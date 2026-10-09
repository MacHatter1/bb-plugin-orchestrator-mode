import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import { REVIEW_TOOL } from "./shared";
import plugin, { DELEGATE_TOOL, MAX_STATE_BYTES, type OrchestratorStateDto } from "./server";
import { writeMirror } from "./shared";
import { CHILD_BATCH_WAIT_REASON } from "./child-message-queue";

const THREAD = "th_orchestrator";
const WORKER = "th_worker";
type QueueEntry = ReturnType<typeof makeQueueEntry>;

function childEntry(id: string, senderThreadId = WORKER, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return makeQueueEntry({
    id, threadId: THREAD, initiator: "agent", senderThreadId,
    content: [{ type: "text", text: `Full content of ${id}`, mentions: [] }],
    waitingOn: { kind: "plugin", pluginId: "orchestrator-mode", reason: "Waiting for the turn to finish" },
    ...overrides,
  });
}

/** Native queue contract: mutations touch ordering/group edges, never content. */
function queueFixture(harness: FakePluginHarness, initial: QueueEntry[]) {
  const queue = { entries: structuredClone(initial) };
  const snapshot = () => structuredClone(queue.entries);
  harness.inspection.sdk.stub("threads.queuedMessages.list", async () => snapshot());
  const reorder = vi.fn(async ({ queuedMessageId, previousQueuedMessageId, nextQueuedMessageId }) => {
    const index = queue.entries.findIndex((entry) => entry.id === queuedMessageId);
    const previous = queue.entries.findIndex((entry) => entry.id === previousQueuedMessageId);
    const next = queue.entries.findIndex((entry) => entry.id === nextQueuedMessageId);
    if (index < 0 || previous < 0 || next < 0 || previous >= next) throw new Error("stale neighbor");
    const [entry] = queue.entries.splice(index, 1);
    queue.entries.splice(queue.entries.findIndex((entry) => entry.id === nextQueuedMessageId), 0, entry!);
    return snapshot();
  });
  const group = vi.fn(async ({ expectedGroupedPrefixQueuedMessageIds, groupBoundaryQueuedMessageId }) => {
    const index = queue.entries.findIndex((entry) => entry.id === groupBoundaryQueuedMessageId);
    const prefix = queue.entries.slice(0, index + 1);
    if (index < 0 || JSON.stringify(prefix.map((entry) => entry.id)) !==
      JSON.stringify(expectedGroupedPrefixQueuedMessageIds)) throw new Error("stale prefix");
    const first = prefix[0]!;
    if (prefix.some((entry) => entry.senderThreadId !== first.senderThreadId || entry.model !== first.model ||
      entry.reasoningLevel !== first.reasoningLevel || entry.permissionMode !== first.permissionMode ||
      entry.serviceTier !== first.serviceTier)) throw new Error("incompatible group");
    queue.entries.forEach((entry, position) => { entry.groupWithNext = position < index; });
    return snapshot();
  });
  harness.inspection.sdk.stub("threads.queuedMessages.reorder", reorder);
  harness.inspection.sdk.stub("threads.queuedMessages.setGroupBoundary", group);
  return {
    queue, group, reorder,
    claim() {
      let count = 1;
      while (queue.entries[count - 1]?.groupWithNext && count < queue.entries.length) count++;
      return queue.entries.splice(0, count);
    },
  };
}

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

/** A catalog for the explicit worker-pin regression cases. */
const PIN_CATALOG: ProviderCatalogFixture = {
  providers: [{ id: "grok", available: true }],
  models: { grok: [{ id: "grok-test-model" }] },
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
  seedQueue?: QueueEntry[],
): Promise<{ bb: BbPluginApi; harness: FakePluginHarness }> {
  const providers = catalog.providers ?? [{ id: "acp-omp", available: true }];
  const modelsByProvider = catalog.models ?? {
    "acp-omp": [{ id: "command-code/deepseek/deepseek-v4.1-flash-fast" }],
  };
  const host = createFakePluginHost({
    pluginId: "orchestrator-mode",
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
        queuedMessages: { list: async () => [] },
        queue: { list: async () => seedQueue ?? [] },
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
  if (seedQueue) queueFixture(host.harness, seedQueue);
  if (seedState !== undefined) {
    await host.bb.storage.kv.set("state", seedState);
  }
  for (const [key, value] of Object.entries(seedKv ?? {})) {
    await host.bb.storage.kv.set(key, value);
  }
  // The plugin owns the global settings record in KV rather than through BB
  // settings descriptors, so the values a test names seed that record.
  if (Object.keys(settings).length > 0) {
    await host.bb.storage.kv.set("settings", settings);
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

  it("queues child messages instead of interrupting the active orchestrator", async () => {
    const { harness } = await load();
    await enable(harness);
    const decision = await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent",
      senderThreadId: WORKER,
      attempt: "join-turn",
    });
    expect(decision).toMatchObject({ action: "wait" });
  });

  it("delivers all queued messages from one child as a single native group", async () => {
    const { harness } = await load();
    await enable(harness);
    const entries = ["First update", "Second update", "Final report"].map((text, index) =>
      makeQueueEntry({
        id: `queued_${index}`, threadId: THREAD, initiator: "agent", senderThreadId: WORKER,
        content: [{ type: "text", text, mentions: [] }],
        waitingOn: { kind: "plugin", pluginId: "orchestrator-mode", reason: "Waiting for the turn to finish" },
      }),
    );
    harness.inspection.sdk.stub("threads.queuedMessages.list", async () => entries);
    const group = vi.fn(async () => entries);
    harness.inspection.sdk.stub("threads.queuedMessages.setGroupBoundary", group);

    await harness.behavior.emitThreadEvent("message.queued", { entry: entries[2]! });
    await vi.waitFor(() => expect(group).toHaveBeenCalledWith({
      threadId: THREAD,
      expectedGroupedPrefixQueuedMessageIds: entries.map((entry) => entry.id),
      groupBoundaryQueuedMessageId: entries[2]!.id,
    }));
    expect(entries.map((entry) => textOf(entry.content)))
      .toEqual(["First update", "Second update", "Final report"]);
    expect(sentTexts).toEqual([]);
  });

  it("batches interleaved children in first-child order and preserves every update", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: threadId === THREAD ? null : THREAD }),
    );
    const original = [childEntry("a1"), childEntry("b1", "th_b"), childEntry("a2", WORKER, {
      content: [
        { type: "text", text: "See worker", mentions: [{ start: 4, end: 10,
          resource: { kind: "thread", label: "worker", threadId: WORKER } }] },
        { type: "localFile", path: "/tmp/report.txt", name: "report.txt", mimeType: "text/plain", sizeBytes: 42 },
        { type: "image", url: "https://example.test/report.png" },
      ],
    }),
      childEntry("b2", "th_b"), childEntry("a3")];
    const { queue, claim, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[4]! });
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a1", "a2", "a3", "b1", "b2"]);
    expect(reorder).toHaveBeenCalledTimes(2);
    const first = claim();
    expect(first.map((entry) => entry.content)).toEqual([original[0]!.content, original[2]!.content, original[4]!.content]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: first,
    })).resolves.toEqual({ action: "proceed" });
    await harness.behavior.emitThreadEvent("message.dispatched", { entry: first[0]! });
    const second = claim();
    expect(second.map((entry) => entry.content)).toEqual([original[1]!.content, original[3]!.content]);
    expect(group).toHaveBeenCalledTimes(2);
    expect(queue.entries).toEqual([]);
    expect(harness.inspection.sdk.calls.some((call) =>
      ["threads.send", "threads.queuedMessages.send", "threads.queuedMessages.delete", "threads.queuedMessages.create"]
        .includes(call.path),
    )).toBe(false);
  });

  it("coalesces concurrent queue events without regrouping the same rows", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2"), childEntry("a3")];
    const { queue, group } = queueFixture(harness, original);
    await Promise.all(original.map((entry) => harness.behavior.emitThreadEvent("message.queued", { entry })));
    expect(group).toHaveBeenCalledTimes(1);
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
  });

  it("includes a new update arriving while a group boundary is being committed", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    const commit = group.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    group.mockImplementationOnce(async (args) => { await gate; return commit(args); });
    const first = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(group).toHaveBeenCalledTimes(1));
    const late = childEntry("a3");
    queue.entries.push(late);
    const second = harness.behavior.emitThreadEvent("message.queued", { entry: late });
    release();
    await Promise.all([first, second]);
    expect(queue.entries.map((entry) => entry.content)).toEqual([...original, late].map((entry) => entry.content));
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
    expect(group).toHaveBeenCalledTimes(2);
    expect(harness.inspection.recheckCount).toBeGreaterThan(0);
  });

  it.each([
    ["user message", makeQueueEntry({ id: "barrier", threadId: THREAD })],
    ["unrelated agent", childEntry("barrier", "th_unrelated")],
    ["another plugin's hold", childEntry("barrier", WORKER, {
      waitingOn: { kind: "plugin", pluginId: "another-plugin", reason: "Waiting" },
    })],
    ["scheduled message", childEntry("barrier", WORKER, { sendAt: Date.now() + 60_000 })],
  ])("does not group across a %s", async (_label, barrier) => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), barrier, childEntry("a2")];
    const { queue, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it.each([
    { model: "different-model" }, { reasoningLevel: "high" as const },
    { permissionMode: "full" as const }, { serviceTier: "fast" as const },
  ])("preserves the child's order across incompatible execution options %j", async (override) => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2", WORKER, override), childEntry("a3")];
    const { queue, group, reorder } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("preserves existing trailing user groups", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2"),
      makeQueueEntry({ id: "u1", threadId: THREAD, groupWithNext: true }),
      makeQueueEntry({ id: "u2", threadId: THREAD })];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("preserves an existing group that extends beyond eligible child messages", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1", WORKER, { groupWithNext: true }),
      childEntry("a2", WORKER, { groupWithNext: true }),
      childEntry("a3", WORKER, { sendAt: Date.now() + 60_000 })];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[0]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("extends an existing leading child group with a later update", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1", WORKER, { groupWithNext: true }), childEntry("a2"), childEntry("a3")];
    const { queue } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[2]! });
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, true, false]);
  });

  it("defers a claimed row once so a queue-vs-dispatch race can form the full batch", async () => {
    const { harness } = await load();
    await enable(harness);
    const first = childEntry("a1");
    const { queue, claim } = queueFixture(harness, [childEntry("a2")]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first],
    })).resolves.toEqual({ action: "wait", reason: CHILD_BATCH_WAIT_REASON });
    first.waitingOn = { kind: "plugin", pluginId: "orchestrator-mode", reason: CHILD_BATCH_WAIT_REASON };
    queue.entries.unshift(first);
    await harness.behavior.emitThreadEvent("message.queued", { entry: first });
    const grouped = claim();
    expect(grouped.map((entry) => entry.id)).toEqual(["a1", "a2"]);
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: grouped,
    })).resolves.toEqual({ action: "proceed" });
  });

  it("retries stale boundaries without resurrecting a deleted queued update", async () => {
    const { harness } = await load();
    await enable(harness);
    const { queue, group } = queueFixture(harness, [childEntry("a1"), childEntry("a2"), childEntry("a3")]);
    group.mockImplementationOnce(async () => {
      queue.entries.splice(1, 1);
      throw new Error("stale prefix");
    });
    await harness.behavior.emitThreadEvent("message.queued", { entry: queue.entries[2]! });
    expect(queue.entries.map((entry) => entry.id)).toEqual(["a1", "a3"]);
    expect(queue.entries.map((entry) => entry.groupWithNext)).toEqual([true, false]);
    expect(group).toHaveBeenCalledTimes(2);
  });

  it("keeps original rows deliverable if grouping fails persistently", async () => {
    const { harness } = await load();
    await enable(harness);
    const first = childEntry("a1");
    const original = [first, childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    group.mockImplementation(async () => { throw new Error("queue unavailable"); });
    await harness.behavior.emitThreadEvent("message.queued", { entry: first });
    expect(group).toHaveBeenCalledTimes(3);
    expect(queue.entries).toEqual(original);
    first.waitingOn = { kind: "plugin", pluginId: "orchestrator-mode", reason: CHILD_BATCH_WAIT_REASON };
    await expect(dispatch(harness, THREAD, { status: "idle" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first],
    })).resolves.toEqual({ action: "proceed" });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, queuedMessages: [first], attempt: "join-turn",
    })).resolves.toMatchObject({ action: "wait", reason: expect.stringContaining("current turn") });
  });

  it.each(["disabled", "immediate"])("does not group when delivery is %s", async (mode) => {
    const { harness } = await load({ childMessageDelivery: mode === "immediate" ? "immediate" : "queued" });
    if (mode !== "disabled") await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("honours disabling orchestrator mode while a queue read is in flight", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { queue, group, reorder } = queueFixture(harness, original);
    let release!: (entries: QueueEntry[]) => void;
    const pending = new Promise<QueueEntry[]>((resolve) => { release = resolve; });
    harness.inspection.sdk.stub("threads.queuedMessages.list", () => pending);
    const event = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(harness.inspection.sdk.calls.some((call) => call.path === "threads.queuedMessages.list")).toBe(true));
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    release(original);
    await event;
    expect(group).not.toHaveBeenCalled();
    expect(reorder).not.toHaveBeenCalled();
    expect(queue.entries).toEqual(original);
  });

  it("groups under a project override of immediate global delivery", async () => {
    const { harness } = await load({ childMessageDelivery: "immediate" });
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: "queued",
    });
    const original = [childEntry("a1"), childEntry("a2")];
    const { group } = queueFixture(harness, original);
    await harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    expect(group).toHaveBeenCalledTimes(1);
  });

  it("recovers same-child batches already waiting when the plugin reloads", async () => {
    const { bb } = await load({}, { [THREAD]: { enabled: true } }, {}, undefined,
      [childEntry("a1"), childEntry("a2")]);
    const queued = await bb.sdk.threads.queuedMessages.list({ threadId: THREAD });
    expect(queued.map((entry) => entry.groupWithNext)).toEqual([true, false]);
  });

  it("stops an in-flight grouping job on disposal", async () => {
    const { harness } = await load();
    await enable(harness);
    const original = [childEntry("a1"), childEntry("a2")];
    const { group } = queueFixture(harness, original);
    let release!: (entries: QueueEntry[]) => void;
    const pending = new Promise<QueueEntry[]>((resolve) => { release = resolve; });
    harness.inspection.sdk.stub("threads.queuedMessages.list", () => pending);
    const event = harness.behavior.emitThreadEvent("message.queued", { entry: original[1]! });
    await vi.waitFor(() => expect(harness.inspection.sdk.calls.some((call) => call.path === "threads.queuedMessages.list")).toBe(true));
    await harness.lifecycle.dispose();
    release(original);
    await event;
    expect(group).not.toHaveBeenCalled();
  });

  it("holds messages from multiple children and releases each retry when the orchestrator is idle", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
      makeThreadResponse({ id: threadId, parentThreadId: THREAD }),
    );
    for (const senderThreadId of [WORKER, "th_worker_2"]) {
      const context = { initiator: "agent", senderThreadId };
      await expect(dispatch(harness, THREAD, { status: "active" }, {
        ...context, attempt: "join-turn",
      })).resolves.toMatchObject({ action: "wait" });
      await expect(dispatch(harness, THREAD, { status: "idle" }, {
        ...context, attempt: "start-turn",
        queuedMessages: [makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId })],
      })).resolves.toEqual({ action: "proceed" });
    }
    expect(sentTexts).toEqual([]);
  });

  it.each([
    { initiator: "user", senderThreadId: null },
    { initiator: "system", senderThreadId: null },
    { initiator: "agent", senderThreadId: null },
    { initiator: "agent", senderThreadId: "th_unrelated" },
  ])("lets $initiator messages from $senderThreadId reach the running turn", async (context) => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      ...context, attempt: "join-turn",
    })).resolves.toEqual({ action: "proceed" });
  });

  it("does not hold a queued group that includes a user message", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "mixed",
      senderThreadId: "mixed",
      attempt: "join-turn",
      queuedMessages: [
        makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId: WORKER }),
        makeQueueEntry({ threadId: THREAD, initiator: "user", senderThreadId: null }),
      ],
    })).resolves.toEqual({ action: "proceed" });
  });

  it("does not hold a group that includes an unrelated agent", async () => {
    const { harness } = await load();
    await enable(harness);
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent",
      senderThreadId: "mixed",
      attempt: "join-turn",
      queuedMessages: [WORKER, "th_unrelated"].map((senderThreadId) =>
        makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId }),
      ),
    })).resolves.toEqual({ action: "proceed" });
  });

  it("proceeds if a child's relationship can no longer be read", async () => {
    const { harness } = await load();
    await enable(harness);
    harness.inspection.sdk.stub("threads.get", async () => { throw new Error("thread deleted"); });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
    })).resolves.toEqual({ action: "proceed" });
  });

  it("releases waiting child messages when orchestrator mode is turned off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    await expect(dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
      queuedMessages: [makeQueueEntry({ threadId: THREAD, initiator: "agent", senderThreadId: WORKER })],
    })).resolves.toEqual({ action: "proceed" });
  });

  it("honours immediate delivery globally and a project's queued override", async () => {
    const { harness } = await load({ childMessageDelivery: "immediate" });
    await enable(harness);
    const context = { initiator: "agent", senderThreadId: WORKER, attempt: "join-turn" };
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toEqual({ action: "proceed" });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: "queued",
    });
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toMatchObject({ action: "wait" });
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: makeMessageDispatchHookContext().project.id, key: "childMessageDelivery", value: null,
    });
    await expect(dispatch(harness, THREAD, { status: "active" }, context))
      .resolves.toEqual({ action: "proceed" });
  });

  it("keeps the per-turn delegation budget through waits and steering messages", async () => {
    const { bb, harness } = await load({}, {
      [THREAD]: { enabled: true, turnStartedAt: 777 },
    });
    await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "agent", senderThreadId: WORKER, attempt: "join-turn",
    });
    await dispatch(harness, THREAD, { status: "active" }, {
      initiator: "user", senderThreadId: null, attempt: "join-turn",
    });
    const state = await bb.storage.kv.get<Record<string, { turnStartedAt: number }>>("state");
    expect(state?.[THREAD]?.turnStartedAt).toBe(777);
    await dispatch(harness, THREAD, { status: "idle" }, { attempt: "start-turn" });
    const updated = await bb.storage.kv.get<Record<string, { turnStartedAt: number }>>("state");
    expect(updated?.[THREAD]?.turnStartedAt).toBeGreaterThan(777);
  });

  it("configures child message delivery through the scope CLI", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["scope", "--global", "--child-messages", "immediate", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).values.childMessageDelivery).toBe("immediate");
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

  it("allows stdin follow-ups to recorded workers with read-only exploration disabled", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: false });
    await arm(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL, { task: "Review the implementation", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    const command = `bb thread tell ${WORKER} --model grok-4.7 --mode steer --message-file - <<'FOLLOWUP'\nAdd tests and run them in the worker.\nFOLLOWUP`;
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_followup", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [], delegations: [{ threadId: WORKER }],
    });
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("recognises workers recorded while the timeline request is in flight", async () => {
    const { harness } = await load({ enforcement: "block", allowReadCommands: false });
    await arm(harness);
    const command = `bb thread tell ${WORKER} 'Add tests'`;
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_concurrent_followup", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command }),
    ];
    timelineMaxSeq = 4;
    harness.inspection.sdk.stub("threads.timeline", async () => {
      await harness.behavior.callAgentTool(
        DELEGATE_TOOL, { task: "Review the implementation", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      );
      return { rows: timelineRows, maxSeq: timelineMaxSeq };
    });
    await idle(harness);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [], delegations: [{ threadId: WORKER }],
    });
    expect(stoppedThreads).toEqual([]);
    expect(sentTexts).toEqual([]);
  });

  it("still flags follow-up commands to unrecorded threads", async () => {
    const { harness } = await load({ enforcement: "block" });
    await arm(harness);
    timelineRows = [
      ...timelineRows,
      workRow({ id: "row_unrecorded", workKind: "command", turnId: "turn_2", sourceSeqStart: 3, sourceSeqEnd: 4, command: "bb thread tell th_other 'Do work'" }),
    ];
    timelineMaxSeq = 4;
    await idle(harness);
    await vi.waitFor(() => expect(stoppedThreads).toEqual([THREAD]));
    expect(await harness.behavior.callRpc("get_state", { threadId: THREAD })).toMatchObject({
      violations: [{ id: "row_unrecorded" }],
    });
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

  it.each(["provider", "providerId"])("pins %s and the model before starting a worker", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      {
        task: "Probe the contract and scope without changing project files",
        [field]: "grok",
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
      executionInputSources: { providerId: "explicit", model: "explicit" },
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", ...pins, waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject(pins);
    // Model-only calls infer its provider, as the execution-controls path does.
    expect(spawned[0]).toMatchObject({ providerId: "grok" });
    if (!("model" in pins)) expect(spawned[0]).not.toHaveProperty("model");
  });

  it.each(["provider", "providerId"])("normalises whitespace in %s and model pins", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Probe the scope", [field]: " grok ", model: " grok-test-model ", waitForResult: false },
      { threadId: THREAD },
    );
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it.each([
    { providerId: "" },
    { providerId: "   " },
    { providerId: "x".repeat(121) },
    { provider: "" },
    { provider: "   " },
    { provider: "x".repeat(121) },
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
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

  it("refuses a raw model pin under the pinned default", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await enable(harness);
    // The default is pinned, so a delegation cannot move a worker off the scope's
    // execution — not even upward.
    await expect(
      harness.behavior.callAgentTool(
        DELEGATE_TOOL,
        { task: "The hard unit", model: "claude-opus-5-5", waitForResult: false },
        { threadId: THREAD, projectId: "proj_1" },
      ),
    ).rejects.toThrow(/pins worker execution, so `model` cannot be set/);
    expect(spawned).toHaveLength(0);
  });

  it.each(["provider", "reasoning"])("refuses a raw %s pin under the pinned default", async (field) => {
    const { harness } = await load({}, undefined, PIN_CATALOG);
    await enable(harness);
    const args =
      field === "provider"
        ? { task: "The hard unit", provider: "grok", waitForResult: false }
        : { task: "The hard unit", reasoning: "max" as const, waitForResult: false };
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, args, { threadId: THREAD, projectId: "proj_1" }),
    ).rejects.toThrow(new RegExp(`pins worker execution, so \`${field}\` cannot be set`));
    expect(spawned).toHaveLength(0);
  });

  it("still runs a stored preset under the pinned default", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await harness.behavior.callRpc("set_worker_execution", {
      providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast",
      presets: { research: { model: "claude-opus-5-5" } },
    });
    await enable(harness);
    // A kind the user saved is their own choice, so pinned leaves it reachable.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Research it", preset: "research", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({ model: "claude-opus-5-5" });
  });

  it("lets a scope opt into flexible, and then a delegation picks its own model", async () => {
    const { harness } = await load({}, undefined, CATALOG);
    await enable(harness);
    await harness.behavior.callRpc("set_scope_setting", {
      projectId: "proj_1",
      key: "workerModelPolicy",
      value: "flexible",
    });
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "The hard unit", model: "claude-opus-5-5", waitForResult: false },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]).toMatchObject({ model: "claude-opus-5-5" });
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
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
    // told to go after the work — not to reread it — without repairing anything.
    const brief = String(spawned[1]!.prompt);
    expect(brief).toContain("Add a retry to src/retry.ts");
    expect(brief).toContain("did the thing");
    expect(brief).toContain("Do not modify any file");
    expect(brief).toContain("run the tests, the command or the steps the brief names");
    expect(brief).toContain("paste it, do not summarise it");
    expect(String(result)).toContain("VERDICT: pass");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations).toHaveLength(2);
    expect(state.delegations[0]).toMatchObject({ verifiedBy: "th_check" });
    // A check unit is evidence, not a unit the orchestrator must judge.
    expect(state).toMatchObject({ unreviewed: 1 });
  });

  it("gives a worktree unit its own checkout, and keeps its check unit in it", async () => {
    const { harness } = await load();
    await enable(harness);
    let started = 0;
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      const first = started++ === 0;
      return makeThreadResponse({
        id: first ? "th_unit" : "th_check",
        parentThreadId: THREAD,
        environmentId: first ? "env_worktree" : "env_parent",
      });
    });
    harness.inspection.sdk.stub("threads.output", async ({ threadId }) => ({
      output: threadId === "th_check" ? "VERDICT: pass" : "did the thing",
    }));
    harness.inspection.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({
      environmentId,
      hostId: "host_1",
      branchName: "bb/work/th-unit",
      path: "/tmp/worktrees/th-unit",
      isWorktree: true,
      status: "ready",
    }));

    const result = await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", workspace: "worktree", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );

    // The unit is spawned in a managed worktree on the orchestrator's own machine.
    expect(spawned[0]!.environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
    // Its check unit reuses that worktree, so it inspects the same working tree.
    expect(spawned[1]!.environment).toEqual({ type: "reuse", environmentId: "env_worktree" });
    // The result names the branch, because nothing lands until it is merged, and
    // hands over the merge brief the orchestrator is allowed to run.
    expect(String(result)).toContain("bb/work/th-unit");
    expect(String(result)).toContain("bb environment diff env_worktree");
    expect(String(result)).toContain('delegate a merge unit with `workspace: "shared"`');
    expect(String(result)).toContain("report what conflicts instead of resolving them");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.delegations[0]).toMatchObject({ environmentId: "env_worktree" });
  });

  it("keeps every worker in the orchestrator's checkout when the scope says shared", async () => {
    const { harness } = await load({ workerWorkspace: "shared" });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit", parentThreadId: THREAD, environmentId: "env_parent" });
    });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts" },
      { threadId: THREAD, projectId: "proj_1" },
    );

    expect(spawned[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });
  });

  it("makes every delegation name its checkout under a mixed scope", async () => {
    const { harness } = await load({ workerWorkspace: "mixed" });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: "th_unit", parentThreadId: THREAD, environmentId: "env_1" });
    });

    // No choice is refused, and the refusal names both options.
    await expect(
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Touch two files" }, { threadId: THREAD, projectId: "proj_1" }),
    ).rejects.toThrow(/names where it runs/);
    expect(spawned).toHaveLength(0);

    // An explicit choice is honoured both ways, whatever the call is.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "A unit that stays put", workspace: "shared" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]!.environment).toEqual({ type: "reuse", environmentId: "env_1" });

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "A unit that needs its own copy", workspace: "worktree" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[1]!.environment).toMatchObject({
      type: "host",
      workspace: { type: "managed-worktree" },
    });
  });

  it("teaches the merge path to a worktree scope", async () => {
    const { harness } = await load({ workerWorkspace: "worktree" });
    const contract = (await harness.behavior.callRpc("get_contract", { threadId: null })) as { text: string };
    expect(contract.text).toContain("Units run in their own worktrees");
    expect(contract.text).toContain('workspace: "shared"');
    expect(contract.text).toContain("delegate the merge as its own unit");

    const mixed = await load({ workerWorkspace: "mixed" });
    const mixedContract = (await mixed.harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(mixedContract.text).toContain("Name where each unit runs");
    // A shared scope stays silent about checkouts it never creates.
    const shared = await load({ workerWorkspace: "shared" });
    const sharedContract = (await shared.harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(sharedContract.text).not.toContain("worktree");
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

  it("names the preset in every child's title", async () => {
    const model = "command-code/deepseek/deepseek-v4.1-flash-fast";
    const { harness } = await load({}, undefined, {}, {
      worker: { presets: { build: { model }, research: { model }, review: { model } } },
    });
    await enable(harness);
    harness.inspection.sdk.stub("threads.spawn", async (args) => {
      spawned.push(args as unknown as Record<string, unknown>);
      return makeThreadResponse({ id: `th_${spawned.length}`, parentThreadId: THREAD, environmentId: "env_1" });
    });
    harness.inspection.sdk.stub("threads.output", async () => ({ output: "done" }));

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Add a retry to src/retry.ts", preset: "build" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[0]!.title).toBe("BUILD: Add a retry to src/retry.ts");

    // An explicit title is prefixed too, and the check unit keeps the prefix.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Check the docs", title: "Doc pass", preset: "review", verify: true },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[1]!.title).toBe("REVIEW: Doc pass");
    expect(spawned[2]!.title).toBe("REVIEW: Doc pass (check)");

    // A title that already names the preset is left alone, and a delegation
    // without one is titled exactly as it was.
    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Find the call sites", title: "RESEARCH: call sites", preset: "research" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[3]!.title).toBe("RESEARCH: call sites");

    await harness.behavior.callAgentTool(
      DELEGATE_TOOL,
      { task: "Just a plain unit" },
      { threadId: THREAD, projectId: "proj_1" },
    );
    expect(spawned[4]!.title).toBe("Just a plain unit");
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, CATALOG);
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

  it("emits the contract the two settings name", async () => {
    const { harness } = await load({ contractPreset: "review-heavy" });
    const contract = (await harness.behavior.callRpc("get_contract", { threadId: null })) as {
      text: string;
    };
    expect(contract.text).toContain("Every unit gets checked before you trust it");
    expect(contract.text).toContain("runs what it claims");
    expect(contract.text).not.toContain("`verify: true` for a unit whose result you cannot judge");
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

  it("reads and writes one scope's settings, and refuses to clear the global record", async () => {
    const { bb, harness } = await load({ enforcement: "instruct", maxNudges: 5 });
    const globals = {
      enforcement: "instruct",
      allowReadCommands: true,
      maxNudges: 5,
      maxParallelWorkers: 8,
      maxDelegationsPerTurn: 20,
      contractPreset: "standard",
      workerModelPolicy: "pinned",
      workerRetention: "keep",
      workerWorkspace: "shared",
      childMessageDelivery: "queued",
    };
    expect(await harness.behavior.callRpc("get_scope_settings", { projectId: null })).toEqual({
      values: globals,
      global: globals,
      overridden: [],
    });

    const written = (await harness.behavior.callRpc("set_scope_setting", {
      projectId: null,
      key: "maxParallelWorkers",
      value: 2,
    })) as { values: { maxParallelWorkers: number }; overridden: string[] };
    expect(written.values.maxParallelWorkers).toBe(2);
    expect(written.overridden).toEqual([]);
    // Stored, not just mirrored: the next read and a thread's own view both see it.
    expect(await bb.storage.kv.get("settings")).toMatchObject({ maxParallelWorkers: 2 });
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as {
      maxParallelWorkers: number;
    };
    expect(state.maxParallelWorkers).toBe(2);

    // The global record has nothing above it, so there is no inherit to fall back to.
    await expect(
      harness.behavior.callRpc("set_scope_setting", { projectId: null, key: "maxNudges", value: null }),
    ).rejects.toThrow(/no inherited value/);
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

  it("keeps the persisted map under the byte budget without losing the newest thread", async () => {
    const detail = "x".repeat(100);
    const seed: Record<string, unknown> = {};
    for (let index = 1; index <= 20; index += 1) {
      seed[`th_${index}`] = {
        enabled: false,
        touchedAt: index,
        violations: Array.from({ length: 60 }, (_, at) => ({
          id: `v_${index}_${at}`,
          turnId: "turn_1",
          workKind: "command",
          detail,
          detectedAt: index,
        })),
      };
    }
    // ~220 KB of rows: seedable (under the store's 256 KB limit) but well past
    // the plugin's 192 KB budget, so the next write has to prune before it can
    // succeed.
    const { bb, harness } = await load({}, seed);
    await enable(harness);

    const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
    // (a) the persisted map fits the budget the store enforces.
    expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeLessThanOrEqual(MAX_STATE_BYTES);
    // (b) the newest thread and the newest seeded row survived the trim.
    expect(raw[THREAD]).toMatchObject({ enabled: true });
    expect(raw.th_20).toBeDefined();
    expect(Object.keys(raw).length).toBeLessThan(20);
    // (c) the write succeeded and a surviving row still reads back whole.
    const kept = (await harness.behavior.callRpc("get_state", {
      threadId: "th_20",
    })) as OrchestratorStateDto;
    expect(kept.violations).toHaveLength(60);
  });
});

describe("state persistence", () => {
  it("counts the byte budget in UTF-8 bytes, not code units", async () => {
    // ~100 K code units but ~200 K UTF-8 bytes: a code-unit budget would keep
    // the whole map, the byte budget has to evict the oldest row.
    const seed: Record<string, unknown> = {
      th_old: { enabled: false, touchedAt: 1, lastReviewNudge: "😀".repeat(50_000) },
      th_new: { enabled: false, touchedAt: 2 },
    };
    expect(JSON.stringify(seed).length).toBeLessThan(MAX_STATE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(seed), "utf8")).toBeGreaterThan(MAX_STATE_BYTES);

    const { bb, harness } = await load({}, seed);
    await enable(harness, "th_write");

    const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeLessThanOrEqual(MAX_STATE_BYTES);
    expect(raw.th_old).toBeUndefined();
    expect(raw.th_new).toBeDefined();
    expect(raw.th_write).toMatchObject({ enabled: true });
    // The eviction is announced, never silent.
    expect(
      harness.inspection.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("th_old"),
      ),
    ).toBe(true);
  });

  it("starts empty when the stored state cannot be read, then recovers on the next write", async () => {
    const { bb, harness } = await load();
    const realGet = bb.storage.kv.get.bind(bb.storage.kv);
    const read = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key: string) => {
      if (key === "state") throw new Error("corrupt json");
      return realGet(key);
    });
    try {
      // A corrupt store must not throw out of a read: an unknown thread simply
      // has no state, which is what every caller already handles.
      const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
      expect(state.enabled).toBe(false);
      expect(
        harness.inspection.logEntries.some(
          (entry) => entry.level === "warn" && entry.message.includes("state read failed"),
        ),
      ).toBe(true);
    } finally {
      read.mockRestore();
    }
    await enable(harness);
    expect(await bb.storage.kv.get("state")).toMatchObject({ [THREAD]: { enabled: true } });
  });

  it("treats an array-shaped stored state as empty instead of harvesting its indices", async () => {
    const { bb, harness } = await load(
      {},
      [{ enabled: true, touchedAt: 1 }] as unknown as Record<string, unknown>,
    );
    await enable(harness);
    const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
    // The array's element must not come back as a thread keyed "0".
    expect(Object.keys(raw)).toEqual([THREAD]);
    expect(
      harness.inspection.logEntries.some(
        (entry) => entry.level === "warn" && entry.message.includes("not an object"),
      ),
    ).toBe(true);
  });

  it("keeps a stored __proto__ thread id instead of letting it become the map's prototype", async () => {
    // A hostile or stale store can name a row "__proto__": a plain
    // `map[id] = row` would set the map's prototype and the row would vanish
    // from Object.keys and JSON.stringify.
    const seed: Record<string, unknown> = {};
    for (let index = 0; index < 300; index += 1) {
      seed[`th_${index}`] = { enabled: false, touchedAt: index };
    }
    Object.defineProperty(seed, "__proto__", {
      value: { enabled: true, touchedAt: 9_999 },
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const { bb, harness } = await load({}, seed);
    await enable(harness);

    const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(raw, "__proto__")).toBe(true);
    // The count cap still evicted the oldest real row, not the newer proto row.
    expect(raw.th_0).toBeUndefined();
    expect(raw.th_299).toBeDefined();
    // Nothing leaked onto Object.prototype.
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  it("does not let a read that was in flight when a write landed resurrect the pre-write map", async () => {
    const { bb, harness } = await load();
    const realGet = bb.storage.kv.get.bind(bb.storage.kv);
    let stateReads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(bb.storage.kv, "get").mockImplementation(async (key: string) => {
      const value = await realGet(key);
      // Hold the first state read open until a write has already committed, so
      // it resolves with a snapshot older than the cache.
      if (key === "state" && (stateReads += 1) === 1) await gate;
      return value;
    });
    try {
      const pending = harness.behavior.callRpc("get_state", { threadId: "th_read" });
      await vi.waitFor(() => expect(stateReads).toBe(1));
      await enable(harness, "th_a");
      release();
      await pending;
      await enable(harness, "th_b");

      const raw = (await bb.storage.kv.get("state")) as Record<string, unknown>;
      expect(raw).toMatchObject({ th_a: { enabled: true }, th_b: { enabled: true } });
    } finally {
      read.mockRestore();
    }
  });
});

describe("cli", () => {
  it("reports the reminder budget split by the gate that spent it", async () => {
    const { harness } = await load({ enforcement: "guard" });
    await arm(harness);
    harness.inspection.sdk.stub("threads.timeline", async () => ({
      rows: [],
      maxSeq: 4,
      delta: {
        upsertRows: [
          workRow({
            id: "row_split", workKind: "file-change", turnId: "turn_2",
            sourceSeqStart: 3, sourceSeqEnd: 4, change: { path: "split.ts" },
          }),
        ],
      },
    }));
    await idle(harness);
    await vi.waitFor(() => expect(sentTexts).toHaveLength(1));

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state).toMatchObject({ nudgeCount: 1, violationNudges: 1, reviewNudges: 0 });

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("1 direct work, 0 unjudged workers");
  });

  it("bounds the verdict-owed records that outlive the newest window", async () => {
    const { harness } = await load({ enforcement: "instruct", maxParallelWorkers: 0, maxDelegationsPerTurn: 0 });
    await enable(harness, THREAD, "instruct");
    let workerNumber = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_w${++workerNumber}`, parentThreadId: THREAD }),
    );
    // Past both the record window (50) and the verdict-owed ceiling (200): the array is
    // re-serialized on every mutation, so "never drop an owed record" needs a bound of its
    // own. The newest owed records survive.
    for (let index = 0; index < 260; index += 1) {
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
    expect(state.delegations.length).toBe(250);
    expect(state.unreviewed).toBe(250);
    expect(state.delegations.map((delegation) => delegation.threadId)).toContain("th_w260");
    expect(state.delegations.map((delegation) => delegation.threadId)).not.toContain("th_w1");
  });

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
    await enable(harness);
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
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
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    const result = await harness.behavior.runCli([
      "delegate", "--task", "Probe the scope", flag, "grok",
      "--model", "grok-test-model", "--no-wait",
    ], { threadId: THREAD });
    expect(result.exitCode).toBe(0);
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it("accepts matching provider aliases after trimming", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe matching aliases", provider: " grok ", providerId: "grok",
      model: "grok-test-model", waitForResult: false,
    }, { threadId: THREAD });
    expect(spawned[0]).toMatchObject({ providerId: "grok", model: "grok-test-model" });
  });

  it("refuses conflicting provider aliases without spawning", async () => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe conflicting aliases", provider: "grok", providerId: "other",
      model: "grok-test-model", waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("must match");
    expect(spawned).toEqual([]);
  });

  it.each(["provider", "providerId"])("does not retarget an unknown %s to the model owner", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, PIN_CATALOG);
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe unknown pins", [field]: "other", model: "grok-test-model",
      waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("Unknown worker provider");
    expect(spawned).toEqual([]);
  });

  it.each(["provider", "providerId"])("refuses a model incompatible with the pinned %s", async (field) => {
    const { harness } = await load({ workerModelPolicy: "flexible" }, undefined, {
      providers: [...CATALOG.providers!, ...PIN_CATALOG.providers!],
      models: { ...CATALOG.models, ...PIN_CATALOG.models },
    });
    await enable(harness);
    await expect(harness.behavior.callAgentTool(DELEGATE_TOOL, {
      task: "Probe incompatible pins", [field]: "grok", model: "claude-opus-5-5",
      waitForResult: false,
    }, { threadId: THREAD })).rejects.toThrow("pinned provider");
    expect(spawned).toEqual([]);
  });

  it("advertises worker pins in CLI help", async () => {
    const { harness } = await load();
    const result = await harness.behavior.runCli(["delegate", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--provider");
    expect(result.stdout).toContain("--model");
    expect(spawned).toEqual([]);
  });

  it.each(["tool", "cli"])("preserves project worker execution through %s delegation", async (route) => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_project_worker", {
      projectId: "proj_1",
      config: { providerId: "acp-omp", model: "command-code/deepseek/deepseek-v4.1-flash-fast", reasoningLevel: "high" },
    });
    const context = { threadId: THREAD, projectId: "proj_1" };
    if (route === "tool") {
      await harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Review scoped execution", waitForResult: false }, context);
    } else {
      const result = await harness.behavior.runCli(["delegate", "--task", "Review scoped execution", "--no-wait"], context);
      expect(result.exitCode).toBe(0);
    }
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1", providerId: "acp-omp",
      model: "command-code/deepseek/deepseek-v4.1-flash-fast", reasoningLevel: "high",
    });
    expect(spawned[0]).not.toHaveProperty("fallback");
    expect(spawned[0]).not.toHaveProperty("presets");
  });

  it("keeps the worker cap on CLI delegation", async () => {
    const { harness } = await load({ maxParallelWorkers: 1 });
    await enable(harness);
    const context = { threadId: THREAD, projectId: "proj_1" };
    const first = await harness.behavior.runCli(["delegate", "--task", "First unit", "--no-wait"], context);
    expect(first.exitCode).toBe(0);
    const second = await harness.behavior.runCli(["delegate", "--task", "Second unit", "--no-wait", "--json"], context);
    expect(second.exitCode).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("refuses CLI delegation after the mode is switched off", async () => {
    const { harness } = await load();
    await enable(harness);
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: false });
    const result = await harness.behavior.runCli(["delegate", "--task", "Stale session unit", "--json"], {
      threadId: THREAD, projectId: "proj_1",
    });
    expect(result.exitCode).toBe(1);
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
describe("project scopes", () => {
  const PROJECT = "proj_scoped";
  const OTHER = "proj_other";
  const threadIn = (projectId: string) => makeThreadResponse({ id: THREAD, projectId, environmentId: "env_1" });

  it("resolves a project's settings over the globals, thread first, and reports the scope", async () => {
    const { harness } = await load();
    await enable(harness, THREAD);
    harness.inspection.sdk.stub("threads.get", async () => threadIn(PROJECT));

    const written = await harness.behavior.runCli([
      "scope", "--project", PROJECT, "--enforcement", "block", "--max-nudges", "7", "--max-parallel", "2",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("project proj_scoped");
    expect(written.stdout).toContain("settings overridden: enforcement, maxNudges, maxParallelWorkers");

    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.effectiveEnforcement).toBe("block");
    expect(state.maxNudges).toBe(7);
    expect(state.maxParallelWorkers).toBe(2);

    const status = await harness.behavior.runCli(["status", "--thread", THREAD]);
    expect(status.stdout).toContain("scope:             project proj_scoped (overrides: enforcement, maxNudges, maxParallelWorkers)");

    // A thread override still wins over the project's.
    await harness.behavior.callRpc("set_enabled", { threadId: THREAD, enabled: true, enforcement: "instruct" });
    const overridden = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(overridden.effectiveEnforcement).toBe("instruct");
  });

  it("applies a project's fan-out cap to that project only", async () => {
    const { harness } = await load({ maxParallelWorkers: 0 });
    await enable(harness, THREAD);
    let spawned = 0;
    harness.inspection.sdk.stub("threads.spawn", async () =>
      makeThreadResponse({ id: `th_cap${++spawned}`, parentThreadId: THREAD }),
    );
    // Not waiting keeps both workers in flight, which is what the cap counts.
    const delegate = (projectId: string, task: string) =>
      harness.behavior.callAgentTool(DELEGATE_TOOL, { task, waitForResult: false }, { threadId: THREAD, projectId });
    await delegate(PROJECT, "first");
    await delegate(PROJECT, "second");
    expect(spawned).toBe(2);

    await harness.behavior.runCli(["scope", "--project", PROJECT, "--max-parallel", "1"]);
    await expect(delegate(PROJECT, "third")).rejects.toThrow(/caps parallel workers at 1/);
    // The neighbouring project still runs on the global cap.
    await delegate(OTHER, "fourth");
    expect(spawned).toBe(3);
  });

  it("hands a session the contract its project resolves, and the global one to another project", async () => {
    const { harness } = await load();
    await enable(harness, THREAD);
    await harness.behavior.runCli([
      "scope", "--project", PROJECT, "--contract-preset", "review-heavy",
      "--rules", "Never touch files under generated/.",
    ]);
    const scoped = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        project: { id: PROJECT },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(scoped.instructions).toContain("Every unit gets checked before you trust it");
    expect(scoped.instructions).toContain("Never touch files under generated/.");

    const other = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: THREAD },
        project: { id: OTHER },
        pluginMetadata: writeMirror({ enabled: true, enforcement: null }),
      }),
    );
    expect(other.instructions).not.toContain("Never touch files under generated/.");
    expect(other.instructions).not.toContain("Every unit gets checked before you trust it");
  });

  it("lists project overrides and clears them on request", async () => {
    const { harness } = await load();
    await harness.behavior.runCli(["scope", "--project", PROJECT, "--max-nudges", "9", "--rules", "Prefer the repo skill copies."]);
    const listed = await harness.behavior.runCli(["scope"]);
    expect(listed.stdout).toContain(PROJECT);
    expect(listed.stdout).toContain("settings: maxNudges");

    const cleared = await harness.behavior.runCli(["scope", "--project", PROJECT, "--inherit-all"]);
    expect(cleared.stdout).toContain("none (inherits the globals)");
    expect(cleared.stdout).toContain("inherits the global rules");
    const empty = await harness.behavior.runCli(["scope"]);
    expect(empty.stdout).toContain("no project overrides");
  });

  it("writes the global record from the scope command, and refuses project-only flags there", async () => {
    const { harness } = await load({ enforcement: "instruct" });
    await enable(harness, THREAD);
    harness.inspection.sdk.stub("threads.get", async () => threadIn(PROJECT));

    const written = await harness.behavior.runCli([
      "scope", "--global", "--read-commands", "off", "--max-parallel", "3",
    ]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("global: what every project inherits");
    expect(written.stdout).toContain("enforcement:          instruct");
    expect(written.stdout).toContain("read commands:        all commands are work");
    expect(written.stdout).toContain("fan-out cap:          3 in flight, 20 per turn");

    // A project that overrides nothing now reads what the record was set to.
    const state = (await harness.behavior.callRpc("get_state", { threadId: THREAD })) as OrchestratorStateDto;
    expect(state.allowReadCommands).toBe(false);
    expect(state.maxParallelWorkers).toBe(3);

    // The global worker execution and rules have their own commands; naming one
    // here would write a second copy of the same value.
    const refused = await harness.behavior.runCli(["scope", "--global", "--rules", "Prefer the repo skill copies."]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("orchestrator-mode contract");
    const both = await harness.behavior.runCli(["scope", "--global", "--project", PROJECT, "--max-parallel", "1"]);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("--global");
  });

});
