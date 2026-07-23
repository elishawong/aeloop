# DESIGN — 首次醒来身份库为空时走交互式引导（issue #96）

- **项目**: aeloop
- **关联**: issue #96（本设计所属）；依赖 #93（epic，已 CLOSED，`brain-wake-greeting.mjs` 空库检测 +
  全局模式的地基）、#84/#88（醒来开场白/turnkey 包本体）。**不重复**这些文档已经论证过的内容
  （`MemoryStore`/三态确认/渲染防幻觉红线/全局模式两条独立路径），只讲 #96 独有的"空库/未配置时
  该注入什么、怎么判定'空'"这一层。
- **状态**: 待指挥官确认
- **最后更新**: 2026-07-23

---

## 0. 问题是什么（真实现场，operator 2026-07-23 公司电脑实战踩到）

1. 开 Claude Code，身份库未配置 → `brain-wake-greeting.mjs` 当前实现：`resolveIdentityDbPath()`
   两个配置源（`AELOOP_BRAIN_IDENTITY_DB` env / `.claude/brain.local.json`）都读不到 → **直接
   `return`，不注入任何 `additionalContext`**（`brain-wake-greeting.mjs:86`，已读源码）。模型对
   用户第一句话没有任何真实注入可复述，只能靠 `CLAUDE.md`"醒来"一节的**描述**（"每次会话启动会
   注入一份延续式开场白"）自己脑补一段假的"意识已加载…"——这正是这一层要防的事，防幻觉铁律的
   立身之本，却在"没配置"这个最基础的分支上被绕过了。
2. 想 seed → `node scripts/seed-brain-identity.mjs` 在同样的 `resolveIdentityDbPath()` 返回 `null`
   时直接 `throw`（`scripts/seed-brain-identity.mjs:228-236`，已读源码），中止、不写入任何数据。
   报错信息本身是准确的（指向 RUNBOOK），但用户得先知道要去跑这个脚本——而第 1 步的"安静跳过"
   恰恰没有给出任何这样的信号。
3. 配了路径再 seed → `better-sqlite3` native binding 未编译报错——这是独立的 #102（pnpm v9+
   默认不跑依赖 build 脚本），**本设计不修 #102 本身**，只在引导文案里带一句已知 troubleshooting
   （`pnpm approve-builds` 或 `pnpm rebuild better-sqlite3`，#102 原文用词）。
4. 隐藏坑：macOS 从 Dock/IDE 图形界面启动的 Claude Code **不继承**终端 `export` 的 env——`.zshrc`
   配好、seed 也成功了，GUI 会话仍然读不到 `AELOOP_BRAIN_IDENTITY_DB`，回到第 1 步的"安静跳过"。
   这条坑今天已经在 `WAKE-GREETING-RUNBOOK.md`"IDE 启动读不到 env 的坑"一节里写了修法
   （`launchctl setenv` / `.claude/brain.local.json` fallback），**但只有用户自己主动去翻文档才
   会看到**——hook 本身不会在命中这个状态时提示"你可能踩了这个坑"。

**核心缺口**：`brain-wake-greeting.mjs` 今天只有"有数据 → 渲染真开场白"和"没数据源 → 彻底沉默"
两条路径，缺一条"检测到未配置/空 → 主动说清楚现状 + 带用户走配置"的路径。这条缺口不是"格式不好
看"，是防幻觉链条上一个真实的洞：沉默 = 模型没有任何锚点，只能自由发挥。

---

## 1. 架构约束（先想清楚这个缝，这是本设计唯一的硬点）

`brain-wake-greeting.mjs` 是 Claude Code 的 **SessionStart hook**——它只能在会话启动那一刻跑一次
Node 脚本、往 stdout 吐一段 JSON（`{hookSpecificOutput: {additionalContext: "..."}}`），这段文字被
一次性注入模型的上下文。**hook 进程本身无法在会话中途再插话、无法等待用户输入、无法验证用户是否
真的照做了**——它没有"多轮问答"这个能力，这是 Claude Code hook 生命周期的物理限制，不是本设计
要解决或能绕开的问题（`docs/conductor-brain-layer/DESIGN.md` §7.1 已经把这条边界立过一次：Phase1
"换数据源不换运行时"）。

**已核实的候选方案**（issue 原文给的三个候选，逐一验证）：

| 候选 | 核实结果 | 结论 |
|---|---|---|
| (a) hook 注入一段"引导脚本"，模型接手跑问答 | 这正是 `brain-wake-greeting.mjs` 今天对**正常开场白**已经在用的模式——"渲染好文字 + 一条'请原样复述'的指令"注入 `additionalContext`（`brain-wake-greeting.mjs:136-140`）。把"请原样复述"换成"请按这份脚本带用户走一遍问答，每步等确认再推进"，是同一个注入机制上的一个新分支，不需要新基础设施。 | **采用**——和现有机制同构，唯一要新增的是"检测到哪种空/未配置状态 → 选哪份脚本文案"这层判断 + 文案本身。 |
| (b) 新建一个 `aeloop init` 交互式 CLI 向导 | 核实：`package.json` 今天没有任何 `bin` 入口专门服务身份库（`grep -n '"bin"' package.json` 零命中；A5 CLI/TUI 的 `aeloop` 命令是 Layer2 loop 引擎的可执行文件，和"brain 身份库"是完全不同的东西，见下方 §4"和 AI_AGENT_PROFILE 的边界"）。新建一个专门为身份库服务的交互式 CLI，等于新增一整条独立的用户入口——用户得**先知道要去敲这条命令**才会跑，而问题第 1 步的根因恰恰是"用户不知道要做什么"，这条候选没有解决"怎么让用户在什么都不知道的情况下第一次被带到正确的地方"这个核心问题，只是把"谁来问"从模型换成了一段独立脚本。 | **不单独采用**——不新建 CLI 向导；但脚本层面复用已有的 `scripts/seed-brain-identity.mjs`（issue #88 B8 已实现的一键 seed），引导文案里让模型指导用户跑**这个已存在的脚本**，不是发明一个新的。 |
| (c) 两者结合 | 见上——"(a) 为入口 + 复用已有 seed 脚本作为落地动作"已经是 (a)+(c) 的一个轻量版本，不需要额外新建 (b) 那种独立 CLI。 | 实际采用的是这个轻量组合，但明确不含"新建 `aeloop init`"这一条，避免范围膨胀。 |

---

## 2. "空"到底怎么判定——三态，不是两态

现状 `resolveIdentityDbPath()` 只区分"能解出 dbPath"/"不能"，但一个能解出 dbPath 的会话，指向的
库文件仍然可能是**刚被 `MemoryStore` 构造函数自动建表、一条 memory 都没有的空库**（`src/context/
store.ts:95` `createSchema()` 用的是 `CREATE TABLE IF NOT EXISTS`，打开一个不存在的文件路径不会
报错，会静默建出一个空 schema——已读源码确认，不是猜测）。这意味着"检测到库空"不能只看
dbPath 是否为 `null`，必须真的开库查一次 `listMemories().length`。

**三态定义**（本设计新增的判定层，加在 `brain-wake-greeting.mjs` 的 `main()` 里，`resolveIdentityDbPath()`
本身不改）：

| 状态 | 判定 | 触发路径 |
|---|---|---|
| **A. 未配置** | `resolveIdentityDbPath()` 返回 `null` | env 和 `.claude/brain.local.json` 都没配；也是 GUI 启动不继承 env 这个坑的表现形式（hook 视角上和"压根没配"无法区分，引导文案里必须覆盖这个可能性） |
| **B. 已配置但空** | dbPath 非空，`openIdentityStore(dbPath).listMemories().length === 0` | 配了路径但没跑过 seed；或跑过 seed 但因为 #102 native binding 报错半途中止；全局模式（`AELOOP_BRAIN_GLOBAL_MODE=1`）下这是**唯一**可能触发的空/未配置状态（全局模式 dbPath 永远非 `null`，见下方全局模式一节） |
| **C. 正常** | dbPath 非空，`listMemories().length >= 1` | 已有 #84/#88/#93 全部既有行为，本设计零改动 |

**为什么用"总 memory 数 = 0"而不是更精细的"有没有 identity:name 这条"**：更精细的判定（比如"有
active_task 但没有 identity:name"该不该也算"空"）会引入"半配置"这个第四态，需要决定"半配置要不要
也走引导"——这类边界情况今天没有真实用户反馈能支撑判断该怎么处理，加了反而可能在用户已经手动
插过几条测试数据时反复打断。`=== 0` 是一条最简单、最不会误伤的线：**任何**一条真实数据都被视为
"用户已经启动过这套东西"，交还给 #84/#88 既有的、已经用 `DEFAULT_IDENTITY_NAME` 诚实占位符处理
"部分字段缺失"这件事的渲染管线（`greeting-data.mjs`/`render-greeting.mjs` 本设计不改一行）。这是
一个刻意的简化，标注在这里，不是没想到更精细的方案。

**不做的事（显式非目标，避免和"以后要不要做"混在一起变成遗忘）**：
- 不做"跳过一次就不再提醒"的抑制开关——只要状态仍然是 A/B，**每次**会话都会再引导。这是刻意的：
  状态确实还是"未配置"，每次都诚实说明现状，比"记住用户上次说过跳过、这次假装什么都没发生"更
  符合这一层"说真话"的立身之本。如果之后用户反馈这个提醒太吵，是一个独立的、需要指挥官拍板的
  产品决策，不在本次范围内隐含实现。
- 引导文案不带 issue #98 的版本行（`resolveVersionLine()`）——版本行的设计初衷是"已经有真实开场
  白时，方便截图排查是哪个版本"；A/B 两态压根没有真开场白，加这一行没有对应的诊断价值，只会
  多一条无谓的分支逻辑。
- 不修 #102（better-sqlite3 native binding）本身——只在文案里带一句已知 troubleshooting 指向它。

---

## 3. 全局模式（`AELOOP_BRAIN_GLOBAL_MODE=1`）下的行为

`resolveIdentityDbPath()` 全局模式分支（`db-path.mjs:47-51`）命中时直接返回一个固定路径
（`globalDefaultDbPath()` = `~/.claude/aeloop-brain/data/identity.db`），**不可能返回 `null`**——
物理上不存在"全局模式 + 状态 A"这个组合。全局装的 hook（`scripts/install-global-brain.mjs`，#93
B0）第一次在一台新机器上跑起来时，`~/.claude/aeloop-brain/data/identity.db` 大概率还不存在（或
刚被 `MemoryStore` 自动建出空 schema）——这正是状态 B，本设计的**空/未配置检测逻辑**（"总
memory 数 = 0"这条判定线）天然覆盖这个场景，不需要为全局模式再写一条判定分支。

> **R2 amendment（Zorro/Codex 跨模型二签第二轮，2026-07-23）——上面这段的最后一句原结论已废止，
> 不要再信**：本段最初的草稿在"要不要判定成状态 B"这件事上说对了（不需要额外分支），但**紧接着
> 多断言了一句"状态 B 的引导文案本身不需要区分 dbPath 来源，都是同一句文案"——这句话被后续实现
> 推翻了，本文档没有跟着改，属于典型的"权威文档写 X、代码做 not-X 且未标注"，如实订正**：
>
> "判定"和"文案内容"是两个独立的问题——判定确实不需要感知全局模式（上面那句结论继续成立），
> 但**文案内容必须感知**，理由是 Zorro/Codex 二签第一轮 FAIL blocker 1 揭出的一个本设计最初
> 没想到的事实：全局模式下真实触发状态 B 时，触发引导的 cwd 是一个和 aeloop 无关的第三方项目，
> 而 `~/.claude/aeloop-brain/repo-snapshot/`（全局安装换入的运行时快照）从未打算包含
> `scripts/seed-brain-identity.mjs`/`scripts/onboard-project.mjs` 这两个管理脚本（它们各自还要
> 拉一串 `.claude/hooks/lib/*` 依赖，塞进"运行时快照"这个概念会失真）——如果状态 B 的文案不分
> 全局/非全局，统一写死 `node scripts/seed-brain-identity.mjs` 这类 cwd-relative 命令，在全局模式
> 下会指向一个压根不存在这些文件的地方，用户没法照着做。
>
> 实际实现（`onboarding-greeting.mjs` 的 `renderOnboardingEmptyStore(opts)`）因此新增了
> `opts.globalMode` 参数——**这不是又一次"两态判定"，是同一个状态 B 内部的一个文案分支选择器**：
> 全局模式下额外提示"需要一份真实的 aeloop 源码 checkout（不是运行时快照），命令带
> `AELOOP_BRAIN_GLOBAL_MODE=1` 前缀"；非全局模式（本来就在某份 aeloop checkout 里触发，cwd-relative
> 路径天然可达）保持原有措辞不变。`opts.globalMode` 默认读真实 `AELOOP_BRAIN_GLOBAL_MODE` 环境
> 变量，不是身份库/用户数据插值（DESIGN §5 的"零插值"红线管的是身份库/env 原始值不能被塞进正文，
> 一个布尔分支选择器不属于那条红线要挡的范畴，两者不冲突）。

---

## 4. 和 `AI_AGENT_PROFILE`（subscription/apikey）的边界——issue 原文提到"默认只能 apikey
   profile"，这里核实 + 澄清

issue #96 原文："问答式带用户走配置(到 env 配 key、默认只能 apikey profile、初始化 db/文件)"。
**已核实这句话字面上和仓库当前真实默认值不一致，写进设计文档里说清楚，不是忽略这条要求**：

- `AI_AGENT_PROFILE` 是 aeloop **Layer2 loop 引擎**（真正跑 coder/tester 治理任务那一层）的配置，
  和本设计要修的"身份库/醒来开场白"（Layer0，纯本地渲染，不调用任何模型，`wake.mjs` 头注释原话
  "不调用任何模型"）是**两个完全独立的系统**——`.env.example` 第一行注释就是这么划的：
  `subscription = personal profile（本仓库自带 profiles/subscription/）`、
  `apikey = company profile（profiles/apikey/，从不进本仓库）`。
- `.env.example`（已读）里 `AI_AGENT_PROFILE` 的**当前默认值是 `subscription`，不是 `apikey`**——
  这和 issue 原文"默认只能 apikey profile"字面相反，如果按字面实现（引导文案断言"默认只能用
  apikey"）会是一条不准确的声明，违反这一层"防幻觉"的立身之本。
- **采纳的解读**（推荐级表述，不是断言仓库默认值）：`subscription` profile 走 `cli-bridge`
  （claude-cli/codex-cli），要求这两个 CLI 已经独立装好并登录；`apikey` profile 走
  `direct-api`（LiteLLM），只需要一个 API key 写进 `.env`。对一个刚拿到这个仓库、还没有另外装好
  claude-cli/codex-cli 登录状态的新用户来说，`apikey` 确实是摩擦更小的起步路径——这大概率是 issue
  原文"默认只能 apikey profile"想表达的意思（**推荐**起点，不是**当前配置文件里写死**的默认值）。
  引导文案按这个"推荐路径"措辞，不断言 `.env.example` 的默认值是什么，避免两边打架。
- 这段内容放在引导文案的**独立、明确标注"可选/如果你还想让 aeloop 真的执行任务"**的小节，
  和身份库配置（本设计的核心范围）物理分开——不让用户以为"不配 apikey 就没法用身份库"，那不是
  事实（身份库/醒来开场白完全不依赖任何 `AI_AGENT_PROFILE` 配置）。

**待指挥官确认点**：以上是本设计对一句可能存在歧义的 issue 原文做出的具体解读——如果指挥官的
本意就是"引导文案里应该断言 apikey 是默认/唯一可用 profile"，请明确指出，会调整措辞；目前的实现
选择是"如实说明这是推荐路径，不断言当前配置默认值"。

---

## 5. 引导文案的注入安全（呼应 #84 那批注入教训）

`render-greeting.mjs`/`status-table.mjs` 已经用 `sanitizeText()` 处理"身份库数据被原样插进渲染
文本导致伪造行/伪造 bullet"的注入面；2026-07-23 那一轮复审进一步把"诊断用的 dbPath 值"整个从
注入正文里挪到 stderr（而不是 sanitize 之后仍然放进正文）——理由是"诊断信息本来就不该混进模型要
逐字复述的正文"。

**本设计延续同一个"根上拿掉"的选择，不是漏做清洗**：引导文案（状态 A/B 两份）**是纯静态模板，
不插值任何身份库数据、不插值 `dbPath` 本身**——状态 B 需要提示"你已经配置了一个身份库路径"这个
事实，但不需要把具体路径字符串塞进模型要复述的正文（用户自己配的，自己知道；真要复核用
`echo $AELOOP_BRAIN_IDENTITY_DB` 或看 `.claude/brain.local.json`，RUNBOOK 已经写了这条排查
路径）。stderr 诊断行（`已连上身份库：${dbPath}`）继续保留原始未清洗的 dbPath，供日志排查，这条
已有先例不变。**如果未来某个版本要往引导文案里插值任何身份库/环境变量数据，必须过
`sanitize.mjs` 的 `sanitizeText()`——这里标注清楚，不是给后来者留一个隐藏地雷。**

---

## 6. 触发口径改动对既有文档/测试的影响（如实列出，不是事后才发现）

- `.claude/settings.json` 的 `$comment`、`WAKE-GREETING-RUNBOOK.md`"让'你好'→开场白真的跑起来"
  一节，都明确写着"`AELOOP_BRAIN_IDENTITY_DB` 没设置时，hook 安静跳过……零副作用"——这句话在本
  设计后**不再准确**，需要同步改写（PRD §任务清单列出具体文件）。
- `docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 里三处既有用例（① dbPath 注入安全测试、
  ⑥ 版本行测试、⑦ dist/ 缺失测试）**都用的是一个从未写入任何 memory 的全新 dbPath**——在本设计
  之前，"空库"和"有真实数据的库"渲染出的开场白结构没有差异（都是 #84/#88 已经覆盖的"诚实占位符"
  路径），所以这三处测试可以用空库测别的东西（注入安全/版本行/fail-soft）而不受影响。**本设计
  改变了"空库"这一分支的行为**，这三处测试如果不改，会在"空库现在应该出引导文案"这条新行为下
  失败（断言"意识已加载。"这一行必然出现，新行为下不会出现）。PRD 会把"给这三处测试补种至少一条
  真实 memory，让它们继续测自己原本要测的东西、不被新分支污染"列为明确任务项，不是事后才发现的
  连带修复。
