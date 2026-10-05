import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENFORCEMENT,
  buildInstructions,
  buildNudge,
  classifyRow,
  defaultAppliesTo,
  isEnforcementLevel,
  isReadOnlyCommand,
  readMirror,
  writeMirror,
  type EnforcementLevel,
} from "./shared";

/** A minimal timeline work row, plus the id the classifier dedupes on. */
function row(
  overrides: Partial<Parameters<typeof classifyRow>[0]> & { id: string },
): Parameters<typeof classifyRow>[0] {
  return { kind: "work", turnId: "turn_1", ...overrides };
}

describe("enforcement levels", () => {
  it("accepts exactly the three documented levels", () => {
    expect(isEnforcementLevel("instruct")).toBe(true);
    expect(isEnforcementLevel("guard")).toBe(true);
    expect(isEnforcementLevel("block")).toBe(true);
    expect(isEnforcementLevel("strict")).toBe(false);
    expect(isEnforcementLevel(undefined)).toBe(false);
    expect(isEnforcementLevel(null)).toBe(false);
  });

  it("defaults to guard", () => {
    expect(DEFAULT_ENFORCEMENT).toBe("guard");
  });
});

describe("thread metadata mirror", () => {
  it("round-trips", () => {
    const written = writeMirror({ enabled: true, enforcement: "block" });
    expect(readMirror(written)).toEqual({
      enabled: true,
      enforcement: "block",
      source: "orchestrator-mode",
    });
  });

  it("ignores a namespace another writer owns", () => {
    expect(readMirror({})).toBeNull();
    expect(readMirror({ orchestrator: { enabled: true } })).toBeNull();
    expect(readMirror({ orchestrator: null })).toBeNull();
    expect(readMirror({ orchestrator: "on" })).toBeNull();
    expect(readMirror({ orchestrator: [] })).toBeNull();
  });

  it("drops an unparseable enforcement level rather than inventing one", () => {
    const mirror = readMirror({
      orchestrator: { enabled: true, enforcement: "aggressive", source: "orchestrator-mode" },
    });
    expect(mirror?.enforcement).toBeNull();
  });

  it("requires a boolean enabled flag", () => {
    expect(
      readMirror({ orchestrator: { enabled: "yes", source: "orchestrator-mode" } }),
    ).toBeNull();
  });
});

describe("new-thread default eligibility", () => {
  it("applies to a root thread", () => {
    expect(defaultAppliesTo({ parentThreadId: null })).toBe(true);
  });

  it("never applies to a worker this plugin spawned", () => {
    expect(defaultAppliesTo({ parentThreadId: "th_parent" })).toBe(false);
  });

  it("never applies to a side chat", () => {
    expect(defaultAppliesTo({ parentThreadId: null, originPluginId: "side-chat" })).toBe(false);
  });
});

describe("read-only command detection", () => {
  const readOnly = [
    "ls -la",
    "cat package.json",
    "rg TODO src/",
    "git status",
    "git diff --stat",
    "git log --oneline -20",
    "find . -name '*.ts'",
    "wc -l src/*.ts",
    "pwd",
    "jq '.name' package.json",
    "grep -rn foo | head -20",
    "ls && cat README.md",
    "FOO=bar ls",
    "/usr/bin/git show HEAD",
    "git config --get user.email",
    "git branch",
    "git branch -avv",
    "git branch --list feature-*",
    "git tag",
    "git tag --list v*",
    "git tag -l v*",
    "git remote -v",
    "git remote show origin",
    "git remote get-url origin",
    "git reflog show HEAD",
    "bb status",
    "bb provider list --environment env_bucd4j3r9b --json",
    "bb provider models codex --environment env_bucd4j3r9b --json",
    "bb provider models --json",
    "bb status --json; bb provider models codex --environment env_bucd4j3r9b --json",
    "bb guide",
    "bb --version",
    "bb --help",
    "bb plugin new --help",
    "bb orchestrator-mode --help",
    "bb skill list --json",
    "bb thread list",
    "bb plugin list",
    // The exact orientation line a real orchestrator-mode thread was punished
    // for: every segment of it only reads.
    "pwd; ls -la; bb status --json; bb --version; bb plugin new --help",
    "diff a.txt b.txt",
  ];
  for (const command of readOnly) {
    it(`allows \`${command}\``, () => {
      expect(isReadOnlyCommand(command)).toBe(true);
    });
  }

  const mutating = [
    "rm -rf build",
    "npm install",
    "git commit -m x",
    "git push",
    "echo hi > out.txt",
    "cat a >> b",
    "ls | tee out.txt",
    "make",
    "pytest",
    "git config user.email me@example.com",
    "ls $(rm -rf /)",
    "cat `whoami`",
    "ls; rm x",
    "git checkout -b feature",
    "git branch review-temp",
    "git branch -D review-temp",
    "git branch --list --delete review-temp",
    "git tag review-temp",
    "git tag -d review-temp",
    "git tag --list --delete review-temp",
    "git remote remove origin",
    "git remote set-url origin https://example.com/repo.git",
    "git reflog expire --expire=now --all",
    "git reflog delete HEAD@{0}",
    "bb thread spawn --prompt hi",
    "bb plugin reload x",
    "bb plugin install x",
    "bb provider enable codex",
    "bb provider disable codex",
    "bb status --json; bb provider disable codex",
    "bb provider models codex --json; npm test",
    "bb provider models codex --json > models.json",
    "bb skills install foo",
    "bb orchestrator-mode off",
    "unknown-tool --flag",
    // From a real orchestrator-mode thread: piping bb output into python3 -c
    // is arbitrary code, however read-only the left side of the pipe looks.
    "bb skill list --json | python3 -c 'import json,sys; print(json.load(sys.stdin))'",
  ];
  for (const command of mutating) {
    it(`refuses \`${command}\``, () => {
      expect(isReadOnlyCommand(command)).toBe(false);
    });
  }
});

describe("direct-work classification", () => {
  it("flags a file change", () => {
    const violation = classifyRow(
      row({ id: "r1", workKind: "file-change", change: { path: "src/app.ts" } }),
    );
    expect(violation?.detail).toContain("src/app.ts");
    expect(violation?.turnId).toBe("turn_1");
  });

  it("flags a mutating command", () => {
    expect(classifyRow(row({ id: "r2", workKind: "command", command: "npm test" }))).not.toBeNull();
  });

  it("allows a read-only command by default", () => {
    expect(classifyRow(row({ id: "r3", workKind: "command", command: "git status" }))).toBeNull();
  });

  it("flags Git commands that mutate branches, tags or remotes", () => {
    for (const command of ["git branch review-temp", "git tag review-temp", "git remote remove origin"]) {
      expect(classifyRow(row({ id: command, workKind: "command", command }))).not.toBeNull();
    }
  });

  it("flags image generation while allowing image inspection", () => {
    expect(classifyRow(row({ id: "generated", workKind: "image-generation" }))).toMatchObject({
      workKind: "image-generation",
    });
    expect(classifyRow(row({ id: "viewed", workKind: "image-view" }))).toBeNull();
  });

  it("flags a read-only command when the setting is off", () => {
    expect(
      classifyRow(row({ id: "r4", workKind: "command", command: "git status" }), {
        allowReadCommands: false,
      }),
    ).not.toBeNull();
  });

  it("flags a generic tool whose name mutates, and allows one that only reads", () => {
    expect(classifyRow(row({ id: "r5", workKind: "tool", toolName: "str_replace_editor" }))).not.toBeNull();
    expect(classifyRow(row({ id: "r6", workKind: "tool", toolName: "view_file" }))).toBeNull();
    expect(classifyRow(row({ id: "r7", workKind: "tool", toolName: null }))).toBeNull();
  });

  it("allows delegation, questions, planning and research", () => {
    for (const workKind of [
      "delegation",
      "workflow",
      "question",
      "form",
      "approval",
      "plan-steps",
      "file-read",
      "search",
      "web-search",
      "web-fetch",
    ]) {
      expect(classifyRow(row({ id: `ok-${workKind}`, workKind }))).toBeNull();
    }
  });

  it("ignores rows that are not work", () => {
    expect(classifyRow({ id: "c1", kind: "conversation" })).toBeNull();
    expect(classifyRow({ id: "t1", kind: "turn" })).toBeNull();
  });

  it("truncates a long command in the detail", () => {
    const violation = classifyRow(
      row({ id: "r8", workKind: "command", command: `npm run ${"x".repeat(200)}` }),
    );
    expect(violation!.detail.length).toBeLessThan(120);
  });
});

describe("the contract", () => {
  const levels: EnforcementLevel[] = ["instruct", "guard", "block"];

  it("fits the 4096-character configure() budget in every mode", () => {
    for (const enforcement of levels) {
      for (const allowReadCommands of [true, false]) {
        const text = buildInstructions({
          enforcement,
          allowReadCommands,
          reminders: Array.from({ length: 5 }, (_, index) => `ran \`${"npm test " + index}\``),
        });
        expect(text.length).toBeLessThanOrEqual(4096);
      }
    }
  });

  it("names the delegation tool and forbids editing files", () => {
    const text = buildInstructions({ enforcement: "guard", allowReadCommands: true });
    expect(text).toContain("orchestrator_delegate");
    expect(text).toContain("ORCHESTRATOR MODE IS ON");
    expect(text.toLowerCase()).toContain("editing");
  });

  it("only warns about the watchdog when one is running", () => {
    expect(buildInstructions({ enforcement: "instruct", allowReadCommands: true })).toContain(
      "nothing is watching",
    );
    expect(buildInstructions({ enforcement: "guard", allowReadCommands: true })).toContain(
      "watchdog",
    );
    expect(buildInstructions({ enforcement: "block", allowReadCommands: true })).toContain(
      "STOPS the turn",
    );
  });

  it("lists prior violations when there are any", () => {
    const text = buildInstructions({
      enforcement: "guard",
      allowReadCommands: true,
      reminders: ["changed src/app.ts itself"],
    });
    expect(text).toContain("changed src/app.ts itself");
  });

  it("builds a nudge that re-delegates instead of continuing", () => {
    const nudge = buildNudge(
      [{ id: "r1", turnId: "t", workKind: "file-change", detail: "changed a.ts itself", detectedAt: 0 }],
      "block",
    );
    expect(nudge).toContain("changed a.ts itself");
    expect(nudge).toContain("orchestrator_delegate");
    expect(nudge).toContain("stopped");
  });

  it("gives sessions without the native tool a CLI delegation route", () => {
    const nudge = buildNudge(
      [{ id: "r1", turnId: "t", workKind: "command", detail: "ran `x`", detectedAt: 0 }],
      "guard",
    );
    expect(nudge).toContain("bb orchestrator-mode delegate");
    expect(buildInstructions({ enforcement: "guard", allowReadCommands: true })).toContain(
      "bb orchestrator-mode delegate",
    );
  });

  it("allows CLI delegation even when read-only exploration is disabled", () => {
    for (const command of [
      "bb orchestrator-mode delegate --task 'Implement retries; add tests > 3 cases'",
      'bb orchestrator-mode delegate --task "Implement retries" --no-wait',
      "bb orchestrator-mode delegate --task 'Use `npm test` and $(example) as literal text'",
    ]) {
      expect(classifyRow(row({ id: command, workKind: "command", command }), {
        allowReadCommands: false,
      })).toBeNull();
    }
    for (const command of [
      "bb orchestrator-mode delegate --task x; npm test",
      "bb orchestrator-mode delegate --task x > output.txt",
      'bb orchestrator-mode delegate --task "$(npm test)"',
      "bb orchestrator-mode delegate --task `npm test`",
      "bb orchestrator-mode delegate --task x & npm test",
      "bb orchestrator-mode delegate --task 'unterminated",
      "bb orchestrator-mode delegate --task $'unsupported quoting'",
    ]) {
      expect(classifyRow(row({ id: command, workKind: "command", command }))).not.toBeNull();
    }
    const chain = "bb status --json; bb orchestrator-mode delegate --task 'Implement retries'";
    expect(classifyRow(row({ id: "chain", workKind: "command", command: chain }))).toBeNull();
    expect(classifyRow(row({ id: "chain", workKind: "command", command: chain }), {
      allowReadCommands: false,
    })).not.toBeNull();
  });
});
