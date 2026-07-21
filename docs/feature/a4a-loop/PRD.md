# PRD — aeloop A4a:Loop 编排(graph + coder/tester 节点 + G1/G2/G3 门 + happy-path 垂直切片)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a3-cli-bridge/PRD.md`(同仓已有 PRD 的写法惯例,分层/批次/验收表述风格照抄)。
> 防幻觉:`[?]` = 我未验证 / 需要指挥官确认,不编造接口/版本/参数。本 PRD 的每条 LangGraph API 行为描述都来自 `docs/feature/a4a-loop/spike-findings.md`(issue #13 前置 spike,真跑命令 + 真实输出样本),不是回忆/假设;没有 spike 直接证据、需要我自己判断的设计决策,都在 §0 单独列出并标注理由,不混进"已证实"的部分。

- **项目**:aeloop(`elishawong/aeloop`,私有仓)
- **分支**:`feature/issue-13-a4a-loop`(spike 已在此分支,未 commit)
- **优先级**:P1
- **状态**:待指挥官确认
- **最后更新**:2026-07-21
- **关联 issue**:[elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13)(A4 Loop 母 issue——本 PRD 只覆盖它的 **A4a 子范围**,理由见 §0.1)· 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§4 门控流程图 / §5 ER 三张审计表 / §6 `src/loop/` 目标布局 / §8 里程碑 A4 / §8.5 方法论警示)+ `docs/feature/a4a-loop/spike-findings.md`(本 issue 的前置 spike,唯一的 LangGraph 行为证据源)

---

## 0. 范围切分:A4a / A4b(军师 + 指挥官已定方向,本节把切分理由写清楚)

**已定的切分**(来自派工指令,不是我自己拍的):
- **A4a**(本 PRD):graph + coder/tester 节点 + G1/G2/G3 门(interrupt/resume,用 spike 证实的真实 checkpoint 机制接)+ happy-path 垂直切片。
- **A4b**(下一轮 PRD):阈值强升 escalation 硬分支 + 三张审计表(`workflow_runs`/`structured_claims`/`approvals`)落盘 + checkpoint 跨进程 resume 接生产化。

**我在这条切分线内部做的进一步细分**(以下是我的判断,不是派工指令直接给的,标出来供确认):DESIGN §4 完整状态机除了"阈值强升"之外,还有几处只有在 Escalation 节点存在时才有意义的分支——我把它们也一并划进 A4b,理由列在下表:

| DESIGN §4 元素 | 判断 | 理由 |
|---|---|---|
| `Draft→G1→Review→G3(批准)→Apply→End` | **A4a 做** | 主干 happy path,派工指令明确要求 |
| `G1 拒绝→反馈回 Draft` | **A4a 做** | G1 门本身的两个分支之一,不做就不是"真的门" |
| `Review 打回→reject_count+=1→G2` | **A4a 做**(计数本身)| `Inc` 这一步不依赖 Escalation 节点,是 Review 打回后无条件发生的,和阈值检查(`T` 判断)是两回事,可以干净拆开 |
| `count>=threshold 硬分支` | **A4b** | 派工指令原文已明确划给 A4b |
| `G2 批准→Fix(=Draft)→Review` | **A4a 做** | G2 门本身除阈值以外的正常分支 |
| `G2 主动升级→Esc` | **A4b**(A4a 只留接口,不接线)| 这条分支的落点是 Escalation 节点,A4a 不建这个节点;A4a 里如果外部调用者传了这个决策值,会显式抛 `UnhandledGateDecisionError`(fail loud),不是悄悄吞掉或悄悄接上一个还不存在的分支 |
| `G3 拒绝→新问题→Draft` | **A4a 做** | G3 门本身的两个分支之一 |
| `Escalation` 节点 + `HD` 人工决定 + `Cancel` 终态 | **A4b** | 三者只服务于"进了升级"这一件事,A4a 完全不会走到这里,提前建等于建一个测不到的死代码 |
| `Apply`("写文件到工作区,不自动 git commit/push") | **A4a 做,但降级**(见 §2 非目标)| 真的落盘改文件是独立的、有相当复杂度的 diff/patch 应用问题,和"LangGraph 编排本身"是两个不同关注点,A4a 的 Apply 节点只做状态终结,不接文件系统写入 |

**结论**:A4a 交付的是 DESIGN §4 状态机里**除 Escalation 子树外的全部**,包括 G1/G2/G3 三个门的正常分支和 Draft↔Review 之间的完整往返(不是只做"从没打回过"这一条最简路径)。垂直切片(e2e 测试)本身只跑 happy path(一次通过,不触发打回),但**图结构和 G2/reject 分支必须真实存在并有单独测试覆盖**——这是"happy-path 垂直切片"和"图只支持 happy path"两件不同的事,后者不是本 PRD 的意图。

### 0.1 为什么不另开子 issue

沿用 `feature/issue-13-a4a-loop` 这个已经在用的分支名(指挥官/军师定下 spike 阶段就是这个名字),不新开 issue——issue #13 标题"A4 Loop"本身就是母范围,本 PRD 是它在这一批要交付的子集,A4b 会是同一个 issue 下的后续 PRD/批次(如同 A0+A1 共享一个 issue 的先例)。issue #13 目前的 body 是"待 /spec 拆批次"的粗描述(创建时就写明),不需要为了这次拆分再开一个新 issue 号——如果指挥官希望 A4a/A4b 分别有独立 issue 便于跟踪,请直接说,我可以现场补开。

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A0-A3 已经把 `Prompt ⊂ Context ⊂ Harness` 三层建完并验证过垂直切片,但**没有任何东西真正驱动"coder 写一版 → 人审 → tester 审一版 → 人签字"这个循环本身**——`ProviderRouter.route("coder")`/`.route("tester")` 能拿到真实 adapter,`SchemaValidator` 能校验一次调用的输出,但"调完 coder 之后该不该送给 tester""tester 打回了要不要再让 coder 改一次""改到第几次该找人"这些编排逻辑完全不存在。DESIGN §4 画的门控状态机(Draft→G1→Review→G2/G3)目前只是一张图,没有代码。同时 spike 已经证明 LangGraph 的 `interrupt()`/`Command({resume})`/`SqliteSaver` 机制在本仓本栈上可用,但**只验证了最简单的单门场景**(一个 G1,没有条件边、没有循环回边、没有 G2/G3),`addConditionalEdges`(DESIGN §4 状态机的核心机制之一)完全没被 spike 碰过。
- **给谁用**:直接消费方是本增量自己的垂直切片测试和后续 A4b(会在 A4a 建好的图上加阈值分支 + 审计持久化)。再往后是 A5(CLI/TUI 层,给这套图接一个真人可用的批准界面)和最终 Elisha 本人的实际 dogfood 循环。
- **一句话方案**:按 spike 证实的 LangGraph API 形状建 `src/loop/`——`nodes/coder.ts`/`nodes/tester.ts` 复用 A2 的 `ProviderRouter`/A1 的 `PromptComposer`/A2 的 `SchemaValidator`(不重新发明模型调用);`gates.ts` 用 spike Q3 证实的 `interrupt()`/`Command({resume})` 模式实现 G1/G2/G3 三个门,每个门都能真的暂停、真的能从外部一次新的函数调用(不依赖调用方保留任何闭包内状态)恢复;`graph.ts` 用 `addConditionalEdges`(spike 未验证,A4a 第一个批次就要把这个机制的风险清零)把 Draft/G1/Review/G2/G3/Apply 六个节点按 DESIGN §4(去掉 Escalation 子树)接成完整状态机;`checkpoint.ts` 按 spike Q4 证实的 `SqliteSaver.fromConnString(path)` 模式接线;最后用一条硬性垂直切片证明"真实 Context→Prompt 组装的 prompt → 真实 `buildAdapterRegistry` 构造的 cli-bridge adapter(受控 fixture 子进程,不打真实 CLI)→ 真实图 → 真实 G1/G2/G3 interrupt/resume → happy path 走到 Apply"这条链路整个接通,不是若干孤立绿测试拼出来的。

## 2. 目标 / 非目标

**目标**:
- `src/loop/types.ts`:`LoopState`(LangGraph `Annotation.Root` 状态形状)、`LoopNodeName`、`GateType`、`GateDecision`、`GatePayload`、`GateResumeValue`、`GateLogEntry` 等类型契约。
- `src/loop/errors.ts`:`UnhandledGateDecisionError`(G2 收到"主动升级"决策但 A4a 没有路由目标时抛出,fail loud)。
- `src/loop/workflow-def.ts`:节点名/门类型的单一命名来源(`LOOP_NODES`/`GATE_TYPES` 常量)+ 一份描述性的 `CODER_TESTER_LOOP_DEFINITION`(DESIGN §6 "WorkflowDefinition Registry"概念在 A4a 的落地,范围见 §5 的详细说明和降级理由)。
- `src/loop/nodes/coder.ts` / `src/loop/nodes/tester.ts`:draft/review 节点工厂函数,复用真实 `ProviderRouter`+`PromptComposer`+`SchemaValidator`,不新造任何模型调用路径。
- `src/loop/gates.ts`:G1/G2/G3 门节点工厂(共享 `interrupt()` 机制)+ 三个路由函数(`routeAfterG1`/`routeAfterReview`/`routeAfterG2`/`routeAfterG3`)。
- `src/loop/checkpoint.ts`:`createSqliteCheckpointer(dbPath)`,按 spike Q4 证实的 `SqliteSaver.fromConnString()` 模式接线。
- `src/loop/graph.ts`:`buildLoopGraph()`(纯图结构,不含 checkpointer)+ `compileLoopGraph()`(接 checkpointer,产出可 `invoke`/`getState` 的编译图),把上面所有节点/门按 DESIGN §4(去 Escalation 子树)接成完整状态机,含 `addConditionalEdges` 的首次验证。
- **硬性垂直切片**:一条端到端测试证明"真实 `MemoryStore`+`ContextInjector`+`PromptComposer` → 真实 `buildAdapterRegistry`(cli-bridge adapter,受控 fixture 子进程)→ 真实 `ProviderRouter` → 真实编译图(真实 `SqliteSaver` checkpointer)→ G1 interrupt+resume(approve)→ tester 通过 → G3 interrupt+resume(approve)→ Apply"整条happy path链路接通。

**非目标(明确不做,留给 A4b/A5 或后续增量)**:
- ❌ **阈值强升硬分支**(`reject_count >= threshold` 的条件路由 + Escalation 节点 + 人工决定 + Cancel 终态)——§0 已定,A4b。`reject_count` 本身在 A4a 会递增(Review 打回时),但没有任何代码读它去做路由决策。
- ❌ **G2"主动升级"分支的实际路由**——A4a 的 `GateResumeValue.decision` 类型技术上允许外部传非 `"approved"`/`"rejected"` 之外的值吗?**不允许**——A4a 的 `GateDecision` 就只有 `"approved" | "rejected"` 两个值(DESIGN §5 `approvals.decision` 枚举的子集,去掉只服务于强升的 `"override"`)。真正的问题是:G2 收到 `"rejected"` 时该去哪?DESIGN 画的 G2 唯二两条出边是"批准→Fix"和"主动升级→Esc",没有第三条"拒绝→哪里"。A4a 对这个 DESIGN 未完全定义的角落做了一个明确判断:**G2 只处理 `"approved"`**,收到 `"rejected"` 时 `routeAfterG2` 抛 `UnhandledGateDecisionError`,不是悄悄路由到某个我自己发明的分支。这条本身就是"决策未完全定义,我做了判断"的例子,标 `[?]` 供确认(见 §9)。
- ❌ **三张审计表持久化**(`workflow_runs`/`structured_claims`/`approvals` 建表 + 写入)——A4b。A4a 的 `GateLogEntry`(§4)是这三张表(尤其 `approvals`)将来落盘时的**内存态影子**,字段命名故意贴近 `approvals` 表的列名,方便 A4b 直接消费,但 A4a 本身**不建表、不碰任何 SQLite schema**。
- ❌ **checkpoint 跨进程 resume 生产化**(把 `langgraph_thread_id` 存进 `workflow_runs` 表、真实场景下"关机重启后从哪个门继续"这套完整流程)——A4b。A4a 只交付 `checkpoint.ts` 本身 + 一条证明"非闭包内状态"的测试(§6 B4,同进程内构造两个独立的编译图+checkpointer 实例,而不是 spike Q4 那种真实起两个 `node` 子进程——理由见 §9.1)。
- ❌ **彩色 TUI / y/n 批准界面**——A5。A4a 的 G1/G2/G3 门由测试代码直接构造 `Command({resume: {...}})` 注入决策,不存在任何人类可交互的界面。
- ❌ **真实 coder/tester 模型逻辑**——A4a 的节点直接复用 A2/A3 已经建好的 `ProviderRouter`+adapter+`SchemaValidator`,不新增任何"怎么让模型写代码/审代码写得更好"的逻辑;persona 文本(`profiles/subscription/personas/{coder,tester}.md`)沿用 A1 现有版本,不改。
- ❌ **真的把 diff 落盘到工作区文件系统**(DESIGN §3 sequence 的"写文件到工作区")——`Apply` 节点只做状态终结(把 `state.coderOutput`/G3 决定标记为"已完成",不再往下走),不调用任何文件系统写入 API。真正把一份 unified diff 应用到工作区文件是独立的、有相当复杂度的关注点(patch 库选型、冲突处理、要不要走真实 `git apply`),和"LangGraph 编排机制本身"是两个不同维度的工作,不属于本增量;§0 表格已把这条列为"A4a 做但降级"。
- ❌ **`WorkflowDefinition` 的运行时动态加载/JSON 文件驱动编译**——见 §5 `workflow-def.ts` 任务描述的详细说明,`graph.ts` 的实际图结构由类型安全的手写链式调用(`addNode().addEdge()...`)构成,不是运行时解释一份 JSON;`workflows/coder-tester-loop.json`(DESIGN §6 提到的文件)本 PRD **不创建**,理由和影响见 §5/§9。
- ❌ **`config.yaml` 的 `reject_threshold` 被任何代码读取**——A4a 的图不做阈值判断,这个已有配置字段(`profiles/subscription/config.yaml` 的 `workflow.reject_threshold: 2`)继续保持"存在但没人读"的状态,直到 A4b。

## 3. 用户故事

- 作为 **A4a 自己的垂直切片测试**,我想要证明一条真实 prompt 从组装到 coder 产出 diff、经人批准送到 tester、tester 通过、经人最终签字、到状态终结,全部通过真实的 `ProviderRouter`+adapter+`SchemaValidator`+LangGraph 图,而不是靠几个互不相干的单测拼出"看起来像是接通了"的错觉。
- 作为 **未来的 A4b 开发者**,我想要 `graph.ts`/`gates.ts` 已经把 G1/G2/G3 的正常分支、`reject_count` 递增点这些和"阈值强升"无关的部分建好,这样 A4b 只需要在 `routeAfterReview`(或紧邻它的位置)插入一条阈值判断的条件边 + 建 `Escalation` 节点,不需要重新设计整个图的骨架。
- 作为 **指挥官**,我想要看到一条测试真的把编译好的图跑到 G1 中断、丢掉那个编译图对象、用一个全新构造的编译图+checkpointer 实例(同一个 `thread_id`、同一个 sqlite 文件路径)续跑到底——证明 resume 靠的是磁盘上的 checkpoint,不是 JS 进程里还留着的某个闭包变量。
- 作为 **指挥官**,我想要确认这个增量不会在自动化测试里打真实 `claude`/`codex` CLI 消耗订阅额度——测试策略延续 A3 已经定好的"cli-bridge adapter 真 spawn,但目标是受控 fixture 脚本"模式。

## 4. 数据模型

本增量**不建表、不碰 SQLite**——`workflow_runs`/`structured_claims`/`approvals` 三张审计表仍是 A4b 的事(和 A2/A3 §4 的"无状态"边界延续)。唯一的"数据形状"是 LangGraph 的内存态 + checkpoint 态:

```typescript
// src/loop/types.ts —— 建议形状,build 阶段字段名可微调,但下面每个字段的语义/存在性是 PRD 硬约束
const LoopState = Annotation.Root({
  task: Annotation<string>(),                              // 原始任务描述,整个运行期间不变
  feedback: Annotation<string | undefined>(),               // 下一次 draft 节点要看到的反馈(来自 G1 拒绝理由 / G2 批准时携带的 tester issues / G3 拒绝理由),draft 节点消费后清空,不无限累积
  injectedContext: Annotation<ContextInjectionResult>(),    // ContextInjector.inject() 的结果,在图外由调用方注入一次(见 §5"为什么不在节点里重复调用 ContextInjector"),整个运行期间不变
  coderOutput: Annotation<CoderOutput | undefined>(),       // 最近一次 draft 节点产出
  coderResult: Annotation<InvokeResult | undefined>(),      // 同上,原始 InvokeResult(含 provider/model/toolExecChecked)
  testerOutput: Annotation<TesterOutput | undefined>(),     // 最近一次 review 节点产出
  testerResult: Annotation<InvokeResult | undefined>(),
  rejectCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // Review 打回时递增;A4a 没有代码读它做路由决策(§0/§2 非目标),纯粹是"Inc"这一步先做出来
  g1Decision: Annotation<GateDecision | undefined>(),
  g2Decision: Annotation<GateDecision | undefined>(),
  g3Decision: Annotation<GateDecision | undefined>(),
  gateLog: Annotation<GateLogEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }), // 见下方说明
  applied: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});

interface GateLogEntry {
  gate: GateType;            // "G1_SEND_TO_TESTER" | "G2_SEND_TO_FIX" | "G3_FINAL_MERGE"(DESIGN §5 approvals.gate_type 的 A4a 子集,不含 A4b 才有的 "ESCALATION_ACK")
  decision: GateDecision;    // "approved" | "rejected"
  reasoningText?: string;    // 人类在 resume 时携带的理由文本
  decidedAt: string;         // ISO 时间戳
}
```

**`gateLog` 是刻意设计的 A4b 前传**:字段命名贴近 DESIGN §5 `approvals` 表的列名(`gate_type`/`decision`/`reasoning_text`/`decided_at`),这样 A4b 加审计持久化时,直接把 `state.gateLog` 的每一项写进 `approvals` 表就行,不需要重新设计"图执行期间要记住哪些信息"这层。**准确的表述(Zorro R1 M1 修正)**:`gateLog` 是 `LoopState` 的 Annotation channel,真实图配 `SqliteSaver` 编译时,LangGraph 会把**整份 state(含 gateLog)**序列化进它自己的 checkpoint 表(`checkpoints`/`writes`)——不是"只在内存、进程退出即消失"。A4a 和 A4b 的真实边界是:A4a 从不把 `gateLog` 的条目写进 A4b 才建的业务审计表 `approvals`;LangGraph 自己的 checkpoint 持久化和 aeloop 自己的 `approvals` 持久化是两件独立的事,只有后者是 A4b 的工作。这是一个明确的设计选择,不是遗漏,标出来供确认(§9)。

LangGraph 自己的 checkpoint 表(`checkpoints`/`writes`,`SqliteSaver.setup()` 自动建)和上面这套 aeloop 业务 state 是两回事——spike-findings.md §4 已经证实这两套表完全独立:前者存"图执行到哪一步、state 快照是什么"(LangGraph 自己管,A4a 直接用),后者是 aeloop 自己的业务审计语义(A4b 才建)。

## 5. 逐文件任务清单

### 类型 / 命名单一来源

- `src/loop/types.ts`(**新文件**):
  - `LoopState`(`Annotation.Root`,见 §4)+ 导出的推导类型 `LoopStateType`(`typeof LoopState.State`,或等价写法——具体 LangGraph `Annotation` 的 TS 推导语法以 build 阶段实测为准,spike Q2/Q3 用的是 `Annotation.Root({...})` 后直接把整个 `State` 对象传给 `new StateGraph(State)`,没有单独导出过一个"State 的 TS 类型"给节点函数签名用,这是 A4a 需要自己摸出来的用法,不在 spike 5 个 Q 的验证范围内,build 阶段第一件事确认)。
  - `LoopNodeName`:字面量联合类型,复用 `workflow-def.ts` 的 `LOOP_NODES` 常量值 + LangGraph 的 `"__start__"`/`"__end__"`(spike Q5 的 `Command` 例子里 `Nodes` 泛型联合包含了 `"__start__"`,`"__end__"` 是否也需要在联合里、还是 LangGraph 会自动处理,build 阶段第一次 `tsc` 报错时才能确认——这条不是我编的,是诚实标注"spike 没测过这个边界")。这是**全 `src/loop/` 模块唯一定义 `LoopNodeName` 的地方**,`graph.ts`/`gates.ts` 里任何 `new Command<...>({resume: ...})` 都从这里 import 第三个泛型参数,不各自重复写字面量联合(spike-findings.md Q5"对 A4a PRD 的影响"那段的直接落地)。
  - `GateType = "G1_SEND_TO_TESTER" | "G2_SEND_TO_FIX" | "G3_FINAL_MERGE"`(DESIGN §5 `approvals.gate_type` 枚举的 A4a 子集,不含 A4b 才建的 `"ESCALATION_ACK"`)。
  - `GateDecision = "approved" | "rejected"`(DESIGN §5 `approvals.decision` 枚举的子集,不含 A4b 才用的 `"override"`)。
  - `GatePayload`:`interrupt()` 调用传出去的 payload 形状,`{ gate: GateType; question: string; diffRef?: string; issues?: string[] }`(`diffRef` 供 G1/G3 用来带上待审的 diff 文本,`issues` 供 G2 带上 tester 报告的问题列表——命名 `diffRef` 而不是 `diff` 是刻意对齐 DESIGN §5 `approvals.diff_ref` 的列名"哈希/路径,不内联大文本",但 A4a 阶段没有任何持久化,这里实际内联的就是 diff 全文字符串本身,`[?]` 是否要在 A4a 就做"存哈希/路径而不是全文"这层——标出来,倾向于**不做**(A4a 完全在内存里跑,没有 diff 需要跨进程传递的场景,A4b 真正持久化时再决定要不要做这层间接)。
  - `GateResumeValue`:`Command({resume: ...})` 里 `resume` 的形状,`{ decision: GateDecision; reasoningText?: string }`。
  - `LOOP_NODES`/`GATE_TYPES` 挪到 `workflow-def.ts`(下方),`types.ts` 只 import 它们的类型,不重复定义常量。

- `src/loop/errors.ts`(**新文件**):
  - `UnhandledGateDecisionError extends Error`:构造函数 `(gate: GateType, decision: string)`,message 说明"A4a 没有为这个 gate/decision 组合建路由目标,等 A4b"。`routeAfterG2` 在收到非 `"approved"` 的决策时抛这个(§2 非目标已说明为什么)。

### `workflow-def.ts`(WorkflowDefinition 概念在 A4a 的降级落地——请核对这个降级)

- `src/loop/workflow-def.ts`(**新文件**):
  - `LOOP_NODES`(`as const` 对象,六个真实节点:`draft`/`g1`/`review`/`g2`/`g3`/`apply`)+ `GATE_TYPES`(`as const`,三个门类型)——这是 `graph.ts`/`gates.ts`/`nodes/*.ts` 里所有节点名/门类型字符串字面量的**唯一来源**,避免像 spike 脚本那样在多处手写同一个字符串。
  - `CODER_TESTER_LOOP_DEFINITION`:一份**描述性**(不是可执行的)数据结构,把 `LOOP_NODES` 的节点集合 + 每条边(含哪些是条件边)列出来,大致形状:
    ```typescript
    export const CODER_TESTER_LOOP_DEFINITION = {
      id: "coder-tester-loop",
      nodes: Object.values(LOOP_NODES),
      edges: [
        { from: "__start__", to: LOOP_NODES.draft },
        { from: LOOP_NODES.draft, to: LOOP_NODES.g1 },
        { from: LOOP_NODES.g1, to: [LOOP_NODES.review, LOOP_NODES.draft], conditional: true },
        { from: LOOP_NODES.review, to: [LOOP_NODES.g3, LOOP_NODES.g2], conditional: true },
        { from: LOOP_NODES.g2, to: [LOOP_NODES.draft], conditional: true },
        { from: LOOP_NODES.g3, to: ["apply", LOOP_NODES.draft], conditional: true },
        { from: LOOP_NODES.apply, to: "__end__" },
      ],
    } as const;
    ```
  - **这是对 DESIGN §6"graph.ts 编译自 WorkflowDefinition"这条设计的一次降级,必须请军师/指挥官核对是否接受**:spike-findings.md 建议2 明确指出"从 JSON/YAML 动态生成 StateGraph"这件事的可行性完全没被验证过,而 LangGraph 的 TS API(spike Q2/Q3/Q4 三个脚本全部如此)在类型安全的前提下用的是**链式手写调用**(`new StateGraph(State).addNode("draft", draftNode).addEdge(...)`),不是"读一个数组循环调用 `addNode`"这种运行时动态结构——图的节点/边的**类型**(用于 `Annotation` 的 state 形状推导、`Command` 的 `Nodes` 泛型)在 LangGraph 的 TS 类型系统里本来就是编译期字面量,硬要做成运行时从数据结构生成,要么会失去这层类型安全(退回 `any`/`string`),要么需要相当复杂的 TS 类型体操(远超一个 PRD 批次该做的探索)。A4a 的选择是:**`CODER_TESTER_LOOP_DEFINITION` 是"人读的文档 + 单一命名来源",不是"graph.ts 运行时读取并解释的配置"**——`graph.ts` 的实际 `addNode`/`addEdge`/`addConditionalEdges` 调用是手写的,但每处用到的字符串字面量都从 `LOOP_NODES`/`GATE_TYPES` import,不会出现"文档一份、代码另一份、两边可能不同步"的问题(TS 编译期就会因为 import 不存在的属性而报错)。`workflows/coder-tester-loop.json`(DESIGN §6 提到的文件)本 PRD **不创建**——一份"看起来被读取、实际没人读"的 JSON 文件比不存在更容易造成误导,等真正出现第二个 workflow 需要动态加载时(DESIGN §1.7 自己也说"等 2-3 个真实 workflow 需求再硬化"),再决定要不要把 `CODER_TESTER_LOOP_DEFINITION` 落成一份运行时读取的 JSON。**这条判断如果不符合指挥官对 DESIGN §6 那句话的原意,请直接改,我不会在后续实现里悄悄按自己的理解做。**

### `nodes/coder.ts` / `nodes/tester.ts`

- `src/loop/nodes/coder.ts`(**新文件**):
  - `createDraftNode(deps: { router: ProviderRouter; composer: PromptComposer }): (state: LoopStateType) => Promise<Partial<LoopStateType>>`。
  - 节点体:① 用 `state.feedback`(可能是 `undefined`)拼出这次要用的 task 文本——`state.feedback` 存在时,`task = state.task + "\n\n---\n\nFeedback from the previous round:\n" + state.feedback`,不存在时就是原始 `state.task`(**这是复用 `SchemaValidator.buildRetryPrompt()` 已经确立的"追加,不替换"惯例**,不是我发明的新模式,同一份代码库里的一致做法);② `deps.composer.compose("coder", state.injectedContext, task)` 拿到 prompt;③ `deps.router.route("coder")` 拿到 adapter;④ `new SchemaValidator().validate({ schema: CoderOutput, request: { role: "coder", prompt }, invoke: (req) => adapter.invoke(req) })`(`SchemaValidator` 无构造依赖,直接 `new`,和 `harness-cli.e2e.test.ts` 里的用法一致,不用额外注入);⑤ 返回 `{ coderOutput: data, coderResult: result, feedback: undefined }`(**消费完 feedback 就清空**,防止下一轮如果又走到这个节点、`state.feedback` 还没被新的门更新时,把同一条反馈重复拼两次)。
  - `SchemaValidationError`(A2 已有的类型)在这里**不额外捕获**——节点函数抛出的异常会让 `compiled.invoke()` 整体抛出,这是期望行为(coder 两次都产出不合规输出,是需要让调用方知道的失败,不是该被 Loop 层悄悄吞掉的情况)。
- `src/loop/nodes/tester.ts`(**新文件**):
  - `createReviewNode(deps: { router: ProviderRouter; composer: PromptComposer }): (state: LoopStateType) => Promise<Partial<LoopStateType>>`。
  - 节点体:① 防御性检查 `state.coderOutput` 存在(理论上图的边保证了 review 节点只会在 draft 之后被调用,但节点函数不应该信任"图结构保证了这一点"这种隐式假设,缺失时抛一个明确的 `Error`,不是 `undefined.diff` 式的裸崩溃);② 组 task 文本:把原始任务 + coder 的 diff + coder 的 claims 都喂给 tester(DESIGN §3 sequence "invoke(tester, diff+ctx, schema)" 的字面落地,顺带把 claims 也给 tester 是因为 tester persona 的 house rule 明确写了"Verify claims instead of just reading and agreeing with them"——没有 claims 列表 tester 没法针对性核实);③ 同上调用 `composer`/`router`/`SchemaValidator`,`schema: TesterOutput`;④ 返回 `{ testerOutput: data, testerResult: result, rejectCount: data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount }`(DESIGN §4 的"Inc"步骤,在这里无条件发生,不依赖任何阈值判断——§0 已说明这条本来就该在 A4a 做)。

### `gates.ts`(G1/G2/G3)

- `src/loop/gates.ts`(**新文件**):
  - 一个共享的内部工厂 `createGateNode(gate: GateType, buildPayload: (state) => Omit<GatePayload, "gate">, deriveFeedback: (state, resume: GateResumeValue) => string | undefined)`,返回一个节点函数,函数体:
    1. `const payload: GatePayload = { gate, ...buildPayload(state) }`(纯函数,读 state 不产生副作用——**这一步在 resume 时会重跑一遍**,spike-findings.md Q3"一个不算 bug 但影响写 nodes/ 代码的行为"那段的直接应用,所以这里绝不能有"发一次通知""写一次日志"这类不幂等操作)。
    2. `const resume = interrupt(payload) as GateResumeValue`(第一次调用在这里真正暂停;resume 时这行直接返回外部传入的 `Command({resume})` 的值,不再暂停——spike Q3 已验证的行为)。
    3. `interrupt()` **之后**才允许有副作用性质的操作:构造 `GateLogEntry`(`decidedAt: new Date().toISOString()`)。
    4. 返回该门专属的决策字段(`g1Decision`/`g2Decision`/`g3Decision`,由调用 `createGateNode` 的三个具体门各自指定,不是这个共享工厂自己猜)+ `feedback: deriveFeedback(state, resume)` + `gateLog: [entry]`(`reducer` 是 `concat`,累加不覆盖)。
  - 三个具体门:
    - `createG1Node()` = `createGateNode("G1_SEND_TO_TESTER", (state) => ({ diffRef: state.coderOutput?.diff, question: "approve sending this diff to the tester?" }), (_state, resume) => resume.reasoningText)`(G1 拒绝时的反馈就是人类当场给的理由,没有更多上下文可加)。
    - `createG2Node()` = `createGateNode("G2_SEND_TO_FIX", (state) => ({ issues: state.testerOutput?.issues, question: "approve sending the tester's findings back to the coder for a fix?" }), (state, resume) => [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n"))`(G2 批准后 coder 真正需要看到的反馈**主要是 tester 的 issues 列表**,人类的 `reasoningText` 是补充,不是替代——这条如果只用 `resume.reasoningText`,coder 会完全看不到 tester 到底说了什么,等于门批准了但反馈没跟着走,是一个真实的功能缺口,不是我过度设计)。
    - `createG3Node()` = `createGateNode("G3_FINAL_MERGE", (state) => ({ diffRef: state.coderOutput?.diff, question: "final sign-off: apply this diff?" }), (_state, resume) => resume.reasoningText)`。
  - 三个路由函数(供 `graph.ts` 的 `addConditionalEdges` 用):
    - `routeAfterG1(state): "review" | "draft"` —— `"approved"` → `"review"`;`"rejected"` → `"draft"`;其它值理论上类型系统已经排除,但运行时仍做一个 `default: throw` 兜底(不静默)。
    - `routeAfterReview(state): "g3" | "g2"` —— `state.testerOutput.verdict === "pass"` → `"g3"`;`"reject"` → `"g2"`。
    - `routeAfterG2(state): "draft"` —— `state.g2Decision === "approved"` → `"draft"`;任何其它值(包括 `"rejected"`,§2 非目标已解释为什么 A4a 故意没给它一个路由目标)→ 抛 `UnhandledGateDecisionError("G2_SEND_TO_FIX", state.g2Decision ?? "undefined")`。
    - `routeAfterG3(state): "apply" | "draft"` —— `"approved"` → `"apply"`;`"rejected"` → `"draft"`。

### `checkpoint.ts`

- `src/loop/checkpoint.ts`(**新文件**):
  - `createSqliteCheckpointer(dbPath: string): SqliteSaver` —— 就是 `SqliteSaver.fromConnString(dbPath)`(spike Q4 证实的用法),薄封装的唯一理由是让 `graph.ts`/测试代码统一从这一个函数拿 checkpointer,不用各处重复 import `@langchain/langgraph-checkpoint-sqlite`。
  - **不做**:`MemorySaver` 的等价封装——A4a 的图默认总是配 `SqliteSaver`(哪怕测试场景下指向一个临时文件),不提供"纯内存、进程退出就丢"的选项,因为"能不能被外部恢复"是 G1/G2/G3 门存在的意义之一(验收标准 §8 明确要求),给一个默认丢状态的选项容易被后续开发者不小心用错。

### `graph.ts`

- `src/loop/graph.ts`(**新文件**):
  - `buildLoopGraph(deps: { router: ProviderRouter; composer: PromptComposer }): StateGraph<...>`(未编译的图,纯结构):
    - `addNode(LOOP_NODES.draft, createDraftNode(deps))`
    - `addNode(LOOP_NODES.g1, createG1Node())`
    - `addNode(LOOP_NODES.review, createReviewNode(deps))`
    - `addNode(LOOP_NODES.g2, createG2Node())`
    - `addNode(LOOP_NODES.g3, createG3Node())`
    - `addNode(LOOP_NODES.apply, applyNode)`(见下方,graph.ts 内部一个不导出的小函数,不单独建 `nodes/apply.ts`——DESIGN §6 文件列表也没有列这个文件,和 §2 非目标"Apply 只做状态终结"对应,逻辑简单到不值得单独一个文件)
    - `addEdge(START, LOOP_NODES.draft)`
    - `addEdge(LOOP_NODES.draft, LOOP_NODES.g1)`
    - `addConditionalEdges(LOOP_NODES.g1, routeAfterG1)`
    - `addEdge(LOOP_NODES.g1, LOOP_NODES.review)` **不是**一条普通边——依赖上面 `addConditionalEdges` 的目标集合已经覆盖 `{review, draft}`,这里不重复加 `addEdge`(初次写码时容易犯的错,PRD 提前提醒)。
    - `addConditionalEdges(LOOP_NODES.review, routeAfterReview)`
    - `addConditionalEdges(LOOP_NODES.g2, routeAfterG2)`
    - `addConditionalEdges(LOOP_NODES.g3, routeAfterG3)`
    - `addEdge(LOOP_NODES.apply, END)`
  - `applyNode(state): Partial<LoopStateType>` —— 内部函数,`return { applied: true }`,不读写文件系统(§2 非目标)。
  - `compileLoopGraph(graph, checkpointer): CompiledGraph` —— `graph.compile({ checkpointer })`,薄封装,唯一理由是所有调用点(测试 + 未来 A5)统一走这一个函数,不各自重复 `.compile({...})` 调用。
  - **实现顺序上的硬性要求(呼应 spike 建议3)**:`addConditionalEdges` 是本 PRD 唯一一处 spike 完全没验证过的 LangGraph 机制(spike 5 个 Q 全部是线性图或单一 `interrupt`,没有一个用了条件边)。§6 批次拆解把"先用玩具节点验证 `addConditionalEdges` 能不能正确按返回值路由"放在最早的批次(B3 开头),不是留到最后才发现这个机制本身有问题。

### 依赖 / 打包

- `package.json`:**本增量不新增依赖**——`@langchain/langgraph@1.4.8`/`@langchain/langgraph-checkpoint-sqlite@1.0.3` 已经在 spike 阶段装好(`package.json`/`pnpm-lock.yaml` 已有对应改动,和本 PRD 一起 commit,见 PRD 头部说明)。

### 测试(与逐文件任务一一对应)

**测试策略(三层边界,延续 A2/A3 已确立的"真实但受控"哲学)**:
1. `gates.ts`/`graph.ts` 自己的图结构/门控测试——**玩具节点**(镜像 spike Q2/Q3 的手法:节点直接返回假数据,不调用真实 adapter),`MemorySaver` 作为 checkpointer(不需要真磁盘,只是验证图的路由逻辑本身对不对)。这一层专门用来把 `addConditionalEdges` 的风险清零,以及验证 G1 拒绝回 draft / G2 approve 回 draft / G3 拒绝回 draft 这些回边真的存在且被走到。
2. `nodes/coder.ts`/`nodes/tester.ts` 的单测——不需要真实子进程,用一个手写的 `FakeAdapter`(镜像 A2 `harness.e2e.test.ts` 已经用过的手法:`implements ModelAdapter`,`invoke()` 直接返回预置的 `InvokeResult`)+ 真实 `ProviderRouter`(用一个把 `"coder"`/`"tester"` 绑定到这个 `FakeAdapter` 的 `AdapterRegistry`)+ 真实 `PromptComposer`。这一层验证"节点函数正确调用了 composer/router/validator,正确处理了 feedback 拼接和 rejectCount 递增",不需要真的 spawn 任何东西。
3. `checkpoint.ts` 的"非闭包内状态"测试——用 B3 建好的**真实** `graph.ts`(不是玩具图)+ 上面的 `FakeAdapter` 节点依赖 + 真实 `SqliteSaver`(指向 `fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-loop-"))` 建的临时目录里的一个真实文件)。第一阶段:构造一个编译图实例,`invoke()` 到 G1 中断,记录 `thread_id`;**显式丢弃这个编译图对象和它的 checkpointer 实例**(不保留任何引用);第二阶段:重新 `createSqliteCheckpointer(同一个db路径)` + 重新 `compileLoopGraph()` 构造一个**全新**的编译图对象,用同一个 `thread_id` 的 `threadConfig` 调 `getState()`(断言能读到和第一阶段一致的 pending interrupt)+ `Command({resume})` 续跑到底。这证明的是"resume 靠磁盘上的 checkpoint,不是 JS 进程里某个变量还活着"——不需要像 spike Q4 那样真的起两个 `node` 子进程(理由见 §9.1)。
4. 垂直切片 e2e——真实 `MemoryStore`/`ContextInjector`/`PromptComposer`/`buildAdapterRegistry`/`ProviderRouter`/真实 cli-bridge adapter(受控 fixture 子进程)/真实 `SchemaValidator`/真实图/真实 `SqliteSaver`。**这一层不追加"非闭包内状态"的重复验证**(第3层已经证明过这个机制,e2e 层的价值在于证明"这套图接的是真实 harness 全家桶,不是玩具/FakeAdapter"),用一个编译图实例从头跑到 Apply 即可。

- `src/loop/__tests__/types.test.ts`:轻量——`LoopState` 的 `Annotation.Root` 能被 `new StateGraph()` 接受(纯粹的类型/构造 smoke test,不是业务逻辑测试)。
- `src/loop/__tests__/workflow-def.test.ts`:`CODER_TESTER_LOOP_DEFINITION.nodes` 和 `LOOP_NODES` 的所有值一一对应(防止两者手动加节点时漏改一处)。
- `src/loop/nodes/__tests__/coder.test.ts`:①正常路径(无 feedback)→ `composer.compose` 收到的 task 就是原始 task,`coderOutput`/`coderResult` 被正确设置;② 有 `state.feedback` → task 文本里包含"Feedback from the previous round"+ 原 feedback 文本;③ 返回值里 `feedback` 被清空为 `undefined`;④ `FakeAdapter` 返回不合 `CoderOutput` schema 的内容两次 → `SchemaValidationError` 从节点函数抛出(不是被吞掉)。
- `src/loop/nodes/__tests__/tester.test.ts`:①正常路径,task 文本里包含 diff 和 claims;② `testerOutput.verdict === "reject"` → 返回的 `rejectCount` 是 `state.rejectCount + 1`;③ `verdict === "pass"` → `rejectCount` 不变;④ 缺 `state.coderOutput` → 抛明确的 `Error`(不是裸 `undefined.diff`)。
- `src/loop/__tests__/gates.test.ts`:①每个门(G1/G2/G3)在 `interrupt()` 之后不再重复暂停,`Command({resume})` 能正确续跑(镜像 spike Q3);② G1/G3 拒绝 → 状态里对应 `gN Decision` 字段是 `"rejected"`;③ G2 approve → `feedback` 字段包含 tester 的 issues 文本;④ `gateLog` 正确累加(多次经过同一个门,`gateLog` 里有多条,不是只保留最后一条)。
- `src/loop/__tests__/graph.test.ts`(玩具节点 + `MemorySaver`,专门清 `addConditionalEdges` 的风险):①happy path 一次通过:draft→g1(approve)→review(pass)→g3(approve)→apply→END;②G1 拒绝一次后 approve:draft→g1(reject)→draft→g1(approve)→review→...;③tester 打回一次后 G2 approve:...→review(reject)→g2(approve)→draft→review(pass)→...(验证 `rejectCount` 确实变成 1,且图真的回到了 draft 再走一遍,不是卡住或走错节点);④G3 拒绝一次:...→g3(reject)→draft→...;⑤G2 收到非 `"approved"` 的决策 → 抛 `UnhandledGateDecisionError`(直接验证 §2 非目标"G2 没有第二条出边"这条硬约束,不是只在文档里说说)。
- `src/loop/__tests__/checkpoint.test.ts`:见上方测试策略第3层的详细描述——两阶段、真实文件、丢弃第一阶段的所有对象引用后用全新实例续跑。

### 垂直切片(A4a 收尾,硬性交付)

- `src/loop.e2e.test.ts`(顶层文件,命名对齐 `harness.e2e.test.ts`/`harness-cli.e2e.test.ts` 已有的放置惯例):
  1. 真实 `MemoryStore`+`ContextInjector`产出 `injectedContext`(照抄 `harness-cli.e2e.test.ts` 已有的搭建方式)。
  2. 真实 `PromptComposer`(`personasDir` 指向 `profiles/subscription/personas`,和 A3 e2e 测试一致)。
  3. 一份内存态 fixture `ProfileConfig`:`roles: { coder: { provider: "claude-cli" }, tester: { provider: "codex-cli" } }`(**对齐真实 `profiles/subscription/config.yaml` 的角色绑定**,不是随手挑的——DESIGN §7 表格明确"coder: claude-cli / tester: codex-cli",这条切片如果绑反了角色,不会报错但语义是错的,`config.test.ts` 那类结构性测试抓不出这种问题,只能靠这里对齐真实配置来防),`providers` 两个 cli-bridge 条目都用 `bin` 覆盖指向 fixture 脚本(A3 已确立的 `cmd`(flavor,不变)+`bin`(spawn 目标覆盖)模式)。
  4. 真实 `buildAdapterRegistry(fixtureConfig)` → 真实 `ProviderRouter`。
  5. `createSqliteCheckpointer()` 指向一个临时文件(同 `checkpoint.test.ts` 的临时目录手法)。
  6. `compileLoopGraph(buildLoopGraph({ router, composer }), checkpointer)`。
  7. 第一次 `invoke({ task, injectedContext, ... 其余字段用 default })` → 应该停在 G1(`__interrupt__` 非空,`state.next` 是 `["g1"]`)。
  8. `Command({ resume: { decision: "approved" } })` 续跑 → 应该停在 G3(tester 走完、判定 pass,`state.next` 是 `["g3"]`)。
  9. `Command({ resume: { decision: "approved" } })` 再续跑一次 → 跑到底,`state.values.applied === true`。
  10. 断言:全程只用了 fixture 脚本作为 adapter 的 spawn 目标(测试本身通过 `bin` 字段保证,不需要额外的 spy);`coderOutput`/`testerOutput` 是 typed 的 schema 校验结果,不是裸 JSON;`coderResult.provider === "claude-cli"`,`testerResult.provider === "codex-cli"`(验证角色↔adapter 绑定真的对);G1/G3 各自的 `gateLog` 条目存在且 `decision === "approved"`。
  - **需要新增的 fixture 场景**:复用 A3 已有的 `fake-claude.fixture.mjs`(供 coder 角色用)/`fake-codex.fixture.mjs`(供 tester 角色用)——如果这两个文件里已有的场景刚好能产出"schema 合法 + 内容是这条切片需要的语义"(coder 侧需要一个非空 diff + 至少一条 claim;tester 侧需要 `verdict: "pass"`),直接复用已有场景;如果没有完全匹配的,按 A3 B3/B4 已经建立的"加一个新 `case` 分支,不复制整份新文件"的模式各自新增一个,不在本 PRD 里锁死具体场景名(这是实现细节,build 阶段做,不影响验收标准)。

## 6. 批次拆解

> 单位延用 A0-A3 PRD 的自定义量级:`[S]` ≈ 2-4h、`[M]` ≈ 半天到一天、`[L]` ≈ 1-2 天。单分支 `feature/issue-13-a4a-loop` 顺序提交(理由同 A0-A3)。批次顺序参考 spike-findings.md"对 A4a PRD 的建议 #4",但按本 PRD §0 定的 A4a 实际范围(含 G2/G3 完整正常分支,不只是最简单一条路径)做了调整。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `src/loop/types.ts` + `errors.ts` + `workflow-def.ts`(类型/命名骨架,含 `LoopState` 的 `Annotation.Root` 定义——第一次实测 LangGraph 的 TS 类型推导用法) | 无(起点) | [S] |
| **B1** | `src/loop/nodes/coder.ts` + `nodes/tester.ts` + 单测(`FakeAdapter`,不需要真实子进程) | B0 | [M] |
| **B2** | `src/loop/gates.ts` + `gates.test.ts`(玩具节点,验证 `interrupt()`/`Command({resume})`,含 §5 描述的三个门+ feedback 派生逻辑) | B0 | [M] |
| **B3** | `src/loop/graph.ts` + `graph.test.ts`(玩具节点 + `MemorySaver`,**第一件事验证 `addConditionalEdges`**,再搭完整状态机含 G1/G2/G3 各自的正常回边——本增量真正的技术风险点) | B1+B2 | [L] |
| **B4** | `src/loop/checkpoint.ts` + `checkpoint.test.ts`(真实 `SqliteSaver` + 真实图 + `FakeAdapter` 节点,"非闭包内状态"两阶段测试) | B3 | [M] |
| **B5** | 垂直切片 `src/loop.e2e.test.ts`(真实 cli-bridge adapter + fixture 子进程 + 真实图 + 真实 checkpointer,happy path 全链路) | B4 | [L] |
| **B6** | 文档回写(`docs/ROADMAP.md` A4 行拆成 A4a 已完成/A4b 待办两行 / `docs/PROGRESS.md` 清空 / `CHANGELOG.md` 加行 / 根 `CLAUDE.md` 目录结构行更新 loop 已建 / `CHARTS/knowledge/aeloop.md`(ai-agent 仓)新增 `src/loop/` 模块条目——四项职责/对外接口/依赖关系/关键文件路径,可追源到本增量真实代码) | B5 | [S] |

**依赖图要点**:B1(coder/tester 节点)和 B2(gates)彼此独立,理论上可并行(都只依赖 B0 的类型),同一个 Cypher 顺序实现故不额外拆分支。B3 是本增量的技术风险核心,必须等 B1+B2 都完成(节点函数和门节点都要真实存在,`graph.ts` 才能把它们接起来)。B4/B5 严格顺序依赖前面的图结构。

## 7. 分支策略

单分支 `feature/issue-13-a4a-loop`(spike 已在此分支),批次按 §6 顺序提交,理由同 A0-A3 PRD:一个人顺序实现,批次间大部分是真依赖。若指挥官希望 Zorro 分阶段审,自然断点是"B0-B2(类型+节点+门,机制单元)/ B3-B4(图结构+checkpoint,风险核心)/ B5-B6(垂直切片+文档)"——`addConditionalEdges` 是本增量唯一真正未被 spike 降险的机制,如果要分阶段审,B3 完成后单独请审一次的价值可能比等到最后更大,留给指挥官判断。

## 8. 可测验收标准(可勾选)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess` 无报错),`pnpm lint`(`tsc --noEmit`)同样无报错——含 spike Q5 发现的 `Command` 泛型坑:`src/loop/` 下任何 `new Command({resume: ...})` 都显式标注了三个泛型参数,第三个是从 `types.ts` 的 `LoopNodeName` 引用来的,不是散落的字面量联合。
- [ ] `pnpm test` 全绿(vitest run),新增 A4a 测试文件全部计入,且不产生任何真实网络/真实 CLI 调用(同 A3 已有的检查手法:`grep` 确认测试文件里没有直接指向真实 `claude`/`codex` 二进制的 spawn)。
- [ ] **`graph.ts` 真编译真跑通**:`buildLoopGraph()`+`compileLoopGraph()` 产出的编译图能 `invoke()`,`addConditionalEdges` 的每一条分支(G1 approve/reject、review pass/reject、G2 approve、G3 approve/reject)都各自有一条测试实际走过(`graph.test.ts`),不是只测了 happy path 那一条。
- [ ] **G1/G2/G3 门真的能停、真的能从外部一个新调用恢复**:`checkpoint.test.ts` 证明——第一阶段构造的编译图/checkpointer 对象被显式丢弃后,第二阶段用全新构造的实例(同 `thread_id`、同磁盘 db 路径)能读到和第一阶段中断时一致的 `__interrupt__` payload,并能用 `Command({resume})` 续跑到底。
- [ ] **coder/tester 节点复用 A2/A3,不重新发明模型调用**:`nodes/coder.ts`/`nodes/tester.ts` 除了 `../../prompt/composer.js`/`../../harness/provider-router.js`/`../../harness/schema-validator.js`/`../../prompt/schema.js` 之外,不 import 任何新的模型调用逻辑;`grep -rn "spawn\|fetch(" src/loop --include="*.ts"` 应该零命中(spawn/fetch 只应该出现在 `harness/` 层,`loop/` 层永远只通过 `ProviderRouter`+`ModelAdapter` 接口间接触达)。
- [ ] **垂直切片必接通**:`loop.e2e.test.ts` 存在且通过——真实 Context→Prompt 链路产出的 prompt,经真实 `buildAdapterRegistry`(fixture 脚本替身)+真实 `ProviderRouter`+真实编译图(真实 `SqliteSaver`)+两次 `Command({resume})`,跑完整个 happy path 到 `applied === true`,且 `coderResult.provider`/`testerResult.provider` 分别是 `"claude-cli"`/`"codex-cli"`(角色↔adapter 绑定和真实 `config.yaml` 一致)。
- [ ] **interrupt 前置副作用重跑坑在代码里被规避**:`gates.ts` 的 `interrupt()` 调用之前的代码(payload 构建)是纯函数,`GateLogEntry` 的构造在 `interrupt()` 返回之后才发生——代码审查可确认,`gates.test.ts` 里"同一个门测试多次 approve/reject 循环、日志条数符合预期而不是被重复记录"的测试间接验证这条。
- [ ] **`rejectCount` 递增点正确、G2 无路由目标时 fail loud**:`tester.test.ts`/`graph.test.ts` 分别在节点层和图层验证 `rejectCount` 只在 `verdict === "reject"` 时 +1;`graph.test.ts` 有一条测试证明 `routeAfterG2` 收到 `"rejected"` 时抛 `UnhandledGateDecisionError`,不是静默走到某个意外节点。
- [ ] `docs/ROADMAP.md` A4 那一行拆分成 A4a(打钩)/ A4b(待办)两行、`docs/PROGRESS.md` 清空或更新、`CHANGELOG.md` 加行、根 `CLAUDE.md` 目录结构行同步、`CHARTS/knowledge/aeloop.md`(ai-agent 仓)新增 `src/loop/` 模块条目。

## 9. 依赖 / 风险 / 开放问题

### 9.1 checkpoint 的"非闭包状态"证明:同进程双阶段 vs. spike Q4 的真跨进程——建议采纳同进程双阶段

派工指令原话是"不一定要跨进程,但要证明非闭包内状态续跑"——本 PRD §5/§6 选择"同一个测试文件里,构造两个结构独立的编译图+checkpointer 实例,第一个用完显式丢弃引用"这种同进程双阶段方式,而不是照抄 spike Q4 那种真的用 `child_process` 起两个独立 `node` 子进程。**理由**:spike Q4 已经在 issue #13 前置阶段把"真跨进程"这件事证实过一次(pid 27363→pid 27564,零内存共享),A4a 不需要为每个批次都重新证一遍"LangGraph 的 checkpoint 机制本身可信"这个已经有证据的事实;A4a 测试套件真正要防的回归是"aeloop 自己写的 `checkpoint.ts`/`graph.ts` 有没有不小心引入了某种进程内单例/缓存,让 resume 看起来工作、实际上偷偷依赖了第一次 `invoke()` 留下的某个变量"——这个问题同进程双阶段(显式丢弃引用+构造全新实例)一样能测出来,而真起子进程会引入额外的测试基础设施复杂度(subprocess 编排、跨进程日志收集、CI 环境的子进程权限)且收益是重复验证已经验证过的东西。**如果指挥官认为"外部一个新调用"必须是字面意义的新 `node` 进程才算数,请直接说,我会照 spike Q4 的模式重做这条测试。**

### 9.2 §5 里几处"不是 spike 直接证据、我自己判断的设计决策"汇总——请逐条确认

以下每条都已经在 §5 对应位置详细写了理由,这里只做汇总方便快速过一遍,不重复展开:
1. G2 只处理 `"approved"`,`"rejected"`/任何其它值抛 `UnhandledGateDecisionError`(§2 非目标)。
2. `GatePayload.diffRef` 在 A4a 阶段实际内联 diff 全文,不做"哈希/路径"这层间接(§5 types.ts)。
3. `gateLog` 会随 `SqliteSaver` checkpoint 落盘(LangGraph 自己的 checkpoint 表),但 A4a 不把它写入 A4b 才建的 `approvals` 业务表——这才是 A4a/A4b 的真实边界,不是"只在内存、进程退出即消失"(Zorro R1 M1 修正,§4)。
4. `workflow-def.ts` 的 `CODER_TESTER_LOOP_DEFINITION` 是文档性质,不是运行时被 `graph.ts` 解释执行的配置;不创建 `workflows/coder-tester-loop.json`(§5 workflow-def.ts,这条是对 DESIGN §6 原文的一次降级解读,风险相对最高,最需要确认)。
5. `Apply` 节点不写文件系统,只做状态终结(§0/§2)。
6. checkpoint 的"非闭包状态"验证用同进程双阶段而非真跨进程(§9.1)。

### 9.3 `LoopState` 的 LangGraph TS 类型推导用法——spike 未覆盖,B0 第一步就会撞到

spike 的 Q2/Q3/Q4 三个脚本都是纯 `.mjs`(或宽松 `.ts`),节点函数直接写在 `new StateGraph(State).addNode("x", fn)` 链式调用里,没有出现过"先声明一个可复用的节点函数类型签名、再把它传给 `addNode`"这种模式(A4a 的 `nodes/coder.ts`/`gates.ts` 恰恰需要这样——节点函数要独立导出、可单测)。这不是设计缺陷,是 spike 5 个 Q 没有覆盖到的一个 TS 类型工程细节,B0 批次第一次真的把 `LoopState`(`Annotation.Root`)的推导类型喂给一个独立声明的节点函数签名时,大概率会遇到需要摸索的类型写法,不在本 PRD 事先精确定义,风险已经在 §6 批次拆解里通过"B0 独立成一个最先的小批次"做了隔离。

---

**没有需要指挥官现在就拍板的会阻塞开工的新岔路**——§9.2 汇总的 6 条判断本 PRD 已经各自给出了倾向性结论并写清楚理由,可以先按这些结论开工,指挥官/军师如果对其中某条有不同意见,随时可以打断修正,不需要等全部确认完才能开始 B0。

## 10. 项目约束检查

- **模型无关?** 是——`nodes/coder.ts`/`nodes/tester.ts` 只依赖 `ProviderRouter`/`ModelAdapter` 接口,完全不知道背后是 `ClaudeCliAdapter`/`CodexCliAdapter`/`LiteLLMAdapter` 中的哪一个。
- **跨层无反向依赖?** 是——`src/loop/*.ts` 只 import `harness/`(`ProviderRouter`/`SchemaValidator`/类型)、`prompt/`(`PromptComposer`/schema)、`context/`(仅类型 `ContextInjectionResult`,不 import `ContextInjector` 类本身——注入发生在图外,§4/§5 已说明);不存在任何 `src/harness/`/`src/context/`/`src/prompt/` 反过来 import `src/loop/` 的情况(build 完成后 `grep -rln "from.*loop" src/harness src/context src/prompt` 应零命中)。
- **角色不硬编码?** 部分是——`nodes/coder.ts`/`gates.ts` 里的 `"coder"`/`"tester"` 字符串是**本增量唯一一条业务允许硬编码角色名的地方**:DESIGN §1.7 说的"不硬编码 `{coder,tester}`"指的是 persona/schema **查找机制**本身要按名动态查(A1/A2 已经做到——`schema-registry.ts`/`personas.ts` 都是按 `role` 参数动态查,不是 switch),不是说"这一个内置的 coder-tester workflow 定义本身不能提到 coder/tester 这两个词"——`CODER_TESTER_LOOP_DEFINITION`/`nodes/coder.ts`/`nodes/tester.ts` 天然就是关于这两个角色的具体节点,和"加一个新角色要不要改 `composer.ts`"是两个不同的问题(答案仍然是"不需要改",因为查找机制本身是动态的)。
- **`profiles/apikey/` 不入仓?** 是——本增量不创建/不修改 `profiles/apikey/` 任何文件。
- **引擎代码不含 Helix 人格?** 是——`src/loop/` 下所有新代码零 Helix/companion/私人记忆内容。
- **远控点火(`CLAUDE.md` 铁律)?** 是——见 §5 测试策略小节,所有测试(单测到垂直切片)全部走玩具节点/`FakeAdapter`/受控 fixture 子进程,不产生任何对真实 `claude`/`codex`/网络的调用。
