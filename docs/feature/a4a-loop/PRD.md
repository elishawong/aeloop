# PRD — aeloop A4a: Loop 编排(graph + coder/tester 节点 + G1/G2/G3 gate + happy-path 纵切)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a3-cli-bridge/PRD.md`(本仓库现有 PRD 的约定——分层/分批/验收措辞风格直接照搬)。
> 防幻觉:`[?]` = 我未验证 / 需要指挥官确认;不编造接口/版本/参数。本 PRD 里每一条 LangGraph API 行为主张都来自 `docs/feature/a4a-loop/spike-findings.md`(issue #13 之前的 spike——真实跑过的命令、真实输出样本),不是凭记忆/假设。任何没有直接 spike 证据支撑、需要我自己判断的设计决定都单独列在 §0,附上理由,不和"已证实"的部分混在一起。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-13-a4a-loop`(spike 已经在这个分支上,未 commit)
- **优先级**:P1
- **状态**:等指挥官确认
- **最后更新**:2026-07-21
- **相关 issue**:[elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13)(A4 Loop 父 issue——本 PRD 只覆盖它的 **A4a 子范围**;拆分理由见 §0)| 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§4 gate 控制流程图 / §5 ER:三张审计表 / §6 `src/loop/` 目标布局 / §8 A4 里程碑 / §8.5 方法论警告)+ `docs/feature/a4a-loop/spike-findings.md`(本 issue 的 pre-spike,LangGraph 行为的唯一证据来源)

---

## 0. 范围切分:A4a / A4b(方向已由军师+指挥官定盘,本节记录切分理由)

**切分本身已经定了**(来自派工指示,不是我自己的判断):
- **A4a**(本 PRD):graph + coder/tester 节点 + G1/G2/G3 gate(interrupt/resume,接线到 spike 已证实的真实 checkpoint 机制)+ happy-path 纵切。
- **A4b**(下一轮 PRD):阈值升级硬分支 + 三张审计表(`workflow_runs`/`structured_claims`/`approvals`)落盘 + 跨进程 checkpoint 续跑生产化。

**我在这个切分之上做的进一步细分**(这是我自己的判断,不是派工指示直接给的——标出来待确认):除了"阈值升级"之外,DESIGN §4 完整状态机里还有几条分支只有 Escalation 节点存在之后才有意义——我把这些也归进了 A4b,理由见下表:

| DESIGN §4 元素 | 决定 | 理由 |
|---|---|---|
| `Draft→G1→Review→G3(approved)→Apply→End` | **A4a 做** | 主 happy path,派工指示明确要求 |
| `G1 reject→feedback 回到 Draft` | **A4a 做** | G1 gate 两条分支之一;没有它就不算真正的"gate" |
| `Review 送回→reject_count+=1→G2` | **A4a 做(计数本身)** | `Inc` 这一步不依赖 Escalation 节点——只要 Review 送回就无条件发生,和阈值判断(`T` 决定)是两件事,可以干净拆开 |
| `count>=threshold 硬分支` | **A4b** | 原始派工指示明确分给 A4b |
| `G2 approve→Fix(=Draft)→Review` | **A4a 做** | G2 gate 除阈值外的正常分支 |
| `G2 proactive escalation→Esc` | **A4b(A4a 只留接口,不接线)** | 这条分支的目的地是 Escalation 节点;A4a 不建这个节点。如果外部调用方在 A4a 阶段传入这个决定值,会显式抛 `UnhandledGateDecisionError`(fail loud)——不会被悄悄吞掉,也不会悄悄接到一条还不存在的分支上 |
| `G3 reject→new issue→Draft` | **A4a 做** | G3 gate 两条分支之一 |
| `Escalation` 节点 + `HD` 人工决定 + `Cancel` 终止态 | **A4b** | 这三样只在"已进入升级"时才有用——A4a 从来不会走到这里,提前建出来意味着建一堆测试碰不到的死代码 |
| `Apply`("把文件写进工作区,不自动 git commit/push") | **A4a 做,但缩水**(见 §2 Non-goals) | 真正把文件改动落盘是一个独立的、相当复杂的 diff/patch 应用问题,和"LangGraph 编排本身"是不同维度——A4a 的 Apply 节点只终止状态,不碰文件系统 |

**结论**:A4a 交付的是 **DESIGN §4 状态机里除 Escalation 子树之外的全部**,包括三个 gate(G1/G2/G3)的正常分支和 Draft↔Review 之间的完整往返(不只是"从没被送回过一次的那条路")。纵切(e2e 测试)本身只跑 happy path(一次通过,从不触发送回),但**图结构和 G2/reject 分支必须真实存在并有自己的测试覆盖**——这是"happy-path 纵切"和"只支持 happy path 的图"的区别,后者不是本 PRD 的意图。

### 0.1 为什么不开单独的子 issue

沿用 spike 阶段就已经在用的分支名 `feature/issue-13-a4a-loop`(指挥官/军师在 spike 阶段就定下的名字)——不开新 issue:issue #13 的标题"A4 Loop"本身就是父范围,本 PRD 是这一批交付的子集;A4b 会是同一个 issue 下的后续 PRD/批次(沿用 A0+A1 共用一个 issue 的先例)。issue #13 现在的正文只是一段"待 `/spec` 拆批"的粗略描述(创建时就是这么写的)——不需要为了这次拆分单独开一个新 issue 号。如果指挥官更希望 A4a/A4b 各自有独立 issue 用于跟踪,说一声我可以当场开。

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A0-A3 已经建好并纵切验证过 `Prompt ⊂ Context ⊂ Harness` 三层栈,但**目前没有任何东西真正驱动"coder 写草稿 → 人工审 → tester 审 → 人工签字"这个循环**——`ProviderRouter.route("coder")`/`.route("tester")` 能拿到真实 adapter,`SchemaValidator` 能校验单次调用的输出,但"coder 完成后该不该送给 tester""tester 送回后 coder 该不该重试""什么时候该升级给人工"——这些编排逻辑完全不存在。DESIGN §4 画的 gate 控制状态机(Draft→G1→Review→G2/G3)目前只是一张图,不是代码。同时 spike 已经证实了 LangGraph 的 `interrupt()`/`Command({resume})`/`SqliteSaver` 机制在本仓库技术栈上可行,但**它只验证了最简单的单 gate 场景**(一个 G1,没有条件边,没有回环边,没有 G2/G3)——`addConditionalEdges`(DESIGN §4 状态机的核心机制之一)spike 完全没碰过。
- **这是给谁用的**:直接消费方是本次增量自己的纵切测试,以及后续的 A4b(会在 A4a 建的图之上加阈值分支+审计持久化)。再往下游是 A5(CLI/TUI 层,会在这张图上接一个真人可用的审批界面),最终是 Elisha 自己实际的 dogfooding 循环。
- **一句话方案**:按 spike 已证实的 API 形状搭建 `src/loop/`——`nodes/coder.ts`/`nodes/tester.ts` 复用 A2 的 `ProviderRouter`/A1 的 `PromptComposer`/A2 的 `SchemaValidator`(不重造模型调用);`gates.ts` 用 spike Q3 证实的 `interrupt()`/`Command({resume})` 模式实现 G1/G2/G3 gate,每个 gate 都能真正暂停、真正被外部一次全新的函数调用恢复(不依赖调用方保留任何闭包持有的状态);`graph.ts` 用 `addConditionalEdges`(spike 未验证——A4a 第一批就必须把这个风险清零)把 Draft/G1/Review/G2/G3/Apply 六个节点按 DESIGN §4(去掉 Escalation 子树)接成完整状态机;`checkpoint.ts` 接上 spike Q4 证实的 `SqliteSaver.fromConnString(path)` 模式;最后一个硬核纵切测试端到端证明整条链——"真实 Context→Prompt 组装出的真实 prompt → 真实 `buildAdapterRegistry` 构造的真实 cli-bridge adapter(受控 fixture 子进程,不打真实 CLI)→ 真实 graph → 真实 G1/G2/G3 interrupt/resume → happy path 一路走到 Apply"——是真的接通的,不是一堆各自绿但只是制造"看起来接通了"错觉的孤立测试。

## 2. 目标 / 非目标

**目标**:
- `src/loop/types.ts`:`LoopState`(LangGraph 的 `Annotation.Root` 状态形状)、`LoopNodeName`、`GateType`、`GateDecision`、`GatePayload`、`GateResumeValue`、`GateLogEntry` 等类型契约。
- `src/loop/errors.ts`:`UnhandledGateDecisionError`(G2 收到 A4a 没有路由目标的"主动升级"决定时抛出——fail loud)。
- `src/loop/workflow-def.ts`:节点名/gate 类型的单一命名来源(`LOOP_NODES`/`GATE_TYPES` 常量)+ 一个描述性的 `CODER_TESTER_LOOP_DEFINITION`(A4a 对 DESIGN §6"WorkflowDefinition Registry"概念的落地——详细说明和缩水理由见 §5)。
- `src/loop/nodes/coder.ts` / `src/loop/nodes/tester.ts`:draft/review 节点工厂函数,复用真实的 `ProviderRouter`+`PromptComposer`+`SchemaValidator`——不新增任何模型调用路径。
- `src/loop/gates.ts`:G1/G2/G3 gate 节点工厂(共用 `interrupt()` 机制)+ 三个路由函数(`routeAfterG1`/`routeAfterReview`/`routeAfterG2`/`routeAfterG3`)。
- `src/loop/checkpoint.ts`:`createSqliteCheckpointer(dbPath)`,按 spike Q4 证实的 `SqliteSaver.fromConnString()` 模式接线。
- `src/loop/graph.ts`:`buildLoopGraph()`(纯图结构,不带 checkpointer)+ `compileLoopGraph()`(接入 checkpointer,产出一个可以 `invoke`/`getState` 的已编译图),把上面所有节点/gate 接成 DESIGN §4(去掉 Escalation 子树)的完整状态机,包括首次验证 `addConditionalEdges`。
- **硬核纵切**:一个端到端测试证明整条 happy-path 链路真的接通——"真实 `MemoryStore`+`ContextInjector`+`PromptComposer` → 真实 `buildAdapterRegistry`(cli-bridge adapter,受控 fixture 子进程)→ 真实 `ProviderRouter` → 真实已编译图(真实 `SqliteSaver` checkpointer)→ G1 interrupt+resume(approve)→ tester 通过 → G3 interrupt+resume(approve)→ Apply"。

**非目标(明确不做,推迟到 A4b/A5 或更后面的增量)**:
- ❌ **阈值升级硬分支**(`reject_count >= threshold` 条件路由 + Escalation 节点 + 人工决定 + Cancel 终止态)——§0 已定,A4b。`reject_count` 本身在 A4a 里确实会递增(只要 Review 送回就会),但没有代码读它来做路由决定。
- ❌ **G2 的"主动升级"分支真正接线**——A4a 的 `GateResumeValue.decision` 类型技术上允许外部调用方传入 `"approved"`/`"rejected"` 之外的值吗?**不允许**——A4a 的 `GateDecision` 只有 `"approved" | "rejected"` 两个值(DESIGN §5 `approvals.decision` 枚举的子集,去掉只服务于升级的 `"override"`)。真正的问题是:G2 收到 `"rejected"` 时该去哪?DESIGN 的图里 G2 只画了两条出边——"approve→Fix"和"主动升级→Esc"——没有第三条"reject→哪里"的边。A4a 对这个 DESIGN 没定义的角落做了明确取舍:**G2 只处理 `"approved"`**;收到 `"rejected"` 时,`routeAfterG2` 抛 `UnhandledGateDecisionError`,而不是悄悄路由到某条我自己编出来的分支。这本身就是"决定没定完,所以我自己判断了一下"的一个例子——标 `[?]` 待确认(见 §9)。
- ❌ **三张审计表落盘**(创建并写入 `workflow_runs`/`structured_claims`/`approvals`)——A4b。A4a 的 `GateLogEntry`(§4)是这三张表(尤其是 `approvals`)未来会落盘内容的**内存影子**——字段名故意贴近 `approvals` 表的列名,让 A4b 能直接消费,但 A4a 本身**不建任何表,不碰任何 SQLite schema**。
- ❌ **跨进程 checkpoint 续跑生产化**(把 `langgraph_thread_id` 存进 `workflow_runs` 表、重启后"从哪个 gate 续跑"的完整真实流程)——A4b。A4a 只交付 `checkpoint.ts` 本身 + 一个证明"不是闭包持有状态"的测试(§6 B4:同一进程内两个独立构造的 compiled-graph+checkpointer 实例,而不是 spike Q4 那种真的起两个 `node` 子进程的做法——理由见 §9.1)。
- ❌ **有颜色的 TUI / y/n 审批界面**——A5。A4a 的 G1/G2/G3 gate 由测试代码直接构造 `Command({resume: {...}})` 注入决定驱动;没有任何人可交互的界面。
- ❌ **真实的 coder/tester 模型逻辑**——A4a 的节点直接复用 A2/A3 已经建好的 `ProviderRouter`+adapter+`SchemaValidator`,不新增任何"怎么让模型写/审代码写得更好"的逻辑;persona 文本(`profiles/subscription/personas/{coder,tester}.md`)照搬 A1 已有版本,不变。
- ❌ **真正把 diff 写进工作区文件系统**(DESIGN §3 时序图里的"把文件写进工作区")——`Apply` 节点只终止状态(把 `state.coderOutput`/G3 决定标记为"完成",不再往下走)——不调用任何文件系统写 API。真正把 unified diff 应用到工作区文件是一个独立的、相当复杂的问题(patch 库选型、冲突处理、要不要 shell 出去调真实 `git apply`),和"LangGraph 编排机制本身"是不同维度的工作,不属于本次增量;§0 表格已经把这一项标为"A4a 做,但缩水"。
- ❌ **运行时动态加载 / JSON 文件驱动编译 `WorkflowDefinition`**——详细说明见 §5 `workflow-def.ts` 任务描述:`graph.ts` 真正的图结构是用类型安全的手写链式调用(`addNode().addEdge()...`)搭出来的,不是运行时解释一个 JSON 文件;本 PRD **不创建** `workflows/coder-tester-loop.json`(DESIGN §6 提到的那个文件)——理由和影响见 §5/§9。
- ❌ **任何读 `config.yaml` 里 `reject_threshold` 的代码**——A4a 的图不做阈值判断;这个已有的配置字段(`profiles/subscription/config.yaml` 的 `workflow.reject_threshold: 2`)在 A4b 之前保持它现在"存在但没人读"的状态。

## 3. 用户故事

- 作为 **A4a 自己的纵切测试**,我想证明一个真实 prompt 从组装,到 coder 产出 diff,到人工批准送给 tester,到 tester 通过,到最终人工签字,到状态终止——全程都是真实的 `ProviderRouter`+adapter+`SchemaValidator`+LangGraph 图走完的——不是靠几个互不相关的单元测试拼出"看起来接通了"的错觉。
- 作为**未来的 A4b 开发者**,我想让 `graph.ts`/`gates.ts` 已经把 G1/G2/G3 的正常分支和 `reject_count` 递增点——所有和"阈值升级"无关的部分——都建好,这样 A4b 只需要在 `routeAfterReview` 附近插一条阈值判断的条件边 + 建 `Escalation` 节点,不用从零重新设计图的骨架。
- 作为**指挥官**,我想看到一个测试真的把一个已编译图跑到 G1 中断,丢弃那个已编译图对象,然后用一个全新的 compiled-graph+checkpointer 实例(同一个 `thread_id`,同一个 sqlite 文件路径)把它续跑完——证明 resume 靠的是磁盘上的 checkpoint,而不是某个还留在 JS 进程里的闭包变量。
- 作为**指挥官**,我想确认这次增量不会在自动化测试里打真实的 `claude`/`codex` CLI、消耗订阅额度——测试策略沿用 A3 已经建立的"真实 cli-bridge adapter spawn,但指向受控 fixture 脚本"模式。

## 4. 数据模型

本次增量**不建任何表,不碰 SQLite**——三张审计表 `workflow_runs`/`structured_claims`/`approvals` 仍然是 A4b 的活(延续 A2/A3 §4 定下的"无状态"边界)。这里唯一的"数据形状"是 LangGraph 的内存态 + checkpoint 状态:

```typescript
// src/loop/types.ts — 建议形状;字段名可能在 build 阶段微调,但下面每个字段的语义/存在性都是 PRD 硬约束
const LoopState = Annotation.Root({
  task: Annotation<string>(),                              // 原始任务描述,整个 run 期间不变
  feedback: Annotation<string | undefined>(),               // 下一个 draft 节点需要看到的反馈(来自 G1 的拒绝理由 / tester 提的问题 G2 批准时带过去 / G3 的拒绝理由);被 draft 节点消费并清空,不会无限累积
  injectedContext: Annotation<ContextInjectionResult>(),    // ContextInjector.inject() 的结果,由调用方在图外一次性注入(见 §5"为什么 ContextInjector 不在节点内再调一次"),整个 run 期间不变
  coderOutput: Annotation<CoderOutput | undefined>(),       // 最近一次 draft 节点运行的输出
  coderResult: Annotation<InvokeResult | undefined>(),      // 同上,原始 InvokeResult(含 provider/model/toolExecChecked)
  testerOutput: Annotation<TesterOutput | undefined>(),     // 最近一次 review 节点运行的输出
  testerResult: Annotation<InvokeResult | undefined>(),
  rejectCount: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }), // 只要 Review 送回就递增;A4a 没有代码读它来做路由决定(§0/§2 Non-goals)——纯粹是先把"Inc"这一步建出来
  g1Decision: Annotation<GateDecision | undefined>(),
  g2Decision: Annotation<GateDecision | undefined>(),
  g3Decision: Annotation<GateDecision | undefined>(),
  gateLog: Annotation<GateLogEntry[]>({ reducer: (a, b) => a.concat(b), default: () => [] }), // 解释见下文
  applied: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
});

interface GateLogEntry {
  gate: GateType;            // "G1_SEND_TO_TESTER" | "G2_SEND_TO_FIX" | "G3_FINAL_MERGE"(DESIGN §5 approvals.gate_type 枚举的 A4a 子集,排除只存在于 A4b 的 "ESCALATION_ACK")
  decision: GateDecision;    // "approved" | "rejected"
  reasoningText?: string;    // 人在 resume 时给出的理由文字
  decidedAt: string;         // ISO 时间戳
}
```

**`gateLog` 是刻意设计成 A4b 的先行者**:它的字段名贴近 DESIGN §5 `approvals` 表的列(`gate_type`/`decision`/`reasoning_text`/`decided_at`),这样 A4b 加审计持久化时可以直接把 `state.gateLog` 的每一条写进 `approvals` 表——不需要重新设计"图执行过程中要记住哪些信息"这一层。**准确措辞(Zorro R1 M1 修正)**:`gateLog` 是 `LoopState` 的一个 Annotation channel;当真实图用 `SqliteSaver` 编译后,LangGraph 会把**整个 state(包括 gateLog)**序列化进它自己的 checkpoint 表(`checkpoints`/`writes`)——不是"只存在于内存,进程一退出就没了"。A4a 和 A4b 之间真正的边界是:A4a 从不把 `gateLog` 的条目写进 A4b 建的业务审计表 `approvals`;LangGraph 自己的 checkpoint 持久化和 aeloop 自己的 `approvals` 持久化是两件独立的事,只有后者是 A4b 的活。这是一个刻意的设计选择,不是疏漏——标出来待确认(§9)。

LangGraph 自己的 checkpoint 表(`checkpoints`/`writes`,由 `SqliteSaver.setup()` 自动建)和上面 aeloop 的业务状态是完全不同的两件事——spike-findings.md §4 已经证实这两组表是完全独立的:前者存"图走到哪一步了、state 快照是什么"(LangGraph 自己管,A4a 直接用),后者是 aeloop 自己的业务审计语义(只在 A4b 建)。

## 5. 逐文件任务清单

### 类型 / 单一命名来源

- `src/loop/types.ts`(**新文件**):
  - `LoopState`(`Annotation.Root`,见 §4)+ 一个导出的派生类型 `LoopStateType`(`typeof LoopState.State`,或等价写法——LangGraph `Annotation` 具体的 TS 类型推导语法在 build 阶段实测确认——spike Q2/Q3 都是 `Annotation.Root({...})` 紧接着直接把整个 `State` 对象喂进 `new StateGraph(State)`,从来没有单独导出一个"State 的 TS 类型"给节点函数签名用——这是 A4a 需要自己摸索的用法,spike 的 5 个 Q 都没覆盖到,build 阶段第一件事要确认)。
  - `LoopNodeName`:一个字面量联合类型,复用 `workflow-def.ts` 的 `LOOP_NODES` 常量值 + LangGraph 的 `"__start__"`/`"__end__"`(spike Q5 的 `Command` 例子里 `"__start__"` 出现在 `Nodes` 泛型联合里——`"__end__"` 是不是也要放进这个联合,还是 LangGraph 自动处理,只能在 build 阶段第一次 `tsc` 报错时才能确认——这不是我编的,是老实标出"spike 没测过这个边界")。这是**全部 `src/loop/` 里唯一定义 `LoopNodeName` 的地方**——`graph.ts`/`gates.ts` 任何地方构造 `new Command<...>({resume: ...})`,第三个泛型参数都从这里导入,不每次重写一遍字面量联合(这是 spike-findings.md Q5"对 A4a PRD 的影响"那节的直接应用)。
  - `GateType = "G1_SEND_TO_TESTER" | "G2_SEND_TO_FIX" | "G3_FINAL_MERGE"`(DESIGN §5 `approvals.gate_type` 枚举的 A4a 子集,排除只在 A4b 建的 `"ESCALATION_ACK"`)。
  - `GateDecision = "approved" | "rejected"`(DESIGN §5 `approvals.decision` 枚举的子集,排除只用于 A4b 的 `"override"`)。
  - `GatePayload`:通过 `interrupt()` 传出去的 payload 形状——`{ gate: GateType; question: string; diffRef?: string; issues?: string[] }`(`diffRef` 让 G1/G3 带上待审的 diff 文本,`issues` 让 G2 带上 tester 报的问题列表——起名 `diffRef` 而不是 `diff` 是刻意贴近 DESIGN §5 `approvals.diff_ref` 列的含义,"一个哈希/路径,而不是内联一大段文本",不过在 A4a 阶段,完全没有持久化,这里实际内联的就是 diff 的全文本身;`[?]` A4a 阶段是不是该已经做"存哈希/路径而不是全文"这层间接——标出来,倾向于**先不做**——A4a 完全跑在内存里,没有 diff 需要跨进程边界传递的场景,等真实持久化出现后 A4b 再决定要不要加这层间接)。
  - `GateResumeValue`:`Command({resume: ...})` 里 `resume` 的形状——`{ decision: GateDecision; reasoningText?: string }`。
  - `LOOP_NODES`/`GATE_TYPES` 挪到 `workflow-def.ts`(下面);`types.ts` 只导入它们的类型,不重新定义这些常量。

- `src/loop/errors.ts`(**新文件**):
  - `UnhandledGateDecisionError extends Error`:构造函数 `(gate: GateType, decision: string)`,消息说明"A4a 没有为这个 gate/decision 组合建路由目标,等 A4b"。`routeAfterG2` 在收到 `"approved"` 之外的决定时抛这个(§2 Non-goals 已经解释了原因)。

### `workflow-def.ts`(A4a 对 WorkflowDefinition 概念的落地,缩水版——请核对这个缩水是否合适)

- `src/loop/workflow-def.ts`(**新文件**):
  - `LOOP_NODES`(一个 `as const` 对象,六个真实节点:`draft`/`g1`/`review`/`g2`/`g3`/`apply`)+ `GATE_TYPES`(`as const`,三个 gate 类型)——这是 `graph.ts`/`gates.ts`/`nodes/*.ts` 里所有节点名/gate 类型字符串字面量的**唯一真源**,避免像 spike 脚本那样在多处手写同一个字符串。
  - `CODER_TESTER_LOOP_DEFINITION`:一个**描述性**(不是可执行)的数据结构,列出 `LOOP_NODES` 的节点集合 + 每条边(包括哪些是条件边),大致形状:
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
  - **这是对 DESIGN §6"graph.ts 由 WorkflowDefinition 编译而来"这个设计的缩水,需要军师/指挥官签字确认**:spike-findings.md 建议 #2 明确指出"从 JSON/YAML 动态生成 StateGraph"从未验证过可行性,LangGraph 的 TS API(spike Q2/Q3/Q4 三个脚本都是这样)在类型安全的前提下用的是**手写链式调用**(`new StateGraph(State).addNode("draft", draftNode).addEdge(...)`),不是"遍历数组读配置调 `addNode`"这种运行时动态结构——一张图的节点/边**类型**(用于 `Annotation` 的状态形状推导、`Command` 的 `Nodes` 泛型)在 LangGraph 的 TS 类型系统里天生是编译期字面量;强行从数据结构在运行时生成它们,要么丢掉这层类型安全(退化成 `any`/`string`),要么需要相当复杂的 TS 类型体操(远超一个 PRD 批次该干的事)。A4a 的取舍是:**`CODER_TESTER_LOOP_DEFINITION` 是"给人看的文档 + 单一命名来源",不是"`graph.ts` 在运行时读取并解释的配置"**——`graph.ts` 真正的 `addNode`/`addEdge`/`addConditionalEdges` 调用是手写的,但用到的每个字符串字面量都是从 `LOOP_NODES`/`GATE_TYPES` 导入的,所以不存在"文档一份、代码一份,两份会漂移"的风险(对一个不存在的属性做导入,TS 会在编译期报错)。本 PRD **不创建** `workflows/coder-tester-loop.json`(DESIGN §6 提到的那个文件)——一个"看起来在读、实际没读"的 JSON 文件比根本没有这个文件更容易误导人;等真的出现第二个需要动态加载的真实 workflow 时(DESIGN §1.7 自己也说"等有 2-3 个真实 workflow 需求再做硬化"),再决定要不要把 `CODER_TESTER_LOOP_DEFINITION` 变成一个运行时真正读取的 JSON 文件。**如果这个取舍不符合指挥官在 DESIGN §6 那句话里的原意,请直接改——我不会在后续工作里悄悄按自己的理解实现。**

### `nodes/coder.ts` / `nodes/tester.ts`

- `src/loop/nodes/coder.ts`(**新文件**):
  - `createDraftNode(deps: { router: ProviderRouter; composer: PromptComposer }): (state: LoopStateType) => Promise<Partial<LoopStateType>>`。
  - 节点主体:① 用 `state.feedback`(可能是 `undefined`)组装本轮要用的任务文本——`state.feedback` 存在时,`task = state.task + "\n\n---\n\n上一轮的反馈:\n" + state.feedback`;不存在时就是原始的 `state.task`(**这里复用的是 `SchemaValidator.buildRetryPrompt()` 已经建立的"追加,不替换"惯例**,不是我新发明的模式——和这个代码库其余部分一致);② `deps.composer.compose("coder", state.injectedContext, task)` 拿 prompt;③ `deps.router.route("coder")` 拿 adapter;④ `new SchemaValidator().validate({ schema: CoderOutput, request: { role: "coder", prompt }, invoke: (req) => adapter.invoke(req) })`(`SchemaValidator` 没有构造函数依赖,直接 `new` 就行,和 `harness-cli.e2e.test.ts` 里的用法一致——不需要额外注入);⑤ 返回 `{ coderOutput: data, coderResult: result, feedback: undefined }`(**反馈一旦被消费就清空**,防止这个节点在某个 gate 再次更新 `state.feedback` 之前被重新进入时被连续追加两次)。
  - `SchemaValidationError`(A2 已有的类型)在这里**不单独捕获**——节点函数如果抛出,就让 `compiled.invoke()` 整体抛出,这是预期行为(coder 连续两次产出不合 schema 的输出是调用方需要知道的失败,不是 Loop 层该悄悄吞掉的东西)。
- `src/loop/nodes/tester.ts`(**新文件**):
  - `createReviewNode(deps: { router: ProviderRouter; composer: PromptComposer }): (state: LoopStateType) => Promise<Partial<LoopStateType>>`。
  - 节点主体:① 防御性检查 `state.coderOutput` 存在(理论上图的边保证 review 节点只会在 draft 之后被调用,但节点函数不该信任"图结构会保证这一点"这种隐含假设——缺失时抛一个清晰的 `Error`,不是 `undefined.diff` 那种裸崩溃);② 组装任务文本:把原始任务 + coder 的 diff + coder 的 claims 一起喂给 tester(DESIGN §3 时序"invoke(tester, diff+ctx, schema)"的字面应用——带上 claims 是因为 tester persona 的行为准则明确写着"核实 claim,而不是读完就点头同意"——没有 claims 列表,tester 就没有具体的东西可核实);③ 和上面一样调用 `composer`/`router`/`SchemaValidator`,`schema: TesterOutput`;④ 返回 `{ testerOutput: data, testerResult: result, rejectCount: data.verdict === "reject" ? state.rejectCount + 1 : state.rejectCount }`(DESIGN §4 的"Inc"步骤,这里无条件发生,不依赖任何阈值判断——§0 已经解释了这属于 A4a)。

### `gates.ts`(G1/G2/G3)

- `src/loop/gates.ts`(**新文件**):
  - 一个共用的内部工厂 `createGateNode(gate: GateType, buildPayload: (state) => Omit<GatePayload, "gate">, deriveFeedback: (state, resume: GateResumeValue) => string | undefined)`,返回一个节点函数,主体:
    1. `const payload: GatePayload = { gate, ...buildPayload(state) }`(一个纯函数,读 state 不产生副作用——**这一步在 resume 时会重新跑一遍**,这是 spike-findings.md Q3"一个不算 bug 但影响 `nodes/` 代码写法"的行为的直接应用——所以这一步绝不能有"发一次通知"/"写一条日志"这类不幂等的副作用)。
    2. `const resume = interrupt(payload) as GateResumeValue`(第一次调用真的在这里暂停;resume 时这一行直接返回外部 `Command({resume})` 调用传入的值,不会再次暂停——spike Q3 已经证实的行为)。
    3. 只有在 `interrupt()` **之后**才允许任何有副作用的操作:构造 `GateLogEntry`(`decidedAt: new Date().toISOString()`)。
    4. 返回该 gate 自己的决定字段(`g1Decision`/`g2Decision`/`g3Decision`,由三个具体 gate 各自调用 `createGateNode` 时单独指定,不是这个共用工厂猜的)+ `feedback: deriveFeedback(state, resume)` + `gateLog: [entry]`(`reducer` 是 `concat`,累加而不是覆盖)。
  - 三个具体 gate:
    - `createG1Node()` = `createGateNode("G1_SEND_TO_TESTER", (state) => ({ diffRef: state.coderOutput?.diff, question: "approve sending this diff to the tester?" }), (_state, resume) => resume.reasoningText)`(G1 拒绝时,反馈就是人当场给的理由——没有更多上下文可加)。
    - `createG2Node()` = `createGateNode("G2_SEND_TO_FIX", (state) => ({ issues: state.testerOutput?.issues, question: "approve sending the tester's findings back to the coder for a fix?" }), (state, resume) => [state.testerOutput?.issues?.join("; "), resume.reasoningText].filter((s): s is string => Boolean(s)).join("\n\n"))`(G2 一旦批准,coder 真正需要看到的**主要是 tester 的问题列表**——人的 `reasoningText` 是补充,不是替代——如果这里只用 `resume.reasoningText`,coder 会完全看不到 tester 实际说了什么,意味着 gate 批准了但反馈没传到——这是一个真实的功能缺口,不是我在过度设计)。
    - `createG3Node()` = `createGateNode("G3_FINAL_MERGE", (state) => ({ diffRef: state.coderOutput?.diff, question: "final sign-off: apply this diff?" }), (_state, resume) => resume.reasoningText)`。
  - 三个路由函数(给 `graph.ts` 的 `addConditionalEdges` 用):
    - `routeAfterG1(state): "review" | "draft"` —— `"approved"` → `"review"`;`"rejected"` → `"draft"`;其他值理论上已经被类型系统排除,但仍有一个运行时的 `default: throw` 兜底(不是悄悄吞掉)。
    - `routeAfterReview(state): "g3" | "g2"` —— `state.testerOutput.verdict === "pass"` → `"g3"`;`"reject"` → `"g2"`。
    - `routeAfterG2(state): "draft"` —— `state.g2Decision === "approved"` → `"draft"`;其他任何值(包括 `"rejected"` —— §2 Non-goals 已经解释了为什么 A4a 刻意不给它路由目标)→ 抛 `UnhandledGateDecisionError("G2_SEND_TO_FIX", state.g2Decision ?? "undefined")`。
    - `routeAfterG3(state): "apply" | "draft"` —— `"approved"` → `"apply"`;`"rejected"` → `"draft"`。

### `checkpoint.ts`

- `src/loop/checkpoint.ts`(**新文件**):
  - `createSqliteCheckpointer(dbPath: string): SqliteSaver` —— 就是 `SqliteSaver.fromConnString(dbPath)`(spike Q4 证实的用法);这层薄包装存在的唯一理由是让 `graph.ts`/测试代码都从这一个函数拿 checkpointer,而不是各自分别导入 `@langchain/langgraph-checkpoint-sqlite`。
  - **不做**:一个等价的 `MemorySaver` 包装——A4a 的图永远默认用 `SqliteSaver`(哪怕在测试场景里,也是指向一个临时文件),不提供"纯内存、进程一退出就丢"的选项,因为"能不能从外部续跑"是 G1/G2/G3 这几个 gate 存在的整个意义的一部分(§8 验收标准明确要求)——提供一个默认会丢状态的选项,未来的开发者太容易误用。

### `graph.ts`

- `src/loop/graph.ts`(**新文件**):
  - `buildLoopGraph(deps: { router: ProviderRouter; composer: PromptComposer }): StateGraph<...>`(未编译的图,纯结构):
    - `addNode(LOOP_NODES.draft, createDraftNode(deps))`
    - `addNode(LOOP_NODES.g1, createG1Node())`
    - `addNode(LOOP_NODES.review, createReviewNode(deps))`
    - `addNode(LOOP_NODES.g2, createG2Node())`
    - `addNode(LOOP_NODES.g3, createG3Node())`
    - `addNode(LOOP_NODES.apply, applyNode)`(见下——一个不导出的、graph.ts 内部的小函数,不值得单独开一个 `nodes/apply.ts` 文件——DESIGN §6 的文件清单也没列——和 §2 Non-goals"Apply 只终止状态"一致,简单到不需要专门开文件)
    - `addEdge(START, LOOP_NODES.draft)`
    - `addEdge(LOOP_NODES.draft, LOOP_NODES.g1)`
    - `addEdge(LOOP_NODES.g1, LOOP_NODES.review)` **不该**写成一条普通边——上面的 `addConditionalEdges` 已经覆盖了目标集合 `{review, draft}`,这里不要再加一条多余的 `addEdge`(第一次写代码时容易犯的错——PRD 提前标出来)。
    - `addConditionalEdges(LOOP_NODES.g1, routeAfterG1)`
    - `addConditionalEdges(LOOP_NODES.review, routeAfterReview)`
    - `addConditionalEdges(LOOP_NODES.g2, routeAfterG2)`
    - `addConditionalEdges(LOOP_NODES.g3, routeAfterG3)`
    - `addEdge(LOOP_NODES.apply, END)`
  - `applyNode(state): Partial<LoopStateType>` —— 一个内部函数,`return { applied: true }`,不读写文件系统(§2 Non-goals)。
  - `compileLoopGraph(graph, checkpointer): CompiledGraph` —— `graph.compile({ checkpointer })`,一层薄包装,存在的唯一理由是让每个调用点(测试 + 未来的 A5)都走这一个函数,而不是各自重复 `.compile({...})`。
  - **对实现顺序的硬性要求(呼应 spike 建议 #3)**:`addConditionalEdges` 是本 PRD 里唯一一个 spike 完全没验证过的 LangGraph 机制(spike 的 5 个 Q 要么是线性图,要么是单个 `interrupt`,没有一个用了条件边)。§6 的批次拆分把"先用玩具节点验证 `addConditionalEdges` 能不能正确按返回值路由"放在最早的一批(B3 开头),而不是留到最后才发现问题。

### 依赖 / 打包

- `package.json`:**本次增量不新增任何依赖**——`@langchain/langgraph@1.4.8`/`@langchain/langgraph-checkpoint-sqlite@1.0.3` 在 spike 阶段就已经装好了(`package.json`/`pnpm-lock.yaml` 已经有对应改动,会随本 PRD 一起 commit——见 PRD 开头的说明)。

### 测试(和上面逐文件任务一一对应)

**测试策略(三层边界,延续 A2/A3 已经建立的"真实但受控"理念)**:
1. `gates.ts`/`graph.ts` 自己的图结构/gate 测试 —— **玩具节点**(仿照 spike Q2/Q3 的做法:节点直接返回假数据,不调真实 adapter),用 `MemorySaver` 当 checkpointer(不需要真实磁盘,这一层只验证图本身的路由逻辑是不是对的)。这一层专门清零 `addConditionalEdges` 的风险,验证 G1-reject-回-draft / G2-approve-回-draft / G3-reject-回-draft 这些回环边真的存在、真的被跑到过。
2. `nodes/coder.ts`/`nodes/tester.ts` 的单元测试 —— 不需要真实子进程,用一个手写的 `FakeAdapter`(仿照 A2 的 `harness.e2e.test.ts` 已经用过的做法:`implements ModelAdapter`,`invoke()` 直接返回一个预设的 `InvokeResult`)+ 真实的 `ProviderRouter`(配一个把 `"coder"`/`"tester"` 绑到这个 `FakeAdapter` 的 `AdapterRegistry`)+ 真实的 `PromptComposer`。这一层验证"节点函数正确调用了 composer/router/validator,正确处理了 feedback 拼接和 rejectCount 递增"——不需要真的起任何进程。
3. `checkpoint.ts` 的"不是闭包持有状态"测试 —— 用 B3 建的**真实** `graph.ts`(不是玩具图)+ 上面的 `FakeAdapter` 节点依赖 + 一个真实的 `SqliteSaver`(指向 `fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-loop-"))` 建的临时目录里的真实文件)。第一阶段:构造一个已编译图实例,`invoke()` 到 G1 中断,记下 `thread_id`;**显式丢弃这个已编译图对象和它的 checkpointer 实例**(不保留任何引用);第二阶段:重新 `createSqliteCheckpointer(同一个 db 路径)` + 重新 `compileLoopGraph()` 构造一个**全新**的已编译图对象,用同一个 `thread_id` 的 `threadConfig` 调 `getState()`(断言读回的待处理中断和第一阶段一致)+ `Command({resume})` 续跑到完成。这证明 resume 靠的是磁盘上的 checkpoint,不是某个还活在 JS 进程里的变量——不需要像 spike Q4 那样真的起两个 `node` 子进程(理由见 §9.1)。
4. 纵切 e2e —— 真实 `MemoryStore`/`ContextInjector`/`PromptComposer`/`buildAdapterRegistry`/`ProviderRouter`/一个真实的 cli-bridge adapter(受控 fixture 子进程)/一个真实的 `SchemaValidator`/一个真实的图/一个真实的 `SqliteSaver`。**这一层不再重复验证一次"不是闭包持有状态"**(第 3 层已经证实过这个机制——e2e 层的价值在于证明"这张图和真实 harness 栈端到端接通了,不是玩具/FakeAdapter");从头跑到 Apply 的一个已编译图实例就够了。

- `src/loop/__tests__/types.test.ts`:轻量级——`LoopState` 的 `Annotation.Root` 能被 `new StateGraph()` 接受(一个纯类型/构造冒烟测试,不是业务逻辑测试)。
- `src/loop/__tests__/workflow-def.test.ts`:`CODER_TESTER_LOOP_DEFINITION.nodes` 和 `LOOP_NODES` 的所有值一一对应(防止手动加节点时两边漂移)。
- `src/loop/nodes/__tests__/coder.test.ts`:① 正常路径(没有 feedback)→ `composer.compose` 收到的任务就是原始任务,`coderOutput`/`coderResult` 被正确设置;② 设了 `state.feedback` → 任务文本包含"上一轮的反馈" + 原始反馈文本;③ 返回的 `feedback` 被清空为 `undefined`;④ `FakeAdapter` 连续两次返回不合 `CoderOutput` schema 的内容 → `SchemaValidationError` 从节点函数里抛出(不是被吞掉)。
- `src/loop/nodes/__tests__/tester.test.ts`:① 正常路径,任务文本包含 diff 和 claims;② `testerOutput.verdict === "reject"` → 返回的 `rejectCount` 是 `state.rejectCount + 1`;③ `verdict === "pass"` → `rejectCount` 不变;④ 缺失 `state.coderOutput` → 抛一个清晰的 `Error`(不是裸的 `undefined.diff`)。
- `src/loop/__tests__/gates.test.ts`:① 每个 gate(G1/G2/G3)在 `interrupt()` 之后不会再次暂停,`Command({resume})` 能正确恢复它(仿照 spike Q3);② G1/G3 拒绝 → state 里对应的 `gN Decision` 字段是 `"rejected"`;③ G2 批准 → `feedback` 字段包含 tester 的 issues 文本;④ `gateLog` 正确累加(同一个 gate 多次经过会产生多条 `gateLog` 条目,不是只保留最后一条)。
- `src/loop/__tests__/graph.test.ts`(玩具节点 + `MemorySaver`,专门清零 `addConditionalEdges` 的风险):① happy path 走一遍:draft→g1(approve)→review(pass)→g3(approve)→apply→END;② G1 拒绝一次再批准:draft→g1(reject)→draft→g1(approve)→review→...;③ tester 送回一次后 G2 批准:...→review(reject)→g2(approve)→draft→review(pass)→...(验证 `rejectCount` 真的变成 1,图真的回到 draft 重新跑一遍——不是卡住或走错节点);④ G3 拒绝一次:...→g3(reject)→draft→...;⑤ G2 收到 `"approved"` 之外的决定 → 抛 `UnhandledGateDecisionError`(直接验证 §2 Non-goals 的硬约束"G2 没有第二条出边",不只是文档里说说)。
- `src/loop/__tests__/checkpoint.test.ts`:见上面测试策略第 3 层的详细描述——两个阶段,真实文件,丢弃第一阶段的所有对象引用,再用全新实例 resume。

### 纵切(A4a 的收尾,硬交付物)

- `src/loop.e2e.test.ts`(顶层文件,命名对齐已有的 `harness.e2e.test.ts`/`harness-cli.e2e.test.ts` 放置惯例):
  1. 真实 `MemoryStore`+`ContextInjector` 产出 `injectedContext`(照搬 `harness-cli.e2e.test.ts` 已用过的搭建方式)。
  2. 真实 `PromptComposer`(`personasDir` 指向 `profiles/subscription/personas`,和 A3 的 e2e 测试一致)。
  3. 一个内存态的 fixture `ProfileConfig`:`roles: { coder: { provider: "claude-cli" }, tester: { provider: "codex-cli" } }`(**对齐 `profiles/subscription/config.yaml` 里真实的角色绑定**,不是随便选的——DESIGN §7 的表格明确写着"coder: claude-cli / tester: codex-cli";如果这个纵切把角色绑反了,不会报错,但语义是错的——像 `config.test.ts` 这样的结构性测试抓不到这类问题,只有对齐真实配置才能防住),两个 `providers` 的 cli-bridge 条目都用 `bin` 把 spawn 目标覆盖成指向 fixture 脚本(A3 已经建立的 `cmd`(flavor,不变)+ `bin`(spawn 目标覆盖)模式)。
  4. 真实 `buildAdapterRegistry(fixtureConfig)` → 真实 `ProviderRouter`。
  5. `createSqliteCheckpointer()` 指向一个临时文件(和 `checkpoint.test.ts` 一样的临时目录做法)。
  6. `compileLoopGraph(buildLoopGraph({ router, composer }), checkpointer)`。
  7. 第一次 `invoke({ task, injectedContext, ... 其余字段用默认值 })` → 应该停在 G1(`__interrupt__` 非空,`state.next` 是 `["g1"]`)。
  8. `Command({ resume: { decision: "approved" } })` 续跑 → 应该停在 G3(tester 跑完,verdict pass,`state.next` 是 `["g3"]`)。
  9. 再一次 `Command({ resume: { decision: "approved" } })` 续跑 → 跑到完成,`state.values.applied === true`。
  10. 断言:全程 fixture 脚本是 adapter 唯一用过的 spawn 目标(测试本身通过 `bin` 字段就能保证,不需要额外的 spy);`coderOutput`/`testerOutput` 是经过 schema 校验的类型化结果,不是原始 JSON;`coderResult.provider === "claude-cli"`,`testerResult.provider === "codex-cli"`(验证角色↔adapter 绑定真的对);G1/G3 各自都有一条 `decision === "approved"` 的 `gateLog` 条目。
  - **需要新增的 fixture 场景**:复用 A3 已有的 `fake-claude.fixture.mjs`(coder 角色用)/ `fake-codex.fixture.mjs`(tester 角色用)——如果这两个文件已经有一个场景恰好能产出"schema 合法 + 语义上这个纵切需要"的输出(coder 侧需要非空 diff + 至少一条 claim;tester 侧需要 `verdict: "pass"`),直接复用现有场景;如果没有精确匹配的,各自遵循 A3 B3/B4 已经建立的"加一个新 `case` 分支,不复制一整个新文件"的模式。本 PRD 不锁定具体场景名(那是 build 阶段的实现细节,不影响验收标准)。

## 6. 批次拆分

> 单位延续 A0-A3 PRD 同款自定义尺度:`[S]` ≈ 2-4h,`[M]` ≈ 半天到一天,`[L]` ≈ 1-2 天。单分支 `feature/issue-13-a4a-loop`,按 §6 顺序依次 commit(理由同 A0-A3)。批次顺序参考 spike-findings.md"对 A4a PRD 的建议 #4",按本 PRD §0 定的实际 A4a 范围调整(包含 G2/G3 完整的正常分支,不只是最简单的单条路径)。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `src/loop/types.ts` + `errors.ts` + `workflow-def.ts`(类型/命名骨架,包括 `LoopState` 的 `Annotation.Root` 定义——LangGraph TS 类型推导用法的第一次实测) | 无(起点) | [S] |
| **B1** | `src/loop/nodes/coder.ts` + `nodes/tester.ts` + 单元测试(`FakeAdapter`,不需要真实子进程) | B0 | [M] |
| **B2** | `src/loop/gates.ts` + `gates.test.ts`(玩具节点,验证 `interrupt()`/`Command({resume})`,包括 §5 描述的三个 gate + feedback 推导逻辑) | B0 | [M] |
| **B3** | `src/loop/graph.ts` + `graph.test.ts`(玩具节点 + `MemorySaver`,**第一件事是验证 `addConditionalEdges`**,然后建出完整状态机,包括 G1/G2/G3 各自的正常回环边——本次增量真正的技术风险点) | B1+B2 | [L] |
| **B4** | `src/loop/checkpoint.ts` + `checkpoint.test.ts`(真实 `SqliteSaver` + 真实图 + `FakeAdapter` 节点,"不是闭包持有状态"两阶段测试) | B3 | [M] |
| **B5** | 纵切 `src/loop.e2e.test.ts`(真实 cli-bridge adapter + fixture 子进程 + 真实图 + 真实 checkpointer,完整 happy-path 链路) | B4 | [L] |
| **B6** | 回写文档(`docs/ROADMAP.md` 的 A4 那一行拆成 A4a-done/A4b-pending 两行 / `docs/PROGRESS.md` 清空 / `CHANGELOG.md` 加条目 / 根 `CLAUDE.md` 目录结构那一行更新反映 loop 已建好 / `CHARTS/knowledge/aeloop.md`(ai-agent 仓库)新增一个 `src/loop/` 模块条目——职责/对外接口/依赖/关键文件路径,都能追溯回本次增量的真实代码) | B5 | [S] |

**依赖图说明**:B1(coder/tester 节点)和 B2(gates)互相独立——理论上可以并行,因为两者都只依赖 B0 的类型——但因为是同一个 Cypher 依次实现,不为此单独拆分支。B3 是本次增量的技术风险核心,必须等 B1+B2 都完成(节点函数和 gate 节点都得真实存在,`graph.ts` 才能把它们接起来)。B4/B5 对它们前面的图结构有严格的顺序依赖。

## 7. 分支策略

单分支 `feature/issue-13-a4a-loop`(spike 已经在上面),按 §6 顺序批次提交,理由同 A0-A3 PRD:一个人依次实现,大多数批次间依赖都是真实存在的。如果指挥官想让 Zorro 分阶段审,自然的断点是"B0-B2(types+nodes+gates,机制单元)/ B3-B4(图结构+checkpoint,风险核心)/ B5-B6(纵切+文档)"——`addConditionalEdges` 是本次增量里唯一一个 spike 从未去风险过的机制,如果要分阶段审,B3 一完成就单独请求一次审查可能比等到最后才审更值——这个判断留给指挥官。

## 8. 可测验收标准(可打勾)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess`,无错误),`pnpm lint`(`tsc --noEmit`)同样干净——包括 spike Q5 发现的 `Command` 泛型坑:`src/loop/` 下每个 `new Command({resume: ...})` 都显式标注全部三个泛型参数,第三个引用自 `types.ts` 的 `LoopNodeName`,不是散落各处的字面量联合。
- [ ] `pnpm test` 全绿(vitest run),新增的所有 A4a 测试文件都算在内,并且产生零真实网络/零真实 CLI 调用(沿用 A3 已用过的检查技巧:`grep` 确认没有测试文件直接 spawn 真实的 `claude`/`codex` 二进制)。
- [ ] **`graph.ts` 真的能编译、真的能跑**:`buildLoopGraph()`+`compileLoopGraph()` 产出的已编译图能被 `invoke()`,`addConditionalEdges` 的每条分支(G1 approve/reject、review pass/reject、G2 approve、G3 approve/reject)都各自被一个测试(`graph.test.ts`)单独跑到——不只是 happy path。
- [ ] **G1/G2/G3 gate 真的能暂停,真的能从外部一次全新调用恢复**:`checkpoint.test.ts` 证明这一点——第一阶段构造的 compiled-graph/checkpointer 对象被显式丢弃后,第二阶段用一个全新实例(同一个 `thread_id`,同一个磁盘 db 路径),能读回和第一阶段中断一致的 `__interrupt__` payload,并能用 `Command({resume})` 续跑到完成。
- [ ] **coder/tester 节点复用 A2/A3,不重造模型调用**:除了 `../../prompt/composer.js`/`../../harness/provider-router.js`/`../../harness/schema-validator.js`/`../../prompt/schema.js`,`nodes/coder.ts`/`nodes/tester.ts` 不导入任何新的模型调用逻辑;`grep -rn "spawn\|fetch(" src/loop --include="*.ts"` 应该零命中(spawn/fetch 应该只出现在 `harness/` 层——`loop/` 层永远只能通过 `ProviderRouter`+`ModelAdapter` 接口间接触达它)。
- [ ] **纵切真的接通**:`loop.e2e.test.ts` 存在且通过——真实 Context→Prompt 链产出的 prompt,经过真实 `buildAdapterRegistry`(fixture 脚本代打)+ 真实 `ProviderRouter` + 真实已编译图(真实 `SqliteSaver`)+ 两次 `Command({resume})` 调用,跑完整条 happy path 到 `applied === true`,`coderResult.provider`/`testerResult.provider` 分别是 `"claude-cli"`/`"codex-cli"`(角色↔adapter 绑定和真实 `config.yaml` 一致)。
- [ ] **代码里避开了"interrupt 之前的副作用会重跑"这个坑**:`gates.ts` 里 `interrupt()` 调用之前的代码(payload 构造)是纯函数,`GateLogEntry` 构造只发生在 `interrupt()` 返回之后——可通过代码审查验证;`gates.test.ts` 里"同一个 gate 经历多次 approve/reject 循环,产生符合预期的日志条目数而不是重复条目"的测试间接验证了这一点。
- [ ] **`rejectCount` 在正确的点递增,G2 在没有路由时 fail loud**:`tester.test.ts`/`graph.test.ts` 分别在节点层和图层验证 `rejectCount` 只在 `verdict === "reject"` 时递增 1;`graph.test.ts` 有一个测试证明 `routeAfterG2` 在收到 `"rejected"` 时抛 `UnhandledGateDecisionError`,而不是悄悄落到某个不该到的节点上。
- [ ] `docs/ROADMAP.md` 的 A4 那一行拆成 A4a(已勾选)/ A4b(待办)两行,`docs/PROGRESS.md` 清空或更新,`CHANGELOG.md` 加条目,根 `CLAUDE.md` 目录结构那一行同步,`CHARTS/knowledge/aeloop.md`(ai-agent 仓库)新增一个 `src/loop/` 模块条目。

## 9. 依赖 / 风险 / 待定问题

### 9.1 证明 checkpoint"不是闭包持有状态":同进程两阶段 vs. spike Q4 的真实跨进程——建议采用同进程两阶段

派工指示的原话是"不一定要跨进程,但必须证明 resume 不是靠闭包持有的状态"——本 PRD §5/§6 选择"在同一个测试文件内,构造两个结构上独立的 compiled-graph+checkpointer 实例,用完第一个就显式丢弃"的同进程做法,而不是照搬 spike Q4 用 `child_process` 起两个独立 `node` 子进程的做法。**理由**:spike Q4 已经在 issue #13 的 pre-issue 阶段真正证明过一次"真实跨进程"(pid 27363→pid 27564,零共享内存)——A4a 不需要在每一个批次里重新证明"LangGraph 的 checkpoint 机制本身可信"这个已经有证据的事实;A4a 测试套件真正需要防的是"aeloop 自己的 `checkpoint.ts`/`graph.ts` 是不是不小心引入了某种进程内单例/缓存,让 resume 看起来能用,实际上偷偷依赖第一次 `invoke()` 留下的某个变量"——同进程两阶段(显式丢弃引用 + 构造全新实例)同样能抓到这个问题,而真的起子进程会为了重新验证一个已经验证过的东西,引入额外的测试基础设施复杂度(子进程编排、跨进程日志收集、CI 环境子进程权限)。**如果指挥官认为"一次全新的外部调用"必须字面意义上是一个新的 `node` 进程才算数,请直接说,我会按 spike Q4 的模式重做这个测试。**

### 9.2 §5 里几处"不是直接 spike 证据、是我自己的设计判断"的汇总——请逐条确认

以下每一条的理由都已经在 §5 对应位置详细写过;这里只是方便快速过一遍,不重复全文:
1. G2 只处理 `"approved"`;`"rejected"`/其他任何值抛 `UnhandledGateDecisionError`(§2 Non-goals)。
2. `GatePayload.diffRef` 在 A4a 阶段实际内联的是 diff 全文,没有"哈希/路径"那层间接(§5 types.ts)。
3. `gateLog` 确实会随 `SqliteSaver` checkpoint 一起落盘(LangGraph 自己的 checkpoint 表),但 A4a 不会把它写进 A4b 建的 `approvals` 业务表——这才是 A4a/A4b 真正的边界,不是"只在内存里,进程一退出就没了"(Zorro R1 M1 修正,§4)。
4. `workflow-def.ts` 的 `CODER_TESTER_LOOP_DEFINITION` 本质是文档,不是 `graph.ts` 在运行时解释的配置;不创建 `workflows/coder-tester-loop.json`(§5 workflow-def.ts——这是对 DESIGN §6 原文的一个缩水解读,相对风险最高,也最需要确认)。
5. `Apply` 节点不写文件系统,只终止状态(§0/§2)。
6. 证明 checkpoint"不是闭包持有状态"用的是同进程两阶段,而不是真正的跨进程(§9.1)。

### 9.3 `LoopState` 的 LangGraph TS 类型推导用法——spike 没覆盖,B0 会第一个碰到

spike 的 Q2/Q3/Q4 脚本都是纯 `.mjs`(或弱类型的 `.ts`),节点函数直接内联写在 `new StateGraph(State).addNode("x", fn)` 链式调用里——没有一个需要"先声明一个可复用的节点函数类型签名,再传给 `addNode`"这种用法(而这正是 A4a 的 `nodes/coder.ts`/`gates.ts` 需要的——节点函数需要能独立导出、独立单元测试)。这不是设计缺陷,是 spike 的 5 个 Q 单纯没覆盖到的一个 TS 类型工程细节;B0 第一次真的把 `LoopState`(`Annotation.Root`)推导出的类型喂给一个独立声明的节点函数签名时,很可能会碰到一个需要摸索的类型写法——本 PRD 不提前精确锁定它;这个风险已经通过在 §6 批次拆分里把 B0 做成一个独立、小、最先的批次来收敛了。

---

**眼下没有新的岔路口需要指挥官现在拍板才能解锁开工**——§9.2 汇总的 6 项每一项在本 PRD 里都已经有一个倾向性结论和写清楚的理由,可以按这些结论先开工;如果指挥官/军师不同意其中任何一条,随时可以纠正——不需要等全部确认完才能开始 B0。

## 10. 项目约束核对

- **模型无关?** 是——`nodes/coder.ts`/`nodes/tester.ts` 只依赖 `ProviderRouter`/`ModelAdapter` 接口,不知道背后的 adapter 是 `ClaudeCliAdapter`/`CodexCliAdapter`/`LiteLLMAdapter` 中的哪一个。
- **没有跨层反向依赖?** 是——`src/loop/*.ts` 只从 `harness/`(`ProviderRouter`/`SchemaValidator`/类型)、`prompt/`(`PromptComposer`/schema)、`context/`(只导入类型——`ContextInjectionResult`——从不导入 `ContextInjector` 类本身,因为注入发生在图外,§4/§5 已经解释过)导入;不存在 `src/harness/`/`src/context/`/`src/prompt/` 反过来导入 `src/loop/` 的情况(build 后,`grep -rln "from.*loop" src/harness src/context src/prompt` 应该零命中)。
- **角色没有硬编码?** 部分——`nodes/coder.ts`/`gates.ts` 里的 `"coder"`/`"tester"` 字符串是**本次增量里唯一合理允许硬编码角色名的地方**:DESIGN §1.7"不要硬编码 `{coder,tester}`"指的是 persona/schema **查找机制**本身需要按名字动态查(A1/A2 已经是这样——`schema-registry.ts`/`personas.ts` 都是按 `role` 参数动态查,不是用 switch 语句)——不是说"这一个内置的 coder-tester workflow 定义本身连 coder/tester 这两个词都不能提"——`CODER_TESTER_LOOP_DEFINITION`/`nodes/coder.ts`/`nodes/tester.ts` 本质上就是关于这两个具体角色的具体节点,这和"新增一个角色需不需要改 `composer.ts`"是不同的问题(那个问题的答案仍然是"不需要",因为查找机制本身是动态的)。
- **`profiles/apikey/` 不进本仓库?** 是——本次增量不创建/修改任何 `profiles/apikey/` 下的文件。
- **引擎代码不含 Helix persona?** 是——`src/loop/` 下所有新代码零 Helix/companion/个人记忆内容。
- **远控点火(`CLAUDE.md` 规则)?** 是——见 §5 测试策略小节;每个测试(从单元测试到纵切)全程走玩具节点/`FakeAdapter`/受控 fixture 子进程,不产生任何对真实 `claude`/`codex` 二进制或网络的调用。
