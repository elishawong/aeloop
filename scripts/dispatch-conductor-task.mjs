#!/usr/bin/env node
/**
 * dispatch-conductor-task.mjs — issue #2 batch 1:"聊天→自动派发"这条 MVP 头号亮点的会话触发
 * 入口。用户在 Claude Code 会话里对醒来的调度员说一句自然语言,调度员(模型自己,见
 * docs/conductor-brain-layer/BRAIN.md 新增小节)识别到"这是一个工作请求"后,调这个脚本。
 *
 * 设计权威:docs/conductor-mvp/DESIGN.md §4.2(派发胶水层职责)+ §7.2(谁识别工作请求)+
 * §7.3(共享核心方案对比,方案 B)。
 *
 * 和 `dispatch-brain-task.mjs`(issue #93,多项目场景)的关系:两者共用同一个
 * `scripts/lib/conductor-dispatch-core.mjs`(`runConductorDispatch()`)。本文件**不要求项目
 * 注册**——#2 Conductor 层概念上不要求"这个意图必须关联一个已注册项目",batch 1 的 demo 就是
 * aeloop 自己仓库内的一次自派发,不针对任何目标项目(Level 1 沙箱约束,§1.3 第 5 点)。
 *
 * cwd 保护:和 `dispatch-brain-task.mjs` 同样的理由(工具执行 cwd 不能继承调用方的 cwd,必须钉死
 * 在 REPO_ROOT)——但**不需要那份跨调用互斥锁**:`dispatch-brain-task.mjs` 的锁保护的是"同一个
 * Node 进程内,`dispatchBrainTask()` 被当库函数多次 overlapping 调用"这个场景(Zorro must-fix 第
 * 2 轮);本文件是一次性 CLI 入口,每次调用是独立的 OS 进程(`node scripts/dispatch-conductor-
 * task.mjs "..."`),`process.chdir()` 的副作用不会跨进程泄漏,不存在两次调用在同一进程内交错的
 * 可能性,因此不需要复刻那把锁。
 *
 * 输出:一段 JSON(stdout),供调用方(通常是模型自己读 Bash 工具输出)解析后渲染给用户——候选摘要、
 * EvidenceBundle 概要、pendingGate(是否卡在 G3/Escalation 前)。**G3/Escalation 恒人工,本脚本
 * 不擅自批**,`pendingGate` 非空时调用方必须诚实告知用户"候选已产出、正等待这个 gate",不能假装
 * 闭环已经走完(candidate-only 既有 posture)。
 *
 * 用法:node scripts/dispatch-conductor-task.mjs "<自然语言意图>"
 * 前置:本机已认证的 subscription profile(claude/codex CLI 在 PATH 且已登录),同
 * `run-spike.mjs`/`dispatch-brain-task.mjs`/`WAKE-GREETING-RUNBOOK.md` 已有前置条件;身份库
 * dbPath 已配置(`AELOOP_BRAIN_IDENTITY_DB` / `.claude/brain.local.json`,同
 * `brain-wake-greeting.mjs` 既有解析逻辑)。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIdentityDbPath } from "../.claude/hooks/lib/db-path.mjs";
import { runConductorDispatch, REPO_ROOT } from "./lib/conductor-dispatch-core.mjs";

function emitResult(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// Zorro R1 blocker B5:"聊天→自动派发"这条头号亮点原本把 EvidenceBundle 压成
// `claimsCount`/`evidenceCount` 两个数字,模型拿到这份 JSON 后说不出候选实际改了什么、证据是
// 什么——只能报个数。下面这组函数把真实内容(经大小限制)带出来,而不是只带计数。限额是为了防止
// 一个异常大的 diff/大量 claims 把整段 stdout 撑爆(模型读 Bash 工具输出本身也有长度预算)，不是
// 为了藏东西——超限时明确标 `truncated:true` + 总数,不静默丢弃且不说。
const MAX_LIST_ITEMS = 20;
const MAX_TEXT_LEN = 500;
const MAX_DIFF_LEN = 4000;

function truncate(text, maxLen) {
  if (typeof text !== "string" || text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n…[已截断，原文共 ${text.length} 字符]`;
}

/** claims[]（EvidenceClaim，src/evidence/bundle.ts）——真实文本，不是计数。 */
function summarizeClaims(claims) {
  return {
    items: claims.slice(0, MAX_LIST_ITEMS).map((c) => ({ id: c.id, text: truncate(c.text, MAX_TEXT_LEN), status: c.status, requirementIds: c.requirementIds })),
    totalCount: claims.length,
    truncated: claims.length > MAX_LIST_ITEMS,
  };
}

/** evidence[]（EvidenceItem，src/evidence/bundle.ts）——真实 title/ref/content，不是计数。 */
function summarizeEvidence(evidence) {
  return {
    items: evidence.slice(0, MAX_LIST_ITEMS).map((e) => ({
      id: e.id,
      kind: e.kind,
      title: truncate(e.title, MAX_TEXT_LEN),
      ref: e.ref,
      passed: e.passed ?? null,
      source: e.source ?? "verified",
      content: e.content ? truncate(e.content, MAX_TEXT_LEN) : undefined,
    })),
    totalCount: evidence.length,
    truncated: evidence.length > MAX_LIST_ITEMS,
  };
}

async function main() {
  const rawIntent = process.argv.slice(2).join(" ");
  if (!rawIntent.trim()) {
    console.error('用法：node scripts/dispatch-conductor-task.mjs "<自然语言意图>"');
    process.exitCode = 2;
    return;
  }

  // 🔒 见文件头"cwd 保护"说明——一次性 CLI 调用,不需要 dispatch-brain-task.mjs 那把跨调用互斥锁。
  const callerCwd = process.cwd();
  process.chdir(REPO_ROOT);

  try {
    const dbPath = resolveIdentityDbPath();
    if (!dbPath) {
      emitResult({
        ok: false,
        error: "NO_IDENTITY_DB_PATH",
        message:
          "找不到身份库 dbPath——AELOOP_BRAIN_IDENTITY_DB / AELOOP_BRAIN_GLOBAL_MODE / .claude/brain.local.json 均未配置。已中止，未发起任何 LLM 调用。",
      });
      process.exitCode = 1;
      return;
    }

    const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));
    const store = new MemoryStore(dbPath);

    try {
      const result = await runConductorDispatch(
        rawIntent,
        { store },
        { decidedByLabel: "dispatch-conductor-task (auto, not a human decision)" },
      );

      emitResult({
        ok: !result.runError,
        contractId: result.contract.contractId,
        objective: result.contract.objective,
        // Zorro R1 yellow⑤：threadId 之前只在共享核心返回值里，CLI 层丢弃了——补上，供未来
        // batch 3（对话式 resume）用，本轮 CLI 本身不使用它。
        runId: result.runId,
        threadId: result.threadId,
        done: result.done,
        // Zorro R1 blocker B5：pendingGate 现在带 diff（经截断的真实候选 diff 文本，不是"有没有
        // diff"这个布尔），让模型能诚实转述"候选实际改了什么"，不只是"停在哪个 gate"。
        pendingGate: result.pendingGate
          ? {
              gate: result.pendingGate.gate,
              question: result.pendingGate.question,
              diff: result.pendingGate.diffRef ? truncate(result.pendingGate.diffRef, MAX_DIFF_LEN) : null,
            }
          : null,
        // Zorro R1 blocker B5：候选摘要 + 证据——真实内容（经大小限制），不是压成计数。
        evidence: {
          status: result.evidenceBundle.status,
          requirements: result.evidenceBundle.requirements,
          claims: summarizeClaims(result.evidenceBundle.claims),
          evidence: summarizeEvidence(result.evidenceBundle.evidence),
        },
        gateResults: result.gateResults,
        runError: result.runError ? { name: result.runError.name, message: result.runError.message } : null,
        board: "看板总览：node conductor-work/ui/server.mjs，打开 http://127.0.0.1:4173 查看多 workflow 实时进度",
      });
      if (result.runError) process.exitCode = 1;
    } finally {
      store.close();
    }
  } finally {
    process.chdir(callerCwd);
  }
}

main().catch((err) => {
  emitResult({ ok: false, error: "UNCAUGHT", message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
