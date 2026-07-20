import type { MemoryStore } from "./store.js";
import { nowIso } from "./util.js";

/**
 * Default values used when a `system_config` key has never been written.
 * These are *engine* defaults, not profile config — a profile can override
 * them by writing into `system_config` (e.g. via a future CLI command),
 * which `SystemConfig.get()` then prefers over the hardcoded default.
 */
const DEFAULTS: Readonly<Record<string, string>> = {
  default_stale_days: "30",
  default_reject_threshold: "2",
};

/**
 * Read/write access to the `system_config` key-value table (DESIGN §5),
 * with engine-level fallback defaults for the keys aeloop actually reads
 * (`default_stale_days`, consumed by `StalenessEngine`; `default_reject_threshold`,
 * reserved for the Loop layer's escalation threshold — not read by anything
 * in this increment, exposed here for A4 to reuse without re-deriving the
 * default).
 */
export class SystemConfig {
  constructor(private readonly store: MemoryStore) {}

  /** Returns the stored value, falling back to `DEFAULTS[key]` if unset. Neither found → `undefined`. */
  get(key: string): string | undefined {
    const entry = this.store.getConfigEntry(key);
    if (entry) return entry.value;
    return DEFAULTS[key];
  }

  /** Persists `key`/`value`, stamping `updated_at` (upsert — PRD §9.0's #7 "aeloop 新补" column). */
  set(key: string, value: string, now: string = nowIso()): void {
    this.store.setConfigEntry(key, value, now);
  }

  /**
   * `default_stale_days` as a number, or `null` if the configured value
   * (stored or default) isn't parseable — callers (`StalenessEngine`)
   * treat `null` as "no threshold configured, never stale" rather than
   * throwing, since this is a soft governance knob, not a hard invariant.
   */
  getDefaultStaleDays(): number | null {
    return parseConfiguredNumber(this.get("default_stale_days"));
  }

  /** Same contract as `getDefaultStaleDays()`, for `default_reject_threshold`. */
  getDefaultRejectThreshold(): number | null {
    return parseConfiguredNumber(this.get("default_reject_threshold"));
  }
}

function parseConfiguredNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
