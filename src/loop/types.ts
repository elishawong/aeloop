/**
 * Core types for the Loop layer (src/loop/*), docs/DESIGN.md §4 (state
 * machine) / §5 (`LoopState` field-by-field rationale, `approvals` table
 * alignment) + PRD §4/§5 (docs/feature/a4a-loop/PRD.md). This file is the
 * contract every other `src/loop/*.ts` file is written against — same role
 * `harness/types.ts` plays for `src/harness/*`.
 *
 * `LoopNodeName` is the **only** place this module defines the graph's node
 * name literal union — `graph.ts`/`gates.ts` import it as the third generic
 * argument to `new Command<...>({resume: ...})` (spike-findings.md Q5's
 * `Command`-generic-defaults-to-`string` pitfall), never re-declaring the
 * union themselves.
 */

import { Annotation } from "@langchain/langgraph";
import type { ContextInjectionResult } from "../context/injector.js";
import type { InvokeResult } from "../harness/types.js";
import type { CoderOutput, TesterOutput } from "../prompt/schema.js";
import { GATE_TYPES, LOOP_NODES } from "./workflow-def.js";

/**
 * Every node name `graph.ts` can `addNode`/route to, plus LangGraph's own
 * `"__start__"`/`"__end__"` sentinels (spike Q5's `Command` example
 * included `"__start__"` in its `Nodes` union; whether `"__end__"` also
 * needs to be in it wasn't exercised by the spike — included here for
 * safety, `tsc` will say if it's unnecessary).
 */
export type LoopNodeName = (typeof LOOP_NODES)[keyof typeof LOOP_NODES] | "__start__" | "__end__";

/** DESIGN §5 `approvals.gate_type` A4a subset (PRD §5 types.ts). */
export type GateType = (typeof GATE_TYPES)[keyof typeof GATE_TYPES];

/** DESIGN §5 `approvals.decision` A4a subset — excludes `"override"`, which only makes sense once A4b's Escalation subtree exists (PRD §2 non-goal #2). */
export type GateDecision = "approved" | "rejected";

/**
 * The payload a gate node hands to `interrupt()` — what the human/caller
 * sees while the graph is paused (PRD §5 types.ts). `diffRef` is named to
 * mirror DESIGN §5's `approvals.diff_ref` column, but in A4a it always
 * holds the diff text inline, not a hash/path — PRD §5/§9.2#2 explicitly
 * decided against adding that indirection this early (nothing in A4a needs
 * to carry a diff across a process boundary).
 */
export interface GatePayload {
  gate: GateType;
  question: string;
  diffRef?: string;
  issues?: string[];
}

/** The shape of `Command({resume: ...})`'s `resume` value for a Loop gate (PRD §5 types.ts). */
export interface GateResumeValue {
  decision: GateDecision;
  reasoningText?: string;
}

/**
 * One entry in `LoopState.gateLog` — the in-memory shadow of what A4b's
 * `approvals` table row for this gate decision will eventually look like
 * (PRD §4). Field names deliberately mirror `approvals`' columns
 * (`gate_type`/`decision`/`reasoning_text`/`decided_at`) so A4b can persist
 * `state.gateLog` entries with minimal reshaping. **Not** "in-memory only,
 * gone on process exit" — `gateLog` is a `LoopState` Annotation channel, so
 * a real `SqliteSaver`-backed graph checkpoints the *whole* state (gateLog
 * included) to LangGraph's own `checkpoints`/`writes` tables on every step
 * (`checkpoint.test.ts`'s two-phase resume proves the *whole state* survives
 * across instances, but its interrupt point is the still-undecided G1 gate,
 * where `gateLog` is still `[]` — it never asserts on `gateLog`'s actual
 * contents; that real content-survives-a-checkpoint evidence is
 * `loop.e2e.test.ts`'s final `gateLog` entries assertions). The real A4a/A4b
 * boundary is narrower: A4a never writes `gateLog` entries into A4b's
 * business-audit `approvals` table (PRD §4/§9.2#3) — LangGraph's own
 * checkpoint persistence and aeloop's own `approvals` persistence are two
 * separate things, and only the latter is A4b's job.
 *
 * Constructed **after** `interrupt()` returns, never before (PRD §5 gates.ts
 * / spike-findings.md Q3's "resume reruns everything before interrupt()"
 * finding) — building this eagerly would duplicate/corrupt the log on
 * every resume.
 */
export interface GateLogEntry {
  gate: GateType;
  decision: GateDecision;
  reasoningText?: string;
  decidedAt: string;
}

/**
 * LangGraph `Annotation.Root` state shape for the A4a coder/tester loop
 * (PRD §4). Every field's semantics/existence is a PRD-level constraint —
 * see PRD §4 for the full per-field rationale (this file's comments only
 * summarize; the PRD is the source of truth for *why*).
 *
 * `injectedContext` is populated **once, outside the graph**, by whoever
 * calls `compiled.invoke()` the first time (PRD §4/§5's "为什么不在节点里
 * 重复调用 ContextInjector" — `nodes/coder.ts`/`nodes/tester.ts` only ever
 * import `ContextInjectionResult`'s *type*, never the `ContextInjector`
 * class itself, so this layer has no reverse dependency on `context/`'s
 * implementation).
 */
export const LoopState = Annotation.Root({
  /** Original task description; unchanged for the whole run. */
  task: Annotation<string>(),
  /**
   * Feedback the next `draft` node invocation should see (G1 rejection
   * reason / G2-approved tester issues / G3 rejection reason). Cleared by
   * `nodes/coder.ts` once consumed — never accumulates across rounds.
   */
  feedback: Annotation<string | undefined>(),
  /** `ContextInjector.inject()`'s result, injected once outside the graph; unchanged for the whole run. */
  injectedContext: Annotation<ContextInjectionResult>(),
  coderOutput: Annotation<CoderOutput | undefined>(),
  coderResult: Annotation<InvokeResult | undefined>(),
  testerOutput: Annotation<TesterOutput | undefined>(),
  testerResult: Annotation<InvokeResult | undefined>(),
  /** Incremented on every `review` verdict `"reject"` (PRD §0/§4's "Inc" step) — A4a has no code that reads this to make a routing decision (that's A4b's threshold escalation). */
  rejectCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }),
  g1Decision: Annotation<GateDecision | undefined>(),
  g2Decision: Annotation<GateDecision | undefined>(),
  g3Decision: Annotation<GateDecision | undefined>(),
  /** Accumulates across the whole run — every gate decision appends, never overwrites (PRD §4). */
  gateLog: Annotation<GateLogEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  applied: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});

/**
 * The TS type nodes/gates/routers actually read/write — `typeof
 * LoopState.State` (spike Q5's `q5-types.ts` used the equivalent `typeof
 * State.State` pattern; A4a's own node functions, unlike the spike's inline
 * closures, need this exported so `nodes/coder.ts`/`gates.ts` can declare
 * standalone, independently-testable function signatures against it — a
 * usage the 5 spike Qs never exercised, PRD §5/§9.3 flags this as the one
 * TS-typing detail build has to work out fresh).
 */
export type LoopStateType = typeof LoopState.State;
