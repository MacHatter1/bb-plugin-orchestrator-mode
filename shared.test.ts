import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENFORCEMENT,
  EXTRA_INSTRUCTION_LIMIT,
  INSTRUCTION_LIMIT,
  CONTRACT_PRESETS,
  buildInstructions,
  buildNudge,
  classifyRow,
  defaultAppliesTo,
  isEnforcementLevel,
  isReadOnlyCommand,
  readMirror,
  writeMirror,
  type ContractPresetId,
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
    "find benchmarks -maxdepth 2 -type f 2>/dev/null",
    "find benchmarks 2>/dev/null",
    "find benchmarks 2> /dev/null",
    "2>/dev/null find benchmarks",
    "find benchmarks 2>/dev/null;find research/sqlite 2>/dev/null",
    "find benchmarks 2>/dev/null && ls research",
    "find benchmarks 2>/dev/null | head -20",
    "find benchmarks -name '-delete' 2>/dev/null",
    "find benchmarks -name 'file -delete' 2>/dev/null",
    "find benchmarks -printf '-delete' 2>/dev/null",
    "rg '2>/dev/null' src 2>/dev/null",
    "find . -name '--delete' 2>/dev/null",
    "find . -regex '.*-exec.*' 2>/dev/null",
    "find benchmarks -maxdepth 2 -type f 2>/dev/null; find research/sqlite -maxdepth 2 -type f 2>/dev/null",
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
    // Quoted metacharacters are arguments, not syntax: `rg "a|b"` is one read-only command.
    'rg "foo|bar" src',
    "grep 'a;b' file.txt",
    'rg "x && y" -l',
    "echo 'a > b'",
    // `&` only ends a command when it is not part of a redirect or a dup:
    // `>&`, `&>`, `2>&1` and `2>&-` are redirections, not separators.
    "ls 2>&1",
    "ls >&2",
    "ls 2>&-",
    "git log >&2",
    "ls &",
    // The controls: pipes and quoted alternation still split/read correctly.
    "cat f | wc -l",
    'rg "a|b" src/',
    // `--output-indicator-*` is a display flag, not the `--output=<file>` write.
    "git diff --output-indicator-new='+'",
    "git log --output-indicator-old='-'",
    // Git global options sit between `git` and the subcommand.
    "git -C repo status",
    "git --no-pager log -1",
    "git diff --stat",
    "find . -name '*.ts'",
    "fd --extension ts",
    "env",
    "env FOO=1",
    "date",
    "date +%s",
    "hostname",
    "hostname -s",
    "git config --get user.email",
    // The whole `--get*` query family reads, not only `--get`.
    "git config --get-all user.name",
    "git config --get-regexp ^user",
    "git config --get-color color.diff auto",
    "git config --get-colorbool color.diff",
    "git config --get-urlmatch user.name https://example.com",
    // A heredoc body is data, not commands: the body's lines must not read as
    // unknown programs, and the `<<` must not read as a writing redirect.
    "cat <<EOF\nbody\nEOF",
    "cat <<'EOF'\nbody\nEOF",
    "cat <<-EOF\n\tbody\n\tEOF",
    'echo "a << b"',
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
    "find benchmarks 2> errors.log",
    "find benchmarks 2>> errors.log",
    "find benchmarks 2>/dev/null > files.txt",
    "find benchmarks > /dev/null 2> errors.log",
    "find benchmarks 2>/dev/null-output",
    "find benchmarks 2>/dev/null/../out.txt",
    "find benchmarks 2>/dev/null*",
    "find benchmarks 2>/dev/null\"-output\"",
    "find benchmarks 2>/dev/null$OUTPUT_SUFFIX",
    "find benchmarks 2>/dev/null; rm file.txt",
    "find benchmarks 2>/dev/null && npm test",
    "find benchmarks 2>/dev/null & rm file.txt",
    "find benchmarks 2>/dev/null&rm file.txt",
    "ls 1>&2>/dev/null",
    "ls name\\;2>/dev/null",
    "ls name\\ 2>/dev/null",
    "ls '2'>/dev/null",
    "ls 2>/dev/null > output.txt",
    "git -C repo -c core.fsmonitor=/tmp/worker-hook.sh status 2>/dev/null",
    "rg --pre=cat pattern 2>/dev/null",
    "find . --delete 2>/dev/null",
    "find benchmarks -delete 2>/dev/null",
    "find benchmarks '-delete' 2>/dev/null",
    "find benchmarks -de'le'te 2>/dev/null",
    "find benchmarks -dele\\te 2>/dev/null",
    "find benchmarks -exec touch out.txt --help \\; 2>/dev/null",
    "find benchmarks -exec touch out.txt \\; 2>/dev/null",
    "find benchmarks -execdir touch out.txt \\; 2>/dev/null",
    "find benchmarks -ok touch out.txt \\; 2>/dev/null",
    "find benchmarks -okdir touch out.txt \\; 2>/dev/null",
    "find benchmarks -fprint files.txt 2>/dev/null",
    "find benchmarks -fprint0 files.txt 2>/dev/null",
    "find benchmarks -fprintf files.txt '%p' 2>/dev/null",
    "find benchmarks -fls files.txt 2>/dev/null",
    "npm test 2>/dev/null",
    "ls $(touch out.txt) 2>/dev/null",
    "cat <(touch out.txt) 2>/dev/null",
    "cat >(touch out.txt) 2>/dev/null",
    "find benchmarks 2>'errors 2>/dev/null suffix'",
    "find benchmarks 2>\"errors 2>/dev/null suffix\"",
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
    // A read-only program can still be told to write or to run something.
    "find . -delete",
    "find . -exec rm {} +",
    "find src -execdir rm -rf {} +",
    "find . -type f -fprint out.txt",
    "fd -x rm {}",
    "rg --pre 'rm -rf x' pattern",
    "env rm -rf build",
    "env sh -c 'rm -rf build'",
    "env -u HOME rm -rf build",
    "yq -i '.a = 1' file.yaml",
    "git diff --output=out.patch",
    "git diff --output out.patch",
    // A standalone `&` and `&&` still separate, and a real redirect alongside a
    // dup (`ls 2>&1 > out.txt`) is still a file write.
    "ls && rm -rf build",
    "ls & rm -rf build",
    "ls 2>&1 > out.txt",
    "ls &> out.txt",
    // Programs that read on their own and write when given the right argument.
    "date -s 2020-01-01",
    "hostname pwned",
    "git config --list --unset user.email",
    "git config --get a --add b=c",
    // Process substitution hides a command inside a read-only one.
    "diff <(rm -rf build) file.txt",
    "cat <(sh -c 'rm -rf build')",
    // The `=<value>` spelling of a mutating flag is the same act as the
    // detached spelling, not a read.
    "rg --pre=cat pattern src",
    "fd --exec=rm",
    "fd -X=rm",
    "fd --exec-batch=rm",
    "yq --inplace=.a=1 file.yaml",
    "date --set=2020-01-01",
    // A heredoc does not launder the rest of the line, the program it feeds, or
    // a write alongside it. An unterminated heredoc stays a refusal.
    "cat <<EOF; rm x\nbody\nEOF",
    "cat <<EOF > out.txt\nbody\nEOF",
    "bash <<EOF\nrm -rf build\nEOF",
    "cat <<EOF\nbody",
  ];
  for (const command of mutating) {
    it(`refuses \`${command}\``, () => {
      expect(isReadOnlyCommand(command)).toBe(false);
    });
  }
});

// Every case below is a defect that the oracle fuzzer (a real `/bin/bash` run
// in a sandbox, against a PATH holding only the read-only allowlist) found and
// reproduced: the "refuses" side wrote a file or ran a program off the
// allowlist while the classifier called it read-only, and the "allows" side
// confirms the fix did not over-reach. The fuzzer is a fuzzing tool, not a
// test; these are the cases it pinned.
describe("read-only classifier soundness (oracle-found defects)", () => {
  const cases: Array<[string, boolean]> = [
    // A writer flag the table did not name: `tree -o <file> FILE` writes the file.
    ["tree -o out.txt .", false],
    ["tree -oout.txt .", false],
    ["tree --output=out.txt .", false],
    // `file -C -m <magic>` compiles the magic file and writes `magic.mgc`.
    ["file -C -m mgc", false],
    ["file --compile -m mgc", false],
    ["file -c -m mgc", true],
    // `less -o`/`-O`/`--log-file` write a log; `+!cmd` runs a shell command.
    ["less -o out.txt canary.txt", false],
    ["less -O out.txt canary.txt", false],
    ["less --log-file=out.txt canary.txt", false],
    ["less --save-marks canary.txt", false],
    ["less +!rm canary.txt canary.txt", false],
    ["less +F canary.txt", true],
    // `--pager` runs whatever it names, for `bat` and `ag`.
    ["bat --pager 'rm -rf x' --paging=always canary.txt", false],
    ["bat --pager=rm canary.txt", false],
    ["ag --pager 'rm -rf x' keep .", false],
    // A value attached to a value-taking short flag is the same request.
    ["date -s2020-01-01", false],
    ["date --set=2020-01-01", false],
    ["date 010112002020", false],
    ["date -Iseconds", true],
    ["hostname pwned", false],
    ["hostname -s 2>&1", true],
    ["yq -i '.a = 1' f.yaml", false],
    ["yq -i'.a=1' f.yaml", false],
    ["yq --inplace=.a=1 f.yaml", false],
    // Quoting a flag is not changing it: the shell hands over the same word.
    ["find . '-delete'", false],
    ['find . "-exec" rm {} +', false],
    ["find '--delete' .", false],
    ["fd '--exec=rm'", false],
    ["fd -xrm", false],
    ["rg '--pre=cat' pattern", false],
    ["git diff '--output=out.patch'", false],
    ['git diff "--output" out.patch', false],
    ["tree '-o out.txt' .", false],
    // `--help` only reports for a program the classifier models, and only for a
    // Git subcommand whose writer form does not run first.
    ["unknown-tool --help", false],
    ["foo --version", false],
    ["rm -rf x --help", false],
    ["find . -delete --help", false],
    ["git config --global user.email x --help", false],
    ["git commit --help", true],
    ["bb plugin new --help", true],
    // A comment does not remove the command before it.
    ["rm canary.txt # --help", false],
    ["find . -delete # --help", false],
    ["ls # rm canary.txt", true],
    // `env -S`/`--split-string` carries a whole command line, not an argument.
    ["env -S 'sh'", false],
    ["env -S 'rm'", false],
    ['env --split-string="rm canary.txt"', false],
    ["env -S 'ls -la'", true],
    ["env FOO=bar ls 2>&1", true],
    // Command substitution runs inside double quotes too.
    ['find . -name "$(touch CANARY)"', false],
    ['cat "$(rm canary.txt)"', false],
    ["echo '$(rm canary.txt)'", true],
    // An escaped quote must not desynchronise the quote state: `\" ;` still
    // separates, and `$'\\''` is one word.
    ['echo \\" ; rm canary.txt', false],
    ["printf $'\\'' ; rm canary.txt", false],
    ['echo "a\\" ; rm canary.txt"', true],
    ["echo \\; rm canary.txt", true],
    // A leading assignment that names a program another command runs: `PATH=`
    // changes which `ls` runs, and the pager/editor/diff variables are commands.
    ["PATH=/nonexistent ls", false],
    ["PAGER='rm canary.txt' git log", false],
    ["GIT_EXTERNAL_DIFF='touch CANARY' git diff", false],
    // The `-c` spelling of the same variables the environment spelling above covers:
    // `core.fsmonitor` runs during `git status`, with no TTY to notice.
    ["git -c core.fsmonitor=/tmp/evil.sh status", false],
    ["git -c core.pager='touch /tmp/pwned' log", false],
    ["git -c core.editor=/tmp/evil.sh log", false],
    ["git --exec-path=/tmp/evil status", false],
    ["git --config-env=core.pager=EVIL log", false],
    // The read-only global option stays a read: only the program-naming ones are work.
    ["git -C repo status", true],
    // `bb plugin rpc call` runs a plugin's own operation, whatever it does.
    ["bb plugin rpc call harness-parity execute --input-file request.json", false],
    ["bb plugin list", true],
    ["LD_PRELOAD=./evil.so ls", false],
    ["GIT_DIR=/nonexistent git status", false],
    ["FOO=bar ls", true],
    // A heredoc delimiter may be backslash-quoted, and the terminator is the
    // unquoted word: `<<\\EOF` ends at `EOF`, so the lines after the real
    // terminator still run. This one deleted a file while reading as read-only.
    ["cat <<\\EOF\nEOF\nrm canary.txt\nE\necho done", false],
    ["cat <<\\EOF\nrm canary.txt\nEOF", true],
    // A file-descriptor redirect is not an argument to the program.
    ["hostname -f 2>&1", true],
    ["hostname pwned 2>&1", false],
    ["ls -la 2>&1", true],
  ];
  for (const [command, readOnly] of cases) {
    it(`${readOnly ? "allows" : "refuses"} \`${command}\``, () => {
      expect(isReadOnlyCommand(command)).toBe(readOnly);
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

  it("allows exploratory find commands that suppress stderr", () => {
    const command = "find benchmarks -maxdepth 2 -type f 2>/dev/null; find research/sqlite -maxdepth 2 -type f 2>/dev/null";
    expect(classifyRow(row({ id: "find-with-stderr", workKind: "command", command }))).toBeNull();
    expect(classifyRow(row({ id: "find-with-stderr", workKind: "command", command }), {
      allowReadCommands: false,
    })).not.toBeNull();
  });

  it("does not throw on a malformed command row", () => {
    // A provider that sends a number where a command line belongs must not wedge
    // the scan: the row is judged conservative work instead of killing the loop.
    const malformed = row({ id: "r4", workKind: "command" }) as unknown as { command: unknown };
    malformed.command = 42;
    expect(() => classifyRow(malformed as Parameters<typeof classifyRow>[0])).not.toThrow();
    expect(classifyRow(malformed as Parameters<typeof classifyRow>[0])).not.toBeNull();
  });

  it("keeps the contract inside the configure ceiling with the worst reminders", () => {
    const text = buildInstructions({
      enforcement: "block",
      allowReadCommands: true,
      extra: "r".repeat(EXTRA_INSTRUCTION_LIMIT),
      reminders: Array.from({ length: 5 }, (_, index) => `changed /a/very/long/path-${index}/and/more/segments/here/file.ts`),
    });
    expect(text.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
    // The tail is what BB would cut, so the contract has to survive whole.
    expect(text).toContain("## If you cannot delegate");
    expect(text).toContain("Do not argue with the mode");
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

describe("telling a command from a tool call's title", () => {
  it("does not read a provider's tool title as a command", () => {
    // The shape that produced a false "did the work itself" nudge: the review
    // tool call rendered as a command row whose text is its title.
    expect(classifyRow(row({ id: `probe_1`, workKind: "command", command: "Recording verdict for PONG worker" }))).toBeNull();
    expect(classifyRow(row({ id: `probe_2`, workKind: "command", command: "Delegating PONG worker" }))).toBeNull();
  });

  it("still reads every realistic command as work", () => {
    for (const command of [
      "npm install",
      "bb thread spawn --project proj_1",
      "./deploy.sh --force",
      "rm -rf build",
      "git push origin main",
      "make release",
    ]) {
      expect(classifyRow(row({ id: `probe_3`, workKind: "command", command }))).not.toBeNull();
    }
  });

  it("keeps allowing read-only commands", () => {
    expect(classifyRow(row({ id: `probe_4`, workKind: "command", command: "ls -la" }))).toBeNull();
    expect(classifyRow(row({ id: `probe_5`, workKind: "command", command: "git status" }))).toBeNull();
  });

  it("reads a title that contains a path or a parenthesis as a title, not a command", () => {
    for (const command of ["Recording verdict for src/app.ts", "Running the build (2 files)"]) {
      for (const allowReadCommands of [true, false]) {
        expect(
          classifyRow(row({ id: `probe_6_${command}`, workKind: "command", command }), {
            allowReadCommands,
          }),
        ).toBeNull();
      }
    }
  });

  it("does not let a prose prefix exempt what follows a separator", () => {
    for (const command of [
      "Review the changes; rm -rf build",
      "Check the build && git push origin main --force",
      "Deploy | rm -rf dist",
    ]) {
      for (const allowReadCommands of [true, false]) {
        expect(
          classifyRow(row({ id: `probe_6b_${command}`, workKind: "command", command }), {
            allowReadCommands,
          }),
        ).not.toBeNull();
      }
    }
  });

  it("reads an unknown program as work, in both read modes", () => {
    for (const command of ["gradlew build", "just test", "flutter build apk"]) {
      for (const allowReadCommands of [true, false]) {
        expect(
          classifyRow(row({ id: `probe_7_${command}`, workKind: "command", command }), {
            allowReadCommands,
          }),
        ).not.toBeNull();
      }
    }
  });

  it("keeps the known residual: a detached capitalised program reads as a title", () => {
    // Documented in looksLikeShellCommand's comment. A capitalised program with
    // a lowercase argument (`Gradlew build`) is indistinguishable from a
    // provider title whose second word is lowercase, so it is missed; the
    // lowercase and path forms of the same program are still work, and a
    // capitalised name on the known list is caught.
    expect(classifyRow(row({ id: "probe_9a", workKind: "command", command: "Gradlew build" }))).toBeNull();
    expect(classifyRow(row({ id: "probe_9b", workKind: "command", command: "Just test" }))).toBeNull();
    expect(classifyRow(row({ id: "probe_9c", workKind: "command", command: "gradlew build" }))).not.toBeNull();
    expect(classifyRow(row({ id: "probe_9d", workKind: "command", command: "./Gradlew build" }))).not.toBeNull();
    expect(classifyRow(row({ id: "probe_9e", workKind: "command", command: "Make all" }))).not.toBeNull();
    expect(classifyRow(row({ id: "probe_9f", workKind: "command", command: "Recording verdict for src/app.ts" }))).toBeNull();
  });

  it("still flags a command-shaped line when read commands are not allowed", () => {
    // An env assignment with no program never runs, so the title rule must not
    // excuse it once the setting says every command is work.
    expect(
      classifyRow(row({ id: "probe_8a", workKind: "command", command: "worker=2" }), {
        allowReadCommands: true,
      }),
    ).toBeNull();
    expect(
      classifyRow(row({ id: "probe_8b", workKind: "command", command: "worker=2" }), {
        allowReadCommands: false,
      }),
    ).not.toBeNull();
  });
});

describe("Git global option operands", () => {
  for (const prefix of ["-C repo", "--git-dir repo/.git", "--work-tree repo", "--namespace team"]) {
    it.each([
      "-c core.pager=cat",
      "-ccore.pager=cat",
      "--config-env core.pager=REVIEW_PAGER",
      "--config-env=core.pager=REVIEW_PAGER",
      "--exec-path /tmp/git-programs",
      "--exec-path=/tmp/git-programs",
    ])(`rejects program-running options after ${prefix}: %s`, (option) => {
      const command = `git ${prefix} ${option} log`;
      expect(isReadOnlyCommand(command)).toBe(false);
      expect(classifyRow(row({ id: "global-option", workKind: "command", command }))).not.toBeNull();
    });
  }

  it.each([
    "git -C first -C second -c core.fsmonitor=/tmp/git-hook status",
    "git --git-dir repo/.git --work-tree repo --namespace team -C repo --exec-path=/tmp/git-programs status",
  ])("rejects program-running options after repeated or mixed operands: %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(false);
    expect(classifyRow(row({ id: "mixed-global-options", workKind: "command", command }))).not.toBeNull();
  });

  it.each([
    "git -C repo status",
    "git --git-dir repo/.git log",
    "git --work-tree repo status",
    "git --namespace team log",
    "git -C first -C second status",
    "git --git-dir repo/.git --work-tree repo --namespace team -C repo status",
    "git -C '-c' status",
    "git --git-dir '--config-env' log",
    "git --work-tree '--exec-path' status",
    "git --namespace '-c' log",
    "git -C repo log -- -c --config-env --exec-path",
  ])("preserves ordinary reads and literal operands: %s", (command) => {
    expect(isReadOnlyCommand(command)).toBe(true);
    expect(classifyRow(row({ id: "global-option-read", workKind: "command", command }))).toBeNull();
  });
});

describe("the contract", () => {
  const levels: EnforcementLevel[] = ["instruct", "guard", "block"];

  it("fits the 4096-character configure() budget in every mode", () => {
    // A distinctive marker, so "the append survived" is checkable and not just "the
    // text is short enough".
    const appended = `RULES:${"x".repeat(EXTRA_INSTRUCTION_LIMIT - 6)}`;
    for (const enforcement of levels) {
      for (const allowReadCommands of [true, false]) {
       for (const preset of CONTRACT_PRESETS) {
        for (const workspace of ["shared", "worktree", "mixed"] as const) {
        const text = buildInstructions({
          enforcement,
          allowReadCommands,
          reminders: Array.from({ length: 5 }, (_, index) => `ran \`${"npm test " + index}\``),
          workerConfig: {
            providerId: "command-code",
            model: `command-code/${"m".repeat(187)}`,
            reasoningLevel: "high",
            serviceTier: "fast",
            permissionMode: "accept-edits",
            fallback: { providerId: "claude-code", model: "claude-opus-5-5" },
            presets: {
              build: { model: "command-code/deepseek-v4.1-flash-fast" },
              review: { model: "claude-opus-5-5" },
              research: { reasoningLevel: "high" },
            },
          },
          extra: appended,
          preset,
          workspace,
        });
        expect(text.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
        // The clamp exists so the tail — what to do when delegation is impossible —
        // is never the part BB silently cuts.
        expect(text).toContain("If you cannot delegate");
        // An append at the cap survives whole: the clamp is the last resort, not
        // the mechanism that makes room. Growing the contract means trimming it,
        // and this is the assertion that says so.
        expect(text).toContain(appended);
        }
       }
      }
    }
  });

  it("gives each level one idea: the check unit, or the shell", () => {
    const strictStep = "Every unit gets checked before you trust it";
    const onDemandStep = "`verify: true` for a unit whose result you cannot judge";
    const delegated = "Even finding things out is a unit of work";
    const contract = (preset: ContractPresetId, allowReadCommands = true) =>
      buildInstructions({ enforcement: "guard", allowReadCommands, preset });

    // standard: a check unit only where a report cannot settle a unit.
    const standard = contract("standard");
    expect(standard).toContain(onDemandStep);
    expect(standard).not.toContain(strictStep);
    expect(standard).toContain("Read-only shell commands");

    // review-heavy: that check becomes mandatory, and the check runs the work rather
    // than rereading it. Nothing else changes.
    const reviewHeavy = contract("review-heavy");
    expect(reviewHeavy).toContain(strictStep);
    expect(reviewHeavy).toContain("runs what it claims");
    expect(reviewHeavy).not.toContain(onDemandStep);
    expect(reviewHeavy).not.toContain(delegated);
    expect(reviewHeavy).toContain("Read-only shell commands");

    // delegate-only: the reading goes to workers and the shell goes with it, whatever
    // the read-only allowance says. The review step stays as standard's.
    const delegateOnly = contract("delegate-only");
    expect(delegateOnly).toContain(delegated);
    expect(delegateOnly).toContain("Only CLI delegation commands may run");
    expect(delegateOnly).not.toContain(strictStep);
    expect(delegateOnly).toContain(onDemandStep);
  });

  it("names the saved worker kinds, and stays silent when none are stored", () => {
    const withPresets = buildInstructions({
      enforcement: "guard",
      allowReadCommands: true,
      preset: "review-heavy",
      workerConfig: {
        presets: {
          research: { reasoningLevel: "high" },
          build: { model: "command-code/deepseek-v4.1-flash-fast" },
        },
      },
    });
    expect(withPresets).toContain("Saved worker kinds: build, research");
    expect(withPresets).toContain("name one as `preset`");
    // Enum order, not insertion order: build before research however the map was written.
    expect(withPresets.indexOf("build")).toBeLessThan(withPresets.indexOf("research"));

    // Nothing saved means nothing advertised: the contract never invents a knob.
    const without = buildInstructions({ enforcement: "guard", allowReadCommands: true, preset: "review-heavy" });
    expect(without).not.toContain("Saved worker kinds");
    expect(without).not.toContain("`preset`");
  });

  it("names the delegation tool and forbids editing files", () => {
    const text = buildInstructions({ enforcement: "guard", allowReadCommands: true });
    expect(text).toContain("orchestrator_delegate");
    expect(text).toContain("ORCHESTRATOR MODE IS ON");
    expect(text.toLowerCase()).toContain("editing");
  });

  it("documents the stderr-suppression exception", () => {
    const text = buildInstructions({ enforcement: "guard", allowReadCommands: true });
    expect(text).toContain("2>/dev/null");
    expect(text).toContain("other output redirects count as work");
  });

  it("explains how to pin workers without disabling the mode", () => {
    const text = buildInstructions({ enforcement: "guard", allowReadCommands: true });
    expect(text).toContain("`providerId`");
    expect(text).toContain("`model`");
    expect(text).toContain("--provider <id> --model <id>");
    expect(text).toContain("pinning does not require turning this mode off");
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

  it("documents worker follow-up messaging", () => {
    const text = buildInstructions({ enforcement: "guard", allowReadCommands: true });
    expect(text).toContain("bb thread tell <worker-id>");
    expect(text).toContain("quoted stdin heredocs are delegation");
  });

  it.each(["thr_z5wtd7fibg", "thr_3fuxqgieyy"])(
    "allows worker follow-up messaging to %s as delegation",
    (threadId) => {
      const command = `bb thread tell ${threadId} --model grok-4.7 --mode steer --message-file -`;
      expect(isReadOnlyCommand(command)).toBe(false);
      expect(classifyRow(row({ id: threadId, workKind: "command", command }), {
        allowReadCommands: false,
        workerThreadIds: ["thr_z5wtd7fibg", "thr_3fuxqgieyy"],
      })).toBeNull();
    },
  );

  it.each([
    "bb thread tell thr_worker 'Review the implementation and add tests'",
    "bb thread message thr_worker --message-file followup.md",
    "bb thread tell 'thr_worker' --mode queue 'Add tests'",
    "bb thread tell \"thr_worker\" --mode auto 'Add tests'",
    "/usr/local/bin/bb thread tell thr_worker 'Add tests'",
    "bb thread tell thr_worker 'Use `npm test` and $(example) as literal text'",
    "bb thread tell thr_worker --message-file - <<'FOLLOWUP'\nAdd tests; do not change the contract.\nRun `npm test` and $(example) in the worker, not here.\nFOLLOWUP",
    "bb thread tell thr_worker --message-file - <<\"FOLLOWUP\"\nAdd tests > 3 cases.\nFOLLOWUP\n",
    "bb thread tell thr_worker --message-file - <<-'FOLLOWUP'\n\tAdd tests\n\tFOLLOWUP",
    "bb thread tell thr_worker 'First task'; bb thread tell thr_worker2 'Second task'",
  ])("allows recorded-worker follow-up: %s", (command) => {
    expect(classifyRow(row({ id: "followup", workKind: "command", command }), {
      allowReadCommands: false,
      workerThreadIds: ["thr_worker", "thr_worker2"],
    })).toBeNull();
  });

  it.each([
    "bb thread tell thr_unknown 'Do work'",
    "bb thread tell thr_parent 'Disable the mode'",
    "bb thread tell thr_worker 'Add tests'; npm test",
    "bb thread tell thr_worker 'Add tests' > output.txt",
    "bb thread tell thr_worker 'Add tests' & npm test",
    'bb thread tell thr_worker "$(npm test)"',
    "bb thread tell thr_worker `npm test`",
    "bb thread tell thr_worker --message-file <(npm test)",
    "bb thread tell thr_worker --message-file - <<FOLLOWUP\n$(npm test)\nFOLLOWUP",
    "bb thread tell thr_worker --message-file - <<'FOLLOWUP'\nAdd tests\nFOLLOWUP\nnpm test",
    "bb thread tell thr_worker --message-file - <<'FOLLOWUP'; npm test\nAdd tests\nFOLLOWUP",
    "bb thread tell thr_worker --message-file - <<'FOLLOWUP'\nAdd tests\nFOLLOWUP extra",
    "bb thread tell thr_worker --message-file - <<'FOLLOWUP'\nNo closing delimiter",
    'bb thread tell thr_worker "message <<\'FOLLOWUP\'\n$(npm test)\nFOLLOWUP\n"',
  ])("rejects unsafe or unrecorded-worker follow-up: %s", (command) => {
    expect(classifyRow(row({ id: "followup", workKind: "command", command }), {
      workerThreadIds: ["thr_worker", "thr_worker2"],
    })).not.toBeNull();
  });

  it("treats a plain heredoc as a read, not worker delegation", () => {
    const work = row({ id: "plain-heredoc", workKind: "command", command: "cat <<'FOLLOWUP'\ntext\nFOLLOWUP" });
    expect(classifyRow(work, { workerThreadIds: ["thr_worker"] })).toBeNull();
    expect(classifyRow(work, {
      workerThreadIds: ["thr_worker"], allowReadCommands: false,
    })).not.toBeNull();
  });

  it("allows read-only checks around worker messages only when exploration is enabled", () => {
    const command = "bb status --json; bb thread tell thr_worker 'Add tests'";
    const work = row({ id: "followup", workKind: "command", command });
    expect(classifyRow(work, { workerThreadIds: ["thr_worker"] })).toBeNull();
    expect(classifyRow(work, {
      workerThreadIds: ["thr_worker"], allowReadCommands: false,
    })).not.toBeNull();
  });

  it("allows CLI delegation even when read-only exploration is disabled", () => {
    for (const command of [
      "bb orchestrator-mode delegate --task 'Implement retries; add tests > 3 cases'",
      'bb orchestrator-mode delegate --task "Implement retries" --no-wait',
      "bb orchestrator-mode delegate --task 'Probe the scope' --provider grok --model grok-test-model --no-wait",
      "bb orchestrator-mode delegate --task 'Probe the scope' --provider-id grok --model grok-test-model",
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
