# PRD — aeloop A4b: Loop Orchestration Wrap-up (threshold escalation + three audit tables persisted + checkpoint cross-process productionization)

> Skeleton source: `aeloop/docs/feature/a4a-loop/PRD.md` (the other half of the same milestone; structure/batches/wording style copied directly — §0's scope split was decided there).
> Anti-hallucination: `[?]` = unverified by me / needs Commander confirmation; no invented interfaces/versions/parameters. Every statement in this PRD about existing code comes from my own reading of the real A4a code (`src/loop/*.ts`) + `docs/DESIGN.md` + `docs/feature/a4a-loop/spike-findings.md`, not from memory; any design decision without direct code/document evidence that requires my own judgment is listed separately in §9, not mixed into the "verified" parts.

- **Project**: aeloop (`elishawong/aeloop`, private repo)
- **Branch**: `feature/issue-13-a4b-loop` (newly cut from main `c6589b7`, i.e. the HEAD right after A4a merged)
- **Priority**: P1
- **Status**: Awaiting Commander confirmation
- **Last updated**: 2026-07-21
- **Related issue**: [elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13) (parent A4 Loop issue) — **⚠️ Verification turned up an issue that needs the Commander/Helix to resolve first, see §0.1**
- **Design authority**: `aeloop/docs/DESIGN.md` (§4 gate-flow diagram / §5 ER for the three audit tables / §6 `src/loop/` target layout including `escalation.ts` / §7 `config.yaml`'s `workflow.reject_threshold` / §8.5 methodology caveats) + real A4a code `src/loop/{types,errors,gates,graph,checkpoint,workflow-def}.ts`/`nodes/{coder,tester}.ts` + A4a's `docs/feature/a4a-loop/{PRD.md,spike-findings.md}`

---

## 0. Scope (continuing the split already established in A4a PRD §0)

A4a PRD §0 split the A4 Loop parent scope into two halves and already documented the rationale for the split. A4b (this PRD) delivers the half left open:

1. **Threshold escalation hard branch** — the conditional route for `reject_count >= threshold` + the `Escalation` node + the manual three-way human decision (revise code/restate → Draft, force pass → G3, abandon → Cancel) + the `Cancel` terminal state. `config.yaml`'s `workflow.reject_threshold` (present but nobody reads it, explicitly left open as a non-goal in A4a §2) gets read for the first time in this increment.
2. **Three audit tables persisted** — `workflow_runs`/`structured_claims`/`approvals` (DESIGN §5 ER) actually get created and actually get written to. A4a's `gateLog` (which does get persisted incidentally via the LangGraph checkpoint) is the field-naming precursor to these three business tables (especially `approvals`).
3. **checkpoint cross-process resume, productionized** — store `langgraph_thread_id` in `workflow_runs`, building out the full path where "a single identifier for the run (not any in-memory reference) is enough to find the thread_id and resume in a brand-new process." A4a spike Q4 already proved, in this repo/stack, using two real `node` child processes, that LangGraph's own checkpoint mechanism itself is trustworthy. What A4b needs to prove is that the layer aeloop wires on top of it (`workflow_runs` lookup → checkpointer construction → resume) also holds up under production semantics.

### 0.1 Verification result on issue #13's current state — one thing needs the Commander/Helix to decide first

Per the assignment instructions, this PRD does not open a new issue and continues to use #13 (a precedent already established by A4a PRD §0.1). But when I ran `gh issue view 13` to verify, I found that **issue #13 is currently `CLOSED`** (`state: CLOSED`). Cross-checking A4a's merge PR #15, its body literally says "The A4a sub-scope of parent A4 Loop issue #13 (A4b ... still to come, so this PR does **not** close #13)," yet `gh pr view 15 --json closingIssuesReferences` shows #13 was in fact linked by PR #15 as a "closing issue" (`mergedAt: 2026-07-21T00:43:10Z`) — **this contradicts what the PR author (Cypher, in a prior round) explicitly wrote as intent**. Most likely, some `#13` text somewhere in the commit message/PR body triggered GitHub's auto-close linking (e.g. a commit message like `feat(loop): #13 A4a Loop orchestration...` can be read as a closing keyword in some contexts, even though another sentence in the body explicitly says "does not close"), not the Commander deliberately closing it.

**I did not reopen the issue myself** — the life/death state of an issue is not within the normal authority scope of "producing a PRD," and I can't rule out the possibility that the Commander, after reviewing the A4a deliverable, deliberately kept it closed and intends to manually open a new issue (though I found no evidence supporting that possibility). **This is something that needs the Commander/Helix to confirm before proceeding**: if we're to continue with #13 per the A4a PRD §0.1 precedent, `gh issue reopen 13` needs to happen first; if the Commander would rather open a separate new issue for A4b (e.g. riding on this accidental-close event to split into two independently trackable issues), please just say so and I can adjust the issue link at the top of this PRD on the spot. **The rest of this PRD is written under the assumption of "continue with #13, needs reopening first" — this does not block reviewing the plan.**

---

## 1. Problem / Users / Solution

- **Problem to solve**: A4a delivered the part of DESIGN §4's state machine that's "within normal range of back-and-forth rejections" — the normal branches of gates G1/G2/G3, the full Draft↔Review round trip, and `reject_count` incrementing itself. But **nothing reads that counter to make a decision**: `config.yaml`'s `workflow.reject_threshold: 2` has gone unconsumed since the day `profile/loader.ts` first parsed it out (A2's `SystemConfig.getDefaultRejectThreshold()` is likewise "reserved but with no consumer" — see the verification in §9.2 below). Meanwhile, every gate decision produced during A4a's graph execution (`gateLog`) and every claim the model self-reports (`coderOutput.claims`/`testerOutput.claims`), aside from living inside LangGraph's own checkpoint serialization (the `checkpoints`/`writes` tables, which only care about "where in the graph execution we are," not business-audit semantics), has nowhere to answer questions like "how many times did this run get sent back in total," "who approved G3 and when," or "what claims did the tester make, with what confidence" — the three audit tables DESIGN §5 drew simply don't exist. And as for "after a restart, can we pick up where we left off at whichever gate, given just the run's identifier" — A4a's spike proved the LangGraph-level mechanism is feasible, but aeloop's own business layer (how to actually find the `thread_id`) was never wired up at all.
- **Who it's for**: The direct consumer is A5 (CLI/TUI, which needs the audit tables to answer "what's the history of this run" and needs the `workflow_runs` table to answer "where did I leave off last time, give me a list I can resume from") and A6 (dual-profile acceptance testing, which needs the audit tables to prove that both profiles' runs each leave a trail). The indirect consumer is the Commander himself — DESIGN §2's use-case diagram `UC9 view approval audit trail` now has real data to look at for the first time.
- **One-sentence solution**: `src/loop/escalation.ts` (new) builds the Escalation gate node per DESIGN §4's `Esc`/`HD` (reusing A4a `gates.ts`'s already-proven `interrupt()`/`Command({resume})` pattern, but the decision domain is a three-way choice, not G1/G2/G3's binary choice, so it doesn't directly reuse the `createGateNode` factory — see §5 for why). `gates.ts` changes two routing spots (`routeAfterReview` compares `rejectCount`/`rejectThreshold` before deciding between `g2` and `escalation` on a reject; `routeAfterG2` recognizes one more "actively escalate" decision value). `graph.ts` wires in the two new nodes `escalation`/`cancel`. `src/loop/audit-store.ts` (new) is the Loop layer's own SQLite store — it does **not** reuse/import the `MemoryStore` class from `context/store.ts`; it's that class's structural sibling (rationale in §9.2 decision 1), independently managing table creation + CRUD for the three tables `workflow_runs`/`structured_claims`/`approvals`. `src/loop/runner.ts` (new) is a thin orchestration layer sitting on top of the graph nodes/gates: when starting a new run, it first inserts a `workflow_runs` row via `AuditStore` to get a `runId`; after every `invoke`/`resume` returns, it persists the newly-appeared `gateLog` entries to `approvals`, persists the new claims to `structured_claims`, and refreshes `workflow_runs`'s `status`/`reject_count`/`current_state`/`updated_at` — the graph nodes/gates themselves continue to uphold the "zero I/O, toy-node-testable" purity established in A4a; all audit writes happen in this layer outside the graph (an extension of the spirit of A4a's "must be a pure function before interrupt" discipline). The checkpoint cross-process acceptance test switches to spike Q4's style of **two genuinely separate `node` child processes** (rather than the same-process two-phase approach A4a's own tests used), because A4b's task definition is literally "productionize" that path — rationale in §9.2 decision 4.

## 2. Goals / Non-goals

**Goals**:
- `src/loop/escalation.ts`: `createEscalationNode()` (a three-way interrupt gate) + `routeAfterEscalation()` (three routes: `"draft" | "g3" | "cancel"`).
- `src/loop/gates.ts` changes: `routeAfterReview` gains a threshold branch (`"g3" | "g2" | "escalation"`); `routeAfterG2` gains an "actively escalate" branch (`"draft" | "escalation"`, `"rejected"` still fails loud — that A4a judgment is unchanged).
- `src/loop/types.ts` changes: `LoopState` gains `rejectThreshold` (injected once from outside the graph, immutable), `escalationDecision`, `cancelled`; `GateType` gains `"ESCALATION_ACK"`; `GateDecision` gains a third value (G2's "actively escalate"); new `EscalationDecision` type added.
- `src/loop/workflow-def.ts` changes: `LOOP_NODES` gains `escalation`/`cancel`; `GATE_TYPES` gains `ESCALATION_ACK`; `CODER_TESTER_LOOP_DEFINITION`'s edge list synced accordingly (documentation only, same downgraded conclusion as A4a).
- `src/loop/graph.ts` changes: wires in the two new nodes `escalation`/`cancel` and their edges; `review`'s conditional-edge target set expands from `{g3,g2}` to `{g3,g2,escalation}`; `g2`'s conditional-edge target set expands from `{draft}` to `{draft,escalation}`.
- `src/loop/audit-store.ts` (new): the `AuditStore` class — table creation + insert/read methods for the three tables `workflow_runs`/`structured_claims`/`approvals` (field-aligned with DESIGN §5 ER, see §4).
- `src/loop/runner.ts` (new): `startRun()`/`resumeRun()` — a wrapper around `compiled.invoke()`/`Command({resume})` that, after every call, persists newly-appeared `gateLog`/`claims` entries and refreshes the `workflow_runs` row; `runId`/`threadId` are this layer's external handles.
- **checkpoint cross-process productionization**: a test using a real `child_process` (two independent `node -e`/script invocations, mirroring spike Q4's Process A/B pattern) proving that "process A runs to some gate, interrupts, and exits → process B, given only the `runId` in the `workflow_runs` table (not any in-memory reference), looks up `langgraph_thread_id` + `reject_threshold` etc. → reconstructs the checkpointer/graph → resumes through to completion."
- **Hard vertical slice** (a longer one than A4a's): a real end-to-end path (Context→Prompt→cli-bridge fixture adapter→real graph→real checkpointer→real `AuditStore`) that runs a path that **deliberately gets rejected until it hits the threshold** — a tester fixture configured to reject N consecutive times (`N = threshold`) → routes to `escalation` → the human picks "force pass" → `g3` → `apply`, with `approvals`/`structured_claims`/`workflow_runs` all asserted to be genuinely written to and field-aligned throughout.

**Non-goals (explicitly out of scope, left to A5/A6 or a later increment)**:
- ❌ **Colorful TUI / y-n approval interface** — that's A5's job. The Escalation gate, like G1/G2/G3, has its decision injected by test code directly constructing `Command({resume: {...}})`.
- ❌ **Any "list all resumable runs" CLI command consuming `workflow_runs`** — that's A5's UI-layer work; A4b only delivers the table itself + underlying query methods (`AuditStore.getRunById`/`getRunByThreadId`), not a list/interactive command.
- ❌ **Making the full priority mechanism between the two threshold sources — `system_config.default_reject_threshold` (already built by A2, no consumer) and `config.yaml`'s `workflow.reject_threshold` — configurable as a policy**. A4b only implements one explicit, hardcoded priority order (see §9.2 decision 2 for the conclusion); it does not implement a "which one takes priority is itself configurable" second-order config.
- ❌ **Actually persisting the diff to the filesystem in the workspace** — carried over from A4a §2's non-goal; the `Apply` node continues to only finalize state, without touching the filesystem. This boundary is not being re-litigated in this increment.
- ❌ **Any cleanup action after `Cancel`** (e.g. deleting temp files, notification channels) — the `Cancel` node, like `Apply`, only finalizes state (`{cancelled: true}`), with no side effects.
- ❌ **Anything in `profiles/apikey/`** — not touched.
- ❌ **`AuditStore` and `MemoryStore`/`checkpoint.ts` having their db paths automatically computed by `profile/loader.ts`** — A1/A2/A4a have none of them done this wiring layer yet ("profile decides the real file path"; `MemoryStore`/`createSqliteCheckpointer` still both require the caller to pass in `dbPath` explicitly to this day). A4b continues this existing boundary — `AuditStore` likewise only accepts an explicit `dbPath` constructor argument. §9.2 decision 3 will describe the **recommended target path relationship** (for a future wiring increment to reference), but this increment does not implement automatic path resolution.
- ❌ **Having G3's payload distinguish "normal G3" from "G3 after a forced pass"** — DESIGN §4's `HD-- force pass -->G3` means that after a forced pass, it still goes through a normal G3 sign-off; A4b makes it the same `createG3Node()` with no added field marking "this G3 was forced through." If the Commander thinks the audit tables need to distinguish these two kinds of G3, please flag it — §9.2 will leave room for an optional added field.

## 3. User Stories

- As **the future A5 CLI**, I want a row in `workflow_runs` that lets me query which `current_state` a given run is currently stuck at and what its `langgraph_thread_id` is, so that "resuming an unfinished run" doesn't require the user to remember any in-process state themselves.
- As **the future A6 dual-profile acceptance test**, I want every claim left by a real coder/tester call (`claim_text`/`confidence`/`verified_by`/`tool_exec_checked`) and every gate decision (`gate_type`/`decision`/`decided_by`/`decided_at`) to be queryable from the `structured_claims`/`approvals` tables, without having to replay test logs.
- As **the Commander**, I want to see a test that actually drives `reject_count` up to `reject_threshold`, proving the graph automatically routes to Escalation instead of rejecting infinitely at G2, and that the "force pass / revise / abandon" decision I make at the Escalation gate leads to three distinct, real end points: G3 / Draft / Cancel respectively.
- As **the Commander**, I want confirmation that the phrase "resume after a restart" now has real cross-process evidence (not pretending to discard a reference within the same process), proven at the same rigor as A4a spike Q4 (two genuinely separate `node` processes, different pids).

## 4. Data Model

### 4.1 New/changed `LoopState` fields (`src/loop/types.ts`)

```typescript
const LoopState = Annotation.Root({
  // ...all existing A4a fields retained unchanged...

  /** Snapshot of this run's reject threshold — injected once from outside the graph (same standing as injectedContext), constant for the whole run. Source: see §9.2 decision 2. */
  rejectThreshold: Annotation<number>(),

  /** The human's three-way decision at the Escalation gate; undefined until the run actually reaches this gate for the first time. */
  escalationDecision: Annotation<EscalationDecision | undefined>(),

  /** Cancel node's terminal marker, semantically symmetric to A4a's existing `applied`. */
  cancelled: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});
```

`GateType` gains one value: `"ESCALATION_ACK"` (the one value in DESIGN §5's `approvals.gate_type` enum that A4a never implemented, now filled in).

`GateDecision` expands from A4a's `"approved" | "rejected"` to `"approved" | "rejected" | "escalate"` — the third value is recognized only by `routeAfterG2` (DESIGN §4's `G2-- actively escalate -->Esc` edge); if `routeAfterG1`/`routeAfterG3` ever receive it, they fall into their existing `default: throw new Error(...)` catch-all (this value never has meaning in either gate's normal semantics — not a newly introduced gap, but a continuation of the "the type system allows it but a specific gate doesn't recognize it" handling already established in A4a).

New `EscalationDecision = "revise" | "force_pass" | "abandon"` — **literally mapped from the three outgoing edges DESIGN §4's state diagram draws off node `HD`** ("revise code/restate"/"force pass"/"abandon"), not a fourth vocabulary I invented. The resume-value types used by G1/G2/G3 (`GateResumeValue`) and by the Escalation gate are kept separate: new `EscalationResumeValue = { decision: EscalationDecision; reasoningText?: string }`.

`GateLogEntry.decision`'s type expands from `GateDecision` to `GateDecision | EscalationDecision` (a log entry produced by the Escalation gate has a `decision` field that's a three-way value, not binary) — whether this turns out to be another TS-type detail this increment only nails down once build actually starts (similar to the `LoopStateType`/`Command` generic gotchas A4a §9.3 called out), I'm not sure — flagged `[?]`, to be adjusted at build time on first `tsc` error; it doesn't affect the field semantics described here.

### 4.2 The three audit tables (`src/loop/audit-store.ts`, `CREATE TABLE IF NOT EXISTS`, created at `AuditStore` construction time, same convention as `MemoryStore`'s `createSchema()`)

Strictly aligned with DESIGN §5 ER (column names/types/nullability), `snake_case` columns + application-layer camelCase mapping, same convention as `context/store.ts`'s `MemoryRow`/`Memory` mapping:

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  workflow_def_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'running' | 'escalated' | 'completed' | 'cancelled'
  reject_count INTEGER NOT NULL DEFAULT 0,
  reject_threshold INTEGER NOT NULL,  -- snapshot for this run, does not track later config.yaml changes
  current_state TEXT NOT NULL,        -- one of LOOP_NODES' values, refreshed by runner after every step
  langgraph_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structured_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  step_ref TEXT NOT NULL,             -- "<node>#<round>", see the step_ref judgment call below
  actor TEXT NOT NULL,                -- 'coder' | 'tester'
  claim_text TEXT NOT NULL,
  confidence TEXT NOT NULL,           -- ClaimConfidence: verified/inferred/unconfirmed/stale
  source_ref TEXT,
  verified_by TEXT,                   -- VerifiedBy: tool_execution/human/unverified
  tool_exec_checked TEXT,             -- ToolExecChecked: pass/fail/na, from InvokeResult (only present with cli-bridge, NULL for direct-api)
  model_used TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  gate_type TEXT NOT NULL,            -- one of GATE_TYPES' values, including the new ESCALATION_ACK
  step_ref TEXT NOT NULL,
  diff_ref TEXT,
  reasoning_text TEXT,
  decision TEXT NOT NULL,             -- for G1/G2/G3 rows: approved/rejected/escalate; for ESCALATION_ACK rows: revise/force_pass/abandon (see §9.2 decision 5)
  decision_reason TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  latency_seconds INTEGER
);
```

**`step_ref`'s format** (DESIGN doesn't give a concrete format, `[?]` this is my judgment call): `"<a LOOP_NODES value>#<how many times this node has run in this run, starting at 1>"`, e.g. `"draft#1"`/`"review#2"`. `runner.ts` maintains an internal "how many times each node name has executed" counter (after every `invoke`/`resume` returns, it compares old vs. new state to figure out which node(s) it passed through and increments the corresponding counter); this counter **exists only as a runtime variable inside `runner.ts`, and is never persisted as part of `LoopState`** — it's purely audit-write helper information, not something the graph's logic needs, and putting it into `LoopState` would burden the "shape of the graph's state" with a concern that doesn't belong to it (echoing the layering rationale in §9.2 decision 1).

**Where `decided_by` comes from**: neither of A4a's `GateResumeValue`/`EscalationResumeValue` has a "who made this decision" field (only `decision`/`reasoningText`). Does A4b need to add a `decidedBy: string` field to the resume value passed into `Command({resume})`, or should the caller of `runner.ts` (test code / future CLI) pass it separately when calling `resumeRun()`? **I lean toward the latter** — `decidedBy` is external-environment information about "who is performing this resume," not "data produced by the graph's execution up to this step," and like `injectedContext`/`rejectThreshold`, it should be "injected from outside the graph" rather than belonging to the shape of "a human's answer to `interrupt()`" that `GateResumeValue`/`EscalationResumeValue` represent. The `runner.resumeRun(runId, threadId, resume, decidedBy)` signature takes this as a separate parameter. Flagged `[?]` for confirmation — this is the only loose small judgment call in this PRD outside the six main decisions in §9.2.

## 5. Per-file Task List

### `src/loop/types.ts` (change, not a new file)
- See §4.1 for all field/type changes. `LoopNodeName`'s union doesn't need a change (`(typeof LOOP_NODES)[keyof typeof LOOP_NODES]` automatically picks up the new `escalation`/`cancel` from `workflow-def.ts`).

### `src/loop/errors.ts` (change)
- `UnhandledGateDecisionError` stays (still the one thrown when `routeAfterG2` receives `"rejected"`, semantics unchanged).
- New `AuditReadError extends Error` (thrown when `AuditStore`'s read methods fail, mirroring `context/errors.ts`'s `RecallError` convention — the discipline that "read failures must be visible, must not silently degrade into an empty result/undefined" carries over to the Loop layer's own store). Write methods (insert) let `better-sqlite3`'s `SqliteError` propagate as-is, without extra wrapping — same existing convention as `MemoryStore`'s write methods (part of §9.2 decision 1).

### `src/loop/workflow-def.ts` (change)
- `LOOP_NODES` gains `escalation: "escalation"`, `cancel: "cancel"`.
- `GATE_TYPES` gains `ESCALATION_ACK: "ESCALATION_ACK"`.
- `CODER_TESTER_LOOP_DEFINITION.edges` synced with the new edges (documentation only, same downgraded conclusion as A4a — `graph.ts` still doesn't read it at runtime):
  - `review → [g3, g2, escalation]` (expanded from A4a's `[g3, g2]`)
  - `g2 → [draft, escalation]` (expanded from A4a's `[draft]`)
  - `escalation → [draft, g3, cancel]` (new)
  - `cancel → "__end__"` (new)

### `src/loop/gates.ts` (change, not a new file — an existing A4a file)
- `routeAfterReview`: signature changes from `(state): "g3" | "g2"` to `(state): "g3" | "g2" | "escalation"`. Logic: `verdict === "pass" → "g3"`; when `verdict === "reject"`, `state.rejectCount >= state.rejectThreshold → "escalation"`, otherwise `"g2"`. **This depends on the fact that `nodes/tester.ts` already increments `rejectCount` in its return value** (existing A4a behavior, `tester.ts` doesn't need to change — LangGraph merges a node's returned `Partial<LoopStateType>` into state *before* evaluating that node's conditional-edge routing function, so `routeAfterReview` reads the already-incremented value; I explain in §9.2 decision 6 in detail why `tester.ts` doesn't need touching).
- `routeAfterG2`: signature changes from `(state): "draft"` to `(state): "draft" | "escalation"`. `"approved" → "draft"` (unchanged); `"escalate" → "escalation"` (new, DESIGN §4's `G2-- actively escalate -->Esc`); `"rejected"` and any other value still throws `UnhandledGateDecisionError` (this A4a judgment is not being overturned in this increment).
- Everything else (`createGateNode`/`createG1Node`/`createG2Node`/`createG3Node`/`routeAfterG1`/`routeAfterG3`) **unchanged** — these gates' decision domains/routing target sets don't change in A4b.

### `src/loop/escalation.ts` (**new file**)
- **Why not reuse `gates.ts`'s `createGateNode` factory**: that factory's type signature assumes the resume value is the binary `GateResumeValue` (`decision: GateDecision`), and internally uses a three-way `switch` to map `decisionField` onto one of the three specific fields `g1Decision`/`g2Decision`/`g3Decision` — the Escalation gate's resume value is the three-way `EscalationResumeValue` (`decision: EscalationDecision`), written back into the single field `escalationDecision`. Forcing it into the existing factory would either break its type precision (the factory deliberately avoids using "computed property keys" in order to preserve `Partial<LoopStateType>`'s precise typing, per the existing comment in `gates.ts`), or require generalizing the factory into a version generic over both decision types — and the risk of that genericization itself (potentially affecting the `gates.ts` logic that's already A4a-tested and already reviewed three rounds by Zorro) outweighs the benefit of "writing a few fewer duplicated lines." `escalation.ts` is therefore an independent implementation structurally **parallel** to `createGateNode`, replicating its core discipline of "pure payload function → `interrupt()` → only construct the log entry afterward" (the same rule from A4a spike Q3 applies here too, just because it's a new file doesn't mean it's OK to violate it).
  ```typescript
  export function createEscalationNode(): (state: LoopStateType) => Partial<LoopStateType> {
    return (state) => {
      const payload: GatePayload = {
        gate: GATE_TYPES.ESCALATION_ACK,
        question: "reject_count reached the threshold — revise / force-pass / abandon?",
        ...(state.coderOutput?.diff !== undefined ? { diffRef: state.coderOutput.diff } : {}),
        ...(state.testerOutput?.issues !== undefined ? { issues: state.testerOutput.issues } : {}),
      };
      const resume = interrupt<GatePayload, EscalationResumeValue>(payload);
      const entry: GateLogEntry = {
        gate: GATE_TYPES.ESCALATION_ACK,
        decision: resume.decision,
        decidedAt: new Date().toISOString(),
        ...(resume.reasoningText !== undefined ? { reasoningText: resume.reasoningText } : {}),
      };
      const feedback =
        resume.decision === "revise"
          ? [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n")
          : undefined; // force_pass/abandon doesn't go back to Draft, no next-round feedback needed
      return { escalationDecision: resume.decision, feedback, gateLog: [entry] };
    };
  }

  export function routeAfterEscalation(state: LoopStateType): "draft" | "g3" | "cancel" {
    switch (state.escalationDecision) {
      case "revise": return "draft";
      case "force_pass": return "g3";
      case "abandon": return "cancel";
      default:
        throw new Error(`routeAfterEscalation: unexpected escalationDecision ${JSON.stringify(state.escalationDecision)}`);
    }
  }
  ```
  (This is the design shape, not the final code — whether `GatePayload`/`GateLogEntry` need dedicated extended fields for Escalation, and whether the generic annotation on `interrupt<GatePayload, EscalationResumeValue>` matches the A4a spike Q5 gotcha, to be verified at build time.)

### `src/loop/graph.ts` (change)
- `addNode(LOOP_NODES.escalation, createEscalationNode())`
- `addNode(LOOP_NODES.cancel, cancelNode)` (a new small internal function, `{cancelled: true}`, fully symmetric to the existing `applyNode`, likewise not warranting its own `nodes/cancel.ts` file — DESIGN §6's file listing doesn't list one either)
- `addConditionalEdges(LOOP_NODES.review, routeAfterReview, { g3: ..., g2: ..., escalation: LOOP_NODES.escalation })` (replaces A4a's existing two-way pathMap)
- `addConditionalEdges(LOOP_NODES.g2, routeAfterG2, { draft: ..., escalation: LOOP_NODES.escalation })` (replaces A4a's existing single-way pathMap)
- `addConditionalEdges(LOOP_NODES.escalation, routeAfterEscalation, { draft: ..., g3: ..., cancel: LOOP_NODES.cancel })` (new)
- `addEdge(LOOP_NODES.cancel, END)` (new)
- `buildLoopGraph(deps)`'s signature unchanged (neither the `escalation` nor `cancel` node has any external dependencies, no `router`/`composer` needed).

### `src/loop/audit-store.ts` (**new file**)
- The `AuditStore` class, constructor `(dbPath: string)`, opens its own `better-sqlite3.Database` connection internally (does **not** reuse/wrap `MemoryStore` — see §9.2 decision 1), `createSchema()` creates the three §4.2 tables (`CREATE TABLE IF NOT EXISTS`, idempotent, same convention as `MemoryStore`).
- Write methods: `insertRun(input): WorkflowRun` (returns the full row with its `id`, same convention as `MemoryStore.insertMemory`), `updateRunProgress(id, patch: {status?, rejectCount?, currentState?, updatedAt})`, `insertClaim(input): StructuredClaim`, `insertApproval(input): Approval`.
- Read methods (failures wrapped in `AuditReadError`, same convention as `RecallError`): `getRunById(id): WorkflowRun | undefined`, `getRunByThreadId(threadId): WorkflowRun | undefined` (**the core query for the cross-process resume-productionization test** — "process B, knowing only threadId or runId, must be able to query back the whole row").
- `runInTransaction<T>(fn: () => T): T` — same as `MemoryStore`, for `runner.ts` to wrap multi-row writes like "insert several claims" into a single transaction.
- `close(): void`.
- This file **does not** import `../context/store.js` or any implementation from `context/` (only type-level reuse of `ClaimConfidence`/`VerifiedBy`/`ToolExecChecked` — enums **already defined in `harness/`/`prompt/`** — if needed; those don't count as a `context` dependency). The `nowIso()` timestamp helper is duplicated as a 2-line function inside this file instead of introducing a dependency on `context/util.ts` (an extension of §9.2 decision 1's judgment; rationale: a 2-line pure function isn't worth promoting `nowIso` up to `src/shared/` and having both layers change their imports for it — revisit once a genuine third use case shows up).

### `src/loop/runner.ts` (**new file**)
- `interface StartRunDeps { router: ProviderRouter; composer: PromptComposer; audit: AuditStore; checkpointer: BaseCheckpointSaver }` (has `audit`/`checkpointer` in addition to `LoopGraphDeps`; `runner.ts` is the only place that holds both "graph dependencies" and "audit dependencies" at once — the graph nodes themselves remain completely unaware of `AuditStore`).
- `startRun(deps, input: { task: string; profile: string; workflowDefId: string; injectedContext: ContextInjectionResult; rejectThreshold: number }): Promise<RunHandle>`:
  1. Generate a `threadId` (`[?]` how — `crypto.randomUUID()` is the obvious choice: built into Node, no new dependency, unless the Commander has a different preference).
  2. `deps.audit.insertRun({ task, workflowDefId, profile, status: "running", rejectCount: 0, rejectThreshold, currentState: LOOP_NODES.draft, langgraphThreadId: threadId, ... })` to get `runId`.
  3. `compileLoopGraph(buildLoopGraph({router: deps.router, composer: deps.composer}), deps.checkpointer).invoke({task, injectedContext, rejectThreshold, ...remaining fields default}, {configurable: {thread_id: threadId}})`.
  4. Diff the state before and after invoke, persist newly-appeared `gateLog` entries / `coderOutput.claims` / `testerOutput.claims` into `approvals`/`structured_claims` (this is where the §4.2 `step_ref` counter starts being maintained), refresh `workflow_runs`'s `current_state`/`updated_at` (`status` only changes to `completed`/`cancelled` once it truly reaches `applied`/`cancelled`; it stays `running` in the meantime, unless `escalationDecision` has been set — in which case `status` is briefly marked `escalated`, a detail §9.2's decisions don't cover, flagged `[?]`, exact status-machine mapping to be confirmed at build time).
  5. Returns `{ runId, threadId, interruptState | finalState }` (exact shape decided at build time, corresponding to the two possible return cases: interrupted or completed).
- `resumeRun(deps, runId: number, threadId: string, resume: GateResumeValue | EscalationResumeValue, decidedBy: string): Promise<RunHandle>`: symmetric logic, resumes via `Command({resume})` + the same audit persistence. **Key constraint**: this function **does not require the caller to hold any in-memory object reference originating from `startRun()`** — it only needs `runId`/`threadId` (whether from `AuditStore` or self-recorded by the caller) plus a freshly constructed `checkpointer` (pointing at the same db file). This is the concrete meaning of the word "productionized" in this PRD: `resumeRun`'s parameter list is **itself** the evidence that it "can be called in a brand-new process," no extra wrapping needed.
- `getResumableRuns(deps, status: "running" | "escalated"): WorkflowRun[]` (a thin wrapper over `AuditStore`'s read methods, giving a future A5 a ready-made entry point — **this is not a focus this increment's tests need to cover**, it's just conveniently pinning down the shape of the read interface `runner.ts` should expose as the "business layer," not extra scope).

### Dependencies / packaging
- `package.json`: **no new dependencies** (`crypto`/`node:crypto` is built into Node).

### Tests (mapped one-to-one to the per-file tasks, continuing A4a's established "real but controlled" three-layer philosophy + a new 4th layer "audit layer" and a new 5th layer "cross-process")

1. **New branches in `escalation.ts`/`graph.ts` — toy nodes + `MemorySaver`** (appended to `graph.test.ts`, not a new file): ① rejections in a row reaching `rejectThreshold` → routes to `escalation` instead of `g2`; ② `escalation` gate receiving `"force_pass"` → routes to `g3` → normal G3 approve afterward → apply; ③ receiving `"revise"` → routes to `draft`, with `feedback` carrying the tester's issues; ④ receiving `"abandon"` → routes to `cancel` → `state.cancelled === true`; ⑤ G2 receiving `"escalate"` → routes to `escalation` (not `draft`); ⑥ `escalation` receiving an unrecognized value → throws `Error` (mirroring the existing G1/G3 catch-all test pattern in A4a).
2. **`audit-store.ts` unit tests** (new `src/loop/__tests__/audit-store.test.ts`): real `better-sqlite3` temp file (same technique as `checkpoint.test.ts`'s `fs.mkdtempSync`), ① `insertRun`/`getRunById` round trip; ② `getRunByThreadId` can find it; ③ behavior when `insertClaim`/`insertApproval`'s foreign key (`run_id`) points to a nonexistent `workflow_runs.id` (`better-sqlite3` doesn't enforce foreign keys by default unless `PRAGMA foreign_keys=ON` — **whether to turn on foreign-key enforcement on this store is a small judgment call**, `MemoryStore` has it on, `AuditStore` most likely should too, flagged `[?]` but leaning "on," to be confirmed at build time); ④ `runInTransaction` failure rolls back without leaving half-written data.
3. **`runner.ts` unit tests** (new `src/loop/__tests__/runner.test.ts`): real `graph.ts` (not a toy graph, same rationale as A4a testing checkpoint with a real graph) + `FakeAdapter` (same technique already used by A4a) + a real `AuditStore` (temp file) + a real `SqliteSaver` (either a separate temp file, or sharing the same file as `AuditStore` — see §9.2 decision 3; this very test is exactly the place that verifies whether "sharing one file" works or not). ① after `startRun`, `workflow_runs` has one row with `status: "running"`; ② after a G1 approve, `approvals` gains one new row with `gate_type: "G1_SEND_TO_TESTER"`; ③ after hitting the threshold triggers escalation, `workflow_runs.status` changes (exact value to be decided per the `[?]` flagged in the `runner.ts` task description above); ④ when `coderOutput.claims` is non-empty, `structured_claims` gets inserted with a matching number of rows, `actor: "coder"`, `model_used`/`provider_used` aligned with `coderResult.model`/`.provider`.
4. **checkpoint cross-process productionization** (new `docs/feature/a4b-loop/spike/` with two small scripts, or directly a `src/loop/__tests__/cross-process-resume.test.ts` using Node's `child_process.spawnSync` to run two inline scripts — **whether it's "new script files" or "test inline-spawns a script string" is decided at build time, doesn't affect the acceptance criteria**): ① process A (via `runner.startRun`) runs to some gate, interrupts, `process.exit(0)`; ② process B starts completely independently, given only `dbPath` (for `AuditStore`) + `runId`, first calls `audit.getRunById(runId)` to get `langgraphThreadId`, then constructs a brand-new `checkpointer` (pointing at the same db file) + a brand-new compiled graph, `resumeRun` resumes through to completion; ③ assert process B's final `workflow_runs.status` is `"completed"`. This test **replaces** (not adds to) A4a `checkpoint.test.ts`'s same-process two-phase approach as the way to verify this specific claim of "cross-process" — that A4a test itself is unchanged and stays in place testing "`checkpoint.ts` this thin wrapper itself"'s non-closure state; this new A4b test tests whether the business-layer lookup logic wired by `runner.ts`/`audit-store.ts` also holds under cross-process semantics — the two tests' concerns don't overlap, rationale in §9.2 decision 4.
5. **Hard vertical slice** (appended as a new `it`/`describe` block in `src/loop.e2e.test.ts`, not a new file — continuing A4a's existing file location): see the "deliberately hit the threshold→escalation→force pass→apply" path described under §2's Goals, reusing the Context/Prompt/adapter fixture setup logic A4a's e2e already built, **adding** a new tester fixture scenario that returns `verdict: "reject"` consecutively (following the A3 fixture convention of "add a case, don't duplicate a new file"). Assertions: ① `workflow_runs`'s final `status: "completed"`, `reject_count` equals the number of rejections before reaching escalation; ② `approvals` has one row with `gate_type: "ESCALATION_ACK"`, `decision: "force_pass"`; ③ `structured_claims`'s row count equals the total claims produced by coder+tester across all rounds.

## 6. Batch Breakdown

> Sizing units follow the same scale as the A0-A4a PRDs: `[S]` ≈ 2-4h, `[M]` ≈ half a day to a day, `[L]` ≈ 1-2 days. Single branch `feature/issue-13-a4b-loop`, committed in the order below (rationale same as A0-A4a).

| Batch | Content | Depends on | Size |
|---|---|---|---|
| **B0** | `types.ts`/`workflow-def.ts`/`errors.ts` changes (all §4.1 field/type changes + `LOOP_NODES`/`GATE_TYPES` expansion + `AuditReadError`) | none (starting point, on top of A4a HEAD) | [S] |
| **B1** | `src/loop/escalation.ts` + `gates.ts`'s two routing changes (`routeAfterReview`/`routeAfterG2`) | B0 | [M] |
| **B2** | `graph.ts` wiring (escalation/cancel nodes+edges) + `graph.test.ts` new test cases (all 6 branches from §5 test point 1) | B1 | [M] |
| **B3** | `src/loop/audit-store.ts` + unit tests (§5 test point 2) | B0 (only needs the types, not the graph changes) | [M] |
| **B4** | `src/loop/runner.ts` + unit tests (§5 test point 3) — the highest-integration-complexity batch of this increment, connects B2's graph changes with B3's store | B2+B3 | [L] |
| **B5** | checkpoint cross-process productionization test (§5 test point 4, real `child_process`) | B4 | [M] |
| **B6** | Hard vertical slice (`src/loop.e2e.test.ts` appended with the threshold path, §5 test point 5) + new tester fixture scenario | B4 (not strictly dependent on B5, but recommended to do after B5, so problems found during cross-process verification can be shared) | [L] |
| **B7** | Documentation write-back (`docs/ROADMAP.md` checks off A4b, `docs/PROGRESS.md` cleared, `CHANGELOG.md` gets a line, root `CLAUDE.md` updated, `CHARTS/knowledge/aeloop.md` (ai-agent repo) gets new/updated entries for the three modules `escalation.ts`/`audit-store.ts`/`runner.ts` + updates existing Loop-layer entries that say "A4b to come") | B6 | [S] |

**Dependency graph notes**: B1 (escalation+routing) and B3 (audit store) are independent of each other (B1 only depends on B0's types, B3 also only depends on B0's types) — in principle they could be parallelized, but since the same Cypher implements them sequentially, they aren't split into separate branches for that reason alone; however, if the Commander wants to review in phases, B0-B3 (types+graph branches+audit tables, mutually independent mechanical units) / B4-B5 (runner integration+cross-process, the risk core) / B6-B7 (vertical slice+docs) are natural break points, following the same idea as A4a PRD §7's phased-review suggestion.

**Overall size estimate**: compared against A4a's actual delivered volume (7 batches, 254 tests), A4b's new/changed file count is similar but the integration complexity is higher (`runner.ts` is a new architectural layer unique to this increment, with no A4a counterpart) — rough estimate is that the total effort is comparable to or slightly more than A4a, not "a small tail end of A4a."

## 7. Branching Strategy

Single branch `feature/issue-13-a4b-loop` (cut from main `c6589b7`, right after A4a merged), batches committed in the order of §6, rationale same as A4a.

## 8. Testable Acceptance Criteria (checkable)

- [x] `pnpm build` succeeds (tsc strict + `noUncheckedIndexedAccess`, no errors), `pnpm lint` likewise clean.
- [x] `pnpm test` fully green (276/276), all new A4b test files counted in; `grep` confirms zero real network/real CLI calls (same check technique already used by A3/A4a; the only new real `spawn` is `cross-process-resume.test.ts` spawning this repo's own `.mjs` fixture, not an external CLI/network call).
- [x] **Threshold genuinely triggers escalation**: `graph.test.ts` adds a "reject_count reaching rejectThreshold routes to escalation, not g2; below threshold still routes to g2" test, both boundaries tested and both genuinely walk a real graph.
- [x] **All three Escalation decisions have routing + test coverage**: `graph.test.ts` has three independent tests each driving `revise→draft`/`force_pass→g3`/`abandon→cancel`.
- [x] **G2's active-escalation branch genuinely exists**: `graph.test.ts`'s "G2 receiving 'escalate'...routes to escalation, not draft" test drives a real graph; `UnhandledGateDecisionError` continues to only apply to values other than `approved`/`escalate` (existing test unchanged, `escalate` is a newly added legal branch, not a newly added exception).
- [x] **The three audit tables are genuinely created + genuinely written to**: `audit-store.test.ts` (9 cases) proves schema+field alignment with §4.2; `runner.test.ts`/`loop.e2e.test.ts` prove that real graph execution's `gateLog`/claims land in `approvals`/`structured_claims`, and `workflow_runs`'s `reject_count`/`current_state`/`status` genuinely refresh with every `resumeRun()` call.
- [x] **checkpoint cross-process productionization for real**: `cross-process-resume.test.ts` uses two genuinely independent `node` processes (`spawnSync`, pids asserted different), process B looking up `langgraph_thread_id` and resuming through to completion given only `dbPath`+`runId` — the two fixture scripts import the compiled `dist/` (not `src/`, since plain Node has no `.ts`→`.js` resolution mapping; the test's `beforeAll` runs `pnpm build` first).
- [x] **Vertical slice must connect end to end (including escalation)**: `loop.e2e.test.ts`'s new scenario walks the full chain "real Context→Prompt→cli-bridge fixture (`fake-codex.fixture.mjs` gets a new `tester-reject` scenario)→real ProviderRouter→real graph (via `runner.startRun`/`resumeRun`, not direct `invoke`)→real checkpointer→real AuditStore→threshold 2→escalation→force_pass→G3→apply," all three tables queryable afterward (using a real `rejectThreshold: 2`, incidentally passing through the normal G2 path along the way, not simplified down to the shortest threshold=1 path).
- [x] **Graph nodes/gates continue to hold zero-I/O purity**: `grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` zero hits, verified.
- [x] **No reverse cross-layer dependencies continue to hold** (⚠️ see one spot in the handoff note the Commander/Helix needs to know about a check-wording gap): `grep -rln "from.*loop" src/harness src/context src/prompt` zero hits; `grep -n "from \"\.\./\.\./context\|from \"\.\./context" src/loop/audit-store.ts` alone, zero hits (§9.2 decision 1's actual claim). This line literally also lists `runner.ts` under the same grep, but `runner.ts`, per §5's own `startRun()` signature requirement, does a type-only import of `ContextInjectionResult` (`../context/injector.js`) — consistent with the existing A4a precedent already in `types.ts` (Loop→Context is a direction the nested architecture allows; what §9.2 decision 1 objects to is "reusing the `MemoryStore` implementation," not "never touching any type in `context/` at all"). This is judged to be no substantive violation of the cross-layer direction; the wording of this §8 grep line is broader than the actual claim in §5/§9.2 decision 1, and the more specific clause governs.
- [x] `docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/root `CLAUDE.md`/`CHARTS/knowledge/aeloop.md` (ai-agent repo) written back per §6 B7; also, per the assignment instructions, incidentally correct `docs/DESIGN.md` §1.5's ruflo wording (this one spot only, scope already verified via diff).

## 9. Dependencies / Risks / Open Questions

### 9.1 Issue #13's closed state (see §0.1)

Already detailed in §0.1 — needs the Commander/Helix to decide first between "reopen #13" vs. "open a separate new issue"; this PRD is written for now under the assumption of "continue with #13, pending reopen."

### 9.2 Six design decisions — please confirm each one (per the four questions the assignment instructions asked to expand on, plus two more I found I had to settle along the way)

**1. Layer ownership of audit-table writes: `AuditStore` is Loop's own independent SQLite store, and does not import/reuse the `MemoryStore` class from `context/store.ts`.**
Rationale: DESIGN §1.5's nested model (`Prompt ⊂ Context ⊂ Harness ⊂ Loop`) means Loop is allowed to use Context (directionally, this doesn't violate "inner layers don't know about outer layers") — but "allowed to depend on" isn't the same as "should depend on." Semantically, `workflow_runs`/`structured_claims`/`approvals` are Loop's own operational ledger (`reject_count`/`current_state`/`langgraph_thread_id` are all Loop-domain concepts), with no overlap with Context's concern of "what memory does the model see"; `MemoryStore`'s own method set (`insertMemory`/`searchMemories`/FTS5-related) is also nothing Loop needs at all. Forcibly reusing `MemoryStore` just to "save effort" would come at the cost of coupling Loop's audit persistence to the internal implementation details of a class designed for a different domain (e.g. its `createSchema()` private method would incidentally also create the three tables `memories`/`memory_confirmations`/`system_config`, which have nothing to do with Loop). `AuditStore` is `MemoryStore`'s **structural sibling** (same `better-sqlite3` + prepared-statement + error-classification convention), not its subclass/wrapper. **The cost of this choice**: two nearly identical bits of "open connection → create tables → prepare statements" boilerplate, a minor duplication — but I believe this cost is smaller than the cost of having Loop reverse-couple to a Context class's internal implementation. `[?]` If the Commander thinks "reuse" matters more (e.g. genuinely wanting memories and audit tables managed inside the same future `MemoryStore` instance), please flag it — this is one that can be reversed and redone.

**2. Priority order for the source of `reject_threshold`: `profiles/subscription/config.yaml`'s `workflow.reject_threshold` takes priority; if missing, fall back to `system_config.default_reject_threshold` (already built by A2's `SystemConfig.getDefaultRejectThreshold()`, currently no consumer); if both are missing, hardcode a fallback of `2`.**
Fact verified: the code **already has two** things related to reject threshold that are mutually independent and neither of which anyone reads — ① `ProfileConfig.workflow?.reject_threshold` parsed by `profile/loader.ts` (the one the assignment instructions literally point at); ② `context/config.ts`'s `SystemConfig.getDefaultRejectThreshold()`, reading the `default_reject_threshold` key of the `system_config` table, whose comment explicitly says "reserved for the Loop layer's escalation threshold — not read by anything in this increment, exposed here for A4 to reuse" — this is a hook A1/A2's author (also a historical Cypher) deliberately left for A4. **My judgment**: `config.yaml`'s value represents "the threshold this profile wants for this deployment" (deploy-time config; `workflow_runs.reject_threshold`'s "snapshot for this run" comment hints this value ought to be pinned once when the run starts), while `system_config`'s value represents "the engine-level default fallback" (runtime-changeable via a future CLI command, no redeploy needed) — the two are not mutually exclusive, but a standard configuration-layering pattern of "the more specific one overrides the more general one." `startRun()`'s caller (test / future CLI) is responsible for computing the final number passed as `LoopState.rejectThreshold` per this priority; `runner.ts` itself does not do this priority computation (it only receives an already-computed `rejectThreshold: number` parameter — keeping the same "injected from outside the graph" standing as `injectedContext`). `[?]` This judgment needs Commander confirmation — if the Commander thinks that `system_config` hook shouldn't be used by A4b at all (e.g. it's actually meant for something else), please flag it, and A4b will then only read `config.yaml`, leaving `system_config` still hanging there unused.

**3. The three audit tables and the checkpoint tables share the same SQLite file (recommended, not mandatory wiring in this increment, just verified in tests as "can it be done"): `AuditStore`/`checkpoint.ts` both accept an explicit `dbPath`, no automatic path resolution; but `runner.test.ts`/the cross-process test/the vertical-slice test should point both at the same temp file path, verifying that DESIGN §5's literal intent of "single SQLite file" holds up technically.**
Rationale: in DESIGN §6's target directory tree, `profiles/subscription/` **lists only one** `memory.db` file (not three files `memory.db` + `checkpoint.db` + `audit.db`) — direct evidence of the intent "one profile, one file holding everything." Multiple independent connections from `better-sqlite3` to the same file (in WAL mode) is a standard supported scenario; `SqliteSaver.setup()` switches the file to WAL mode, and `AuditStore`/`MemoryStore`'s respective connections should work fine on the same WAL file without extra configuration — but this is my technical judgment, not an already-verified fact (A4a's spike never tested the specific scenario of "two separate `better-sqlite3.Database` connections to the same file, one creating LangGraph's `checkpoints`/`writes` tables, the other creating the business tables"), so this PRD designs "sharing one file" as an assertion **verified incidentally** in the B4/B6 tests, rather than standing up a dedicated spike phase for it — if a real problem is hit (e.g. lock contention causing a write to time out), it'll be resolved in-place within the batch (falling back to "separate independent files" wouldn't be a big change either, since `dbPath` is already passed in independently for each — there's no hardcoded coupling). `MemoryStore` (the context layer) is **not** in scope for this file-sharing discussion at all — A4b doesn't touch it; what's being shared is the checkpoint file and the audit file, and whether `MemoryStore` also joins that sharing is left to a future "profile wiring" increment to decide.

**4. Checkpoint cross-process acceptance upgraded to real child processes (no longer A4a's same-process two-phase approach).**
A4a PRD §9.1 explicitly said "if the Commander thinks 'an external new call' must literally be a new `node` process to count, just say so and I'll redo it per spike Q4's pattern" — this time the assignment instructions explicitly named this "productionization," which I understand to be that "just say so." Additional rationale: in the A4a phase, "same-process two-phase" tested whether `checkpoint.ts`/`graph.ts` accidentally introduced an in-process singleton — that concern still holds in A4b, and that A4a test stays in place, unmodified; but the `runner.ts`/`audit-store.ts` newly introduced in A4b bring in an entire new layer of "how does the business layer find a run again" logic (queries like `getRunByThreadId`), and only a genuine cross-process test can catch whether this layer secretly depends on in-process state (e.g. a module-level cache) — continuing to test with same-process two-phase can't catch this class of problem, so the cost of investing in child-process test infrastructure is worth paying in A4b, and this doesn't conflict with A4a's conclusion that "this cost isn't worth the benefit" at that stage (the scope changed, the judgment didn't flip-flop).

**5. In `approvals.decision`, `ESCALATION_ACK` rows store the literal `EscalationDecision` value directly (`"revise"`/`"force_pass"`/`"abandon"`), without forcibly mapping onto the three words "approved/rejected/override" written in DESIGN §5's comment.**
DESIGN §5's comment line ("decision: approved/rejected/override") was very likely written before the designer had fully thought through `HD`'s three outgoing edges (the word "override" has already been interpreted, in the A4a PRD, as "serving only threshold escalation" — but the escalation `HD` decision actually has three kinds, not one). The ER diagram's `approvals.decision` is just a `TEXT` column, with no SQL `CHECK` constraint drawn — it's not a hard boundary that must land exactly on one of three preset values. I believe honestly storing the literal semantic values (`revise`/`force_pass`/`abandon`) is better than forcibly squeezing three kinds of semantics into three words (`approved`/`rejected`/`override`) that risk being misread — but this **is explicitly my own reinterpretation of a piece of DESIGN wording**, not an established conclusion I've verified; flagging it for Commander confirmation on whether it matches the original intent — if the Commander insists on using the three words `approved`/`rejected`/`override`, I need a concrete mapping rule (e.g. "force_pass→override, revise→rejected, abandon→?") — I can't currently come up with a reasonable mapping for the third word, which is also part of why I lean toward "don't force the mapping."

**6. For the step of checking the `rejectCount` threshold, don't change `nodes/tester.ts`, only change `gates.ts`'s `routeAfterReview`.**
This isn't a controversial judgment call — it's written here to explicitly verify an easily-misunderstood LangGraph execution-order fact: A4a's `nodes/tester.ts` already computes `rejectCount` in the `review` node's own return value (`data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount`); LangGraph's execution model is "a node function returns `Partial<State>` → merged into the graph's state → *then* that node's outgoing edges (including `addConditionalEdges`'s routing function) are evaluated," not "route first, then merge" — so by the time `routeAfterReview` is called, the `state.rejectCount` it reads **is already** this round's post-rejection new value; `routeAfterReview` doesn't need to `+1` itself or rely on some "previous round's" stale value. This isn't something I made up — it's LangGraph `StateGraph`'s standard execution semantics (the combination of `addNode`→`addConditionalEdges` just works this way; A4a's existing `graph.test.ts` cases — e.g. the "tester rejects once, then G2 approves" one — have already indirectly verified this order, just that A4a never had a test specifically asserting "does the routing function read the latest value" as its own claim). It's written out here so that "why `tester.ts` doesn't need changing" has documented grounds — it's not left open for the Commander to choose.

### 9.3 The precise TS type wording for `EscalationResumeValue`/`GateLogEntry.decision` — not within the scope of precise up-front definition

Same nature as A4a §9.3: whether the generic annotation on `interrupt<GatePayload, EscalationResumeValue>()`, and the union type `GateLogEntry.decision: GateDecision | EscalationDecision`, will need extra type-narrowing under real `tsc --strict` — this is not within this PRD's scope of precise up-front definition; to be adjusted at build time on first contact, per whatever the actual error turns out to be; doesn't affect the field semantics described in this section.

---

**One thing needs the Commander/Helix to decide right now, and it will block starting work**: §0.1's issue #13 closed state — continue using it and `gh issue reopen 13` first, or open a new issue instead. Other than that, the 6 design decisions rounded up in §9.2 each already have a leaning conclusion with rationale written out in this PRD, and work can start against those conclusions; if the Commander/Helix disagrees with any one of them, feel free to interrupt and correct at any time — there's no need to wait for all of them to be confirmed before B0 can start.

## 10. Project Constraint Checklist

- **Model-agnostic?** Yes — none of the files added/changed in this increment (`escalation.ts`/`audit-store.ts`/`runner.ts`/`gates.ts`/`graph.ts`) reference any specific provider/model name; `runner.ts` reaches model calls indirectly via `LoopGraphDeps` (`router`/`composer`), consistent with the boundary already established in A4a.
- **No reverse cross-layer dependencies?** Yes — other than importing each other within Loop-layer internal files, `audit-store.ts`/`runner.ts` only import `better-sqlite3` (the same third-party library used by `harness/`/`context/`/`prompt/`, not importing each other's modules) and `node:crypto`; types from `harness/types.ts`/`prompt/schema.ts` (`InvokeResult`/`Claim` etc.) continue to be type-only imports. There is no case of `src/harness/`/`src/context/`/`src/prompt/` importing `src/loop/` in reverse (§8's acceptance criteria already list the grep check for this).
- **No hardcoded roles?** Partially — same conclusion as A4a §10: the strings `"coder"`/`"tester"` continue to be hardcoded in places like `structured_claims.actor`; this is a different matter from whether the mechanism for looking up personas/schemas dynamically by name is itself hardcoded ("this workflow's specific nodes/fields naturally mention these two role names" vs. "does the lookup mechanism itself do dynamic lookup by name") — the latter (answer remains "doesn't need to change") is unaffected by this increment.
- **`profiles/apikey/` stays out of the repo?** Yes — this increment doesn't create/modify any file under `profiles/apikey/`.
- **Engine code contains no Helix persona?** Yes — none of the new code under `src/loop/` contains any Helix/companion/private-memory content.
- **Remote ignition (the `CLAUDE.md` iron rule)?** Yes — all of §5's test strategy runs on toy nodes/`FakeAdapter`/controlled fixture child processes/real-but-offline SQLite files; the only newly added "real subprocess" test (§5 test point 4) spawns **this repo's own test scripts** (node calling its own code), not the real `claude`/`codex` CLI, and makes no calls to any external service — same nature as A4a spike Q4.
