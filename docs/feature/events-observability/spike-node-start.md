# Spike — does LangGraph 1.4.8 give a real "node about to execute" signal?

> Commissioned by 指挥官's choice of Option C ("real node-start semantics", not the completion-time semantics the original PRD shipped). Per aeloop's spike-first convention (A4a precedent, `docs/feature/a4a-loop/spike-findings.md`): investigate empirically before touching the PRD. **No production code changed in this step** — `src/loop/*` is untouched; the only new file is the spike script itself (`docs/feature/events-observability/spike/node-start.mjs`) plus this findings doc.

- **Environment**: `pnpm install` run in this worktree for the first time this session (`node_modules` had not been installed before) — confirms `@langchain/langgraph@1.4.8` resolves to `node_modules/.pnpm/@langchain+langgraph@1.4.8_@langchain+core@1.2.3_zod@4.4.3/node_modules/@langchain/langgraph`.
- **Spike script**: `docs/feature/events-observability/spike/node-start.mjs` (real, runnable — `node docs/feature/events-observability/spike/node-start.mjs`), toy 3-node graph `draft -> g1 [interrupt] -> review`, same shape as A4a's own `spike/q3-interrupt-resume.mjs`.

## 1. `streamMode` options that exist (verified against real `.d.ts`, not memory)

`node_modules/.pnpm/@langchain+langgraph@1.4.8_.../dist/pregel/types.d.ts:19`:

```typescript
type StreamMode = "values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools";
```

`runner.ts` currently uses only `"updates"` (`grep -n streamMode src/loop/runner.ts` → one hit, line 330 — verified before this spike). **`"tasks"` is the one that matters for this question** — its type shape (`types.d.ts:32-40`):

```typescript
interface StreamTasksOutputBase { id: string; name: string; interrupts: Interrupt[]; }
interface StreamTasksCreateOutput<StreamValues> extends StreamTasksOutputBase { input: StreamValues; triggers: string[]; }   // pre-exec shape
interface StreamTasksResultOutput<Keys, StreamUpdates> extends StreamTasksOutputBase { result: [Keys, StreamUpdates][]; }  // post-exec shape
type StreamTasksOutput<...> = StreamTasksCreateOutput<...> | StreamTasksResultOutput<...>;
```

i.e. `"tasks"` mode itself yields **two different shapes** at runtime for the *same* node visit: a `"input" in payload` **create** (pre-execution) event, and a `"result" in payload` **result** (post-execution) event — discriminable via which field is present.

## 2. Source-level confirmation: create-shape is emitted *before* the node runs, structurally

`dist/pregel/loop.js`'s `PregelLoop.tick()` (the "prepare + decide whether to advance a step" method):

```js
// loop.js:521-524
if (this.stream.modes.has("tasks") || this.stream.modes.has("debug")) {
  const debugOutput = await gatherIterator(prefixGenerator(mapDebugTasks(taskList), "tasks"));
  this._emit(debugOutput);   // <-- emits the CREATE-shaped events
}
return true;
```

`dist/pregel/index.js`'s `_runLoop()` (the actual step-driving loop):

```js
// index.js:1201-1207 (abridged)
while (await loop.tick({ inputKeys: this.inputChannels })) {   // <-- CREATE events emitted inside loop.tick(), which fully resolves here
  ...
  await runner.tick({ ... });   // <-- THIS is what actually invokes node bodies (PregelRunner.tick(), runner.js:47)
}
```

`loop.tick()` (which emits the `"tasks"` CREATE events for every task about to run this step) **returns before** `runner.tick()` (which is what actually calls the node functions) is ever invoked. This is a real, structural, engine-level "emit-then-invoke" ordering — not an accident of async scheduling — and it requires **zero changes to node bodies**: `mapDebugTasks()` reads `taskList` (already computed by `_prepareNextTasks()` from the checkpoint + channels), never touches `gates.ts`/`nodes/*.ts`/`escalation.ts`.

## 3. Empirical proof (real run, not simulated)

Full captured output of `node docs/feature/events-observability/spike/node-start.mjs`:

```
[1] === first stream() call (draft -> g1 interrupt): compiled.stream(..., {streamMode: ["updates","tasks"]}) ===
[2] draft: body START {"task":"toy task: add a function"}
[3]   chunk mode=tasks shape=CREATE (pre-exec) name=draft {"id":"4436389d-..."}
[4] draft: body END (about to return)
[5]   chunk mode=updates {"nodeNames":["draft"]}
[6] g1: body START (about to interrupt()) {"coderOutput":"fake diff for: toy task: add a function"}
[7]   chunk mode=tasks shape=RESULT (post-exec) name=draft {"id":"4436389d-..."}
[8]   chunk mode=tasks shape=CREATE (pre-exec) name=g1 {"id":"d0c63e06-..."}
[9]   chunk mode=updates {"nodeNames":["__interrupt__"]}
[10]   chunk mode=tasks shape=RESULT (post-exec) name=g1 {"id":"d0c63e06-..."}
[11] === resuming via Command({resume: 'approved'}) ===
[12] === second stream() call (g1 decided -> review -> end): compiled.stream(..., {streamMode: ["updates","tasks"]}) ===
[13] g1: body START (about to interrupt()) {"coderOutput":"fake diff for: toy task: add a function"}
[14] g1: resumed with decision "approved"
[15]   chunk mode=tasks shape=CREATE (pre-exec) name=g1 {"id":"d0c63e06-..."}
[16]   chunk mode=updates {"nodeNames":["g1"]}
[17] review: body START {"gateDecision":"approved"}
[18]   chunk mode=tasks shape=RESULT (post-exec) name=g1 {"id":"d0c63e06-..."}
[19]   chunk mode=tasks shape=CREATE (pre-exec) name=review {"id":"2ff17307-..."}
[20] review: body END (about to return)
[21]   chunk mode=updates {"nodeNames":["review"]}
[22]   chunk mode=tasks shape=RESULT (post-exec) name=review {"id":"2ff17307-..."}
[23] Spike done.
```

**Verdict: YES — `streamMode: ["updates", "tasks"]` gives a real create/pre-execution-shaped event per node, using an existing, documented LangGraph feature, with zero change to any node body.** This resolves the PRD's original `[?]` — Option A (LangGraph gives it cleanly) is the real answer, **not** the "must instrument node bodies, breaks zero-I/O purity" fallback.

## 4. One honest caveat found during the empirical run — read before over-claiming "strictly before"

Look at order `[2]`/`[3]` and `[13]`/`[15]`: the `tasks` CREATE chunk for a node is consistently observed by the **external `for await` consumer** *after* that node's own synchronous prologue has already logged (`draft: body START` at `[2]`, CREATE at `[3]`; on resume, `g1: body START`+`resumed` at `[13]`/`[14]` fully complete *before* CREATE(g1) is even observed at `[15]`).

**Why**: `loop.tick()` truly emits the CREATE event into the stream's internal queue before `runner.tick()` invokes the node (§2's engine-level guarantee is real). But the *external* `for await` consumer only gets to process a queued chunk when its own pending `.next()` promise's microtask is scheduled — and a newly-invoked node's synchronous code (everything up to its first real `await`, or all of it if the node has no `await` at all, like `g1Node` in this spike) runs to completion *before* JS hands control back to a separately-pending microtask chain. This is a **JS continuation-ordering property of the consumer side**, not a defect in LangGraph's own internal sequencing — the engine really does "decide + announce, then execute," but "announce" landing in an external consumer's hands is subject to ordinary microtask queuing, which a synchronous (or already-scheduled) piece of consumer-external code can race ahead of.

**Practical consequence for this codebase's real nodes** (`nodes/coder.ts`/`nodes/tester.ts`, both `async` functions whose real work is a network/API call via `adapter.invoke()`, taking hundreds of ms to seconds in production): the CREATE event will be observed by `runner.ts`'s consumer loop a sub-millisecond-to-few-millisecond beat *after* the node's synchronous prologue starts running (composing the prompt, resolving the adapter) — for all practical purposes (a CLI/TUI progress indicator, an `EventProjector` timestamp) this is indistinguishable from "the node just started," and vastly earlier than today's shipped behavior (nothing fires until the *entire* multi-second LLM round-trip has already finished). **This is not the same as a mathematically-provable "always strictly before the very first line of the node body runs" guarantee** — that guarantee does not hold in general (this spike's own `g1Node`, fully synchronous, is a counter-example) — but it is a categorical, order-of-magnitude improvement for the actual real-world nodes this event is meant to serve, and it required touching zero node bodies.

## 5. Chosen mechanism (feeds directly into the revised PRD)

- `compiled.stream(input, { ...cfg, streamMode: ["updates", "tasks"] })` in `runner.ts` — the **one** `compiled.stream()` call site inside `runStreamAndPersist()` (shared by both `startRun()` and `resumeRun()`, which both call this same function — not two separate call sites), currently `streamMode: "updates" as const`, becomes an array.
- The existing `"updates"`-mode processing logic (draft/review/gate/apply-cancel branches, `computeRunProgress()`/`updateRunProgress()` cadence) is **completely unchanged in content** — only re-nested one level under a `mode === "updates"` dispatch, since the outer `for await` now yields `[mode, payload]` tuples instead of a bare chunk object (confirmed shape via `[5]`/`[9]`/`[16]`/`[21]` above: `payload` for `mode==="updates"` is byte-for-byte the same `{nodeName: partialUpdate}` shape `runner.ts` already consumes today).
- **`computeRunProgress()`/`audit.updateRunProgress()` must only run on `mode==="updates"` iterations, not on `"tasks"` iterations** — otherwise adding `"tasks"` mode would roughly double the number of outer-loop iterations per call (one `updates` + one-or-two `tasks` chunks per real node visit, see e.g. `[3]`+`[5]`+`[7]` — 3 tasks/updates chunks for one `draft` visit), and calling `computeRunProgress`/`updateRunProgress` on every one of those (instead of just the `updates` ones, as today) would needlessly double `AuditStore` writes and `getState()` reads relative to current behavior. This is the one thing worth flagging as an accidental-regression risk if implemented carelessly — the revised PRD makes this an explicit, testable acceptance criterion.
- `"tasks"` CREATE-shaped chunks (`"input" in payload`) → emit the new `node_started` event, for **every** real node name (`draft`/`g1`/`review`/`g2`/`g3`/`apply`/`escalation`/`cancel` — all 8, no gate-node exclusion needed anymore, since this mechanism is uniform across every node type). `"tasks"` RESULT-shaped chunks (`"result" in payload`) are **not used** — `"updates"`-mode already gives equivalent-or-richer completion data for everything the PRD's other 8 event types need.

## 6. Zero-I/O-purity impact: none

`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` remains empty under this design — no file under those paths is touched by this change. The only file that changes is `runner.ts` (a `streamMode` value + the destructuring of its own consumption loop). **No sign-off-required purity trade-off exists for this issue** — the "must instrument node bodies" fallback path 军师 flagged as the risk to weigh was not needed.
