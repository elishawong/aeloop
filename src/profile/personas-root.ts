/**
 * Resolves the persona root directory `PromptComposer` reads `<role>.md`
 * files from (issue #42: "Support external persona-set roots in profile
 * assembly").
 *
 * **Problem this closes**: `assembleProfileDeps()` (`../cli/assemble.ts`)
 * used to hardcode `path.join(profileDir, "personas")` as the only
 * possible persona source. A deployment that keeps `profiles/apikey/
 * config.yaml` inside this repo's profile tree but its actual role
 * persona files (`coder.md`/`tester.md`, etc.) in a separate location had
 * no way to point `PromptComposer` at that external directory — the
 * profile would load, but `PromptComposer.compose()` would throw
 * `PersonaNotFoundError` the moment it looked for `coder.md`/`tester.md`
 * under a `personas/` subdirectory that was never meant to exist there.
 *
 * **Not to be confused with `brains/company/` / `brains/personal/`**
 * (see `../../brains/README.md`): those are Conductor's Brain artifacts
 * (`manifest.yaml` + `system-prompt.md`), a completely separate concept
 * consumed by Conductor, not by Aeloop. This module has nothing to do
 * with them — it only ever reads role persona files (`coder.md`/
 * `tester.md`) the same way `<profileDir>/personas` always did, just from
 * an optionally-external root.
 *
 * **Contract**:
 * - `config.personas` **absent** → returns `<profileDir>/personas`, byte-
 *   for-byte the same path `assembleProfileDeps()` always computed. Zero
 *   behavior change for `profiles/subscription/` or any other profile
 *   that doesn't opt in.
 * - `config.personas` **present** → must be a string and a single safe
 *   path segment (`../shared/safe-path.js#isSinglePathSegment` — no `/`,
 *   `\`, `..`, not absolute), else `InvalidPersonaSetNameError`.
 *   `AELOOP_PERSONAS_ROOT` (`env`, defaults to `process.env`, same
 *   injection-point pattern as `AELOOP_PROFILES_ROOT` in
 *   `../cli/assemble.ts`) must be set, else `PersonaRootNotConfiguredError`
 *   — an opted-in persona set never silently falls back to
 *   `<profileDir>/personas`, it fails closed. The root must exist on disk
 *   as a directory, else `PersonaRootNotFoundError`. The resolved
 *   `<AELOOP_PERSONAS_ROOT>/<personas>` path must stay contained inside
 *   `AELOOP_PERSONAS_ROOT` even after following symlinks
 *   (`isContainedRealpath`, the same defense-in-depth check
 *   `profile/loader.ts` and `prompt/personas.ts` already use), else
 *   `InvalidPersonaSetNameError` (symlink escape). Returns
 *   `<AELOOP_PERSONAS_ROOT>/<personas>/personas` — the same `personas/`
 *   subdirectory convention `<profileDir>/personas` already uses, so
 *   `PromptComposer`/`loadPersona()` (`../prompt/personas.ts`) need no
 *   changes: both call sites just receive a different `personasDir`.
 *
 * All checks run *before* any filesystem read of the persona-set directory
 * itself, mirroring `profile/loader.ts#loadProfile()` and
 * `prompt/personas.ts#loadPersona()`'s "validate the name, then the
 * containment, then touch disk" ordering.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { isContainedRealpath, isSinglePathSegment } from "../shared/safe-path.js";
import {
  InvalidPersonaSetNameError,
  PersonaRootNotConfiguredError,
  PersonaRootNotFoundError,
} from "./errors.js";
import type { ProfileConfig } from "./loader.js";

const LEGACY_PERSONAS_SUBDIR = "personas";

/**
 * `env` defaults to `process.env`; an explicit override is only meant for
 * tests (same "explicit injection point, never overridden implicitly by
 * production callers" pattern `assembleProfileDeps()`'s own `env`
 * parameter already establishes).
 */
export function resolvePersonaRoot(
  profileDir: string,
  config: Pick<ProfileConfig, "personas">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const personas = config.personas;

  if (personas === undefined) {
    return path.join(profileDir, LEGACY_PERSONAS_SUBDIR);
  }

  if (typeof personas !== "string") {
    throw new InvalidPersonaSetNameError(personas, "personas must be a string");
  }

  if (!isSinglePathSegment(personas)) {
    throw new InvalidPersonaSetNameError(
      personas,
      "personas names must be a single path segment (no '/', '\\', '..', and not an absolute path)",
    );
  }

  const personasRoot = env["AELOOP_PERSONAS_ROOT"];
  if (!personasRoot) {
    throw new PersonaRootNotConfiguredError(personas);
  }

  if (!existsSync(personasRoot) || !statSync(personasRoot).isDirectory()) {
    throw new PersonaRootNotFoundError(personas, personasRoot);
  }

  const personaSetDir = path.join(personasRoot, personas);

  if (!isContainedRealpath(personasRoot, personaSetDir)) {
    throw new InvalidPersonaSetNameError(
      personas,
      `resolves outside ${personasRoot} (possible symlink escape)`,
    );
  }

  return path.join(personaSetDir, LEGACY_PERSONAS_SUBDIR);
}
