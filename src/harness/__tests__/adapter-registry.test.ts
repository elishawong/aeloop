import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../adapter-registry.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../types.js";

/**
 * Minimal fake adapter — enough shape to prove `AdapterRegistry` treats
 * `ModelAdapter` as an opaque value, never inspecting anything beyond
 * `.id`.
 */
function fakeAdapter(id: string): ModelAdapter {
  return {
    id,
    kind: "direct-api",
    async checkAvailability(): Promise<AvailabilityResult> {
      return { available: true, checkedAt: "2026-07-20T00:00:00.000Z" };
    },
    async invoke(_req: InvokeRequest): Promise<InvokeResult> {
      return { content: `from ${id}`, provider: id, model: "fake-model" };
    },
  };
}

describe("AdapterRegistry", () => {
  it("register + get round-trips the same adapter instance", () => {
    const registry = new AdapterRegistry();
    const adapter = fakeAdapter("fake-a");

    registry.register(adapter);

    expect(registry.get("fake-a")).toBe(adapter);
  });

  it("get returns undefined for an id that was never registered", () => {
    const registry = new AdapterRegistry();

    expect(registry.get("nope")).toBeUndefined();
  });

  it("has reflects registration state", () => {
    const registry = new AdapterRegistry();

    expect(registry.has("fake-a")).toBe(false);

    registry.register(fakeAdapter("fake-a"));

    expect(registry.has("fake-a")).toBe(true);
  });

  it("registering a second adapter under an id already in use overwrites the first, without throwing (PRD §9.4)", () => {
    const registry = new AdapterRegistry();
    const first = fakeAdapter("dup");
    const second = fakeAdapter("dup");

    registry.register(first);
    expect(() => registry.register(second)).not.toThrow();

    expect(registry.get("dup")).toBe(second);
    expect(registry.get("dup")).not.toBe(first);
  });
});
