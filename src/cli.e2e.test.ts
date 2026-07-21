/**
 * B8 — A5's mandatory hard vertical slice (DESIGN §8.5 / PRD §2/§8): a real
 * end-to-end run driven through `src/cli/main.ts`'s real command dispatch
 * (`main()`, imported directly — not a subprocess spawn of `dist/cli/bin.js`,
 * same "hard vertical slice tests the real function, not a rebuild of the
 * production entry shim" posture the rest of this file's sibling `*.e2e.
 * test.ts` files already take), against the real `subscription`-profile
 * dependency graph `src/cli/assemble.ts` assembles — real `MemoryStore`/
 * `ContextInjector`/`PromptComposer`/`buildAdapterRegistry`/`ProviderRouter`/
 * real `AuditStore`+checkpointer sharing one file — with a scripted
 * `FakePrompter` standing in for a human at the keyboard (PRD §6.4/§2's
 * explicit acceptance target) and real cli-bridge fixture subprocesses
 * (`fake-claude.fixture.mjs`/`fake-codex.fixture.mjs`), the same
 * fixture-substitution boundary `src/loop.e2e.test.ts` already established.
 *
 * **What's real vs. what's replaced** (identical split to
 * `src/loop.e2e.test.ts`'s own header): real all the way from
 * `main()`'s argv dispatch through `assembleSubscriptionDeps()`'s real
 * object graph, through the real `src/loop/` graph, to `applied: true`/
 * `cancelled` on disk. The only thing replaced is the process on the other
 * end of each `spawn()` — `bin` overrides in this test's fixture
 * `config.yaml` point at the fixture scripts instead of the real
 * `claude`/`codex` binaries — and the human at the interactive prompts,
 * replaced by a `FakePrompter` script (not a mock of `main.ts`'s own
 * logic — `main()`'s real dispatch, real `assembleSubscriptionDeps()`, and
 * real `runInteractiveLoop()` all run for real here, unlike `main.test.ts`,
 * which mocks all three to unit-test `main.ts`'s own dispatch/error-handling
 * logic in isolation).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "./profile/loader.js";
import { MemoryStore } from "./context/store.js";
import { AuditStore } from "./loop/audit-store.js";
import { main } from "./cli/main.js";
import { FakePrompter } from "./cli/prompter.js";

const NOW = "2026-07-21T00:00:00.000Z";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_FIXTURE = path.join(HERE, "harness", "adapters", "__tests__", "fixtures", "fake-claude.fixture.mjs");
const FAKE_CODEX_FIXTURE = path.join(HERE, "harness", "adapters", "__tests__", "fixtures", "fake-codex.fixture.mjs");
const CLAUDE_SCENARIO_ENV = "FAKE_CLAUDE_SCENARIO";
const CODEX_SCENARIO_ENV = "FAKE_CODEX_SCENARIO";

const REAL_SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

let tmpDir = "";

/**
 * `main()`'s `MainOverrides` no longer accepts an `env` override (P1-3,
 * `docs/feature/a5-cli-tui/test-report.md`, 2026-07-21 Zorro re-review) —
 * `assembleSubscriptionDeps()` inside `main()` is always called with the
 * real `process.env`, on purpose (see `main.ts`'s own header for why that
 * seam was a "no bypass path" security gap, not a legitimate test-only
 * convenience). This suite scopes the real `process.env.AI_AGENT_PROFILE`
 * instead — set to `"subscription"` for the duration of each test, restored
 * to whatever it was before, same "temporarily mutate, always restore"
 * posture `CLAUDE_SCENARIO_ENV`/`CODEX_SCENARIO_ENV` below already use.
 */
let originalAiAgentProfile: string | undefined;

beforeEach(() => {
  process.exitCode = undefined;
  originalAiAgentProfile = process.env["AI_AGENT_PROFILE"];
  process.env["AI_AGENT_PROFILE"] = "subscription";
});

afterEach(() => {
  delete process.env[CLAUDE_SCENARIO_ENV];
  delete process.env[CODEX_SCENARIO_ENV];
  delete process.env["FAKE_CLAUDE_PROMPT_CAPTURE_FILE"];
  if (originalAiAgentProfile === undefined) delete process.env["AI_AGENT_PROFILE"];
  else process.env["AI_AGENT_PROFILE"] = originalAiAgentProfile;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  process.exitCode = undefined;
});

/**
 * Builds `<tmpDir>/subscription/{config.yaml,personas/}` — a real
 * `profilesRoot` for `assembleSubscriptionDeps()` to load, aligned to the
 * real, committed `profiles/subscription/config.yaml`'s role bindings
 * (coder -> claude-cli, tester -> codex-cli), `bin` overriding only the
 * spawn target (same "cmd flavor unchanged, bin spawn override" pattern
 * `harness/config.ts`/`harness-cli.e2e.test.ts` already established) — not
 * a from-scratch fixture config, a faithful copy of the real one plus the
 * two `bin` overrides this test needs. Real persona files are copied in
 * (not symlinked, to keep this test hermetic against the real profile
 * directory being edited concurrently) so `PromptComposer`'s real
 * `compose()` call has real persona text to load.
 */
function buildFixtureProfilesRoot(rejectThreshold: number): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-cli-e2e-"));
  const profileDir = path.join(tmpDir, "subscription");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.cpSync(REAL_SUBSCRIPTION_PERSONAS_DIR, path.join(profileDir, "personas"), { recursive: true });

  const configYaml = `
profile: subscription

providers:
  claude-cli:
    kind: cli-bridge
    cmd: claude
    bin: ${JSON.stringify(FAKE_CLAUDE_FIXTURE)}
  codex-cli:
    kind: cli-bridge
    cmd: codex
    bin: ${JSON.stringify(FAKE_CODEX_FIXTURE)}

roles:
  coder:
    provider: claude-cli
  tester:
    provider: codex-cli

workflow:
  reject_threshold: ${rejectThreshold}
`;
  fs.writeFileSync(path.join(profileDir, "config.yaml"), configYaml);
  return tmpDir;
}

/** Seeds `<profilesRoot>/subscription/memory.db` with one real memory before `main()` ever opens it — sanity that the injected context flowing into the real graph is genuinely real, not a stub (mirrors `loop.e2e.test.ts`'s identical setup). */
function seedMemory(profilesRoot: string): void {
  const memoryDbPath = path.join(profilesRoot, "subscription", "memory.db");
  const store = new MemoryStore(memoryDbPath);
  try {
    store.insertMemory(
      { type: "decision", title: "Build tooling", content: "aeloop uses pnpm as its package manager.", confidenceState: "confirmed" },
      NOW,
    );
  } finally {
    store.close();
  }
}

/** Reads the one `workflow_runs` row this test's fresh `workflow.db` should hold, via an independent read-only-in-spirit `AuditStore` connection (mirrors `loop.e2e.test.ts`'s pattern of reading real on-disk state after `main()`'s own `AuditStore` instance has already closed). */
function readSoleRun(profilesRoot: string): ReturnType<AuditStore["getRunById"]> {
  const workflowDbPath = path.join(profilesRoot, "subscription", "workflow.db");
  const audit = new AuditStore(workflowDbPath);
  try {
    const running = audit.listRunsByStatus("running");
    const escalated = audit.listRunsByStatus("escalated");
    const completed = audit.listRunsByStatus("completed");
    const cancelled = audit.listRunsByStatus("cancelled");
    const all = [...running, ...escalated, ...completed, ...cancelled];
    expect(all).toHaveLength(1); // test guard: this fixture profilesRoot is fresh per test, exactly one run expected
    return all[0];
  } finally {
    audit.close();
  }
}

describe("CLI hard vertical slice — real main() dispatch, real subscription-profile dependency graph, real cli-bridge fixtures, FakePrompter", () => {
  it("happy path: aeloop start drives G1 approve -> G3 approve -> applied, through real main() dispatch", async () => {
    process.env[CLAUDE_SCENARIO_ENV] = "claims-no-trace";
    process.env[CODEX_SCENARIO_ENV] = "tester-pass";

    const profilesRoot = buildFixtureProfilesRoot(2);
    seedMemory(profilesRoot);

    // P1-4 "🟡" item 4 (test-report.md): prove the seeded memory's actual *content* reached the
    // coder subprocess's real prompt, not just that some prompt was sent — fake-claude.fixture.mjs
    // opt-in-appends the real -p text it received to this file when the env var is set.
    const promptCaptureFile = path.join(profilesRoot, "captured-coder-prompt.txt");
    process.env["FAKE_CLAUDE_PROMPT_CAPTURE_FILE"] = promptCaptureFile;

    const prompter = new FakePrompter({ confirm: [true, true] }); // G1 approve, G3 approve

    await main(["start", "Add a function that reverses a string, and report on it."], {
      profilesRoot,
      prompter,
    });

    expect(process.exitCode).toBeUndefined(); // no error path was hit

    const run = readSoleRun(profilesRoot);
    expect(run).toMatchObject({ status: "completed", currentState: "apply", profile: "subscription" });

    // The prompter really drove both real gates, in order.
    expect(prompter.calls.map((c) => c.kind)).toEqual(["confirm", "confirm"]);

    // The seeded memory's real content (not a placeholder) really reached the coder's real,
    // composed prompt — closing the gap where seeding an unrelated/empty memory would have made
    // this suite pass identically (test-report.md's exact "false green" description).
    const capturedPrompt = fs.readFileSync(promptCaptureFile, "utf8");
    expect(capturedPrompt).toContain("aeloop uses pnpm as its package manager.");
    delete process.env["FAKE_CLAUDE_PROMPT_CAPTURE_FILE"];
  });

  it("escalation path: reject_count reaches threshold -> Escalation gate -> force_pass -> G3 approve -> applied, through real main() dispatch", async () => {
    process.env[CLAUDE_SCENARIO_ENV] = "claims-no-trace";
    process.env[CODEX_SCENARIO_ENV] = "tester-reject"; // rejects on every real codex invocation

    const profilesRoot = buildFixtureProfilesRoot(2);
    seedMemory(profilesRoot);

    // G1 approve(round1) -> review(reject #1, below threshold) -> G2 approve(fix-forward) ->
    // draft(round2) -> G1 approve -> review(reject #2, AT threshold) -> Escalation force_pass ->
    // G3 approve -> applied. Purely from the graph's own reject_count bookkeeping (same "no
    // hardcoded round count, driven by whichever gate is actually pending" posture
    // src/loop.e2e.test.ts's own escalation slice already established), not this test varying
    // what the fixture emits.
    const prompter = new FakePrompter({ confirm: [true, true, true], select: ["approved", "force_pass"] });

    await main(["start", "Add a function that reverses a string, and report on it."], {
      profilesRoot,
      prompter,
    });

    expect(process.exitCode).toBeUndefined();

    const run = readSoleRun(profilesRoot);
    expect(run).toMatchObject({ status: "completed", currentState: "apply", rejectCount: 2, rejectThreshold: 2 });

    // Real approvals rows really landed, including the ESCALATION_ACK force_pass decision — a raw,
    // independent connection to the same on-disk workflow.db, same pattern loop.e2e.test.ts/
    // runner.test.ts already use for this kind of ground-truth check.
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(profilesRoot, "subscription", "workflow.db");
    const db = new Database(dbPath, { readonly: true });
    try {
      const approvalRows = db
        .prepare("SELECT gate_type, decision FROM approvals WHERE run_id = ? ORDER BY id")
        .all(run?.id) as Array<{ gate_type: string; decision: string }>;
      expect(approvalRows.filter((r) => r.gate_type === "G1_SEND_TO_TESTER")).toHaveLength(2);
      expect(approvalRows.filter((r) => r.gate_type === "G2_SEND_TO_FIX")).toHaveLength(1);
      const escalationRow = approvalRows.find((r) => r.gate_type === "ESCALATION_ACK");
      expect(escalationRow).toMatchObject({ decision: "force_pass" });
      expect(approvalRows.filter((r) => r.gate_type === "G3_FINAL_MERGE")).toHaveLength(1);
    } finally {
      db.close();
    }

    expect(prompter.calls.map((c) => c.kind)).toEqual(["confirm", "select", "confirm", "select", "confirm"]);
  });

  /**
   * P1-5 (`docs/feature/a5-cli-tui/test-report.md`): before this test, B8's two cases only ever
   * drove `main(["start", ...])` — `runInteractiveLoop()` looped a single run through *every* gate
   * inside one `main()` call, so `main(["resume", ...])`'s real, fresh-process path (PRD §10's own
   * core acceptance target: "SIGINT -> fresh process `aeloop resume` -> runs to completion") was
   * never actually exercised end to end here — `main.test.ts`'s `resume` tests all mock
   * `getPendingInterrupt`/`runInteractiveLoop` away, so neither file could have caught a real
   * regression in `resume`'s wiring. This test drives it for real, through two genuinely separate
   * `main()` calls with their own `FakePrompter` (no in-memory state shared between them) — the
   * only thing they share is the same on-disk `profilesRoot`, exactly what a second CLI process
   * would share with the first.
   */
  it("cross-process resume: a second, independent main() call reconstructs the pending gate via getPendingInterrupt() and drives the run to completion — no in-memory RunHandle reused", async () => {
    process.env[CLAUDE_SCENARIO_ENV] = "claims-no-trace";
    process.env[CODEX_SCENARIO_ENV] = "tester-pass";

    const profilesRoot = buildFixtureProfilesRoot(2);
    seedMemory(profilesRoot);

    // "Process 1": starts the run, approves G1 for real, but its FakePrompter script only has one
    // scripted confirm() answer — it runs dry exactly when G3's prompt asks for a decision,
    // throwing FakePrompterExhaustedError and aborting main() with exitCode 1. By that point,
    // resumeRun()'s G1 decision has already durably advanced the checkpoint/workflow_runs to a
    // real G3 pause (R6-B2's per-chunk audit sync, src/loop/audit-store.ts) — the same "safe to
    // Ctrl+C here" state PRD §0.2 documents for a human sitting at a real gate prompt. This
    // simulates that process ending right there, without faking anything about the run's own state.
    const firstProcessPrompter = new FakePrompter({ confirm: [true] }); // G1 approve only
    await main(["start", "Add a function that reverses a string, and report on it."], {
      profilesRoot,
      prompter: firstProcessPrompter,
    });
    expect(process.exitCode).toBe(1); // FakePrompterExhaustedError at G3's confirm() — "process 1 died here"
    // Two confirm() *attempts* were recorded — G1 (answered) and G3 (attempted, then exhausted;
    // FakePrompter.confirm() records the call before checking whether an answer is left) — but
    // only one real decision (G1's) actually made it into resumeRun().
    expect(firstProcessPrompter.calls.map((c) => c.kind)).toEqual(["confirm", "confirm"]);

    const runAfterFirstProcess = readSoleRun(profilesRoot);
    expect(runAfterFirstProcess).toMatchObject({ status: "running", currentState: "g3" });
    process.exitCode = undefined; // this suite's own next "process" — reset the shared field

    // "Process 2": a completely separate main() call, its own FakePrompter, zero references to
    // anything process 1 built in memory (no shared handle, no shared prompter). assembleSubscriptionDeps()
    // inside this main() call opens brand-new AuditStore/checkpointer connections against the same
    // on-disk profilesRoot — the real mechanism a genuinely separate OS process resuming this run
    // would use, not a simulation of it.
    const secondProcessPrompter = new FakePrompter({ confirm: [true] }); // G3 approve
    await main(["resume", String(runAfterFirstProcess?.id)], {
      profilesRoot,
      prompter: secondProcessPrompter,
    });

    expect(process.exitCode).toBeUndefined();
    expect(secondProcessPrompter.calls.map((c) => c.kind)).toEqual(["confirm"]); // only ever asked for G3 — G1 was not replayed

    const runAfterSecondProcess = readSoleRun(profilesRoot);
    expect(runAfterSecondProcess).toMatchObject({ status: "completed", currentState: "apply" });

    // Ground truth on disk: exactly one G1 approval (from process 1) and one G3 approval (from
    // process 2) — proves getPendingInterrupt() really reconstructed G3's pending payload rather
    // than, say, silently re-running G1 or fabricating a decision.
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(profilesRoot, "subscription", "workflow.db");
    const db = new Database(dbPath, { readonly: true });
    try {
      const approvalRows = db
        .prepare("SELECT gate_type, decision FROM approvals WHERE run_id = ? ORDER BY id")
        .all(runAfterSecondProcess?.id) as Array<{ gate_type: string; decision: string }>;
      expect(approvalRows.filter((r) => r.gate_type === "G1_SEND_TO_TESTER")).toHaveLength(1);
      expect(approvalRows.filter((r) => r.gate_type === "G3_FINAL_MERGE")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
