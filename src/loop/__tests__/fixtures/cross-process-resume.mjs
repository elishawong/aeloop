#!/usr/bin/env node
// cross-process-resume.mjs — "Process B" of the A4b checkpoint
// production-hardening test (docs/feature/a4b-loop/PRD.md §5/§9.2 Decision 4).
//
// A second, fully independent `node` invocation — different pid, no
// process-tree relationship to `cross-process-start.mjs` beyond this test
// spawning both. Given only `dbPath` + `runId` (via argv), it:
//   1. `audit.getRunById(runId)` — the on-disk lookup that recovers
//      `langgraphThreadId` (and `rejectThreshold`) with zero memory shared
//      with process A.
//   2. Constructs a brand-new `checkpointer` pointed at the same file.
//   3. Drives `resumeRun()` to completion with G1/G3 "approved" — the
//      happy path process A left paused at G1.
// See cross-process-start.mjs's header for why this imports from `dist/`.
import { AdapterRegistry } from "../../../../dist/harness/adapter-registry.js";
import { ProviderRouter } from "../../../../dist/harness/provider-router.js";
import { PromptComposer } from "../../../../dist/prompt/composer.js";
import { resolveProfileDir } from "../../../../dist/profile/loader.js";
import { AuditStore } from "../../../../dist/loop/audit-store.js";
import { createSqliteCheckpointer } from "../../../../dist/loop/checkpoint.js";
import { resumeRun } from "../../../../dist/loop/runner.js";
import path from "node:path";

const NOW = () => new Date().toISOString();

// Same fake adapters as process A — a real cross-process resume doesn't
// require the *same instances* (impossible, separate process), just
// adapters that behave the same way (a real config.yaml + real cli-bridge
// adapters would work identically here; FakeAdapter is used for the same
// "real but controlled, no real subprocess/network" reason every other
// A4a/A4b test uses one).
class FakeCoderAdapter {
  id = "fake-coder";
  kind = "direct-api";
  async checkAvailability() {
    return { available: true, checkedAt: NOW() };
  }
  async invoke() {
    const payload = {
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [{ claimText: "the change compiles", confidence: "verified" }],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

class FakeTesterAdapter {
  id = "fake-tester";
  kind = "direct-api";
  async checkAvailability() {
    return { available: true, checkedAt: NOW() };
  }
  async invoke() {
    const payload = {
      verdict: "pass",
      issues: [],
      claims: [{ claimText: "ran the tests", confidence: "verified", verifiedBy: "tool_execution" }],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

const [, , dbPath, runIdRaw] = process.argv;
const runId = Number(runIdRaw);

if (!dbPath || !Number.isInteger(runId)) {
  console.error("usage: cross-process-resume.mjs <dbPath> <runId>");
  process.exitCode = 1;
} else {
  const registry = new AdapterRegistry();
  registry.register(new FakeCoderAdapter());
  registry.register(new FakeTesterAdapter());
  const router = new ProviderRouter({ coder: { provider: "fake-coder" }, tester: { provider: "fake-tester" } }, registry);
  const composer = new PromptComposer(path.join(resolveProfileDir("subscription"), "personas"));
  const audit = new AuditStore(dbPath);

  // The lookup this whole test exists to prove: nothing but `runId` (read
  // from a brand-new connection to the on-disk file) recovers the thread.
  const run = audit.getRunById(runId);
  if (!run) {
    console.error(`cross-process-resume.mjs: no workflow_runs row for id ${runId}`);
    process.exitCode = 1;
  } else {
    const checkpointer = createSqliteCheckpointer(dbPath);
    const deps = { router, composer, audit, checkpointer };

    let handle = await resumeRun(deps, runId, run.langgraphThreadId, { decision: "approved", reasoningText: "resumed from process B" }, "process-b-operator");
    // Drive to completion — this scenario only needs G1 then G3 approvals (tester verdict is always "pass").
    while (!handle.done) {
      handle = await resumeRun(deps, runId, run.langgraphThreadId, { decision: "approved" }, "process-b-operator", handle.stepCounters);
    }

    audit.close();
    process.stdout.write(JSON.stringify({ done: handle.done }) + "\n");
    process.exitCode = 0;
  }
}
