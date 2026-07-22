#!/usr/bin/env node
// B4 — 驱动脚本：串联 B0（醒来）→ B1（翻译）→ 真实 aeloop 执行（库调模式）
//        → B2（三态门折回）→ 再醒来，打印两行 PASS/FAIL 对应 DESIGN §10 的两条硬验收标准。
//
// 设计权威：docs/conductor-brain-layer/DESIGN.md §10 + PRD §0.2/§2/§3(B4)/§4(AC1/AC2)。
//
// 调用模式（PRD §0.2/§5 已定：库调模式，不走 conductor-work.mjs 子进程，因为那条路径今天
// 必然停在 G1、没有 resume 命令）：
//   assembleProfileDeps() 开 subscription profile 的真实 CliDeps
//   ConductorWorkApp.planRun() 拿 RunPlan（brain 硬约束 "company"，见 PRD §0.1）
//   startRun() 驱动到第一个中断（恒为 G1，`runner.ts` 头注释原话）
//   resumeRun() 在 G1/G2 自动放行（decision:"approved"），停在 G3/Escalation 前 ——
//     这两个"恒人工"，driver 不擅自批（和 runCandidate() 自己的 "candidate-only; git writes
//     disabled" posture 一致）
//   ConductorWorkApp.projectEvents() 把捕获的事件投影成只读 EvidenceBundle
//   applyThreeStateGate()（B2）折回 identity db
//   全新第三个 MemoryStore 实例 wake()（B0）一次，验证 AC1
//
// 跑法：pnpm run build && node docs/conductor-brain-layer/spike/run-spike.mjs ["自然语言意图"]
// 前置：本机已认证的 subscription profile（claude/codex CLI 在 PATH 且已登录）——这是 PRD §5
// 待决策项"deepseek/seed 真实凭证来源"三选一里的选③（本机 subscription 先证明机制，模型替换
// 留待"公司电脑"用真实 apikey/deepseek/seed profile 补跑，不是这次 spike 的范围，见 PRD 头部）。
//
// **次要风险如实标注（PRD §6）**：`decidedBy` 字符串会写进 identity db 之外的
// `profiles/subscription/workflow.db` 的 `approvals.decided_by`/audit 记录 —— 这是真实的
// audit 痕迹，跑完这条 run 是 workflow.db 里的永久记录。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { assembleProfileDeps } from "../../../dist/cli/assemble.js";
import {
  ConductorWorkApp,
  companyBrainDirectory,
  WorkflowRegistry,
  coderTesterWorkflow,
  renderTaskContract,
  startRun,
  resumeRun,
  LoopEventEmitter,
} from "../../../dist/index.js";

import { openIdentityStore, wake } from "./lib/wake.mjs";
import { translateIntent } from "./lib/translator.mjs";
import { applyThreeStateGate } from "./lib/three-state-gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SPIKE_DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(SPIKE_DATA_DIR, { recursive: true });
const IDENTITY_DB_PATH = path.join(SPIKE_DATA_DIR, "identity.db");

const DEFAULT_INTENT =
  "Read docs/conductor-brain-layer/spike/README.md if it exists, and docs/conductor-brain-layer/spike/lib/wake.mjs " +
  "to confirm it exports openIdentityStore and wake. This is a read-only verification task for the conductor-brain " +
  "vertical-slice spike (aeloop issue #80) — respond with no_change if nothing needs to be modified.";

const AUTO_APPROVE_GATES = new Set(["G1_SEND_TO_TESTER", "G2_SEND_TO_FIX"]);

function line(msg) {
  console.log(msg);
}

async function main() {
  const rawIntent = process.argv[2] ?? DEFAULT_INTENT;

  line("=== brain-spike run-spike.mjs (aeloop issue #80) ===");
  line(`repoRoot: ${REPO_ROOT}`);
  line(`identityDbPath: ${IDENTITY_DB_PATH}`);
  line(`rawIntent: ${rawIntent}`);

  // ---- 步骤1: 醒来（第一次） ----
  const identityStore1 = openIdentityStore(IDENTITY_DB_PATH);
  const wake1 = wake(identityStore1);
  line(`\n[步骤1 醒来] ${wake1.openingSummary}`);
  identityStore1.close(); // 显式关闭 —— 后面每次 wake 都是全新实例，不是复用同一个 JS 对象

  // ---- 步骤2: 翻译意图 → TaskContract ----
  const contract = translateIntent(rawIntent);
  line(`\n[步骤2 翻译] contractId=${contract.contractId} brain=${contract.brain} riskLevel=${contract.riskLevel}`);

  const contractPath = path.join(SPIKE_DATA_DIR, `${contract.contractId}.json`);
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));

  // ---- 步骤3: aeloop 执行（库调模式：assembleProfileDeps + startRun/resumeRun） ----
  const workflows = new WorkflowRegistry();
  workflows.register(coderTesterWorkflow);
  const app = new ConductorWorkApp({ brainDirectory: companyBrainDirectory(REPO_ROOT), workflows });

  const plan = app.planRun(contractPath);
  line(`\n[步骤3 aeloop] workflow=${plan.workflow.id}@${plan.workflow.version}`);

  const deps = assembleProfileDeps("subscription", process.env, undefined);
  const capturedEvents = [];
  const emitter = new LoopEventEmitter();
  emitter.on((event) => capturedEvents.push(event));

  const decidedBy = `brain-spike-driver (auto, not a human decision; operator=${os.userInfo().username})`;

  let handle;
  let runError = null;
  try {
    const task = renderTaskContract(plan.contract.objective, plan.contract);
    const injectedContext = deps.injector.inject(plan.contract.objective);

    handle = await startRun(
      { ...deps, events: emitter },
      {
        task,
        profile: deps.profileConfig.profile,
        workflowDefId: plan.workflow.id,
        injectedContext,
        rejectThreshold: 2,
      },
    );
    line(`[步骤3] startRun -> runId=${handle.runId} interrupt=${handle.interrupt?.gate ?? "(none)"} done=${handle.done}`);

    while (handle.interrupt && AUTO_APPROVE_GATES.has(handle.interrupt.gate) && !handle.done) {
      line(`[步骤3] resumeRun 自动放行 gate=${handle.interrupt.gate}（decidedBy="${decidedBy}"）`);
      handle = await resumeRun(
        { ...deps, events: emitter },
        handle.runId,
        handle.threadId,
        { decision: "approved" },
        decidedBy,
        handle.stepCounters,
      );
      line(`[步骤3] resumeRun -> interrupt=${handle.interrupt?.gate ?? "(none)"} done=${handle.done}`);
    }

    if (handle.interrupt) {
      line(`[步骤3] 停在人工门前：gate=${handle.interrupt.gate}（G3/Escalation 恒人工，driver 不擅自批，这是设计意图，不是 bug）`);
    } else if (handle.done) {
      line(`[步骤3] run 已到终态（apply/cancel/no_change）`);
    }
  } catch (err) {
    runError = err;
    line(`[步骤3] 真实 run 抛出异常：${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    line(`[步骤3] 如实继续：即便这一步失败，步骤4/5 仍然基于 capturedEvents（可能为空）验证三态门+醒来机制本身的正确性。`);
  } finally {
    deps.audit.close();
    deps.memoryStore.close();
    if (deps.checkpointer && typeof deps.checkpointer.db?.close === "function") {
      deps.checkpointer.db.close();
    }
  }

  // ---- 步骤4: EvidenceBundle 经三态门折回 identity db ----
  const evidenceBundle = app.projectEvents(capturedEvents, contractPath);
  line(
    `\n[步骤4 三态门] evidence[]=${evidenceBundle.evidence.length} 条, claims[]=${evidenceBundle.claims.length} 条, ` +
      `status=${evidenceBundle.status}, runId=${evidenceBundle.runId ?? "?"}, eventTypes=${JSON.stringify(evidenceBundle.eventTypes)}`,
  );

  const identityStore2 = openIdentityStore(IDENTITY_DB_PATH); // 全新第二个实例
  const gateResults = applyThreeStateGate(evidenceBundle, identityStore2, { actor: decidedBy });
  for (const r of gateResults) {
    line(`  evidenceId=${r.evidenceId ?? "(mechanical-status)"} source=${r.source} confirmed=${r.confirmed} memoryId=${r.memoryId}`);
  }
  identityStore2.close();

  // ---- 步骤5: 再醒来，验证延续（全新第三个实例，不是复用上面的 JS 对象） ----
  const identityStore3 = openIdentityStore(IDENTITY_DB_PATH);
  const wake2 = wake(identityStore3, contract.contractId);
  line(`\n[步骤5 再醒来] ${wake2.openingSummary}`);

  // ---- AC1: 第5步真观察到延续 ----
  const traceableMemory = wake2.continuedThreads.find(
    (m) => m.content.includes(contract.contractId) || m.title.includes(contract.contractId),
  );
  const ac1 = Boolean(traceableMemory);
  line(`\nAC1 (再醒来观察到延续): ${ac1 ? "PASS" : "FAIL"}`);
  if (ac1) {
    line(`  溯源到 memory id=${traceableMemory.id} title="${traceableMemory.title}"`);
  } else {
    line(`  诚实说明：第二次 wake() 的 continuedThreads 里没有一条能字符串溯源到 contractId=${contract.contractId}。`);
  }

  // ---- AC2: 全程未绕过三态门 ----
  const modelReportedEvidenceIds = new Set(
    evidenceBundle.evidence.filter((e) => e.source === "model-reported").map((e) => e.id),
  );
  const allMemories = identityStore3.listMemories();
  const ac2Violations = [];
  for (const memory of allMemories) {
    if (memory.confidenceState !== "confirmed") continue;
    for (const evId of modelReportedEvidenceIds) {
      if (memory.title.includes(`evidence:${evId}`)) {
        ac2Violations.push({ memoryId: memory.id, evidenceId: evId });
      }
    }
  }
  const ac2 = ac2Violations.length === 0;
  line(`AC2 (全程未绕过三态门): ${ac2 ? "PASS" : "FAIL"}`);
  if (!ac2) {
    line(`  违规: ${JSON.stringify(ac2Violations)}`);
  } else if (modelReportedEvidenceIds.size === 0) {
    line(
      `  诚实说明：这次真实 run 的 evidence[] 里没有出现 model-reported 条目（PRD §0.3 已知 gap：生产路径` +
        ` EvidenceBundle.evidence[] 常年是 []，只有触发 no_change 分支才会有一条 model-reported 证据）。` +
        ` 这里的 PASS 只是"没有违规样本"，不是"这次真实 run 抓到了一次真实拦截"——B2 单元测试` +
        ` （test-three-state-gate.mjs）用合成 EvidenceBundle 独立证明了这条规则本身成立，那才是这条规则的主证据。`,
    );
  } else {
    line(`  ${modelReportedEvidenceIds.size} 条 model-reported 证据全部正确停留在 unconfirmed，没有一条被三态门错误 confirm。`);
  }

  identityStore3.close();

  line(`\n=== 结果 ===`);
  line(`AC1: ${ac1 ? "PASS" : "FAIL"}`);
  line(`AC2: ${ac2 ? "PASS" : "FAIL"}`);
  if (runError) {
    line(
      `注：步骤3 真实 aeloop run 抛出了异常（${runError instanceof Error ? runError.name : "unknown"}）—— AC1/AC2 的判定` +
        ` 逻辑本身仍然正确执行，但这意味着"闭环"演示本身不完整，如实标注，不假装绿。`,
    );
  }

  if (!ac1 || !ac2 || runError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("run-spike.mjs 未捕获异常：");
  console.error(err);
  process.exitCode = 1;
});
