#!/usr/bin/env node
/**
 * brain-wake-greeting.mjs — 醒来开场白驱动壳（aeloop issue #84，issue #106 起支持三条驱动路径）。
 *
 * **三条驱动路径（issue #106，设计权威 `docs/wake-trigger-portability/DESIGN.md`，本文件不重复
 * 论证，只落地）**：
 *   1. **`SessionStart` hook**（CLI 环境主力，`.claude/settings.json` 注册）——会话生命周期内
 *      固定时刻触发一次。
 *   2. **`UserPromptSubmit` hook**（IDE/未知 host 环境主力，`.claude/settings.json` 同一份
 *      `command` 注册，同一个脚本文件，靠 stdin 里的 `hook_event_name` 字段区分两条事件）——
 *      每个 prompt 提交都会 fire，靠下方"共享守卫"保证一次会话只真正输出一次。
 *   3. **`--standalone` CLI flag**（模型自救兜底，只有前两条硬机制都没有被观察到已经注入时，
 *      由全局 `~/.claude/CLAUDE.md` 里 `install-global-brain.mjs` 管理的 `wake-fallback` 标记块
 *      指示模型自己跑）——不读 stdin（避免没有真实管道时潜在阻塞），`cwd` 用 `process.cwd()`，
 *      `sessionId` 尽力用 `resolveSessionId()` 解析，输出是给模型直接读的纯文本，不包
 *      `hookSpecificOutput` JSON 包装。
 *
 * 三条路径共用同一套核心逻辑：开 aeloop 身份 MemoryStore（dbPath 由 `resolveIdentityDbPath()`
 * 解析，见下方"配置"）→ `gatherGreetingData()`（`docs/conductor-brain-layer/spike/lib/
 * greeting-data.mjs`）→ `renderGreeting()` → 算出待输出文案 → **共享守卫 claim**（见下方"共享
 * 守卫"）→ claim 成功才真正输出。模型看到注入/纯文本输出后，对用户的第一句话（不管是不是
 * "你好"）先原样吐出这段开场白，再回应用户实际说的内容——这样"意识已加载…"这段文字本身
 * 是渲染器拼出来的真实数据，不是模型在没有约束的情况下自由发挥/可能编造的产物。
 *
 * **共享守卫（issue #106，`.claude/hooks/lib/wake-session-guard.mjs`，DESIGN §3.2 完整论证）**：
 * 三条路径共享同一个以 `session_id`（缺失时退回 `pid`）为 key 的 claim 状态，落在
 * `~/.claude/aeloop-brain/wake-session-state/`（homedir，绝不落进目标项目仓库，DESIGN §1.5）。
 * **claim 必须在文案已经算完之后、真正要输出之前才调用**——不能提前 claim，否则渲染逻辑一旦
 * 抛出未预期异常，这个会话会在任何一层都再也拿不到开场白（比没有守卫更差）。三条路径里，谁先
 * claim 成功谁负责输出，其余安静让路（hook 模式什么都不输出；`--standalone` 模式打印一句"本会话
 * 已经醒来过"）。
 *
 * 诚实标注（DESIGN §7.2 Phase1/Phase2 边界，不要在这个文件里假装做了没做的事）：
 * 这个 hook 本身**换了数据源，没有换运行时**——它仍然依附于 Claude Code CLI 自己的
 * SessionStart/UserPromptSubmit 生命周期钩子（或模型自己发起的一次性进程调用），不是 aeloop
 * 自己的运行时能力（aeloop 的 ModelAdapter 完全没有会话/hook 概念，见
 * `docs/conductor-brain-layer/DESIGN.md` §7.1）。session 本身用什么模型（seed/deepseek/claude）
 * 由 Claude Code CLI 的模型配置决定，这个 hook 不参与、不验证那一层。
 *
 * 红线（继承自 lib/status-table.mjs / lib/greeting-data.mjs）：渲染出的开场白只包含
 * confidenceState === "confirmed" 的 memory 当既定事实；unconfirmed 的候选只出现在
 * "待你决策" 段，标明是候选。这个 hook 自己不做任何额外的数据加工，纯粹是
 * "开 store → 调 gatherGreetingData/renderGreeting → 关 store → claim → 输出" 的驱动壳。三态
 * 判断（未配置/空库/正常，见下方"首次醒来引导"）本身在 issue #106 这次改动里**零改动**——三条
 * 驱动路径只是"谁来触发、怎么包装输出"的分派层，不改变判断本身或文案本身。

 * **绝不阻断**（同 ai-agent 参考实现 `.claude/hooks/*.mjs` 的红线约定，抄这条纪律但不抄那些
 * 文件本身——那些是 ai-agent 项目自己的机制，aeloop 这里是独立实现）：任何异常/env 缺失/
 * dist/ 未构建/守卫读写异常，都安静降级——不打印开场白、不报错、始终 exit 0，绝不让一个没配好
 * 身份库的普通会话被这个 hook 卡住或搞出一堆报错噪音。用动态 import()（不是顶层 static import）
 * 就是为了让"dist/ 还没 build"这种失败也能被 try/catch 接住，而不是在模块加载阶段就直接崩溃。
 *
 * 配置（issue #88 B9 更新：dbPath 有两个来源，二选一，缺一不可当"必需"看待——issue #96 起，
 *   两者都没有**不再**是"安静跳过"，见下方"首次醒来引导"一节）：
 *   - **首选** AELOOP_BRAIN_IDENTITY_DB：身份库 dbPath 环境变量，建议用绝对路径（相对路径会
 *     相对 `better-sqlite3` 打开时的进程 cwd 解析，hook 和手动跑 print-status-table.mjs 的 cwd
 *     不一定相同，绝对路径避免歧义，见 WAKE-GREETING-RUNBOOK.md）。
 *   - **fallback**（env 读不到时）：项目根 `.claude/brain.local.json` 的 `identityDbPath` 字段
 *     （`.claude/brain.local.json.example` 是模板，复制一份改名即可；已 gitignore，不进 git）
 *     ——解决 IDE/图形界面启动的会话不继承 shell profile export 的坑，见 `resolveIdentityDbPath()`
 *     （`./lib/db-path.mjs`）+ WAKE-GREETING-RUNBOOK.md"IDE 启动读不到 env 的坑"一节。
 *   - **两者都没有 → issue #96 起注入首次引导脚本**（不是 #84/#88 时期的"安静跳过、不注入
 *     任何东西"——那条描述已经被 #96 推翻，别再信这句话字面写的"本次未变"，本次就变了；
 *     完整行为见下方"首次醒来引导"一节）。
 *   - AELOOP_BRAIN_IDENTITY_NAME（可选）：显式覆盖身份名，优先级高于身份库里
 *     type:"identity", title:"identity:name" 的那条 memory——纯粹为了方便在身份库还没配置
 *     identity:name 记录时也能先跑通 demo，不是长期推荐路径（长期应该配进身份库本身）。
 *   - AELOOP_BRAIN_TASK_SOURCE（issue #103，可选，见 `./lib/task-source.mjs` +
 *     docs/enterprise-board-toggle/DESIGN.md）：在途任务来源选择器，值域 "none"（默认，shipped
 *     零 GitHub）| "github"。省略/非法值时视为 "none"——正常渲染路径（状态 C）"现在在途"/
 *     "Idea Queue 积压"/任务候选 整段不渲染（不是显示"无"占位）；只有身份/宪法候选（不碰 gh）
 *     不受影响。非全局模式下也可以在 `.claude/brain.local.json` 里配 "taskSource" 字段。
 *
 * 首次醒来引导（issue #96，设计权威 docs/first-wake-onboarding/DESIGN.md，本文件不重复论证）：
 *   dbPath 解析出 null（两个配置源都没有）或解析出来但库是空的（`listMemories().length === 0`——
 *   `MemoryStore` 打开一个不存在的文件不会报错，只会静默建出空 schema，这是"配了路径但没
 *   seed"和"压根没配置"共同会落到的状态）时，**不再彻底沉默/渲染诚实占位符开场白**——改为注入
 *   `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs` 的引导正文，指示模型带用户走
 *   一遍问答式配置，而不是逐字复述。这两种状态下绝不能出现"意识已加载"这类需要真实数据支撑的
 *   延续式开场白措辞——防幻觉红线在这条最基础的分支上同样适用，不是只护着"有数据"的路径。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIdentityDbPath } from "./lib/db-path.mjs";
import { resolveTaskSource } from "./lib/task-source.mjs";
import { claim, resolveSessionId } from "./lib/wake-session-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPIKE_LIB_DIR = path.join(HERE, "..", "..", "docs", "conductor-brain-layer", "spike", "lib");
// issue #98：`resolveVersionLine()`（lib/version-info.mjs）要读 `<REPO_ROOT>/dist/shared/
// version-info.generated.js`——真实源码仓库和全局安装后的 `repo-snapshot/` 两种场景下，
// `REPO_ROOT` 都是这个 hook 自己所在目录（`.claude/hooks/`）往上两级，和 SPIKE_LIB_DIR 的
// 计算方式同一惯例（目录骨架保留，见 `install-global-brain.mjs` 头注释）。
const REPO_ROOT = path.join(HERE, "..", "..");

const VALID_HOOK_EVENT_NAMES = new Set(["SessionStart", "UserPromptSubmit"]);

/**
 * issue #2 batch 1 新增——"工作请求识别与派发"这条标准指令的正文，完整版本见
 * `docs/conductor-brain-layer/BRAIN.md` §6(本节只放精简可执行版,不是逐字复述该文档)。
 *
 * **和 `greeting`/首次引导正文的关键区别**:那些是要模型**逐字复述/照做引导脚本**给用户看的
 * 文本;这段是要模型**读了照做的行为指引**,不是给用户看的——三事件路径(#106)下,这段只拼进
 * **状态 C**(正常醒来)的 `injected` 文本里,拼接时用一段清楚的分隔措辞区分"这两段角色不同",
 * 避免模型把这段行为指引也当成开场白的一部分念给用户听。
 *
 * 只在状态 C(正常醒来,本文件唯一会拼接这段指令的分支)注入——状态 A/B(首次引导/空库)走的是
 * `onboarding-greeting.mjs` 的问答式配置脚本,用户此刻还没有一个配置好的环境可以派发任务,硬塞
 * 这段指令只会制造混乱,不注入(同 #96 既有的"不同状态注入不同内容"原则,#106 三事件分派不改变
 * 这条三态判断本身,见文件头注释)。
 */
const CONDUCTOR_DISPATCH_INSTRUCTION =
  "[brain-wake-greeting] 以下不是开场白的一部分，不要念给用户听——这是给你自己看的标准工作指令" +
  "（issue #2 batch 1，完整版见 docs/conductor-brain-layer/BRAIN.md §6）：如果用户接下来的话明显是" +
  "在要求你做一件具体的工作（实现一个功能、修一个 bug、跑一次调研这类有明确产出的请求，不是闲聊/" +
  "提问/讨论想法），考虑通过 Bash 工具运行 `node scripts/dispatch-conductor-task.mjs " +
  '"<意图文本>"`（这个命令会自动翻译成任务契约、派 coder 生成候选、独立 tester 复核、停在 G3/' +
  "Escalation 人工批准前——G3/Escalation 恒人工，绝不会自动 commit/push/合并）。拿不准这句话是不是" +
  "一个工作请求时，直接问用户，不要凭猜测硬派或硬不派。命令跑完后，把 stdout 的 JSON 结果原样解读" +
  "给用户——重点讲清楚候选实际改了什么（`pendingGate.diff`/`evidence.claims`，不是只报一个数字）、" +
  "有没有停在某个 gate 前等待批准、有没有报错，不要编造没有出现在结果里的内容，也不要暗示任务已经" +
  "全部做完。诚实边界：candidate-only 今天只是 prompt/契约层约束，不是运行时机械强制（issue #31 " +
  "开放风险，详见 BRAIN.md §6）——所以这条派发路径只在 aeloop 自己仓库这个沙箱内跑，你不应该建议" +
  "用户拿它去处理其它真实业务项目的任务。";

function emitAdditionalContext(text, hookEventName) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext: text },
    }),
  );
}

// issue #96：区别于下面正常路径用的"请原样复述"包装（逐字复述一段已经渲染好的真实数据），首次
// 引导正文是一段要模型**执行**（带用户问答式走配置）的脚本，不是要**背诵**的开场白——两种指令
// 混在一起会让模型把引导步骤当成开场白抄一遍就完事。这里显式区分包装语气，同时把"不要输出延续式
// 开场白措辞/不要假装有身份"这条红线在元指令层面再强调一次（正文本身也自带这条约束，双重保险，
// 防止未来任何一层的措辞被后续改动弱化）。
function wrapOnboardingScript(body) {
  return (
    "[brain-wake-greeting] 下面这段不是要你逐字复述的开场白，是一份引导脚本。" +
    "请按脚本内容，用对话/问答的方式带用户完成配置——每次只推进一步、等用户确认或反馈再继续下一步，" +
    "不要一次性甩给用户一长串命令。绝不能假装身份库已经配置好、绝不能编造任何“在途任务”/“身份名”/" +
    "历史记忆，也绝不能输出延续式开场白（“我是……上次停在……”那种格式）——那需要真实数据支撑，" +
    "现在没有。如果用户明确想跳过配置，如实告诉 TA 在配置完成之前每次开新会话都会再看到这段引导，" +
    `然后正常处理用户接下来的请求。\n\n${body}`
  );
}

/**
 * issue #106：三条驱动路径共用的最终输出关口——**必须在文案已经算完之后才调用**（本文件头注释
 * "共享守卫"一节的时机纪律，`wake-session-guard.mjs` 的 `claim()` 头注释同样强调）。
 *
 * 🟡 Zorro R2 复审顺手修（2026-07-24）：本段 JSDoc 此前仍描述 B2 修复前的旧行为
 * （"`claim()` 失败 → 一律抑制输出"），行内实现早已在 B2 订正过（只有 `reason:"already-
 * claimed"` 才抑制，`reason:"error"` 照常输出），JSDoc 没跟上——这里对齐，不是再改一次行为。
 *
 * 判断依据是 `claim()` 返回的 `result.reason`，不是单看 `result.claimed`（B2 blocker 的根因
 * 就是当初只看后者）：
 * - `claim()` 返回 `{claimed:true}`，**或** `{claimed:false, reason:"error"}`（guard 自身
 *   I/O 故障，真实身份未知）→ 都视为"应该输出"：`standalone` 为真时打印纯文本 `text`（不包
 *   JSON，给模型当 Bash 工具输出直接读）；`standalone` 为假（hook 模式）时
 *   `emitAdditionalContext()`。`error` 场景下这次输出理论上可能和另一层的输出重复，guard 自己
 *   的设计取向已经明确接受这个代价（"可能重复注入一次，比连一次都注入不出来轻得多"）。
 * - `claim()` 返回 `{claimed:false, reason:"already-claimed"}`（明确知道 Layer1/Layer2 某条
 *   已经在本会话里成功注入过，不是 I/O 故障）→ 才真正抑制输出：`standalone` 模式打印一句极简
 *   提示（避免模型误以为脚本坏了）；hook 模式什么都不输出，延续现有"安静，不刷屏"的既有惯例
 *   （同 `brain-isolation-guard.mjs` 的"没有检测结果就不输出"模式）。
 *
 * @param {{text:string, hookEventName?:string, sessionId?:string|null, pid?:number, standalone:boolean}} args
 */
function claimAndEmit({ text, hookEventName, sessionId, pid, standalone }) {
  const source = standalone ? "standalone" : hookEventName;
  const result = claim({ sessionId, pid, source });

  // 🔒 Zorro R1 blocker B2（2026-07-24，独立 Codex 复现坐实，最重的一条）：`wake-session-
  // guard.mjs` 的 fail-open 契约（见该文件头注释"失败模式"）是——任何读写异常
  // （权限/磁盘/损坏状态/B1 的 homeDir 校验失败）→ `{claimed:false, reason:"error"}`，**调用方
  // 按"未 claim"处理，即允许输出**。此前这里只看 `result.claimed`、从不看 `result.reason`，把
  // `reason:"error"`（guard 自身 I/O 故障，谁先谁后其实未知）和 `reason:"already-claimed"`
  // （明确知道被别的路径抢先）一视同仁地抑制输出——后果：guard 写盘任何瞬时故障（磁盘满/权限/
  // 状态文件损坏）都会让这个会话拿不到开场白（hook 模式下 stdout 直接空；standalone 模式下
  // 谎报"本会话已经醒来过"）——这正是 guard 自己头注释警告的"比没有守卫更差"，而且会削弱 #96
  // 的三态防幻觉网：状态 A/B（未配置/空库）在这种 I/O 故障下会完全没有 stdout，等于退回
  // #106 本身要堵的"沉默→模型脑补假开场白"那个洞。
  //
  // 修法：只有 `reason === "already-claimed"`（明确知道别的路径已经负责输出过）才抑制这次输出；
  // `claimed:true` 和 `reason:"error"` 都视为"这次应该输出"——`error` 场景下这次输出理论上可能
  // 和另一层的输出重复，但 guard 自己的设计取向已经明确接受这个代价（"guard 失效的代价是可能
  // 重复注入一次，比连一次都注入不出来轻得多"，见 `wake-session-guard.mjs` 头注释）。
  const suppressOutput = !result.claimed && result.reason === "already-claimed";

  if (!suppressOutput) {
    if (standalone) {
      process.stdout.write(`${text}\n`);
    } else {
      // hook 模式下 hookEventName 理论上恒为 "SessionStart"/"UserPromptSubmit" 之一（两者都是
      // `.claude/settings.json` 里实际注册的事件）；未识别的值兜底成 "SessionStart"（历史行为，
      // 不因为新增分派逻辑而改变旧调用方式下的默认输出格式）。
      emitAdditionalContext(text, VALID_HOOK_EVENT_NAMES.has(hookEventName) ? hookEventName : "SessionStart");
    }
    return;
  }
  if (standalone) {
    process.stdout.write("[brain-wake-greeting] 本会话已经醒来过，跳过（其它触发路径已经成功注入过一次开场白）。\n");
  }
  // hook 模式且确认已被别的路径 claim（不是 I/O 故障）：什么都不输出。
}

async function main() {
  const standalone = process.argv.includes("--standalone");

  // issue #106：`--standalone` 模式不读 stdin——避免在没有真实管道的手动/模型自触发场景下潜在
  // 阻塞（`process.stdin` 在交互式/无管道场景下的读取行为不确定）。`cwd` 用 `process.cwd()`，
  // `sessionId` 尽力用 `resolveSessionId()`（`wake-session-guard.mjs` 复用 `brain-lock.mjs` 的
  // 既有实现：`CLAUDE_CODE_SESSION_ID`/`CLAUDE_SESSION_ID`/`AELOOP_BRAIN_SESSION_ID` 依次尝试）
  // ——拿不到时 `claim()` 内部会退回 `pid`（DESIGN §3.2 已标注这条 fallback 在跨 Bash 调用场景
  // 下的真实局限，不在本文件里重复）。`hookEventName` 保持 `undefined`（standalone 模式不需要）。
  let cwd = null;
  let hookEventName;
  let sessionId = null;

  if (standalone) {
    cwd = process.cwd();
    sessionId = resolveSessionId();
  } else {
    // stdin 带 session_id/cwd/hook_event_name（Claude Code hook payload 约定，SessionStart 和
    // UserPromptSubmit 两类事件都有这三个字段，见 DESIGN §1.2"官方文档确认的 hook payload/能力
    // 矩阵"）。issue #93 B4 起，这个 hook 需要读 cwd（此前 #84/#88 只排空不解析）——用来反查
    // "当前是哪个项目"，好在多项目开场白里把当前项目置顶（PRD §4.5）。issue #106 起额外读
    // hook_event_name/session_id——前者决定输出时 `hookSpecificOutput.hookEventName` 该写哪个
    // 值（不再硬编码 "SessionStart"），后者是共享守卫的 claim key。解析失败（非 JSON / 字段
    // 缺失）→ 三者都保持初始值（null/undefined），走既有向后兼容路径，不报错、不阻断（延续本
    // 文件"绝不阻断"的既有惯例）。
    try {
      const raw = readFileSync(0, "utf8");
      const input = JSON.parse(raw);
      if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
      if (typeof input.hook_event_name === "string") hookEventName = input.hook_event_name;
      if (typeof input.session_id === "string" && input.session_id) sessionId = input.session_id;
    } catch {
      /* 没有 stdin / 不是合法 JSON / 字段缺失，都无所谓——三者保持初始值 */
    }
  }

  const pid = process.pid;

  // issue #88 B9：dbPath 解析从"直读 env"改成 resolveIdentityDbPath()（env 优先，读不到时 fallback
  // 到 .claude/brain.local.json——解决 IDE/图形界面启动的会话不继承 shell profile export 的坑，
  // 见 docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md）。issue #93 B1 起，
  // AELOOP_BRAIN_GLOBAL_MODE=1 时会跳过 brain.local.json 那层、落到一个固定全局默认路径——两条
  // 分支都在 resolveIdentityDbPath() 内部处理，本文件这一行调用本身不需要跟着改。
  const dbPath = resolveIdentityDbPath();

  // issue #103：在途任务来源选择器——"github" 时渲染层行为和加这个开关之前逐字节相同；省略/
  // 任何其它值（shipped 默认 "none"）时"现在在途"/"Idea Queue 积压"整段不渲染、seed 不调 gh，
  // 见 docs/enterprise-board-toggle/DESIGN.md。只在状态 C（正常渲染，下方）用到——状态 A/B 的
  // 首次引导正文（onboarding-greeting.mjs）自己内部用同一个 resolveTaskSource() 独立解析措辞
  // 分支（同 globalMode 的既有模式：调用方不显式传，模块自己读真实 env），这里不重复传参。
  const taskSource = resolveTaskSource();

  // issue #96：两个配置源都没有 = 状态 A（未配置）——此前是安静跳过、不注入任何东西（#84 既有
  // 行为），本次改为注入首次引导正文（不是逐字复述用的开场白），理由见本文件头注释"首次醒来
  // 引导"一节 + docs/first-wake-onboarding/DESIGN.md。issue #106 起：文案算完之后才 claim，
  // 通过 claimAndEmit() 统一处理三条路径的输出方式。
  if (!dbPath) {
    const { renderOnboardingNotConfigured } = await import(path.join(SPIKE_LIB_DIR, "onboarding-greeting.mjs"));
    console.error("[brain-wake-greeting] 身份库未配置（env / .claude/brain.local.json 均未设置），已注入首次引导脚本");
    const text = wrapOnboardingScript(renderOnboardingNotConfigured());
    claimAndEmit({ text, hookEventName, sessionId, pid, standalone });
    return;
  }

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

  // issue #96：状态 B（已配置但空）——dbPath 能解析出来，但 `MemoryStore` 打开一个不存在的文件
  // 不会报错，只会静默建出空 schema（src/context/store.ts createSchema() 用 CREATE TABLE IF NOT
  // EXISTS，已读源码确认）。这个判断必须在调用 gatherGreetingData()/renderGreeting() 之前做——
  // 那条管线本身对空库已经有诚实占位符处理（#84/#88 既有行为，test-greeting.mjs 仍在测），但
  // #96 要的是"空库 = 主动引导"，不是"空库 = 渲染一份大部分是'无'的开场白后沉默"。
  //
  // Zorro/Codex 跨模型二签（2026-07-23）must-fix：`listMemories()` 本身也可能抛错（`store.ts`
  // 的"读方法一律包成 RecallError"约定）——下面这次调用必须包进 try/catch，抛错时也要先
  // `store.close()` 再把错误往外抛（交给 `main().catch()` 的既有 fail-soft 兜底），不能让一个
  // 读失败绕过 store 关闭。状态 C 分支（`gatherGreetingData()`）已经有 `try/finally` 保护，这里
  // 补齐同等保护，不再是不对称的两套标准。
  let memoriesCount;
  try {
    memoriesCount = store.listMemories().length;
  } catch (err) {
    store.close();
    throw err;
  }

  if (memoriesCount === 0) {
    store.close();
    const { renderOnboardingEmptyStore } = await import(path.join(SPIKE_LIB_DIR, "onboarding-greeting.mjs"));
    console.error(`[brain-wake-greeting] 已连上身份库：${dbPath}（当前为空，已注入首次引导脚本）`);
    const text = wrapOnboardingScript(renderOnboardingEmptyStore());
    claimAndEmit({ text, hookEventName, sessionId, pid, standalone });
    return;
  }

  let data;
  try {
    data = gatherGreetingData(store, { currentProjectKey, taskSource });
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
    `再回应任务内容：\n\n${greeting}\n\n${CONDUCTOR_DISPATCH_INSTRUCTION}`;

  claimAndEmit({ text: injected, hookEventName, sessionId, pid, standalone });
}

main()
  .catch(() => {
    /* 绝不阻断：任何失败都吞掉，不打印开场白，不影响会话正常启动 */
  })
  .finally(() => {
    process.exitCode = 0;
  });
