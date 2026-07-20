import { describe, expect, it } from "vitest";
import { buildAdapterRegistry } from "../config.js";
import { LiteLLMAdapter } from "../adapters/litellm-adapter.js";
import { InvalidProviderConfigError } from "../errors.js";
import { loadProfile } from "../../profile/loader.js";
import type { ProfileConfig, ProviderConfig } from "../../profile/loader.js";

describe("buildAdapterRegistry — direct-api provider", () => {
  it("constructs and registers a LiteLLMAdapter for a direct-api provider entry", () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        litellm: {
          kind: "direct-api",
          base_url: "http://127.0.0.1:9999",
          api_key: "sk-test",
          model: "gpt-4o-mini",
        },
      },
      roles: { coder: { provider: "litellm" } },
    };

    const registry = buildAdapterRegistry(config);
    const adapter = registry.get("litellm");

    expect(adapter).toBeInstanceOf(LiteLLMAdapter);
    expect(adapter?.id).toBe("litellm");
    expect(adapter?.kind).toBe("direct-api");
  });
});

describe("buildAdapterRegistry — real helix profile (both providers cli-bridge)", () => {
  it("returns an empty AdapterRegistry — this is expected behavior (PRD §5), not a bug to fix by adding a placeholder cli-bridge adapter", () => {
    const result = loadProfile("helix");
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    // Sanity: confirm the fixture this test relies on is really what the
    // PRD describes — both real helix providers are cli-bridge.
    expect(result.config.providers["claude-cli"]?.kind).toBe("cli-bridge");
    expect(result.config.providers["codex-cli"]?.kind).toBe("cli-bridge");

    const registry = buildAdapterRegistry(result.config);

    expect(registry.has("claude-cli")).toBe(false);
    expect(registry.has("codex-cli")).toBe(false);
    expect(registry.get("claude-cli")).toBeUndefined();
    expect(registry.get("codex-cli")).toBeUndefined();
  });
});

// Zorro round-1 🟡 (指挥官已批「一起修」): `profile/loader.ts:147` explicitly
// leaves full schema validation of `providers`' nested shapes to this layer
// — these three cases cover the malformed-entry shapes that would
// previously either crash with a raw `TypeError` (null/non-object entry,
// non-string `base_url` surfacing later inside `LiteLLMAdapter`) or vanish
// silently with no signal at all (unknown `kind`).
describe("buildAdapterRegistry — malformed provider entries (Zorro round-1 🟡)", () => {
  it("a null provider entry (malformed yaml: `providers: { x: null }`) throws InvalidProviderConfigError, not a raw TypeError", () => {
    const config = {
      profile: "fixture",
      providers: { x: null as unknown as ProviderConfig },
      roles: {},
    } as ProfileConfig;

    expect(() => buildAdapterRegistry(config)).toThrow(InvalidProviderConfigError);
    try {
      buildAdapterRegistry(config);
      expect.unreachable("buildAdapterRegistry should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProviderConfigError);
      expect(err).not.toBeInstanceOf(TypeError);
      expect((err as InvalidProviderConfigError).providerId).toBe("x");
    }
  });

  it("a non-string base_url (e.g. a number) throws InvalidProviderConfigError at build time, not later inside LiteLLMAdapter's .replace()", () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        litellm: {
          kind: "direct-api",
          base_url: 12345 as unknown as string,
          model: "gpt-4o-mini",
        },
      },
      roles: { coder: { provider: "litellm" } },
    };

    expect(() => buildAdapterRegistry(config)).toThrow(InvalidProviderConfigError);
    try {
      buildAdapterRegistry(config);
      expect.unreachable("buildAdapterRegistry should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProviderConfigError);
      expect((err as InvalidProviderConfigError).providerId).toBe("litellm");
      expect((err as Error).message).toContain("base_url");
    }
  });

  it("an unrecognized kind is observable (throws InvalidProviderConfigError) instead of silently being skipped", () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        mystery: {
          kind: "direct-apu" as unknown as ProviderConfig["kind"], // typo'd kind
          base_url: "http://127.0.0.1:9999",
          model: "gpt-4o-mini",
        },
      },
      roles: { coder: { provider: "mystery" } },
    };

    expect(() => buildAdapterRegistry(config)).toThrow(InvalidProviderConfigError);
    try {
      buildAdapterRegistry(config);
      expect.unreachable("buildAdapterRegistry should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProviderConfigError);
      expect((err as InvalidProviderConfigError).providerId).toBe("mystery");
      expect((err as Error).message).toContain("direct-apu");
    }
  });
});
