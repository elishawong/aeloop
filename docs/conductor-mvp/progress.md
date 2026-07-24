---
feature: conductor-mvp(issue #2)
status: in_progress
last_updated: 2026-07-24
---

# Progress — Conductor 层 MVP(issue #2)

> 边写边更。改完即写回。**未经指挥官批准不 commit**——本轮已获批 build batch 0+1,仍不 commit,
> build+自测跑完后交 Zorro 审。

> **▶ 下一步(RESUME 指针)**:batch 0 + batch 1 完成 → Zorro R1 = FAIL(6 blocker + 7 yellow)→
> 返工 → Zorro R2 = FAIL(离 PASS 很近:R1 的 6 blocker 全真修好、7 yellow 全清、660 绿,
> candidate-only 值全守住)→ 返工(RB1/RB2 + #106 rebase/reconcile 集成 + 4 个低优先级 yellow,
> 665 绿)→ **Zorro R3 = FAIL(代码面 100% 干净——RB1 红线独立攻击验证真堵死、post-#106 融合
> 无损、665+27 测试全绿、红线未弱化;唯一 blocker 是 PRD/DESIGN 里 #106 状态多处自相矛盾的纯
> 文档问题,R2 只补了一处、漏了其余,这轮零代码改动、只做文档一致性 sweep)** → 已全部对齐
> (见下方"Zorro R3 返工"一节)→ `pnpm build && pnpm test` 确认仍 665 绿(文档改动不改测试数)→
> 等指挥官看这轮结果,送 **Zorro R4**。batch 2/batch 3-5 未开始,这轮不做(指挥官原话:"这轮只到
> batch 1")。

- **关联 PRD / DESIGN**:`./PRD.md` · `./DESIGN.md`

## 本轮(文档产出)进度

### 研究阶段 — 完成
- 读 issue #2 原文(4 项修正 + profile 差异要求)。
- 读 `docs/architecture/conductor-work/{IMPLEMENTATION-STATUS,SOLUTION-DESIGN.zh-CN,
  CAPABILITY-MAP.zh-CN,REFACTOR-ROADMAP.zh-CN}.md`,摸清 conductor-work 已建能力边界。
- 逐行读 `src/conductor-work/{main,app,contract-loader,brain-loader}.ts`、
  `src/conductor/{types,contract,orchestrator,run}.ts`、`src/conductor-personal/{adapter,types}.ts`。
- 读 `docs/conductor-brain-layer/spike/lib/translator.mjs` + `test-translator.mjs`,确认翻译器是
  纯模板,不是 NLP。
- 读 `.claude/hooks/brain-wake-greeting.mjs` + `docs/conductor-brain-layer/BRAIN.md` 全文,确认
  "只到醒来出开场白,不含意图→派工→折回闭环"这条既有边界(BRAIN.md §5 原话)。
- 读 `docs/conductor-brain-layer/spike-PRD.md` + `spike/run-spike.mjs`(232 行全读)+
  `scripts/dispatch-brain-task.mjs`(293 行全读),确认库调驱动闭环已验证过、已有并发安全加固。
- 读另一 worktree(`issue-106-wake-claudemd`)的 `docs/wake-trigger-portability/DESIGN.md`(546 行
  全读),核实 #106 状态(指挥官已确认设计,尚未 build)、并用它校准本文档的厚度/诚实标注风格。
- 读 `src/loop/audit-store.ts`(`AuditStore`/`WorkflowRun`/`StepMarker`/`Approval` 全部签名)、
  `src/cli/main.ts` 的 `runList()`,核实多 run 注册表已存在并被生产 CLI 使用。
- 读 `src/conductor/orchestrator.ts`/`src/workflow/registry.ts`,核实"1 TaskContract : 1 workflow"
  cardinality(军师中途追加的核实要求)。
- 读 `src/loop/runner.ts` 的 `insertApproval()` 调用点,确认"当前挂起中(未决策)那一轮的 diff
  查不到"这条看板已知缺口。
- 读 `src/profile/loader.ts` 的 `resolveProfileDir()`,确认看板 server 可以不经过完整
  `assembleProfileDeps()` 就只读打开 `workflow.db`。

### 文档产出 — 完成
- `DESIGN.md`:已核实的事实基线(逐条列源)、架构总纲(2 张 mermaid 时序图)、多 workflow 看板
  一等章节(含 §3.0 cardinality 核实)、4 项修正落地状态、profile 差异、6 个方案对比、明确不做
  清单、8 个待拍板 `[?]`。
- `PRD.md`:数据模型(复用类型 + 2 个新增纯函数/接口)、6 批次逐文件任务清单(batch 0-5)、批次
  依赖表、可测验收标准(batch 0-2 具体,batch 3-5 留待补充设计)、项目约束检查。

### 过程中的两次范围调整(如实记录,不是最初就设计对的)
1. 军师中途转达指挥官新增一等需求:"多 workflow 实时进度看板"(原设计只有派发闭环)——已并入
   DESIGN §1.4/§3、PRD 批次拆解。
2. 军师中途转达指挥官二次重排优先级:看板"总览"要先于"详情",且追加了"一个任务开几个 workflow"
   这个 cardinality 核实要求——已按 §3.0 结论重写 DESIGN §3、调整批次编号(batch 1 = 派发+总览,
   batch 2 = 详情,不再是最初的"batch1=单run stepper"框架)。

## 批次进度

### Batch 0 — 核实 + 基础重构 — 完成(2026-07-24)

**① 抽共享派发核心**(DESIGN §7.3 方案 B):
- 新建 `scripts/lib/conductor-dispatch-core.mjs`——`runConductorDispatch(rawIntent, ctx, opts)`,
  从 `dispatch-brain-task.mjs` 抽出"翻译→库调驱动(自动批 G1/G2,停 G3/Escalation 前)→
  EvidenceBundle→三态门折回"这段核心逻辑,不要求项目注册、不含 cwd 互斥锁/chdir(那两样是多项目
  CLI 场景特有的并发保护,留在 `dispatch-brain-task.mjs`,见该文件"调用方职责边界"头注释)。
- 重构 `scripts/dispatch-brain-task.mjs`:改为委托调用共享核心,自己只保留项目注册校验 + cwd
  互斥锁/chdir + project-link memory 写入这三样多项目特有逻辑。
- **⚠️ 与 PRD 原定文件位置的偏离(PRD §9.2 已授权 build 阶段按实际代码形状判断,如实记录)**:
  PRD 原写的是 `src/conductor-work/dispatch.ts`(TypeScript,走 `src/`)。build 时发现这会破坏
  一条既有的、刻意的架构边界——`docs/conductor-brain-layer/spike-PRD.md` §0 明确要求"不改动
  `src/**` 任何一行,所有净新建代码在 `docs/conductor-brain-layer/spike/`",`translateIntent()`/
  `applyThreeStateGate()` 至今刻意留在 spike 层、没有升级进 `src/`。如果共享核心放进 `src/
  conductor-work/`,就必须从一个真正的 `src/` 产品文件 import spike 层的 `.mjs` 文件,这条依赖
  方向本身就在打破"spike 是沙箱、src 是产品"这条既有边界。改为 `scripts/lib/conductor-dispatch-
  core.mjs`(plain JS,和 `dispatch-brain-task.mjs`/`run-spike.mjs` 同一惯例:从 `dist/` 导入编译
  产物 + 从 spike 层导入 `translateIntent()`/`applyThreeStateGate()`),不触碰这条边界。
- **回归验证**:重构前 `node scripts/test-dispatch-brain-task.mjs` 跑一遍(10 组断言全绿,先确认
  baseline),重构后再跑一遍(仍然 10 组断言全绿,零回归);`pnpm run test`(vitest 全量套件)
  58 files / 634 tests 全绿。
- 新增 `scripts/test-conductor-dispatch-core.mjs`(11 组断言全绿):合法意图 100% 过
  `assertValidTaskContract()`;`assembleDeps` 缺省 profile 是 `"subscription"`;`allowedPaths`/
  `objectivePrefix`/`contractDir` 正确透传;空/纯空白/`undefined` 意图 fail-closed、
  `assembleDeps` 零调用;`DEFAULT_CONTRACT_DIR` 是独立于既有两个安全区的新目录
  (`docs/conductor-mvp/runs`)。

**② 核实修正④(角色 schema 动态 registry)真实范围**(DESIGN §9.1,只核实、不实现):

**结论:issue #2 描述的"动态 registry"机制本身已经完整建成**,不是待建能力:
- `src/prompt/personas.ts` 的 `loadPersona(role, personasDir)`——persona 按 `<personasDir>/
  <role>.md` 文件名动态查找,不是 `if (role === "coder")` 分支;新增角色 = 丢一个新的
  `<role>.md` 文件,零代码改动。这个文件的头注释原话引用了 `docs/DESIGN.md §1.7`:"adding a role
  doesn't require touching the composer"——这正是 issue #2 说的"A0+A1 Zorro blocker #4 的正解"。
- `src/prompt/schema-registry.ts` 的 `SchemaRegistry = Record<string, ZodType|null>`——角色的
  输出 schema 在**调用点**构建("`{ ...DEFAULT_OUTPUT_SCHEMAS, reviewer: ReviewerOutput }`"),
  传进 `PromptComposer` 构造函数,同样不改 `schema-registry.ts`/`composer.ts` 本身。
- `src/shared/types.ts` 的 `export type Role = string`——角色本身就是自由字符串,没有写死的联合
  类型需要扩展。
- `PromptComposer.compose(role, context, task)`(`src/prompt/composer.ts`)接受任意 `role` 字符串,
  查不到 persona 抛 `PersonaNotFoundError`,查不到 schema 抛 `SchemaNotRegisteredError`——两者都是
  显式失败,不是静默吞掉,机制本身是"fail loud"的,不是"看起来支持、实际会悄悄漏"。

**真正的缺口不在"动态 registry 机制"本身,而在"有没有一个会调用它的 conductor 节点"**:
- 今天 `src/loop/graph.ts`/`src/loop/nodes/{coder,tester}.ts` 只有两个硬编码调用点
  (`composer.compose("coder", ...)`/`composer.compose("tester", ...)`),没有任何"conductor"角色
  被实际调用过——加一个 `personas/conductor.md` + 一条 `SchemaRegistry` 条目今天不会产生任何
  行为变化,因为没有代码路径会去调它。
- 而且**batch 0-2(本轮范围)按 DESIGN §7.2 的既有设计,压根不需要 aeloop 自己的 harness 跑一个
  "conductor" persona**——"识别这是不是一个工作请求"这一步是**当前 Claude Code 会话本身的模型**
  做的,不是 aeloop 内部再起一次模型调用。也就是说,correction ④要不要落地,取决于一个更深的
  产品问题:**企业 profile 长期是否需要 aeloop 自己的 harness 里有一个真正的"conductor"模型角色
  参与决策(而不是依赖外部会话)**——这是 DESIGN §6/§9.5 提到的"长期产品化独立入口"方向的一部分,
  不是本轮 batch 0-1 能回答的问题。
- **batch 5 排期结论**:如果/当指挥官确认需要这条能力,工作量是——(a) 写 `personas/conductor.md`
  + 建对应 `SchemaRegistry` 条目(**已有机制,零架构改动,工作量小**);(b) 在
  `src/loop/graph.ts` 或一个新的独立 workflow 里新增一个真正调用 `composer.compose("conductor",
  ...)` 的节点、并把它的结构化输出接进 `parseGateCommand()`/`Orchestrator`
  (**这是真正的新工作量,不是机制缺口,是"目前没有任何东西需要用到这个机制"**)。不建议在
  batch 5 之前动手,先等 batch 3(控制命令对话层接线)跑完看实际需要什么样的路由,可能根本用不上
  aeloop 自己的模型角色。

### Batch 1 — 派发单向闭环 + 看板总览 — 完成(2026-07-24)

**① 派发单向闭环**(DESIGN §4.2):
- 新建 `scripts/dispatch-conductor-task.mjs`——薄 CLI 入口,调共享核心 `runConductorDispatch()`,
  不要求项目注册。**和 `dispatch-brain-task.mjs` 的一处刻意差异**:不复刻它的跨调用互斥锁——
  那把锁保护的是"同一 Node 进程内被当库函数多次 overlapping 调用",本文件是一次性 CLI 入口(每次
  `node scripts/dispatch-conductor-task.mjs "..."` 是独立 OS 进程),不存在同进程内交错的场景,
  已在文件头注释说明理由,不是遗漏。
- **⚠️ 对共享核心的一处必要补充(build 时发现,PRD 原稿没预见到)**:`conductor-dispatch-core.mjs`
  原设计的返回值(`{contract, evidenceBundle, gateResults, runError}`)没有把 `startRun`/
  `resumeRun` 最终的 `RunHandle`(`interrupt`/`done`)透出——但对话层要诚实回复"候选已产出、正
  等待哪个 gate",必须知道这个信息。已补上 `handle` 的追踪(`let handle = null` 提到 try 外层),
  返回值新增 `runId`/`threadId`/`pendingGate`/`done` 四个字段。**重新跑过**
  `test-dispatch-brain-task.mjs`(10 组断言)+ `test-conductor-dispatch-core.mjs`(11 组断言),
  确认这处补充没有破坏任何既有断言(新增字段,不改变既有字段的值/形状)。
- 新增 `scripts/test-dispatch-conductor-task.mjs`(5 组断言全绿):这个脚本是纯 CLI 入口(无
  `import.meta.url` 库/CLI 双模式判断),不能像 `conductor-dispatch-core.mjs` 那样注入 mock 测试,
  改用 `execFileSync` 真的当子进程跑,只测两条不需要真实 LLM 调用的 fail-fast 路径:空/纯空白
  参数→exit 2;身份库 dbPath 未配置→exit 1 + 结构化错误 JSON。**完整闭环(真实调用
  assembleProfileDeps/startRun/resumeRun,需要真实认证的 subscription profile)是人工
  self-check,本轮 build 会话没有真实凭证、也不应该在这类环境里尝试起真实 claude/codex CLI 子
  进程(红线④:严禁 `claude -p --dangerously-skip-permissions` 类关门嵌套 agent)——如实标注
  这条路径**没有**在本轮自动化/本次会话里真实跑过一次端到端,留给指挥官/有真实终端访问权限的人
  补验,同 `dispatch-brain-task.mjs`/`run-spike.mjs` 一直以来的既有惯例。**已通过的证据链**：
  `runConductorDispatch()`（共享核心）本身的 fail-closed/contract 构造/透传逻辑已有 11 组自动化
  断言覆盖到"assembleDeps 被调用那一刻"为止；`dispatch-brain-task.mjs` 的既有 10 组断言（issue
  #93，同一套 startRun/resumeRun 调用序列）同样只到这一步——真实 LLM 调用这条尾段，在整个仓库
  的既有测试体系里从来就没有被自动化过，本轮维持这个既有边界，不是本轮新增的缺口。

**② 多 workflow 总览看板**(DESIGN §3)——**以下是初版记录,Zorro R1 发现的问题(B2/B3/B4/①②)
的具体修复见下方"Zorro R1 返工"一节,这里保留原始记录 + 更新已改名的字段,不重写历史**:
- 新建 `src/conductor-work/board.ts`(真实 `src/` TypeScript,不是 spike/scripts):`phaseLabelFor()`
  (DESIGN §3.5 映射表逐字实现)、`loopCountFromStepRefs()`、`coderRoundCompletedFromStepRefs()`
  (初版名为 `hasCandidateDiffFromStepRefs`,Zorro R1 yellow①之后改名,见下)、`toBoardRow()`。
  新增 `src/conductor-work/__tests__/board.test.ts`(初版 21 个用例,返工后 26 个,见下)。
- **⚠️ 与 PRD 原定语义的一处诚实偏离(build 时发现,已记录,不是隐瞒)**:PRD/DESIGN 早期草稿把
  "是否已产出候选 diff"设想成"是否存在一条已决策、`diffRef` 非空的 `Approval`"——build 时发现
  `AuditStore` 今天**没有**公开的"按 runId 查 `Approval` 行"方法(只有 `getApprovalById`单点查询
  和 `listStepRefsByRun` 只给字符串、不给完整行)。新增这样一个方法是**改动核心引擎持久化层**
  (`src/loop/audit-store.ts`),超出 batch 1"不碰核心引擎、只读已有公开方法"的风险控制范围。改用
  一个只依赖已有公开方法(`listStepRefsByRun`)的近似判据(`draft#N` 这个 step_ref 存在 = coder
  至少完整跑完一轮),语义上更朴素("产出过候选"而不是"候选已经可查")——**但初版取名
  `hasCandidateDiff` 本身有误导性,Zorro R1 yellow①抓到了这一点,见下方返工记录**。
- 扩展 `conductor-work/ui/server.mjs`:新增 `resolveWorkflowDbPath()` + `getBoardRows()` +
  `GET /api/runs` 端点。初版**逻辑层面只读**(只调 `listRunsByStatus()`/`listStepRefsByRun()`);
  `workflow.db` 不存在时不隐式创建它——**但初版 `AuditStore` 构造器在已存在的文件上仍有真实写
  路径,Zorro R1 blocker B2 抓到并已修复,见下**。既有的 `/api/state`(单 run fixture)零改动。
- 扩展 `conductor-work/ui/{index.html,app.js}`:新增总览表格,每 2-3 秒轮询 `/api/runs`;
  `escapeHtml()` 防 XSS。既有单 run fixture 面板零改动逻辑。
- 更新 `conductor-work/ui/README.md`:新增"多 workflow 总览看板"一节。

**③ 真实自测(手动,非自动化测试,验证端到端行为)**:
- 起 `conductor-work/ui/server.mjs`,先验证空 `workflow.db`(未生成)时 `/api/runs` 走
  `static-fallback`、诚实提示"未找到 xxx"——`curl` 确认 `source:"static-fallback"`。
- 用 `AuditStore` 真实 `insertRun`/`insertStepMarker` 写入两条 fixture run(不经过真实 LLM,纯
  数据库层面模拟"一个 run 正卡在 g1"、"另一个正卡在 review 且已循环 2 轮"),`curl /api/runs`
  确认 `source:"live"`,两行数据的 `phase`/`phaseLabel`/`loopCount`/`hasCandidateDiff` 全部
  正确。**交叉核对**:同一份 `workflow.db` 上跑 `node dist/cli/bin.js list`(既有生产 CLI),
  两个视图(新 web 看板 vs 既有 CLI)的 `id`/`task`/`currentState` 完全一致——证明看板读的确实
  是"`aeloop list` 读的同一份数据",不是另起一套。
- 测试完清理测试用 `workflow.db`(不留任何测试数据在磁盘上)。

**④ §9.6 SQLite 并发读安全性实测(指挥官明确要求在 build 时做)**:
- **结论**:`better-sqlite3` 打开 `workflow.db` 的默认 `journal_mode` 是 `"delete"`(传统 rollback
  journal,**不是** WAL)——如实记录,不是假设。
- **实测**:1 个"写者"(模拟一次真实 dispatch 的完整节点转移序列:`insertRun`→
  `insertStepMarker`→`updateRunProgress`→`insertApproval`→`updateRunProgress`,每条独立开关一次
  `AuditStore` 连接,共 80 次这样的完整序列)与 2 个"读者"(各自独立开关 `AuditStore` 连接,复刻
  `getBoardRows()` 的确切调用序列:`listRunsByStatus()` × 2 + 每行一次 `listStepRefsByRun()`,
  各 150 次)**真并发**跑在同一份真实 `workflow.db` 上(`Promise.all`,写者每次间隔约 5ms、读者
  每次间隔约 3ms——比真实场景激进得多,真实 dispatch 的节点转移间隔是"一次 LLM 调用的时长",
  以秒/十秒计,不是毫秒)。**结果:0 个错误**(无 `SQLITE_BUSY`、无异常、无脏读迹象),726ms 内
  跑完约 380 次读写操作往返。
- **如实的局限**:这不是"证明了在任何负载下都不会碰到 `SQLITE_BUSY`"——`journal_mode:"delete"`
  的锁语义理论上仍然可能在极端高频写入场景下让并发读遇到短暂锁等待/失败,这次测试只覆盖了"接近
  真实使用模式、但读写频率都人为调高很多倍"这一种负载形态,不是穷举证明。真实场景下(写入间隔
  以秒计、UI 轮询 2-3 秒一次)冲突概率显著低于这次压力测试,但没有做过"高负载持续运行数小时"这类
  更严苛的验证——如实标注,不夸大成"已经证明绝对安全"。测试脚本是一次性验证,未保留进仓库(不是
  长期回归测试,是"build 时按指挥官要求实测一次"这个一次性任务的证据)。

**⑤ 完整回归证据(batch 0 + batch 1 全部改动叠加之后)**:
- `pnpm run build`:通过,零 TS 编译错误。
- `pnpm run test`(vitest 全量套件):**59 files / 655 tests 全绿**(相比 batch 0 完成时的 58
  files/634 tests,新增的 21 个测试全部来自 `board.test.ts`)。
- 全部 `scripts/test-*.mjs`(9 个文件,含新增的 2 个)逐一手动跑过,全部 PASS,零失败。
- 全部 `docs/conductor-brain-layer/spike/test-*.mjs`(8 个文件,含改动过的
  `brain-wake-greeting.mjs` 相关的 `test-hook-greeting.mjs` 11 段断言)逐一手动跑过,全部 PASS,
  零回归——`brain-wake-greeting.mjs` 新增的 `CONDUCTOR_DISPATCH_INSTRUCTION` 注入文本没有触发
  任何一条既有断言(“意识已加载。”计数/版本行位置/dbPath 泄漏检测/状态 A-B-C 分支文案等)。

**以上是 Zorro R1 review 之前(初版 batch 0+1)的回归证据。Zorro R1 = FAIL 之后的返工 + 最终回归
证据见下方独立一节,不与初版记录混在一起。**

---

## Zorro R1 返工(2026-07-24)

**Zorro R1 结论:FAIL**(Codex + Zorro 双模型独立确认,6 个 blocker 全部落在真实代码上,不是
主观分歧)。好消息(如实记录,不是自我表扬):batch 0 零回归、wake 注入的三态门状态判断正确
(#96 未破)、新代码没有引入任何 git 写路径、幻觉门(`[?]`/如实标注)整体诚实。以下逐条记录
6 blocker + 7 yellow 的修复,每条都有可核实的证据(测试/手动验证结果),不是"改了就说改了"。

### Blocker 逐条修复

**B1 — candidate-only 今天不是机械强制(指挥官已拍处理方式:诚实记风险,不建机械隔离)**
- 改 `docs/conductor-brain-layer/BRAIN.md` §6:删掉不实声明("candidate-only 是代码层 posture,
  不靠自觉"),换成诚实版本:prompt/契约层约束,非运行时机械强制;coder 走 `bypassPermissions
  --allowedTools Bash`(Bash 非只读);`evaluateExecutionPolicy()` 未接线;coder cwd 钉在 aeloop
  仓库自身,理论上能写自己的工作树。标注为 issue #31 开放风险。
- 同步更新 `.claude/hooks/brain-wake-greeting.mjs` 的 `CONDUCTOR_DISPATCH_INSTRUCTION`(状态 C
  注入文本),补上同样的诚实边界摘要 + "只在 aeloop 自己仓库沙箱内跑,不建议用户拿它处理其它真实
  业务项目"这条指引。
- `docs/conductor-mvp/DESIGN.md` 新增 §1.5(独立小节,不是夹在别处的一句话):完整列出 4 条具体
  依据(契约字段 vs 运行时/`bypassPermissions`/`evaluateExecutionPolicy()` 未接线/coder cwd 能写
  自己工作树)+ 指挥官处理方式(诚实记风险 + 延后到 #31,不建机械隔离)+ "红线未被弱化"的明确
  声明(AUTO_APPROVE_GATES/G3 恒人工/`allowGitWrite:false` 这些既有约束原样保留)。
- **不做**(指挥官原话):真·机械隔离(只读工作区/去掉可写 Bash/落地
  `evaluateExecutionPolicy()`)——本轮完全没有触碰这部分,延后到 #31 单独做。
- **验证**:纯文档改动,`pnpm run build`/`pnpm run test` 全绿(无代码逻辑改动可能受影响)。

**B2 — `/api/runs` 不是物理只读(`AuditStore` 默认构造器读写 + 无条件 `createSchema()`)**
- `src/loop/audit-store.ts` 的 `AuditStore` 构造器新增可选 `opts.readonly`:为 `true` 时用
  `new Database(dbPath, {readonly:true, fileMustExist:true})` 打开、**跳过 `createSchema()`**;
  省略 `opts`(所有既有调用点)行为逐字节不变。
- `conductor-work/ui/server.mjs` 的 `getBoardRows()` 改用 `new AuditStore(dbPath, {readonly:true})`。
- **实测验证**(不是只看代码,真跑了一遍):① 用读写 `AuditStore` 建一个真实 `workflow.db` 并写入
  一条 run,记录 mtime;② 用只读模式打开,`listRunsByStatus()` 正常读到数据;③ 用只读实例尝试
  `insertRun()`,真的抛 `SQLITE_READONLY`;④ 操作后 mtime 与操作前完全相同(字节级验证,不是
  "应该不变");⑤ 对一个不存在的路径用只读模式打开,`fileMustExist:true` 真的抛 `SQLITE_CANTOPEN`
  而不是静默建一个空库——`fs.existsSync()`(没有创建任何文件)确认。
- **回归**:`npx vitest run src/loop/__tests__/audit-store.test.ts` 20/20 全绿(新参数是可选的,
  既有 20 个用例零改动零回归)。

**B3 — 看板 profiles 根硬编码,忽略 `AELOOP_PROFILES_ROOT`;`CONDUCTOR_WORK_PROFILE` 无路径穿越校验**
- `server.mjs` 的 `resolveWorkflowDbPath()` 改为**复用引擎自己的 `loadProfile()`**
  (`src/profile/loader.ts`,`assembleProfileDeps()` 内部调的同一个函数)——不再手写
  `path.join(root, "..", "..", "profiles", profileName)`。`profilesRoot` 解析优先级和
  `assembleProfileDeps()` 一致:显式传入(这里没有)→ `AELOOP_PROFILES_ROOT` env → 包内相对默认值。
- `loadProfile()` 内置的 `isSinglePathSegment()`/`isContainedRealpath()` 检查**同时解决**了
  `CONDUCTOR_WORK_PROFILE` 的路径穿越校验——不需要另写一份检查逻辑(复用,不重造轮子)。
- **实测验证**(三个场景都真跑了,不是只看代码):
  1. 无 `AELOOP_PROFILES_ROOT`(默认场景):`/api/runs` 正确读仓库内 `profiles/subscription/`。
  2. 设置 `AELOOP_PROFILES_ROOT=/tmp/external-profiles-root`(真实建了一个外置 profile 目录 +
     `workflow.db`,里面写了一条 run):`/api/runs` 正确读到 `/tmp/external-profiles-root/
     subscription/workflow.db` 里的数据,`dbPath` 字段确认指向外置路径。
  3. `CONDUCTOR_WORK_PROFILE="../../../etc"`(路径穿越攻击尝试):返回
     `source:"static-fallback"`,`message` 是 `loadProfile()` 抛出的
     `InvalidProfileNameError`("profile names must be a single path segment..."),不崩服务器、
     不越权读取仓库外任意路径。

**B4 — `no_change` 真实终态漏映射;测试用虚构的 `__end__` 冒充"覆盖全部"**
- 核实真源:`src/loop/runner.ts` 的 `computeRunProgress()`(`:304-317`)是唯一实际写
  `WorkflowRun.current_state` 列的函数——`done` 分支只产出 `apply`/`no_change`/`cancel` 三者之一,
  `__end__`/`__start__`(LangGraph 内部图节点名)**从未**被写进这一列。
- `src/conductor-work/board.ts` 的 `PHASE_MAP`:key 集合改为直接从 `LOOP_NODES`
  (`src/loop/workflow-def.ts`)派生(不再手写字符串字面量列表),新增 `no_change → "已完成(无
  改动)"` 映射,删掉从未真实出现过的 `__end__` 条目。
- `board.test.ts` 的覆盖断言改为从 `Object.values(LOOP_NODES)` 派生(不是手写列表)——未来
  `LOOP_NODES` 新增节点名而 `PHASE_MAP` 没跟上,这条测试会失败,不是"看起来测了全部,其实是一份
  手抄的旧列表在假装完备"。
- `DESIGN.md` §3.5 映射表同步订正(标注这是从错误状态订正过来的,不是原本就对)。
- **验证**:`board.test.ts` 从 21 个用例增加到 **26 个**(新增:`no_change` 正确映射、`__end__`
  验证落到未知阶段、覆盖集合防漂移断言),全绿。

**B5 — 会话入口没有真正回出候选摘要 + 证据(头号亮点没达成)**
- `scripts/lib/conductor-dispatch-core.mjs` 的返回值新增 `pendingGate.diffRef`——从
  `handle.interrupt.payload?.diffRef` 取(`GatePayload.diffRef` 在 A4a 里始终内联持有 diff 文本
  本身,这一刻是唯一能拿到"这一轮候选实际改了什么"的地方)。
- `scripts/dispatch-conductor-task.mjs` 新增 `summarizeClaims()`/`summarizeEvidence()`:输出真实
  的 claims 文本/evidence title+ref+content(不是 `claimsCount`/`evidenceCount` 两个数字),经大小
  限制(`MAX_LIST_ITEMS=20`/`MAX_TEXT_LEN=500`/`MAX_DIFF_LEN=4000`,超限显式标 `truncated:true` +
  总数,不静默丢弃)。`pendingGate.diff` 同样经截断但携带真实 diff 文本。
- **验证**(深水区回归,见 yellow③):`test-conductor-dispatch-core.mjs` 新增"真实全链路"测试,
  用 fake coder/tester adapter 真实驱动 `startRun`/`resumeRun` 走完 draft→G1→review→G2(第1轮被
  拒)→draft→G1→review→G3(停),断言 `result.pendingGate.diffRef` 包含真实生成的 diff 文本
  (`"round2"` 字符串,对应 fake coder 第二轮的输出)——不是断言"字段存在",是断言"字段里的内容
  真的对应第二轮 coder 的产出"。

**B6 — #106 集成任务未记录(会与本分支产生真实合并冲突)**
- `DESIGN.md` §2.3 订正:删掉"不需要 batch 1 回头改任何代码"这句不准确的话,新增"⚠️ 与 #106 的
  合并风险"小节——如实说明两个分支都改 `.claude/hooks/brain-wake-greeting.mjs`(本分支 +25 行,
  #106 分支 +171 行 + 重写 `test-hook-greeting.mjs` + 改 `BRAIN.md`),merge 时几乎必然产生真实
  文本冲突,"设计层面两条触发路径互不干扰"这句话不能自动避免代码合并冲突。
- `impact.md` 新增 pre-merge 任务记录(见该文件,§3):rebase 到 #106 merge 后的 main、手工
  reconcile hook/BRAIN.md/`test-hook-greeting.mjs`、重跑三路径守卫 + A/B/C 注入测试。
- **本轮(R1)明确不执行 rebase**——#106 当时尚未 merge,时序由指挥官在 #106 merge 后协调,对着一个
  还会变的基线做 rebase 是无意义的工作。**⚠️ 这是 R1 时点的记录,不是最终状态**:#106 已于 R2 阶段
  merge,rebase + reconcile 已在下方"Zorro R2 返工 §0"真实执行,不要把这条 R1 记录误读成"至今没做"。

### 7 个 yellow 逐条清

**①`coderRoundCompleted` 对 `no_change` 的误报(结合改名解决)**——`no_change` 场景下
`insertStepMarker()` 对 draft 节点仍无条件调用,`draft#1` 依然存在,旧名 `hasCandidateDiff` 在这
种场景下会返回 `true` 但根本没有 diff。改名为 `coderRoundCompleted`(`board.ts` 的
`coderRoundCompletedFromStepRefs()`)——这个更朴素的问题("coder 有没有真的跑完过一轮")无论这
一轮是否产生真实 diff 都成立,不再暗示"一定有 diff 存在"。`board.test.ts` 新增专门用例验证
no_change 场景下这个字段仍然是 `true`(如实反映"跑完了一轮"),但列头改成"Coder 完成轮次"(带
title 提示),不再叫"候选 Diff"。

**②`/api/runs` 拉取失败的文案 vs 实际行为不一致**——`app.js` 原来失败时调用同一个 `renderBoard()`
函数,传 `rows:[]`,函数内部 `if (rows.length===0) rowsEl.innerHTML=""` 会真的清空表格,但文案说
"保留上一次成功渲染的内容"。修法:新增独立的 `renderBoardFetchError()`,只更新错误提示条,**不碰
`#board-rows` 这个 DOM 节点**——"保留上一次成功渲染的内容"现在是代码行为本身保证的,不是一句从
没被兑现的承诺。

**③共享核心/CLI 测试覆盖太浅**——原先只测到"assembleDeps 被调用那一刻"为止。新增深水区回归(见
`scripts/test-conductor-dispatch-core.mjs`):真实 fake-adapter 驱动 `startRun`/`resumeRun` 走完
① G1→G2→G3 停止(第1轮拒、第2轮过,验证 coder/tester 各被调用 2 次、`pendingGate.gate` 正确、
`pendingGate.diffRef` 含真实内容、`runId`/`threadId` 是真实值)② Escalation 停止(持续 reject 超
`rejectThreshold`,验证停在 `ESCALATION_ACK` 不是 `G3`)③ `no_change` 终态(验证 `done:true`、
`pendingGate:null`、tester 从未被调用)。新增 `AUTO_APPROVE_GATES` 导出 + 内容断言(恒等于
`{G1_SEND_TO_TESTER, G2_SEND_TO_FIX}`,不含 G3/Escalation)。测试组数从 11 增到 **26**。

**④hook A/B/C 状态缺少断言**——`test-hook-greeting.mjs` 的状态 A(⑧)/状态 B(⑨)新增断言:
`additionalContext` **不**包含 `"dispatch-conductor-task.mjs"`(用户还没配置好环境,不该看到派发
指引);状态 C(⑩)新增断言:`additionalContext` **必须**包含该字符串 + `"不要念给用户听"`(这是
指引真正生效的唯一分支)。

**⑤`threadId` 核心返回但 CLI 丢弃**——`dispatch-conductor-task.mjs` 的输出 JSON 补上 `threadId`
字段(供未来 batch 3 对话式 resume 用,本轮 CLI 本身不使用它,但不再无声丢弃)。

**⑥"不写盘"措辞收窄**——`DESIGN.md`/`PRD.md`/`BRAIN.md` 里所有笼统的"不写盘"改为准确表述"不写
候选到工作区/不 apply/不 git write"——共享核心确实把 `TaskContract` JSON 写到磁盘的安全沙箱路径,
`runner.ts`/三态门也确实写 `workflow.db`/身份库,这些是有意的、审计需要的落盘,和"候选代码写进
目标工作区"是两回事,原措辞会让人误以为"完全不落盘"。

**⑦DESIGN/PRD 表头"待指挥官确认"→"指挥官已确认"**——两份文档的顶部状态行更新为"指挥官已确认
方向 + §9 关键决策;Zorro R1 = FAIL,本版本是返工后的 R2 送审稿",不再是过时的"待确认"。

### 最终回归证据(Zorro R1 返工全部完成之后,干净重跑一遍)

- `rm -rf dist && pnpm run build`:通过,零 TS 编译错误(从零开始重新编译,不是增量编译侥幸过)。
- `pnpm run test`(vitest 全量套件):**59 files / 660 tests 全绿**(相比返工前的 655,新增 5 个
  来自 `board.test.ts` 的 B4 相关用例)。
- `pnpm run lint`(`tsc --noEmit`):通过,零类型错误。
- 全部 `scripts/test-*.mjs`(9 个文件)+ 全部 `docs/conductor-brain-layer/spike/test-*.mjs`(8 个
  文件)逐一重新手动跑过,**17 个文件全部 PASS,零失败**——包含改动过的
  `test-conductor-dispatch-core.mjs`(11→26 组断言)、`test-hook-greeting.mjs`(新增 A/B/C 三处
  断言)。
- `git diff --stat -- src/`(核心引擎改动面,真实命令输出,如实报——`git diff --stat` 只显示已
  跟踪文件的差异,`board.ts`/`board.test.ts` 是本轮新建的未跟踪文件,不会出现在这条命令里,单独
  用 `git status --short -- src/` + `wc -l` 核实,两条命令的输出都原样贴出,不合并成一份可能失真
  的摘要):

```
$ git diff --stat -- src/
 src/loop/audit-store.ts | 32 +++++++++++++++++++++++++++++---
 1 file changed, 29 insertions(+), 3 deletions(-)

$ git status --short -- src/
 M src/loop/audit-store.ts
?? src/conductor-work/__tests__/board.test.ts
?? src/conductor-work/board.ts

$ wc -l src/conductor-work/board.ts src/conductor-work/__tests__/board.test.ts
     138 src/conductor-work/board.ts
     161 src/conductor-work/__tests__/board.test.ts
```

  核心引擎(`src/loop/`)唯一改动是 `audit-store.ts`(+29/-3 行,新增一个默认关闭的可选只读构造
  参数),不影响任何既有调用点的行为;`src/conductor-work/board.ts`(138 行)+
  `src/conductor-work/__tests__/board.test.ts`(161 行)是全新文件,batch 1 本来就要新建。
- **仍未做(如实标注,不是遗漏)**:真实端到端 LLM 调用(需要认证的 subscription profile,本轮
  build 会话没有真实凭证,也不应该在这类环境里起真实嵌套 agent 调用)——等价的确定性行为路径已
  用 fake adapter 验证过(见 blocker B5/yellow③),但"真实模型说人话、真实 Bash 工具执行"这一层
  没有被本轮验证,留给指挥官/有真实终端访问权限的人补验。

---

## Zorro R2 返工(2026-07-24)

**Zorro R2 结论:FAIL,离 PASS 很近**——R1 的 6 blocker 全部真修好、7 yellow 全清、660 测试绿、
candidate-only 相关的值全部守住(如实记录这句肯定,不是自我表扬,是 Zorro R2 原话的转述)。剩 2 个
小 blocker(RB1/RB2)+ 一件集成事(#106 已 merge,这轮把 rebase + reconcile 一起做完,不再拆两步)+
4 个低优先级 yellow(明确"能捎就捎,不强求")。以下逐条记录,全部已完成。

### 0. 前置:rebase + reconcile(B6 的真正落地,这轮的头等大事)

**背景**:#106 已于 2026-07-24 merge 到 `origin/main`(`1e36531`)。本分支此前一直没有自己的
commit——所有改动都是未提交的工作树修改(遵守"未经批准不 commit"红线)——所以这不是传统意义上
"replay 若干个 commit"的 rebase,而是"把 origin/main 的新内容拉进来,再把未提交的工作树改动在
新基线上重新对齐"。

**操作记录(真实执行的命令,不是转述)**:
1. `git fetch origin` → 确认 `origin/main` = `1e36531`,和本分支的合并基线(`13c2bf1`)之间只差
   #106 这一个 merge commit。
2. `git log --oneline -5` 确认本分支 `HEAD` 恰好等于合并基线(`13c2bf1`)——**零自有 commit**,
   所有工作是未提交的工作树状态。
3. `git stash push -u -m "..."` (含 `-u`,把 `docs/conductor-mvp/`、`scripts/lib/` 等未跟踪的新
   文件也一起 stash,不遗漏)。
4. `git rebase origin/main` → 因为没有自有 commit,这一步是纯 fast-forward,零冲突。
5. `git stash pop` → **两个文件产生真实冲突**:`.claude/hooks/brain-wake-greeting.mjs`、
   `docs/conductor-brain-layer/BRAIN.md`;`docs/conductor-brain-layer/spike/test-hook-greeting.mjs`
   (#106 改了约 463 行,含给每个既有测试块的 `env:{...}` 加 `HOME: fakeHome`)**三方合并自动成功**,
   没有冲突标记——git 的上下文感知合并正确处理了"我的新增断言"和"#106 给每个 env 对象加一行"这两类
   互不重叠的改动。

**冲突手工 reconcile(逐个记录,不是笼统说"解决了")**:
- **`brain-wake-greeting.mjs`**:冲突集中在文件顶部的常量声明区域(上游新增
  `VALID_HOOK_EVENT_NAMES` + 新签名 `emitAdditionalContext(text, hookEventName)`,本分支新增
  `CONDUCTOR_DISPATCH_INSTRUCTION` 常量声明)——**两边都保留,调整声明顺序**:
  `VALID_HOOK_EVENT_NAMES` → `CONDUCTOR_DISPATCH_INSTRUCTION`(连同它的 JSDoc,补充说明"三事件
  路径下,这段只拼进状态 C 的 `injected` 文本里")→ 新签名的 `emitAdditionalContext()`。
  **值得记录的一点**:文件真正关键的那一行——状态 C 分支里
  `` `...\n\n${greeting}\n\n${CONDUCTOR_DISPATCH_INSTRUCTION}` `` 拼接、以及调用
  `claimAndEmit({text: injected, ...})`(#106 新的统一输出关口,取代旧的直接调
  `emitAdditionalContext(injected)`)——**git 的三方合并自己就处理对了,不在冲突标记范围内**,
  没有手工改一个字符。这意味着 #106 把状态 C 的输出方式换成 `claimAndEmit()` 之后,我在
  `injected` 字符串末尾追加 `CONDUCTOR_DISPATCH_INSTRUCTION` 这个动作自动跟着挪到了新的调用点,
  完全不需要人工干预——两处改动本来就落在同一行的不同"层次"(字符串内容 vs 外层函数调用),
  git 的上下文合并算法正确识别了这一点。
- **`BRAIN.md`**:冲突在 §5"Phase1 诚实边界"——上游改写了第一条 bullet(补充三层触发路径说明),
  本分支改写了第二条 bullet(补充"现在有一条会话触发路径"说明)。**两条 bullet 都保留**,合并后
  再补一条新的第三条 bullet 把"醒来出开场白 + 一次性派发,不含完整打断/恢复闭环"这个边界说清楚
  (原本两条 bullet 分别改了不同的半句话,合并后需要一条新的收尾句子把两边的更新逻辑上连起来,
  不是简单拼接)。
- **`test-hook-greeting.mjs`**:如上,零手工干预,git 自动合并成功。

**融合后的验证(不是"合并完就假设没事",真跑了一遍)**:
- `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs`——**21 段全部 PASS**:①-⑦(既有
  基础断言,如注入安全/版本行/dist 缺失 fail-soft)+ ⑧⑨⑩(本分支的 A/B/C 派发指令断言,状态
  A/B 不含 `"dispatch-conductor-task.mjs"`、状态 C 必含)+ ⑪(#103 taskSource)+ **⑫-㉑
  (#106 新增的三路径守卫测试:UserPromptSubmit 事件分派/`--standalone` 模式/共享守卫互斥/
  guard I/O 故障不吞开场白/guard 状态目录被文件占据的边角情形,共 10 段)**。
- `rm -rf dist && pnpm run build`:干净重编译,零错误(`gitSha` 已经变成 `1e36531`,证明基线真的
  切过来了,不是残留旧 dist 侥幸过)。
- `pnpm run test`(vitest):59 files / 665 tests 全绿。
- 全部标准测试脚本重新手动跑过一遍(见下方"最终回归证据"),含 #106 真正新增的
  `.claude/hooks/lib/wake-session-guard.mjs`/`test-wake-session-guard.mjs`(用
  `git diff 13c2bf1..origin/main --diff-filter=A` 核实过是新增文件,不是猜的,`.claude/hooks/lib/`
  下另外几个 test-*.mjs 是既有文件)。

**文档同步**:`impact.md`"§4 #106 合并风险"那条"pre-merge 任务,本轮不执行"已更新为"本轮已执行"
状态,记录完整操作步骤;`DESIGN.md` §2.3 同步订正(见下方 RB2)。

### RB1(红线硬化回退,必堵——已修复)

**问题**:`conductor-dispatch-core.mjs` 的 `AUTO_APPROVE_GATES` 在 R1 阶段被直接 `export const
... = new Set([...])`——`const` 只锁定变量绑定不可重新赋值,锁不住 `Set` 实例的 `.add()`/
`.delete()` 等可变方法。任何 `import` 到这个 `Set` 的调用方(比如测试文件,也包括未来任何一个
不小心的调用方)都能真的执行 `AUTO_APPROVE_GATES.add("G3_FINAL_MERGE")`,一旦被调用,自动批循环
(`isAutoApproveGate()`/原来的 `.has()` 判断)就会真的自动批准 G3——直接击穿"G3/Escalation 恒
人工"这条不可弱化的红线。

**修复**:
- 这个 `Set`(改名 `AUTO_APPROVE_GATES_INTERNAL`)不再 `export`,保持模块私有。
- 新增 `export function isAutoApproveGate(gate)`——自动批循环(`while (handle.interrupt &&
  isAutoApproveGate(handle.interrupt.gate) && !handle.done)`)和外部调用方都用这一个函数判断,
  不直接触达内部可变 `Set`。
- 新增 `export const AUTO_APPROVE_GATE_NAMES = Object.freeze([...AUTO_APPROVE_GATES_INTERNAL])`
  ——真正 `Object.freeze()` 过的数组快照,严格模式下 `.push()`/索引赋值会真的抛 `TypeError`,
  不是像 `const Set` 那样"看起来不可变、实际方法都能调"。
- `scripts/test-conductor-dispatch-core.mjs` 改用这两个新接口重写断言,新增一条专门验证
  "`AUTO_APPROVE_GATE_NAMES.push()` 真的抛错"的测试(不只是断言内容对,还要断言"真的冻结了"
  这个更强的属性)。
- **验证**:`node scripts/test-conductor-dispatch-core.mjs` 28 组断言全绿(比 R1 结束时的 26 组
  多 2 组,新增的冻结性断言);全链路真实测试(G1→G2→G3 停止/Escalation/no_change)全部沿用
  R1 已验证过的路径,零回归。

### RB2(1 分钟——已修复)

`PRD.md` 里"Batch 1 验收点"那条注释仍写"VSCode 入口待 #106 落地后自动生效,不需要 batch 1 回头
改代码"——这句话本身就是 DESIGN §2.3 已经判定为不准确、B6 要消灭的那句话,R1 返工时改了
DESIGN §2.3 但漏改了 PRD 里的这条重复表述。已同步订正,措辞对齐 DESIGN §2.3,并且**现在 reconcile
真的做完了**,措辞相应改成"已 reconcile"而不是"待 #106 merge 后协调"。

### 4 个低优先级 yellow(明确"能捎就捎,不强求"——这轮全部顺手清了)

1. **`conductor-work/ui/README.md` 幻觉门**:①`:51` 仍把 DB 路径描述成固定
   `profiles/<profile>/workflow.db`、完全不提 `AELOOP_PROFILES_ROOT`,但 `PRD.md` 已经声称 README
   记录了这个 env——两边对不上,是真实的文档幻觉。已订正为准确描述(`loadProfile()` 复用 +
   `AELOOP_PROFILES_ROOT` 优先级 + 路径穿越校验同时被 `loadProfile()` 内置检查覆盖）。②`:~70`
   仍用旧字段名 `hasCandidateDiff`/旧语义"是否已产出候选 diff"描述已经在 R1 改名的
   `coderRoundCompleted`——已同步改名 + 补充"这个字段在 `no_change` 场景下同样是 `true`,不等于
   有 diff 可看"这条 R1 已经在代码注释里写清楚、但 README 没跟上的说明。
2. **`server.mjs` 的 profiles root 空字符串边界**:`CONDUCTOR_WORK_PROFILE`/`AI_AGENT_PROFILE` 的
   解析原来用 `??`(nullish coalescing)——`CONDUCTOR_WORK_PROFILE=""`(空字符串,不是
   null/undefined)不会被 `??` 当成"未设置"处理,会被当成"显式选了一个名叫空字符串的 profile"
   往下传。`loadProfile()` 自己的 `isSinglePathSegment("")` 会安全拒绝这个值(不崩溃、走既有
   `static-fallback` 降级路径,已用 `isSinglePathSegment` 源码核实过 `segment.length === 0` 这条
   显式检查)——**不是安全漏洞**,但语义上不够干净:空字符串更应该被当成"等于没设置,退到下一
   优先级"。改用 `||`(和已有的 `AELOOP_PROFILES_ROOT` 处理方式保持一致),已手动验证
   `CONDUCTOR_WORK_PROFILE=""` 时正确落到 `"subscription"` 默认值。
3. **`AuditStore` readonly 模式补单元测试**:R1 阶段只用一次性手写脚本手动验证过("跑完就删",
   不是长期回归)。新增 `src/loop/__tests__/audit-store.test.ts` 的
   `describe("AuditStore — opts.readonly constructor mode")` 区块(5 个用例):读操作成功、写
   操作真的抛 `SQLITE_READONLY`、mtime 不变、缺失文件时 `fileMustExist:true` 真的抛错(不隐式
   建库)、省略 `opts` 时默认行为不变(读写皆可)。全部通过,vitest 总数因此从 660 涨到 665。
4. **`PRD.md`"逐字节不变" → "行为等价"**:`AuditStore` 那条任务清单原话"默认行为(省略 opts)
   逐字节不变"——字面意思是"一个字节都没改",但构造函数本身确实多了几行分支判断代码,不是字面
   意义上的零改动。改成"行为等价"(省略 `opts` 时产出的实例行为和改动前完全一致),更准确。
   顺手核对了 `BRAIN.md:227` 附近"怎么回应用户"那段——发现只提到 `evidence.claims.items`,没有
   提到 `evidence.evidence.items`(真实的 `EvidenceItem[]`,和外层 `evidence` 小节撞名,容易被
   忽略)——已补充说明这层嵌套 + 明确指出两个字段都要用,不能只报 claims 不报 evidence 本身。

### 最终回归证据(Zorro R2 返工全部完成之后,干净重跑一遍)

- `rm -rf dist && pnpm run build`:通过,零 TS 编译错误(基线已切到 `1e36531`)。
- `pnpm run test`(vitest 全量套件):**59 files / 665 tests 全绿**(比 R1 结束时的 660 多 5 个,
  全部来自新增的 `AuditStore` readonly 单元测试)。
- `pnpm run lint`(`tsc --noEmit`):**中途发现一处真实类型错误**(`audit-store.test.ts` 新增的
  只读模式测试里 `runs[0].task` 触发 `TS2532: Object is possibly 'undefined'`——`noUncheckedIndexedAccess`
  规则),已用仓库既有惯例(`[0]!` 非空断言,`config.test.ts`/`app.test.ts`/`runner.test.ts` 都是
  这个写法)修复,不是绕过检查。修复后 lint 通过,零类型错误。
- 全部标准测试脚本(9 个 `scripts/test-*.mjs` + 8 个 `docs/conductor-brain-layer/spike/
  test-*.mjs` + 6 个 `.claude/hooks/lib/test-*.mjs`,**共 23 个独立测试文件**)逐一手动重新跑过,
  **全部 PASS,零失败**。
- `git diff --stat -- src/`(核心引擎改动面,真实命令输出):

```
$ git diff --stat -- src/
 src/loop/__tests__/audit-store.test.ts | 96 ++++++++++++++++++++++++++++++++++
 src/loop/audit-store.ts                | 32 ++++++++++--
 2 files changed, 125 insertions(+), 3 deletions(-)

$ git status --short -- src/
 M src/loop/__tests__/audit-store.test.ts
 M src/loop/audit-store.ts
?? src/conductor-work/__tests__/board.test.ts
?? src/conductor-work/board.ts
```

  `src/loop/audit-store.ts` 的改动(+29/-3,R1 时已有)本轮没有再变;`audit-store.test.ts` 新增
  96 行(yellow③ 的 5 个新用例),是本轮唯一新增的核心引擎相关改动,纯测试代码,不改变任何生产
  行为。`src/conductor-work/board.ts`/`board.test.ts` 是 R1 就已建的新文件,本轮未改动。
- **仍未做(如实标注,不是遗漏,延续 R1 结论)**:真实端到端 LLM 调用——本轮同样没有真实凭证,
  也不应该在这类环境里起真实嵌套 agent 调用,继续留给指挥官/有真实终端访问权限的人补验。

---

## 决策记录(可追源)
- 2026-07-24 决定 batch 1 = 派发闭环 + 看板总览打包交付(不是分开两个 batch),因为:①两者都是
  "MVP 头号亮点"指挥官原话点名的内容;②看板总览的数据源(`workflow.db`)天然需要至少一次真实派发
  才有东西可看,demo 上把两者放一起最合理——理由见 DESIGN §7.1/PRD §5。
- 2026-07-24 决定派发胶水层走"抽取共享核心"(DESIGN §7.3 方案 B),不是直接复用
  `dispatchBrainTask()`(方案 A)或完全独立重写(方案 C)——因为方案 A 会把 #2 和 #93 的"项目注册"
  语义耦合在一起,方案 C 重复维护踩过并发坑的逻辑,方案 B 是唯一不重造轮子又不引入耦合的路径。
- 2026-07-24 决定看板走轮询而非 WebSocket/SSE(DESIGN §3.4 方案 A)——`WorkflowRun.currentState`
  已经是持久化、跨进程可读的数据,轮询零新增基础设施;真正的"进行中"细粒度状态需要新的跨进程事件
  转发机制,工作量明显超出 MVP,留后续 batch。
