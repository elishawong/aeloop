# PRD — 在途任务来源可插拔（默认关）+ seed 解耦 gh（issue #103）

- **项目**: aeloop
- **依赖**: #96（首次醒来三态引导，同一批文件）、#93（全局模式/多项目地基）、#98（版本戳）
- **设计权威**: `docs/enterprise-board-toggle/DESIGN.md`（配置轴选型 trade-off、数据层/渲染层
  收窄方案、seed gate 设计、install 幂等设计，均在那份文档定盘，本 PRD 不重复论证，只列怎么
  落地 + 验收标准）
- **状态**: 实现完成，本地自测全绿（含全量既有 `test-*.mjs` + `pnpm test` 634 条 vitest 用例 +
  `pnpm run lint`），待 Zorro 独立复审
- **最后更新**: 2026-07-24

---

## 1. 范围

**做什么**：
1. 新增 `.claude/hooks/lib/task-source.mjs`：`AELOOP_BRAIN_TASK_SOURCE` 选择器（`"none"`
   默认 | `"github"`），precedence 照抄 `db-path.mjs`。
2. `greeting-data.mjs`/`render-greeting.mjs`：`taskSource !== "github"` 时"现在在途"/
   "Idea Queue 积压"/任务候选整段不渲染（不是显示"无"）；身份/宪法候选（"待你决策"的一部分）
   不受影响。
3. `seed-brain-identity.mjs`：`taskSource !== "github"` 时整个"在途任务同步"物理跳过（不反查
   owner/repo、不检查项目注册、不调 gh）；`skippedIssueSync` 字段改名 `skippedTaskSync`。
4. `onboarding-greeting.mjs`（#96 首醒引导）：按 `taskSource` 分支措辞，默认路径不提 gh。
5. `install-global-brain.mjs`：新增 `--task-source=github` CLI flag，烘焙进 `hookCommand`；
   `mergeSettingsWithBrainHook()` 幂等判据从"command 完全相同"改成"command 含 `aeloop-brain`
   标记"，重装换 flag 时原地替换而不是追加第二条（DESIGN §12④）。
6. 全部改动点更新对应 `test-*.mjs`，新增 taskSource 维度覆盖；`install-global-brain-onboarding-
   e2e.mjs` 新增全局模式端到端验证（task-source.mjs 真的在快照里 + 真实 spawn 走通两种
   taskSource）。

**不做什么**（DESIGN 已列非目标，这里重复防止范围膨胀）：
- 不新建完整 adapter 插件注册系统（YAGNI，DESIGN §2 已定）。
- 不预定 adapter #2 的命名空间（DESIGN §12⑤）。
- 不改 README.md/WAKE-GREETING-RUNBOOK.md 等面向人读的文档（DESIGN §7 明确排除，运行时文本
  是本次范围，静态文档是独立的后续 P2）。
- 不改 `print-status-table.mjs`（按需查询 skill，用户显式主动触发，不受"默认不推看板"策略约束，
  DESIGN §7）。
- `src/**` 零改动（本次改动全部在 `.claude/hooks/`、`docs/conductor-brain-layer/spike/lib/`、
  `scripts/` 三处，未触及 TypeScript 引擎源码）。

---

## 2. 逐文件任务清单

| 文件 | 改动 | 依赖 |
|---|---|---|
| `.claude/hooks/lib/task-source.mjs`（**新建**） | `resolveTaskSource(opts)`：env → 全局模式短路 `"none"` → `.claude/brain.local.json` 的 `taskSource` 字段 → 默认 `"none"`。非法值 fail-closed 到 `"none"`。导出 `VALID_TASK_SOURCES`/`DEFAULT_TASK_SOURCE`。 | 无 |
| `.claude/hooks/lib/test-task-source.mjs`（**新建**） | 单测：默认 none / env 优先 / 全局模式跳过本地 json / 非法值 fail-closed / 全局模式+env 组合 | task-source.mjs |
| `.claude/brain.local.json.example`（**修改**） | 补 `taskSource` 字段说明（可选，缺省 `"none"`） | 无 |
| `docs/conductor-brain-layer/spike/lib/greeting-data.mjs`（**修改**） | `gatherGreetingData(store, opts)` 新增 `opts.taskSource`；归一化为两值枚举（非 `"github"` 一律当 `"none"`）；`boardEnabled` 门控 `collectStatusRows`/`backlogItems`/`unconfirmedActiveTasks`/`unconfirmedIdeas`（不查，不是查了丢）；`wakeResult.pendingDecisions`（身份/宪法候选）不受影响；返回值新增 `taskSource` 字段透传给渲染层。 | task-source.mjs（间接，实际由调用方传入，本文件不直接 import） |
| `docs/conductor-brain-layer/spike/lib/render-greeting.mjs`（**修改**） | 读 `data.taskSource`（默认 `"none"`）；`taskSource === "github"` 时整块渲染"现在在途"/"其它项目"/"未分组任务"/"Idea Queue 积压"；否则整块不进 `parts`（不是空数组走 `labeledSection` 的"无"分支）。"待你决策"不受门控。 | greeting-data.mjs |
| `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs`（**修改**） | 新增 `resolveTaskSourceOpt(opts)`（复用 `task-source.mjs` 的 `resolveTaskSource()`）；`seedStep(globalMode, taskSource)`/`seedTroubleshooting(globalMode, taskSource)` 按 `taskSource` 分支措辞（`"none"`：不提 gh + opt-in 提示；`"github"`：保留 #96 原措辞 + 项目注册坑提示）；`renderOnboardingNotConfigured(opts)`/`renderOnboardingEmptyStore(opts)` 新增可选 `opts.taskSource`（默认参数不计入 `Function.length`，零参数契约不受影响）。 | task-source.mjs |
| `.claude/hooks/brain-wake-greeting.mjs`（**修改**） | import `resolveTaskSource`；`main()` 里解析一次 `taskSource`，传入 `gatherGreetingData(store, {currentProjectKey, taskSource})`；状态 A/B 的引导调用不显式传（沿用 `onboarding-greeting.mjs` 自解析 env 的既有模式，同 globalMode）；头注释补充配置说明。 | task-source.mjs、greeting-data.mjs |
| `scripts/seed-brain-identity.mjs`（**修改**） | import `resolveTaskSource`；`main(opts)` 新增 `opts.taskSource`（省略时 `resolveTaskSource({cwd})`）；"3. 在途任务"整段包进 `if (taskSource === "github") {...}`，否则设 `skippedTaskSync` 并跳过（不反查 origin、不检查注册、不调 gh）；`skippedIssueSync` 全文改名 `skippedTaskSync`；CLI 输出文案同步改名 + 措辞通用化；文件头注释更新（"三类种子数据"第 3 类标注仅 opt-in 时运行）。 | task-source.mjs |
| `scripts/install-global-brain.mjs`（**修改**） | `COPY_ITEMS` 新增 `task-source.mjs`；导出 `AELOOP_BRAIN_MARKER = "/.claude/aeloop-brain/repo-snapshot/"` 常量（Zorro 复审 FAIL 后从裸 `"aeloop-brain"` 收紧成高特异性路径片段，见 DESIGN §12④）；`mergeSettingsWithBrainHook()` 幂等判据改成"按标记子串定位既有条目 → 命中则原地替换 command，未命中才追加"；新增 `assertValidTaskSourceOpt()` 共享校验，`installGlobalBrain()`/`parseArgs()` 两个入口口径一致（`taskSource` 非法值都 fail-closed 抛错，不只是 CLI 一侧）；`installGlobalBrain(opts)` 新增 `opts.taskSource`，`"github"` 时 `hookCommand` 带 `AELOOP_BRAIN_TASK_SOURCE=github`；`parseArgs()` 新增 `--task-source=github`。 | task-source.mjs（作为被拷贝的产物，无代码依赖） |
| `docs/conductor-brain-layer/spike/test-greeting.mjs`（**修改**） | 既有全部 `gatherGreetingData(store)` 调用改传 `{ taskSource: "github" }`（保留原有覆盖，语义变成"github 来源下的既有行为回归"）；新增 ⑧ 段：默认/显式 none/未知值/显式 github 四种对照，覆盖数据层收窄 + 渲染层整段不出现 + 待你决策拆分。 | greeting-data.mjs、render-greeting.mjs |
| `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（**修改**） | ⑤ 段（多项目分组）env 补 `AELOOP_BRAIN_TASK_SOURCE: "github"`；新增 ⑪ 段：真实 spawn，默认不设该 env，验证板块整段不出现（端到端，不只是单元测试层）。 | brain-wake-greeting.mjs |
| `docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs`（**修改**） | 新增 `notConfiguredGithub`/`emptyStoreGithub` 两个变体；①②③ 循环覆盖四个变体；③ 新增"项目注册坑只在 github 变体出现"断言；⑧ 段显式传 `taskSource: "github"` 隔离维度；新增 ⑨ 段专测 taskSource 措辞分支 + 默认值读真实 env。 | onboarding-greeting.mjs |
| `scripts/test-seed-brain-identity.mjs`（**修改**） | 全部 `skippedIssueSync` 改名 `skippedTaskSync`；既有 `main()` 调用（②-⑧）补 `taskSource: "github"`；新增 ⑨ 段（taskSource:"none" 整个途③物理跳过，含非 git 目录也能正常跑完）+ ⑩ 段（省略 taskSource 时默认落到 none）。 | seed-brain-identity.mjs |
| `scripts/test-install-global-brain.mjs`（**修改**） | "幂等"用例改用含标记路径片段的真实形状 hookCommand；新增纯函数用例（原地替换 + 混合第三方条目场景）+ `installGlobalBrain()` 端到端用例（反复横跳 taskSource，条目数恒为 1）。**Zorro 复审 FAIL 后补齐**：反例用例（第三方 command 恰好含"aeloop-brain"字样、但不含完整标记路径 → 不能被误判/覆盖，锁死修复后的边界）+ `installGlobalBrain({taskSource:"bogus"})` 编程调用直接抛错的用例（API 侧 fail-closed，不只是 CLI 侧）。 | install-global-brain.mjs |
| `scripts/test-install-global-brain-onboarding-e2e.mjs`（**修改**） | 新增 ④ 段：`task-source.mjs` 真实出现在快照里；默认 spawn（真实 `node hookEntryPath` + 手动 env）板块不出现；`installGlobalBrain({taskSource:"github"})` 重装后**真实 shell 执行 `hookCommand` 字符串本身**（验证"烘焙进命令行"机制本身生效，不只是 `resolveTaskSource()` 认 env）板块出现；`settings.json` 幂等断言（仍只有一条 aeloop 条目）。 | install-global-brain.mjs |
| `docs/enterprise-board-toggle/DESIGN.md`（**修改**） | 状态改"指挥官已确认"；§12 从"待确认"改写成裁决记录（5 点逐条）；§8/§3 措辞按裁决③更正（不再暗示"个人版"特指 ai-agent）。 | 无 |
| `docs/enterprise-board-toggle/progress.md`（**新建**） | 批次记录 + 自测结果 | — |
| `docs/enterprise-board-toggle/impact.md`（**新建**） | 影响范围 + 测试建议 + P0/P1/P2 回归清单 | 全部批次完成后 |

---

## 3. 批次拆分（按依赖顺序，本轮 PRD+build 连续一手做，未分会话）

- **B0**（无依赖）：`task-source.mjs` + `test-task-source.mjs`——先把配置解析这个最底层的缝
  锁定，独立可测。
- **B1**（依赖 B0）：`greeting-data.mjs` + `render-greeting.mjs` + `test-greeting.mjs`——数据层
  + 渲染层收窄，单元测试层面把"待你决策拆分"/"整段不渲染"两条红线锁死。
- **B2**（依赖 B0）：`brain-wake-greeting.mjs` + `test-hook-greeting.mjs`——把 B1 接进真实 hook
  入口，端到端验证。
- **B3**（依赖 B0）：`onboarding-greeting.mjs` + `test-onboarding-greeting.mjs`——首醒引导措辞
  分支，和 B1/B2 相互独立（三态判定和 taskSource 是正交轴，DESIGN §9）。
- **B4**（依赖 B0）：`seed-brain-identity.mjs` + `test-seed-brain-identity.mjs`——seed gate。
- **B5**（依赖 B0，和 B1-B4 相互独立）：`install-global-brain.mjs`（COPY_ITEMS + 幂等 + CLI
  flag）+ `test-install-global-brain.mjs` + `test-install-global-brain-onboarding-e2e.mjs`。
- **B6**（依赖 B1-B5 全部落地）：全量自测（既有 20+ 个 `test-*.mjs` + `pnpm test` vitest +
  `pnpm run lint`），确认零回归；`.claude/brain.local.json.example` 补字段说明；DESIGN.md
  状态/裁决记录回写；PRD/progress/impact 文档收尾。

（实际执行中 B0-B5 相互间有少量交叉验证——比如写 B1 时顺带发现 B4 的 `skippedIssueSync` 字段名
也要同步改，属于同一个决策④的自然延伸，不是独立批次，已在 progress.md 如实记录。）

---

## 4. 验收标准

1. **数据层**：`gatherGreetingData(store)`（省略 `taskSource`）返回 `statusRows=[]`、
   `otherProjects=[]`、`unassignedCount=0`、`backlogItems=[]`；`pendingDecisions` 只含身份/
   宪法候选，不含任务/idea 候选。`{taskSource:"github"}` 时**渲染出的开场白文本 / 写入身份库的
   数据 / 触发的 GitHub 拉取副作用**和加这个参数之前等价（2026-07-24 Zorro 复审 🟡 finding 后
   收窄措辞——`GreetingData` 返回对象本身新增了 `taskSource` 字段、`seed-brain-identity.mjs`
   的 `skippedIssueSync` 字段改名 `skippedTaskSync`、CLI 输出文案有小改动，"逐字节相同"这个
   说法对返回对象/字段名不成立，只对"github 分支下用户能感知到的最终结果"成立，`impact.md`
   已经如实列出了这些具体的破坏性改动，本条不应该用比 impact.md 更强的措辞自相矛盾）。
2. **渲染层**：`taskSource!=="github"` 时输出**不包含**子串 `"**现在在途："`/`"**Idea Queue 积压："`
   （不是包含但显示"无"/"当前没有在途任务。"）；`"**待你决策："` 标题始终存在。
3. **seed**：`taskSource!=="github"` 时 `fetchOpenIssues` 零调用，`getOriginOwnerRepo`/
   `assertProjectRegistered` 均不执行（对未注册、甚至非 git 目录的 cwd 也能正常跑完，零报错）；
   身份/宪法约束正常写入。
4. **install**：`--task-source=github` 烘焙进 `hookCommand`；同一 `homeDir` 反复用不同
   `taskSource` 重装，`settings.json` 里 aeloop 的 SessionStart 条目数恒为 1。
5. **首醒引导**：`taskSource` 默认（`"none"`）时的引导正文不含 `"需要 \`gh\` CLI 已安装并登录"`
   这句只在 github 来源下准确的措辞，含 `"不需要 \`gh\`"` + opt-in 指引。
6. **零回归**：所有既有 `test-*.mjs`（约 21 个）+ `pnpm test`（vitest，`src/**`）+
   `pnpm run lint`（`tsc --noEmit`）全绿；`src/**` 目录零改动（`git diff --stat -- src/` 为空）。
7. **升级影响（不当零回归糊过去，见 DESIGN §11 已标注的默认值翻转）**：这是一处**有意的行为
   变更**，不是向后兼容——任何已经在跑这套 hook、且没有显式配置 `taskSource`/`--task-source`
   的既有安装（不管是 dogfood 项目内的 `.claude/brain.local.json` 路径，还是全局装机），升级后
   **开场白会从"带 GitHub 在途看板"变成"不带"**（seed 也会从"同步 issue"变成"跳过"）。这不是
   一个静默的破坏性改动被藏起来——是指挥官已经明确要的"shipped 默认零 GitHub"这条产品决策的
   直接、必然后果。任何操作者如果升级后想保留今天的行为，需要显式：全局模式重装时带
   `--task-source=github`；或非全局模式在目标项目的 `.claude/brain.local.json` 里加
   `"taskSource": "github"`；或直接设 `AELOOP_BRAIN_TASK_SOURCE=github` 环境变量。
