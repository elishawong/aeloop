#!/usr/bin/env node
// cross-process-start.mjs — "Process A" of the A4b checkpoint
// production-hardening test (docs/feature/a4b-loop/PRD.md §5/§9.2 决策4).
//
// A real, independent `node` invocation (not a same-process two-phase
// simulation like A4a's `checkpoint.test.ts`) — this script starts a real
// run via `runner.startRun()`, lets it pause at G1's `interrupt()`, writes
// `{runId, dbPath}` to stdout as JSON, then exits. Nothing from this
// process (no live object, no closure) is available to the second process
// (`cross-process-resume.mjs`) — the only channel between them is the
// on-disk SQLite file at `dbPath` (checkpoint + audit tables, sharing the
// file per PRD §9.2 决策3) and this script's stdout.
//
// Imports from **`dist/`, not `src/`** — plain Node ESM has no built-in
// `.js`-import-resolves-to-sibling-`.ts`-file remapping (verified: running
// `node` directly against this repo's `.ts` sources with their `.js`
// import specifiers throws `ERR_MODULE_NOT_FOUND`; TypeScript's own
// moduleResolution does that remapping at *compile* time, which is exactly
// what `pnpm build` already produces). Using the real compiled output here
// is also a more faithful "production" cross-process proof than reinventing
// module resolution just for this test — aeloop genuinely ships as a
// compiled CLI (CLAUDE.md §2: "部署:CLI 工具...非 server"). The test file
// that spawns this script runs `pnpm build` first so `dist/` is current.
import { AdapterRegistry } from "../../../../dist/harness/adapter-registry.js";
import { ProviderRouter } from "../../../../dist/harness/provider-router.js";
import { PromptComposer } from "../../../../dist/prompt/composer.js";
import { resolveProfileDir } from "../../../../dist/profile/loader.js";
import { AuditStore } from "../../../../dist/loop/audit-store.js";
import { createSqliteCheckpointer } from "../../../../dist/loop/checkpoint.js";
import { startRun } from "../../../../dist/loop/runner.js";
import path from "node:path";

const NOW = () => new Date().toISOString();

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

const [, , dbPath] = process.argv;
if (!dbPath) {
  console.error("usage: cross-process-start.mjs <dbPath>");
  process.exitCode = 1;
} else {
  const registry = new AdapterRegistry();
  registry.register(new FakeCoderAdapter());
  registry.register(new FakeTesterAdapter());
  const router = new ProviderRouter({ coder: { provider: "fake-coder" }, tester: { provider: "fake-tester" } }, registry);
  const composer = new PromptComposer(path.join(resolveProfileDir("subscription"), "personas"));
  const audit = new AuditStore(dbPath);
  const checkpointer = createSqliteCheckpointer(dbPath);

  const handle = await startRun(
    { router, composer, audit, checkpointer },
    {
      task: "cross-process resume: add a function that reverses a string",
      profile: "subscription",
      workflowDefId: "coder-tester-loop",
      injectedContext: { memories: [] },
      rejectThreshold: 2,
    },
  );

  audit.close();

  // Process B is handed *only* this — no in-memory reference, no
  // `stepCounters` (PRD §9.2 决策4: this proves the business-layer lookup,
  // not just LangGraph's own already-proven checkpoint mechanism).
  process.stdout.write(JSON.stringify({ runId: handle.runId, interruptGate: handle.interrupt?.gate ?? null }) + "\n");
  process.exitCode = 0;
}
