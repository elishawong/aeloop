# PRD — aeloop: Event System (LoopEvent + EventEmitter) — the engine's public observability API

> Anti-hallucination: `[?]` = unverified by me / needs Commander confirmation; no invented interfaces/versions/parameters. Every statement below about existing code comes from my own reading of `src/loop/{runner,types,gates,escalation,workflow-def,audit-store}.ts` + `src/loop/nodes/{coder,tester}.ts` + `docs/DESIGN.md` on this worktree's HEAD (`8a7c2a7`), not from memory. Every statement about LangGraph's own runtime behavior (§4) comes from `docs/feature/events-observability/spike-node-start.md` — a real, installed (`pnpm install`), runnable spike against `node_modules/@langchain/langgraph@1.4.8`'s real source, not from memory of LangGraph's docs. Judgment calls I made without direct instruction are called out explicitly in §9, not mixed into "verified" statements.

- **Project**: aeloop (`elishawong/aeloop`, private repo)
- **Branch**: `feature/issue-29-events`
- **Priority**: P1
- **Status**: Awaiting Commander confirmation
- **Last updated**: 2026-07-21 (rev. 2, + Zorro R1/R2 review-driven implementation fixes: §9.6's `emitProgressEvents` cadence risk turned out to also need gating to the *causal* chunk specifically — not just any `"updates"` iteration — to avoid duplicate/mis-ordered `gate_requested`/`run_completed`/`run_cancelled`; `safeErrorReason()` hardened; §9.9 known-limitations added. No PRD-level design change from these — implementation-level fixes within the already-agreed plan; see `progress.md` for the full round-by-round record.)
- **Related issue**: [elishawong/aeloop#29](https://github.com/elishawong/aeloop/issues/29)
- **Design authority**: issue #29 body (event catalog draft + 3 design-decision prompts) + real code `src/loop/runner.ts` (`runStreamAndPersist`/`computeRunProgress`/`startRun`/`resumeRun`) + `src/loop/gates.ts`/`escalation.ts` (graph-node zero-I/O-purity invariant) + `src/loop/nodes/{coder,tester}.ts` + `src/loop/workflow-def.ts` (`LOOP_NODES`/`GATE_TYPES`) + `docs/feature/events-observability/spike-node-start.md` (rev. 2's own empirical spike into `@langchain/langgraph@1.4.8`'s real `streamMode` behavior)

---

## Rev. 2 changelog (why this PRD changed after first being written)

Rev. 1 shipped `node_entered`/`agent_completed` with **completion-time** semantics (fires after a node's real work already finished) because `streamMode: "updates"` — the only mode `runner.ts` used — structurally cannot yield a pre-execution signal, and instrumenting node bodies to get one would break the zero-I/O-purity invariant `gates.ts`/`nodes/*.ts` are required to hold. Rev. 1 flagged this as `[?]`/open, un-installed-and-unverified.

指挥官 chose **Option C: real "node about to start" semantics**, explicitly accepting the risk that this might require crossing the purity line, and directed a spike-first investigation (per aeloop's A4a precedent) before touching this PRD further. That spike (`spike-node-start.md`) ran `pnpm install` for real, then empirically + source-verified that **`streamMode: ["updates", "tasks"]`** — an existing, documented LangGraph feature `runner.ts` simply never used — gives a genuine pre-execution ("task about to run") event with **zero changes to any node body**. The purity-violating fallback was never needed. This rev.:
- Adds a new event type, **`node_started`** (11 event types total, was 10).
- Renames `node_entered` → **`node_completed`** (same completion-time semantics as rev. 1, kept as a distinct, useful event — not removed).
- **Removes the rev. 1 "`node_entered` excludes gate nodes" special-casing** — now that `node_started`/`node_completed` come from a uniform mechanism (`"tasks"` mode / `"updates"` mode respectively) that costs nothing extra per node type, both fire for **all 8** real node names (`draft`/`g1`/`review`/`g2`/`g3`/`apply`/`escalation`/`cancel`), with `gate_requested`/`gate_decided`/`agent_completed` layered on top as more specific events for the nodes they apply to — a cleaner, more symmetric model than rev. 1's.
- Adds one new, real implementation risk: `runStreamAndPersist()`'s outer loop must switch from consuming bare `chunk` objects to `[mode, payload]` tuples, and `computeRunProgress()`/`audit.updateRunProgress()` must **only** run on `mode==="updates"` iterations (not `"tasks"` ones) to avoid silently doubling `AuditStore` writes/reads (spike §5).

---

## 0. Scope

**In scope (per issue #29's explicit boundary)**: define `LoopEvent` (a discriminated union) + a `LoopEventEmitter` class + emit calls at the correct points inside `runner.ts`, so external callers can subscribe to a real-time event stream of what the engine is doing.

**Out of scope (issue #29's explicit non-goal, verified against the issue body)**: `EventProjector` / SQLite event projection. That is a *consumer* of this event stream (a future, separate issue) — this PRD does not create a projector, does not add any new table, and does not touch `audit-store.ts`'s schema.

---

## 1. Problem / Users / Solution

- **Problem to solve**: today the engine has exactly two ways to observe a loop run, and neither is a real-time event stream. (1) `state.gateLog: GateLogEntry[]` (`src/loop/types.ts:156`, a `concat`-reducer Annotation) only has anything in it once you read `getState()`/`RunHandle` after a call returns — it is a **retrospective** log, not a push notification, and it only covers gate decisions, not draft/review/apply/cancel activity. (2) `runner.ts`'s `runStreamAndPersist()` (lines 309-480) privately interprets `compiled.stream(..., {streamMode:"updates"})` chunks and writes directly to `AuditStore` (`insertStepMarker`/`insertClaim`/`insertApproval`/`updateRunProgress`) — this is real-time, but it is **runner-internal and hardcoded**: nothing outside `runner.ts` can subscribe to it, and the only way to "watch progress" today is to poll `AuditStore`'s tables from a separate process. `grep -rn "EventEmitter\|LoopEvent\|emit(" src/` on this worktree returns nothing — there is no event vocabulary in the codebase at all.
- **Who it's for**: **#22 A5 CLI/TUI** (wants to render live progress — including a "coder is working..." spinner the instant a node starts, not just after it finishes — instead of polling `workflow_runs`/`structured_claims`/`approvals`); a future **EventProjector** (Persistence borrow-point from Verity — becomes a subscriber instead of `runner.ts` writing SQL directly, in a later issue); **#2 Conductor** (wants to drive human-approval UX off `gate_requested`).
- **One-sentence solution**: a new `src/loop/events.ts` defines `LoopEvent` (11 concrete event types under one discriminated union) + `LoopEventEmitter` (subscribe/unsubscribe + synchronous, exception-isolated `emit()`); `runner.ts`'s `StartRunDeps` gains an **optional** `events?: LoopEventEmitter` field, and `runStreamAndPersist()`/`startRun()`/`resumeRun()` emit the 11 event types — including a real pre-execution `node_started` sourced from LangGraph's own `streamMode: "tasks"` instrumentation (spike-verified, §4) — at points derived from data **already computed** in that file today, plus this one new `streamMode` value. No change to `gates.ts`/`escalation.ts`/`nodes/*.ts`/`audit-store.ts`, so the "graph nodes/gates maintain zero I/O purity" invariant (`runner.ts`'s own file header, lines 1-10: `grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` must stay empty) is untouched and still holds.

---

## 2. Goals / Non-goals

**Goals**:
- `src/loop/events.ts` (new): `LoopEvent` discriminated union (**11** members, see §4), `LoopEventListener` type, `LoopEventEmitter` class (`on()`/`emit()`), synchronous emit with per-listener exception isolation (§9 decision 3).
- `src/loop/runner.ts` (change): `StartRunDeps.events?: LoopEventEmitter` (optional — see §9 decision 1); `runStreamAndPersist()`'s `compiled.stream()` call switches from `streamMode: "updates"` to `streamMode: ["updates", "tasks"]` (spike-verified, no purity impact); `startRun()` emits `run_started`; `runStreamAndPersist()` (and therefore both `startRun()`/`resumeRun()`) emits the other 10 event types at the exact points in §4's table.
- Every event carries the run's identity (`runId`, `threadId`) + `ts` (ISO timestamp) as common fields, plus a `type` discriminant + type-specific payload fields.
- `node_started`/`node_completed` fire uniformly for **all 8** real node names — no gate-node exclusion (rev. 1 had one; removed in rev. 2, see changelog).
- A listener that throws (sync) or returns a rejected Promise (async) never crashes the loop and never affects `AuditStore` persistence (§9 decision 3, tested explicitly).
- `computeRunProgress()`/`audit.updateRunProgress()`'s call cadence is provably unchanged from today (once per real `"updates"` chunk, never on a `"tasks"` chunk) — a new, explicit acceptance criterion this rev. adds (§8).

**Non-goals (explicit, per issue #29, unchanged from rev. 1)**:
- ❌ `EventProjector` / any new SQLite table / any change to `audit-store.ts`'s schema or methods. Events are additive to the existing audit writes, not a replacement (§9 decision 2).
- ❌ Any change to `gates.ts`/`escalation.ts`/`nodes/coder.ts`/`nodes/tester.ts`/`audit-store.ts`/`types.ts`/`workflow-def.ts`. All eleven emit call sites live inside `runner.ts` only — confirmed achievable without touching any of these, per the spike (§9 decision 1 originally flagged this as *why* the emitter can't live in a graph node; the spike additionally confirms `node_started` doesn't need to either).
- ❌ Any CLI/TUI consumer of these events (that is #22's job — this PRD only builds the producer side).
- ❌ Backpressure / async queueing / event persistence / at-least-once delivery guarantees. `emit()` is fire-and-forget, synchronous, in-process only.
- ❌ Making `events` a **required** field on `StartRunDeps` (unchanged rationale from rev. 1 — ~64 existing call sites construct `StartRunDeps` with no `events` field today).
- ❌ Claiming `node_started` is a mathematically-provable "always strictly before the node's very first line of code runs" guarantee — the spike found a real (and, for this system's actual async nodes, practically negligible) JS-continuation-ordering caveat; see §4.4. This PRD ships the event with an honest doc-comment about that caveat, not an overclaimed guarantee.

---

## 3. User Stories

- As **the future A5 CLI/TUI**, I want a `node_started` event the moment the coder/tester node begins its real work, so I can show "coder is thinking..." immediately instead of only learning a round happened after it's already fully finished (rev. 1's `node_entered` couldn't do this — this is the whole reason 指挥官 asked for rev. 2).
- As **a future EventProjector**, I want a single, stable, typed event stream (not "reverse-engineer `runner.ts`'s private stream-chunk shape") to build a SQLite projection from.
- As **#2 Conductor**, I want `gate_requested` events (with the exact `GatePayload` a human needs to decide) so I can drive an approval UX without polling `getState()`.
- As **the Commander**, I want a guarantee that a buggy/throwing listener can never crash a run or corrupt the existing audit trail — demonstrated by a real test.
- As **the Commander**, I want confirmation that adding a second `streamMode` didn't silently double how often `AuditStore` gets written to or read from — demonstrated by a real test, not just asserted in a comment (this rev.'s new risk, see §5/§8).

---

## 4. Event Catalog (finalized, rev. 2)

### 4.0 Common envelope (unchanged from rev. 1)

```typescript
interface LoopEventBase {
  runId: number;      // WorkflowRun.id (AuditStore)
  threadId: string;   // LangGraph thread id
  ts: string;          // new Date().toISOString(), stamped at emit time
}
```

### 4.1 The mechanism: `streamMode: ["updates", "tasks"]` (spike-verified — see `spike-node-start.md` for full empirical evidence)

`runner.ts`'s `compiled.stream(input, {...cfg, streamMode: "updates" as const})` (current line 330) becomes `compiled.stream(input, {...cfg, streamMode: ["updates", "tasks"] as const})`. The outer `for await` loop's yielded value changes shape from a bare `chunk` object to a `[mode, payload]` tuple:
- `mode === "updates"`: `payload` is **byte-for-byte the same shape** `runner.ts` already consumes today (`{[nodeName]: partialStateUpdate}`, plus the `__interrupt__` key) — spike-confirmed, not just inferred from types. All of today's draft/review/gate/apply-cancel branch logic, and `computeRunProgress()`/`updateRunProgress()`, move one level deeper (gated behind `mode === "updates"`) with **zero change to their own bodies**.
- `mode === "tasks"`: `payload` is either a **create**-shaped object (`"input" in payload`, present *before* that node's own body has been invoked by `PregelRunner.tick()` — engine-level ordering, spike §2) or a **result**-shaped object (`"result" in payload`, after). Only the create shape is used (§4.2); the result shape is not needed (`"updates"` mode already covers node completion).

### 4.2 The 11 event types

| # | `type` | Verified emission point (file:function) | Payload (beyond `runId`/`threadId`/`ts`) | Verified? |
|---|---|---|---|---|
| 1 | `run_started` | `runner.ts` `startRun()`, immediately after `deps.audit.insertRun(...)` returns, **before** `compileLoopGraph`/`runStreamAndPersist` | `task, profile, workflowDefId, rejectThreshold` | ✅ verified against real `startRun()` body |
| 2 | **`node_started`** (**new in rev. 2**) | `runStreamAndPersist()`'s per-tuple loop, `mode === "tasks"` branch, when `"input" in payload` (create shape) — fires for **all 8** real node names (`payload.name`), before that node's own body is invoked by `PregelRunner.tick()` (spike §2's source-level confirmation; spike §4's caveat on *observed* timing) | `node: LoopNodeName` (excluding `"__start__"`/`"__end__"`), `stepRef?: string` (a **non-mutating preview** of what `nextStepRef()` will allocate for this node's next round — see §9.4; `undefined` for `apply`/`cancel`, which have no counter concept anywhere in this codebase) | ✅ mechanism spike-verified; exact TS narrowing of the `["tasks", StreamTasksOutput]` union member is a build-time detail (§9.6) |
| 3 | `node_completed` (**renamed from rev. 1's `node_entered`**, same completion-time semantics, now fires for all 8 nodes not just 4) | Same `mode === "updates"` per-node branches as rev. 1 (draft/review at their existing `nextStepRef()` call sites; gate nodes inside the existing `GATE_NODE_NAMES` branch; apply/cancel via the same new `else` branch rev. 1 already needed) | `node: LoopNodeName`, `stepRef?: string` (real, allocated value — same one `agent_completed`/`gate_decided` use for that round; `undefined` for apply/cancel) | ✅ verified against real code |
| 4 | `agent_completed` | Same draft/review branches, nested inside the existing `if (update.coderOutput && update.coderResult)` / `if (update.testerOutput && update.testerResult)` guards | `node: "draft"\|"review"`, `actor: "coder"\|"tester"`, `claimCount: number` | ✅ verified (unchanged from rev. 1) |
| 5 | `gate_requested` | **Finalized post-B1-fix** (Zorro R1; see §9.6/§9.9) — `computeRunProgress()`/`updateRunProgress()` still run on every `mode === "updates"` iteration unchanged, but emission of this event is gated behind `interruptSeenThisChunk`: only fires when the chunk just processed in the in-loop iteration was the causal chunk containing the `__interrupt__` key itself — never from the zero-chunk fallback branch (`if (!latestProgress)`), which only syncs progress and never emits. This is what makes the event fire **exactly once per gate**, always *after* that gate's own `node_started` — the original per-`computeRunProgress()`-call emission (any "updates" iteration where `progress.interrupt` happened to be truthy) is what R1 found duplicating/mis-ordering the event under LangGraph's run-ahead execution, and is not what shipped. | `gate: GateType`, `payload: GatePayload` | ✅ verified against shipped code + regression-tested (`runner.test.ts`'s exact-count/ordering assertions, R1's two dedicated regression tests) — **not** "unchanged from rev. 1," this emission logic is what B1 rewrote |
| 6 | `gate_decided` | `GATE_NODE_NAMES` branch, after `audit.runInTransaction(...)` returns (post-commit), once per `entry` | `gate: entry.gate`, `decision: entry.decision`, `decidedBy: decidedBy!` | ✅ verified (unchanged from rev. 1) |
| 7 | `tester_rejected` | Inside the `review` branch, when `testerOutput.verdict === "reject"` | `rejectCount`, `rejectThreshold` | ✅ verified (unchanged from rev. 1) |
| 8 | `escalation_triggered` | Same block as #7, guarded by `rejectCount >= rejectThreshold` | `rejectCount` | ✅ verified (unchanged from rev. 1) |
| 9 | `run_completed` | **Finalized post-B1-fix** (same mechanism as row 5) — gated behind `terminalNodeSeenThisChunk`: only fires when the in-loop chunk just processed was itself the `apply`/`cancel` node's own completion chunk, `progress.patch.status === "completed"`. Never fires from the zero-chunk fallback. | `currentState` | ✅ verified against shipped code — **not** "unchanged from rev. 1," see row 5's note |
| 10 | `run_cancelled` | Same as #9, gated by the same `terminalNodeSeenThisChunk` check, `status === "cancelled"` | `currentState` | ✅ verified against shipped code — **not** "unchanged from rev. 1," see row 5's note |
| 11 | `run_failed` | New `try`/`catch` around `runStreamAndPersist()`'s body, on catch emit then rethrow unchanged | `reason` | ⚠️ new control flow, not a refactor (unchanged from rev. 1, see §9.7) |

### 4.3 Why gate nodes are no longer excluded from `node_started`/`node_completed` (supersedes rev. 1 §4.2)

Rev. 1 excluded `g1`/`g2`/`g3`/`escalation` from `node_entered` reasoning that a third generic event alongside `gate_requested`/`gate_decided` would be redundant noise for the *same completion moment*. That reasoning doesn't carry over to `node_started`: for a gate node, `node_started` fires *before* the node even reaches its own `interrupt()` call (i.e. before the human-facing question is even built) — genuinely new, earlier information `gate_requested` cannot provide (`gate_requested` only fires once the interrupt has actually paused the graph). Given `node_started` now exists uniformly for free, symmetry with `node_completed` (which mirrors `agent_completed`/`gate_decided`'s existing completion-time redundancy for draft/review/gates anyway, and rev. 1 already accepted that redundancy for draft/review) makes uniform coverage the simpler, more consistent design. **This is a clarification, finalized, not asking permission** — flagged for visibility since it changes rev. 1's stated scoping.

### 4.4 The honest caveat on `node_started`'s timing (see `spike-node-start.md` §4 for full detail)

LangGraph's own engine ordering (`loop.tick()` emits the create-shaped `"tasks"` event, fully resolves, *then* `runner.tick()` invokes the node — `_runLoop()`'s `while (await loop.tick(...)) { ... await runner.tick(...) }`) is real and structural. But the spike found that the *external* `for await` consumer (`runner.ts`'s own loop) observes that event a beat *after* the node's own synchronous prologue has already started running — sometimes after it's fully finished, for a node with no `await` in its body (the spike's toy `g1`-equivalent gate nodes have none; this codebase's real `gates.ts` nodes are exactly that shape too, since their bodies are synchronous up to `interrupt()`). This is an ordinary JS microtask-scheduling property of the consumer side, not a flaw in LangGraph's own sequencing.

**Practical read for this codebase**: `draft`/`review` (`nodes/coder.ts`/`nodes/tester.ts`) are `async` functions whose real work is a network/API call (hundreds of ms to seconds) — for these, `node_started` will fire a negligible (sub-millisecond-to-few-ms) beat after the node's synchronous prologue begins, which is indistinguishable from "just started" for any human-facing progress UI and is a categorical improvement over rev. 1's completion-time-only signal. For `g1`/`g2`/`g3`/`escalation`/`apply`/`cancel` (all synchronous, near-instant bodies), `node_started` and `node_completed` will typically be observed extremely close together in wall-clock time regardless — the ordering nuance matters far less there since there's no meaningful "in progress" duration to observe mid-flight either way. `LoopEventBase`'s `ts` field is stamped at `emit()` time by `runner.ts`, so it always reflects *when the runner's own consumer loop actually processed the corresponding chunk*, not any deeper engine-internal timestamp — this PRD documents that honestly (in the shipped code's own doc comment, not just here) rather than implying a stronger guarantee than the mechanism actually provides.

---

## 5. Per-file Task List

### `src/loop/events.ts` (**new file**)
- `interface LoopEventBase { runId: number; threadId: string; ts: string; }`
- 11 concrete event interfaces extending `LoopEventBase` with a literal `type` discriminant (§4.2) — type-only imports from `./types.js`: `GateType`, `GateDecision`, `EscalationDecision`, `GatePayload`, `LoopNodeName`.
- `export type LoopEvent = <union of the 11>`.
- `export type LoopEventListener = (event: LoopEvent) => void | Promise<void>;`
- `export class LoopEventEmitter { on(listener): () => void; emit(event: LoopEvent): void }` — unchanged design from rev. 1 (§9 decision 3): internal `Set<LoopEventListener>`; `emit()` per-listener `try/catch` (sync isolation) + `.catch()`-guards a thenable return value (async isolation); errors reported via `console.error(...)`, never rethrown.

### `src/loop/runner.ts` (change, not a new file)
- `StartRunDeps` gains `events?: LoopEventEmitter;` (optional — §9 decision 1, unchanged).
- **`runStreamAndPersist()`'s `compiled.stream()` call**: `streamMode: "updates" as const` → `streamMode: ["updates", "tasks"] as const` (the one-line trigger for everything else in this file changing).
- **`runStreamAndPersist()`'s outer loop restructure**: `for await (const chunk of stream) { for (const [nodeName, rawUpdate] of Object.entries(chunk)) {...} ; await computeRunProgress...}` becomes `for await (const [mode, payload] of stream) { if (mode === "tasks") { <node_started handling, see below>; continue; } // mode === "updates", payload is today's old bare chunk: for (const [nodeName, rawUpdate] of Object.entries(payload)) {...existing branch bodies, unchanged...} ; await computeRunProgress...}` — **the existing branch bodies (draft/review/gate/apply-cancel) and the `computeRunProgress()`/`updateRunProgress()` call are moved one level deeper, verbatim, not rewritten.** This is the one structural (not purely additive) change in this PRD; §9.6 covers the regression risk.
- **`mode === "tasks"` handling**: `if ("input" in payload) { const node = payload.name as LoopNodeName; const stepRef = node === LOOP_NODES.apply || node === LOOP_NODES.cancel ? undefined : previewStepRef(stepCounters, node); emitter.emit({type:"node_started", runId, threadId, ts: nowIso(), node, stepRef}); }` (result-shaped `"tasks"` payloads, `"result" in payload`, are ignored — no event derived from them). New helper `previewStepRef(counters, node): string` = `` `${node}#${(counters[node] ?? 0) + 1}` `` — **read-only, does not mutate `stepCounters`** (the real allocation still happens exactly once, at completion time, via the existing `nextStepRef()`; this is provably the same value because this graph's execution is strictly sequential per node — no two visits to the same node name are ever in flight concurrently within one run, so nothing else can touch that counter between the preview and the real allocation).
- **`node_completed` emission** (renamed from rev. 1's `node_entered`, now covering all 8 nodes): draft/review at their existing `stepRef = nextStepRef(...)` lines (unchanged location); gate nodes inside the existing `GATE_NODE_NAMES` branch (a new addition — rev. 1 didn't emit anything gate-node-specific here beyond `gate_decided`, this rev. adds a plain `node_completed` alongside it); apply/cancel via the same new `else if (nodeName === LOOP_NODES.apply || nodeName === LOOP_NODES.cancel)` branch rev. 1 already introduced.
- `startRun()`/`resumeRun()`/`agent_completed`/`gate_requested`/`gate_decided`/`tester_rejected`/`escalation_triggered`/`run_completed`/`run_cancelled`/`run_failed`: **unchanged from rev. 1** (see rev. 1's original per-file task list bullets — still accurate, just now living one indentation level deeper inside the `mode === "updates"` branch where applicable).

### Tests
- `src/loop/__tests__/events.test.ts` (new file, unchanged scope from rev. 1) — emitter unit tests.
- `src/loop/__tests__/runner.test.ts` (change) — extend rev. 1's planned event-sequence assertions to also assert `node_started` appears, for every node in a full run, **strictly before** (in the collected-events array's order — not wall-clock, since that's what a listener actually observes and acts on) the corresponding `node_completed`/`agent_completed`/`gate_decided` for that same node visit.
- **New acceptance criterion this rev. adds**: a test asserting `audit.updateRunProgress` (spy/count) is called **exactly the same number of times** with `streamMode: ["updates","tasks"]` as it was with plain `"updates"` for an identical scripted run — proving the `"tasks"` mode addition didn't change write cadence (§8).
- **Regression requirement** (unchanged from rev. 1): all pre-existing tests across `runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` continue to pass unmodified.

---

## 6. Batch Breakdown (rev. 2 — B2 grows from rev. 1's estimate)

| Batch | Size | Scope | Depends on |
|---|---|---|---|
| **B1** | S | `src/loop/events.ts` (11 event types + `LoopEventEmitter`) + `events.test.ts` | none |
| **B2** | **M/L** (was M in rev. 1) | `runner.ts`: `streamMode` → `["updates","tasks"]` + outer-loop restructure into `[mode,payload]` dispatch + `node_started` emission (all 8 nodes) + `node_completed` emission (all 8 nodes, incl. new gate-node coverage) + `agent_completed`/`gate_requested`/`gate_decided`/`tester_rejected`/`escalation_triggered`/`run_completed`/`run_cancelled` (unchanged logic, re-nested) + `previewStepRef()` helper + event-sequence tests + `updateRunProgress` call-count regression test + full regression run of existing suites | B1 |
| **B3** | S | `runner.ts`: `run_failed` try/catch wrap + tests | B1, B2 |

**Why B2 grew**: rev. 1's B2 was purely additive (new `emit()` calls dropped next to existing code, no existing control flow touched). Rev. 2's mechanism (`streamMode` array) changes the **shape** of what the outer loop consumes, which means every existing branch body has to be re-nested (not rewritten, but moved) under a new dispatch — a real, if mechanical, structural change, plus the new `computeRunProgress`-cadence risk this introduces (§9.6) that needs its own dedicated test, not just "trust the refactor was mechanical."

**Total estimate (rev. 2)**: B1 unchanged (~80-120 LOC + tests). B2 grows from rev. 1's ~40-60 LOC to roughly ~90-130 LOC net new/moved (the loop restructure touches more lines even though most bodies are unchanged verbatim) + a meaningfully larger test section (event-sequence assertions for 11 types × several run-shape scenarios + the new write-cadence regression test). B3 unchanged (~small).

---

## 7. Branching Strategy (unchanged from rev. 1)

Single branch `feature/issue-29-events`, all 3 batches committed sequentially on it.

---

## 8. Testable Acceptance Criteria (rev. 2 — additions marked 🆕)

- [ ] `src/loop/events.ts` exports `LoopEvent` (**11**-member union), `LoopEventListener`, `LoopEventEmitter`; `tsc` compiles clean.
- [ ] `LoopEventEmitter.emit()`: sync-throw isolation (unchanged from rev. 1).
- [ ] `LoopEventEmitter.emit()`: async-rejection isolation (unchanged from rev. 1).
- [ ] `startRun()` emits exactly one `run_started` event, before any other event for that run.
- 🆕 [ ] A full start→G1 approve→(G2 or G3 path)→apply run emits `node_started` for **every** node it visits (`draft`, `g1`, `review`, `g2`-or-`g3`, `apply`), each one appearing in the collected-events array strictly before that same node's `node_completed`.
- [ ] The same run's ordered `type` sequence otherwise matches rev. 1's already-specified sequence, with `node_started(X)` inserted immediately before each `node_completed(X)`/`agent_completed(X)`/`gate_decided(X)` triple.
- [ ] A run driven to `rejectCount === rejectThreshold` emits `tester_rejected` on every reject and exactly one `escalation_triggered` on the threshold-reaching round.
- [ ] An "abandon" Escalation decision path emits `node_started(escalation)`, `node_started(cancel)`, `node_completed(cancel)`, `run_cancelled` in that relative order.
- [ ] A forced adapter throw mid-`runStreamAndPersist()` still propagates the original error unchanged **and** emits exactly one `run_failed` event before the rethrow.
- 🆕 [ ] **`updateRunProgress` call-count regression**: an identical scripted run, instrumented with a spy/counter on `audit.updateRunProgress`, is called the **same number of times** whether `runner.ts` uses `streamMode: "updates"` (old) or `streamMode: ["updates","tasks"]` (new) — proves the `"tasks"` addition didn't change write cadence (§9.6's risk, made checkable, not just asserted).
- [ ] **Regression**: every pre-existing test in `runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` passes unmodified.
- [ ] `grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` still returns empty (zero-I/O-purity invariant untouched).
- [ ] `grep -n "emit(\|LoopEvent" src/loop/gates.ts src/loop/escalation.ts src/loop/nodes/coder.ts src/loop/nodes/tester.ts src/loop/audit-store.ts` returns empty.
- 🆕 [ ] `grep -n 'streamMode' src/loop/runner.ts` shows `["updates", "tasks"]` (or the `as const` equivalent) at the one `compiled.stream()` call site inside `runStreamAndPersistCore()` — shared by both `startRun()` and `resumeRun()` (both call the same underlying function), not two separate call sites — confirms the mechanism was actually wired in, not just planned.

---

## 9. Dependencies / Risks / Open Questions

### 9.1 Decision 1 — where does `LoopEventEmitter` live? (unchanged from rev. 1)

**Finalized: `StartRunDeps.events?: LoopEventEmitter` (optional)**, defaulted internally to `new LoopEventEmitter()` when absent. Full rationale unchanged from rev. 1 (verified ~64 existing call sites construct `StartRunDeps` with no `events` field today).

### 9.2 Decision 2 — relationship to existing `AuditStore` writes (unchanged from rev. 1)

**Finalized: additive.** Unchanged rationale. Rev. 2 adds one refinement made explicit by the spike: additive **also** means "don't accidentally multiply write/read frequency just because a second `streamMode` now interleaves more chunks into the same stream" (§9.6).

### 9.3 Decision 3 — emit semantics: synchronous + listener isolation (unchanged from rev. 1)

Unchanged in full from rev. 1 — sync `emit()`, per-listener try/catch, thenable-return `.catch()` guard, `console.error` reporting, `gate_decided` emitted post-commit not inside the transaction.

### 9.4 `stepRef` on `node_started`: preview, not allocation

`node_started` fires *before* the round it describes has actually happened, so there is no real `stepRef` to report yet in the sense `structured_claims`/`approvals`/`step_markers` use one (those are only ever written at completion time). This PRD's `previewStepRef()` (§5) computes `` `${node}#${(counters[node] ?? 0) + 1}` `` **without mutating** `stepCounters`, relying on an explicit invariant: **this graph's execution is strictly sequential per node** — LangGraph never runs two invocations of the same node name concurrently within one `runStreamAndPersist()` call (confirmed by `graph.ts`'s topology, unchanged since A4a/A4b: every node has exactly one predecessor edge active at a time). So the previewed value is provably identical to whatever `nextStepRef()` allocates for real once that same round completes — no correlation-by-task-id map is needed, and no risk of the preview and the real allocation drifting apart. `apply`/`cancel` still get `stepRef: undefined` on both `node_started` and `node_completed` (same rev. 1 rationale — no counter concept exists anywhere else in the system for these two terminal nodes; unchanged).

### 9.5 Judgment call carried over from rev. 1, now more consequential: `run_failed` excludes `resumeRun()`'s pre-flight validation throws

Unchanged rationale from rev. 1 (§9.5 there) — `RunThreadMismatchError`/`ResumeDecisionDomainMismatchError`/the `decidedBy` type guard all throw before `runStreamAndPersist()` is ever reached, and represent a rejected *request*, not a failed *execution step*.

### 9.6 🆕 Risk: the `streamMode` array must not silently change `computeRunProgress`/`updateRunProgress` cadence

This is rev. 2's one genuinely new risk (spike §5 flags it directly). Adding `"tasks"` mode roughly doubles how many `[mode, payload]` tuples the outer loop sees per real node visit (one `"tasks"` create + one `"updates"` + one `"tasks"` result, vs. just one `"updates"` today — spike's captured output, e.g. lines `[3]`/`[5]`/`[7]` for one `draft` visit). If `computeRunProgress()`/`audit.updateRunProgress()` naively stayed "once per outer-loop iteration" (today's actual placement — verified, `runner.ts` line 463), this would call it up to ~3× more often per run, tripling `getState()` reads and `workflow_runs` writes compared to today, for zero functional benefit (the position/status computed from a `"tasks"`-only iteration would be stale/redundant with the very next `"updates"` iteration's own call). **Fix, made explicit in §5**: gate `computeRunProgress()`/`updateRunProgress()` behind `mode === "updates"` specifically, restoring today's exact cadence. **Made testable, not just asserted** — §8's new "`updateRunProgress` call-count regression" acceptance criterion.

### 9.7 Risk: `run_failed`'s try/catch wrap and the R6-B2 invariant (unchanged from rev. 1)

Unchanged from rev. 1 §9.6 there — wrapping for `run_failed` doesn't touch *when* `computeRunProgress()`/`audit.updateRunProgress()` run inside the loop, only adds a side-effect at the point of an already-occurring `throw`.

### 9.8 Remaining `[?]` (down from rev. 1's one open item — that one is now resolved)

Rev. 1's single `[?]` ("does LangGraph 1.4.8 offer a streamMode that yields node-start") is **resolved** by the spike — no longer open. The follow-up `[?]` rev. 1 introduced (exact TypeScript narrowing of the `["tasks", StreamTasksOutput<...>] | ["updates", ...]` discriminated tuple) is **also now resolved**, during B2 implementation: a throwaway probe file with `@ts-expect-error` on a bogus property in each branch confirmed real `tsc` (`strict`, `noUncheckedIndexedAccess`) narrows `payload` cleanly to `StreamTasksCreateOutput`/the plain `"updates"` shape via `mode === "tasks"` + `"input" in payload`, with **zero casts or type-guards needed** beyond that. No `[?]` remains open in this PRD as of this revision.

### 9.9 Known Limitation (added post-Zorro-review, R1 round; wording tightened R3) — event identity is derived from post-hoc `getState()`, not the causal chunk's own payload

Zorro's R1 review (independent Codex-assisted probe against the real compiled graph) flagged a deeper architectural point about **how** every "did this gate just get requested / did this run just complete" event in this file decides *what happened*: `gate_requested`/`run_completed`/`run_cancelled` are derived by calling `computeRunProgress()` (a fresh `compiled.getState()` read) *after* confirming — via `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` (§9.6/R1 fix) — that the chunk just processed was the causal `__interrupt__`/terminal-node chunk. The event's *timing* (which chunk triggers the emission check) is now correctly bound to the causal chunk, but the event's *content* (which gate, what payload, `done`/`status`) still comes from a **separate, subsequent** `getState()` call, not read directly off the `__interrupt__` chunk's own payload (which already carries the interrupt `value` — see `computeRunProgress()`'s own `pending.value as GatePayload` line, sourced from `snapshot.tasks[0]?.interrupts[0]`, itself also from a `getState()` read, just one already-planned by the R6-B2-era code this PRD builds on).

**What actually determines whether this is safe (R3 correction — not "sync vs. async checkpointer")**: the earlier draft of this section framed the safety condition as "aeloop's checkpointer is synchronous" — that's the wrong axis. A **strongly-consistent** asynchronous checkpointer (one whose read-after-write is guaranteed consistent, e.g. a single-node network store with no replication lag) would be just as safe as the current synchronous SQLite one; conversely, even a synchronous store could misbehave under the right adversarial scheduling if reads and writes weren't serialized per thread. The two properties that actually matter, together: **(a) each `threadId` is driven serially** — no two `resumeRun()`/`startRun()` calls execute concurrently against the *same* thread, so there is only ever one writer moving that thread's checkpoint forward at a time; **(b)** the `getState()` call issued right after confirming the causal chunk reads that same, read-after-write-consistent checkpoint store, so it cannot observe a position some *other* concurrent caller advanced the thread to in the gap between "chunk processed" and "`getState()` read" — only LangGraph's *own* internal run-ahead within that single caller's own call (the exact race §9.6/R1 already fixed by gating on the causal chunk).

**(a) is a description of today's actual usage pattern, not a structural guarantee this codebase enforces** — stated plainly, not implied: `audit-store.ts`'s own R5-B2 comment says outright that "no lock/CAS/serialization backs `resumeRun()` against two concurrent calls resuming the *same* run," and that gap is explicitly tracked, not closed, for a future increment. Nothing in `runner.ts` or `audit-store.ts` *prevents* a caller from issuing two concurrent `resumeRun()` calls against one `threadId` today — the 317 passing tests (including the two Zorro R1 regression tests) and Zorro's own R1 probe demonstrate this fix is correct **under serial usage**, which is aeloop's only real usage pattern as a single-operator CLI-driven engine today; they do not, and cannot, prove serial usage is the only thing that could ever happen.

**What would break it, and what the fix would need to be**: two concurrent `resumeRun()` calls against the same thread (property (a) violated) — regardless of what checkpointer backs them — would reopen a real window for the same class of race this PRD's R1 fix already closed once: the `getState()` call following one caller's causal chunk could observe a position a *second, concurrent* caller's own in-flight call had already advanced the thread to. **Before that usage pattern is ever allowed** (whether via a future concurrency feature, or simply because nothing today stops a caller from doing it accidentally), this file's event-content derivation should change from "confirm the causal chunk, then re-read `getState()`" to "read the event's content directly off the causal chunk's own payload" (the `__interrupt__` chunk already carries `{id, value}` per-interrupt; the terminal-node `"updates"` chunk already carries whatever `apply`/`cancel` returned) — eliminating the second `getState()` read entirely for these three event types, not just gating its *timing*. **Not implemented in this revision** — 军师/Elisha's explicit call: building that refactor now, against a concurrency scenario nothing in this codebase's real call sites exercises today, is out of scope for this issue; the gap is recorded here (and cross-referenced against `audit-store.ts`'s existing R5-B2 tracking, the same underlying "same-thread concurrency is unenforced" fact) so it isn't rediscovered from scratch later.

---

## 10. Project Constraint Checklist

- whoseorder 零侵入 / `/wo-module`?: N/A — aeloop is not whoseorder.
- 跨项目契约 (whoseorder↔whosehere)?: N/A.
- 项目内约束 (aeloop `CLAUDE.md`/`docs/DESIGN.md`): zero-I/O-purity for `src/loop/` graph nodes/gates preserved (verified §8's grep criteria — confirmed by spike to hold even under Option C's stronger "real node-start" requirement, no purity trade-off needed after all); no new npm dependency introduced; no change to `config.yaml`/`profile/` wiring; the spike's own throwaway script (`docs/feature/events-observability/spike/node-start.mjs`) is not production code and is not wired into any build/test target — kept for evidentiary/reproducibility purposes only, same convention as `docs/feature/a4a-loop/spike/*.mjs`.
