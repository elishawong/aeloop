/**
 * `LOOP_NODES`/`GATE_TYPES` — the single naming source for every node name /
 * gate-type string literal used anywhere under `src/loop/` (PRD §5
 * "workflow-def.ts"). `types.ts`/`graph.ts`/`gates.ts`/`nodes/*.ts` all
 * `import { LOOP_NODES, GATE_TYPES } from "./workflow-def.js"` rather than
 * hand-writing the same string literal in more than one place — the spike
 * scripts (docs/feature/a4a-loop/spike/q2-q5) wrote node names as bare
 * string literals scattered across each file, which is fine for a
 * throwaway spike but would be a real footgun in production code (typo a
 * node name in one call site, `tsc` won't catch it because there's nothing
 * to check it against).
 *
 * `CODER_TESTER_LOOP_DEFINITION` is a **documentation** artifact, not a
 * runtime-interpreted config `graph.ts` reads (PRD §5's explicit, detailed
 * downgrade from DESIGN §6's "graph.ts compiles from WorkflowDefinition" —
 * see the PRD section for the full reasoning: LangGraph's TS API is built around
 * compile-time literal node names / `Annotation` state shapes, and none of
 * spike Q2-Q5 exercised "build a StateGraph at runtime from a data
 * structure"). `graph.ts`'s actual `addNode`/`addEdge`/`addConditionalEdges`
 * calls are hand-written, but every string literal they use is imported
 * from `LOOP_NODES`/`GATE_TYPES` below, so a typo becomes a `tsc` error
 * instead of a silent divergence between "what this file describes" and
 * "what graph.ts actually builds". `workflows/coder-tester-loop.json`
 * (DESIGN §6) is deliberately **not created** by this PRD — see PRD §5 for
 * why a file that looks consumed but isn't would be worse than no file at
 * all.
 */

/**
 * The real nodes of the coder/tester loop graph (DESIGN §4) — A4a shipped
 * the first six; A4b (PRD §4.1) added `escalation`/`cancel`, the Escalation
 * subtree A4a deliberately left out (PRD §0); issue #47 adds `no_change`, a
 * second terminal alongside `apply`/`cancel` for a `draft` round whose
 * `coderOutput.status === "no_change"` (a read-only/already-satisfied task
 * with nothing to send through `g1`/the tester review).
 */
export const LOOP_NODES = {
  draft: "draft",
  g1: "g1",
  review: "review",
  g2: "g2",
  g3: "g3",
  apply: "apply",
  escalation: "escalation",
  cancel: "cancel",
  noChange: "no_change",
} as const;

/**
 * DESIGN §5 `approvals.gate_type` enum, now complete — A4a shipped the
 * first three; A4b (PRD §4.1) adds `"ESCALATION_ACK"`, the Escalation
 * node's gate type.
 */
export const GATE_TYPES = {
  G1_SEND_TO_TESTER: "G1_SEND_TO_TESTER",
  G2_SEND_TO_FIX: "G2_SEND_TO_FIX",
  G3_FINAL_MERGE: "G3_FINAL_MERGE",
  ESCALATION_ACK: "ESCALATION_ACK",
} as const;

/**
 * Human/documentation-readable description of the A4a graph's node set and
 * edges (including which edges are conditional) — read this to understand
 * the shape of `graph.ts`'s `buildLoopGraph()`, but this object itself is
 * never imported by `graph.ts` (see file header). Kept in sync with
 * `graph.ts` manually; `workflow-def.test.ts` only checks that
 * `CODER_TESTER_LOOP_DEFINITION.nodes` and `LOOP_NODES`'s values agree, not
 * that the edge list matches `graph.ts`'s real edges (there is no runtime
 * link between the two to check against).
 */
export const CODER_TESTER_LOOP_DEFINITION = {
  id: "coder-tester-loop",
  nodes: Object.values(LOOP_NODES),
  edges: [
    { from: "__start__", to: LOOP_NODES.draft },
    { from: LOOP_NODES.draft, to: [LOOP_NODES.g1, LOOP_NODES.noChange], conditional: true },
    { from: LOOP_NODES.g1, to: [LOOP_NODES.review, LOOP_NODES.draft], conditional: true },
    { from: LOOP_NODES.review, to: [LOOP_NODES.g3, LOOP_NODES.g2, LOOP_NODES.escalation], conditional: true },
    { from: LOOP_NODES.g2, to: [LOOP_NODES.draft, LOOP_NODES.escalation], conditional: true },
    { from: LOOP_NODES.g3, to: [LOOP_NODES.apply, LOOP_NODES.draft], conditional: true },
    { from: LOOP_NODES.escalation, to: [LOOP_NODES.draft, LOOP_NODES.g3, LOOP_NODES.cancel], conditional: true },
    { from: LOOP_NODES.apply, to: "__end__" },
    { from: LOOP_NODES.cancel, to: "__end__" },
    { from: LOOP_NODES.noChange, to: "__end__" },
  ],
} as const;
