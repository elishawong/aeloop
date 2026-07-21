/**
 * Typed errors for the Loop layer (src/loop/*), mirroring the Harness
 * layer's `harness/errors.ts` convention (typed classes, never a raw
 * generic `Error` for a condition callers need to distinguish).
 */

import type { GateType } from "./types.js";

/**
 * `routeAfterG2` (gates.ts) received a `state.g2Decision` other than
 * `"approved"` — most notably `"rejected"`, which DESIGN §4's G2 gate has
 * no drawn edge for (its only two out-edges are "批准→Fix" and "主动升级→
 * Esc", and A4a builds neither the Escalation node nor a path for a G2
 * rejection — PRD §2 non-goal #2). Thrown instead of silently routing
 * `"rejected"` to some invented node, or falling through to a default
 * that isn't actually correct per DESIGN — this is the fail-loud
 * consequence of A4a's explicit, documented decision that G2 only handles
 * `"approved"` until A4b builds the Escalation subtree.
 */
export class UnhandledGateDecisionError extends Error {
  readonly gate: GateType;
  readonly decision: string;

  constructor(gate: GateType, decision: string) {
    super(
      `Gate "${gate}" received decision "${decision}", which A4a has no routing target for ` +
        `(A4b will add one — see docs/feature/a4a-loop/PRD.md §2/§9.2).`,
    );
    this.name = "UnhandledGateDecisionError";
    this.gate = gate;
    this.decision = decision;
  }
}
