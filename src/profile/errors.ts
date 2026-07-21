/**
 * Typed errors for the profile loader (src/profile/loader.ts).
 */

/**
 * A profile has no usable `config.yaml` (its directory is absent, or the
 * directory exists but doesn't contain a config.yaml).
 *
 * This is a normal, expected state — e.g. `AI_AGENT_PROFILE=apikey` on a
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
 * `../shared/safe-path.js` (review, feature/issue-1-a0-a1-scaffold:
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

/**
 * `config.personas` failed one of the two path-safety checks in
 * `../shared/safe-path.js`, or isn't a string at all (issue #42: a
 * profile's `personas` field is user/deployment-controlled data read out
 * of YAML — `js-yaml` will happily hand back a number, mapping, or array
 * for a malformed `personas:` key, and even a well-typed string could
 * still be a traversal payload like `"../../../etc"`). Same "this string
 * can never be a valid name" semantics as `InvalidProfileNameError`/
 * `InvalidRoleNameError` (`../prompt/personas.ts`) — thrown, not returned
 * as data, because an unsafe/malformed persona-set name is a real
 * misconfiguration, not an expected "not found yet" state.
 */
export class InvalidPersonaSetNameError extends Error {
  readonly personas: unknown;

  constructor(personas: unknown, reason: string) {
    super(`Invalid personas name ${JSON.stringify(personas)}: ${reason}`);
    this.name = "InvalidPersonaSetNameError";
    this.personas = personas;
  }
}

/**
 * A profile's `config.yaml` declares `personas: <name>`, but the
 * deployment never set `AELOOP_PERSONAS_ROOT` — there is no root
 * directory to resolve `<name>` under at all. This is a fail-closed
 * error, not a silent fallback to `<profileDir>/personas`: once a
 * profile opts into an external persona-set root, the engine must not
 * quietly substitute a different persona source than the one the
 * operator asked for (docs/DESIGN.md "Profile boundary" / issue #42
 * "fail closed on unsafe/missing paths").
 */
export class PersonaRootNotConfiguredError extends Error {
  readonly personas: string;

  constructor(personas: string) {
    super(
      `Profile declares personas "${personas}" but AELOOP_PERSONAS_ROOT is not set — cannot resolve an external persona root`,
    );
    this.name = "PersonaRootNotConfiguredError";
    this.personas = personas;
  }
}

/**
 * `AELOOP_PERSONAS_ROOT` is set, but nothing exists on disk at that path
 * (or it isn't a directory). Distinct from `PersonaRootNotConfiguredError`
 * (env var absent) and from `PersonaNotFoundError`
 * (`../prompt/personas.ts`, which fires later for a missing `<role>.md`
 * file *inside* an otherwise-valid, resolved persona directory) — this is
 * "the configured root itself doesn't exist", caught before any
 * persona-set name path is even built.
 */
export class PersonaRootNotFoundError extends Error {
  readonly personas: string;
  readonly personasRoot: string;

  constructor(personas: string, personasRoot: string) {
    super(
      `AELOOP_PERSONAS_ROOT "${personasRoot}" does not exist or is not a directory (personas "${personas}")`,
    );
    this.name = "PersonaRootNotFoundError";
    this.personas = personas;
    this.personasRoot = personasRoot;
  }
}
