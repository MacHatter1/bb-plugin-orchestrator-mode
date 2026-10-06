# Orchestrator Mode design notes

## State and dispatch

The plugin's KV store holds authoritative thread state. The synchronous
`bb.agents.configure` callback reads only the thread metadata mirror. Before
each message dispatch, the plugin refreshes that mirror from its own state;
editing the mirror alone does not disable a tracked thread. A mirror refresh
failure logs a warning and allows dispatch to proceed.

State mutations serialize the complete read, update and write operation, so
parallel worker delegations and changes to different threads do not overwrite
one another. RPC and CLI use the same operation to clear violation records
and correction counters.

The new-thread default records when it was enabled. At dispatch it requires a
thread created at or after that moment, a user initiator, no parent, and an
origin other than the side-chat plugin. Existing stored thread choices win.
Configuration never guesses eligibility from a missing mirror.

State is bounded: the store retains at most 300 threads by last touch time,
100 violations and 50 delegation records per thread, and 500 seen timeline row
IDs per thread. These are working records, not a permanent audit archive.
Deleted threads lose their stored state.

## Session timing and grace turns

Enabling a thread seeds the watchdog's timeline sequence from the existing
head. Older work is not judged. A provider session cannot have its instructions
replaced while it is running, so mode changes send steering messages to active
turns. Idle threads receive session configuration on their next construction.
Some providers retain the original native tool list on resume. The CLI
`bb orchestrator-mode delegate` invokes the same delegation handler and remains
usable in those sessions.

The watchdog therefore grants one grace turn when enabled while idle. When
enabled during an active turn, it grants that turn and one subsequent turn.
These turns advance tracking without being classified as violations. A
session constructed with the contract can begin delegating before the watchdog
starts judging its work.

## Work classification

The classifier in `shared.ts` looks at timeline rows, rather than intercepting
tool calls. Scans consume full rows or incremental `delta.upsertRows` patches
and request nested rows so completed turn summaries still expose their work.
File changes and image generation count as work. Command rows count unless they
delegate through the plugin CLI or the read-only command setting allows them.
Delegation command checks respect quoted briefs and reject executable
substitutions, output redirections and mixed chains that perform direct work.
Worker follow-ups through `bb thread tell`/`message` are delegation only when
the literal target ID is in this parent's retained delegation records, even
when read-only exploration is disabled. The watchdog refreshes that worker
list after reading the timeline so newly recorded workers are included.
Quoted stdin heredocs (including tab-stripping `<<-`) are read as literal
message data; unquoted, unfinished or unsupported heredocs remain work.
Generic tool rows are classified using
their names; this is a heuristic, not a complete description of their effects.

Recognised research includes reads, searches, web fetches, plans and questions.
Delegation rows remain available. Shell read-only checks reject writes through
redirection and mutating command chains. Literal stderr suppression with
`2>/dev/null` (or `2> /dev/null`) is allowed when every command only reads;
other output redirects still count as work. `find` actions that delete,
execute programs, or write result files also count as work, even with errors
suppressed. Consult `isReadOnlyCommand` and its tests for the exact recognised
commands.
Mixed Git subcommands require recognised query forms: listing branches or
tags, inspecting remotes and showing reflogs. Creating or deleting branches
and tags, changing remotes and rewriting reflogs count as work.

In `instruct`, no watchdog classification runs. In `guard`, new violations are
recorded and the thread receives corrective messages up to the nudge cap, with
at most one nudge per offending turn. The review gate draws on the same cap, so
one budget covers both kinds of correction; `status` reports the split. In `block`, the plugin also asks BB to
stop the offending turn, at most once per turn, even after the nudge cap.

Thread events coalesce scans with a 750 ms delay; idle events use 250 ms. These
are scheduling delays, not a guaranteed detection latency. Timeline access,
scan duration and BB's stop handling add time. A write can complete before
the stop request. This plugin is a coordination aid, not a security boundary.

## Worker lifecycle

`orchestrator_delegate` and the `delegate` CLI create a child without passing
the parent's conversation. Shared workers reuse the parent's environment;
worktree workers receive their own checkout. Workers do not inherit the
new-root-thread default.
Optional `provider` (alias `providerId`) and `model` pins (CLI: `--provider`
and `--model`) are trimmed and validated at the input boundary. Conflicting
provider aliases or a model incompatible with a pinned provider are refused.
Execution is passed to `threads.spawn` with explicit provenance, before the
worker's first turn, never through a later update. Omitted fields resolve
through presets, scoped worker settings and BB's defaults. The plugin checks
its provider/model catalog and BB validates availability. A failed spawn
creates no delegation record and is never retried unpinned; a configured
retry target may still apply.

The tool waits by default, reports the settled status and returns up to 12,000
characters of final output. With `waitForResult: false`, it returns the worker
ID immediately. A timeout reports status without stopping the worker. Open or
inspect the worker later to finish reviewing its work.

Only the first 400 characters of a delegation brief are retained in the
parent's delegation record. The full brief is sent to the worker. Hidden
workers are omitted from the sidebar; the delegation result still identifies
their thread.

A delegation may name a stored execution preset, which is applied under the
call's own arguments and over the worker execution. A preset is partial by
design: it only loses the ids the catalog no longer lists, and the provider
follows whichever model the preset names. The `presets` and `fallback` keys are
stripped before anything reaches `threads.spawn`, because they are this plugin's
own bookkeeping rather than spawn fields.

`verify: true` spawns a check unit on the same execution, carrying the original
brief and the worker's claim, and records its thread on the delegation record.
A check unit is evidence for the unit it checks: it is excluded from the review
gate, since judging the checker as well would add ceremony rather than a
decision.

Two caps bound a fan-out, counted from this plugin's own records so the refusal
can name which cap it hit. The per-turn count starts at the last dispatch, which
is where a turn begins. A refusal is a distinct error type: the delegation tool
retries a provider failure on the fallback, and a cap is not a provider failure.

## The review gate

A verdict is recorded by the tool rather than inferred from the timeline. Reads
leave no row, so "did the orchestrator look at this" is unobservable from the
outside; making the verdict an explicit call is what makes it checkable at all.

The gate runs when an orchestrator's turn ends and when a worker settles, and
only nudges a thread that is idle: a message sent mid-turn would queue behind
the work it is asking about. It remembers the set of workers it last reminded
about, so an ignored reminder is not repeated for the same set. A finished turn
cannot be stopped, so `block` behaves as `guard` here; the nudge text says so
rather than implying a stop that did not happen.

A worker that settles while nothing is waiting on it is found by looking its
thread id up in every stored orchestrator's delegations. A delegation made with
`waitForResult: false` settles that way. That lookup also carries the failure text from
`thread.failed` onto the record, so the orchestrator is told why a worker failed
and not only that it did.

## Contract shapes

The contract is emitted, never rewritten. It states which acts the classifier
flags, so a free-form replacement could desync the two and make the watchdog
wrong; the two shape settings swap sections and project rules append one.

`configure` truncates dynamic instructions at 4096 characters, so the budget is
an invariant rather than a hope: the budget test builds the largest contract
every combination of the two can produce — the longest model id the catalog accepts, presets in
every kind, five reminders, an appended section at the cap — and asserts it fits
and that the tail survives. That test is what sets the append cap, and the
render clamps the append as its last resort rather than handing BB a block it
would cut.
