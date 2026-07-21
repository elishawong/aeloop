/**
 * Typed errors for the CLI layer (`src/cli/*`), mirroring the convention
 * every other layer already established (`profile/errors.ts`,
 * `harness/errors.ts`, `loop/errors.ts`): typed classes, never a raw generic
 * `Error` for a condition a caller (here, `main.ts`'s dispatch) needs to
 * distinguish and report clearly instead of letting a stack trace leak to
 * the terminal (PRD §10 acceptance criteria: "never a stack trace, never a
 * silent fallback").
 */

/**
 * `assembleSubscriptionDeps()` (`src/cli/assemble.ts`) found
 * `AI_AGENT_PROFILE` resolved to something other than `"subscription"` — A5
 * only wires up the subscription profile (PRD §2 non-goal #1); apikey lands
 * in A6. Thrown instead of silently falling back to `subscription` (which
 * would run the wrong provider/credentials without the user asking for it)
 * or letting the mismatch surface later as a confusing, unrelated failure
 * deeper in the stack.
 */
export class UnsupportedProfileError extends Error {
  readonly profile: string;

  constructor(profile: string) {
    super(
      `aeloop's CLI only supports the "subscription" profile in this release, got AI_AGENT_PROFILE="${profile}". ` +
        `apikey/direct-api support lands in A6 (docs/ROADMAP.md).`,
    );
    this.name = "UnsupportedProfileError";
    this.profile = profile;
  }
}

/**
 * `aeloop resume <runId>` (`src/cli/main.ts`) was asked to resume a run
 * that isn't actually resumable: `runId` doesn't exist at all
 * (`AuditReadError` already covers that — this error is for the *other*
 * case), or the run exists but has already reached a terminal state
 * (`completed`/`cancelled` — `getPendingInterrupt()`'s `done: true`, no
 * pending gate left to resume). Distinguishes "this run is real, but
 * there's nothing left to do" from "no such run" so the CLI's error message
 * can be precise instead of a generic failure.
 */
export class RunNotResumableError extends Error {
  readonly runId: number;
  readonly status: string;

  constructor(runId: number, status: string) {
    super(`Run #${runId} is not resumable — its status is "${status}" (already reached a terminal state).`);
    this.name = "RunNotResumableError";
    this.runId = runId;
    this.status = status;
  }
}
