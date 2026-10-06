import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import plugin, { DELEGATE_TOOL } from "./server";
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
let spawned: Record<string, unknown>[] = [];

/** Every loaded host, disposed after each test so no scan timer leaks into the next. */
const hosts: FakePluginHarness[] = [];

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
): Promise<{ bb: BbPluginApi; harness: FakePluginHarness }> {
  const host = createFakePluginHost({
    pluginId: "orchestrator-mode",
    settings,
    sdk: {
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
      },
    },
  });
  if (seedState !== undefined) {
    await host.bb.storage.kv.set("state", seedState);
  }
  await plugin(host.bb);
  hosts.push(host.harness);
  return host;
}

beforeEach(() => {
  timelineRows = [];
  timelineMaxSeq = 0;
  metadata = {};
  sentTexts = [];
  stoppedThreads = [];
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
  it("does not start a turn just to notify an idle thread", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    expect(sentTexts).toEqual([]);
  });

  it("notifies an active session when its mode changes", async () => {
    const { harness } = await load();
    harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: THREAD, status: "active" }),
    );
    await enable(harness);
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain("ORCHESTRATOR MODE IS ON");
    expect(sentTexts[0]).toContain("bb orchestrator-mode delegate");
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[1]).toContain("Orchestrator mode is now off");
  });

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
    expect(resolved.tools.map((tool) => tool.name)).toEqual([DELEGATE_TOOL]);
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
    const state = await harness.behavior.callRpc("get_state", { threadId: THREAD });
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

  it.each([
    "git status",
    "bb status --json; bb provider models codex --environment env_bucd4j3r9b --json",
    "find benchmarks -maxdepth 2 -type f 2>/dev/null; find research/sqlite -maxdepth 2 -type f 2>/dev/null",
  ])("lets read-only command `%s` through", async (command) => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: true });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_ls", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      violations: unknown[];
    };
    expect(state.violations).toEqual([]);
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
    expect(spawned[0]).not.toHaveProperty("providerId");
    expect(spawned[0]).not.toHaveProperty("model");
    expect(String(result)).toContain("the worker finished the task");
    expect(String(result)).toContain(WORKER);

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      delegations: { threadId: string; status: string | null }[];
    };
    expect(state.delegations).toHaveLength(1);
    expect(state.delegations[0]!.threadId).toBe(WORKER);
  });

  it("pins the requested provider and model before starting a worker", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      {
        task: "Probe the contract and scope without changing project files",
        providerId: "grok",
        model: "grok-test-model",
        waitForResult: false,
      },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "grok",
      model: "grok-test-model",
      parentThreadId: THREAD,
    });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      enabled: true,
      delegations: [{ threadId: WORKER }],
    });
  });

  it.each([
    { providerId: "grok" },
    { model: "grok-test-model" },
  ])("supports an individual worker pin: %j", async (pins) => {
    const { harness } = await load();
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", ...pins, waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject(pins);
    for (const key of ["providerId", "model"]) {
      if (!(key in pins)) expect(spawned[0]).not.toHaveProperty(key);
    }
  });

  it("normalises surrounding whitespace in worker pins", async () => {
    const { harness } = await load();
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", providerId: " grok ", model: " grok-test-model ", waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it.each([
    { providerId: "" },
    { providerId: "   " },
    { providerId: "x".repeat(121) },
    { model: "" },
    { model: "   " },
    { model: "x".repeat(201) },
  ])("rejects invalid worker pins before spawning: %j", async (pins) => {
    const { harness } = await load();
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL, { task: "Probe the scope", ...pins }, { threadId: THREAD },
    )).rejects.toThrow();
    expect(spawned).toEqual([]);
  });

  it("does not fall back to an unpinned worker when BB rejects the pins", async () => {
    const { harness } = await load();
    harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("requested provider/model unavailable");
    });
    await expect(harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", providerId: "grok", model: "grok-test-model" },
      { threadId: THREAD },
    )).rejects.toThrow("requested provider/model unavailable");
    const calls = harness.inspection.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [],
    });
  });

  it("returns immediately when asked not to wait", async () => {
    const { harness } = await load();
    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Do it", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(String(result)).toContain("without waiting");
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
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
});

describe("cli", () => {
  it("delegates after enabling a session that started without the native tool", async () => {
    const { harness } = await load();
    const originalSession = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: THREAD } }),
    );
    expect(originalSession.tools).toEqual([]);
    await enable(harness);
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Implement the retry policy; add tests", "--title", "Retry policy",
    ], { threadId: THREAD, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(WORKER);
    expect(result.stdout).toContain("the worker finished the task");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1", parentThreadId: THREAD,
      prompt: "Implement the retry policy; add tests", title: "Retry policy",
      environment: { type: "reuse", environmentId: "env_1" },
    });
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      delegations: [{ threadId: WORKER, status: "idle" }],
    });
  });

  it("supports CLI fan-out and derives an explicit parent's project", async () => {
    const { harness } = await load();
    harness.inspection.sdk.stub("threads.get", async () =>
      makeThreadResponse({ id: THREAD, projectId: "proj_parent", environmentId: "env_1" }),
    );
    const result = await harness.behavior.runCli([
      "delegate", "--thread", THREAD, "--task", "Implement retries", "--no-wait", "--hidden", "--json",
    ], { projectId: "proj_elsewhere" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout!).output).toContain("without waiting");
    expect(spawned[0]).toMatchObject({
      projectId: "proj_parent", parentThreadId: THREAD, visibility: "hidden",
    });
    expect(harness.inspection.sdk.callsTo("threads.wait")).toEqual([]);
  });

  it("pins the requested provider and model through CLI delegation", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Probe the contract and scope",
      "--provider", "grok", "--model", "grok-test-model", "--no-wait",
    ], { threadId: THREAD, projectId: "proj_1" });
    expect(result.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      providerId: "grok",
      model: "grok-test-model",
      parentThreadId: THREAD,
    });
    expect(harness.inspection.sdk.callsTo("threads.update")).toEqual([]);
  });

  it.each(["--provider-id", "--providerId"])("accepts the %s CLI alias", async (flag) => {
    const { harness } = await load();
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Probe the scope", flag, "grok",
      "--model", "grok-test-model", "--no-wait",
    ], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it("advertises worker pins in CLI help", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["delegate", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--provider");
    expect(result.stdout).toContain("--model");
    expect(spawned).toEqual([]);
  });

  it("rejects invalid CLI delegation arguments before spawning", async () => {
    const { harness } = await load();
    for (const args of [
      ["--task", ""],
      ["--task", "x".repeat(20_001)],
      ["--task", "x", "--timeout", "9"],
      ["--task", "x", "--provider", ""],
      ["--task", "x", "--provider", "   "],
      ["--task", "x", "--provider", "x".repeat(121)],
      ["--task", "x", "--model", ""],
      ["--task", "x", "--model", "   "],
      ["--task", "x", "--model", "x".repeat(201)],
    ]) {
      const result = await harness.behavior.runCli(["delegate", ...args, "--json"], { threadId: THREAD });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout!).ok).toBe(false);
    }
    expect(spawned).toEqual([]);
  });

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
