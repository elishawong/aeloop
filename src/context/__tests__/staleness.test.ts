import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store.js";
import { SystemConfig } from "../config.js";
import { StalenessEngine } from "../staleness.js";
import type { Memory } from "../types.js";

const openStores: MemoryStore[] = [];
function setup(): { store: MemoryStore; config: SystemConfig; staleness: StalenessEngine } {
  const store = new MemoryStore(":memory:");
  openStores.push(store);
  const config = new SystemConfig(store);
  return { store, config, staleness: new StalenessEngine(config) };
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

function baseMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 1,
    type: "decision",
    title: "T",
    content: "C",
    sourceFile: null,
    tags: [],
    confidenceState: "confirmed",
    staleOverrideDays: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    confirmedAt: null,
    confirmedBy: null,
    ...overrides,
  };
}

describe("StalenessEngine — system_config default", () => {
  it("is not stale when age < default_stale_days", () => {
    const { config, staleness } = setup();
    config.set("default_stale_days", "30");
    const memory = baseMemory({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const asOf = new Date("2026-01-15T00:00:00.000Z"); // 14 days old
    expect(staleness.isStale(memory, asOf)).toBe(false);
  });

  it("is stale when age >= default_stale_days", () => {
    const { config, staleness } = setup();
    config.set("default_stale_days", "30");
    const memory = baseMemory({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const asOf = new Date("2026-02-01T00:00:00.000Z"); // 31 days old
    expect(staleness.isStale(memory, asOf)).toBe(true);
  });

  it("is never stale when no threshold is configured/parseable anywhere", () => {
    const { config, staleness } = setup();
    config.set("default_stale_days", "not-a-number");
    const memory = baseMemory({ updatedAt: "2020-01-01T00:00:00.000Z" });
    const asOf = new Date("2026-01-01T00:00:00.000Z"); // very old, but no threshold
    expect(staleness.isStale(memory, asOf)).toBe(false);
  });
});

describe("StalenessEngine — per-memory stale_override_days wins over system_config", () => {
  it("uses the override even when it makes a memory stale sooner than the default", () => {
    const { config, staleness } = setup();
    config.set("default_stale_days", "365"); // generous default
    const memory = baseMemory({ staleOverrideDays: 5, updatedAt: "2026-01-01T00:00:00.000Z" });
    const asOf = new Date("2026-01-10T00:00:00.000Z"); // 9 days old — stale per override, fresh per default
    expect(staleness.isStale(memory, asOf)).toBe(true);
  });

  it("uses the override even when it makes a memory fresher than the default would", () => {
    const { config, staleness } = setup();
    config.set("default_stale_days", "1"); // aggressive default
    const memory = baseMemory({ staleOverrideDays: 365, updatedAt: "2026-01-01T00:00:00.000Z" });
    const asOf = new Date("2026-01-10T00:00:00.000Z"); // 9 days old — fresh per override, stale per default
    expect(staleness.isStale(memory, asOf)).toBe(false);
  });
});
