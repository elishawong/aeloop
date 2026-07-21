/**
 * `main()` — argv parsing (`node:util`'s built-in `parseArgs`, PRD §6.7's
 * judgment call: no new dependency for something this narrow, matching
 * this repo's existing "hand-roll a small primitive" ethos, e.g.
 * `harness/cli-exec.ts`) + `start`/`resume`/`list` dispatch. `bin.ts` is
 * the real, two-line production entry point (`await main(process.argv.
 * slice(2))`, no arguments beyond argv) — because that file has no error
 * handling of its own, `main()` itself must catch every error dispatch
 * throws, print a clean `Name: message` line (never a raw stack trace —
 * PRD §10's `UnsupportedProfileError` acceptance criterion), and set
 * `process.exitCode` rather than let anything escape uncaught.
 *
 * `MainOverrides` (`profilesRoot`/`prompter`) is this file's own test
 * seam, absent from the PRD §6.7 sketch's literal `main()` signature but
 * necessary for the same reason `assemble.ts`'s `profilesRoot` parameter
 * is: B8's hard vertical slice must drive *this exact* function against
 * real cli-bridge fixture binaries with a scripted `FakePrompter`, not the
 * real `profiles/subscription/` directory or a real human at a keyboard.
 * `bin.ts` never passes overrides — every default is the real production
 * value (`loadProfile()`'s package-relative default, `InquirerPrompter`).
 *
 * **`env` was deliberately removed from this seam (2026-07-21, Zorro
 * independent re-review, `docs/feature/a5-cli-tui/test-report.md` P1-3)** —
 * `main()` is this file's public, callable-programmatically entry point
 * (not just `bin.ts`'s two-line shim), and `assembleSubscriptionDeps()`'s
 * whole "no bypass path" security claim (PRD §2 non-goal #1: `aeloop`
 * refuses anything but the real `subscription` profile) depended on nobody
 * being able to hand it a *fake* `env` object claiming
 * `AI_AGENT_PROFILE=subscription` while the process's real environment says
 * something else. `bin.ts` never passed `env` (production was already
 * safe), but `main()` itself — reachable by any programmatic caller, not
 * only `bin.ts` — accepted it, which is the actual seam that mattered.
 * `assembleSubscriptionDeps()` here is always called with the real
 * `process.env`, unconditionally; only `profilesRoot`/`prompter` remain
 * legitimate test seams (they don't let a caller lie about which profile
 * is active, only where its files live and who answers its prompts).
 */
import os from "node:os";
import { parseArgs } from "node:util";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { danger, warn } from "./colors.js";
import { assembleProfileDeps, assembleSubscriptionDeps, resolveRejectThreshold, type CliDeps } from "./assemble.js";
import { RunNotResumableError } from "./errors.js";
import { InquirerPrompter, type Prompter } from "./prompter.js";
import { describeCwdMismatch, getRunOrigin, recordRunOrigin } from "./run-origin.js";
import { runInteractiveLoop } from "./run-loop.js";
import { stripControlSequences } from "./sanitize-terminal.js";
import { SystemConfig } from "../context/config.js";
import { getPendingInterrupt, getResumableRuns, startRun } from "../loop/runner.js";

export interface MainOverrides {
  profilesRoot?: string;
  prompter?: Prompter;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * PRD §0.2's known, permanent limitation: a Ctrl+C while a coder/tester
 * model call is in flight leaves that run genuinely stuck (not resumable —
 * `workflow_runs.current_state` never advanced past its pre-call value, and
 * there's no mid-node checkpoint to resume from either). Ctrl+C while
 * paused at a gate prompt, by contrast, is fully safe (`interrupt()` has
 * already returned and the checkpoint is already durably written). This
 * handler exists so a real Ctrl+C prints that distinction instead of a
 * silent hang or a raw stack trace — installed for the duration of one
 * `main()` call and removed afterward (both success and failure), so
 * repeated `main()` calls (every test in this file's own suite, and B8's
 * hard vertical slice) never accumulate `SIGINT` listeners.
 */
function installSigintHandler(): () => void {
  const handler = (): void => {
    console.error(
      warn(
        "\nInterrupted. If a model call was in flight, that run cannot be resumed — a known limitation " +
          "(start a new run with the same task text). If you were paused at a gate prompt, the run is safe " +
          "— run `aeloop list` to resume it.",
      ),
    );
    process.exit(130); // 128 + SIGINT's signal number 2, the conventional shell exit code.
  };
  process.once("SIGINT", handler);
  return () => process.removeListener("SIGINT", handler);
}

async function withDeps<T>(overrides: MainOverrides, fn: (deps: CliDeps) => Promise<T>): Promise<T> {
  // Always the real process.env — see MainOverrides's doc comment above for why `env` is not a
  // seam here (P1-3): letting a caller lie about which profile is active would defeat
  // assembleSubscriptionDeps()'s "no bypass path" guarantee.
  const profileName = process.env["AI_AGENT_PROFILE"] ?? "subscription";
  // Keep the subscription wrapper for compatibility with the A5 CLI contract;
  // every other profile uses the same neutral assembly path. This is the
  // switch that lets a company checkout provide its own `apikey` profile
  // without copying the engine or adding a company-specific runner.
  const deps = profileName === "subscription"
    ? assembleSubscriptionDeps(process.env, overrides.profilesRoot)
    : assembleProfileDeps(profileName, process.env, overrides.profilesRoot);
  try {
    return await fn(deps);
  } finally {
    deps.audit.close();
    deps.memoryStore.close();
    // SqliteSaver has no close() of its own (see checkpoint.ts) — its public `db` field is the
    // underlying better-sqlite3 connection assembleSubscriptionDeps()'s createSqliteCheckpointer()
    // opened; leaving it open leaks a file handle per aeloop command invocation (Zorro re-review
    // "顺手修"). `StartRunDeps.checkpointer` is typed as the generic `BaseCheckpointSaver` (shared
    // with runner.ts/graph.ts, which never need `.db`), but assemble.ts only ever constructs a
    // real `SqliteSaver` (checkpoint.ts's own header: "no MemorySaver equivalent here") — this
    // cast reflects that real, single construction site, not a speculative narrowing.
    (deps.checkpointer as SqliteSaver).db.close();
  }
}

async function runStart(task: string, overrides: MainOverrides): Promise<void> {
  await withDeps(overrides, async (deps) => {
    const prompter = overrides.prompter ?? new InquirerPrompter();
    const injectedContext = deps.injector.inject(task);
    const rejectThreshold = resolveRejectThreshold(deps.profileConfig, new SystemConfig(deps.memoryStore));

    const handle = await startRun(deps, {
      task,
      profile: deps.profileConfig.profile,
      workflowDefId: "coder-tester-loop",
      injectedContext,
      rejectThreshold,
    });
    // P0-2 (docs/feature/a5-cli-tui/test-report.md): record which directory this run was started
    // from, so a later `aeloop resume`/`aeloop list` from a different directory can warn instead
    // of silently spawning the coder/tester subprocess against the wrong repo. See run-origin.ts.
    recordRunOrigin(deps.profileDir, handle.runId, process.cwd());
    console.log(`Run #${handle.runId} started.`);

    const decidedBy = os.userInfo().username;
    await runInteractiveLoop(deps, prompter, handle, decidedBy);
  });
}

async function runResume(runId: number, overrides: MainOverrides): Promise<void> {
  await withDeps(overrides, async (deps) => {
    const prompter = overrides.prompter ?? new InquirerPrompter();

    // P0-2: a non-blocking nudge, not a lock — see run-origin.ts's header for why this is a
    // warning rather than a hard stop.
    const origin = getRunOrigin(deps.profileDir, runId);
    const currentCwd = process.cwd();
    if (origin !== undefined && origin.cwd !== currentCwd) {
      console.error(warn(describeCwdMismatch(runId, origin, currentCwd)));
    }

    const pending = await getPendingInterrupt(deps, runId);
    if (pending.done) {
      const run = deps.audit.getRunById(runId);
      throw new RunNotResumableError(runId, run?.status ?? "unknown");
    }

    console.log(`Resuming run #${runId}...`);
    const decidedBy = os.userInfo().username;
    await runInteractiveLoop(deps, prompter, pending, decidedBy);
  });
}

function formatRunsTable(rows: { id: number; task: string; currentState: string; updatedAt: string; cwd: string }[]): string {
  const header = ["id", "task", "currentState", "updatedAt", "cwd"];
  // task is user-typed (aeloop start "<task>") text, printed straight to the terminal — sanitized
  // the same way model-produced diff/issue text is (P1-4, sanitize-terminal.ts's header).
  const lines = rows.map((r) => [String(r.id), stripControlSequences(r.task), r.currentState, r.updatedAt, r.cwd]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  const formatRow = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  return [formatRow(header), ...lines.map(formatRow)].join("\n");
}

async function runList(overrides: MainOverrides): Promise<void> {
  await withDeps(overrides, async (deps) => {
    const running = getResumableRuns(deps, "running");
    const escalated = getResumableRuns(deps, "escalated");
    const rows = [...running, ...escalated];
    if (rows.length === 0) {
      console.log("No resumable runs.");
      return;
    }

    // P0-2: show each run's recorded origin directory, and flag (⚠) any that don't match where
    // `aeloop list` itself is being run from right now — the same nudge `runResume` gives, surfaced
    // before a human even types `aeloop resume`.
    const currentCwd = process.cwd();
    // P1-4 (docs/feature/a5-cli-tui/test-report.md), R4 fix: `currentCwd` is `process.cwd()`,
    // not model-controlled text, so the threat model this file's sanitization exists for is
    // genuinely not broken by leaving it unsanitized — but every string this file prints to the
    // terminal goes through the same sanitizer, no exceptions, so a reviewer never has to reason
    // about which printed field was the exception. Sanitized once here and reused below (the
    // mismatch banner) instead of leaving that one interpolation as the sole unstripped value.
    const displayCurrentCwd = stripControlSequences(currentCwd);
    let anyMismatch = false;
    const withOrigin = rows.map((r) => {
      const origin = getRunOrigin(deps.profileDir, r.id);
      if (origin === undefined) return { ...r, cwd: "(unknown)" };
      const mismatch = origin.cwd !== currentCwd; // mismatch check against the raw recorded value, not the sanitized display copy below
      if (mismatch) anyMismatch = true;
      // Same rationale as above: `origin.cwd` is `process.cwd()` at `aeloop start` time, not
      // model-controlled text, stripped anyway for defense-in-depth consistency.
      const displayCwd = stripControlSequences(origin.cwd);
      return { ...r, cwd: mismatch ? `${displayCwd} ⚠` : displayCwd };
    });

    console.log(formatRunsTable(withOrigin));
    if (anyMismatch) {
      console.log(
        warn(
          `⚠  One or more runs above were started from a different directory than the one you're in now ("${displayCurrentCwd}"). ` +
            "The coder/tester subprocess's working directory follows wherever you run `aeloop` from — resuming from here would spawn against this directory, not the run's original one.",
        ),
      );
    }
  });
}

/**
 * Real `--help`/`-h` output (Zorro re-review "顺手修" item) — before this
 * fix, `--help` fell through to the `default:` "unrecognized command"
 * branch and exited 1, even though the PRD's own §0.2 prose and this
 * repo's `README.md` "Getting started" section both already describe this
 * exact usage as the documented entry point.
 */
const HELP_TEXT = `aeloop — model-agnostic, governance-first workflow engine

Usage:
  aeloop start "<task description>"   Start a new run against AI_AGENT_PROFILE (default: subscription)
  aeloop resume <runId>               Resume a paused/escalated run — safe from a brand-new process
  aeloop list                         List resumable (running/escalated) runs
  aeloop --help, -h                   Show this help

Each gate (G1/G2/G3/Escalation) renders the coder/tester's diff/issues and prompts for a decision:
G1/G3 approve-or-reject, G2 approve-or-escalate, Escalation revise/force-pass/abandon.

See README.md's "Getting started" section for a full walkthrough.`;

function printHelp(): void {
  console.log(HELP_TEXT);
}

/**
 * The only long option this CLI recognizes at all — `--help`/`-h`. Declaring
 * it explicitly (rather than `parseArgs`'s bare `{}` this file used before)
 * is also what makes the unrecognized-option check below possible: with no
 * `options` config, `strict:false` alone gives no reliable way to tell "a
 * flag `parseArgs` doesn't know about" apart from "a flag this file
 * deliberately supports".
 */
const KNOWN_OPTIONS = { help: { type: "boolean", short: "h" } } as const;

async function dispatch(argv: string[], overrides: MainOverrides): Promise<void> {
  const { positionals, values, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: KNOWN_OPTIONS,
    tokens: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  // `strict:false` was chosen (PRD §6.7's judgment call, file header) so a genuinely unknown
  // `--flag` doesn't itself crash parseArgs — but silently swallowing it is its own footgun (Zorro
  // re-review "顺手修" item): a typo'd flag would otherwise just vanish with no feedback at all.
  // Report it as a clean error instead, the same way an unrecognized *command* already is below.
  const unknownOption = tokens.find((t) => t.kind === "option" && t.name !== "help" && t.name !== "h");
  if (unknownOption && unknownOption.kind === "option") {
    throw new Error(`aeloop: unrecognized option "${unknownOption.rawName}" (run "aeloop --help" for usage)`);
  }

  const [command, ...rest] = positionals;

  switch (command) {
    case "start": {
      // More than one positional after "start" almost always means an unquoted multi-word task
      // (`aeloop start fix the bug` instead of `aeloop start "fix the bug"`) — silently taking only
      // rest[0] and dropping the rest used to be exactly that "swallowed a mistake" footgun (Zorro
      // re-review "顺手修" item).
      if (rest.length > 1) {
        throw new Error(
          `aeloop start takes exactly one task argument, got ${rest.length} (did you forget to quote it?): aeloop start "<task>"`,
        );
      }
      const task = rest[0];
      if (task === undefined || task.trim().length === 0) {
        throw new Error('aeloop start requires a task argument: aeloop start "<task>"');
      }
      await runStart(task, overrides);
      return;
    }
    case "resume": {
      if (rest.length > 1) {
        throw new Error(`aeloop resume takes exactly one runId argument, got ${rest.length} (${JSON.stringify(rest)})`);
      }
      const runIdRaw = rest[0];
      const runId = runIdRaw !== undefined ? Number(runIdRaw) : NaN;
      if (!Number.isInteger(runId)) {
        throw new Error(`aeloop resume requires a numeric runId argument: aeloop resume <runId> (got ${JSON.stringify(runIdRaw)})`);
      }
      await runResume(runId, overrides);
      return;
    }
    case "list":
      if (rest.length > 0) {
        throw new Error(`aeloop list takes no arguments, got ${JSON.stringify(rest)}`);
      }
      await runList(overrides);
      return;
    case undefined:
      // Bare `aeloop` with no command at all — same "show usage instead of a bare error" posture
      // as `--help` above, not an error condition worth exit code 1 for.
      printHelp();
      return;
    default:
      throw new Error(`aeloop: unrecognized command ${JSON.stringify(command)} (expected "start", "resume", "list", or --help)`);
  }
}

export async function main(argv: string[], overrides: MainOverrides = {}): Promise<void> {
  const uninstallSigintHandler = installSigintHandler();
  try {
    await dispatch(argv, overrides);
  } catch (err) {
    console.error(danger(describeError(err)));
    process.exitCode = 1;
  } finally {
    uninstallSigintHandler();
  }
}
