/**
 * Core types for the Harness layer (src/harness/*), docs/DESIGN.md §7 +
 * PRD §5 (docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md).
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
   * probe for cli-bridge) — DESIGN §7's "deepseek 列表可见≠可调用" lesson:
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
 * PRD §5 / DESIGN §8.5#4: `provider`/`model` must always be populated (not
 * optional, not empty-string) — this is what lets audit/logging answer
 * "who actually responded" instead of Verity's M3 gap where `InvokeResult`
 * only carried `content`/`httpStatus`.
 *
 * `toolExecChecked` is an A3 field. A2 adapters never set it — leaving it
 * `undefined` is the honest signal ("not checked, because this adapter
 * can't check"), not a stand-in value like `"na"` that would need a reader
 * to already know the A2/A3 distinction to interpret correctly.
 */
export interface InvokeResult {
  content: string;
  provider: string;
  model: string;
  toolExecChecked?: "pass" | "fail" | "na";
}

export interface AvailabilityResult {
  available: boolean;
  reason?: string;
  checkedAt: ISODateString;
}

/**
 * Minimal placeholder — A3 (`ClaudeCliAdapter`/`CodexCliAdapter` +
 * `ToolExecVerifier`) defines the real shape. A2 only needs
 * `ModelAdapter#toolTrace`'s return type to exist and typecheck; no A2
 * adapter implements `toolTrace()` or constructs a `ToolCallRecord`.
 */
export interface ToolCallRecord {
  [key: string]: unknown;
}
