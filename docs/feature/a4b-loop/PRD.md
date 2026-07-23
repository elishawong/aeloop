# PRD — aeloop A4b:Loop 编排收尾(阈值升级 + 三张审计表持久化 + checkpoint 跨进程生产化)

> 骨架来源:`aeloop/docs/feature/a4a-loop/PRD.md`(同一个里程碑的另一半;结构/批次/措辞风格直接照抄——§0 的范围拆分是那份文档定的)。
> 防幻觉:`[?]` = 我没验证过 / 需要指挥官确认;不编造接口/版本/参数。这份 PRD 里任何关于既有代码的陈述,都来自我自己阅读真实的 A4a 代码(`src/loop/*.ts`)+ `docs/DESIGN.md` + `docs/feature/a4a-loop/spike-findings.md`,不是凭记忆;没有直接代码/文档证据、需要我自己判断的设计决定,都单独列在 §9,不跟"已验证"的部分混在一起。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-13-a4b-loop`(从 main `c6589b7` 新切出来,也就是 A4a 合并后的 HEAD)
- **优先级**:P1
- **状态**:等指挥官确认
- **最后更新**:2026-07-21
- **关联 issue**:[elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13)(A4 Loop 父 issue)——**⚠️ 验证时发现一件需要指挥官/军师先裁决的事,见 §0.1**
- **设计权威**:`aeloop/docs/DESIGN.md`(§4 gate 流程图 / §5 三张审计表的 ER / §6 `src/loop/` 目标目录结构,包含 `escalation.ts` / §7 `config.yaml` 的 `workflow.reject_threshold` / §8.5 方法论提醒)+ 真实的 A4a 代码 `src/loop/{types,errors,gates,graph,checkpoint,workflow-def}.ts`/`nodes/{coder,tester}.ts` + A4a 的 `docs/feature/a4a-loop/{PRD.md,spike-findings.md}`

---

## 0. 范围(延续 A4a PRD §0 已经定下的拆分)

A4a PRD §0 把 A4 Loop 的父范围拆成了两半,并已经记录了拆分理由。A4b(本 PRD)交付留下来的那一半:

1. **阈值升级硬分支**——`reject_count >= threshold` 的条件路由 + `Escalation` 节点 + 人工三选一决定(revise 代码/重述 → Draft,force pass → G3,abandon → Cancel)+ `Cancel` 终态。`config.yaml` 的 `workflow.reject_threshold`(存在但没人读,A4a §2 明确标为本增量之外的 non-goal)在本增量首次被读取。
2. **三张审计表持久化**——`workflow_runs`/`structured_claims`/`approvals`(DESIGN §5 的 ER)真正建出来、真正写进去。A4a 的 `gateLog`(顺带靠 LangGraph checkpoint 持久化下来)是这三张业务表(尤其是 `approvals`)在字段命名上的前身。
3. **checkpoint 跨进程续跑,生产化**——把 `langgraph_thread_id` 存进 `workflow_runs`,把"只靠这次 run 的一个标识(不是任何内存引用)就能找到 thread_id 并在全新进程里续跑"这条完整路径搭起来。A4a spike Q4 已经用两个真实的 `node` 子进程,在本仓库/本技术栈上证明了 LangGraph 自己的 checkpoint 机制本身是可信的。A4b 需要证明的是 aeloop 在它之上接的这一层(`workflow_runs` 查找 → checkpointer 构造 → 续跑)在生产语义下也站得住。

### 0.1 对 issue #13 现状的验证结果——有件事需要指挥官/军师先裁决

按分派说明,本 PRD 不新开 issue,继续用 #13(A4a PRD §0.1 已经立了这个先例)。但我跑 `gh issue view 13` 核实时发现,**issue #13 目前是 `CLOSED`**(`state: CLOSED`)。对照 A4a 的合并 PR #15,它的 body 里明写着"父 issue A4 Loop 的 A4a 子范围 issue #13(A4b……还没来,所以这个 PR **不**关闭 #13)",但 `gh pr view 15 --json closingIssuesReferences` 显示 #13 事实上被 PR #15 关联成了一个"closing issue"(`mergedAt: 2026-07-21T00:43:10Z`)——**这跟 PR 作者(Cypher,之前一轮)明写的意图矛盾**。最可能的情况是,commit message/PR body 里某处的 `#13` 文本触发了 GitHub 的自动关闭关联(比如像 `feat(loop): #13 A4a Loop orchestration...` 这样的 commit message 在某些语境下会被读成关闭关键字,哪怕 body 里另一句话明写"不关闭"),不是指挥官故意关的。

**我没有自己重新打开这个 issue**——一个 issue 的生死状态不在"出 PRD"这个正常职权范围内,我也不能排除指挥官在看完 A4a 交付物之后故意让它保持关闭、打算手动开一个新 issue 的可能性(虽然我没找到支持这种可能性的证据)。**这件事需要指挥官/军师先确认,再往下走**:如果要按 A4a PRD §0.1 的先例继续用 #13,需要先 `gh issue reopen 13`;如果指挥官更想为 A4b 单开一个新 issue(比如借这次意外关闭的机会拆成两个可独立追踪的 issue),说一声我可以当场调整本 PRD 顶部的 issue 链接。**本 PRD 剩下的部分都是按"继续用 #13,需要先重新打开"这个假设写的——这不影响先看方案。**

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A4a 交付了 DESIGN §4 状态机里"正常范围内来回打回"的那部分——G1/G2/G3 gate 的正常分支、完整的 Draft↔Review 往返、`reject_count` 会自增。但**没有任何东西读这个计数器去做决定**:`config.yaml` 的 `workflow.reject_threshold: 2` 自从 `profile/loader.ts` 第一次解析出来那天起就没被消费过(A2 的 `SystemConfig.getDefaultRejectThreshold()` 同样是"留着但没有消费者"——见下面 §9.2 的验证)。同时,A4a graph 执行期间产生的每一次 gate 决定(`gateLog`)和模型自报的每一条 claim(`coderOutput.claims`/`testerOutput.claims`),除了活在 LangGraph 自己的 checkpoint 序列化里(`checkpoints`/`writes` 表,只关心"图执行走到哪一步",不关心业务审计语义)之外,没有任何地方能回答"这次 run 总共被打回几次"、"谁在什么时候批准了 G3"、"tester 做了什么 claim、置信度多少"这类问题——DESIGN §5 画的三张审计表根本不存在。至于"重启后,只靠这次 run 的标识,能不能接着跑,不管卡在哪个 gate"——A4a 的 spike 已经证明 LangGraph 那一层的机制可行,但 aeloop 自己的业务层(怎么实际找到 `thread_id`)完全没有接线。
- **服务对象**:直接消费者是 A5(CLI/TUI,需要审计表来回答"这次 run 的历史是什么",需要 `workflow_runs` 表来回答"我上次停在哪、给我一份可以续跑的列表")和 A6(双 profile 验收测试,需要审计表来证明两个 profile 的 run 各自都留下了轨迹)。间接消费者是指挥官本人——DESIGN §2 用例图里的 `UC9 查看审批审计轨迹` 第一次有真实数据可看了。
- **一句话方案**:`src/loop/escalation.ts`(新)按 DESIGN §4 的 `Esc`/`HD` 搭出 Escalation gate 节点(复用 A4a `gates.ts` 已经验证过的 `interrupt()`/`Command({resume})` 模式,但决定域是三选一,不是 G1/G2/G3 的二选一,所以不直接复用 `createGateNode` 工厂——原因见 §5)。`gates.ts` 改两处路由(`routeAfterReview` 在打回时先比较 `rejectCount`/`rejectThreshold` 再决定走 `g2` 还是 `escalation`;`routeAfterG2` 多认一个"主动升级"的决定值)。`graph.ts` 接入两个新节点 `escalation`/`cancel`。`src/loop/audit-store.ts`(新)是 Loop 层自己的 SQLite 存储——它**不**复用/导入 `context/store.ts` 的 `MemoryStore` 类;它是那个类结构上的兄弟(理由见 §9.2 决定 1),独立管理三张表 `workflow_runs`/`structured_claims`/`approvals` 的建表 + CRUD。`src/loop/runner.ts`(新)是叠在 graph 节点/gate 之上的一层薄编排:开始一次新 run 时,先通过 `AuditStore` 插入一条 `workflow_runs` 拿到 `runId`;每次 `invoke`/`resume` 返回后,把新出现的 `gateLog` 条目持久化进 `approvals`,把新的 claim 持久化进 `structured_claims`,并刷新 `workflow_runs` 的 `status`/`reject_count`/`current_state`/`updated_at`——graph 节点/gate 本身继续保持 A4a 立下的"interrupt 之前必须是纯函数、玩具节点也能测"的纯净度;所有审计写入都发生在这一层、在 graph 之外(延续 A4a"interrupt 之前必须是纯函数"这条纪律的精神)。checkpoint 跨进程验收测试改成 spike Q4 那种**两个真正独立的 `node` 子进程**风格(而不是 A4a 自己测试用的同进程两阶段做法),因为 A4b 的任务定义本身就是"生产化"这条路径——理由见 §9.2 决定 4。

## 2. 目标 / 非目标

**目标**:
- `src/loop/escalation.ts`:`createEscalationNode()`(三选一 interrupt gate)+ `routeAfterEscalation()`(三条路由:`"draft" | "g3" | "cancel"`)。
- `src/loop/gates.ts` 改动:`routeAfterReview` 新增一条 threshold 分支(`"g3" | "g2" | "escalation"`);`routeAfterG2` 新增一条"主动升级"分支(`"draft" | "escalation"`,`"rejected"` 依然报错——这条 A4a 的判断不变)。
- `src/loop/types.ts` 改动:`LoopState` 新增 `rejectThreshold`(从 graph 外面一次性注入,不可变)、`escalationDecision`、`cancelled`;`GateType` 新增 `"ESCALATION_ACK"`;`GateDecision` 新增第三个值(G2 的"主动升级");新增 `EscalationDecision` 类型。
- `src/loop/workflow-def.ts` 改动:`LOOP_NODES` 新增 `escalation`/`cancel`;`GATE_TYPES` 新增 `ESCALATION_ACK`;`CODER_TESTER_LOOP_DEFINITION` 的边列表相应同步(仅供文档参考,跟 A4a 一样的降级结论)。
- `src/loop/graph.ts` 改动:接入 `escalation`/`cancel` 两个新节点及其边;`review` 的条件边目标集从 `{g3,g2}` 扩到 `{g3,g2,escalation}`;`g2` 的条件边目标集从 `{draft}` 扩到 `{draft,escalation}`。
- `src/loop/audit-store.ts`(新):`AuditStore` 类——三张表 `workflow_runs`/`structured_claims`/`approvals` 的建表 + 插入/读取方法(字段跟 DESIGN §5 ER 对齐,见 §4)。
- `src/loop/runner.ts`(新):`startRun()`/`resumeRun()`——包一层 `compiled.invoke()`/`Command({resume})`,每次调用之后持久化新出现的 `gateLog`/`claims` 条目并刷新 `workflow_runs` 行;`runId`/`threadId` 是这一层对外的把手。
- **checkpoint 跨进程生产化**:用真实的 `child_process`(两个独立的 `node -e`/脚本调用,照着 spike Q4 的 Process A/B 模式)测试证明"进程 A 跑到某个 gate、interrupt、退出 → 进程 B 只靠 `workflow_runs` 表里的 `runId`(不是任何内存引用)→ 查到 `langgraph_thread_id` + `reject_threshold` 等 → 重建 checkpointer/graph → 续跑到完成"。
- **硬核纵切**(比 A4a 的更长):一条真实的端到端路径(Context→Prompt→cli-bridge fixture adapter→真实 graph→真实 checkpointer→真实 `AuditStore`),跑一条**故意被打回到触发 threshold**的路径——一个配置成连续拒绝 N 次(`N = threshold`)的 tester fixture → 路由到 `escalation` → 人工选"force pass" → `g3` → `apply`,全程断言 `approvals`/`structured_claims`/`workflow_runs` 都真正写入且字段对齐。

**非目标(明确排除在外,留给 A5/A6 或以后的增量)**:
- ❌ **有颜色的 TUI / y-n 批准界面**——那是 A5 的活。Escalation gate 跟 G1/G2/G3 一样,决定由测试代码直接构造 `Command({resume: {...}})` 注入。
- ❌ **任何消费 `workflow_runs` 的"列出所有可续跑的 run"CLI 命令**——那是 A5 的 UI 层工作;A4b 只交付表本身 + 底层查询方法(`AuditStore.getRunById`/`getRunByThreadId`),不做列表/交互命令。
- ❌ **让两个 threshold 来源之间的完整优先级机制——`system_config.default_reject_threshold`(A2 已建好,没有消费者)和 `config.yaml` 的 `workflow.reject_threshold`——变成可配置的策略**。A4b 只实现一个明确的、写死的优先顺序(结论见 §9.2 决定 2);不实现"哪个优先本身也可配置"的二阶配置。
- ❌ **真的把 diff 持久化到工作区的文件系统里**——延续 A4a §2 的非目标;`Apply` 节点继续只落定 state,不碰文件系统。这条边界本增量不重新讨论。
- ❌ **`Cancel` 之后的任何清理动作**(比如删临时文件、通知渠道)——`Cancel` 节点跟 `Apply` 一样,只落定 state(`{cancelled: true}`),没有副作用。
- ❌ **`profiles/apikey/` 里的任何东西**——不碰。
- ❌ **`AuditStore` 和 `MemoryStore`/`checkpoint.ts` 的 db 路径由 `profile/loader.ts` 自动算出来**——A1/A2/A4a 都还没做这层接线("profile 决定真实文件路径";`MemoryStore`/`createSqliteCheckpointer` 到今天依然都要求调用方显式传 `dbPath`)。A4b 延续这个既有边界——`AuditStore` 同样只接受构造函数显式传入的 `dbPath`。§9.2 决定 3 会描述**推荐的目标路径关系**(供未来的接线增量参考),但本增量不实现自动路径解析。
- ❌ **让 G3 的 payload 区分"正常 G3"和"force pass 之后的 G3"**——DESIGN §4 的 `HD-- force pass -->G3` 意味着强制通过后依然走一遍正常的 G3 签字;A4b 用的还是同一个 `createG3Node()`,没有加字段标记"这次 G3 是被强制推过来的"。如果指挥官觉得审计表需要区分这两种 G3,请提出来——§9.2 会留出一个可选加字段的余地。

## 3. 用户故事

- 作为**未来的 A5 CLI**,我希望 `workflow_runs` 里有一行能让我查到某次 run 目前卡在哪个 `current_state`、它的 `langgraph_thread_id` 是什么,这样"续跑一个未完成的 run"就不需要用户自己记住任何进程内状态。
- 作为**未来的 A6 双 profile 验收测试**,我希望一次真实的 coder/tester 调用留下的每条 claim(`claim_text`/`confidence`/`verified_by`/`tool_exec_checked`)和每次 gate 决定(`gate_type`/`decision`/`decided_by`/`decided_at`)都能从 `structured_claims`/`approvals` 表里查到,不用重放测试日志。
- 作为**指挥官**,我希望看到一个测试真的把 `reject_count` 打到 `reject_threshold`,证明 graph 会自动路由到 Escalation,而不是在 G2 无限打回;并且我在 Escalation gate 上做的"force pass / revise / abandon"决定,分别真的导向三个不同的终点:G3 / Draft / Cancel。
- 作为**指挥官**,我希望确认"重启后续跑"这句话现在有了真正的跨进程证据(不是在同一个进程里假装丢弃一个引用),验证的严格程度跟 A4a spike Q4 一样(两个真正独立的 `node` 进程,不同 pid)。

## 4. 数据模型

### 4.1 `LoopState` 新增/改动字段(`src/loop/types.ts`)

```typescript
const LoopState = Annotation.Root({
  // ...所有既有 A4a 字段原样保留...

  /** 这次 run 的 reject threshold 快照——从 graph 外面一次性注入(跟 injectedContext 地位一样),整次 run 期间不变。来源见 §9.2 决定 2。 */
  rejectThreshold: Annotation<number>(),

  /** 人在 Escalation gate 上的三选一决定;在 run 第一次真正走到这个 gate 之前是 undefined。 */
  escalationDecision: Annotation<EscalationDecision | undefined>(),

  /** Cancel 节点的终态标记,跟 A4a 已有的 applied 语义对称。 */
  cancelled: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});
```

`GateType` 新增一个值:`"ESCALATION_ACK"`(DESIGN §5 `approvals.gate_type` 枚举里唯一一个 A4a 从没实现过的值,现在补上)。

`GateDecision` 从 A4a 的 `"approved" | "rejected"` 扩展成 `"approved" | "rejected" | "escalate"`——第三个值只被 `routeAfterG2` 识别(DESIGN §4 的 `G2-- actively escalate -->Esc` 边);如果 `routeAfterG1`/`routeAfterG3` 收到这个值,会掉进它们既有的 `default: throw new Error(...)` 兜底(这个值在这两个 gate 的正常语义里从来没有意义——不是新引入的漏洞,是延续 A4a 已经定下的"类型层面允许、但某个具体 gate 不认"的处理方式)。

新增 `EscalationDecision = "revise" | "force_pass" | "abandon"`——**字面上就是从 DESIGN §4 状态图 `HD` 节点画出去的三条出边**("revise 代码/重述"/"force pass"/"abandon"),不是我编的第四套词汇。G1/G2/G3 用的 resume 值类型(`GateResumeValue`)和 Escalation gate 用的分开:新增 `EscalationResumeValue = { decision: EscalationDecision; reasoningText?: string }`。

`GateLogEntry.decision` 的类型从 `GateDecision` 扩展成 `GateDecision | EscalationDecision`(Escalation gate 产生的日志条目,它的 `decision` 字段是个三选一的值,不是二选一)——这算不算又一处像 A4a §9.3 提到的 `LoopStateType`/`Command` 泛型坑那样、真到写代码时才能敲定的 TS 类型细节,我不确定——标 `[?]`,build 时碰到第一个 `tsc` 报错再调整;不影响这里描述的字段语义。

### 4.2 三张审计表(`src/loop/audit-store.ts`,`CREATE TABLE IF NOT EXISTS`,在 `AuditStore` 构造时创建,跟 `MemoryStore` 的 `createSchema()` 是同一套惯例)

严格对齐 DESIGN §5 ER(列名/类型/是否可空),`snake_case` 列 + 应用层 camelCase 映射,跟 `context/store.ts` 的 `MemoryRow`/`Memory` 映射是同一套惯例:

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  workflow_def_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'running' | 'escalated' | 'completed' | 'cancelled'
  reject_count INTEGER NOT NULL DEFAULT 0,
  reject_threshold INTEGER NOT NULL,  -- 这次 run 的快照,不会跟着后续 config.yaml 的改动变
  current_state TEXT NOT NULL,        -- LOOP_NODES 的某个值,每一步之后由 runner 刷新
  langgraph_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structured_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  step_ref TEXT NOT NULL,             -- "<node>#<round>",见下面 step_ref 判断
  actor TEXT NOT NULL,                -- 'coder' | 'tester'
  claim_text TEXT NOT NULL,
  confidence TEXT NOT NULL,           -- ClaimConfidence: verified/inferred/unconfirmed/stale
  source_ref TEXT,
  verified_by TEXT,                   -- VerifiedBy: tool_execution/human/unverified
  tool_exec_checked TEXT,             -- ToolExecChecked: pass/fail/na,来自 InvokeResult(只有 cli-bridge 才有,direct-api 是 NULL)
  model_used TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  gate_type TEXT NOT NULL,            -- GATE_TYPES 的某个值,包括新增的 ESCALATION_ACK
  step_ref TEXT NOT NULL,
  diff_ref TEXT,
  reasoning_text TEXT,
  decision TEXT NOT NULL,             -- G1/G2/G3 行:approved/rejected/escalate;ESCALATION_ACK 行:revise/force_pass/abandon(见 §9.2 决定 5)
  decision_reason TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  latency_seconds INTEGER
);
```

**`step_ref` 的格式**(DESIGN 没给具体格式,`[?]` 这是我的判断):`"<一个 LOOP_NODES 值>#<这个节点在这次 run 里跑了第几次,从 1 开始>"`,比如 `"draft#1"`/`"review#2"`。`runner.ts` 内部维护一个"每个节点名跑过几次"的计数器(每次 `invoke`/`resume` 返回后,比较新旧 state 判断经过了哪个/哪些节点,并对相应计数器加一);这个计数器**只作为 `runner.ts` 内部的一个运行时变量存在,从不作为 `LoopState` 的一部分被持久化**——它纯粹是审计写入的辅助信息,不是 graph 逻辑需要的东西,放进 `LoopState` 会让"graph state 的形状"背上一个不属于它的关注点(呼应 §9.2 决定 1 的分层理由)。

**`decided_by` 从哪来**:A4a 的 `GateResumeValue`/`EscalationResumeValue` 都没有"谁做的这个决定"字段(只有 `decision`/`reasoningText`)。A4b 需要往传给 `Command({resume})` 的 resume 值里加一个 `decidedBy: string` 字段,还是应该由 `runner.ts` 的调用方(测试代码/未来的 CLI)在调用 `resumeRun()` 时单独传?**我倾向后者**——`decidedBy` 是"谁在执行这次 resume"这个外部环境信息,不是"graph 执行到这一步产生的数据",跟 `injectedContext`/`rejectThreshold` 一样,应该"从 graph 外面注入",而不属于 `GateResumeValue`/`EscalationResumeValue` 代表的"人对 `interrupt()` 的回答"这个形状。`runner.resumeRun(runId, threadId, resume, decidedBy)` 的签名把它当独立参数传入。标 `[?]` 待确认——这是本 PRD 除了 §9.2 六个主决定之外唯一一处松散的小判断。

## 5. 逐文件任务清单

### `src/loop/types.ts`(改动,不是新文件)
- 所有字段/类型改动见 §4.1。`LoopNodeName` 的联合类型不需要改(`(typeof LOOP_NODES)[keyof typeof LOOP_NODES]` 会自动从 `workflow-def.ts` 拿到新增的 `escalation`/`cancel`)。

### `src/loop/errors.ts`(改动)
- `UnhandledGateDecisionError` 保留(还是 `routeAfterG2` 收到 `"rejected"` 时抛出的那个,语义不变)。
- 新增 `AuditReadError extends Error`(`AuditStore` 的读取方法失败时抛,照着 `context/errors.ts` 的 `RecallError` 惯例——"读失败必须可见,不能悄悄退化成空结果/undefined"这条纪律延续到 Loop 层自己的 store)。写入方法(insert)让 `better-sqlite3` 的 `SqliteError` 原样透传,不额外包装——跟 `MemoryStore` 写入方法既有的惯例一样(§9.2 决定 1 的一部分)。

### `src/loop/workflow-def.ts`(改动)
- `LOOP_NODES` 新增 `escalation: "escalation"`、`cancel: "cancel"`。
- `GATE_TYPES` 新增 `ESCALATION_ACK: "ESCALATION_ACK"`。
- `CODER_TESTER_LOOP_DEFINITION.edges` 同步新边(仅供文档参考,跟 A4a 一样的降级结论——`graph.ts` 运行时依然不读它):
  - `review → [g3, g2, escalation]`(从 A4a 的 `[g3, g2]` 扩展)
  - `g2 → [draft, escalation]`(从 A4a 的 `[draft]` 扩展)
  - `escalation → [draft, g3, cancel]`(新增)
  - `cancel → "__end__"`(新增)

### `src/loop/gates.ts`(改动,不是新文件——A4a 既有文件)
- `routeAfterReview`:签名从 `(state): "g3" | "g2"` 改成 `(state): "g3" | "g2" | "escalation"`。逻辑:`verdict === "pass" → "g3"`;`verdict === "reject"` 时,`state.rejectCount >= state.rejectThreshold → "escalation"`,否则 `"g2"`。**这依赖一个事实:`nodes/tester.ts` 在返回值里已经把 `rejectCount` 加过了**(A4a 既有行为,`tester.ts` 不需要改——LangGraph 会先把一个节点返回的 `Partial<LoopStateType>` 合并进 state,*然后*才评估这个节点的条件边路由函数,所以 `routeAfterReview` 读到的已经是加过之后的值;§9.2 决定 6 详细解释了为什么 `tester.ts` 不用动)。
- `routeAfterG2`:签名从 `(state): "draft"` 改成 `(state): "draft" | "escalation"`。`"approved" → "draft"`(不变);`"escalate" → "escalation"`(新增,DESIGN §4 的 `G2-- actively escalate -->Esc`);`"rejected"` 和其他任何值依然抛 `UnhandledGateDecisionError`(这条 A4a 的判断本增量不推翻)。
- 其他(`createGateNode`/`createG1Node`/`createG2Node`/`createG3Node`/`routeAfterG1`/`routeAfterG3`)**不变**——这些 gate 的决定域/路由目标集在 A4b 里不变。

### `src/loop/escalation.ts`(**新文件**)
- **为什么不复用 `gates.ts` 的 `createGateNode` 工厂**:那个工厂的类型签名假设 resume 值是二选一的 `GateResumeValue`(`decision: GateDecision`),内部用一个三路 `switch` 把 `decisionField` 映射到 `g1Decision`/`g2Decision`/`g3Decision` 三个具体字段之一——Escalation gate 的 resume 值是三选一的 `EscalationResumeValue`(`decision: EscalationDecision`),要写回单独一个字段 `escalationDecision`。硬塞进既有工厂,要么破坏它的类型精度(那个工厂特意不用"计算属性键",为的是保住 `Partial<LoopStateType>` 的精确类型,`gates.ts` 里已有注释说明这一点),要么得把工厂泛化成同时兼容两种决定类型的版本——而这种泛化本身的风险(可能影响 `gates.ts` 里已经被 A4a 测过、Zorro 审过三轮的逻辑)超过了"少写几行重复代码"带来的好处。`escalation.ts` 因此是一份结构上跟 `createGateNode` **平行**的独立实现,照搬了它"纯 payload 函数 → `interrupt()` → 之后才构造日志条目"的核心纪律(A4a spike Q3 那条规则在这里同样适用,不能因为是新文件就破例)。
  ```typescript
  export function createEscalationNode(): (state: LoopStateType) => Partial<LoopStateType> {
    return (state) => {
      const payload: GatePayload = {
        gate: GATE_TYPES.ESCALATION_ACK,
        question: "reject_count reached the threshold — revise / force-pass / abandon?",
        ...(state.coderOutput?.diff !== undefined ? { diffRef: state.coderOutput.diff } : {}),
        ...(state.testerOutput?.issues !== undefined ? { issues: state.testerOutput.issues } : {}),
      };
      const resume = interrupt<GatePayload, EscalationResumeValue>(payload);
      const entry: GateLogEntry = {
        gate: GATE_TYPES.ESCALATION_ACK,
        decision: resume.decision,
        decidedAt: new Date().toISOString(),
        ...(resume.reasoningText !== undefined ? { reasoningText: resume.reasoningText } : {}),
      };
      const feedback =
        resume.decision === "revise"
          ? [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n")
          : undefined; // force_pass/abandon 不回 Draft,不需要下一轮的 feedback
      return { escalationDecision: resume.decision, feedback, gateLog: [entry] };
    };
  }

  export function routeAfterEscalation(state: LoopStateType): "draft" | "g3" | "cancel" {
    switch (state.escalationDecision) {
      case "revise": return "draft";
      case "force_pass": return "g3";
      case "abandon": return "cancel";
      default:
        throw new Error(`routeAfterEscalation: unexpected escalationDecision ${JSON.stringify(state.escalationDecision)}`);
    }
  }
  ```
  (这是设计形状,不是最终代码——`GatePayload`/`GateLogEntry` 要不要为 Escalation 加专门的扩展字段,以及 `interrupt<GatePayload, EscalationResumeValue>` 的泛型标注跟 A4a spike Q5 的坑对不对得上,要到 build 时才能验证。)

### `src/loop/graph.ts`(改动)
- `addNode(LOOP_NODES.escalation, createEscalationNode())`
- `addNode(LOOP_NODES.cancel, cancelNode)`(一个新的小型内部函数,`{cancelled: true}`,跟既有的 `applyNode` 完全对称,同样不值得单独开一个 `nodes/cancel.ts` 文件——DESIGN §6 的文件清单也没列一个)
- `addConditionalEdges(LOOP_NODES.review, routeAfterReview, { g3: ..., g2: ..., escalation: LOOP_NODES.escalation })`(替换 A4a 既有的双向 pathMap)
- `addConditionalEdges(LOOP_NODES.g2, routeAfterG2, { draft: ..., escalation: LOOP_NODES.escalation })`(替换 A4a 既有的单向 pathMap)
- `addConditionalEdges(LOOP_NODES.escalation, routeAfterEscalation, { draft: ..., g3: ..., cancel: LOOP_NODES.cancel })`(新增)
- `addEdge(LOOP_NODES.cancel, END)`(新增)
- `buildLoopGraph(deps)` 的签名不变(`escalation`/`cancel` 节点都没有外部依赖,不需要 `router`/`composer`)。

### `src/loop/audit-store.ts`(**新文件**)
- `AuditStore` 类,构造函数 `(dbPath: string)`,内部自己开一个 `better-sqlite3.Database` 连接(**不**复用/包装 `MemoryStore`——见 §9.2 决定 1),`createSchema()` 创建 §4.2 的三张表(`CREATE TABLE IF NOT EXISTS`,幂等,跟 `MemoryStore` 同一套惯例)。
- 写入方法:`insertRun(input): WorkflowRun`(返回带 `id` 的完整行,跟 `MemoryStore.insertMemory` 同一套惯例),`updateRunProgress(id, patch: {status?, rejectCount?, currentState?, updatedAt})`,`insertClaim(input): StructuredClaim`,`insertApproval(input): Approval`。
- 读取方法(失败包一层 `AuditReadError`,跟 `RecallError` 同一套惯例):`getRunById(id): WorkflowRun | undefined`,`getRunByThreadId(threadId): WorkflowRun | undefined`(**跨进程续跑生产化测试的核心查询**——"进程 B 只知道 threadId 或 runId,必须能查回整行")。
- `runInTransaction<T>(fn: () => T): T`——跟 `MemoryStore` 一样,供 `runner.ts` 把"插入好几条 claim"这类多行写入包进一个事务。
- `close(): void`。
- 这个文件**不**导入 `../context/store.js` 或 `context/` 里的任何实现(如果需要,只在类型层面复用 `ClaimConfidence`/`VerifiedBy`/`ToolExecChecked`——这些枚举**已经定义在 `harness/`/`prompt/`**——那些不算 `context` 依赖)。`nowIso()` 这个时间戳辅助函数在本文件里复制了一份两行的独立实现,而不是引入对 `context/util.ts` 的依赖(§9.2 决定 1 的判断的延伸;理由:一个两行的纯函数不值得把 `nowIso` 提到 `src/shared/` 去、让两层都改 import——等真出现第三个使用场景再重新考虑)。

### `src/loop/runner.ts`(**新文件**)
- `interface StartRunDeps { router: ProviderRouter; composer: PromptComposer; audit: AuditStore; checkpointer: BaseCheckpointSaver }`(比 `LoopGraphDeps` 多了 `audit`/`checkpointer`;`runner.ts` 是唯一同时持有"graph 依赖"和"审计依赖"的地方——graph 节点本身完全不知道 `AuditStore` 的存在)。
- `startRun(deps, input: { task: string; profile: string; workflowDefId: string; injectedContext: ContextInjectionResult; rejectThreshold: number }): Promise<RunHandle>`:
  1. 生成一个 `threadId`(`[?]` 怎么生成——`crypto.randomUUID()` 是显而易见的选择:Node 内置、不引入新依赖,除非指挥官有别的偏好)。
  2. `deps.audit.insertRun({ task, workflowDefId, profile, status: "running", rejectCount: 0, rejectThreshold, currentState: LOOP_NODES.draft, langgraphThreadId: threadId, ... })` 拿到 `runId`。
  3. `compileLoopGraph(buildLoopGraph({router: deps.router, composer: deps.composer}), deps.checkpointer).invoke({task, injectedContext, rejectThreshold, ...其余字段用默认值}, {configurable: {thread_id: threadId}})`。
  4. 对比 invoke 前后的 state,把新出现的 `gateLog` 条目 / `coderOutput.claims` / `testerOutput.claims` 持久化进 `approvals`/`structured_claims`(这就是 §4.2 `step_ref` 计数器开始维护的地方),刷新 `workflow_runs` 的 `current_state`/`updated_at`(`status` 只有真正走到 `applied`/`cancelled` 才会变成 `completed`/`cancelled`;期间保持 `running`,除非 `escalationDecision` 已经被设置——这种情况下 `status` 会短暂标成 `escalated`,这个细节 §9.2 的决定没覆盖,标 `[?]`,准确的状态机映射待 build 时确认)。
  5. 返回 `{ runId, threadId, interruptState | finalState }`(准确形状 build 时定,对应两种可能的返回情形:中断或完成)。
- `resumeRun(deps, runId: number, threadId: string, resume: GateResumeValue | EscalationResumeValue, decidedBy: string): Promise<RunHandle>`:对称逻辑,通过 `Command({resume})` 续跑 + 同样的审计持久化。**关键约束**:这个函数**不要求调用方持有任何源自 `startRun()` 的内存对象引用**——它只需要 `runId`/`threadId`(不管是从 `AuditStore` 查来的还是调用方自己记的)加上一个新构造的 `checkpointer`(指向同一个 db 文件)。这就是本 PRD 里"生产化"这个词的具体含义:`resumeRun` 的参数列表**本身**就是"能在全新进程里被调用"的证据,不需要额外包装。
- `getResumableRuns(deps, status: "running" | "escalated"): WorkflowRun[]`(对 `AuditStore` 读取方法的一层薄包装,给未来的 A5 一个现成的入口——**本增量的测试不需要专门覆盖这个**,它只是顺手把 `runner.ts` 应该对外暴露的"业务层"读取接口的形状定下来,不是额外范围)。

### 依赖/打包
- `package.json`:**不新增依赖**(`crypto`/`node:crypto` 是 Node 内置的)。

### 测试(跟逐文件任务一一对应,延续 A4a 已经立好的"真实但受控"三层哲学,新增第 4 层"审计层"和第 5 层"跨进程")

1. **`escalation.ts`/`graph.ts` 的新分支——玩具节点 + `MemorySaver`**(追加到 `graph.test.ts`,不是新文件):① 连续打回到 `rejectThreshold` → 路由到 `escalation` 而不是 `g2`;② `escalation` gate 收到 `"force_pass"` → 路由到 `g3` → 之后正常 G3 approve → apply;③ 收到 `"revise"` → 路由到 `draft`,`feedback` 带着 tester 的 issues;④ 收到 `"abandon"` → 路由到 `cancel` → `state.cancelled === true`;⑤ G2 收到 `"escalate"` → 路由到 `escalation`(不是 `draft`);⑥ `escalation` 收到无法识别的值 → 抛 `Error`(照着 A4a 既有的 G1/G3 兜底测试模式)。
2. **`audit-store.ts` 单元测试**(新文件 `src/loop/__tests__/audit-store.test.ts`):真实的 `better-sqlite3` 临时文件(跟 `checkpoint.test.ts` 用 `fs.mkdtempSync` 一样的技术),① `insertRun`/`getRunById` 往返;② `getRunByThreadId` 能查到;③ `insertClaim`/`insertApproval` 的外键(`run_id`)指向不存在的 `workflow_runs.id` 时的行为(`better-sqlite3` 默认不强制外键,除非 `PRAGMA foreign_keys=ON`——**这个 store 要不要开外键约束是个小判断**,`MemoryStore` 开了,`AuditStore` 大概率也应该开,标 `[?]` 但倾向"开",build 时确认);④ `runInTransaction` 失败时回滚,不留下半写的数据。
3. **`runner.ts` 单元测试**(新文件 `src/loop/__tests__/runner.test.ts`):真实的 `graph.ts`(不是玩具图,跟 A4a 用真实 graph 测 checkpoint 是同一个理由)+ `FakeAdapter`(A4a 已经用过的技术)+ 真实的 `AuditStore`(临时文件)+ 真实的 `SqliteSaver`(要么单独一个临时文件,要么跟 `AuditStore` 共用同一个文件——见 §9.2 决定 3;这份测试正是验证"共用一个文件"到底行不行的地方)。① `startRun` 之后,`workflow_runs` 有一行 `status: "running"`;② G1 approve 之后,`approvals` 多一行 `gate_type: "G1_SEND_TO_TESTER"`;③ 打到 threshold 触发 escalation 之后,`workflow_runs.status` 会变(具体值按上面 `runner.ts` 任务描述里标的 `[?]` 待定);④ `coderOutput.claims` 非空时,`structured_claims` 插入的行数跟数量对得上,`actor: "coder"`,`model_used`/`provider_used` 跟 `coderResult.model`/`.provider` 对齐。
4. **checkpoint 跨进程生产化**(新增 `docs/feature/a4b-loop/spike/` 下的两个小脚本,或者直接一个 `src/loop/__tests__/cross-process-resume.test.ts` 用 Node 的 `child_process.spawnSync` 跑两段内联脚本——**是"新脚本文件"还是"测试内联 spawn 一段脚本字符串"build 时再定,不影响验收标准**):① 进程 A(通过 `runner.startRun`)跑到某个 gate、interrupt、`process.exit(0)`;② 进程 B 完全独立启动,只知道 `dbPath`(给 `AuditStore` 用)+ `runId`,先调 `audit.getRunById(runId)` 拿到 `langgraphThreadId`,再构造一个全新的 `checkpointer`(指向同一个 db 文件)+ 一个全新编译的 graph,`resumeRun` 续跑到完成;③ 断言进程 B 最终的 `workflow_runs.status` 是 `"completed"`。这个测试**替代**(不是新增)A4a `checkpoint.test.ts` 那种同进程两阶段做法作为验证这条"跨进程"具体主张的方式——那个 A4a 测试本身不变、依然留在原地测"`checkpoint.ts` 这层薄封装本身"的非闭包状态;这份新的 A4b 测试测的是 `runner.ts`/`audit-store.ts` 接的业务层查找逻辑在跨进程语义下是否也站得住——两个测试关心的事不重叠,理由见 §9.2 决定 4。
5. **硬核纵切**(作为新的 `it`/`describe` 块追加到 `src/loop.e2e.test.ts`,不是新文件——延续 A4a 既有的文件位置):见 §2 目标里描述的"故意打到 threshold→escalation→force pass→apply"路径,复用 A4a e2e 已经搭好的 Context/Prompt/adapter fixture 设置逻辑,**新增**一个连续返回 `verdict: "reject"` 的 tester fixture 场景(照着 A3 fixture"加一个 case,不新开文件"的惯例)。断言:① `workflow_runs` 最终 `status: "completed"`,`reject_count` 等于到达 escalation 之前被打回的次数;② `approvals` 有一行 `gate_type: "ESCALATION_ACK"`,`decision: "force_pass"`;③ `structured_claims` 的行数等于 coder+tester 在所有轮次里产生的 claim 总数。

## 6. 批次拆分

> 单位跟 A0-A4a 的 PRD 一样:`[S]` ≈ 2-4h,`[M]` ≈ 半天到一天,`[L]` ≈ 1-2 天。单分支 `feature/issue-13-a4b-loop`,按下面的顺序提交(理由跟 A0-A4a 一样)。

| 批次 | 内容 | 依赖 | 大小 |
|---|---|---|---|
| **B0** | `types.ts`/`workflow-def.ts`/`errors.ts` 改动(§4.1 所有字段/类型改动 + `LOOP_NODES`/`GATE_TYPES` 扩展 + `AuditReadError`) | 无(起点,在 A4a HEAD 之上) | [S] |
| **B1** | `src/loop/escalation.ts` + `gates.ts` 的两处路由改动(`routeAfterReview`/`routeAfterG2`) | B0 | [M] |
| **B2** | `graph.ts` 接线(escalation/cancel 节点+边)+ `graph.test.ts` 新测试用例(§5 测试点 1 的全部 6 个分支) | B1 | [M] |
| **B3** | `src/loop/audit-store.ts` + 单元测试(§5 测试点 2) | B0(只需要类型,不需要 graph 改动) | [M] |
| **B4** | `src/loop/runner.ts` + 单元测试(§5 测试点 3)——本增量集成复杂度最高的批次,把 B2 的 graph 改动跟 B3 的 store 连起来 | B2+B3 | [L] |
| **B5** | checkpoint 跨进程生产化测试(§5 测试点 4,真实 `child_process`) | B4 | [M] |
| **B6** | 硬核纵切(`src/loop.e2e.test.ts` 追加 threshold 路径,§5 测试点 5)+ 新 tester fixture 场景 | B4(不严格依赖 B5,但建议放在 B5 之后做,这样跨进程验证时发现的问题可以互相共享) | [L] |
| **B7** | 文档回写(`docs/ROADMAP.md` 勾掉 A4b,`docs/PROGRESS.md` 清空,`CHANGELOG.md` 加一行,根 `CLAUDE.md` 更新,`CHARTS/knowledge/aeloop.md`(ai-agent 仓库)给 `escalation.ts`/`audit-store.ts`/`runner.ts` 三个模块新增/更新条目 + 更新既有 Loop 层里写着"A4b to come"的条目) | B6 | [S] |

**依赖图说明**:B1(escalation+路由)和 B3(审计存储)彼此独立(B1 只依赖 B0 的类型,B3 也只依赖 B0 的类型)——理论上可以并行,但因为同一个 Cypher 顺序实现,不为这个理由单独拆分支;不过如果指挥官想分阶段审,B0-B3(类型+graph 分支+审计表,互相独立的机械单元)/B4-B5(runner 集成+跨进程,风险核心)/B6-B7(纵切+文档)是天然的断点,跟 A4a PRD §7 的分阶段审建议是同一个思路。

**整体规模估计**:跟 A4a 实际交付的量对比(7 个批次,254 个测试),A4b 新增/改动的文件数差不多,但集成复杂度更高(`runner.ts` 是本增量特有的新架构层,A4a 没有对应物)——粗略估计总工作量跟 A4a 相当或略多,不是"A4a 的一个小尾巴"。

## 7. 分支策略

单分支 `feature/issue-13-a4b-loop`(从 A4a 合并后的 main `c6589b7` 切出来),按 §6 的顺序提交批次,理由跟 A4a 一样。

## 8. 可测试的验收标准(可核对)

- [x] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess`,无报错),`pnpm lint` 同样干净。
- [x] `pnpm test` 全绿(276/276),所有新的 A4b 测试文件都算进去;`grep` 确认零真实网络/真实 CLI 调用(跟 A3/A4a 已经用过的检查技术一样;唯一新增的真实 `spawn` 是 `cross-process-resume.test.ts` 拉起本仓库自己的 `.mjs` fixture,不是外部 CLI/网络调用)。
- [x] **threshold 真的能触发 escalation**:`graph.test.ts` 新增一个"`reject_count` 达到 `rejectThreshold` 路由到 escalation,不是 g2;低于 threshold 依然路由到 g2"的测试,两个边界都测,并且都真的走一遍真实 graph。
- [x] **Escalation 三种决定都有路由 + 测试覆盖**:`graph.test.ts` 有三个独立测试分别驱动 `revise→draft`/`force_pass→g3`/`abandon→cancel`。
- [x] **G2 的主动升级分支真的存在**:`graph.test.ts` 里"G2 收到 'escalate'...路由到 escalation,不是 draft"的测试驱动了一次真实 graph;`UnhandledGateDecisionError` 继续只适用于 `approved`/`escalate` 之外的值(既有测试不变,`escalate` 是新增的合法分支,不是新增的异常)。
- [x] **三张审计表真的建出来了 + 真的写进去了**:`audit-store.test.ts`(9 个用例)证明 schema+字段跟 §4.2 对齐;`runner.test.ts`/`loop.e2e.test.ts` 证明真实的 graph 执行产生的 `gateLog`/claims 落进了 `approvals`/`structured_claims`,并且 `workflow_runs` 的 `reject_count`/`current_state`/`status` 真的随着每次 `resumeRun()` 调用而刷新。
- [x] **checkpoint 跨进程生产化真的实现了**:`cross-process-resume.test.ts` 用两个真正独立的 `node` 进程(`spawnSync`,断言 pid 不同),进程 B 只靠 `dbPath`+`runId` 查到 `langgraph_thread_id` 并续跑到完成——两个 fixture 脚本导入的是编译产物 `dist/`(不是 `src/`,因为纯 Node 没有 `.ts`→`.js` 的解析映射;测试的 `beforeAll` 先跑一遍 `pnpm build`)。
- [x] **纵切必须端到端真连接(包括 escalation)**:`loop.e2e.test.ts` 的新场景走完整条链"真实 Context→Prompt→cli-bridge fixture(`fake-codex.fixture.mjs` 新增一个 `tester-reject` 场景)→真实 ProviderRouter→真实 graph(通过 `runner.startRun`/`resumeRun`,不是直接 `invoke`)→真实 checkpointer→真实 AuditStore→threshold 2→escalation→force_pass→G3→apply",之后三张表都能查到(用真实的 `rejectThreshold: 2`,顺带走一遍正常的 G2 路径,不简化成最短的 threshold=1 路径)。
- [x] **graph 节点/gate 继续保持零 I/O 纯净度**:`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 零命中,已验证。
- [x] **反向跨层依赖继续不存在**(⚠️ 见一处需要指挥官/军师知道的检查措辞缺口):`grep -rln "from.*loop" src/harness src/context src/prompt` 零命中;单独 `grep -n "from \"\.\./\.\./context\|from \"\.\./context" src/loop/audit-store.ts`,零命中(§9.2 决定 1 的实际主张)。这一行文字上其实也把 `runner.ts` 列进了同一个 grep,但 `runner.ts` 按 §5 自己 `startRun()` 签名的要求,对 `ContextInjectionResult`(`../context/injector.js`)做的是类型层面的 import——跟 `types.ts` 里已有的 A4a 先例一致(Loop→Context 是嵌套架构允许的方向;§9.2 决定 1 反对的是"复用 `MemoryStore` 的实现",不是"完全不碰 `context/` 里的任何类型")。判定这不构成对跨层方向的实质违反;本 §8 这行 grep 的措辞比 §5/§9.2 决定 1 的实际主张更宽,以更具体的那条为准。
- [x] `docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/根 `CLAUDE.md`/`CHARTS/knowledge/aeloop.md`(ai-agent 仓库)按 §6 B7 回写;另外,按分派说明,顺手更正 `docs/DESIGN.md` §1.5 的 ruflo 措辞(仅此一处,范围已经用 diff 核实过)。

## 9. 依赖 / 风险 / 待定问题

### 9.1 issue #13 的关闭状态(见 §0.1)

已经在 §0.1 详述过——需要指挥官/军师先在"重新打开 #13"和"单开一个新 issue"之间做决定;本 PRD 目前是按"继续用 #13,等重新打开"这个假设写的。

### 9.2 六个设计决定——请逐条确认(按分派说明要求展开的四个问题,加上我在做的过程中发现必须一并敲定的另外两个)

**1. 审计表写入的分层归属:`AuditStore` 是 Loop 自己独立的 SQLite 存储,不导入/复用 `context/store.ts` 的 `MemoryStore` 类。**
理由:DESIGN §1.5 的嵌套模型(`Prompt ⊂ Context ⊂ Harness ⊂ Loop`)意味着 Loop 可以使用 Context(方向上,这不违反"内层不知道外层"),但"允许依赖"不等于"应该依赖"。语义上,`workflow_runs`/`structured_claims`/`approvals` 是 Loop 自己的运营账本(`reject_count`/`current_state`/`langgraph_thread_id` 都是 Loop 领域的概念),跟 Context 关心的"模型能看到什么记忆"没有重叠;`MemoryStore` 自己的方法集(`insertMemory`/`searchMemories`/FTS5 相关)Loop 也一样都用不上。为了"省点事"硬去复用 `MemoryStore`,代价是让 Loop 的审计持久化耦合到一个为别的领域设计的类的内部实现细节上(比如它的 `createSchema()` 私有方法会顺带创建跟 Loop 毫无关系的三张表 `memories`/`memory_confirmations`/`system_config`)。`AuditStore` 是 `MemoryStore` **结构上的兄弟**(同一套 `better-sqlite3` + prepared-statement + 错误分类惯例),不是它的子类/包装。**这个选择的代价**:两份几乎一样的"开连接→建表→prepare statement"样板代码,有一点点重复——但我认为这个代价比让 Loop 反向耦合到一个 Context 类的内部实现要小。`[?]` 如果指挥官觉得"复用"更重要(比如确实想让 memories 和审计表以后由同一个 `MemoryStore` 实例统一管理),请提出来——这是个可以推翻重做的决定。

**2. `reject_threshold` 来源的优先顺序:`profiles/subscription/config.yaml` 的 `workflow.reject_threshold` 优先;缺失就回落到 `system_config.default_reject_threshold`(A2 的 `SystemConfig.getDefaultRejectThreshold()` 已经建好,目前没有消费者);两个都缺就写死回落到 `2`。**
已验证的事实:代码里**已经有两个**跟 reject threshold 相关、彼此独立、都没人读的东西——① `profile/loader.ts` 解析出来的 `ProfileConfig.workflow?.reject_threshold`(分派说明字面上指的就是这个);② `context/config.ts` 的 `SystemConfig.getDefaultRejectThreshold()`,读 `system_config` 表的 `default_reject_threshold` 键,它的注释明写着"为 Loop 层的升级阈值保留——本增量没有任何东西读它,这里暴露出来是给 A4 复用"——这是 A1/A2 的作者(也是一个历史上的 Cypher)特意为 A4 留的钩子。**我的判断**:`config.yaml` 的值代表"这个 profile 这次部署想要的阈值"(部署期配置;`workflow_runs.reject_threshold` 的"这次 run 的快照"这条注释暗示这个值应该在 run 开始时就一次性钉死),而 `system_config` 的值代表"引擎级的默认兜底"(未来可以通过一个不需要重新部署的 CLI 命令在运行时改)——两者不是互斥的,而是一种标准的"更具体的覆盖更通用的"配置分层模式。`startRun()` 的调用方(测试/未来的 CLI)负责按这个优先顺序算出最终数字,作为 `LoopState.rejectThreshold` 传入;`runner.ts` 本身不做这个优先级计算(它只接收一个已经算好的 `rejectThreshold: number` 参数——跟 `injectedContext` 一样"从 graph 外面注入"的地位)。`[?]` 这个判断需要指挥官确认——如果指挥官觉得那个 `system_config` 钩子根本不该被 A4b 用(比如它其实是为别的东西准备的),请提出来,那样 A4b 就只读 `config.yaml`,`system_config` 继续挂在那没人用。

**3. 三张审计表和 checkpoint 表共用同一个 SQLite 文件(推荐,本增量不强制接线,只在测试里验证"能不能这么做"):`AuditStore`/`checkpoint.ts` 都接受显式的 `dbPath`,不自动解析路径;但 `runner.test.ts`/跨进程测试/纵切测试应该把两者都指向同一个临时文件路径,验证 DESIGN §5"单个 SQLite 文件"的字面意图在技术上站得住。**
理由:DESIGN §6 的目标目录树里,`profiles/subscription/` **只列了一个** `memory.db` 文件(不是三个独立文件 `memory.db` + `checkpoint.db` + `audit.db`)——这是"一个 profile,一个文件装所有东西"这个意图的直接证据。`better-sqlite3` 多个独立连接指向同一个文件(在 WAL 模式下)是标准支持的场景;`SqliteSaver.setup()` 会把文件切到 WAL 模式,`AuditStore`/`MemoryStore` 各自的连接理应能在同一个 WAL 文件上正常工作,不需要额外配置——但这是我的技术判断,不是已经验证过的事实(A4a 的 spike 从没测过"两个独立的 `better-sqlite3.Database` 连接指向同一个文件,一个创建 LangGraph 的 `checkpoints`/`writes` 表,另一个创建业务表"这个具体场景),所以本 PRD 把"共用一个文件"设计成一条在 B4/B6 测试中**顺带被验证**的断言,而不是单独立一个 spike 阶段——如果真碰到问题(比如锁争用导致写入超时),就在批次里就地解决(退回"各自独立文件"改动也不大,因为每个都已经独立传入 `dbPath`,没有硬编码耦合)。`MemoryStore`(context 层)**完全不在**这次共享文件的讨论范围内——A4b 不碰它;共享的是 checkpoint 文件和审计文件,`MemoryStore` 要不要也加入共享留给未来的"profile 接线"增量决定。

**4. checkpoint 跨进程验收升级为真正的子进程(不再是 A4a 那种同进程两阶段做法)。**
A4a PRD §9.1 明写过"如果指挥官觉得'一次外部新调用'必须是真的新 `node` 进程才算数,说一声我就照 spike Q4 的模式重做"——这次分派说明明确点名了"生产化",我理解这就是那句"说一声"。补充理由:A4a 阶段,"同进程两阶段"测的是 `checkpoint.ts`/`graph.ts` 有没有不小心引入一个进程内单例——这个顾虑在 A4b 依然成立,那个 A4a 测试原样保留、不改;但 A4b 新引入的 `runner.ts`/`audit-store.ts` 带来了一整层新的"业务层怎么重新找到一次 run"逻辑(比如 `getRunByThreadId` 这类查询),只有真正的跨进程测试才能抓出这一层是不是偷偷依赖了进程内状态(比如一个模块级缓存)——继续用同进程两阶段测不出这类问题,所以在 A4b 投入子进程测试基础设施的成本值得付,这跟 A4a 当时"这个成本不值得"的结论不冲突(范围变了,判断没有反复)。

**5. `approvals.decision` 里,`ESCALATION_ACK` 行直接存 `EscalationDecision` 的字面值(`"revise"`/`"force_pass"`/`"abandon"`),不强行映射到 DESIGN §5 注释里写的"approved/rejected/override"三个词。**
DESIGN §5 的注释那一行("decision: approved/rejected/override")很可能是设计者还没把 `HD` 的三条出边想透之前写的("override"这个词在 A4a PRD 里已经被解读成"只服务于阈值升级"——但实际的升级 `HD` 决定是三种,不是一种)。ER 图的 `approvals.decision` 只是个 `TEXT` 列,没画 SQL `CHECK` 约束——它不是一条必须精确落在三个预设值上的硬边界。我认为如实存储字面语义值(`revise`/`force_pass`/`abandon`)比硬把三种语义塞进三个容易被误读的词(`approved`/`rejected`/`override`)要好——但这**明确是我对一段 DESIGN 文字的重新解读**,不是我已经验证过的既定结论;标出来请指挥官确认是否符合原意——如果指挥官坚持要用 `approved`/`rejected`/`override` 这三个词,我需要一条具体的映射规则(比如"force_pass→override,revise→rejected,abandon→?")——第三个词我目前想不出合理的映射,这也是我倾向"不强行映射"的部分原因。

**6. 检查 `rejectCount` 阈值这一步,不改 `nodes/tester.ts`,只改 `gates.ts` 的 `routeAfterReview`。**
这不是一个有争议的判断——写在这里是为了明确验证一个容易被误解的 LangGraph 执行顺序事实:A4a 的 `nodes/tester.ts` 已经在 `review` 节点自己的返回值里算好了 `rejectCount`(`data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount`);LangGraph 的执行模型是"一个节点函数返回 `Partial<State>` → 合并进 graph 的 state → *然后*才评估这个节点的出边(包括 `addConditionalEdges` 的路由函数)",不是"先路由,再合并"——所以 `routeAfterReview` 被调用时,它读到的 `state.rejectCount` **已经是**这一轮打回之后的新值;`routeAfterReview` 不需要自己 `+1`,也不需要依赖某个"上一轮"的旧值。这不是我编的——这是 LangGraph `StateGraph` 的标准执行语义(`addNode`→`addConditionalEdges` 的组合就是这么工作的;A4a 既有的 `graph.test.ts` 用例——比如"tester 拒绝一次,然后 G2 批准"那个——已经间接验证过这个顺序,只是 A4a 从没有一个测试专门断言过"路由函数读到的是最新值"这件事本身)。写在这里是为了让"为什么 `tester.ts` 不需要改"有据可查——不是留给指挥官选的开放项。

### 9.3 `EscalationResumeValue`/`GateLogEntry.decision` 精确的 TS 类型措辞——不在提前精确定义的范围内

跟 A4a §9.3 性质一样:`interrupt<GatePayload, EscalationResumeValue>()` 的泛型标注,以及联合类型 `GateLogEntry.decision: GateDecision | EscalationDecision`,在真实的 `tsc --strict` 下会不会需要额外的类型收窄——这不在本 PRD 提前精确定义的范围内;等 build 时第一次接触,按实际报错情况调整;不影响本节描述的字段语义。

---

**有件事现在就需要指挥官/军师裁决,会挡住开工**:§0.1 的 issue #13 关闭状态——继续用它、先 `gh issue reopen 13`,还是改开一个新 issue。除此之外,§9.2 汇总的 6 个设计决定各自已经在本 PRD 里写好了倾向性结论 + 理由,可以照着这些结论开工;如果指挥官不同意其中任何一条,随时可以打断纠正——不需要等全部确认完才能开始 B0。

## 10. 项目约束检查表

- **模型无关?** 是——本增量新增/改动的文件(`escalation.ts`/`audit-store.ts`/`runner.ts`/`gates.ts`/`graph.ts`)没有引用任何特定 provider/模型名;`runner.ts` 通过 `LoopGraphDeps`(`router`/`composer`)间接触达模型调用,跟 A4a 已经定下的边界一致。
- **没有反向跨层依赖?** 是——除了 Loop 层内部文件互相 import,`audit-store.ts`/`runner.ts` 只 import `better-sqlite3`(`harness/`/`context/`/`prompt/` 也在用的同一个第三方库,不是互相 import 对方的模块)和 `node:crypto`;`harness/types.ts`/`prompt/schema.ts` 的类型(`InvokeResult`/`Claim` 等)继续只做类型层面的 import。没有出现 `src/harness/`/`src/context/`/`src/prompt/` 反向 import `src/loop/` 的情况(§8 的验收标准已经列了这条 grep 检查)。
- **没有硬编码角色?** 部分——跟 A4a §10 一样的结论:`"coder"`/`"tester"` 这两个字符串继续硬编码在 `structured_claims.actor` 这类地方;这跟"按名字动态查 persona/schema 的机制本身是否硬编码"是两码事("这个 workflow 具体的节点/字段天然会提到这两个角色名"vs"查找机制本身是不是按名字动态查")——后者(答案依然是"不需要改")不受本增量影响。
- **`profiles/apikey/` 不进仓库?** 是——本增量不创建/修改 `profiles/apikey/` 下的任何文件。
- **引擎代码不含 Helix 人格?** 是——`src/loop/` 下新代码没有任何 Helix/companion/私密记忆内容。
- **远控点火(`CLAUDE.md` 铁律)?** 是——§5 的测试策略全部跑在玩具节点/`FakeAdapter`/受控 fixture 子进程/真实但离线的 SQLite 文件上;唯一新增的"真实子进程"测试(§5 测试点 4)拉起的是**本仓库自己的测试脚本**(node 调自己的代码),不是真实的 `claude`/`codex` CLI,也不调用任何外部服务——跟 A4a spike Q4 性质一样。
