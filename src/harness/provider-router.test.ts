import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "./adapter-registry.js";
import { AdapterNotRegisteredError, RoleNotBoundError } from "./errors.js";
import { ProviderRouter } from "./provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "./types.js";
import type { RoleBinding } from "../profile/loader.js";

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

describe("ProviderRouter — normal routing", () => {
  it("routes a bound role to the adapter registered under its provider id", () => {
    const registry = new AdapterRegistry();
    const adapter = fakeAdapter("provider-a");
    registry.register(adapter);

    const roles: Record<string, RoleBinding> = { coder: { provider: "provider-a" } };
    const router = new ProviderRouter(roles, registry);

    expect(router.route("coder")).toBe(adapter);
  });
});

describe("ProviderRouter — real routing to a second provider, zero source changes (PRD §8 hardest item)", () => {
  it("registering a second fake adapter under a different id and rebinding a role's provider routes to the new adapter", () => {
    const registry = new AdapterRegistry();
    const adapterA = fakeAdapter("provider-a");
    const adapterB = fakeAdapter("provider-b");
    registry.register(adapterA);
    registry.register(adapterB);

    // Router bound to provider-a first.
    const rolesBoundToA: Record<string, RoleBinding> = { coder: { provider: "provider-a" } };
    const routerToA = new ProviderRouter(rolesBoundToA, registry);
    expect(routerToA.route("coder")).toBe(adapterA);

    // Same registry, same ProviderRouter class (no edits to provider-router.ts),
    // but the role's provider binding now points at the second adapter.
    const rolesBoundToB: Record<string, RoleBinding> = { coder: { provider: "provider-b" } };
    const routerToB = new ProviderRouter(rolesBoundToB, registry);

    const routed = routerToB.route("coder");
    expect(routed).toBe(adapterB);
    expect(routed).not.toBe(adapterA);
    expect(routed.id).toBe("provider-b");
  });
});

describe("ProviderRouter — error paths", () => {
  it("throws RoleNotBoundError when the role has no entry in roles config", () => {
    const registry = new AdapterRegistry();
    const roles: Record<string, RoleBinding> = { coder: { provider: "provider-a" } };
    const router = new ProviderRouter(roles, registry);

    expect(() => router.route("tester")).toThrow(RoleNotBoundError);
  });

  it("throws AdapterNotRegisteredError when the bound provider id has no adapter in the registry", () => {
    const registry = new AdapterRegistry(); // nothing registered
    const roles: Record<string, RoleBinding> = { coder: { provider: "provider-a" } };
    const router = new ProviderRouter(roles, registry);

    expect(() => router.route("coder")).toThrow(AdapterNotRegisteredError);
  });
});
