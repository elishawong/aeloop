/**
 * Checkpoint cross-process resume — **production-hardened** version of
 * A4a's `checkpoint.test.ts` (A4b PRD §5/§6 B5, §9.2 Decision 4, §8's
 * "checkpoint cross-process productionization actually done" acceptance
 * criterion).
 *
 * A4a's `checkpoint.test.ts` proved LangGraph's own checkpoint mechanism
 * survives a same-process, two-phase "object falls out of scope" simulation
 * (sufficient for what it was testing: did `checkpoint.ts`/`graph.ts`
 * accidentally introduce an in-process singleton). A4b adds a real
 * business-orchestration layer above the graph (`runner.ts`/
 * `audit-store.ts`) whose whole reason to exist is "find a run's
 * `langgraph_thread_id` from nothing but a `runId`" — same-process
 * simulation can't rule out that layer secretly depending on something
 * still alive in this process's memory (a module-level cache, a captured
 * closure). Only two **real, independent `node` processes** — different
 * pids, the only channel between them the on-disk SQLite file — settle
 * that.
 *
 * `fixtures/cross-process-start.mjs` ("process A") starts a run and pauses
 * at G1. `fixtures/cross-process-resume.mjs` ("process B") is spawned with
 * *only* `dbPath`+`runId` (never `threadId`, never any `stepCounters`) and
 * drives the run to completion. Both import from `dist/`, not `src/` — see
 * `cross-process-start.mjs`'s header for why (plain Node has no `.js`
 * -import-resolves-to-`.ts` remapping; that's TypeScript's own
 * moduleResolution, which only runs at `tsc` compile time). This file's
 * `beforeAll` runs `pnpm build` so `dist/` reflects this increment's
 * `src/loop/*.ts` before the fixtures import it — real subprocess
 * infrastructure, not a substitute for the graph nodes'
 * FakeAdapter-controlled boundary (A4a/A4b's established "real but
 * controlled" line: no real network, no real `claude`/`codex` CLI).
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const START_FIXTURE = path.join(HERE, "fixtures", "cross-process-start.mjs");
const RESUME_FIXTURE = path.join(HERE, "fixtures", "cross-process-resume.mjs");

let tmpDir = "";

beforeAll(() => {
  // Ensure dist/ reflects this increment's src/loop/*.ts before either
  // fixture script (which import from dist/, not src/) runs.
  execSync("pnpm build", { cwd: REPO_ROOT, stdio: "pipe" });
}, 60_000);

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

interface WorkflowRunRow {
  id: number;
  status: string;
  current_state: string;
  langgraph_thread_id: string;
  reject_count: number;
}

function readRun(dbPath: string, runId: number): WorkflowRunRow | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as WorkflowRunRow | undefined;
  } finally {
    db.close();
  }
}

interface ApprovalRow {
  gate_type: string;
  decision: string;
  decided_by: string;
}

function readApprovals(dbPath: string, runId: number): ApprovalRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT gate_type, decision, decided_by FROM approvals WHERE run_id = ? ORDER BY id").all(runId) as ApprovalRow[];
  } finally {
    db.close();
  }
}

describe("cross-process checkpoint resume — two real, independent node processes, pids differ, only the on-disk SQLite file connects them", () => {
  it("process A starts+pauses at G1 and exits; process B, given only dbPath+runId, resumes to completion", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-cross-process-"));
    const dbPath = path.join(tmpDir, "cross-process.sqlite");

    // ---- Process A: real, independent `node` invocation. ----
    const procA = spawnSync(process.execPath, [START_FIXTURE, dbPath], { encoding: "utf-8" });
    expect(procA.status, `process A stderr:\n${procA.stderr}`).toBe(0);
    const procAPid = procA.pid;
    const { runId, interruptGate } = JSON.parse(procA.stdout.trim()) as { runId: number; interruptGate: string | null };
    expect(interruptGate).toBe("G1_SEND_TO_TESTER");
    expect(Number.isInteger(runId)).toBe(true);

    // Real disk file, not :memory: — process A's own process has already exited by the time this line runs.
    expect(fs.existsSync(dbPath)).toBe(true);
    const midRun = readRun(dbPath, runId);
    expect(midRun).toMatchObject({ status: "running", current_state: "g1" });

    // ---- Process B: a SECOND, independent `node` invocation — given only dbPath+runId. ----
    const procB = spawnSync(process.execPath, [RESUME_FIXTURE, dbPath, String(runId)], { encoding: "utf-8" });
    expect(procB.status, `process B stderr:\n${procB.stderr}`).toBe(0);
    const procBPid = procB.pid;
    const { done } = JSON.parse(procB.stdout.trim()) as { done: boolean };
    expect(done).toBe(true);

    // Different pids — genuinely two separate OS processes, not the same one reused.
    expect(procBPid).not.toBe(procAPid);

    // ---- Final on-disk state, read via a THIRD, independent connection (this test's own). ----
    const finalRun = readRun(dbPath, runId);
    expect(finalRun).toMatchObject({ status: "completed", current_state: "apply" });

    const approvals = readApprovals(dbPath, runId);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({ gate_type: "G1_SEND_TO_TESTER", decision: "approved" });
    expect(approvals[1]).toMatchObject({ gate_type: "G3_FINAL_MERGE", decision: "approved", decided_by: "process-b-operator" });
  });
});
