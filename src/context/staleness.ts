import type { SystemConfig } from "./config.js";
import type { Memory } from "./types.js";

/**
 * Decides whether a memory is stale, per DESIGN §5's comment on
 * `memories.stale_override_days`: "if NULL, read system_config" — a per-memory
 * override wins when set; otherwise fall back to the engine-wide
 * `system_config.default_stale_days`.
 *
 * Consumed by `ContextInjector` (B5) to attach a non-filtering "stale"
 * warning — staleness never removes a memory from injection, it only
 * flags it (DESIGN §3 sequence: "stale/unconfirmed tagged with warning").
 */
export class StalenessEngine {
  constructor(private readonly config: SystemConfig) {}

  /**
   * `asOf` defaults to "now" but is an explicit parameter so tests don't
   * need to fake the system clock to exercise boundary conditions.
   */
  isStale(memory: Memory, asOf: Date = new Date()): boolean {
    const thresholdDays = memory.staleOverrideDays ?? this.config.getDefaultStaleDays();
    if (thresholdDays === null) {
      // No threshold anywhere (no per-memory override, no configured/parseable
      // default) — nothing to compare against, so nothing is stale.
      return false;
    }
    const ageDays = ageInDays(memory.updatedAt, asOf);
    return ageDays >= thresholdDays;
  }
}

function ageInDays(updatedAtIso: string, asOf: Date): number {
  const updatedAtMs = Date.parse(updatedAtIso);
  const ageMs = asOf.getTime() - updatedAtMs;
  return ageMs / (1000 * 60 * 60 * 24);
}
