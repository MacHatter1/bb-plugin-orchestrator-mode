// Backend for the orchestrator-mode plugin.
//
// One per-thread switch, three enforcement layers:
//
//   1. `bb.agents.configure` injects the orchestrator contract and selects the
//      `orchestrator_delegate` tool for threads that are orchestrating. This is
//      the layer that actually changes what the agent does.
//   2. The `message.dispatch` hook keeps the thread-metadata mirror in step
//      with this plugin's own authoritative state before every turn starts, and
//      applies the "new threads start as orchestrators" default. The mirror is
//      what layer 1 can read synchronously; the KV store is what the agent
//      cannot forge.
//   3. A watchdog reads the timeline of orchestrator threads, classifies each
//      new work row; in `guard`/`block` it records violations, stops the
//      turn and sends a corrective nudge.
//
// BB gives plugins no pre-tool-call veto, so layer 3 is detect-and-intervene
// rather than prevent-at-source. That limitation is documented in README.md.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginSettingDescriptor,
  type PluginSettingsValues,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_ENFORCEMENT,
  DELEGATE_TOOL,
  CONTRACT_PRESETS,
  ENFORCEMENT_DESCRIPTIONS,
  ENFORCEMENT_LEVELS,
  PERMISSION_MODES,
  REASONING_LEVELS,
  REVIEW_TOOL,
  REVIEW_VERDICTS,
  WORKER_PRESETS,
  SERVICE_TIERS,
  EXTRA_INSTRUCTION_LIMIT,
  buildInstructions,
  buildNudge,
  buildReviewNudge,
  buildVerifierBrief,
  classifyRow,
  defaultAppliesTo,
  isEnforcementLevel,
  isOneOf,
  readMirror,
  writeMirror,
  type EnforcementLevel,
  type PermissionMode,
  type ReasoningLevel,
  type ReviewVerdict,
  type ServiceTier,
  type Violation,
  type WorkerCatalog,
  type WorkerConfig,
  type WorkerPresetName,
  type ContractPresetId,
  type WorkRowLike,
  type WorkerExecution,
  type WorkerModelOption,
} from "./shared";

export { DELEGATE_TOOL };

/** Realtime channel the composer surfaces listen on. */
const STATE_CHANGED = "orchestrator-state";

const STATE_KEY = "state";
/** When the "new threads" default was last switched on; null while it is off. */
const DEFAULT_KEY = "default";
/** The stored worker execution every delegation defaults to. */
const WORKER_KEY = "worker";
/** The stored project rules appended to the contract. */
const CONTRACT_KEY = "contract";
/** Threads kept in the KV map before the least recently touched is dropped. */
const MAX_THREADS = 300;
const MAX_VIOLATIONS = 100;
const MAX_SEEN_ROWS = 500;
const MAX_DELEGATIONS = 50;

export interface Delegation {
  threadId: string;
  title: string;
  task: string;
  createdAt: number;
  status: string | null;
  /** Set when the delegation asked for an independent check unit. */
  verifiedBy?: string | null;
  /**
   * The delegation this worker is the check unit for. A check unit is evidence,
   * not a unit of work: the orchestrator judges the unit, not its checker.
   */
  verifierFor?: string;
  /** The orchestrator's verdict, absent until `orchestrator_review` records one. */
  verdict?: ReviewVerdict | null;
  notes?: string | null;
  reviewedAt?: number | null;
  /** The error text when this worker failed, so the orchestrator sees why. */
  failure?: string | null;
}

export interface ThreadState {
  enabled: boolean;
  /** Per-thread override; null follows the plugin setting. */
  enforcement: EnforcementLevel | null;
  enabledAt: string | null;
  touchedAt: number;
  violations: Violation[];
  seenRowIds: string[];
  /** Timeline sequence already classified, so a scan never re-judges a row. */
  lastSeq: number;
  /**
   * Turns that ran in a provider session which never received the contract or
   * the tool: the one in flight when the mode was switched on (if any) and the
   * first one after it, because BB resumes a live session rather than
   * hot-mutating it. Recorded but never judged.
   */
  graceTurnIds: string[];
  /** How many grace turns this enablement gets: two mid-turn, one when idle. */
  graceSlots: number;
  nudgeCount: number;
  lastNudgeTurnId: string | null;
  lastStopTurnId: string | null;
  delegations: Delegation[];
  /**
   * When the orchestrator's current turn started, as the dispatch hook saw it.
   * The per-turn fan-out cap counts delegations created since this moment.
   */
  turnStartedAt: number;
  /**
   * The set of workers the review gate last reminded about, so a turn that ends
   * with the same unjudged workers is not nagged twice.
   */
  lastReviewNudge: string | null;
}

const delegationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  task: z.string(),
  createdAt: z.number(),
  status: z.string().nullable(),
  verifiedBy: z.string().nullable().optional(),
  verifierFor: z.string().optional(),
  verdict: z.enum(REVIEW_VERDICTS).nullable().optional(),
  notes: z.string().nullable().optional(),
  reviewedAt: z.number().nullable().optional(),
  failure: z.string().nullable().optional(),
});

const violationSchema = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  workKind: z.string(),
  detail: z.string(),
  detectedAt: z.number(),
});

/**
 * The stored arrays are read by consumers that assume their declared element
 * shape (`violation.detail`, `delegation.status`), so a foreign value in the
 * store is dropped on the way out instead of crashing an RPC read or a scan.
 */
function sanitizeElements<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The execution a delegation defaults to; an absent field inherits. */
const workerExecutionSchema = z.object({
  providerId: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  reasoningLevel: z.enum(REASONING_LEVELS).optional(),
  serviceTier: z.enum(SERVICE_TIERS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).optional(),
});

/** The stored configuration: the execution, the retry target, the presets. */
const workerConfigSchema = workerExecutionSchema.extend({
  fallback: workerExecutionSchema.optional(),
  presets: z
    .partialRecord(z.enum(WORKER_PRESETS), workerExecutionSchema)
    .optional(),
});

/** The enforcement union as a zod enum, shared by the state shape and the writes. */
const enforcementSchema = z.enum(
  ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]],
);

/** The `{ threadId }` input every per-thread RPC call takes. */
const threadIdSchema = z.object({ threadId: z.string().min(1).max(120) });

const stateSchema = z.object({
  enabled: z.boolean(),
  enforcement: enforcementSchema.nullable(),
  effectiveEnforcement: enforcementSchema,
  enabledAt: z.string().nullable(),
  violations: z.array(violationSchema),
  delegations: z.array(delegationSchema),
  nudgeCount: z.number(),
  /** The plugin-wide default, so the new-thread composer can render it. */
  defaultForNewThreads: z.boolean(),
  allowReadCommands: z.boolean(),
  maxNudges: z.number(),
  /** The execution every delegation defaults to; absent fields inherit. */
  workerExecution: workerExecutionSchema,
  /** The fan-out caps in force, so a report can name them. */
  maxParallelWorkers: z.number(),
  maxDelegationsPerTurn: z.number(),
  /** Settled workers whose result nobody has judged yet. */
  unreviewed: z.number(),
  /** Delegations whose result the orchestrator accepted, as a ratio's numerator. */
  reviewed: z.number(),
});

/** The contract text, the project rules appended to it, and the room left. */
const contractSchema = z.object({ text: z.string(), extra: z.string(), limit: z.number() });
export type ContractDto = z.infer<typeof contractSchema>;

/** The shape every RPC call returns; the schema above owns it. */
export type OrchestratorStateDto = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  get_state: {
    input: threadIdSchema.strict(),
    output: stateSchema,
  },
  set_enabled: {
    input: z
      .object({
        threadId: z.string().min(1).max(120),
        enabled: z.boolean(),
        enforcement: enforcementSchema.nullable().optional(),
      })
      .strict(),
    output: stateSchema,
  },
  get_default: { input: z.null(), output: z.object({ enabled: z.boolean() }) },
  set_default: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  get_contract: {
    input: z.object({ threadId: z.string().min(1).max(120).nullable() }).strict(),
    output: contractSchema,
  },
  set_contract: {
    input: z
      .object({ extra: z.string().max(EXTRA_INSTRUCTION_LIMIT) })
      .strict(),
    output: contractSchema,
  },
  get_worker_execution: { input: z.null(), output: workerConfigSchema },
  set_worker_execution: {
    input: workerConfigSchema.nullable(),
    output: workerConfigSchema,
  },
  clear_violations: {
    input: threadIdSchema.strict(),
    output: stateSchema,
  },
});

/**
 * What to do with a worker whose result the orchestrator has read. Archiving is
 * recoverable and only ever hides a worker from the sidebar, so it stays opt-in:
 * a default that tidied the sidebar would also hide the evidence.
 */
const WORKER_RETENTION = ["keep", "archive-checks", "archive-all"] as const;
type WorkerRetention = (typeof WORKER_RETENTION)[number];

/**
 * Thrown when a delegation would exceed a fan-out cap. A distinct type because
 * the delegation tool retries a *provider* failure on the fallback, and a cap
 * is not a provider failure: retrying it would fail twice for no reason.
 */
class WorkerBudgetError extends Error {
  override readonly name = "WorkerBudgetError";
}

/** A timeline row, narrowed to the fields the classifier reads. */
interface ScanRow extends WorkRowLike {
  id: string;
  turnId?: string | null;
  sourceSeqEnd?: number;
  startedAt?: number;
  children?: unknown;
}

function asScanRows(rows: unknown): ScanRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ScanRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === null || typeof row !== "object") continue;
    const candidate = row as Omit<ScanRow, "id"> & { id?: unknown };
    // A delivered work row is judged even when the provider omitted its id:
    // dropping it would make the act invisible to a watchdog that exists to see
    // it. The sequence keys it stably, so a re-delivery in the next delta is
    // still deduped; only the id-less, sequence-less row falls back to position.
    const id =
      typeof candidate.id === "string"
        ? candidate.id
        : typeof candidate.sourceSeqEnd === "number"
          ? `seq:${candidate.sourceSeqEnd}`
          : `row:${index}`;
    out.push({ ...candidate, id });
    if (Array.isArray(candidate.children)) out.push(...asScanRows(candidate.children));
  }
  return out;
}

// --- settings --------------------------------------------------------------

/**
 * Every model the SDK's own picker would offer, with the provider that serves
 * it. Read from `bb.sdk.providers.models()`, the same source the new-thread
 * composer's provider and model pickers use, so a worker runs on something the
 * user can actually select there.
 *
 * A failed read is not fatal: the catalog comes back empty, the pickers offer
 * only "inherit", and nothing is validated against it.
 */
async function loadWorkerCatalog(bb: BbPluginApi): Promise<WorkerCatalog> {
  try {
    // The unfiltered response enumerates providers, including which are
    // available; each provider's models need a call of its own. Providers are a
    // handful, so this is a few requests once per plugin load.
    const system = await bb.sdk.providers.models();
    const providers: string[] = [];
    const models: WorkerModelOption[] = [];
    for (const provider of system.providers) {
      if (!provider.available) continue;
      providers.push(provider.id);
      const listed = (await bb.sdk.providers.models({ providerId: provider.id })).models;
      for (const model of listed) {
        if (models.some((existing) => existing.id === model.id)) continue;
        models.push({ id: model.id, providerId: provider.id });
      }
    }
    return { providers, models };
  } catch (cause) {
    bb.log.warn(`worker provider catalog unavailable, offering inherit only: ${String(cause)}`);
    return { providers: [], models: [] };
  }
}

/**
 * The provenance map `threads.spawn` reads for each execution field it gets:
 * `explicit` means the caller named the value, so the server must keep it.
 */
type WorkerExecutionSources = Partial<Record<keyof WorkerExecution, "explicit">>;

/**
 * Stamp every field present in `exec` as caller-chosen. Without this the server
 * drops a requested `providerId`/`model` and re-derives it from the project's
 * remembered defaults, so the worker would silently ignore what was asked for.
 */
function executionSources(exec: WorkerExecution): WorkerExecutionSources {
  return {
    ...(exec.providerId === undefined ? {} : { providerId: "explicit" as const }),
    ...(exec.model === undefined ? {} : { model: "explicit" as const }),
    ...(exec.reasoningLevel === undefined ? {} : { reasoningLevel: "explicit" as const }),
    ...(exec.serviceTier === undefined ? {} : { serviceTier: "explicit" as const }),
    ...(exec.permissionMode === undefined ? {} : { permissionMode: "explicit" as const }),
  };
}

export default async function plugin(bb: BbPluginApi) {
  const catalog = await loadWorkerCatalog(bb);

  const SETTING_DESCRIPTORS = {
    defaultForNewThreads: {
      type: "boolean",
      label: "Start new threads as orchestrators",
      description:
        "Threads you start from the composer begin in orchestrator mode. Threads already open, child workers and side chats are not affected, and you can still switch one thread on or off whenever you like.",
      default: false,
    },
    enforcement: {
      type: "select",
      label: "How far the watchdog goes",
      // One line per option, which BB's settings UI collapses into a paragraph
      // and `bb plugin config` prints as written. A settings description is a
      // single string, so a real list is not available here.
      description: ENFORCEMENT_LEVELS.map((level) => ENFORCEMENT_DESCRIPTIONS[level]).join(" "),
      options: [...ENFORCEMENT_LEVELS],
      default: DEFAULT_ENFORCEMENT,
    },
    allowReadCommands: {
      type: "boolean",
      label: "Let the orchestrator read with shell commands",
      description:
        "While this is on, ls, cat, rg, git status, git diff and similar count as looking around rather than doing work. Turn it off and every command counts as doing the work itself.",
      default: true,
    },
    maxNudges: {
      type: "number",
      label: "Reminders per thread",
      description:
        "How many times this plugin may prod one thread, once for doing work itself and once for leaving a worker unjudged. Violations keep being recorded after the cap; only the reminders stop. 0 turns reminders off.",
      default: 3,
    },
    maxParallelWorkers: {
      type: "number",
      label: "Most workers running at once",
      description:
        "Once this many workers are running, further delegations are refused and told why. Check units and fallbacks count too. 0 for no limit.",
      default: 6,
    },
    maxDelegationsPerTurn: {
      type: "number",
      label: "Most workers per turn",
      description:
        "A delegation is refused once one turn has delegated this many, so a runaway fan-out stops instead of filling the sidebar. Check units and fallback retries are the plugin's own doing and do not count. 0 for no limit.",
      default: 20,
    },
    workerRetention: {
      type: "select",
      label: "What happens to workers afterwards",
      description:
        "keep leaves every worker in the sidebar. archive-checks archives check units once their verdict has been read. archive-all archives every worker once the orchestrator has read its result. Archiving hides a thread from the sidebar, but it stays recoverable.",
      options: [...WORKER_RETENTION],
      default: "keep",
    },
    contractPreset: {
      type: "select",
      label: "What the orchestrator is told",
      description:
        "standard delegates the work and reviews it. delegate-only also hands over research, so it may not run commands at all. research-first asks for enough reading to write a brief that stands alone. review-heavy gives every unit an independent check unit before it is accepted. Read the exact text with bb orchestrator-mode contract.",
      options: [...CONTRACT_PRESETS],
      default: "standard",
    },
  } satisfies Record<string, PluginSettingDescriptor>;

  /**
   * The resolved settings this plugin defines. Named here rather than published
   * through `ReturnType` of the handle, so `applySettings` takes a real type.
   */
  type OrchestratorSettings = PluginSettingsValues<typeof SETTING_DESCRIPTORS>;

  const settings = bb.settings.define(SETTING_DESCRIPTORS);

  /** In-memory mirror of the effective settings, for the sync configure path. */
  const live = {
    defaultForNewThreads: false,
    /**
     * When the default was last switched on. The dispatch hook only applies the
     * default to threads created at or after this moment, which is what keeps
     * "new threads" from meaning "every thread that happens to lack a mirror".
     */
    defaultEnabledAtMs: 0,
    enforcement: DEFAULT_ENFORCEMENT as EnforcementLevel,
    allowReadCommands: true,
    maxNudges: 3,
    contractPreset: "standard" as ContractPresetId,
    workerRetention: "keep" as WorkerRetention,
    /** Fan-out guardrails; 0 means no cap. */
    maxParallelWorkers: 6,
    maxDelegationsPerTurn: 20,
    /** Worker execution defaults; an absent field means "inherit". */
    worker: {} as WorkerConfig,
  };

  /**
   * The worker execution this plugin configures, in the shape `threads.spawn`
   * takes and `buildInstructions` describes. Absent fields are omitted rather
   * than sent empty, so a thread spawned without them resolves the project's
   * remembered defaults exactly as it did before this fork.
   */
  function workerDefaults(): WorkerExecution {
    return executionOf(live.worker);
  }

  /**
   * A configuration's execution, without its fallback. `reconcile` and
   * `threads.spawn` must never see the `fallback` key: it is this plugin's own
   * bookkeeping, not a spawn field.
   */
  function executionOf(config: WorkerConfig): WorkerExecution {
    const { fallback: _fallback, presets: _presets, ...execution } = config;
    return execution;
  }

  /**
   * Resolve one stored id. A blank one means "not set"; a value the live
   * catalog no longer lists is dropped with a warning rather than spawned,
   * because both writers (the settings section and the CLI) choose from the
   * catalog: this means the provider's models changed under a saved choice, and
   * a worker on the project's own default beats one whose start fails.
   */
  function workerChoice(
    value: string | undefined,
    options: readonly string[],
    setting: string,
  ): string | undefined {
    if (value === undefined || value === "") return undefined;
    if (options.length > 0 && !options.includes(value)) {
      bb.log.warn(`${setting} "${value}" is not in the current catalog; ignoring it`);
      return undefined;
    }
    return value;
  }

  /**
   * Keep provider and model coherent. A model belongs to exactly one provider,
   * so naming a provider that does not serve the chosen model would guarantee a
   * failed start; the model wins and the mismatch is logged.
   */
  function reconcile(exec: WorkerExecution): WorkerExecution {
    if (exec.model === undefined) return exec;
    const owner = catalog.models.find((option) => option.id === exec.model)?.providerId;
    if (owner === undefined || owner === exec.providerId) return exec;
    if (exec.providerId !== undefined) {
      bb.log.warn(
        `worker provider ${exec.providerId} does not serve ${exec.model}; using ${owner}`,
      );
    }
    return { ...exec, providerId: owner };
  }

  function applySettings(values: OrchestratorSettings): void {
    live.defaultForNewThreads = values.defaultForNewThreads === true;
    live.enforcement = isEnforcementLevel(values.enforcement)
      ? values.enforcement
      : DEFAULT_ENFORCEMENT;
    live.allowReadCommands = values.allowReadCommands !== false;
    live.maxNudges = capOf(values.maxNudges, 3);
    live.maxParallelWorkers = capOf(values.maxParallelWorkers, 6);
    live.maxDelegationsPerTurn = capOf(values.maxDelegationsPerTurn, 20);
    live.contractPreset = isOneOf(CONTRACT_PRESETS, values.contractPreset)
      ? values.contractPreset
      : "standard";
    live.workerRetention = isOneOf(WORKER_RETENTION, values.workerRetention)
      ? values.workerRetention
      : "keep";
  }

  /** A fan-out cap: a non-negative whole number, or the fallback when unusable. */
  function capOf(value: unknown, fallback: number): number {
    const cap = Number(value);
    return Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : fallback;
  }

  /**
   * The stored worker configuration, with any id the live catalog no longer
   * lists dropped. The store is written by this plugin's own surfaces, so an
   * unknown id means a provider's models changed under a saved choice.
   */
  function storedWorkerConfig(stored: unknown): WorkerConfig {
    if (stored === null || typeof stored !== "object") return {};
    const record = stored as Record<string, unknown>;
    const execution = sanitizeExecution(record);
    const fallback =
      record.fallback === undefined || record.fallback === null
        ? undefined
        : sanitizeExecution(record.fallback as Record<string, unknown>);
    const presets: Partial<Record<WorkerPresetName, WorkerExecution>> = {};
    if (record.presets !== null && typeof record.presets === "object") {
      for (const [name, value] of Object.entries(record.presets as Record<string, unknown>)) {
        // A preset is a partial override, so it only loses the ids the catalog
        // no longer lists, and is dropped when nothing usable is left.
        if (!isOneOf(WORKER_PRESETS, name) || value === null || typeof value !== "object") continue;
        const sanitized = sanitizeExecution(value as Record<string, unknown>);
        if (Object.keys(sanitized).length > 0) presets[name] = sanitized;
      }
    }
    return {
      ...execution,
      // A fallback that lost its provider or model to the catalog is no retry
      // target at all: keep none rather than retry on half a choice.
      ...(fallback?.providerId === undefined || fallback.model === undefined
        ? {}
        : { fallback }),
      ...(Object.keys(presets).length === 0 ? {} : { presets }),
    };
  }

  /** One level of the stored configuration, validated against the catalog. */
  function sanitizeExecution(record: Record<string, unknown>): WorkerExecution {
    const providerId = workerChoice(
      typeof record.providerId === "string" ? record.providerId : undefined,
      catalog.providers,
      "worker provider",
    );
    const model = workerChoice(
      typeof record.model === "string" ? record.model : undefined,
      catalog.models.map((option) => option.id),
      "worker model",
    );
    return reconcile({
      ...(providerId === undefined ? {} : { providerId }),
      ...(model === undefined ? {} : { model }),
      ...(isOneOf(REASONING_LEVELS, record.reasoningLevel)
        ? { reasoningLevel: record.reasoningLevel }
        : {}),
      ...(isOneOf(SERVICE_TIERS, record.serviceTier) ? { serviceTier: record.serviceTier } : {}),
      ...(isOneOf(PERMISSION_MODES, record.permissionMode)
        ? { permissionMode: record.permissionMode }
        : {}),
    });
  }

  /**
   * Refuse a worker the provider catalog cannot serve, naming the alternatives
   * so the agent can correct itself instead of handing back a broken worker.
   * Nothing is asserted while the catalog is empty, because an unreadable catalog must
   * not make delegation impossible.
   */
  function assertInCatalog(exec: WorkerExecution): void {
    // The provider first: it is the outer choice, and naming a model that exists
    // under a provider that does not is a confusing way to report a typo.
    if (
      exec.providerId !== undefined &&
      catalog.providers.length > 0 &&
      !catalog.providers.includes(exec.providerId)
    ) {
      throw new Error(
        `Unknown worker provider "${exec.providerId}". Providers this machine offers: ${catalog.providers.join(", ")}. Omit provider to inherit the project default.`,
      );
    }
    if (
      exec.model !== undefined &&
      catalog.models.length > 0 &&
      !catalog.models.some((option) => option.id === exec.model)
    ) {
      const sample = catalog.models
        .slice(0, 12)
        .map((option) => option.id)
        .join(", ");
      throw new Error(
        `Unknown worker model "${exec.model}". Models this machine offers include: ${sample}. Run \`bb provider models <provider>\` for the full list, or omit model to inherit the project default.`,
      );
    }
  }

  async function persistDefaultEnabledAt(): Promise<void> {
    await bb.storage.kv.set(DEFAULT_KEY, {
      enabledAtMs: live.defaultForNewThreads ? live.defaultEnabledAtMs : null,
    });
  }

  /**
   * The one place the "new threads" default is switched. Recording the moment
   * it turned on is what lets the dispatch hook distinguish a thread created
   * under the default from one that merely predates it.
   */
  async function setDefault(enabled: boolean): Promise<boolean> {
    await settings.experimental_set({ defaultForNewThreads: enabled });
    live.defaultForNewThreads = enabled;
    live.defaultEnabledAtMs = enabled ? Date.now() : 0;
    await persistDefaultEnabledAt();
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return enabled;
  }

  /**
   * Replace the stored worker configuration. `null` clears it, leaving every
   * delegation on the project's remembered defaults. Each level must name both
   * a provider and a model, since the settings section renders them with BB's
   * picker, which resolves the pair against the live catalog, and every id it
   * cannot serve is refused here rather than spawned.
   */
  async function setWorkerConfig(next: WorkerConfig | null): Promise<WorkerConfig> {
    if (next !== null) {
      const execution = executionOf(next);
      if (Object.keys(execution).length > 0) {
        if (execution.providerId === undefined || execution.model === undefined) {
          throw new Error("A worker execution needs both a provider and a model.");
        }
        assertInCatalog(execution);
      }
      if (next.fallback !== undefined) {
        if (next.fallback.providerId === undefined || next.fallback.model === undefined) {
          throw new Error("A worker execution needs both a provider and a model.");
        }
        assertInCatalog(next.fallback);
      }
      // A preset is partial by design, so only the ids it does name must exist.
      for (const preset of Object.values(next.presets ?? {})) {
        assertInCatalog(preset);
      }
    }
    const stored: WorkerConfig =
      next === null
        ? {}
        : {
            ...reconcile(executionOf(next)),
            ...(next.fallback === undefined ? {} : { fallback: reconcile(next.fallback) }),
            ...(next.presets === undefined
              ? {}
              : {
                  presets: Object.fromEntries(
                    Object.entries(next.presets).map(([name, preset]) => [
                      name,
                      reconcile(preset),
                    ]),
                  ),
                }),
          };
    await bb.storage.kv.set(WORKER_KEY, stored);
    live.worker = stored;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return stored;
  }

  /**
   * The project rules the user appended. Held in memory as well as storage
   * because `bb.agents.configure` is synchronous and cannot await a read.
   */
  let extraInstructions = readExtra(await bb.storage.kv.get<unknown>(CONTRACT_KEY));

  /** The appended rules out of a stored record, or "" when there are none. */
  function readExtra(stored: unknown): string {
    if (stored === null || typeof stored !== "object") return "";
    const value = (stored as Record<string, unknown>).extra;
    return typeof value === "string" ? value : "";
  }

  /** Replace the appended rules. An empty string clears them. */
  async function setExtraInstructions(next: string): Promise<string> {
    const text = next.trim();
    if (text.length > EXTRA_INSTRUCTION_LIMIT) {
      throw new Error(
        `Project rules are capped at ${EXTRA_INSTRUCTION_LIMIT} characters so the contract stays inside the 4096-character limit; that text is ${text.length}.`,
      );
    }
    await bb.storage.kv.set(CONTRACT_KEY, { extra: text });
    extraInstructions = text;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
    return text;
  }

  /**
   * The exact text `bb.agents.configure` injects for one thread. Pass a null
   * thread for the text a thread that has not run yet would receive. Exposed so
   * the contract can be read instead of guessed at.
   */
  async function contractText(threadId: string | null): Promise<string> {
    const state = threadId === null ? undefined : await getState(threadId);
    const enforcement = effectiveEnforcement(state);
    const reminders =
      state === undefined || state.violations.length === 0
        ? undefined
        : state.violations.slice(-5).map((violation) => violation.detail);
    return buildInstructions({
      enforcement,
      allowReadCommands: live.allowReadCommands,
      reminders,
      workerConfig: live.worker,
      extra: extraInstructions,
      preset: live.contractPreset,
    });
  }

  applySettings(await settings.get());
  live.worker = storedWorkerConfig(await bb.storage.kv.get<unknown>(WORKER_KEY));
  {
    const stored = await bb.storage.kv.get<{ enabledAtMs?: unknown }>(DEFAULT_KEY);
    const storedAt =
      stored !== undefined && typeof stored.enabledAtMs === "number" ? stored.enabledAtMs : null;
    if (live.defaultForNewThreads) {
      // A default switched on by an older build, or straight through settings,
      // has no recorded moment: claim now, so only threads created from here
      // on are caught by it.
      live.defaultEnabledAtMs = storedAt ?? Date.now();
      if (storedAt === null) await persistDefaultEnabledAt();
    } else {
      live.defaultEnabledAtMs = 0;
    }
  }
  settings.onChange((next, prev) => {
    const wasOn = prev.defaultForNewThreads === true;
    const isOn = next.defaultForNewThreads === true;
    applySettings(next);
    if (isOn && !wasOn) {
      live.defaultEnabledAtMs = Date.now();
      void persistDefaultEnabledAt();
    } else if (!isOn && wasOn) {
      live.defaultEnabledAtMs = 0;
      void persistDefaultEnabledAt();
    }
    bb.log.info(`enforcement=${live.enforcement} default=${live.defaultForNewThreads}`);
    // Several settings change text the composer strip and the settings section
    // render (the contract shape and the enforcement description above all), so
    // a settings write has to wake them. Their own writes publish too; this
    // covers a change made in BB's settings UI, which the plugin never sees.
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
  });

  // --- state store ---------------------------------------------------------
  //
  // Authoritative per-thread state lives in this plugin's KV, which the thread's
  // own agent cannot write. Thread metadata carries a mirror of it only because
  // `bb.agents.configure` is synchronous and metadata is its only per-thread
  // input. The dispatch hook rewrites the mirror before every turn.

  let cache: Record<string, ThreadState> | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  /**
   * Claims this process has made but not yet recorded. A cap check that counted
   * only the recorded delegations would let two simultaneous claims both pass,
   * so in-flight claims are counted too. `turn` tracks the ones that count
   * toward the per-turn cap, which excludes check units and retries.
   */
  const pendingClaims = new Map<string, { parallel: number; turn: number }>();

  function reserveClaim(threadId: string, countPerTurn: boolean): void {
    const counts = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
    pendingClaims.set(threadId, {
      parallel: counts.parallel + 1,
      turn: counts.turn + (countPerTurn ? 1 : 0),
    });
  }

  function releaseClaim(threadId: string, countPerTurn: boolean): void {
    const counts = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
    const next = {
      parallel: Math.max(0, counts.parallel - 1),
      turn: Math.max(0, counts.turn - (countPerTurn ? 1 : 0)),
    };
    if (next.parallel === 0 && next.turn === 0) pendingClaims.delete(threadId);
    else pendingClaims.set(threadId, next);
  }

  /**
   * Run `work` in the same queue as the state writes, so a check that reads the
   * state cannot interleave with another claim on the same thread. A failed
   * unit rejects its caller without wedging the queue.
   */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const queued = mutationQueue.then(work, work);
    mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function readAll(): Promise<Record<string, ThreadState>> {
    if (cache !== null) return cache;
    const stored = await bb.storage.kv.get<Record<string, ThreadState>>(STATE_KEY);
    const rows = stored !== undefined && typeof stored === "object" && stored !== null ? stored : {};
    // Normalize here, not only in getState and mutateState: every reader shares this
    // cache, including the agent-configuration path, and a row written by an older
    // build must not reach a caller with a missing array.
    cache = Object.fromEntries(
      Object.entries(rows).map(([threadId, state]) => [threadId, normalize(state)]),
    );
    return cache;
  }

  /**
   * Fill in fields added after a state row was written, and tolerate a row that is
   * not the shape this build writes at all: a thread enabled by an older build, or
   * a foreign value in the store, must not crash a scan or an RPC read. That
   * covers the array *elements* too: a stored `violations: [null]` reaches
   * `violation.detail` in the contract and the RPC output, so a bad element is
   * dropped rather than passed on.
   */
  function normalize(state: ThreadState | null | undefined): ThreadState {
    if (state === null || state === undefined) return emptyState(Date.now());
    return {
      ...state,
      enabled: state.enabled === true,
      enforcement:
        state.enforcement === "instruct" || state.enforcement === "guard" || state.enforcement === "block"
          ? state.enforcement
          : null,
      enabledAt: typeof state.enabledAt === "string" ? state.enabledAt : null,
      violations: sanitizeElements(state.violations, violationSchema),
      seenRowIds: sanitizeElements(state.seenRowIds, z.string()),
      delegations: sanitizeElements(state.delegations, delegationSchema),
      graceTurnIds: sanitizeElements(state.graceTurnIds, z.string()),
      lastReviewNudge: typeof state.lastReviewNudge === "string" ? state.lastReviewNudge : null,
      touchedAt: typeof state.touchedAt === "number" && Number.isFinite(state.touchedAt) ? state.touchedAt : 0,
      turnStartedAt: typeof state.turnStartedAt === "number" ? state.turnStartedAt : 0,
      graceSlots: typeof state.graceSlots === "number" ? state.graceSlots : 1,
      lastSeq: typeof state.lastSeq === "number" ? state.lastSeq : 0,
      nudgeCount: typeof state.nudgeCount === "number" ? state.nudgeCount : 0,
    };
  }

  async function persist(next: Record<string, ThreadState>): Promise<void> {
    await bb.storage.kv.set(STATE_KEY, next);
    cache = next;
    bb.realtime.publish(STATE_CHANGED, { at: Date.now() });
  }

  function emptyState(now: number): ThreadState {
    return {
      enabled: false,
      enforcement: null,
      enabledAt: null,
      touchedAt: now,
      violations: [],
      seenRowIds: [],
      lastSeq: 0,
      graceTurnIds: [],
      graceSlots: 1,
      nudgeCount: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      delegations: [],
      turnStartedAt: 0,
      lastReviewNudge: null,
    };
  }

  async function getState(threadId: string): Promise<ThreadState | undefined> {
    const all = await readAll();
    const stored = all[threadId];
    return stored === undefined ? undefined : normalize(stored);
  }

  function mutateState(
    threadId: string,
    update: (current: ThreadState) => ThreadState | null,
  ): Promise<ThreadState | undefined> {
    // Serialize the read as well as the write: parallel delegations and thread
    // toggles must derive their updates from the preceding committed state.
    return enqueue(async () => {
      const all = { ...(await readAll()) };
      const current = normalize(all[threadId] ?? emptyState(Date.now()));
      const next = update(current);
      if (next === null) {
        if (all[threadId] === undefined) return undefined;
        delete all[threadId];
        await persist(prune(all));
        return undefined;
      }
      next.touchedAt = Date.now();
      all[threadId] = next;
      await persist(prune(all));
      return next;
    });
  }

  function clearViolations(threadId: string): Promise<ThreadState | undefined> {
    return mutateState(threadId, (current) => ({
      ...current,
      violations: [],
      nudgeCount: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
      // The review reminder is a correction counter too. Leaving its marker here
      // would mute the gate for the same workers while the cap said there were
      // reminders left to spend.
      lastReviewNudge: null,
    }));
  }

  /** Drop the least recently touched threads once the map outgrows its cap. */
  function prune(all: Record<string, ThreadState>): Record<string, ThreadState> {
    const ids = Object.keys(all);
    if (ids.length <= MAX_THREADS) return all;
    const ordered = ids.sort((a, b) => (all[a]!.touchedAt ?? 0) - (all[b]!.touchedAt ?? 0));
    const out: Record<string, ThreadState> = {};
    for (const id of ordered.slice(ordered.length - MAX_THREADS)) out[id] = all[id]!;
    return out;
  }

  function effectiveEnforcement(state: ThreadState | undefined): EnforcementLevel {
    return state?.enforcement ?? live.enforcement;
  }

  function toDto(threadId: string, state: ThreadState | undefined): OrchestratorStateDto {
    const base = state ?? emptyState(Date.now());
    return {
      enabled: state?.enabled ?? false,
      enforcement: base.enforcement,
      effectiveEnforcement: effectiveEnforcement(state),
      enabledAt: base.enabledAt,
      violations: base.violations.slice(-MAX_VIOLATIONS),
      delegations: trimDelegations(base.delegations),
      nudgeCount: base.nudgeCount,
      defaultForNewThreads: live.defaultForNewThreads,
      allowReadCommands: live.allowReadCommands,
      maxNudges: live.maxNudges,
      workerExecution: workerDefaults(),
      maxParallelWorkers: live.maxParallelWorkers,
      maxDelegationsPerTurn: live.maxDelegationsPerTurn,
      unreviewed: unreviewedOf(base.delegations).length,
      reviewed: base.delegations.filter((delegation) => delegation.verdict != null).length,
    };
  }

  /**
   * Settled workers whose result nobody has judged. A worker still running has
   * nothing to review yet, so it is not counted.
   */
  /** Settled, unjudged, and not a check unit: a delegation the orchestrator still owes a verdict. */
  function needsVerdict(delegation: Delegation): boolean {
    return (
      delegation.status !== null &&
      delegation.verdict == null &&
      // A check unit is evidence for the unit it checks: judging the checker
      // as well would double the ceremony without adding a decision.
      delegation.verifierFor === undefined
    );
  }

  /**
   * Keep the newest records plus every worker still owed a verdict: dropping an
   * unjudged record would refuse its verdict later and hide it from the counts.
   */
  function trimDelegations(delegations: readonly Delegation[]): Delegation[] {
    if (delegations.length <= MAX_DELEGATIONS) return [...delegations];
    const recent = delegations.slice(-MAX_DELEGATIONS);
    const kept = new Set(recent.map((delegation) => delegation.threadId));
    return [
      ...delegations.filter((delegation) => !kept.has(delegation.threadId) && needsVerdict(delegation)),
      ...recent,
    ];
  }

  function unreviewedOf(delegations: readonly Delegation[]): Delegation[] {
    return delegations.filter(needsVerdict);
  }

  /**
   * One row's dedupe key. A later turn may reuse a row id, and a row id may
   * itself contain `:`, so neither the bare id nor `id:seq` is unique per
   * `(id, seq)`: `id:"a:1"` at seq 0 would collide with `id:"a"` at seq 1 and
   * hide the later row. The id's length in front makes the key unambiguous
   * whatever characters the id holds.
   */
  function seenKey(row: ScanRow): string {
    const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
    return `${row.id.length}:${row.id}:${seq}`;
  }

  /** Read the thread's current timeline head so a scan starts after it. */
  async function timelineHead(
    threadId: string,
  ): Promise<{ seq: number; turnId: string | null }> {
    try {
      const timeline = await bb.sdk.threads.timeline({ threadId });
      const response = timeline as { maxSeq?: unknown; rows?: unknown };
      const seq =
        typeof response.maxSeq === "number" && Number.isFinite(response.maxSeq)
          ? response.maxSeq
          : 0;
      const rows = asScanRows(response.rows);
      return { seq, turnId: rows.length === 0 ? null : (rows[rows.length - 1]!.turnId ?? null) };
    } catch (cause) {
      bb.log.warn(`timeline head read failed for ${threadId}: ${String(cause)}`);
      return { seq: 0, turnId: null };
    }
  }

  async function setEnabled(
    threadId: string,
    enabled: boolean,
    enforcement: EnforcementLevel | null,
  ): Promise<ThreadState> {
    // Seeding the sequence head when turning on means historical work in an
    // existing thread is never retroactively flagged.
    const head = enabled ? await timelineHead(threadId) : { seq: 0, turnId: null };
    // A thread with a turn in flight loses that turn AND the next one to the
    // session lag; an idle thread loses only the next one.
    let graceTurnIds: string[] = [];
    let graceSlots = 1;
    if (enabled) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.status === "active" && head.turnId !== null) {
          graceTurnIds = [head.turnId];
          graceSlots = 2;
        }
      } catch (cause) {
        bb.log.warn(`thread status read failed for ${threadId}: ${String(cause)}`);
      }
    }
    const state = await mutateState(threadId, (current) => ({
      ...current,
      enabled,
      enforcement,
      enabledAt: enabled ? (current.enabledAt ?? new Date().toISOString()) : null,
      lastSeq: enabled ? head.seq : current.lastSeq,
      graceTurnIds: enabled ? graceTurnIds : current.graceTurnIds,
      graceSlots: enabled ? graceSlots : current.graceSlots,
      nudgeCount: enabled ? current.nudgeCount : 0,
      lastNudgeTurnId: enabled ? current.lastNudgeTurnId : null,
      lastStopTurnId: enabled ? current.lastStopTurnId : null,
      lastReviewNudge: enabled ? current.lastReviewNudge : null,
    }));
    await syncMirror(threadId, state?.enabled ?? false, state?.enforcement ?? null);
    return state ?? emptyState(Date.now());
  }

  async function syncMirror(
    threadId: string,
    enabled: boolean,
    enforcement: EnforcementLevel | null,
  ): Promise<void> {
    try {
      const current = await bb.sdk.threads.getPluginMetadata({ threadId });
      const mirror = readMirror(current as Record<string, unknown>);
      if (mirror !== null && mirror.enabled === enabled && mirror.enforcement === enforcement) {
        return;
      }
      // No mirror of ours and nothing to enforce: leave the namespace alone
      // rather than writing an "off" entry onto every thread in the app.
      if (mirror === null && !enabled) return;
      await bb.sdk.threads.updatePluginMetadata({
        threadId,
        set: writeMirror({ enabled, enforcement }),
      });
    } catch (cause) {
      // A missing thread (deleted between the write and the mirror) is normal.
      bb.log.warn(`mirror sync failed for ${threadId}: ${String(cause)}`);
    }
  }

  // --- layer 1: the contract ----------------------------------------------

  bb.agents.registerTool({
    name: DELEGATE_TOOL,
    description:
      "Hand one unit of work to a worker thread and get its result back. The only way an orchestrator-mode thread gets work done. The worker cannot see this conversation, so `task` must be a complete, self-contained brief: goal, context, constraints, and what done means.",
    instructions:
      "In orchestrator mode, delegate every unit of real work with orchestrator_delegate instead of doing it yourself. Fan out independent units in parallel; sequence only genuine dependencies.",
    presentation: {
      label: {
        pending: "Delegating to a worker thread",
        completed: "Delegated to a worker thread",
      },
    },
    parameters: z.object({
      task: z
        .string()
        .min(1)
        .max(20_000)
        .describe("Complete, self-contained brief for the worker."),
      title: z.string().max(200).optional().describe("Worker thread title."),
      waitForResult: z
        .boolean()
        .optional()
        .describe("Wait for the worker to finish and return its result. Default true."),
      timeoutSeconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("How long to wait. Default 900."),
      hidden: z
        .boolean()
        .optional()
        .describe("Keep the worker out of the sidebar. Default false."),
      preset: z
        .enum(WORKER_PRESETS)
        .optional()
        .describe(
          "A named execution preset stored in the plugin settings, applied under this call's own arguments. Ask for one that is stored; the error names the ones that are.",
        ),
      verify: z
        .boolean()
        .optional()
        .describe(
          "Also spawn an independent check unit on the same brief, told to inspect the work and report pass or fail. Use it for a unit whose result you cannot judge from its report alone. Default false.",
        ),
      model: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Model id for this worker, taken from the provider catalog (`bb provider models <provider>`). Defaults to the plugin's worker model, then the project's remembered model.",
        ),
      provider: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "Provider id for this worker, taken from the provider catalog (`bb provider list`). Defaults to the plugin's worker provider, then the project's remembered provider.",
        ),
      reasoning: z
        .enum(REASONING_LEVELS)
        .optional()
        .describe(
          "Reasoning level for this worker. Defaults to the plugin's worker reasoning level, then the project's remembered level.",
        ),
      permissionMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe(
          "Permission mode for this worker. Defaults to the plugin's worker permission mode, then the project's remembered mode.",
        ),
    }),
    async execute(
      {
        task,
        title,
        waitForResult,
        timeoutSeconds,
        hidden,
        preset,
        verify,
        model,
        provider,
        reasoning,
        permissionMode,
      },
      { threadId, projectId, signal },
    ) {
      if (threadId === undefined || projectId === undefined) {
        throw new Error("orchestrator_delegate needs a thread context.");
      }
      // A check unit inspects finished work, so it can only start once the
      // worker has settled. Refusing beats spawning a worker nobody checks.
      if (verify === true && waitForResult === false) {
        throw new Error(
          "verify: true needs waitForResult: true, because a check unit has to inspect finished work. Wait for this worker, or record a verdict yourself and delegate the check as its own unit.",
        );
      }
      const parent = await bb.sdk.threads.get({ threadId });
      const environment =
        parent.environmentId === null
          ? { type: "project-default" as const }
          : { type: "reuse" as const, environmentId: parent.environmentId };
      const workerTitle = title?.trim() || task.trim().split("\n")[0]!.slice(0, 120);
      const orchestratorId = threadId;
      const targetProjectId = projectId;

      // The mode has to be on: a stale session can keep this tool after the
      // thread was switched off, and the review gate does not monitor a thread
      // that is off, so those workers would never be nudged for a verdict.
      const orchestratorState = await getState(orchestratorId);
      if (orchestratorState?.enabled !== true) {
        throw new Error(
          "This thread is not in orchestrator mode, so delegations are refused. Turn the mode on in the composer first.",
        );
      }

      // A named preset must be stored: silently ignoring one would leave the
      // orchestrator believing it had asked for a different model.
      let presetExec: WorkerExecution = {};
      if (preset !== undefined) {
        const stored = live.worker.presets?.[preset];
        if (stored === undefined) {
          const available = Object.keys(live.worker.presets ?? {});
          throw new Error(
            `No \`${preset}\` worker preset is stored.${available.length === 0 ? " This plugin has no presets configured." : ` Stored presets: ${available.join(", ")}.`}`,
          );
        }
        presetExec = stored;
      }

      // Per-delegation arguments win over a preset, which wins over the worker
      // settings; a field none of them names is left out so the worker resolves
      // the project default.
      const workerExec = reconcile({
        ...workerDefaults(),
        ...presetExec,
        ...(provider === undefined ? {} : { providerId: provider }),
        ...(model === undefined ? {} : { model }),
        ...(reasoning === undefined ? {} : { reasoningLevel: reasoning }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
      });
      assertInCatalog(workerExec);

      /** Spawn one worker on `exec` and record it against this orchestrator. */
      async function spawnWorker(
        exec: WorkerExecution,
        workerLabel: string,
        options: { brief?: string; verifierFor?: string; pluginInitiated?: boolean } = {},
      ): Promise<string> {
        const countPerTurn = options.pluginInitiated !== true;
        await assertWithinBudget(orchestratorId, countPerTurn);
        try {
          const spawned = await bb.sdk.threads.spawn({
            projectId: targetProjectId,
            environment,
            prompt: options.brief ?? task,
            title: workerLabel,
            parentThreadId: orchestratorId,
            ...(hidden === true ? { visibility: "hidden" as const } : {}),
            ...exec,
            // The server drops a requested provider/model that carries no
            // provenance source and re-derives it from the project's remembered
            // defaults, which would silently undo everything above.
            ...(Object.keys(exec).length === 0
              ? {}
              : { executionInputSources: executionSources(exec) }),
            pluginMetadata: { workerFor: orchestratorId },
          });
          await mutateState(orchestratorId, (current) => ({
            ...current,
            delegations: trimDelegations([
              ...current.delegations,
              {
                threadId: spawned.id,
                title: workerLabel,
                task: (options.brief ?? task).slice(0, 400),
                createdAt: Date.now(),
                status: null,
                ...(options.verifierFor === undefined
                  ? {}
                  : { verifierFor: options.verifierFor, verifiedBy: null, verdict: null }),
              },
            ]),
          }));
          return spawned.id;
        } finally {
          // However the spawn ended, its claim stops counting against the caps.
          releaseClaim(orchestratorId, countPerTurn);
        }
      }

      interface Settled {
        status: string | null;
        output: string | null;
        /** Still working when the deadline passed. */
        running: boolean;
      }

      /** Wait for one worker, record how it settled, and read what it said. */
      async function settle(workerId: string, timeoutMs: number): Promise<Settled> {
        const deadline = Date.now() + timeoutMs;
        try {
          await bb.sdk.threads.wait({ threadId: workerId, status: "idle", timeoutMs, signal });
        } catch {
          // `wait` matches one status and polls, so an errored thread never
          // reaches `idle`: the server rejects the wait immediately with
          // "will not reach idle by waiting alone" rather than holding until the
          // timeout. That rejection is what notices a failure promptly, and the
          // status read below then decides whether to retry. A timeout lands
          // here too, which is why the status is read either way.
        }
        let status: string | null = null;
        try {
          status = (await bb.sdk.threads.get({ threadId: workerId })).status;
        } catch {
          status = null;
        }
        await mutateState(orchestratorId, (current) => ({
          ...current,
          delegations: current.delegations.map((delegation) =>
            delegation.threadId === workerId ? { ...delegation, status } : delegation,
          ),
        }));
        if (Date.now() >= deadline && status !== "idle" && status !== "error") {
          return { status, output: null, running: true };
        }
        let output: string | null = null;
        try {
          const result = await bb.sdk.threads.output({ threadId: workerId });
          output = (result as { output?: string | null }).output ?? null;
        } catch (cause) {
          bb.log.warn(`worker output read failed for ${workerId}: ${String(cause)}`);
        }
        await maybeArchive(orchestratorId, workerId);
        return { status, output, running: false };
      }

      /** The text the orchestrator gets back about one finished worker. */
      function report(workerId: string, settled: Settled): string {
        if (settled.running) {
          return `Worker ${workerId} is still running after ${Math.round(timeoutMs / 1000)}s (status: ${settled.status ?? "unknown"}). Delegate the next unit, or wait and check it again. Do not start doing its work yourself.`;
        }
        const trimmed = (settled.output ?? "").trim();
        const body =
          trimmed === ""
            ? "(the worker produced no final text. Open the thread to see what it did.)"
            : trimmed.length > 12_000
              ? `${trimmed.slice(0, 12_000)}\n\n[truncated]`
              : trimmed;
        return `Worker ${workerId} finished with status "${settled.status ?? "unknown"}".\n\n${body}\n\nReview it. If it is wrong or incomplete, send a follow-up to a worker. Do not fix it yourself.`;
      }

      /**
       * Re-delegate the same brief on the fallback, which inherits every field
       * it does not name from the execution the first attempt used.
       */
      async function retryOnFallback(fallback: WorkerExecution, reason: string): Promise<string> {
        const retryExec = reconcile({ ...workerExec, ...fallback });
        const target = retryExec.model ?? "the project default";
        bb.log.warn(`${reason} Retrying on ${target}.`);
        const retryId = await spawnWorker(retryExec, `${workerTitle} (fallback)`, {
          pluginInitiated: true,
        });
        const settled = await settle(retryId, timeoutMs);
        return `${reason} Re-delegated the same brief on \`${target}\` as worker ${retryId}.\n\n${await finish(retryId, `${workerTitle} (fallback)`, settled)}`;
      }

      /**
       * Spawn a second worker to check the first one's work, on the same
       * execution, and hand its report back with the worker's. The check unit
       * is recorded as evidence for `workerId` and is not itself a unit the
       * orchestrator has to judge.
       */
      async function runVerifier(
        workerId: string,
        workerLabel: string,
        workerOutput: string | null,
      ): Promise<string> {
        const brief = buildVerifierBrief({ task, workerTitle: workerLabel, workerOutput });
        const verifierExec = reconcile({ ...workerExec });
        let verifierId: string;
        try {
          verifierId = await spawnWorker(verifierExec, `${workerLabel} (check)`, {
            brief,
            verifierFor: workerId,
            pluginInitiated: true,
          });
        } catch (cause) {
          bb.log.warn(`check unit for ${workerId} could not start: ${String(cause)}`);
          return `\n\nNo check unit ran: ${String(cause)}`;
        }
        await mutateState(orchestratorId, (current) => ({
          ...current,
          delegations: current.delegations.map((delegation) =>
            delegation.threadId === workerId ? { ...delegation, verifiedBy: verifierId } : delegation,
          ),
        }));
        const checked = await settle(verifierId, timeoutMs);
        const verdict = (checked.output ?? "").trim();
        return `\n\nCheck unit ${verifierId} ran the same brief.${
          checked.running
            ? " It is still running, so check it before you accept the work."
            : verdict === ""
              ? " It produced no final text, so open it before you accept the work."
              : `\n\n${verdict.length > 8_000 ? `${verdict.slice(0, 8_000)}\n\n[truncated]` : verdict}`
        }`;
      }

      /** The worker's report, plus an independent check when one was asked for. */
      async function finish(
        workerId: string,
        workerLabel: string,
        settled: Settled,
      ): Promise<string> {
        const reported = report(workerId, settled);
        // Checking a worker that never ran is pointless: there is nothing to
        // inspect, and the orchestrator has to re-delegate that unit anyway.
        if (verify !== true || settled.running || settled.status === "error") return reported;
        return `${reported}${await runVerifier(workerId, workerLabel, settled.output)}`;
      }

      const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 900, 10), 3600) * 1000;
      const fallback = live.worker.fallback;
      let workerId: string;
      try {
        workerId = await spawnWorker(workerExec, workerTitle);
      } catch (cause) {
        // A cap is our own refusal, not a provider that could not start: send
        // it straight back so the orchestrator changes what it is doing.
        if (cause instanceof WorkerBudgetError) throw cause;
        // A spawn that never started a worker is the clearest case for the
        // fallback: the provider could not serve the requested execution at all.
        if (fallback === undefined) throw cause;
        return await retryOnFallback(
          fallback,
          `Worker could not start on \`${workerExec.model ?? "the project default"}\`: ${String(cause)}`,
        );
      }

      if (waitForResult === false) {
        const retry = fallback === undefined ? "" : " If it fails, re-delegate it on the configured fallback.";
        return `Delegated without waiting.\nWorker thread ${workerId}, titled "${workerTitle}"\nCheck on it later and fold its result into your report.${retry}`;
      }

      const first = await settle(workerId, timeoutMs);
      if (first.running || first.status !== "error" || fallback === undefined) {
        return await finish(workerId, workerTitle, first);
      }
      return await retryOnFallback(fallback, `Worker ${workerId} failed.`);
    },
  });

  bb.agents.registerTool({
    name: REVIEW_TOOL,
    description:
      "Record your verdict on one worker's output. Call it once per worker whose result you used, before you report, because the watchdog checks for it. `rejected` means the unit is re-delegated to a worker, never patched by you.",
    instructions:
      "Judge every worker whose result you used and record the verdict with orchestrator_review before you finish the turn.",
    presentation: {
      label: {
        pending: "Recording a worker review",
        completed: "Recorded a worker review",
      },
    },
    parameters: z.object({
      workerThreadId: z
        .string()
        .min(1)
        .max(120)
        .describe("The worker thread whose output you judged."),
      verdict: z
        .enum(REVIEW_VERDICTS)
        .describe("accepted, or rejected when the result is wrong or incomplete."),
      notes: z
        .string()
        .max(2_000)
        .optional()
        .describe("What you checked and what you concluded."),
      verifiedBy: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("The check unit's thread id, when one ran."),
    }),
    async execute({ workerThreadId, verdict, notes, verifiedBy }, { threadId }) {
      if (threadId === undefined) {
        throw new Error(`${REVIEW_TOOL} needs a thread context.`);
      }
      const state = await getState(threadId);
      const known = state?.delegations ?? [];
      if (!known.some((delegation) => delegation.threadId === workerThreadId)) {
        const ids = known.map((delegation) => delegation.threadId).join(", ");
        throw new Error(
          `This thread has no worker ${workerThreadId}.${ids === "" ? " It has delegated nothing yet." : ` Workers it delegated: ${ids}.`}`,
        );
      }
      const updated = await mutateState(threadId, (current) => ({
        ...current,
        delegations: current.delegations.map((delegation) =>
          delegation.threadId === workerThreadId
            ? {
                ...delegation,
                verdict,
                notes: notes ?? delegation.notes ?? null,
                reviewedAt: Date.now(),
                ...(verifiedBy === undefined ? {} : { verifiedBy }),
              }
            : delegation,
        ),
      }));
      // Recording a verdict is the moment the orchestrator demonstrably read the
      // result, which is what retention waits for.
      await maybeArchive(threadId, workerThreadId);
      const reviewed = updated?.delegations.find(
        (delegation) => delegation.threadId === workerThreadId,
      );
      if (reviewed?.verifiedBy != null) {
        await maybeArchive(threadId, reviewed.verifiedBy);
      }
      const remaining = unreviewedOf(updated?.delegations ?? []).length;
      const tail =
        remaining === 0
          ? " Every worker has a verdict."
          : ` ${remaining} worker${remaining === 1 ? "" : "s"} still unjudged.`;
      return verdict === "rejected"
        ? `Recorded rejected for ${workerThreadId}. Re-delegate that unit to a worker. Do not fix it yourself.${tail}`
        : `Recorded accepted for ${workerThreadId}.${tail}`;
    },
  });

  bb.agents.configure((context) => {
    // The mirror is the only source of truth here. `configure` is synchronous
    // and receives no createdAt, so it cannot tell a thread created under the
    // new-thread default from one that merely predates it, and guessing here is
    // what once governed every mirror-less thread in the app. The dispatch
    // hook, which does have createdAt, is the single place the default lands.
    const mirror = readMirror(context.pluginMetadata as Record<string, unknown>);
    const enabled = mirror !== null && mirror.enabled;
    if (!enabled) return { tools: [], skills: [] };
    const enforcement = mirror?.enforcement ?? live.enforcement;
    const state = cache?.[context.thread.id];
    const reminders =
      state === undefined || state.violations.length === 0
        ? undefined
        : state.violations.slice(-5).map((violation) => violation.detail);
    return {
      tools: [DELEGATE_TOOL, REVIEW_TOOL],
      skills: [],
      instructions: buildInstructions({
        enforcement,
        allowReadCommands: live.allowReadCommands,
        reminders,
        workerConfig: live.worker,
        extra: extraInstructions,
        preset: live.contractPreset,
      }),
    };
  });

  // --- layer 2: the dispatch checkpoint ------------------------------------

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const threadId = ctx.thread.id;
    try {
      let state = await getState(threadId);
      if (state === undefined) {
        const qualifies =
          live.defaultForNewThreads &&
          live.defaultEnabledAtMs > 0 &&
          ctx.thread.createdAt >= live.defaultEnabledAtMs &&
          // A preference for threads *you* start. Plugin-spawned background
          // workers (recap runners, watchers) are root threads too, and a
          // background worker that may only delegate is a background worker
          // that does nothing.
          ctx.initiator === "user" &&
          defaultAppliesTo({
            parentThreadId: ctx.thread.parentThreadId,
            originPluginId: ctx.thread.originPluginId,
          });
        if (qualifies) {
          const head = await timelineHead(threadId);
          state = await mutateState(threadId, (current) => ({
            ...current,
            enabled: true,
            enforcement: null,
            enabledAt: new Date().toISOString(),
            lastSeq: head.seq,
            graceTurnIds: head.turnId === null ? [] : [head.turnId],
            graceSlots: 1,
          }));
          bb.log.info(`orchestrator mode applied by default to ${threadId}`);
        }
      }
      if (state === undefined) {
        // We have never enforced this thread and the default does not reach it,
        // so there is no mirror of ours to correct: leave the dispatch path
        // without touching the SDK. A thread we did enable always has state,
        // so a forged mirror is still caught and rewritten below.
        return { action: "proceed" as const };
      }
      await syncMirror(threadId, state.enabled, state.enforcement);
      if (state.enabled) {
        // A dispatch is where a new turn begins, so this is where the per-turn
        // delegation budget starts counting.
        await mutateState(threadId, (current) => ({ ...current, turnStartedAt: Date.now() }));
        scheduleScan(threadId, 0);
      }
    } catch (cause) {
      // Never block a dispatch because the mirror could not be refreshed; the
      // next turn tries again and the watchdog still reads authoritative state.
      bb.log.warn(`dispatch sync failed for ${threadId}: ${String(cause)}`);
    }
    return { action: "proceed" as const };
  });

  // --- layer 3: the watchdog ----------------------------------------------

  const scanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scanning = new Set<string>();
  /** Set on dispose so an in-flight scan stops touching `bb.sdk`. */
  let disposed = false;

  function scheduleScan(threadId: string, delayMs = 750): void {
    if (disposed) return;
    const existing = scanTimers.get(threadId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      scanTimers.delete(threadId);
      void runScan(threadId);
    }, delayMs);
    // Do not hold the process open for a pending scan.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    scanTimers.set(threadId, timer);
  }

  async function runScan(threadId: string): Promise<void> {
    if (disposed || scanning.has(threadId)) return;
    scanning.add(threadId);
    try {
      await scan(threadId);
    } catch (cause) {
      bb.log.warn(`scan failed for ${threadId}: ${String(cause)}`);
    } finally {
      scanning.delete(threadId);
    }
  }

  async function scan(threadId: string): Promise<void> {
    const state = await getState(threadId);
    if (state === undefined || !state.enabled) return;
    const enforcement = effectiveEnforcement(state);
    if (enforcement === "instruct") return;

    const timeline = await bb.sdk.threads.timeline({
      threadId,
      includeNestedRows: "true",
      ...(state.lastSeq > 0 ? { afterSequence: String(state.lastSeq) } : {}),
    });
    // Incremental responses carry row patches instead of full rows. Nested
    // rows keep work visible after a completed turn collapses to a summary.
    const rows = asScanRows(timeline.delta?.upsertRows ?? timeline.rows);
    const enabledAtMs = state.enabledAt === null ? 0 : Date.parse(state.enabledAt);
    // A missing or malformed maxSeq must not poison the cursor: Math.max(2, undefined) is NaN, which persists as null.
    const reportedMaxSeq = typeof timeline.maxSeq === "number" && Number.isFinite(timeline.maxSeq) ? timeline.maxSeq : 0;
    let maxSeq = Math.max(state.lastSeq, reportedMaxSeq);
    const graceTurnIds = [...state.graceTurnIds];
    const fresh: Violation[] = [];
    // The turn the batch is about: the newest row that produced a violation.
    // Block mode stops and nudges this turn, not the first one in the batch.
    let liveTurnKey: string | null = null;
    let liveSeq = -1;
    for (const row of rows) {
      const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
      if (seq > maxSeq) maxSeq = seq;
      if (seq !== 0 && seq <= state.lastSeq) continue;
      try {
        // A later turn can reuse a row id, so the sequence disambiguates a genuine second delivery from a new act.
        if (state.seenRowIds.includes(seenKey(row))) continue;
        const turnId = row.turnId ?? null;
        // Which turns predate the enable is decided by `startedAt` where the row
        // carries one: an earlier timestamp is history, and history must not
        // spend a grace slot. A row without one is a partial or delta row (the
        // timeline puts startedAt on the completed summary, not on every
        // patch), so "unknown" counts as present and the first post-enable turn
        // is still excused.
        const startedAt = typeof row.startedAt === "number" ? row.startedAt : enabledAtMs;
        if (
          turnId !== null &&
          !graceTurnIds.includes(turnId) &&
          graceTurnIds.length < state.graceSlots &&
          startedAt >= enabledAtMs
        ) {
          graceTurnIds.push(turnId);
        }
        // Turns that ran before the session could gain the contract are never
        // judged, only recorded.
        if (turnId !== null && graceTurnIds.includes(turnId)) continue;
        const violation = classifyRow(row, { allowReadCommands: live.allowReadCommands });
        if (violation !== null) {
          fresh.push(violation);
          if (seq >= liveSeq) {
            liveSeq = seq;
            // A turn with no id cannot share the sentinel with the next such
            // turn: "unknown" would suppress every later stop. The row id is
            // unique per delivery, so the key still names one live turn.
            liveTurnKey = turnId ?? `unknown:${violation.id}`;
          }
        }
      } catch (cause) {
        // A malformed row must not wedge the watchdog: the cursor still advances
        // past it, so the next scan keeps enforcing instead of failing forever.
        bb.log.warn(`scan skipped a malformed row in ${threadId}: ${String(cause)}`);
      }
    }

    if (fresh.length === 0 && maxSeq === state.lastSeq) return;

    const updated = await mutateState(threadId, (current) => ({
      ...current,
      lastSeq: Math.max(current.lastSeq, maxSeq),
      graceTurnIds,
      seenRowIds: [...current.seenRowIds, ...rows.map(seenKey)].slice(-MAX_SEEN_ROWS),
      violations: [...current.violations, ...fresh].slice(-MAX_VIOLATIONS),
    }));
    if (fresh.length === 0) return;

    bb.log.warn(
      `${threadId} did direct work ${fresh.length} time(s): ${fresh
        .map((violation) => violation.detail)
        .join("; ")}`,
    );
    bb.realtime.publish(STATE_CHANGED, { at: Date.now(), threadId, violations: fresh.length });
    await intervene(threadId, updated, fresh, enforcement, liveTurnKey ?? fresh[fresh.length - 1]!.id);
  }

  async function intervene(
    threadId: string,
    state: ThreadState | undefined,
    violations: readonly Violation[],
    enforcement: EnforcementLevel,
    /** Names the live turn for `lastStopTurnId`/`lastNudgeTurnId`. */
    liveTurnKey: string,
  ): Promise<void> {
    if (state === undefined) return;

    if (enforcement === "block" && state.lastStopTurnId !== liveTurnKey) {
      try {
        await bb.sdk.threads.stop({ threadId });
        await mutateState(threadId, (current) => ({ ...current, lastStopTurnId: liveTurnKey }));
        bb.log.warn(`stopped ${threadId} for doing direct work`);
      } catch (cause) {
        bb.log.warn(`stop failed for ${threadId}: ${String(cause)}`);
      }
    }

    if (state.lastNudgeTurnId === liveTurnKey) return;
    if (state.nudgeCount >= live.maxNudges) return;
    const text = buildNudge(violations, enforcement);
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
      await mutateState(threadId, (current) => ({
        ...current,
        nudgeCount: current.nudgeCount + 1,
        lastNudgeTurnId: liveTurnKey,
      }));
    } catch (cause) {
      bb.log.warn(`nudge failed for ${threadId}: ${String(cause)}`);
    }
  }

  bb.events.on("experimental_thread.events", ({ thread }) => {
    void (async () => {
      const state = await getState(thread.id);
      if (state?.enabled === true) scheduleScan(thread.id);
    })();
  });

  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      await syncDelegationFor(thread.id, thread.status);
      const state = await getState(thread.id);
      if (state?.enabled === true) {
        scheduleScan(thread.id, 250);
        await checkReviews(thread.id);
      }
    })();
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    void (async () => {
      await syncDelegationFor(thread.id, thread.status, error);
    })();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    void mutateState(thread.id, () => null);
  });

  /**
   * The orchestrator whose delegation this worker is, if any. A worker that
   * settles while its orchestrator is not watching it is only visible through
   * this lookup. A delegation made with `waitForResult: false` settles that way.
   */
  function ownerOf(workerThreadId: string): string | undefined {
    for (const [threadId, state] of Object.entries(cache ?? {})) {
      if (state.delegations.some((delegation) => delegation.threadId === workerThreadId)) {
        return threadId;
      }
    }
    return undefined;
  }

  /**
   * Keep a delegation's record in step when its worker settles on its own, and
   * carry the failure text across so the orchestrator is told why, not just
   * that it errored.
   */
  async function syncDelegationFor(
    workerThreadId: string,
    status: string,
    failure?: string | null,
  ): Promise<void> {
    await readAll();
    const owner = ownerOf(workerThreadId);
    if (owner === undefined) return;
    await mutateState(owner, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) =>
        delegation.threadId === workerThreadId
          ? {
              ...delegation,
              status,
              ...(failure === undefined || failure === null ? {} : { failure }),
            }
          : delegation,
      ),
    }));
    await checkReviews(owner);
  }

  /**
   * The review gate: a turn that ended with workers nobody judged gets one
   * reminder, and only while its orchestrator is idle, since a nudge sent mid-turn
   * would queue behind the very work it is asking about.
   *
   * A finished turn cannot be stopped after the fact, so `block` behaves as
   * `guard` here. That limit is documented rather than papered over.
   */
  /**
   * Archive a worker the retention policy covers. Called where the plugin learns
   * the orchestrator has read a result: when it settles a worker it was waiting
   * on, and when a verdict is recorded. The second place matters because a
   * delegation made with `waitForResult: false` is never settled here, and
   * retention that only worked for waited delegations would be a trap.
   */
  async function maybeArchive(ownerThreadId: string, workerId: string): Promise<void> {
    if (live.workerRetention === "keep") return;
    const state = await getState(ownerThreadId);
    const delegation = state?.delegations.find((entry) => entry.threadId === workerId);
    if (delegation === undefined) return;
    if (live.workerRetention === "archive-checks" && delegation.verifierFor === undefined) {
      return;
    }
    try {
      await bb.sdk.threads.archive({ threadId: workerId });
      bb.log.info(`archived worker ${workerId} (retention: ${live.workerRetention})`);
    } catch (cause) {
      bb.log.warn(`could not archive worker ${workerId}: ${String(cause)}`);
    }
  }

  /**
   * Refuse a delegation that would exceed either fan-out cap. Both counts come
   * from this plugin's own records, so the orchestrator is told which cap it hit
   * and what to do about it.
   */
  async function assertWithinBudget(
    threadId: string,
    countPerTurn: boolean,
  ): Promise<void> {
    // Inside the write queue, and counting the claims already in flight: a check
    // that reads the state beside another claim lets two simultaneous
    // delegations both pass their cap.
    await enqueue(async () => {
      const state = await getState(threadId);
      if (state === undefined) return;
      const pending = pendingClaims.get(threadId) ?? { parallel: 0, turn: 0 };
      if (live.maxParallelWorkers > 0) {
        const inFlight =
          state.delegations.filter((delegation) => delegation.status === null).length + pending.parallel;
        if (inFlight >= live.maxParallelWorkers) {
          throw new WorkerBudgetError(
            `${inFlight} workers are still running and this plugin caps parallel workers at ${live.maxParallelWorkers}. Wait for one to finish, or raise maxParallelWorkers (0 removes the cap).`,
          );
        }
      }
      // The per-turn cap governs what the orchestrator chose to fan out. A check
      // unit or a fallback retry is this plugin's own decision, and counting it
      // would let a tight cap silently defeat `verify: true`.
      if (countPerTurn && live.maxDelegationsPerTurn > 0) {
        // Until the first dispatch of a session there is no turn yet, so the
        // window starts when the mode was enabled rather than being ignored.
        const enabledAtMs = state.enabledAt === null ? 0 : Date.parse(state.enabledAt);
        const since = Math.max(state.turnStartedAt, Number.isNaN(enabledAtMs) ? 0 : enabledAtMs);
        const thisTurn =
          state.delegations.filter((delegation) => delegation.createdAt >= since).length + pending.turn;
        if (thisTurn >= live.maxDelegationsPerTurn) {
          throw new WorkerBudgetError(
            `This turn has delegated ${thisTurn} workers and this plugin caps a turn at ${live.maxDelegationsPerTurn}. Fold what came back into a report, or raise maxDelegationsPerTurn (0 removes the cap).`,
          );
        }
      }
      reserveClaim(threadId, countPerTurn);
    });
  }

  /**
   * The marker for the unjudged set when a reminder is due, or undefined when the
   * gate is closed: not enabled, instruct level, nothing unjudged, already
   * reminded for this set, or out of reminders.
   */
  function reviewNudgeMarker(state: ThreadState): string | undefined {
    if (!state.enabled) return undefined;
    if (effectiveEnforcement(state) === "instruct") return undefined;
    const unreviewed = unreviewedOf(state.delegations);
    if (unreviewed.length === 0) return undefined;
    const marker = unreviewed
      .map((delegation) => delegation.threadId)
      .sort()
      .join(",");
    if (state.lastReviewNudge === marker) return undefined;
    if (state.nudgeCount >= live.maxNudges) return undefined;
    return marker;
  }

  async function checkReviews(threadId: string): Promise<void> {
    // Cheap guard first: an unrelated idle event should not cost a thread read.
    const before = await getState(threadId);
    if (reviewNudgeMarker(before ?? emptyState(Date.now())) === undefined) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.status !== "idle" && thread.status !== "error") return;
    } catch (cause) {
      bb.log.warn(`review gate could not read ${threadId}: ${String(cause)}`);
      return;
    }
    // Claim inside the serialized mutation: two events for the same unjudged set
    // must not both send a reminder and spend two of the budget.
    let claimed: { titles: string[]; count: number; marker: string; enforcement: EnforcementLevel } | undefined;
    await mutateState(threadId, (current) => {
      const marker = reviewNudgeMarker(current);
      if (marker === undefined) return current;
      const unreviewed = unreviewedOf(current.delegations);
      claimed = {
        titles: unreviewed.map((delegation) => delegation.title),
        count: unreviewed.length,
        marker,
        enforcement: effectiveEnforcement(current),
      };
      return { ...current, nudgeCount: current.nudgeCount + 1, lastReviewNudge: marker };
    });
    if (claimed === undefined) return;
    const { titles, count, marker, enforcement } = claimed;
    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: buildReviewNudge(titles, enforcement),
            mentions: [],
          },
        ],
      });
      bb.log.warn(`${threadId} ended a turn with ${count} unjudged worker(s)`);
    } catch (cause) {
      bb.log.warn(`review nudge failed for ${threadId}: ${String(cause)}`);
      // Give the reminder back: the marker would otherwise mute the gate for this set.
      await mutateState(threadId, (current) =>
        current.lastReviewNudge === marker
          ? { ...current, nudgeCount: Math.max(0, current.nudgeCount - 1), lastReviewNudge: null }
          : current,
      ).catch(() => undefined);
    }
  }

  // --- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    get_state: async ({ threadId }) => toDto(threadId, await getState(threadId)),
    set_enabled: async ({ threadId, enabled, enforcement }) => {
      const state = await setEnabled(threadId, enabled, enforcement ?? null);
      return toDto(threadId, state);
    },
    get_default: async () => ({ enabled: live.defaultForNewThreads }),
    set_default: async ({ enabled }) => ({ enabled: await setDefault(enabled) }),
    get_contract: async ({ threadId }) => ({
      text: await contractText(threadId),
      extra: extraInstructions,
      limit: EXTRA_INSTRUCTION_LIMIT,
    }),
    set_contract: async ({ extra }) => {
      // Store first: the returned text has to be the text this write produced,
      // not the one it replaced.
      const stored = await setExtraInstructions(extra);
      return { text: await contractText(null), extra: stored, limit: EXTRA_INSTRUCTION_LIMIT };
    },
    get_worker_execution: async () => live.worker,
    set_worker_execution: async (next) => setWorkerConfig(next),
    clear_violations: async ({ threadId }) => {
      const state = await clearViolations(threadId);
      return toDto(threadId, state);
    },
  });

  // --- CLI -----------------------------------------------------------------

  const threadOption = {
    thread: {
      type: "string",
      description: "Thread id. Defaults to the thread running this command.",
      aliases: ["t"],
    },
    json: { type: "boolean", description: "Emit machine-readable JSON" },
  } as const;

  function resolveThreadId(explicit: string | undefined, ctx: { threadId?: string }): string {
    const threadId = explicit?.trim() || ctx.threadId;
    if (threadId === undefined || threadId === "") {
      throw new PluginCliError("no thread to act on", {
        code: "thread_required",
        hint: "Pass --thread <thread-id>, or run this inside a bb thread.",
      });
    }
    return threadId;
  }

  function render(
    json: boolean | undefined,
    value: unknown,
    text: string,
  ): { exitCode: number; stdout: string } {
    return { exitCode: 0, stdout: json === true ? JSON.stringify(value, null, 2) : text };
  }

  /** The stored presets, one line each. */
  function describePresets(presets: WorkerConfig["presets"]): string {
    const entries = Object.entries(presets ?? {});
    return entries.length === 0
      ? ""
      : entries
          .map(([name, execution]) => `\n  preset ${name}: ${describeWorkerExecution(execution)}`)
          .join("");
  }

  /** The retry target, named after the execution it belongs to. */
  function describeFallback(fallback: WorkerConfig["fallback"]): string {
    return fallback === undefined
      ? ""
      : `\nA failed worker is retried on: ${describeWorkerExecution(fallback)}`;
  }

  /** One line naming what a delegation's worker will run on. */
  function describeWorkerExecution(exec: OrchestratorStateDto["workerExecution"]): string {
    const parts = [
      exec.providerId === undefined ? null : `provider ${exec.providerId}`,
      exec.model === undefined ? null : `model ${exec.model}`,
      exec.reasoningLevel === undefined ? null : `reasoning ${exec.reasoningLevel}`,
      exec.serviceTier === undefined ? null : `tier ${exec.serviceTier}`,
      exec.permissionMode === undefined ? null : `permission ${exec.permissionMode}`,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? "project default (no worker override)" : parts.join(", ");
  }

  function describeState(threadId: string, state: OrchestratorStateDto): string {
    const lines = [
      `thread ${threadId}`,
      `  orchestrator mode: ${state.enabled ? "ON" : "off"}`,
      `  enforcement:       ${state.effectiveEnforcement}${
        state.enforcement === null ? " (plugin default)" : " (thread override)"
      }`,
      `  violations:        ${state.violations.length}`,
      `  nudges sent:       ${state.nudgeCount} of ${state.maxNudges}`,
      `  delegations:       ${state.delegations.length}`,
      `  workers run as:    ${describeWorkerExecution(state.workerExecution)}`,
      `  reviews:           ${state.reviewed} judged, ${state.unreviewed} waiting`,
      `  fan-out cap:       ${
        state.maxParallelWorkers === 0 ? "none" : `${state.maxParallelWorkers} in flight`
      }, ${state.maxDelegationsPerTurn === 0 ? "none" : `${state.maxDelegationsPerTurn} per turn`}`,
    ];
    if (state.violations.length > 0) {
      lines.push("  recent direct work:");
      for (const violation of state.violations.slice(-5)) {
        lines.push(`    - ${violation.detail}`);
      }
    }
    return lines.join("\n");
  }

  bb.cli.register(
    defineCli({
      name: "orchestrator-mode",
      summary: "Force a thread to delegate every unit of work instead of doing it",
      description:
        "Turn orchestrator mode on for a thread and it may only read, plan, ask, delegate and report. `bb orchestrator-mode --help` for every command.",
      commands: {
        status: cliCommand({
          summary: "Show a thread's orchestrator mode, violations and delegations",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const state = toDto(threadId, await getState(threadId));
            return render(input.options.json, state, describeState(threadId, state));
          },
        }),
        on: cliCommand({
          summary: "Turn orchestrator mode on for a thread",
          options: {
            ...threadOption,
            enforcement: {
              type: "enum",
              values: [...ENFORCEMENT_LEVELS],
              description: "Override the plugin's enforcement level for this thread",
            },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const enforcement =
              input.options.enforcement === undefined
                ? null
                : (input.options.enforcement as EnforcementLevel);
            const state = await setEnabled(threadId, true, enforcement);
            await syncMirror(threadId, true, state.enforcement);
            const dto = toDto(threadId, state);
            return render(
              input.options.json,
              dto,
              `Orchestrator mode ON for ${threadId} (${dto.effectiveEnforcement}).\n` +
                "Applies when the provider session is next constructed. A live session keeps the instructions it started with.",
            );
          },
        }),
        off: cliCommand({
          summary: "Turn orchestrator mode off for a thread",
          options: threadOption,
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const state = await setEnabled(threadId, false, null);
            const dto = toDto(threadId, state);
            return render(input.options.json, dto, `Orchestrator mode off for ${threadId}.`);
          },
        }),
        contract: cliCommand({
          summary: "Print the exact instructions this plugin injects into a thread",
          options: {
            thread: {
              type: "string",
              description: "Thread id. Defaults to this thread, or to a new one when absent.",
              aliases: ["t"],
            },
            rules: {
              type: "string",
              description: "Replace the project rules appended to the contract",
            },
            "clear-rules": {
              type: "boolean",
              description: "Remove the project rules",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = input.options.thread?.trim() || ctx.threadId || null;
            if (input.options["clear-rules"] === true) {
              await setExtraInstructions("");
            } else if (input.options.rules !== undefined) {
              await setExtraInstructions(input.options.rules);
            }
            const text = await contractText(threadId);
            return render(
              input.options.json,
              {
                threadId,
                chars: text.length,
                ceiling: 4096,
                extra: extraInstructions,
                extraLimit: EXTRA_INSTRUCTION_LIMIT,
                text,
              },
              text,
            );
          },
        }),
        violations: cliCommand({
          summary: "List the direct work a thread did, or clear the record",
          options: { ...threadOption, clear: { type: "boolean", description: "Clear the record" } },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            if (input.options.clear === true) {
              const state = await clearViolations(threadId);
              return render(input.options.json, toDto(threadId, state), `Cleared for ${threadId}.`);
            }
            const state = await getState(threadId);
            const violations = state?.violations ?? [];
            if (violations.length === 0) {
              return render(input.options.json, [], `No direct work recorded for ${threadId}.`);
            }
            const text = violations
              .map(
                (violation) =>
                  `${new Date(violation.detectedAt).toISOString()}  [${violation.workKind}] ${violation.detail}`,
              )
              .join("\n");
            return render(input.options.json, violations, text);
          },
        }),
        default: cliCommand({
          summary: "Show or set whether new threads start in orchestrator mode",
          positionals: [
            { name: "state", description: "on or off; omit to show the current default" },
          ],
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const requested = input.positionals.state?.toLowerCase();
            if (requested === undefined || requested === "") {
              return render(input.options.json, { enabled: live.defaultForNewThreads }, 
                `New threads start in orchestrator mode: ${live.defaultForNewThreads ? "yes" : "no"}`);
            }
            if (requested !== "on" && requested !== "off") {
              throw new PluginCliError(`expected "on" or "off", got "${requested}"`, {
                code: "invalid_state",
              });
            }
            const enabled = requested === "on";
            await setDefault(enabled);
            return render(input.options.json, { enabled }, 
              `New threads start in orchestrator mode: ${enabled ? "yes" : "no"}`);
          },
        }),
        worker: cliCommand({
          summary: "Show or set the execution every delegated worker defaults to",
          options: {
            clear: { type: "boolean", description: "Clear it, so workers inherit again" },
            provider: { type: "string", description: "Provider id, from `bb provider list`" },
            model: {
              type: "string",
              description: "Model id, from `bb provider models <provider>`",
            },
            reasoning: {
              type: "enum",
              values: [...REASONING_LEVELS],
              description: "Reasoning level for workers",
            },
            tier: {
              type: "enum",
              values: [...SERVICE_TIERS],
              description: "Service tier for workers",
            },
            permission: {
              type: "enum",
              values: [...PERMISSION_MODES],
              description: "Permission mode for workers",
            },
            "fallback-provider": {
              type: "string",
              description: "Provider to retry a failed worker on; needs --fallback-model",
            },
            "fallback-model": {
              type: "string",
              description: "Model to retry a failed worker on; needs --fallback-provider",
            },
            "fallback-permission": {
              type: "enum",
              values: [...PERMISSION_MODES],
              description: "Permission mode for a retried worker",
            },
            "clear-fallback": {
              type: "boolean",
              description: "Stop retrying failed workers",
            },
            preset: {
              type: "enum",
              values: [...WORKER_PRESETS],
              description:
                "Write these execution flags to a named preset instead of to the worker execution",
            },
            "clear-preset": {
              type: "enum",
              values: [...WORKER_PRESETS],
              description: "Delete a named preset",
            },
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const chosen = {
              ...(input.options.provider === undefined ? {} : { providerId: input.options.provider }),
              ...(input.options.model === undefined ? {} : { model: input.options.model }),
              ...(input.options.reasoning === undefined
                ? {}
                : { reasoningLevel: input.options.reasoning as ReasoningLevel }),
              ...(input.options.tier === undefined
                ? {}
                : { serviceTier: input.options.tier as ServiceTier }),
              ...(input.options.permission === undefined
                ? {}
                : { permissionMode: input.options.permission as PermissionMode }),
            };
            const fallbackProvider = input.options["fallback-provider"];
            const fallbackModel = input.options["fallback-model"];
            const fallbackPermission = input.options["fallback-permission"];
            // A patch, not a replacement: each flag below is merged over the
            // stored fallback, so `--fallback-permission` alone keeps its
            // provider and model.
            const fallbackPatch: WorkerExecution = {
              ...(fallbackProvider === undefined ? {} : { providerId: fallbackProvider }),
              ...(fallbackModel === undefined ? {} : { model: fallbackModel }),
              ...(fallbackPermission === undefined
                ? {}
                : { permissionMode: fallbackPermission as PermissionMode }),
            };
            const hasFallbackPatch = Object.keys(fallbackPatch).length > 0;
            const clearing = input.options.clear === true;
            const clearFallback = input.options["clear-fallback"] === true;
            const presetName = input.options.preset;
            const clearPreset = input.options["clear-preset"];
            if (
              !clearing &&
              !clearFallback &&
              !hasFallbackPatch &&
              clearPreset === undefined &&
              Object.keys(chosen).length === 0
            ) {
              // Nothing named a value to write, so this is a read: `--preset
              // build` on its own asks for a preset with no contents, and
              // storing `{}` would leave a no-op preset a delegation could name.
              return render(
                input.options.json,
                live.worker,
                `Workers run as: ${describeWorkerExecution(workerDefaults())}${describeFallback(live.worker.fallback)}${describePresets(live.worker.presets)}`,
              );
            }
            // Each flag changes one thing and leaves the rest of the stored
            // configuration alone, so `worker --permission auto` on an existing
            // choice does not drop its provider and model.
            let next: WorkerConfig | null = null;
            if (!clearing) {
              if (presetName !== undefined || clearPreset !== undefined) {
                // A preset edit leaves the worker execution and the retry target
                // untouched.
                next = { ...live.worker };
                const presets = { ...(next.presets ?? {}) };
                if (presetName !== undefined && Object.keys(chosen).length > 0) {
                  presets[presetName] = { ...presets[presetName], ...chosen };
                } else if (clearPreset !== undefined) {
                  delete presets[clearPreset];
                }
                next.presets = Object.keys(presets).length === 0 ? undefined : presets;
              } else {
                next = { ...workerDefaults(), ...chosen };
                if (!clearFallback) {
                  const target = { ...live.worker.fallback, ...fallbackPatch };
                  if (target.providerId !== undefined || target.model !== undefined) {
                    next.fallback = target;
                  }
                }
              }
            }
            const stored = await setWorkerConfig(next);
            return render(
              input.options.json,
              stored,
              `Workers run as: ${describeWorkerExecution(stored)}${describeFallback(stored.fallback)}${describePresets(stored.presets)}`,
            );
          },
        }),
      },
    }),
  );

  bb.onDispose(() => {
    disposed = true;
    for (const timer of scanTimers.values()) clearTimeout(timer);
    scanTimers.clear();
    scanning.clear();
  });

  bb.log.info(`loaded (enforcement=${live.enforcement})`);
}
