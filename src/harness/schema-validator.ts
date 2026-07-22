/**
 * `SchemaValidator` — validates a `ModelAdapter#invoke()` response against a
 * zod schema, retrying with the prior failure fed back into the retry
 * prompt (PRD §5 / §8.5#3, DESIGN §7) until either a validation succeeds or
 * `maxAttempts` total model attempts have been made.
 *
 * **`maxAttempts` (issue #45 follow-up)**: the retry count used to be
 * hardcoded at exactly 2 total attempts (one shot + one retry). It's now an
 * optional constructor parameter — `harness.schema_max_attempts` in
 * `ProfileConfig` (`src/profile/loader.ts`), resolved fail-closed at CLI
 * assembly time (`src/cli/assemble.ts`'s `resolveSchemaMaxAttempts()`) and
 * threaded through `LoopGraphDeps`/`StartRunDeps` into `createDraftNode`/
 * `createReviewNode`, which construct `new SchemaValidator({ maxAttempts })`.
 * Defaults to 2 when omitted or invalid — **identical to today's
 * pre-existing hardcoded behavior**, so every existing profile/caller that
 * never mentions this field keeps behaving exactly as before. Deliberately
 * a *separate* knob from `workflow.reject_threshold` (`cli/assemble.ts`'s
 * `resolveRejectThreshold()`): that one governs how many tester *rejections*
 * before the loop escalates to a human; this one governs how many model
 * *attempts* `SchemaValidator` allows to produce schema-valid JSON. The two
 * never read or influence each other.
 *
 * Deliberately knows nothing about *who* it's calling: `validate()` takes an
 * `invoke` callback (typically `(req) => adapter.invoke(req)`), never a
 * `ModelAdapter`/`ProviderRouter`/`AdapterRegistry` instance. That keeps this
 * file's only import from the rest of `src/harness/` limited to its own
 * `types.ts`/`errors.ts` — no reference to `ProviderRouter`, `AdapterRegistry`,
 * or any concrete adapter — and lets tests pass a plain function instead of
 * constructing a real or fake adapter object (PRD §5).
 */

import type { z } from "zod";
import { SchemaValidationError } from "./errors.js";
import type { InvokeRequest, InvokeResult } from "./types.js";

/** Total model attempts allowed when a profile doesn't configure `harness.schema_max_attempts` — matches the pre-#45-config-slice hardcoded behavior exactly. */
export const DEFAULT_SCHEMA_MAX_ATTEMPTS = 2;

export interface SchemaValidatorParams<T> {
  schema: z.ZodType<T>;
  request: InvokeRequest;
  invoke: (req: InvokeRequest) => Promise<InvokeResult>;
}

export interface SchemaValidatorOptions {
  /**
   * Total model attempts allowed (first attempt + retries), not just the
   * retry count. Must be a positive integer — anything else (non-number,
   * non-integer, zero, negative) falls back to `DEFAULT_SCHEMA_MAX_ATTEMPTS`
   * fail-closed, rather than throwing or silently allowing an
   * unbounded/negative attempt count.
   */
  maxAttempts?: number;
}

export interface SchemaValidatorSuccess<T> {
  data: T;
  result: InvokeResult;
  attempts: number;
}

/** Outcome of trying to parse+validate one `InvokeResult#content` string. */
type ValidateOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Fail-closed normalization for `maxAttempts` — mirrors the "malformed
 * config falls back to the safe default, never throws, never silently
 * allows something larger/unbounded" contract `cli/assemble.ts`'s
 * `resolveSchemaMaxAttempts()` already establishes at the config-loading
 * layer. Kept here too (not only there) so `SchemaValidator` is safe to
 * construct directly (e.g. from a test) with a bad value and still behaves
 * exactly as if it had been given no value at all.
 */
function normalizeMaxAttempts(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return DEFAULT_SCHEMA_MAX_ATTEMPTS;
  }
  return value;
}

export class SchemaValidator {
  private readonly maxAttempts: number;

  constructor(options?: SchemaValidatorOptions) {
    this.maxAttempts = normalizeMaxAttempts(options?.maxAttempts);
  }

  /**
   * 1. `invoke(request)` → parse `result.content` as JSON → `schema.safeParse()`.
   * 2. On success, return immediately (`attempts: <this attempt's 1-based index>`).
   * 3. On failure (JSON parse error *or* schema mismatch — same retry path,
   *    not two separate code paths, PRD §5), build the next request whose
   *    `prompt` is *this* attempt's prompt **plus** the failure description
   *    (so each subsequent retry's prompt keeps growing with every prior
   *    failure appended in order — for `maxAttempts: 2` this reduces to
   *    exactly the original single-retry behavior: original prompt + one
   *    failure description), and invoke again.
   * 4. Repeats until either an attempt succeeds, or `this.maxAttempts` total
   *    attempts have all failed — in which case it throws
   *    `SchemaValidationError` carrying every attempt's raw `content` +
   *    failure description, in order — never a silent `null`/`undefined`.
   */
  async validate<T>(params: SchemaValidatorParams<T>): Promise<SchemaValidatorSuccess<T>> {
    const { schema, request, invoke } = params;

    const failures: { content: string; error: string }[] = [];
    let currentRequest = request;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const result = await invoke(currentRequest);
      const outcome = tryValidate(schema, result.content);
      if (outcome.ok) {
        return { data: outcome.data, result, attempts: attempt };
      }

      failures.push({ content: result.content, error: outcome.error });
      currentRequest = {
        ...currentRequest,
        prompt: buildRetryPrompt(currentRequest.prompt, outcome.error),
      };
    }

    throw new SchemaValidationError(failures);
  }
}

/**
 * Appends the prior failure to the original prompt rather than replacing
 * it — the retry request is a strictly longer, different string than the
 * first, and literally contains the failure text (PRD §5/§8.5#3's
 * verbatim acceptance test: "the req.prompt string received by the second
 * invoke ≠ the first, and contains the previous error message").
 *
 * Issue #45: the closing instruction used to just say "respond again with
 * corrected JSON matching the schema" — too weak to stop a model that
 * drifted into prose or a partial/truncated response from doing the same
 * thing again on this, its last chance before `SchemaValidationError`.
 * Strengthened to explicitly demand a single, complete JSON object with no
 * prose wrapper and no partial/truncated content. Deliberately kept
 * schema-agnostic (no mention of coder-specific fields like `diff`) since
 * this same function retries both coder and tester requests — the
 * coder-specific "diff must be non-empty/complete" language lives in
 * `loop/nodes/coder.ts`'s `FIX_FORWARD_OUTPUT_REQUIREMENT` instead, which
 * knows it's building a `CoderOutput` prompt.
 */
function buildRetryPrompt(originalPrompt: string, failureDescription: string): string {
  return (
    originalPrompt +
    "\n\n---\n\n# Previous Attempt Failed Validation\n\n" +
    failureDescription +
    "\n\nRespond again with a single, complete JSON object matching the schema. Your entire " +
    "response must be that JSON object — no prose wrapper before or after it, and no partial " +
    "or truncated fields."
  );
}

/**
 * `JSON.parse` failure and `schema.safeParse()` failure share this one
 * function/return path (PRD §5: "not two separate code paths") — both just become a
 * `{ ok: false, error }` outcome the caller retries the same way.
 */
function tryValidate<T>(schema: z.ZodType<T>, content: string): ValidateOutcome<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    return { ok: false, error: `response content was not valid JSON: ${describeCause(cause)}` };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const issues = result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `response did not match schema: ${issues}` };
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
