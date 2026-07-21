/**
 * `run-origin.ts` — A5 re-review P0-2 (`docs/feature/a5-cli-tui/test-report.md`,
 * Commander-decided scope: lightweight, non-blocking mitigation, no
 * `audit-store.ts` schema change).
 *
 * **The real problem**: `aeloop start`/`aeloop resume` don't take a `--repo`/
 * `--cwd` flag (PRD §3 point 1 — the coder/tester subprocess's working
 * directory is simply wherever the human ran `aeloop` from). A `workflow_runs`
 * row has no record of which directory it was started *from*. If the
 * Commander starts a run in repo A, then later runs `aeloop resume <runId>`
 * from repo B (a typo'd runId, a stale terminal tab, muscle memory), the
 * resumed run's coder/tester subprocesses spawn against **repo B**, not the
 * repo the run's diff/history actually concerns — silently, since nothing
 * before this file compared the two.
 *
 * **This file's fix is a warning, not a lock** — single-operator CLI posture
 * (same class of decision as `audit-store.ts`'s R5-B2 concurrency note): it
 * records the `cwd` a run was `start`ed from, and `aeloop list`/`aeloop
 * resume` read it back and warn (never throw, never block) when the
 * *current* `cwd` doesn't match. A human can still deliberately resume from
 * a different directory (e.g. the repo moved) — this is a nudge against an
 * honest mistake, not a security boundary.
 *
 * **Storage: a JSON sidecar file, not a `workflow_runs` column** — the
 * Commander's explicit scope decision was "don't touch `audit-store.ts`'s
 * schema this round" (that's Harness/Loop-layer territory). `<profileDir>/
 * run-origins.json` (a sibling of `memory.db`/`workflow.db`, same directory
 * convention, `.gitignore`-covered the same way those two already are) is
 * this file's own append-only-in-spirit map of `runId -> RunOrigin`, read/
 * written only by this file — `src/cli/` never reaches into it from
 * anywhere else, and no other layer reads it.
 *
 * **Best-effort, not authoritative**: a missing or corrupt `run-origins.json`
 * (deleted by hand, truncated by a crash mid-write, an old profile directory
 * that predates this file), OR a syntactically-valid-JSON sidecar whose
 * per-`runId` entry is itself malformed (`null`, a string, an object
 * missing `cwd`/`recordedAt` — `isValidRunOrigin()` below, B1 fix) — all
 * degrade to "no origin recorded for this run". `getRunOrigin()` returns
 * `undefined`, callers print no warning rather than treating that as an
 * error. This is metadata for a nudge, not a fact the rest of the system
 * depends on being present.
 */
import fs from "node:fs";
import path from "node:path";
import { stripControlSequences } from "./sanitize-terminal.js";

export interface RunOrigin {
  /** Absolute `cwd` (`process.cwd()`) at the moment `aeloop start` created this run. */
  cwd: string;
  /** ISO timestamp of when this origin was recorded. */
  recordedAt: string;
}

type RunOriginsFile = Record<string, RunOrigin>;

function runOriginsPath(profileDir: string): string {
  return path.join(profileDir, "run-origins.json");
}

/**
 * Reads `<profileDir>/run-origins.json`, tolerating "file doesn't exist yet"
 * (brand-new profile directory, or a profile that predates this file) and
 * "file exists but isn't valid JSON" (a genuinely corrupt sidecar — this is
 * best-effort metadata, not something worth crashing `aeloop` over) by
 * returning `{}` for either case. A warning is printed to stderr for the
 * corrupt case specifically (distinguishable from the normal "not created
 * yet" case), so a real problem isn't silently invisible forever, but it
 * never throws.
 */
function readRunOrigins(profileDir: string): RunOriginsFile {
  const filePath = runOriginsPath(profileDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {}; // doesn't exist yet — normal for a run's very first origin write, or an older profile dir.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RunOriginsFile;
    }
    console.error(`aeloop: ${filePath} did not contain a JSON object — ignoring recorded run origins.`);
    return {};
  } catch {
    console.error(`aeloop: ${filePath} is not valid JSON — ignoring recorded run origins.`);
    return {};
  }
}

/**
 * Records `cwd` as the origin directory for `runId`. Called once, right
 * after `startRun()` returns a real `runId` (`main.ts`'s `runStart`).
 * Best-effort: a write failure (e.g. read-only filesystem, disk full) is
 * caught and warned about, never thrown — this metadata is a nudge, not
 * something a run's actual audit trail depends on.
 */
export function recordRunOrigin(profileDir: string, runId: number, cwd: string, now: string = new Date().toISOString()): void {
  const origins = readRunOrigins(profileDir);
  origins[String(runId)] = { cwd, recordedAt: now };
  try {
    fs.writeFileSync(runOriginsPath(profileDir), JSON.stringify(origins, null, 2) + "\n");
  } catch (err) {
    console.error(`aeloop: could not record run origin for #${runId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Shape guard for one `RunOriginsFile[runId]` entry. `readRunOrigins()` only checks that the
 * *whole file* parses to a JSON object — it does not (and, being generic over "any JSON object",
 * cannot cheaply) check that every value inside it actually looks like a `RunOrigin`. A `cwd` is
 * never trusted from anywhere except this file's own `recordRunOrigin()` write, but the sidecar
 * itself is user-editable (`.gitignore`-covered, but still a plain JSON file on disk) and this is
 * "best-effort, not authoritative" metadata (file header) — a hand-edited or truncated-mid-write
 * entry like `{"1": null}` or `{"1": "not an object"}` is still *valid JSON* at the top level and
 * must not reach a caller as if it were a real `RunOrigin`.
 *
 * Bug fixed here (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md` B1): before this
 * guard, `getRunOrigin()` returned whatever `origins[String(runId)]` was, unvalidated, `as
 * RunOriginsFile` cast and all. For a sidecar like `{"1": null}`, that returned `null` — and
 * `main.ts`'s `runResume`/`runList` both only check `origin !== undefined` before dereferencing
 * `origin.cwd`, so `null !== undefined` is true and `null.cwd` threw `TypeError: Cannot read
 * properties of null (reading 'cwd')`, crashing the entire `resume`/`list` command in a file whose
 * own header promises "never throws, degrades to no-origin". This function now returns `undefined`
 * (not just doesn't throw) for anything that isn't a real `RunOrigin` shape, so every existing
 * "no origin recorded" call site keeps working unchanged.
 */
function isValidRunOrigin(value: unknown): value is RunOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["cwd"] === "string" && typeof candidate["recordedAt"] === "string";
}

/** Reads back the recorded origin for `runId`, or `undefined` if none was ever recorded (or the sidecar is missing/corrupt, or the stored entry itself is malformed — see `isValidRunOrigin()`). */
export function getRunOrigin(profileDir: string, runId: number): RunOrigin | undefined {
  const entry = readRunOrigins(profileDir)[String(runId)];
  return isValidRunOrigin(entry) ? entry : undefined;
}

/**
 * The warning text `main.ts` prints (never blocks) when `aeloop resume`'s
 * current `cwd` doesn't match the run's recorded origin. Exported so tests
 * can assert on the exact copy without duplicating it.
 *
 * Both `origin.cwd` and `currentCwd` are run through `stripControlSequences()`
 * before being interpolated (P1-4, `docs/feature/a5-cli-tui/test-report.md`)
 * — both values are `process.cwd()` at some point in time, not model-
 * controlled text, so the threat model `sanitize-terminal.ts` exists for
 * isn't actually broken here, but this warning is printed straight to the
 * real terminal like everything else that file's header describes, and
 * consistency ("every printed string goes through the same sanitizer, no
 * exceptions to reason about") is worth the one extra call.
 */
export function describeCwdMismatch(runId: number, origin: RunOrigin, currentCwd: string): string {
  const originCwd = stripControlSequences(origin.cwd);
  const sanitizedCurrentCwd = stripControlSequences(currentCwd);
  return (
    `Warning: run #${runId} was started from "${originCwd}", but you're resuming it from "${sanitizedCurrentCwd}". ` +
    `The coder/tester subprocess's working directory is wherever you run \`aeloop\` from (no --repo flag) — ` +
    `if this run concerns a different repo than the one you're in now, Ctrl+C and cd there first.`
  );
}
