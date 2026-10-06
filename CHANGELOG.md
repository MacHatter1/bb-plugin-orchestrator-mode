# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.2 - 2026-10-06

### Changed

- The settings section is scoped end to end. **Settings → Installed plugins →
  Orchestrator Mode → Settings** now opens with **Scope**, and everything below it —
  enforcement, read-only commands, the reminder and fan-out caps, the contract shape, the
  worker retention policy, the worker execution, the execution presets and the appended
  rules — reads and writes the selected scope. Global is the record every project
  inherits; a project stores only what it changes, and Inherit hands a field back.
  `bb orchestrator-mode scope --global` reads and writes the global record for scripts,
  and refuses the flags whose global values have their own commands (`worker`, `contract
  --rules`). The plugin renders this surface itself and stores the values in its own KV
  record, because a BB settings descriptor holds one value per install and these resolve
  per project; `bb plugin config orchestrator-mode` no longer lists them. Existing
  installs carry the same defaults, so nothing visible changes until a value is edited.
  `defaultForNewThreads` stays global — it is a composer default, not thread behaviour —
  and its row appears only in Global scope.

- Settings rows explain every choice, not only the one in force: enforcement, read-only
  commands, the contract level, the worker retention policies and the new-thread default
  each list what every option does, and the numeric rows carry the description the
  descriptor form used to hold. A `select` cannot explain the options it is not on, so the
  row carries the list; the option's own name is emphasised where the sentence already
  starts with it.

### Added

- **Mixed checkouts.** `workerWorkspace` gained `mixed`: the orchestrator decides
  per delegation, every call must name `workspace: "shared"` or
  `workspace: "worktree"`, and the contract says to give a worktree to a unit that
  would touch files another unit is touching. An unnamed choice is refused with
  both options spelled out, since a silent default would make mixed behave like
  shared.

- **Worktrees for delegated units.** A scope's `workerWorkspace` (`shared`
  by default, `worktree` per delegation) decides where a unit runs. A worktree
  delegation gets its own git worktree and branch, created by BB from the project's
  default branch on the orchestrator's own machine; its check unit and any fallback
  retry reuse that environment, so all three work in one checkout. The result names
  the branch and the environment id (`bb environment diff <id>` shows the change),
  and nothing lands in the main checkout until it is merged. Worktrees only hold
  tracked files, so a repo needs a committed `.bb-env-setup.sh` before a check unit
  can run its tests. The contract says how a worktree lands: the orchestrator
  cannot merge by hand without the watchdog counting it as work, so it delegates a
  merge unit with `workspace: "shared"` or names the branch for the user.

- Per-project configuration. The plugin settings, the worker execution, the execution
  presets and the appended rules now resolve thread → project → global → built-in
  default, and **Settings → Installed plugins → Orchestrator Mode** gains a scope
  selector listing Global plus every project, with each field showing whether it
  is overridden and an Inherit action that hands it back. A project that overrides
  nothing behaves exactly as before. `bb orchestrator-mode scope` reads and writes the
  same overrides, and `status --thread` names the scope and the overridden fields, so a
  surprising cap or contract is traceable to the layer that set it. `defaultForNewThreads`
  stays global: it is a composer default, not thread behaviour.

- The contract shape is three levels instead of five presets: `standard` (delegate and review, with a check unit only where a report cannot settle a unit), `review-heavy` (an independent check unit in front of every unit) and `delegate-only` (no shell commands at all, reading handed to workers). Each level changes what a session does with its own hands rather than reword one sentence. A key an earlier build of this branch wrote is ignored, and a stored `contractPreset` that is not one of the three levels resolves to `standard`.
- The contract names the worker execution presets you have actually stored (`Saved worker
  kinds: build, review; name one as \`preset\` for a unit of that kind.`), and says nothing when
  none are, so the pre-delegation override the tool already accepted is discoverable from the
  instructions rather than only from the tool schema. The added sentence is paid for by trimming
  prose in the same block: the worst case measured (five reminders, a full project-rules append,
  a complete worker configuration, and presets in every kind) went from 6 to 127 characters of
  headroom under `configure`'s 4096-character ceiling, and the budget test now builds that case.

### Fixed

- Treat `bb thread tell`/`message` follow-ups to recorded workers as delegation,
  including literal quoted stdin heredocs, without allowing local shell work.
- Allow literal `2>/dev/null` stderr suppression on read-only commands without
  flagging exploratory `find` queries, while rejecting file-output redirects
  and mutating `find` actions.
- Allow explicit provider/model pins in the delegation tool and CLI before
  workers start, so provider-constrained personas can keep orchestrator mode on.

- CLI delegation shares the native tool's worker handler, including caps,
  verification and retention. Both routes honour project worker execution,
  and active mode-change notifications use the project's complete contract.

- Git's program-running global options remain work after `-C`, `--git-dir`,
  `--work-tree` or `--namespace` operands. Ordinary reads still pass, including
  operands whose literal values look like those execution options.

- The read-only classifier is sound before permissive. A line is now only
  read-only when every program in it is one the module models and no argument
  can make it write, because a missed work act is the harm the watchdog exists
  to prevent. Closed against a real-`bash` oracle: `--help`/`--version` no
  longer launder a program the module does not know or a flag that writes
  (`unknown-tool --help`, `rm -rf x --help`, `find . -delete --help`);
  `--help` cannot stand in for the read check on the mixed `git` subcommands
  (`git config --global user.email x --help` writes first); the scanner tracks
  backslash escapes and `$'...'` quoting, so `echo \" ; rm x` no longer hides
  the command after the escaped quote; command substitution inside double
  quotes is caught (`find . -name "$(touch x)"`); a heredoc delimiter read with
  backslash quoting is bounded correctly (`cat <<\EOF` ends at `EOF`, so the
  lines past the real terminator are still judged); quoted flags are still
  flags (`find . '-delete'`, `git diff '--output=pat.ch'`); value-attached and
  clustered write flags are refused (`date -s2020`, `yq -i'.a=1'`,
  `tree -oFILE`, `file --compile`, `fd -xrm`, `find --exec`); `tree -o`/
  `--output`, `less -o`/`-O`/`--log-file`/`--save-marks`/`+!cmd` and
  `bat`/`ag --pager` join the write table; `env -S`/`--split-string` is judged
  as the command line it is (`env -S 'sh'` runs `sh`); a leading assignment
  that names a program the shell or a tool runs later (`PATH`, `PAGER`,
  `GIT_EXTERNAL_DIFF`, `EDITOR`, `LD_PRELOAD`, `GIT_DIR`, …) is work; and a
  file-descriptor redirect is not an argument, so `hostname -f 2>&1` reads as
  `hostname -f`. Measured on a 60,000-line generated corpus under real
  `/bin/bash` with only the allowlist on `PATH`: 0 unsound read-only
  classifications (3,062 for the previous classifier on the same lines), and
  the accusation rate on genuinely read-only lines fell from 23.7% to 2.2%
  because the same pass fixed pre-existing misreads of quoted words, escaped
  separators, fd redirects and backslash-quoted heredocs. 66 regression cases
  cover the defects.
- A redirection's `&` is no longer a command separator: `ls 2>&1`, `git log >&2`
  and `ls 2>&-` are read-only again, while `&&` and a standalone `&` still
  separate, and a real redirect (`ls 2>&1 > out.txt`, `ls &> out.txt`) is still
  a write.
- `git diff --output-indicator-new='+'`/`--output-indicator-old='-'` are
  read-only display flags again; only `--output=<file>` and `--output <file>`
  count as a write.
- The shell-command doc comment now states the real rule and the known residual:
  a detached capitalised program with a lowercase argument (`Gradlew build`,
  `Just test`) reads as prose and is missed; its lowercase and path forms are
  still work.
- The direct-work classifier no longer reads a destructive or program-running
  command as read-only: `find -delete/-exec/-fprint/-ok`, `fd -x/-X`, `rg --pre`,
  `env <program>`, `yq -i`, `date -s`, `hostname <name>`, `git config --list
  --unset`, a `git diff --output=` write, process substitution (`<(cmd)`), and
  `git` global options before the subcommand (`git -C dir status` now reads as a
  query, not as a command). Quoted metacharacters are arguments: `rg "a|b"`,
  `grep 'a;b'` and `echo 'a > b'` are read-only again. A mixed `find`/`rg`/`fd`/
  `yq` form that carries both a read action and a writing one is work.
- A malformed timeline row can no longer wedge the watchdog: a non-string
  `command` is judged as work instead of throwing, a row that throws is logged
  and skipped, and a non-numeric `maxSeq` no longer poisons the cursor.
- A row id reused by a later turn is judged again, so the second turn's work is
  not silently dropped as a redelivery.
- The orchestrator contract can no longer exceed `configure`'s 4096-character
  ceiling: the reminder block is trimmed to fit, so the thread receives the whole
  contract instead of a silent truncation of its tail.
- The fan-out caps are enforced under concurrency: the check runs in the same
  queue as the writes and counts the claims already in flight, so two
  simultaneous delegations cannot both pass `maxParallelWorkers` or
  `maxDelegationsPerTurn`. The per-turn cap also applies before a thread's first
  dispatch, counted from when the mode was enabled.
- The review gate claims its reminder atomically, so two events for the same
  unjudged set send one reminder and spend one of the budget; a failed send gives
  the reminder back.
- `orchestrator_delegate` refuses a delegation once the thread's mode is off.
- A null, partial or foreign state row is tolerated everywhere (including the
  agent-configuration path), reading as defaults instead of failing the RPC, the
  CLI or the composer.
- The delegation record keeps every worker still owed a verdict when it is
  trimmed, so a late verdict is not refused for a record that aged out.
- The command classifier tells a provider's prose tool-call title from a
  command by the first token rather than by shell punctuation, so
  `Recording verdict for src/app.ts` and `Running the build (2 files)` are no
  longer violations, while an unknown program (`gradlew build`, `just test`,
  `flutter build apk`) is work in both read modes and the title rule never
  excuses a command-shaped row when read-only commands are disallowed.
- The first post-enable turn is excused even when its rows carry no
  `startedAt` (a partial or delta row), and a historical row with an earlier
  timestamp no longer spends that grace slot.
- Block mode stops and nudges the live turn, not the first violation's turn,
  and two turns whose rows carry no `turnId` no longer collapse into one
  sentinel that suppressed every stop after the first.
- A delivered work row without a string `id` is judged rather than dropped,
  keyed by its sequence so a redelivery is still deduped.
- A malformed element inside a stored `violations`, `delegations`, `seenRowIds`
  or `graceTurnIds` array is dropped on read instead of reaching the contract,
  the RPC output or an event handler; a non-numeric `touchedAt` falls back to 0
  so pruning stays least-recently-touched.
- `bb orchestrator-mode worker --preset <name>` with no execution flags reports
  the current configuration instead of storing an empty preset entry.

### Added

- **Worker execution control.** A **Worker execution** settings section with a
  switch that opens BB's own provider and model picker, plus matching
  `provider`, `model`, `reasoning` and `permissionMode` arguments on
  `orchestrator_delegate`, so a worker thread can run on a chosen model and
  permission mode instead of inheriting the project default. Picking a provider
  scopes the model list to that provider, and one pick resolves provider, model,
  reasoning level and service tier as a single value, the same value
  `threads.spawn` takes, which is why the choice is stored by the plugin rather
  than as a settings `select` whose options cannot depend on another. Every
  requested field is stamped in `threads.spawn`'s `executionInputSources`,
  without which the server drops it and re-derives the project defaults. A model
  the catalog does not offer is refused with the available ids named.
- The worker execution is a visible `Inherit` / `Custom` pair, so inheriting the
  project's own provider and model is a choice rather than the absence of one.
- A **Retry a failed worker** target: `Report` (the default) hands a failure
  back, `Retry` re-delegates the same brief once on a second provider, model and
  access. It covers a refused spawn and a worker that lands in `error`, and the
  retry inherits every field the fallback does not name, so a fallback with no
  access of its own runs with the worker's permission mode.
- **The review gate.** `orchestrator_review` records a verdict per worker, and a
  turn that ends with unjudged workers tells an idle orchestrator once. Counts
  appear in the composer strip and in `status`. `verify: true` on a delegation
  spawns an independent check unit, told to inspect and report rather than
  repair, and records its thread as that delegation's evidence.
- **Inspectable contract.** `bb orchestrator-mode contract` prints the exact text
  a thread receives and sets or clears the appended project rules with `--rules`
  / `--clear-rules`; the settings section shows it with its length against the
  4096-character ceiling; project rules append their own section under a measured
  cap; and the contract level (`standard`, `review-heavy`, `delegate-only`) picks
  which sections it emits.
- **Fan-out guardrails.** `maxParallelWorkers` and `maxDelegationsPerTurn`
  (both `0` for no cap) refuse a delegation with a readable error, and a refusal
  is never retried on the fallback.
- **Worker retention.** `workerRetention` can archive check units, or every
  worker whose result has been read, once that result is in the orchestrator's
  hands.
- **Execution presets.** `--preset` / the `preset` tool argument name a stored
  per-unit-class execution (`build`, `review`, `research`), applied under the
  call's own arguments and over the worker execution. A preset may set only the
  fields that differ.
- A worker's failure text is carried from `thread.failed` onto its delegation
  record, so the orchestrator is told why a worker failed rather than only that
  it did.
- `bb orchestrator-mode worker` shows, sets and clears the stored execution, and
  manages the retry target with `--fallback-provider`, `--fallback-model` and
  `--clear-fallback`. Each flag leaves the rest of the stored configuration
  alone.
- `bb provider list` and `bb provider models` count as read-only commands, so an
  orchestrator can discover valid worker ids.
- `bb orchestrator-mode status` reports the execution delegations default to.
- Composer toggle, `+` menu fallback and status strip for orchestrator threads.
- Instructions that limit the orchestrator to reading, planning, asking,
  delegating and reporting, with a tool that creates worker threads.
- `instruct`, `guard` and `block` enforcement levels, configurable read-only
  command handling and a corrective-message cap.
- CLI commands to inspect and change thread mode, clear violations and set the
  default for new threads.
- Repository documentation, a logo using the plugin's delegation icon and an
  MIT licence.

### Changed

- Explain how long-running threads can drift from delegation into direct work,
  and how ongoing watchdog checks help catch that behaviour.

### Fixed

- A plugin tool call that a provider renders as a `command` row no longer reads
  as the orchestrator running a shell command. Those rows carry a call's title
  ("Recording accepted verdict"), not a command line, and flagging them told the
  orchestrator off for using the tools this plugin gives it. A command row now
  has to look like an invocation, so a known program or shell evidence such as a
  path, a flag, a pipe or an assignment.

- Read incremental timeline patches and nested work in completed turns so the
  watchdog does not miss direct work.
- Serialize state mutations to retain simultaneous thread choices and worker
  delegation records.
- Count mutating Git command forms and direct image generation as work.
- Share violation clearing between RPC and CLI, and remove unused vendored UI.
- Apply the new-thread default only to qualifying root threads created while
  it is enabled, on a user-initiated dispatch.
- Refresh the metadata mirror from plugin storage before each dispatch.
- Preserve monitoring of state saved by earlier builds.
- Skip historical work and grant grace turns while provider sessions gain the
  orchestrator contract; allow read-only exploration by default.

## 0.1.1 - 2026-10-05

### Fixed

- Notify running turns when orchestrator mode changes and provide CLI delegation
  for existing or resumed sessions without the native tool.
- Allow read-only `bb provider list` and `bb provider models` commands, including
  chains with `bb status --json`.

## 0.1.0 - 2026-10-01

### Added

- Composer toggle, `+` menu fallback and status strip for orchestrator threads.
- Instructions that limit the orchestrator to reading, planning, asking,
  delegating and reporting, with a tool that creates worker threads.
- `instruct`, `guard` and `block` enforcement levels, configurable read-only
  command handling and a corrective-message cap.
- CLI commands to inspect and change thread mode, clear violations and set the
  default for new threads.
- Repository documentation, a logo using the plugin's delegation icon and an
  MIT licence.

### Changed

- Explain how long-running threads can drift from delegation into direct work,
  and how ongoing watchdog checks help catch that behaviour.

### Fixed

- Read incremental timeline patches and nested work in completed turns so the
  watchdog does not miss direct work.
- Serialize state mutations to retain simultaneous thread choices and worker
  delegation records.
- Count mutating Git command forms and direct image generation as work.
- Share violation clearing between RPC and CLI, and remove unused vendored UI.
- Apply the new-thread default only to qualifying root threads created while
  it is enabled, on a user-initiated dispatch.
- Refresh the metadata mirror from plugin storage before each dispatch.
- Preserve monitoring of state saved by earlier builds.
- Skip historical work and grant grace turns while provider sessions gain the
  orchestrator contract; allow read-only exploration by default.
