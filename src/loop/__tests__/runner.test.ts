/**
 * `runner.ts` unit tests (A4b PRD §5 "runner.test.ts" / §6 B4 — "the
 * highest-integration-complexity batch of this increment"). Real
 * `graph.ts` (not a toy graph, same posture
 * `checkpoint.test.ts`/`graph.test.ts` already take) + `FakeAdapter` per
 * role (no real subprocess/network) + a real `AuditStore` + real
 * `SqliteSaver`, both pointed at the **same** temp file — this file is
 * where PRD §9.2 Decision 3's "does sharing one SQLite file between the
 * checkpointer's tables and the audit tables actually work" question gets
 * a real answer, not just an assertion of intent.
 *
 * Since `AuditStore`'s public surface only exposes point lookups
 * (`getRunById`/`getRunByThreadId`), verifying "every row `runner.ts`
 * wrote" uses a second, independent, read-only `better-sqlite3` connection
 * to the same on-disk file — same pattern `audit-store.test.ts`'s
 * transaction-rollback test already established, not a new store method
 * invented just for this file's tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProfileDir } from "../../profile/loader.js";
import { PromptComposer } from "../../prompt/composer.js";
import { AdapterRegistry } from "../../harness/adapter-registry.js";
import { ProviderRouter } from "../../harness/provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../harness/types.js";
import type { CoderOutput, TesterOutput } from "../../prompt/schema.js";
import type { GateLogEntry } from "../types.js";
import { AuditStore } from "../audit-store.js";
import { createSqliteCheckpointer } from "../checkpoint.js";
import { ResumeDecisionDomainMismatchError, RunThreadMismatchError } from "../errors.js";
import { buildLoopGraph, compileLoopGraph } from "../graph.js";
import { startRun, resumeRun, type StartRunDeps } from "../runner.js";
import { LOOP_NODES } from "../workflow-def.js";

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
      diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+round${this.calls}\n`,
      claims: [
        { claimText: "the change compiles", confidence: "verified", sourceRef: "tsc" },
        { claimText: "matches the requested behavior", confidence: "inferred" },
      ],
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

function buildDeps(
  dbPath: string,
  testerVerdicts: readonly TesterOutput["verdict"][],
): { deps: StartRunDeps; coder: FakeCoderAdapter; tester: FakeTesterAdapter; audit: AuditStore } {
  const coder = new FakeCoderAdapter();
  const tester = new FakeTesterAdapter(testerVerdicts);
  const registry = new AdapterRegistry();
  registry.register(coder);
  registry.register(tester);
  const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
  const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
  const audit = new AuditStore(dbPath);
  const checkpointer = createSqliteCheckpointer(dbPath); // same file as `audit` — PRD §9.2 Decision 3.
  return { deps: { router, composer, audit, checkpointer }, coder, tester, audit };
}

/**
 * Coder fake whose claims-per-round is scriptable (unlike `FakeCoderAdapter`
 * above, always 2) — Review Round-2 R2-2 (`docs/feature/a4b-loop/test-report.md`)
 * needs a round that legally returns zero claims (`prompt/schema.ts`'s
 * `CoderOutput.claims` has no `.min(1)`) to prove `step_ref` numbering
 * survives it.
 */
class ScriptableClaimsCoderAdapter implements ModelAdapter {
  readonly id = "fake-coder";
  readonly kind = "direct-api" as const;
  calls = 0;

  constructor(private readonly claimsPerCall: readonly number[]) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const n = this.claimsPerCall[Math.min(this.calls, this.claimsPerCall.length - 1)] ?? 1;
    this.calls += 1;
    const payload: CoderOutput = {
      diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+round${this.calls}\n`,
      claims: Array.from({ length: n }, (_, i) => ({
        claimText: `round ${this.calls} claim ${i + 1}`,
        confidence: "verified" as const,
      })),
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-coder-model-v1" };
  }
}

/** Tester counterpart to `ScriptableClaimsCoderAdapter` — verdict and claims-count are scripted independently (a round can `reject` with zero claims, the exact R2-2 scenario). */
class ScriptableClaimsTesterAdapter implements ModelAdapter {
  readonly id = "fake-tester";
  readonly kind = "direct-api" as const;
  calls = 0;

  constructor(
    private readonly verdicts: readonly TesterOutput["verdict"][],
    private readonly claimsPerCall: readonly number[],
  ) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const verdict = this.verdicts[Math.min(this.calls, this.verdicts.length - 1)] ?? "pass";
    const n = this.claimsPerCall[Math.min(this.calls, this.claimsPerCall.length - 1)] ?? 1;
    this.calls += 1;
    const payload: TesterOutput = {
      verdict,
      issues: verdict === "reject" ? ["found a real problem"] : [],
      claims: Array.from({ length: n }, (_, i) => ({
        claimText: `review round ${this.calls} claim ${i + 1}`,
        confidence: "verified" as const,
        sourceRef: "test output",
        verifiedBy: "tool_execution" as const,
      })),
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-tester-model-v1" };
  }
}

interface ApprovalRow {
  id: number;
  run_id: number;
  gate_type: string;
  step_ref: string;
  decision: string;
  decided_by: string;
  decided_at: string;
}

interface ClaimRow {
  id: number;
  run_id: number;
  step_ref: string;
  actor: string;
  claim_text: string;
  model_used: string;
  provider_used: string;
}

/** Raw read against the shared file via a second, independent connection — never `AuditStore`'s own (see file header). */
function readApprovals(dbPath: string, runId: number): ApprovalRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM approvals WHERE run_id = ? ORDER BY id").all(runId) as ApprovalRow[];
  } finally {
    db.close();
  }
}

function readClaims(dbPath: string, runId: number): ClaimRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM structured_claims WHERE run_id = ? ORDER BY id").all(runId) as ClaimRow[];
  } finally {
    db.close();
  }
}

let tmpDir = "";
let audits: AuditStore[] = [];

afterEach(() => {
  for (const audit of audits) audit.close();
  audits = [];
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

function tmpDbPath(name: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-runner-"));
  return path.join(tmpDir, name);
}

describe("startRun", () => {
  it("inserts a workflow_runs row (status running, current_state g1) and pauses at G1 with the coder's real claims already persisted", async () => {
    const dbPath = tmpDbPath("start-run.sqlite");
    const { deps, coder, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const handle = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    expect(handle.done).toBe(false);
    expect(handle.interrupt?.gate).toBe("G1_SEND_TO_TESTER");
    expect(coder.calls).toBe(1);

    const run = audit.getRunById(handle.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g1", rejectCount: 0, rejectThreshold: 2, langgraphThreadId: handle.threadId });

    // The coder's real claims from this round are already persisted, even though no gate has decided anything yet.
    const claims = readClaims(dbPath, handle.runId);
    expect(claims).toHaveLength(2);
    expect(claims.every((c) => c.actor === "coder")).toBe(true);
    expect(claims.every((c) => c.step_ref === "draft#1")).toBe(true);
    expect(claims.every((c) => c.model_used === "fake-coder-model-v1" && c.provider_used === "fake-coder")).toBe(true);
    expect(claims.map((c) => c.claim_text)).toEqual(["the change compiles", "matches the requested behavior"]);
  });
});

describe("resumeRun — approvals", () => {
  it("G1 approve produces exactly one new approvals row, gate_type G1_SEND_TO_TESTER, decision approved, decided_by the caller-supplied value", async () => {
    const dbPath = tmpDbPath("g1-approval.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const resumed = await resumeRun(deps, started.runId, started.threadId, { decision: "approved", reasoningText: "looks fine" }, "elisha", started.stepCounters);

    expect(resumed.interrupt?.gate).toBe("G3_FINAL_MERGE"); // tester verdict "pass" -> straight to g3
    const approvals = readApprovals(dbPath, started.runId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER", step_ref: "g1#1", decision: "approved", decided_by: "elisha" });
  });
});

describe("resumeRun — threshold escalation flips workflow_runs.status", () => {
  it("reaching rejectThreshold updates workflow_runs.status to escalated, current_state to escalation", async () => {
    const dbPath = tmpDbPath("threshold-status.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["reject"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 1, // first reject already reaches threshold.
    });

    const resumed = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);

    expect(resumed.interrupt?.gate).toBe("ESCALATION_ACK");
    const run = audit.getRunById(started.runId);
    expect(run?.status).toBe("escalated");
    expect(run?.currentState).toBe("escalation");
    expect(run?.rejectCount).toBe(1);

    // The escalation-triggering reject round's tester claim was persisted too.
    const claims = readClaims(dbPath, started.runId);
    const testerClaims = claims.filter((c) => c.actor === "tester");
    expect(testerClaims).toHaveLength(1);
    expect(testerClaims[0]?.step_ref).toBe("review#1");
  });

  it("full escalation -> force_pass -> g3 -> apply path: workflow_runs ends completed, approvals has the ESCALATION_ACK row with decision force_pass", async () => {
    const dbPath = tmpDbPath("threshold-force-pass.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["reject"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 1,
    });
    const toEscalation = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(toEscalation.interrupt?.gate).toBe("ESCALATION_ACK");

    const toG3 = await resumeRun(
      deps,
      started.runId,
      started.threadId,
      { decision: "force_pass", reasoningText: "ship it" },
      "elisha",
      toEscalation.stepCounters,
    );
    expect(toG3.interrupt?.gate).toBe("G3_FINAL_MERGE");

    const final = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", toG3.stepCounters);
    expect(final.done).toBe(true);

    const run = audit.getRunById(started.runId);
    expect(run?.status).toBe("completed");
    expect(run?.currentState).toBe("apply");

    const approvals = readApprovals(dbPath, started.runId);
    const escalationRow = approvals.find((a) => a.gate_type === "ESCALATION_ACK");
    expect(escalationRow).toMatchObject({ decision: "force_pass", decided_by: "elisha", step_ref: "escalation#1" });
    const g3Row = approvals.find((a) => a.gate_type === "G3_FINAL_MERGE");
    expect(g3Row).toMatchObject({ decision: "approved", step_ref: "g3#1" });
  });
});

describe("resumeRun — structured_claims count matches claims actually produced", () => {
  it("across a full G2-approve loop-back round, structured_claims accumulates one row per claim per real coder/tester invocation, not per gate decision", async () => {
    const dbPath = tmpDbPath("claims-count.sqlite");
    const { deps, coder, tester, audit } = buildDeps(dbPath, ["reject", "pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that this reject routes to g2, not escalation.
    });

    let handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters); // G1 approve -> review(reject) -> g2
    expect(handle.interrupt?.gate).toBe("G2_SEND_TO_FIX");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", handle.stepCounters); // G2 approve -> draft (round 2) -> g1
    expect(handle.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", handle.stepCounters); // G1 approve -> review(pass) -> g3
    expect(handle.interrupt?.gate).toBe("G3_FINAL_MERGE");

    expect(coder.calls).toBe(2);
    expect(tester.calls).toBe(2);

    const claims = readClaims(dbPath, started.runId);
    const coderClaims = claims.filter((c) => c.actor === "coder");
    const testerClaims = claims.filter((c) => c.actor === "tester");
    expect(coderClaims).toHaveLength(4); // 2 claims/round * 2 real draft rounds
    expect(testerClaims).toHaveLength(2); // 1 claim/round * 2 real review rounds
    expect(new Set(coderClaims.map((c) => c.step_ref))).toEqual(new Set(["draft#1", "draft#2"]));
    expect(new Set(testerClaims.map((c) => c.step_ref))).toEqual(new Set(["review#1", "review#2"]));
  });
});

/**
 * Review Round-1 B2 (`docs/feature/a4b-loop/test-report.md`): `resumeRun`
 * used to trust its `runId`/`threadId` pair as already matching — nothing
 * checked that `threadId` (which drives the graph) and `runId` (which
 * drives every audit write) actually named the same `workflow_runs` row.
 * A mismatched pair would silently advance one run's graph while
 * attributing its claims/approvals/`reject_count` to a *different* run's
 * audit trail. This describe block proves the fix: `resumeRun` now looks
 * up `runId`'s real `langgraphThreadId` first and refuses to proceed (or
 * write anything) on a mismatch.
 */
describe("resumeRun — B2 threadId/runId binding", () => {
  it("rejects with RunThreadMismatchError when threadId doesn't belong to runId, and writes zero audit rows for either run", async () => {
    const dbPath = tmpDbPath("threadid-mismatch.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const runA = await startRun(deps, {
      task: "run A",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });
    const runB = await startRun(deps, {
      task: "run B",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });
    expect(runA.threadId).not.toBe(runB.threadId);

    // Mismatched pair: run A's runId, run B's threadId.
    await expect(resumeRun(deps, runA.runId, runB.threadId, { decision: "approved" }, "elisha", runA.stepCounters)).rejects.toBeInstanceOf(
      RunThreadMismatchError,
    );

    // Neither run gained a single new approvals row from the rejected call — fail loud, zero writes,
    // not a partial/silent cross-attribution.
    expect(readApprovals(dbPath, runA.runId)).toHaveLength(0);
    expect(readApprovals(dbPath, runB.runId)).toHaveLength(0);

    // Run A is still exactly where startRun() left it (g1, still running) — the rejected call didn't
    // silently advance or corrupt it either.
    const runARow = audit.getRunById(runA.runId);
    expect(runARow).toMatchObject({ status: "running", currentState: "g1" });
  });

  it("still succeeds when threadId correctly matches runId (the mismatch guard doesn't false-positive on the normal path)", async () => {
    const dbPath = tmpDbPath("threadid-match.sqlite");
    const { deps } = buildDeps(dbPath, ["pass"]);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const resumed = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(resumed.interrupt?.gate).toBe("G3_FINAL_MERGE");
  });
});

/**
 * Review Round-4 R5-B1 (`docs/feature/a4b-loop/test-report.md`): `resume:
 * GateResumeValue | EscalationResumeValue` is an undiscriminated union —
 * nothing used to check that the *shape* of the resume value actually
 * matched the gate the run was paused at. A caller could hand a
 * `{decision: "force_pass"}` (a legal `EscalationResumeValue`, no cast
 * needed) to a run paused at **G1**, which only understands
 * `GateResumeValue`. Manual reproduction: that used to insert an
 * illegitimate `approvals` row (an Escalation-domain decision recorded
 * under `gate_type: "G1_SEND_TO_TESTER"`), *then* fail loud only once
 * `routeAfterG1`'s own `default: throw` ran — by which point the
 * checkpoint had already advanced past G1 while `workflow_runs` still read
 * `status=running, current_state=g1`, a split state. This describe block
 * proves the new `resumeDecisionsFor()`/`ResumeDecisionDomainMismatchError`
 * guard closes that: the mismatch is now caught before anything is
 * written or the graph is touched at all.
 */
describe("resumeRun — R5-B1 resume decision domain must match the pending gate", () => {
  it("rejects with ResumeDecisionDomainMismatchError when an Escalation-shaped resume value is passed to a run paused at G1, and writes zero approvals rows, leaves workflow_runs untouched, and never advances the checkpoint", async () => {
    const dbPath = tmpDbPath("resume-domain-mismatch-g1.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });
    expect(started.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    // `{decision: "force_pass"}` is a legal EscalationResumeValue — no cast required — but this run
    // is paused at G1, which only understands GateResumeValue's approved/rejected/escalate.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "force_pass" }, "elisha", started.stepCounters),
    ).rejects.toBeInstanceOf(ResumeDecisionDomainMismatchError);

    // Zero audit rows from the rejected call — in particular, no illegitimate approvals row recording
    // an Escalation decision under G1's gate_type (the reproduced failure mode).
    expect(readApprovals(dbPath, started.runId)).toHaveLength(0);

    // workflow_runs is untouched — still exactly what startRun() left it as, not a split state where
    // the checkpoint moved but this table didn't.
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g1" });

    // The checkpoint itself never advanced either — a fresh compiled graph on the same thread is
    // still paused at g1, not past it (proves this is checked before compiled.stream() ever runs).
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
  });

  it("still succeeds when the resume value's domain correctly matches the pending gate (the guard doesn't false-positive on the normal path, including G2's escalate value)", async () => {
    const dbPath = tmpDbPath("resume-domain-match.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["reject"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that review's reject routes to g2, not escalation
    });

    const atG2 = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(atG2.interrupt?.gate).toBe("G2_SEND_TO_FIX");

    // "escalate" is in G2's own accepted set (resumeDecisionsFor(LOOP_NODES.g2), mirroring
    // routeAfterG2's own edge) — this must still be accepted here. (Review Round-5 R6-B1: this
    // used to be framed as "the guard only checks gate-vs-escalation, not per-gate routing, so
    // this passes as a side effect" — that framing was itself describing the bug R6-B1 fixes.
    // resumeDecisionsFor() is now precise per-gate, and G2+escalate is legitimately in G2's own
    // set, not merely unblocked by a coarser check.)
    const atEscalation = await resumeRun(deps, started.runId, started.threadId, { decision: "escalate" }, "elisha", atG2.stepCounters);
    expect(atEscalation.interrupt?.gate).toBe("ESCALATION_ACK");
  });
});

/**
 * Review Round-5 R6-B1 (`docs/feature/a4b-loop/test-report.md`): the R5-B1
 * guard above closed the *cross-domain* case (an Escalation-shaped value
 * reaching a g1/g2/g3 gate) but `resumeDecisionsFor()` still mapped all
 * three gates to one shared `["approved","rejected","escalate"]` domain —
 * three *same-domain* values each gate's own `routeAfter*` router doesn't
 * actually accept still slipped through with no cast required:
 * `{decision:"escalate"}` at G1 or G3 (only `routeAfterG2`'s own edge ever
 * produces `"escalate"`), and `{decision:"rejected"}` at G2 (PRD §2
 * non-goal #2 — `routeAfterG2` never routes `"rejected"` anywhere,
 * `UnhandledGateDecisionError`). Each reproduced R5-B1's exact failure
 * class: an illegitimate `approvals` row lands first, the gate's own
 * router throws second, leaving the checkpoint advanced past the gate
 * while `workflow_runs` never moved. `resumeDecisionsFor()` now maps each
 * gate to its own real accepted set (mirroring `gates.ts`'s
 * `routeAfterG1`/`routeAfterG2`/`routeAfterG3` switches), so all three are
 * caught here too, before anything is written or the graph is touched.
 */
describe("resumeRun — R6-B1 resume decision domain must match the pending gate's own accepted set, not a shared gate-wide one", () => {
  it("rejects G1 + escalate with ResumeDecisionDomainMismatchError, zero approvals, workflow_runs untouched, checkpoint unadvanced", async () => {
    const dbPath = tmpDbPath("resume-domain-mismatch-g1-escalate.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });
    expect(started.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    // "escalate" is a legal GateDecision — no cast required — but only routeAfterG2's own edge
    // ever produces it; G1's routeAfterG1 has no case for it and falls to its `default: throw`.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "escalate" }, "elisha", started.stepCounters),
    ).rejects.toBeInstanceOf(ResumeDecisionDomainMismatchError);

    expect(readApprovals(dbPath, started.runId)).toHaveLength(0);

    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g1" });

    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
  });

  it("rejects G3 + escalate with ResumeDecisionDomainMismatchError, zero approvals, workflow_runs untouched, checkpoint unadvanced", async () => {
    const dbPath = tmpDbPath("resume-domain-mismatch-g3-escalate.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]); // tester "pass" -> review routes straight to g3, skipping g2
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const atG3 = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(atG3.interrupt?.gate).toBe("G3_FINAL_MERGE");

    // Same shape of leak as G1 above: "escalate" needs no cast but routeAfterG3 has no case for it.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "escalate" }, "elisha", atG3.stepCounters),
    ).rejects.toBeInstanceOf(ResumeDecisionDomainMismatchError);

    // Only the G1 approval from before this call exists — nothing new landed under G3's gate_type.
    expect(readApprovals(dbPath, started.runId)).toHaveLength(1);
    expect(readApprovals(dbPath, started.runId)[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER" });

    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g3" });

    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);
  });

  it("rejects G2 + rejected with ResumeDecisionDomainMismatchError, zero new approvals, workflow_runs untouched, checkpoint unadvanced", async () => {
    const dbPath = tmpDbPath("resume-domain-mismatch-g2-rejected.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["reject"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that review's reject routes to g2, not escalation
    });

    const atG2 = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(atG2.interrupt?.gate).toBe("G2_SEND_TO_FIX");

    // "rejected" is a legal GateDecision but DESIGN's G2 gate draws no edge for it (PRD §2
    // non-goal #2) — routeAfterG2 throws UnhandledGateDecisionError, never routes it anywhere.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "rejected" }, "elisha", atG2.stepCounters),
    ).rejects.toBeInstanceOf(ResumeDecisionDomainMismatchError);

    // Only the G1 approval from before this call exists — nothing new landed under G2's gate_type.
    expect(readApprovals(dbPath, started.runId)).toHaveLength(1);
    expect(readApprovals(dbPath, started.runId)[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER" });

    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g2" });

    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
  });
});

/**
 * Review Round-1 B3 (`docs/feature/a4b-loop/test-report.md`): `runner.ts`
 * never called `AuditStore.runInTransaction`, even though PRD §4.2/§5
 * explicitly designed it for "wrap a round's multi-row claim/approval
 * writes into one transaction". A mid-group insert failure used to leave
 * a half-written round on disk (e.g. 1 of 2 claims). This test forces
 * exactly that failure (the 2nd of `FakeCoderAdapter`'s 2 claims/round
 * throws) and proves the *whole* group — including the 1st, otherwise-
 * successful insert — rolls back.
 */
describe("resumeRun — B3 multi-row audit writes are transactional", () => {
  it("draft's 2-claim group rolls back entirely (including the 1st, already-succeeded insert) when the 2nd insertClaim call throws mid-group", async () => {
    const dbPath = tmpDbPath("txn-rollback.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const originalInsertClaim = audit.insertClaim.bind(audit);
    let insertClaimCalls = 0;
    vi.spyOn(audit, "insertClaim").mockImplementation((input) => {
      insertClaimCalls += 1;
      if (insertClaimCalls === 2) {
        throw new Error("simulated mid-group insertClaim failure");
      }
      return originalInsertClaim(input);
    });

    await expect(
      startRun(deps, {
        task: "add a function",
        profile: "subscription",
        workflowDefId: "coder-tester-loop",
        injectedContext: { memories: [] },
        rejectThreshold: 2,
      }),
    ).rejects.toThrow("simulated mid-group insertClaim failure");

    // FakeCoderAdapter emits exactly 2 claims per draft round (see this file's header). If runner.ts
    // wraps that group in AuditStore.runInTransaction (PRD §4.2/§5), the 1st (successful) insertClaim
    // call's row must roll back along with the 2nd (thrown) one — zero survivors, not a half-written
    // round. Read via a second, independent connection to the same on-disk file, same pattern this
    // file's readClaims()/readApprovals() already use.
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) as n FROM structured_claims").get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

/**
 * Review Round-5 R6-B2 (`docs/feature/a4b-loop/test-report.md`): `workflow_runs`'
 * `status`/`current_state` used to be synced exactly once, after the whole
 * `compiled.stream()` call drained — but `structured_claims`/`approvals`
 * rows (and LangGraph's own checkpoint) are written incrementally, per
 * node, as each one completes. A *normal* adapter failure mid-stream — no
 * illegal input, no concurrency, just the tester adapter being unavailable
 * — makes a later node throw before it can produce its own chunk, which
 * propagates straight out of `runStreamAndPersist` and used to skip the
 * trailing sync entirely: the checkpoint had already advanced past the
 * gate that just got approved, an `approvals` row for it already landed,
 * but `workflow_runs.current_state` stayed exactly where it was before
 * this call started — a permanent split between the checkpoint (the
 * graph's real position) and the business ledger. This test reproduces
 * the exact manual repro: G1 approve succeeds normally, the tester
 * adapter then throws inside `review` before it can yield a chunk.
 */
describe("resumeRun — R6-B2 workflow_runs stays in sync with the checkpoint even when a later node throws mid-call", () => {
  it("G1 approve landing an approvals row + advancing the checkpoint into review, then the tester adapter throwing before review can complete, still leaves workflow_runs.current_state matching the checkpoint's real position (review), not stuck at g1", async () => {
    const dbPath = tmpDbPath("mid-stream-tester-failure.sqlite");
    const { deps, audit, tester } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });
    expect(started.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    // Simulate a real adapter failure — not an illegal resume value, not concurrency — the tester
    // adapter is simply unavailable for this one call.
    vi.spyOn(tester, "invoke").mockRejectedValueOnce(new Error("tester adapter unavailable"));

    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters),
    ).rejects.toThrow("tester adapter unavailable");

    // The G1 approval itself is legitimate and did land — this call's G1 decision was valid, only
    // the *next* node (review) failed.
    const approvals = readApprovals(dbPath, started.runId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER", decision: "approved" });

    // The checkpoint really did advance past G1, into review (LangGraph persists its own checkpoint
    // per completed node, independent of whether this file's audit writes succeed).
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.review]);

    // The bug this test locks: workflow_runs must match the checkpoint's real position (review), not
    // remain wherever it was before this call started (g1) — no split between the two truth sources.
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: LOOP_NODES.review });
  });
});

/**
 * Review Round-1 D1 (`docs/feature/a4b-loop/test-report.md`): `resumeRun`'s
 * `step_ref` counters used to trust the caller-supplied `stepCounters`
 * param alone (default `{}`). A caller that didn't thread the previous
 * call's returned `stepCounters` forward — the exact shape of a resume
 * landing in a brand-new process with nothing but `runId`/`threadId` — would
 * silently restart a revisited node's counter at `#1`, colliding with a
 * `step_ref` already on disk from an earlier round. This test simulates
 * that "brand-new process every call" scenario in-process (always passes
 * `{}`, never `handle.stepCounters`) and proves `resumeRun` now rebuilds
 * counters from disk (`AuditStore.listStepRefsByRun`) instead of trusting
 * the empty param.
 */
describe("resumeRun — D1 step_ref counters rebuild from disk across independent resume calls", () => {
  it("passing {} stepCounters on every call (as a brand-new process with no in-memory history would) still produces unique, sequential step_refs across two draft/review rounds — no draft#1/review#1/g1#1 collision", async () => {
    const dbPath = tmpDbPath("step-ref-rebuild.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["reject", "pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that the reject routes to g2, not escalation.
    });

    // Every resumeRun() call below passes `{}`, never `handle.stepCounters` — simulating a caller
    // that never threads the in-memory value forward (a brand-new process, per this run's docstring).
    let handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G1 approve -> review(reject) -> g2
    expect(handle.interrupt?.gate).toBe("G2_SEND_TO_FIX");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G2 approve -> draft(round 2) -> g1
    expect(handle.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G1 approve -> review(pass) -> g3
    expect(handle.interrupt?.gate).toBe("G3_FINAL_MERGE");

    const claims = readClaims(dbPath, started.runId);
    const coderStepRefs = claims.filter((c) => c.actor === "coder").map((c) => c.step_ref);
    const testerStepRefs = claims.filter((c) => c.actor === "tester").map((c) => c.step_ref);
    // Without D1's DB rebuild, every {} call restarts the draft/g1 counters at 0, so round 2 would
    // collide back onto "draft#1"/"g1#1" instead of advancing to "draft#2"/"g1#2".
    expect(new Set(coderStepRefs)).toEqual(new Set(["draft#1", "draft#2"]));
    expect(new Set(testerStepRefs)).toEqual(new Set(["review#1", "review#2"]));

    const approvals = readApprovals(dbPath, started.runId);
    const g1StepRefs = approvals.filter((a) => a.gate_type === "G1_SEND_TO_TESTER").map((a) => a.step_ref);
    expect(new Set(g1StepRefs)).toEqual(new Set(["g1#1", "g1#2"]));
  });
});

/**
 * Review Round-2 R2-2 (`docs/feature/a4b-loop/test-report.md`): D1's disk
 * rebuild (above) reads `AuditStore.listStepRefsByRun()`, which used to only
 * see rows in `structured_claims`/`approvals`. `CoderOutput.claims`/
 * `TesterOutput.claims` (`prompt/schema.ts`) have no `.min(1)`, so a real
 * adapter can legally return `claims: []` for a round — that round wrote
 * *nothing* to either table, so `listStepRefsByRun()` couldn't see it
 * happened at all, and a resume landing in a brand-new process (D1's exact
 * scenario, always passing `{}`) would re-mint that node's already-used
 * `step_ref` number for the next round. `audit-store.ts`'s new
 * `step_markers` table fixes this: `runner.ts` now writes one marker row
 * per draft/review round unconditionally, whether or not it produced any
 * claims.
 */
describe("resumeRun — R2-2 a zero-claim round still leaves a durable step_ref, so a later round through the same node doesn't collide", () => {
  it("draft round 1 and review round 1 both return zero claims (legal per schema); round 2 of each still gets draft#2/review#2 across independent {}-stepCounters resume calls, not a collision back onto #1", async () => {
    const dbPath = tmpDbPath("zero-claim-step-ref.sqlite");
    const coder = new ScriptableClaimsCoderAdapter([0, 2]); // round 1: 0 claims, round 2: 2 claims.
    const tester = new ScriptableClaimsTesterAdapter(["reject", "pass"], [0, 1]); // round 1: 0 claims (still a real "reject" verdict), round 2: 1 claim.
    const registry = new AdapterRegistry();
    registry.register(coder);
    registry.register(tester);
    const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const audit = new AuditStore(dbPath);
    audits.push(audit);
    const checkpointer = createSqliteCheckpointer(dbPath);
    const deps: StartRunDeps = { router, composer, audit, checkpointer };

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5, // high enough that round 1's reject routes to g2, not escalation.
    });
    // startRun() already drove draft's round 1 (zero claims).

    // Every resumeRun() call below passes `{}` — the brand-new-process-every-call scenario D1's own
    // test above uses, the hardest case for this bug: nothing but disk determines the next step_ref.
    let handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G1 approve -> review(round1, 0 claims, reject) -> g2
    expect(handle.interrupt?.gate).toBe("G2_SEND_TO_FIX");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G2 approve -> draft(round2, 2 claims) -> g1
    expect(handle.interrupt?.gate).toBe("G1_SEND_TO_TESTER");

    handle = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", {}); // G1 approve -> review(round2, 1 claim, pass) -> g3
    expect(handle.interrupt?.gate).toBe("G3_FINAL_MERGE");

    expect(coder.calls).toBe(2);
    expect(tester.calls).toBe(2);

    const claims = readClaims(dbPath, started.runId);
    const coderClaims = claims.filter((c) => c.actor === "coder");
    const testerClaims = claims.filter((c) => c.actor === "tester");
    // Round 1 produced zero claims for both nodes — only round 2's claims exist on disk, but they
    // must be correctly numbered draft#2/review#2. Without the R2-2 fix, rebuildStepCounters() would
    // see nothing for round 1 (no claims, no marker) and round 2 would collide back onto draft#1/review#1.
    expect(coderClaims).toHaveLength(2);
    expect(testerClaims).toHaveLength(1);
    expect(new Set(coderClaims.map((c) => c.step_ref))).toEqual(new Set(["draft#2"]));
    expect(new Set(testerClaims.map((c) => c.step_ref))).toEqual(new Set(["review#2"]));

    // Direct mechanism check: step_markers holds draft#1/review#1 rows (claim_count 0) even though
    // structured_claims has nothing for round 1 — this is what makes listStepRefsByRun()/
    // rebuildStepCounters() see round 1 happened at all.
    const db = new Database(dbPath, { readonly: true });
    try {
      const markers = db
        .prepare("SELECT step_ref, node, claim_count FROM step_markers WHERE run_id = ? ORDER BY id")
        .all(started.runId) as { step_ref: string; node: string; claim_count: number }[];
      // A marker row exists for every draft/review round, whether or not it produced claims — round
      // 1's are the R2-2 evidence (0 claims each, still durable); round 2's are here too since
      // markers are written unconditionally, not just for the zero-claim case.
      expect(markers).toEqual([
        { step_ref: "draft#1", node: "draft", claim_count: 0 },
        { step_ref: "review#1", node: "review", claim_count: 0 },
        { step_ref: "draft#2", node: "draft", claim_count: 2 },
        { step_ref: "review#2", node: "review", claim_count: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});

/**
 * Review Round-2 R2-3 (`docs/feature/a4b-loop/test-report.md`): B3's
 * transaction wrapping is real code (`runInTransaction` really does wrap
 * `review`'s claim-insert loop and `resumeRun`'s gate-approval-insert loop),
 * but the only regression test that ever forced a mid-group failure was
 * `startRun`'s draft-path test above — `FakeTesterAdapter`'s single claim
 * per round and every gate's single approval per call meant the review/gate
 * transaction wraps were never actually exercised with more than one row to
 * roll back, so removing either `runInTransaction` call left every test
 * green. This describe block closes both gaps.
 */
describe("resumeRun — R2-3 review/gate multi-row audit writes are transactional", () => {
  it("review's 2-claim group rolls back entirely when the 2nd insertClaim call throws mid-group, without disturbing G1's already-committed approval from earlier in the same call", async () => {
    const dbPath = tmpDbPath("review-txn-rollback.sqlite");
    const coder = new ScriptableClaimsCoderAdapter([1]);
    const tester = new ScriptableClaimsTesterAdapter(["reject"], [2]); // 2 claims this review round.
    const registry = new AdapterRegistry();
    registry.register(coder);
    registry.register(tester);
    const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const audit = new AuditStore(dbPath);
    audits.push(audit);
    const checkpointer = createSqliteCheckpointer(dbPath);
    const deps: StartRunDeps = { router, composer, audit, checkpointer };

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 5,
    });

    const originalInsertClaim = audit.insertClaim.bind(audit);
    let insertClaimCalls = 0;
    vi.spyOn(audit, "insertClaim").mockImplementation((input) => {
      insertClaimCalls += 1;
      if (insertClaimCalls === 2) {
        throw new Error("simulated mid-group insertClaim failure (review path)");
      }
      return originalInsertClaim(input);
    });

    // G1 approve (its own, separate transaction — already committed before review even runs) ->
    // review runs, its 2-claim group's 2nd insert throws -> the whole resumeRun() call rejects.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters),
    ).rejects.toThrow("simulated mid-group insertClaim failure (review path)");

    // Review's group: zero survivors, including the 1st, otherwise-successful insert.
    const testerClaims = readClaims(dbPath, started.runId).filter((c) => c.actor === "tester");
    expect(testerClaims).toHaveLength(0);

    // G1's approval — from a *separate* runInTransaction call earlier in the same resumeRun() —
    // was already committed before review's group ever started, and survives review's rollback.
    const approvals = readApprovals(dbPath, started.runId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER", decision: "approved" });

    // Review Round-5 R6-B2 (docs/feature/a4b-loop/test-report.md): workflow_runs is now synced after
    // *every* chunk this call finishes processing, not only once at the very end — G1's chunk (whose
    // own runInTransaction call already committed, before review's group ever started) was
    // successfully synced, advancing current_state to "review" (matching the checkpoint's real
    // position at that point), *before* review's own group hit its injected failure. Review's failed
    // group is correctly not synced (its own runInTransaction call never committed), but the run no
    // longer reads the fully stale "g1" this test used to assert before R6-B2 (pre-R6-B2,
    // updateRunProgress ran only once, after the whole stream loop drained without throwing, so a
    // review-path failure like this one left workflow_runs exactly where it was before the call).
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: LOOP_NODES.review });
  });

  /**
   * Honest scope note on this one test (unlike the review test above, which
   * a real mutation — unwrapping `runInTransaction` — turns red): every
   * gate node's own body (`gates.ts`'s `createGateNode`) always returns
   * exactly `gateLog: [entry]`, a single-element array, once per real node
   * execution — there is no reachable path through `graph.ts`'s real
   * topology that makes `runStreamAndPersist`'s `entries` (this loop's
   * source) hold more than one item in one `compiled.stream()` chunk. That
   * means this transaction's group size is always 1 in current code, and a
   * size-1 `db.transaction(fn)()` is not black-box-distinguishable from
   * calling `fn()` directly (both either write the one row or don't — there
   * is nothing else in the group to roll back alongside it). Hand-verified:
   * unwrapping this specific `runInTransaction` call did **not** turn this
   * test red. This test still locks a real, valuable invariant — a failed
   * gate-approval insert leaves zero rows and never falsely advances
   * `workflow_runs` — it just isn't evidence of *this* `runInTransaction`
   * call's atomicity specifically (the review test above, and B3's
   * original draft test, are).
   */
  it("a gate's approval insert rolling back leaves zero new approval rows for that call, while an earlier, separately-committed approval from the same run is untouched", async () => {
    const dbPath = tmpDbPath("gate-txn-rollback.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    // G1 approve succeeds normally (real, committed approval #1) -> review(pass) -> g3 interrupts.
    const atG3 = await resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", started.stepCounters);
    expect(atG3.interrupt?.gate).toBe("G3_FINAL_MERGE");
    expect(readApprovals(dbPath, started.runId)).toHaveLength(1);

    const originalInsertApproval = audit.insertApproval.bind(audit);
    vi.spyOn(audit, "insertApproval").mockImplementation((input) => {
      if (input.gateType === "G3_FINAL_MERGE") {
        throw new Error("simulated insertApproval failure (gate path)");
      }
      return originalInsertApproval(input);
    });

    // G3 approve -> gate's own runInTransaction-wrapped approval insert throws -> call rejects.
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, "elisha", atG3.stepCounters),
    ).rejects.toThrow("simulated insertApproval failure (gate path)");

    // No new (G3) approval row survived the failed call...
    const approvals = readApprovals(dbPath, started.runId);
    expect(approvals).toHaveLength(1); // still just G1's, from the earlier, separate, already-committed call.
    expect(approvals.some((a) => a.gate_type === "G3_FINAL_MERGE")).toBe(false);

    // ...and workflow_runs still reflects the pre-call state (g3/running), not falsely advanced to apply/completed.
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g3" });
  });
});

/**
 * Review Round-2 R2-5 (`docs/feature/a4b-loop/test-report.md`): a
 * `decidedBy` guard used to live only inside `runStreamAndPersist`'s
 * per-chunk loop — reachable only *after* `compiled.stream()` had already
 * advanced the checkpoint past the gate that produced the decision.
 * `resumeRun()`'s own `decidedBy: string` param is non-optional, so the
 * only way to actually reach a runtime-invalid value here is a caller
 * bypassing that type at runtime (an `as unknown as string` cast, exactly
 * like these tests do) — this proves the *ordering* fix: the checkpoint
 * must not move at all when that happens.
 *
 * Review Round-3 R3-2 (`docs/feature/a4b-loop/test-report.md`): the guard
 * originally checked only `decidedBy === undefined`, which let `null`
 * (`null !== undefined`) sail through both this guard and its
 * `runStreamAndPersist` backstop, advance the graph, and only fail later —
 * loudly, but too late — at `decided_by TEXT NOT NULL` (audit-store.ts).
 * The guard now checks `typeof decidedBy !== "string"`; the second `it`
 * below is the `null` case R3-2 added.
 */
describe("resumeRun — R2-5/R3-2 decidedBy is validated before the graph advances, not after", () => {
  it("a runtime-invalid (undefined) decidedBy throws before compiled.stream() runs — the checkpoint stays exactly where startRun() left it, and zero audit rows are written", async () => {
    const dbPath = tmpDbPath("decided-by-guard.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const invalidDecidedBy = undefined as unknown as string;
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, invalidDecidedBy, started.stepCounters),
    ).rejects.toThrow(/decidedBy is required/);

    // Zero audit rows from the rejected call.
    expect(readApprovals(dbPath, started.runId)).toHaveLength(0);

    // workflow_runs is untouched — still exactly what startRun() left it as.
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g1" });

    // The checkpoint itself never advanced either — a fresh compiled graph on the same thread is
    // still paused at g1, not somewhere past it. If the old, later-positioned guard were still the
    // only check, compiled.stream() would have already run review's real node body (consuming the
    // real coder/tester adapters again) before the throw — this proves that didn't happen.
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
  });

  it("R3-2: a runtime-invalid (null) decidedBy is also caught before compiled.stream() runs — not just undefined", async () => {
    const dbPath = tmpDbPath("decided-by-guard-null.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    // `null !== undefined` — the pre-R3-2 `decidedBy === undefined` guard would have let this
    // through, advanced the graph, and only failed later at the DB's `decided_by NOT NULL`
    // constraint. `typeof decidedBy !== "string"` must catch it here instead.
    const nullDecidedBy = null as unknown as string;
    await expect(
      resumeRun(deps, started.runId, started.threadId, { decision: "approved" }, nullDecidedBy, started.stepCounters),
    ).rejects.toThrow(/decidedBy is required/);

    // Zero audit rows from the rejected call.
    expect(readApprovals(dbPath, started.runId)).toHaveLength(0);

    // workflow_runs is untouched — still exactly what startRun() left it as.
    const run = audit.getRunById(started.runId);
    expect(run).toMatchObject({ status: "running", currentState: "g1" });

    // The checkpoint itself never advanced either — same proof as the undefined case above.
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
  });
});

/**
 * Review Round-2 R2-6 (M2 follow-up, `docs/feature/a4b-loop/test-report.md`):
 * `runner.ts` threads `entry.decidedAt` (the gate's own recorded decision
 * moment, from `gates.ts`'s `new Date().toISOString()` right after
 * `interrupt()` returns) into `insertApproval`, but nothing verified that —
 * deleting that one line (falling back to `insertApproval`'s own
 * write-time default) left every existing test green, because none of them
 * select/assert on `decided_at` at all.
 */
describe("resumeRun — R2-6 approvals.decided_at is the gate's own recorded decision moment, not a DB-write-time default", () => {
  it("the decidedAt argument runner.ts passes into insertApproval, the gateLog entry LangGraph's own checkpoint recorded, and the value actually on disk all agree", async () => {
    const dbPath = tmpDbPath("decided-at-passthrough.sqlite");
    const { deps, audit } = buildDeps(dbPath, ["pass"]);
    audits.push(audit);

    const started = await startRun(deps, {
      task: "add a function",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    });

    const insertApprovalSpy = vi.spyOn(audit, "insertApproval");

    const resumed = await resumeRun(deps, started.runId, started.threadId, { decision: "approved", reasoningText: "looks fine" }, "elisha", started.stepCounters);
    expect(resumed.interrupt?.gate).toBe("G3_FINAL_MERGE");

    // Ground truth: the gate's own recorded decision moment, read independently via a fresh compiled
    // graph pointed at the same checkpointer/thread — LangGraph's own checkpoint state, nothing to do
    // with AuditStore.
    const checkpointer = createSqliteCheckpointer(dbPath);
    const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer }), checkpointer);
    const snapshot = await compiled.getState({ configurable: { thread_id: started.threadId } });
    const gateEntry = snapshot.values.gateLog.find((entry: GateLogEntry) => entry.gate === "G1_SEND_TO_TESTER");
    expect(gateEntry?.decidedAt).toBeTruthy();

    // The exact argument runner.ts passed into AuditStore carried that same value — not omitted (which
    // would leave it `undefined`) or replaced with some other, DB-write-time value.
    const call = insertApprovalSpy.mock.calls.find((c) => c[0].gateType === "G1_SEND_TO_TESTER");
    expect(call?.[0].decidedAt).toBe(gateEntry?.decidedAt);

    // And it's what actually landed on disk.
    const approvals = readApprovals(dbPath, started.runId);
    const g1Approval = approvals.find((a) => a.gate_type === "G1_SEND_TO_TESTER");
    expect(g1Approval?.decided_at).toBe(gateEntry?.decidedAt);
  });
});
