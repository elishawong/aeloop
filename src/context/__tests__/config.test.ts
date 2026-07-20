import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store.js";
import { SystemConfig } from "../config.js";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

const openStores: MemoryStore[] = [];
function openConfig(): SystemConfig {
  const store = new MemoryStore(":memory:");
  openStores.push(store);
  return new SystemConfig(store);
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("SystemConfig — engine defaults", () => {
  it("get() falls back to the engine default when a key was never written", () => {
    const config = openConfig();
    expect(config.get("default_stale_days")).toBe("30");
    expect(config.get("default_reject_threshold")).toBe("2");
  });

  it("get() returns undefined for an unknown key with no default", () => {
    const config = openConfig();
    expect(config.get("not_a_real_key")).toBeUndefined();
  });

  it("set() overrides the default, and it sticks across calls", () => {
    const config = openConfig();
    config.set("default_stale_days", "10", NOW);
    expect(config.get("default_stale_days")).toBe("10");
  });

  it("set() stamps updated_at, and a later set() overwrites it", () => {
    const config = openConfig();
    const store = openStores[0]!;
    config.set("default_stale_days", "10", NOW);
    expect(store.getConfigEntry("default_stale_days")?.updatedAt).toBe(NOW);
    config.set("default_stale_days", "20", LATER);
    expect(store.getConfigEntry("default_stale_days")?.updatedAt).toBe(LATER);
    expect(store.getConfigEntry("default_stale_days")?.value).toBe("20");
  });
});

describe("SystemConfig — typed numeric getters", () => {
  it("getDefaultStaleDays() parses the default value", () => {
    const config = openConfig();
    expect(config.getDefaultStaleDays()).toBe(30);
  });

  it("getDefaultRejectThreshold() parses the default value", () => {
    const config = openConfig();
    expect(config.getDefaultRejectThreshold()).toBe(2);
  });

  it("returns null (not NaN, not a throw) when the stored value isn't numeric", () => {
    const config = openConfig();
    config.set("default_stale_days", "not-a-number", NOW);
    expect(config.getDefaultStaleDays()).toBeNull();
  });

  it("reflects an override after set()", () => {
    const config = openConfig();
    config.set("default_stale_days", "45", NOW);
    expect(config.getDefaultStaleDays()).toBe(45);
  });
});
