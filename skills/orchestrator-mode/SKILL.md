---
name: orchestrator-mode
description: "Use when a thread is in orchestrator mode and must delegate every unit of work instead of doing it, or when the user asks to turn orchestrator mode on or off, check what direct work a thread did, or change how new threads start. Covers the composer toggle and the `bb orchestrator-mode` CLI."
---

# Orchestrator mode

Orchestrator mode is a per-thread switch. When it is on, that thread does not
do the work: it reads, plans, asks, delegates, and reports, and every unit of
actual work goes to a worker thread.

## Recognise it

The composer shows a delegation icon (possibly under More plugin actions) and,
while the mode is on, a strip above the input naming the enforcement level and
any direct work already caught. The
thread's own instructions carry the full contract when the mode is on — if you
are reading a "# ORCHESTRATOR MODE IS ON" block, it is on for you.

## Commands

```
bb orchestrator-mode status [--thread <id>] [--json]
bb orchestrator-mode delegate --task <brief> [--title <title>] [--provider <id>] [--model <id>] [--no-wait] [--timeout <seconds>] [--hidden] [--thread <id>] [--json]
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
```

`--thread` defaults to the thread running the command, so an agent can inspect
or change its own mode. Running turns receive a message when the mode changes.
Session configuration is refreshed when the provider session is next
constructed, but resuming may retain its original tool list.

## Enforcement levels

- `instruct` — the contract is injected, nothing is watched.
- `guard` (default) — the timeline is watched; direct work is recorded and the
  thread gets a corrective message telling it to re-delegate.
- `block` — as `guard`, plus the turn is stopped the moment direct work is
  detected. Detection follows the action, so a fast write can finish before
  the stop; there is no pre-tool-call veto.

The watchdog grants grace turns while provider sessions gain the contract:
one when enabled while idle, or the active turn and the next one when enabled
mid-turn. Historical work is not judged. Follow the contract whenever your
session receives it, including during watchdog grace turns.

The new-thread default only reaches qualifying root threads created while
it is on, at a user-initiated dispatch. It leaves existing threads, child
workers and side chats alone.

Read-only shell commands (`ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find`, `wc`, `bb status`, `bb provider list`, `bb provider models`)
do not count as work unless the plugin's
"Read-only shell commands are not work" setting is turned off.
Chained commands are allowed when every segment is read-only, including
`bb status --json; bb provider models codex --environment <id> --json`.
Literal stderr suppression (`2>/dev/null` or `2> /dev/null`) is allowed on
read-only commands, including chained `find` queries. Other output redirects
still count as work. `find -delete`, program-execution actions such as `-exec`,
and file-output actions such as `-fprint` are work, even with stderr suppressed.
Creating images counts as work and must be delegated; inspecting images is
allowed. Git commands that create or delete branches or tags, change remotes,
or rewrite reflogs also count as work.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
If it is unavailable, use `bb orchestrator-mode delegate --task 'complete brief'`.
The CLI runs the same worker creation, recording and result handling. It is
allowed even when read-only shell exploration is disabled. Quote the brief
safely; `--no-wait` lets you start independent workers without waiting.
Give it a complete, self-contained brief: the worker cannot see this
conversation. Fan out independent units; sequence only real dependencies.

Arguments are `task` (required, at most 20,000 characters), `title` (optional,
at most 200), `providerId` (optional, 1–120), `model` (optional, 1–200),
`waitForResult` (default `true`), `timeoutSeconds` (default `900`, integer range
10–3,600) and `hidden` (default `false`). A timeout or `waitForResult: false`
leaves the worker running; inspect that worker later and review its result.

If your persona or task requires specific workers, pass `providerId` and
`model` to the tool. The CLI equivalents are `--provider <id> --model <id>`;
`--provider-id` and `--providerId` are aliases for `--provider`. Pins are set
at creation, before the worker's first turn. Omitted pins use BB's normal
default selection; blank pins are rejected after trimming whitespace. BB
validates availability, and a failed spawn is never retried with unpinned
workers. Discover registered IDs with `bb provider list` and
`bb provider models <provider-id>` on the parent's environment. You do not
need to turn orchestrator mode off to pin workers.

A resumed session may retain an older native tool schema without the pin
arguments. In that case, use the CLI route with `--provider` and `--model`
rather than attempting unpinned delegation.

The default corrective-message cap is three per enablement. Recording and
block-mode stops continue after the cap. Clearing violations or disabling the
thread resets correction counters.

Do not try to turn the mode off yourself or work around it. If the work
genuinely cannot be delegated, say so and stop, and ask the user to turn the
mode off in the composer.
