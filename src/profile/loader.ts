import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { isContainedRealpath, isSinglePathSegment } from "../shared/safe-path.js";
import { InvalidProfileNameError, ProfileConfigParseError, ProfileNotFoundError } from "./errors.js";

/**
 * Structural shape of a profile's `config.yaml` (docs/DESIGN.md §7).
 * Deliberately loose (index signatures allow unknown extra keys) — this
 * increment only needs the loader to parse the YAML into a usable shape,
 * not to fully schema-validate it (that's for the Harness layer that
 * actually consumes `providers`/`roles`, not built in this increment).
 */
export interface ProviderConfig {
  kind: "cli-bridge" | "direct-api";
  cmd?: string;
  base_url?: string;
  api_key?: string;
  [key: string]: unknown;
}

export interface RoleBinding {
  provider: string;
  [key: string]: unknown;
}

export interface ProfileConfig {
  profile: string;
  providers: Record<string, ProviderConfig>;
  roles: Record<string, RoleBinding>;
  workflow?: {
    reject_threshold?: number;
    [key: string]: unknown;
  };
  /**
   * Optional Context-layer knobs (issue #36 slice 1: wiring `ContextBudgetManager`
   * into the real `ContextInjector` -> `PromptComposer` path).
   *
   * `token_budget` is the max total token estimate (see
   * `context/budget.ts`'s `estimateTokens()`) of memories `ContextInjector`
   * will inject into a single prompt. It is **entirely optional and has no
   * implicit default** — a profile that omits `context` (or omits
   * `context.token_budget` within it) gets exactly today's unbounded
   * behavior: every core/recalled, non-rejected memory is injected,
   * regardless of size. This is a deliberate backward-compatibility
   * choice, not an oversight: turning budget enforcement on for existing
   * profiles by default could silently start omitting memories that used
   * to always appear.
   *
   * `DEFAULT_CONTEXT_TOKEN_BUDGET` (exported from `../context/injector.js`)
   * is a documented, *recommended* value for profiles that want to opt in
   * — set `context: { token_budget: 8000 }` explicitly to use it. It is
   * never applied automatically.
   */
  context?: {
    token_budget?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type ProfileLoadResult =
  | {
      ok: true;
      profile: string;
      profileDir: string;
      configPath: string;
      config: ProfileConfig;
    }
  | {
      ok: false;
      error: ProfileNotFoundError;
    };

const ENV_PLACEHOLDER = /\$\{([A-Z0-9_]+)\}/g;

/**
 * Directory containing `profiles/<name>/`, resolved relative to *this
 * module's own location* — not `process.cwd()`. That matters because
 * aeloop ships as a globally-installed CLI (`npm i -g`, see CLAUDE.md §2):
 * a user can run it from any directory, but `profiles/` always lives next
 * to the package root, not next to the caller's cwd.
 *
 * Both `src/profile/loader.ts` (running under vitest, from source) and the
 * compiled `dist/profile/loader.js` sit two directories below the package
 * root (`src/profile/` and `dist/profile/` respectively), which is where
 * `profiles/` lives as a sibling (docs/DESIGN.md §6) — so the same
 * `../../profiles` relative resolution is correct in both cases.
 */
const PROFILES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "profiles",
);

/** Exposed for tests: computes `<profilesRoot>/<profile>`. */
export function resolveProfileDir(profile: string, profilesRoot: string = PROFILES_ROOT): string {
  return path.join(profilesRoot, profile);
}

/**
 * Reads `AI_AGENT_PROFILE` (`"subscription"` | `"apikey"`, defaulting to
 * `"subscription"`), locates `profiles/<name>/config.yaml`, parses it, and
 * substitutes `${ENV_VAR}` placeholders in its string values.
 *
 * - **Missing profile** (no `config.yaml` found — e.g. `profiles/apikey/`
 *   absent on this machine) is a normal, expected state: returned as a
 *   typed `{ ok: false, error: ProfileNotFoundError }` result, never
 *   thrown, never silently swapped for an empty config.
 * - **Malformed `config.yaml`** (bad YAML syntax, or a document root that
 *   isn't a mapping) is a real misconfiguration: throws
 *   `ProfileConfigParseError`, wrapping the underlying parse error instead
 *   of letting a raw `YAMLException` escape.
 *
 * `profilesRoot` is an injection point for tests; production callers
 * should omit it and rely on the package-relative default.
 *
 * **Path safety** (review, feature/issue-1-a0-a1-scaffold): `profile`
 * is checked against `../shared/safe-path.js` *before* it ever reaches
 * `path.join` — a traversal string like `"../../../CLAUDE"` or an absolute
 * path throws typed `InvalidProfileNameError` rather than resolving to a
 * path outside `profilesRoot`. A second containment check after resolving
 * catches a symlink escape too. Both checks run before any filesystem read.
 */
export function loadProfile(
  profile: string = readProfileEnv(),
  profilesRoot: string = PROFILES_ROOT,
): ProfileLoadResult {
  if (!isSinglePathSegment(profile)) {
    throw new InvalidProfileNameError(
      profile,
      "profile names must be a single path segment (no '/', '\\', '..', and not an absolute path)",
    );
  }

  const profileDir = resolveProfileDir(profile, profilesRoot);

  if (!isContainedRealpath(profilesRoot, profileDir)) {
    throw new InvalidProfileNameError(profile, `resolves outside ${profilesRoot} (possible symlink escape)`);
  }

  const configPath = path.join(profileDir, "config.yaml");

  if (!existsSync(configPath)) {
    return { ok: false, error: new ProfileNotFoundError(profile, profileDir) };
  }

  const raw = readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = loadYaml(raw);
  } catch (cause) {
    throw new ProfileConfigParseError(profile, configPath, cause);
  }

  if (!isPlainObject(parsed)) {
    throw new ProfileConfigParseError(
      profile,
      configPath,
      new Error(`expected a YAML mapping at the document root, got ${describeType(parsed)}`),
    );
  }

  const substituted = substituteEnvPlaceholders(parsed);
  assertProfileConfigShape(substituted, profile, configPath);
  return { ok: true, profile, profileDir, configPath, config: substituted };
}

/**
 * Minimal required-field check before handing `parsed` off as a
 * `ProfileConfig` (review, feature/issue-1-a0-a1-scaffold: the prior
 * code did a bare `as ProfileConfig` cast right after confirming the YAML
 * root is *a* mapping — a `config.yaml` missing `providers`/`roles`
 * entirely, or with `profile` as a number, would sail through as `ok:
 * true` with a type that lied about its own shape). This intentionally
 * stays shallow — it checks that `profile`/`providers`/`roles` exist and
 * have the right *outer* shape (string / mapping), not that every nested
 * field inside `providers`/`roles` is well-formed. Full schema validation
 * belongs to the layer that actually consumes those nested shapes (the
 * Harness layer, A2+, per PRD §5's note that this loader "only needs to
 * parse out the structure"), not this loader — confirmed implemented as of
 * A2's Review Round-1 fix: `harness/config.ts`'s
 * `assertValidProviderConfig()` is that validation for `providers[id]`
 * entries (null/non-object entries,
 * non-string `base_url`, unrecognized `kind` all throw typed
 * `InvalidProviderConfigError` there, not here).
 */
function assertProfileConfigShape(
  config: Record<string, unknown>,
  profile: string,
  configPath: string,
): asserts config is ProfileConfig {
  if (typeof config["profile"] !== "string") {
    throw new ProfileConfigParseError(
      profile,
      configPath,
      new Error(`missing or non-string required field "profile"`),
    );
  }
  if (!isPlainObject(config["providers"])) {
    throw new ProfileConfigParseError(
      profile,
      configPath,
      new Error(`missing or non-mapping required field "providers"`),
    );
  }
  if (!isPlainObject(config["roles"])) {
    throw new ProfileConfigParseError(
      profile,
      configPath,
      new Error(`missing or non-mapping required field "roles"`),
    );
  }
}

function readProfileEnv(): string {
  return process.env["AI_AGENT_PROFILE"] ?? "subscription";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Recursively replaces `${ENV_VAR}` placeholders in string values with
 * `process.env.ENV_VAR`. If the env var isn't set, the placeholder is left
 * untouched rather than silently becoming `""` — an unresolved placeholder
 * showing up downstream is far easier to debug than a silently-empty
 * credential.
 */
export function substituteEnvPlaceholders<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER, (match, varName: string) => {
      const envValue = process.env[varName];
      return envValue !== undefined ? envValue : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnvPlaceholders(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = substituteEnvPlaceholders(v);
    }
    return result as T;
  }
  return value;
}
