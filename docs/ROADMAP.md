# aeloop — Roadmap (Overall Progress)

> 📌 **Single source of truth for aeloop's progress** — answers "where are we now / what's next." See per-batch implementation docs for details.
> 🔗 Design authority: [docs/DESIGN.md](./DESIGN.md) (§8 Milestones A0-A6)
> Last updated: 2026-07-21 (A5 build wrapped up, pending independent review)

---

## 🧭 Maintenance Rules (locked in)
1. **Three-state markers**: `[x]` done and pushed (note the commit) • `[~]` done and verified but **pending commit/push** (lost on shutdown) • `[ ]` not done. Completed items **keep their checkmark**.
2. **New items that come up mid-stream**: (a) a task to do right away → insert at the current cursor position, use the three-state markers; (b) an idea not being done now → drop into `💡 Inbox` (dated); if unsure → ask Elisha first.
3. **Clear the Inbox at wrap-up**: at milestone wrap-up, ask "should these Inbox items go into the issue backlog?"
4. Update this file + the date at the top every time a new batch starts or wraps up.

---

## ✅ Completed
> `[x]` pushed • `[~]` done, pending commit/push
- [x] **Project onboarded into internal tooling** — laid down the project-local layer (CLAUDE.md/docs structure/skills/.gitignore) + design authority docs/DESIGN.md (`2cc30d5`; this line was mistakenly left as `[~]` "pending commit/push" until B7 — turned out to be a stale marker that was never cleared, since it had already been pushed long before; corrected here in passing)

## ⬜ To Do (Milestones A0-A6, see DESIGN §8 for details)
### A0. Scaffolding
- [x] New repo src/ skeleton + package.json + tsconfig + vitest + profile loader stub — B0 (`c19dff3`) + B1 (`948fd24`), branch `feature/issue-1-a0-a1-scaffold`, see `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md` for details

### A1. Context + Prompt (anti-hallucination diamond built first) — B2-B10 all complete, see `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md` for details
- [x] ClaimSchema/CoderOutput/TesterOutput (zod) — B6 (`4e6ff3a`). SchemaValidator deferred to A2 (Harness scope, out of this increment)
- [x] SQLite+FTS5 store (RecallError never swallowed) + StalenessEngine + ConfirmationService (three states, wrapped in db.transaction) — B2 (`0eea001`) + B3 (`d2af34d`) + B4 (`b24fa3f`)
- [x] ContextInjector (wake-up injection + filters rejected) — a prior internal implementation didn't have this, aeloop adds it — B5 (`06259c9`)
- [x] persona loader (looks up the registry dynamically by role name) + PromptComposer — B7 (`88852a5`) + B8 (`64e8240`)
- [x] Hard vertical-slice test (Context→Prompt genuinely wired end-to-end, including rejected-filter assertions) — B9 (`4eb97e4`)
- [x] Verified bundling config + wrote back docs (this file/PROGRESS/CHANGELOG/root CLAUDE.md) — B10; after rework, 139/139 tests green, passed independent review + merged (PR #3, `018ab85`)

### A2. Harness — B0-B7 all complete, see `docs/feature/a2-harness-provider-router-litellm-adapter/` for details
- [x] ProviderRouter (role→provider→adapter pure lookup, zero I/O) + AdapterRegistry + LiteLLMAdapter (direct-api, full coverage of 401/403/429/5xx/trailing slash/missing key/invalid JSON/real liveness probe) + SchemaValidator (feeds errors back on retry) + config.ts (buildAdapterRegistry) — B0-B5 (`8080f8f`/`e085e04`/`2830f68`)
- [x] Hard vertical-slice test (Prompt→Harness genuinely wired end-to-end: real MemoryStore/ContextInjector/PromptComposer/AdapterRegistry/ProviderRouter/SchemaValidator, the only stand-in is FakeAdapter) — B6
- [x] Wrote back docs (this file/PROGRESS/CHANGELOG/root CLAUDE.md) — B7; 171/171 tests green, passed four rounds of adversarial independent review + Codex `gpt-5.6-sol` cross-model second sign-off PASS (R1-R3 FAIL and reworked, R4 PASS, both models agreed, see `docs/feature/a2-harness-provider-router-litellm-adapter/test-report.md` for details), merged→main PR#7 (`c9c22aa`)

### A3. CLI bridge + real verification (aeloop-specific) — B0-B7 all complete, see `docs/feature/a3-cli-bridge/` for details
- [x] ClaudeCliAdapter + CodexCliAdapter (cli-bridge, real spawn + real parsing: codex `exec --json` / claude `-p --output-format stream-json --verbose`) + `cli-exec.ts` (generic spawn/timeout/immediate stdin-close primitives) + `ToolExecVerifier` (`checkToolExecution` — claims `tool_execution` but trace is empty → `fail`) — B0-B2 (`d08f59d`) + B3 (`9abd1d7`) + B4 (`25ab7bc`)
- [x] profile renamed from the earlier persona-based names to `subscription`/`apikey` (named after the credential model instead, decoupling the engine from specific persona names; a standalone commit, not tied to any particular B batch) — `c243f64`
- [x] `config.ts` wiring (`buildAdapterRegistry` genuinely constructs both cli-bridge adapters; `cmd` strict-equality dispatches flavor + optional `bin` override for the spawn target, letting tests point at a controlled fixture) — B5 (`2b472bc`)
- [x] Hard vertical-slice test (cli-bridge genuinely wired end-to-end: real MemoryStore/ContextInjector/PromptComposer/`buildAdapterRegistry`/ProviderRouter/real CodexCliAdapter real spawn/SchemaValidator/ToolExecVerifier, the only stand-in is a controlled fixture subprocess) — B6 (`12cba2d`)
- [x] Wrote back docs (this file/PROGRESS/CHANGELOG/root CLAUDE.md) — B7; **228/228 tests green, two rounds of adversarial independent review PASS (R1 FAIL→reworked→R2 PASS) + Codex cross-model second sign-off, pending final sign-off to merge**

### A4a. Loop orchestration (graph + coder/tester nodes + G1/G2/G3 gates + happy-path vertical slice) — B0-B6 all complete, see `docs/feature/a4a-loop/` for details
- [x] `types.ts`/`errors.ts`/`workflow-def.ts` (`LoopState` Annotation.Root + `LOOP_NODES`/`GATE_TYPES` single source of naming) + `nodes/coder.ts`/`nodes/tester.ts` (reuses A2 ProviderRouter/A1 PromptComposer/A2 SchemaValidator, zero new model-call logic) — B0-B1
- [x] `gates.ts` (G1/G2/G3 gates, `interrupt()`/`Command({resume})`, pure function before interrupt / GateLogEntry only constructed after interrupt) — B2
- [x] `graph.ts` (`buildLoopGraph`/`compileLoopGraph`, first verification of `addConditionalEdges` — the one LangGraph mechanism the spike hadn't covered, passed on the first try) — B3
- [x] `checkpoint.ts` (`SqliteSaver.fromConnString`) + same-process two-phase "non-closure state" resume test (real graph + real on-disk checkpoint) — B4
- [x] Hard vertical slice `src/loop.e2e.test.ts` (real Context→Prompt→`buildAdapterRegistry` (cli-bridge fixture)→ProviderRouter→real graph→real SqliteSaver→G1/G3 interrupt+resume happy path→`applied:true`, role bindings aligned with the real config.yaml: coder→claude-cli/tester→codex-cli) — B5
- [x] Wrote back docs (this file/root CLAUDE.md/CHANGELOG/ai-agent repo CHARTS/knowledge/aeloop.md) — B6; 254/254 tests green, passed independent review + merged→main (PR #15, `c6589b7`)

### A4b. Threshold escalation + audit-table persistence + cross-process checkpoint productionization (a follow-up batch of the same issue #13) — B0-B7 all complete, see `docs/feature/a4b-loop/` for details
- [x] `types.ts`/`workflow-def.ts`/`errors.ts` extended (`rejectThreshold`/`escalationDecision`/`cancelled` fields, `GateDecision` gains `"escalate"`, new `EscalationDecision`/`EscalationResumeValue` types, `LOOP_NODES` gains `escalation`/`cancel`, `GATE_TYPES` gains `ESCALATION_ACK`, new `AuditReadError`) — B0
- [x] `escalation.ts` (`createEscalationNode()`/`routeAfterEscalation()`, DESIGN §4 `HD` three-way choice `revise`/`force_pass`/`abandon`, structurally parallel to `gates.ts`'s `createGateNode` rather than reusing it) + two routing changes in `gates.ts` (the `routeAfterReview` threshold branch, the `routeAfterG2` "proactive escalation" branch) — B1
- [x] `graph.ts` wires in the `escalation`/`cancel` nodes + extends the `review`/`g2`/`escalation` conditional edges + `graph.test.ts` adds 6 Escalation-subtree branch-coverage cases (threshold boundary/`force_pass`/`revise`/`abandon`/G2 proactive escalation/unrecognized decision fail-loud) — B2
- [x] `audit-store.ts` (`AuditStore`, creates + CRUDs the three `workflow_runs`/`structured_claims`/`approvals` tables, a structural sibling of `MemoryStore`, does not import/wrap it) — B3
- [x] `runner.ts` (`startRun`/`resumeRun`, `compiled.stream(..., {streamMode:"updates"})` writes per-node attributed audit entries, `stepCounters` explicitly threaded through `RunHandle` rather than module-level mutable state) — B4
- [x] Checkpoint cross-process productionization — two genuinely independent `node` child processes (different pids), process B looks up `langgraph_thread_id` using only `dbPath`+`runId` and resumes all the way through (`src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs`, the equivalent of `docs/feature/a4b-loop/spike/`, imports the compiled `dist/` rather than `src/`) — B5
- [x] Hard vertical slice (`src/loop.e2e.test.ts` adds a full threshold→escalation→`force_pass`→G3→apply chain scenario, plus a new `tester-reject` scenario in `fake-codex.fixture.mjs`) — B6
- [x] Wrote back docs (this file/PROGRESS/CHANGELOG/root CLAUDE.md/ai-agent repo CHARTS/knowledge/aeloop.md + a wording fix in `docs/DESIGN.md` §1.5 ruflo) — B7 (this item); **276/276 tests green, pending independent review**

### A5. CLI/TUI — B0-B9 all complete, see `docs/feature/a5-cli-tui/` for details
- [x] `src/cli/errors.ts` (typed `UnsupportedProfileError`/`RunNotResumableError`) + `package.json` `bin`/`chalk`/`@inquirer/prompts` deps — B0
- [x] `colors.ts` (chalk theming helpers, `escalationBanner()`) + `diff-render.ts` (best-effort line-prefix diff colorizer — `CoderOutput.diff` is a self-reported string, not a real `git diff`, so this deliberately isn't a unified-diff parser/validator) — B1
- [x] `gate-view.ts` (pure `GatePayload -> string` per gate, Escalation wrapped in the structurally-distinct banner, not just a different color) — B2
- [x] `prompter.ts` (`Prompter` interface, real `InquirerPrompter`, scripted `FakePrompter` — the seam that makes the interactive loop testable without a TTY, and what B8's hard vertical slice uses to drive a real run non-interactively) — B3
- [x] `runner.ts` gains `getPendingInterrupt()` — the one Loop-layer change this PRD makes (read-only reconstruction of a paused run's pending-gate payload for a fresh CLI process with no in-memory `RunHandle`); 3 mutation-tested regressions (missing-run guard, wrong thread_id, always-done) — B4
- [x] `assemble.ts` (`assembleSubscriptionDeps()` — real dependency-graph wiring for the subscription profile, `AI_AGENT_PROFILE=apikey` hard-guarded to `UnsupportedProfileError` before ever touching `profiles/apikey`; `resolveRejectThreshold()`'s 3-tier chain) — B5
- [x] `run-loop.ts` (`runInteractiveLoop()` — shared start/resume orchestrator; G1/G3 `confirm()`, G2/Escalation `select()`, G2 never offers a third "rejected" option per `gates.ts`'s real `routeAfterG2` contract; 4 mutation-tested regressions on the gate-routing/rendering logic) — B6
- [x] `main.ts` (`node:util.parseArgs` argv parsing, `start`/`resume`/`list` dispatch, every error caught and printed as `Name: message` — never a raw stack trace — SIGINT handler installed/removed per call) + `bin.ts` (real two-line production entry point) — B7
- [x] Hard vertical slice (`src/cli.e2e.test.ts`): real `main()` dispatch + real subscription-profile dependency graph + real cli-bridge fixture subprocesses + scripted `FakePrompter`, both the happy path (G1→G3→apply) and the threshold-escalation path (reject-to-threshold→ESCALATION_ACK→force_pass→G3→apply) — B8
- [x] Wrote back docs (this file/PROGRESS/CHANGELOG/README/ai-agent repo `CHARTS/knowledge/aeloop.md`) — B9 (this item); **368/368 tests green**, `pnpm build`/`pnpm lint` both clean, pending independent review

### A6. Dual profile run acceptance
- [ ] Run subscription (claude+codex) and apikey (litellm) each through one real task end-to-end

### Refactor foundation (pre-A6)
- [~] Workflow plugin boundary, deterministic brain/contract/orchestrator boundary, profile-neutral CLI assembly, external private profile root, and credential-free company demo — local branch `refactor/conductor-foundation` (`df79d27`); requires a real company profile for final A6 acceptance

### Spikes (must run before implementation)
- [x] codex exec non-interactive mode verification — issue #10 prerequisite spike (the claude side's `-p --output-format stream-json --verbose` was verified at the same time), see `docs/feature/a3-cli-bridge/spike-findings.md` for details (`2017280`)
- [ ] deepseek liveness probe + structured-output verification (the apikey profile's tester half, under its pre-rename name — out of scope for A3, left as a tail item for A6/A2)

---

## 💡 Inbox (Pending triage — new ideas that don't fit any section above go here first)
_(none for now)_
