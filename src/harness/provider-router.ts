/**
 * `ProviderRouter` — role → provider id → `ModelAdapter`, and nothing
 * else (PRD §5 / §9.1, DESIGN §7, §8.5#1).
 *
 * This is the file the PRD's hardest acceptance item (§8 "ProviderRouter
 * real routing") is about: adding a new provider must never require touching
 * this file again. That's why it takes `roles` (just the slice of
 * `ProfileConfig` it needs — PRD §5's "explicitly pass only the dependencies
 * needed, not the whole object", matching A1's `PromptComposer`/`MemoryStore` style) and an
 * `AdapterRegistry` it already knows nothing about the contents of. It
 * performs one lookup, does zero I/O, and never references any concrete
 * `ModelAdapter` implementation (`LiteLLMAdapter`, `ClaudeCliAdapter`,
 * ...). Actually *constructing* adapters for a given provider id is
 * `harness/config.ts`'s job (B4), not this file's — see PRD §9.1 for why
 * that split was chosen over an alternative (a factory map owned by the
 * router itself).
 */

import type { AdapterRegistry } from "./adapter-registry.js";
import { AdapterNotRegisteredError, RoleNotBoundError } from "./errors.js";
import type { ModelAdapter } from "./types.js";
import type { ProfileConfig } from "../profile/loader.js";
import type { Role } from "../shared/types.js";

export class ProviderRouter {
  constructor(
    private readonly roles: ProfileConfig["roles"],
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * Resolves `role` to a `ModelAdapter`:
   * 1. `role` has no entry in `roles` → `RoleNotBoundError`.
   * 2. `roles[role].provider` has no adapter in `registry` → `AdapterNotRegisteredError`.
   * 3. Otherwise, the registered adapter.
   */
  route(role: Role): ModelAdapter {
    const binding = this.roles[role];
    if (binding === undefined) {
      throw new RoleNotBoundError(role);
    }

    const adapter = this.registry.get(binding.provider);
    if (adapter === undefined) {
      throw new AdapterNotRegisteredError(binding.provider);
    }

    return adapter;
  }
}
