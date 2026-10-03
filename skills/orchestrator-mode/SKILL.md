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
bb orchestrator-mode on [--thread <id>] [--enforcement instruct|guard|block] [--json]
bb orchestrator-mode off [--thread <id>] [--json]
bb orchestrator-mode violations [--thread <id>] [--clear] [--json]
bb orchestrator-mode default [on|off] [--json]
bb orchestrator-mode worker [--provider <id>] [--model <id>] [--preset <name>] [--json]
bb orchestrator-mode contract [--thread <id>] [--rules <text>] [--clear-rules] [--json]
```

`--thread` defaults to the thread running the command, so an agent can inspect
or change its own mode. A change applies when the provider session is next
constructed. A live session keeps the instructions it started with.

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

Read-only shell commands such as `ls`, `cat`, `rg`, `git status`, `git diff`,
`git log`, `find` and `wc` do not count as work while the plugin setting "Let the
orchestrator read with shell commands" is on. Creating images counts as work and
must be delegated, while inspecting images is allowed. Git commands that create
or delete branches or tags, change remotes, or rewrite reflogs also count as
work.

## Delegating

Use the `orchestrator_delegate` tool, which the mode selects for the thread.
Give it a complete, self-contained brief, because the worker cannot see this
conversation. Fan out independent units, and sequence only real dependencies.

Arguments are `task` (required, at most 20,000 characters), `title` (optional,
at most 200), `waitForResult` (default `true`), `timeoutSeconds` (default `900`,
integer range 10 to 3,600), `hidden` (default `false`), `preset` (optional, a
stored execution preset), `verify` (default `false`, adds the check unit
described below) and `provider`, `model`, `reasoning`, `permissionMode` for this
one unit. With `waitForResult: false` the worker keeps running: inspect it later
and review its result.

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

Workers run on the provider, model and access the plugin's Workers section names,
falling back to this project's remembered defaults. Override those for one unit
with `provider`, `model`, `reasoning` and `permissionMode`. Give a hard unit a
stronger model and a mechanical one a cheaper model.

`preset` names a kind of work the plugin has a saved setup for, such as `build`,
`review` or `research`. Your own arguments beat the preset for that unit.

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
