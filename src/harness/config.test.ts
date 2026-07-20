import { describe, expect, it } from "vitest";
import { buildAdapterRegistry } from "./config.js";
import { LiteLLMAdapter } from "./adapters/litellm-adapter.js";
import { loadProfile } from "../profile/loader.js";
import type { ProfileConfig } from "../profile/loader.js";

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
