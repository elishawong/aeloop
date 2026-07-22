#!/usr/bin/env node
/**
 * brain-wake-greeting.mjs — SessionStart hook（aeloop issue #84）。
 *
 * 会话启动时：开 aeloop 身份 MemoryStore（AELOOP_BRAIN_IDENTITY_DB 指的那个 dbPath）→
 * gatherGreetingData()（docs/conductor-brain-layer/spike/lib/greeting-data.mjs）→
 * renderGreeting() → 把渲染好的开场白文字连同一条"请原样复述"的指令，作为
 * SessionStart additionalContext 注入。模型看到这段注入后，对用户的第一句话（不管是不是
 * "你好"）先原样吐出这段开场白，再回应用户实际说的内容——这样"意识已加载…"这段文字本身
 * 是渲染器拼出来的真实数据，不是模型在没有约束的情况下自由发挥/可能编造的产物。
 *
 * 诚实标注（DESIGN §7.2 Phase1/Phase2 边界，不要在这个文件里假装做了没做的事）：
 * 这个 hook 本身**换了数据源，没有换运行时**——它仍然依附于 Claude Code CLI 自己的
 * SessionStart 生命周期钩子，不是 aeloop 自己的运行时能力（aeloop 的 ModelAdapter 完全没有
 * 会话/hook 概念，见 DESIGN §7.1）。session 本身用什么模型（seed/deepseek/claude）由
 * Claude Code CLI 的模型配置决定，这个 hook 不参与、不验证那一层。
 *
 * 红线（继承自 lib/status-table.mjs / lib/greeting-data.mjs）：渲染出的开场白只包含
 * confidenceState === "confirmed" 的 memory 当既定事实；unconfirmed 的候选只出现在
 * "待你决策" 段，标明是候选。这个 hook 自己不做任何额外的数据加工，纯粹是
 * "开 store → 调 gatherGreetingData/renderGreeting → 关 store → 输出" 的驱动壳。
 *
 * **绝不阻断**（同 ai-agent 参考实现 `.claude/hooks/*.mjs` 的红线约定，抄这条纪律但不抄那些
 * 文件本身——那些是 ai-agent 项目自己的机制，aeloop 这里是独立实现）：任何异常/env 缺失/
 * dist/ 未构建，都安静降级——不打印开场白、不报错、始终 exit 0，绝不让一个没配好身份库的
 * 普通会话被这个 hook 卡住或搞出一堆报错噪音。用动态 import()（不是顶层 static import）
 * 就是为了让"dist/ 还没 build"这种失败也能被 try/catch 接住，而不是在模块加载阶段就直接崩溃。
 *
 * 配置：
 *   - AELOOP_BRAIN_IDENTITY_DB（必需，否则安静跳过，不注入任何东西）：身份库 dbPath，
 *     建议用绝对路径（相对路径会相对 `better-sqlite3` 打开时的进程 cwd 解析，hook 和手动跑
 *     print-status-table.mjs 的 cwd 不一定相同，绝对路径避免歧义，见 WAKE-GREETING-RUNBOOK.md）。
 *   - AELOOP_BRAIN_IDENTITY_NAME（可选）：显式覆盖身份名，优先级高于身份库里
 *     type:"identity", title:"identity:name" 的那条 memory——纯粹为了方便在身份库还没配置
 *     identity:name 记录时也能先跑通 demo，不是长期推荐路径（长期应该配进身份库本身）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_LIB_DIR = path.join(HERE, "..", "..", "docs", "conductor-brain-layer", "spike", "lib");

function emitAdditionalContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
}

async function main() {
  // stdin 带 session_id/cwd（Claude Code SessionStart payload 约定），这个 hook 目前不需要
  // 读它——dbPath 完全由环境变量决定，不依赖 cwd——但仍然把 stdin 排空，避免管道卡住。
  try {
    readFileSync(0, "utf8");
  } catch {
    /* 没有 stdin 也无所谓 */
  }

  const dbPath = process.env.AELOOP_BRAIN_IDENTITY_DB;
  if (!dbPath) return; // 未配置身份库 = 安静跳过，不是错误

  const { openIdentityStore } = await import(path.join(SPIKE_LIB_DIR, "wake.mjs"));
  const { gatherGreetingData } = await import(path.join(SPIKE_LIB_DIR, "greeting-data.mjs"));
  const { renderGreeting } = await import(path.join(SPIKE_LIB_DIR, "render-greeting.mjs"));

  const store = openIdentityStore(dbPath);
  let data;
  try {
    data = gatherGreetingData(store);
  } finally {
    store.close();
  }

  if (process.env.AELOOP_BRAIN_IDENTITY_NAME) {
    data = { ...data, identityName: process.env.AELOOP_BRAIN_IDENTITY_NAME };
  }

  const greeting = renderGreeting(data);

  // 诊断信息（连上的是哪个 dbPath）只走 stderr——不进 emitAdditionalContext() 的正文。
  // 2026-07-23 Zorro/Codex 跨模型复审第 4 轮 must-fix：AELOOP_BRAIN_IDENTITY_DB 是 operator
  // 环境变量，原样插进"请逐字复述"的注入正文时和身份库里的 memory 数据一样是不可信输入——
  // 一个带换行的路径值能在这条带外前缀里伪造出额外的物理行（第二个"意识已加载"/假 bullet），
  // 而且这条前缀在 render-greeting.mjs 的 sanitizeText() 管线之外，渲染层上一轮的清洗完全
  // 挡不到它。选的修法是"根上拿掉"（军师建议的方案二，而不是再给这条前缀套一层
  // sanitizeText）：诊断路径本来就不该混进模型要逐字复述的正文，搬到 stderr 后这个注入面
  // 直接消失，不需要再维护第二处清洗逻辑。
  console.error(`[brain-wake-greeting] 已连上身份库：${dbPath}`);

  const injected =
    `[brain-wake-greeting] 请把下面这段开场白原样作为你对用户第一句话的` +
    `回复——逐字复述，不要改写措辞、不要新增其中没有出现过的条目、不要省略"现在在途"/"Idea Queue 积压"` +
    `/"待你决策"里列出的任何一行。若用户第一句话直接是任务指令而不是打招呼，仍先完整给出以下开场白，` +
    `再回应任务内容：\n\n${greeting}`;

  emitAdditionalContext(injected);
}

main()
  .catch(() => {
    /* 绝不阻断：任何失败都吞掉，不打印开场白，不影响会话正常启动 */
  })
  .finally(() => {
    process.exitCode = 0;
  });
