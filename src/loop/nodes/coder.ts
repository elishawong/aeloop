/**
 * `createDraftNode` — the `draft` node factory (PRD §5 "nodes/coder.ts",
 * DESIGN §4's `Draft` state). Reuses A2's `ProviderRouter` + A1's
 * `PromptComposer` + A2's `SchemaValidator` wholesale — this file adds zero
 * new model-invocation logic of its own (PRD §2 non-goal "real
 * coder/tester model logic").
 *
 * Only ever imports *types* from `../../context/injector.js` (never the
 * `ContextInjector` class) — `injectedContext` arrives pre-built in
 * `state`, this layer doesn't know how it was produced (PRD §5/§10
 * "no reverse cross-layer dependency").
 */

import { SchemaValidator } from "../../harness/schema-validator.js";
import type { ProviderRouter } from "../../harness/provider-router.js";
import type { PromptComposer } from "../../prompt/composer.js";
import { CoderOutput } from "../../prompt/schema.js";
import type { LoopStateType } from "../types.js";

export interface DraftNodeDeps {
  router: ProviderRouter;
  composer: PromptComposer;
  /**
   * Optional (issue #45 follow-up): forwarded straight to
   * `new SchemaValidator({ maxAttempts: ... })` below. `undefined`
   * (the pre-existing default for every caller that predates this field)
   * makes `SchemaValidator` fall back to `DEFAULT_SCHEMA_MAX_ATTEMPTS`
   * (2) — byte-for-byte the same behavior this node had before this field
   * existed.
   */
  schemaMaxAttempts?: number;
}

/**
 * Appended to the task text only on a fix-forward round (`state.feedback`
 * present — i.e. after a G2-approved tester finding routes back to
 * `draft`, DESIGN §4's `G2 -- approved --> Draft` edge). Issue #45: the
 * coder's fix-forward output was observed drifting into prose or a
 * too-small/partial diff and failing `CoderOutput` schema validation after
 * both `SchemaValidator` attempts. `state.task` already carries the
 * original Contract (rendered once by `renderTaskContract()` before the
 * run starts, PRD workflow/coder-tester.ts) and `state.feedback` already
 * carries the tester's issues (`gates.ts`'s `createG2Node` deriveFeedback,
 * joined with any human `reasoningText`) — both already land in this
 * round's task text below. What was missing was an explicit, blunt
 * restatement of the output-shape requirement *right next to* that
 * feedback, so the model doesn't drift into "just describe the fix" mode
 * once its attention is on the tester's prose findings rather than the
 * `# Output Schema` section `composer.compose()` put earlier in the
 * prompt. Deliberately only appended on the fix-forward path (not the
 * first-attempt path) — issue #45's "focused, backward-compatible" ask for
 * this fix, not a general schema-registry gen or SchemaValidator behavior
 * tweak. This is a *targeted addition*, not weaker validation:
 * `SchemaValidator` (harness/schema-validator.ts) still fail-closed throws
 * `SchemaValidationError` if the model ignores this and violates the
 * schema anyway.
 */
const FIX_FORWARD_OUTPUT_REQUIREMENT =
  "# Full Output Requirement\n\n" +
  "Your entire response must be a single, complete CoderOutput JSON object matching the " +
  "# Output Schema section above — no prose wrapper before or after it, and no partial or " +
  "truncated diff. The `diff` field must be non-empty and contain the complete fix for every " +
  "issue listed in the feedback above (not a small snippet). The `claims` and `confidence` " +
  "fields are required exactly as the schema defines them.";

/**
 * Node body:
 * 1. Build this round's task text — `state.feedback` present → append it
 *    ("Feedback from the previous round: ..."), same "append, don't
 *    replace" convention `SchemaValidator.buildRetryPrompt()` already
 *    established elsewhere in this codebase (PRD §5, not a new pattern).
 *    On that same fix-forward path, also append
 *    `FIX_FORWARD_OUTPUT_REQUIREMENT` (issue #45) — a blunt reminder of
 *    the output shape, placed right next to the tester's findings that
 *    triggered this round.
 * 2. `composer.compose("coder", state.injectedContext, task)` → prompt.
 * 3. `router.route("coder")` → adapter.
 * 4. `SchemaValidator#validate()` against `CoderOutput` — a fresh
 *    `SchemaValidator` instance each call (it has no constructor
 *    dependencies, same usage as `harness-cli.e2e.test.ts`).
 * 5. Return `coderOutput`/`coderResult`, and clear `feedback` — consumed,
 *    so it isn't accidentally re-applied on a later round that doesn't
 *    pass through a gate that sets a fresh one.
 *
 * `SchemaValidationError` (thrown when both attempts fail schema
 * validation) is deliberately **not caught here** — it propagates out of
 * `compiled.invoke()` as-is; a coder that can't produce valid output twice
 * in a row is a real failure the caller needs to see, not something this
 * layer should swallow (PRD §5).
 */
export function createDraftNode(deps: DraftNodeDeps): (state: LoopStateType) => Promise<Partial<LoopStateType>> {
  return async (state) => {
    const task = state.feedback
      ? `${state.task}\n\n---\n\nFeedback from the previous round:\n${state.feedback}\n\n---\n\n${FIX_FORWARD_OUTPUT_REQUIREMENT}`
      : state.task;

    const prompt = deps.composer.compose("coder", state.injectedContext, task);
    const adapter = deps.router.route("coder");
    const validator = new SchemaValidator({ maxAttempts: deps.schemaMaxAttempts });

    const { data, result } = await validator.validate({
      schema: CoderOutput,
      request: { role: "coder", prompt },
      invoke: (req) => adapter.invoke(req),
    });

    return { coderOutput: data, coderResult: result, feedback: undefined };
  };
}
