// bb-plugin-orchestrator-mode — backend.
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
//      new work row, and — in `guard`/`block` — records violations, stops the
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
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_ENFORCEMENT,
  DELEGATE_TOOL,
  ENFORCEMENT_DESCRIPTIONS,
  ENFORCEMENT_LEVELS,
  buildInstructions,
  buildNudge,
  classifyRow,
  defaultAppliesTo,
  isEnforcementLevel,
  readMirror,
  writeMirror,
  type EnforcementLevel,
  type Violation,
} from "./shared";

export type { EnforcementLevel, Violation };
export { DELEGATE_TOOL };

/** Realtime channel the composer surfaces listen on. */
const STATE_CHANGED = "orchestrator-state";

const STATE_KEY = "state";
/** When the "new threads" default was last switched on; null while it is off. */
const DEFAULT_KEY = "default";
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
}

const delegationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  task: z.string(),
  createdAt: z.number(),
  status: z.string().nullable(),
});

const violationSchema = z.object({
  id: z.string(),
  turnId: z.string().nullable(),
  workKind: z.string(),
  detail: z.string(),
  detectedAt: z.number(),
});

const stateSchema = z.object({
  enabled: z.boolean(),
  enforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]).nullable(),
  effectiveEnforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]),
  enabledAt: z.string().nullable(),
  violations: z.array(violationSchema),
  delegations: z.array(delegationSchema),
  nudgeCount: z.number(),
  /** The plugin-wide default, so the new-thread composer can render it. */
  defaultForNewThreads: z.boolean(),
  allowReadCommands: z.boolean(),
  maxNudges: z.number(),
});

export const rpcContract = defineRpcContract({
  get_state: {
    input: z.object({ threadId: z.string().min(1).max(120) }).strict(),
    output: stateSchema,
  },
  set_enabled: {
    input: z
      .object({
        threadId: z.string().min(1).max(120),
        enabled: z.boolean(),
        enforcement: z.enum(ENFORCEMENT_LEVELS as readonly ["instruct", ...EnforcementLevel[]]).nullable().optional(),
      })
      .strict(),
    output: stateSchema,
  },
  get_default: { input: z.null(), output: z.object({ enabled: z.boolean() }) },
  set_default: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  clear_violations: {
    input: z.object({ threadId: z.string().min(1).max(120) }).strict(),
    output: stateSchema,
  },
});

/** A timeline row, narrowed to the fields the classifier reads. */
interface ScanRow {
  id: string;
  kind: string;
  workKind?: string;
  status?: string;
  toolName?: string | null;
  command?: string | null;
  change?: { path?: string | null } | null;
  turnId?: string | null;
  sourceSeqEnd?: number;
  startedAt?: number;
  children?: unknown;
}

function asScanRows(rows: unknown): ScanRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ScanRow[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const candidate = row as ScanRow;
    if (typeof candidate.id !== "string") continue;
    out.push(candidate);
    if (Array.isArray(candidate.children)) out.push(...asScanRows(candidate.children));
  }
  return out;
}

export default async function plugin(bb: BbPluginApi) {
  // --- settings ------------------------------------------------------------

  const settings = bb.settings.define({
    defaultForNewThreads: {
      type: "boolean",
      label: "New threads start in orchestrator mode",
      description:
        "Applies the default to root threads created while it is on. Existing threads are left alone.",
      default: false,
    },
    enforcement: {
      type: "select",
      label: "Enforcement",
      description: ENFORCEMENT_DESCRIPTIONS.guard,
      options: [...ENFORCEMENT_LEVELS],
      default: DEFAULT_ENFORCEMENT,
    },
    allowReadCommands: {
      type: "boolean",
      label: "Read-only shell commands are not work",
      description:
        "Lets an orchestrator run ls/cat/rg/git status/git diff to orient itself. Turning this off treats every command as doing the work.",
      default: true,
    },
    maxNudges: {
      type: "number",
      label: "Maximum corrective nudges per thread",
      description: "Violations keep being recorded after the cap is reached.",
      default: 3,
    },
  });

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
  };

  function applySettings(values: Awaited<ReturnType<typeof settings.get>>): void {
    live.defaultForNewThreads = values.defaultForNewThreads === true;
    live.enforcement = isEnforcementLevel(values.enforcement)
      ? values.enforcement
      : DEFAULT_ENFORCEMENT;
    live.allowReadCommands = values.allowReadCommands !== false;
    const nudges = Number(values.maxNudges);
    live.maxNudges = Number.isFinite(nudges) && nudges >= 0 ? Math.floor(nudges) : 3;
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

  applySettings(await settings.get());
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
  });

  // --- state store ---------------------------------------------------------
  //
  // Authoritative per-thread state lives in this plugin's KV, which the thread's
  // own agent cannot write. Thread metadata carries a mirror of it only because
  // `bb.agents.configure` is synchronous and metadata is its only per-thread
  // input. The dispatch hook rewrites the mirror before every turn.

  let cache: Record<string, ThreadState> | null = null;
  let mutationQueue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<Record<string, ThreadState>> {
    if (cache !== null) return cache;
    const stored = await bb.storage.kv.get<Record<string, ThreadState>>(STATE_KEY);
    cache = stored !== undefined && typeof stored === "object" && stored !== null ? stored : {};
    return cache;
  }

  /**
   * Fill in fields added after a state row was written. A thread enabled by an
   * older build of this plugin must keep being watched after an update instead
   * of crashing the scan on a missing array.
   */
  function normalize(state: ThreadState): ThreadState {
    return {
      ...state,
      violations: Array.isArray(state.violations) ? state.violations : [],
      seenRowIds: Array.isArray(state.seenRowIds) ? state.seenRowIds : [],
      delegations: Array.isArray(state.delegations) ? state.delegations : [],
      graceTurnIds: Array.isArray(state.graceTurnIds) ? state.graceTurnIds : [],
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
    const mutation = mutationQueue.then(async () => {
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
    // A failed mutation rejects its caller without wedging subsequent updates.
    mutationQueue = mutation.catch(() => undefined);
    return mutation;
  }

  function clearViolations(threadId: string): Promise<ThreadState | undefined> {
    return mutateState(threadId, (current) => ({
      ...current,
      violations: [],
      nudgeCount: 0,
      lastNudgeTurnId: null,
      lastStopTurnId: null,
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

  function toDto(threadId: string, state: ThreadState | undefined) {
    const base = state ?? emptyState(Date.now());
    return {
      enabled: state?.enabled ?? false,
      enforcement: base.enforcement,
      effectiveEnforcement: effectiveEnforcement(state),
      enabledAt: base.enabledAt,
      violations: base.violations.slice(-MAX_VIOLATIONS),
      delegations: base.delegations.slice(-MAX_DELEGATIONS),
      nudgeCount: base.nudgeCount,
      defaultForNewThreads: live.defaultForNewThreads,
      allowReadCommands: live.allowReadCommands,
      maxNudges: live.maxNudges,
    };
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
    let active = false;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      active = thread.status === "active";
      if (enabled && active && head.turnId !== null) {
        graceTurnIds = [head.turnId];
        graceSlots = 2;
      }
    } catch (cause) {
      bb.log.warn(`thread status read failed for ${threadId}: ${String(cause)}`);
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
    }));
    await syncMirror(threadId, state?.enabled ?? false, state?.enforcement ?? null);
    if (active) {
      try {
        const text = enabled
          ? buildInstructions({
              enforcement: effectiveEnforcement(state),
              allowReadCommands: live.allowReadCommands,
            })
          : "Orchestrator mode is now off. The earlier orchestrator contract no longer applies; continue following the user's request.";
        await bb.sdk.threads.send({
          threadId,
          mode: "steer",
          input: [{ type: "text", mentions: [], text }],
        });
      } catch (cause) {
        bb.log.warn(`mode notification failed for ${threadId}: ${String(cause)}`);
      }
    }
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

  const delegateParameters = z.object({
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
  });

  async function delegateTask(
    { task, title, waitForResult, timeoutSeconds, hidden }: z.infer<typeof delegateParameters>,
    { threadId, projectId, signal }: PluginCliContext,
  ): Promise<string> {
    if (threadId === undefined) {
      throw new Error("orchestrator_delegate needs a thread context.");
    }
    const parent = await bb.sdk.threads.get({ threadId });
    const environment =
      parent.environmentId === null
        ? { type: "project-default" as const }
        : { type: "reuse" as const, environmentId: parent.environmentId };
    const workerTitle = title?.trim() || task.trim().split("\n")[0]!.slice(0, 120);

    const worker = await bb.sdk.threads.spawn({
      projectId: projectId ?? parent.projectId,
      environment,
      prompt: task,
      title: workerTitle,
      parentThreadId: threadId,
      ...(hidden === true ? { visibility: "hidden" as const } : {}),
      pluginMetadata: { workerFor: threadId },
    });

    await mutateState(threadId, (current) => ({
      ...current,
      delegations: [
        ...current.delegations,
        {
          threadId: worker.id,
          title: workerTitle,
          task: task.slice(0, 400),
          createdAt: Date.now(),
          status: null,
        },
      ].slice(-MAX_DELEGATIONS),
    }));

    if (waitForResult === false) {
      return `Delegated without waiting.\nWorker thread: ${worker.id} — "${workerTitle}"\nCheck on it later and fold its result into your report.`;
    }

    const timeoutMs = Math.min(Math.max(timeoutSeconds ?? 900, 10), 3600) * 1000;
    const deadline = Date.now() + timeoutMs;
    let status: string | null = null;
    try {
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle", timeoutMs, signal });
    } catch {
      // A timeout or an error status both land here; read the real status.
    }
    try {
      const settled = await bb.sdk.threads.get({ threadId: worker.id });
      status = settled.status;
    } catch {
      status = null;
    }
    await mutateState(threadId, (current) => ({
      ...current,
      delegations: current.delegations.map((delegation) =>
        delegation.threadId === worker.id ? { ...delegation, status } : delegation,
      ),
    }));

    if (Date.now() >= deadline && status !== "idle" && status !== "error") {
      return `Worker ${worker.id} is still running after ${Math.round(timeoutMs / 1000)}s (status: ${status ?? "unknown"}). Delegate the next unit, or wait and check it again — do not start doing its work yourself.`;
    }

    let output: string | null = null;
    try {
      const result = await bb.sdk.threads.output({ threadId: worker.id });
      output = (result as { output?: string | null }).output ?? null;
    } catch (cause) {
      bb.log.warn(`worker output read failed for ${worker.id}: ${String(cause)}`);
    }

    const trimmed = (output ?? "").trim();
    const body =
      trimmed === ""
        ? "(the worker produced no final text — open the thread to see what it did)"
        : trimmed.length > 12_000
          ? `${trimmed.slice(0, 12_000)}\n\n[truncated]`
          : trimmed;
    return `Worker ${worker.id} finished with status "${status ?? "unknown"}".\n\n${body}\n\nReview it. If it is wrong or incomplete, send a follow-up to a worker — do not fix it yourself.`;
  }

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
    parameters: delegateParameters,
    execute: delegateTask,
  });

  bb.agents.configure((context) => {
    // The mirror is the only source of truth here. `configure` is synchronous
    // and receives no createdAt, so it cannot tell a thread created under the
    // new-thread default from one that merely predates it — guessing here is
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
      tools: [DELEGATE_TOOL],
      skills: [],
      instructions: buildInstructions({
        enforcement,
        allowReadCommands: live.allowReadCommands,
        reminders,
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
      if (state.enabled) scheduleScan(threadId, 0);
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
    let maxSeq = Math.max(state.lastSeq, timeline.maxSeq);
    const graceTurnIds = [...state.graceTurnIds];
    const fresh: Violation[] = [];
    for (const row of rows) {
      const seq = typeof row.sourceSeqEnd === "number" ? row.sourceSeqEnd : 0;
      if (seq > maxSeq) maxSeq = seq;
      if (seq !== 0 && seq <= state.lastSeq) continue;
      if (state.seenRowIds.includes(row.id)) continue;
      const turnId = row.turnId ?? null;
      const startedAt = typeof row.startedAt === "number" ? row.startedAt : 0;
      if (
        turnId !== null &&
        !graceTurnIds.includes(turnId) &&
        graceTurnIds.length < state.graceSlots &&
        startedAt >= enabledAtMs
      ) {
        graceTurnIds.push(turnId);
      }
      // Turns that ran before the session could gain the contract are never
      // judged — only recorded.
      if (turnId !== null && graceTurnIds.includes(turnId)) continue;
      const violation = classifyRow(row, { allowReadCommands: live.allowReadCommands });
      if (violation !== null) fresh.push(violation);
    }

    if (fresh.length === 0 && maxSeq === state.lastSeq) return;

    const updated = await mutateState(threadId, (current) => ({
      ...current,
      lastSeq: Math.max(current.lastSeq, maxSeq),
      graceTurnIds,
      seenRowIds: [...current.seenRowIds, ...rows.map((row) => row.id)].slice(-MAX_SEEN_ROWS),
      violations: [...current.violations, ...fresh].slice(-MAX_VIOLATIONS),
    }));
    if (fresh.length === 0) return;

    bb.log.warn(
      `${threadId} did direct work ${fresh.length} time(s): ${fresh
        .map((violation) => violation.detail)
        .join("; ")}`,
    );
    bb.realtime.publish(STATE_CHANGED, { at: Date.now(), threadId, violations: fresh.length });
    await intervene(threadId, updated, fresh, enforcement);
  }

  async function intervene(
    threadId: string,
    state: ThreadState | undefined,
    violations: readonly Violation[],
    enforcement: EnforcementLevel,
  ): Promise<void> {
    if (state === undefined) return;
    const turnId = violations.find((violation) => violation.turnId !== null)?.turnId ?? "unknown";

    if (enforcement === "block" && state.lastStopTurnId !== turnId) {
      try {
        await bb.sdk.threads.stop({ threadId });
        await mutateState(threadId, (current) => ({ ...current, lastStopTurnId: turnId }));
        bb.log.warn(`stopped ${threadId} for doing direct work`);
      } catch (cause) {
        bb.log.warn(`stop failed for ${threadId}: ${String(cause)}`);
      }
    }

    if (state.lastNudgeTurnId === turnId) return;
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
        lastNudgeTurnId: turnId,
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
      const state = await getState(thread.id);
      if (state?.enabled === true) scheduleScan(thread.id, 250);
    })();
  });

  bb.events.on("thread.deleted", ({ thread }) => {
    void mutateState(thread.id, () => null);
  });

  // --- RPC -----------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    get_state: async ({ threadId }) => toDto(threadId, await getState(threadId)),
    set_enabled: async ({ threadId, enabled, enforcement }) => {
      const state = await setEnabled(threadId, enabled, enforcement ?? null);
      return toDto(threadId, state);
    },
    get_default: async () => ({ enabled: live.defaultForNewThreads }),
    set_default: async ({ enabled }) => ({ enabled: await setDefault(enabled) }),
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

  function describeState(threadId: string, state: ReturnType<typeof toDto>): string {
    const lines = [
      `thread ${threadId}`,
      `  orchestrator mode: ${state.enabled ? "ON" : "off"}`,
      `  enforcement:       ${state.effectiveEnforcement}${
        state.enforcement === null ? " (plugin default)" : " (thread override)"
      }`,
      `  violations:        ${state.violations.length}`,
      `  nudges sent:       ${state.nudgeCount} of ${state.maxNudges}`,
      `  delegations:       ${state.delegations.length}`,
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
        delegate: cliCommand({
          summary: "Delegate to a worker when the native tool is unavailable",
          options: {
            ...threadOption,
            task: { type: "string", required: true, description: "Complete, self-contained worker brief (1–20,000 characters)" },
            title: { type: "string", description: "Worker title (at most 200 characters)" },
            "no-wait": { type: "boolean", description: "Return immediately so other units can be delegated" },
            timeout: { type: "integer", min: 10, max: 3600, description: "Wait timeout in seconds (default 900)" },
            hidden: { type: "boolean", description: "Keep the worker out of the sidebar" },
          },
          async run(input, ctx) {
            const threadId = resolveThreadId(input.options.thread, ctx);
            const parsed = delegateParameters.safeParse({
              task: input.options.task,
              title: input.options.title,
              waitForResult: input.options["no-wait"] !== true,
              timeoutSeconds: input.options.timeout,
              hidden: input.options.hidden,
            });
            if (!parsed.success) {
              throw new PluginCliError("invalid delegation arguments", {
                code: "invalid_arguments",
                hint: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
              });
            }
            const output = await delegateTask(parsed.data, {
              ...ctx, threadId,
              projectId: input.options.thread === undefined ? ctx.projectId : undefined,
            });
            return render(input.options.json, { output }, output);
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
                "Running turns are notified now. If the native tool is unavailable, use bb orchestrator-mode delegate.",
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
