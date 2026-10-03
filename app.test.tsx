// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./server";
import type { EnforcementLevel, Violation } from "./shared";

const app = await loadPluginApp(() => import("./app"));
const customization = app.composerCustomizations[0]!;
const Host = customization.banners![0]!.component;
const Toggle = customization.actions![0]!.component;

const THREAD = "th_1";

interface StateDto {
  enabled: boolean;
  enforcement: EnforcementLevel | null;
  effectiveEnforcement: EnforcementLevel;
  enabledAt: string | null;
  violations: Violation[];
  delegations: never[];
  nudgeCount: number;
  defaultForNewThreads: boolean;
  allowReadCommands: boolean;
  maxNudges: number;
}

function baseState(overrides: Partial<StateDto> = {}): StateDto {
  return {
    enabled: false,
    enforcement: null,
    effectiveEnforcement: "guard",
    enabledAt: null,
    violations: [],
    delegations: [],
    nudgeCount: 0,
    defaultForNewThreads: false,
    allowReadCommands: true,
    maxNudges: 3,
    ...overrides,
  };
}

/** An in-memory stand-in for the backend's RPC surface. */
function makeRpc(initial: Partial<StateDto> = {}) {
  const state = baseState(initial);
  let defaultEnabled = state.defaultForNewThreads;
  const calls: { method: string; input: unknown }[] = [];
  const handlers = {
    get_state: async () => {
      calls.push({ method: "get_state", input: null });
      return { ...state };
    },
    set_enabled: async (input: {
      threadId: string;
      enabled: boolean;
      enforcement?: EnforcementLevel | null;
    }) => {
      calls.push({ method: "set_enabled", input });
      state.enabled = input.enabled;
      state.enforcement = input.enforcement ?? null;
      state.effectiveEnforcement = input.enforcement ?? "guard";
      return { ...state };
    },
    get_default: async () => {
      calls.push({ method: "get_default", input: null });
      return { enabled: defaultEnabled };
    },
    set_default: async (input: { enabled: boolean }) => {
      calls.push({ method: "set_default", input });
      defaultEnabled = input.enabled;
      return { enabled: defaultEnabled };
    },
    clear_violations: async (input: { threadId: string }) => {
      calls.push({ method: "clear_violations", input });
      state.violations = [];
      return { ...state };
    },
  };
  return { handlers, calls, state, isDefaultEnabled: () => defaultEnabled };
}

type Rpc = ReturnType<typeof makeRpc>;

// renderSlot mounts into the shared document, so every query is scoped to the
// slot it came from; two surfaces of one composer are two slots.
const slots: RenderedSlot[] = [];

function mount(component: typeof Host, rpc: Rpc, options: Record<string, unknown>): RenderedSlot {
  const slot = renderSlot({ component }, {}, { rpc: rpc.handlers as never, ...options });
  slots.push(slot);
  return slot;
}

/** Let the components' effects and RPC promises settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
  await flush();
}

function threadOptions() {
  return {
    composer: { scope: { kind: "thread" as const, threadId: THREAD }, text: "do the thing" },
    context: { threadId: THREAD, projectId: "proj_1" },
  };
}

function composeOptions() {
  return {
    composer: { scope: { kind: "new-thread" as const, projectId: "proj_1" }, text: "" },
  };
}

function toggleButton(slot: RenderedSlot): HTMLElement {
  return within(slot.container).getByRole("button");
}

function plusMenuView(scope: unknown) {
  return {
    scope,
    layout: "compact" as const,
    draft: { text: "", isEmpty: true, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  };
}

afterEach(() => {
  for (const slot of slots.splice(0)) slot.lifecycle.unmount();
  cleanup();
});

describe("registration", () => {
  it("registers one composer customization for thread and new-thread scopes", () => {
    expect(app.composerCustomizations).toHaveLength(1);
    expect(customization.id).toBe("orchestrator-mode");
    expect(customization.scopes).toEqual(["thread", "new-thread"]);
    expect(customization.actions).toHaveLength(1);
    expect(customization.banners).toHaveLength(1);
    expect(customization.banners![0]!.chrome).toBe("bare");
    expect(customization.plusMenu).toHaveLength(1);
  });

  it("draws the manifest-declared glyph on every surface", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();
    expect(
      host.container.querySelectorAll('[data-icon="orchestrator-mode/hub"]'),
    ).toHaveLength(1);
    expect(
      toggle.container.querySelectorAll('[data-icon="orchestrator-mode/hub"]'),
    ).toHaveLength(1);
  });
});

describe("thread composer", () => {
  it("shows an off toggle and no strip while the mode is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    expect(within(host.container).queryByText(/Orchestrator mode is on/)).toBeNull();
    expect(host.container.textContent).toBe("");
    const button = toggleButton(toggle);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toContain("Turn orchestrator mode on");
    expect(host.inspection.composer.textEffect).toBeNull();
  });

  it("turns the mode on from the toggle and paints the draft", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    await click(toggleButton(toggle));

    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
    expect(toggleButton(toggle).getAttribute("aria-pressed")).toBe("true");
    expect(host.inspection.composer.textEffect).toEqual({ className: "orch-draft" });
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(within(host.container).getByText(/may only read, plan, ask/)).toBeTruthy();
  });

  it("turns the mode off from the strip and clears the draft effect", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toEqual({ className: "orch-draft" });

    await click(within(host.container).getByText("Turn off"));

    expect(within(host.container).queryByText(/Orchestrator mode is on/)).toBeNull();
    expect(rpc.state.enabled).toBe(false);
    expect(host.inspection.composer.textEffect).toBeNull();
  });

  it("reports the direct work the watchdog caught", async () => {
    const rpc = makeRpc({
      enabled: true,
      effectiveEnforcement: "block",
      violations: [
        {
          id: "row_1",
          turnId: "turn_1",
          workKind: "file-change",
          detail: "changed src/server.ts itself",
          detectedAt: Date.now(),
        },
      ],
    });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    const strip = within(host.container);

    expect(strip.getByText(/Direct work caught \(1 total\)/)).toBeTruthy();
    expect(strip.getByText(/changed src\/server.ts itself/)).toBeTruthy();
    expect(strip.getByText(/· block/)).toBeTruthy();
    expect(host.container.querySelector('[data-violations="true"]')).not.toBeNull();
  });

  it("refetches when the backend publishes a state change", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    await flush();
    const before = rpc.calls.filter((call) => call.method === "get_state").length;

    rpc.state.enabled = true;
    await act(async () => {
      await host.behavior.emitRealtime("orchestrator-state", { at: Date.now() });
    });
    await flush();

    expect(rpc.calls.filter((call) => call.method === "get_state").length).toBeGreaterThan(before);
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
  });

  it("toggles through the plus-menu row the compact layout falls back to", async () => {
    const rpc = makeRpc();
    mount(Host, rpc, threadOptions());
    await flush();

    const item = customization.plusMenu![0]!;
    expect(item.label).toBe("Orchestrator mode");
    const disabled = item.disabled as (view: unknown) => boolean;
    expect(disabled(plusMenuView({ kind: "thread", threadId: THREAD }))).toBe(false);

    await act(async () => {
      await item.run({ composer: {} as never, view: plusMenuView({ kind: "thread", threadId: THREAD }) as never });
    });
    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
  });

  it("disables the plus-menu row in a scope this plugin does not own", async () => {
    const rpc = makeRpc();
    mount(Host, rpc, threadOptions());
    await flush();
    const disabled = customization.plusMenu![0]!.disabled as (view: unknown) => boolean;
    expect(
      disabled(
        plusMenuView({
          kind: "side-chat",
          projectId: "p",
          parentThreadId: "t",
          tabId: "tab",
          childThreadId: null,
        }),
      ),
    ).toBe(true);
  });
});

describe("new-thread composer", () => {
  it("toggles the plugin-wide default instead of a thread", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    const toggle = mount(Toggle, rpc, composeOptions());
    await flush();

    expect(toggleButton(toggle).getAttribute("aria-label")).toContain("Start new threads");
    await click(toggleButton(toggle));

    expect(within(host.container).getByText(/New threads start as orchestrators/)).toBeTruthy();
    expect(rpc.calls.some((call) => call.method === "set_default")).toBe(true);
    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(false);
    expect(rpc.isDefaultEnabled()).toBe(true);
  });

  it("renders nothing in the root compose screen while the default is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    await flush();
    expect(host.container.textContent).toBe("");
  });
});
