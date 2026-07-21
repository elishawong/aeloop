/**
 * G1/G2/G3 gate node factories + their `addConditionalEdges` router
 * functions (PRD §5 "gates.ts", DESIGN §4). Shared `createGateNode()`
 * internal factory implements the `interrupt()`/`Command({resume})` pattern
 * spike-findings.md Q3 verified, applied three times.
 *
 * **The one hard rule every gate node here obeys** (spike-findings.md Q3's
 * "⚠️ not a bug, but a behavior that affects how nodes/ code is written"): resume re-runs the entire
 * node body from the top, including everything *before* `interrupt()`. So
 * `buildPayload()` — called before `interrupt()` — must be a pure function
 * of `state` with no side effects; only after `interrupt()` returns is it
 * safe to build the `GateLogEntry` (a `new Date().toISOString()` call and
 * an array push are exactly the kind of non-idempotent operation that would
 * double-record if it ran before the interrupt point).
 */

import { interrupt } from "@langchain/langgraph";
import { GATE_TYPES } from "./workflow-def.js";
import { UnhandledGateDecisionError } from "./errors.js";
import type { GateLogEntry, GatePayload, GateResumeValue, GateType, LoopStateType } from "./types.js";

type GateDecisionField = "g1Decision" | "g2Decision" | "g3Decision";

/**
 * Shared node body for all three gates. `decisionField` says which of
 * `LoopState`'s three per-gate decision fields this gate writes — the
 * factory itself never guesses this from `gate` (PRD §5: "specified by
 * each of the three concrete gates that call createGateNode, not guessed
 * by this shared factory itself"); it's an
 * explicit parameter, resolved below via a plain switch rather than a
 * computed property key, so the returned `Partial<LoopStateType>` stays
 * precisely typed (a computed key typed from a 3-way string-literal union
 * would make TypeScript believe all three decision fields are always set,
 * which isn't true at runtime).
 */
function createGateNode(
  gate: GateType,
  decisionField: GateDecisionField,
  buildPayload: (state: LoopStateType) => Omit<GatePayload, "gate">,
  deriveFeedback: (state: LoopStateType, resume: GateResumeValue) => string | undefined,
): (state: LoopStateType) => Partial<LoopStateType> {
  return (state) => {
    // Pure, re-runs safely on resume — no side effects before interrupt().
    const payload: GatePayload = { gate, ...buildPayload(state) };

    const resume = interrupt<GatePayload, GateResumeValue>(payload);

    // Only safe to construct here, after interrupt() has actually returned
    // a real resume value (spike-findings.md Q3).
    const entry: GateLogEntry = {
      gate,
      decision: resume.decision,
      decidedAt: new Date().toISOString(),
      ...(resume.reasoningText !== undefined ? { reasoningText: resume.reasoningText } : {}),
    };

    const feedback = deriveFeedback(state, resume);
    const decisionUpdate: Partial<LoopStateType> =
      decisionField === "g1Decision"
        ? { g1Decision: resume.decision }
        : decisionField === "g2Decision"
          ? { g2Decision: resume.decision }
          : { g3Decision: resume.decision };

    return { ...decisionUpdate, feedback, gateLog: [entry] };
  };
}

/** G1: approve sending the coder's diff to the tester (DESIGN §4's `Draft -> G1 -> Review`). Rejection feedback is just whatever the human typed — there's no more context to add. */
export function createG1Node(): (state: LoopStateType) => Partial<LoopStateType> {
  return createGateNode(
    GATE_TYPES.G1_SEND_TO_TESTER,
    "g1Decision",
    (state) => ({
      question: "approve sending this diff to the tester?",
      ...(state.coderOutput?.diff !== undefined ? { diffRef: state.coderOutput.diff } : {}),
    }),
    (_state, resume) => resume.reasoningText,
  );
}

/** G2: approve sending the tester's findings back to the coder for a fix (DESIGN §4's `Review(reject) -> G2 -> Fix`). Feedback is *mainly* the tester's own issues list — resume's `reasoningText` is a supplement, not a replacement (PRD §5: without the issues list, the coder never actually sees what the tester found). */
export function createG2Node(): (state: LoopStateType) => Partial<LoopStateType> {
  return createGateNode(
    GATE_TYPES.G2_SEND_TO_FIX,
    "g2Decision",
    (state) => ({
      question: "approve sending the tester's findings back to the coder for a fix?",
      ...(state.testerOutput?.issues !== undefined ? { issues: state.testerOutput.issues } : {}),
    }),
    (state, resume) =>
      [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n"),
  );
}

/** G3: final sign-off before Apply (DESIGN §4's `Review(pass) -> G3 -> Apply`). */
export function createG3Node(): (state: LoopStateType) => Partial<LoopStateType> {
  return createGateNode(
    GATE_TYPES.G3_FINAL_MERGE,
    "g3Decision",
    (state) => ({
      question: "final sign-off: apply this diff?",
      ...(state.coderOutput?.diff !== undefined ? { diffRef: state.coderOutput.diff } : {}),
    }),
    (_state, resume) => resume.reasoningText,
  );
}

/**
 * Routers below feed `graph.ts`'s `addConditionalEdges` calls. G1/G3's
 * `default: throw` branches are a defensive runtime backstop, **not** a
 * type-system-ruled-out case (Review Round-1 M3,
 * `docs/feature/a4b-loop/test-report.md`: `GateDecision` has *three*
 * values as of A4b — `"approved" | "rejected" | "escalate"` — this
 * comment used to say "only two", which stopped being true the moment
 * `"escalate"` was added). G1/G3 are simply never *supposed* to receive
 * `"escalate"` (only `routeAfterG2`'s "Proactively escalate→Esc" edge ever produces
 * it) — the `default: throw` here is the same runtime backstop it always
 * was, just for a value that's undocumented for these two gates rather
 * than one TypeScript itself excludes. Not silent, per PRD §5, but a
 * plain `Error`, distinct from `routeAfterG2`'s `UnhandledGateDecisionError`,
 * which encodes a real, documented A4a design decision (PRD §2 non-goal
 * #2), not just an unreachable-case guard.
 */
export function routeAfterG1(state: LoopStateType): "review" | "draft" {
  switch (state.g1Decision) {
    case "approved":
      return "review";
    case "rejected":
      return "draft";
    default:
      throw new Error(`routeAfterG1: unexpected g1Decision ${JSON.stringify(state.g1Decision)}`);
  }
}

/**
 * A4b (PRD §5 "gates.ts") adds the threshold branch: a `"reject"` verdict
 * routes to `"escalation"` once `state.rejectCount` has reached
 * `state.rejectThreshold`, `"g2"` otherwise. This reads `rejectCount`
 * *after* `nodes/tester.ts`'s `review` node has already incremented it for
 * this round — LangGraph merges a node's `Partial<State>` return into state
 * before evaluating that node's own conditional-edge router, so
 * `routeAfterReview` never sees a stale, pre-increment value (PRD §9.2
 * Decision 6 spells out why this doesn't require touching `nodes/tester.ts`).
 */
export function routeAfterReview(state: LoopStateType): "g3" | "g2" | "escalation" {
  if (!state.testerOutput) {
    throw new Error("routeAfterReview called without a testerOutput in state");
  }
  if (state.testerOutput.verdict === "pass") return "g3";
  return state.rejectCount >= state.rejectThreshold ? "escalation" : "g2";
}

/**
 * A4a's G2 had exactly one routing target: `"approved" -> "draft"`. A4b
 * (PRD §5 "gates.ts") adds a second, DESIGN §4's `G2-- Proactively escalate -->Esc`
 * edge: `"escalate" -> "escalation"`. Any other decision (most notably
 * `"rejected"`, which DESIGN's G2 gate draws no edge for) still throws
 * `UnhandledGateDecisionError` — PRD §2 non-goal #2's explicit, documented
 * decision, unchanged by A4b.
 */
export function routeAfterG2(state: LoopStateType): "draft" | "escalation" {
  if (state.g2Decision === "approved") return "draft";
  if (state.g2Decision === "escalate") return "escalation";
  throw new UnhandledGateDecisionError(GATE_TYPES.G2_SEND_TO_FIX, state.g2Decision ?? "undefined");
}

export function routeAfterG3(state: LoopStateType): "apply" | "draft" {
  switch (state.g3Decision) {
    case "approved":
      return "apply";
    case "rejected":
      return "draft";
    default:
      throw new Error(`routeAfterG3: unexpected g3Decision ${JSON.stringify(state.g3Decision)}`);
  }
}
