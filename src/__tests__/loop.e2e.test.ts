/**
 * B5 — A4a's hardest requirement (PRD §5 "vertical slice (A4a wrap-up,
 * hard deliverable)" / DESIGN §8.5's "every aeloop milestone wrap-up must
 * have one thin vertical slice actually wired end-to-end"),
 * this time proving the *Loop* seam: that a real, composed prompt flows
 * all the way from Context through a real cli-bridge `ModelAdapter`
 * (controlled fixture subprocess, mirroring `harness-cli.e2e.test.ts`'s
 * B6) through the real `src/loop/` graph — real `SqliteSaver`
 * checkpointer, real `interrupt()`/`Command({resume})` at G1 and G3 — to
 * `applied: true`.
 *
 * **What's real vs. what's replaced**:
 * - Real: `MemoryStore` -> `ContextInjector` -> `PromptComposer` (identical
 *   setup to `harness-cli.e2e.test.ts`).
 * - Real: `buildAdapterRegistry()` -> `ProviderRouter` -> real
 *   `ClaudeCliAdapter`/`CodexCliAdapter` instances, each really `spawn()`ing
 *   a subprocess and really parsing its stdout.
 * - Real: `buildLoopGraph()`/`compileLoopGraph()` (`src/loop/graph.ts`) —
 *   driven here with real subprocess-backed `ModelAdapter`s, not
 *   FakeAdapter-backed deps (that's `graph.test.ts`/`checkpoint.test.ts`'s
 *   job) — this is the one place all of A4a's layers are simultaneously
 *   real.
 * - Real: `createSqliteCheckpointer()` pointed at a real temp file.
 * - **The only thing replaced**: the process on the other end of each
 *   spawn — `bin` overrides point at `fake-claude.fixture.mjs`/
 *   `fake-codex.fixture.mjs` instead of the real `claude`/`codex` binaries
 *   (same "real but controlled" boundary as `harness-cli.e2e.test.ts`).
 *
 * **Role binding matters here** (PRD §5's explicit warning): `coder` binds
 * to `claude-cli`, `tester` binds to `codex-cli` — the same direction as
 * the real, committed `profiles/subscription/config.yaml` (DESIGN §7).
 * Swapping them would still produce *a* schema-valid result (nothing in
 * the harness layer would error), but it would silently misrepresent which
 * real CLI plays which role — this test asserts `coderResult.provider`/
 * `testerResult.provider` explicitly to catch that class of mistake.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "@langchain/langgraph";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../profile/loader.js";
import type { ProfileConfig } from "../profile/loader.js";
import { MemoryStore } from "../context/store.js";
import { SystemConfig } from "../context/config.js";
import { StalenessEngine } from "../context/staleness.js";
import { ContextInjector } from "../context/injector.js";
import { PromptComposer } from "../prompt/composer.js";
import { buildAdapterRegistry } from "../harness/config.js";
import { ProviderRouter } from "../harness/provider-router.js";
import { buildLoopGraph, compileLoopGraph } from "../loop/graph.js";
import { createSqliteCheckpointer } from "../loop/checkpoint.js";
import { AuditStore } from "../loop/audit-store.js";
import { startRun, resumeRun, type RunHandle } from "../loop/runner.js";
import type { GateResumeValue, LoopNodeName, LoopStateType } from "../loop/types.js";
import type { CoderOutput } from "../prompt/schema.js";

const NOW = "2026-07-21T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_FIXTURE = path.join(HERE, "..", "harness", "adapters", "__tests__", "fixtures", "fake-claude.fixture.mjs");
const FAKE_CODEX_FIXTURE = path.join(HERE, "..", "harness", "adapters", "__tests__", "fixtures", "fake-codex.fixture.mjs");
const CLAUDE_SCENARIO_ENV = "FAKE_CLAUDE_SCENARIO";
const CODEX_SCENARIO_ENV = "FAKE_CODEX_SCENARIO";

/** `buildLoopGraph()`'s real compiled node union, minus `"__end__"` (not a valid `Command.goto` target — see `gates.test.ts`'s `resumeCommand` doc). */
type RealGraphNode = Exclude<LoopNodeName, "__end__">;

function resumeCommand(resume: GateResumeValue) {
  return new Command<GateResumeValue, Record<string, unknown>, RealGraphNode>({ resume });
}

/** This suite's fixtures always exercise the `"changed"` path — this just narrows the assertion access, not a production helper. */
function changedDiff(output: CoderOutput | undefined): string | undefined {
  return output?.status === "changed" ? output.diff : undefined;
}

const openStores: MemoryStore[] = [];
const openAudits: AuditStore[] = [];
let tmpDir = "";

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
  while (openAudits.length > 0) openAudits.pop()?.close();
  delete process.env[CLAUDE_SCENARIO_ENV];
  delete process.env[CODEX_SCENARIO_ENV];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

describe("Context -> Prompt -> Harness (real cli-bridge fixtures) -> Loop (real graph + real SqliteSaver) vertical slice", () => {
  it("a real composed task flows through coder(claude-cli)/tester(codex-cli), G1+G3 interrupt/resume, to applied: true", async () => {
    // `claims-no-trace` (fake-claude.fixture.mjs): schema-valid CoderOutput
    // JSON as the final answer, no tool_use in the stream — sufficient
    // here, this slice isn't exercising ToolExecVerifier (that's B6 of A3).
    process.env[CLAUDE_SCENARIO_ENV] = "claims-no-trace";
    // `tester-pass` (fake-codex.fixture.mjs, added by this PRD — see that
    // file's header): schema-valid TesterOutput JSON with verdict "pass".
    process.env[CODEX_SCENARIO_ENV] = "tester-pass";

    const task = "Add a function that reverses a string, and report on it.";

    // ---- 1. Real Context -> Prompt chain (identical setup to harness-cli.e2e.test.ts) ----
    const store = new MemoryStore(":memory:");
    openStores.push(store);
    store.insertMemory(
      { type: "decision", title: "Build tooling", content: "aeloop uses pnpm as its package manager.", confidenceState: "confirmed" },
      NOW,
    );
    const config = new SystemConfig(store);
    config.set("default_stale_days", "30", NOW);
    const staleness = new StalenessEngine(config);
    const injector = new ContextInjector(store, staleness);
    const injectedContext = injector.inject(task, new Date(NOW));

    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);

    // Sanity: the injected context really is real, not a stub (the loop
    // graph's nodes will compose their own prompts from this internally).
    expect(injectedContext.memories.length).toBeGreaterThan(0);

    // ---- 2. In-memory fixture ProfileConfig — aligned to the real,
    // committed profiles/subscription/config.yaml's role bindings (DESIGN
    // §7: coder -> claude-cli, tester -> codex-cli), `bin` overriding only
    // the spawn target (A3's established `cmd` (flavor, unchanged) + `bin`
    // (spawn override) pattern). ---------------------------------------
    const fixtureConfig: ProfileConfig = {
      profile: "fixture",
      providers: {
        "claude-cli": { kind: "cli-bridge", cmd: "claude", bin: FAKE_CLAUDE_FIXTURE },
        "codex-cli": { kind: "cli-bridge", cmd: "codex", bin: FAKE_CODEX_FIXTURE },
      },
      roles: {
        coder: { provider: "claude-cli" },
        tester: { provider: "codex-cli" },
      },
    };

    // ---- 3. Real buildAdapterRegistry -> real ProviderRouter -----------
    const registry = buildAdapterRegistry(fixtureConfig);
    const router = new ProviderRouter(fixtureConfig.roles, registry);

    // ---- 4. Real checkpointer, real graph, real compile -----------------
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-loop-e2e-"));
    const dbPath = path.join(tmpDir, "loop-e2e.sqlite");
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router, composer }), checkpointer);

    const threadId = "loop-e2e-happy-path";
    const cfg = { configurable: { thread_id: threadId } };

    const initialState: LoopStateType = {
      task,
      feedback: undefined,
      injectedContext,
      coderOutput: undefined,
      coderResult: undefined,
      testerOutput: undefined,
      testerResult: undefined,
      rejectCount: 0,
      g1Decision: undefined,
      g2Decision: undefined,
      g3Decision: undefined,
      gateLog: [],
      applied: false,
      rejectThreshold: 2,
      escalationDecision: undefined,
      cancelled: false,
      noChange: false,
    };

    // ---- 5. First invoke: real coder cli-bridge call, should stop at G1 ----
    await compiled.invoke(initialState, cfg);
    const afterDraft = await compiled.getState(cfg);
    expect(afterDraft.next).toEqual(["g1"]);
    expect(changedDiff(afterDraft.values.coderOutput)).toContain("+new");
    expect(afterDraft.values.coderResult?.provider).toBe("claude-cli");

    // ---- 6. Resume G1 (approve): real tester cli-bridge call, should stop at G3 ----
    await compiled.invoke(resumeCommand({ decision: "approved", reasoningText: "diff looks correct" }), cfg);
    const afterReview = await compiled.getState(cfg);
    expect(afterReview.next).toEqual(["g3"]);
    expect(afterReview.values.testerOutput?.verdict).toBe("pass");
    expect(afterReview.values.testerResult?.provider).toBe("codex-cli");

    // ---- 7. Resume G3 (approve): runs to completion ----------------------
    const final = await compiled.invoke(resumeCommand({ decision: "approved", reasoningText: "ship it" }), cfg);

    // ---- 8. Assertions on the final typed result --------------------------
    expect(final.applied).toBe(true);

    // Typed, schema-valid results — not raw JSON.
    expect(changedDiff(final.coderOutput)).toContain("+new");
    expect(final.coderOutput?.confidence).toBe("verified");
    expect(final.testerOutput?.verdict).toBe("pass");

    // Role <-> adapter binding really matches the real config.yaml direction.
    expect(final.coderResult?.provider).toBe("claude-cli");
    expect(final.testerResult?.provider).toBe("codex-cli");

    // G1/G3 gate log entries exist and both record "approved".
    const g1Entries = final.gateLog.filter((entry) => entry.gate === "G1_SEND_TO_TESTER");
    const g3Entries = final.gateLog.filter((entry) => entry.gate === "G3_FINAL_MERGE");
    expect(g1Entries).toHaveLength(1);
    expect(g1Entries[0]?.decision).toBe("approved");
    expect(g3Entries).toHaveLength(1);
    expect(g3Entries[0]?.decision).toBe("approved");
  });

  /**
   * A4b's hardest requirement (docs/feature/a4b-loop/PRD.md §2/§8's
   * "vertical slice must be wired end-to-end (including escalation)"): the same real chain as the happy-path
   * slice above, but driven through `runner.ts`'s `startRun()`/
   * `resumeRun()` — not raw `compiled.invoke()`/`Command` — because
   * `runner.ts` is the only layer that actually writes `AuditStore`'s
   * three tables; bypassing it here would just be hand-rolling a second,
   * redundant audit-writer instead of proving the real one. `tester-reject`
   * (added to `fake-codex.fixture.mjs` by this PRD) rejects on every real
   * `codex` invocation, so two real review rounds — first below
   * `rejectThreshold: 2`, routed through G2's normal fix-forward path, then
   * at it, routed to `escalation` instead — happen purely from the graph's
   * own `reject_count` bookkeeping, not from varying what the fixture
   * emits. `AuditStore` and the checkpointer share one on-disk file (PRD
   * §9.2 Decision 3, exercised here with real cli-bridge adapters, not just
   * `runner.test.ts`'s FakeAdapter).
   */
  it("a real run that hits rejectThreshold routes to escalation, force_pass reaches G3/apply, and the three audit tables hold the run's full decision history", async () => {
    process.env[CLAUDE_SCENARIO_ENV] = "claims-no-trace";
    process.env[CODEX_SCENARIO_ENV] = "tester-reject";

    const task = "Add a function that reverses a string, and report on it.";

    const store = new MemoryStore(":memory:");
    openStores.push(store);
    store.insertMemory(
      { type: "decision", title: "Build tooling", content: "aeloop uses pnpm as its package manager.", confidenceState: "confirmed" },
      NOW,
    );
    const config = new SystemConfig(store);
    config.set("default_stale_days", "30", NOW);
    const staleness = new StalenessEngine(config);
    const injector = new ContextInjector(store, staleness);
    const injectedContext = injector.inject(task, new Date(NOW));

    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);

    const fixtureConfig: ProfileConfig = {
      profile: "fixture",
      providers: {
        "claude-cli": { kind: "cli-bridge", cmd: "claude", bin: FAKE_CLAUDE_FIXTURE },
        "codex-cli": { kind: "cli-bridge", cmd: "codex", bin: FAKE_CODEX_FIXTURE },
      },
      roles: {
        coder: { provider: "claude-cli" },
        tester: { provider: "codex-cli" },
      },
    };

    const registry = buildAdapterRegistry(fixtureConfig);
    const router = new ProviderRouter(fixtureConfig.roles, registry);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-loop-e2e-escalation-"));
    const dbPath = path.join(tmpDir, "loop-e2e-escalation.sqlite");
    const checkpointer = createSqliteCheckpointer(dbPath);
    const audit = new AuditStore(dbPath);
    openAudits.push(audit);

    const deps = { router, composer, audit, checkpointer };

    // ---- Drive the run purely by reacting to whichever gate it's paused at — no hardcoded step count. ----
    let handle: RunHandle = await startRun(deps, {
      task,
      profile: "fixture",
      workflowDefId: "coder-tester-loop",
      injectedContext,
      rejectThreshold: 2,
    });

    let rounds = 0;
    while (!handle.done) {
      rounds += 1;
      if (rounds > 10) throw new Error("test guard: too many rounds, the run never reached a terminal node");

      const gate = handle.interrupt?.gate;
      if (gate === undefined) throw new Error("test guard: handle not done but no interrupt present");

      if (gate === "ESCALATION_ACK") {
        handle = await resumeRun(deps, handle.runId, handle.threadId, { decision: "force_pass", reasoningText: "ship it despite the tester's finding" }, "test-harness", handle.stepCounters);
      } else {
        // G1/G2/G3 all get approved — the point of this slice is proving the threshold/escalation wiring, not exercising every rejection branch again (graph.test.ts/runner.test.ts already do).
        handle = await resumeRun(deps, handle.runId, handle.threadId, { decision: "approved" }, "test-harness", handle.stepCounters);
      }
    }

    // ---- Final on-disk state, read via the SAME AuditStore instance (production usage — no reason to re-open a second connection here, unlike cross-process-resume.test.ts which specifically needs to prove no shared memory). ----
    const finalRun = audit.getRunById(handle.runId);
    expect(finalRun).toMatchObject({ status: "completed", currentState: "apply", rejectCount: 2, rejectThreshold: 2 });

    // ---- approvals: the ESCALATION_ACK row is really there, decision force_pass. ----
    const approvalsDb = new Database(dbPath, { readonly: true });
    const approvalRows = approvalsDb
      .prepare("SELECT gate_type, decision, decided_by FROM approvals WHERE run_id = ? ORDER BY id")
      .all(handle.runId) as Array<{ gate_type: string; decision: string; decided_by: string }>;
    approvalsDb.close();

    const escalationRow = approvalRows.find((row) => row.gate_type === "ESCALATION_ACK");
    expect(escalationRow).toMatchObject({ decision: "force_pass", decided_by: "test-harness" });
    // G1 x2 (one per draft round) + G2 x1 (the fix-forward approval below threshold) + ESCALATION_ACK x1 + G3 x1.
    expect(approvalRows.filter((row) => row.gate_type === "G1_SEND_TO_TESTER")).toHaveLength(2);
    expect(approvalRows.filter((row) => row.gate_type === "G2_SEND_TO_FIX")).toHaveLength(1);
    expect(approvalRows.filter((row) => row.gate_type === "G3_FINAL_MERGE")).toHaveLength(1);

    // ---- structured_claims: one row per claim the real coder/tester cli-bridge rounds actually produced. ----
    const claimsDb = new Database(dbPath, { readonly: true });
    const claimRows = claimsDb
      .prepare("SELECT actor, step_ref FROM structured_claims WHERE run_id = ? ORDER BY id")
      .all(handle.runId) as Array<{ actor: string; step_ref: string }>;
    claimsDb.close();

    const coderClaims = claimRows.filter((row) => row.actor === "coder");
    const testerClaims = claimRows.filter((row) => row.actor === "tester");
    expect(coderClaims).toHaveLength(2); // 2 real draft rounds (round 1, then round 2 after G2's fix-forward approval), 1 claim/round in the "claims-no-trace" fixture.
    expect(testerClaims).toHaveLength(2); // 2 real review rounds, 1 claim/round in the "tester-reject" fixture.
    expect(new Set(coderClaims.map((c) => c.step_ref))).toEqual(new Set(["draft#1", "draft#2"]));
    expect(new Set(testerClaims.map((c) => c.step_ref))).toEqual(new Set(["review#1", "review#2"]));
  });
});
