import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A role has no persona file under the given `personas/` directory.
 *
 * This is the "role name is dynamic, never hardcoded" contract (docs/
 * DESIGN.md §1.7: "persona/schema 按角色名动态查 registry,不用 Verity
 * 那个硬编码 {coder,tester} Record — 加角色不改 composer") made concrete:
 * the `personas/` directory *is* the role registry — adding a role means
 * dropping a new `<role>.md` file there, never touching this loader's code.
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
 * Missing file → typed `PersonaNotFoundError`, not a raw `ENOENT`.
 */
export function loadPersona(role: string, personasDir: string): string {
  const personaPath = resolvePersonaPath(role, personasDir);
  if (!existsSync(personaPath)) {
    throw new PersonaNotFoundError(role, personaPath);
  }
  return readFileSync(personaPath, "utf-8");
}
