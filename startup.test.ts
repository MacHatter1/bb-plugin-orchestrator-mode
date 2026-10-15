import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin, { DELEGATE_TOOL } from "./server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
type SdkCatalog = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>;
// Only the response fields consumed here; the fake SDK accepts partial DTOs.
type CatalogResponse = Pick<SdkCatalog, "models"> & Partial<Pick<SdkCatalog, "modelLoadError">> & {
  providers: Pick<SdkCatalog["providers"][number], "id" | "available" | "displayName">[];
};
const providers = {
  providers: ["alpha", "beta"].map((id) => ({ id, displayName: id, available: true })), models: [],
};
function models(providerId: string): CatalogResponse {
  return { providers: [], models: [{
    id: `${providerId}-model`, displayName: providerId, model: `${providerId}-model`, description: "", isDefault: false,
    supportedReasoningEfforts: [], defaultReasoningEffort: "medium",
  }] };
}
const pin = { providerId: "alpha", model: "alpha-model" };
const mismatched = { providerId: "alpha", model: "beta-model" };
const config = { ...mismatched, fallback: pin, presets: { build: mismatched, review: { model: "retired" } } };

function fixture(discover: (args?: { providerId?: string }) => Promise<CatalogResponse>) {
  return createFakePluginHost({
    pluginId: "orchestrator-mode",
    sdk: {
      providers: { models: discover },
      threads: {
        queue: { list: async () => [] },
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "project", environmentId: "env" }),
        getPluginMetadata: async () => ({}), updatePluginMetadata: async () => ({}),
        timeline: async () => ({ rows: [], maxSeq: 0 }),
        spawn: async () => makeThreadResponse({ id: "worker" }),
      },
    },
  });
}
const getWorker = (host: ReturnType<typeof fixture>) => host.harness.behavior.callRpc("get_worker_execution", null);
const getProject = (host: ReturnType<typeof fixture>) => host.harness.behavior.callRpc("get_project_worker", { projectId: "project" });

describe("startup readiness", () => {
  it("registers and finishes the factory while provider readiness and queue recovery are unresolved", async () => {
    const ready = deferred<void>();
    const host = createFakePluginHost({
      pluginId: "orchestrator-mode",
      sdk: {
        providers: { models: async () => { await ready.promise; return { providers: [], models: [] }; } },
        threads: { queue: { list: async () => { await ready.promise; return []; } } },
      },
    });
    let registered = false;
    const loading = plugin(host.bb).then(() => { registered = true; });
    const services: Promise<void>[] = [];
    try {
      await turn();
      expect(registered, "factory must not wait for the startup pass that is waiting for it").toBe(true);
      expect(host.harness.registrations.agentTools.some((tool) => tool.name === DELEGATE_TOOL)).toBe(true);
      expect(host.harness.registrations.rpcMethods).toContain("get_worker_execution");
      expect(host.harness.inspection.sdk.calls).toEqual([]);
      services.push(host.harness.behavior.runService("worker-catalog").done);
      services.push(host.harness.behavior.runService("queue-recovery").done);
      await turn();
      expect(host.harness.inspection.sdk.callsTo("providers.models")).toHaveLength(1);
      expect(host.harness.inspection.sdk.callsTo("threads.queue.list")).toHaveLength(1);
      expect(await host.harness.behavior.callRpc("get_default", null)).toEqual({ enabled: false });
    } finally {
      ready.resolve();
      await loading;
      await Promise.all(services);
      await host.harness.lifecycle.dispose();
    }
  });

  it("keeps saved global/project choices pending, then reconciles every level after discovery", async () => {
    const ready = deferred<CatalogResponse>();
    const host = fixture(async (args) => args?.providerId ? models(args.providerId) : ready.promise);
    try {
      await host.bb.storage.kv.set("worker", config);
      await host.bb.storage.kv.set("project_worker", { project: config });
      await plugin(host.bb);
      const service = host.harness.behavior.runService("worker-catalog");
      expect(await getWorker(host)).toEqual(config);
      expect(await getProject(host)).toEqual(config);
      const cli = await host.harness.behavior.runCli(["worker", "--json"]);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual(config);
      ready.resolve(providers);
      await service.done;
      const reconciled = { ...mismatched, providerId: "beta", fallback: pin, presets: { build: { ...mismatched, providerId: "beta" } } };
      expect(await getWorker(host)).toEqual(reconciled);
      expect(await getProject(host)).toEqual(reconciled);
      // Discovery updates effective choices without destroying durable settings.
      expect(await host.bb.storage.kv.get("worker")).toEqual(config);
      expect(await host.bb.storage.kv.get("project_worker")).toEqual({ project: config });
      await host.harness.behavior.callRpc("set_enabled", { threadId: "parent", enabled: true });
      await host.harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Probe", preset: "build", waitForResult: false }, { threadId: "parent", projectId: "project" });
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({ providerId: "beta", model: "beta-model" });
    } finally {
      ready.resolve(providers);
      await host.harness.lifecycle.dispose();
    }
  });

  it("reconciles the latest settings and CLI edits made while discovery was pending", async () => {
    const ready = deferred<CatalogResponse>();
    const host = fixture(async (args) => args?.providerId ? models(args.providerId) : ready.promise);
    try {
      await plugin(host.bb);
      const service = host.harness.behavior.runService("worker-catalog");
      await host.harness.behavior.callRpc("set_worker_execution", { ...pin, fallback: mismatched });
      const cli = await host.harness.behavior.runCli(["worker", "--preset", "build", "--model", "beta-model"]);
      expect(cli.exitCode).toBe(0);
      await host.harness.behavior.callRpc("set_project_worker", { projectId: "project", config: mismatched });
      ready.resolve(providers);
      await service.done;
      expect(await getWorker(host)).toEqual({ ...pin, fallback: { ...mismatched, providerId: "beta" }, presets: { build: { providerId: "beta", model: "beta-model" } } });
      expect(await getProject(host)).toMatchObject({ providerId: "beta", model: "beta-model" });
      for (const config of [
        { providerId: "gone", model: "alpha-model" },
        { ...pin, fallback: { providerId: "alpha", model: "gone" } },
        { ...pin, presets: { build: { model: "gone" } } },
      ]) {
        await expect(host.harness.behavior.callRpc("set_worker_execution", config)).rejects.toThrow(/Unknown worker/);
        await expect(host.harness.behavior.callRpc("set_project_worker", { projectId: "project", config })).rejects.toThrow(/Unknown worker/);
      }
      expect((await host.harness.behavior.runCli(["worker", "--model", "gone"])).exitCode).not.toBe(0);
      await host.harness.behavior.callRpc("set_enabled", { threadId: "parent", enabled: true });
      await expect(host.harness.behavior.callAgentTool(DELEGATE_TOOL, { task: "Probe", model: "gone", waitForResult: false }, { threadId: "parent", projectId: "project" })).rejects.toThrow(/Unknown worker model/);
      expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
    } finally {
      ready.resolve(providers);
      await host.harness.lifecycle.dispose();
    }
  });

  it("preserves model-only saved fallback and preset choices until their provider can be inferred", async () => {
    const ready = deferred<CatalogResponse>();
    const host = fixture(async (args) => args?.providerId ? models(args.providerId) : ready.promise);
    const saved = { model: "beta-model", fallback: { model: "alpha-model" }, presets: { build: { model: "beta-model" } } };
    try {
      await host.bb.storage.kv.set("worker", saved);
      await host.bb.storage.kv.set("project_worker", { project: saved });
      await plugin(host.bb);
      expect(await getWorker(host)).toEqual(saved);
      expect(await getProject(host)).toEqual(saved);
      const service = host.harness.behavior.runService("worker-catalog");
      ready.resolve(providers);
      await service.done;
      const inferred = { ...saved, providerId: "beta", fallback: pin, presets: { build: { providerId: "beta", model: "beta-model" } } };
      expect(await getWorker(host)).toEqual(inferred);
      expect(await getProject(host)).toEqual(inferred);
    } finally { ready.resolve(providers); await host.harness.lifecycle.dispose(); }
  });

  it.each(["system", "provider", "returned error"])("preserves choices on %s discovery failure and retries without failing activation", async (failure) => {
    vi.useFakeTimers();
    let failing = true;
    const host = fixture(async (args) => {
      if (failing && failure === "returned error" && args?.providerId === "beta") {
        return { providers: [], models: [], modelLoadError: { code: "timeout", providerId: "beta", detail: "offline" } };
      }
      if (failing && (failure === "system" || args?.providerId === "beta")) throw new Error("offline");
      return args?.providerId ? models(args.providerId) : providers;
    });
    try {
      await host.bb.storage.kv.set("worker", config);
      await host.bb.storage.kv.set("project_worker", { project: config });
      await plugin(host.bb);
      const service = host.harness.behavior.runService("worker-catalog");
      await flush();
      expect(host.harness.logEntries.some((entry) => entry.message.includes("preserving saved choices and retrying"))).toBe(true);
      expect(await getWorker(host)).toEqual(config);
      expect(await getProject(host)).toEqual(config);
      expect(vi.getTimerCount()).toBe(1);
      failing = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await service.done;
      expect(await getWorker(host)).toMatchObject({ providerId: "beta", model: "beta-model" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await host.harness.lifecycle.dispose();
      vi.useRealTimers();
    }
  });

  it("distinguishes a successful empty catalog from unavailable discovery", async () => {
    const host = fixture(async () => ({ providers: [], models: [] }));
    try {
      await host.bb.storage.kv.set("worker", config);
      await plugin(host.bb);
      expect(await getWorker(host)).toEqual(config);
      await host.harness.behavior.runService("worker-catalog").done;
      expect(await getWorker(host)).toEqual({});
      await expect(host.harness.behavior.callRpc("set_worker_execution", pin)).rejects.toThrow(/Unknown worker provider/);
    } finally { await host.harness.lifecycle.dispose(); }
  });

  it.each(["resolve", "reject"])("disposes promptly during discovery and safely consumes a late %s", async (outcome) => {
    const ready = deferred<CatalogResponse>();
    const host = fixture(async () => ready.promise);
    await plugin(host.bb);
    const service = host.harness.behavior.runService("worker-catalog");
    await turn();
    await host.harness.lifecycle.dispose();
    await service.done;
    const calls = host.harness.inspection.sdk.calls.length;
    const logs = host.harness.logEntries.length;
    const signals = host.harness.realtimeSignals.length;
    if (outcome === "resolve") ready.resolve(providers); else ready.reject(new Error("late failure"));
    await turn();
    expect(host.harness.inspection.sdk.calls).toHaveLength(calls);
    expect(host.harness.logEntries).toHaveLength(logs);
    expect(host.harness.realtimeSignals).toHaveLength(signals);
  });

  it("does not publish a late per-provider result over a replacement generation", async () => {
    const ready = deferred<CatalogResponse>();
    let old = true;
    const host = fixture(async (args) => {
      if (!args?.providerId) return providers;
      if (old) return ready.promise;
      return models(args.providerId);
    });
    await host.bb.storage.kv.set("worker", config);
    await plugin(host.bb);
    const service = host.harness.behavior.runService("worker-catalog");
    await turn();
    old = false;
    const replacement = await host.harness.lifecycle.reload(plugin);
    try {
      await service.done;
      await replacement.harness.behavior.runService("worker-catalog").done;
      const oldSignals = host.harness.realtimeSignals.length;
      const oldCalls = host.harness.inspection.sdk.calls.length;
      ready.resolve(models("alpha"));
      await turn();
      expect(host.harness.realtimeSignals).toHaveLength(oldSignals);
      expect(host.harness.inspection.sdk.calls).toHaveLength(oldCalls);
      expect(await getWorker(replacement)).toMatchObject({ providerId: "beta", model: "beta-model" });
      expect(host.harness.logEntries.some((entry) => entry.message.includes("PluginContextStaleError"))).toBe(false);
    } finally { await replacement.harness.lifecycle.dispose(); }
  });

  it("cancels a catalog retry timer on disposal", async () => {
    vi.useFakeTimers();
    const host = fixture(async () => { throw new Error("offline"); });
    try {
      await plugin(host.bb);
      const service = host.harness.behavior.runService("worker-catalog");
      await flush();
      expect(vi.getTimerCount()).toBe(1);
      await host.harness.lifecycle.dispose();
      await service.done;
      expect(vi.getTimerCount()).toBe(0);
      const calls = host.harness.inspection.sdk.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(host.harness.inspection.sdk.calls).toHaveLength(calls);
    } finally { await host.harness.lifecycle.dispose(); vi.useRealTimers(); }
  });

  it.each([1])("stops queue recovery at pending read %s without stale SDK access", async (heldRead) => {
    const ready = deferred<ReturnType<typeof makeQueueEntry>[]>();
    const host = fixture(async () => ({ providers: [], models: [] }));
    let reads = 0;
    host.harness.inspection.sdk.stub("threads.queue.list", async () => ++reads === heldRead ? ready.promise : []);
    await plugin(host.bb);
    const service = host.harness.behavior.runService("queue-recovery");
    await turn();
    expect(reads).toBe(heldRead);
    await host.harness.lifecycle.dispose();
    await service.done;
    const calls = host.harness.inspection.sdk.calls.length;
    const logs = host.harness.logEntries.length;
    ready.resolve([makeQueueEntry({ initiator: "agent", senderThreadId: "child" })]);
    await turn();
    expect(host.harness.inspection.sdk.calls).toHaveLength(calls);
    expect(host.harness.logEntries).toHaveLength(logs);
  });
});
