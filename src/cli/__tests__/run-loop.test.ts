/**
 * `runInteractiveLoop()` unit tests (PRD §6.6 / §8 B6). Real `graph.ts` +
 * real `AuditStore`/`SqliteSaver` (same file, PRD §9.2 Decision 3) + fake
 * coder/tester `ModelAdapter`s (no real subprocess) + `FakePrompter`
 * (scripted, no real terminal) — the same "real graph, fake adapters"
 * posture `runner.test.ts` already established, one layer up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProfileDir } from "../../profile/loader.js";
import { PromptComposer } from "../../prompt/composer.js";
import { MemoryStore } from "../../context/store.js";
import { SystemConfig } from "../../context/config.js";
import { StalenessEngine } from "../../context/staleness.js";
import { ContextInjector } from "../../context/injector.js";
import { AdapterRegistry } from "../../harness/adapter-registry.js";
import { ProviderRouter } from "../../harness/provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../harness/types.js";
import type { CoderOutput, TesterOutput } from "../../prompt/schema.js";
import { AuditStore } from "../../loop/audit-store.js";
import { createSqliteCheckpointer } from "../../loop/checkpoint.js";
import { startRun } from "../../loop/runner.js";
import type { ProfileConfig } from "../../profile/loader.js";
import type { CliDeps } from "../assemble.js";
import { FakePrompter } from "../prompter.js";
import { runInteractiveLoop } from "../run-loop.js";

const NOW = "2026-07-21T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

class FakeCoderAdapter implements ModelAdapter {
  readonly id = "fake-coder";
  readonly kind = "direct-api" as const;
  calls = 0;

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    this.calls += 1;
    const payload: CoderOutput = {
      status: "changed",
      diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+round${this.calls}\n`,
      claims: [{ claimText: "the change compiles", confidence: "verified", sourceRef: "tsc" }],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-coder-model-v1" };
  }
}

class FakeTesterAdapter implements ModelAdapter {
  readonly id = "fake-tester";
  readonly kind = "direct-api" as const;
  calls = 0;

  constructor(private readonly verdicts: readonly TesterOutput["verdict"][]) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const verdict = this.verdicts[Math.min(this.calls, this.verdicts.length - 1)] ?? "pass";
    this.calls += 1;
    const payload: TesterOutput = {
      verdict,
      issues: verdict === "reject" ? ["found a real problem"] : [],
      claims: [{ claimText: "ran the tests", confidence: "verified", sourceRef: "test output", verifiedBy: "tool_execution" }],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-tester-model-v1" };
  }
}

let tmpDir = "";
let stores: MemoryStore[] = [];
let audits: AuditStore[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
  for (const audit of audits) audit.close();
  audits = [];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  vi.restoreAllMocks();
});

function tmpDbPath(name: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-run-loop-"));
  return path.join(tmpDir, name);
}

function buildCliDeps(dbPath: string, testerVerdicts: readonly TesterOutput["verdict"][]): { deps: CliDeps; coder: FakeCoderAdapter; tester: FakeTesterAdapter } {
  const coder = new FakeCoderAdapter();
  const tester = new FakeTesterAdapter(testerVerdicts);
  const registry = new AdapterRegistry();
  registry.register(coder);
  registry.register(tester);
  const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
  const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
  const audit = new AuditStore(dbPath);
  audits.push(audit);
  const checkpointer = createSqliteCheckpointer(dbPath);

  const store = new MemoryStore(":memory:");
  stores.push(store);
  const systemConfig = new SystemConfig(store);
  const staleness = new StalenessEngine(systemConfig);
  const injector = new ContextInjector(store, staleness);
  const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {} };

  // profileDir isn't read by run-loop.ts itself (only main.ts's run-origin.ts wiring uses it) —
  // path.dirname(dbPath) is a real, already-existing directory (tmpDbPath()'s own mkdtempSync)
  // rather than an arbitrary string, purely so this stays a realistic CliDeps shape.
  return {
    deps: { router, composer, audit, checkpointer, profileConfig, injector, memoryStore: store, profileDir: path.dirname(dbPath) },
    coder,
    tester,
  };
}

describe("runInteractiveLoop — happy path", () => {
  it("G1 approve -> G3 approve -> applied, printing a completed summary", async () => {
    const dbPath = tmpDbPath("happy-path.sqlite");
    const { deps } = buildCliDeps(dbPath, ["pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const prompter = new FakePrompter({ confirm: [true, true] }); // G1 approve, G3 approve
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    const run = deps.audit.getRunById(final.runId);
    expect(run).toMatchObject({ status: "completed", currentState: "apply" });
    const printedLines = logSpy.mock.calls.flat();
    expect(printedLines.join("\n")).toContain("completed");
    // renderGate() really dispatched to renderG1() for the G1 pause and renderG3() for the G3 pause —
    // not swapped (gate-view.ts's own [G1]/[G3] heading tags are the observable difference; catches a
    // mutation that mixed up which render* function each GateType case calls).
    expect(printedLines[0]).toContain("[G1]");
    expect(printedLines.some((line) => typeof line === "string" && line.includes("[G3]"))).toBe(true);
    expect(printedLines[0]).not.toContain("[G3]");
  });

  it("G1 reject with a reason feeds GateResumeValue.reasoningText into the next resumeRun call, then a second draft round approves through to applied", async () => {
    const dbPath = tmpDbPath("g1-reject-reason.sqlite");
    const { deps, coder } = buildCliDeps(dbPath, ["pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    // G1 reject (reason "please add tests") -> back to draft (round 2) -> G1 approve -> review(pass) -> G3 approve.
    const prompter = new FakePrompter({ confirm: [false, true, true], input: ["please add tests"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    expect(coder.calls).toBe(2); // draft ran twice: the rejected round, then the approved retry
    const run = deps.audit.getRunById(final.runId);
    expect(run?.status).toBe("completed");
  });
});

describe("runInteractiveLoop — G2 gate offers exactly two choices, never a third", () => {
  it("G2 approve (fix-forward): the reject verdict routes to G2, approve sends it back to the coder for a fix, second draft round then completes", async () => {
    const dbPath = tmpDbPath("g2-approve.sqlite");
    const { deps, coder, tester } = buildCliDeps(dbPath, ["reject", "pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that the reject routes to g2, not escalation.
    });

    // G1 approve -> review(reject) -> G2 approve (fix-forward) -> draft(round2) -> G1 approve -> review(pass) -> G3 approve.
    const prompter = new FakePrompter({ confirm: [true, true, true], select: ["approved"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    expect(coder.calls).toBe(2);
    expect(tester.calls).toBe(2);
    const run = deps.audit.getRunById(final.runId);
    expect(run?.status).toBe("completed");
  });

  it("G2 escalate: routes straight to the Escalation gate; force_pass then reaches G3 and applies", async () => {
    const dbPath = tmpDbPath("g2-escalate.sqlite");
    const { deps } = buildCliDeps(dbPath, ["reject"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that review's reject alone doesn't reach the threshold-escalation branch
    });

    // G1 approve -> review(reject) -> G2 escalate -> Escalation force_pass -> G3 approve -> applied.
    const prompter = new FakePrompter({ confirm: [true, true], select: ["escalate", "force_pass"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    const run = deps.audit.getRunById(final.runId);
    expect(run?.status).toBe("completed");
  });
});

describe("runInteractiveLoop — Escalation gate's three-way decision", () => {
  it("revise with a reason loops back to draft, then approving through completes normally", async () => {
    const dbPath = tmpDbPath("escalation-revise.sqlite");
    const { deps, coder } = buildCliDeps(dbPath, ["reject", "pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 1, // first reject already reaches the threshold -> escalation
    });

    // G1 approve -> review(reject, hits threshold) -> Escalation revise (reason) -> draft(round2) -> G1 approve -> review(pass) -> G3 approve.
    const prompter = new FakePrompter({ confirm: [true, true, true], select: ["revise"], input: ["let's actually fix this"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    expect(coder.calls).toBe(2);
    const run = deps.audit.getRunById(final.runId);
    expect(run?.status).toBe("completed");
  });

  it("abandon cancels the run — done: true, status cancelled, prints a non-completed summary", async () => {
    const dbPath = tmpDbPath("escalation-abandon.sqlite");
    const { deps } = buildCliDeps(dbPath, ["reject"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 1,
    });

    const prompter = new FakePrompter({ confirm: [true], select: ["abandon"] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, started, "elisha");

    expect(final.done).toBe(true);
    const run = deps.audit.getRunById(final.runId);
    expect(run).toMatchObject({ status: "cancelled", currentState: "cancel" });
    const printed = logSpy.mock.calls.flat().join("\n");
    expect(printed).toContain("not completed");
  });
});

describe("runInteractiveLoop — accepts a handle without stepCounters (the resume-from-fresh-process shape getPendingInterrupt() returns)", () => {
  it("defaults missing stepCounters to {} and still produces correct, non-colliding step_refs on the next round", async () => {
    const dbPath = tmpDbPath("no-step-counters.sqlite");
    const { deps } = buildCliDeps(dbPath, ["pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    // Simulate what getPendingInterrupt() hands back — same shape, no stepCounters field at all.
    const pendingShapedHandle = { runId: started.runId, threadId: started.threadId, interrupt: started.interrupt, done: started.done };

    const prompter = new FakePrompter({ confirm: [true, true] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const final = await runInteractiveLoop(deps, prompter, pendingShapedHandle, "elisha");
    expect(final.done).toBe(true);
    const run = deps.audit.getRunById(final.runId);
    expect(run?.status).toBe("completed");
  });
});

describe("runInteractiveLoop — real prompter call shapes", () => {
  it("G1's prompt message is the gate's real question text, and G2's select() choices are exactly approved/escalate (never a third rejected option)", async () => {
    const dbPath = tmpDbPath("prompt-shapes.sqlite");
    const { deps } = buildCliDeps(dbPath, ["reject", "pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5,
    });
    expect(started.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    const prompter = new FakePrompter({ confirm: [true, true, true], select: ["approved"] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runInteractiveLoop(deps, prompter, started, "elisha");

    const confirmCall = prompter.calls.find((c) => c.kind === "confirm");
    expect(confirmCall?.message).toBe(started.interrupt?.payload.question);

    // Zorro re-review "🟡" item 1 (test-report.md): this used to only assert select() was called
    // at all — FakePrompter.select() discarded the real `choices` argument it was given, so a
    // mutation that made decideForGate() offer G2 a bogus/extra third choice couldn't have been
    // caught here. Now it can: exactly approved/escalate, never a third "rejected" option (§0.1).
    const selectCall = prompter.calls.find((c) => c.kind === "select");
    expect(selectCall?.choices).toEqual(["approved", "escalate"]);
  });
});
