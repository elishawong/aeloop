/**
 * `createEscalationNode()`/`routeAfterEscalation()` — the Escalation gate
 * (DESIGN §4's `Esc`/`HD` nodes, A4b PRD §5 "escalation.ts"). Structurally
 * **parallel** to `gates.ts`'s `createGateNode()` factory, not built on top
 * of it — the Escalation gate's resume value is `EscalationResumeValue`
 * (`EscalationDecision`: `"revise" | "force_pass" | "abandon"`), a
 * *disjoint* domain from `GateResumeValue` (`GateDecision`:
 * `"approved" | "rejected" | "escalate"`, as of A4b — see gates.ts's
 * routers' header comment, Review Round-1 M3) that `createGateNode()`'s
 * type signature assumes, and it writes back a single `escalationDecision`
 * field rather than choosing among `g1Decision`/`g2Decision`/`g3Decision`
 * via `createGateNode()`'s `decisionField` switch. Generalizing the shared
 * factory to cover both shapes would either weaken its `Partial<LoopStateType>`
 * return-type precision (the switch-not-computed-key trick `gates.ts`'s
 * header explains) or touch `gates.ts`'s already-tested G1/G2/G3 logic for
 * no real gain — PRD §5's explicit call, not an oversight.
 *
 * Same hard rule as every gate node in `gates.ts` (spike-findings.md Q3):
 * resume re-runs the whole node body, including everything before
 * `interrupt()`. `buildPayload` below is therefore a pure function of
 * `state`; the `GateLogEntry` is only constructed *after* `interrupt()`
 * returns.
 */

import { interrupt } from "@langchain/langgraph";
import { GATE_TYPES } from "./workflow-def.js";
import { isCoderOutputChanged } from "../prompt/schema.js";
import type { EscalationResumeValue, GateLogEntry, GatePayload, LoopStateType } from "./types.js";

/**
 * The Escalation gate node (DESIGN §4's `Esc` → human `HD` decision).
 * `feedback` is only populated for `"revise"` — `"force_pass"`/`"abandon"`
 * don't route back to `draft`, so there's no next `draft` round for a
 * feedback string to reach (mirrors `createG2Node()`'s feedback-derivation
 * shape: tester issues + optional human reasoning text, same "issues list
 * first, human text supplements" convention).
 */
export function createEscalationNode(): (state: LoopStateType) => Partial<LoopStateType> {
  return (state) => {
    // Pure, re-runs safely on resume — no side effects before interrupt().
    const payload: GatePayload = {
      gate: GATE_TYPES.ESCALATION_ACK,
      question: "reject_count reached the threshold — revise / force-pass / abandon?",
      ...(state.coderOutput && isCoderOutputChanged(state.coderOutput) ? { diffRef: state.coderOutput.diff } : {}),
      ...(state.testerOutput?.issues !== undefined ? { issues: state.testerOutput.issues } : {}),
    };

    const resume = interrupt<GatePayload, EscalationResumeValue>(payload);

    // Only safe to construct here, after interrupt() has actually returned
    // a real resume value (spike-findings.md Q3).
    const entry: GateLogEntry = {
      gate: GATE_TYPES.ESCALATION_ACK,
      decision: resume.decision,
      decidedAt: new Date().toISOString(),
      ...(resume.reasoningText !== undefined ? { reasoningText: resume.reasoningText } : {}),
    };

    const feedback =
      resume.decision === "revise"
        ? [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n")
        : undefined; // force_pass/abandon don't route back to draft, no next round to see feedback.

    return { escalationDecision: resume.decision, feedback, gateLog: [entry] };
  };
}

/**
 * DESIGN §4's `HD` node's three out-edges, verbatim. Any other value
 * (unreachable per `EscalationDecision`'s closed union, same defensive
 * backstop posture as `routeAfterG1`/`routeAfterG3`'s `default: throw`
 * branches — not `UnhandledGateDecisionError`, which is reserved for a
 * real, documented "this gate doesn't handle this decision" case, not an
 * unreachable-case guard).
 */
export function routeAfterEscalation(state: LoopStateType): "draft" | "g3" | "cancel" {
  switch (state.escalationDecision) {
    case "revise":
      return "draft";
    case "force_pass":
      return "g3";
    case "abandon":
      return "cancel";
    default:
      throw new Error(`routeAfterEscalation: unexpected escalationDecision ${JSON.stringify(state.escalationDecision)}`);
  }
}
