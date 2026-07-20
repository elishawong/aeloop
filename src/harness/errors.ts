/**
 * Typed errors for the Harness layer (src/harness/*).
 *
 * PRD §8 acceptance criteria these exist to satisfy:
 * - "JSON.parse 全包 try-catch" (§8.5#5) — every `JSON.parse` call site in
 *   this layer (LiteLLMAdapter's HTTP response parsing, SchemaValidator's
 *   model-output parsing) must catch failures into one of these typed
 *   errors, never let a raw `SyntaxError` escape.
 * - `RoleNotBoundError`/`AdapterNotRegisteredError` are the two distinct
 *   failure modes of `ProviderRouter.route()` (PRD §5) — kept as separate
 *   classes rather than one generic "routing failed" error because callers
 *   (and Zorro, reviewing) need to tell "nobody bound this role" apart
 *   from "something's bound but nothing registered that id" at a glance.
 */

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A `ModelAdapter#invoke()` (or `checkAvailability()`) call failed — HTTP
 * transport error, non-2xx response, or a response body that failed to
 * parse/didn't match the expected shape. `LiteLLMAdapter` wraps every one
 * of those cases into this single type rather than letting a raw
 * `TypeError`/`SyntaxError`/fetch rejection leak out, so callers only ever
 * need to catch one error type from an adapter call.
 */
export class AdapterInvokeError extends Error {
  /** HTTP status code, when the failure came from a non-2xx response. */
  readonly statusCode: number | undefined;

  constructor(message: string, options?: { statusCode?: number; cause?: unknown }) {
    super(
      options?.cause !== undefined ? `${message}: ${describeCause(options.cause)}` : message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "AdapterInvokeError";
    this.statusCode = options?.statusCode;
  }
}

/**
 * `ProviderRouter.route(role)` was called for a `role` that has no entry
 * in `ProfileConfig.roles` — nobody bound this role to any provider id at
 * all. Distinct from `AdapterNotRegisteredError`: this is a config-shape
 * problem (missing `roles.<role>`), not a wiring problem.
 */
export class RoleNotBoundError extends Error {
  readonly role: string;

  constructor(role: string) {
    super(`Role "${role}" has no provider binding in roles config`);
    this.name = "RoleNotBoundError";
    this.role = role;
  }
}

/**
 * `ProviderRouter.route(role)` resolved `role` to a provider id via
 * `roles[role].provider`, but that id has no adapter registered in the
 * `AdapterRegistry`. Covers both "config lists the provider but
 * `harness/config.ts` never constructed/registered it" and "the provider
 * id in `roles.<role>.provider` is simply misspelled" — `ProviderRouter`
 * can't tell those apart and doesn't need to; both are "I have no adapter
 * for this id" from its point of view.
 */
export class AdapterNotRegisteredError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`No adapter registered for provider id "${providerId}"`);
    this.name = "AdapterNotRegisteredError";
    this.providerId = providerId;
  }
}

/**
 * `SchemaValidator.validate()` retried once (PRD §5/§8.5#3 — feeding the
 * prior validation failure back into the retry prompt) and still failed to
 * produce output matching the schema. Carries both attempts' raw `content`
 * plus both failure descriptions so a caller/log can diagnose what the
 * model actually returned, rather than validate() silently returning
 * `null`/`undefined`.
 */
export class SchemaValidationError extends Error {
  readonly attempts: readonly [
    { content: string; error: string },
    { content: string; error: string },
  ];

  constructor(attempts: [{ content: string; error: string }, { content: string; error: string }]) {
    super(
      `Schema validation failed after ${attempts.length} attempts. ` +
        `Last error: ${attempts[attempts.length - 1]?.error}`,
    );
    this.name = "SchemaValidationError";
    this.attempts = attempts;
  }
}
