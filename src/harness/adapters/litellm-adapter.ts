/**
 * `LiteLLMAdapter` — the first real `ModelAdapter` (`kind: "direct-api"`),
 * speaking to a LiteLLM proxy over its OpenAI-compatible `chat/completions`
 * endpoint (PRD §5, `docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`).
 *
 * `[?]` **Endpoint shape unverified against a real LiteLLM proxy** (PRD
 * §9.3): `invoke()` assumes `POST ${base_url}/chat/completions` with an
 * OpenAI-compatible request/response body — that's LiteLLM's documented
 * public positioning, but there's no reachable company LiteLLM proxy
 * instance on this machine to test against, so this can't be marked
 * "verified". Every test in `litellm-adapter.test.ts` runs against a local
 * `node:http` fake server standing in for that shape, not a real LiteLLM
 * instance. This `[?]` stays open until it's actually wired to a real
 * proxy — noted again in progress.md.
 *
 * `checkAvailability()`'s endpoint, by contrast, *is* resolved (PRD §9.3
 * spike, done during this batch): LiteLLM's public docs
 * (https://docs.litellm.ai/docs/proxy/health) document `GET
 * /health/liveliness` as a no-auth, zero-upstream-call "is the proxy
 * process alive" probe — exactly the "real request but don't burn a model
 * call just to check availability" shape this method needs. The other two
 * documented health endpoints were rejected: `/health` requires an API key
 * and calls every configured model (expensive, and does more than "is this
 * adapter reachable"); `/health/readiness` also checks DB connectivity,
 * which is a LiteLLM-proxy-internal concern this adapter has no business
 * asserting on.
 */

import { AdapterInvokeError } from "../errors.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter, ProviderUsage } from "../types.js";

/**
 * Shape of the constructor config this adapter needs — a subset of
 * `ProfileConfig["providers"][id]` (`src/profile/loader.ts`'s
 * `ProviderConfig`) after `${ENV}` substitution has already run. Kept as
 * its own local type (not importing `ProviderConfig` directly) because
 * `LiteLLMAdapter` only cares about these fields, not `kind`/`cmd`
 * (those are `harness/config.ts`'s dispatch concern, PRD §5).
 *
 * `api_style`:
 * - "openai" (default): OpenAI-compatible `POST /chat/completions`
 * - "anthropic": Anthropic Messages API `POST /v1/messages` (used by Claude Code)
 */
export interface LiteLLMAdapterConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
  api_style?: "openai" | "anthropic";
}

/** Minimal shape this adapter reads out of an OpenAI-compatible chat/completions response. */
interface ChatCompletionsResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

/** Minimal shape this adapter reads out of an Anthropic-compatible messages response. */
interface AnthropicMessagesResponse {
  model?: unknown;
  content?: unknown;
  usage?: unknown;
}

/**
 * Anthropic `/v1/messages` response's `usage` block (Anthropic Messages API
 * docs). `input_tokens`/`output_tokens` are the "fresh" (non-cached) token
 * counts; `cache_creation_input_tokens`/`cache_read_input_tokens` are
 * separate, additive categories — a cache read/write is never already
 * counted inside `input_tokens` (issue #48 contract decision, see
 * `ProviderUsage` doc in `types.ts` for why that matters for `totalTokens`).
 */
interface AnthropicUsageRaw {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

/**
 * OpenAI chat/completions `usage` block, plus the LiteLLM-specific variants
 * this adapter has actually been observed to need (issue #48):
 * - Strict OpenAI shape: `prompt_tokens`/`completion_tokens`/`total_tokens`,
 *   optionally `prompt_tokens_details.cached_tokens` for a cache-read count
 *   (OpenAI's own prompt-caching docs) — that cached count is a *subset* of
 *   `prompt_tokens`, not additional to it.
 * - LiteLLM Anthropic-passthrough variant: when LiteLLM proxies an
 *   Anthropic model through its OpenAI-compatible `/chat/completions`
 *   endpoint, it has been observed carrying the Anthropic-native
 *   `cache_creation_input_tokens`/`cache_read_input_tokens` field names
 *   straight through inside the otherwise-OpenAI-shaped `usage` object
 *   (LiteLLM's own cost-tracking needs the Anthropic-specific split, so it
 *   doesn't collapse it away even in the OpenAI-compatible response). Those
 *   are additive to `prompt_tokens`, matching Anthropic's own semantics,
 *   *not* OpenAI's `prompt_tokens_details.cached_tokens` subset semantics —
 *   the two are deliberately read into different `ProviderUsage` fields
 *   only when unambiguous (see `extractOpenAIUsage`).
 */
interface OpenAIUsageRaw {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Strips trailing slashes so `${base_url}/chat/completions` never produces
 * a doubled `//` (PRD §5 / §8.5#6 — a prior internal implementation's real-world footgun when
 * `base_url` is configured with a trailing slash).
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Pulls `choices[0].message.content` out of a parsed OpenAI-compatible
 * response body. Returns `undefined` (never throws) for anything that
 * doesn't match — the caller turns that into a typed `AdapterInvokeError`
 * rather than this helper throwing a shape-specific error of its own.
 */
function extractOpenAIContent(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { choices } = parsed as ChatCompletionsResponse;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Pulls `content[i].text` out of a parsed Anthropic-compatible messages
 * response body. Anthropic's response format:
 * - `content: [{ type: "text", text: "..." }]` (array of content blocks)
 * - With thinking enabled: `content: [{ type: "thinking", ... }, { type: "text", text: "..." }]`
 *
 * This function iterates through all content blocks and returns the first
 * block where `type === "text"`, ignoring "thinking" type blocks.
 */
function extractAnthropicContent(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { content } = parsed as AnthropicMessagesResponse;
  if (!Array.isArray(content) || content.length === 0) return undefined;

  // Find the first block with type === "text".
  // Note: some models (e.g. DeepSeek/Seed) may return "thinking" type blocks
  // first, followed by the actual "text" block.
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      return b.text;
    }
  }
  return undefined;
}

/**
 * Pulls the response's own `model` field, when present and a *non-blank*
 * string. `""` (or a whitespace-only string) is treated the same as
 * missing — never returned as-is — because the caller (`invoke()`) does
 * `extractModel(parsed) ?? model`, and `??` only falls back on
 * `null`/`undefined`, not `""`. Without this, a legal-but-degenerate
 * `"model": ""` response body would make `InvokeResult.model === ""`,
 * violating the non-empty invariant `types.ts:72` documents (PRD §5 /
 * DESIGN §8.5#4).
 */
function extractModel(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { model } = parsed as ChatCompletionsResponse;
  if (typeof model !== "string") return undefined;
  return model.trim().length > 0 ? model : undefined;
}

/**
 * Guards a single raw usage field: only a finite, non-negative `number`
 * counts as a real token count. Anything else (missing, `null`, a string,
 * `NaN`/`Infinity`, negative) is treated as "provider didn't tell us this"
 * and mapped to `undefined` rather than coerced/guessed — the fail-safe
 * posture issue #48 asks for (a malformed field never crashes `invoke()`,
 * it's just silently absent from `ProviderUsage`).
 */
function toTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Builds the `ProviderUsage` `invoke()` returns, or `undefined` when none
 * of the five counters could be read at all — an all-`undefined`-fields
 * `{ source: "provider" }` object would be a degenerate, useless value to
 * hand back, so this omits `usage` from `InvokeResult` entirely in that
 * case rather than returning that shell (same "leave it honestly unknown"
 * choice `InvokeResult.usage`'s doc in `types.ts` describes).
 */
function buildUsage(fields: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): ProviderUsage | undefined {
  const hasAnyField = Object.values(fields).some((value) => value !== undefined);
  if (!hasAnyField) return undefined;
  return { ...fields, source: "provider" };
}

/**
 * Anthropic `/v1/messages` usage parsing (issue #48). `totalTokens` is
 * populated only when both `input_tokens`/`output_tokens` are present —
 * Anthropic's response has no provider-declared total field, so this is a
 * computed sum, and only of those two (cache tokens are deliberately never
 * folded in; see `ProviderUsage`'s doc in `types.ts` for why).
 */
function extractAnthropicUsage(parsed: unknown): ProviderUsage | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { usage } = parsed as AnthropicMessagesResponse;
  if (typeof usage !== "object" || usage === null) return undefined;
  const raw = usage as AnthropicUsageRaw;

  const inputTokens = toTokenCount(raw.input_tokens);
  const outputTokens = toTokenCount(raw.output_tokens);
  const cacheWriteTokens = toTokenCount(raw.cache_creation_input_tokens);
  const cacheReadTokens = toTokenCount(raw.cache_read_input_tokens);
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined;

  return buildUsage({ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens });
}

/**
 * OpenAI-compatible chat/completions usage parsing (issue #48), including
 * the LiteLLM Anthropic-passthrough variant (see `OpenAIUsageRaw`'s doc).
 * `totalTokens` prefers the provider's own `total_tokens` when it's a valid
 * count (a provider-declared total is more defensible than a computed one);
 * falls back to `prompt_tokens + completion_tokens` only when both of those
 * are present and `total_tokens` itself wasn't usable.
 *
 * Cache reads: OpenAI's `prompt_tokens_details.cached_tokens` is checked
 * first (the "official" OpenAI shape); the LiteLLM Anthropic-passthrough
 * `cache_read_input_tokens` field is used only as a fallback when the
 * OpenAI-shaped field isn't present, since the two are not guaranteed to
 * mean the same thing (subset-of-prompt vs. additive-to-prompt — see
 * `OpenAIUsageRaw`'s doc) and a response should not realistically carry
 * both for the same underlying count.
 */
function extractOpenAIUsage(parsed: unknown): ProviderUsage | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { usage } = parsed as ChatCompletionsResponse;
  if (typeof usage !== "object" || usage === null) return undefined;
  const raw = usage as OpenAIUsageRaw;

  const inputTokens = toTokenCount(raw.prompt_tokens);
  const outputTokens = toTokenCount(raw.completion_tokens);
  const cacheWriteTokens = toTokenCount(raw.cache_creation_input_tokens);

  const promptDetails =
    typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null
      ? (raw.prompt_tokens_details as { cached_tokens?: unknown })
      : undefined;
  const cacheReadTokens = toTokenCount(promptDetails?.cached_tokens) ?? toTokenCount(raw.cache_read_input_tokens);

  const declaredTotal = toTokenCount(raw.total_tokens);
  const totalTokens =
    declaredTotal ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  return buildUsage({ inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens });
}

export class LiteLLMAdapter implements ModelAdapter {
  readonly kind = "direct-api" as const;

  constructor(
    readonly id: string,
    private readonly config: LiteLLMAdapterConfig,
  ) {}

  // `toolTrace` intentionally not implemented — direct-api adapters have no
  // tool-execution trace to give (PRD §5).

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const baseUrl = this.requireBaseUrl();
    const model = this.requireModel();
    const providerId = this.requireProviderId();
    const apiStyle = this.config.api_style ?? "openai";
    const normalizedBase = normalizeBaseUrl(baseUrl);

    // Build URL and request body based on API style.
    let url: string;
    let requestBody: Record<string, unknown>;
    let responseShapeError: string;

    if (apiStyle === "anthropic") {
      // Anthropic Messages API: POST /v1/messages
      // - max_tokens is REQUIRED for Anthropic
      // - messages: [{ role: "user", content: "..." }]
      url = `${normalizedBase}/v1/messages`;
      requestBody = {
        model,
        messages: [{ role: "user", content: req.prompt }],
        max_tokens: 4096,
      };
      responseShapeError = "Anthropic messages shape (content[0].text)";
    } else {
      // OpenAI-compatible API: POST /chat/completions (default)
      url = `${normalizedBase}/chat/completions`;
      requestBody = {
        model,
        messages: [{ role: "user", content: req.prompt }],
      };
      responseShapeError = "chat/completions shape (choices[0].message.content)";
    }

    // `performance.now()` (monotonic, immune to wall-clock adjustments —
    // the "non-brittle" measurement issue #48 asks for, unlike `Date.now()`
    // which can jump backwards/forwards on NTP sync) brackets exactly the
    // network round trip: from immediately before `fetch()` is issued to
    // immediately after the full response body has been read. Deliberately
    // excludes request-body serialization before it and `JSON.parse`/
    // content-shape validation after it — those are this process's own CPU
    // work, not time spent waiting on the provider, so folding them in
    // would make `latencyMs` overstate the actual network latency it's
    // meant to report.
    const requestStartedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
      });
    } catch (cause) {
      throw new AdapterInvokeError(`LiteLLMAdapter "${this.id}" request to ${url} failed`, {
        cause,
      });
    }

    if (!response.ok) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" received HTTP ${response.status} from ${url}`,
        { statusCode: response.status },
      );
    }

    // `response.text()` is a network read, not just a data transform — a
    // connection that dies mid-body (truncated chunked response, server
    // process killed after headers) makes undici reject `.text()` with a
    // bare `TypeError` ("terminated"/"aborted"), not a `SyntaxError`. That
    // has to land inside this try/catch too (Review Round-1 blocker 1),
    // otherwise it would escape `invoke()` as an untyped error and break
    // `errors.ts:22-27`'s "adapters only ever throw AdapterInvokeError"
    // contract.
    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (cause) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" failed to read response body from ${url}`,
        { cause },
      );
    }

    const latencyMs = Math.round(performance.now() - requestStartedAt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (cause) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" response body from ${url} was not valid JSON`,
        { cause },
      );
    }

    // Extract content based on API style.
    const content =
      apiStyle === "anthropic"
        ? extractAnthropicContent(parsed)
        : extractOpenAIContent(parsed);

    if (content === undefined) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" response from ${url} did not match the expected ${responseShapeError}`,
      );
    }

    // Usage parsing is fail-safe by construction (`extractAnthropicUsage`/
    // `extractOpenAIUsage` never throw — malformed/missing usage yields
    // `undefined`, not an error), so no try/catch is needed here; a bad
    // usage block must never take down an otherwise-successful `invoke()`.
    const usage =
      apiStyle === "anthropic" ? extractAnthropicUsage(parsed) : extractOpenAIUsage(parsed);

    return {
      content,
      provider: providerId,
      model: extractModel(parsed) ?? model,
      ...(usage !== undefined ? { usage } : {}),
      latencyMs,
    };
  }

  /**
   * Real network probe (PRD §5 / §8.5 "listed ≠ callable") — `GET
   * ${base_url}/health/liveliness`, LiteLLM's documented no-auth,
   * no-upstream-call liveness endpoint (see file header). Never degrades
   * into a config-presence check when `base_url` *is* configured; the only
   * case that skips the network call is "there's no `base_url` to call at
   * all", which is reported as `available: false` with a reason, not a
   * silent `true`.
   */
  async checkAvailability(): Promise<AvailabilityResult> {
    const checkedAt = new Date().toISOString();
    const baseUrl = this.config.base_url;
    if (baseUrl === undefined || baseUrl === "") {
      return {
        available: false,
        reason: `provider "${this.id}" has no base_url configured`,
        checkedAt,
      };
    }

    const url = `${normalizeBaseUrl(baseUrl)}/health/liveliness`;
    try {
      const response = await fetch(url, { method: "GET", headers: this.buildHeaders() });
      return {
        available: response.ok,
        reason: response.ok ? undefined : `HTTP ${response.status} from ${url}`,
        checkedAt,
      };
    } catch (cause) {
      return {
        available: false,
        reason: `request to ${url} failed: ${describeCause(cause)}`,
        checkedAt,
      };
    }
  }

  /**
   * Builds request headers.
   *
   * - OpenAI style: `Authorization: Bearer <api_key>`
   * - Anthropic style: `x-api-key: <api_key>` + `anthropic-version: 2023-06-01`
   *
   * Omits auth headers entirely when `api_key` is unset rather than
   * interpolating `undefined` into the header value (PRD §5 / §8.5#6 —
   * never sends a `Bearer undefined` header).
   */
  private buildHeaders(): Record<string, string> {
    const apiStyle = this.config.api_style ?? "openai";
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (this.config.api_key !== undefined && this.config.api_key !== "") {
      if (apiStyle === "anthropic") {
        // Anthropic style: x-api-key header + required version header.
        headers["x-api-key"] = this.config.api_key;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        // OpenAI style: Authorization: Bearer header.
        headers["Authorization"] = `Bearer ${this.config.api_key}`;
      }
    }
    return headers;
  }

  private requireBaseUrl(): string {
    const { base_url: baseUrl } = this.config;
    if (baseUrl === undefined || baseUrl === "") {
      throw new AdapterInvokeError(`LiteLLMAdapter "${this.id}" has no base_url configured`);
    }
    return baseUrl;
  }

  private requireModel(): string {
    const { model } = this.config;
    if (model === undefined || model === "") {
      throw new AdapterInvokeError(`LiteLLMAdapter "${this.id}" has no model configured`);
    }
    return model;
  }

  /**
   * `id` is typed as a non-optional `string` in the constructor, so this is
   * belt-and-suspenders rather than a case that should ever trip in
   * practice (`config.ts` always passes the provider's own map key as
   * `id`) — but `InvokeResult.provider` carries the same non-empty
   * invariant as `.model` (`types.ts:72`), so it gets the same runtime
   * guard rather than trusting the type alone (Review Round-1 blocker 2).
   */
  private requireProviderId(): string {
    if (typeof this.id !== "string" || this.id.trim().length === 0) {
      throw new AdapterInvokeError("LiteLLMAdapter constructed with an empty/missing provider id");
    }
    return this.id;
  }
}
