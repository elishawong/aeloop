/**
 * `AuditStore` unit tests (A4b PRD §5 "audit-store.test.ts" / §6 B3). Real
 * `better-sqlite3` against a real temp file (`fs.mkdtempSync`, same handle
 * `checkpoint.test.ts` already uses) — no mock/stub layer, this is the
 * store's own persistence contract under test, not a collaborator's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AuditStore } from "../audit-store.js";
import { AuditReadError } from "../errors.js";

let tmpDir = "";
let dbPath = "";
let store: AuditStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  dbPath = "";
});

function openStore(): AuditStore {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-audit-store-"));
  dbPath = path.join(tmpDir, "audit.sqlite");
  store = new AuditStore(dbPath);
  return store;
}

describe("AuditStore — workflow_runs", () => {
  it("insertRun/getRunById round trip: every column comes back exactly as written", () => {
    const audit = openStore();
    const now = "2026-07-21T00:00:00.000Z";

    const created = audit.insertRun(
      {
        task: "add a function",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "draft",
        langgraphThreadId: "thread-1",
      },
      now,
    );

    expect(created.id).toBeGreaterThan(0);
    expect(created).toMatchObject({
      task: "add a function",
      workflowDefId: "coder-tester-loop",
      profile: "subscription",
      status: "running",
      rejectCount: 0,
      rejectThreshold: 2,
      currentState: "draft",
      langgraphThreadId: "thread-1",
      createdAt: now,
      updatedAt: now,
    });

    const fetched = audit.getRunById(created.id);
    expect(fetched).toEqual(created);
  });

  it("getRunById returns undefined (not throw) for an id that was never inserted", () => {
    const audit = openStore();
    expect(audit.getRunById(9999)).toBeUndefined();
  });

  it("getRunByThreadId finds the run by its langgraph_thread_id — the query A4b's cross-process resume depends on", () => {
    const audit = openStore();
    const created = audit.insertRun(
      {
        task: "cross-process lookup",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "g1",
        langgraphThreadId: "thread-lookup-target",
      },
      "2026-07-21T00:00:00.000Z",
    );

    const found = audit.getRunByThreadId("thread-lookup-target");
    expect(found).toEqual(created);
    expect(audit.getRunByThreadId("no-such-thread")).toBeUndefined();
  });

  it("updateRunProgress writes only the passed columns, always refreshes updated_at, and reads back the merged row", () => {
    const audit = openStore();
    const created = audit.insertRun(
      {
        task: "progress update",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "draft",
        langgraphThreadId: "thread-progress",
      },
      "2026-07-21T00:00:00.000Z",
    );

    const updated = audit.updateRunProgress(created.id, {
      rejectCount: 1,
      currentState: "g2",
      updatedAt: "2026-07-21T00:05:00.000Z",
    });

    expect(updated.rejectCount).toBe(1);
    expect(updated.currentState).toBe("g2");
    expect(updated.updatedAt).toBe("2026-07-21T00:05:00.000Z");
    // Untouched columns survive the patch.
    expect(updated.status).toBe("running");
    expect(updated.task).toBe("progress update");

    const statusUpdate = audit.updateRunProgress(created.id, {
      status: "escalated",
      updatedAt: "2026-07-21T00:10:00.000Z",
    });
    expect(statusUpdate.status).toBe("escalated");
    expect(statusUpdate.rejectCount).toBe(1); // untouched by this second patch
  });

  it("updateRunProgress on a nonexistent id throws AuditReadError, not a silent no-op", () => {
    const audit = openStore();
    expect(() => audit.updateRunProgress(9999, { updatedAt: "2026-07-21T00:00:00.000Z" })).toThrow(AuditReadError);
  });

  /**
   * Zorro Round-2 R2-4 (`docs/feature/a4b-loop/test-report.md`):
   * `langgraph_thread_id` had no uniqueness constraint at all — theoretically
   * two `workflow_runs` rows could share the same thread_id, which would let
   * a mismatched `resumeRun(B.runId, A.threadId)` call pass `runner.ts`'s B2
   * guard (`A.threadId` really does belong to *a* row named A — the guard
   * never claimed thread_ids were unique) while still advancing A's real
   * LangGraph thread under B's audit id. `createSchema()` now declares
   * `langgraph_thread_id TEXT NOT NULL UNIQUE`; this proves it's a real,
   * enforced constraint, not just a comment.
   */
  it("insertRun rejects a second row that reuses an already-used langgraph_thread_id (UNIQUE constraint)", () => {
    const audit = openStore();
    audit.insertRun(
      {
        task: "first run",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "g1",
        langgraphThreadId: "thread-shared",
      },
      "2026-07-21T00:00:00.000Z",
    );

    expect(() =>
      audit.insertRun(
        {
          task: "second run, duplicate thread",
          workflowDefId: "coder-tester-loop",
          profile: "subscription",
          status: "running",
          rejectCount: 0,
          rejectThreshold: 2,
          currentState: "g1",
          langgraphThreadId: "thread-shared",
        },
        "2026-07-21T00:05:00.000Z",
      ),
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

describe("AuditStore — structured_claims / approvals foreign keys", () => {
  it("insertClaim/insertApproval succeed against a real run_id and round-trip every column", () => {
    const audit = openStore();
    const run = audit.insertRun(
      {
        task: "claims and approvals",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "review",
        langgraphThreadId: "thread-claims",
      },
      "2026-07-21T00:00:00.000Z",
    );

    const claim = audit.insertClaim(
      {
        runId: run.id,
        stepRef: "draft#1",
        actor: "coder",
        claimText: "the change compiles",
        confidence: "verified",
        sourceRef: "tsc",
        verifiedBy: "tool_execution",
        toolExecChecked: "pass",
        modelUsed: "fake-model-v1",
        providerUsed: "fake-coder",
      },
      "2026-07-21T00:01:00.000Z",
    );
    expect(claim).toMatchObject({
      runId: run.id,
      stepRef: "draft#1",
      actor: "coder",
      claimText: "the change compiles",
      confidence: "verified",
      sourceRef: "tsc",
      verifiedBy: "tool_execution",
      toolExecChecked: "pass",
      modelUsed: "fake-model-v1",
      providerUsed: "fake-coder",
      createdAt: "2026-07-21T00:01:00.000Z",
    });

    const approval = audit.insertApproval(
      {
        runId: run.id,
        gateType: "G1_SEND_TO_TESTER",
        stepRef: "g1#1",
        diffRef: "--- a/x\n+++ b/x\n",
        reasoningText: "looks good",
        decision: "approved",
        decidedBy: "test-harness",
      },
      "2026-07-21T00:02:00.000Z",
    );
    expect(approval).toMatchObject({
      runId: run.id,
      gateType: "G1_SEND_TO_TESTER",
      stepRef: "g1#1",
      diffRef: "--- a/x\n+++ b/x\n",
      reasoningText: "looks good",
      decision: "approved",
      decidedBy: "test-harness",
      decidedAt: "2026-07-21T00:02:00.000Z",
    });
  });

  it("insertClaim/insertApproval against a run_id that doesn't exist in workflow_runs throws a real foreign-key error (PRAGMA foreign_keys=ON), not a silently-accepted orphan row", () => {
    const audit = openStore();

    expect(() =>
      audit.insertClaim({
        runId: 999999,
        stepRef: "draft#1",
        actor: "coder",
        claimText: "orphan claim",
        confidence: "verified",
        modelUsed: "fake-model-v1",
        providerUsed: "fake-coder",
      }),
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(() =>
      audit.insertApproval({
        runId: 999999,
        gateType: "G1_SEND_TO_TESTER",
        stepRef: "g1#1",
        decision: "approved",
        decidedBy: "test-harness",
      }),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("ESCALATION_ACK approvals row stores the literal EscalationDecision value, not a remapped approved/rejected/override word (PRD §9.2 决策5)", () => {
    const audit = openStore();
    const run = audit.insertRun(
      {
        task: "escalation audit row",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "escalated",
        rejectCount: 2,
        rejectThreshold: 2,
        currentState: "escalation",
        langgraphThreadId: "thread-escalation",
      },
      "2026-07-21T00:00:00.000Z",
    );

    const approval = audit.insertApproval({
      runId: run.id,
      gateType: "ESCALATION_ACK",
      stepRef: "escalation#1",
      decision: "force_pass",
      decidedBy: "test-harness",
    });
    expect(approval.decision).toBe("force_pass");
  });
});

/**
 * Zorro Round-4 R5-B2 (`docs/feature/a4b-loop/test-report.md`): neither
 * `approvals` nor `step_markers` had any uniqueness constraint on
 * `(run_id, step_ref)` — Codex's concurrency probe demonstrated that two
 * concurrent `resumeRun()` calls resuming the same run (e.g. one `approve`
 * and one `reject`) could both succeed, each landing its own approvals row
 * for the same step. Elisha's decision (2026-07-21): full concurrency
 * control (locking/CAS/serialization) is out of scope for A4b's
 * single-operator-CLI use case and tracked as a follow-up issue for A5+,
 * but a `UNIQUE(run_id, step_ref)` constraint on both tables is cheap
 * defense-in-depth to do now — it can't prevent a race between two
 * concurrent *reads* of `stepCounters`/`current_state` that both compute
 * the same `step_ref`, but it does stop both of their *writes* from
 * landing, which is exactly the "two rows for one step" failure mode
 * observed. These tests prove the constraint is real and enforced at the
 * schema level, not just documented in a comment.
 */
describe("AuditStore — R5-B2 UNIQUE(run_id, step_ref) defense-in-depth", () => {
  it("insertApproval rejects a second row for a (run_id, step_ref) pair already used by an earlier approval", () => {
    const audit = openStore();
    const run = audit.insertRun(
      {
        task: "duplicate approval step_ref",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "g1",
        langgraphThreadId: "thread-dup-approval",
      },
      "2026-07-21T00:00:00.000Z",
    );

    audit.insertApproval({
      runId: run.id,
      gateType: "G1_SEND_TO_TESTER",
      stepRef: "g1#1",
      decision: "approved",
      decidedBy: "elisha",
    });

    // Simulates the R5-B2 race: a second call (e.g. a concurrent resumeRun()) computing the same
    // step_ref for this run and trying to record a conflicting decision.
    expect(() =>
      audit.insertApproval({
        runId: run.id,
        gateType: "G1_SEND_TO_TESTER",
        stepRef: "g1#1",
        decision: "rejected",
        decidedBy: "elisha",
      }),
    ).toThrow(/UNIQUE constraint failed/i);

    // Only the first row survived — the constraint rejected the conflicting write outright, not a
    // silent overwrite.
    const inspect = new Database(dbPath, { readonly: true });
    try {
      const rows = inspect.prepare("SELECT decision FROM approvals WHERE run_id = ? AND step_ref = ?").all(run.id, "g1#1") as {
        decision: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.decision).toBe("approved");
    } finally {
      inspect.close();
    }
  });

  it("a different run_id may reuse the same step_ref string — the constraint is scoped per-run, not global", () => {
    const audit = openStore();
    const runA = audit.insertRun(
      {
        task: "run A",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "g1",
        langgraphThreadId: "thread-scope-a",
      },
      "2026-07-21T00:00:00.000Z",
    );
    const runB = audit.insertRun(
      {
        task: "run B",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "g1",
        langgraphThreadId: "thread-scope-b",
      },
      "2026-07-21T00:00:00.000Z",
    );

    audit.insertApproval({ runId: runA.id, gateType: "G1_SEND_TO_TESTER", stepRef: "g1#1", decision: "approved", decidedBy: "elisha" });
    // Same literal step_ref string, different run_id — must not collide.
    expect(() =>
      audit.insertApproval({ runId: runB.id, gateType: "G1_SEND_TO_TESTER", stepRef: "g1#1", decision: "approved", decidedBy: "elisha" }),
    ).not.toThrow();
  });

  it("insertStepMarker rejects a second row for a (run_id, step_ref) pair already used by an earlier marker", () => {
    const audit = openStore();
    const run = audit.insertRun(
      {
        task: "duplicate step marker",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "draft",
        langgraphThreadId: "thread-dup-marker",
      },
      "2026-07-21T00:00:00.000Z",
    );

    audit.insertStepMarker({ runId: run.id, stepRef: "draft#1", node: "draft", actor: "coder", claimCount: 2 });

    expect(() =>
      audit.insertStepMarker({ runId: run.id, stepRef: "draft#1", node: "draft", actor: "coder", claimCount: 0 }),
    ).toThrow(/UNIQUE constraint failed/i);

    const inspect = new Database(dbPath, { readonly: true });
    try {
      const row = inspect.prepare("SELECT COUNT(*) as n FROM step_markers WHERE run_id = ? AND step_ref = ?").get(run.id, "draft#1") as {
        n: number;
      };
      expect(row.n).toBe(1);
    } finally {
      inspect.close();
    }
  });
});

describe("AuditStore — runInTransaction rollback", () => {
  it("a failure partway through a transaction leaves no partial data behind", () => {
    const audit = openStore();
    const run = audit.insertRun(
      {
        task: "transaction rollback",
        workflowDefId: "coder-tester-loop",
        profile: "subscription",
        status: "running",
        rejectCount: 0,
        rejectThreshold: 2,
        currentState: "review",
        langgraphThreadId: "thread-rollback",
      },
      "2026-07-21T00:00:00.000Z",
    );

    expect(() =>
      audit.runInTransaction(() => {
        audit.insertClaim({
          runId: run.id,
          stepRef: "review#1",
          actor: "tester",
          claimText: "first claim, should be rolled back",
          confidence: "verified",
          modelUsed: "fake-model-v1",
          providerUsed: "fake-tester",
        });
        throw new Error("simulated mid-transaction failure");
      }),
    ).toThrow("simulated mid-transaction failure");

    // Nothing from the aborted transaction survived — run_id has zero claims.
    // Verified via a second, independent connection to the same on-disk
    // file (not `AuditStore`'s own private connection) so this assertion
    // doesn't need any store-internal access.
    const inspect = new Database(dbPath, { readonly: true });
    try {
      const row = inspect.prepare("SELECT COUNT(*) as n FROM structured_claims WHERE run_id = ?").get(run.id) as {
        n: number;
      };
      expect(row.n).toBe(0);
    } finally {
      inspect.close();
    }
  });
});
