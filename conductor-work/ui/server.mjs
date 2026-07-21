#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.CONDUCTOR_WORK_PORT ?? 4173);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

/**
 * A small, type-legal `LoopEvent[]` fixture (src/loop/events.ts) — hardcoded
 * here on purpose (issue #29 follow-up). This is *not* a live conductor run;
 * it is fed once, at process start, to the real `EvidenceEventProjector`
 * (src/evidence/bundle.ts) so the JSON this endpoint serves is a genuine
 * projector *output*, not a hand-authored `EvidenceBundle` shape pretending
 * to be one. See README.md for the fixture-vs-real-event-stream distinction.
 */
const FIXTURE_RUN_ID = 1042;
const FIXTURE_THREAD_ID = "thread-demo-1042";
const FIXTURE_TASK = "Implement the approved change";
const FIXTURE_CONTRACT_ID = "company-demo-001";
const FIXTURE_WORKFLOW_DEF_ID = "coder-tester-loop";

const FIXTURE_EVENTS = [
  { type: "run_started", runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, ts: "2026-07-21T10:02:11.000Z", task: FIXTURE_TASK, profile: FIXTURE_WORKFLOW_DEF_ID, workflowDefId: FIXTURE_WORKFLOW_DEF_ID, rejectThreshold: 2 },
  { type: "node_started", runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, ts: "2026-07-21T10:02:11.500Z", node: "draft", stepRef: "draft-1" },
  { type: "node_completed", runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, ts: "2026-07-21T10:02:38.000Z", node: "draft", stepRef: "draft-1" },
  { type: "agent_completed", runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, ts: "2026-07-21T10:02:38.000Z", node: "draft", actor: "coder", claimCount: 2 },
  {
    type: "gate_requested",
    runId: FIXTURE_RUN_ID,
    threadId: FIXTURE_THREAD_ID,
    ts: "2026-07-21T10:02:39.000Z",
    gate: "G1_SEND_TO_TESTER",
    payload: { gate: "G1_SEND_TO_TESTER", question: "Send candidate change to independent Tester?", diffRef: "- old behavior\n+ approved behavior" },
  },
];

/** Deterministic usage fixture recorded through the real `TokenBudgetLedger`/`EvidenceBundleBuilder.recordUsage`, not hand-computed percentages. */
const FIXTURE_USAGE = { inputTokens: 3420, outputTokens: 1250, cacheReadTokens: 2085, retryTokens: 640, estimated: false, model: "demo-fixture", costUsd: 0.0142 };
const FIXTURE_BUDGET = { inputTokens: 20000, outputTokens: 20000, retryTokens: 2000 };

function timeOf(ts) {
  return ts.slice(11, 19);
}

function pathToFileUrl(p) {
  return new URL(`file://${p}`);
}

/**
 * Attempt to build the real `EvidenceBundle` via the compiled
 * `src/evidence/bundle.ts` output (`dist/evidence/bundle.js`, produced by
 * `pnpm run build`). Rejects (caught by the caller) if the build artifact
 * isn't present — the caller falls back to a clearly-labelled static
 * snapshot rather than crashing the server. See README.md for why this
 * indirection exists (no ts-node/on-the-fly TS execution in this
 * zero-dependency demo server).
 */
async function buildRealBundle() {
  const distEvidencePath = path.join(root, "..", "..", "dist", "evidence", "bundle.js");
  const { EvidenceBundleBuilder, EvidenceEventProjector, TokenBudgetLedger } = await import(pathToFileUrl(distEvidencePath));

  const builder = new EvidenceBundleBuilder({ runId: FIXTURE_RUN_ID, contractId: FIXTURE_CONTRACT_ID, requirementIds: ["REQ-001", "REQ-002", "REQ-003"] });
  const projector = new EvidenceEventProjector(builder);
  for (const event of FIXTURE_EVENTS) projector.accept(event);

  builder.addEvidence({ id: "ev-test-behavior", kind: "test", title: "test:behavior suite", ref: "test/behavior.spec.ts", passed: true });
  builder.addEvidence({ id: "ev-policy-path-scope", kind: "source", title: "policy:path-scope check", ref: "policy/path-scope.json", passed: true });
  builder.addEvidence({ id: "ev-changed-files", kind: "artifact", title: "Changed files", ref: "git diff --stat (4 files)" });
  builder.addEvidence({ id: "ev-tool-exec", kind: "tool", title: "Tool executions", ref: "7 commands, exit code captured" });

  // `markRequirement`'s `note` runs *before* `addClaim` so the descriptive
  // text survives — `addClaim` spreads the existing requirement entry and
  // only overwrites `status`/`evidenceRefs`, preserving whatever `note` was
  // already set (src/evidence/bundle.ts `EvidenceBundleBuilder.addClaim`).
  builder.markRequirement("REQ-001", "unverified", "Approved behavior is implemented");
  builder.markRequirement("REQ-002", "unverified", "No unrelated public API changes");
  builder.markRequirement("REQ-003", "unverified", "Performance target is proven");
  builder.addClaim({ id: "claim-1", text: "Approved behavior is implemented", status: "supported", requirementIds: ["REQ-001"], evidenceRefs: ["ev-test-behavior"] });
  builder.addClaim({ id: "claim-2", text: "No unrelated public API changes", status: "supported", requirementIds: ["REQ-002"], evidenceRefs: ["ev-policy-path-scope"] });

  builder.recordUsage(FIXTURE_USAGE);

  const ledger = new TokenBudgetLedger(FIXTURE_BUDGET);
  ledger.record({ inputTokens: FIXTURE_USAGE.inputTokens, outputTokens: FIXTURE_USAGE.outputTokens, retryTokens: FIXTURE_USAGE.retryTokens });

  return { bundle: projector.snapshot(), budgetSnapshot: ledger.snapshot() };
}

function timelineFrom(bundle) {
  const inputTokens = bundle.usage.inputTokens.toLocaleString("en-US");
  return [
    { title: "Run started", detail: `Company Brain froze TaskContract ${bundle.contractId}`, status: "done", time: timeOf(FIXTURE_EVENTS[0].ts) },
    { title: "Coder completed", detail: `2 claims · 1 artifact · ${inputTokens} input tokens`, status: "done", time: timeOf(FIXTURE_EVENTS[3].ts) },
    { title: "G1 waiting for approval", detail: "Send candidate change to independent Tester", status: "waiting", time: timeOf(FIXTURE_EVENTS[4].ts) },
    // Not a real emitted event yet — a narrative "next step" derived from the
    // coder-tester-loop workflow definition (g1 -> review), shown pending
    // because no `node_started` for "review" exists in FIXTURE_EVENTS.
    { title: "Tester pending", detail: "Will receive diff + claims + evidence only", status: "pending", time: "—" },
  ];
}

function requirementsFrom(bundle) {
  return bundle.requirements.map((requirement) => [
    requirement.requirementId,
    requirement.note ?? "Approved behavior is implemented",
    requirement.evidenceRefs.length > 0 ? requirement.evidenceRefs.join(", ") : "No execution evidence",
    requirement.status === "verified" ? "VERIFIED" : "NOT_PROVEN",
  ]);
}

function evidenceFrom(bundle) {
  const byId = Object.fromEntries(bundle.evidence.map((item) => [item.id, item]));
  return [
    ["Changed files", "4", byId["ev-changed-files"]?.ref ?? "within allowed paths"],
    ["Tool executions", "7", byId["ev-tool-exec"]?.ref ?? "exit code captured"],
    ["Token saved", `−${tokenSavedPct(bundle.usage)}%`, "context compression"],
  ];
}

function tokenSavedPct(usage) {
  const denom = usage.cacheReadTokens + usage.inputTokens + usage.outputTokens;
  if (denom <= 0) return 0;
  return Math.round((usage.cacheReadTokens / denom) * 100);
}

function cacheHitPct(usage) {
  const denom = usage.cacheReadTokens + usage.inputTokens;
  if (denom <= 0) return 0;
  return Math.round((usage.cacheReadTokens / denom) * 100);
}

/** Static fallback used only when `dist/evidence/bundle.js` hasn't been built (run `pnpm run build` first). Clearly not projector output — see README.md. */
function staticFallbackState() {
  return {
    source: "static-fallback",
    run: { runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, contractId: FIXTURE_CONTRACT_ID, status: "running", displayStatus: "WAITING FOR G1", task: FIXTURE_TASK, workflowDefId: FIXTURE_WORKFLOW_DEF_ID },
    timeline: [
      { title: "Run started", detail: `Company Brain froze TaskContract ${FIXTURE_CONTRACT_ID}`, status: "done", time: timeOf(FIXTURE_EVENTS[0].ts) },
      { title: "Coder completed", detail: "2 claims · 1 artifact · 3,420 input tokens", status: "done", time: timeOf(FIXTURE_EVENTS[3].ts) },
      { title: "G1 waiting for approval", detail: "Send candidate change to independent Tester", status: "waiting", time: timeOf(FIXTURE_EVENTS[4].ts) },
      { title: "Tester pending", detail: "Will receive diff + claims + evidence only", status: "pending", time: "—" },
    ],
    requirements: [
      ["REQ-001", "Approved behavior is implemented", "test:behavior", "VERIFIED"],
      ["REQ-002", "No unrelated public API changes", "policy:path-scope", "VERIFIED"],
      ["REQ-003", "Performance target is proven", "No execution evidence", "NOT_PROVEN"],
    ],
    evidence: [
      ["Changed files", "4", "within allowed paths"],
      ["Tool executions", "7", "exit code captured"],
      ["Token saved", "−34%", "context compression"],
    ],
    usage: { inputTokens: 3420, outputTokens: 4400, cacheReadTokens: 0, retryTokens: 0, estimated: true, budgetInputTokens: 20000, budgetOutputTokens: 20000, cacheHitPct: 61, totalTokens: 7820, totalBudget: 20000 },
  };
}

let cachedStatePromise;

async function getState() {
  if (!cachedStatePromise) {
    cachedStatePromise = (async () => {
      try {
        const { bundle, budgetSnapshot } = await buildRealBundle();
        return {
          source: "projector",
          run: {
            runId: bundle.runId,
            threadId: FIXTURE_THREAD_ID,
            contractId: bundle.contractId,
            status: bundle.status,
            displayStatus: "WAITING FOR G1",
            task: FIXTURE_TASK,
            workflowDefId: FIXTURE_WORKFLOW_DEF_ID,
          },
          timeline: timelineFrom(bundle),
          requirements: requirementsFrom(bundle),
          evidence: evidenceFrom(bundle),
          usage: {
            ...bundle.usage,
            budgetInputTokens: budgetSnapshot.budget.inputTokens,
            budgetOutputTokens: budgetSnapshot.budget.outputTokens,
            cacheHitPct: cacheHitPct(bundle.usage),
            totalTokens: bundle.usage.inputTokens + bundle.usage.outputTokens,
            totalBudget: budgetSnapshot.budget.inputTokens + budgetSnapshot.budget.outputTokens,
          },
        };
      } catch (error) {
        console.warn(`[conductor-work-ui] falling back to static demo state — real projector unavailable (${error.code ?? error.message}).`);
        console.warn(`[conductor-work-ui] run "pnpm run build" at the repo root to generate dist/evidence/bundle.js and re-run this server for real projector output.`);
        return staticFallbackState();
      }
    })();
  }
  return cachedStatePromise;
}

http
  .createServer(async (request, response) => {
    if (request.url === "/api/state") {
      try {
        const state = await getState();
        const body = JSON.stringify(state);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(body);
      } catch (error) {
        // /api/state must never take the whole server down — the client
        // falls back to its own local static snapshot on a non-200/parse
        // failure.
        console.error("[conductor-work-ui] /api/state failed:", error);
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "state unavailable" }));
      }
      return;
    }

    const requested = request.url === "/" ? "/index.html" : request.url ?? "/index.html";
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(response);
  })
  .listen(port, "127.0.0.1", () => console.log(`Conductor Work UI: http://127.0.0.1:${port}`));
