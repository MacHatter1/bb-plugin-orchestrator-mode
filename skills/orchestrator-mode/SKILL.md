---
name: orchestrator-mode
description: "Use when a thread is in orchestrator mode and must delegate every unit of work instead of doing it, or when the user asks to turn orchestrator mode on or off, check what direct work a thread did, or change how new threads start. Covers the composer toggle and the `bb orchestrator-mode` CLI."
---

# Orchestrator mode

Orchestrator mode is a per-thread switch. While it is on, that thread does not
do the work. It reads, plans, asks, delegates and reports, and every unit of
actual work goes to a worker thread.

## Recognise it

The composer shows a delegation icon, which BB may group under More plugin
actions. While the mode is on, a strip above the input names the enforcement
level and any direct work already caught. The thread's own instructions carry
the full contract, so if you are reading an "# ORCHESTRATOR MODE IS ON" block,
the mode is on for you.

## Commands

```
bb orchestrator-mode status [--thread <id>] [--json]
bb orchestrator-mode delegate --task <brief> [--title <title>] [--provider <id>] [--model <id>] [--no-wait] [--timeout <seconds>] [--hidden] [--thread <id>] [--json]
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
bb orchestrator-mode worker [--provider <id>] [--model <id>] [--preset <name>] [--json]
bb orchestrator-mode contract [--thread <id>] [--rules <text>] [--clear-rules] [--json]
bb orchestrator-mode scope [--project <id>] [--max-parallel <n>] [--inherit <key>] [--inherit-all] [--json]
bb orchestrator-mode scope --global|--project <id> [--child-messages queued|immediate] [--json]
```

`--thread` defaults to the thread running the command, so an agent can inspect
or change its own mode. Running turns receive a message when the mode changes.
Session configuration is refreshed when the provider session is next
constructed, but resuming may retain its original tool list.

Direct messages from child threads queue by default until the orchestrator's
current turn ends. BB retains their content and sender. Compatible queued
updates from one child arrive together, preserving every update and its order.
Interleaved children are batched in order of their first pending update. Matching
execution settings are required; user messages, other waits and existing groups
can prevent batching across a boundary. BB requires one sender per queued group,
so reports from different children remain separate dispatches. Send now overrides the hold. The
`childMessageDelivery` scope setting selects `queued` or `immediate`; use
`--inherit childMessageDelivery` to clear a project's override. User messages,
unrelated senders and idle orchestrators proceed immediately. Automatic child
completion/failure/attention notices use BB's separate system delivery path
and cannot be held by this plugin; waiting delegation tool results also return
directly. Finish the current turn after delegating async work so queued child
messages can reach you.

## Enforcement levels

- `instruct` writes the rules into every turn and checks nothing.
- `guard` (the default) writes the rules and warns the orchestrator when it does
  work itself or leaves a worker unjudged.
- `block` writes the rules too and stops the turn as soon as the orchestrator
  does work itself, though a fast write can still land first.

The watchdog grants grace turns while provider sessions gain the contract: one
when enabled while idle, or the active turn and the next one when enabled
mid-turn. Historical work is not judged. Follow the contract whenever your
session receives it, including during grace turns.

The new-thread default only reaches qualifying root threads created while it is
on, at a user-initiated dispatch. Existing threads, child workers and side chats
are left alone.

Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find`, `wc`, `bb status`, `bb provider list`, `bb provider models`)
do not count as work while "Let the orchestrator read with shell commands" is
on and the contract is not `delegate-only`. Chained commands are allowed when
every segment is read-only. Literal stderr suppression (`2>/dev/null` or
`2> /dev/null`) is allowed, including on chained `find` queries. Other
output redirects and mutating `find` actions (`-delete`, `-exec`, `-fprint`)
still count as work. Creating images counts as work and must be
delegated; inspecting images is allowed. Git commands that create or delete
branches or tags, change remotes, or rewrite reflogs also count as work.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
If it is unavailable, use `bb orchestrator-mode delegate --task 'complete brief'`.
The CLI runs the same worker creation, recording and result handling. It is
allowed even when read-only shell exploration is disabled. Quote the brief
safely; `--no-wait` lets you start independent workers without waiting.
Give it a complete, self-contained brief: the worker cannot see this
conversation. Fan out independent units; sequence only real dependencies.

Arguments are `task` (required, at most 20,000 characters), `title` (optional,
at most 200), `waitForResult` (default `true`), `timeoutSeconds` (default `900`,
integer range 10 to 3,600), `hidden` (default `false`), `preset` (optional, a
stored execution preset), `verify` (default `false`, adds the check unit
described below) and `provider` (alias `providerId`), `model`, `reasoning`, `permissionMode` for this
one unit. With `waitForResult: false` the worker keeps running: inspect it later
and review its result.

Optional `provider` (alias `providerId`, 1–120 characters) and `model`
(1–200) are trimmed; blank pins are rejected. If both provider names are
supplied, they must match. Provider pins are never silently retargeted: name a
model that the pinned provider serves. The CLI equivalents are `--provider`
(aliases `--provider-id` and `--providerId`) and `--model`. Pins take effect
before the first turn and do not require disabling orchestrator mode. Failed
spawns are not retried with unpinned workers; an explicitly configured retry
target still applies.

A resumed session may retain an older native tool schema without the pin
arguments. Use the CLI with `--provider` and `--model` rather than unpinned
delegation in that case.

### Following up with a worker

`bb thread tell <worker-id> ...` (alias `message`) counts as delegation when
the target is in this orchestrator's retained delegation records. It remains
allowed when read-only shell exploration is disabled. Literal quoted messages
and `--message-file <path>` can carry the follow-up. For stdin, use a quoted
heredoc delimiter so the shell cannot execute substitutions in the message:

```sh
bb thread tell <worker-id> --model <model-id> --mode steer --message-file - <<'FOLLOWUP'
Review the implementation and add the missing tests in your worker thread.
FOLLOWUP
```

Unknown/unrecorded targets (including the orchestrator itself), unquoted
heredocs, command substitutions outside literal message data, file-output
redirects and mixed chains doing local work are not delegation. Each worker
in a chained follow-up must be recorded. At most 250 worker records are retained.

## Recording a verdict

Every worker whose result you used needs a verdict before you finish the turn.
Call `orchestrator_review` with the worker's thread id, `accepted` or `rejected`,
and a line of notes. A turn that ends with unjudged workers gets one reminder. A
rejected result is re-delegated, never patched by you.

`verify: true` on a delegation spawns an independent check unit that inspects the
repository and reports `VERDICT: pass` or `VERDICT: fail`. Its report comes back
with the worker's, and its thread is recorded as that delegation's evidence. Use
it when you cannot judge a unit from its report alone.

## Choosing the worker's execution

Workers run on the provider, model and access the settings section's worker rows
name, falling back to this project's remembered defaults. Override those for one
unit with `provider`, `model`, `reasoning` and `permissionMode`. Give a hard unit
a stronger model and a mechanical one a cheaper model.

`preset` names a kind of work the plugin has a saved setup for, such as `build`,
`review` or `research`. Your own arguments beat the preset for that unit. Naming
one also titles the child `BUILD:`, `REVIEW:` or `RESEARCH:`, so the sidebar shows
what it is doing.

`workspace` picks where the unit runs. `shared` (the default) uses the checkout
you are in, so its edits are visible to you immediately. `worktree` gives the
unit its own worktree and branch; nothing it writes lands in your checkout, the
result names the branch, and the user merges it. Ask for `worktree` when two units
would touch the same files, or when a unit should not disturb the working tree.

Under a `mixed` scope every delegation has to name one. To land a worktree unit,
delegate the merge as its own unit with `workspace: "shared"`, naming the branch
to bring in; merging by hand counts as doing the work yourself.

When the plugin has a retry target configured, it re-delegates a failed worker
once on that provider and model before you hear about the failure, so do not
re-run a failed unit by hand.

Valid ids come from `bb provider list` and `bb provider models <provider>`, both
read-only. A model the catalog does not offer is refused with the available ids
named, so pass a model you have seen there rather than guessing.

Two caps can refuse a delegation: workers running at once, and workers per turn.
The refusal names the cap, and it is not a provider failure, so re-delegating
through the retry target will not help. Fold what came back into a report
instead.

The default corrective-message cap is three per enablement. Recording and
block-mode stops continue after the cap. Clearing violations or disabling the
thread resets correction counters.

Do not try to turn the mode off yourself or work around it. If the work genuinely
cannot be delegated, say so and stop, and ask the user to turn the mode off in
the composer.
