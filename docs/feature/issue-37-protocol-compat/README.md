# Issue #37 —— RunPlan 与 workflow 版本的 fail-closed 协议兼容性:审计现状

状态:**仅文档,没有改动任何运行时代码**。这次审计发现,issue 要求加门的那个具体边界——一个
`RunPlan` reload/replay/re-entry 调用点——在代码库里目前哪里都不存在。按这个任务的决策规则,没有
加任何 fail-closed 检查;本文档如实记录到底缺了什么、以及前提条件要先具备什么。

## 1. issue 假设的情况 vs. 代码实际的情况

issue 正文写道:

> RunPlan.planVersion is emitted as `1` but never validated on re-entry.
> (RunPlan.planVersion 会被设成 `1` 发出去,但从未在 re-entry 时被校验过。)

这话本身没说错,但"从未在 re-entry 时校验"这个说法低估了实际的缺口:根本就不存在对
`RunPlan` 的任何 re-entry,校验与否都无从谈起。`RunPlan` 是一个**只写、纯内存、单次调用的产
物**。运行时里没有任何东西会把它持久化到磁盘/数据库,再在之后读回来去 resume、replay 或
re-enter 任何东西。

## 2. 端到端追踪 `RunPlan`

- `RunPlan` 定义在 `src/conductor/run.ts:18-29`,`planVersion: "1"`。
- 唯一的生产者是 `Orchestrator.planRun()`(`src/conductor/orchestrator.ts:47-61`),它每次被调用
  时都会从一个 `RunRequest` 现造一个全新的 `RunPlan` 对象——没有缓存,没有存储,也没有按 id 查
  找。
- `planRun()` 唯一的调用方是 `ConductorWorkApp.planRun()`
  (`src/conductor-work/app.ts:29-33`),而它本身只在 CLI 的
  `plan --json` 命令(`src/conductor-work/main.ts:21-24`)里被调用:
  ```ts
  const runPlan = app.planRun(path.resolve(contractPath));
  output(JSON.stringify(runPlan));
  ```
  这就是它完整的生命周期:造一次,`JSON.stringify` 输出到 stdout,结束。没有文件写入,没有数据库
  插入,也没有第二个命令能把之前发出去的 `RunPlan` 读回来。
- 用 `grep -rn "planRun|RunPlan" src` 核实过(排除测试):非测试的命中全都是上面这三处
  定义/调用点。哪里都没有对一份持久化的 plan 做 `readFile`/`JSON.parse`,也没有任何地方比较过
  `planVersion`。

**结论:**今天没法实现一个"RunPlan reload/replay/re-entry 边界",因为这句话里 reload 的那一半根本
不存在。新写一个 `assertCompatibleRunPlan()` 函数,并在 `planRun()`(目前唯一一处代码会碰到
`RunPlan` 对象的地方)里调用它,并不是给一次 reload 加门——而是在刚构造出这个 plan 的同一次调用
里,拿它去校验它自己,对类型系统本来就已经接受的任何输入,这种校验永远不可能失败。这正是这个任务
明令禁止的"一个没人真正为了它本来的用途去调用的、没用的校验函数"模式。

## 3. 最接近的真实 reload/re-entry 边界——以及为什么它不是 `RunPlan` 的

代码库里确实有一处真正的"加载持久化状态并重新进入执行"调用点:`src/loop/runner.ts:1008` 的
`resumeRun()`(经由 `aeloop resume <runId>` → `src/cli/main.ts:141-162` →
`src/cli/run-loop.ts` → `getPendingInterrupt`/`resumeRun` 到达)。它会:

- 按 id 加载一条持久化的 `workflow_runs` 行(`deps.audit.getRunById(runId)`,
  `src/loop/audit-store.ts:602`),
- 校验 `run.langgraphThreadId === threadId`(`RunThreadMismatchError`,
  `runner.ts:1027-1029`),
- 校验 resume 决定是否属于当前待处理 gate 的决定域
  (`ResumeDecisionDomainMismatchError`,`runner.ts:1036-1038`),
- 然后重新进入那个 thread 的 LangGraph checkpoint。

这是一条真实的、当前可达的 reload/re-entry 路径,并且已经带有 fail-closed 守卫——但它重新加载的是
一个和 `RunPlan` **不同的结构**,而这个结构没有版本这个维度可以拿来加门:

- 持久化的行类型是 `WorkflowRun`(`src/loop/audit-store.ts:51-64`):
  `id`、`task`、`workflowDefId`、`profile`、`status`、`rejectCount`、
  `rejectThreshold`、`currentState`、`langgraphThreadId`、`createdAt`、`updatedAt`。
  没有 `planVersion`,没有 workflow 的 `version`/`inputVersion`/`outputVersion`,也没有任何
  schema 版本字段。`CREATE TABLE workflow_runs` 的 DDL
  (`audit-store.ts:405-`)里同样没有这样的列。
- `resumeRun()` 的签名(`runner.ts:1008-1015`)不接受 `WorkflowManifest` 或
  `RunPlan`——它是通过 `compileLoopGraph(buildLoopGraph({ router, composer }), checkpointer)`
  (`runner.ts:1040`)**硬编码**重建那张图,而不是按每次 run 持久化的 `workflowDefId` 从
  `WorkflowRegistry` 查出来再选一个。`workflowDefId` 在 `startRun`/`resumeRun` 的记账过程中会被
  写入(`runner.ts:859`、`893`),但在 resume 时从未被读回来用于选择或校验任何东西。
- CLI 里真实的 `aeloop resume <runId>` 路径(`cli/main.ts` → `run-loop.ts`)完全不碰
  `Orchestrator`、`WorkflowRegistry` 或 `WorkflowManifest`——它直接调用
  `getPendingInterrupt`/`resumeRun`。所以即便 workflow manifest 自己确实存在的那几个
  `version`/`inputVersion`/`outputVersion` 字段(`src/workflow/types.ts:31-32`,作为静态元数据存
  在),在这条路径上也从来不会被查阅。
- 这几个 manifest 版本字段今天只做两件事:(a) 在 `planRun()` 时被原样复制进一个刚构造的
  `RunPlan.workflow.version`(`orchestrator.ts:55`),不和任何东西比较;(b) 在
  `WorkflowRegistry.register()` 时只做形状校验(是否非空字符串)(`registry.ts:39-43`,
  `assertManifest`)——从未在任何地方针对一个持久化的值做过*兼容性*校验。

**结论:**运行时里唯一真实的 reload/re-entry 调用点(`resumeRun`)操作的是一个今天不携带任何版本
信息的持久化结构,并且在架构上和 `RunPlan`/`WorkflowManifest` 是脱节的(单一的硬编码 workflow
图,没有按 workflow 版本分发)。要在"RunPlan 版本"上给它加门,得先发明并接通一整套新的持久化
状态——一次给 `workflow_runs` 加版本列的 schema 迁移、在 `startRun` 时从那个从未被持久化过的
`RunPlan`/manifest 里填充这一列的代码,以及在 `resumeRun` 时把它读回来的代码——这些今天全都不
存在。这已经远超"在一个既有调用点加一个最小的 fail-closed 检查"这个任务允许的范围;这是在从零
搭建这个边界,而任务明确说了不要这么做。

## 4. 前提条件必须先具备什么(按依赖顺序)

1. **`RunPlan`(或等价物)必须先被真正持久化到某个之后能被 reload 回来的地方**——比如
   `startRun()` 在 run 创建时把 `RunPlan`(或只是它的 `planVersion` + `workflow.id`/
   `workflow.version`)写进 `workflow_runs`(或一张新表)。今天 `startRun()`/
   `NewWorkflowRunInput`(`audit-store.ts:67-76`)完全看不到 `RunPlan`——`ConductorWorkApp`/
   `Orchestrator` 和 `src/loop/runner.ts` 是两个互不调用的独立层(生产代码里如此;只在测试/
   fixture 里有接线,如果有的话——见 `src/workflow/coder-tester.ts` 直接调用 `startRun`/
   `resumeRun`,完全绕过了 `Orchestrator.planRun()`)。
2. **`resumeRun()`(或它的调用方)必须把那个持久化的版本值也读回来**,和它已经在加载的
   `workflow_runs` 行一起。
3. **只有到了这一步**,在那个 reload 点加一个 fail-closed 的
   `assertCompatibleRunPlan(persistedVersion)`(或
   `assertCompatibleWorkflowVersion(...)`)调用才有一个真实的、当下产生出来的值可以去比对——到
   那时,issue 要求的这个检查才会变成对一个已经真实存在的调用点做的、最小的、非臆造的补充,正好
   落进任务规则的第一分支。
4. 另外,如果/等到 `resumeRun()` 开始按持久化的 `workflowDefId` 通过
   `WorkflowRegistry.get()` 去选图,而不是现在这样硬编码调用 `buildLoopGraph()`,那才是真正会
   出现一个"workflow manifest 兼容性"消费方的时刻(把这个 run 启动时的 manifest 版本,和当前
   注册在这个 `workflowDefId` 下的 manifest 版本做比较)——今天 registry 里只有一个 workflow
   定义(`coderTesterWorkflow`),也没有任何在 resume 时按 id 分发的代码路径,所以没有东西可以
   拿来给一个兼容性检查做比较。

## 5. 为什么这个 issue 没有写任何代码

按这个任务的决策规则:实现一个版本检查需要一个真实存在的、会消费"被校验对象"的 reload 调用点。
`RunPlan` 有一个生产者(`planRun()`),但没有任何消费方会把之前产出的实例 reload 回来——这个代码
库里存在过的每一个 `RunPlan`,一生一世都活在单次 `plan --json` CLI 调用之内。真正会 reload
持久化状态的那个东西(`resumeRun()`)reload 的是另一个没有版本、和 `RunPlan`/
`WorkflowManifest` 没有任何关联的结构。写一个 `assertCompatibleRunPlan()` 并在今天任何可达的
地方调用它,结果必然是要么 (a) 在同一次刚构造出 `RunPlan` 的调用里,拿它去校验它自己(空洞——
不可能失败),要么 (b) 一个导出了却没人调用的辅助函数,等一个目前还不存在的未来调用方。这两种
情形都恰好是这个任务明确禁止的。上面 §4 就是前提条件清单;等第 1-2 步落地之后,这个 issue 要求
的"最小 fail-closed 检查"就会是一个范围小、边界清楚、有真实价值可以校验的后续工作。
