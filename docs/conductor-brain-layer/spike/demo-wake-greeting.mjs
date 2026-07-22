#!/usr/bin/env node
// demo-wake-greeting.mjs — 本机可验的端到端 demo（aeloop issue #84 交付项5）。
//
// 做两件事：
//   1. 建一个全新临时身份库，塞几条真实 memory（identity/active_task ×3/idea ×2/decision ×1，
//      刻意混入 confirmed 和 unconfirmed 两种状态），验证渲染器不会把 unconfirmed 的当真报。
//   2. 用真实的 SessionStart hook 脚本（.claude/hooks/brain-wake-greeting.mjs）——不是绕开它
//      直接调 renderGreeting()，而是真的 spawn 这个 hook、喂它 Claude Code 会给的那种 stdin
//      payload、读它吐出的 additionalContext JSON——证明"hook 接线本身真的工作"，不是只证明
//      "渲染函数本身正确"这两件不完全相同的事。
//   3. 额外跑一次 print-status-table.mjs（.claude/skills/status-table/SKILL.md 背后那个 CLI），
//      证明同一份 status-table.mjs 数据在两个消费方（开场白 + 按需查询）之间是一致的。
//
// 跑法：pnpm run build && node docs/conductor-brain-layer/spike/demo-wake-greeting.mjs
// 产出的临时身份库不落在仓库任何 git 追踪路径下（mkdtempSync 在系统 tmp 目录），跑完自动清理。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openIdentityStore } from "./lib/wake.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const HOOK_PATH = path.join(REPO_ROOT, ".claude", "hooks", "brain-wake-greeting.mjs");
const PRINT_STATUS_TABLE_PATH = path.join(HERE, "print-status-table.mjs");

function line(msg = "") {
  console.log(msg);
}

const dir = mkdtempSync(path.join(tmpdir(), "aeloop-brain-wake-demo-"));
const dbPath = path.join(dir, "identity.db");

try {
  line("=== demo-wake-greeting.mjs（aeloop issue #84）===");
  line(`identityDbPath: ${dbPath}`);

  // ---- 步骤1：塞种子数据 ----
  const store = openIdentityStore(dbPath);

  store.insertMemory({
    type: "identity",
    title: "identity:name",
    content: "Aeloop Brain（demo 身份名，运营时按 AELOOP_BRAIN_IDENTITY_NAME 或身份库自行配置）",
    tags: ["demo"],
    confidenceState: "confirmed",
  });

  store.insertMemory({
    type: "snapshot",
    title: "上次停在的断点",
    content: "刚跑完 aeloop issue #80 的 vertical-slice spike（AC1/AC2 都 PASS），准备接 #84 的醒来开场白。",
    tags: ["demo"],
    confidenceState: "confirmed",
  });

  store.insertMemory({
    type: "active_task",
    title: "#84 醒来开场白渲染 + hook 接线",
    content: "greeting-data.mjs / render-greeting.mjs / status-table.mjs / SessionStart hook 都已经写完，在跑本机 demo。",
    tags: ["demo", "status:in-progress", "model:claude-opus-4-8"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "#75 brain 层 DESIGN 落地",
    content: "DESIGN.md 已经操作者确认过大方向，#84 是它 §2.2 外层醒来 loop 的第一片可见切片。",
    tags: ["demo", "status:done"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "向量层 spike（DESIGN §2.3 待决策项）",
    content: "还没排期，等 Phase1 demo 过了再看要不要做。",
    tags: ["demo", "status:todo"],
    confidenceState: "confirmed",
  });
  // 刻意插一条 unconfirmed 的 active_task——demo 要证明它绝不会出现在"现在在途"表格里，
  // 只会作为候选出现在"待你决策"。
  store.insertMemory({
    type: "active_task",
    title: "（候选，未确认）要不要把翻译器接真实模型",
    content: "这条还没人工确认要不要做，插进 demo 数据是为了验证渲染器不会把它当真报。",
    tags: ["demo"],
    confidenceState: "unconfirmed",
  });

  store.insertMemory({
    type: "idea",
    title: "Idea：给身份库加一个轻量 CLI 查看器",
    content: "operator 手动 sqlite3 查太麻烦，值得做一个小工具。",
    tags: ["demo"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "idea",
    title: "Idea：向量检索 spike",
    content: "DESIGN §2.3 三选一，先记进 Idea Queue。",
    tags: ["demo"],
    confidenceState: "confirmed",
  });

  store.insertMemory({
    type: "decision",
    title: "决策待定：TaskContract.brain 是否要开放第三种 BrainKind",
    content: "DESIGN §2.1 标了待决策，需要操作者拍板要不要向 aeloop 提新 issue。",
    tags: ["demo"],
    confidenceState: "unconfirmed",
  });

  store.close();
  line("\n[步骤1] 种子数据已写入（3 条 confirmed active_task + 1 条 unconfirmed active_task 候选 + " +
    "1 条 confirmed snapshot + 2 条 confirmed idea + 1 条 unconfirmed decision + 1 条 confirmed identity）。");

  // ---- 步骤2：真的 spawn SessionStart hook，喂它 Claude Code 会给的 stdin payload ----
  line("\n[步骤2] 真实 spawn .claude/hooks/brain-wake-greeting.mjs（不是绕开它直接调渲染函数）");
  const stdinPayload = JSON.stringify({ session_id: "demo-session", cwd: REPO_ROOT });
  const hookStdout = execFileSync("node", [HOOK_PATH], {
    input: stdinPayload,
    encoding: "utf8",
    env: { ...process.env, AELOOP_BRAIN_IDENTITY_DB: dbPath },
  });

  let hookOutput;
  try {
    hookOutput = JSON.parse(hookStdout);
  } catch (err) {
    throw new Error(`hook stdout 不是合法 JSON，如实报告失败，不猜测内容：${err.message}\nraw stdout:\n${hookStdout}`);
  }

  if (hookOutput?.hookSpecificOutput?.hookEventName !== "SessionStart") {
    throw new Error(`hook 输出的 hookEventName 不是 SessionStart，如实报告：${JSON.stringify(hookOutput)}`);
  }

  line("\n[步骤2] hook 真实 stdout（JSON）解析成功，hookEventName === SessionStart。");
  line("\n=== hook additionalContext 里注入的完整开场白（这是真实渲染结果，不是手写样例）===\n");
  line(hookOutput.hookSpecificOutput.additionalContext);

  // ---- 步骤3：同一份数据跑一次 print-status-table.mjs（skill 背后的 CLI），验证两个消费方一致 ----
  line("\n\n=== 步骤3：print-status-table.mjs（.claude/skills/status-table/SKILL.md 用的同一个 CLI）===\n");
  const statusTableStdout = execFileSync("node", [PRINT_STATUS_TABLE_PATH], {
    encoding: "utf8",
    env: { ...process.env, AELOOP_BRAIN_IDENTITY_DB: dbPath },
  });
  line(statusTableStdout.trimEnd());

  // ---- 一致性自检：hook 开场白里的"现在在途"表格 和 print-status-table.mjs 单独跑出的表格
  //      必须逐字相同——不是 `.includes(...)` 子串包含（那只证明"表格文本出现在某处"，
  //      证不到"两处输出的这一段本身逐字相等"；2026-07-22 Zorro/Codex 跨模型复审建议项）。
  //      做法：从开场白里精确切出"**现在在途：**"和"**Idea Queue 积压："之间的那一段，
  //      trim 后和 print-status-table.mjs 的 stdout（同样 trim）做严格字符串相等断言。
  const greetingText = hookOutput.hookSpecificOutput.additionalContext;
  const sectionStartMarker = "**现在在途：**";
  const sectionEndMarker = "**Idea Queue 积压：**";
  const startIdx = greetingText.indexOf(sectionStartMarker);
  const endIdx = greetingText.indexOf(sectionEndMarker);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      "一致性自检本身失败：开场白文本里找不到 \"**现在在途：**\"/\"**Idea Queue 积压：**\" 这两个" +
        "分节标记，如实报告，不能假装能比对（可能是渲染格式变了但这个 demo 脚本没跟着更新）。",
    );
  }
  const tableInGreeting = greetingText.slice(startIdx + sectionStartMarker.length, endIdx).trim();
  const tableFromCli = statusTableStdout.trim();
  const exactMatch = tableInGreeting === tableFromCli;
  line(
    `\n=== 一致性自检：开场白里的"现在在途"表格与 print-status-table.mjs 单独输出逐字相等（===，不是子串包含）：${
      exactMatch ? "PASS" : "FAIL"
    } ===`,
  );
  if (!exactMatch) {
    line(`  开场白里的表格段：\n---\n${tableInGreeting}\n---`);
    line(`  print-status-table.mjs 的输出：\n---\n${tableFromCli}\n---`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
