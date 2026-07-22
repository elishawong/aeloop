/**
 * Core types for the Harness layer (src/harness/*), docs/DESIGN.md §7 +
 * PRD §5 (docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md,
 * A2's `ModelAdapter`/`InvokeRequest`/`InvokeResult`/`AvailabilityResult`;
 * docs/feature/a3-cli-bridge/PRD.md §5, A3's real `ToolCallRecord`/
 * `ToolExecChecked` shapes replacing A2's placeholder).
 *
 * This file is interface/type declarations only — no implementation. It's
 * the contract that `ProviderRouter`, `AdapterRegistry`, every concrete
 * `ModelAdapter` (`LiteLLMAdapter` here in A2; `ClaudeCliAdapter` /
 * `CodexCliAdapter` in A3), and `SchemaValidator` are all written against.
 */

import type { ISODateString, Role } from "../shared/types.js";

/**
 * A model-agnostic adapter: something that can be asked "are you
 * available?" and "invoke yourself with this prompt". `ProviderRouter`
 * only ever talks to callers through this interface — it never knows
 * whether a given `id` is backed by a direct HTTP API (`LiteLLMAdapter`,
 * A2) or a CLI subprocess bridge (`ClaudeCliAdapter`/`CodexCliAdapter`,
 * A3).
 */
export interface ModelAdapter {
  /** Stable identifier this adapter is registered under, e.g. "litellm". */
  readonly id: string;
  /**
   * `"direct-api"` adapters call an HTTP endpoint directly (A2's
   * `LiteLLMAdapter`). `"cli-bridge"` adapters shell out to a CLI
   * subprocess (A3) and can therefore expose `toolTrace()` for real
   * tool-execution verification — a direct-api adapter has no such trace
   * to give.
   */
  readonly kind: "direct-api" | "cli-bridge";
  /**
   * Must perform a real check (network request for direct-api, subprocess
   * probe for cli-bridge) — DESIGN §7's "deepseek listed ≠ callable" lesson:
   * an adapter existing in config is not the same as it being callable
   * right now. Never allowed to degrade into "config has the fields I
   * need, so I'll just say available: true".
   */
  checkAvailability(): Promise<AvailabilityResult>;
  /** Invoke the underlying model with `req`, returning its raw output. */
  invoke(req: InvokeRequest): Promise<InvokeResult>;
  /**
   * cli-bridge-only: returns the tool-call trace `ToolExecVerifier` (A3)
   * checks against. Optional because a direct-api adapter (A2's
   * `LiteLLMAdapter`) has no such trace and simply omits this method
   * rather than implementing it to return an empty/fake array.
   */
  toolTrace?(): ToolCallRecord[];
}

/**
 * `prompt` is the already-composed string from `PromptComposer.compose()`
 * (src/prompt/composer.ts) — the Harness layer receives a finished prompt,
 * it does not know how Context/Prompt built it.
 */
export interface InvokeRequest {
  role: Role;
  prompt: string;
}

/**
 * `ToolExecVerifier`'s verdict (`checkToolExecution()`, `src/harness/
 * tool-exec-verifier.ts`, A3 PRD §5). v2 (issue #11): when a claim
 * asserting `verifiedBy: "tool_execution"` also declares a non-empty
 * `toolsUsed: string[]` (`ClaimSchema`, `src/prompt/schema.ts`), every
 * declared tool name must actually appear in the adapter's trace —
 * `"pass"` only if all of them do, `"fail"` otherwise (real per-tool
 * subset matching, not just "some tool ran"). Legacy compatibility: a
 * `tool_execution` claim that omits `toolsUsed` (pre-v2 callers, or a
 * model that just doesn't self-report it) falls back to v1's
 * existence-only check — `"pass"` if the trace is non-empty at all,
 * `"fail"` if empty (the "claimed ≠ done" case this whole verifier
 * exists to catch). `"na"` either way — nothing to verify (no claim
 * asserted tool_execution, or `content` couldn't even be parsed as a
 * claims-bearing shape).
 */
export type ToolExecChecked = "pass" | "fail" | "na";

/**
 * Where a `ProviderUsage` value came from. This slice (issue #48) only ever
 * produces `"provider"` — a value read verbatim out of a provider's own
 * response body. `"estimate"` is reserved for a future slice that derives
 * usage locally (e.g. tokenizing `content` when a provider gives no usage
 * block at all); no adapter sets it yet, and none of this slice's parsing
 * helpers fabricate one. Keeping the literal in the union now (rather than
 * adding it later) means `ProviderUsage.source` doesn't need a breaking
 * widen when that estimator lands.
 */
export type UsageSource = "provider" | "estimate";

/**
 * Normalized token-usage counters for one `invoke()` call, issue #48
 * (`docs/feature/issue-48-provider-usage-telemetry/README.md` — see adapter
 * files for the per-provider parsing contract). Every counter is optional and independent
 * — a provider that reports some fields and omits others (e.g. Anthropic
 * never sends a `total_tokens`-equivalent) must have exactly the fields it
 * actually reported populated, never a guessed/zero-filled value for the
 * rest (PRD's "omit unknown values" / fail-safe posture, same honesty
 * stance as `InvokeResult.model`'s "unknown" fallback documented above).
 *
 * `cacheReadTokens`/`cacheWriteTokens` are Anthropic-native concepts
 * (`cache_read_input_tokens`/`cache_creation_input_tokens`) that some
 * OpenAI-compatible LiteLLM responses also surface (either nested under
 * `prompt_tokens_details.cached_tokens` for reads, or as the same
 * Anthropic-named top-level fields when LiteLLM is proxying an Anthropic
 * model through its OpenAI-compatible endpoint) — normalized into this one
 * shared shape regardless of which wire format they arrived in.
 *
 * `totalTokens` is populated only when it can be stated without guessing:
 * either the provider handed back an explicit total (OpenAI's
 * `total_tokens`), or both `inputTokens` and `outputTokens` are present and
 * their sum is used. Cache tokens are deliberately never folded into this
 * sum — cache accounting isn't uniform across providers/response shapes (in
 * some shapes a cache-read count is already included inside the reported
 * input tokens, in others it's additional), so adding it in would risk a
 * silently wrong total. Cache counts are always available separately via
 * `cacheReadTokens`/`cacheWriteTokens` for a caller that wants to reason
 * about them explicitly.
 */
export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Always `"provider"` in this slice — see `UsageSource` doc. */
  source: UsageSource;
}

/**
 * PRD §5 / DESIGN §8.5#4: `provider`/`model` must always be populated (not
 * optional, not empty-string) — this is what lets audit/logging answer
 * "who actually responded" instead of a prior internal implementation's M3 gap where `InvokeResult`
 * only carried `content`/`httpStatus`.
 *
 * `toolExecChecked` is an A3 field. A2's `LiteLLMAdapter` (`kind:
 * "direct-api"`) never sets it — leaving it `undefined` is the honest
 * signal ("not checked, because this adapter can't check"). A3's
 * `ClaudeCliAdapter`/`CodexCliAdapter` (`kind: "cli-bridge"`) *do* set it,
 * including the explicit value `"na"` when there's simply nothing to
 * verify — that's a different, stronger claim than `undefined` ("I have
 * verification capability, and I used it: there was nothing to check"),
 * so a cli-bridge adapter must never leave this field `undefined` the way
 * a direct-api adapter does (A3 PRD §4).
 *
 * `usage`/`latencyMs` are issue #48 fields, both optional and additive —
 * every existing adapter/consumer that never sets or reads them keeps
 * working unchanged (backward-compatible extension, not a breaking one).
 * `usage` is `undefined` whenever a provider's response has no usage block
 * at all, or the block is present but malformed in a way that yields zero
 * readable counters (fail-safe: never thrown, never a fabricated all-zero
 * `ProviderUsage`) — same "leave it honestly unknown" posture as
 * `toolExecChecked`. `latencyMs` is the wall-clock duration of the
 * underlying network round trip (not `invoke()`'s total time, which can
 * include request-building work before and validation after it) — omitted
 * only when an adapter has no round trip to measure at all (none exist
 * yet; every current adapter's `invoke()` does one).
 */
export interface InvokeResult {
  content: string;
  provider: string;
  model: string;
  toolExecChecked?: ToolExecChecked;
  usage?: ProviderUsage;
  latencyMs?: number;
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
  checkedAt: ISODateString;
}

/**
 * One real tool-call event, extracted from a cli-bridge adapter's raw CLI
 * output (A3 PRD §5) — the uniform shape `CodexCliAdapter`/
 * `ClaudeCliAdapter` both normalize their very different native event
 * streams into, and the only thing `ToolExecVerifier` ever looks at
 * (`trace.length`, never `raw`'s contents).
 */
export interface ToolCallRecord {
  /**
   * Uniform tool identifier. `CodexCliAdapter` fixes this to `"shell"` —
   * codex's `--json` stream only exposes shell-level `command_execution`,
   * it can't distinguish which logical tool ran (spike-findings.md §3.1).
   * `ClaudeCliAdapter` uses the real tool name (`"Bash"`, `"Read"`, ...)
   * straight from its `tool_use` events, which do carry that distinction.
   */
  toolName: string;
  /**
   * 0-based position of this record within the trace collected during one
   * `invoke()` call, in emission order. Establishes "this tool call
   * happened before the final `content` was emitted" — both CLIs' non-
   * interactive event streams are strictly chronological with the final
   * answer always last, so every record collected during one invoke
   * necessarily precedes that invoke's `content` (spike-findings.md §1.4 /
   * A3 PRD §5's "ToolExecVerifier" note on why no extra timestamp
   * comparison is needed).
   */
  sequenceIndex: number;
  /**
   * Did this specific call report success? `CodexCliAdapter`:
   * `exit_code === 0`. `ClaudeCliAdapter`: `tool_result.is_error === false`.
   * `undefined` when the underlying CLI never gave an unambiguous
   * success/failure signal for this call (e.g. a `tool_use` with no
   * matching `tool_result`) — left honestly unknown rather than guessed.
   */
  succeeded?: boolean;
  /**
   * The raw underlying event object(s) this record was built from, kept
   * for debugging/audit only. `ToolExecVerifier` never reads into this —
   * v2 matches only against `toolName` (per-tool subset match when a
   * claim declares `toolsUsed`, existence-only fallback otherwise); no
   * verifier version has ever inspected `raw` (A3 PRD §0 decision 1 /
   * §9.4, refined by issue #11's v2).
   */
  raw: Record<string, unknown>;
}
