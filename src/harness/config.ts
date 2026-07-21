/**
 * `buildAdapterRegistry` — the one place that turns a `ProfileConfig`'s
 * `providers` map into real `ModelAdapter` instances and registers them
 * (PRD §5 / §9.1). This is "the file you touch to add a new provider" —
 * deliberately *not* `provider-router.ts`, which stays a zero-I/O lookup
 * that never references a concrete adapter class (see PRD §9.1 for why
 * that split was chosen).
 */

import { AdapterRegistry } from "./adapter-registry.js";
import { LiteLLMAdapter } from "./adapters/litellm-adapter.js";
import { ClaudeCliAdapter } from "./adapters/claude-cli-adapter.js";
import { CodexCliAdapter } from "./adapters/codex-cli-adapter.js";
import { InvalidProviderConfigError } from "./errors.js";
import type { ProfileConfig, ProviderConfig } from "../profile/loader.js";

/**
 * `ProviderConfig` (src/profile/loader.ts) has no typed `model` field — it's
 * only reachable through the index signature as `unknown`. Extracted
 * explicitly here rather than passed straight through, so `LiteLLMAdapter`'s
 * constructor never receives an `unknown` where it expects `string |
 * undefined`.
 */
function extractModel(providerConfig: ProviderConfig): string | undefined {
  const model = providerConfig["model"];
  return typeof model === "string" ? model : undefined;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * `providerConfig.bin` (optional) — the actual binary/path `spawn` should
 * target, when it needs to differ from `cmd`. `cmd` stays the *flavor*
 * dispatch key (`"claude"` | `"codex"`, matched by strict equality, never
 * loosened) — `bin`, when present, is purely "spawn this instead", not a
 * second way to pick which adapter class gets built. Motivating use case:
 * `harness-cli.e2e.test.ts` (B6) needs a `cli-bridge` provider to dispatch
 * to `CodexCliAdapter` (so the right JSONL parser is used) while actually
 * spawning a controlled fixture script standing in for the real `codex`
 * binary — `cmd: "codex"` (flavor, unchanged/strict) + `bin: "<absolute
 * path to fake-codex.fixture.mjs>"` (spawn target override) expresses
 * exactly that, with zero ambiguity in either direction. Production
 * `config.yaml` never sets `bin` — `cmd` alone (`"claude"`/`"codex"`,
 * resolved via `PATH` same as any bare command) is both the flavor and the
 * spawn target there, same as before this field existed.
 *
 * Validated the same way `base_url` is just below: present but the wrong
 * shape (not a non-empty string) → `InvalidProviderConfigError`, not a
 * silent fallback to `cmd`.
 */
function extractBin(id: string, providerConfig: ProviderConfig): string | undefined {
  const bin = providerConfig["bin"];
  if (bin === undefined) return undefined;
  if (typeof bin !== "string" || bin.length === 0) {
    throw new InvalidProviderConfigError(
      id,
      `"bin" must be a non-empty string when present, got ${typeof bin === "string" ? "an empty string" : describeType(bin)}`,
    );
  }
  return bin;
}

/**
 * Runtime guard for one `config.providers[id]` entry (Review Round-1 🟡:
 * `profile/loader.ts:147` explicitly leaves nested-shape validation of
 * `providers` to this layer — `loadProfile()`'s `assertProfileConfigShape`
 * only checks that `providers` itself is *a* mapping, not that each entry
 * inside it is well-formed). Statically `providerConfig` is already typed
 * `ProviderConfig` by `ProfileConfig`, but that's an optimistic cast over
 * parsed YAML (`loader.ts:142-144`) — a real `config.yaml` can still hand
 * this `null`, a scalar, or a `base_url` that isn't a string, and none of
 * that should reach `LiteLLMAdapter` un-checked.
 */
function assertValidProviderConfig(
  id: string,
  providerConfig: unknown,
): asserts providerConfig is ProviderConfig {
  if (typeof providerConfig !== "object" || providerConfig === null || Array.isArray(providerConfig)) {
    throw new InvalidProviderConfigError(
      id,
      `expected an object with a "kind" field, got ${describeType(providerConfig)}`,
    );
  }

  const baseUrl = (providerConfig as Record<string, unknown>)["base_url"];
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new InvalidProviderConfigError(id, `"base_url" must be a string, got ${describeType(baseUrl)}`);
  }
}

/**
 * Walks `config.providers` and, per provider `kind`, constructs + registers
 * a real `ModelAdapter`:
 *
 * - `"direct-api"` → `LiteLLMAdapter` (the only direct-api adapter this
 *   increment knows how to build).
 * - `"cli-bridge"` → dispatches on `providerConfig.cmd` by **strict
 *   equality** (A3, PRD §5): `"claude"` → `ClaudeCliAdapter`, `"codex"` →
 *   `CodexCliAdapter`, anything else → `InvalidProviderConfigError` (same
 *   "surfaced as a typed error, not a silent no-op" posture as the
 *   unrecognized-`kind` `default` branch below). `cmd` is purely the
 *   *flavor* key here — never loosened to fuzzy/path-based matching, so
 *   production behavior for real `config.yaml` (which always writes
 *   `cmd: claude`/`cmd: codex` literally) can never be affected by
 *   anything test-only.
 *   The *spawn target* handed to the constructed adapter is
 *   `providerConfig.bin ?? cmd` (see `extractBin()`) — `bin` is an
 *   optional override that lets a provider entry say "dispatch as this
 *   flavor, but actually spawn this other path", which is exactly what
 *   `harness-cli.e2e.test.ts` (B6) needs (`cmd: "codex"` + `bin:` an
 *   absolute path to a controlled fixture script standing in for the real
 *   binary). Production `config.yaml` never sets `bin`, so `cmd` alone is
 *   both the flavor and the spawn target there, exactly as before `bin`
 *   existed.
 *
 * Running this against the real `profiles/subscription/config.yaml` (both
 * of its providers are `cli-bridge`, `cmd: claude` / `cmd: codex`, no
 * `bin`) now returns a **populated** `AdapterRegistry` with both adapters —
 * A2 pinned down the opposite behavior (empty registry) as the *expected*
 * placeholder state for that increment; A3 deliberately supersedes that
 * assertion here now that the construction branch is real (see
 * `config.test.ts`'s updated test and its comment for the full "this is
 * not a regression" account).
 */
export function buildAdapterRegistry(config: ProfileConfig): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    // Review Round-1 blocker B2: reject an empty provider-map key before it
    // ever reaches an adapter constructor. `LiteLLMAdapter`/`ClaudeCliAdapter`/
    // `CodexCliAdapter` each also guard against an empty `id` at invoke()
    // time (`requireProviderId()`) as a last line of defense, but a bad
    // `config.yaml` (`providers: { "": {...} }`) should fail loudly here,
    // at construction time, not silently produce an adapter that would
    // only reveal the problem the first time something calls invoke().
    if (id.trim().length === 0) {
      throw new InvalidProviderConfigError(id, `provider map key must be a non-empty string, got ${JSON.stringify(id)}`);
    }
    assertValidProviderConfig(id, providerConfig);

    switch (providerConfig.kind) {
      case "direct-api":
        registry.register(
          new LiteLLMAdapter(id, {
            base_url: providerConfig.base_url,
            api_key: providerConfig.api_key,
            model: extractModel(providerConfig),
          }),
        );
        break;
      case "cli-bridge": {
        const cmd = providerConfig.cmd;
        const bin = extractBin(id, providerConfig);
        if (cmd === "claude") {
          registry.register(new ClaudeCliAdapter(id, { cmd: bin ?? cmd }));
          break;
        }
        if (cmd === "codex") {
          registry.register(new CodexCliAdapter(id, { cmd: bin ?? cmd }));
          break;
        }
        throw new InvalidProviderConfigError(
          id,
          `cli-bridge provider "cmd" must be "claude" or "codex", got ${JSON.stringify(cmd)}`,
        );
      }
      default:
        // Unrecognized `kind` used to fall through this switch silently —
        // no adapter registered, no error, no log: an invisible no-op a
        // misspelled `kind: "direct-apu"` in config.yaml would sail
        // through. Now surfaced as a typed error instead (Review Round-1 🟡).
        throw new InvalidProviderConfigError(
          id,
          `unknown provider kind ${JSON.stringify((providerConfig as { kind: unknown }).kind)} ` +
            `(expected "cli-bridge" or "direct-api")`,
        );
    }
  }

  return registry;
}
