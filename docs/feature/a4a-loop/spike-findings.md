# A4a Loop Pre-work Spike — LangGraph.js Gated Loop Empirical Verification (issue #13)

> **Reconnaissance only, not a production implementation, no commit.** Goal: on aeloop's own machine and stack (Node v24 + pnpm + ESM +
> TypeScript strict), actually run commands to verify whether LangGraph.js can support the gated state machine from DESIGN §4
> (Draft→G1→Review→G3, including interrupt human-in-the-loop + cross-process checkpoint resume). DESIGN §9 item 3
> tags this pattern `[verity-proven]` — that was proven in the Verity codebase, **this repo may not copy the Verity implementation** (air wall),
> it can only be independently re-proven. This spike is that re-proof.
>
> Test environment: macOS, Node `v24.1.0`, pnpm `9.12.3`, branch `feature/issue-13-a4a-loop` (based on main
> `539f650`). All commands were actually run in this session, and the output samples are pasted verbatim (not fabricated/not recalled).
> The scripts are in `docs/feature/a4a-loop/spike/`, reproducible directly via `node`/`npx tsc`.

## One-line Conclusion (up front)

**All 5 Qs held. DESIGN §9 item 3's "verity-proven" claim has been independently confirmed on this repo's own stack, with no
"some part simply doesn't work" worst-case branch appearing.** The only thing that needs special handling in the PRD is a Q5 typing pitfall (`Command`'s
`Nodes` generic parameter defaults to `string`, and TS2345 will be reported if it isn't explicitly annotated) — this is not a design-level issue, it's a hard
caveat when writing `nodes/` code.

| Q | Question | Conclusion |
|---|---|---|
| Q1 | Does it install? | ✅ Success. `@langchain/langgraph@1.4.8` + `@langchain/langgraph-checkpoint-sqlite@1.0.3`, clean `pnpm add` install and import with no errors under Node v24 + pnpm + ESM |
| Q2 | StateGraph two-node | ✅ Success. coder→tester toy graph compiled + ran a full cycle, state flows correctly |
| Q3 | interrupt human-in-the-loop | ✅ Success. `interrupt()` really pauses at G1, throwing the pending-review content out to the caller; the external `Command({resume})` really resumes to completion |
| Q4 | Cross-process checkpoint (most critical) | ✅ Success. Two independent `node` processes (different pids), pause→resume achieved purely via `thread_id` + a persisted sqlite file, zero in-memory sharing |
| Q5 | Type/ESM compatibility | ✅ Success, but with one pitfall that must be explicitly handled (see below). `tsc --noEmit` (strict + noUncheckedIndexedAccess) ultimately fully green |

---

## Q1: Does it install?

### Real package names and versions (verified via npm, not recalled)

```
$ npm view @langchain/langgraph-checkpoint-sqlite@1.0.3 dependencies peerDependencies
dependencies = { 'better-sqlite3': '^12.10.0' }
peerDependencies = {
  '@langchain/core': '^1.1.44',
  '@langchain/langgraph-checkpoint': '^1.0.0'
}

$ npm view @langchain/langgraph@1.4.8 dependencies peerDependencies
dependencies = {
  '@langchain/protocol': '^0.0.18',
  '@standard-schema/spec': '1.1.0',
  '@langchain/langgraph-checkpoint': '^1.1.3',
  '@langchain/langgraph-sdk': '~1.9.26'
}
peerDependencies = { '@langchain/core': '^1.1.48', zod: '^3.25.32 || ^4.2.0' }

$ npm view @langchain/langgraph@1.4.8 engines
{ node: '>=18' }
```

**Selected versions**: `@langchain/langgraph@1.4.8` (the latest on npm at the time),
`@langchain/langgraph-checkpoint-sqlite@1.0.3` (the latest at the time, officially maintained by LangChain).

**Compatibility check against aeloop's existing dependencies** (not a guess, checked item by item):
- `@langchain/langgraph-checkpoint-sqlite`'s `better-sqlite3` dependency requires `^12.10.0`, aeloop's
  `package.json` already has `better-sqlite3@^12.11.1` — **compatible, does not produce a second copy of better-sqlite3**.
- `@langchain/langgraph`'s `zod` peer dep requires `^3.25.32 || ^4.2.0`, aeloop already has `zod@^4.4.3`
  — **compatible**.
- `engines.node: >=18`, aeloop requires `>=24` — **compatible (a stricter subset)**.
- `node:sqlite` variant not installed (DESIGN §10's open item mentioned this as a possible lever) — the official
  `@langchain/langgraph-checkpoint-sqlite` package uses `better-sqlite3` underneath, not `node:sqlite`, so "switch to node:sqlite to reduce
  dependencies" **does not apply to this official checkpoint package** (its implementation choice already locks in better-sqlite3); npm has a
  third-party package `langgraph-checkpoint-sqlite-native` (uses node:sqlite, not officially maintained by LangChain, single
  maintainer, version `0.0.2`) — this spike **did not evaluate this third-party package**, only verified the official
  `@langchain/langgraph-checkpoint-sqlite`; noting this honestly, DESIGN §10's open item should be rewritten as "the official package is locked to
  better-sqlite3; if node:sqlite is truly needed, one would have to switch to the third-party package, at one's own risk."

### Installation

```
$ pnpm add @langchain/langgraph@1.4.8 @langchain/langgraph-checkpoint-sqlite@1.0.3
...
Packages: +20
++++++++++++++++++++
dependencies:
+ @langchain/langgraph 1.4.8
+ @langchain/langgraph-checkpoint-sqlite 1.0.3

Done in 1m 34.5s
```
Clean install, no peer dep conflict warnings (the only WARN is `prebuild-install@7.1.3` flagged as deprecated,
unrelated to langgraph — it's an existing sub-dependency in the better-sqlite3 ecosystem, not newly introduced this time).

### Import smoke test

`docs/feature/a4a-loop/spike/q1-import.mjs`:
```js
import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
console.log("StateGraph:", typeof StateGraph);
...
```

```
$ node docs/feature/a4a-loop/spike/q1-import.mjs
StateGraph: function
START: __start__
END: __end__
SqliteSaver: function
Q1 OK: imports resolved under Node v24.1.0
```

**Impact on the A4a PRD**: `package.json` should pin `@langchain/langgraph@1.4.8` +
`@langchain/langgraph-checkpoint-sqlite@1.0.3` (or a later PRD stage could re-run `npm view` to get the then-latest,
but at minimum these two are the baseline actually tested in this spike, not a guessed version number). No need to additionally install `@langchain/langgraph-checkpoint`
(the base package) — it's a shared peer dep of both, and pnpm already resolved and installed it automatically (reflected in the `+20`, including
`@langchain/core`/`@langchain/langgraph-checkpoint`/`@langchain/protocol`/`@langchain/langgraph-sdk`
and other transitive dependencies).

---

## Q2: StateGraph two nodes (coder→tester)

`docs/feature/a4a-loop/spike/q2-two-node-graph.mjs` — `Annotation.Root` defines the state, two pure-function
nodes (`coderNode`/`testerNode`) just return fake data, `addEdge` chains `START→coder→tester→END`.

```
$ node docs/feature/a4a-loop/spike/q2-two-node-graph.mjs
[coder] received state.task = toy task: add a function
[tester] received state.coderOutput = fake diff for: toy task: add a function
Q2 final state: {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "testerVerdict": "approved (fake)",
  "log": [
    "coder ran",
    "tester ran"
  ]
}
Q2 OK: coder->tester StateGraph compiled and ran a full cycle.
```

**Conclusion**: The `StateGraph` API matches the `graph.ts` compilation pattern envisioned in DESIGN §6 — nodes are plain functions,
receiving accumulated state and returning a partial update, with `addEdge` chaining them together; no unexpected cognitive overhead. The `log` field used
`reducer: (a,b)=>a.concat(b)`, verifying that state can hold "accumulating" fields (the audit trail `structured_claims`
will very likely need to use this pattern to accumulate history going forward).

---

## Q3: interrupt human-in-the-loop (G1 pauses + Command resume)

`docs/feature/a4a-loop/spike/q3-interrupt-resume.mjs` — inserts a `g1GateNode` between coder and tester,
internally calling `interrupt({gate, diff, question})`.

```
$ node docs/feature/a4a-loop/spike/q3-interrupt-resume.mjs
=== first invoke: should stop at G1 interrupt ===
[coder] drafting for task: toy task: add a function
[G1] about to interrupt(), coderOutput = fake diff for: toy task: add a function
first result (should show __interrupt__): {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "__interrupt__": [
    {
      "id": "cb769f800250f567e3cc661ca922e039",
      "value": {
        "gate": "G1_SEND_TO_TESTER",
        "diff": "fake diff for: toy task: add a function",
        "question": "approve sending this diff to tester?"
      }
    }
  ]
}
state.next after interrupt: [ 'g1' ]
=== resume with Command({resume: 'approve'}) ===
[G1] about to interrupt(), coderOutput = fake diff for: toy task: add a function
[G1] resumed with decision = approve
[tester] reviewing, gateDecision was: approve
second (final) result: {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "gateDecision": "approve",
  "testerVerdict": "approved (fake)"
}
Q3 OK: interrupt paused the graph, external Command({resume}) continued it to completion.
```

**Real API shape (for the PRD to write precisely)**:
- Pausing: inside a node function, call `interrupt(payload)` — `payload` is any serializable value (this spike used
  `{gate, diff, question}`, directly mapping to a prototype of DESIGN §5's `approvals.gate_type`/`diff_ref`/`reasoning_text`).
  `compile({checkpointer})` **must** be configured with a checkpointer (even the in-memory `MemorySaver`);
  without a checkpointer, `interrupt()` cannot truly "pause and retain the breakpoint" — although this spike didn't do a reverse test of
  "what happens without a checkpointer," this dependency of `interrupt` on the checkpoint mechanism is an explicit premise in the official docs,
  and Q4 further confirms this dependency relationship.
- The top-level `invoke()`'s return value contains a `__interrupt__` array field, with each item shaped `{id, value}` — `id` is
  the unique identifier of this interrupt, and `value` is exactly the payload the node passed to `interrupt()`.
- Resuming: `compiled.invoke(new Command({resume: <decision value>}), threadConfig)` — using the **same** `thread_id`'s
  `threadConfig`, and the value of `resume` becomes, verbatim, the return value of the `interrupt()` call (`decision === "approve"`).
- `compiled.getState(threadConfig)` can be used during the pause to query `state.next` (the next node to run, here it's
  `['g1']`) and `state.tasks[0].interrupts` (the same payload as `__interrupt__`) — this is the entry point for reading the "pending review content" for
  G1/G2/G3; `escalation.ts`/the TUI layer will very likely need to use this query to view pause details.

**⚠️ Not a bug, but a behavior that affects how `nodes/` code is written**: on resume, `g1GateNode`'s **entire function body re-executes
once more** (in the log, `[G1] about to interrupt()...` is printed twice — the first time is a real interrupt, and the second time, on resume, it's printed
again, except this time `interrupt()` directly returns `decision` instead of pausing again). **Corollary**: any code **before** the `interrupt()`
call (including any logging/side effects a node might have) will **re-run** on resume.
When writing G1/G2/G3 nodes in `nodes/gates.ts`, there must be no non-idempotent side effects before the `interrupt()` call (things like
"send a notification once" or "write one INSERT to the approvals table" — non-idempotent operations must be moved to **after** `interrupt()`,
or deduplicated via `checkpoint_id`); this is a hard constraint for the PRD/build phase, not a bug found here.

---

## Q4: Cross-process checkpoint (most critical)

Three files: `q4-graph-def.mjs` (the graph definition shared by both processes — the checkpoint stores **state**, not the graph definition
itself, so both processes must each independently construct a structurally identical graph), `q4-process-a.mjs` (runs to the G1 interrupt and then
calls `process.exit(0)`, without resuming), `q4-process-b.mjs` (a brand-new `node` invocation, which only knows the `thread_id` +
the sqlite file on disk).

### Process A (runs halfway then exits)

```
$ node docs/feature/a4a-loop/spike/q4-process-a.mjs /tmp/q4-cross-process.sqlite thread-abc-123
[pid 27363] Process A starting, db=/tmp/q4-cross-process.sqlite, thread_id=thread-abc-123
[pid 27363] [coder] drafting for task: toy task: cross-process resume
[pid 27363] [G1] about to interrupt(), coderOutput = fake diff for: toy task: cross-process resume
[pid 27363] Process A invoke() returned (should show __interrupt__):
{
  "task": "toy task: cross-process resume",
  "coderOutput": "fake diff for: toy task: cross-process resume",
  "__interrupt__": [
    {
      "id": "3a31896bfd2e8e67fccdeb897bdb6ffa",
      "value": {
        "gate": "G1_SEND_TO_TESTER",
        "diff": "fake diff for: toy task: cross-process resume",
        "question": "approve sending this diff to tester?"
      }
    }
  ]
}
[pid 27363] Process A state.next (should be ['g1']): [ 'g1' ]
[pid 27363] Process A exiting now WITHOUT resuming. Checkpoint should be on disk at /tmp/q4-cross-process.sqlite.
```
After the process exits, confirm the disk files actually exist (WAL mode, three files):
```
$ ls -la /tmp/q4-cross-process.sqlite*
-rw-r--r--  1 elishawong  wheel   4096 ... q4-cross-process.sqlite
-rw-r--r--  1 elishawong  wheel  74192 ... q4-cross-process.sqlite-wal
-rw-r--r--  1 elishawong  wheel  32768 ... q4-cross-process.sqlite-shm
```

### Process B (brand-new process, different pid, resumes purely from thread_id)

```
$ node docs/feature/a4a-loop/spike/q4-process-b.mjs /tmp/q4-cross-process.sqlite thread-abc-123
[pid 27564] Process B starting (fresh process), db=/tmp/q4-cross-process.sqlite, thread_id=thread-abc-123
[pid 27564] Process B getState() BEFORE resume — state.next: [ 'g1' ]
[pid 27564] Process B getState() BEFORE resume — pending interrupts: [
  {
    "id": "3a31896bfd2e8e67fccdeb897bdb6ffa",
    "value": {
      "gate": "G1_SEND_TO_TESTER",
      "diff": "fake diff for: toy task: cross-process resume",
      "question": "approve sending this diff to tester?"
    }
  }
]
[pid 27564] Process B resuming with Command({resume: 'approve-from-process-b'})...
[pid 27564] [G1] about to interrupt(), coderOutput = fake diff for: toy task: cross-process resume
[pid 27564] [G1] resumed with decision = approve-from-process-b
[pid 27564] [tester] reviewing, gateDecision was: approve-from-process-b
[pid 27564] Process B final result:
{
  "task": "toy task: cross-process resume",
  "coderOutput": "fake diff for: toy task: cross-process resume",
  "gateDecision": "approve-from-process-b",
  "testerVerdict": "approved (fake)"
}
[pid 27564] Q4 OK: process B, a fresh node invocation, resumed purely from thread_id + on-disk sqlite checkpoint and ran to completion.
```

**Conclusion (this is the smoking-gun evidence of this spike)**:
- **pid 27363 → pid 27564, two completely independent `node` processes** (not the same process forked, not a worker
  thread — each was invoked separately via `node <script>.mjs`, zero in-memory sharing).
- Without **any** runtime state coming from Process A, Process B's `getState(threadConfig)` can
  read out an interrupt payload that matches Process A's interrupt-time state **exactly** (`gate`/`diff`/`question`, and the id also matches,
  `3a31896b...`) — proving the value thrown by `interrupt()` was **truly persisted to disk**, not just held in memory.
- Relying purely on `{configurable: {thread_id: "thread-abc-123"}}` + a `SqliteSaver.fromConnString(dbPath)` pointing at the
  same sqlite file path, Process B was able to run the entire chain to completion.
- **Directly confirms the DESIGN §5 `workflow_runs.langgraph_thread_id` design**: that column stores exactly this
  `thread_id`; `checkpoint.ts` only needs to store this string into the `workflow_runs` table, and next time it starts, use the same
  `thread_id` to construct `threadConfig` and pass it to `compiled.invoke`/`getState`, and it can achieve "after a restart, continue where it
  left off at whichever of G1/G2/G3 it was stuck on" — this design **has been verified true on this repo's own stack**, it's not just a claim on
  paper.

**API details (for use when writing checkpoint.ts)**: `SqliteSaver.fromConnString(path)` internally is
`new SqliteSaver(new Database(path))` (`Database` comes from `better-sqlite3`), and `.setup()` on its first call automatically creates the
`checkpoints`/`writes` tables and enables `journal_mode=WAL` — **these two tables are completely independent from DESIGN §5's hand-drawn
`workflow_runs`/`structured_claims`/`approvals`**; LangGraph's own checkpoint tables manage "which step the graph execution is at, what the state is,"
while aeloop's own audit tables manage "business-semantic approval records" — these are not the same thing;
when wiring up `checkpoint.ts`, `langgraph_thread_id` should be treated as a foreign key bridging the two sides, one should not expect
LangGraph's checkpoint tables to substitute for DESIGN §5's audit tables.

---

## Q5: Type/ESM compatibility (strict + noUncheckedIndexedAccess + NodeNext)

`docs/feature/a4a-loop/spike/q5-types.ts` rewrote Q3's interrupt/resume scenario, run through
`docs/feature/a4a-loop/spike/tsconfig.q5.json` (`extends` the project root `tsconfig.json`, only
overriding `rootDir`/`outDir`/`noEmit`/`include`, with everything else — `strict`/`noUncheckedIndexedAccess`/
`skipLibCheck`/`module: NodeNext`, etc. — all inherited from the real project config, not a separately set-up looser config).

### First run: TS2345 (a real typing pitfall)

```ts
const resumeCommand = new Command({ resume: "approve" });
const second = await compiled.invoke(resumeCommand, threadConfig);
```
```
$ npx tsc -p docs/feature/a4a-loop/spike/tsconfig.q5.json
docs/feature/a4a-loop/spike/q5-types.ts(68,40): error TS2345: Argument of type
'Command<string, Record<string, unknown>, string>' is not assignable to parameter of type
'CommandInstance<unknown, {...}, "__start__" | "coder" | "g1" | "tester"> | UpdateType<...> | null'.
  ...
    Types of property '[COMMAND_SYMBOL]' are incompatible.
      Type 'string' is not assignable to type '"__start__" | "coder" | "g1" | "tester"'.
exit=1
```

**Root cause** (confirmed by reading `node_modules/@langchain/langgraph/dist/constants.d.ts`, not guessed):
```ts
declare class Command<Resume = unknown, Update extends Record<string, unknown> = Record<string, unknown>, Nodes extends string = string> extends CommandInstance<...>
```
`Command`'s third generic parameter `Nodes` (which nodes this Command is allowed to jump to) **defaults to the bare
`string`**, while `compiled.invoke()` expects the literal union type of node names for that specific compiled graph (like
`"__start__"|"coder"|"g1"|"tester"`). `new Command({resume: "approve"})` written this way gives TS no context
from which to infer what `Nodes` should be, so it falls back to the default, broad `string`, which doesn't match the narrower type
`invoke()` expects, and is structurally incompatible → TS2345.

### Fix (explicitly annotate the generic)

```ts
const resumeCommand = new Command<
  unknown,
  Record<string, unknown>,
  "__start__" | "coder" | "g1" | "tester"
>({ resume: "approve" });
```
```
$ npx tsc -p docs/feature/a4a-loop/spike/tsconfig.q5.json
exit=0
```
Also verified at runtime that the fixed `.ts` file's own logic wasn't broken (Node v24 native type-stripping, used only for verification,
not representative of the production build path — aeloop's production goes through `tsc -p tsconfig.build.json` to produce `.js` before running):
```
$ node docs/feature/a4a-loop/spike/q5-types.ts
(node:28692) ExperimentalWarning: Type Stripping is an experimental feature ...
first: { task: 'toy task', coderOutput: '...', __interrupt__: [ { id: '...', value: [Object] } ] }
second: { task: 'toy task', ..., gateDecision: 'approve', testerVerdict: 'approved (fake), saw gateDecision=approve' }
exit=0
```

**Impact on the A4a PRD**: anywhere in `src/loop/graph.ts`/`gates.ts` that constructs `new Command({resume: ...})`
**must explicitly annotate the third generic parameter as that graph's literal union of node names** (or define a shared
`type LoopNodeName = "coder" | "g1" | "g2" | "g3" | "tester" | ...` for the whole `loop/` module to reuse),
otherwise it will hit TS2345 under aeloop's strict tsconfig — this is a known pitfall at the coding stage, not a design flaw.

### Side check: is skipLibCheck actually needed

DESIGN §9 item 5 (spike Q5) asks "are there any pitfalls, is `skipLibCheck` required." The aeloop project's `tsconfig.json`
already has `skipLibCheck: true` (set back in A0, unrelated to langgraph, a pre-existing config). This spike additionally temporarily turned
it off to test separately (`tsconfig.q5-noskiplib.json`, same directory), confirming that **LangGraph's own `.d.ts`
declaration files are also clean under `skipLibCheck: false`** (`exit=0`, zero errors) — in other words, langgraph's
type declarations themselves don't force a requirement of `skipLibCheck`; aeloop's existing `skipLibCheck: true` is a historical decision
(set in A0), not something langgraph requires, so keeping the status quo is fine.

### Did `noUncheckedIndexedAccess` get triggered

This spike didn't directly index array subscripts like `state.tasks[0]` to read the interrupts field (it used
optional chaining `state.tasks?.[0]?.interrupts`), which is itself exactly the style `noUncheckedIndexedAccess` forces — this
spike was, in the process, forced to write it this way, and it did compile successfully, which shows this constraint can be naturally followed
in the loop layer's code, no exception needed.

---

## Recommendations for the A4a PRD

1. **A small DESIGN section-number correction**: when the task was assigned to me, it said "§9.3 tags LangGraph...verity-proven," but what I actually
   read was `docs/DESIGN.md` **item 3 of the list in §9 "Spikes that must be run before starting work"** (not sub-section 9.3 — DESIGN
   §9 itself doesn't have further 9.1/9.2/9.3 sub-numbering). Original text: "3. `[verity-proven]` LangGraph cross-process
   interrupt/resume, LiteLLM json_schema pass-through, e2e minimal closed loop — Verity has already proven these; for aeloop, after the rewrite,
   just regression-verify." — This spike covers the "LangGraph cross-process interrupt/resume" half of that item (Q3/Q4);
   **"LiteLLM json_schema pass-through" and "e2e minimal closed loop" are not within the scope of this spike, and still need future verification**
   (json_schema pass-through fits more within A2 Harness's scope; the e2e closed loop only makes sense once the coder/tester nodes are wired to real
   adapters — recommend leaving these for the later part of A4a or for A4b).
2. **`workflow-def.ts`'s compilation approach has an implicit requirement**: DESIGN §6 says `graph.ts` should be "compiled from a
   WorkflowDefinition" — this spike's graph is purely hand-written in code (a `buildGraph()` function); it did not verify
   the feasibility of "dynamically generating a StateGraph from a JSON/YAML-format workflow definition" itself. This falls under
   "aeloop's own orchestration-layer design" rather than "LangGraph's capability boundary," and is not within the scope of this spike's 5 Qs, but
   **it's something the A4a PRD must design separately when writing `graph.ts`**; recommend the PRD list "WorkflowDefinition → compile to
   StateGraph" as an independent acceptance item, and not assume it's as simple as the "hand-written graph" this spike proved.
3. **G2/G3 gates + the escalation hard branch were not verified in this spike**: this spike only built a single G1 gate (chained straight through);
   DESIGN §4's full state machine still has G2 (fix-approval branch), G3 (final review), and the `reject_count >= threshold` hard
   escalation branch (a conditional edge). This spike **did not touch** LangGraph's conditional edges (`addConditionalEdges`) at all — this is
   the core mechanism needed for G1/G2/G3 + the threshold escalation; recommend that A4a's first build batch do a minimal verification of
   `addConditionalEdges` as the very first thing (even if still with toy nodes), because this is the one LangGraph capability that this spike hasn't
   empirically verified, yet that DESIGN §4's diagram explicitly needs — the risk remains uncleared.
4. **Batch-splitting suggestion** (based on the capability boundaries this spike proved):
   - **Batch 1**: `graph.ts` skeleton + `nodes/coder.ts`/`nodes/tester.ts` (start with fixtures/fake data,
     mirroring this spike's Q2) + supplementary verification of `addConditionalEdges` (the gap noted in recommendation 3).
   - **Batch 2**: `gates.ts` (G1/G2/G3 interrupt, mirroring Q3) + `escalation.ts` (the threshold hard branch,
     wired up using conditional edges).
   - **Batch 3**: `checkpoint.ts` (wire `SqliteSaver` to `workflow_runs.langgraph_thread_id`,
     mirroring Q4's cross-process verification approach, but this time wiring to DESIGN §5's three audit tables, not just LangGraph's own
     `checkpoints`/`writes` tables).
   - **Batch 4**: swap the coder/tester nodes for real A2/A3 adapters (ProviderRouter + CliAdapter), do a
     real e2e thin vertical slice (the kind of "the finish line must be a real connection" required by DESIGN §8.5's anti-fragmentation methodology warning).
   This split separates "the LangGraph mechanism itself" (batches 1-3) from "wiring up aeloop's own harness layer" (batch 4) —
   the risk on the first three batches has already been substantially reduced by this spike; batch 4's risk is mainly on the A2/A3 adapter side, not the
   LangGraph side.
5. **No new fork in the road that needs the commander's decision right now** — all 5 Qs in this spike ran as expected, and DESIGN §4/§5/§6's
   existing design was not falsified; the only thing that counts as a "decision" is that in recommendation 1, the non-official npm package
   `langgraph-checkpoint-sqlite-native` **should not be adopted** (continue with the official package + better-sqlite3) — this spike has already
   made this call on the PRD's behalf, no need for
   additional escalated discussion; the PRD stage can just write it this way.

---

## Appendix: What this spike changed / installed (an honest inventory)

**Files changed** (all on the `feature/issue-13-a4a-loop` branch, not committed):
- `package.json` / `pnpm-lock.yaml` — 2 new direct dependencies added (see the Q1 diff)
- New `docs/feature/a4a-loop/spike/`: `q1-import.mjs` / `q2-two-node-graph.mjs` /
  `q3-interrupt-resume.mjs` / `q4-graph-def.mjs` / `q4-process-a.mjs` / `q4-process-b.mjs` /
  `q5-types.ts` / `tsconfig.q5.json` / `tsconfig.q5-noskiplib.json`
- New file `docs/feature/a4a-loop/spike-findings.md` (this file)

**Dependencies installed**: `@langchain/langgraph@1.4.8`, `@langchain/langgraph-checkpoint-sqlite@1.0.3`
(+ transitive dependencies pnpm resolved automatically: `@langchain/core`, `@langchain/langgraph-checkpoint`,
`@langchain/protocol`, `@langchain/langgraph-sdk`, `@standard-schema/spec`, etc., 20 packages total,
see `pnpm-lock.yaml` diff for details).

**Not changed**: `src/` (zero changes to the engine's existing code), the `main` branch (never switched back to it throughout), any other project repos.

**Regression confirmation**: `pnpm lint` (`tsc --noEmit`) and `pnpm test` (228/228 tests) remained **fully green** after installing the new dependencies +
adding the spike files — the spike files are not within `tsconfig.json`'s `include: ["src/**/*.ts"]` scope,
so they don't interfere with the existing build/test pipeline.
