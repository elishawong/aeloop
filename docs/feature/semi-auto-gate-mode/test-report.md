# Test report — #63 `workflow.gate_mode: "manual" | "semi-auto"`

> Round 1 was reviewed by Zorro (+ Codex independent cross-model second signature) outside this Cypher session — I (Cypher) did not witness that review directly; §1 below is my faithful paraphrase of the findings as relayed to me in this round's task briefing, not a verbatim transcript (I don't have the original report file — none exists under `docs/feature/semi-auto-gate-mode/` or anywhere else in the repo; this is in fact the first document in that directory). §2 onward is this round's (R2) own work, which I ran and verified myself and can state as first-hand fact.

---

## Round 1 — Zorro + Codex independent review: FAIL

**Verdict**: FAIL — 2 blockers, 1 strong hardening recommendation.

### Blocker 1 — zero documentation for a security-sensitive feature, dangling "per the PRD" references
`src/cli/run-loop.ts:141` and `src/profile/loader.ts`'s `gate_mode` doc comment referenced "per the PRD's explicit requirement" for the G3/Escalation-always-human safety invariant, but no PRD existed anywhere in the repo for issue #63 (`docs/feature/` had no `semi-auto-gate-mode/` directory at all before this round). For a feature that removes human review from two of four approval gates, an unverifiable citation to a nonexistent design document is a hallucination-risk red flag, not a cosmetic gap — a reader has no way to confirm the safety boundary was actually designed and reviewed, only asserted in a code comment.

### Blocker 2 — `reject_threshold` accepted `NaN`/`Infinity` as valid
`src/cli/assemble.ts:210-218`'s `resolveRejectThreshold()` only checked `typeof fromProfile === "number"` before returning it — no `Number.isInteger`/finiteness guard, unlike its sibling `resolveSchemaMaxAttempts()` (same file, ~line 243) which already had one. A YAML `.nan`/`.inf` tag parses to a real JS `NaN`/`Infinity` (both `typeof "number"`). Consequence: `src/loop/runner.ts:725`'s `rejectCount >= rejectThreshold` escalation check can never evaluate `true` against a `NaN`/`Infinity` threshold — under `workflow.gate_mode: "semi-auto"`, this would have meant an unattended, unbounded auto-approval loop that can never reach a human at Escalation, the exact backstop the semi-auto design depends on.

### Strong recommendation (treated as required, done as part of this round) — gate-identity assertion
`src/cli/run-loop.ts:199-206`'s semi-auto branch decided whether to auto-approve based solely on `interrupt.gate`, then unconditionally sent a generic `{decision:"approved"}`. Recommendation: assert that the run's real, DB-persisted pending gate is actually in `{G1, G2}` before ever auto-approving, so that even if `interrupt.gate` and DB state were ever to disagree, the system fails closed rather than potentially auto-approving G3.

---

## Round 2 (this round) — fixes and self-verification

### Fix 1 (blocker 1): documentation + dangling-reference cleanup
- Created `docs/feature/semi-auto-gate-mode/{PRD,impact,progress,test-report}.md` (this file included).
- `src/cli/run-loop.ts`: updated the file-header paragraph (originally lines 21-34) and the `AUTO_APPROVABLE_GATES` doc comment (originally lines 140-148, containing the exact dangling phrase Zorro flagged at line 141) to cite `docs/feature/semi-auto-gate-mode/PRD.md` instead of an unqualified "the PRD".
- `src/profile/loader.ts`: updated the `gate_mode` field's doc comment to cite the same PRD path (this file itself didn't contain the literal dangling phrase Zorro's report cited, but had zero documentation pointer at all for a fail-closed, security-relevant validation branch — added for the same reason).
- `docs/DESIGN.md` §7 (the `config.yaml` example block, which already documents `workflow.reject_threshold` in the same location): added `workflow.gate_mode: manual` to the example + a new paragraph explaining the semi-auto safety boundary, linking back to the PRD.
- **Verification**: `grep -rn "per the PRD\|the PRD's" src/` — all remaining hits are pre-existing, unrelated, legitimate references to other real PRDs (A2's `harness/provider-router.ts`, A4a's `loop/graph.ts`, A4a's `loop/__tests__/gates.test.ts` ×2) — none reference issue #63's now-real PRD.md incorrectly, and none are dangling.

### Fix 2 (blocker 2): `resolveRejectThreshold()` fail-closed guard
- `src/cli/assemble.ts`: added `Number.isInteger(fromProfile) && fromProfile >= 1` to the tier-1 check, copied verbatim from the sibling `resolveSchemaMaxAttempts()`'s own guard (same file) — not a new pattern. An invalid tier-1 value now falls through to tier 2/tier 3 of the existing three-tier chain, matching the fallback design this function already had for non-number values (a pre-existing test already proved a string value falls through this way).
- New tests (`src/cli/__tests__/assemble.test.ts`):
  - `it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` — all fall through to tier 2 (`SystemConfig`'s configured default), never returned as-is. 6 tests.
  - One regression test confirming a genuinely valid `reject_threshold: 1` is still accepted at tier 1 (guarding against the fix being overly strict). 1 test.
- **Mutation self-verification** (performed and witnessed directly in this session, not merely asserted): temporarily reverted the guard to the pre-fix `typeof fromProfile === "number"` check with no integer/finiteness/positivity constraint, reran `assemble.test.ts` — the 6 new `it.each` cases failed exactly as expected (each malformed value was returned as-is instead of falling through to the configured tier-2 value `7`), the other 36 tests in the file were unaffected. Restored the guard — all 42 tests in the file passed again.

### Fix 3 (hardening): gate-identity assertion
- `src/cli/run-loop.ts`: added `AUTO_APPROVABLE_DB_STATE: Record<string, string>` (maps each `GateType` in `AUTO_APPROVABLE_GATES` to its `LOOP_NODES` counterpart) and a 2-line assertion in the semi-auto branch — `if (deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]) throw ...` — executed before constructing the auto-approval resume value.
- **Why this closes a real gap, not just theater**: `resumeRun()`'s pre-existing domain check (`resumeDecisionsFor(run.currentState).includes(resume.decision)`, `loop/runner.ts:1078-1079`) does not catch a G1/G2-vs-G3 mismatch, because `"approved"` is a valid decision for both G1/G3's domain (`["approved","rejected"]`). If `interrupt.gate` and `workflow_runs.current_state` were ever to disagree, the pre-existing check alone would not have stopped an auto-approval from reaching G3.
- New test (`src/cli/__tests__/run-loop.test.ts`, `"refuses to auto-approve when workflow_runs.current_state disagrees with interrupt.gate"`): starts a real run to its G1 interrupt, then opens a second, independent `better-sqlite3` write connection to the same SQLite file (same technique `loop/__tests__/runner.test.ts` already uses for read-side DB assertions in this codebase) and directly `UPDATE`s `workflow_runs.current_state` to `'g3'`, forcing the disagreement `interrupt.gate` alone cannot express. Asserts `runInteractiveLoop()` rejects with a gate-identity-mismatch error and that the `Prompter` was never consulted (0 calls).
- **Mutation self-verification** (performed and witnessed directly in this session): temporarily removed the 3-line assertion block, reran `run-loop.test.ts` — the new test failed exactly as expected (`runInteractiveLoop()` resolved successfully instead of rejecting — the auto-approval went through against the mismatched state), the other 11 tests in the file were unaffected. Restored the assertion — all 12 tests in the file passed again.

### Final numbers (this session, run in this exact order)
```
pnpm lint   → clean (tsc --noEmit, 0 errors)
pnpm build  → clean (tsc -p tsconfig.build.json, 0 errors)
pnpm test   → 609/609 passed, 57 test files (baseline 601 + 8 new: assemble.test.ts +7, run-loop.test.ts +1)
```

### Scope discipline check
`git diff --stat` (full, this session's changes only): `docs/DESIGN.md` (+3), `src/cli/__tests__/assemble.test.ts` (+47), `src/cli/__tests__/run-loop.test.ts` (+182 incl. this round's addition), `src/cli/assemble.ts` (+25/-1), `src/cli/run-loop.ts` (+79), `src/profile/__tests__/loader.test.ts` (+59, R1), `src/profile/loader.ts` (+40, R1) — plus the 4 new files under `docs/feature/semi-auto-gate-mode/`. `git diff --stat -- src/loop` is empty — no production code under `src/loop/**` was touched in either round, matching the PRD's stated scope.

### Not yet done
- Zorro re-review of this round's fixes (R2) — not yet run.
- Commander approval → commit/push — not done (Cypher does not commit/push per the standing gate).

### Things I noticed but weren't in Zorro's original ask (flagged, not acted on beyond noting them)
- Issue #63's own body references "Design doc §5.2" for an "auto-until-threshold" model. I could not locate a `§5.2` anywhere in `docs/DESIGN.md` (that file has no `###`-level subsections at all — every heading is `##`). Not load-bearing for this PRD (the issue's own "What"/"Constraints" sections are unambiguous), but flagged as `[?]` in `PRD.md` §1 per anti-hallucination policy rather than silently treated as verified.
- `docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/`README.md` have no entry for issue #63 yet (unlike A5's B9 docs-wrap-up batch). Out of scope for this round (Helix's task briefing scoped this round to exactly the 2 blockers + 1 hardening ask + doc-link fix), noted here so it isn't silently forgotten.
