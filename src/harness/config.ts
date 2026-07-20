/**
 * `buildAdapterRegistry` — the one place that turns a `ProfileConfig`'s
 * `providers` map into real `ModelAdapter` instances and registers them
 * (PRD §5 / §9.1). This is "the file you touch to add a new provider" —
 * deliberately *not* `provider-router.ts`, which stays a zero-I/O lookup
 * that never references a concrete adapter class (see PRD §9.1 for why
 * that split was chosen).
 */

import { AdapterRegistry } from "./adapter-registry.js";
import { LiteLLMAdapter } from "./adapters/litellm-adapter.js";
import type { ProfileConfig, ProviderConfig } from "../profile/loader.js";

/**
 * `ProviderConfig` (src/profile/loader.ts) has no typed `model` field — it's
 * only reachable through the index signature as `unknown`. Extracted
 * explicitly here rather than passed straight through, so `LiteLLMAdapter`'s
 * constructor never receives an `unknown` where it expects `string |
 * undefined`.
 */
function extractModel(providerConfig: ProviderConfig): string | undefined {
  const model = providerConfig["model"];
  return typeof model === "string" ? model : undefined;
}

/**
 * Walks `config.providers` and, per provider `kind`, constructs + registers
 * a real `ModelAdapter`:
 *
 * - `"direct-api"` → `LiteLLMAdapter` (the only direct-api adapter this
 *   increment knows how to build).
 * - `"cli-bridge"` → **explicitly skipped**. A3 adds the
 *   `ClaudeCliAdapter`/`CodexCliAdapter` construction branch here — this
 *   increment neither errors nor fabricates a placeholder adapter for a
 *   cli-bridge provider id.
 *
 * Running this against the real `profiles/helix/config.yaml` (both of its
 * providers are `cli-bridge`) is expected to return an **empty**
 * `AdapterRegistry` — that's the predicate `config.test.ts` pins down, not
 * a bug to "fix" by adding a placeholder branch later.
 */
export function buildAdapterRegistry(config: ProfileConfig): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    switch (providerConfig.kind) {
      case "direct-api":
        registry.register(
          new LiteLLMAdapter(id, {
            base_url: providerConfig.base_url,
            api_key: providerConfig.api_key,
            model: extractModel(providerConfig),
          }),
        );
        break;
      case "cli-bridge":
        // A3 补 ClaudeCliAdapter/CodexCliAdapter 的构造分支于此 —— 本增量
        // 显式跳过,不报错、不造一个假 adapter (PRD §5)。
        break;
    }
  }

  return registry;
}
