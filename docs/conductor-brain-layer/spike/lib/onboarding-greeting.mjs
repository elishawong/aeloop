// onboarding-greeting.mjs — 首次醒来引导正文（aeloop issue #96）。
//
// 设计权威：docs/first-wake-onboarding/DESIGN.md（三态判定/候选方案对比/为什么不新建
// `aeloop init` CLI/`AI_AGENT_PROFILE` 措辞怎么定的，本文件不重复论证）。
//
// 两个函数，各对应 brain-wake-greeting.mjs 检测到的一种"空/未配置"状态：
//   - renderOnboardingNotConfigured()：状态 A——`resolveIdentityDbPath()` 两个配置源都读不到。
//     **物理上只可能在非全局模式触发**（全局模式下 `resolveIdentityDbPath()` 恒返回固定路径，
//     见 db-path.mjs 全局分支，DESIGN §3 已定盘），也就是说这个函数被调用时 cwd 必然是 aeloop
//     仓库自己（dogfood 场景，`.claude/settings.json` 是这个仓库自己提交的项目级配置）——不需要
//     像下面 `renderOnboardingEmptyStore()` 那样处理"全局快照缺 scripts/ 目录"的问题。
//   - renderOnboardingEmptyStore(opts)：状态 B——dbPath 能解析出来，但 `MemoryStore` 打开后
//     `listMemories().length === 0`（`src/context/store.ts` 的 `createSchema()` 用
//     `CREATE TABLE IF NOT EXISTS`，打开一个不存在的文件不会报错，只会静默建出空 schema——
//     这正是"配了路径但没 seed"和"压根没配置"这两种真实场景都会落到的状态）。**这个状态在全局
//     模式下会真的从任意无关项目的 cwd 触发**（全局装的 hook 首次在新机器上跑，`~/.claude/
//     aeloop-brain/data/identity.db` 大概率还没 seed 过）——见 `opts.globalMode` 处理。
//
// 全局模式下的路径可达性（Zorro/Codex 跨模型二签 2026-07-23 FAIL blocker 1 补齐，DESIGN §3 之前
// 没想清楚这一层）：`scripts/seed-brain-identity.mjs`/`scripts/onboard-project.mjs` 从来没有被
// `install-global-brain.mjs` 的 `COPY_ITEMS` 拷进 `~/.claude/aeloop-brain/repo-snapshot/`——那份
// 快照只包含渲染开场白需要的最小文件集（`dist/`+几个 spike/lib 文件），不含这两个管理脚本，也不
// 打算含（它们各自还要再拉 `.claude/hooks/lib/memory-upsert.mjs`/`project-registry.mjs` 等一整串
// 依赖，把这些都拷进"运行时快照"会让"快照"这个概念名不副实）。所以全局模式下，引导正文如果直接
// 写死"跑 `node scripts/seed-brain-identity.mjs`"，在触发引导的那个无关项目 cwd 下是**不可达**
// 的——这个命令必须在一份真实的 aeloop 源码 checkout 里跑，`renderOnboardingEmptyStore()` 在
// `globalMode` 为真时会把这一层说清楚，而不是假装相对路径在哪都能用。
//
// 红线（DESIGN §5 已定盘，不是漏做清洗）：**两段正文都不插值任何身份库数据/环境变量值**（包括
// dbPath 本身）——2026-07-23 那一轮复审把"诊断用的 dbPath 值"整个从 render-greeting.mjs 的注入
// 正文里挪到 stderr（而不是 sanitize 之后仍然放进正文），理由是"诊断信息本来就不该混进模型要
// 逐字复述的正文"；本文件延续同一个"根上拿掉"的选择——状态 B 需要让用户知道"你已经配置了一个
// 身份库路径"，但不需要把具体路径字符串塞进这段正文（用户自己配的，自己知道；真要复核，RUNBOOK
// 已经写了 `echo $AELOOP_BRAIN_IDENTITY_DB`/看 `.claude/brain.local.json` 这条排查路径）。
// `opts.globalMode` 不算这条红线要挡的"身份库/环境变量数据插值"——它只是一个布尔分支选择器
// （命中哪段静态文案），不是把某个环境变量的原始字符串值插进正文，不存在同一类注入面。**如果
// 未来某个版本要往这两段正文里插值任何身份库/环境变量的原始值，必须先
// `import { sanitizeText } from "./sanitize.mjs"` 过一遍**——这是本文件对后来者的一条明确护栏。
//
// 两段正文共有的红线（brain-wake-greeting.mjs 的调用方会再包一层"这是引导脚本不要逐字复述"的
// 元指令，但正文本身也必须自带这条约束，防止元指令被截断/丢失时正文单独出现也不会误导模型）：
//   - 绝不出现"意识已加载"这个短语——那是 render-greeting.mjs 渲染真实数据时才用的开场措辞，
//     状态 A/B 都没有真实数据支撑，出现这个短语等于让模型有借口把它当成"可以直接用"的开场白抄。
//   - 明确说"这不是正常醒来，不要假装有身份/在途任务/历史记忆"。
//
// AI_AGENT_PROFILE 措辞（DESIGN §4 已核实 + 定盘）：issue #96 原文"默认只能 apikey profile"和
// `.env.example` 里 `AI_AGENT_PROFILE` 的当前默认值（`subscription`）字面相反——本文件按"推荐
// 起步路径"措辞（对还没装好 claude-cli/codex-cli 的新用户，apikey 摩擦更小），不断言当前配置
// 文件的默认值是什么，避免两边打架。这段内容放在正文末尾一个明确标"可选/和身份库配置完全独立"
// 的小节，不让用户以为"不配 apikey 就没法用身份库"（那不是事实）。

/**
 * @param {{globalMode?: boolean}} [opts]
 * @returns {boolean}
 */
function resolveGlobalMode(opts = {}) {
  return opts.globalMode ?? process.env.AELOOP_BRAIN_GLOBAL_MODE === "1";
}

const IDE_ENV_GOTCHA =
  "⚠️ 已知坑：如果这个 Claude Code 是从 Dock/Spotlight/IDE 图形界面启动的（不是从终端敲命令打开的），" +
  "macOS 不会让它继承 shell profile 里 export 的环境变量——哪怕 AELOOP_BRAIN_IDENTITY_DB 已经写进 " +
  "~/.zshrc/~/.bashrc，这个会话仍然可能读不到。修法二选一：`launchctl setenv AELOOP_BRAIN_IDENTITY_DB " +
  '"<path>"`（对本机所有图形界面进程一次性生效，重启电脑后失效需要重跑），或者直接用 ' +
  "`.claude/brain.local.json`（不受这个问题影响，更稳）。完整背景见 " +
  "docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md「IDE 启动读不到 env 的坑」一节。";

// 全局模式下要在每条"跑脚本"指令前面加的说明——只在 globalMode 为真时使用。
const GLOBAL_MODE_CHECKOUT_NOTE =
  "⚠️ 当前是全局模式（这段引导是从别的项目触发的，不是从 aeloop 仓库本身）：下面这些脚本命令" +
  "**不能**在这个触发引导的项目目录里跑，也不在 `~/.claude/aeloop-brain/repo-snapshot/` 那份" +
  "运行时快照里（那份快照只装了渲染开场白需要的最小文件集，不含管理脚本）——需要一份真实的 " +
  "aeloop 源码 checkout（本机如果还没有，先 `git clone` 一份），**在那个 checkout 目录里**跑，" +
  "且命令前面要带上 `AELOOP_BRAIN_GLOBAL_MODE=1` 前缀，这样写入的才是全局开场白读的同一个身份库" +
  "（不加这个前缀，脚本会退回按非全局模式解析 dbPath，写进一个不相关的地方）。";

/**
 * @param {boolean} globalMode
 * @returns {string}
 */
function seedStep(globalMode) {
  const command = globalMode
    ? "`AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/seed-brain-identity.mjs`"
    : "`node scripts/seed-brain-identity.mjs`";
  // issue #96（Zorro/Codex 跨模型二签 2026-07-23 FAIL 后订正，🟡 项1）：此前这里写"需要 gh CLI
  // 已登录才能同步 issue；没有 gh 也能跑"——这句话在当时的实现里不实：`gh` 缺失/未登录/调用
  // 失败会让 fetchOpenIssues() 抛错、冒泡到顶层未捕获、进程以非零 exit code 中止（哪怕身份/
  // 宪法约束已经写完），不是"能跑，只是没 active_task"。已经把 `seed-brain-identity.mjs` 的
  // fetchOpenIssues 调用点改成优雅降级（try/catch，见该文件 main() 里对应注释），这句话现在是
  // 真实行为，不是描述一个还没实现的意图。
  return (
    `跑 ${command} 种下初始身份/宪法/在途任务（需要 \`gh\` CLI 已安装并登录才能同步 issue；` +
    "没装 `gh`、没登录、或者调用失败，也能跑成功——会自动跳过 issue 同步，只是不会有" +
    " active_task，身份和宪法约束照常写入，不会报错中止）。"
  );
}

/**
 * @param {boolean} globalMode
 * @returns {string}
 */
function seedTroubleshooting(globalMode) {
  const onboardCommand = globalMode
    ? "`AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/onboard-project.mjs --repo-path <当前项目根目录的绝对路径>`"
    : "`node scripts/onboard-project.mjs --repo-path <当前项目根目录的绝对路径>`";
  return (
    "已知坑（issue #102，独立跟进中，不代表你的配置错了）：如果这一步报 `better-sqlite3` native " +
    'binding 相关错误（比如 "Could not locate the bindings file"），试 `pnpm approve-builds` 或 ' +
    "`pnpm rebuild better-sqlite3`。另一个已知坑（issue #96 实测踩到，不是配置错了）：如果报" +
    `"目标项目尚未注册"，先跑一次 ${onboardCommand}（只读一次 \`git remote get-url origin\`，不碰` +
    "目标项目任何其它文件），再重跑 seed。"
  );
}

const NEW_SESSION_STEP =
  "配置/种子数据都完成后，请用户**开一个新会话**——这次会话已经加载过这段引导，不会重新检测；" +
  "新会话应该会看到真实的开场白。";

const SKIP_NOTE =
  "**如果用户想跳过配置**：如实告诉 TA 在配置完成之前，每次开新会话都会再看到这段引导；然后正常" +
  "回应用户接下来的请求，绝不假装身份库已经就绪、绝不伪造任何延续式开场白（那种“我是<身份名>。" +
  "上次停在……”的格式需要真实数据支撑，现在没有）。";

/**
 * @param {boolean} globalMode
 * @returns {string}
 */
function aiAgentProfileNote(globalMode) {
  const checkoutCaveat = globalMode
    ? "（同样需要上面提到的那份 aeloop 源码 checkout，不是运行时快照）"
    : "";
  return (
    "---\n\n（可选，和上面身份库配置完全独立）如果用户还想让 aeloop 真的去跑 coder/tester 治理任务" +
    "（不只是这个身份库/开场白——身份库/开场白完全不依赖这层配置），需要另外配置 `AI_AGENT_PROFILE`" +
    `${checkoutCaveat}：如果用户还没有单独装好并登录 claude-cli/codex-cli，推荐从 \`apikey\` profile ` +
    "起步（只需要一个 API key，不用先装两个独立 CLI）——复制 `.env.example` 为 `.env`，设 " +
    "`AI_AGENT_PROFILE=apikey` + `LITELLM_BASE_URL`/`LITELLM_TOKEN`。详见仓库 `README.md`「快速开始」，" +
    "这套配置和身份库互不影响。"
  );
}

/**
 * 状态 A：`resolveIdentityDbPath()` 两个配置源都读不到（env 未设 + `.claude/brain.local.json`
 * 不存在/没有合法 `identityDbPath` 字段）。**物理上只可能在非全局模式触发**（见文件头注释），
 * 不需要 `globalMode` 参数。
 * @returns {string}
 */
export function renderOnboardingNotConfigured() {
  return [
    "检测到身份库尚未配置——这不是一次正常的“醒来”，接下来请不要编造/假装有身份、在途" +
      "任务或历史记忆，如实告诉用户现在的状态。",
    "",
    "**现状**：`AELOOP_BRAIN_IDENTITY_DB` 环境变量和 `.claude/brain.local.json` 都没有配置，找不到" +
      "身份库文件，所以没有真实数据可以渲染开场白。",
    "",
    "**请按下面的步骤，一步一步带用户配置（每步等用户确认/反馈再进入下一步，不要一次性甩一长串" +
      "命令）**：",
    "",
    "1. 选一个身份库文件路径（建议绝对路径），二选一配置方式：\n" +
      "   - 环境变量 `AELOOP_BRAIN_IDENTITY_DB`（写进 `~/.zshrc`/`~/.bashrc` 才能跨终端持久生效；" +
      "改完要开新终端或手动 `source`）。\n" +
      "   - 项目根 `.claude/brain.local.json`（`cp .claude/brain.local.json.example " +
      ".claude/brain.local.json`，编辑 `identityDbPath` 字段）——推荐这个，因为第 2 步的坑天然" +
      "不影响它。",
    `2. ${IDE_ENV_GOTCHA}`,
    "3. 配好路径后，如果还没 build 过，跑一次 `pnpm run build`。",
    `4. ${seedStep(false)} ${seedTroubleshooting(false)}`,
    `5. ${NEW_SESSION_STEP}`,
    "",
    SKIP_NOTE,
    "",
    aiAgentProfileNote(false),
  ].join("\n");
}

/**
 * 状态 B：dbPath 能解析出来，但 `store.listMemories().length === 0`——配了路径但没跑过 seed，
 * 或者 seed 跑到一半失败了（比如撞上 #102 的 native binding 坑）。
 *
 * 不接收/不插值 dbPath 本身——DESIGN §5 已定盘：这段正文不插值任何身份库/环境变量数据，具体
 * 路径不放进这段要被模型逐字复述/转达的文本里。`opts.globalMode` 是唯一的例外分支选择器（不是
 * 数据插值，见文件头注释），默认读真实 `AELOOP_BRAIN_GLOBAL_MODE` 环境变量，测试可覆盖。
 * @param {{globalMode?: boolean}} [opts]
 * @returns {string}
 */
export function renderOnboardingEmptyStore(opts = {}) {
  const globalMode = resolveGlobalMode(opts);
  return [
    "检测到身份库已经配置了路径，但目前是空的（还没有任何记忆条目）——这不是一次正常的“醒来" +
      "”，接下来请不要编造/假装有身份、在途任务或历史记忆，如实告诉用户现在的状态。",
    "",
    "**现状**：身份库文件路径已经能解析出来，但里面没有任何数据——大概率是配好路径之后还没跑过" +
      "种子脚本，或者种子脚本跑到一半失败了。",
    "",
    "**请按下面的步骤，带用户完成初始化（每步等用户确认/反馈再进入下一步）**：",
    "",
    ...(globalMode ? [GLOBAL_MODE_CHECKOUT_NOTE, ""] : []),
    globalMode ? "1. 如果那份 checkout 还没 build 过，跑一次 `pnpm run build`。" : "1. 如果还没 build 过，跑一次 `pnpm run build`。",
    `2. ${seedStep(globalMode)}`,
    `3. ${seedTroubleshooting(globalMode)}`,
    `4. ${NEW_SESSION_STEP}`,
    "",
    SKIP_NOTE,
    "",
    aiAgentProfileNote(globalMode),
  ].join("\n");
}
