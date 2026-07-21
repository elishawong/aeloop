# PRD — aeloop A4b:Loop 编排收尾(阈值强升 escalation + 三张审计表落盘 + checkpoint 跨进程生产化)

> 骨架来源:`aeloop/docs/feature/a4a-loop/PRD.md`(同一里程碑上一半,结构/批次/验收表述风格照抄,§0 范围切分是它定的)。
> 防幻觉:`[?]` = 我未验证 / 需要指挥官确认,不编造接口/版本/参数。本 PRD 每条对现有代码的描述都来自我对 A4a 真实代码(`src/loop/*.ts`)+ `docs/DESIGN.md` + `docs/feature/a4a-loop/spike-findings.md` 的实读,不是回忆;没有直接代码/文档证据、需要我自己判断的设计决策,都在 §9 单独列出并标注理由,不混进"已核实"的部分。

- **项目**:aeloop(`elishawong/aeloop`,私有仓)
- **分支**:`feature/issue-13-a4b-loop`(从 main `c6589b7`,即 A4a merge 后的 HEAD,新开)
- **优先级**:P1
- **状态**:待指挥官确认
- **最后更新**:2026-07-21
- **关联 issue**:[elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13)(A4 Loop 母 issue)——**⚠️ 核实到一个需要指挥官/军师先处理的问题,见 §0.1**
- **设计权威**:`aeloop/docs/DESIGN.md`(§4 门控流程图 / §5 ER 三张审计表 / §6 `src/loop/` 目标布局含 `escalation.ts` / §7 config.yaml `workflow.reject_threshold` / §8.5 方法论警示)+ A4a 真实代码 `src/loop/{types,errors,gates,graph,checkpoint,workflow-def}.ts`/`nodes/{coder,tester}.ts` + A4a `docs/feature/a4a-loop/{PRD.md,spike-findings.md}`

---

## 0. 范围(承接 A4a PRD §0 已定的切分)

A4a PRD §0 把 A4 Loop 母范围切成两半并已把切分理由写清楚,A4b(本 PRD)交付其中留白的一半:

1. **阈值强升 escalation 硬分支**——`reject_count >= threshold` 的条件路由 + `Escalation` 节点 + 人工三选一决定(改码/重述→Draft、强制通过→G3、放弃→Cancel)+ `Cancel` 终态。`config.yaml` 的 `workflow.reject_threshold`(存在但没人读,A4a §2 非目标明确留白)在本增量第一次被读取。
2. **三张审计表落盘**——`workflow_runs`/`structured_claims`/`approvals`(DESIGN §5 ER)真建表 + 真写入。A4a 的 `gateLog`(LangGraph checkpoint 会连带落盘,但从不写入这三张业务表)是这三张表(尤其 `approvals`)的字段命名前传。
3. **checkpoint 跨进程 resume 生产化**——把 `langgraph_thread_id` 存进 `workflow_runs`,做出"只凭 run 的一个标识符(不是内存里的任何引用)就能在全新进程里找到 thread_id 并续跑"的完整路径。A4a spike Q4 已经在本仓本栈用两个真实 `node` 子进程证明了 LangGraph 自己的 checkpoint 机制本身可信;A4b 要证明的是"aeloop 自己接的这层"（`workflow_runs` 查找 → checkpointer 构造 → resume）在生产语义下也成立。

### 0.1 issue #13 当前状态核实结果——需要指挥官/军师先决定一件事

按派工指令,本 PRD 不新开 issue,沿用 #13(A4a PRD §0.1 已确立的先例)。但我核实 `gh issue view 13` 时发现 **issue #13 当前是 `CLOSED` 状态**(`state: CLOSED`)。核对 A4a 的合并 PR #15,其 body 原文写着"A4 Loop 母 issue #13 的 A4a 子范围(A4b ... 待续,故本 PR **不 close #13**)",但 `gh pr view 15 --json closingIssuesReferences` 显示 #13 确实被 PR #15 关联为"closing issue"(`mergedAt: 2026-07-21T00:43:10Z`)——**这和 PR 作者(上一轮 Cypher)明确写下的意图相反**,大概率是 commit message/PR body 里某处的 `#13` 文本触发了 GitHub 的自动关闭链接(比如提交信息 `feat(loop): #13 A4a Loop 编排...` 这类写法在某些场景会被 GitHub 当成 closing keyword,即使正文另一句话明确说"不 close"),不是指挥官刻意关闭。

**我没有自己重开这个 issue**——issue 生死状态不属于"出 PRD"这个动作的常规权限范围,且不排除指挥官事后看过 A4a 成果后有意保持关闭、准备手动开一个新 issue 的可能(虽然我没找到证据支持这个可能性)。**这是一件需要指挥官/军师先确认再往下走的事**:如果按 A4a PRD §0.1 的先例继续用 #13,需要先 `gh issue reopen 13`;如果指挥官更倾向于给 A4b 单独开一个新 issue(比如就着这次意外关闭的事实,顺势拆开两个独立可追踪的 issue),也请直说,我可以现场调整本 PRD 头部的 issue 链接。**本 PRD 正文其余部分按"沿用 #13,需要先重开"这个假设撰写,不阻塞先看方案。**

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A4a 交付了 DESIGN §4 状态机里"打回几次都在正常范围内"的那部分——G1/G2/G3 三个门的正常分支、Draft↔Review 的完整往返、`reject_count` 的递增本身。但**没有任何东西读这个计数去做决策**:`config.yaml` 里 `workflow.reject_threshold: 2` 从被 `profile/loader.ts` 解析出来那天起就没人消费过(A2 的 `SystemConfig.getDefaultRejectThreshold()` 同样是"预留但无消费方"——见下方 §9.2 的核实)。同时,A4a 图执行期间产生的每一次门决策(`gateLog`)、每一条模型自报的 claim(`coderOutput.claims`/`testerOutput.claims`),除了活在 LangGraph 自己的 checkpoint 序列化里(`checkpoints`/`writes` 表,只关心"图执行到哪一步",不是业务审计语义)之外,没有任何地方能回答"这次 run 一共打回了几次""是谁在什么时候批准了 G3""tester 说了哪些 claim、confidence 是什么"——DESIGN §5 画的三张审计表完全不存在。而"关机重启后能不能凭一个 run 的标识符找回它卡在哪个门继续"这条,A4a 的 spike 证过 LangGraph 层机制可行,但 aeloop 自己的业务层(怎么找到 `thread_id`)完全没接。
- **给谁用**:直接消费方是 A5(CLI/TUI,需要审计表回答"这次 run 的历史是什么"、需要 `workflow_runs` 表回答"上次跑到哪了,给我一个能恢复的列表")和 A6(profile 双跑验收,需要审计表证明两边 profile 各自的运行有留痕)。间接消费方是指挥官本人——DESIGN §2 用例图的 `UC9 查审批审计` 现在第一次有真实数据可看。
- **一句话方案**:`src/loop/escalation.ts`(新)按 DESIGN §4 的 `Esc`/`HD` 建 Escalation 门节点(复用 A4a `gates.ts` 已验证的 `interrupt()`/`Command({resume})` 模式,但决策值域是三选一,不是 G1/G2/G3 的二选一,所以不直接复用 `createGateNode` 工厂,理由见 §5);`gates.ts` 改动两处路由(`routeAfterReview` 在打回时先比较 `rejectCount`/`rejectThreshold` 再决定去 `g2` 还是 `escalation`,`routeAfterG2` 多识别一个"主动升级"决策值);`graph.ts` 接上 `escalation`/`cancel` 两个新节点。`src/loop/audit-store.ts`(新)是 Loop 层自己的 SQLite store——不复用/不 import `context/store.ts` 的 `MemoryStore` 类,是它的同构兄弟(理由见 §9.2 设计决策1),独立管 `workflow_runs`/`structured_claims`/`approvals` 三张表的建表 + CRUD。`src/loop/runner.ts`(新)是图节点/门之上薄薄一层编排:开一个新 run 时先在 `AuditStore` 插入 `workflow_runs` 行拿到 `runId`,每次 `invoke`/`resume` 返回后,把新增的 `gateLog` 条目落 `approvals`、把新增的 claims 落 `structured_claims`、把 `workflow_runs` 的 `status`/`reject_count`/`current_state`/`updated_at` 刷新——图节点/门本身继续保持 A4a 已确立的"零 I/O、可玩具节点单测"纯度,审计写入全部发生在图外的这一层(呼应 A4a "interrupt 前必须纯函数"那条纪律的精神延伸)。checkpoint 跨进程验收换成 spike Q4 那种**真实两个 `node` 子进程**(而不是 A4a 自己测试里用的同进程双阶段),因为 A4b 的任务定义就是"生产化"这条路径,理由见 §9.2 设计决策4。

## 2. 目标 / 非目标

**目标**:
- `src/loop/escalation.ts`:`createEscalationNode()`(三选一 interrupt 门)+ `routeAfterEscalation()`(三路由:`"draft" | "g3" | "cancel"`)。
- `src/loop/gates.ts` 改动:`routeAfterReview` 增加阈值分支(`"g3" | "g2" | "escalation"`);`routeAfterG2` 增加"主动升级"分支(`"draft" | "escalation"`,`"rejected"` 仍然 fail loud,A4a 那条判断不变)。
- `src/loop/types.ts` 改动:`LoopState` 加 `rejectThreshold`(图外部注入一次,不变)、`escalationDecision`、`cancelled`;`GateType` 加 `"ESCALATION_ACK"`;`GateDecision` 加第三个值(G2 的"主动升级");新增 `EscalationDecision` 类型。
- `src/loop/workflow-def.ts` 改动:`LOOP_NODES` 加 `escalation`/`cancel`;`GATE_TYPES` 加 `ESCALATION_ACK`;`CODER_TESTER_LOOP_DEFINITION` 的边列表同步补全(文档性质,同 A4a 的降级结论不变)。
- `src/loop/graph.ts` 改动:接入 `escalation`/`cancel` 两个新节点 + 相应边;`review` 的条件边目标集合从 `{g3,g2}` 扩到 `{g3,g2,escalation}`;`g2` 的条件边目标集合从 `{draft}` 扩到 `{draft,escalation}`。
- `src/loop/audit-store.ts`(新):`AuditStore` 类,`workflow_runs`/`structured_claims`/`approvals` 三张表建表 + insert/read 方法(DESIGN §5 ER 字段对齐,见 §4)。
- `src/loop/runner.ts`(新):`startRun()`/`resumeRun()`——包一层 `compiled.invoke()`/`Command({resume})`,每次调用后把新增的 `gateLog`/`claims` 落盘 + 刷新 `workflow_runs` 行,`runId`/`threadId` 是这层对外的句柄。
- **checkpoint 跨进程生产化**:一条测试用真实 `child_process`(两个独立 `node -e`/脚本调用,模拟 spike Q4 的 Process A/B 模式)证明"进程 A 跑到某个门中断退出 → 进程 B 只凭 `workflow_runs` 表里的 `runId`(不是任何内存引用)查到 `langgraph_thread_id`+ `reject_threshold` 等字段 → 重建 checkpointer/图 → resume 到底"。
- **硬性垂直切片**(比 A4a 更长一截):真实链路(Context→Prompt→cli-bridge fixture adapter→真实图→真实 checkpointer→真实 `AuditStore`)跑一条**故意打回到阈值**的路径——tester fixture 配置成连续 N 次打回(`N = threshold`)→ 走到 `escalation` → 人工选"强制通过"→ `g3` → `apply`,全程 `approvals`/`structured_claims`/`workflow_runs` 三张表被断言真实写入且字段对齐。

**非目标(明确不做,留给 A5/A6 或后续增量)**:
- ❌ **彩色 TUI / y/n 批准界面**——A5。Escalation 门和 G1/G2/G3 一样,由测试代码直接构造 `Command({resume: {...}})` 注入决策。
- ❌ **`workflow_runs` 表被任何"列出所有可恢复 run"的 CLI 命令消费**——那是 A5 的 UI 层工作,A4b 只交付表本身 + 底层查询方法(`AuditStore.getRunById`/`getRunByThreadId`),不做列表/交互命令。
- ❌ **`system_config.default_reject_threshold`(A2 已建、无消费方)和 `config.yaml` 的 `workflow.reject_threshold` 两个阈值来源的完整优先级机制做成可配置策略**——A4b 只做一个明确、写死的优先级顺序(见 §9.2 设计决策2 的结论),不做"哪个优先级更高可以再配置"这种二级配置。
- ❌ **真的把 diff 落盘到工作区文件系统**——沿用 A4a §2 非目标,`Apply` 节点继续只做状态终结,不接文件系统。这条边界本增量不重新讨论。
- ❌ **`Cancel` 之后的任何清理动作**(比如删除临时文件、通知渠道)——`Cancel` 节点和 `Apply` 一样只做状态终结(`{cancelled: true}`),不做任何副作用。
- ❌ **`profiles/apikey/` 的任何内容**——不碰。
- ❌ **`AuditStore` 和 `MemoryStore`/`checkpoint.ts` 的 db 路径统一由 `profile/loader.ts` 自动算出**——A1/A2/A4a 都还没做"profile 决定真实文件路径"这层wiring(`MemoryStore`/`createSqliteCheckpointer` 至今都是显式传入 `dbPath` 的调用方职责),A4b 延续这个既有边界,`AuditStore` 同样只接受显式 `dbPath` 构造参数。§9.2 设计决策3 会说明**推荐的目标路径关系**(供未来 wiring 增量参照),但本增量不实现自动路径解析。
- ❌ **G3 的 payload 区分"正常 G3"和"强制通过后的 G3"**——DESIGN §4 的 `HD-- 强制通过 -->G3` 意味着强制通过之后仍要走 G3 正常签字,A4b 让它就是同一个 `createG3Node()`,不新增字段标记"这次 G3 是被强推过来的"。如果指挥官认为审计表需要能区分这两种 G3,请指出,§9.2 会留一个可选加字段的口子。

## 3. 用户故事

- 作为 **未来的 A5 CLI**,我想要 `workflow_runs` 表里有一行能查到某次 run 现在卡在哪个 `current_state`、`langgraph_thread_id` 是什么,这样"恢复一个未完成的 run"不需要用户自己记住任何进程内部状态。
- 作为 **未来的 A6 双 profile 验收**,我想要每次真实 coder/tester 调用留下的 claim(`claim_text`/`confidence`/`verified_by`/`tool_exec_checked`)、每次门决策(`gate_type`/`decision`/`decided_by`/`decided_at`)都能从 `structured_claims`/`approvals` 表里查出来,不用回放测试日志。
- 作为 **指挥官**,我想要看到一条测试真的把 `reject_count` 打到 `reject_threshold`,证明图会自动路由到 Escalation 而不是无限打回 G2,并且我在 Escalation 门做的"强制通过/重述/放弃"三个决定分别导向 G3/Draft/Cancel 三个不同的真实终点。
- 作为 **指挥官**,我想要确认"关机重启后继续"这句话现在有真实的跨进程证据(不是同进程内假装丢弃引用),证明方式和 A4a spike Q4 同一量级(两个真实独立 `node` 进程,不同 pid)。

## 4. 数据模型

### 4.1 `LoopState` 新增/变更字段(`src/loop/types.ts`)

```typescript
const LoopState = Annotation.Root({
  // ...A4a 已有字段全部保留,不变...

  /** 本次运行的打回阈值快照——图外部注入一次(和 injectedContext 同等地位),整个运行期间不变。来源见 §9.2 设计决策2。 */
  rejectThreshold: Annotation<number>(),

  /** Escalation 门的人工三选一决定,undefined 直到第一次真的走到这个门。 */
  escalationDecision: Annotation<EscalationDecision | undefined>(),

  /** Cancel 节点终结标记,语义对称于 A4a 已有的 `applied`。 */
  cancelled: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});
```

`GateType` 加一个值:`"ESCALATION_ACK"`(DESIGN §5 `approvals.gate_type` 枚举里 A4a 唯一没做的那个,现在补上)。

`GateDecision` 从 A4a 的 `"approved" | "rejected"` 扩到 `"approved" | "rejected" | "escalate"`——第三个值只有 `routeAfterG2` 认(DESIGN §4 `G2-- 主动升级 -->Esc` 这条边),`routeAfterG1`/`routeAfterG3` 收到它会落进它们已有的 `default: throw new Error(...)` 兜底分支(这两个门的正常语义里"主动升级"从未有意义——不是新增的疏漏,是延续 A4a 已经确立的"类型系统允许但某个具体门不认"的处理方式)。

新增 `EscalationDecision = "revise" | "force_pass" | "abandon"`——**字面对应 DESIGN §4 状态图 `HD` 节点画出的三条出边**("改码/重述"/"强制通过"/"放弃"),不是我发明的第四套词汇。`GateResumeValue`(G1/G2/G3 用)和 Escalation 门用的 resume 值类型分开:新增 `EscalationResumeValue = { decision: EscalationDecision; reasoningText?: string }`。

`GateLogEntry.decision` 的类型从 `GateDecision` 扩成 `GateDecision | EscalationDecision`(Escalation 门产生的日志条目 `decision` 字段是三选一的值,不是二选一)——这条会不会是本增量"build 阶段第一次接触才摸出准确写法"的另一个 TS 类型细节(类似 A4a §9.3 点过的 `LoopStateType`/`Command` 泛型坑),我不确定,标 `[?]`,build 阶段第一次 `tsc` 报错时按实际情况调整,不影响这里描述的字段语义。

### 4.2 三张审计表(`src/loop/audit-store.ts`,`CREATE TABLE IF NOT EXISTS`,建表时机 = `AuditStore` 构造函数,同 `MemoryStore` 的 `createSchema()` 惯例)

严格对齐 DESIGN §5 ER(列名/类型/可空性),`snake_case` 列名 + 应用层 camelCase 映射,同 `context/store.ts` 的 `MemoryRow`/`Memory` 映射惯例:

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  workflow_def_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'running' | 'escalated' | 'completed' | 'cancelled'
  reject_count INTEGER NOT NULL DEFAULT 0,
  reject_threshold INTEGER NOT NULL,  -- 本次运行快照,不追踪 config.yaml 之后的改动
  current_state TEXT NOT NULL,        -- LOOP_NODES 的某个值,runner 每步之后刷新
  langgraph_thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS structured_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  step_ref TEXT NOT NULL,             -- "<node>#<round>",见下方 step_ref 的判断
  actor TEXT NOT NULL,                -- 'coder' | 'tester'
  claim_text TEXT NOT NULL,
  confidence TEXT NOT NULL,           -- ClaimConfidence: verified/inferred/unconfirmed/stale
  source_ref TEXT,
  verified_by TEXT,                   -- VerifiedBy: tool_execution/human/unverified
  tool_exec_checked TEXT,             -- ToolExecChecked: pass/fail/na,来自 InvokeResult(cli-bridge 才有,direct-api 为 NULL)
  model_used TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES workflow_runs(id),
  gate_type TEXT NOT NULL,            -- GATE_TYPES 的某个值,含新增的 ESCALATION_ACK
  step_ref TEXT NOT NULL,
  diff_ref TEXT,
  reasoning_text TEXT,
  decision TEXT NOT NULL,             -- G1/G2/G3 行:approved/rejected/escalate;ESCALATION_ACK 行:revise/force_pass/abandon(见 §9.2 设计决策5)
  decision_reason TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  latency_seconds INTEGER
);
```

**`step_ref` 的格式**(DESIGN 没给出具体格式,`[?]` 我的判断):`"<LOOP_NODES 值>#<该节点在这次 run 里第几次执行,从1开始>"`,如 `"draft#1"`/`"review#2"`。`runner.ts` 内部维护一个"每个节点名执行过几次"的计数器(每次 `invoke`/`resume` 返回后,比较新旧 state 判断走过了哪个节点,递增对应计数),这个计数器**只存在于 `runner.ts` 的运行期变量里,不落盘为 `LoopState` 的一部分**——它是纯粹的审计写入辅助信息,不是图逻辑需要的状态,放进 `LoopState` 会让"图的状态形状"承担本不属于它的审计关注点(呼应 §9.2 设计决策1 的分层理由)。

**`decided_by` 从哪来**:A4a 的 `GateResumeValue`/`EscalationResumeValue` 都没有"谁做的决定"这个字段(只有 `decision`/`reasoningText`)。A4b 需要在 `Command({resume})` 的 resume 值里加一个 `decidedBy: string` 字段吗,还是 `runner.ts` 的调用方(测试/未来 CLI)在调 `resumeRun()` 时单独传入?**我倾向后者**——`decidedBy` 是"谁在操作这次 resume"这个外部环境信息,不是"图执行到这一步产生的数据",和 `injectedContext`/`rejectThreshold` 一样应该是"图外部注入"的东西,不属于 `GateResumeValue`/`EscalationResumeValue` 这类"人对 interrupt() 的回答"形状。`runner.resumeRun(runId, threadId, resume, decidedBy)` 签名里单独收这个参数。标 `[?]` 供确认,这是本 PRD 除 §9.2 六条主决策外唯一一处散落的小判断。

## 5. 逐文件任务清单

### `src/loop/types.ts`(改动,非新文件)
- 见 §4.1 全部字段/类型改动。`LoopNodeName` 联合无需改(`(typeof LOOP_NODES)[keyof typeof LOOP_NODES]` 自动吃到 `workflow-def.ts` 新增的 `escalation`/`cancel`)。

### `src/loop/errors.ts`(改动)
- `UnhandledGateDecisionError` 保留(仍是 `routeAfterG2` 收到 `"rejected"` 时抛的那个,语义不变)。
- 新增 `AuditReadError extends Error`(`AuditStore` 的读方法失败时抛,镜像 `context/errors.ts` 的 `RecallError` 惯例——"读失败必须可见,不能悄悄退化成空结果/undefined"这条纪律延续到 Loop 层自己的 store)。写方法(insert)让 `better-sqlite3` 的 `SqliteError` 原样传播,不额外包装——同 `MemoryStore` 写方法的既有约定(§9.2 决策1 的一部分)。

### `src/loop/workflow-def.ts`(改动)
- `LOOP_NODES` 加 `escalation: "escalation"`、`cancel: "cancel"`。
- `GATE_TYPES` 加 `ESCALATION_ACK: "ESCALATION_ACK"`。
- `CODER_TESTER_LOOP_DEFINITION.edges` 同步补全新边(纯文档,同 A4a 的降级结论——`graph.ts` 依然不运行时读它):
  - `review → [g3, g2, escalation]`(从 A4a 的 `[g3, g2]` 扩)
  - `g2 → [draft, escalation]`(从 A4a 的 `[draft]` 扩)
  - `escalation → [draft, g3, cancel]`(新)
  - `cancel → "__end__"`(新)

### `src/loop/gates.ts`(改动,不是新文件——A4a 已有文件)
- `routeAfterReview`:签名从 `(state): "g3" | "g2"` 改成 `(state): "g3" | "g2" | "escalation"`。逻辑:`verdict === "pass" → "g3"`;`verdict === "reject"` 时,`state.rejectCount >= state.rejectThreshold → "escalation"`,否则 `"g2"`。**这条依赖 `nodes/tester.ts` 已经把 `rejectCount` 递增写进返回值这一事实**(A4a 既有行为,不用改 `tester.ts`——LangGraph 在评估条件边路由函数之前,已经把节点返回的 `Partial<LoopStateType>` 合并进 state,`routeAfterReview` 读到的就是递增后的值,这条我在 §9.2 决策6 里详细说明为什么不用碰 `tester.ts`)。
- `routeAfterG2`:签名从 `(state): "draft"` 改成 `(state): "draft" | "escalation"`。`"approved" → "draft"`(不变);`"escalate" → "escalation"`(新,DESIGN §4 `G2-- 主动升级 -->Esc`);`"rejected"` 及任何其它值仍然抛 `UnhandledGateDecisionError`(A4a 这条判断本增量不推翻)。
- 其余(`createGateNode`/`createG1Node`/`createG2Node`/`createG3Node`/`routeAfterG1`/`routeAfterG3`)**不改**——这几个门的决策域/路由目标集合在 A4b 里没有变化。

### `src/loop/escalation.ts`(**新文件**)
- **为什么不复用 `gates.ts` 的 `createGateNode` 工厂**:那个工厂的类型签名假定 resume 值是二选一的 `GateResumeValue`(`decision: GateDecision`),且它内部用一个三路 `switch` 把 `decisionField` 映射到 `g1Decision`/`g2Decision`/`g3Decision` 三个具体字段之一——Escalation 门的 resume 值是三选一的 `EscalationResumeValue`(`decision: EscalationDecision`),写回的字段是单一的 `escalationDecision`,硬塞进现有工厂要么破坏它的类型精度(工厂原本刻意避免用"计算属性 key"来保持 `Partial<LoopStateType>` 的精确类型,见 `gates.ts` 现有注释),要么需要把工厂改成对两种决策类型都通用的泛型版本——这个泛型化本身的风险(可能连带影响 A4a 已经测试通过、Zorro 已经三轮审过的 `gates.ts` 逻辑)大于"少写几行重复代码"的收益。`escalation.ts` 因此是一个结构上**平行**于 `createGateNode` 的独立实现,复制其"payload 纯函数 → `interrupt()` → 之后才构造日志条目"的核心纪律(A4a spike Q3 那条规则同样适用,不因为在新文件里就可以违反)。
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
          : undefined; // force_pass/abandon 不回 Draft,不需要下一轮 feedback
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
  (以上是设计形状,不是最终代码——`GatePayload`/`GateLogEntry` 是否需要为 Escalation 单独扩展字段、`interrupt<GatePayload, EscalationResumeValue>` 的泛型标注是否和 A4a spike Q5 的坑一致,build 阶段核实。)

### `src/loop/graph.ts`(改动)
- `addNode(LOOP_NODES.escalation, createEscalationNode())`
- `addNode(LOOP_NODES.cancel, cancelNode)`(新的内部小函数,`{cancelled: true}`,和现有 `applyNode` 完全对称,同样不单独建 `nodes/cancel.ts` 文件——DESIGN §6 文件列表也没列)
- `addConditionalEdges(LOOP_NODES.review, routeAfterReview, { g3: ..., g2: ..., escalation: LOOP_NODES.escalation })`(替换 A4a 现有的两路 pathMap)
- `addConditionalEdges(LOOP_NODES.g2, routeAfterG2, { draft: ..., escalation: LOOP_NODES.escalation })`(替换 A4a 现有的单路 pathMap)
- `addConditionalEdges(LOOP_NODES.escalation, routeAfterEscalation, { draft: ..., g3: ..., cancel: LOOP_NODES.cancel })`(新)
- `addEdge(LOOP_NODES.cancel, END)`(新)
- `buildLoopGraph(deps)` 的签名不变(`escalation`/`cancel` 节点都无外部依赖,不需要 `router`/`composer`)。

### `src/loop/audit-store.ts`(**新文件**)
- `AuditStore` 类,构造函数 `(dbPath: string)`,内部开自己的 `better-sqlite3.Database` 连接(**不**复用/包装 `MemoryStore`——见 §9.2 决策1),`createSchema()` 建 §4.2 三张表(`CREATE TABLE IF NOT EXISTS`,幂等,同 `MemoryStore` 惯例)。
- 写方法:`insertRun(input): WorkflowRun`(返回带 `id` 的完整行,同 `MemoryStore.insertMemory` 惯例)、`updateRunProgress(id, patch: {status?, rejectCount?, currentState?, updatedAt})`、`insertClaim(input): StructuredClaim`、`insertApproval(input): Approval`。
- 读方法(`AuditReadError` 包裹失败,同 `RecallError` 惯例):`getRunById(id): WorkflowRun | undefined`、`getRunByThreadId(threadId): WorkflowRun | undefined`(**跨进程 resume 生产化那条测试的核心查询**——"进程 B 只知道 threadId 或 runId,要能查回整行")。
- `runInTransaction<T>(fn: () => T): T`——同 `MemoryStore`,供 `runner.ts` 把"插入多条 claim"这类多行写入包进单个事务。
- `close(): void`。
- 本文件**不** import `../context/store.js` 或任何 `context/` 的实现(只有类型层面如果需要复用 `ClaimConfidence`/`VerifiedBy`/`ToolExecChecked` 这些**已在 `harness/`/`prompt/` 定义**的枚举类型,那些不算 context 依赖)。`nowIso()` 时间戳helper 本文件内部复制一份 2 行小函数,不引入对 `context/util.ts` 的依赖(§9.2 决策1 的延伸判断,理由:一个 2 行纯函数不值得为它把 `nowIso` 提升到 `src/shared/` 再让两层都改 import,等真的出现第三处需要时再考虑提升)。

### `src/loop/runner.ts`(**新文件**)
- `interface StartRunDeps { router: ProviderRouter; composer: PromptComposer; audit: AuditStore; checkpointer: BaseCheckpointSaver }`(比 `LoopGraphDeps` 多了 `audit`/`checkpointer`,`runner.ts` 是唯一同时持有"图依赖"和"审计依赖"的地方——图节点本身继续对 `AuditStore` 一无所知)。
- `startRun(deps, input: { task: string; profile: string; workflowDefId: string; injectedContext: ContextInjectionResult; rejectThreshold: number }): Promise<RunHandle>`:
  1. 生成一个 `threadId`(`[?]` 用什么生成——`crypto.randomUUID()` 是 Node 内置、零新依赖的显然选择,除非指挥官有别的偏好)。
  2. `deps.audit.insertRun({ task, workflowDefId, profile, status: "running", rejectCount: 0, rejectThreshold, currentState: LOOP_NODES.draft, langgraphThreadId: threadId, ... })` 拿到 `runId`。
  3. `compileLoopGraph(buildLoopGraph({router: deps.router, composer: deps.composer}), deps.checkpointer).invoke({task, injectedContext, rejectThreshold, ...其余字段用默认}, {configurable: {thread_id: threadId}})`。
  4. 对比 invoke 前后的 state,把新出现的 `gateLog` 条目/`coderOutput.claims`/`testerOutput.claims` 落 `approvals`/`structured_claims`(§4.2 的 `step_ref` 计数器从这里开始维护),刷新 `workflow_runs` 的 `current_state`/`updated_at`(`status` 只有真的到达 `applied`/`cancelled` 才改成 `completed`/`cancelled`,中途维持 `running`,除非 `escalationDecision` 被设置过——那种情况 `status` 短暂标 `escalated`,§9.2 决策未覆盖到的一个细节,`[?]` build 阶段确认具体状态机怎么映)。
  5. 返回 `{ runId, threadId, interruptState | finalState }`(具体形状 build 阶段定,呼应中断/完成两种可能返回)。
- `resumeRun(deps, runId: number, threadId: string, resume: GateResumeValue | EscalationResumeValue, decidedBy: string): Promise<RunHandle>`:对称逻辑,`Command({resume})` 续跑 + 同样的审计落盘。**关键约束**:这个函数**不要求调用方持有任何来自 `startRun()` 的内存对象引用**——只需要 `runId`/`threadId`(从 `AuditStore` 或调用方自己记的都行)+ 一个全新构造的 `checkpointer`(指向同一 db 文件)。这是"生产化"这个词在本 PRD 里的具体含义:`resumeRun` 的参数表**本身**就是"能在全新进程里调用"的证据,不需要额外包一层。
- `getResumableRuns(deps, status: "running" | "escalated"): WorkflowRun[]`(薄封装 `AuditStore` 的读方法,给未来 A5 一个现成入口——**这条不是本增量测试要覆盖的重点**,只是顺手把 `runner.ts` 作为"业务层"该暴露的读接口定好形状,不算额外范围)。

### 依赖 / 打包
- `package.json`:**不新增依赖**(`crypto`/`node:crypto` 是 Node 内置)。

### 测试(与逐文件任务一一对应,延续 A4a 已确立的"真实但受控"三层哲学 + 新增第 4 层"审计层"和第 5 层"跨进程")

1. **`escalation.ts`/`graph.ts` 的新分支——玩具节点 + `MemorySaver`**(`graph.test.ts` 追加用例,不新建文件):①打回连续到达 `rejectThreshold` → 路由到 `escalation` 而不是 `g2`;②`escalation` 门收到 `"force_pass"` → 路由到 `g3` → 后续正常 G3 approve → apply;③收到 `"revise"` → 路由到 `draft`,且 `feedback` 里带上了 tester 的 issues;④收到 `"abandon"` → 路由到 `cancel` → `state.cancelled === true`;⑤G2 收到 `"escalate"` → 路由到 `escalation`(不是 `draft`);⑥`escalation` 收到未识别值 → 抛 `Error`(镜像 A4a 已有的 G1/G3 兜底测试写法)。
2. **`audit-store.ts` 的单测**(新 `src/loop/__tests__/audit-store.test.ts`):真实 `better-sqlite3` 临时文件(同 `checkpoint.test.ts` 的 `fs.mkdtempSync` 手法),①`insertRun`/`getRunById` 往返;②`getRunByThreadId` 能查到;③`insertClaim`/`insertApproval` 的外键(`run_id`)指向一个不存在的 `workflow_runs.id` 时的行为(`better-sqlite3` 默认不强制外键除非 `PRAGMA foreign_keys=ON`——**是否要在这个 store 上开外键约束是一个小判断**,`MemoryStore` 开了,`AuditStore` 大概率也该开,标 `[?]` 但倾向"开",build 阶读确认);④`runInTransaction` 失败回滚不留半条数据。
3. **`runner.ts` 的单测**(新 `src/loop/__tests__/runner.test.ts`):真实 `graph.ts`(不是玩具图,理由同 A4a 用真实图测 checkpoint 的选择)+ `FakeAdapter`(同 A4a 已用的手法)+ 真实 `AuditStore`(临时文件)+ 真实 `SqliteSaver`(另一个临时文件,或和 `AuditStore` 共享同一个文件——见 §9.2 决策3,这条测试本身就是验证"共享一个文件工不工作"的地方)。①`startRun` 后 `workflow_runs` 表有一行 `status: "running"`;②G1 approve 后 `approvals` 表新增一行 `gate_type: "G1_SEND_TO_TESTER"`;③打到阈值触发 escalation 后 `workflow_runs.status` 变化(具体值按上方 runner.ts 任务描述里标的 `[?]` 敲定);④`coderOutput.claims` 非空时 `structured_claims` 表按 claim 数量插入对应行数,`actor: "coder"`,`model_used`/`provider_used` 对齐 `coderResult.model`/`.provider`。
4. **checkpoint 跨进程生产化**(新 `docs/feature/a4b-loop/spike/` 下两个小脚本,或直接 `src/loop/__tests__/cross-process-resume.test.ts` 里用 Node `child_process.spawnSync` 跑两个内联脚本——**具体是"新增脚本文件"还是"测试内联 spawn 一段脚本字符串"由 build 阶段定,不影响验收标准**):①进程 A(通过 `runner.startRun`)跑到某个门中断、`process.exit(0)`;②进程 B 完全独立启动,只传 `dbPath`(`AuditStore`)+ `runId`,先 `audit.getRunById(runId)` 拿到 `langgraphThreadId`,再构造全新 `checkpointer`(指向同一个 db 文件)+ 全新编译图,`resumeRun` 续跑到底;③断言进程 B 的最终 `workflow_runs.status` 是 `"completed"`。这条测试**替代**(不是叠加)A4a `checkpoint.test.ts` 的同进程双阶段做法用于验证"跨进程"这个具体主张——A4a 那条测试本身不改、继续留着测"`checkpoint.ts` 这个薄封装本身"的非闭包状态,A4b 这条新测试测的是"`runner.ts`/`audit-store.ts` 接的这一层业务查找逻辑在跨进程语义下也成立",两条测试的关注点不重叠,理由见 §9.2 决策4。
5. **硬性垂直切片**(`src/loop.e2e.test.ts` 追加一个新的 `it`/`describe` 块,不是新文件——延续 A4a 已有的文件位置):见 §2 目标里描述的"故意打到阈值→escalation→强制通过→apply"路径,复用 A4a e2e 已经搭好的 Context/Prompt/adapter fixture 搭建逻辑,**新增**一个会连续返回 `verdict: "reject"` 的 tester fixture 场景(A3 fixture 惯例的"加 case 不复制新文件")。断言:①`workflow_runs` 表最终 `status: "completed"`,`reject_count` 等于走到 escalation 之前打回的次数;②`approvals` 表里有一行 `gate_type: "ESCALATION_ACK"`,`decision: "force_pass"`;③`structured_claims` 表行数等于 coder+tester 各轮产出的 claims 总数。

## 6. 批次拆解

> 单位延用 A0-A4a PRD 的量级:`[S]` ≈ 2-4h、`[M]` ≈ 半天到一天、`[L]` ≈ 1-2 天。单分支 `feature/issue-13-a4b-loop` 顺序提交(理由同 A0-A4a)。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `types.ts`/`workflow-def.ts`/`errors.ts` 改动(§4.1 全部字段/类型 + `LOOP_NODES`/`GATE_TYPES` 扩充 + `AuditReadError`) | 无(起点,A4a HEAD 之上) | [S] |
| **B1** | `src/loop/escalation.ts` + `gates.ts` 两处路由改动(`routeAfterReview`/`routeAfterG2`) | B0 | [M] |
| **B2** | `graph.ts` 接线(escalation/cancel 节点+边)+ `graph.test.ts` 追加用例(§5 测试第1点全部6条分支) | B1 | [M] |
| **B3** | `src/loop/audit-store.ts` + 单测(§5 测试第2点) | B0(只需要类型,不依赖图改动) | [M] |
| **B4** | `src/loop/runner.ts` + 单测(§5 测试第3点)——本增量整合复杂度最高的一批,把 B2 的图改动和 B3 的 store 接在一起 | B2+B3 | [L] |
| **B5** | checkpoint 跨进程生产化测试(§5 测试第4点,真实 `child_process`) | B4 | [M] |
| **B6** | 硬性垂直切片(`src/loop.e2e.test.ts` 追加阈值路径,§5 测试第5点)+ 新增 tester fixture 场景 | B4(不严格依赖 B5,但建议 B5 之后做,便于共享跨进程验证中发现的问题) | [L] |
| **B7** | 文档回写(`docs/ROADMAP.md` A4b 行打钩、`docs/PROGRESS.md` 清空、`CHANGELOG.md` 加行、根 `CLAUDE.md` 更新、`CHARTS/knowledge/aeloop.md`(ai-agent 仓)新增/更新 `escalation.ts`/`audit-store.ts`/`runner.ts` 三个模块条目 + 更新已有 Loop 层条目里"A4b 待续"字样) | B6 | [S] |

**依赖图要点**:B1(escalation+路由)和 B3(audit store)彼此独立,理论上可并行(B1 只依赖 B0 的类型,B3 也只依赖 B0 的类型),同一个 Cypher 顺序实现故不额外拆分支,但如果指挥官希望分阶段审,B0-B3(类型+图分支+审计表,互相独立的机制单元)/ B4-B5(runner 整合+跨进程,风险核心)/ B6-B7(垂直切片+文档)是自然断点,和 A4a PRD §7 的分阶段建议同一个思路。

**总体量级估计**:对照 A4a 实际交付量(7 批,254 个测试),A4b 涉及的新增/改动文件数相近但整合复杂度更高(runner.ts 是本增量独有的、A4a 没有对应物的新架构层),粗估总工作量和 A4a 相当或略多,不是"A4a 的一个小尾巴"。

## 7. 分支策略

单分支 `feature/issue-13-a4b-loop`(从 A4a merge 后的 main `c6589b7` 开出),批次按 §6 顺序提交,理由同 A4a。

## 8. 可测验收标准(可勾选)

- [x] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess` 无报错),`pnpm lint` 同样无报错。
- [x] `pnpm test` 全绿(276/276),新增 A4b 测试文件全部计入,`grep` 确认零真实网络/真实 CLI 调用(同 A3/A4a 已有检查手法;唯一新增的真实 `spawn` 是 `cross-process-resume.test.ts` spawn 本仓自己的 `.mjs` fixture,不是外部 CLI/网络)。
- [x] **阈值真触发 escalation**:`graph.test.ts` 新增"reject_count reaching rejectThreshold routes to escalation, not g2; below threshold still routes to g2"测试,两条边界都测且都真的走过真实图。
- [x] **Escalation 三选一决定全部有路由 + 测试覆盖**:`graph.test.ts` 三条独立测试分别驱动 `revise→draft`/`force_pass→g3`/`abandon→cancel`。
- [x] **G2 主动升级分支真实存在**:`graph.test.ts`"G2 receiving 'escalate'...routes to escalation, not draft"测试驱动真实图;`UnhandledGateDecisionError` 继续只对非 `approved`/`escalate` 的值生效(既有测试未变,`escalate` 是新增合法分支不是新增异常)。
- [x] **三张审计表真实建表 + 真实写入**:`audit-store.test.ts`(9 用例)证明 schema+字段对齐 §4.2;`runner.test.ts`/`loop.e2e.test.ts` 证明真实图执行的 `gateLog`/claims 落进 `approvals`/`structured_claims`,`workflow_runs` 的 `reject_count`/`current_state`/`status` 随每次 `resumeRun()` 调用真实刷新。
- [x] **checkpoint 跨进程生产化真做**:`cross-process-resume.test.ts` 用两个真实独立 `node` 进程(`spawnSync`,pid 经断言不同),进程 B 只凭 `dbPath`+`runId` 查回 `langgraph_thread_id` 续跑到底——两个 fixture 脚本 import 编译后 `dist/`(不是 `src/`,plain Node 无 TS 的 `.js`→`.ts` 解析映射,测试 `beforeAll` 先跑 `pnpm build`)。
- [x] **垂直切片必接通(含 escalation)**:`loop.e2e.test.ts` 新增场景走完"真实 Context→Prompt→cli-bridge fixture(`fake-codex.fixture.mjs` 新增 `tester-reject` 场景)→真实 ProviderRouter→真实图(经 `runner.startRun`/`resumeRun`,非直接 `invoke`)→真实 checkpointer→真实 AuditStore→阈值 2→escalation→force_pass→G3→apply"全链路,三张表事后可查(用真实 `rejectThreshold: 2`,顺带过 G2 正常路径,不是简化成 threshold=1 的最短路径)。
- [x] **图节点/门继续保持零 I/O 纯度**:`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 零命中,已核实。
- [x] **跨层无反向依赖延续**(⚠️ 见 handoff 备注一处需指挥官/军师知悉的检查口径落差):`grep -rln "from.*loop" src/harness src/context src/prompt` 零命中;`grep -n "from \"\.\./\.\./context\|from \"\.\./context" src/loop/audit-store.ts` 单独核零命中(§9.2 决策1 的真正主张)。本行字面把 `runner.ts` 也列进同一条 grep,但 `runner.ts` 依 §5 自己的 `startRun()` 签名要求 type-only import `ContextInjectionResult`(`../context/injector.js`)——和 `types.ts` 自 A4a 起的既有先例一致(Loop→Context 是嵌套架构允许的方向,§9.2 决策1 反对的是"复用 `MemoryStore` 实现",不是"完全不碰 `context/` 任何类型")。判定这条本身没有实质违反跨层方向,是 PRD §8 这一条 grep 文本比 §5/§9.2 决策1 的实际主张更宽,按更具体的条款执行。
- [x] `docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/根 `CLAUDE.md`/`CHARTS/knowledge/aeloop.md`(ai-agent 仓)按 §6 B7 回写;另按派工指令顺手订正 `docs/DESIGN.md` §1.5 ruflo 措辞(仅此一处,已用 diff 核实范围)。

## 9. 依赖 / 风险 / 开放问题

### 9.1 issue #13 关闭状态(见 §0.1)

已在 §0.1 详细说明——需要指挥官/军师先决定"重开 #13"还是"另开新 issue",本 PRD 暂按"沿用 #13,待重开"撰写。

### 9.2 六条设计决策——请逐条确认(按派工指令要求的四个问题展开,外加两条我在写作过程中发现必须一并定的)

**1. 审计表写入的层归属:`AuditStore` 是 Loop 层自己独立的 SQLite store,不 import/复用 `context/store.ts` 的 `MemoryStore` 类。**
理由:DESIGN §1.5 的嵌套模型(`Prompt ⊂ Context ⊂ Harness ⊂ Loop`)意味着 Loop 允许使用 Context(方向上不违反"内层不知道外层"),但"允许依赖"不等于"应该依赖"——`workflow_runs`/`structured_claims`/`approvals` 三张表在语义上是 Loop 自己的运行台账(`reject_count`/`current_state`/`langgraph_thread_id` 全部是 Loop 领域概念),和 Context 层"模型看到什么记忆"这个关注点没有交集;`MemoryStore` 这个类本身的方法集合(`insertMemory`/`searchMemories`/FTS5 相关)也完全不是 Loop 需要的操作。硬要复用 `MemoryStore` 只是为了"省事",代价是让 Loop 的审计持久化耦合到一个为不同领域设计的类的内部实现细节(比如它的 `createSchema()` 私有方法会连带建 `memories`/`memory_confirmations`/`system_config` 三张和 Loop 无关的表)。`AuditStore` 是 `MemoryStore` 的**同构兄弟**(同样的 `better-sqlite3` + 预编译语句 + 错误分类惯例),不是它的子类/包装。**这条选择的代价**:两处几乎一样的"打开连接→建表→准备语句"样板代码,轻微重复,但我认为这个代价小于让 Loop 反向耦合一个 Context 类内部实现的代价。`[?]` 如果指挥官认为"复用" 更重要(比如未来真的要把 memories 和 audit 表放进同一个 `MemoryStore` 实例管理),请指出,这是可以推翻重做的一条。

**2. `reject_threshold` 的来源优先级:`profiles/subscription/config.yaml` 的 `workflow.reject_threshold` 优先,缺失时退到 `system_config.default_reject_threshold`(A2 已建的 `SystemConfig.getDefaultRejectThreshold()`,当前无消费方),两者都缺失时硬编码兜底 `2`。**
核实到的事实:代码里**已经存在两个**和 reject threshold 相关但互相独立、谁都没读过的东西——① `profile/loader.ts` 解析出的 `ProfileConfig.workflow?.reject_threshold`(派工指令原话点的那个);② `context/config.ts` 的 `SystemConfig.getDefaultRejectThreshold()`,读 `system_config` 表的 `default_reject_threshold` key,该文件的注释明确写着"reserved for the Loop layer's escalation threshold — not read by anything in this increment, exposed here for A4 to reuse"——这是 A1/A2 的作者(同样是历史上的 Cypher)特意为 A4 留的一个口子。**我的判断**:`config.yaml` 的值代表"这个 profile 这次部署想用的阈值"(部署期配置,`workflow_runs.reject_threshold` 的"本次运行快照"注释暗示这条值本该在 run 开始时确定一次),`system_config` 的值代表"整个引擎级别的默认兜底"(运行期可通过未来的 CLI 命令改写,不需要重新部署)——两者不是互斥的,是"更具体的覆盖更笼统的"标准配置分层,`startRun()` 的调用方(测试/未来 CLI)负责按这个优先级算出最终传给 `LoopState.rejectThreshold` 的数字,`runner.ts` 本身不做这层优先级判断(它只接收一个已经算好的 `rejectThreshold: number` 参数——保持和 `injectedContext` 一样"图外部注入"的地位)。`[?]` 这条判断需要指挥官确认——如果指挥官认为 `system_config` 那个口子就不该被 A4b 用(比如它其实是给别的东西留的),请指出,那样 A4b 就只读 `config.yaml`,`system_config` 那条继续晾着。

**3. 三张审计表和 checkpoint 表放同一个 SQLite 文件(推荐,不在本增量强制 wiring,只是测试里验证"能不能"):`AuditStore`/`checkpoint.ts` 都接受显式 `dbPath`,不做自动路径解析;但 `runner.test.ts`/跨进程测试/垂直切片测试应该让两者指向同一个临时文件路径,验证 DESIGN §5"SQLite 单文件"字面意图在技术上站得住。**
理由:DESIGN §6 的目标目录树里,`profiles/subscription/` 下**只列了一个** `memory.db` 文件(不是 `memory.db` + `checkpoint.db` + `audit.db` 三个),这是"一个 profile 一个文件装下所有东西"这个意图的直接证据。`better-sqlite3` 对同一文件的多个独立连接(WAL 模式下)是标准支持的场景,`SqliteSaver.setup()` 会把文件切到 WAL 模式,`AuditStore`/`MemoryStore` 各自开的连接不需要额外配置就能在同一个 WAL 文件上正常工作——但这是我的技术判断,不是已经被验证过的事实(A4a spike 没测过"两个不同的 `better-sqlite3.Database` 连接同一个文件,一个建了 LangGraph 的 `checkpoints`/`writes` 表,另一个建业务表"这个具体场景),所以本 PRD 把"共享一个文件"设计成 B4/B6 测试里**顺手验证**的一个断言,而不是单独起一个 spike 阶段——如果真的踩到问题(比如锁竞争导致某个写入超时),批次内就地解决(退回"各自独立文件"也不是大改,`dbPath` 参数已经是各自独立传入的,不存在硬编码耦合)。`MemoryStore`(context 层)本身**不在**这次共享范围内讨论——A4b 不碰它,共享的是 checkpoint 文件和 audit 文件这两者,MemoryStore 是否也共享同一个文件留给未来"profile wiring"增量决定。

**4. checkpoint 跨进程验收升级为真实子进程(不再是 A4a 用的同进程双阶段)。**
A4a PRD §9.1 明确说过"如果指挥官认为'外部一个新调用'必须是字面意义的新 `node` 进程才算数,请直接说,我会照 spike Q4 的模式重做"——派工指令这次明确把这件事定名为"生产化",我理解这就是那个"直接说"。理由补充:A4a 阶段"同进程双阶段"测的是"`checkpoint.ts`/`graph.ts` 有没有意外引入进程内单例",这个问题在 A4b 依然成立、A4a 那条测试继续留着不用动;但 A4b 新增的 `runner.ts`/`audit-store.ts` 引入了一整层新的"业务层怎么找回一个 run"的逻辑(`getRunByThreadId` 这类查询),这层逻辑本身有没有偷偷依赖进程内状态(比如一个模块级缓存),只有真实跨进程才能测出来——继续用同进程双阶段测不出这类问题,所以这条投入子进程测试基础设施的成本在 A4b 是值得付的,和 A4a 阶段"这个成本收益不对等"的结论不冲突(是范围变了,不是判断反悔)。

**5. `approvals.decision` 列在 `ESCALATION_ACK` 行里直接存 `EscalationDecision` 的字面值(`"revise"`/`"force_pass"`/`"abandon"`),不强行映射进 DESIGN §5 注释写的"approved/rejected/override"三个词。**
DESIGN §5 那行注释("decision: approved/rejected/override")很可能是在设计者还没把 `HD` 的三条出边想清楚之前写的概括性文字("override"这个词在 A4a PRD 里已经被解读成"只服务于强升"——但强升的 HD 决定实际有三种,不是一种)。ER 图里 `approvals.decision` 只是一个 `TEXT` 列,没有画 SQL `CHECK` 约束,不是一个必须精确落在三个预设值里的硬边界。我认为诚实地存字面语义值(`revise`/`force_pass`/`abandon`)比强行把三种语义压进 `approved`/`rejected`/`override` 三个可能会造成误读的词更好——但这**明确是我对一处 DESIGN 文字的重新解读**,不是我核实到的既定结论,标出来请指挥官确认这条是否符合原意,如果指挥官坚持要用 `approved`/`rejected`/`override` 这三个词,我需要具体的映射规则(比如"force_pass→override,revise→rejected,abandon→?"),现在给不出第三个词的合理映射,这也是倾向"不强行映射"的一部分理由。

**6. `rejectCount` 判断阈值这一步,不改 `nodes/tester.ts`,只改 `gates.ts` 的 `routeAfterReview`。**
这不是一个有争议的判断,写在这里是为了显式核实一个容易被误解的 LangGraph 执行顺序事实:A4a 的 `nodes/tester.ts` 已经在 `review` 节点自己的返回值里把 `rejectCount` 算好了(`data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount`);LangGraph 的执行模型是"节点函数返回 `Partial<State>` → 合并进图的 state → 再评估这个节点的出边(包括 `addConditionalEdges` 的路由函数)",不是"先路由再合并"——所以 `routeAfterReview` 被调用时读到的 `state.rejectCount` **已经是**这一轮打回后的新值,不需要 `routeAfterReview` 自己再 +1 或者依赖某种"上一轮"的旧值。这条不是我编的,是 LangGraph `StateGraph` 的标准执行语义(`addNode`→`addConditionalEdges` 的组合就是这么工作的,A4a `graph.test.ts` 已有的用例——比如"tester 打回一次后 G2 approve"那条——已经间接验证过这个顺序,只是 A4a 没有专门测过"路由函数读到的是不是最新值"这个具体断言),这里写出来是为了让"为什么不用改 `tester.ts`"这个决定有据可查,不是留白让指挥官选。

### 9.3 `EscalationResumeValue`/`GateLogEntry.decision` 的 TS 类型精确写法——不在事先精确定义范围内

同 A4a §9.3 的性质:`interrupt<GatePayload, EscalationResumeValue>()` 的泛型标注、`GateLogEntry.decision: GateDecision | EscalationDecision` 这个联合类型在实际 `tsc --strict` 下会不会需要额外的类型收窄写法,不在本 PRD 精确定义范围内,build 阶段第一次触及时按实际报错调整,不影响本节描述的字段语义。

---

**有一件事需要指挥官/军师现在就决定,会阻塞开工**:§0.1 的 issue #13 关闭状态——继续沿用需要先 `gh issue reopen 13`,还是改开新 issue。除此之外,§9.2 汇总的 6 条设计决策本 PRD 已经各自给出倾向性结论并写清楚理由,可以先按这些结论开工,指挥官/军师如果对某条有不同意见,随时可以打断修正,不需要等全部确认完才能开始 B0。

## 10. 项目约束检查

- **模型无关?** 是——本增量新增/改动的文件(`escalation.ts`/`audit-store.ts`/`runner.ts`/`gates.ts`/`graph.ts`)不引用任何 provider/model 具体名称,`runner.ts` 通过 `LoopGraphDeps`(`router`/`composer`)间接触达模型调用,和 A4a 已确立的边界一致。
- **跨层无反向依赖?** 是——`audit-store.ts`/`runner.ts` 除了 Loop 层内部文件互相 import 之外,只 import `better-sqlite3`(和 `harness/`/`context/`/`prompt/` 用的是同一个第三方库,不是互相 import 对方模块)、`node:crypto`;`harness/types.ts`/`prompt/schema.ts` 的类型(`InvokeResult`/`Claim` 等)继续只做 type-only import。不存在任何 `src/harness/`/`src/context/`/`src/prompt/` 反过来 import `src/loop/` 的情况(§8 验收标准已列 grep 检查)。
- **角色不硬编码?** 部分是——同 A4a §10 已有的结论:`"coder"`/`"tester"` 字符串在 `structured_claims.actor` 这类地方继续硬编码,这是"内置这一个 coder-tester workflow 的具体节点/字段天然提到这两个角色名"和"persona/schema 查找机制本身是否按名动态查"两件不同的事,后者(答案仍是"不需要改")不受本增量影响。
- **`profiles/apikey/` 不入仓?** 是——本增量不创建/不修改 `profiles/apikey/` 任何文件。
- **引擎代码不含 Helix 人格?** 是——`src/loop/` 下所有新代码零 Helix/companion/私人记忆内容。
- **远控点火(`CLAUDE.md` 铁律)?** 是——§5 测试策略全部走玩具节点/`FakeAdapter`/受控 fixture 子进程/真实但离线的 SQLite 文件;新增的"真实子进程"测试(§5 测试第4点)spawn 的是**本仓自己的测试脚本**(node 调用自己的代码),不是 `claude`/`codex` 真实 CLI,不产生对外部服务的任何调用,同 A4a spike Q4 的性质一致。
