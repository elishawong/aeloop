/**
 * G1/G2/G3 gate node factories + their `addConditionalEdges` router
 * functions (PRD §5 "gates.ts", DESIGN §4). Shared `createGateNode()`
 * internal factory implements the `interrupt()`/`Command({resume})` pattern
 * spike-findings.md Q3 verified, applied three times.
 *
 * **The one hard rule every gate node here obeys** (spike-findings.md Q3's
 * "⚠️ 一个不算 bug 但影响写 nodes/ 代码的行为"): resume re-runs the entire
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
 * factory itself never guesses this from `gate` (PRD §5: "由调用
 * createGateNode 的三个具体门各自指定,不是这个共享工厂自己猜"); it's an
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
 * `default: throw` branches are a defensive runtime backstop for a case
 * the type system has already ruled out (`GateDecision` only has two
 * values) — not silent, per PRD §5, but a plain `Error`, distinct from
 * `routeAfterG2`'s `UnhandledGateDecisionError`, which encodes a real,
 * documented A4a design decision (PRD §2 non-goal #2), not just an
 * unreachable-case guard.
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

export function routeAfterReview(state: LoopStateType): "g3" | "g2" {
  if (!state.testerOutput) {
    throw new Error("routeAfterReview called without a testerOutput in state");
  }
  return state.testerOutput.verdict === "pass" ? "g3" : "g2";
}

/**
 * A4a's G2 has exactly one routing target: `"approved" -> "draft"`. Any
 * other decision (most notably `"rejected"`, which DESIGN's G2 gate draws
 * no edge for) throws `UnhandledGateDecisionError` — PRD §2 non-goal #2's
 * explicit, documented decision, not an oversight.
 */
export function routeAfterG2(state: LoopStateType): "draft" {
  if (state.g2Decision === "approved") return "draft";
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
