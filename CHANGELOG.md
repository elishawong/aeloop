# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project does not yet follow semantic versioning (see `version` in
`package.json`).

## [Unreleased]

- **2026-07-21** — A5 CLI/TUI: a real, installable `aeloop` command
  (`start`/`resume`/`list`) driving the Loop engine end to end against the
  `subscription` profile — chalk-colorized diff rendering (`diff-render.ts`)
  and gate views (`gate-view.ts`, including a structurally distinct
  Escalation banner), a `Prompter` abstraction (`InquirerPrompter` for real
  terminal use, `FakePrompter` for tests) so the interactive loop
  (`run-loop.ts`) is testable without a real TTY, real dependency-graph
  assembly for the subscription profile (`assemble.ts`), argv parsing +
  dispatch + a documented, permanent Ctrl+C-during-model-call limitation
  (`main.ts`/`bin.ts`), and one small, additive `runner.ts` export
  (`getPendingInterrupt()`) giving a fresh CLI process a read-only way to
  reconstruct a paused run's pending gate for `aeloop resume`. Hard vertical
  slice covers both the happy path and the threshold-escalation path
  through real `main()` dispatch, real cli-bridge fixture subprocesses, and
  a scripted `FakePrompter`. 368 tests passing.
- **2026-07-21** — Loop orchestration, phase 2: threshold escalation hard
  branch (`escalation.ts`), audit persistence (`workflow_runs` /
  `structured_claims` / `approvals` tables in `audit-store.ts`), a
  `runner.ts` orchestration layer (`startRun()` / `resumeRun()`), and
  cross-process checkpoint resume (two independent processes, resume driven
  purely by `dbPath` + `runId`). 300 tests passing.
- **2026-07-21** — Loop orchestration, phase 1: graph-based coder/tester
  state machine (`graph.ts`) with G1/G2/G3 approval gates (`gates.ts`),
  SQLite-backed checkpointing (`checkpoint.ts`), and a real end-to-end
  vertical slice covering context → prompt → harness → graph → gate
  interrupt/resume. 254 tests passing.
- **2026-07-20** — CLI bridge layer: Claude CLI and Codex CLI adapters with
  real process spawning and JSONL stream parsing, a tool-execution verifier
  that catches claimed-but-unexecuted tool calls, and a shared
  spawn/timeout/stdin primitive (`cli-exec.ts`). Internal profile
  identifiers renamed to credential-model names (`subscription` /
  `apikey`). 228 tests passing.
- **2026-07-20** — Harness layer: provider routing, an adapter registry, a
  direct-API LiteLLM adapter, and schema validation with retry-on-failure
  that feeds validation errors back into the prompt. 165 tests passing.
- **2026-07-20** — Engine scaffold, plus the Context layer (SQLite+FTS5
  memory store, staleness tracking, a transactional confirm/correct/reject
  flow, rejected-memory filtering) and the Prompt layer (zod-validated
  output schemas, dynamic persona loading, prompt composer), with a real
  context → prompt vertical slice. 96 tests passing.
