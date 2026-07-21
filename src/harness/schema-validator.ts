/**
 * `SchemaValidator` — validates a `ModelAdapter#invoke()` response against a
 * zod schema, retrying once with the prior failure fed back into the retry
 * prompt (PRD §5 / §8.5#3, DESIGN §7).
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

export interface SchemaValidatorParams<T> {
  schema: z.ZodType<T>;
  request: InvokeRequest;
  invoke: (req: InvokeRequest) => Promise<InvokeResult>;
}

export interface SchemaValidatorSuccess<T> {
  data: T;
  result: InvokeResult;
  attempts: 1 | 2;
}

/** Outcome of trying to parse+validate one `InvokeResult#content` string. */
type ValidateOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

export class SchemaValidator {
  /**
   * 1. `invoke(request)` → parse `result.content` as JSON → `schema.safeParse()`.
   * 2. On success, return immediately (`attempts: 1`).
   * 3. On failure (JSON parse error *or* schema mismatch — same retry path,
   *    not two separate code paths, PRD §5), build a retry request whose
   *    `prompt` is the original prompt **plus** the failure description, and
   *    invoke once more.
   * 4. Second attempt success → return (`attempts: 2`). Second attempt
   *    failure → throw `SchemaValidationError` carrying both attempts' raw
   *    `content` + failure descriptions — never a silent `null`/`undefined`.
   */
  async validate<T>(params: SchemaValidatorParams<T>): Promise<SchemaValidatorSuccess<T>> {
    const { schema, request, invoke } = params;

    const first = await invoke(request);
    const firstOutcome = tryValidate(schema, first.content);
    if (firstOutcome.ok) {
      return { data: firstOutcome.data, result: first, attempts: 1 };
    }

    const retryRequest: InvokeRequest = {
      ...request,
      prompt: buildRetryPrompt(request.prompt, firstOutcome.error),
    };

    const second = await invoke(retryRequest);
    const secondOutcome = tryValidate(schema, second.content);
    if (secondOutcome.ok) {
      return { data: secondOutcome.data, result: second, attempts: 2 };
    }

    throw new SchemaValidationError([
      { content: first.content, error: firstOutcome.error },
      { content: second.content, error: secondOutcome.error },
    ]);
  }
}

/**
 * Appends the prior failure to the original prompt rather than replacing
 * it — the retry request is a strictly longer, different string than the
 * first, and literally contains the failure text (PRD §5/§8.5#3's
 * verbatim acceptance test: "the req.prompt string received by the second
 * invoke ≠ the first, and contains the previous error message").
 */
function buildRetryPrompt(originalPrompt: string, failureDescription: string): string {
  return (
    originalPrompt +
    "\n\n---\n\n# Previous Attempt Failed Validation\n\n" +
    failureDescription +
    "\n\nPlease respond again with corrected JSON matching the schema."
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
