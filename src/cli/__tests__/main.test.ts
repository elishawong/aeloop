/**
 * `main.ts` unit tests (PRD §6.7 / §8 B7). `assembleSubscriptionDeps()`/
 * `startRun`/`getPendingInterrupt`/`getResumableRuns`/`runInteractiveLoop`
 * are all mocked here — this file tests argv parsing, dispatch, error
 * handling (never a raw stack trace), and cleanup (`audit.close()`/
 * `memoryStore.close()` always run, success or failure), not the real
 * dependency graph or a real cli-bridge subprocess. The real, unmocked,
 * end-to-end proof — real fixtures, real `main.ts` dispatch — is B8's hard
 * vertical slice (`src/cli.e2e.test.ts`), which this file deliberately does
 * not duplicate.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../assemble.js";
import { UnsupportedProfileError } from "../errors.js";
import { getRunOrigin, recordRunOrigin } from "../run-origin.js"; // real module, not mocked — P0-2's own tests read/write this file's real fs I/O
import type { RunHandle } from "../../loop/runner.js";

const assembleSubscriptionDepsMock = vi.fn();
const assembleProfileDepsMock = vi.fn();
const resolveRejectThresholdMock = vi.fn();
vi.mock("../assemble.js", () => ({
  assembleSubscriptionDeps: (...args: unknown[]) => assembleSubscriptionDepsMock(...args),
  assembleProfileDeps: (...args: unknown[]) => assembleProfileDepsMock(...args),
  resolveRejectThreshold: (...args: unknown[]) => resolveRejectThresholdMock(...args),
}));

const startRunMock = vi.fn();
const getPendingInterruptMock = vi.fn();
const getResumableRunsMock = vi.fn();
vi.mock("../../loop/runner.js", () => ({
  startRun: (...args: unknown[]) => startRunMock(...args),
  getPendingInterrupt: (...args: unknown[]) => getPendingInterruptMock(...args),
  getResumableRuns: (...args: unknown[]) => getResumableRunsMock(...args),
}));

const runInteractiveLoopMock = vi.fn();
vi.mock("../run-loop.js", () => ({
  runInteractiveLoop: (...args: unknown[]) => runInteractiveLoopMock(...args),
}));

const { main } = await import("../main.js");

// P0-2 (docs/feature/a5-cli-tui/test-report.md): main.ts's runStart/runResume/runList are NOT
// mocked in this file (only assemble.js/runner.js/run-loop.js are) — they really call
// run-origin.ts's recordRunOrigin()/getRunOrigin(), which really touch the filesystem at
// `<profileDir>/run-origins.json`. A real, per-test temp directory (not a hardcoded path that may
// not exist) keeps that real fs access hermetic, same "own tmpDir, cleaned in afterEach" posture
// every other suite in this file's sibling test files already uses.
let stubProfileDir = "";

function makeStubDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    router: {} as CliDeps["router"],
    composer: {} as CliDeps["composer"],
    audit: { close: vi.fn(), getRunById: vi.fn() } as unknown as CliDeps["audit"],
    checkpointer: { db: { close: vi.fn() } } as unknown as CliDeps["checkpointer"],
    profileConfig: { profile: "subscription", providers: {}, roles: {} },
    injector: { inject: vi.fn().mockReturnValue({ memories: [] }) } as unknown as CliDeps["injector"],
    memoryStore: { close: vi.fn() } as unknown as CliDeps["memoryStore"],
    profileDir: stubProfileDir,
    ...overrides,
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  stubProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-main-test-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = undefined;
  if (stubProfileDir) fs.rmSync(stubProfileDir, { recursive: true, force: true });
  stubProfileDir = "";
});

describe("main — argv parsing errors (no dependency graph ever assembled)", () => {
  it("unrecognized command prints a clean error and sets exitCode 1, without calling assembleSubscriptionDeps", async () => {
    await main(["bogus"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("unrecognized command");
    expect(printed).not.toContain(" at "); // never a raw stack trace
  });

  it("start with no task argument prints a clean error and sets exitCode 1", async () => {
    await main(["start"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("requires a task argument");
  });

  it("顺手修: an unrecognized --flag is reported as a clean error, not silently swallowed", async () => {
    await main(["start", "add a function", "--bogus"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("unrecognized option");
    expect(printed).toContain("--bogus");
  });

  it("顺手修: an unquoted multi-word start task (>1 positional) is reported as a clean error, not silently truncated to the first word", async () => {
    await main(["start", "fix", "the", "bug"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("exactly one task argument");
  });

  it("顺手修: resume with more than one positional argument is reported as a clean error", async () => {
    await main(["resume", "9", "extra"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("exactly one runId argument");
  });

  it("顺手修: list with any positional argument is reported as a clean error", async () => {
    await main(["list", "extra"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("takes no arguments");
  });

  it("顺手修: --help prints usage and exits cleanly (exitCode undefined), without assembling any dependency graph", async () => {
    await main(["--help"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("Usage:");
    expect(printed).toContain("aeloop start");
    expect(printed).toContain("aeloop resume");
    expect(printed).toContain("aeloop list");
  });

  it("顺手修: -h is the same as --help", async () => {
    await main(["-h"]);
    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Usage:");
  });

  it("顺手修: bare aeloop with no command prints usage instead of an 'unrecognized command' error", async () => {
    await main([]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Usage:");
  });

  it("resume with a non-numeric runId prints a clean error and sets exitCode 1", async () => {
    await main(["resume", "not-a-number"]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("numeric runId");
  });
});

describe("main — start dispatch", () => {
  it("assembles deps, injects context, resolves the reject threshold, calls startRun with the right StartRunInput, prints 'Run #<id> started.', drives runInteractiveLoop, and cleans up", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    resolveRejectThresholdMock.mockReturnValue(3);
    const handle: RunHandle = { runId: 7, threadId: "thread-7", interrupt: { gate: "G1_SEND_TO_TESTER", payload: { gate: "G1_SEND_TO_TESTER", question: "q" } }, done: false, stepCounters: {} };
    startRunMock.mockResolvedValue(handle);
    runInteractiveLoopMock.mockResolvedValue({ ...handle, done: true });

    await main(["start", "add a function"]);

    expect(deps.injector.inject).toHaveBeenCalledWith("add a function");
    expect(startRunMock).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        task: "add a function",
        profile: "subscription",
        workflowDefId: "coder-tester-loop",
        rejectThreshold: 3,
        injectedContext: { memories: [] },
      }),
    );
    expect(runInteractiveLoopMock).toHaveBeenCalledWith(deps, expect.anything(), handle, expect.any(String));
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Run #7 started.");
    expect(deps.audit.close).toHaveBeenCalled();
    expect(deps.memoryStore.close).toHaveBeenCalled();
    // 顺手修 (test-report.md): withDeps() used to leave the checkpointer's underlying
    // better-sqlite3 connection (SqliteSaver.db) open — every command now closes it too.
    expect((deps.checkpointer as unknown as { db: { close: () => void } }).db.close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("a task argument that's only whitespace is rejected the same as a missing one", async () => {
    await main(["start", "   "]);
    expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("P0-2: records the run's origin cwd via run-origin.ts's real recordRunOrigin(), readable back with getRunOrigin()", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    resolveRejectThresholdMock.mockReturnValue(2);
    const handle: RunHandle = { runId: 42, threadId: "thread-42", interrupt: undefined, done: true, stepCounters: {} };
    startRunMock.mockResolvedValue(handle);
    runInteractiveLoopMock.mockResolvedValue(handle);

    await main(["start", "add a function"]);

    const origin = getRunOrigin(deps.profileDir, 42);
    expect(origin?.cwd).toBe(process.cwd());
  });
});

describe("main — resume dispatch", () => {
  it("a pending (not-done) run drives runInteractiveLoop with the reconstructed handle, and cleans up", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await main(["resume", "9"]);

    expect(getPendingInterruptMock).toHaveBeenCalledWith(deps, 9);
    expect(runInteractiveLoopMock).toHaveBeenCalledWith(deps, expect.anything(), pending, expect.any(String));
    expect(logSpy.mock.calls.flat().join("\n")).toContain("Resuming run #9");
    expect(deps.audit.close).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("an already-terminal run (done: true) throws RunNotResumableError, prints a clean message, sets exitCode 1, and still cleans up", async () => {
    const deps = makeStubDeps();
    (deps.audit.getRunById as ReturnType<typeof vi.fn>).mockReturnValue({ status: "completed" });
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    getPendingInterruptMock.mockResolvedValue({ runId: 3, threadId: "t", interrupt: undefined, done: true });

    await main(["resume", "3"]);

    expect(runInteractiveLoopMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("RunNotResumableError");
    expect(printed).toContain("completed");
    expect(printed).not.toContain(" at ");
    expect(deps.audit.close).toHaveBeenCalled(); // cleanup still ran despite the throw
    expect(deps.memoryStore.close).toHaveBeenCalled();
  });

  it("P0-2: warns (non-blocking) when the run's recorded origin cwd differs from the current cwd, then still resumes normally", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    recordRunOrigin(deps.profileDir, 9, "/some/other/repo", "2026-07-21T00:00:00.000Z");
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await main(["resume", "9"]);

    const printedWarning = errorSpy.mock.calls.flat().join("\n");
    expect(printedWarning).toContain("/some/other/repo");
    expect(printedWarning).toContain(process.cwd());
    expect(process.exitCode).toBeUndefined(); // a warning, not a failure — the resume still proceeded
    expect(runInteractiveLoopMock).toHaveBeenCalled();
  });

  it("P0-2: no warning when the run's recorded origin cwd matches the current cwd", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    recordRunOrigin(deps.profileDir, 9, process.cwd(), "2026-07-21T00:00:00.000Z");
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await main(["resume", "9"]);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("P0-2: no warning when no origin was ever recorded for the run (e.g. a run started before this fix existed)", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await main(["resume", "9"]);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  /**
   * B1 regression (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md`): before the
   * `run-origin.ts` fix, `getRunOrigin()` returned the raw (unvalidated) `null` for a sidecar entry
   * like `{"9": null}`, and this file's own `runResume` only guards `origin !== undefined` before
   * reading `origin.cwd` — `null !== undefined` is true, so this used to throw a real `TypeError`
   * ("Cannot read properties of null (reading 'cwd')") and abort the whole `resume` command with
   * exitCode 1. Confirmed reproduced (pre-fix) by Zorro/Codex `gpt-5.6-sol`. Post-fix, this must
   * degrade silently to "no origin recorded" — same as the "no warning when no origin was ever
   * recorded" case above — and the resume proceeds normally.
   */
  it("B1: a corrupted per-run sidecar entry ({\"<runId>\": null}) does not crash resume — degrades to no-warning and the resume still proceeds", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    fs.writeFileSync(path.join(deps.profileDir, "run-origins.json"), JSON.stringify({ "9": null }));
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await expect(main(["resume", "9"])).resolves.not.toThrow();

    expect(process.exitCode).toBeUndefined(); // not the exitCode 1 a crash would have set
    expect(errorSpy).not.toHaveBeenCalled(); // degraded to "no origin recorded", not a warning or a stack trace
    expect(runInteractiveLoopMock).toHaveBeenCalled(); // the resume actually proceeded, not aborted
  });

  it("B1: a corrupted per-run sidecar entry (a bare string, not an object) does not crash resume", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    fs.writeFileSync(path.join(deps.profileDir, "run-origins.json"), JSON.stringify({ "9": "not-an-object" }));
    const pending = { runId: 9, threadId: "thread-9", interrupt: { gate: "G2_SEND_TO_FIX", payload: { gate: "G2_SEND_TO_FIX", question: "q" } }, done: false };
    getPendingInterruptMock.mockResolvedValue(pending);
    runInteractiveLoopMock.mockResolvedValue({ ...pending, stepCounters: {} });

    await expect(main(["resume", "9"])).resolves.not.toThrow();

    expect(process.exitCode).toBeUndefined();
    expect(runInteractiveLoopMock).toHaveBeenCalled();
  });
});

describe("main — list dispatch", () => {
  it("selects the profile-neutral assembler for a company profile", async () => {
    const previous = process.env["AI_AGENT_PROFILE"];
    process.env["AI_AGENT_PROFILE"] = "company";
    const deps = makeStubDeps({ profileConfig: { profile: "company", providers: {}, roles: {} } });
    assembleProfileDepsMock.mockReturnValue(deps);
    getResumableRunsMock.mockReturnValue([]);
    try {
      await main(["list"]);
      expect(assembleProfileDepsMock).toHaveBeenCalledWith("company", process.env, undefined);
      expect(assembleSubscriptionDepsMock).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env["AI_AGENT_PROFILE"];
      else process.env["AI_AGENT_PROFILE"] = previous;
    }
  });

  it("prints a table of running + escalated runs (id/task/currentState/updatedAt)", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running"
        ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }]
        : [{ id: 2, task: "fix bug B", currentState: "escalation", updatedAt: "2026-07-21T01:00:00.000Z" }],
    );

    await main(["list"]);

    expect(getResumableRunsMock).toHaveBeenCalledWith(deps, "running");
    expect(getResumableRunsMock).toHaveBeenCalledWith(deps, "escalated");
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("add feature A");
    expect(printed).toContain("fix bug B");
    expect(printed).toContain("g1");
    expect(printed).toContain("escalation");
    expect(deps.audit.close).toHaveBeenCalled();
  });

  it("P0-2: flags a run whose recorded origin cwd differs from the current cwd, and prints a follow-up warning; a matching origin gets no flag", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    recordRunOrigin(deps.profileDir, 1, "/some/other/repo", "2026-07-21T00:00:00.000Z");
    recordRunOrigin(deps.profileDir, 2, process.cwd(), "2026-07-21T00:00:00.000Z");
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running"
        ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }]
        : [{ id: 2, task: "fix bug B", currentState: "escalation", updatedAt: "2026-07-21T01:00:00.000Z" }],
    );

    await main(["list"]);

    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("/some/other/repo ⚠"); // run #1's row, flagged
    const line2 = printed.split("\n").find((l: string) => l.includes(process.cwd()));
    expect(line2).toBeDefined();
    expect(line2).not.toContain("⚠"); // run #2's row, matching cwd, not flagged
    expect(printed).toContain("directory than the one you're in now"); // the follow-up explanation
  });

  // P1-4 (docs/feature/a5-cli-tui/test-report.md): runList's rendered "cwd" column comes from the
  // run-origins.json sidecar (a plain file on disk, not model output, but this file's own P1-4
  // fix goes through stripControlSequences() anyway for consistency with every other printed
  // string — no exception a reviewer has to remember).
  it("P1-4: strips control sequences from a recorded origin cwd before printing it in the list table", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    const ESC = "\x1B";
    recordRunOrigin(deps.profileDir, 1, `/repos/${ESC}[2Jaeloop`, "2026-07-21T00:00:00.000Z");
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running" ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }] : [],
    );

    await main(["list"]);

    // Scoped to the table itself (logSpy's first call, formatRunsTable's output) — not the whole
    // printed output, which also includes the mismatch-warning line, itself legitimately colored
    // with real ANSI codes by warn()/chalk (a different, expected source of ESC bytes).
    const table = String(logSpy.mock.calls[0]?.[0] ?? "");
    expect(table).not.toContain(ESC);
    expect(table).toContain("/repos/aeloop");
  });

  /**
   * R4 fix (Zorro R3 FAIL, `docs/feature/a5-cli-tui/test-report.md`): the P1-4 sweep above
   * covers the `runList` table's `cwd` column (`origin.cwd`, sourced from the run-origins.json
   * sidecar), but the separate mismatch-banner line `runList` prints below the table interpolates
   * `currentCwd` (`process.cwd()`) directly — that interpolation was never routed through
   * `stripControlSequences()`, unlike every other printed field in this file (including this same
   * `currentCwd` value's sibling use in `describeCwdMismatch()`, `run-origin.ts`, for the `resume`
   * path). `process.cwd()` isn't attacker-controlled in production, but the fix (and this test)
   * exist for the same defense-in-depth consistency reason P1-4 itself was written for: no printed
   * field is the unexplained exception a reviewer has to remember.
   */
  it("R4: strips control sequences from the current cwd before printing it in the list mismatch banner", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    const ESC = "\x1B";
    const maliciousCwd = `/repos/${ESC}[2Jaeloop`;
    vi.spyOn(process, "cwd").mockReturnValue(maliciousCwd);
    recordRunOrigin(deps.profileDir, 1, "/some/other/repo", "2026-07-21T00:00:00.000Z"); // deliberately different from maliciousCwd, to trigger the mismatch banner
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running" ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }] : [],
    );

    await main(["list"]);

    const printed = logSpy.mock.calls.flat().join("\n");
    const banner = printed.split("\n").find((l: string) => l.includes("directory than the one you're in now"));
    expect(banner).toBeDefined();
    // `warn()`/chalk legitimately wraps this whole banner in real SGR color codes (`ESC [ ... m`)
    // — a blanket "the banner contains no ESC byte at all" assertion would false-positive on that
    // expected wrapping. Strip only that SGR shape first, then assert zero ESC bytes remain: what's
    // under test is that `currentCwd`'s embedded malicious CSI sequence (`ESC[2J`, clear-screen) is
    // gone, not that the banner carries zero ANSI whatsoever.
    const withoutChalkSgr = (banner ?? "").replace(/\x1B\[[0-9;]*m/g, "");
    expect(withoutChalkSgr).not.toContain(ESC);
    expect(banner).toContain("/repos/aeloop"); // sanitized cwd still legible
    expect(banner).not.toContain("[2Jaeloop"); // the raw CSI sequence itself is gone, not just its ESC byte
  });

  it("P0-2: no mismatch warning when every listed run's recorded (or absent) origin matches the current cwd", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    recordRunOrigin(deps.profileDir, 1, process.cwd(), "2026-07-21T00:00:00.000Z");
    // run #2 has no recorded origin at all — "(unknown)", not a mismatch.
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running" ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }] : [{ id: 2, task: "fix bug B", currentState: "escalation", updatedAt: "2026-07-21T01:00:00.000Z" }],
    );

    await main(["list"]);

    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).not.toContain("⚠");
    expect(printed).toContain("(unknown)");
  });

  /**
   * B1 regression (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md`): `runList`'s
   * `getRunOrigin() === undefined` check (main.ts) has the exact same shape as `runResume`'s — a
   * raw `null` per-run entry used to sail past it and crash on `origin.cwd`. Same fix, same
   * regression coverage, at `runList`'s own call site this time.
   */
  it("B1: a corrupted per-run sidecar entry ({\"<runId>\": null}) does not crash list — that run renders as (unknown) instead", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    fs.writeFileSync(path.join(deps.profileDir, "run-origins.json"), JSON.stringify({ "1": null }));
    getResumableRunsMock.mockImplementation((_deps: unknown, status: string) =>
      status === "running" ? [{ id: 1, task: "add feature A", currentState: "g1", updatedAt: "2026-07-21T00:00:00.000Z" }] : [],
    );

    await expect(main(["list"])).resolves.not.toThrow();

    expect(process.exitCode).toBeUndefined();
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("(unknown)"); // degraded to no-origin, not a crash
    expect(printed).not.toContain("⚠");
  });

  it("prints a friendly message when there are no resumable runs", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    getResumableRunsMock.mockReturnValue([]);

    await main(["list"]);

    expect(logSpy.mock.calls.flat().join("\n")).toContain("No resumable runs.");
  });
});

describe("main — error handling never leaks a raw stack trace", () => {
  it("assembleSubscriptionDeps throwing UnsupportedProfileError is caught, printed as Name: message, and sets exitCode 1", async () => {
    assembleSubscriptionDepsMock.mockImplementation(() => {
      throw new UnsupportedProfileError("apikey");
    });

    await main(["start", "add a function"]);

    expect(process.exitCode).toBe(1);
    const printed = errorSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("UnsupportedProfileError");
    expect(printed).toContain("apikey");
    expect(printed).not.toContain(" at "); // never a raw stack trace
  });
});

describe("main — SIGINT handler is installed and removed per call, never accumulates listeners", () => {
  it("listener count returns to its pre-call baseline after main() resolves, across repeated calls", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    getResumableRunsMock.mockReturnValue([]);

    const baseline = process.listenerCount("SIGINT");
    await main(["list"]);
    expect(process.listenerCount("SIGINT")).toBe(baseline);
    await main(["list"]);
    expect(process.listenerCount("SIGINT")).toBe(baseline);
  });

  it("a real SIGINT during the call prints the known-limitation message and exits — the handler this PRD's §0.2 documents", async () => {
    const deps = makeStubDeps();
    assembleSubscriptionDepsMock.mockReturnValue(deps);
    getResumableRunsMock.mockReturnValue([]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    // Trigger SIGINT synchronously mid-dispatch by having getResumableRuns itself emit it —
    // simulates "Ctrl+C while a command is running" without ever sending a real OS signal.
    getResumableRunsMock.mockImplementation(() => {
      process.emit("SIGINT");
      return [];
    });

    await main(["list"]);

    expect(exitSpy).toHaveBeenCalledWith(130);
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("cannot be resumed");
  });
});
