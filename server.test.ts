import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import { REVIEW_TOOL } from "./shared";
import plugin, { DELEGATE_TOOL, type OrchestratorStateDto } from "./server";
import { writeMirror } from "./shared";

const THREAD = "th_orchestrator";
const WORKER = "th_worker";

/** Timeline rows the watchdog reads, mutated per test. */
let timelineRows: unknown[] = [];
let timelineMaxSeq = 0;
/** Per-thread plugin-metadata namespaces, as the server would store them. */
let metadata: Record<string, Record<string, unknown>> = {};
let sentTexts: string[] = [];
let stoppedThreads: string[] = [];
let archivedThreads: string[] = [];
let spawned: Record<string, unknown>[] = [];

/** Every loaded host, disposed after each test so no scan timer leaks into the next. */
const hosts: FakePluginHarness[] = [];

/** A provider/model catalog the fake host serves to the plugin at load. */
interface ProviderCatalogFixture {
  providers?: { id: string; available: boolean }[];
  models?: Record<string, { id: string }[]>;
}

/** The retry target the delegation-failure tests store. */
const RETRY_TARGET = { providerId: "claude-code", model: "claude-opus-5-5" };

/** The catalog the delegation tests resolve worker ids against. */
const CATALOG: ProviderCatalogFixture = {
  providers: [
    { id: "acp-omp", available: true },
    { id: "claude-code", available: true },
  ],
  models: {
    "acp-omp": [{ id: "command-code/deepseek/deepseek-v4.1-flash-fast" }],
    "claude-code": [
      { id: "claude-opus-5-5" },
      { id: "claude-haiku-4-5-20251001" },
    ],
  },
};

function workRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "work",
    id: `row_${Math.random().toString(36).slice(2, 8)}`,
    threadId: THREAD,
    turnId: "turn_1",
    status: "completed",
    sourceSeqStart: timelineMaxSeq + 1,
    sourceSeqEnd: timelineMaxSeq + 2,
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

/** The concatenated text of a send/spawn `input` block array. */
function textOf(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .map((block) =>
      block !== null && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("\n");
}

async function load(
  settings: Record<string, PluginSettingValue> = {},
  seedState?: Record<string, unknown>,
  catalog: ProviderCatalogFixture = {},
  seedKv?: Record<string, unknown>,
): Promise<{ bb: BbPluginApi; harness: FakePluginHarness }> {
  const providers = catalog.providers ?? [{ id: "acp-omp", available: true }];
  const modelsByProvider = catalog.models ?? {
    "acp-omp": [{ id: "command-code/deepseek/deepseek-v4.1-flash-fast" }],
  };
  const host = createFakePluginHost({
    pluginId: "orchestrator-mode",
    settings,
    sdk: {
      providers: {
        models: async ({ providerId }: { providerId?: string } = {}) => {
          if (providerId !== undefined) {
            return {
              providers: [],
              models: (modelsByProvider[providerId] ?? []).map((model) => ({
                ...model,
                model: model.id,
                description: "",
                isDefault: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: "medium" as const,
              })),
            };
          }
          return {
            providers: providers.map((provider) => ({
              id: provider.id,
              available: provider.available,
              displayName: provider.id,
            })),
            models: [],
          };
        },
      },
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) =>
          metadata[threadId] ?? {},
        updatePluginMetadata: async ({
          threadId,
          set,
          remove,
        }: {
          threadId: string;
          set?: Record<string, unknown>;
          remove?: string[];
        }) => {
          const current = { ...(metadata[threadId] ?? {}) };
          for (const key of remove ?? []) delete current[key];
          Object.assign(current, set ?? {});
          metadata[threadId] = current;
          return current;
        },
        timeline: async () => ({ rows: timelineRows, maxSeq: timelineMaxSeq }),
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            environmentId: threadId === WORKER ? null : "env_1",
            parentThreadId: threadId === WORKER ? THREAD : null,
          }),
        spawn: async (args) => {
          spawned.push(args as unknown as Record<string, unknown>);
          return makeThreadResponse({ id: WORKER, parentThreadId: THREAD });
        },
        wait: async () => ({ matched: true, threadId: WORKER }),
        output: async () => ({ output: "the worker finished the task" }),
        send: async (args) => {
          sentTexts.push(textOf((args as { input?: unknown }).input));
          return { threadId: THREAD };
        },
        stop: async ({ threadId }: { threadId: string }) => {
          stoppedThreads.push(threadId);
          return { threadId };
        },
        archive: async ({ threadId }: { threadId: string }) => {
          archivedThreads.push(threadId);
          return { threadId };
        },
      },
    },
  });
  if (seedState !== undefined) {
    await host.bb.storage.kv.set("state", seedState);
  }
  for (const [key, value] of Object.entries(seedKv ?? {})) {
    await host.bb.storage.kv.set(key, value);
  }
  await plugin(host.bb);
  // Loading reads the provider catalog once. No test asserts on that, and every
  // call-count assertion below is about what a request or a turn does, so the
  // load-time reads are dropped rather than counted as request activity.
  host.harness.inspection.sdk.calls.length = 0;
  hosts.push(host.harness);
  return host;
}

beforeEach(() => {
  timelineRows = [];
  timelineMaxSeq = 0;
  metadata = {};
  sentTexts = [];
  stoppedThreads = [];
  archivedThreads = [];
  spawned = [];
});

afterEach(async () => {
  for (const harness of hosts.splice(0)) {
    await harness.lifecycle.dispose();
  }
  // Let any scan already in flight settle before the next test swaps the stubs.
  await new Promise((resolve) => setTimeout(resolve, 30));
});

/** Turn the mode on through the same RPC the composer uses. */
async function enable(
  harness: FakePluginHarness,
  threadId = THREAD,
  enforcement?: "instruct" | "guard" | "block",
): Promise<void> {
  await harness.behavior.callRpc("set_enabled", {
    threadId,
    enabled: true,
    ...(enforcement === undefined ? {} : { enforcement }),
  });
}

async function idle(harness: FakePluginHarness): Promise<void> {
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: THREAD }),
    lastAssistantText: null,
  });
}

/**
 * Model the session lag: the turn in flight when the mode is enabled, and the
 * first turn after it, run in a provider session that never received the
 * contract or the tool, so neither is judged. Tests that expect a violation
 * therefore act on the third turn.
 */
async function arm(harness: FakePluginHarness): Promise<void> {
  timelineRows = [
    workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
  ];
  timelineMaxSeq = 1;
  await enable(harness);
  timelineRows = [
    ...timelineRows,
    workRow({ id: "row_first", workKind: "file-read", turnId: "turn_1", sourceSeqStart: 2, sourceSeqEnd: 2 }),
  ];
  timelineMaxSeq = 2;
  await idle(harness);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe("agent configuration", () => {
  it("hands an enabled thread the contract and the delegation tool", async () => {
    const { harness } = await load();
    await enable(harness);
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toContain("ORCHESTRATOR MODE IS ON");
    // The contract names both tools, so the session must receive both.
    expect(resolved.tools.map((tool) => tool.name)).toEqual([DELEGATE_TOOL, REVIEW_TOOL]);
  });

  it("contributes nothing to a thread that is not orchestrating", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: false, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toBeNull();
    expect(resolved.tools).toEqual([]);
  });

  it("honours a per-thread enforcement override in the contract", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: "block" }),
      }),
    );
    expect(resolved.instructions).toContain("STOPS the turn");
  });

  it("never governs a mirror-less thread from the default alone", async () => {
    // configure is synchronous and receives no createdAt, so it must not guess.
    // A default left on reaching every mirror-less thread is exactly the bug
    // that once governed the whole app; only the dispatch hook, which has
    // createdAt, may apply it.
    const { harness } = await load({ defaultForNewThreads: true });
    for (const context of [
      makePluginAgentConfigurationContext({ thread: { id: "th_root", parentThreadId: null } }),
      makePluginAgentConfigurationContext({
        thread: { id: WORKER, parentThreadId: THREAD },
      }),
      makePluginAgentConfigurationContext({
        thread: { id: "th_side" },
        origin: { kind: "fork", pluginId: "side-chat" },
      }),
    ]) {
      const resolved = await harness.behavior.resolveAgentConfiguration(context);
      expect(resolved.instructions).toBeNull();
      expect(resolved.tools).toEqual([]);
    }
  });

  it("leaves ordinary threads alone when the default is off", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "th_root", parentThreadId: null } }),
    );
    expect(resolved.instructions).toBeNull();
    expect(resolved.tools).toEqual([]);
  });

  it("ignores a mirror another writer forged", async () => {
    const { harness } = await load();
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: { orchestrator: { enabled: true, source: "some-other-plugin" } },
      }),
    );
    expect(resolved.instructions).toBeNull();
  });

  it("still hands the contract over when a stored violation is malformed", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [null],
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
      },
    });
    // Warm the state cache the synchronous configure callback reads.
    await harness.behavior.callRpc("get_state", { threadId: THREAD });
    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(resolved.instructions).toContain("ORCHESTRATOR MODE IS ON");
    expect(resolved.tools.map((tool) => tool.name)).toEqual([DELEGATE_TOOL, REVIEW_TOOL]);
  });
});

describe("the dispatch checkpoint", () => {
  async function dispatch(
    harness: FakePluginHarness,
    threadId: string,
    threadOverrides: Record<string, unknown> = {},
    contextOverrides: Record<string, unknown> = {},
  ) {
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    expect(handler).not.toBeNull();
    return handler!(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({
          id: threadId,
          createdAt: Date.now(),
          ...threadOverrides,
        }),
        ...contextOverrides,
      }),
    );
  }

  it("always proceeds", async () => {
    const { harness } = await load();
    await expect(dispatch(harness, THREAD)).resolves.toEqual({ action: "proceed" });
  });

  it("mirrors authoritative state onto the thread before the turn", async () => {
    const { harness } = await load();
    await enable(harness);
    metadata[THREAD] = {}; // as if another writer cleared it
    await dispatch(harness, THREAD);
    expect(metadata[THREAD]).toEqual(
      writeMirror({ enabled: true, enforcement: null }),
    );
  });

  it("restores the mirror when the thread's own agent turns it off", async () => {
    const { harness } = await load();
    await enable(harness);
    metadata[THREAD] = writeMirror({ enabled: false, enforcement: null });
    await dispatch(harness, THREAD);
    expect((metadata[THREAD]!["orchestrator"] as { enabled: boolean }).enabled).toBe(true);
  });

  it("applies the new-thread default at first dispatch", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_fresh");
    expect(metadata["th_fresh"]).toEqual(
      writeMirror({ enabled: true, enforcement: null }),
    );
  });

  it("does not apply the default to a worker thread", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, WORKER, { parentThreadId: THREAD });
    expect(metadata[WORKER]).toBeUndefined();
  });

  it("does not apply the default to a thread created long ago", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_old", { createdAt: Date.now() - 60 * 60_000 });
    expect(metadata["th_old"]).toBeUndefined();
  });

  it("does not apply the default to a thread created before the switch", async () => {
    const { harness } = await load();
    const before = Date.now() - 5_000;
    await harness.behavior.callRpc("set_default", { enabled: true });
    await dispatch(harness, "th_just_before", { createdAt: before });
    expect(metadata["th_just_before"]).toBeUndefined();

    await dispatch(harness, "th_just_after", { createdAt: Date.now() });
    expect(metadata["th_just_after"]).toEqual(writeMirror({ enabled: true, enforcement: null }));
  });

  it("does not apply the default to a plugin-spawned background worker", async () => {
    const { harness } = await load();
    await harness.behavior.callRpc("set_default", { enabled: true });
    await dispatch(
      harness,
      "th_recap_worker",
      { createdAt: Date.now(), originPluginId: "bb-recap" },
      { initiator: "agent", originPluginId: "bb-recap" },
    );
    expect(metadata["th_recap_worker"]).toBeUndefined();
  });

  it("leaves a thread it has never enforced alone", async () => {
    const { harness } = await load({ defaultForNewThreads: true });
    await dispatch(harness, "th_old", { createdAt: Date.now() - 60 * 60_000 });
    // The dispatch path is app-wide, so an unenforced thread must cost no SDK
    // calls at all: no metadata read, no timeline read, no mirror write.
    expect(harness.inspection.sdk.calls).toEqual([]);
  });
});

describe("the watchdog", () => {
  it("records and deduplicates work delivered in timeline delta patches", async () => {
    const { bb, harness } = await load({ enforcement: "guard" });
    await arm(harness);
    const edit = workRow({
      id: "row_delta", workKind: "file-change", turnId: "turn_2",
      sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "delta.ts" },
    });
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [], maxSeq: 4, delta: { upsertRows: [edit] },
    }));
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("delta.ts");

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ violations: [{ id: "row_delta" }], nudgeCount: 1 });
    expect(await bb.storage.kv.get("state")).toMatchObject({ [THREAD]: { lastSeq: 4 } });
    expect(sentTexts).toHaveLength(1);
  });

  it("inspects edits inside completed turn summaries", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    const edit = workRow({
      id: "row_nested", workKind: "file-change", turnId: "turn_2",
      sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "nested.ts" },
    });
    harness.inspection.sdk.stub("threads.timeline", async ({ includeNestedRows }: { includeNestedRows?: string }) => ({
      maxSeq: 5,
      rows: [{
        id: "summary_2", kind: "turn", turnId: "turn_2", status: "completed",
        startedAt: edit.startedAt, sourceSeqStart: 3, sourceSeqEnd: 5,
        children: includeNestedRows === "true" ? [edit] : null,
      }],
    }));
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("nested.ts");
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "row_nested" }],
    });
  });

  it("advances past an empty timeline patch without recording work", async () => {
    const { bb, harness } = await load();
    await arm(harness);
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [], maxSeq: 3, delta: { upsertRows: [] },
    }));
    await idle(harness);
    await vi.waitFor(async () => {
      expect(await bb.storage.kv.get("state")).toMatchObject({ [THREAD]: { lastSeq: 3 } });
    });
    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ violations: [] });
  });

  it("records a violation and corrects the thread in guard mode", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_edit",
        workKind: "file-change",
        turnId: "turn_2",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        change: { path: "src/server.ts" },
      }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("src/server.ts");
    expect(sentTexts[0]).toContain(DELEGATE_TOOL);
    expect(stoppedThreads).toEqual([]);

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { detail: string }[];
      nudgeCount: number;
    };
    expect(state.violations).toHaveLength(1);
    expect(state.nudgeCount).toBe(1);
  });

  it("stops the turn in block mode", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_cmd", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "npm run build" }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);

    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    expect(sentTexts[0]).toContain("npm run build");
  });

  it("records but never judges the turns a resumed session ran ungoverned", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    // turn_0 (in flight at enable) and turn_1 (first after it) are excused;
    // arm() already ran turn_1, so only its recording is asserted here.
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toEqual([]);
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("does nothing in instruct mode", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_edit2", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toEqual([]);
    expect(stoppedThreads).toEqual([]);
  });

  it("lets read-only commands through", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: true });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_ls", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "git status" }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("never classifies the same row twice", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    const row = workRow({ id: "row_once", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } });
    timelineRows = [...timelineRows, row];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));
    // A second scan over the same row must not nudge again for the same turn.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(1);
  });

  it("leaves a thread that is not orchestrating alone", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [workRow({ id: "row_x", workKind: "file-change", change: { path: "a.ts" } })];
    timelineMaxSeq = 2;
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "th_other" }),
      lastAssistantText: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
  });

  it("keeps watching state written by an older build of the plugin", async () => {
    // A row written before the grace fields existed: no graceTurnIds,
    // no graceSlots. The scan must normalize it, not die on it.
    const { harness } = await load({ enforcement: "block" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        touchedAt: Date.now(),
        violations: [],
        seenRowIds: [],
        lastSeq: 0,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        delegations: [],
      },
    });
    timelineRows = [
      workRow({ id: "row_old0", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
      workRow({ id: "row_old1", workKind: "file-change", turnId: "turn_1", sourceSeqStart: 2, sourceSeqEnd: 2, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 2;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
  });

  it("excuses the first post-enable turn when its rows carry no startedAt", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [
      workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
    ];
    timelineMaxSeq = 1;
    await enable(harness);
    // A partial row: the timeline puts startedAt on the completed summary, so a
    // delta patch of the live turn arrives without one. It is still the first
    // post-enable turn, so the grace slot must cover it.
    timelineRows = [
      ...timelineRows,
      workRow({
        id: "row_first",
        workKind: "file-change",
        turnId: "turn_1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        change: { path: "a.ts" },
        startedAt: undefined,
      }),
    ];
    timelineMaxSeq = 2;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [],
      nudgeCount: 0,
    });
  });

  it("does not let a historical row spend the first post-enable turn's grace", async () => {
    const { harness } = await load({ enforcement: "block" });
    timelineRows = [
      workRow({ id: "row_prior", workKind: "file-read", turnId: "turn_0", sourceSeqStart: 1, sourceSeqEnd: 1 }),
    ];
    timelineMaxSeq = 1;
    await enable(harness);
    timelineRows = [
      ...timelineRows,
      // History first: its timestamp predates the enable, so it must not
      // consume the grace slot the live turn needs.
      workRow({
        id: "row_hist",
        workKind: "file-read",
        turnId: "turn_hist",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        startedAt: Date.now() - 60_000,
      }),
      workRow({
        id: "row_first",
        workKind: "file-change",
        turnId: "turn_1",
        sourceSeqStart: 3,
        sourceSeqEnd: 3,
        change: { path: "a.ts" },
        startedAt: undefined,
      }),
    ];
    timelineMaxSeq = 3;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("stops each live turn that does direct work even when the rows carry no turnId", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_a", workKind: "file-change", turnId: undefined, sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(1));

    // A second turn, again with no turnId: it must be stopped too rather than
    // collapsing into the same sentinel as the first.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_b", workKind: "file-change", turnId: undefined, sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(2);
  });

  it("attributes the stop to the newest turn in the batch", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_t2", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
      workRow({ id: "row_t3", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toHaveLength(1));

    // turn_3 is the live turn, so further work in it must not stop it again.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_t3b", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 7, sourceSeqEnd: 8, change: { path: "c.ts" } }),
    ];
    timelineMaxSeq = 8;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(stoppedThreads).toHaveLength(1);
    expect(sentTexts).toHaveLength(1);
  });

  it("judges a work row that carries no id", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: undefined, workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { detail: string }[];
    };
    expect(state.violations).toHaveLength(1);
    expect(state.violations[0]!.detail).toContain("a.ts");

    // The sequence is the key, so a later scan does not judge it again.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      nudgeCount: 1,
    });
  });
});

describe("the delegation tool", () => {
  it("retains every worker record when delegations start together", async () => {
    const { harness } = await load();
    await enable(harness);
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_worker_${++workerNumber}`, parentThreadId: THREAD }),
    );
    await Promise.all(["First task", "Second task"].map((task) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL, { task, waitForResult: false }, { threadId: THREAD, projectId: "proj_1" },
      ),
    ));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: "th_worker_1" }, { threadId: "th_worker_2" }],
    });
  });

  it("spawns a worker under the orchestrator and returns its result", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Implement the retry policy in src/retry.ts" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1",
      parentThreadId: THREAD,
      prompt: "Implement the retry policy in src/retry.ts",
      environment: { type: "reuse", environmentId: "env_1" },
    });
    expect(String(result)).toContain("the worker finished the task");
    expect(String(result)).toContain(WORKER);

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string; status: string | null }[];
    };
    expect(state.delegations).toHaveLength(1);
    expect(state.delegations[0]!.threadId).toBe(WORKER);
  });

  it("returns immediately when asked not to wait", async () => {
    const { harness } = await load();
    await enable(harness);
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(result)).toContain("without waiting");
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
  });

  it("leaves the worker on the project default when no execution is configured", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).not.toHaveProperty("providerId");
    expect(spawned[0]).not.toHaveProperty("model");
    expect(spawned[0]).not.toHaveProperty("reasoningLevel");
    expect(spawned[0]).not.toHaveProperty("permissionMode");
    expect(spawned[0]).not.toHaveProperty("executionInputSources");
  });

  it("leaves workers inherited until an execution is stored", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).not.toHaveProperty("executionInputSources");
  });

  it("spawns workers on the stored execution, stamped as caller-chosen", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "full",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "high",
      permissionMode: "full",
      // Without these the server drops the request and re-derives the
      // project's remembered defaults.
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    });
  });

  it("refuses storing a provider the catalog does not offer", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "gone-provider",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      }),
    ).rejects.toThrow(/Unknown worker provider "gone-provider"/);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
  });

  it("refuses a stored execution that names no model", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", { providerId: "acp-omp" }),
    ).rejects.toThrow(/needs both a provider and a model/);
  });

  it("drops a stored model the catalog no longer offers", async () => {
    // Seeded straight into the store, as an older build with a wider catalog
    // would have left it.
    const { harness } = await load({}, undefined, CATALOG, {
      worker: { providerId: "acp-omp", model: "command-code/retired/model" },
    });
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({
      providerId: "acp-omp",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // The model is gone, the provider that served it survives.
    expect(spawned[0]).toMatchObject({
      providerId: "acp-omp",
      executionInputSources: { providerId: "explicit" },
    });
    expect(spawned[0]).not.toHaveProperty("model");
  });

  it("lets one delegation override the stored worker execution", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      {
        task: "The hard unit",
        model: "claude-opus-5-5",
        permissionMode: "auto",
        waitForResult: false,
      },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({
      model: "claude-opus-5-5",
      permissionMode: "auto",
      // The model's own provider replaces the configured one, which does not
      // serve it.
      providerId: "claude-code",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        permissionMode: "explicit",
      },
    });
    expect(spawned[0]).not.toHaveProperty("reasoningLevel");
  });

  /** Enable a thread whose workers run on a stored execution and retry target.
   * Pass `null` for a thread with no retry target. */
  async function armFallback(
    fallback: OrchestratorStateDto["workerExecution"] | null = RETRY_TARGET,
  ): Promise<FakePluginHarness> {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      ...(fallback === null ? {} : { fallback }),
    });
    await enable(harness);
    return harness;
  }

  /** Spawn two workers in order, the first of which behaves differently. */
  function twoWorkers(harness: FakePluginHarness): void {
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_first" : "th_second",
        parentThreadId: THREAD,
      });
    });
  }

  it("retries a failed worker on the configured fallback", async () => {
    const harness = await armFallback({ ...RETRY_TARGET, permissionMode: "auto" });
    twoWorkers(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toMatchObject({
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      providerId: "acp-omp",
    });
    // The fallback replaces the model and its access, and keeps the rest of
    // the execution.
    expect(spawned[1]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      permissionMode: "auto",
      prompt: "Rebuild the index",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        permissionMode: "explicit",
      },
    });
    expect(String(result)).toContain("th_first failed");
    expect(String(result)).toContain("th_second");
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: "th_first" }, { threadId: "th_second" }],
    });
  });

  it("retries when the wait rejects for an errored worker", async () => {
    const harness = await armFallback();
    twoWorkers(harness);
    // What the server actually does: an errored thread never reaches `idle`, so
    // the wait rejects instead of holding until the timeout.
    harness.inspection.sdk.stub("threads.wait", async ({ threadId }) => {
      if (threadId === "th_first") throw new Error("Thread is in status error and will not reach idle by waiting alone.");
      return { matched: true, threadId };
    });
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    expect(spawned[1]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(String(result)).toContain("th_first failed");
  });

  it("lets a fallback without its own access inherit the worker's", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      permissionMode: "accept-edits",
      fallback: RETRY_TARGET,
    });
    await enable(harness);
    twoWorkers(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: threadId === "th_first" ? "error" : "idle" }),
    );

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[1]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      permissionMode: "accept-edits",
    });
  });

  it("retries on the fallback when the worker cannot start at all", async () => {
    const harness = await armFallback();
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      // The provider refuses the first execution outright, as a 503 does.
      if (started++ === 0) throw new Error("HTTP 503: provider unavailable");
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_retry", parentThreadId: THREAD });
    });

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
    expect(String(result)).toContain("could not start");
    expect(String(result)).toContain("th_retry");
  });

  it("does not retry a failed worker when no fallback is configured", async () => {
    const harness = await armFallback(null);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "error" }),
    );

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
    expect(String(result)).toContain('status "error"');
  });

  it("does not retry a worker that finished", async () => {
    const harness = await armFallback();

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Rebuild the index" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
    expect(String(result)).toContain('status "idle"');
  });

  it("keeps the execution when only the fallback is cleared", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: { providerId: "claude-code", model: "claude-opus-5-5" },
    });
    expect(
      await harness.behavior.callRpc("set_worker_execution", {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      }),
    ).toEqual({ providerId: "acp-omp", model: "command-code/deepseek/deepseek-v4.1-flash-fast" });
  });

  it("refuses a fallback provider the catalog does not offer", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
        fallback: { providerId: "gone", model: "command-code/deepseek/deepseek-v4.1-flash-fast" },
      }),
    ).rejects.toThrow(/Unknown worker provider "gone"/);
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({});
  });

  it("drops a stored fallback the catalog no longer offers", async () => {
    const { harness } = await load({}, undefined, CATALOG, {
      worker: {
        providerId: "acp-omp",
        model: "command-code/deepseek/deepseek-v4.1-flash-fast",
        fallback: { providerId: "acp-omp", model: "command-code/retired/model" },
      },
    });
    expect(await harness.behavior.callRpc("get_worker_execution", null)).toEqual({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });
  });

  it("refuses a worker model the catalog does not offer", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", model: "gpt-9-imaginary", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/Unknown worker model "gpt-9-imaginary"/);
    expect(spawned).toHaveLength(0);
  });

  it("records a verdict for a worker", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    const result = await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: WORKER, verdict: "accepted", notes: "read the diff" },
      { threadId: THREAD },
    );

    expect(String(result)).toContain("Recorded accepted");
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ reviewed: 1, unreviewed: 0 });
    expect(state.delegations[0]).toMatchObject({ verdict: "accepted", notes: "read the diff" });
  });

  it("refuses a verdict for a thread it never delegated", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        REVIEW_TOOL,
        { workerThreadId: "th_never", verdict: "accepted" },
        { threadId: THREAD },
      ),
    ).rejects.toThrow(/no worker th_never/);
  });

  it("reminds an idle orchestrator about an unjudged worker exactly once", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reviews = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reviews()).toHaveLength(1);

    // The same unjudged worker is not nagged about again.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reviews()).toHaveLength(1);
  });

  it("reminds again after the counters are cleared", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reminders = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(1);

    await harness.behavior.callRpc("clear_violations", { threadId: THREAD });
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Clearing resets the counters, so the gate speaks again instead of staying
    // muted for the same unjudged worker.
    expect(reminders()).toHaveLength(2);
  });

  it("reminds again after the thread is turned off and on", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const reminders = () => sentTexts.filter((text) => /review is missing/i.test(text));

    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(1);

    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    await enable(harness);
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(reminders()).toHaveLength(2);
  });

  it("leaves the review gate silent at the instruct level", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts.filter((text) => /review is missing/i.test(text))).toEqual([]);
  });

  it("spawns a check unit when a delegation asks to be verified", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "VERDICT: pass\nthe file exists" : "did the thing",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(2);
    // The check unit carries the original brief and the worker's claim, and is
    // told to inspect rather than repair.
    const brief = String(spawned[1]!.prompt);
    expect(brief).toContain("Add a retry to src/retry.ts");
    expect(brief).toContain("did the thing");
    expect(brief).toContain("Do not modify any file");
    expect(String(result)).toContain("VERDICT: pass");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations).toHaveLength(2);
    expect(state.delegations[0]).toMatchObject({ verifiedBy: "th_check" });
    // A check unit is evidence, not a unit the orchestrator must judge.
    expect(state).toMatchObject({ unreviewed: 1 });
  });

  it("does not check a worker that failed", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, status: "error" }),
    );

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned).toHaveLength(1);
  });

  it("hands the orchestrator a worker's failure reason", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );

    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: WORKER, status: "error" }),
      error: "Provider refused the model",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]).toMatchObject({
      status: "error",
      failure: "Provider refused the model",
    });
  });

  it("refuses a delegation past the parallel cap, and says which cap", async () => {
    const { harness } = await load({ maxParallelWorkers: 2, maxDelegationsPerTurn: 0 });
    await enable(harness);
    const delegate = () =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );

    await delegate();
    await delegate();
    await expect(delegate()).rejects.toThrow(/caps parallel workers at 2/);
    expect(spawned).toHaveLength(2);
  });

  it("does not count a check unit against the per-turn cap", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 1, maxParallelWorkers: 0 });
    await enable(harness);
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    await handler!(
      makeMessageDispatchHookContext({ thread: makeThreadResponse({ id: THREAD }) }),
    );
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // One delegation the orchestrator chose, plus the check unit it did not.
    expect(spawned).toHaveLength(2);
  });

  it("does not send a fan-out refusal to the fallback", async () => {
    const { harness } = await load({ maxParallelWorkers: 1, maxDelegationsPerTurn: 0 }, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: RETRY_TARGET,
    });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // A cap is the plugin's own refusal: retrying it on the fallback would fail
    // twice and hide the reason.
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/caps parallel workers at 1/);
    expect(spawned).toHaveLength(1);
  });

  it("caps how many workers one turn may delegate", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 2, maxParallelWorkers: 0 });
    await enable(harness);
    const handler = harness.inspection.registrations.hooks["message.dispatch"];
    await handler!(
      makeMessageDispatchHookContext({ thread: makeThreadResponse({ id: THREAD }) }),
    );

    const delegate = () =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );

    await delegate();
    await delegate();
    await expect(delegate()).rejects.toThrow(/caps a turn at 2/);
  });

  it("offers no cap when a cap is set to zero", async () => {
    const { harness } = await load({ maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness);
    for (let index = 0; index < 8; index += 1) {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: `Unit ${index}`, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
    }
    expect(spawned).toHaveLength(8);
  });

  it("exposes the exact contract and the appended rules", async () => {
    const { harness } = await load({ enforcement: "guard" });
    const before = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
      extra: string;
      limit: number;
    };
    expect(before).toMatchObject({ extra: "", limit: 370 });
    expect(String(before.text)).toContain("ORCHESTRATOR MODE IS ON");
    expect(String(before.text)).toContain("orchestrator_review");

    const after = (await harness.behavior.callRpc("set_contract", {
      extra: "Never edit src/legacy.",
    })) as { text: string; extra: string; limit: number };
    expect(after).toMatchObject({ extra: "Never edit src/legacy." });
    expect(String(after.text)).toContain("## Rules for this project");
    expect(String(after.text)).toContain("Never edit src/legacy.");
  });

  it("refuses appended rules past the cap", async () => {
    const { harness } = await load();
    await expect(
      harness.behavior.callRpc("set_contract", { extra: "x".repeat(371) }),
    ).rejects.toThrow();
  });

  it("sets and clears the project rules from the CLI", async () => {
    const { harness } = await load();

    await harness.behavior.runCli(["contract", "--rules", "Never edit generated/."]);
    const set = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      extra: string;
      text: string;
    };
    expect(set.extra).toBe("Never edit generated/.");
    expect(set.text).toContain("Never edit generated/.");

    await harness.behavior.runCli(["contract", "--clear-rules"]);
    const cleared = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      extra: string;
      text: string;
    };
    expect(cleared.extra).toBe("");
    expect(cleared.text).not.toContain("Never edit generated/.");
  });

  it("prints the contract from the CLI", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["contract"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ORCHESTRATOR MODE IS ON");
    expect(result.stdout).toContain("orchestrator_delegate");
  });

  it("spawns a preset's execution on top of the worker execution", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      reasoningLevel: "low",
      presets: { build: { model: "claude-opus-5-5", permissionMode: "full" } },
    });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Build it", preset: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // The preset named only a model and an access; the provider follows the
    // model and the reasoning level stays what the worker execution said.
    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "low",
      permissionMode: "full",
    });
  });

  it("lets a call's own arguments beat the preset", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { build: { model: "claude-opus-5-5" } },
    });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Build it", preset: "build", model: "claude-haiku-4-5-20251001" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[0]).toMatchObject({
      providerId: "claude-code",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("refuses a preset that is not stored, naming the ones that are", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { research: { model: "claude-haiku-4-5-20251001" } },
    });
    await enable(harness);

    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Build it", preset: "build" },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/No `build` worker preset is stored. Stored presets: research/);
    expect(spawned).toHaveLength(0);
  });

  it("writes and clears one preset from the CLI without touching the rest", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      fallback: RETRY_TARGET,
    });

    const written = await harness.behavior.runCli([
      "worker",
      "--preset",
      "build",
      "--model",
      "claude-opus-5-5",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("preset build");
    expect(written.stdout).toContain("claude-opus-5-5");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      workerExecution: Record<string, unknown>;
    };
    expect(state.workerExecution).toMatchObject({
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
    });

    const cleared = await harness.behavior.runCli(["worker", "--clear-preset", "build"]);
    expect(cleared.exitCode).toBe(0);
    const config = (await harness.behavior.callRpc("get_worker_execution", null)) as Record<string, unknown>;
    expect(config.presets).toBeUndefined();
    // The retry target and the execution survived the preset edit.
    expect(config).toMatchObject({ fallback: RETRY_TARGET });
  });

  it("writes no preset when a preset is named with no execution flags", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    const result = await harness.behavior.runCli(["worker", "--preset", "build"]);
    expect(result.exitCode).toBe(0);
    // `--preset build` on its own names no value, so it reports rather than
    // storing an empty preset a delegation could then resolve.
    const config = (await harness.behavior.callRpc("get_worker_execution", null)) as Record<string, unknown>;
    expect(config.presets).toBeUndefined();
  });

  it("archives a settled worker when retention says so", async () => {
    const { harness } = await load({ workerRetention: "archive-all" });
    await enable(harness);

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(archivedThreads).toEqual([WORKER]);
  });

  it("archives a worker a verdict was recorded for, even without waiting", async () => {
    const { harness } = await load({ workerRetention: "archive-all" });
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    // Nobody waited on it, so nothing has been read yet.
    expect(archivedThreads).toEqual([]);

    await harness.behavior.callAgentTool(
      REVIEW_TOOL,
      { workerThreadId: WORKER, verdict: "accepted" },
      { threadId: THREAD },
    );
    expect(archivedThreads).toEqual([WORKER]);
  });

  it("refuses to verify a worker nobody waits for", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "Do it", waitForResult: false, verify: true },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/verify: true needs waitForResult: true/);
    // Nothing was spawned, so no worker is left unchecked.
    expect(spawned).toHaveLength(0);
  });

  it("names the provider, not the model, when the provider is the typo", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await expect(
      harness.behavior.callRpc("set_worker_execution", {
        providerId: "nope",
        model: "claude-opus-5-5",
      }),
    ).rejects.toThrow(/Unknown worker provider "nope"/);
  });

  it("keeps every worker by default", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(archivedThreads).toEqual([]);
  });

  it("archives only check units under the checks policy", async () => {
    const { harness } = await load({ workerRetention: "archive-checks" });
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({
        id: started++ === 0 ? "th_unit" : "th_check",
        parentThreadId: THREAD,
      });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(archivedThreads).toEqual(["th_check"]);
  });

  it("emits the contract shape the setting names", async () => {
    const { harness } = await load({ contractPreset: "review-heavy" });
    const contract = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(contract.text).toContain("Every unit gets checked before you trust it");
    expect(contract.text).not.toContain("Pass `verify: true` when you delegate a unit whose");
  });

  it("rejects an empty brief", async () => {
    const { harness } = await load();
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "" }, { threadId: THREAD }),
    ).rejects.toThrow();
  });
});

describe("rpc", () => {
  it("preserves both thread choices when they are enabled together", async () => {
    const { bb, harness } = await load();
    await Promise.all([enable(harness, "th_first"), enable(harness, "th_second")]);
    for (const threadId of ["th_first", "th_second"]) {
      expect(await harness.behavior.callRpc("get_state", { threadId })).toMatchObject({ enabled: true });
      expect(metadata[threadId]).toEqual(writeMirror({ enabled: true, enforcement: null }));
    }
    expect(await bb.storage.kv.get("state")).toMatchObject({
      th_first: { enabled: true }, th_second: { enabled: true },
    });
  });

  it("leaves failed writes uncommitted and accepts later mutations", async () => {
    const { bb, harness } = await load();
    const write = vi.spyOn(bb.storage.kv, "set").mockRejectedValueOnce(new Error("write failed"));
    try {
      await expect(enable(harness, "th_failed")).rejects.toThrow("write failed");
      expect(await harness.behavior.callRpc("get_state", { threadId: "th_failed" })).toMatchObject({ enabled: false });
      expect(metadata["th_failed"]).toBeUndefined();

      await enable(harness, "th_later");
      expect(await bb.storage.kv.get("state")).toMatchObject({ th_later: { enabled: true } });
      expect(await harness.behavior.callRpc("get_state", { threadId: "th_later" })).toMatchObject({ enabled: true });
    } finally {
      write.mockRestore();
    }
  });

  it("reports the effective enforcement and the plugin defaults", async () => {
    const { harness } = await load({ enforcement: "block", maxNudges: 5 });
    const before = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      enabled: boolean;
      effectiveEnforcement: string;
    };
    expect(before.enabled).toBe(false);
    expect(before.effectiveEnforcement).toBe("block");

    await enable(harness);
    const after = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      enabled: boolean;
      effectiveEnforcement: string;
      maxNudges: number;
    };
    expect(after.enabled).toBe(true);
    expect(after.effectiveEnforcement).toBe("block");
    expect(after.maxNudges).toBe(5);
  });

  it("toggles the new-thread default", async () => {
    const { harness } = await load();
    expect(await harness.behavior.callRpc("get_default")).toEqual({ enabled: false });
    expect(await harness.behavior.callRpc("set_default", { enabled: true })).toEqual({
      enabled: true,
    });
    expect(await harness.behavior.callRpc("get_default")).toEqual({ enabled: true });
  });

  it("clears the violation record", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_c", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const cleared = (await harness.behavior.callRpc("clear_violations", {
      threadId: THREAD,
    })) as { violations: unknown[]; nudgeCount: number };
    expect(cleared.violations).toEqual([]);
    expect(cleared.nudgeCount).toBe(0);
  });

  it("publishes a realtime signal the composer can refetch on", async () => {
    const { harness } = await load();
    await enable(harness);
    expect(
      harness.inspection.realtimeSignals.some((signal) => signal.channel === "orchestrator-state"),
    ).toBe(true);
  });

  it("drops malformed entries in a stored array instead of failing a read", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date().toISOString(),
        touchedAt: Date.now(),
        violations: [
          { id: "v1", turnId: "t1", workKind: "command", detail: "ran `x`", detectedAt: 1 },
          null,
          {},
        ],
        seenRowIds: ["row_1", null, 7],
        delegations: [
          { threadId: WORKER, title: "w", task: "t", createdAt: 1, status: "completed" },
          null,
          {},
        ],
        lastSeq: 0,
        graceTurnIds: [null, "turn_1"],
        graceSlots: 1,
        nudgeCount: 0,
        lastNudgeTurnId: null,
        lastStopTurnId: null,
        turnStartedAt: 0,
        lastReviewNudge: null,
      },
    });
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: { id: string }[];
      delegations: { threadId: string }[];
      unreviewed: number;
    };
    // The valid entries survive intact; the foreign ones are dropped.
    expect(state.violations.map((violation) => violation.id)).toEqual(["v1"]);
    expect(state.delegations.map((delegation) => delegation.threadId)).toEqual([WORKER]);
    expect(state.unreviewed).toBe(1);
    // A later scan over the repaired state keeps working.
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "v1" }],
    });
  });

  it("survives an idle event whose stored delegation is malformed", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const { harness } = await load({}, {
        [THREAD]: {
          enabled: true,
          enforcement: null,
          enabledAt: new Date().toISOString(),
          touchedAt: Date.now(),
          violations: [],
          seenRowIds: [],
          delegations: [null],
          lastSeq: 0,
          graceTurnIds: [],
          graceSlots: 1,
          nudgeCount: 0,
          lastNudgeTurnId: null,
          lastStopTurnId: null,
          turnStartedAt: 0,
          lastReviewNudge: null,
        },
      });
      await idle(harness);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("evicts by touch time even when a stored touchedAt is not a number", async () => {
    const seed: Record<string, unknown> = {};
    for (let index = 1; index <= 300; index += 1) {
      seed[`th_${index}`] = { enabled: false, touchedAt: index };
    }
    seed.th_bad = { enabled: false, touchedAt: "recently" };
    const { bb, harness } = await load({}, seed);
    await enable(harness);
    const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(300);
    // The unreadable timestamp falls back to 0, so that row is the oldest.
    expect(raw.th_bad).toBeUndefined();
    expect(raw.th_2).toBeDefined();
  });
});

describe("cli", () => {
  it("turns the mode on and reports it", async () => {
    const { harness } = await load();
    const on = await harness.behavior.runCli(["on", "--thread", THREAD]);
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain("ON");

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("orchestrator mode: ON");

    const off = await harness.behavior.runCli(["off", "--thread", THREAD]);
    expect(off.stdout).toContain("off");
    const after = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(after.stdout).toContain("orchestrator mode: off");
  });

  it("targets the invoking thread when no --thread is given", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["on"], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(metadata[THREAD]).toEqual(writeMirror({ enabled: true, enforcement: null }));
  });

  it("explains itself when there is no thread to act on", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--thread");
  });

  it("emits JSON when asked", async () => {
    const { harness } = await load();
    await harness.behavior.runCli(["on", "--thread", THREAD]);
    const result = await harness.behavior.runCli(["status", "--thread", THREAD, "--json"]);
    const parsed = JSON.parse(result.stdout) as { enabled: boolean };
    expect(parsed.enabled).toBe(true);
  });

  it("sets and shows the new-thread default", async () => {
    const { harness } = await load();
    expect((await harness.behavior.runCli(["default"])).stdout).toContain("no");
    const set = await harness.behavior.runCli(["default", "on"]);
    expect(set.stdout).toContain("yes");
    const bad = await harness.behavior.runCli(["default", "maybe"]);
    expect(bad.exitCode).not.toBe(0);
  });

  it("accepts an enforcement override and rejects a made-up one", async () => {
    const { harness } = await load();
    const ok = await harness.behavior.runCli([
      "on",
      "--thread",
      THREAD,
      "--enforcement",
      "block",
    ]);
    expect(ok.exitCode).toBe(0);
    const bad = await harness.behavior.runCli([
      "on",
      "--thread",
      THREAD,
      "--enforcement",
      "aggressive",
    ]);
    expect(bad.exitCode).not.toBe(0);
  });

  it("lists and clears violations", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_cli", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "z.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const list = await harness.behavior.runCli(["violations", "--thread", THREAD]);
    expect(list.stdout).toContain("z.ts");
    const cleared = await harness.behavior.runCli([
      "violations",
      "--thread",
      THREAD,
      "--clear",
    ]);
    expect(cleared.stdout).toContain("Cleared");
  });

  it("prints help", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("orchestrator-mode");
  });
});

describe("sweep regressions", () => {
  it("sends one reminder when two idle events race for the same unjudged worker", async () => {
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: null,
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        delegations: [
          { threadId: WORKER, title: "Do it", task: "Do it", createdAt: Date.now() - 1_000, status: "idle", verdict: null },
        ],
      },
    });
    await Promise.all([idle(harness), idle(harness)]);
    await vi.waitFor(() => expect(sentTexts.length).toBeGreaterThan(0));
    // The scan runs on the plugin's own debounce timer, so this settle is real time by nature and fake timers cannot
    // drive it; a second reminder would have to arrive inside the same window. Promise.withResolvers is newer than
    // this project's lib, so the file's own idiom is used.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sentTexts).toHaveLength(1);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({ nudgeCount: 1 });
  });

  it("counts delegations against the per-turn cap before the first dispatch", async () => {
    const { harness } = await load({ maxDelegationsPerTurn: 1, maxParallelWorkers: 0 });
    await enable(harness);
    const delegate = (task: string) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
    await delegate("First");
    await expect(delegate("Second")).rejects.toThrow(/caps a turn at 1/);
    expect(spawned).toHaveLength(1);
  });

  it("counts two simultaneous delegations against the parallel cap", async () => {
    const { harness } = await load({ maxParallelWorkers: 1, maxDelegationsPerTurn: 0 });
    await enable(harness);
    const settled = await Promise.allSettled(["First", "Second"].map((task) =>
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task, waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ));
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it("refuses a delegation once the thread is switched off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false, enforcement: null });
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    )).rejects.toThrow(/not in orchestrator mode/);
    expect(spawned).toHaveLength(0);
  });

  it("reads a null or partial state row instead of failing", async () => {
    const partial = "th_partial";
    const { harness } = await load({}, { [THREAD]: null, [partial]: { enabled: true } });
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      enabled: false,
      enforcement: null,
      enabledAt: null,
    });
    expect(await harness.behavior.callRpc("get_state", { threadId: partial })).toMatchObject({
      enabled: true,
      enforcement: null,
      enabledAt: null,
    });
  });

  it("judges a later turn that reuses a seen row id", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_dup", workKind: "file-change", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "a.ts" } }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: unknown[] };
      expect(state.violations).toHaveLength(1);
    });
    // The same id in a later turn is a different act, not a redelivery of the first.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_dup", workKind: "file-change", turnId: "turn_3", sourceSeqStart: 5, sourceSeqEnd: 6, change: { path: "b.ts" } }),
    ];
    timelineMaxSeq = 6;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { turnId: string | null }[] };
      expect(state.violations.map((violation) => violation.turnId)).toEqual(["turn_2", "turn_3"]);
    });
  });

  it("does not let a colon-bearing row id hide a later, different row", async () => {
    // lastSeq starts at 0 so both deliveries are above the cursor, and the rows
    // carry no turnId so neither spends a grace slot.
    const { harness } = await load({ enforcement: "guard" }, {
      [THREAD]: {
        enabled: true,
        enforcement: "guard",
        enabledAt: new Date(Date.now() - 60_000).toISOString(),
        touchedAt: Date.now(),
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
      },
    });
    // A seq-0 delivery whose id already contains the old `id:seq` separator.
    timelineRows = [
      workRow({ id: "a:1", workKind: "file-change", turnId: undefined, sourceSeqStart: 0, sourceSeqEnd: 0, change: { path: "src/first.ts" } }),
    ];
    timelineMaxSeq = 0;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { detail: string }[] };
      expect(state.violations.map((violation) => violation.detail)).toEqual(["changed src/first.ts itself"]);
    });
    // `{id:"a", sourceSeqEnd:1}` is a different row, not a redelivery of `a:1`.
    timelineRows = [
      ...timelineRows,
      workRow({ id: "a", workKind: "file-change", turnId: undefined, sourceSeqStart: 1, sourceSeqEnd: 1, change: { path: "src/second.ts" } }),
    ];
    timelineMaxSeq = 1;
    await idle(harness);
    await vi.waitFor(async () => {
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as { violations: { detail: string }[] };
      expect(state.violations.map((violation) => violation.detail)).toEqual([
        "changed src/first.ts itself",
        "changed src/second.ts itself",
      ]);
    });
  });

  it("keeps workers that are still owed a verdict when the record is trimmed", async () => {
    const { harness } = await load({ enforcement: "instruct", maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness, THREAD, "instruct");
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_worker_${++workerNumber}`, parentThreadId: THREAD }),
    );
    // One past the record window: the oldest unjudged record must survive the trim, or its verdict becomes impossible.
    for (let index = 0; index < 51; index += 1) {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: `Task ${index}` },
        { threadId: THREAD, projectId: "proj_1" },
      );
    }
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string }[];
      unreviewed: number;
    };
    expect(state.unreviewed).toBe(51);
    expect(state.delegations.map((delegation) => delegation.threadId)).toContain("th_worker_1");
  });
});
