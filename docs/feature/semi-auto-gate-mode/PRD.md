# PRD — aeloop #63: `workflow.gate_mode: "manual" | "semi-auto"`

> Anti-hallucination: `[?]` = unverified by me / needs Commander confirmation; no invented interfaces/versions/parameters. Every statement in this PRD about existing code comes from my own reading of the real code (`src/cli/{run-loop,assemble}.ts`, `src/profile/loader.ts`, `src/loop/{runner,gates,workflow-def,audit-store}.ts`) + `gh issue view 63 --repo elishawong/aeloop` (fetched during this PRD's own research, not recalled from memory), not from memory. This document is written **after** the code (Cypher's normal PRD-before-code order was inverted here: the toggle was implemented first, Zorro's independent review then found this feature had zero documentation for a security-sensitive behavior — blocker 1 of that review — and this PRD is the direct fix for that gap, written against the real, already-implemented code, not a forward-looking design).

- **Project**: aeloop (`elishawong/aeloop`, private repo)
- **Branch**: `feature/semi-auto-gate-mode` (worktree: `aeloop-worktrees/gate-mode`)
- **Priority**: P1 (per issue label)
- **Status**: Implemented, addressing Zorro/Codex independent-review FAIL (2 blockers + 1 hardening ask); not yet committed
- **Last updated**: 2026-07-22
- **Related issue**: [elishawong/aeloop#63](https://github.com/elishawong/aeloop/issues/63)
- **Design authority**: issue #63's own body (fetched via `gh issue view 63`, quoted verbatim in §1) + real code in `src/cli/run-loop.ts`, `src/cli/assemble.ts`, `src/profile/loader.ts`. Issue #63's body references "Design doc §5.2" for an "auto-until-threshold" model — **I could not locate a §5.2 in `docs/DESIGN.md`** (that file has no `###`-level subsections at all; its own §5 is "DB schema", unrelated to gate automation) or in any other file under `docs/`. Flagged as `[?]` — either a stale reference to a doc that changed structure since the issue was written, or a reference to something outside this repo (e.g. a pitch deck). Not load-bearing for this PRD either way: the issue body's own "What"/"Constraints" sections are unambiguous and are what the implementation actually follows.

---

## 1. Problem / Users / Solution

**Problem to solve** (issue #63, quoted verbatim):
> Current interactive CLI gates every step (high-touch). For real productivity + the pitch demo, the intermediate revision cycles should run autonomously, surfacing to the human only for final apply + when stuck.

Every gate in the A5 CLI (`src/cli/run-loop.ts`'s `runInteractiveLoop()`) prompts a real human via `Prompter`, for all four gate types (G1/G2/G3/Escalation), in every profile, unconditionally. For a coder→tester revision loop that's going to reject-and-retry several times before it either passes or hits the reject-count threshold, that means a human has to sit and approve every single round trip, even though G1 ("send the coder's draft to the tester") and G2 ("send the tester's findings back to the coder for a fix") are not decisions that carry real judgment for most runs — they're "yes, continue the loop" rubber-stamps, and the only points that actually matter for a human to look at are the **final** diff (G3) and the case where the loop is stuck (Escalation).

**Who it's for**: the Commander, running `aeloop start`/`resume` for real work or a pitch demo, who wants the coder↔tester loop to run unattended through its normal back-and-forth and only be pulled in when there's something to actually decide.

**One-sentence solution**: a new `workflow.gate_mode: "manual" | "semi-auto"` key in `config.yaml` (`profile/loader.ts`'s `ProfileConfig.workflow`, validated fail-closed at load time), consumed in exactly one place — `run-loop.ts`'s `runInteractiveLoop()` — which, in `"semi-auto"`, auto-approves G1/G2 with a synthetic `{decision:"approved"}` recorded under a distinct system `decidedBy` string, while G3 and Escalation are structurally excluded from ever being auto-approved (a fixed, closed set, not derived from config) and additionally protected by a defensive runtime assertion (§5).

## 2. Goals

1. `workflow.gate_mode` config key: `"manual"` (default, including when the key/`workflow` block is absent entirely) or `"semi-auto"`. Any other value fails closed — `profile/loader.ts` throws `ProfileConfigParseError` at load time, never silently coerced to a default and never silently ignored (`profile/loader.ts:~34-56`).
2. In `"semi-auto"`: G1 (`GATE_TYPES.G1_SEND_TO_TESTER`) and G2 (`GATE_TYPES.G2_SEND_TO_FIX`) skip the `Prompter` call entirely and resume with `{decision:"approved"}`, recorded in the audit trail (`approvals.decided_by`) under the literal string `"system (semi-auto)"` — never the real human's `decidedBy` value that `runInteractiveLoop()` was called with. This is issue #63's own constraint: "Gate decisions must still be auditable (log auto-approvals with actor=system/semi-auto)."
3. **G3 (`G3_FINAL_MERGE`) and Escalation (`ESCALATION_ACK`) always stay human, in every mode, with no config knob able to change that.** This is the one safety invariant `gate_mode` can never override — see §3.
4. `"manual"` (or the key absent) is byte-for-byte the same code path `runInteractiveLoop()` always took before this change — no behavior change for any profile that doesn't opt in (issue #63's own constraint: "Default `manual` → all 594 tests stay green").
5. Least-invasive injection point: only `run-loop.ts` branches on `gate_mode` (issue #63's own constraint: "likely run-loop / prompter layer, not the graph"). `loop/graph.ts`/`loop/gates.ts` are unmodified and have no awareness this toggle exists — from `resumeRun()`'s point of view, a semi-auto auto-approval is indistinguishable from a human one except for which string lands in `decided_by`.

## 3. Safety boundary (the load-bearing part of this feature)

This is a human-in-the-loop **removal** for two of four gates — a change to a control that exists specifically to keep a human reviewing a coding agent's output before it goes further. The design deliberately keeps three independent layers of protection against ever auto-approving the wrong thing:

1. **Closed allowlist, not a denylist.** `run-loop.ts`'s `AUTO_APPROVABLE_GATES` is a fixed `Set([GATE_TYPES.G1_SEND_TO_TESTER, GATE_TYPES.G2_SEND_TO_FIX])` — a hardcoded, closed 2-element set, not "everything except G3/Escalation" computed from the 4-value `GateType` union. Adding a hypothetical fifth gate type in the future would default to **not** auto-approvable unless someone explicitly adds it here.
2. **`reject_threshold` fail-closed validation** (`cli/assemble.ts`'s `resolveRejectThreshold()`, §5.2 below): the reject-count-to-Escalation safety net that guarantees a semi-auto loop still reaches a human when it's stuck depends on `rejectCount >= rejectThreshold` (`loop/runner.ts:725`) eventually being true. A malformed `reject_threshold` (e.g. YAML's `.nan`/`.inf` tags) must never be able to make that comparison permanently false.
3. **Defensive gate-identity assertion** (`run-loop.ts`, §5.1 below): before ever auto-approving, cross-check that `workflow_runs.current_state` (the DB-persisted state) independently agrees with `interrupt.gate` (the value the CLI layer is about to act on) really is G1 or G2, not G3/Escalation. Should be unreachable through real `startRun()`/`resumeRun()` code paths (both values are ultimately read from the same `computeRunProgress()` call), but auto-approval is security-sensitive enough that a single-signal trust model isn't good enough — the assertion fails closed (throws) rather than trusting `interrupt.gate` alone.

Non-goals: this PRD does not add a `--gate-mode` CLI flag (config-only, matching every other `workflow.*`/`harness.*` knob's existing precedent), does not change `resumeDecisionsFor()`'s per-gate decision domains (`loop/runner.ts`, unmodified), and does not add a third gate_mode tier beyond manual/semi-auto (e.g. "fully auto including G3") — issue #63 doesn't ask for one and it would violate §3's safety boundary.

## 4. What actually shipped (implementation, already written before this PRD)

### 4.1 `src/profile/loader.ts`
- `ProfileConfig.workflow.gate_mode?: "manual" | "semi-auto"` — new optional field on the existing `workflow` block (sibling of `reject_threshold`).
- `assertProfileConfigShape()` gains a fail-closed check: if `workflow` is a plain object and `workflow.gate_mode` is present and is neither `"manual"` nor `"semi-auto"`, throws `ProfileConfigParseError` (mirrors the existing `profile`/`providers`/`roles` shape checks in the same function).

### 4.2 `src/cli/run-loop.ts`
- `AUTO_APPROVABLE_GATES: ReadonlySet<GateType>` — the closed `{G1_SEND_TO_TESTER, G2_SEND_TO_FIX}` set (§3.1).
- `AUTO_APPROVABLE_DB_STATE: Record<string, string>` — maps each of those two `GateType` values to its `LOOP_NODES` counterpart (`"g1"`/`"g2"`), used only by the gate-identity assertion (§5.1).
- `SEMI_AUTO_DECIDED_BY = "system (semi-auto)"` — the distinct audit-trail marker (Goal 2).
- `runInteractiveLoop()`: reads `deps.profileConfig.workflow?.gate_mode ?? "manual"` once per call (not once per gate — `gate_mode` is a per-run/per-profile setting, doesn't change mid-loop). Inside the loop, when `gateMode === "semi-auto" && AUTO_APPROVABLE_GATES.has(interrupt.gate)`: runs the gate-identity assertion (§5.1), prints an explicit `[semi-auto] auto-approved — <gate>` banner to the terminal (so a human watching along sees what happened even though they weren't asked), then resumes with `{decision:"approved"}` under `SEMI_AUTO_DECIDED_BY` — skipping the `Prompter` call entirely. Every other gate (including G1/G2 in `"manual"` mode, and always G3/Escalation) takes the pre-existing `decideForGate()` → `Prompter` → `resumeRun(..., decidedBy, ...)` path, unchanged.

### 4.3 Tests
- `src/profile/__tests__/loader.test.ts`: `gate_mode` accepted values (`"manual"`/`"semi-auto"`/absent), rejected values (fail-closed `ProfileConfigParseError`).
- `src/cli/__tests__/run-loop.test.ts`: semi-auto happy path (G1/G2 auto-approved, G3 still prompts, `decided_by` correctly attributed per gate — real `LoopEventEmitter`-observed `gate_decided` events, not mocked), semi-auto reaching Escalation (still prompts a human even in semi-auto), `"manual"` explicit behaves identically to absent, and (added in this round, §6) the gate-identity mismatch test.

## 5. Zorro/Codex independent review — FAIL, and this round's fixes

The independent review (Zorro + Codex cross-model second signature) found the implementation itself correct in its gate-routing logic, but failed it on 2 blockers + 1 hardening recommendation:

### 5.1 Blocker — gate-identity assertion (hardening, done as part of this round)
**Finding**: the semi-auto branch decided whether to auto-approve based solely on `interrupt.gate` (a value threaded through from `computeRunProgress()`), then unconditionally sent `{decision:"approved"}`. Nothing cross-checked that value against the DB-persisted `workflow_runs.current_state` before acting on it. Concretely: `resumeRun()`'s own existing domain check (`resumeDecisionsFor(run.currentState).includes(resume.decision)`, `loop/runner.ts:1078-1079`) does **not** catch a G1/G2-vs-G3 confusion, because `"approved"` is a valid decision for *both* G1/G3's domain (`["approved","rejected"]`) — so if `interrupt.gate` and `current_state` were ever to disagree (should be unreachable in real code, since both derive from the same read), an auto-approval could reach G3 without being caught by that pre-existing guard.
**Fix**: added a 2-line assertion in `run-loop.ts`'s semi-auto branch — `deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]` → throw, before ever constructing the auto-approval resume value. Test: `src/cli/__tests__/run-loop.test.ts`, `"refuses to auto-approve when workflow_runs.current_state disagrees with interrupt.gate"` — forces the disagreement via a second, independent `better-sqlite3` write connection to the same run's row (the same technique `loop/__tests__/runner.test.ts` already uses for read-side DB assertions), then asserts `runInteractiveLoop()` rejects with a gate-identity-mismatch error and the `Prompter` was never consulted.

### 5.2 Blocker — `reject_threshold` fail-closed validation
**Finding**: `cli/assemble.ts`'s `resolveRejectThreshold()` accepted any `typeof === "number"` value from `profileConfig.workflow.reject_threshold` with no further validation — unlike its sibling `resolveSchemaMaxAttempts()` (same file), which already guards with `Number.isInteger(fromProfile) && fromProfile >= 1`. A YAML `.nan`/`.inf` tag parses to a real JS `NaN`/`Infinity` (`typeof "number"`, but not an integer), which would have been returned as-is from tier 1 of the three-tier chain. Consequence: `loop/runner.ts:725`'s `rejectCount >= rejectThreshold` escalation check can never be true against a `NaN`/`Infinity` threshold — silently defeating the reject-count-to-Escalation safety net entirely, which §3's semi-auto safety boundary explicitly depends on to still reach a human when the loop is stuck.
**Fix**: `resolveRejectThreshold()` now applies the exact same `Number.isInteger(fromProfile) && fromProfile >= 1` guard as `resolveSchemaMaxAttempts()` (copied verbatim, not a new pattern) — an invalid tier-1 value now falls through to tier 2 (`SystemConfig.getDefaultRejectThreshold()`) / tier 3 (hardcoded `2`), matching this function's own pre-existing three-tier fallback design (an existing test already proves a non-number value falls through this way; this round extends the same falls-through behavior to `NaN`/`Infinity`/negative/zero/non-integer values, which were previously — incorrectly — treated as valid tier-1 values). Tests: `src/cli/__tests__/assemble.test.ts`, `it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` all fall through to tier 2, plus a regression test confirming a genuinely valid `reject_threshold: 1` is still accepted at tier 1 (the guard isn't overly strict).

### 5.3 Blocker — zero documentation for a security-sensitive feature (this document)
**Finding**: `run-loop.ts`/`loader.ts`'s doc comments referenced "the PRD's explicit requirement" for keeping G3/Escalation human, but no PRD existed anywhere in the repo for issue #63 — a dangling reference for a safety-sensitive behavior (auto-approving human review gates). Anti-hallucination policy treats an unverifiable "per the PRD" citation as a hallucination risk regardless of whether the underlying code is correct.
**Fix**: this document (`docs/feature/semi-auto-gate-mode/PRD.md`), plus updating both dangling-reference call sites (`run-loop.ts`'s file header and its `AUTO_APPROVABLE_GATES` doc comment, `loader.ts`'s `gate_mode` field doc comment) to point here instead of an unqualified "the PRD," plus a new `workflow.gate_mode` subsection in `docs/DESIGN.md` (the repo's authoritative design doc, which already documents `workflow.reject_threshold` in the same `config.yaml` example block) linking back to this PRD.

## 6. Acceptance criteria

- [x] `workflow.gate_mode` absent or `"manual"` → zero behavior change (existing tests unmodified and green).
- [x] `workflow.gate_mode: "semi-auto"` → G1/G2 auto-approve, no `Prompter` call, `decided_by = "system (semi-auto)"`.
- [x] G3/Escalation always prompt a human, in every mode — including when semi-auto's loop reaches Escalation.
- [x] Invalid `gate_mode` value → `ProfileConfigParseError` at profile load time, not a silent default/ignore.
- [x] `reject_threshold` fail-closed for `NaN`/`Infinity`/negative/zero/non-integer (this round's blocker 2 fix).
- [x] Gate-identity defensive assertion in the semi-auto auto-approval path, with a test proving it fires (this round's hardening fix).
- [x] No dangling "per the PRD" references anywhere under `src/` (`grep -rn "per the PRD" src/` returns only the genuine, existing A5 `docs/feature/a5-cli-tui/PRD.md` references).
- [ ] `pnpm lint && pnpm build && pnpm test` all green — see `progress.md` for the final numbers.
- [ ] Zorro re-review (this round) — PASS.
- [ ] Commander approval → commit/push (not done by Cypher).
