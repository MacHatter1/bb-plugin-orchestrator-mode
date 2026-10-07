// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { EnforcementLevel, Violation, WorkerConfig } from "./shared";

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
  it("leaves an enabled thread's editable draft undecorated", async () => {
    const rpc = makeRpc({ enabled: true });
    const options = threadOptions();
    options.composer.text = "First line\nSecond line";
    const host = mount(Host, rpc, options);
    await flush();

    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe(options.composer.text);
  });

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

  it("turns the mode on from the toggle without decorating the draft", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, threadOptions());
    const toggle = mount(Toggle, rpc, threadOptions());
    await flush();

    await click(toggleButton(toggle));

    expect(rpc.calls.some((call) => call.method === "set_enabled")).toBe(true);
    expect(toggleButton(toggle).getAttribute("aria-pressed")).toBe("true");
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("do the thing");
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(within(host.container).getByText(/may only read, plan, ask/)).toBeTruthy();
  });

  it("turns the mode off from the strip without changing the draft", async () => {
    const rpc = makeRpc({ enabled: true });
    const host = mount(Host, rpc, threadOptions());
    await flush();
    expect(within(host.container).getByText(/Orchestrator mode is on/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();

    await click(within(host.container).getByText("Turn off"));

    expect(within(host.container).queryByText(/Orchestrator mode is on/)).toBeNull();
    expect(rpc.state.enabled).toBe(false);
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("do the thing");
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
  it("leaves the new-thread draft undecorated when the default is on", async () => {
    const rpc = makeRpc({ defaultForNewThreads: true });
    const options = composeOptions();
    options.composer.text = "Start a new task";
    const host = mount(Host, rpc, options);
    await flush();

    expect(within(host.container).getByText(/New threads start as orchestrators/)).toBeTruthy();
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe(options.composer.text);
  });

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
    expect(host.inspection.composer.textEffect).toBeNull();
    expect(host.inspection.composer.textEffectCalls).toEqual([]);
    expect(host.inspection.composer.text).toBe("");
  });

  it("renders nothing in the root compose screen while the default is off", async () => {
    const rpc = makeRpc();
    const host = mount(Host, rpc, composeOptions());
    await flush();
    expect(host.container.textContent).toBe("");
  });
});

describe("the settings section", () => {
  /** The section's own RPC surface: the settings of one scope, the worker configuration and the rules append. */
  function makeSettingsRpc(initial: WorkerConfig = {}) {
    let worker: WorkerConfig = initial;
    let extra = "";
    let newThreads = false;
    /** The global record the server would resolve every scope over. */
    const globals: Record<string, unknown> = {
      enforcement: "guard",
      allowReadCommands: true,
      maxNudges: 3,
      maxParallelWorkers: 8,
      maxDelegationsPerTurn: 20,
      contractPreset: "standard",
      workerRetention: "keep",
      workerWorkspace: "shared",
    };
    const projectWorker: Record<string, WorkerConfig> = {};
    const projectRules: Record<string, string> = {};
    const projectSettings: Record<string, Record<string, unknown>> = {};
    /** One scope's settings as the server returns them. */
    const scopeView = (projectId: string | null) => ({
      values: projectId === null ? globals : { ...globals, ...(projectSettings[projectId] ?? {}) },
      global: globals,
      overridden: projectId === null ? [] : Object.keys(projectSettings[projectId] ?? {}),
    });
    const calls: { method: string; input: unknown }[] = [];
    const handlers = {
      get_default: async () => {
        calls.push({ method: "get_default", input: null });
        return { enabled: newThreads };
      },
      set_default: async (input: { enabled: boolean }) => {
        calls.push({ method: "set_default", input });
        newThreads = input.enabled;
        return { enabled: newThreads };
      },
      get_worker_execution: async () => {
        calls.push({ method: "get_worker_execution", input: null });
        return worker;
      },
      set_worker_execution: async (next: WorkerConfig | null) => {
        calls.push({ method: "set_worker_execution", input: next });
        worker = next ?? {};
        return worker;
      },
      get_contract: async () => {
        calls.push({ method: "get_contract", input: { threadId: null } });
        return { text: "contract text", extra, limit: 370 };
      },
      set_contract: async (input: { extra: string }) => {
        calls.push({ method: "set_contract", input });
        extra = input.extra;
        return { text: "contract text", extra, limit: 370 };
      },
      get_project_worker: async (input: { projectId: string }) => {
        calls.push({ method: "get_project_worker", input });
        return projectWorker[input.projectId] ?? {};
      },
      set_project_worker: async (input: { projectId: string; config: WorkerConfig | null }) => {
        calls.push({ method: "set_project_worker", input });
        if (input.config === null) delete projectWorker[input.projectId];
        else projectWorker[input.projectId] = input.config;
        return projectWorker[input.projectId] ?? {};
      },
      get_project_rules: async (input: { projectId: string }) => {
        calls.push({ method: "get_project_rules", input });
        return { text: "contract text", extra: projectRules[input.projectId] ?? "", limit: 370 };
      },
      set_project_rules: async (input: { projectId: string; extra: string }) => {
        calls.push({ method: "set_project_rules", input });
        projectRules[input.projectId] = input.extra;
        return { text: "contract text", extra: input.extra, limit: 370 };
      },
      get_scope_settings: async (input: { projectId: string | null }) => {
        calls.push({ method: "get_scope_settings", input });
        return scopeView(input.projectId);
      },
      set_scope_setting: async (input: { projectId: string | null; key: string; value: unknown }) => {
        calls.push({ method: "set_scope_setting", input });
        if (input.projectId === null) {
          globals[input.key] = input.value;
        } else {
          const current = { ...(projectSettings[input.projectId] ?? {}) };
          if (input.value === null) delete current[input.key];
          else current[input.key] = input.value;
          projectSettings[input.projectId] = current;
        }
        return scopeView(input.projectId);
      },
    };
    return {
      handlers,
      calls,
      /** The inputs one method was called with, in order. */
      inputsOf: (method: string) => calls.filter((call) => call.method === method).map((call) => call.input),
      worker: () => worker,
    };
  }

  /** A catalog stand-in: one available provider, one default model. */
  const settingsSdk = {
    projects: {
      list: async () => [
        { id: "proj_alpha", name: "Alpha" },
        { id: "proj_beta", name: "Beta" },
      ],
    },
    providers: {
      models: async (input?: { providerId?: string }) =>
        input?.providerId === undefined
          ? { providers: [{ id: "command-code", name: "Command Code", available: true }], permissionCeiling: "accept-edits" }
          : { models: [{ id: "model-a", name: "Model A", isDefault: true, defaultReasoningEffort: "high" }] },
    },
  };

  const section = app.settingsSections[0]!;

  function mountSettings(rpc: ReturnType<typeof makeSettingsRpc>) {
    const slot = renderSlot({ component: section.component }, {}, {
      rpc: rpc.handlers as never,
      sdk: settingsSdk as never,
    });
    slots.push(slot);
    return slot;
  }

  const lastWrite = (rpc: ReturnType<typeof makeSettingsRpc>) =>
    [...rpc.calls].reverse().find((call) => call.method === "set_worker_execution")?.input as WorkerConfig | undefined;

  it("writes a seeded execution on Custom and clears it on Inherit", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "Custom" }));
    expect(lastWrite(rpc)).toMatchObject({ providerId: "command-code", model: "model-a", reasoningLevel: "high" });

    await click(within(slot.container).getByRole("button", { name: "Inherit" }));
    expect(lastWrite(rpc)).toEqual({});
  });

  it("sets a retry target on Retry and drops it on Report", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a" });
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "Retry" }));
    expect(lastWrite(rpc)).toMatchObject({ fallback: { providerId: "command-code", model: "model-a" } });

    await click(within(slot.container).getByRole("button", { name: "Report" }));
    expect(lastWrite(rpc)).toEqual({ providerId: "command-code", model: "model-a" });
  });

  it("shows a partial preset as repairable instead of Unsupported", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a", presets: { research: { reasoningLevel: "high" } } });
    const slot = mountSettings(rpc);
    await flush();

    // Scoped to the Research row: the provider pickers elsewhere on the page render the
    // SDK's own "Unsupported" for a model their catalog does not list, which is not this.
    const researchRow = within(slot.container).getByText("Research").closest("div")!;
    expect(researchRow.textContent).not.toContain("Unsupported");
    expect(researchRow.textContent).toContain("Saved without a provider and model");

    // The Set button repairs it into a complete preset, which is what fills the row.
    const setButtons = within(slot.container).getAllByRole("button", { name: "Set" });
    await click(setButtons[2]!);
    expect(lastWrite(rpc)).toMatchObject({ presets: { research: { providerId: "command-code", model: "model-a" } } });
  });

  it("writes the project rules through", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    const textarea = within(slot.container).getByRole("textbox");
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Never touch files under generated/." } });
    });
    await click(within(slot.container).getByRole("button", { name: "Save rules" }));
    expect(rpc.calls.filter((call) => call.method === "set_contract").at(-1)?.input).toEqual({
      extra: "Never touch files under generated/.",
    });
  });
  it("writes the global record from the rows while Global is selected", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    // Global scope offers no Inherit: the record has nothing above it to fall back to.
    const enforcement = within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement;
    expect(Array.from(enforcement.options, (option) => option.textContent)).toEqual([
      "instruct",
      "guard",
      "block",
    ]);
    await act(async () => {
      fireEvent.change(enforcement, { target: { value: "block" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "enforcement",
      value: "block",
    });
    expect((within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement).value).toBe("block");

    // The contract level is one row with three levels, and writes its own key.
    const shape = within(slot.container).getByLabelText("What the orchestrator is told") as HTMLSelectElement;
    expect(Array.from(shape.options, (option) => option.textContent)).toEqual([
      "standard",
      "review-heavy",
      "delegate-only",
    ]);
    await act(async () => {
      fireEvent.change(shape, { target: { value: "delegate-only" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: null,
      key: "contractPreset",
      value: "delegate-only",
    });
  });

  it("keeps the new-thread default global, and out of a project's scope", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    await click(within(slot.container).getByRole("button", { name: "On" }));
    expect(rpc.calls.filter((call) => call.method === "set_default").at(-1)?.input).toEqual({ enabled: true });

    // A project has no such setting: it is a composer default, not thread behaviour.
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_alpha" } });
    });
    await flush();
    expect(within(slot.container).queryByText("Start new threads as orchestrators")).toBeNull();
  });

  it("scopes the section to a project, and writes the override there", async () => {
    const rpc = makeSettingsRpc();
    const slot = mountSettings(rpc);
    await flush();

    // Global by default: the project RPCs are untouched.
    expect(rpc.calls.some((call) => call.method === "get_project_worker")).toBe(false);
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    expect(Array.from(selector.options, (option) => option.textContent)).toEqual(["Global", "Alpha", "Beta"]);

    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_alpha" } });
    });
    await flush();
    expect(rpc.inputsOf("get_project_worker")).toContainEqual({ projectId: "proj_alpha" });

    // A settings row writes one field for the project, and Inherit clears it again.
    const enforcement = within(slot.container).getByLabelText("Enforcement") as HTMLSelectElement;
    expect(Array.from(enforcement.options, (option) => option.textContent)).toEqual([
      "Inherit (guard)",
      "instruct",
      "block",
    ]);
    await act(async () => {
      fireEvent.change(enforcement, { target: { value: "block" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: "proj_alpha",
      key: "enforcement",
      value: "block",
    });

    // The select's first option is the inherit affordance for an enum row.
    await act(async () => {
      fireEvent.change(within(slot.container).getByLabelText("Enforcement"), { target: { value: "" } });
    });
    await flush();
    expect(rpc.calls.filter((call) => call.method === "set_scope_setting").at(-1)?.input).toEqual({
      projectId: "proj_alpha",
      key: "enforcement",
      value: null,
    });
  });

  it("clears a project's worker execution when Inherit is pressed in project scope", async () => {
    const rpc = makeSettingsRpc({ providerId: "command-code", model: "model-a" });
    const slot = mountSettings(rpc);
    await flush();
    const selector = within(slot.container).getByLabelText("Scope") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(selector, { target: { value: "proj_beta" } });
    });
    await flush();

    // Custom stores a project execution; Inherit then hands it back to the global one.
    await click(within(slot.container).getByRole("button", { name: "Custom" }));
    expect(rpc.calls.filter((call) => call.method === "set_project_worker").at(-1)?.input).toMatchObject({
      projectId: "proj_beta",
    });
    await click(within(slot.container).getByRole("button", { name: "Inherit" }));
    expect(rpc.calls.filter((call) => call.method === "set_project_worker").at(-1)?.input).toEqual({
      projectId: "proj_beta",
      config: null,
    });
  });
});
