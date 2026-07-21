/**
 * `AuditStore` — Loop layer's own SQLite store for DESIGN §5's three
 * business-audit tables (`workflow_runs`/`structured_claims`/`approvals`),
 * A4b PRD §5 "audit-store.ts" / §9.2 决策1. Plus a fourth,
 * internal-bookkeeping-only `step_markers` table (Zorro Round-2 R2-2,
 * `docs/feature/a4b-loop/test-report.md`) — not part of DESIGN §5's
 * governance-facing schema, purely `rebuildStepCounters()`'s durable
 * "this round ran" record (see `NewStepMarkerInput`'s doc comment below).
 *
 * **Deliberately not built on/wrapping `context/store.ts`'s `MemoryStore`.**
 * The four-layer nesting (DESIGN §1.5, `Prompt ⊂ Context ⊂ Harness ⊂ Loop`)
 * means Loop is *allowed* to depend on Context, but these three tables are
 * Loop's own runtime ledger (`reject_count`/`current_state`/
 * `langgraph_thread_id` are all Loop-domain concepts), not Context's
 * memory-recall concern — and `MemoryStore`'s method set
 * (`insertMemory`/`searchMemories`/FTS5) is entirely unrelated to what this
 * store needs. `AuditStore` is `MemoryStore`'s **structural sibling**: same
 * `better-sqlite3` + prepared-statement + typed-read-error conventions, a
 * separate class with its own connection, not a subclass/wrapper. The
 * accepted cost is a small amount of duplicated "open connection, create
 * schema, prepare statements" boilerplate — judged smaller than coupling
 * Loop's persistence to a class whose `createSchema()` would otherwise pull
 * in three unrelated Context tables (PRD §9.2 决策1 covers the full
 * reasoning, including the reversibility note).
 *
 * **Portability** (Helix 2026-07-21 dispatch note, ai-agent#127): this file
 * intentionally imports nothing from `@langchain/langgraph` — only
 * `better-sqlite3` and type-only imports from `./types.js`/`../harness/
 * types.js`/`../prompt/schema.js`. Read/write against these three tables
 * doesn't need to know what orchestration engine produced the data; keeping
 * that boundary clean costs nothing here and preserves the option of aeloop
 * becoming a governance layer usable by an orchestrator other than
 * LangGraph in the future.
 */

import Database from "better-sqlite3";
import { AuditReadError } from "./errors.js";
import type { GateType } from "./types.js";
import type { ToolExecChecked } from "../harness/types.js";
import type { ClaimConfidence, VerifiedBy } from "../prompt/schema.js";

/** `nowIso()` — a 2-line copy of `context/util.ts`'s helper, not an import (PRD §5 "audit-store.ts": a function this small doesn't earn promoting `nowIso` to a shared module the two layers both import from; revisit if/when a third caller needs it). */
function nowIso(): string {
  return new Date().toISOString();
}

// ---- domain types (camelCase; store.ts owns the row<->domain mapping, same split as context/store.ts) ----

export type WorkflowRunStatus = "running" | "escalated" | "completed" | "cancelled";

export interface WorkflowRun {
  id: number;
  task: string;
  workflowDefId: string;
  profile: string;
  status: WorkflowRunStatus;
  rejectCount: number;
  /** Snapshot for this run only — does not track config.yaml changes made after the run started (DESIGN §5 / A4b PRD §4.2). */
  rejectThreshold: number;
  currentState: string;
  langgraphThreadId: string;
  createdAt: string;
  updatedAt: string;
}

/** Fields the caller supplies when starting a run; the store assigns `id`/timestamps. */
export interface NewWorkflowRunInput {
  task: string;
  workflowDefId: string;
  profile: string;
  status: WorkflowRunStatus;
  rejectCount: number;
  rejectThreshold: number;
  currentState: string;
  langgraphThreadId: string;
}

/** Patch `updateRunProgress` writes — every field optional except `updatedAt`, only the columns actually passed are touched. */
export interface WorkflowRunProgressPatch {
  status?: WorkflowRunStatus;
  rejectCount?: number;
  currentState?: string;
  updatedAt: string;
}

export interface StructuredClaim {
  id: number;
  runId: number;
  stepRef: string;
  actor: "coder" | "tester";
  claimText: string;
  confidence: ClaimConfidence;
  sourceRef: string | null;
  verifiedBy: VerifiedBy | null;
  /** `ToolExecVerifier`'s verdict (A3) — `null` for a direct-api adapter, which never sets it (DESIGN §5 `structured_claims.tool_exec_checked`). */
  toolExecChecked: ToolExecChecked | null;
  modelUsed: string;
  providerUsed: string;
  createdAt: string;
}

export interface NewStructuredClaimInput {
  runId: number;
  stepRef: string;
  actor: "coder" | "tester";
  claimText: string;
  confidence: ClaimConfidence;
  sourceRef?: string | null;
  verifiedBy?: VerifiedBy | null;
  toolExecChecked?: ToolExecChecked | null;
  modelUsed: string;
  providerUsed: string;
}

export interface Approval {
  id: number;
  runId: number;
  gateType: GateType;
  stepRef: string;
  diffRef: string | null;
  reasoningText: string | null;
  /**
   * G1/G2/G3 rows: a `GateDecision` (`approved`/`rejected`/`escalate`).
   * `ESCALATION_ACK` rows: an `EscalationDecision` (`revise`/`force_pass`/
   * `abandon`) stored verbatim, not remapped into DESIGN §5's illustrative
   * `approved`/`rejected`/`override` comment (A4b PRD §9.2 决策5 — that
   * comment predates the Escalation subtree's real three-way decision and
   * has no `CHECK` constraint backing it; this column is a plain `TEXT`).
   */
  decision: string;
  decisionReason: string | null;
  decidedBy: string;
  decidedAt: string;
  latencySeconds: number | null;
}

export interface NewApprovalInput {
  runId: number;
  gateType: GateType;
  stepRef: string;
  diffRef?: string | null;
  reasoningText?: string | null;
  decision: string;
  decisionReason?: string | null;
  decidedBy: string;
  latencySeconds?: number | null;
  /**
   * The real moment the human decided, as sourced from `GateLogEntry.decidedAt`
   * (`gates.ts`/`escalation.ts` stamp this right after `interrupt()` returns,
   * not at DB-persistence time). Optional — defaults to `now` (the 5th
   * positional param this method already accepts) for any caller that
   * doesn't have a better value, same as every other timestamp in this
   * store (Zorro Round-1 M2, `docs/feature/a4b-loop/test-report.md`:
   * before this field existed, `runner.ts` had no way to pass the real
   * decision moment through, so `approvals.decided_at` always ended up a
   * few moments later than the true decision — this is what actually
   * fixes that, not just a runner-side change).
   */
  decidedAt?: string;
}

/**
 * A durable marker that a `draft`/`review` node round actually ran, written
 * **regardless of how many claims it produced** — Zorro Round-2 R2-2
 * (`docs/feature/a4b-loop/test-report.md`): `structured_claims`' `claims`
 * schema (`prompt/schema.ts`) has no `.min(1)`, so a real adapter can
 * legally return `claims: []` for a round. Before this table existed, a
 * zero-claim round left **zero** rows anywhere for that round's `step_ref`
 * — `listStepRefsByRun()` (which `runner.ts`'s `rebuildStepCounters()`
 * reads) had nothing to see, so a resume landing in a brand-new process
 * (no in-memory counter to inherit) would re-mint that same `step_ref`
 * number for the *next* round through that node, silently colliding — the
 * exact D1 bug Zorro Round-1 already fixed, just triggered by "no claims"
 * instead of "no in-memory counter". `runner.ts` now writes exactly one
 * marker row per draft/review round, inside the same
 * `AuditStore.runInTransaction` call as that round's claim inserts (B3
 * atomicity — the marker and its claims commit or roll back together), so
 * `listStepRefsByRun()` always has a durable record of every round that
 * ran, whether or not it produced any claims.
 */
export interface StepMarker {
  id: number;
  runId: number;
  stepRef: string;
  node: string;
  actor: "coder" | "tester";
  claimCount: number;
  createdAt: string;
}

export interface NewStepMarkerInput {
  runId: number;
  stepRef: string;
  node: string;
  actor: "coder" | "tester";
  /** How many claims this round actually produced — `0` for the zero-claim case this table exists to cover, kept here as a cheap audit signal rather than discarded. */
  claimCount: number;
}

// ---- raw SQLite row shapes (snake_case) ----

interface WorkflowRunRow {
  id: number;
  task: string;
  workflow_def_id: string;
  profile: string;
  status: string;
  reject_count: number;
  reject_threshold: number;
  current_state: string;
  langgraph_thread_id: string;
  created_at: string;
  updated_at: string;
}

interface StructuredClaimRow {
  id: number;
  run_id: number;
  step_ref: string;
  actor: string;
  claim_text: string;
  confidence: string;
  source_ref: string | null;
  verified_by: string | null;
  tool_exec_checked: string | null;
  model_used: string;
  provider_used: string;
  created_at: string;
}

interface ApprovalRow {
  id: number;
  run_id: number;
  gate_type: string;
  step_ref: string;
  diff_ref: string | null;
  reasoning_text: string | null;
  decision: string;
  decision_reason: string | null;
  decided_by: string;
  decided_at: string;
  latency_seconds: number | null;
}

interface StepMarkerRow {
  id: number;
  run_id: number;
  step_ref: string;
  node: string;
  actor: string;
  claim_count: number;
  created_at: string;
}

/**
 * SQLite-backed store for `workflow_runs`/`structured_claims`/`approvals`
 * (DESIGN §5, A4b PRD §4.2). Takes an explicit `dbPath` (a file path, or
 * `":memory:"` for tests) — same "no profile-driven path wiring in this
 * increment" boundary `MemoryStore`/`createSqliteCheckpointer` already
 * established (PRD §2 non-goal).
 *
 * **Error-wrapping convention**, mirroring `MemoryStore`: read methods
 * (`getRunById`/`getRunByThreadId`) wrap a thrown SQLite error into typed
 * `AuditReadError`, never silently downgrading to `undefined`. Write
 * methods let `better-sqlite3`'s own `SqliteError` propagate unwrapped.
 */
export class AuditStore {
  private readonly db: Database.Database;

  private readonly insertRunStmt: Database.Statement<unknown[]>;
  private readonly getRunByIdStmt: Database.Statement<[number], WorkflowRunRow>;
  private readonly getRunByThreadIdStmt: Database.Statement<[string], WorkflowRunRow>;
  private readonly listRunsByStatusStmt: Database.Statement<[string], WorkflowRunRow>;
  private readonly insertClaimStmt: Database.Statement<unknown[]>;
  private readonly insertApprovalStmt: Database.Statement<unknown[]>;
  private readonly insertStepMarkerStmt: Database.Statement<unknown[]>;
  private readonly getClaimByIdStmt: Database.Statement<[number], StructuredClaimRow>;
  private readonly getApprovalByIdStmt: Database.Statement<[number], ApprovalRow>;
  private readonly getStepMarkerByIdStmt: Database.Statement<[number], StepMarkerRow>;
  private readonly listClaimStepRefsByRunStmt: Database.Statement<[number], { step_ref: string }>;
  private readonly listApprovalStepRefsByRunStmt: Database.Statement<[number], { step_ref: string }>;
  private readonly listStepMarkerStepRefsByRunStmt: Database.Statement<[number], { step_ref: string }>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.createSchema();

    this.insertRunStmt = this.db.prepare(
      `INSERT INTO workflow_runs
        (task, workflow_def_id, profile, status, reject_count, reject_threshold, current_state, langgraph_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getRunByIdStmt = this.db.prepare<[number], WorkflowRunRow>(`SELECT * FROM workflow_runs WHERE id = ?`);
    this.getRunByThreadIdStmt = this.db.prepare<[string], WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE langgraph_thread_id = ?`,
    );
    this.listRunsByStatusStmt = this.db.prepare<[string], WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE status = ? ORDER BY id`,
    );
    this.insertClaimStmt = this.db.prepare(
      `INSERT INTO structured_claims
        (run_id, step_ref, actor, claim_text, confidence, source_ref, verified_by, tool_exec_checked, model_used, provider_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertApprovalStmt = this.db.prepare(
      `INSERT INTO approvals
        (run_id, gate_type, step_ref, diff_ref, reasoning_text, decision, decision_reason, decided_by, decided_at, latency_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertStepMarkerStmt = this.db.prepare(
      `INSERT INTO step_markers
        (run_id, step_ref, node, actor, claim_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.getClaimByIdStmt = this.db.prepare<[number], StructuredClaimRow>(`SELECT * FROM structured_claims WHERE id = ?`);
    this.getApprovalByIdStmt = this.db.prepare<[number], ApprovalRow>(`SELECT * FROM approvals WHERE id = ?`);
    this.getStepMarkerByIdStmt = this.db.prepare<[number], StepMarkerRow>(`SELECT * FROM step_markers WHERE id = ?`);
    this.listClaimStepRefsByRunStmt = this.db.prepare<[number], { step_ref: string }>(
      `SELECT step_ref FROM structured_claims WHERE run_id = ?`,
    );
    this.listApprovalStepRefsByRunStmt = this.db.prepare<[number], { step_ref: string }>(
      `SELECT step_ref FROM approvals WHERE run_id = ?`,
    );
    this.listStepMarkerStepRefsByRunStmt = this.db.prepare<[number], { step_ref: string }>(
      `SELECT step_ref FROM step_markers WHERE run_id = ?`,
    );
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a single `better-sqlite3` transaction; rolls back entirely on throw (mirrors `MemoryStore.runInTransaction`). */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private createSchema(): void {
    this.db.exec(`
      -- Zorro Round-2 R2-4 (docs/feature/a4b-loop/test-report.md):
      -- langgraph_thread_id used to have no uniqueness constraint at all —
      -- runner.ts's B2 guard (resumeRun's RunThreadMismatchError) only
      -- checked that a *given* runId/threadId pair actually matched, but
      -- nothing stopped two distinct workflow_runs rows from sharing the
      -- same thread_id in the first place, which would let a mismatched
      -- resumeRun(B.id, A.threadId) call pass B2's guard (A.threadId really
      -- does belong to *a* row named A) while still advancing A's graph
      -- under B's id. UNIQUE closes that off at the schema level, not just
      -- the application-code level defense-in-depth (audit-store.test.ts's
      -- "duplicate thread_id insert rejected" test proves it).
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        workflow_def_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        status TEXT NOT NULL,
        reject_count INTEGER NOT NULL DEFAULT 0,
        reject_threshold INTEGER NOT NULL,
        current_state TEXT NOT NULL,
        langgraph_thread_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS structured_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
        step_ref TEXT NOT NULL,
        actor TEXT NOT NULL,
        claim_text TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source_ref TEXT,
        verified_by TEXT,
        tool_exec_checked TEXT,
        model_used TEXT NOT NULL,
        provider_used TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Zorro Round-4 R5-B2 (docs/feature/a4b-loop/test-report.md):
      -- no lock/CAS/serialization backs resumeRun() against two concurrent
      -- calls resuming the *same* run -- Elisha's decision (2026-07-21,
      -- same posture as D1) is that full concurrency control is out of
      -- scope for A4b's single-operator-CLI use case and left to A5+, but
      -- this UNIQUE constraint is the cheap defense-in-depth piece done
      -- now: it stops two concurrent resumeRun() calls from *both*
      -- landing an approvals row for the same (run_id, step_ref) -- the
      -- "approve and reject both succeed, recording opposite decisions
      -- for the same step" failure mode Codex's R4 concurrency probe
      -- demonstrated. Tracked for the full fix: see the aeloop issue
      -- referenced in test-report.md's R5 section.
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
        gate_type TEXT NOT NULL,
        step_ref TEXT NOT NULL,
        diff_ref TEXT,
        reasoning_text TEXT,
        decision TEXT NOT NULL,
        decision_reason TEXT,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        latency_seconds INTEGER,
        UNIQUE (run_id, step_ref)
      );

      -- Zorro Round-2 R2-2 (docs/feature/a4b-loop/test-report.md): a
      -- durable "this draft/review round ran" marker, written unconditionally
      -- (even when claim_count is 0), so listStepRefsByRun()/rebuildStepCounters()
      -- always have a real row to see for every round — not just the rounds
      -- that happened to produce at least one claim. See NewStepMarkerInput's
      -- doc comment above for the full D1-adjacent bug this closes.
      -- Zorro Round-4 R5-B2 (docs/feature/a4b-loop/test-report.md): same
      -- cheap defense-in-depth as approvals' UNIQUE above -- a durable
      -- "this round ran" marker should never be written twice for the same
      -- (run_id, step_ref) either, concurrent resumeRun() calls included.
      CREATE TABLE IF NOT EXISTS step_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
        step_ref TEXT NOT NULL,
        node TEXT NOT NULL,
        actor TEXT NOT NULL,
        claim_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, step_ref)
      );
    `);
  }

  // ---- row -> domain mapping ------------------------------------------

  private mapRunRow(row: WorkflowRunRow): WorkflowRun {
    return {
      id: row.id,
      task: row.task,
      workflowDefId: row.workflow_def_id,
      profile: row.profile,
      status: row.status as WorkflowRunStatus,
      rejectCount: row.reject_count,
      rejectThreshold: row.reject_threshold,
      currentState: row.current_state,
      langgraphThreadId: row.langgraph_thread_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapClaimRow(row: StructuredClaimRow): StructuredClaim {
    return {
      id: row.id,
      runId: row.run_id,
      stepRef: row.step_ref,
      actor: row.actor as StructuredClaim["actor"],
      claimText: row.claim_text,
      confidence: row.confidence as ClaimConfidence,
      sourceRef: row.source_ref,
      verifiedBy: row.verified_by as VerifiedBy | null,
      toolExecChecked: row.tool_exec_checked as ToolExecChecked | null,
      modelUsed: row.model_used,
      providerUsed: row.provider_used,
      createdAt: row.created_at,
    };
  }

  private mapStepMarkerRow(row: StepMarkerRow): StepMarker {
    return {
      id: row.id,
      runId: row.run_id,
      stepRef: row.step_ref,
      node: row.node,
      actor: row.actor as StepMarker["actor"],
      claimCount: row.claim_count,
      createdAt: row.created_at,
    };
  }

  private mapApprovalRow(row: ApprovalRow): Approval {
    return {
      id: row.id,
      runId: row.run_id,
      gateType: row.gate_type as GateType,
      stepRef: row.step_ref,
      diffRef: row.diff_ref,
      reasoningText: row.reasoning_text,
      decision: row.decision,
      decisionReason: row.decision_reason,
      decidedBy: row.decided_by,
      decidedAt: row.decided_at,
      latencySeconds: row.latency_seconds,
    };
  }

  // ---- workflow_runs ----------------------------------------------------

  insertRun(input: NewWorkflowRunInput, now: string = nowIso()): WorkflowRun {
    const result = this.insertRunStmt.run(
      input.task,
      input.workflowDefId,
      input.profile,
      input.status,
      input.rejectCount,
      input.rejectThreshold,
      input.currentState,
      input.langgraphThreadId,
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);
    const created = this.getRunById(id);
    if (!created) {
      throw new AuditReadError(`Failed to read back workflow_runs row ${id} immediately after insert`);
    }
    return created;
  }

  getRunById(id: number): WorkflowRun | undefined {
    let row: WorkflowRunRow | undefined;
    try {
      row = this.getRunByIdStmt.get(id);
    } catch (cause) {
      throw new AuditReadError(`Failed to read workflow_runs row ${id}`, cause);
    }
    return row === undefined ? undefined : this.mapRunRow(row);
  }

  /** The core query A4b's cross-process resume path depends on: a brand-new process, holding nothing but a `threadId`, must be able to find its way back to the rest of the run's audit trail (A4b PRD §5 "audit-store.ts"). */
  getRunByThreadId(threadId: string): WorkflowRun | undefined {
    let row: WorkflowRunRow | undefined;
    try {
      row = this.getRunByThreadIdStmt.get(threadId);
    } catch (cause) {
      throw new AuditReadError(`Failed to read workflow_runs row for thread "${threadId}"`, cause);
    }
    return row === undefined ? undefined : this.mapRunRow(row);
  }

  /**
   * All runs currently at `status` — `runner.ts`'s `getResumableRuns()` thin
   * wrapper (A4b PRD §5 "runner.ts": "给未来 A5 一个现成入口...不算额外范
   * 围") is the only caller in this increment; no CLI/UI consumes it yet
   * (PRD §2 non-goal).
   */
  listRunsByStatus(status: WorkflowRunStatus): WorkflowRun[] {
    let rows: WorkflowRunRow[];
    try {
      rows = this.listRunsByStatusStmt.all(status);
    } catch (cause) {
      throw new AuditReadError(`Failed to list workflow_runs with status "${status}"`, cause);
    }
    return rows.map((row) => this.mapRunRow(row));
  }

  /**
   * Every `step_ref` string (`"<node>#<n>"`) ever written for this run,
   * across `structured_claims`, `approvals`, **and `step_markers`** — the
   * on-disk source of truth `runner.ts`'s `resumeRun()` rebuilds its
   * per-node `stepCounters` from, instead of trusting a caller-supplied
   * in-memory value alone (Zorro Round-1 D1, `docs/feature/a4b-loop/test-report.md`:
   * a resume that lands in a brand-new process — or simply an in-memory
   * `stepCounters` a caller forgot to thread through — used to restart a
   * revisited node's counter at `#1`, colliding with a `step_ref` already
   * on disk from an earlier round). `step_markers` is what makes this
   * complete for a **zero-claim** round too (Zorro Round-2 R2-2): without
   * it, a round that produced no claims left no row in either of the other
   * two tables, so this method — and `rebuildStepCounters()`, which only
   * knows what this method returns — couldn't see it happened at all.
   */
  listStepRefsByRun(runId: number): string[] {
    let claimRows: { step_ref: string }[];
    let approvalRows: { step_ref: string }[];
    let markerRows: { step_ref: string }[];
    try {
      claimRows = this.listClaimStepRefsByRunStmt.all(runId);
      approvalRows = this.listApprovalStepRefsByRunStmt.all(runId);
      markerRows = this.listStepMarkerStepRefsByRunStmt.all(runId);
    } catch (cause) {
      throw new AuditReadError(`Failed to list step_refs for run ${runId}`, cause);
    }
    return [...claimRows, ...approvalRows, ...markerRows].map((row) => row.step_ref);
  }

  /** Writes only the columns present in `patch` (plus `updated_at`, always). */
  updateRunProgress(id: number, patch: WorkflowRunProgressPatch): WorkflowRun {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.rejectCount !== undefined) {
      sets.push("reject_count = ?");
      values.push(patch.rejectCount);
    }
    if (patch.currentState !== undefined) {
      sets.push("current_state = ?");
      values.push(patch.currentState);
    }
    sets.push("updated_at = ?");
    values.push(patch.updatedAt);
    values.push(id);

    const result = this.db.prepare(`UPDATE workflow_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
      throw new AuditReadError(`Failed to update workflow_runs row ${id}: no row with that id`);
    }
    const updated = this.getRunById(id);
    if (!updated) {
      throw new AuditReadError(`Failed to read back workflow_runs row ${id} immediately after update`);
    }
    return updated;
  }

  // ---- structured_claims --------------------------------------------------

  insertClaim(input: NewStructuredClaimInput, now: string = nowIso()): StructuredClaim {
    const result = this.insertClaimStmt.run(
      input.runId,
      input.stepRef,
      input.actor,
      input.claimText,
      input.confidence,
      input.sourceRef ?? null,
      input.verifiedBy ?? null,
      input.toolExecChecked ?? null,
      input.modelUsed,
      input.providerUsed,
      now,
    );
    const id = Number(result.lastInsertRowid);
    let row: StructuredClaimRow | undefined;
    try {
      row = this.getClaimByIdStmt.get(id);
    } catch (cause) {
      throw new AuditReadError(`Failed to read back structured_claims row ${id} immediately after insert`, cause);
    }
    if (!row) {
      throw new AuditReadError(`Failed to read back structured_claims row ${id} immediately after insert`);
    }
    return this.mapClaimRow(row);
  }

  // ---- approvals -------------------------------------------------------

  insertApproval(input: NewApprovalInput, now: string = nowIso()): Approval {
    const result = this.insertApprovalStmt.run(
      input.runId,
      input.gateType,
      input.stepRef,
      input.diffRef ?? null,
      input.reasoningText ?? null,
      input.decision,
      input.decisionReason ?? null,
      input.decidedBy,
      input.decidedAt ?? now,
      input.latencySeconds ?? null,
    );
    const id = Number(result.lastInsertRowid);
    let row: ApprovalRow | undefined;
    try {
      row = this.getApprovalByIdStmt.get(id);
    } catch (cause) {
      throw new AuditReadError(`Failed to read back approvals row ${id} immediately after insert`, cause);
    }
    if (!row) {
      throw new AuditReadError(`Failed to read back approvals row ${id} immediately after insert`);
    }
    return this.mapApprovalRow(row);
  }

  // ---- step_markers ------------------------------------------------------

  /** See `NewStepMarkerInput`'s doc comment (Zorro Round-2 R2-2) for why this table/method exists. */
  insertStepMarker(input: NewStepMarkerInput, now: string = nowIso()): StepMarker {
    const result = this.insertStepMarkerStmt.run(input.runId, input.stepRef, input.node, input.actor, input.claimCount, now);
    const id = Number(result.lastInsertRowid);
    let row: StepMarkerRow | undefined;
    try {
      row = this.getStepMarkerByIdStmt.get(id);
    } catch (cause) {
      throw new AuditReadError(`Failed to read back step_markers row ${id} immediately after insert`, cause);
    }
    if (!row) {
      throw new AuditReadError(`Failed to read back step_markers row ${id} immediately after insert`);
    }
    return this.mapStepMarkerRow(row);
  }
}
