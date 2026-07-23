# PRD — aeloop:事件系统(LoopEvent + EventEmitter)—— 引擎的公开可观测性 API

> 防幻觉:`[?]` = 我未验证 / 需指挥官确认;不编造接口/版本/参数。下面每一条关于既有代码的陈述都来自我本人对这个 worktree HEAD(`8a7c2a7`)上 `src/loop/{runner,types,gates,escalation,workflow-def,audit-store}.ts` + `src/loop/nodes/{coder,tester}.ts` + `docs/DESIGN.md` 的亲自阅读,不是凭记忆。每一条关于 LangGraph 自身运行时行为的陈述(§4)都来自 `docs/feature/events-observability/spike-node-start.md`—— 一次真实、已安装(`pnpm install`)、针对 `node_modules/@langchain/langgraph@1.4.8` 真实源码可运行的 spike,不是凭对 LangGraph 文档的记忆。没有直接指示、由我自行做出的判断调用,在 §9 明确标出,不混进"已验证"的陈述里。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-29-events`
- **优先级**:P1
- **状态**:等指挥官确认
- **最后更新**:2026-07-21(rev. 2,+ Zorro R1/R2 复审驱动的实现修复:§9.6 的 `emitProgressEvents` 节奏风险,发现还需要绑定到*那次因果性*的 chunk 上——而不是任意一次 `"updates"` 迭代——才能避免 `gate_requested`/`run_completed`/`run_cancelled` 重复/错序;`safeErrorReason()` 加固;新增 §9.9 已知限制。这些相对 PRD 层面没有设计变更——都是已定盘方案内的实现层修复;完整逐轮记录见 `progress.md`。)
- **关联 issue**:[elishawong/aeloop#29](https://github.com/elishawong/aeloop/issues/29)
- **设计权威**:issue #29 正文(事件目录草案 + 3 个设计决策提问)+ 真实代码 `src/loop/runner.ts`(`runStreamAndPersist`/`computeRunProgress`/`startRun`/`resumeRun`)+ `src/loop/gates.ts`/`escalation.ts`(graph-node 零 I/O 纯净性不变量)+ `src/loop/nodes/{coder,tester}.ts` + `src/loop/workflow-def.ts`(`LOOP_NODES`/`GATE_TYPES`)+ `docs/feature/events-observability/spike-node-start.md`(rev. 2 自己对 `@langchain/langgraph@1.4.8` 真实 `streamMode` 行为的实证 spike)

---

## Rev. 2 变更日志(这份 PRD 初稿写完后为什么又改了)

Rev. 1 上线的是 `node_entered`/`agent_completed`,语义是**完成时**(在节点真实工作已经结束后才触发),因为 `runner.ts` 唯一用到的 `streamMode: "updates"` 结构上就不可能产出一个执行前信号,而给节点体打桩来拿到这个信号会破坏 `gates.ts`/`nodes/*.ts` 必须遵守的零 I/O 纯净性不变量。Rev. 1 把这一点标成 `[?]`/待定,未安装未验证。

指挥官选择了 **方案 C:真正的"节点即将开始"语义**,明确接受这可能需要越过纯净性边界的风险,并要求(按 aeloop 的 A4a 先例)先跑 spike 再继续动这份 PRD。那次 spike(`spike-node-start.md`)真的跑了 `pnpm install`,然后实证 + 源码核实了 **`streamMode: ["updates", "tasks"]`**——一个 LangGraph 既有的、有文档记载但 `runner.ts` 从未用过的特性——能给出一个真正的执行前("task 即将运行")事件,且**对任何节点体零改动**。破坏纯净性的兜底方案从始至终都不需要。本轮修订:
- 新增一个事件类型,**`node_started`**(共 11 种事件类型,原来是 10 种)。
- 把 `node_entered` 改名为 **`node_completed`**(和 rev. 1 一样是完成时语义,作为独立、有用的事件保留——没有被移除)。
- **移除 rev. 1 里"`node_entered` 排除 gate 节点"的特殊处理**——现在 `node_started`/`node_completed` 分别来自一套统一机制(依次是 `"tasks"` 模式 / `"updates"` 模式),对每种节点类型都零额外成本,所以对**全部 8 个**真实节点名(`draft`/`g1`/`review`/`g2`/`g3`/`apply`/`escalation`/`cancel`)都触发,`gate_requested`/`gate_decided`/`agent_completed` 作为更具体的事件叠加在对应节点上——比 rev. 1 更干净、更对称的模型。
- 新增一个真实的实现风险:`runStreamAndPersist()` 的外层循环必须从消费裸 `chunk` 对象改成消费 `[mode, payload]` 元组,而 `computeRunProgress()`/`audit.updateRunProgress()` 必须**只**在 `mode==="updates"` 的迭代上跑(不能在 `"tasks"` 迭代上跑),否则会悄悄让 `AuditStore` 的写入/读取翻倍(spike §5)。

---

## 0. 范围

**范围内(按 issue #29 明确划定的边界)**:定义 `LoopEvent`(一个判别式联合类型)+ 一个 `LoopEventEmitter` 类 + 在 `runner.ts` 内正确的位置调用 emit,让外部调用方能订阅一条实时事件流,了解引擎正在做什么。

**范围外(issue #29 明确的非目标,已对照 issue 正文核实)**:`EventProjector` / SQLite 事件投影。那是这条事件流的一个*消费者*(未来的、独立的 issue)——这份 PRD 不创建 projector,不新增任何表,不动 `audit-store.ts` 的 schema。

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:今天引擎只有两种方式观察一次 loop run,都不是真正的实时事件流。(1)`state.gateLog: GateLogEntry[]`(`src/loop/types.ts:156`,一个 `concat`-reducer Annotation)只有在调用返回后读 `getState()`/`RunHandle` 才会有内容——它是一份**回顾性**日志,不是推送通知,而且只覆盖 gate 决策,不覆盖 draft/review/apply/cancel 活动。(2)`runner.ts` 的 `runStreamAndPersist()`(第 309-480 行)私下解析 `compiled.stream(..., {streamMode:"updates"})` 的 chunk 并直接写 `AuditStore`(`insertStepMarker`/`insertClaim`/`insertApproval`/`updateRunProgress`)——这是实时的,但是**runner 内部私有、写死的**:`runner.ts` 之外没有任何东西能订阅它,今天"观察进度"的唯一办法是从另一个进程轮询 `AuditStore` 的表。在这个 worktree 上跑 `grep -rn "EventEmitter\|LoopEvent\|emit(" src/` 什么都不返回——代码库里根本没有事件词汇表。
- **给谁用**:**#22 A5 CLI/TUI**(想渲染实时进度——包括节点一开始就出现的"coder is working..."转圈,而不是等它结束后才知道——而不是轮询 `workflow_runs`/`structured_claims`/`approvals`);未来的 **EventProjector**(从 Verity 借鉴的持久化落点——变成一个订阅者,而不是 `runner.ts` 直接写 SQL,留给后续 issue);**#2 Conductor**(想靠 `gate_requested` 驱动人工批准的交互体验)。
- **一句话方案**:新增 `src/loop/events.ts`,定义 `LoopEvent`(11 种具体事件类型,归到一个判别式联合类型下)+ `LoopEventEmitter`(subscribe/unsubscribe + 同步、异常隔离的 `emit()`);`runner.ts` 的 `StartRunDeps` 新增一个**可选**的 `events?: LoopEventEmitter` 字段,`runStreamAndPersist()`/`startRun()`/`resumeRun()` 触发这 11 种事件类型——包括一个真正的执行前 `node_started`,源自 LangGraph 自身的 `streamMode: "tasks"` 打桩(spike 已验证,§4)——触发点都来自该文件今天**已经算出**的数据,外加这一个新的 `streamMode` 值。不改 `gates.ts`/`escalation.ts`/`nodes/*.ts`/`audit-store.ts`,所以"graph 节点/gate 保持零 I/O 纯净"这条不变量(`runner.ts` 自己文件头,第 1-10 行:`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 必须继续返回空)完好未动,依然成立。

---

## 2. 目标 / 非目标

**目标**:
- `src/loop/events.ts`(新):`LoopEvent` 判别式联合类型(**11** 个成员,见 §4)、`LoopEventListener` 类型、`LoopEventEmitter` 类(`on()`/`emit()`)、同步 emit 且每个 listener 独立异常隔离(§9 决策 3)。
- `src/loop/runner.ts`(改动):`StartRunDeps.events?: LoopEventEmitter`(可选——见 §9 决策 1);`runStreamAndPersist()` 的 `compiled.stream()` 调用从 `streamMode: "updates"` 换成 `streamMode: ["updates", "tasks"]`(spike 已验证,不影响纯净性);`startRun()` 触发 `run_started`;`runStreamAndPersist()`(因而 `startRun()`/`resumeRun()` 都是)在 §4 表格里给出的确切位置触发其余 10 种事件类型。
- 每个事件都携带该 run 的身份信息(`runId`、`threadId`)+ `ts`(ISO 时间戳)作为公共字段,外加一个 `type` 判别字段 + 类型特定的 payload 字段。
- `node_started`/`node_completed` 对**全部 8 个**真实节点名统一触发——不排除 gate 节点(rev. 1 有这个排除;rev. 2 移除了,见变更日志)。
- 一个抛异常(同步)或返回 rejected Promise(异步)的 listener 永远不会让 loop 崩溃,也永远不会影响 `AuditStore` 的持久化(§9 决策 3,有明确测试)。
- `computeRunProgress()`/`audit.updateRunProgress()` 的调用节奏被证明与今天完全一致(每个真实 `"updates"` chunk 一次,`"tasks"` chunk 上永远不调)——这是本轮新增的一条明确验收标准(§8)。

**非目标(明确列出,按 issue #29,相对 rev. 1 无变化)**:
- ❌ `EventProjector` / 任何新 SQLite 表 / 对 `audit-store.ts` schema 或方法的任何改动。事件是对既有 audit 写入的增量,不是替代(§9 决策 2)。
- ❌ 对 `gates.ts`/`escalation.ts`/`nodes/coder.ts`/`nodes/tester.ts`/`audit-store.ts`/`types.ts`/`workflow-def.ts` 的任何改动。全部十一处 emit 调用点都只活在 `runner.ts` 里——经 spike 确认可以不碰上述任何一个文件就做到(§9 决策 1 原本就标出这*正是* emitter 不能活在 graph 节点里的原因;spike 进一步确认 `node_started` 也不需要)。
- ❌ 任何这些事件的 CLI/TUI 消费方(那是 #22 的活——这份 PRD 只搭生产者这一侧)。
- ❌ 背压 / 异步排队 / 事件持久化 / 至少投递一次的保证。`emit()` 是发后不管、同步、仅进程内的。
- ❌ 让 `events` 成为 `StartRunDeps` 上的**必填**字段(理由与 rev. 1 一致——今天已有约 64 处调用点在构造 `StartRunDeps` 时没有 `events` 字段)。
- ❌ 声称 `node_started` 是一个数学上可证明的"绝对严格早于节点第一行代码执行"的保证——spike 发现了一个真实存在(且对这套系统里真实的异步节点来说实际可忽略不计)的 JS continuation 排序警告;见 §4.4。这份 PRD 交付这个事件时,文档注释里如实写出这个警告,而不是夸大机制实际提供的保证。

---

## 3. 用户故事

- 作为**未来的 A5 CLI/TUI**,我想在 coder/tester 节点真正开始工作的那一刻就收到 `node_started` 事件,这样我能立刻显示"coder is thinking..."而不是等一整轮彻底跑完才知道发生过(rev. 1 的 `node_entered` 做不到这一点——这正是指挥官要求做 rev. 2 的全部原因)。
- 作为**未来的 EventProjector**,我想要一条单一、稳定、类型化的事件流(而不是"反向工程 `runner.ts` 私有 stream-chunk 的形状")来构建一份 SQLite 投影。
- 作为**#2 Conductor**,我想要 `gate_requested` 事件(带上人类做决策所需的确切 `GatePayload`),这样我能驱动一套批准交互而不必轮询 `getState()`。
- 作为**指挥官**,我想要一个保证:一个有 bug/会抛异常的 listener 永远不能让一次 run 崩溃或污染既有的审计轨迹——由一个真实测试证明。
- 作为**指挥官**,我想要确认新增的第二个 `streamMode` 没有悄悄让 `AuditStore` 的读写频率翻倍——由一个真实测试证明,而不是只在注释里断言(本轮新增的风险,见 §5/§8)。

---

## 4. 事件目录(定稿,rev. 2)

### 4.0 公共信封(与 rev. 1 一致,无变化)

```typescript
interface LoopEventBase {
  runId: number;      // WorkflowRun.id (AuditStore)
  threadId: string;   // LangGraph thread id
  ts: string;          // new Date().toISOString(), stamped at emit time
}
```

### 4.1 机制:`streamMode: ["updates", "tasks"]`(spike 已验证——完整实证见 `spike-node-start.md`)

`runner.ts` 里的 `compiled.stream(input, {...cfg, streamMode: "updates" as const})`(当前第 330 行)会变成 `compiled.stream(input, {...cfg, streamMode: ["updates", "tasks"] as const})`。外层 `for await` 循环产出的值,形状会从一个裸 `chunk` 对象变成一个 `[mode, payload]` 元组:
- `mode === "updates"`:`payload` **和 `runner.ts` 今天已经在消费的形状逐字节一致**(`{[nodeName]: partialStateUpdate}`,外加 `__interrupt__` 这个 key)——这一点是 spike 实证确认的,不只是从类型推断出来的。今天全部 draft/review/gate/apply-cancel 分支逻辑,以及 `computeRunProgress()`/`updateRunProgress()`,都往下挪一层(用 `mode === "updates"` 挡住),**自身函数体零改动**。
- `mode === "tasks"`:`payload` 要么是**create**形状的对象(`"input" in payload`,出现在该节点自身函数体被 `PregelRunner.tick()` 调用**之前**——引擎层面的顺序,spike §2),要么是**result**形状的对象(`"result" in payload`,出现在之后)。只用到 create 形状(§4.2);result 形状用不上(节点完成这件事 `"updates"` 模式已经覆盖了)。

### 4.2 11 种事件类型

| # | `type` | 已验证的触发点(file:function) | Payload(除了 `runId`/`threadId`/`ts` 之外) | 是否已验证? |
|---|---|---|---|---|
| 1 | `run_started` | `runner.ts` `startRun()`,紧跟在 `deps.audit.insertRun(...)` 返回之后、`compileLoopGraph`/`runStreamAndPersist` **之前** | `task, profile, workflowDefId, rejectThreshold` | ✅ 对照真实 `startRun()` 函数体验证过 |
| 2 | **`node_started`**(**rev. 2 新增**) | `runStreamAndPersist()` 的逐元组循环,`mode === "tasks"` 分支,当 `"input" in payload`(create 形状)时——对**全部 8 个**真实节点名(`payload.name`)都触发,在该节点自身函数体被 `PregelRunner.tick()` 调用之前(spike §2 的源码级确认;spike §4 有关于*实测*时序的警告) | `node: LoopNodeName`(排除 `"__start__"`/`"__end__"`)、`stepRef?: string`(对 `nextStepRef()` 将为该节点下一轮分配的值做的一次**不产生副作用的预览**——见 §9.4;对 `apply`/`cancel` 是 `undefined`,因为这两个节点在整个代码库里没有计数器概念) | ✅ 机制已由 spike 验证;`["tasks", StreamTasksOutput]` 联合成员的确切 TS 收窄是一个构建期细节(§9.6) |
| 3 | `node_completed`(**从 rev. 1 的 `node_entered` 改名而来**,同样是完成时语义,现在覆盖全部 8 个节点而不只是 4 个) | 和 rev. 1 一样的 `mode === "updates"` 逐节点分支(draft/review 在它们既有的 `nextStepRef()` 调用点;gate 节点在既有的 `GATE_NODE_NAMES` 分支里;apply/cancel 通过 rev. 1 已经引入的同一个新 `else` 分支) | `node: LoopNodeName`、`stepRef?: string`(真实、已分配的值——和该轮 `agent_completed`/`gate_decided` 用的是同一个值;对 apply/cancel 是 `undefined`) | ✅ 对照真实代码验证过 |
| 4 | `agent_completed` | 和 rev. 1 一样的 draft/review 分支,嵌套在既有的 `if (update.coderOutput && update.coderResult)` / `if (update.testerOutput && update.testerResult)` guard 里 | `node: "draft"\|"review"`、`actor: "coder"\|"tester"`、`claimCount: number` | ✅ 已验证(与 rev. 1 一致,无变化) |
| 5 | `gate_requested` | **B1 修复后定稿**(Zorro R1;见 §9.6/§9.9)—— `computeRunProgress()`/`updateRunProgress()` 仍在每次 `mode === "updates"` 迭代上不变地运行,但这个事件的触发被绑定在 `interruptSeenThisChunk` 后面:只有当本次循环迭代刚处理的 chunk 恰好就是携带 `__interrupt__` key 的那个因果 chunk 时才触发——绝不会从零 chunk 的兜底分支(`if (!latestProgress)`)触发,那个分支只同步进度、从不触发事件。正是这一点让这个事件**每个 gate 恰好触发一次**,且总是在该 gate 自己的 `node_started` **之后**——原先"任何一次 `computeRunProgress()` 调用,只要 `progress.interrupt` 恰好为真就触发"的方案,正是 R1 发现在 LangGraph 的抢跑式执行下会重复/错序的地方,没有上线。 | `gate: GateType`、`payload: GatePayload` | ✅ 对照上线代码验证过 + 有回归测试(`runner.test.ts` 的精确计数/顺序断言,R1 两条专门的回归测试)——**不是**"与 rev. 1 一致无变化",这段触发逻辑正是 B1 重写的对象 |
| 6 | `gate_decided` | `GATE_NODE_NAMES` 分支,在 `audit.runInTransaction(...)` 返回之后(提交后),每条 `entry` 一次 | `gate: entry.gate`、`decision: entry.decision`、`decidedBy: decidedBy!` | ✅ 已验证(与 rev. 1 一致,无变化) |
| 7 | `tester_rejected` | 在 `review` 分支内部,当 `testerOutput.verdict === "reject"` | `rejectCount`、`rejectThreshold` | ✅ 已验证(与 rev. 1 一致,无变化) |
| 8 | `escalation_triggered` | 和 #7 同一个代码块,以 `rejectCount >= rejectThreshold` 为 guard | `rejectCount` | ✅ 已验证(与 rev. 1 一致,无变化) |
| 9 | `run_completed` | **B1 修复后定稿**(和第 5 行同一套机制)—— 绑定在 `terminalNodeSeenThisChunk` 后面:只有当本次循环刚处理的 chunk 本身就是 `apply`/`cancel` 节点自己的完成 chunk、且 `progress.patch.status === "completed"` 时才触发。绝不会从零 chunk 兜底分支触发。 | `currentState` | ✅ 对照上线代码验证过——**不是**"与 rev. 1 一致无变化",见第 5 行的说明 |
| 10 | `run_cancelled` | 和 #9 一样,绑定在同一个 `terminalNodeSeenThisChunk` 检查后面,`status === "cancelled"` | `currentState` | ✅ 对照上线代码验证过——**不是**"与 rev. 1 一致无变化",见第 5 行的说明 |
| 11 | `run_failed` | 在 `runStreamAndPersist()` 的函数体外包一个新的 `try`/`catch`,catch 时先触发事件再原样重新抛出 | `reason` | ⚠️ 新的控制流,不是纯重构(与 rev. 1 一致无变化,见 §9.7) |

### 4.3 为什么 gate 节点不再被排除在 `node_started`/`node_completed` 之外(取代 rev. 1 §4.2)

Rev. 1 把 `g1`/`g2`/`g3`/`escalation` 排除在 `node_entered` 之外,理由是在 `gate_requested`/`gate_decided` 已经覆盖同一个完成时刻的情况下,再来一个通用的第三个事件是多余的噪音。这个理由对 `node_started` 不成立:对一个 gate 节点来说,`node_started` 触发在该节点甚至还没到达自己的 `interrupt()` 调用之前(也就是在那个给人看的问题都还没构造出来之前)——这是真正新的、更早的信息,`gate_requested` 提供不了(`gate_requested` 只在中断真的让 graph 暂停之后才触发)。既然 `node_started` 现在对所有节点都免费统一存在,和 `node_completed`(它反正对 draft/review 也复现了 `agent_completed`/`gate_decided` 既有的完成时冗余,rev. 1 早就接受了这份冗余)保持对称,让"统一覆盖"成为更简单、更一致的设计。**这是一处澄清,已定稿,不是在征求许可**——特意标出来是为了可见性,因为它改变了 rev. 1 陈述过的范围划定。

### 4.4 关于 `node_started` 时序的诚实警告(完整细节见 `spike-node-start.md` §4)

LangGraph 自身的引擎顺序(`loop.tick()` 触发 create 形状的 `"tasks"` 事件、完全 resolve,*然后* `runner.tick()` 才调用节点——`_runLoop()` 的 `while (await loop.tick(...)) { ... await runner.tick(...) }`)是真实且结构性的。但 spike 发现,*外部*的 `for await` 消费方(也就是 `runner.ts` 自己的循环)观察到这个事件的时刻,会比该节点自己的同步序言(prologue)已经开始运行的时刻晚一拍——对于一个函数体里没有 `await` 的节点(spike 那个玩具版本的 `g1` 等价 gate 节点就是这样;这个代码库里真实的 `gates.ts` 节点也是同样的形状,因为它们的函数体在 `interrupt()` 之前都是同步的),有时甚至晚到该节点已经彻底跑完了。这是消费方那侧一个普通的 JS 微任务调度特性,不是 LangGraph 自身排序上的缺陷。

**对这个代码库的实际意义**:`draft`/`review`(`nodes/coder.ts`/`nodes/tester.ts`)是 `async` 函数,它们的真实工作是一次网络/API 调用(几百毫秒到几秒)——对这两个节点来说,`node_started` 会在该节点同步序言开始后差一个可忽略不计的时间(亚毫秒到几毫秒)才触发,对任何面向人类的进度 UI 来说这和"刚刚开始"没有区别,相比 rev. 1 只有完成时信号是一个实质性的改进。对于 `g1`/`g2`/`g3`/`escalation`/`apply`/`cancel`(全都是同步、近乎瞬时的函数体),`node_started` 和 `node_completed` 无论如何在挂钟时间上通常都会观察到非常接近——这里排序上的细微差别本来就没那么重要,因为不管怎样都没有一段有意义的"进行中"时长可以在中途被观察到。`LoopEventBase` 的 `ts` 字段是由 `runner.ts` 在 `emit()` 那一刻打上的时间戳,所以它反映的永远是*runner 自己的消费循环真正处理到对应 chunk 的那一刻*,不是任何更深层的引擎内部时间戳——这份 PRD 如实记录了这一点(写在上线代码自己的文档注释里,不只是写在这里),而不是暗示一个比机制实际能提供的更强的保证。

---

## 5. 逐文件任务清单

### `src/loop/events.ts`(**新文件**)
- `interface LoopEventBase { runId: number; threadId: string; ts: string; }`
- 11 个具体的事件 interface,继承 `LoopEventBase`,带一个字面量 `type` 判别字段(§4.2)——从 `./types.js` 做仅类型导入:`GateType`、`GateDecision`、`EscalationDecision`、`GatePayload`、`LoopNodeName`。
- `export type LoopEvent = <这 11 个的联合>`。
- `export type LoopEventListener = (event: LoopEvent) => void | Promise<void>;`
- `export class LoopEventEmitter { on(listener): () => void; emit(event: LoopEvent): void }` —— 设计与 rev. 1 一致无变化(§9 决策 3):内部一个 `Set<LoopEventListener>`;`emit()` 对每个 listener 做 `try/catch`(同步隔离)+ 对 thenable 返回值做 `.catch()` 保护(异步隔离);错误通过 `console.error(...)` 上报,永不重新抛出。

### `src/loop/runner.ts`(改动,不是新文件)
- `StartRunDeps` 新增 `events?: LoopEventEmitter;`(可选——§9 决策 1,无变化)。
- **`runStreamAndPersist()` 的 `compiled.stream()` 调用**:`streamMode: "updates" as const` → `streamMode: ["updates", "tasks"] as const`(这一行改动是这个文件里其它所有改动的触发点)。
- **`runStreamAndPersist()` 外层循环重构**:`for await (const chunk of stream) { for (const [nodeName, rawUpdate] of Object.entries(chunk)) {...} ; await computeRunProgress...}` 变成 `for await (const [mode, payload] of stream) { if (mode === "tasks") { <node_started 处理,见下> ; continue; } // mode === "updates",payload 就是今天的老裸 chunk: for (const [nodeName, rawUpdate] of Object.entries(payload)) {...既有分支体,不变...} ; await computeRunProgress...}` —— **既有的分支体(draft/review/gate/apply-cancel)以及 `computeRunProgress()`/`updateRunProgress()` 调用,都原封不动地往下挪一层,不重写。** 这是这份 PRD 里唯一一处结构性(而非纯增量)的改动;§9.6 讨论了这一改动带来的回归风险。
- **`mode === "tasks"` 的处理**:`if ("input" in payload) { const node = payload.name as LoopNodeName; const stepRef = node === LOOP_NODES.apply || node === LOOP_NODES.cancel ? undefined : previewStepRef(stepCounters, node); emitter.emit({type:"node_started", runId, threadId, ts: nowIso(), node, stepRef}); }`(result 形状的 `"tasks"` payload,即 `"result" in payload`,直接忽略——不从中产生任何事件)。新增辅助函数 `previewStepRef(counters, node): string` = `` `${node}#${(counters[node] ?? 0) + 1}` `` —— **只读,不修改 `stepCounters`**(真正的分配依然只在完成时发生一次,走既有的 `nextStepRef()`;这个预览值可以证明和真实分配值完全一致,因为这张图的执行严格按节点顺序进行——同一次 run 里,同一个节点名永远不会有两次访问同时在飞,所以在预览和真实分配之间不会有别的东西碰这个计数器)。
- **`node_completed` 的触发**(从 rev. 1 的 `node_entered` 改名而来,现在覆盖全部 8 个节点):draft/review 在它们既有的 `stepRef = nextStepRef(...)` 那一行(位置不变);gate 节点在既有的 `GATE_NODE_NAMES` 分支里(新增内容——rev. 1 在这里除了 `gate_decided` 什么都没触发,本轮在旁边加了一个普通的 `node_completed`);apply/cancel 通过 rev. 1 已经引入的同一个新 `else if (nodeName === LOOP_NODES.apply || nodeName === LOOP_NODES.cancel)` 分支。
- `startRun()`/`resumeRun()`/`agent_completed`/`gate_requested`/`gate_decided`/`tester_rejected`/`escalation_triggered`/`run_completed`/`run_cancelled`/`run_failed`:**与 rev. 1 一致,无变化**(见 rev. 1 原始的逐文件任务清单条目——依然准确,只是现在多缩进一层,活在适用的 `mode === "updates"` 分支里)。

### 测试
- `src/loop/__tests__/events.test.ts`(新文件,范围与 rev. 1 一致无变化)—— emitter 单元测试。
- `src/loop/__tests__/runner.test.ts`(改动)—— 把 rev. 1 计划好的事件序列断言扩展到也断言 `node_started` 对一次完整 run 里的每个节点都出现,且**严格先于**(按收集到的事件数组的顺序——不是挂钟时间,因为那才是一个 listener 真正观察到并据此行动的东西)该同一节点访问对应的 `node_completed`/`agent_completed`/`gate_decided`。
- **本轮新增的验收标准**:一条测试断言,对一次完全相同脚本化的 run,`audit.updateRunProgress` 在用 `streamMode: ["updates","tasks"]` 时被调用的次数(spy/count)**和**用纯 `"updates"` 时**完全一样**——证明新增 `"tasks"` 模式没有改变写入节奏(§8)。
- **回归要求**(与 rev. 1 一致无变化):`runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` 里所有既有测试原封不动继续通过。

---

## 6. 批次拆分(rev. 2——B2 相比 rev. 1 的估计变大了)

| 批次 | 规模 | 范围 | 依赖 |
|---|---|---|---|
| **B1** | S | `src/loop/events.ts`(11 种事件类型 + `LoopEventEmitter`)+ `events.test.ts` | 无 |
| **B2** | **M/L**(rev. 1 里是 M) | `runner.ts`:`streamMode` → `["updates","tasks"]` + 外层循环重构成 `[mode,payload]` 分发 + `node_started` 触发(全部 8 个节点)+ `node_completed` 触发(全部 8 个节点,含新增的 gate 节点覆盖)+ `agent_completed`/`gate_requested`/`gate_decided`/`tester_rejected`/`escalation_triggered`/`run_completed`/`run_cancelled`(逻辑不变,重新嵌套)+ `previewStepRef()` 辅助函数 + 事件序列测试 + `updateRunProgress` 调用计数回归测试 + 既有测试套件全量回归跑一遍 | B1 |
| **B3** | S | `runner.ts`:`run_failed` 的 try/catch 包裹 + 测试 | B1、B2 |

**为什么 B2 变大了**:rev. 1 的 B2 是纯增量的(新的 `emit()` 调用插在既有代码旁边,不碰任何既有控制流)。Rev. 2 的机制(`streamMode` 数组)改变了外层循环消费内容的**形状**,意味着每个既有分支体都要重新嵌套(不是重写,是搬动)到一个新的分发之下——一处真实的、尽管是机械性的结构性改动,再加上这一改动引入的新的 `computeRunProgress` 节奏风险(§9.6)需要一条专门的测试,而不能只是"相信重构是机械性的"。

**总估算(rev. 2)**:B1 不变(~80-120 行代码 + 测试)。B2 从 rev. 1 的约 40-60 行净增长/移动到大约 90-130 行净新增/移动(循环重构会碰到更多行,虽然大部分函数体逐字不变)+ 一段实质更大的测试部分(11 种类型 × 若干种 run 形状场景的事件序列断言 + 新的写入节奏回归测试)。B3 不变(规模小)。

---

## 7. 分支策略(与 rev. 1 一致无变化)

单一分支 `feature/issue-29-events`,3 个批次依次顺序提交在上面。

---

## 8. 可测试的验收标准(rev. 2——新增项标 🆕)

- [ ] `src/loop/events.ts` 导出 `LoopEvent`(**11** 成员联合类型)、`LoopEventListener`、`LoopEventEmitter`;`tsc` 编译干净。
- [ ] `LoopEventEmitter.emit()`:同步抛出隔离(与 rev. 1 一致无变化)。
- [ ] `LoopEventEmitter.emit()`:异步 rejection 隔离(与 rev. 1 一致无变化)。
- [ ] `startRun()` 恰好触发一次 `run_started` 事件,先于该 run 的任何其它事件。
- 🆕 [ ] 一次完整的 start→G1 approve→(G2 或 G3 路径)→apply run,对它经过的**每一个**节点(`draft`、`g1`、`review`、`g2`-或-`g3`、`apply`)都触发 `node_started`,每一个都在收集到的事件数组里严格早于同一节点自己的 `node_completed`。
- [ ] 同一次 run 有序的 `type` 序列在其它方面与 rev. 1 已定的序列一致,只是在每个 `node_completed(X)`/`agent_completed(X)`/`gate_decided(X)` 三元组前面紧插了一个 `node_started(X)`。
- [ ] 一次被驱动到 `rejectCount === rejectThreshold` 的 run,每次 reject 都触发 `tester_rejected`,在到达阈值的那一轮恰好触发一次 `escalation_triggered`。
- [ ] 一条 Escalation 决策为"abandon"的路径,按这个相对顺序触发 `node_started(escalation)`、`node_started(cancel)`、`node_completed(cancel)`、`run_cancelled`。
- [ ] 在 `runStreamAndPersist()` 中途强制让 adapter 抛出,仍然原样传播原始错误,**且**在重新抛出之前恰好触发一次 `run_failed` 事件。
- 🆕 [ ] **`updateRunProgress` 调用计数回归**:同一段脚本化的 run,在 `audit.updateRunProgress` 上装一个 spy/counter,无论 `runner.ts` 用的是 `streamMode: "updates"`(旧)还是 `streamMode: ["updates","tasks"]`(新),被调用的次数都**相同**——证明新增 `"tasks"` 没有改变写入节奏(把 §9.6 的风险变成可检查的,而不只是断言)。
- [ ] **回归**:`runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` 里每一条既有测试原封不动继续通过。
- [ ] `grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 依然返回空(零 I/O 纯净性不变量未被触碰)。
- [ ] `grep -n "emit(\|LoopEvent" src/loop/gates.ts src/loop/escalation.ts src/loop/nodes/coder.ts src/loop/nodes/tester.ts src/loop/audit-store.ts` 返回空。
- 🆕 [ ] `grep -n 'streamMode' src/loop/runner.ts` 显示 `["updates", "tasks"]`(或等价的 `as const` 写法)出现在 `runStreamAndPersistCore()` 内部唯一那处 `compiled.stream()` 调用点——由 `startRun()` 和 `resumeRun()` 共用(两者都调用同一个底层函数),而不是两处独立调用点——确认机制真的被接上了,而不只是计划过。

---

## 9. 依赖 / 风险 / 待定问题

### 9.1 决策 1 —— `LoopEventEmitter` 活在哪里?(与 rev. 1 一致无变化)

**定稿:`StartRunDeps.events?: LoopEventEmitter`(可选)**,缺省时内部默认成 `new LoopEventEmitter()`。完整理由与 rev. 1 一致无变化(已验证今天约 64 处既有调用点构造 `StartRunDeps` 时都没有 `events` 字段)。

### 9.2 决策 2 —— 和既有 `AuditStore` 写入的关系(与 rev. 1 一致无变化)

**定稿:增量式。** 理由不变。Rev. 2 添加了一处 spike 明确出来的补充:增量式**同时也**意味着"不要因为第二个 `streamMode` 现在往同一条流里交织了更多 chunk,就意外地把写/读频率翻倍"(§9.6)。

### 9.3 决策 3 —— emit 语义:同步 + listener 隔离(与 rev. 1 一致无变化)

与 rev. 1 完全一致无变化—— 同步 `emit()`、每个 listener 独立 try/catch、对 thenable 返回值做 `.catch()` 保护、`console.error` 上报,`gate_decided` 在提交后触发,不在事务内部。

### 9.4 `node_started` 上的 `stepRef`:预览,不是分配

`node_started` 在它所描述的那一轮真正发生之前就触发,所以在 `structured_claims`/`approvals`/`step_markers` 使用 `stepRef` 那个意义上(那些都只在完成时才写),现在还没有一个真实的 `stepRef` 可以报告。这份 PRD 的 `previewStepRef()`(§5)计算 `` `${node}#${(counters[node] ?? 0) + 1}` `` **且不修改** `stepCounters`,依赖一个明确的不变量:**这张图的执行严格按节点顺序进行**——在一次 `runStreamAndPersist()` 调用内,LangGraph 永远不会并发运行同一个节点名的两次调用(由 `graph.ts` 的拓扑结构确认,自 A4a/A4b 以来未变:每个节点在任意时刻只有一条前驱边处于激活状态)。所以预览出来的值可以证明和该同一轮真正完成时 `nextStepRef()` 分配的值完全相同——不需要按 task-id 做关联映射,预览值和真实分配值之间也没有漂移的风险。`apply`/`cancel` 在 `node_started` 和 `node_completed` 上依然都是 `stepRef: undefined`(理由和 rev. 1 一样——系统里其它任何地方都没有为这两个终态节点设计计数器概念;无变化)。

### 9.5 从 rev. 1 沿用下来、现在后果更大的判断调用:`run_failed` 不包括 `resumeRun()` 的预检验证抛出

理由与 rev. 1(那里的 §9.5)一致无变化——`RunThreadMismatchError`/`ResumeDecisionDomainMismatchError`/`decidedBy` 的类型 guard 都在 `runStreamAndPersist()` 被触及之前就抛出,代表的是一个被拒绝的*请求*,不是一次失败的*执行步骤*。

### 9.6 🆕 风险:`streamMode` 数组不能悄悄改变 `computeRunProgress`/`updateRunProgress` 的节奏

这是 rev. 2 真正新增的唯一风险(spike §5 直接点出)。加上 `"tasks"` 模式之后,外层循环每次真实节点访问看到的 `[mode, payload]` 元组数量大致翻倍(一次 `"tasks"` create + 一次 `"updates"` + 一次 `"tasks"` result,对比今天的一次 `"updates"`——spike 抓到的实际输出,例如一次 `draft` 访问对应的第 `[3]`/`[5]`/`[7]` 行)。如果 `computeRunProgress()`/`audit.updateRunProgress()` 天真地维持"外层循环每迭代一次就调一次"(今天实际的位置——已验证,`runner.ts` 第 463 行),这会导致每次 run 里它被多调用约 3 倍,让 `getState()` 读取和 `workflow_runs` 写入相比今天三倍,却没有任何功能收益(从一次只有 `"tasks"` 的迭代算出来的位置/状态,对紧接着下一次 `"updates"` 迭代自己那次调用来说是陈旧/冗余的)。**修法,在 §5 里已明确写出**:把 `computeRunProgress()`/`updateRunProgress()` 专门绑定在 `mode === "updates"` 后面,恢复今天精确的节奏。**做成可测试的,不只是断言**——§8 新增的"`updateRunProgress` 调用计数回归"验收标准。

### 9.7 风险:`run_failed` 的 try/catch 包裹与 R6-B2 不变量(与 rev. 1 一致无变化)

与 rev. 1 §9.6 一致无变化——为 `run_failed` 加的包裹不改变 `computeRunProgress()`/`audit.updateRunProgress()` 在循环内*何时*运行,只是在一次已经发生的 `throw` 那一点上加一个副作用。

### 9.8 剩余的 `[?]`(比 rev. 1 的一项待定问题少了——那一项现在已解决)

Rev. 1 唯一的一项 `[?]`("LangGraph 1.4.8 是否提供一种能产出 node-start 信号的 streamMode")已被 spike **解决**——不再是待定项。Rev. 1 引入的后续 `[?]`(`["tasks", StreamTasksOutput<...>] | ["updates", ...]` 这个判别式元组的确切 TypeScript 收窄方式)在 B2 实现期间**也已解决**:一个用完即弃的探针文件,在每个分支里对一个虚构属性用 `@ts-expect-error`,确认真实 `tsc`(`strict`、`noUncheckedIndexedAccess`)通过 `mode === "tasks"` + `"input" in payload` 就能把 `payload` 干净地收窄成 `StreamTasksCreateOutput`/纯 `"updates"` 形状,除此之外**不需要任何类型转换或类型守卫**。截至本次修订,这份 PRD 里没有剩余的 `[?]`。

### 9.9 已知限制(Zorro 复审后新增,R1 那一轮;措辞在 R3 收紧)—— 事件身份来自事后的 `getState()`,而不是那次因果 chunk 自己的 payload

Zorro 的 R1 复审(独立、Codex 辅助的、针对真实编译好的 graph 的探测)指出了一个更深的架构性问题,关于这个文件里每一个"这个 gate 是不是刚被请求 / 这次 run 是不是刚完成"的事件**如何**判断*发生了什么*:`gate_requested`/`run_completed`/`run_cancelled` 是通过调用 `computeRunProgress()`(一次全新的 `compiled.getState()` 读取)得出的,*在*通过 `interruptSeenThisChunk`/`terminalNodeSeenThisChunk`(§9.6/R1 修复)确认刚处理的 chunk 就是那个因果性的 `__interrupt__`/终态节点 chunk *之后*。这个事件的*时机*(哪个 chunk 触发这次触发检查)现在正确地绑定到了那个因果 chunk 上,但这个事件的*内容*(哪个 gate、什么 payload、`done`/`status`)依然来自一次**独立、后续**的 `getState()` 调用,而不是直接从 `__interrupt__` chunk 自己的 payload 里读出来(那个 payload 其实已经带着中断的 `value` 了——见 `computeRunProgress()` 自己的 `pending.value as GatePayload` 那一行,源自 `snapshot.tasks[0]?.interrupts[0]`,而它本身也来自一次 `getState()` 读取,只不过是这份 PRD 所依赖的 R6-B2 时代代码早就计划好的那一次)。

**真正决定这是否安全的因素(R3 修正——不是"同步 vs. 异步 checkpointer")**:这一节更早的草稿把安全条件框定成了"aeloop 的 checkpointer 是同步的"——那是错误的判断轴。一个**强一致性**的异步 checkpointer(其读后写保证一致,比如一个没有复制延迟的单节点网络存储)会和现在这个同步的 SQLite 一样安全;反过来,即便是一个同步存储,如果读写没有按线程序列化,在恰当的对抗性调度下也可能出问题。真正重要的是两个性质,合在一起:**(a) 每个 `threadId` 都是串行驱动的**——不会有两个 `resumeRun()`/`startRun()` 调用对*同一个* thread 并发执行,所以在任意时刻只有一个写入者在推进那个 thread 的 checkpoint;**(b)** 确认因果 chunk 之后紧接着发出的那次 `getState()` 调用,读到的是同一个读后写一致的 checkpoint 存储,所以它不可能观察到"chunk 已处理"和"`getState()` 读取"这个间隙里,被某个*其它*并发调用方推进到的位置——唯一可能出现的是 LangGraph *自身*在同一个调用方自己这次调用内部的抢跑(也就是 §9.6/R1 已经通过绑定因果 chunk 修好的那个确切竞态)。

**(a) 是对今天实际使用模式的描述,不是这个代码库强制执行的结构性保证**——直白地说,不是暗示:`audit-store.ts` 自己的 R5-B2 注释直接写明"没有锁/CAS/序列化机制挡住两个并发调用对*同一个* run 调用 `resumeRun()`",这个缺口是被明确记录、而不是被关闭的,留给未来某个增量。今天 `runner.ts` 或 `audit-store.ts` 里没有任何东西*阻止*调用方对一个 `threadId` 发起两次并发的 `resumeRun()` 调用——317 条通过的测试(包括两条 Zorro R1 回归测试)以及 Zorro 自己的 R1 探测,证明的是这个修复在**串行使用**下是正确的,而串行使用正是 aeloop 今天作为一个单操作者、CLI 驱动的引擎唯一真实的使用模式;它们没有、也不能证明串行使用是唯一可能发生的情况。

**什么会打破它,修法应该是什么**:两个并发的 `resumeRun()` 调用作用在同一个 thread 上(违反性质 (a))——不论背后是什么 checkpointer——都会重新打开一个真实的窗口,让这份 PRD R1 修复已经关掉过一次的同一类竞态重新出现:跟在一个调用方自己因果 chunk 后面的那次 `getState()` 调用,可能观察到*另一个*并发的、飞行中的调用方把那个 thread 推进到的一个位置。**在这种使用模式被允许之前**(无论是通过未来的并发特性,还是仅仅因为今天没有任何东西阻止调用方不小心这么做),这个文件里事件内容的推导方式应该从"确认因果 chunk,再重新读一次 `getState()`"改成"直接从因果 chunk 自己的 payload 里读出事件内容"(`__interrupt__` chunk 已经按每个中断带着 `{id, value}`;终态节点的 `"updates"` chunk 已经带着 `apply`/`cancel` 返回的内容了)——彻底消除这三种事件类型的第二次 `getState()` 读取,而不只是把它的*时机*绑定住。**本次修订未实现**——这是军师/Elisha 明确的判断:针对一个这个代码库真实调用点今天根本不会触及的并发场景,现在就去做这个重构超出了这个 issue 的范围;这个缺口记录在这里(并与 `audit-store.ts` 既有的 R5-B2 追踪交叉引用,两者背后是同一个"同一线程并发未被强制约束"的事实),这样以后就不会从零被重新发现一遍。

---

## 10. 项目约束清单

- whoseorder 零侵入 / `/wo-module`?:N/A —— aeloop 不是 whoseorder。
- 跨项目契约(whoseorder↔whosehere)?:N/A。
- 项目内约束(aeloop `CLAUDE.md`/`docs/DESIGN.md`):`src/loop/` graph 节点/gate 的零 I/O 纯净性保持不变(已由 §8 的 grep 标准验证——spike 确认即便在方案 C 更强的"真实 node-start"要求下也依然成立,终究不需要牺牲纯净性);未引入任何新的 npm 依赖;不改动 `config.yaml`/`profile/` 接线;spike 自己那个用完即弃的脚本(`docs/feature/events-observability/spike/node-start.mjs`)不是生产代码,也没有接入任何构建/测试目标——保留下来只是为了留证据/可复现性,和 `docs/feature/a4a-loop/spike/*.mjs` 的惯例一样。
</content>
