// Shared policy for the orchestrator-mode backend and the frontend.
//
// Everything here is pure: no SDK imports, no I/O. `server.ts` uses it to build
// the instruction block and to classify timeline rows, `app.tsx` uses it to
// label the composer surfaces, and `shared.test.ts` exercises it directly.
//
// Keeping the policy in one module matters because the two halves must agree:
// the instructions tell the agent exactly which acts the watchdog treats as
// "doing the work itself", so a change here has to change both at once.

/** How hard the plugin pushes back when an orchestrator does the work itself. */
export type EnforcementLevel = "instruct" | "guard" | "block";

/**
 * The tool an orchestrator delegates with. Defined here, next to the text that
 * names it, so the contract and the registration cannot drift apart.
 */
export const DELEGATE_TOOL = "orchestrator_delegate";

/**
 * The tool an orchestrator records a verdict with. Defined here, next to the
 * contract that requires it, so the two cannot drift apart.
 */
export const REVIEW_TOOL = "orchestrator_review";

/** What the orchestrator decided about a worker's output. */
export const REVIEW_VERDICTS = ["accepted", "rejected"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const ENFORCEMENT_LEVELS: readonly EnforcementLevel[] = [
  "instruct",
  "guard",
  "block",
];

export const DEFAULT_ENFORCEMENT: EnforcementLevel = "guard";

/** One-line description of each level, for the composer, CLI and settings UI. */
export const ENFORCEMENT_DESCRIPTIONS: Record<EnforcementLevel, string> = {
  instruct: "Instruct writes the rules into every turn and checks nothing.",
  guard:
    "Guard writes the rules and warns the orchestrator when it does the work itself or leaves a worker unjudged.",
  block:
    "Block writes the rules too, and stops the turn as soon as the orchestrator does the work itself. A fast write can still land first.",
};

/** One runtime check for every `as const` union this module declares. */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export function isEnforcementLevel(value: unknown): value is EnforcementLevel {
  return isOneOf(ENFORCEMENT_LEVELS, value);
}

// ---------------------------------------------------------------------------
// Worker execution control
// ---------------------------------------------------------------------------

/**
 * The reasoning levels a spawn accepts, mirroring the SDK's `ReasoningLevel`.
 * Narrower in practice: a provider only honours the rungs its model ladder has.
 */
export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The permission modes a spawn accepts, mirroring the SDK's `PermissionMode`. */
export const PERMISSION_MODES = ["auto", "accept-edits", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The service tiers a spawn accepts, mirroring the SDK's `ServiceTier`. */
export const SERVICE_TIERS = ["default", "fast"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

/**
 * Execution overrides for a spawned worker. An absent field is not "no value",
 * it is "inherit": the thread is spawned without it and BB resolves the
 * project's remembered default, then the provider catalog default.
 *
 * The block is forwarded to `threads.spawn` together with an
 * `executionInputSources` provenance stamp, because the server drops a
 * requested `providerId`/`model` that carries no source and silently re-derives
 * it from the project defaults.
 */
export interface WorkerExecution {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: ServiceTier;
  permissionMode?: PermissionMode;
}

/**
 * The unit classes an execution preset can name: the delegate-mode recipes, as
 * one word the orchestrator can pass instead of five ids.
 */
export const WORKER_PRESETS = ["build", "review", "research"] as const;
export type WorkerPresetName = (typeof WORKER_PRESETS)[number];

/**
 * Whether a delegation may choose its own model. `pinned` is the default: every
 * worker runs on the execution the scope stores, or on a stored kind it names as
 * a `preset`, so the orchestrator can neither upgrade nor downgrade a unit.
 * `flexible` restores the earlier behaviour, where a delegation may name any
 * model in the catalog and the contract invites a stronger one for a hard unit.
 */
export const WORKER_MODEL_POLICIES = ["pinned", "flexible"] as const;
export type WorkerModelPolicy = (typeof WORKER_MODEL_POLICIES)[number];

/**
 * What the plugin stores for workers: the execution every delegation starts on,
 * plus the one to retry with when a worker fails.
 *
 * Deliberately a separate type from {@link WorkerExecution}: that one is spread
 * straight into `threads.spawn`, and a `fallback` key inside it would be an
 * invalid spawn field.
 */
export interface WorkerConfig extends WorkerExecution {
  /** Re-delegate the same brief on this when the first worker fails. */
  fallback?: WorkerExecution;
  /**
   * Per-unit-class overrides, applied under a delegation's own arguments and
   * over the worker execution: a preset may set only the fields that differ, so
   * `research` can mean a cheaper model and a read-only access on whatever the
   * workers already run on.
   */
  presets?: Partial<Record<WorkerPresetName, WorkerExecution>>;
}

/** One model the SDK's own picker offers, with the provider that serves it. */
export interface WorkerModelOption {
  id: string;
  providerId: string;
}

/**
 * The provider/model catalog this plugin offers for workers, read from the same
 * `bb.sdk.providers` source the new-thread composer's pickers use. An empty
 * catalog means the read failed: nothing is offered and nothing is validated.
 */
export interface WorkerCatalog {
  providers: readonly string[];
  models: readonly WorkerModelOption[];
}

/**
 * The thread-metadata mirror of the plugin's authoritative state.
 *
 * `bb.agents.configure` is synchronous and its only per-thread input is
 * `context.pluginMetadata`, so the enabled flag has to be readable there. The
 * copy in this plugin's own KV store stays the source of truth and is rewritten
 * onto the thread at every dispatch admission, which runs before the turn does.
 */
// A type alias, not an interface: BB's `JsonObject` needs an implicit index
// signature, which only object-literal type aliases get.
type OrchestratorMirror = {
  /** True while this thread must orchestrate instead of working. */
  enabled: boolean;
  /** Per-thread override, or null to follow the plugin setting. */
  enforcement: EnforcementLevel | null;
  /** Marks the mirror as ours, so a stale value from another writer is ignored. */
  source: "orchestrator-mode";
};

const MIRROR_SOURCE = "orchestrator-mode" as const;

/** Parse an untrusted metadata namespace into a mirror, or null when absent. */
export function readMirror(
  metadata: Readonly<Record<string, unknown>>,
): OrchestratorMirror | null {
  const raw = metadata["orchestrator"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["source"] !== MIRROR_SOURCE) return null;
  if (typeof record["enabled"] !== "boolean") return null;
  const enforcement = isEnforcementLevel(record["enforcement"])
    ? record["enforcement"]
    : null;
  return { enabled: record["enabled"], enforcement, source: MIRROR_SOURCE };
}

/** The value written into a thread's plugin-metadata namespace. */
export function writeMirror(mirror: {
  enabled: boolean;
  enforcement: EnforcementLevel | null;
}): { orchestrator: OrchestratorMirror } {
  return {
    orchestrator: {
      enabled: mirror.enabled,
      enforcement: mirror.enforcement,
      source: MIRROR_SOURCE,
    },
  };
}

/**
 * Whether the plugin's "new threads start as orchestrators" default may apply
 * to a thread. Only a root thread a person started qualifies: a worker this
 * plugin spawned has a parent, and a side chat is a fork of the builtin
 * side-chat plugin. Both facts come from core, not from metadata, so the
 * thread's own agent cannot forge its way in or out.
 */
export function defaultAppliesTo(thread: {
  parentThreadId: string | null;
  originPluginId?: string | null;
}): boolean {
  if (thread.parentThreadId !== null) return false;
  if (thread.originPluginId === "side-chat") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Direct-work classification
// ---------------------------------------------------------------------------

/**
 * The slice of a timeline row the classifier needs. Structural on purpose: the
 * SDK's `TimelineRow` union is huge and versioned, and this keeps the policy
 * testable without importing it.
 */
export interface WorkRowLike {
  kind: string;
  workKind?: string | undefined;
  toolName?: string | null | undefined;
  command?: string | null | undefined;
  change?: { path?: string | null } | null | undefined;
}

export interface Violation {
  /** Timeline row id, used to dedupe across scans. */
  id: string;
  turnId: string | null;
  workKind: string;
  /** Human-readable act, shown in the banner and the CLI. */
  detail: string;
  detectedAt: number;
}

interface ClassifierOptions {
  /** Read-only shell commands are research, not work. Default true. */
  allowReadCommands: boolean;
  /** Retained worker IDs recorded by this orchestrator's delegation handler. */
  workerThreadIds: readonly string[];
}

const DEFAULT_CLASSIFIER_OPTIONS: ClassifierOptions = {
  allowReadCommands: true,
  workerThreadIds: [],
};

/**
 * Tool names that change something. A generic `tool` row that matches is doing
 * the work itself; one that does not is treated as research and allowed.
 */
const MUTATING_TOOL_PATTERN =
  /(write|edit|create|delete|remove|rename|move|copy|apply|patch|replace|append|insert|mkdir|touch|chmod|chown|commit|push|merge|rebase|reset|revert|checkout|install|build|compile|exec|execute|shell|bash|command|run|kill|upload|deploy|migrate|format|lint|test)/i;

/** Work kinds that are always the orchestrator doing the work itself. */
const ALWAYS_WORK: ReadonlySet<string> = new Set(["file-change", "command", "image-generation"]);

/** Work kinds that are always allowed: thinking, asking, and delegating. */
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
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
  "image-view",
]);

/**
 * Whether the character at `index` ends one shell command and starts the next.
 * `;`, `|` and the line breaks always do; `&` is the awkward one, because it
 * also forms the redirect and fd-duplication operators. A `&` that belongs to
 * `>&`, `&>` or `2>&1` is part of a redirect rather than a separator, and so is
 * a leading `&` (as in `&> file`). `&&` still separates, both ampersands of it.
 * Nothing here is quote-aware: the scanner only asks about characters outside
 * quotes.
 */
function isCommandSeparator(text: string, index: number): boolean {
  const char = text[index]!;
  if (char === ";" || char === "|" || char === "\n" || char === "\r") return true;
  if (char !== "&") return false;
  if (text[index - 1] === "&" || text[index + 1] === "&") return true;
  if (text[index - 1] === ">" || text[index + 1] === ">") return false;
  return index !== 0;
}

/** Quote state of a shell word: none, `'...'`, `"..."`, or ANSI-C `$'...'`. */
type QuoteState = "" | "'" | '"' | "ansi";

/**
 * Walk a shell line once, tracking quotes and backslash escapes, and hand every
 * character to `visit` with the facts both callers need: the quote state that
 * governs it, whether it was written with a backslash, and whether it was
 * syntax rather than content (a quote delimiter, a `$` that opens one, or the
 * backslash itself). A backslash escapes the next character outside quotes and
 * inside `"..."` and `$'...'`; inside `'...'` it is an ordinary character,
 * exactly as the shell reads it. Without this, `echo \" ; rm x` desynchronises
 * the quote state and a separator after an escaped quote looks like quoted
 * text.
 */
function walkShell(
  text: string,
  visit: (char: string, quote: QuoteState, escaped: boolean, delimiter: boolean, index: number) => void,
): void {
  let quote: QuoteState = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote !== "") {
      if (char === "\\" && quote !== "'") {
        visit(char, quote, false, true, index);
        const next = text[index + 1];
        if (next !== undefined) {
          visit(next, quote, true, false, index + 1);
          index += 1;
        }
        continue;
      }
      const closes = char === quote || (quote === "ansi" && char === "'");
      visit(char, quote, false, closes, index);
      if (closes) quote = "";
      continue;
    }
    if (char === "\\") {
      visit(char, "", false, true, index);
      const next = text[index + 1];
      if (next !== undefined) {
        visit(next, "", true, false, index + 1);
        index += 1;
      }
      continue;
    }
    // `$'...'` is ANSI-C quoting and `$"..."` behaves like `"..."`: both hold
    // their content as one word, and both let a backslash escape a closing quote.
    if (char === "$" && (text[index + 1] === "'" || text[index + 1] === '"')) {
      visit(char, "", false, true, index);
      visit(text[index + 1]!, "", false, true, index + 1);
      quote = text[index + 1] === "'" ? "ansi" : '"';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      visit(char, "", false, true, index);
      quote = char;
      continue;
    }
    visit(char, "", false, false, index);
  }
}

/** Characters the shell treats as unquoted whitespace between words. */
const WORD_BREAK = /[ \t]/;

/**
 * The words of one command, with quotes removed and escapes resolved the way
 * the shell resolves them, so `find . '-delete'` and `tree "-o out.txt" .` hand
 * their flags to the write-flag table as the single arguments they are.
 */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  walkShell(segment, (char, quote, escaped, delimiter) => {
    if (delimiter) {
      // A quoted empty word is still a word: `''`.
      started = true;
      return;
    }
    if (quote === "" && !escaped && WORD_BREAK.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
      return;
    }
    word += char;
    started = true;
  });
  if (started) words.push(word);
  return words;
}

/**
 * Walk a shell line once. `unquoted` is the text outside quotes, for the
 * word-level metacharacter tests, `live` is the text the shell would run an
 * expansion in — everything except single-quoted and `$'...'` content, because
 * a command substitution runs inside `"..."` too — and `segments` are the
 * pieces between unquoted separators, so `rg "a|b"` stays one command, a quoted
 * `>` is not a redirect, and the `&` in `ls 2>&1` does not cut the line in two.
 * Escaped characters count as unquoted on purpose: `\$(rm x)` still runs a
 * subshell, so the conservative reading is the correct one.
 */
function scanCommandLine(text: string): { unquoted: string; live: string; segments: string[] } {
  const segments: string[] = [];
  let current = "";
  let unquoted = "";
  let live = "";
  walkShell(text, (char, quote, escaped, _delimiter, index) => {
    if (quote === "" || quote === '"') live += char;
    // An escaped `\;` is a literal character, not a command separator.
    if (quote === "" && !escaped && isCommandSeparator(text, index)) {
      unquoted += char;
      segments.push(current);
      current = "";
      return;
    }
    current += char;
    if (quote === "") unquoted += char;
  });
  segments.push(current);
  return { unquoted, live, segments };
}

/** Leading `FOO=bar` environment assignments before the actual program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that only look at things. `git` and `bb` are checked against their
 * subcommands separately, because both can also mutate.
 */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "ll",
  "la",
  "cat",
  "bat",
  "head",
  "tail",
  "less",
  "more",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "find",
  "fd",
  "tree",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "which",
  "whereis",
  "type",
  "echo",
  "printf",
  "date",
  "env",
  "printenv",
  "uname",
  "hostname",
  "whoami",
  "id",
  "jq",
  "yq",
  "true",
  "test",
  "[",
  "diff",
  "cmp",
  "md5",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "realpath",
  "dirname",
  "basename",
]);

/**
 * Programs that plausibly appear as the first word of a real command. Not a
 * safety list: an unknown program is still work, because a command's first
 * token is not an English sentence — see {@link looksLikeShellCommand}. Its job
 * is to tell a command from the *title* some providers give a plugin tool call,
 * which arrives as a `command` row whose text is a sentence like "Recording
 * verdict for X".
 */
const PLAUSIBLE_PROGRAMS: ReadonlySet<string> = new Set([
  ...READ_ONLY_PROGRAMS,
  // Mutating programs an agent runs, by hand or through a script.
  "bb",
  "git",
  "gh",
  "glab",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "cargo",
  "rustc",
  "go",
  "zig",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "aws",
  "gcloud",
  "az",
  "brew",
  "apt",
  "apt-get",
  "pytest",
  "vitest",
  "jest",
  "tsc",
  "eslint",
  "prettier",
  "ruff",
  "black",
  "mypy",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sed",
  "awk",
  "perl",
  "ruby",
  "java",
  "javac",
  "swift",
  "xcodebuild",
  "openssl",
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tee",
  "truncate",
  "dd",
  "kill",
  "pkill",
  "killall",
  "ps",
  "launchctl",
  "systemctl",
  "crontab",
  "sqlite3",
  "psql",
  "mysql",
  "redis-cli",
  "patch",
]);

/**
 * A short option, or a cluster of them, that contains `letter` — `-o`, `-oFILE`
 * and `-aofile` all count, while a long option does not.
 */
function hasShortFlag(arg: string, letter: string): boolean {
  return /^-[^-]/.test(arg) && arg.slice(1).includes(letter);
}

/**
 * Flags that turn an otherwise read-only program into a writer or a runner, so
 * `find . -delete`, `fd -x rm`, `rg --pre <cmd>`, `tree -o <file>`, `less -o`,
 * `file -C` and `bat --pager <cmd>` are not read as searches. Only programs on
 * the read-only list can appear here, and every predicate runs on the token
 * with its quotes removed, because `find . '-delete'` deletes and
 * `git diff '--output=out.patch'` writes: quoting a flag is not changing it.
 *
 * Each predicate accepts the detached, `=<value>`, value-attached and clustered
 * spellings, since `rg --pre=cat`, `fd -X=rm`, `date -s2020` and `tree -oFILE`
 * are the same request as their space-separated forms.
 */
const MUTATING_PROGRAM_FLAGS: Record<string, (arg: string) => boolean> = {
  // BSD `find` accepts its actions with one or two leading dashes (`--exec`),
  // and `-fprintFILE`/`-fprintf FILE` take the file the action writes.
  find: (arg) => /^--?(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)(?:=|$)/.test(arg),
  // `fd -x rm` and its attached `-xrm` are the same request.
  fd: (arg) => /^(?:--exec|--exec-batch)(?:=|$)/.test(arg) || /^-[xX]/.test(arg),
  rg: (arg) => /^--pre(?:=|$)/.test(arg),
  yq: (arg) => /^--in-?place(?:=|$)/.test(arg) || hasShortFlag(arg, "i"),
  // `date -s`/`date -s2020` sets the clock; on BSD a bare date operand does too.
  date: (arg) => /^-s/.test(arg) || /^--set(?:=|$)/.test(arg) || /^\d{6,}$/.test(arg),
  // `hostname` prints on its own and sets the name when it is given one.
  hostname: (arg) => !arg.startsWith("-"),
  // `tree -oFILE`, `file -C` (compile a magic file), `less -o` (log file) and
  // `less +!cmd` (run a shell command), `bat`/`ag --pager <cmd>`.
  tree: (arg) => arg === "--output" || arg.startsWith("--output=") || hasShortFlag(arg, "o"),
  file: (arg) => arg === "--compile" || arg.startsWith("--compile=") || hasShortFlag(arg, "C"),
  less: (arg) =>
    /^--(?:log-file|LOG-FILE|save-marks)(?:=|$)/.test(arg) ||
    /^\+[!|]/.test(arg) ||
    hasShortFlag(arg, "o") ||
    hasShortFlag(arg, "O"),
  bat: (arg) => arg === "--pager" || arg.startsWith("--pager="),
  ag: (arg) => arg === "--pager" || arg.startsWith("--pager="),
};

/**
 * Environment variables that name a program something else will run, or move
 * where a program looks for one. `FOO=bar ls` only sets an argument, but
 * `PATH=/tmp ls` runs a different `ls`, `GIT_EXTERNAL_DIFF=x git diff` runs
 * `x`, `BAT_PAGER=x bat` runs `x`, and `GIT_DIR=x git status` retargets a write.
 */
const ENV_COMMAND_VARIABLES: Record<string, true> = {
  PATH: true,
  PAGER: true,
  GIT_PAGER: true,
  BAT_PAGER: true,
  MANPAGER: true,
  LESS: true,
  GIT_EXTERNAL_DIFF: true,
  GIT_EDITOR: true,
  GIT_SEQUENCE_EDITOR: true,
  GIT_ASKPASS: true,
  SSH_ASKPASS: true,
  EDITOR: true,
  VISUAL: true,
  LD_PRELOAD: true,
  LD_LIBRARY_PATH: true,
  DYLD_INSERT_LIBRARIES: true,
  DYLD_LIBRARY_PATH: true,
  BASH_ENV: true,
  ENV: true,
  PERL5OPT: true,
  NODE_OPTIONS: true,
  PYTHONSTARTUP: true,
  GIT_SSH: true,
  GIT_SSH_COMMAND: true,
  GIT_DIR: true,
  GIT_WORK_TREE: true,
  GIT_INDEX_FILE: true,
  GIT_OBJECT_DIRECTORY: true,
  GIT_CONFIG_GLOBAL: true,
  GIT_CONFIG_SYSTEM: true,
};

/**
 * A file-descriptor redirect token — `2>&1`, `>&2`, `2>&-`, `<`, `0<&3`. It is
 * not an argument to the program, so `hostname -f 2>&1` is `hostname -f`.
 * File-writing redirects (`>`, `>>`, `&>`) never reach here: the line-level
 * check refuses them first.
 */
const FD_REDIRECT = /^(?:\d*[<>]&(?:-|\d+)|[<>]|\d+[<>])$/;

/** A later token that reads as a lowercase English word rather than a shout. */
const SENTENCE_WORD = /^[a-z][a-z'-]*$/;

/**
 * Whether a `command` row's text is shaped like something that was actually
 * run, rather than the sentence a provider used as a tool call's title.
 *
 * One rule separates the two, and it is the first token. A program is named the
 * way the binary or file is: lowercase (`gradlew build`), a path
 * (`./deploy.sh`), or an env assignment (`FOO=bar make`). A provider title
 * instead begins with a capitalised English word and reads on as a sentence
 * (`Recording verdict for src/app.ts`, `Running the build (2 files)`), so a
 * capitalised first token plus one later lowercase word means a title. A known
 * program settles it either way; otherwise a lone capitalised token — a
 * capitalised program with no lowercase word after it — reads as a program.
 *
 * It is asked about one command segment at a time, never the whole row: a
 * provider's title never contains an unquoted separator, so `Review the
 * changes; rm -rf build` is a command line whose second segment is not a title.
 *
 * The known residual, per segment: a detached capitalised program followed by a
 * lowercase argument (`Gradlew build`, `Just test`) is read as a title and
 * missed, because nothing outside the program list distinguishes it from prose.
 * The lowercase form (`gradlew build`) and the path form (`./Gradlew build`) are
 * both caught.
 */
function looksLikeShellCommand(command: string): boolean {
  const text = command.trim();
  if (text === "") return false;
  const tokens = text.split(/\s+/);
  const first = tokens[0] ?? "";
  if (PLAUSIBLE_PROGRAMS.has(first)) return true;
  // A capitalised program name is still a program.
  if (!/^[A-Z]/.test(first) || PLAUSIBLE_PROGRAMS.has(first.toLowerCase())) return true;
  // `FOO=bar` is an assignment, not a sentence.
  if (ENV_ASSIGNMENT.test(first)) return true;
  // A sentence needs a lowercase word after its first token; without one the
  // text is a bare capitalised token, which reads as a program, not prose.
  return !tokens.slice(1).some((token) => SENTENCE_WORD.test(token));
}

/**
 * Whether a whole `command` row reads as a provider title: every segment has to.
 * One segment that looks like a command makes the row a command line, because a
 * title never carries an unquoted separator.
 */
function looksLikeTitleRow(command: string): boolean {
  const segments = scanCommandLine(command).segments.filter((segment) => segment.trim() !== "");
  if (segments.length === 0) return false;
  return segments.every((segment) => !looksLikeShellCommand(segment));
}

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "ls-files",
  "ls-tree",
  "describe",
  "rev-parse",
  "rev-list",
  "shortlog",
  "cat-file",
  "whatchanged",
  "count-objects",
  "name-rev",
  "merge-base",
  "for-each-ref",
]);

const GIT_BRANCH_LIST_OPTIONS: ReadonlySet<string> = new Set([
  "--list", "--all", "--remotes", "--verbose",
]);
const GIT_TAG_LIST_OPTIONS: ReadonlySet<string> = new Set(["--list", "-l", "-n"]);

/** `git config` actions that write, whichever read form the same call asks for. */
const GIT_CONFIG_WRITERS: Record<string, true> = {
  "--add": true,
  "--unset": true,
  "--unset-all": true,
  "--replace-all": true,
  "--rename-section": true,
  "--remove-section": true,
  "--set": true,
  "--edit": true,
  "-e": true,
};

/** Git global options that take a separate value, so the token after them is not the subcommand. */
const GIT_GLOBAL_VALUE_FLAGS: Record<string, true> = {
  "-C": true,
  "-c": true,
  "--git-dir": true,
  "--work-tree": true,
  "--namespace": true,
  "--exec-path": true,
  "--config-env": true,
};

/**
 * Global `git` options that hand git a program to run: `-c core.pager=…`,
 * `-c core.fsmonitor=…`, `--config-env=core.editor=…`, `--exec-path=…`. They sit
 * before the subcommand, so skipping them as ordinary global options is what let
 * `git -c core.fsmonitor=/tmp/evil.sh status` read as read-only. None of them
 * can make a read a read; treating every one as work is the trade this module
 * makes everywhere else.
 */
function gitRunsAProgram(rest: readonly string[]): boolean {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("-")) return false;
    if (token === "-c" || (token.startsWith("-c") && token.length > 2)) return true;
    if (token === "--config-env" || token.startsWith("--config-env=")) return true;
    if (token === "--exec-path" || token.startsWith("--exec-path=")) return true;
    // A global option operand is neither a subcommand nor another option.
    // Skip it so a later program-running option is still checked.
    if (GIT_GLOBAL_VALUE_FLAGS[token] === true) index += 1;
  }
  return false;
}

/** The subcommand after any leading global options: `git -C repo status` reads `status`, not `-C`. */
function gitSubcommandAndArgs(rest: readonly string[]): { subcommand: string | undefined; args: string[] } {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index]!;
    if (GIT_GLOBAL_VALUE_FLAGS[token] === true) { index += 2; continue; }
    if (token.startsWith("-")) { index += 1; continue; }
    break;
  }
  return { subcommand: rest[index], args: rest.slice(index + 1) };
}

/** Mixed Git subcommands need an explicit query form, not just a known name. */
function isReadOnlyGitSegment(rest: readonly string[]): boolean {
  const { subcommand, args } = gitSubcommandAndArgs(rest);
  if (subcommand === undefined) return true;
  // A diff-family `--output=<file>`/`--output <file>` writes a file, whatever
  // the subcommand reads. Only those two forms: `--output-indicator-*` is a
  // read-only display flag that shares the prefix.
  if (args.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
  if (subcommand === "branch" || subcommand === "tag") {
    const isBranch = subcommand === "branch";
    const listing = args.includes("--list") || (!isBranch && args.includes("-l"));
    const options = isBranch ? GIT_BRANCH_LIST_OPTIONS : GIT_TAG_LIST_OPTIONS;
    return args.every((arg) =>
      options.has(arg) ||
      (isBranch && /^-[arv]+$/.test(arg)) ||
      (!isBranch && /^-n\d+$/.test(arg)) ||
      (listing && !arg.startsWith("-")),
    );
  }
  if (subcommand === "remote") {
    const query = args[0] === "-v" || args[0] === "--verbose" ? args.slice(1) : args;
    return query.length === 0 || query[0] === "show" || query[0] === "get-url";
  }
  if (subcommand === "reflog") {
    return args.length === 0 || args[0] === "show" || args[0] === "list" || args[0] === "exists";
  }
  if (subcommand === "config") {
    // A read form only reads when the same call carries no writing action.
    // The whole `--get*` query family reads: `--get-all`, `--get-regexp`,
    // `--get-color`, `--get-colorbool` and `--get-urlmatch` are the same
    // explicit query as `--get`, and none of them writes.
    const reads = args.some(
      (arg) => arg === "--get" || arg.startsWith("--get-") || arg === "--list" || arg === "-l",
    );
    return reads && !args.some((arg) => GIT_CONFIG_WRITERS[arg] === true);
  }
  return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * Git subcommands whose writer forms are flag-driven, so `--help` cannot be
 * trusted to short-circuit them. `git config --global user.email x --help`
 * resolves the config path, writes it, and only then reports.
 */
const GIT_MIXED_SUBCOMMANDS: Record<string, true> = {
  config: true,
  branch: true,
  tag: true,
  remote: true,
  reflog: true,
};

/** Whether `--help` may stand in for the read check on this Git call. */
function gitHelpIsSafe(rest: readonly string[]): boolean {
  const { subcommand } = gitSubcommandAndArgs(rest);
  return subcommand === undefined || GIT_MIXED_SUBCOMMANDS[subcommand] !== true;
}

/**
 * `bb` subcommands that only report, with no second token to check.
 * Deliberately short: `bb thread`, `bb plugin` and `bb workflows` can all start
 * work, and an orchestrator has `orchestrator_delegate` for that anyway.
 */
const READ_ONLY_BB_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "guide"]);

/**
 * `bb <area> <verb>` pairs that only read. Kept as a table because the areas
 * themselves are mixed: `bb plugin list` reports, `bb plugin install` changes
 * the machine. `bb orchestrator-mode status` is read-only but `on`/`off` would
 * let a thread switch off its own leash, so only `status` is listed.
 */
const READ_ONLY_BB_VERBS: Record<string, ReadonlySet<string>> = {
  // `rpc` is deliberately absent: `bb plugin rpc call <plugin> <operation>` runs a
  // plugin's own operation, which this module cannot model and which is how a
  // mutating call reads as a read.
  plugin: new Set(["list", "logs", "source", "search", "outdated"]),
  // The orchestrator needs these to pick worker models the catalog can serve.
  provider: new Set(["list", "models"]),
  thread: new Set([
    "list",
    "show",
    "get",
    "log",
    "messages",
    "output",
    "history",
    "context",
    "count",
    "search",
    "wait",
  ]),
  "orchestrator-mode": new Set(["status"]),
};

/** `bb skill`/`bb skills` verbs that change the catalog rather than read it. */
const MUTATING_SKILL_VERBS: ReadonlySet<string> = new Set(["update", "remove", "install"]);

/** Asking for help or a version never changes anything. */
const HELP_OR_VERSION = /(?:^|\s)(?:--help|-h|--version)(?:\s|=|$)/;

/** Characters that end an unquoted shell word, so a heredoc delimiter stops there. */
const SHELL_WORD_BREAK = /[\s;&|()<>]/;

/**
 * Read the heredoc delimiter word at `start`, skipping the whitespace between
 * `<<` and the word. The word is read the way the shell reads it — quotes and
 * the quote characters are removed, and a backslash escapes only the one
 * character after it, so `<<\EOF` ends at `EOF` and `<<'EOF'` ends at `EOF` —
 * because the terminator line is compared against the unquoted text. Returns
 * null when there is no complete word to read, which is not a heredoc we can
 * bound.
 */
function readHeredocDelimiter(text: string, start: number): { delimiter: string; end: number } | null {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) index += 1;
  let delimiter = "";
  let quote = "";
  let sawChar = false;
  while (index < text.length) {
    const char = text[index]!;
    if (quote !== "") {
      if (char === "\\" && quote !== "'") {
        const next = text[index + 1];
        if (next === undefined) return null;
        delimiter += next;
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = "";
        index += 1;
        continue;
      }
      delimiter += char;
      sawChar = true;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return null;
      delimiter += next;
      sawChar = true;
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (SHELL_WORD_BREAK.test(char)) break;
    delimiter += char;
    sawChar = true;
    index += 1;
  }
  if (quote !== "" || !sawChar) return null;
  return { delimiter, end: index };
}

/**
 * The first unquoted heredoc operator in `text`, with the delimiter its body
 * ends at and whether `<<-` strips leading tabs from the terminator line.
 * Quote-aware, so a `<<` inside quotes is text; an escaped `\<` is a literal
 * character rather than an operator; `<<<` is a here-string whose word stays on
 * the same line, so it has no body and is skipped.
 */
function findHeredocOpener(
  text: string,
): { operatorStart: number; operatorEnd: number; delimiter: string; stripTabs: boolean } | null {
  let operatorStart = -1;
  walkShell(text, (char, quote, escaped, delimiter, index) => {
    if (operatorStart !== -1 || quote !== "" || escaped || delimiter || char !== "<") return;
    if (text[index + 1] !== "<" || text[index + 2] === "<") return;
    operatorStart = index;
  });
  if (operatorStart === -1) return null;
  const stripTabs = text[operatorStart + 2] === "-";
  const word = readHeredocDelimiter(text, operatorStart + (stripTabs ? 3 : 2));
  if (word === null) return null;
  return { operatorStart, operatorEnd: word.end, delimiter: word.delimiter, stripTabs };
}

/**
 * Remove every heredoc body before the line is split into commands. A heredoc's
 * body is data, not commands, but it sits on its own lines and the scanner
 * treats a line break as a separator, so without this the body's lines would be
 * judged as unknown programs and a pure read would be flagged.
 *
 * Only the operator and the body lines are removed: the rest of the command
 * line stays, so `cat <<EOF; rm x` still shows the `rm x` after it. A heredoc
 * with no terminator line is left untouched, because an unterminated read
 * cannot be told from the start of a write and must fail closed.
 */
function stripHeredocBodies(text: string): string {
  let result = text;
  for (;;) {
    const opener = findHeredocOpener(result);
    if (opener === null) return result;
    const lineEnd = result.indexOf("\n", opener.operatorEnd);
    if (lineEnd === -1) return result; // No body lines at all: leave it, fail closed.
    let lineStart = lineEnd + 1;
    let terminatorEnd = -1;
    while (lineStart <= result.length) {
      const nextBreak = result.indexOf("\n", lineStart);
      const end = nextBreak === -1 ? result.length : nextBreak;
      const line = result.slice(lineStart, end);
      if ((opener.stripTabs ? line.replace(/^\t+/, "") : line) === opener.delimiter) {
        terminatorEnd = end;
        break;
      }
      if (nextBreak === -1) break;
      lineStart = nextBreak + 1;
    }
    if (terminatorEnd === -1) return result; // Missing terminator: fail closed.
    result =
      result.slice(0, opener.operatorStart) +
      result.slice(opener.operatorEnd, lineEnd) +
      result.slice(terminatorEnd);
  }
}

/** Remove only unquoted, literal stderr discards, never quoted data or fd operands. */
function stripStderrDiscard(command: string): string {
  let result = "";
  let start = 0;
  let boundary = true;
  walkShell(command, (char, quote, escaped, delimiter, index) => {
    if (boundary && quote === "" && !escaped && !delimiter && char === "2") {
      const match = /^2>[ \t]*\/dev\/null(?=$|[\s;|&])/.exec(command.slice(index));
      if (match !== null) {
        result += command.slice(start, index);
        start = index + match[0].length;
      }
    }
    boundary = quote === "" && !escaped && !delimiter &&
      (/[ \t\r\n]/.test(char) || isCommandSeparator(command, index));
  });
  return result + command.slice(start);
}

/**
 * True when every command in a shell line only reads. Output redirects count
 * as work except literal stderr suppression with `2>/dev/null`.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return true;
  const { unquoted, live, segments } = scanCommandLine(stripStderrDiscard(stripHeredocBodies(trimmed)));
  // A redirect writes, whatever the program is. Only unquoted text counts: `echo 'a > b'` writes nothing.
  if (/(^|[^>])>(?!&)/.test(unquoted)) return false;
  if (/\btee\b/.test(unquoted)) return false;
  // `$(...)` and backticks run inside double quotes as well, so they are looked
  // for in every character the shell expands; `<( )`/`>( )` and `( )` are
  // word-level syntax, so `echo "<(x)"` stays a plain argument.
  if (/\$\(|`/.test(live)) return false;
  if (/[<(]\(/.test(unquoted)) return false;

  return segments.every((segment) => isReadOnlySegment(segment.trim()));
}

/** Options whose next word is a literal pattern/format, not a find action. */
const FIND_PATTERN_OPTIONS: ReadonlySet<string> = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
  "-lname", "-ilname", "-regex", "-iregex", "-printf",
]);

/**
 * True when one command in a line only reads.
 *
 * The rule, in order. The program must be one this file models — an allowlisted
 * read-only program, or `git`, `bb` or `env` — because an unmodelled program is
 * work whatever its arguments: `--help` does not launder `rm -rf x --help`, an
 * unknown tool, or a wrapper. Then the program must carry no flag the table
 * records as a write or a runner, and only then may a read flag such as
 * `--help`/`--version` speak for the call. Arguments are read with their quotes
 * removed, because the shell removes them too: `find . '-delete'` deletes.
 *
 * Anything this does not fully model is work, not a read: the fallthrough for
 * an unknown program, the `MUTATING_PROGRAM_FLAGS` table for a known one, and
 * the whole-line checks for redirects, `tee` and substitution. The cost is a
 * nudge on a read the table has no entry for; the alternative is a write that
 * the watchdog exists to catch.
 */
function isReadOnlySegment(segment: string): boolean {
  if (segment === "") return true;
  const tokens = shellWords(segment);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) {
    // An assignment that names a program another command will run is a wrapper
    // in disguise: `PATH=/tmp ls` runs a different `ls`.
    const assignment = tokens[index]!;
    if (ENV_COMMAND_VARIABLES[assignment.slice(0, assignment.indexOf("="))] === true) return false;
    index += 1;
  }
  const program = tokens[index];
  if (program === undefined) return true;
  const name = program.replace(/^.*\//, "");
  const args = tokens.slice(index + 1).filter((token) => !FD_REDIRECT.test(token));
  if (name === "git") {
    // A global option that names a program to run is work, whatever the
    // subcommand reads: `git -c core.pager='touch /tmp/pwned' log` runs it.
    if (gitRunsAProgram(args)) return false;
    // Git answers `--help` before running a plain subcommand, but not before a
    // mixed one: `git config --global user.email x --help` still writes.
    if (!gitHelpIsSafe(args)) return isReadOnlyGitSegment(args);
    return HELP_OR_VERSION.test(segment) || isReadOnlyGitSegment(args);
  }
  // `bb plugin new --help` reports, `bb plugin install x` does not.
  if (name === "bb") return HELP_OR_VERSION.test(segment) || isReadOnlyBbSegment(args);
  if (name === "env") return isReadOnlyEnvSegment(args);
  if (!READ_ONLY_PROGRAMS.has(name)) return false;
  const mutating = MUTATING_PROGRAM_FLAGS[name];
  if (name === "find" && mutating !== undefined) {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (mutating(arg)) return false;
      if (FIND_PATTERN_OPTIONS.has(arg.replace(/^--/, "-"))) index += 1;
    }
    return true;
  }
  return mutating === undefined || !args.some((arg) => mutating(arg));
}

/**
 * `env` only reads when it is not running a program: `env`, `env FOO=1` and
 * `env -i` report, `env rm -rf x` does not.
 * `-u`/`--unset` takes a variable name, so the token after it is not the
 * program. `-S`/`--split-string` is the opposite: its value *is* a command
 * line, so it is judged as one — `env -S 'sh'` runs `sh`.
 */
function isReadOnlyEnvSegment(rest: readonly string[]): boolean {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index]!;
    if (token === "-u" || token === "--unset") { index += 2; continue; }
    if (token === "-S" || token === "--split-string" || token.startsWith("--split-string=")) {
      const value = token.startsWith("--split-string=")
        ? token.slice("--split-string=".length) + " " + rest.slice(index + 1).join(" ")
        : rest.slice(index + 1).join(" ");
      return isReadOnlyCommand(value);
    }
    if (token.startsWith("-") || ENV_ASSIGNMENT.test(token)) { index += 1; continue; }
    break;
  }
  const program = rest[index];
  return program === undefined || isReadOnlySegment(rest.slice(index).join(" "));
}

function isReadOnlyBbSegment(rest: readonly string[]): boolean {
  const area = rest[0];
  if (area === undefined) return true;
  if (area.startsWith("-")) return false;
  if (READ_ONLY_BB_SUBCOMMANDS.has(area)) return true;
  if (area === "skill" || area === "skills") {
    const verb = rest[1];
    return verb === undefined || !MUTATING_SKILL_VERBS.has(verb);
  }
  const verbs = READ_ONLY_BB_VERBS[area];
  if (verbs === undefined) return false;
  const verb = rest[1];
  return verb !== undefined && verbs.has(verb);
}

/** Only an explicit, recorded worker target makes a follow-up delegation. */
function isWorkerFollowup(segment: string, workerThreadIds: readonly string[]): boolean {
  const match = /^(?:\S*\/)?bb\s+thread\s+(?:tell|message)\s+(?:'([A-Za-z0-9_-]+)'|"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))(?=\s|$)/.exec(segment);
  const target = match?.[1] ?? match?.[2] ?? match?.[3];
  return target !== undefined && workerThreadIds.includes(target);
}

/** End of a quoted, non-expanding heredoc; null for unsupported/unfinished input. */
function literalHeredocEnd(command: string, offset: number): number | null {
  const header = /^<<(-?)(?:'([A-Za-z0-9_-]+)'|"([A-Za-z0-9_-]+)")[ \t]*\r?\n/.exec(command.slice(offset));
  if (header === null) return null;
  const delimiter = header[2] ?? header[3]!;
  const stripTabs = header[1] === "-";
  let start = offset + header[0].length;
  while (start <= command.length) {
    const newline = command.indexOf("\n", start);
    const end = newline === -1 ? command.length : newline;
    let line = command.slice(start, end).replace(/\r$/, "");
    if (stripTabs) line = line.replace(/^\t+/, "");
    if (line === delimiter) return end;
    if (newline === -1) break;
    start = newline + 1;
  }
  return null;
}

/** CLI delegation is permitted even in sessions without the native tool. */
function isDelegationCommand(
  command: string,
  allowReadCommands: boolean,
  workerThreadIds: readonly string[],
): boolean {
  // Ordinary shell quoting only; quoted heredoc bodies are literal message data.
  const delegates = (part: string) =>
    /^(?:\S*\/)?bb\s+orchestrator-mode\s+delegate(?:\s|$)/.test(part) ||
    isWorkerFollowup(part, workerThreadIds);
  const segments: string[] = [];
  let segment = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      segment += char;
      escaped = false;
    } else if (quote === "'") {
      segment += char;
      if (char === "'") quote = null;
    } else if (char === "\\") {
      segment += char;
      escaped = true;
    } else if (char === "`" || (char === "$" && (
      command[index + 1] === "(" ||
      (quote === null && (command[index + 1] === "'" || command[index + 1] === '"'))
    ))) {
      return false;
    } else if (quote === '"') {
      segment += char;
      if (char === '"') quote = null;
    } else if (char === "'" || char === '"') {
      segment += char;
      quote = char;
    } else if (char === "<" && command[index + 1] === "<") {
      if (!isWorkerFollowup(segment.trim(), workerThreadIds)) return false;
      const end = literalHeredocEnd(command, index);
      if (end === null) return false;
      segments.push(segment.trim());
      segment = "";
      index = end;
    } else if (/[<>()]/.test(char)) {
      return false;
    } else if (char === "&" && command[index + 1] !== "&") {
      return false;
    } else if (/[;|&\n\r]/.test(char)) {
      segments.push(segment.trim());
      segment = "";
      if ((char === "&" || char === "|") && command[index + 1] === char) index += 1;
    } else {
      segment += char;
    }
  }
  if (quote !== null || escaped) return false;
  segments.push(segment.trim());
  return segments.some(delegates) && segments.every((part) =>
    part === "" || delegates(part) || (allowReadCommands && isReadOnlyCommand(part)),
  );
}

/**
 * Classify one timeline row. Returns a violation when the row is the
 * orchestrator doing the work itself, or null when it is allowed.
 */
export function classifyRow(
  row: WorkRowLike & { id: string; turnId?: string | null },
  options: Partial<ClassifierOptions> = {},
): Violation | null {
  const { allowReadCommands, workerThreadIds = [] } = { ...DEFAULT_CLASSIFIER_OPTIONS, ...options };
  if (row.kind !== "work") return null;
  const workKind = row.workKind ?? "";
  if (ALWAYS_ALLOWED.has(workKind)) return null;
  const turnId = row.turnId ?? null;
  const base = {
    id: row.id,
    turnId,
    workKind,
    detectedAt: Date.now(),
  };

  if (workKind === "file-change") {
    const path = row.change?.path ?? "a file";
    return { ...base, detail: `changed ${path} itself` };
  }

  if (workKind === "image-generation") {
    return { ...base, detail: "generated an image itself" };
  }

  if (workKind === "command") {
    // A malformed row must not throw out of the scan loop: a non-string command reads as no command at all.
    const command = typeof row.command === "string" ? row.command.trim() : "";
    if (isDelegationCommand(command, allowReadCommands, workerThreadIds)) return null;
    if (allowReadCommands && command !== "" && isReadOnlyCommand(command)) {
      return null;
    }
    // Some providers render a plugin tool call as a command row whose text is
    // the call's title. That is not the orchestrator running anything, and
    // flagging it tells the orchestrator off for using the tools this plugin
    // gave it, which is the fastest way for a watchdog to lose its authority.
    if (command !== "" && looksLikeTitleRow(command)) {
      return null;
    }
    const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
    return {
      ...base,
      detail: shown === "" ? "ran a shell command itself" : `ran \`${shown}\``,
    };
  }

  if (!ALWAYS_WORK.has(workKind)) {
    // A generic tool row: the provider's own vocabulary. Judge it by name.
    const toolName = row.toolName ?? null;
    if (toolName === null) return null;
    if (!MUTATING_TOOL_PATTERN.test(toolName)) return null;
    return { ...base, detail: `called \`${toolName}\` itself` };
  }

  return { ...base, detail: `did the work itself (${workKind})` };
}

// ---------------------------------------------------------------------------
// The contract the agent is handed
// ---------------------------------------------------------------------------

/**
 * The three contract shapes. Each changes what a session does with its own hands:
 * `standard` delegates and checks a unit only when a report cannot settle it,
 * `review-heavy` puts an independent check unit in front of every unit, and
 * `delegate-only` hands the reading over too and runs no shell commands at all.
 */
export const CONTRACT_PRESETS = ["standard", "review-heavy", "delegate-only"] as const;
export type ContractPresetId = (typeof CONTRACT_PRESETS)[number];

/**
 * One line per level, so the settings row explains every level rather than only the
 * one in force. Each opens with the preset's own name, which is the convention the
 * row relies on to emphasise it.
 */
export const CONTRACT_PRESET_DESCRIPTIONS: Record<ContractPresetId, string> = {
  standard:
    "Standard delegates the work, reviews what comes back, and checks a unit only when a report cannot settle it.",
  "review-heavy":
    "Review-heavy puts an independent check unit in front of every unit. Each one runs what the unit claims, so it roughly doubles the work in flight.",
  "delegate-only":
    "Delegate-only hands the reading over too. The orchestrator runs no shell commands, and finding things out is a unit of work.",
};

/**
 * How much appended instruction text the plugin accepts. `configure` truncates
 * the whole block at 4096 characters, and the tail is the part that explains
 * what to do when delegation is impossible, so the append is capped below the
 * worst case the contract itself reaches: the budget test measures that case
 * with an append at exactly this length, which is what keeps this number
 * honest when the contract grows.
 */
export const EXTRA_INSTRUCTION_LIMIT = 370;

/** `bb.agents.configure` truncates the dynamic instructions at this many characters. */
export const INSTRUCTION_LIMIT = 4096;

/** One reminder line, so a long file path cannot crowd out the contract it corrects. */
const REMINDER_LINE_LIMIT = 120;

interface InstructionInput {
  enforcement: EnforcementLevel;
  allowReadCommands: boolean;
  /** Extra lines a caller wants appended, e.g. recent violations. */
  reminders?: readonly string[];
  /** The worker configuration this plugin stores; absent means inherit. */
  workerConfig?: WorkerConfig;
  /** Project rules the user appended, emitted verbatim and last. */
  extra?: string;
  /** Which level of contract to emit. Defaults to `standard`. */
  preset?: ContractPresetId;
  /**
   * Whether the contract invites per-delegation model choice. `pinned` — the
   * default — says the opposite: every worker runs on the stored execution, and
   * `delegate` refuses the arguments that would move one off it.
   */
  modelPolicy?: WorkerModelPolicy;
  /**
   * Where the scope's units run. `worktree` and `mixed` add a section on what a
   * worktree leaves behind and how it lands; `shared` says nothing.
   */
  workspace?: "shared" | "worktree" | "mixed";
}

/**
 * One sentence naming the execution the workers get, or the fact that this
 * plugin overrides nothing. Kept next to the contract it is spliced into, and
 * deliberately short: `configure` truncates the whole block at 4096 characters.
 */
function workerBudget(config: WorkerConfig | undefined): string {
  const exec = config ?? {};
  const parts = [
    exec.model === undefined ? null : `model \`${exec.model}\``,
    exec.providerId === undefined ? null : `provider \`${exec.providerId}\``,
    exec.reasoningLevel === undefined
      ? null
      : `reasoning \`${exec.reasoningLevel}\``,
    exec.serviceTier === undefined ? null : `tier \`${exec.serviceTier}\``,
    exec.permissionMode === undefined
      ? null
      : `permission mode \`${exec.permissionMode}\``,
  ].filter((part): part is string => part !== null);
  const execution =
    parts.length === 0
      ? "Workers run on this project's own execution defaults."
      : `Workers default to ${parts.join(", ")}, set by this plugin.`;
  const fallback = exec.fallback;
  if (fallback === undefined) return execution;
  // The orchestrator must not re-do a failed worker's unit by hand: the
  // delegation call already retried it.
  return `${execution} A failed worker is retried once on \`${fallback.model ?? "the project default"}\` first.`;
}

/**
 * The orchestrator contract injected through `bb.agents.configure`.
 *
 * Hard cap: `configure` truncates dynamic instructions at 4096 characters, so
 * this must stay comfortably under it. `shared.test.ts` asserts the budget.
 */
export function buildInstructions(input: InstructionInput): string {
  const watching =
    input.enforcement === "instruct"
      ? "This is a standing contract; nothing is watching your tool calls."
      : input.enforcement === "guard"
        ? "A watchdog reads your timeline. Every direct-work act is recorded and reported back, and you will be told to re-delegate it."
        : "A watchdog reads your timeline and STOPS the turn the moment you do direct work. Work you did yourself is thrown away.";

  const savedKinds = WORKER_PRESETS.filter(
    (name) => input.workerConfig?.presets?.[name] !== undefined,
  );
  const savedPresets =
    savedKinds.length === 0
      ? ""
      : ` Saved worker kinds: ${savedKinds.join(", ")}; name one as \`preset\` for a unit of that kind.`;

  const preset = input.preset ?? "standard";
  // `delegate-only` takes the reading out of the orchestrator's hands entirely: the
  // question goes to a worker, and the shell goes away with it.
  const research =
    preset === "delegate-only"
      ? "\n   Even finding things out is a unit of work. Hand a worker the question instead of searching yourself."
      : "";
  const reviewStep =
    preset === "review-heavy"
      ? `4. Every unit gets checked before you trust it: delegate it with \`verify: true\` so an
   independent worker runs what it claims (the tests, the command, the paths) and
   reports raw output, then record a verdict on it with the \`${REVIEW_TOOL}\` tool.
   Re-delegate a failed check; never patch it yourself.`
      : `4. Record a verdict on every worker with the \`${REVIEW_TOOL}\` tool. Pass
   \`verify: true\` for a unit whose result you cannot judge from its report: that
   adds a check unit. Send a wrong or incomplete result back to a worker; never
   patch it yourself.`;

  /**
   * What a worktree leaves behind, and how it lands. Only emitted when the scope
   * can produce one: the orchestrator cannot merge by hand without the watchdog
   * calling it work, so the section says to delegate the merge instead.
   */
  const workspaceRule =
    input.workspace === "worktree"
      ? `\n\n   Units run in their own worktrees, so nothing a worker writes reaches your\n   checkout until it is merged. To land one, delegate the merge as its own unit\n   with \`workspace: "shared"\`, naming the branch.`
      : input.workspace === "mixed"
        ? `\n\n   Name where each unit runs: \`workspace: "shared"\` edits your checkout at once,\n   \`workspace: "worktree"\` keeps it on a branch. Give a worktree to a unit that\n   would touch files another unit touches, or should not disturb the working tree.\n   To land one, delegate the merge as its own unit with \`workspace: "shared"\`.`
        : "";

  const commands = input.allowReadCommands && preset !== "delegate-only"
    ? "Read-only shell commands are allowed for orientation. Literal stderr suppression (`2>/dev/null`) is allowed; other output redirects count as work."
    : "Only CLI delegation commands may run; read-only shell exploration is disabled.";

  /**
   * What the contract says about whose model a worker runs on. A pinned scope —
   * the default — gets the rule that replaces the invitation: the stored
   * execution is the only one, plus any stored kind, because naming a raw model
   * is what moves a worker off that execution.
   */
  const pinned = input.modelPolicy !== "flexible";
  const modelBudget = pinned
    ? `${workerBudget(input.workerConfig)} Every worker runs on that execution${savedKinds.length === 0 ? "" : ", or on a stored kind it names as \`preset\`"}: do not pass \`model\`, \`provider\` or \`reasoning\` on a delegation.${savedPresets}`
    : `${workerBudget(input.workerConfig)} Override per delegation with \`model\`,
\`provider\` (alias \`providerId\`), \`reasoning\` and \`permissionMode\`. Give a hard unit a stronger
model, a mechanical one a cheaper one.${savedPresets}`;
  const pinLine = pinned
    ? ""
    : "   Pin with `--provider <id> --model <id>`; pinning does not require turning this mode off.\n";

  const reminderLines = (input.reminders ?? [])
    .slice(-5)
    .map((line) => (line.length > REMINDER_LINE_LIMIT ? `${line.slice(0, REMINDER_LINE_LIMIT - 3)}...` : line));
  const reminderBlock = (lines: readonly string[]): string =>
    lines.length === 0
      ? ""
      : `\n\nYou have already broken this contract in this thread:\n${lines.map((line) => `- ${line}`).join("\n")}`;

  const render = (lines: readonly string[], extra = input.extra): string => `# ORCHESTRATOR MODE IS ON FOR THIS THREAD

You are an orchestrator: you do not do the work. Every unit goes to a worker
thread, and your output is the plan, the delegation and the synthesis.

${watching}

## Do not do the work yourself

- Creating, editing, moving or deleting any file.
- Generating images instead of delegating their creation.
- Running a command that changes anything: builds, installs, tests, commits,
  migrations, formatters.
- Writing code yourself, even a one-line fix, even when a worker would be slower.
- Fixing up a worker's output by hand instead of sending it back to a worker.

${commands}

## How you work instead
${workspaceRule}
1. Understand the request. Read and search freely; ask when the goal is
   ambiguous.${research}
2. Give each unit a self-contained brief: goal, context, constraints and
   definition of done. A worker cannot see this conversation.
3. Delegate with \`${DELEGATE_TOOL}\`; if unavailable, use
   \`bb orchestrator-mode delegate --task 'complete brief'\`.
   Quote briefs safely; \`--no-wait\` fans out independent units. Resuming a
   provider session may retain its original tool list.
${pinLine}${reviewStep}
   Send corrections with \`bb thread tell <worker-id> ...\` (alias \`message\`) to
   recorded workers; safely quoted messages or quoted stdin heredocs are delegation.
5. Synthesise results and what remains. Link worker ids so the user can open them.

## When you may act directly

Only reading, searching, planning, asking, delegating and reporting. Before a
tool that changes something, stop and delegate.

## Choosing the worker's model

${modelBudget} Ids come from
\`bb provider list\` and \`bb provider models <provider>\`; both are read-only.

${extraBudget(extra)}## If you cannot delegate

Say so plainly and stop. "I cannot do this without doing the work myself" is a
correct answer; doing the work is not. Do not argue with the mode; ask the user
to turn it off in the composer if it is wrong.${reminderBlock(lines)}`;

  const whole = render(reminderLines);
  if (whole.length <= INSTRUCTION_LIMIT) return whole;
  // BB cuts the dynamic block at the ceiling and the tail is what disappears, so the reminders are trimmed here
  // instead: the contract has to arrive whole, and the newest reminders are the ones worth keeping.
  for (let keep = reminderLines.length - 1; keep >= 0; keep -= 1) {
    const candidate = render(reminderLines.slice(reminderLines.length - keep));
    if (candidate.length <= INSTRUCTION_LIMIT) return candidate;
  }
  // Nothing left to give up but the project-rules append, so it is clamped by what the
  // fixed sections left behind. Returning the unclamped block would hand BB more than it
  // keeps, and it cuts the tail — which is the part that says what to do when delegation
  // is impossible. A slicing fallback survives only if the fixed sections alone exceed the
  // ceiling, which the budget test measures with the longest model id the catalog holds.
  const base = render([]);
  if (base.length <= INSTRUCTION_LIMIT) return base;
  const excess = base.length - INSTRUCTION_LIMIT;
  const extra = (input.extra ?? "").slice(0, Math.max(0, (input.extra ?? "").length - excess));
  const clamped = render([], extra);
  return clamped.length <= INSTRUCTION_LIMIT ? clamped : clamped.slice(0, INSTRUCTION_LIMIT);
}

/**
 * The brief a verification unit gets. The verifier cannot see the parent
 * conversation, so it carries the original brief, what the first worker said it
 * did, and what to report. It is told to inspect and report, never to fix: a
 * verifier that repairs the work destroys the evidence of whether it was right.
 */
export function buildVerifierBrief(input: {
  task: string;
  workerTitle: string;
  workerOutput: string | null;
}): string {
  const trim = (text: string, limit: number): string =>
    text.length > limit ? `${text.slice(0, limit)}\n\n[truncated]` : text;
  const claimed =
    input.workerOutput === null || input.workerOutput.trim() === ""
      ? "(the worker reported no final text)"
      : trim(input.workerOutput.trim(), 8_000);
  return `# Check another worker's work

A worker was asked to do this, and reported back:

## The brief it was given

${trim(input.task, 8_000)}

## What it reported ("${input.workerTitle}")

${claimed}

## What to do

Verify the work against the brief by going after it, not by reading the report:
run the tests, the command or the steps the brief names, look at the files it
claims to have touched, and try to find the case it gets wrong. Do not trust the
report alone, and do not fix anything: an unverified claim and a missing change
are both findings.

Report, in this order:

1. What you actually ran and inspected (exact commands and paths, with their raw
   output — paste it, do not summarise it).
2. What is correct.
3. What is wrong, missing or unverified, each with the evidence, and what you
   tried that did not falsify the claim.
4. A final line: \`VERDICT: pass\` or \`VERDICT: fail\`, then one sentence of
   reasoning.

Do not modify any file. If the work is wrong, say so plainly.`;
}

/**
 * The user's appended rules, under a heading that names where they come from.
 * Kept after the plugin's own sections so a project rule adds to the contract
 * rather than silently replacing the parts the watchdog enforces.
 */
function extraBudget(extra: string | undefined): string {
  const text = extra?.trim() ?? "";
  return text === "" ? "" : `## Rules for this project\n\n${text}\n\n`;
}

/**
 * The corrective message sent when a turn ended with workers nobody judged.
 * Deliberately separate from {@link buildNudge}: that one is about doing the
 * work yourself, and telling an orchestrator off for the wrong thing is how a
 * watchdog loses its authority.
 */
export function buildReviewNudge(
  unreviewed: readonly string[],
  enforcement: EnforcementLevel,
): string {
  const acts = unreviewed
    .slice(0, 5)
    .map((title) => `- ${title}`)
    .join("\n");
  const stopped =
    enforcement === "block"
      ? " This turn had already finished, so nothing was stopped: the review gate cannot stop a turn that is over."
      : "";
  return `Orchestrator review is missing:${stopped}

${acts}

You finished the turn without recording a verdict for these workers. Call
\`${REVIEW_TOOL}\` once per worker, with \`accepted\` or \`rejected\` and a line of
notes, then fold the verdicts into your report. A rejected result is
re-delegated to a worker, never fixed by you.`;
}

/** The corrective message sent after a detected violation. */
export function buildNudge(violations: readonly Violation[], enforcement: EnforcementLevel): string {
  const acts = violations
    .slice(0, 5)
    .map((violation) => `- ${violation.detail}`)
    .join("\n");
  const stopped =
    enforcement === "block"
      ? " The turn was stopped, so any change you made mid-flight may be incomplete."
      : "";
  const missingTool =
    `\n\nIf \`${DELEGATE_TOOL}\` is unavailable, use \`bb orchestrator-mode delegate --task 'complete brief'\` instead. It runs the same delegation action. Resuming a session may retain its original tools; no context reset is needed for this CLI route.`;
  return `Orchestrator mode caught you doing the work yourself:${stopped}

${acts}

Do not continue that work and do not clean it up yourself. Re-delegate it: give
a worker thread a self-contained brief with \`${DELEGATE_TOOL}\`, then synthesize
what comes back. If the work genuinely cannot be delegated, say so and stop.
If orchestrator mode is wrong for this thread, ask the user to turn it off in
the composer rather than working around it.${missingTool}`;
}
