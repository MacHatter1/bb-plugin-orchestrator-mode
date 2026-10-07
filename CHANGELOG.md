# Changelog

All notable changes to Orchestrator Mode are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- Remove the draft-text decoration that drew a stray edge inside the composer
  while orchestrator mode was on; the toggle and status banner remain unchanged.

## 0.1.2 - 2026-10-06

### Added

- Per-delegation worker provider, model, reasoning and permission controls,
  with BB's provider/model picker, named execution presets and an optional
  configured retry target.
- Project-scoped settings, worker execution and appended rules, with global
  defaults and explicit inheritance controls.
- Shared, worktree and mixed worker workspaces. Verification workers and
  fallback retries reuse the unit's checkout.
- Recorded worker verdicts through `orchestrator_review` and independent
  verification with `verify: true`.
- Parallel-worker and per-turn delegation caps, worker-retention policies,
  and an inspectable contract with standard, review-heavy and delegate-only
  levels.

### Fixed

- Apply provider/model pins before workers start, with explicit execution
  provenance. Support the native `providerId` alias and CLI `--provider-id`
  and `--providerId` aliases; trim pins and reject blanks, conflicting
  aliases and incompatible provider/model combinations.
- Recognise `bb thread tell`/`message` follow-ups to recorded workers as
  delegation, including literal quoted stdin heredocs, even when read-only
  exploration is disabled.
- Allow literal `2>/dev/null` stderr suppression on read-only commands,
  without allowing output-file redirects or mutating `find` actions.
- Preserve stricter shell classification: writing/execution flags,
  executable substitutions, unsafe wrappers and mixed work chains remain
  work. Git's program-running global options are checked after directory
  and namespace operands, not only before them.
- Share native and CLI worker handling, including project execution,
  caps, verification and retention; preserve delegation in resumed sessions.
- Harden timeline scans against malformed rows, repeated row IDs and
  missing sequence/timing fields. Attribute block-mode intervention to
  the live turn and retain the post-enable grace period.
- Enforce delegation caps and review reminders under concurrency, sanitise
  stored state, and retain workers still owed a verdict within bounded records.
- Keep injected instructions within the 4096-character limit without
  losing the contract tail or supported project-rules append.

### Changed

- Settings resolve through the plugin's Global/Project scope editor rather
  than BB's single-install settings form; unchanged projects inherit defaults.
- Remove the `.github` directory and GitHub Actions workflow. Verification
  remains available through the local test, typecheck and build commands.

### Contributors

- Thank you [@GantisStorm](https://github.com/GantisStorm) for
  [PR #1](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/1):
  worker execution controls, scoped configuration, reviews and verification,
  workspaces, guardrails, and classifier/watchdog hardening.
- [@MacHatter1](https://github.com/MacHatter1) contributed the delegation and
  watchdog usability fixes in
  [PR #4](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/4)
  and release preparation in
  [PR #5](https://github.com/MacHatter1/bb-plugin-orchestrator-mode/pull/5).

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
