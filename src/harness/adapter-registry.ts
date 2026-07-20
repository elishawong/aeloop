/**
 * `AdapterRegistry` — a pure id → `ModelAdapter` instance map (PRD §5). No
 * provider-specific knowledge lives here: it doesn't know what a
 * `LiteLLMAdapter` is, doesn't construct anything, doesn't know about
 * `ProfileConfig`. Constructing real adapters from config is
 * `harness/config.ts`'s job (B4); this class only stores and retrieves
 * whatever `ModelAdapter` instances it's handed.
 */

import type { ModelAdapter } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, ModelAdapter>();

  /**
   * Stores `adapter` under `adapter.id`. Registering a second adapter
   * under an `id` already in use **overwrites** the first, silently — no
   * error, matching native `Map#set` semantics (PRD §9.4: undecided,
   * non-blocking, "overwrite, no error" is the documented default until a
   * real need for stricter behavior shows up).
   */
  register(adapter: ModelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ModelAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }
}
