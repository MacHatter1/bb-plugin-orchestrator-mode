// bb-plugin-orchestrator-mode — policy shared by the backend and the frontend.
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

export const ENFORCEMENT_LEVELS: readonly EnforcementLevel[] = [
  "instruct",
  "guard",
  "block",
];

export const DEFAULT_ENFORCEMENT: EnforcementLevel = "guard";

/** One-line description of each level, for the composer, CLI and settings UI. */
export const ENFORCEMENT_DESCRIPTIONS: Record<EnforcementLevel, string> = {
  instruct: "Contract only: inject the orchestrator rules into every turn.",
  guard:
    "Contract + watchdog: detect direct work, record it and correct the agent.",
  block:
    "Contract + watchdog + stop: halt the turn the moment it does direct work.",
};

export function isEnforcementLevel(value: unknown): value is EnforcementLevel {
  return (
    typeof value === "string" &&
    (ENFORCEMENT_LEVELS as readonly string[]).includes(value)
  );
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
export type OrchestratorMirror = {
  /** True while this thread must orchestrate instead of working. */
  enabled: boolean;
  /** Per-thread override, or null to follow the plugin setting. */
  enforcement: EnforcementLevel | null;
  /** Marks the mirror as ours, so a stale value from another writer is ignored. */
  source: "orchestrator-mode";
};

export const MIRROR_SOURCE = "orchestrator-mode" as const;

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
  status?: string | undefined;
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

export interface ClassifierOptions {
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

/** Shell metacharacters that split one command line into separate commands. */
const COMMAND_SEPARATORS = /(?:&&|\|\||[;|&\n\r])/;

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

/** Mixed Git subcommands need an explicit query form, not just a known name. */
function isReadOnlyGitSegment(rest: readonly string[]): boolean {
  const [subcommand, ...args] = rest;
  if (subcommand === undefined) return true;
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
    return args.some((arg) => arg === "--get" || arg === "--list" || arg === "-l");
  }
  return READ_ONLY_GIT_SUBCOMMANDS.has(subcommand);
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
  provider: new Set(["list", "models"]),
  plugin: new Set(["list", "logs", "source", "search", "rpc", "outdated"]),
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

/**
 * True when every command in a shell line only reads. Output redirects count
 * as work except literal stderr suppression with `2>/dev/null`.
 */
export function isReadOnlyCommand(command: string): boolean {
  // Match the complete literal target, not /dev/null-output, a glob, or an
  // expanded/concatenated filename. Everything else keeps the redirect veto.
  const trimmed = command.trim().replace(
    /(^|[\s;|&])2>[ \t]*\/dev\/null(?=$|[\s;|&])/g,
    "$1",
  );
  if (trimmed === "") return true;
  if (/(^|[^>])>(?!&)/.test(trimmed) || />>/.test(trimmed)) return false;
  if (/\btee\b/.test(trimmed)) return false;
  // Command substitution can hide anything.
  if (/\$\(|`|[<>]\(/.test(trimmed)) return false;

  const segments = trimmed.split(COMMAND_SEPARATORS);
  return segments.every((segment) => isReadOnlySegment(segment.trim()));
}

const FIND_WORK_ACTIONS: ReadonlySet<string> = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

/** Options whose next word is a literal pattern/format, not a find action. */
const FIND_PATTERN_OPTIONS: ReadonlySet<string> = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename",
  "-lname", "-ilname", "-regex", "-iregex", "-printf",
]);

function isReadOnlySegment(segment: string): boolean {
  if (segment === "") return true;
  const tokens = segment.split(/\s+/);
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index += 1;
  const program = tokens[index];
  if (program === undefined) return true;
  const name = program.replace(/^.*\//, "");
  if (name === "find") {
    // Keep quoted patterns together, and recognise quoted/escaped action
    // flags too. Suppressing errors never makes delete/exec/file-output safe.
    const words = segment.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g) ?? [];
    const args = words.slice(index + 1).map((word) => word.replace(/['"\\]/g, ""));
    for (let arg = 0; arg < args.length; arg += 1) {
      if (FIND_WORK_ACTIONS.has(args[arg]!)) return false;
      if (FIND_PATTERN_OPTIONS.has(args[arg]!)) arg += 1;
    }
    return true;
  }
  // `foo --help`, `foo -h` and `foo --version` report; they never mutate.
  if (HELP_OR_VERSION.test(segment)) return true;
  if (name === "git") return isReadOnlyGitSegment(tokens.slice(index + 1));
  if (name === "bb") return isReadOnlyBbSegment(tokens.slice(index + 1));
  return READ_ONLY_PROGRAMS.has(name);
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
    const command = (row.command ?? "").trim();
    if (isDelegationCommand(command, allowReadCommands, workerThreadIds)) return null;
    if (allowReadCommands && command !== "" && isReadOnlyCommand(command)) {
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

export interface InstructionInput {
  enforcement: EnforcementLevel;
  allowReadCommands: boolean;
  /** Extra lines a caller wants appended, e.g. recent violations. */
  reminders?: readonly string[];
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
        ? "A watchdog reads your timeline. Every direct-work act is recorded and reported back to you, and you will be told to re-delegate it."
        : "A watchdog reads your timeline and STOPS the turn the moment you do direct work. Work you did yourself is thrown away.";

  const commands = input.allowReadCommands
    ? "Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`, `git log`, `find`, `wc`, `bb status`, `bb provider list`, `bb provider models`) are allowed so you can orient yourself. Literal stderr suppression (`2>/dev/null`) is allowed; other output redirects count as work. Anything that writes, builds, installs, commits or otherwise changes state is not."
    : "Only CLI delegation commands may run; read-only shell exploration is disabled.";

  const reminders =
    input.reminders === undefined || input.reminders.length === 0
      ? ""
      : `\n\nYou have already broken this contract in this thread:\n${input.reminders
          .slice(-5)
          .map((line) => `- ${line}`)
          .join("\n")}`;

  return `# ORCHESTRATOR MODE IS ON FOR THIS THREAD

You are an orchestrator. You do not do the work. Every unit of actual work is
handed to a worker thread, and your own output is the plan, the delegation, and
the synthesis of what came back.

${watching}

## Forbidden — doing the work yourself

- Editing, creating, overwriting, moving or deleting any file.
- Generating images instead of delegating their creation.
- Running a command that changes anything: builds, installs, tests, git commits
  and pushes, code generation, migrations, formatters, scripts.
- Writing the implementation yourself, even "just this one small fix", even
  inside a reply, even when the worker would take longer.
- Fixing up a worker's output by hand instead of sending it back to a worker.

${commands}

## Required — how you work instead

1. Understand the request. Read and search freely; ask the user when the goal
   is ambiguous.
2. Decompose it into independent units of work with explicit, self-contained
   briefs. A worker cannot see this conversation, so each brief carries its own
   goal, context, constraints and definition of done.
3. Delegate every unit with the \`${DELEGATE_TOOL}\` tool. If it is unavailable,
   use \`bb orchestrator-mode delegate --task 'complete brief'\` instead; this
   runs the same delegation action without needing a new provider tool.
   Quote the brief safely; use \`--no-wait\` to fan out independent units.
   To pin workers before they start, pass \`providerId\` and \`model\` to the
   tool, or \`--provider <id> --model <id>\` to the CLI. Use registered provider
   and model IDs; pinning does not require turning this mode off.
   Resuming a provider session may retain its original tool list.
4. Review what comes back. Send corrections to recorded workers with
   \`bb thread tell <worker-id> ...\` (alias \`message\`); safely quoted messages
   or quoted stdin heredocs are delegation. Never patch the work yourself.
5. Report by synthesizing: what was delegated, what each worker produced, what
   is left. Link worker threads by id so the user can open them.

## When you may act directly

Only these: reading, searching, planning, asking the user a question,
delegating, and reporting. If you are about to call a tool that changes
something, stop and delegate it instead.

## If you cannot delegate

Say so plainly and stop. "I cannot do this without doing the work myself" is a
correct answer; doing the work yourself is not. Do not disable or argue with
this mode — ask the user to turn it off in the composer if it is wrong.${reminders}`;
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
