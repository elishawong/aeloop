import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isContainedRealpath, isSinglePathSegment } from "../shared/safe-path.js";

/**
 * A role has no persona file under the given `personas/` directory.
 *
 * This is the "role name is dynamic, never hardcoded" contract (docs/
 * DESIGN.md §1.7: "persona/schema is looked up dynamically by role name via
 * the registry, instead of the hardcoded `{coder,tester}` Record a prior
 * internal implementation used — adding a role doesn't require touching the
 * composer") made concrete: the `personas/` directory *is* the role
 * registry — adding a role means dropping a new `<role>.md` file there,
 * never touching this loader's code.
 * An unknown role therefore isn't a programming error to throw a raw
 * exception for; it's an expected, typed outcome a caller (`PromptComposer`,
 * B8) can catch and react to.
 */
export class PersonaNotFoundError extends Error {
  readonly role: string;
  readonly personaPath: string;

  constructor(role: string, personaPath: string) {
    super(`No persona file for role "${role}": expected ${personaPath}`);
    this.name = "PersonaNotFoundError";
    this.role = role;
    this.personaPath = personaPath;
  }
}

/**
 * `role` failed one of the two path-safety checks in `../shared/safe-path.js`
 * (review, feature/issue-1-a0-a1-scaffold: "role" was `path.join`-ed
 * straight into a file path with no containment check, so
 * `role = "../../../CLAUDE"` read the repo's own `CLAUDE.md`). Distinct
 * from `PersonaNotFoundError` — this is not "a legitimate role with no
 * persona file yet", it's "this string can never be a valid role name",
 * whether because it isn't a single path segment (contains `/`, `\`, `..`,
 * or is already absolute) or because it resolves outside `personasDir`
 * through a symlink.
 */
export class InvalidRoleNameError extends Error {
  readonly role: string;

  constructor(role: string, reason: string) {
    super(`Invalid role name "${role}": ${reason}`);
    this.name = "InvalidRoleNameError";
    this.role = role;
  }
}

/** Exposed for tests: computes `<personasDir>/<role>.md`. */
export function resolvePersonaPath(role: string, personasDir: string): string {
  return path.join(personasDir, `${role}.md`);
}

/**
 * Loads the persona text for `role` by looking up `<personasDir>/<role>.md`
 * — a plain string-keyed file lookup, never an `if (role === "coder")`
 * branch (DESIGN §1.7). `personasDir` is an explicit parameter rather than
 * something this module derives from a profile itself, matching the same
 * "explicit path in, no implicit coupling" shape `profile/loader.ts` and
 * `context/store.ts` already use — callers (typically `PromptComposer`,
 * pointed at a `ProfileLoadResult.profileDir`'s `personas/` subdirectory)
 * decide which profile's personas to read from.
 *
 * Missing file → typed `PersonaNotFoundError`, not a raw `ENOENT`. An
 * unsafe `role` (path traversal, absolute path, or a symlink escape once
 * resolved) → typed `InvalidRoleNameError`, checked *before* any
 * filesystem access — see `../shared/safe-path.js` for why both checks are
 * needed.
 */
export function loadPersona(role: string, personasDir: string): string {
  if (!isSinglePathSegment(role)) {
    throw new InvalidRoleNameError(
      role,
      "role names must be a single path segment (no '/', '\\', '..', and not an absolute path)",
    );
  }

  const personaPath = resolvePersonaPath(role, personasDir);

  if (!isContainedRealpath(personasDir, personaPath)) {
    throw new InvalidRoleNameError(role, `resolves outside ${personasDir} (possible symlink escape)`);
  }

  if (!existsSync(personaPath)) {
    throw new PersonaNotFoundError(role, personaPath);
  }
  return readFileSync(personaPath, "utf-8");
}
