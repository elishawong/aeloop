# Zorro Review Report — aeloop A4a Loop Orchestration (Round 1)

> Independent adversarial review by auditor Zorro. Producer (Cypher) ≠ reviewer (Zorro).
> Cross-model double sign-off: Codex `gpt-5.6-sol` (read-only sandbox) + Claude mutation testing, dual-engine, catching each other's hallucinations.
> Branch `feature/issue-13-a4a-loop`, HEAD before review `539f650` (working tree not committed).
> Related: [elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13) | upstream [ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)

---

## Codex independent review attestation (embedded verbatim, wrapper output, not a single character changed)

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-20T23:30:14.801Z",
  "completed_at": "2026-07-20T23:38:00.315Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "aeloop A4a Loop milestone: src/loop/ graph+gates+nodes+checkpoint+types+e2e vertical slice",
  "git_commit": "539f6504a636ae93298f6632cc53e9099174893d",
  "diff_base": "539f6504a636ae93298f6632cc53e9099174893d",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "09a322c146447c3ee6ff2c5c2fe87dab2cc6943fc84734ebeaa7a9ce732cd464",
  "independent_review_completed": true,
  "fallback_used": false
}
```

- `raw_output_sha256`: `09a322c146447c3ee6ff2c5c2fe87dab2cc6943fc84734ebeaa7a9ce732cd464` (non-empty, independent review genuinely completed)
- Codex's sandbox is read-only: it can read source/diff/docs, run `pnpm lint`/`tsc --noEmit`, and directly execute fixtures, **but cannot run `pnpm test`** (read-only blocks Vitest from creating its `.vite-temp` scratch directory — all 30 suites hit EPERM before import completes). Test red/green evidence is supplied by **Zorro running outside the sandbox** (below); Codex handles static/logical verification — division of labor is correct.

## Review verdict: **FAIL**

- **Blockers: 1** | **Minor: 2**
- **Both models independently judged FAIL**, and both landed on the same root cause (Deviation 3: the real `graph.ts`'s non-happy-path topology has zero test coverage).
- The production `pathMap`'s current static values **match the PRD** (no live bug is shipping right now), but the missing coverage means **any future change to the real graph's reject edges could ship green**, violating an explicit acceptance item in PRD §8 + DESIGN §8.5's anti-"isolated green tests" methodology.

---

### 🔴 Must fix (blocker)

**B1 — Real `graph.ts`'s reject / fix-forward conditional edges have zero behavioral coverage (final ruling on Deviation 3)**
- **Location**: `src/loop/graph.ts:73-83` (the three pathMap targets for review→g2, g2→draft, g3→draft) | violates `docs/feature/a4a-loop/PRD.md:267` (acceptance item: "every branch of `addConditionalEdges` … must have at least one test that actually exercises it") | DESIGN §8.5's anti-isolated-green-test stance.
- **Root cause**: `graph.test.ts` uses a **locally re-implemented** `buildToyGraph()` (`src/loop/__tests__/graph.test.ts:88-103`) that **copies the production `pathMap` a second time** — all reject/fix-forward branches run against this duplicate graph. The real `buildLoopGraph()` is only invoked by `checkpoint.test.ts:125/141` and `loop.e2e.test.ts:137`, and **both of those only walk the happy path** (`G1 approved → review pass → G3 approved → apply`). In the real graph, `G1 rejected→draft`, `G2 approved→draft`, `G3 rejected→draft` (and the real graph's G2 fail-loud path) **have never actually been exercised by any test**.
- **Mutation evidence (Zorro ran this personally, decisive)**:
  - Changed the real `graph.ts`'s G2 pathMap `draft: LOOP_NODES.draft` to `draft: LOOP_NODES.apply` (structurally valid — `draft` is still reachable via `START→draft`, so it does not trigger `UnreachableNodeError`) → **all 26 loop tests still pass green**. This is exactly the "duplicate graph correct, production graph broken, still all green" scenario PRD §8:267 is meant to guard against.
  - Control: changed the real `graph.ts`'s **happy-path** edge (G1's `review: LOOP_NODES.review` → `draft`) → `checkpoint.test.ts` + `loop.e2e.test.ts` **immediately turn red** (the happy path is indeed covered by the real graph). So what's precisely missing is **the real, non-happy-path edges**, not everything.
  - Note: if `review→g2` were mis-mapped, `g2` would become unreachable and LangGraph's compile-time `UnreachableNodeError` would incidentally catch it (a structural check, not a behavioral test); but mis-mapping `G2→draft`/`G3→draft` leaves `draft` still reachable, a pure behavioral error with zero alarm.
- **Both models agree**: Codex (gpt-5.6-sol) independently flagged the same blocker (see its eight-point checklist #1); Zorro's mutation testing confirmed it empirically. When Cypher self-reported Deviation 3 in the PRD, they claimed B4/B5 "indirectly cover" the real graph — mutation testing proves that coverage **only reaches the happy path, not the reject branches**; the "indirect coverage" claim does not hold.
- **Suggested fix (low-risk, not a redesign)**: Have `graph.test.ts` drive the real `buildLoopGraph()` directly (swap the draft/review dependencies for a `FakeAdapter`, reusing the FakeCoder/FakeTester technique already present in `checkpoint.test.ts`), and exercise G1 reject / review reject→G2 approve / G3 reject / G2 fail-loud, each branch once, against the real graph; or append reject-path cases to `checkpoint.test.ts`. The core requirement is that **every real conditional edge in the graph be walked at least once by the real `buildLoopGraph()`**, eliminating the "duplicate topology" as a second source of truth that can drift.

### 🟡 Should fix (minor, not FAIL-triggering, but should be fixed alongside the rework)

**M1 — The comment/PRD statement that `gateLog` "only lives in memory and disappears on process exit" is inaccurate**
- **Location**: `src/loop/types.ts:63` ("it does not survive process exit") + `docs/feature/a4a-loop/PRD.md` §9.2#3.
- **Reality**: `gateLog` is an Annotation channel of `LoopState` (`types.ts:112`); the real graph is compiled with `SqliteSaver` (`graph.ts:92`), and LangGraph serializes **the entire state (including gateLog) into the SQLite checkpoint** — `checkpoint.test.ts`'s two-phase resume is exactly what proves the whole state survives on disk and can be recovered. The accurate statement should be "gateLog **is not written into A4b's `approvals` business table**," not "only in memory / disappears on process exit." There is no functional bug (A4a indeed does not build the business table); this is purely an over-claiming comment/PRD wording issue, a minor hallucination-gate finding. Both models agree (Codex eight-point checklist #8 / §9.2#3).

**M2 — Fixture header's "ONLY by codex-cli-adapter.test.ts" statement is stale**
- **Location**: `src/harness/adapters/__tests__/fixtures/fake-codex.fixture.mjs:3` ("used ONLY by codex-cli-adapter.test.ts").
- **Reality**: This fixture is now also spawned by `src/loop.e2e.test.ts:59/89` (the `tester-pass` scenario). The header does have a newly added "**A4a addition**" block explaining tester-pass, but the "ONLY" wording on line 3 was not updated to match. Documentation staleness, minor.

### ✅ Checked and OK (independently verified, not taken on self-report)

- **Placeholder rejection**: No TODOs/stubs/fake data masquerading as real (both Codex + Zorro checked independently, zero hits).
- **Dangerous code**: No destructive deletes/plaintext secrets/injection/unauthorized egress/privilege escalation (confirmed by Codex).
- **G2 fail-loud**: `routeAfterG2` (`gates.ts:141-144`) throws `UnhandledGateDecisionError` for anything other than `"approved"`; G1/G3 default-throw a plain `Error` — the distinction is reasonable (both G1/G3 branches are implemented, default = broken-state fallback; G2's `"rejected"` is a legal `GateDecision` but A4a deliberately gives it no target, hence a dedicated error type). **Mutation evidence**: removing `routeAfterG2`'s throw and replacing it with an unconditional `return "draft"` → the "G2 non-approved throws" case in `graph.test.ts` turns red.
- **rejectCount increment semantics**: `tester.ts:63` only increments on `verdict === "reject"`; A4a has zero code that reads `rejectCount` for routing decisions (threshold logic deferred to A4b). **Mutation evidence**: changing it to unconditionally `state.rejectCount + 1` → the "does not change rejectCount when pass" case in `tester.test.ts` turns red.
- **Four-layer no-reverse-dependency**: `grep -rln "from.*loop" src/harness src/context src/prompt` → **zero hits**; `src/loop/*` only imports `harness/`/`prompt/`, and context is type-only (`types.ts:16`).
- **Zero spawn/fetch in the loop layer**: `grep -rn "spawn\|fetch(" src/loop --include="*.ts"` → **zero hits**.
- **Checkpoint non-closure-state resume**: `checkpoint.test.ts` discards all phase-1 objects, then resumes to completion with a brand-new instance + same db path + same thread_id. **Mutation evidence**: changing `createSqliteCheckpointer` to return a fresh `MemorySaver` (no shared disk) → `checkpoint.test.ts` turns red (`fs.existsSync(dbPath)` is false) — proving this test genuinely depends on cross-instance disk state, not a false green.
- **Vertical slice truly wired end-to-end**: `loop.e2e.test.ts` genuinely runs MemoryStore→ContextInjector→PromptComposer→`buildAdapterRegistry`→ProviderRouter→a real cli-bridge adapter (real spawn of a fixture subprocess)→a real graph→a real SqliteSaver→G1/G3 interrupt+resume→`applied:true`, the only stand-in being the fixture subprocess. Role bindings coder→claude-cli / tester→codex-cli match the real `profiles/subscription/config.yaml:18`. **Mutation evidence**: swapping the roles in the e2e config → `SchemaValidationError` (coder receives the tester fixture, which lacks `diff`), proving the binding is genuinely behavior-verified and a reversed binding does not silently pass.
- **tester-pass fixture is non-contaminating**: only adds an independent `case`, does not modify any existing A3 scenario; its output conforms to `TesterOutput` (`verdict:"pass"`/`issues:[]`/valid `claims[]`/`confidence`). All existing A3 tests still pass green (included in the 254/254 below).
- **Command verification (Zorro ran these outside the sandbox)**: `pnpm build` (tsc strict + noUncheckedIndexedAccess) = passes; `pnpm lint` (`tsc --noEmit`) = passes; `pnpm test` = **254/254 green (30 suites)**. After all mutations were fully run and reverted, the working tree was restored and re-run — still 254/254 green.

### The seven gates

- Requirement alignment **[✗]** (B1: PRD §8:267's acceptance item for real-graph branch coverage not satisfied) | Blast radius **[✓]** | Placeholder rejection **[✓]** | Dangerous code **[✓]** | Hallucination check **[✗]** (M1: the claim that `gateLog` doesn't persist to disk contradicts the real checkpoint behavior; Deviation 3's self-reported "indirect coverage" was disproven by mutation testing) | Documentation completeness **[✓]** (PRD/spike/impact/this report all present; M2 is pre-existing fixture header staleness, not a missing item) | Documentation sync (major-design-doc level only) **[N.A.]** (A4a does not touch the four authoritative documents BASE-ARCHITECTURE/AI_COMPANY_PLAN/CORE/CLAUDE)

### 📚 Knowledge base (verified, not maintained)

- Does this change touch an already-indexed module **[Yes]** — `CHARTS/knowledge/aeloop.md` (ai-agent repo) gains 5 new Loop-layer index entries in this increment (types/errors/workflow-def | nodes | gates | checkpoint | graph).
- Still accurate against the real code **[✓]** — verified interface signatures line by line (`buildLoopGraph`/`compileLoopGraph`/`LoopGraphDeps`/`createGateNode`'s four params / the four `routeAfter*` return types / `GateDecision`/`GatePayload`/`GateLogEntry`/`LoopNodeName` including the `Exclude<...,"__end__">` boundary / `createSqliteCheckpointer`) — all match the real code; the dependency direction, and the fact that "graph.test.ts doesn't call buildLoopGraph but re-implements the topology locally," **was also honestly recorded in the knowledge base** (consistent with Deviation 3). No dangling references, no path drift.
- If drift was found, was Cypher required to sync it **[N.A.]** — no drift found. One suggestion: once B1's coverage gap is closed via rework, the knowledge base's graph.ts entry line "graph.test.ts re-implements the topology locally, doesn't call buildLoopGraph" should be updated accordingly (at that point the real graph will be directly tested).

---

## Review-cycle guidance

Cypher fixes B1 (every conditional edge of the real graph must be walked by `buildLoopGraph()` at least once) + fixes M1/M2 along the way → Zorro Round 2 re-review (focus: re-run the B1 mutation above — mis-mapping the real graph's reject edges must turn the corresponding tests red) → pass + green CI → hand to the commander for final approval. **No commit / no merge without the commander's approval.**

---
---

# Round 2 Review (after rework)

> Cypher reworked the three items per the R1 report (B1 + M1 + M2). Zorro independently verified, did not take self-reports at face value. Branch `feature/issue-13-a4a-loop`, HEAD before review `539f650`, not committed.

## Codex R2 independent review attestation (embedded verbatim, wrapper output)

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-20T23:57:16.091Z",
  "completed_at": "2026-07-21T00:02:20.975Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "aeloop A4a Loop R2 rework: graph.test.ts real-graph coverage + M1 gateLog comment + M2 fixture header",
  "git_commit": "539f6504a636ae93298f6632cc53e9099174893d",
  "diff_base": "539f6504a636ae93298f6632cc53e9099174893d",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec",
  "independent_review_completed": true,
  "fallback_used": false
}
```

- R2 `raw_output_sha256`: `ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec` (non-empty, different from R1's `09a322c1…`, a genuine independent execution for this round).
- Codex R2's first launch appeared to hang on a cross-repo timeout with no result (known issue ai-agent#115); **a bounded retry** produced real output (started 23:57 → completed 00:02, ~5 min). Same read-only sandbox as R1; `pnpm test` still blocked by EPERM; test red/green evidence is supplied by Zorro running outside the sandbox.

## R2 verdict: **FAIL** (both models agree)

- **Blockers: 1 (B1 narrowed but not fully closed)** | **Minor: 2**
- B1's **big hole has been fixed** (the real graph is no longer untested); but Codex caught a residual gap **that my own R2 mutation set missed** — exactly the value of cross-model double sign-off, recorded honestly here.

### 🔴 Must fix (blocker)

**B1-residual — the G3 reject→draft case lacks a "draft must actually re-run" regression assertion; one class of sneaky mis-map can still ship green**
- **Location**: `src/loop/__tests__/graph.test.ts:248-271` (the "G3 rejects once" case) | real edge `src/loop/graph.ts:82` (`draft: LOOP_NODES.draft`).
- **Root cause**: this case, after G3 reject, **only asserts `next===[g1]`** (line 262) — unlike its sibling cases, it does not also grab `coder` and assert `coder.calls===2` (compare: the G1-reject case line 199 and the G2-approve case line 236 both pin `coder.calls===2` to prove draft genuinely re-ran).
- **Mutation evidence (Zorro ran this personally, decisive)**: changed the real `graph.ts`'s G3 `draft: LOOP_NODES.draft` to `draft: LOOP_NODES.g1` (sneaky — skips the coder re-draft and jumps straight back to g1; the observed `next` value is still `[g1]`) → **all 5 graph.test.ts cases still pass green**. My own R2 mutation round used `draft→apply` for the G3 mutation (loud — caught by `applied`/`next`, turns red), so **I alone would have missed this one**; Codex surfaced the residual gap using `draft→g1`. It took the two models cross-checking each other to catch it.
- **Why this is a real bug, not nitpicking**: the semantics of G3-reject→draft are "final sign-off rejected → coder redrafts with the feedback." If it's mis-wired to →g1 instead, a G3 rejection would loop g1→review→g3 endlessly reviewing the same, **never-modified** diff — the feedback would never reach the coder. A genuine functional defect worth locking down with a regression assertion.
- **Suggested fix (one-line-level)**: in the "G3 rejects once" case, grab `coder` from `buildDeps`, and after the G3 reject, add `expect(coder.calls).toBe(2)` (+ optionally assert that the second coder prompt contains G3's `reasoningText`), aligning it with its two sibling cases G1-reject/G2-approve.

### 🟡 Should fix (minor)

**M1-residual — `types.ts:66` comment over-claims what checkpoint.test proves**
- The comment states "phase 2's brand-new instance reads back a `gateLog`-bearing state from disk." But `checkpoint.test.ts` pauses at an **undecided G1**, at which point `gateLog` is still the initial empty array (`checkpoint.test.ts:94` `gateLog: []`), and the test **never asserts gateLog's contents across instances**. The **mechanism-level judgment that gateLog gets persisted via SqliteSaver is correct** (graph.ts:92 configures a checkpointer, and gateLog is an Annotation channel) — it's only the claim that "this specific test proves gateLog's content survives across instances" that over-states things. Fix: soften the wording (what this test proves is that **the entire state** survives across instances; the actual proof that gateLog has content and gets checkpointed is in the `final.gateLog` assertion at the end of `loop.e2e.test.ts` — the comment could reference that instead). Both models agree.

**M2-new — two comments post-rework still call graph.test.ts a "toy graph/toy nodes" setup, now stale**
- `src/loop/graph.ts:9` ("`graph.test.ts` deliberately verifies it first, with toy nodes") + `src/loop.e2e.test.ts:18` ("not a toy graph (that's `graph.test.ts`'s job)"). The rework already changed graph.test.ts to be FakeAdapter-backed against the real graph — it's no longer a toy graph/toy nodes. Both lines need to be updated to match. Documentation staleness.

### ✅ Rework acceptance (independently verified)

- **B1's fix is a real graph, not another duplicate**: `graph.test.ts:48` genuinely imports `buildLoopGraph`/`compileLoopGraph`; all five cases drive the real graph via `compileLoopGraph(buildLoopGraph(deps), ...)`; the file contains **zero** `new StateGraph`/`addNode`/`addConditionalEdges`/`buildToyGraph` topology definitions (only comments/describe strings mention the history). **The big hole is closed** — both models independently confirm "this is a real graph, no residual duplicate."
- **Mis-map capture for every real conditional edge (Zorro's R2 mutations, one by one, decisive)**:
  - G1 rejected→draft: mis-map `→apply` → the "G1 reject once" case **turns red behaviorally** ✓
  - G2 approved→draft: mis-map `→apply` → the "tester rejects once" case **turns red behaviorally** ✓
  - G3 rejected→draft: mis-map `→apply` → the "G3 rejects once" case turns red behaviorally ✓; **but** mis-map `→g1` (sneaky) → **stays fully green** (see blocker B1-residual).
  - review→g2: mis-map `→apply` → compile-time `UnreachableNodeError` (g2's sole inbound edge is orphaned) — caught by a **structural check** (Cypher's self-report on this is accurate — this is the one edge that relies on structural rather than behavioral assertions, and it's still fail-closed and unshippable).
  - Happy-path edges (G1 approved→review, review pass→g3, G3 approved→apply): covered by the happy-path case + e2e/checkpoint (already proven in R1).
- **M1 behavior is correct**: gateLog is a concat-reducer Annotation channel (`types.ts:112`); the real graph in `graph.ts:92` is configured with SqliteSaver → the entire state gets persisted to disk; A4a contains no code that writes to A4b's `approvals` table.
- **M2 confirmed**: the fixture header now says "also spawned by `src/loop.e2e.test.ts`"; the e2e does indeed use it as the `bin` for `codex-cli` (`loop.e2e.test.ts:59/121/165`).
- **No regressions**: `pnpm build`/`pnpm lint` pass; `pnpm test` = **254/254 green (30 suites, same count as R1 — graph.test.ts still has 5 cases)**; items already marked PASS in R1 remain intact — G2 fail-loud (`gates.ts:141` typed error), the four-layer no-reverse-dependency (grep zero hits), zero spawn/fetch in the loop layer (grep zero hits), the vertical slice truly wired end-to-end, and checkpoint non-closure-state resume all still hold.
- **FakeTesterAdapter queue**: reads `calls` before incrementing it; `["reject","pass"]` order is correct, no off-by-one (both models agree).

### The seven gates (R2)

- Requirement alignment **[✗]** (B1-residual: the spirit of PRD §8:267's "every branch actually exercised by a test" — the G3-reject branch was exercised but not locked against mis-map, inconsistent with its siblings) | Blast radius **[✓]** | Placeholder rejection **[✓]** | Dangerous code **[✓]** | Hallucination check **[✗]** (M1-residual: comment over-claim) | Documentation completeness **[✓]** (M2 is comment staleness, not a missing item) | Documentation sync (major-design-doc level only) **[N.A.]**

### 📚 Knowledge base (R2 verification)

- The knowledge base `CHARTS/knowledge/aeloop.md`'s graph.ts entry line "graph.test.ts re-implements the topology locally, doesn't call buildLoopGraph" has been synced by Cypher as part of the rework (now reads "directly calls the real buildLoopGraph to drive it") — verified consistent with the real graph.test.ts **[✓]**, no new dangling references.

### R2 verdict summary

R1's blocker (the real graph had **zero** test coverage) **is fixed**; one **narrowed** blocker remains (the sneaky mis-map on the single G3-reject edge isn't locked down by a behavioral assertion) + 2 minor comment issues. **The fixes are all one-line-to-few-line level, with zero production logic changes** (production `graph.ts` was not touched at all this round; R1's Codex double-sign-off `09a322c1…` already covers its production logic). Once Cypher adds the `coder.calls===2` assertion to the G3-reject case + fixes the two comments → Zorro Round 3 only needs to re-run the G3 `draft→g1` mutation to confirm it turns red, and this closes the loop. **No commit / no merge without the commander's approval.**

---
---

# Round 3 Review (closing the loop)

> Cypher fixed the three items per the R2 report (B1-residual blocker + M1 + M2). Zorro focused on closure, independently verified, did not take self-reports at face value. Branch `feature/issue-13-a4a-loop`, HEAD before review `539f650`, not committed.

## R3 verdict: **PASS** ✅ — A4a closed

- All three items (1 blocker + 2 minor) genuinely fixed and verified via mutation/code inspection; build/lint/`pnpm test` **254/254 green**; working tree restored byte-identical.

## Codex R3: **double sign-off waived** (reason stated honestly, no fabricated sha claimed)

R3's changes are **test-assertion + comment level only, zero production logic changes**:
- Personally ran `git diff` on production `graph.ts`: **byte-identical** to post-R2, except lines 9-12's comment block, whose wording changed (from "with toy nodes" to "driving this file's real buildLoopGraph()/compileLoopGraph() with FakeAdapter-backed deps"); the `addNode`/`addEdge`/the four `addConditionalEdges`' pathMap targets are **unchanged, character for character**.
- R2's Codex double sign-off `ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec` (non-empty) already independently reviewed this **unchanged** production logic.
- The B1-residual fix is a **test-assertion strengthening**, and whether it's actually closed is determined by a **deterministic mutation test** (G3 `draft→g1` → `expected 1 to be 2`) — this is a model-independent, objective check, not a judgment call that needs a second model.

On this basis, R3's Codex run is waived (authorized by the strategist: production logic unchanged + R2's double sign-off already covers it + R3 is pure test/comment). **No R3 sha was obtained, and none is fabricated**; A4a's independent double-sign-off evidence across all rounds is the two genuine signatures R1 `09a322c1…` (covering the initial production logic) + R2 `ce3fa54…` (covering the post-rework, unchanged production logic).

## R3 decisive verification (Zorro ran these personally, outside the sandbox)

### ✅ B1-residual closed (decisive)
- **Mutation**: real `graph.ts:84` `draft: LOOP_NODES.draft` → `draft: LOOP_NODES.g1` (the sneaky mis-map surfaced in R2: skips the coder re-draft, still stops at g1).
- **Result**: the "G3 rejects once" case **turns red**, reporting `AssertionError: expected 1 to be 2` — caught by the new `expect(coder.calls).toBe(2)` Cypher added (`graph.test.ts:266`, + the pre-reject baseline `toBe(1)` on line 258). In R2, this same mutation slipped through all-green undetected; it is now locked down. Broke it → confirmed red → restored byte-identical.

### ✅ No regression from the loud mutations (regression sweep)
All three G1/G2/G3 reject edges simultaneously mis-mapped to `→apply` → the three corresponding cases (G1-reject / tester-rejects / G3-reject) each **turn red behaviorally**, no `UnreachableNodeError`, no regression. Restored byte-identical.

### ✅ Production graph.ts changed only in comments
`diff /tmp/graph.r2.bak src/loop/graph.ts` = only the lines 9-10→9-12 comment block; pathMap/edges are character-for-character identical. Cypher's self-report of "only changed comments" **personally verified via diff**, no misrepresentation.

### ✅ M1 comment now matches real behavior (hallucination gate passes)
`types.ts:62-72`'s revised wording: what checkpoint.test's two-phase resume proves is that "the whole state survives"; its interrupt point is at an **undecided G1, gateLog still `[]`**, and it never asserts gateLog's contents. What actually verifies gateLog's content surviving across a checkpoint is `loop.e2e.test.ts`'s final `final.gateLog` assertions. **Verified**: `loop.e2e.test.ts:189-190` does indeed assert on `final.gateLog.filter(entry => entry.gate === "G1_SEND_TO_TESTER"/"G3_FINAL_MERGE")` entries for G1/G3. Wording now matches the actual code/test behavior, no longer over-claiming.

### ✅ M2 comment updates confirmed
The stale "toy graph/toy nodes" wording in `graph.ts:9-12` + `loop.e2e.test.ts:18` has been updated (graph.ts now reads "driving real buildLoopGraph with FakeAdapter-backed deps"; e2e now reads "driven here with real subprocess-backed ModelAdapters, not FakeAdapter-backed deps — that's graph.test.ts/checkpoint.test.ts's job"). Consistent with graph.test.ts's real post-rework shape.

### ✅ No regressions
`pnpm build` (tsc strict + noUncheckedIndexedAccess) = passes; `pnpm lint` = passes; `pnpm test` = **254/254 green (30 suites)**.

## The seven gates (R3, all pass)

- Requirement alignment **[✓]** (PRD §8:267: every conditional edge of the real graph has its mis-map caught: 3 reject edges locked by behavioral assertions + review→g2 backstopped by structural checking + happy-path edges covered by e2e/checkpoint) | Blast radius **[✓]** | Placeholder rejection **[✓]** | Dangerous code **[✓]** | Hallucination check **[✓]** (M1/M2 comments now both match real behavior) | Documentation completeness **[✓]** | Documentation sync (major-design-doc level only) **[N.A.]**

## 📚 Knowledge base (R3)

No further knowledge-base changes touched this round; R2 already confirmed `CHARTS/knowledge/aeloop.md`'s graph.ts entry matches the real graph.test.ts, and there is no production/test shape change this round that would cause drift **[✓]**.

## A4a final verdict

**PASS.** After three rounds of adversarial review (R1 FAIL→R2 FAIL→R3 PASS): every `addConditionalEdges` branch of the real graph `buildLoopGraph()`/`compileLoopGraph()` (including every reject/fix-forward return edge) is now locked down by behavioral tests driven against the real graph, and any pathMap mis-map (loud or sneaky) will be caught; the vertical slice is genuinely wired end-to-end, the four-layer no-reverse-dependency holds, the loop layer has zero spawn/fetch, checkpoint non-closure-state resume holds, G2 fail-loud holds; 254/254 tests green; cross-model double sign-off R1 `09a322c1…` + R2 `ce3fa54…` covers the evolution of production logic, R3 is pure test/comment and its sign-off was waived (stated honestly above). Working tree restored byte-identical, HEAD still `539f650`, not committed/pushed/merged. **Handed to the commander for final approval → only after approval may it be committed/merged.**
