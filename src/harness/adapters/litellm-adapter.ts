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
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../types.js";

/**
 * Shape of the constructor config this adapter needs — a subset of
 * `ProfileConfig["providers"][id]` (`src/profile/loader.ts`'s
 * `ProviderConfig`) after `${ENV}` substitution has already run. Kept as
 * its own local type (not importing `ProviderConfig` directly) because
 * `LiteLLMAdapter` only cares about these three fields, not `kind`/`cmd`
 * (those are `harness/config.ts`'s dispatch concern, PRD §5).
 */
export interface LiteLLMAdapterConfig {
  base_url?: string;
  api_key?: string;
  model?: string;
}

/** Minimal shape this adapter reads out of an OpenAI-compatible chat/completions response. */
interface ChatCompletionsResponse {
  model?: unknown;
  choices?: unknown;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Strips trailing slashes so `${base_url}/chat/completions` never produces
 * a doubled `//` (PRD §5 / §8.5#6 — Verity's real-world footgun when
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
function extractContent(parsed: unknown): string | undefined {
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
    const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: req.prompt }],
        }),
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
    // has to land inside this try/catch too (Zorro round-1 blocker 1),
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (cause) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" response body from ${url} was not valid JSON`,
        { cause },
      );
    }

    const content = extractContent(parsed);
    if (content === undefined) {
      throw new AdapterInvokeError(
        `LiteLLMAdapter "${this.id}" response from ${url} did not match the expected ` +
          `chat/completions shape (choices[0].message.content)`,
      );
    }

    return {
      content,
      provider: providerId,
      model: extractModel(parsed) ?? model,
    };
  }

  /**
   * Real network probe (PRD §5 / §8.5 "列表可见≠可调用") — `GET
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
   * Builds request headers. Omits `Authorization` entirely when `api_key`
   * is unset rather than interpolating `undefined` into the header value
   * (PRD §5 / §8.5#6 — never sends a `Bearer undefined` header).
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.api_key !== undefined && this.config.api_key !== "") {
      headers["Authorization"] = `Bearer ${this.config.api_key}`;
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
   * guard rather than trusting the type alone (Zorro round-1 blocker 2).
   */
  private requireProviderId(): string {
    if (typeof this.id !== "string" || this.id.trim().length === 0) {
      throw new AdapterInvokeError("LiteLLMAdapter constructed with an empty/missing provider id");
    }
    return this.id;
  }
}
