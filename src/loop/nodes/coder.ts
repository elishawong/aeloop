/**
 * `createDraftNode` — the `draft` node factory (PRD §5 "nodes/coder.ts",
 * DESIGN §4's `Draft` state). Reuses A2's `ProviderRouter` + A1's
 * `PromptComposer` + A2's `SchemaValidator` wholesale — this file adds zero
 * new model-invocation logic of its own (PRD §2 non-goal "真实
 * coder/tester 模型逻辑").
 *
 * Only ever imports *types* from `../../context/injector.js` (never the
 * `ContextInjector` class) — `injectedContext` arrives pre-built in
 * `state`, this layer doesn't know how it was produced (PRD §5/§10
 * "跨层无反向依赖").
 */

import { SchemaValidator } from "../../harness/schema-validator.js";
import type { ProviderRouter } from "../../harness/provider-router.js";
import type { PromptComposer } from "../../prompt/composer.js";
import { CoderOutput } from "../../prompt/schema.js";
import type { LoopStateType } from "../types.js";

export interface DraftNodeDeps {
  router: ProviderRouter;
  composer: PromptComposer;
}

/**
 * Node body:
 * 1. Build this round's task text — `state.feedback` present → append it
 *    ("Feedback from the previous round: ..."), same "append, don't
 *    replace" convention `SchemaValidator.buildRetryPrompt()` already
 *    established elsewhere in this codebase (PRD §5, not a new pattern).
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
      ? `${state.task}\n\n---\n\nFeedback from the previous round:\n${state.feedback}`
      : state.task;

    const prompt = deps.composer.compose("coder", state.injectedContext, task);
    const adapter = deps.router.route("coder");
    const validator = new SchemaValidator();

    const { data, result } = await validator.validate({
      schema: CoderOutput,
      request: { role: "coder", prompt },
      invoke: (req) => adapter.invoke(req),
    });

    return { coderOutput: data, coderResult: result, feedback: undefined };
  };
}
