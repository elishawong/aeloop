/**
 * Path-safety helpers shared by every module that turns an externally
 * supplied *name* (a role name in `src/prompt/personas.ts`, a profile name
 * in `src/profile/loader.ts`) into a filesystem path under a fixed root
 * directory (`<personasDir>/<role>.md`, `<profilesRoot>/<profile>/`).
 *
 * Both call sites had the same hole (Zorro review, feature/issue-1-a0-a1-scaffold):
 * the name was `path.join`-ed straight into a path and read, with no check
 * that the result stayed inside the intended root. `path.join` happily
 * collapses `..` segments — `role = "../../../CLAUDE"` resolves to the repo
 * root's `CLAUDE.md`, fully outside `profiles/<x>/personas/`. Real-world
 * repro (pre-fix, this increment): `loadPersona("../../../CLAUDE",
 * "./profiles/subscription/personas")` returned the *repo's own* `CLAUDE.md`
 * content.
 *
 * Two independent layers, both required:
 * 1. **Input shape** (`isSinglePathSegment`): the name must be exactly one
 *    path component — no `/`, `\`, `..`, and not already absolute. This
 *    rejects the traversal string itself before it ever reaches
 *    `path.join`.
 * 2. **Containment** (`isContainedRealpath`): even a name that passes (1)
 *    could still resolve outside the root through a symlink planted inside
 *    it (e.g. `profiles/subscription/personas/leaked.md` symlinked to a file
 *    elsewhere on disk) — (1) only inspects the *name*, not what the
 *    resulting path *is* on disk. This resolves both the root and the
 *    candidate path through `fs.realpathSync` (which follows symlinks) and
 *    checks the candidate's real location is still inside the root's real
 *    location.
 */
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * True when `segment` is safe to treat as a single path component under a
 * fixed root: not empty, not `.`/`..`, contains no path separator, and
 * isn't already an absolute path.
 */
export function isSinglePathSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (path.isAbsolute(segment)) return false;
  return true;
}

/**
 * Defense-in-depth containment check: resolves `root` and `candidatePath`
 * through `fs.realpathSync` (following symlinks) and checks the
 * candidate's real path is still inside — or exactly equal to — the
 * root's real path.
 *
 * If `root` doesn't exist (yet) or `candidatePath` doesn't exist, there is
 * nothing on disk to have escaped *through* — returns `true` in both
 * cases; the caller's own existence check (`existsSync`, or the
 * `config.yaml` presence check in `profile/loader.ts`) is what reports
 * "missing" for those, this function only judges escape.
 */
export function isContainedRealpath(root: string, candidatePath: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return true;
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidatePath);
  } catch {
    return true;
  }
  if (realCandidate === realRoot) return true;
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realCandidate.startsWith(rootWithSep);
}
