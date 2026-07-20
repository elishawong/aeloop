/**
 * Typed errors for the profile loader (src/profile/loader.ts).
 */

/**
 * A profile has no usable `config.yaml` (its directory is absent, or the
 * directory exists but doesn't contain a config.yaml).
 *
 * This is a normal, expected state — e.g. `AI_AGENT_PROFILE=verity` on a
 * machine that doesn't have the company overlay checked out. `loadProfile()`
 * therefore never *throws* this error; it constructs one and returns it as
 * data inside a `{ ok: false, error }` result (see `ProfileLoadResult` in
 * loader.ts), so callers get graceful degradation without needing
 * try/catch for an expected case.
 */
export class ProfileNotFoundError extends Error {
  readonly profile: string;
  readonly profileDir: string;

  constructor(profile: string, profileDir: string) {
    super(`Profile "${profile}" not found: no config.yaml under ${profileDir}`);
    this.name = "ProfileNotFoundError";
    this.profile = profile;
    this.profileDir = profileDir;
  }
}

/**
 * `config.yaml` exists but is not usable — either it fails to parse as
 * YAML, or it parses to something that isn't a mapping at the document
 * root. This is a real misconfiguration, so `loadProfile()` throws it
 * rather than returning it as a result; the underlying cause (e.g. a
 * js-yaml `YAMLException`) is preserved via the standard `Error#cause`
 * option instead of leaking a raw, untyped exception to callers.
 */
export class ProfileConfigParseError extends Error {
  readonly profile: string;
  readonly configPath: string;

  constructor(profile: string, configPath: string, cause: unknown) {
    super(
      `Profile "${profile}" config.yaml at ${configPath} failed to parse: ${describeCause(cause)}`,
      { cause },
    );
    this.name = "ProfileConfigParseError";
    this.profile = profile;
    this.configPath = configPath;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `profile` failed one of the two path-safety checks in
 * `../shared/safe-path.js` (Zorro review, feature/issue-1-a0-a1-scaffold:
 * the same path-traversal hole found in `prompt/personas.ts`'s role
 * lookup — `profile` was `path.join`-ed straight into
 * `profilesRoot/<profile>/config.yaml` with no containment check). Distinct
 * from `ProfileNotFoundError` — this is not "a legitimate profile name
 * with no config.yaml on disk (yet)", it's "this string can never be a
 * valid profile name", whether because it isn't a single path segment
 * (contains `/`, `\`, `..`, or is already absolute) or because it resolves
 * outside `profilesRoot` through a symlink. Thrown, not returned as
 * `{ ok: false }` — unlike a missing profile, an unsafe name is not an
 * expected/normal state.
 */
export class InvalidProfileNameError extends Error {
  readonly profile: string;

  constructor(profile: string, reason: string) {
    super(`Invalid profile name "${profile}": ${reason}`);
    this.name = "InvalidProfileNameError";
    this.profile = profile;
  }
}
