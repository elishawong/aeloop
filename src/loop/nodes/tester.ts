/**
 * `createReviewNode` — the `review` node factory (PRD §5 "nodes/tester.ts",
 * DESIGN §4's `Review` state). Same reuse posture as `coder.ts`: no new
 * model-invocation logic, only `ProviderRouter`/`PromptComposer`/
 * `SchemaValidator` (PRD §2 non-goal).
 */

import { SchemaValidator } from "../../harness/schema-validator.js";
import type { ProviderRouter } from "../../harness/provider-router.js";
import type { PromptComposer } from "../../prompt/composer.js";
import { TesterOutput, type Claim, type CoderOutput } from "../../prompt/schema.js";
import type { LoopStateType } from "../types.js";

export interface ReviewNodeDeps {
  router: ProviderRouter;
  composer: PromptComposer;
}

/**
 * Node body:
 * 1. Defensive check that `state.coderOutput` exists — the graph's edges
 *    guarantee `review` only runs after `draft`, but a node function
 *    should not trust that implicitly (PRD §5: "节点函数不应该信任图结构
 *    保证了这一点这种隐式假设"). Missing → throws a plain, explicit
 *    `Error`, never a bare `undefined.diff` crash.
 * 2. Build the tester's task text: original task + coder's diff + coder's
 *    claims — the tester persona's house rules
 *    (profiles/subscription/personas/tester.md) explicitly say to verify
 *    claims rather than just agreeing with them, so the claims list has to
 *    actually reach the tester, not just the diff (PRD §5).
 * 3. `composer.compose("tester", ...)` → `router.route("tester")` →
 *    `SchemaValidator#validate()` against `TesterOutput` — identical
 *    shape to `createDraftNode`'s steps 2-4.
 * 4. Return `testerOutput`/`testerResult`, and increment `rejectCount`
 *    **unconditionally** when `verdict === "reject"` (DESIGN §4's "Inc"
 *    step) — nothing here reads `rejectCount` to make a routing decision,
 *    that threshold check is A4b (PRD §0/§2).
 */
export function createReviewNode(deps: ReviewNodeDeps): (state: LoopStateType) => Promise<Partial<LoopStateType>> {
  return async (state) => {
    if (!state.coderOutput) {
      throw new Error("review node invoked without a coderOutput in state");
    }
    const coderOutput = state.coderOutput;

    const task =
      `${state.task}\n\n---\n\n# Diff to review\n\n${coderOutput.diff}\n\n---\n\n` +
      `# Coder's claims\n\n${formatClaims(coderOutput.claims)}`;

    const prompt = deps.composer.compose("tester", state.injectedContext, task);
    const adapter = deps.router.route("tester");
    const validator = new SchemaValidator();

    const { data, result } = await validator.validate({
      schema: TesterOutput,
      request: { role: "tester", prompt },
      invoke: (req) => adapter.invoke(req),
    });

    return {
      testerOutput: data,
      testerResult: result,
      rejectCount: data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount,
    };
  };
}

function formatClaims(claims: CoderOutput["claims"]): string {
  if (claims.length === 0) return "(no claims)";
  return claims.map(formatClaim).join("\n");
}

function formatClaim(claim: Claim): string {
  const parts = [`confidence: ${claim.confidence}`];
  if (claim.verifiedBy) parts.push(`verifiedBy: ${claim.verifiedBy}`);
  if (claim.sourceRef) parts.push(`sourceRef: ${claim.sourceRef}`);
  return `- ${claim.claimText} (${parts.join(", ")})`;
}
