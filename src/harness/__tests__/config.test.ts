import { describe, expect, it } from "vitest";
import { buildAdapterRegistry } from "../config.js";
import { LiteLLMAdapter } from "../adapters/litellm-adapter.js";
import { ClaudeCliAdapter } from "../adapters/claude-cli-adapter.js";
import { CodexCliAdapter } from "../adapters/codex-cli-adapter.js";
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

// A3 (PRD §5, docs/feature/a3-cli-bridge/PRD.md): `buildAdapterRegistry`'s
// `cli-bridge` branch now dispatches on `providerConfig.cmd` and
// constructs a real `ClaudeCliAdapter`/`CodexCliAdapter` — no invoke()/
// checkAvailability() call anywhere in this file, only construction +
// registry lookups, so none of these tests spawn a real subprocess (the
// two adapters' constructors do no I/O; `spawn` only ever happens inside
// `invoke()`/`checkAvailability()`, neither of which is called here).
describe("buildAdapterRegistry — cli-bridge provider (A3)", () => {
  it('constructs and registers a ClaudeCliAdapter for a cli-bridge provider entry with cmd: "claude"', () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        "claude-cli": { kind: "cli-bridge", cmd: "claude" },
      },
      roles: { coder: { provider: "claude-cli" } },
    };

    const registry = buildAdapterRegistry(config);
    const adapter = registry.get("claude-cli");

    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
    expect(adapter?.id).toBe("claude-cli");
    expect(adapter?.kind).toBe("cli-bridge");
  });

  it('constructs and registers a CodexCliAdapter for a cli-bridge provider entry with cmd: "codex"', () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        "codex-cli": { kind: "cli-bridge", cmd: "codex" },
      },
      roles: { tester: { provider: "codex-cli" } },
    };

    const registry = buildAdapterRegistry(config);
    const adapter = registry.get("codex-cli");

    expect(adapter).toBeInstanceOf(CodexCliAdapter);
    expect(adapter?.id).toBe("codex-cli");
    expect(adapter?.kind).toBe("cli-bridge");
  });

  it('throws InvalidProviderConfigError for an unrecognized cli-bridge "cmd" value, not a silent no-op', () => {
    const config: ProfileConfig = {
      profile: "fixture",
      providers: {
        mystery: { kind: "cli-bridge", cmd: "gemini" },
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
      expect((err as Error).message).toContain("gemini");
    }
  });
});

// 🔴 Deliberately supersedes A2's assertion for this same test (Zorro:
// diff this block against `git log -p -- src/harness/__tests__/config.test.ts`
// to confirm it's an intentional PRD-called-out change, not a regression) —
// A2's `buildAdapterRegistry()` explicitly skipped `cli-bridge` construction
// (PRD §5 for A2), so running it against the real, committed
// `profiles/subscription/config.yaml` (both providers `cli-bridge`) was
// *expected* to return an EMPTY `AdapterRegistry`, and A2 had a test pinning
// exactly that down. A3 fills in the `cli-bridge` construction branch (see
// `config.ts`), so the same real config now populates the registry — the
// assertion below intentionally inverts A2's "stays empty" expectation into
// "both providers now resolve to real adapters", per A3 PRD §5/§8's explicit
// acceptance item "打破 A2 断言的地方被显式记录".
describe("buildAdapterRegistry — real subscription profile (both providers cli-bridge, now populated by A3)", () => {
  it("constructs real ClaudeCliAdapter/CodexCliAdapter instances for both real providers — A2's 'stays empty' expectation for this exact config no longer holds now that the cli-bridge branch is implemented", () => {
    const result = loadProfile("subscription");
    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    // Sanity: confirm the fixture this test relies on is really what the
    // PRD describes — both real subscription providers are cli-bridge.
    expect(result.config.providers["claude-cli"]?.kind).toBe("cli-bridge");
    expect(result.config.providers["codex-cli"]?.kind).toBe("cli-bridge");

    const registry = buildAdapterRegistry(result.config);

    const claudeAdapter = registry.get("claude-cli");
    const codexAdapter = registry.get("codex-cli");

    expect(registry.has("claude-cli")).toBe(true);
    expect(registry.has("codex-cli")).toBe(true);
    expect(claudeAdapter).toBeInstanceOf(ClaudeCliAdapter);
    expect(codexAdapter).toBeInstanceOf(CodexCliAdapter);
    expect(claudeAdapter?.id).toBe("claude-cli");
    expect(codexAdapter?.id).toBe("codex-cli");
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
