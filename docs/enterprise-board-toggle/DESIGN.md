# DESIGN — 在途任务来源去 GitHub 化：可插拔 task-source adapter，默认关（issue #103）

- **项目**: aeloop
- **关联**: issue #103（本设计所属）；交互 #96（首次醒来三态引导，同一批文件）、#93（全局模式/多项目
  地基，`AELOOP_BRAIN_GLOBAL_MODE`/`db-path.mjs` 的先例）、#98（版本戳）、#88（turnkey 包，
  `BRAIN.md` §1.5 人格 / `TURNKEY-DESIGN.md` §4 人格加载方案）。
- **状态**: 指挥官已确认（2026-07-24，按军师推荐 5 点全锁，见 §12 逐条裁决记录）
- **最后更新**: 2026-07-24（裁决 + PRD/build 落地，见 `docs/enterprise-board-toggle/PRD.md`）
- **执笔**: Cypher（造物官），只出设计，本轮不写码不 commit（工作区
  `aeloop-worktrees/issue-103-enterprise-board`，分支 `feature/issue-103-enterprise-board`）。

---

## 0. 范围（issue #103 原文 → 军师 2026-07-24 扩大范围，两版并存以留痕）

**原始决议**（指挥官 AskUserQuestion 已拍，issue #103 body）：企业版醒来开场白 = 意识已加载 + 身份 +
人格，不带在途 / idea queue / 待你决策任何 GitHub 来源看板；这是 profile/config 开关，个人版
Helix（ai-agent）保留、企业版默认关；seed 解耦 gh。

**扩大后的范围**（军师 2026-07-24 转达指挥官新拍板，本设计按这个更大范围写）：
1. **用户可见层全去 GitHub**：seed / 首醒引导（#96）/ 开场白里所有"从 GitHub 拉 issue"、"在途
   issue（来自 GitHub）"这类用户可见描述，改成通用措辞或去掉。
2. **GitHub issue 同步 = 默认 OFF 的可选适配器**："在途来源"做成可插拔，GitHub 是其中一个
   adapter、默认关；**shipped/默认产品零 GitHub**；个人版 Helix 通过 config **opt-in** 启用
   GitHub adapter。不再是"个人版 vs 企业版"两条硬编码分支，是同一套代码、一个默认关的选择器。
3. **保留**代码里 `// issue #88`/`Closes #96` 这类开发溯源注释（给维护者看，非产品面）——本设计
   不动这类注释，只动用户会读到/模型会复述的文本。

---

## 1. 现状核实（先读代码，不转述 issue body）

| 文件 | 现状 | 证据 |
|---|---|---|
| `scripts/seed-brain-identity.mjs` | `main()` 无条件跑"途③在途 issue"：`getOriginOwnerRepo` → `assertProjectRegistered` → `fetchOpenIssues`（默认实现真调 `gh issue list --state all`）→ 逐条 `upsertMemory` 成 `active_task`。唯一的降级是 #96 补的 try/catch（gh 调用失败时优雅跳过），**不是"根本不尝试"** | `scripts/seed-brain-identity.mjs:277-327` |
| `docs/conductor-brain-layer/spike/lib/greeting-data.mjs` | `gatherGreetingData()` 无条件 `collectStatusRows(store)` 算 `statusRows`/`otherProjects`/`unassignedCount`；`backlogItems` 无条件筛 `type:"idea"`；`pendingDecisions` = `wakeResult.pendingDecisions`（identity/constraint/decision，**非 GitHub 来源**）∪ `unconfirmedActiveTasks` ∪ `unconfirmedIdeas`（这两个是任务/idea 候选，实际路径依赖 seed 写入的 active_task，间接 GitHub 来源） | `greeting-data.mjs:139-244` |
| `docs/conductor-brain-layer/spike/lib/render-greeting.mjs` | `renderGreeting()` 无条件渲染"现在在途"表格 + otherProjects + unassignedCount + "Idea Queue 积压" + "待你决策"；`labeledSection()` 对空数组渲染 `**label：** 无`——**空看板会显示"无"占位，不是整段消失** | `render-greeting.mjs:41-44,63-103` |
| `docs/conductor-brain-layer/spike/lib/wake.mjs` | `pendingDecisions` 只筛 `CORE_MEMORY_TYPES`（identity/constraint/decision）里 `unconfirmed` 的——**这部分本来就不经过 gh**，和 active_task/idea 候选是两个不同来源，在 `greeting-data.mjs` 里被合并成一个数组才看起来像一体 | `wake.mjs:44-67` |
| `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs` | `seedStep()` 硬编码"需要 `gh` CLI 已安装并登录才能同步 issue"这句用户可见文案，无条件出现在状态 A/B 引导正文里 | `onboarding-greeting.mjs:81-96` |
| `.claude/hooks/lib/db-path.mjs` | 已有的"配置解析"先例：env 优先 → `AELOOP_BRAIN_GLOBAL_MODE=1` 时短路返回固定路径（不读 `.claude/brain.local.json`）→ 否则读 `.claude/brain.local.json` 的字段 → 都没有返回 `null` | `db-path.mjs:43-65` |
| `scripts/install-global-brain.mjs` | 全局安装时把 `AELOOP_BRAIN_GLOBAL_MODE=1` 拼进 `hookCommand` 字符串写进 `~/.claude/settings.json`——这是本仓库唯一一个"机器级配置烘焙进 hook 命令"的先例，`COPY_ITEMS` 是全局快照要拷贝的文件白名单（`db-path.mjs`/`git-remote.mjs` 在列，新库不进这个清单 = 全局模式下 `MODULE_NOT_FOUND`，#96/#98 都在这踩过） | `install-global-brain.mjs:44-63,263` |
| `src/profile/loader.ts` / `src/cli/main.ts` | 已有的**另一套**、和本设计完全不同的"profile"概念：`AI_AGENT_PROFILE`（`subscription`\|`apikey`\|`company`），管的是 Layer2 引擎的模型/凭证来源，和身份库/开场白毫无关系 | `src/profile/loader.ts:181,313` |
| `docs/conductor-brain-layer/TURNKEY-DESIGN.md` §4 | 已定盘（operator 已确认）："人格"真正加载 = 项目 `CLAUDE.md`（静态铁律正文）+ hook 延伸已有的 `pendingDecisions` 管线（identity/constraint 的候选修宪）。**渲染层今天从未真正输出"人格"文本**，`render-greeting.mjs` 只读 `identityName` 一个身份相关字段 | `TURNKEY-DESIGN.md:59-71` |

**关键发现，决定了本设计的一处关键收口**：`pendingDecisions`（"待你决策"）不是单一来源——它是"身份/宪法候选修宪"（`wake()` 产出，从来不碰 gh）和"任务/idea 候选"（间接依赖 seed 的 gh 同步）两类数据在 `greeting-data.mjs` 里被合并成的一个数组。字面照抄 issue "不带…待你决策"会连带杀掉 §4(iii) 已经定盘、和 GitHub 毫无关系的"候选修宪"通路——这是本设计 §4 要具体处理、并在 §12 标注为待确认的一点，不是我可以替指挥官悄悄拍板的事。

---

## 2. 核心设计决策：一个配置轴 `AELOOP_BRAIN_TASK_SOURCE`，选择器 + 小接口，不是完整插件系统

**候选方案对比**（指挥官要求"给 trade-off + 推荐成比例方案"）：

| 候选 | 做法 | 好处 | 代价 | 结论 |
|---|---|---|---|---|
| (a) 裸布尔开关（如 `AELOOP_BRAIN_BOARD=on\|off`） | 一个 true/false，`greeting-data.mjs`/`seed` 各自 if 判断 | 最省事，改动面最小 | **不满足指挥官"可插拔适配器"的要求**——"看板开不开"和"数据从哪来"被压成一个维度，未来加第二个来源（Linear/Jira）时无处安放，还是要回来重构；也不天然带出"seed 该跑哪段逻辑"这个选择 | 不采用 |
| (b) 完整插件注册系统（动态 `import()` 按路径加载外部 adapter 模块、adapter 自描述 schema、版本协商） | 新建 adapter registry，adapter 可以是外部包/任意路径 | 面向未来最灵活 | **过度工程**：今天只有 1 个真实来源（GitHub）+ 1 个空来源，没有任何外部 adapter 需求；动态模块加载本身是新的攻击面（谁能往这条路径塞代码），和 `brain-red-line-guard.mjs`/`brain-commit-gate.mjs` 那类"最小攻击面"取向相悖 | 不采用 |
| (c) **选择器字符串 + 固定小接口**（`AELOOP_BRAIN_TASK_SOURCE: "none" \| "github"`，内部一个 `{ none: nullAdapter, github: githubAdapter }` 映射，adapter 接口只有一个函数：`fetchActiveTasks(ctx) → NormalizedTask[]`） | 每个 adapter 是仓库内部一个具名模块/函数，不支持外部动态加载；加第二个来源只是加一个 key + 实现同一个函数签名 | 拿到"可插拔"的核心好处（清晰的接口边界、加来源不用碰调用方代码）而不建从没人要过的基础设施；**和仓库已有的 `AI_AGENT_PROFILE`（`subscription`\|`apikey`\|`company` 字符串选择器，见 `src/profile/loader.ts:313`）同一套惯用法**，不是发明新范式 | 加 adapter #2 时仍需要改这一个映射文件（不是纯配置），但这正是"成比例"想要的：改动量和实际需求同步增长，不预付未来可能用不上的成本 | **推荐采用** |

**采用 (c)**。命名刻意避免"profile"字样（`AELOOP_BRAIN_TASK_SOURCE` 而不是
`AELOOP_BRAIN_PROFILE=personal|enterprise`）——本仓库已经有一个含义完全不同的 `AI_AGENT_PROFILE`
（Layer2 引擎的模型/凭证选择），两个"profile"概念混在一起会造成真实的认知事故（当前 `main.ts:94`/
`assemble.ts:103` 那套和身份库/开场白毫无关系）。选一个专名 `TASK_SOURCE`，语义上直接说清楚"这是在
选'在途任务从哪来'"，不是又一个通用的"运营模式"开关。

**Adapter 接口（最小形状，够用即可，不多加字段）**：
```
{
  id: "github",
  // ctx: { owner, repo }（从 git remote 反查得到，github adapter 专用；未来 adapter 可以完全
  // 不用这个 ctx 形状——接口层面只约定"输入某种 ctx、输出下面这个归一化形状"，不强求所有 adapter
  // 共享同一个 ctx schema，这是刻意的松耦合，不是漏做）
  async fetchTasks(ctx) => Array<{ title: string, externalId: string, tags: string[] }>
}
```
`githubAdapter.fetchTasks()` 内部原样保留今天 `defaultFetchOpenIssues()` + `resolveActiveTaskTags()`
的映射逻辑（这段逻辑本身没有 bug，不是本次要改的东西），只是包一层统一签名。`noneAdapter`（或者说：
`taskSource === "none"` 时压根不进入 adapter 分发，见 §6）不需要一个真的"空 adapter 对象"，直接短路
更诚实。

---

## 3. 配置解析：新文件 `.claude/hooks/lib/task-source.mjs`，precedence 照抄 `db-path.mjs` 的先例

```js
export function resolveTaskSource(opts = {}) {
  const envValue = process.env.AELOOP_BRAIN_TASK_SOURCE;
  if (envValue === "github" || envValue === "none") return envValue;
  if (envValue) {
    // 未知值：fail-closed 到 "none"，不是 fail-open 到 "github"——防幻觉优先，
    // 一个拼错的 env 值不该意外打开一条会调外部 CLI 的路径。stderr 留一行诊断（同
    // brain-wake-greeting.mjs"绝不阻断"的既有诊断惯例：诊断走 stderr，不进正文）。
  }

  if (process.env.AELOOP_BRAIN_GLOBAL_MODE === "1") return "none";
  // 全局模式下不读 <cwd>/.claude/brain.local.json——同 resolveIdentityDbPath() 的既有理由
  // （全局装的 hook 不该读到"当前被触发所在的、可能完全无关的第三方项目"自己的本地配置）。
  // 全局模式下的持久化 opt-in 走 §8 的 hookCommand 烘焙方案，不是这层 fallback。

  const cwd = opts.cwd ?? process.cwd();
  // 读 <cwd>/.claude/brain.local.json 的 taskSource 字段，值域同上；坏 JSON/字段缺失/
  // 非法值 → 当没配置，不抛错（同 resolveIdentityDbPath 的既有"安静跳过"哲学）。
  ...
  return "none"; // 默认——shipped 默认零 GitHub。
}
```

`.claude/brain.local.json.example` 需要补一行 `taskSource` 字段说明（非必需字段，缺省 `"none"`）。

三个入口，和 `identityDbPath` 完全对称：① env（终端启动可用，受 IDE 不继承 shell profile 的已知坑
影响，`db-path.mjs:4-6` 同一条坑）；② 非全局模式下的 `.claude/brain.local.json`（不受该坑影响）；
③ 全局模式下烘焙进 `hookCommand`（§8，同样不受该坑影响，且是操作者稳定 opt-in 的推荐路径——不特指 ai-agent，见 §12③ 裁决）。

`.claude/hooks/lib/task-source.mjs` 被 `brain-wake-greeting.mjs`（渲染侧）和
`scripts/seed-brain-identity.mjs`（seed 侧）两处 import——和 `git-remote.mjs`/`project-registry.mjs`
同一套"hooks/lib 下的共享小文件，两个目录各自 import"的既有惯例，不新建一层目录结构。

**⚠️ 必须记进实现清单，不是可选项**：`install-global-brain.mjs` 的 `COPY_ITEMS`
（`install-global-brain.mjs:44-63`）必须把 `task-source.mjs` 加进去——这正是 #96/#98 已经踩过两次
的同一类坑（新库没进全局快照拷贝清单 = 全局模式下 `brain-wake-greeting.mjs` 动态 `import()` 时
`MODULE_NOT_FOUND`）。本设计明确点名，防止第三次发生。

---

## 4. 数据层怎么按开关收窄（`greeting-data.mjs`）

`gatherGreetingData(store, opts)` 新增 `opts.taskSource`（调用方 `brain-wake-greeting.mjs` 传入
`resolveTaskSource()` 的结果；省略时默认 `"none"`——**注意这打破"省略参数=字节级不变"的既有惯例**，
是本设计刻意的默认值翻转，见 §11）：

- `taskSource === "none"`：**不调用** `collectStatusRows(store)`——不是查出来再丢弃，是压根不查
  （和"该省的段直接不渲染"同一条红线，往数据层再落一层：不该给的东西，连查都不查，防的是"万一渲染
  层漏了一个分支，数据层至少不会意外递出东西"这类纵深防御）。`statusRows = []`、`otherProjects =
  []`、`unassignedCount = 0`。`backlogItems = []`（Idea Queue 同理不查）。
- `taskSource === "github"`：行为等同今天（`statusRows`/`otherProjects`/`unassignedCount`/
  `backlogItems` 照旧算）。
- **`pendingDecisions` 拆两段，这是本设计对"待你决策"最关键的一处收口**（§1 已指出的来源混淆，
  下面是具体处理，§12 标注为待指挥官确认）：
  - **身份/宪法候选**（`wakeResult.pendingDecisions`，来自 identity/constraint/decision，
    `wake.mjs:44-67` 的既有产出，**从不碰 gh**）——**不受 `taskSource` 影响，始终计算、始终可能
    出现**。这是 `TURNKEY-DESIGN.md` §4(iii) 已经定盘、指挥官已确认采纳的"候选修宪"通路，字面
    砍掉"待你决策"整段会连带废掉这个已拍板的机制，本设计不做这个连带动作。
  - **任务/idea 候选**（`unconfirmedActiveTasks`/`unconfirmedIdeas`）——随 `taskSource` 一起收窄：
    `taskSource === "none"` 时不计算这两个（`active_task`/`idea` 类型的 unconfirmed 记录理论上
    仍可能因为操作者手动三态确认流程产生，和 seed/gh 无关，但和"现在在途"/"Idea Queue"是同一个
    "任务看板"概念下的候选，一并收窄，行为上和"整个任务看板关掉"保持一致——这是本设计的判断，
    不是能从代码结构自动推导出的必然结论，同样标 §12）。
- `lastStop` 的既有回退链（`snapshotMemory ?? focusTask（可续做时）?? "当前没有可回溯的断点。"`，
  `greeting-data.mjs:192-199`）**不改动回退优先级本身**，但因为 `taskSource === "none"` 时
  `statusRows` 已经强制为空，`focusTask`（由 `pickFocusTask(statusRows)` 算）天然恒为 `null`——
  "上次停在"在这个模式下只可能来自 `snapshotMemory`（非任务看板来源、非 GitHub）或中性兜底句，
  **不需要新增一条专门的 taskSource 判断**，是数据层收窄的自然副产物，这是刻意设计成"改动面最
  小"的地方（不是遗漏）。`followUp` 同理，`focusIsActionable` 恒为 `false` 时自然落到"有什么想让
  我接手的？"这句中性追问，不需要新代码。

---

## 5. 渲染层怎么整段跳过（`render-greeting.mjs`）——不能落进"无"占位这个坑

`labeledSection()`（`render-greeting.mjs:41-44`）对空数组的既有行为是渲染
`**label：** 无`——**这正是防幻觉红线明确禁止的**（"该省的段直接不渲染而非显示'暂无'占位"）。
不能靠"§4 已经把数组喂空"就自动满足这条红线，因为 `labeledSection` 不管数组是"真的没有"还是"这个
概念在当前配置下压根不该出现"，一律渲染"无"——这是两个不同的语义，今天代码没有区分。

`renderGreeting(data)` 新增读取 `data.taskSource`（`gatherGreetingData()` 透传，不是渲染层自己读
env——保持"纯函数，只读传进来的数据"这条 `render-greeting.mjs` 头注释里明文写的红线）：

```js
const parts = [
  `意识已加载。我是 ${sanitizeText(identityName)}。`,
  ...(versionLine ? [sanitizeText(versionLine)] : []),
  "",
  `**上次停在：** ${sanitizeText(lastStop)}`,
];

if (taskSource !== "none") {
  parts.push("", "**现在在途：**", "", renderStatusTable(statusRows));
  if (otherProjects.length > 0) parts.push("", labeledSection("其它项目", otherProjects, ...));
  if (unassignedCount > 0) parts.push("", `**未分组任务：** ...`);
  parts.push("", labeledSection("Idea Queue 积压", backlogItems, ...));
}

// "待你决策"：始终渲染这个标题（§4 已定：身份/宪法候选不受 taskSource 影响），但当
// taskSource === "none" 时 pendingDecisions 数组本身已经不含任务/idea 候选（§4），
// 如果身份候选也恰好是空的，这里合规地走 labeledSection 既有的"无"分支——这个"无"不是
// 违规占位，因为"待你决策"这个概念在任何 taskSource 下都合法存在（不是被整段关掉的东西）。
parts.push("", labeledSection("待你决策", pendingDecisions, ...), "", `——${sanitizeText(followUp)}`);
```

**注意这里的关键区分，避免实现时踩混**：`labeledSection()` 对"待你决策"仍然可以合法输出"无"（因为
这个概念本身没被关掉，只是碰巧当前没有候选）；但"现在在途"/"Idea Queue 积压"整个 `if` 块在
`taskSource === "none"` 时物理上不执行，不会有任何"无"字样——这是"数组为空"和"概念被关闭"两种不同
情况该有不同渲染结果的具体落点，不是同一套逻辑套两次。

---

## 6. seed 解耦 gh：`taskSource === "none"` 时整个途③物理跳过，不只是 gh 调用本身

`scripts/seed-brain-identity.mjs` 的 `main()` 第 3 步（`main.mjs:277-327`）今天做四件事：反查
origin owner/repo → `assertProjectRegistered` → `fetchOpenIssues`（真调 gh）→ 逐条 upsert。**本设计
把 gate 点放在最外层**（不是只包 `fetchOpenIssues` 那一次调用，#96 已经这么做过；这次连
`getOriginOwnerRepo`/`assertProjectRegistered` 也一起跳过）：

```js
const taskSource = resolveTaskSource({ cwd });
if (taskSource === "none") {
  result.skippedTaskSync =
    "未配置在途任务来源（AELOOP_BRAIN_TASK_SOURCE 未设为 \"github\"），按设计跳过——" +
    "身份 + 宪法约束已正常写入，不受影响。";
} else if (taskSource === "github") {
  // 今天的途③原样，只是外层多包一层 if；内部逻辑不变（含 #96 已有的 gh 调用失败优雅降级）
  ...
}
```

**为什么连 `assertProjectRegistered`/`getOriginOwnerRepo` 也跳过，不只是 gh 调用本身**：
`taskSource === "none"` 时不会产出任何 `active_task`，"这个项目有没有在 `project_registry` 注册"
这件事对本次 seed 运行没有任何意义——继续要求注册只是白白制造一个门槛（企业场景下目标项目甚至可能
不是任何人手动 `onboard-project.mjs` 过的东西）。这直接回应了指挥官"seed 根本不尝试 gh"的原话——
不仅不调 `gh` 二进制，连"为了将来调 gh 而做的前置检查"也不做。

**字段改名**：`result.skippedIssueSync` → `result.skippedTaskSync`（§7 呼应"用户可见层去 GitHub
措辞"——这个字段今天叫"Issue"，是 GitHub 特定词汇渗进了本该通用的字段名；`taskSource === "github"`
分支内部失败时的消息仍可以提"issue 同步"字样，因为那时候确实就是在讲 GitHub issue，但字段本身的
命名不该预设只有 GitHub 一种来源）。**这是一处小的破坏性改动**（调用 `main()` 的测试/调用方如果
读了 `result.skippedIssueSync` 这个字段名会失败）——`scripts/test-seed-brain-identity.mjs` 需要
同步改，PRD 阶段列进任务清单。

---

## 7. 用户可见文案清单（逐条列出，PRD 阶段照这个改）

| 位置 | 现状（用户/模型会读到的原文） | 改动 |
|---|---|---|
| `scripts/seed-brain-identity.mjs:307-309`（`taskSource==="github"` 时 gh 调用失败） | "gh CLI 不可用（未安装/未登录/调用失败），已跳过 issue 在途同步" | 保留（这条分支本来就是"选了 github 但失败了"，提 gh 是准确的） |
| `scripts/seed-brain-identity.mjs:343-348`（console.log 汇总） | `"issue 在途："` / `"issue 同步已跳过："` | `taskSource==="none"` 时改成 `"在途任务同步：已跳过（未配置来源）"`；`taskSource==="github"` 时保留原样（准确） |
| `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs:92-95`（`seedStep()`） | 硬编码"需要 `gh` CLI 已安装并登录才能同步 issue；没装/没登录/调用失败也能跑成功" | 新增 `taskSource` 参数：`"none"`（默认引导路径）→ "跑 ... 种下初始身份与宪法（默认不连接任何外部在途任务来源，不需要 `gh`）。如果之后想接入 GitHub issue 同步，见 README「在途任务来源」一节"；`"github"` → 保留今天的措辞（这一分支只有操作者已经显式 opt-in 时才会被走到，见 §9） |
| `render-greeting.mjs` | 无字面 "GitHub"/"gh" 字样（"现在在途"/"Idea Queue 积压"是中性措辞） | 不改文案本身，只改是否渲染（§5） |
| `status-table.mjs` | 无字面 GitHub 字样，但 `active_task` 的 `gh-issue:<n>` tag 会被显示为来源标注（需二次确认具体渲染格式） | PRD 阶段核实 `renderStatusTable()` 是否把 `gh-issue:` tag 值原样吐出来；如果吐，`taskSource==="github"` 时这是准确信息不用改；`taskSource==="none"` 时这张表根本不渲染（§5），不存在需要改的场景 |
| `README.md` / `WAKE-GREETING-RUNBOOK.md` | 大概率有面向人读的 GitHub/gh 说明 | **明确排除在本设计范围外**——这些是文档，不是运行时注入给模型/用户的正文，指挥官的"用户可见层"指令我理解为运行时文本（seed 输出/引导正文/开场白），文档更新可以是独立的后续 P2，不阻塞本设计落地 |
| `docs/conductor-brain-layer/spike/print-status-table.mjs`（按需查询 skill 的确定性 CLI） | 无条件读 `AELOOP_BRAIN_IDENTITY_DB` 打印状态表 | **明确不改**——这是用户显式主动触发的按需查询（不是自动开场白），不受"默认不推看板"这条策略约束，用户主动问就该如实答，"确认数据才显示"的红线在这里仍然适用但不需要 `taskSource` 门控 |

---

## 8. `install-global-brain.mjs`：操作者怎么 opt-in（§12③ 裁决：不是指 ai-agent 这个仓库，是指"某个 aeloop 用户设 `--task-source=github`"）

**推荐路径**：扩展安装脚本一个可选 CLI 参数 `--task-source=github`（省略时等同今天，不传即
`AELOOP_BRAIN_TASK_SOURCE` 不出现在 `hookCommand` 里 → `resolveTaskSource()` 落到默认 `"none"`）：

```js
const hookCommand = taskSourceFlag
  ? `AELOOP_BRAIN_GLOBAL_MODE=1 AELOOP_BRAIN_TASK_SOURCE=${taskSourceFlag} node "${hookEntryPath}"`
  : `AELOOP_BRAIN_GLOBAL_MODE=1 node "${hookEntryPath}"`;
```

**为什么不是让操作者自己 `export AELOOP_BRAIN_TASK_SOURCE=github`**：全局模式下
`resolveTaskSource()`（同 `resolveIdentityDbPath()`）不读 `.claude/brain.local.json`；剩下唯一
持久化路径是 env，而 env 有已经写进 `db-path.mjs` 头注释的已知坑——IDE/图形界面启动的 Claude Code
不继承 `~/.zshrc` 的 `export`。烘焙进 `hookCommand`（和 `AELOOP_BRAIN_GLOBAL_MODE=1` 今天已经在
用的同一个机制）不受这个坑影响，是操作者稳定 opt-in 唯一在全局模式下真正健壮的路径——
这不是我发明的新范式，是复用这个文件已经建立的先例。

**重装/幂等的一个真实后果，需要指挥官知道**：`installGlobalBrain()` 每次运行都会重新拼
`hookCommand` 字符串（`install-global-brain.mjs:263`），`mergeSettingsWithBrainHook()` 按
"完全相同的 command 字符串"判幂等（`install-global-brain.mjs:157-160`）。如果操作者第一次装的时候
带了 `--task-source=github`，之后某次重装/升级忘了带这个参数，`hookCommand` 字符串会变
（少了 `AELOOP_BRAIN_TASK_SOURCE=github` 这一段），`mergeSettingsWithBrainHook()` 判"不是完全相同
的 command"→ 会在 `settings.json` 里**追加一条新的 SessionStart 条目**，而不是替换旧的——旧条目
（仍然是 `task-source=github` 的版本）还留着，新条目是默认 `none` 的版本，两条 hook 会**都**跑，
先后顺序不确定，行为不可预测。**这是本设计发现的一个真实 edge case，不是我可以在这份设计里替
指挥官决定怎么处理的东西**（选项：a. 幂等判据从"完全相同字符串"改成"同一个 hookEntryPath 就算
重复，取代旧的" b. 装完打印一句"你上次装的时候带了 --task-source=github，这次没带，是否要保留"
c. 不管，接受这个已知坑，写进 troubleshooting 文档），列入 §12 待指挥官确认。

---

## 9. 和 #96 三态引导的交互

`brain-wake-greeting.mjs` 的状态 A（未配置）/状态 B（空库）/状态 C（正常渲染）判定完全基于
`dbPath`/`store.listMemories().length`（`brain-wake-greeting.mjs:111-163`），和 `taskSource`
是**两条正交的轴**——`taskSource` 不改变、也不需要改变三态判定逻辑本身：

- **状态 A/B（引导）**：`renderOnboardingNotConfigured()`/`renderOnboardingEmptyStore()` 里的
  `seedStep()` 需要按 `taskSource` 分支措辞（§7 已列）。**引导文案默认（`taskSource` 未配置 =
  `"none"`）只讲"配身份/宪法"，完全不提 GitHub/gh**——这正是指挥官"引导只讲配身份、不提
  GitHub/gh"这条要求的具体落点。只有操作者已经通过 §8 的 `--task-source=github` 装过、或者手动
  设了 env/`.claude/brain.local.json` 的 `taskSource: "github"`，引导正文才会提到 gh（这时候提
  是准确的，不是意外泄露）。
- **状态 C（正常渲染）**：走 §4/§5 的收窄逻辑。

两者不打架，`taskSource` 的解析（`resolveTaskSource()`）本身不依赖 store 是否为空，可以在状态
A/B 分支里安全调用（不需要开 store）。

---

## 10. 防幻觉 / 零回归底线的具体落点

- **个人版字节级零回归**：这条现在需要重新表述——原始 issue 假设"个人版=默认保留"，扩大范围后
  shipped 默认翻转为 `"none"`。**真正的零回归对象是"今天已经在跑、且被人依赖的具体场景"，不是
  "省略参数时的默认值"**（§11 明确写出这处翻转，不是悄悄改默认值）。任何已经在用 `taskSource
  ="github"`（无论是设了 env、`.claude/brain.local.json`，还是走 §8 装的机器）的场景，**渲染出
  的开场白文本 / 身份库写入 / GitHub 拉取副作用**和今天等价——这才是本设计承诺的"零回归"范围
  （2026-07-24 Zorro 复审后收窄措辞：`GreetingData` 新增 `taskSource` 字段、`seed-brain-
  identity.mjs` 的 `skippedIssueSync` 字段改名 `skippedTaskSync`，这类内部字段/接口层面的改动
  不在"零回归"承诺范围内，只有用户能感知到的最终结果才是，详见 `impact.md`）。
- **跳过的段 = 整段不渲染，绝不显示"暂无"**：§5 的具体实现（`if (taskSource !== "none")` 包住
  整个渲染块，不是把数组传空指望 `labeledSection` 自己处理）。
- **开关是布尔/枚举选择器，不把 env 原值插进正文**：`taskSource` 本身只是一个内部三选一
  （`"none"`/`"github"`/未知值兜底 `"none"`）分支判断，不会被 `sanitizeText()`-less 地拼进任何
  面向模型/用户的正文——延续 `brain-wake-greeting.mjs:190-197` 已经定盘的"诊断值不进正文，进
  stderr"红线（#84 注入红线的同一条）。

---

## 11. 默认值 / 回退矩阵

| 场景 | `AELOOP_BRAIN_TASK_SOURCE` 解析结果 | 现在在途 | Idea Queue | 待你决策·身份候选 | 待你决策·任务候选 | seed 调 gh？ |
|---|---|---|---|---|---|---|
| **shipped 默认**（什么都没配） | `none` | 不渲染 | 不渲染 | 渲染（可能为空="无"） | 不计算 | 否，连前置检查都跳过 |
| 显式 `.claude/brain.local.json: {"taskSource":"github"}`（非全局模式，dogfood/本地开发） | `github` | 渲染 | 渲染 | 渲染 | 渲染 | 是（含 #96 既有的失败优雅降级） |
| 全局模式，装机时 `--task-source=github`（操作者显式 opt-in 路径） | `github` | 渲染 | 渲染 | 渲染 | 渲染 | 是 |
| 全局模式，装机时未传 `--task-source`（企业/默认场景） | `none` | 不渲染 | 不渲染 | 渲染（可能为空） | 不计算 | 否 |
| `AELOOP_BRAIN_TASK_SOURCE` 设了非法值（如拼错成 `githb`） | 兜底 `none` | 不渲染 | 不渲染 | 渲染 | 不计算 | 否（fail-closed，不是 fail-open 到 github） |

**这张表的第一行是本设计明确要求指挥官确认的一处默认值翻转**：`gatherGreetingData()` 省略
`opts.taskSource` 时默认 `"none"`，这和 `greeting-data.mjs` 今天其它可选参数"省略=行为字节级
不变"的一贯注释惯例（如 `currentProjectKey` 头注释原话）**不一致**——本设计认为这个不一致是
必要的（指挥官已经明确要"shipped 默认零 GitHub"，"省略=沿用今天行为"和这个要求矛盾），但如实
标出这个不一致，不假装它和既有惯例吻合。

---

## 12. 指挥官裁决记录（2026-07-24，按军师推荐 5 点全锁——本节原是"待确认"，现补记实际裁决）

1. **"待你决策"拆两类——认可**：身份/宪法候选（不碰 gh）始终显示；任务/idea 候选随 `taskSource`
   收窄。§4/§1 的设计原样落地，`greeting-data.mjs` 的 `unconfirmedActiveTasks`/`unconfirmedIdeas`
   随 `boardEnabled` 收窄，`wakeResult.pendingDecisions` 不受影响——`docs/conductor-brain-layer/
   spike/lib/greeting-data.mjs` 已实现，`test-greeting.mjs` ⑧ 段覆盖（身份候选/任务候选分别
   断言）。
2. **"上次停在"/结尾追问句——保留**：那是延续/人格，不是 GitHub 看板。数据层收窄后（`taskSource`
   关闭时 `statusRows` 强制为空）两处自然只引用非任务看板数据或中性兜底句，未新增代码路径——
   `test-greeting.mjs`/`test-hook-greeting.mjs` 均有覆盖这两处在 `taskSource:"none"` 下的行为。
3. **ai-agent（个人版 Helix）不接 aeloop 全局 hook——已核实，§12③ 原判断划掉**：ai-agent（Helix）
   有自己独立的一套 hook（session-isolation-guard/wake-reconcile/heartbeat/commit-gate 等），
   零引用 aeloop-brain/`AELOOP_BRAIN_GLOBAL_MODE`。**"个人版 opt-in"不是指 ai-agent 这个仓库，
   是指"某个 aeloop 用户设 `--task-source=github`"**——§8 措辞已按这个更正后的理解写（"个人版
   Helix"字样替换为泛化的"某个 aeloop 用户/操作者"，不再暗示和 ai-agent 仓库有具体绑定关系）。
4. **`install-global-brain.mjs` 重装幂等——已纳入**：`--task-source` 引入的"重装忘带 flag →
   settings.json 堆两条 hook 都跑"这个 edge case，由 #103 自己的改动引入，就该由 #103 自己处理，
   不留给未来的 #105。裁决：**重装时更新那唯一一条 aeloop SessionStart 条目**（按标记子串匹配
   替换，不是按完全相同字符串判幂等），和 #105 uninstall 的"按同一标记匹配"对称，用同一个标记
   子串（`install-global-brain.mjs` 导出的 `AELOOP_BRAIN_MARKER` 常量，供 #105 落地时直接复用，
   不用各写一份字面量）。已实现：`mergeSettingsWithBrainHook()` 改成"先找含标记的既有条目，
   找到就原地替换 command，找不到才追加"，`test-install-global-brain.mjs` 新增纯函数用例 +
   `installGlobalBrain()` 端到端用例验证反复横跳装不同 taskSource 始终只有一条 SessionStart
   条目。**Zorro 复审 FAIL 后订正标记子串本身的值**（2026-07-24，独立 Codex `gpt-5.6-sol`
   交叉核实）：初版 `AELOOP_BRAIN_MARKER` 用裸 `"aeloop-brain"`（不带路径分隔符），Zorro 真实
   复现出这个判据会把一个 command 里恰好含这几个字符、但和本工具完全无关的第三方 hook 误判成
   "自己的旧条目"并覆盖掉（数据丢失级 blocker）——改成高特异性路径片段
   `"/.claude/aeloop-brain/repo-snapshot/"`（只有真实由 `installPaths()` 生成的 `hookEntryPath`
   才会天然带上），并补了一条反例测试（第三方 command 含"aeloop-brain"字样但不含完整路径结构
   → 不能被覆盖）。**已知局限，如实标注**：`mergeSettingsWithBrainHook()` 只处理第一条命中的
   条目，不会自动合并"这次修复上线前就已经因为老判据攒出的既存重复条目"——只保证从此以后不再
   新增，不追溯清理，详见 `impact.md`。
5. **不预定 adapter #2 命名空间——YAGNI 采纳**：选择器字符串值域维持只有 `"none"`/`"github"`，
   `.claude/hooks/lib/task-source.mjs` 不为任何未来来源预留命名。（背景仅供本文档内部记录，
   不外传：未来企业来源是个内部工具，连军师之前的猜测都猜错了，更印证了不预定命名空间的判断。）

**PRD/实现权威**：`docs/enterprise-board-toggle/PRD.md`（逐文件任务清单 + 批次）、
`docs/enterprise-board-toggle/progress.md`（批次记录 + 自测结果）、
`docs/enterprise-board-toggle/impact.md`（影响范围 + 回归清单）。
