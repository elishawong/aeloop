#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  { type: "run_started", runId: FIXTURE_RUN_ID, threadId: FIXTURE_THREAD_ID, ts: "2026-07-21T10:02:11.000Z", task: FIXTURE_TASK, profile: "company", workflowDefId: FIXTURE_WORKFLOW_DEF_ID, rejectThreshold: 2 },
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
  return pathToFileURL(p);
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

/**
 * 多 workflow 总览看板（issue #2 batch 1，docs/conductor-mvp/DESIGN.md §3）。
 *
 * 读哪个 profile 的 `workflow.db`：`CONDUCTOR_WORK_PROFILE` env（本页专属）优先，其次
 * `AI_AGENT_PROFILE`（`src/profile/loader.ts` 既有的引擎级 profile 选择 env，同一约定，不新造
 * 第二套命名），都没有时缺省 `"subscription"`——和 `run-spike.mjs`/`dispatch-brain-task.mjs` 的
 * 既有默认一致。
 *
 * **Zorro R1 blocker B3 修复**：profile 目录解析**复用引擎自己的 `loadProfile()`**
 * （`src/profile/loader.ts`，`assembleProfileDeps()` 内部调的同一个函数），不再手写
 * `path.join(root, "..", "..", "profiles", profileName)`——旧写法忽略了 `AELOOP_PROFILES_ROOT`
 * （外置 profile 场景下引擎实际读写的是另一个目录，看板硬编码仓库内 `profiles/` 会显示"无数据"，
 * 不是真的没数据，是找错了目录）。`loadProfile()` 内部已有的 `isSinglePathSegment()`/
 * `isContainedRealpath()` 检查同时把 `CONDUCTOR_WORK_PROFILE` 的路径穿越校验也一并解决了——不
 * 需要另写一份检查。
 *
 * **只读**：只调用 `AuditStore.listRunsByStatus()`/`listStepRefsByRun()`，从不调用任何
 * `insert*`/`update*` 方法——不新增任何写路径（DESIGN §3.3 candidate-only 关系说明）。
 *
 * **Zorro R1 blocker B2 修复**：`AuditStore` 默认构造器是 `new Database(dbPath)`（读写）+
 * 无条件 `createSchema()`（`CREATE TABLE IF NOT EXISTS`）——对一个已存在的 `workflow.db` 而言，
 * 这仍然是一次真实的写路径请求（哪怕 DDL 本身是 no-op），推翻"看板全程只读"这个声明。改用
 * `new AuditStore(dbPath, { readonly: true })`（`src/loop/audit-store.ts` 新增的只读模式，
 * `better-sqlite3` 的 `{readonly:true, fileMustExist:true}`，跳过 `createSchema()`）——已实测
 * 确认：读操作正常、写操作真的抛 `SQLITE_READONLY`、文件 mtime 不变、对不存在的文件会抛错而不是
 * 静默建一个空库（`fileMustExist:true`）。`fs.existsSync()` 判断依然保留在前面，双重保险。
 */
async function resolveWorkflowDbPath() {
  // Zorro R2 yellow②：用 `||`（不是 `??`）把空字符串和"没设置"同等对待——`CONDUCTOR_WORK_
  // PROFILE=""`（比如 shell 里 `export CONDUCTOR_WORK_PROFILE=` 忘了赋值）在 `??` 下会被当成
  // "显式选择了一个名叫空字符串的 profile" 往下传，虽然 `loadProfile()` 自己的
  // `isSinglePathSegment("")` 会安全拒绝它（不会崩溃/不会越权，走既有降级路径），但语义上更
  // 合理的解读是"这其实等于没设置，应该退到下一优先级"——和下面 `AELOOP_PROFILES_ROOT` 已有的
  // `||` 处理方式保持一致，不留一个只有这一个变量用 `??`、行为不对称的边角。
  const profileName = process.env.CONDUCTOR_WORK_PROFILE || process.env.AI_AGENT_PROFILE || "subscription";
  const distIndexPath = path.join(root, "..", "..", "dist", "index.js");
  let loadProfile;
  try {
    ({ loadProfile } = await import(pathToFileUrl(distIndexPath)));
  } catch (error) {
    return { profileName, dbPath: null, loadError: `dist/ 未 build 或导入失败：${error.code ?? error.message}` };
  }
  // profilesRoot 解析和 assembleProfileDeps()（src/cli/assemble.ts）同一套优先级：显式传入
  // （这里没有）→ AELOOP_PROFILES_ROOT env → loadProfile() 自己的包内相对默认值（undefined 时）。
  const profilesRoot = process.env.AELOOP_PROFILES_ROOT || undefined;
  try {
    const result = loadProfile(profileName, profilesRoot);
    if (!result.ok) {
      return { profileName, dbPath: null, loadError: result.error.message };
    }
    return { profileName, dbPath: path.join(result.profileDir, "workflow.db") };
  } catch (error) {
    // InvalidProfileNameError（含路径穿越/非单段名）、ProfileConfigParseError 等——都是"这个
    // profile 解析不出来"，走降级路径，不是服务器崩溃。
    return { profileName, dbPath: null, loadError: error.message };
  }
}

/**
 * 组装看板总览的 `BoardRow[]`。`source` 字段区分真实数据（`"live"`）和降级空态
 * （`"static-fallback"`，profile 解析不出来/`workflow.db` 不存在/`dist/` 未 build 时）——同既有
 * `/api/state` 的 `source` 字段约定，不新造一套语义。
 */
async function getBoardRows() {
  const { profileName, dbPath, loadError } = await resolveWorkflowDbPath();
  if (!dbPath) {
    return { source: "static-fallback", profile: profileName, dbPath: null, rows: [], message: loadError ?? "profile 解析失败。" };
  }
  if (!fs.existsSync(dbPath)) {
    return { source: "static-fallback", profile: profileName, dbPath, rows: [], message: `未找到 ${dbPath}——还没有任何 run 用这个 profile 跑过。` };
  }
  let AuditStore;
  let toBoardRow;
  try {
    ({ AuditStore } = await import(pathToFileUrl(path.join(root, "..", "..", "dist", "index.js"))));
    ({ toBoardRow } = await import(pathToFileUrl(path.join(root, "..", "..", "dist", "conductor-work", "board.js"))));
  } catch (error) {
    console.warn(`[conductor-work-ui] /api/runs falling back — dist/ import failed (${error.code ?? error.message}). Run "pnpm run build" first.`);
    return { source: "static-fallback", profile: profileName, dbPath, rows: [], message: "dist/ 未 build，运行 pnpm run build 后重启。" };
  }

  let audit;
  try {
    audit = new AuditStore(dbPath, { readonly: true });
  } catch (error) {
    // fileMustExist:true 理论上不该在这里触发（上面已经 fs.existsSync() 判断过），但 TOCTOU
    // 窗口（判断之后、打开之前文件被删）不是不可能——同样走降级路径，不崩服务器。
    console.warn(`[conductor-work-ui] /api/runs: readonly open failed (${error.code ?? error.message}).`);
    return { source: "static-fallback", profile: profileName, dbPath, rows: [], message: `打开 ${dbPath} 失败：${error.message}` };
  }
  try {
    // 只读：listRunsByStatus()/listStepRefsByRun()，从不调用任何 insert*/update* 方法。
    const runs = [...audit.listRunsByStatus("running"), ...audit.listRunsByStatus("escalated")];
    const rows = runs.map((run) => toBoardRow(run, audit.listStepRefsByRun(run.id)));
    return { source: "live", profile: profileName, dbPath, rows };
  } finally {
    audit.close();
  }
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

    if (request.url === "/api/runs") {
      // issue #2 batch 1 — 总览看板端点。**不缓存**（不同于 /api/state 的 cachedStatePromise）：
      // 前端每 2-3 秒轮询一次，每次都要反映 workflow.db 的最新内容，缓存会让看板卡在第一次快照。
      try {
        const board = await getBoardRows();
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(board));
      } catch (error) {
        // 同 /api/state 的既有惯例：/api/runs 失败绝不能拖垮整个 server 进程，前端拿到非 200
        // 时保持上一次成功渲染的内容不变（app.js 的轮询循环自己处理这一层降级）。
        console.error("[conductor-work-ui] /api/runs failed:", error);
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ source: "error", rows: [], error: "runs unavailable" }));
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
