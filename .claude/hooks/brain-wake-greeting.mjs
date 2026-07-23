#!/usr/bin/env node
/**
 * brain-wake-greeting.mjs — SessionStart hook（aeloop issue #84）。
 *
 * 会话启动时：开 aeloop 身份 MemoryStore（dbPath 由 `resolveIdentityDbPath()` 解析，见下方"配置"）→
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
 * 配置（issue #88 B9 更新：dbPath 有两个来源，二选一，缺一不可当"必需"看待——两者都没有
 *   才安静跳过）：
 *   - **首选** AELOOP_BRAIN_IDENTITY_DB：身份库 dbPath 环境变量，建议用绝对路径（相对路径会
 *     相对 `better-sqlite3` 打开时的进程 cwd 解析，hook 和手动跑 print-status-table.mjs 的 cwd
 *     不一定相同，绝对路径避免歧义，见 WAKE-GREETING-RUNBOOK.md）。
 *   - **fallback**（env 读不到时）：项目根 `.claude/brain.local.json` 的 `identityDbPath` 字段
 *     （`.claude/brain.local.json.example` 是模板，复制一份改名即可；已 gitignore，不进 git）
 *     ——解决 IDE/图形界面启动的会话不继承 shell profile export 的坑，见 `resolveIdentityDbPath()`
 *     （`./lib/db-path.mjs`）+ WAKE-GREETING-RUNBOOK.md"IDE 启动读不到 env 的坑"一节。
 *   - 两者都没有 → 安静跳过，不注入任何东西，不是错误（#84 既有行为，本次未变）。
 *   - AELOOP_BRAIN_IDENTITY_NAME（可选）：显式覆盖身份名，优先级高于身份库里
 *     type:"identity", title:"identity:name" 的那条 memory——纯粹为了方便在身份库还没配置
 *     identity:name 记录时也能先跑通 demo，不是长期推荐路径（长期应该配进身份库本身）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIdentityDbPath } from "./lib/db-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_LIB_DIR = path.join(HERE, "..", "..", "docs", "conductor-brain-layer", "spike", "lib");
// issue #98：`resolveVersionLine()`（lib/version-info.mjs）要读 `<REPO_ROOT>/dist/shared/
// version-info.generated.js`——真实源码仓库和全局安装后的 `repo-snapshot/` 两种场景下，
// `REPO_ROOT` 都是这个 hook 自己所在目录（`.claude/hooks/`）往上两级，和 SPIKE_LIB_DIR 的
// 计算方式同一惯例（目录骨架保留，见 `install-global-brain.mjs` 头注释）。
const REPO_ROOT = path.join(HERE, "..", "..");

function emitAdditionalContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
}

async function main() {
  // stdin 带 session_id/cwd（Claude Code SessionStart payload 约定）。issue #93 B4 起，这个 hook
  // 现在需要读 cwd 了（此前 #84/#88 只排空不解析）——用来反查"当前是哪个项目"，好在多项目开场白
  // 里把当前项目置顶（PRD §4.5）。解析失败（非 JSON / 没有 cwd 字段）→ currentProjectKey 保持
  // null，走 greeting-data.mjs 已有的向后兼容路径（不分组，行为等同 #84/#88），不报错、不阻断
  // （延续本文件"绝不阻断"的既有惯例）。
  let cwd = null;
  try {
    const raw = readFileSync(0, "utf8");
    const input = JSON.parse(raw);
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    /* 没有 stdin / 不是合法 JSON / 没有 cwd 字段，都无所谓——cwd 保持 null */
  }

  // issue #88 B9：dbPath 解析从"直读 env"改成 resolveIdentityDbPath()（env 优先，读不到时 fallback
  // 到 .claude/brain.local.json——解决 IDE/图形界面启动的会话不继承 shell profile export 的坑，
  // 见 docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md）。issue #93 B1 起，
  // AELOOP_BRAIN_GLOBAL_MODE=1 时会跳过 brain.local.json 那层、落到一个固定全局默认路径——两条
  // 分支都在 resolveIdentityDbPath() 内部处理，本文件这一行调用本身不需要跟着改。
  const dbPath = resolveIdentityDbPath();
  if (!dbPath) return; // 两个配置源都没有 = 安静跳过，不是错误（#84 既有行为，本次不变）

  const { openIdentityStore } = await import(path.join(SPIKE_LIB_DIR, "wake.mjs"));
  const { gatherGreetingData } = await import(path.join(SPIKE_LIB_DIR, "greeting-data.mjs"));
  const { renderGreeting } = await import(path.join(SPIKE_LIB_DIR, "render-greeting.mjs"));

  // issue #93 B4：cwd 反查当前项目 owner/repo——解析失败（非 git 目录/无 origin/URL 认不出）
  // 同样兜底为 null，不报错（同上"绝不阻断"惯例）。
  let currentProjectKey = null;
  if (cwd) {
    const { getOriginOwnerRepo } = await import(path.join(HERE, "lib", "git-remote.mjs"));
    const origin = getOriginOwnerRepo(cwd);
    if (origin.ok) currentProjectKey = `${origin.owner}/${origin.repo}`;
  }

  const store = openIdentityStore(dbPath);
  let data;
  try {
    data = gatherGreetingData(store, { currentProjectKey });
  } finally {
    store.close();
  }

  if (process.env.AELOOP_BRAIN_IDENTITY_NAME) {
    data = { ...data, identityName: process.env.AELOOP_BRAIN_IDENTITY_NAME };
  }

  // issue #98：版本行解析单独包 try/catch——这一步失败（比如 dist/ 没 build 过）绝不能拖累
  // 整段开场白（`resolveVersionLine()` 自己已经 fail-soft 返回 undefined 不抛错，这里再加一层
  // 纯粹是防御性的：即便它未来某天违反自己的契约意外抛错，也只丢版本行，不影响开场白其余部分）。
  try {
    const { resolveVersionLine } = await import(path.join(SPIKE_LIB_DIR, "version-info.mjs"));
    const versionLine = await resolveVersionLine(REPO_ROOT);
    if (versionLine) data = { ...data, versionLine };
  } catch {
    /* 版本行是锦上添花的诊断信息，不是开场白的必需部分——解析失败就没有这一行，不阻断 */
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
