/**
 * `buildLoopGraph()` / `compileLoopGraph()` — assembles the six A4a nodes
 * (draft/g1/review/g2/g3/apply) into DESIGN §4's state machine, minus the
 * Escalation subtree (PRD §0/§5 "graph.ts").
 *
 * **This file is the PRD's declared technical risk core**: `addConditionalEdges`
 * is the one LangGraph mechanism none of spike-findings.md's 5 Qs exercised
 * (they were all linear graphs or a single unconditional `interrupt()`).
 * `graph.test.ts` deliberately verifies it first, driving this file's real
 * `buildLoopGraph()`/`compileLoopGraph()` with FakeAdapter-backed deps (not
 * a toy re-implementation of the graph topology), before this file's real
 * wiring is trusted — see that file's header.
 *
 * The actual `addNode`/`addEdge`/`addConditionalEdges` calls below are
 * hand-written (not generated from `workflow-def.ts`'s
 * `CODER_TESTER_LOOP_DEFINITION` — see that file's header for why), but
 * every node-name/gate-type string literal they use is imported from
 * `LOOP_NODES`, never re-typed.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createDraftNode } from "./nodes/coder.js";
import { createReviewNode } from "./nodes/tester.js";
import { createG1Node, createG2Node, createG3Node, routeAfterG1, routeAfterG2, routeAfterG3, routeAfterReview } from "./gates.js";
import { LOOP_NODES } from "./workflow-def.js";
import { LoopState, type LoopStateType } from "./types.js";
import type { ProviderRouter } from "../harness/provider-router.js";
import type { PromptComposer } from "../prompt/composer.js";

export interface LoopGraphDeps {
  router: ProviderRouter;
  composer: PromptComposer;
}

/**
 * `Apply` — DESIGN §4's terminal state, downgraded per PRD §0/§2: marks the
 * run as finished, never touches the filesystem. Not broken out into its
 * own `nodes/apply.ts` file — DESIGN §6's file list doesn't list one
 * either, and there's nothing here worth a dedicated file/test for (PRD
 * §5 "graph.ts").
 */
function applyNode(_state: LoopStateType): Partial<LoopStateType> {
  return { applied: true };
}

/**
 * Unconnected-to-a-checkpointer graph builder — pure structure, matching
 * DESIGN §4 minus the Escalation subtree:
 *
 * `START -> draft -> g1 -{approved}-> review -{pass}-> g3 -{approved}-> apply -> END`
 *
 * with reject/rejected edges looping back to `draft`, and `review`'s
 * `"reject"` verdict routing through `g2` before returning to `draft`.
 *
 * **Deliberately not adding a plain `addEdge(LOOP_NODES.g1, LOOP_NODES.review)`
 * alongside the `addConditionalEdges(LOOP_NODES.g1, ...)` call below** — the
 * conditional edges' target set already covers `{review, draft}` (PRD §5's
 * explicit warning: "初次写码时容易犯的错").
 */
export function buildLoopGraph(deps: LoopGraphDeps) {
  return new StateGraph(LoopState)
    .addNode(LOOP_NODES.draft, createDraftNode(deps))
    .addNode(LOOP_NODES.g1, createG1Node())
    .addNode(LOOP_NODES.review, createReviewNode(deps))
    .addNode(LOOP_NODES.g2, createG2Node())
    .addNode(LOOP_NODES.g3, createG3Node())
    .addNode(LOOP_NODES.apply, applyNode)
    .addEdge(START, LOOP_NODES.draft)
    .addEdge(LOOP_NODES.draft, LOOP_NODES.g1)
    .addConditionalEdges(LOOP_NODES.g1, routeAfterG1, {
      review: LOOP_NODES.review,
      draft: LOOP_NODES.draft,
    })
    .addConditionalEdges(LOOP_NODES.review, routeAfterReview, {
      g3: LOOP_NODES.g3,
      g2: LOOP_NODES.g2,
    })
    .addConditionalEdges(LOOP_NODES.g2, routeAfterG2, {
      draft: LOOP_NODES.draft,
    })
    .addConditionalEdges(LOOP_NODES.g3, routeAfterG3, {
      apply: LOOP_NODES.apply,
      draft: LOOP_NODES.draft,
    })
    .addEdge(LOOP_NODES.apply, END);
}

/**
 * Thin wrapper around `graph.compile({checkpointer})` — the only reason
 * this exists as its own function is so every call site (tests, future A5)
 * goes through one place rather than repeating `.compile({...})` (PRD §5).
 */
export function compileLoopGraph(graph: ReturnType<typeof buildLoopGraph>, checkpointer: BaseCheckpointSaver) {
  return graph.compile({ checkpointer });
}
