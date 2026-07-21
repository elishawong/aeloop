# Plan — aeloop: Event System (LoopEvent + EventEmitter)

> Companion to `PRD.md` (issue [elishawong/aeloop#29](https://github.com/elishawong/aeloop/issues/29)). **Rev. 2** — revised after 指挥官 chose Option C ("real node-start semantics") and the follow-up spike (`spike-node-start.md`) confirmed `streamMode: ["updates","tasks"]` delivers it with zero purity impact. Batches land sequentially on the existing branch `feature/issue-29-events` — see PRD §6/§7 for the dependency reasoning.

## B1 — `src/loop/events.ts` [S]

**Files**:
- `src/loop/events.ts` (new)
- `src/loop/__tests__/events.test.ts` (new)

**Do**:
1. Define `LoopEventBase { runId: number; threadId: string; ts: string; }`.
2. Define the **11** concrete event interfaces (PRD §4.2) extending `LoopEventBase`, each with a literal `type` discriminant — including the new `node_started` and the renamed `node_completed` (was `node_entered` in rev. 1). Type-only imports from `./types.js`: `GateType`, `GateDecision`, `EscalationDecision`, `GatePayload`, `LoopNodeName`.
3. `export type LoopEvent = <union of the 11>`.
4. `export type LoopEventListener = (event: LoopEvent) => void | Promise<void>;`
5. `export class LoopEventEmitter`:
   - private `listeners = new Set<LoopEventListener>()`
   - `on(listener): () => void` — adds to set, returns an unsubscribe closure that deletes it
   - `emit(event: LoopEvent): void` — iterate `listeners`, call each inside `try/catch`; if the return value is thenable, attach `.catch()` to it (PRD §9.3); on any caught error (sync or async), `console.error("LoopEventEmitter: listener threw for event ...", err)` — never rethrow.
6. Tests: multi-listener fan-out; sync-throw isolation (listener A throws, listener B still runs, `emit()` doesn't throw); async-rejection isolation (listener returns `Promise.reject(...)`, `emit()` returns synchronously without throwing, rejection observed via a spy on the error reporter); `on()`'s unsubscribe actually stops further delivery.

**Self-check before handoff to B2**: `npx tsc --noEmit`, `npx vitest run src/loop/__tests__/events.test.ts`.

---

## B2 — `runner.ts` wiring: `streamMode` switch + event types 1-10 [M/L]

**Depends on**: B1.

**Files**:
- `src/loop/runner.ts` (change)
- `src/loop/__tests__/runner.test.ts` (change — new test section, no edits to existing tests)

**Do** (all inside `runner.ts`, no other file touched):
1. Import `type { LoopEvent } from "./events.js"` and `{ LoopEventEmitter }` (value import) from `"./events.js"`.
2. `StartRunDeps` gains `events?: LoopEventEmitter;`.
3. `runStreamAndPersist(...)` signature gains an 8th param `emitter: LoopEventEmitter` (after `stepCountersIn`). `threadId` for event payloads is read from the existing `cfg.configurable.thread_id` — no new param for it.
4. **`compiled.stream()` call**: `{ ...cfg, streamMode: "updates" as const }` → `{ ...cfg, streamMode: ["updates", "tasks"] as const }` (PRD §4.1/§9.8 — this is what actually produces the `node_started` signal; the exact TS narrowing of the resulting tuple union is a build-time detail to work out here, per PRD §9.8).
5. **Restructure the outer loop**: `for await (const chunk of stream) { for (const [nodeName, rawUpdate] of Object.entries(chunk)) {...} ; <computeRunProgress+updateRunProgress> }` becomes:
   ```
   for await (const [mode, payload] of stream) {
     if (mode === "tasks") {
       if ("input" in payload) {
         const node = payload.name as LoopNodeName;
         const stepRef = node === LOOP_NODES.apply || node === LOOP_NODES.cancel ? undefined : previewStepRef(stepCounters, node);
         emitter.emit({ type: "node_started", runId, threadId, ts: nowIso(), node, stepRef });
       }
       continue; // "result"-shaped tasks payloads: nothing to do, "updates" mode covers completion.
     }
     // mode === "updates" — payload is exactly today's old bare `chunk`. Everything below this line
     // is the EXISTING draft/review/gate/apply-cancel branch logic, unchanged, just re-nested here.
     for (const [nodeName, rawUpdate] of Object.entries(payload)) { ...unchanged... }
     const progress = await computeRunProgress(compiled, cfg);
     audit.updateRunProgress(runId, progress.patch);
     latestProgress = { interrupt: progress.interrupt, done: progress.done };
   }
   ```
   **Critical**: `computeRunProgress()`/`updateRunProgress()` must stay *inside* the `mode === "updates"` branch (i.e. skipped entirely for `"tasks"` iterations via the `continue` above) — see PRD §9.6. This is the one thing most likely to be gotten wrong in a naive refactor; write the call-count regression test (step 9 below) *before* declaring this batch done, not after.
6. New helper: `function previewStepRef(counters: Record<string, number>, node: string): string { return \`${node}#${(counters[node] ?? 0) + 1}\`; }` — read-only, does not mutate `counters` (PRD §9.4).
7. `startRun()`: right after `insertRun()` returns (before `compileLoopGraph`), `const emitter = deps.events ?? new LoopEventEmitter();` then emit `run_started`. Pass `emitter` into `runStreamAndPersist(...)`.
8. `resumeRun()`: `const emitter = deps.events ?? new LoopEventEmitter();` (no `run_started` here), pass into `runStreamAndPersist(...)`.
9. Inside the `mode === "updates"` branch (now one level deeper, bodies unchanged from rev. 1's plan except as noted):
   - `draft` branch: after `const stepRef = nextStepRef(...)`, emit `node_completed({node:"draft", stepRef})`. Inside the existing `if (update.coderOutput && update.coderResult)` block, after `audit.runInTransaction(...)` returns, emit `agent_completed({node:"draft", actor:"coder", claimCount: coderOutput.claims.length})`.
   - `review` branch: mirror the above for `node_completed({node:"review", stepRef})` / `agent_completed({node:"review", actor:"tester", claimCount: testerOutput.claims.length})`. Additionally: if `testerOutput.verdict === "reject"`, compute `rejectCount = update.rejectCount ?? prior.values.rejectCount` and emit `tester_rejected({rejectCount, rejectThreshold: prior.values.rejectThreshold})`; if `rejectCount >= prior.values.rejectThreshold`, also emit `escalation_triggered({rejectCount})`.
   - `GATE_NODE_NAMES` branch: **new** — emit `node_completed({node: nodeName, stepRef})` (rev. 2 adds this; rev. 1 didn't cover gate nodes here). Then, after `audit.runInTransaction(() => { for (entry of entries) insertApproval(...) })` returns (outside the closure, after commit), loop over `entries` again and emit `gate_decided({gate: entry.gate, decision: entry.decision, decidedBy: decidedBy!})` per entry.
   - **New** final branch: `else if (nodeName === LOOP_NODES.apply || nodeName === LOOP_NODES.cancel) { emitter.emit({type:"node_completed", ..., node: nodeName, stepRef: undefined}); }`.
   - **Post-Zorro-R1/R2 correction to this step** (the original plan below undercounted a real risk — see PRD §9.6/§9.9 for the full story): `computeRunProgress()`/`updateRunProgress()` still run unconditionally at both call sites (in-loop, and the zero-chunk fallback). But `gate_requested`/`run_completed`/`run_cancelled` emission is **not** simply "call it wherever `computeRunProgress()` runs" — LangGraph's run-ahead execution means a `getState()` read issued while processing an *earlier* chunk can already reflect a *later* gate's interrupt, so emission is gated behind `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` flags that are only true on the chunk that's *actually, causally* the interrupt/terminal signal (in-loop call site only) — the zero-chunk fallback never emits these three event types at all, only syncs progress, since anything it would report was already reported by whichever earlier call first reached that state.
10. Tests (new section in `runner.test.ts`, alongside existing describe blocks — do not modify any existing `it(...)`):
    - Full happy path (start → G1 approve → review pass → G3 approve → apply): collect events via `StartRunDeps.events`, assert `node_started(X)` precedes `node_completed(X)`/`agent_completed(X)`/`gate_decided(X)` for every node `X` visited, and the overall ordered `type` sequence matches PRD §8.
    - Reject-then-recover path through G2.
    - Reject-to-threshold path: assert `tester_rejected` on each reject, exactly one `escalation_triggered` on the threshold-reaching round.
    - Escalation "abandon" path ending in `node_started(cancel)` + `node_completed(cancel)` + `run_cancelled`.
    - **New**: `updateRunProgress` call-count regression — spy/count `audit.updateRunProgress` calls across an identical scripted run with the new `["updates","tasks"]` streamMode and confirm the count matches what it would have been under plain `"updates"` (PRD §9.6/§8).
    - Regression: run the **existing** (unmodified) `runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` suites and confirm all pass unmodified.

**Self-check before handoff to B3**: `npx tsc --noEmit`, `npx vitest run src/loop/__tests__/runner.test.ts src/loop/__tests__/audit-store.test.ts src/__tests__/loop.e2e.test.ts`, plus the three grep checks from PRD §8 (zero-I/O-purity untouched, no emit call sites outside `runner.ts`, `streamMode` shows `["updates","tasks"]`).

---

## B3 — `run_failed` (event type 11) [S]

**Depends on**: B1, B2.

**Files**:
- `src/loop/runner.ts` (change)
- `src/loop/__tests__/runner.test.ts` (change — new test section only)

**Do**:
1. Wrap `runStreamAndPersist()`'s body from `const stream = await compiled.stream(...)` onward in `try { ... } catch (error) { emitter.emit({type:"run_failed", runId, threadId, ts: nowIso(), reason: error instanceof Error ? error.message : String(error)}); throw error; }`. The `throw error;` must rethrow the exact same value — no wrapping, no new error type.
2. Tests: force an adapter throw mid-run (reuse the existing fixture-adapter-that-throws technique already present elsewhere in this suite, per the R6-B2 doc comment's own reference to "the tester adapter being unavailable") — assert (a) the call still throws the same error unchanged (b) exactly one `run_failed` event fired, with a `reason` derived from that error, before the throw reaches the caller (c) whatever `AuditStore` rows had already landed before the throw (from earlier chunks in the same call) are still present and unaffected — i.e. the R6-B2 partial-progress invariant still holds with the try/catch in place.

**Self-check**: `npx tsc --noEmit`, `npx vitest run src/loop/__tests__/runner.test.ts`, full suite `npx vitest run` for a final regression pass.

---

## Definition of done (all 3 batches)

- All PRD §8 acceptance criteria checked.
- `npx tsc --noEmit` clean.
- Full `npx vitest run` green (no pre-existing test touched/broken).
- `progress.md`/`impact.md` written (per Helix base workflow) before handing to Zorro.
