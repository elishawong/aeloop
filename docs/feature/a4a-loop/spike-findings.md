# A4a Loop 前置 Spike — LangGraph.js 门控循环实证(issue #13)

> **投石问路,不写生产实现,不 commit。** 目标:在 aeloop 本机本栈(Node v24 + pnpm + ESM +
> TypeScript strict)上,真跑命令验证 LangGraph.js 能不能承载 DESIGN §4 的门控状态机
> (Draft→G1→Review→G3,含 interrupt 人在环 + 跨进程 checkpoint resume)。DESIGN §9 第 3 条
> 把这套模式标 `[verity-proven]`——那是 Verity 代码库证过的,**本仓不能抄 Verity 实现**(空气墙),
> 只能重新独立证一遍。本 spike 就是那次重新证明。
>
> 实测环境:macOS,Node `v24.1.0`,pnpm `9.12.3`,分支 `feature/issue-13-a4a-loop`(基于 main
> `539f650`)。所有命令都是本次会话里真跑的,输出样本原文粘贴(未编造/未回忆)。脚本在
> `docs/feature/a4a-loop/spike/`,可直接 `node`/`npx tsc` 复现。

## 一句话结论(先行)

**5 个 Q 全部成立,DESIGN §9 第 3 条"verity-proven"的判断在本仓本栈上被独立证实,没有出现
"某个环节根本做不到"的最坏分支。** 唯一需要 PRD 特别处理的是 Q5 的一处类型坑(`Command` 的
`Nodes` 泛型参数默认 `string`,不显式标注会报 TS2345)——不是设计层面的问题,是写 `nodes/`
代码时的一条硬性注意事项。

| Q | 问题 | 结论 |
|---|---|---|
| Q1 | 装得上吗 | ✅ 成。`@langchain/langgraph@1.4.8` + `@langchain/langgraph-checkpoint-sqlite@1.0.3`,Node v24 + pnpm + ESM 下 `pnpm add` 干净安装、import 无报错 |
| Q2 | StateGraph 两节点 | ✅ 成。coder→tester 玩具图编译 + 跑通一圈,state 正确流转 |
| Q3 | interrupt 人在环 | ✅ 成。`interrupt()` 真的暂停在 G1、把待审内容抛给外部;外部 `Command({resume})` 真的续跑到底 |
| Q4 | 跨进程 checkpoint(最关键) | ✅ 成。两个独立 `node` 进程(不同 pid),仅凭 `thread_id` + 落盘 sqlite 文件完成暂停→续跑,零内存共享 |
| Q5 | 类型/ESM 契合 | ✅ 成,但有一处必须显式处理的坑(见下)。`tsc --noEmit`(strict + noUncheckedIndexedAccess)最终全绿 |

---

## Q1:装得上吗

### 真实包名与版本(npm 查证,非记忆)

```
$ npm view @langchain/langgraph-checkpoint-sqlite@1.0.3 dependencies peerDependencies
dependencies = { 'better-sqlite3': '^12.10.0' }
peerDependencies = {
  '@langchain/core': '^1.1.44',
  '@langchain/langgraph-checkpoint': '^1.0.0'
}

$ npm view @langchain/langgraph@1.4.8 dependencies peerDependencies
dependencies = {
  '@langchain/protocol': '^0.0.18',
  '@standard-schema/spec': '1.1.0',
  '@langchain/langgraph-checkpoint': '^1.1.3',
  '@langchain/langgraph-sdk': '~1.9.26'
}
peerDependencies = { '@langchain/core': '^1.1.48', zod: '^3.25.32 || ^4.2.0' }

$ npm view @langchain/langgraph@1.4.8 engines
{ node: '>=18' }
```

**选定版本**:`@langchain/langgraph@1.4.8`(当时 npm 上最新)、
`@langchain/langgraph-checkpoint-sqlite@1.0.3`(当时最新,官方 LangChain 维护)。

**与 aeloop 现有依赖的兼容性核对**(非猜测,逐条对过):
- `@langchain/langgraph-checkpoint-sqlite` 的 `better-sqlite3` 依赖要求 `^12.10.0`,aeloop
  `package.json` 已有 `better-sqlite3@^12.11.1` —— **兼容,不产生第二份 better-sqlite3**。
- `@langchain/langgraph` 的 `zod` peer dep 要求 `^3.25.32 || ^4.2.0`,aeloop 已有 `zod@^4.4.3`
  —— **兼容**。
- `engines.node: >=18`,aeloop 要求 `>=24` —— **兼容(更严格的子集)**。
- 没有安装 `node:sqlite` 变体(DESIGN §10 开放点提过这个可选杠杆)——`@langchain/langgraph-checkpoint-sqlite`
  官方包底层用的就是 `better-sqlite3`,不是 `node:sqlite`,所以"换 node:sqlite 减依赖"这件事
  **不适用于这个官方 checkpoint 包本身**(它的实现选择已经锁死 better-sqlite3);npm 上另有一个
  第三方包 `langgraph-checkpoint-sqlite-native`(用 node:sqlite,非 LangChain 官方维护,单一
  maintainer,版本 `0.0.2`)——本 spike **未评估这个第三方包**,只验证了官方
  `@langchain/langgraph-checkpoint-sqlite`,如实标注,DESIGN §10 那条开放点应改写为"官方包锁定
  better-sqlite3,若真要 node:sqlite 得换第三方包,风险自担"。

### 安装

```
$ pnpm add @langchain/langgraph@1.4.8 @langchain/langgraph-checkpoint-sqlite@1.0.3
...
Packages: +20
++++++++++++++++++++
dependencies:
+ @langchain/langgraph 1.4.8
+ @langchain/langgraph-checkpoint-sqlite 1.0.3

Done in 1m 34.5s
```
干净安装,无 peer dep 冲突警告(唯一一条 WARN 是 `prebuild-install@7.1.3` 被标 deprecated,
和 langgraph 无关,是 better-sqlite3 生态链里的既有子依赖,不是本次新增)。

### import smoke test

`docs/feature/a4a-loop/spike/q1-import.mjs`:
```js
import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
console.log("StateGraph:", typeof StateGraph);
...
```

```
$ node docs/feature/a4a-loop/spike/q1-import.mjs
StateGraph: function
START: __start__
END: __end__
SqliteSaver: function
Q1 OK: imports resolved under Node v24.1.0
```

**对 A4a PRD 的影响**:`package.json` 应钉死 `@langchain/langgraph@1.4.8` +
`@langchain/langgraph-checkpoint-sqlite@1.0.3`(或后续 PRD 阶段重新 `npm view` 取当时最新,
但至少这两个是本 spike 实测过的基线,不是猜的版本号)。不需要额外装 `@langchain/langgraph-checkpoint`
(base 包)—— 它是两者的共同 peer dep,pnpm 已自动解析装好(体现在 `+20` 里,包含
`@langchain/core`/`@langchain/langgraph-checkpoint`/`@langchain/protocol`/`@langchain/langgraph-sdk`
等传递依赖)。

---

## Q2:StateGraph 两节点(coder→tester)

`docs/feature/a4a-loop/spike/q2-two-node-graph.mjs` —— `Annotation.Root` 定义 state,两个纯函数
节点(`coderNode`/`testerNode`)只返回假数据,`addEdge` 串联 `START→coder→tester→END`。

```
$ node docs/feature/a4a-loop/spike/q2-two-node-graph.mjs
[coder] received state.task = toy task: add a function
[tester] received state.coderOutput = fake diff for: toy task: add a function
Q2 final state: {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "testerVerdict": "approved (fake)",
  "log": [
    "coder ran",
    "tester ran"
  ]
}
Q2 OK: coder->tester StateGraph compiled and ran a full cycle.
```

**结论**:`StateGraph` API 和 DESIGN §6 设想的 `graph.ts` 编译模式对得上——节点是普通函数,
接收累积 state、返回 partial update,`addEdge` 串联即可,没有意外的心智负担。`log` 字段用了
`reducer: (a,b)=>a.concat(b)` 验证了 state 里可以放"累加型"字段(审计链 `structured_claims`
以后大概率要用这种模式攒历史)。

---

## Q3:interrupt 人在环(G1 暂停 + Command resume)

`docs/feature/a4a-loop/spike/q3-interrupt-resume.mjs` —— 在 coder 和 tester 之间插一个
`g1GateNode`,内部调 `interrupt({gate, diff, question})`。

```
$ node docs/feature/a4a-loop/spike/q3-interrupt-resume.mjs
=== first invoke: should stop at G1 interrupt ===
[coder] drafting for task: toy task: add a function
[G1] about to interrupt(), coderOutput = fake diff for: toy task: add a function
first result (should show __interrupt__): {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "__interrupt__": [
    {
      "id": "cb769f800250f567e3cc661ca922e039",
      "value": {
        "gate": "G1_SEND_TO_TESTER",
        "diff": "fake diff for: toy task: add a function",
        "question": "approve sending this diff to tester?"
      }
    }
  ]
}
state.next after interrupt: [ 'g1' ]
=== resume with Command({resume: 'approve'}) ===
[G1] about to interrupt(), coderOutput = fake diff for: toy task: add a function
[G1] resumed with decision = approve
[tester] reviewing, gateDecision was: approve
second (final) result: {
  "task": "toy task: add a function",
  "coderOutput": "fake diff for: toy task: add a function",
  "gateDecision": "approve",
  "testerVerdict": "approved (fake)"
}
Q3 OK: interrupt paused the graph, external Command({resume}) continued it to completion.
```

**真实 API 形状(供 PRD 精确写)**:
- 暂停:节点函数里调 `interrupt(payload)`——`payload` 是任意可序列化值(本 spike 用
  `{gate, diff, question}`,直接映射 DESIGN §5 `approvals.gate_type`/`diff_ref`/`reasoning_text`
  的雏形)。`compile({checkpointer})` **必须**配 checkpointer(哪怕内存版 `MemorySaver`),
  没有 checkpointer 时 `interrupt()` 无法真正"暂停并保留断点"——这条虽然 spike 没有反向测试
  "不给 checkpointer 会怎样",但 API 设计上 `interrupt` 依赖 checkpoint 机制是官方文档明确前提,
  Q4 进一步证实了这个依赖关系。
- 顶层 `invoke()` 的返回值里出现 `__interrupt__` 数组字段,里面每项 `{id, value}}` —— `id` 是
  这次中断的唯一标识,`value` 就是节点传给 `interrupt()` 的 payload。
- 恢复:`compiled.invoke(new Command({resume: <决策值>}), threadConfig)`——**同一个** `thread_id`
  的 `threadConfig`,`resume` 的值原样成为 `interrupt()` 调用的返回值(`decision === "approve"`)。
- `compiled.getState(threadConfig)` 可以在暂停期间查询 `state.next`(下一个待跑节点,这里是
  `['g1']`)和 `state.tasks[0].interrupts`(和 `__interrupt__` 同样的 payload)——这是 G1/G2/G3
  的"待审内容"读取入口,`escalation.ts`/TUI 层大概率要用这个查询暂停详情。

**⚠️ 一个不算 bug 但影响写 `nodes/` 代码的行为**:resume 时,`g1GateNode` **整个函数体重新执行
了一遍**(日志里 `[G1] about to interrupt()...` 打印了两次——第一次真中断,第二次 resume 时
又打了一遍,只是这次 `interrupt()` 直接返回 `decision` 而不再暂停)。**推论**:`interrupt()`
调用点**之前**的任何代码(包括节点里可能有的日志/副作用)在 resume 时会**重跑一次**。
`nodes/gates.ts` 写 G1/G2/G3 节点时,`interrupt()` 调用前不能有不可重复执行的副作用(比如
"发一次通知""写一次 approvals 表 INSERT"这类不幂等操作必须挪到 `interrupt()` **之后**,
或者用 `checkpoint_id` 去重),这是 PRD/build 阶段的一条硬约束,不是这里发现了 bug。

---

## Q4:跨进程 checkpoint(最关键)

三个文件:`q4-graph-def.mjs`(两个进程共享的图定义——checkpoint 存的是 **state**,不存图定义
本身,所以两个进程必须各自独立构造出结构相同的图)、`q4-process-a.mjs`(跑到 G1 interrupt 就
`process.exit(0)`,不 resume)、`q4-process-b.mjs`(全新 `node` 调用,只认 `thread_id` + 磁盘上
的 sqlite 文件)。

### Process A(跑一半就退出)

```
$ node docs/feature/a4a-loop/spike/q4-process-a.mjs /tmp/q4-cross-process.sqlite thread-abc-123
[pid 27363] Process A starting, db=/tmp/q4-cross-process.sqlite, thread_id=thread-abc-123
[pid 27363] [coder] drafting for task: toy task: cross-process resume
[pid 27363] [G1] about to interrupt(), coderOutput = fake diff for: toy task: cross-process resume
[pid 27363] Process A invoke() returned (should show __interrupt__):
{
  "task": "toy task: cross-process resume",
  "coderOutput": "fake diff for: toy task: cross-process resume",
  "__interrupt__": [
    {
      "id": "3a31896bfd2e8e67fccdeb897bdb6ffa",
      "value": {
        "gate": "G1_SEND_TO_TESTER",
        "diff": "fake diff for: toy task: cross-process resume",
        "question": "approve sending this diff to tester?"
      }
    }
  ]
}
[pid 27363] Process A state.next (should be ['g1']): [ 'g1' ]
[pid 27363] Process A exiting now WITHOUT resuming. Checkpoint should be on disk at /tmp/q4-cross-process.sqlite.
```
进程退出后确认磁盘文件真实存在(WAL 模式,三个文件):
```
$ ls -la /tmp/q4-cross-process.sqlite*
-rw-r--r--  1 elishawong  wheel   4096 ... q4-cross-process.sqlite
-rw-r--r--  1 elishawong  wheel  74192 ... q4-cross-process.sqlite-wal
-rw-r--r--  1 elishawong  wheel  32768 ... q4-cross-process.sqlite-shm
```

### Process B(全新进程,不同 pid,仅凭 thread_id 续跑)

```
$ node docs/feature/a4a-loop/spike/q4-process-b.mjs /tmp/q4-cross-process.sqlite thread-abc-123
[pid 27564] Process B starting (fresh process), db=/tmp/q4-cross-process.sqlite, thread_id=thread-abc-123
[pid 27564] Process B getState() BEFORE resume — state.next: [ 'g1' ]
[pid 27564] Process B getState() BEFORE resume — pending interrupts: [
  {
    "id": "3a31896bfd2e8e67fccdeb897bdb6ffa",
    "value": {
      "gate": "G1_SEND_TO_TESTER",
      "diff": "fake diff for: toy task: cross-process resume",
      "question": "approve sending this diff to tester?"
    }
  }
]
[pid 27564] Process B resuming with Command({resume: 'approve-from-process-b'})...
[pid 27564] [G1] about to interrupt(), coderOutput = fake diff for: toy task: cross-process resume
[pid 27564] [G1] resumed with decision = approve-from-process-b
[pid 27564] [tester] reviewing, gateDecision was: approve-from-process-b
[pid 27564] Process B final result:
{
  "task": "toy task: cross-process resume",
  "coderOutput": "fake diff for: toy task: cross-process resume",
  "gateDecision": "approve-from-process-b",
  "testerVerdict": "approved (fake)"
}
[pid 27564] Q4 OK: process B, a fresh node invocation, resumed purely from thread_id + on-disk sqlite checkpoint and ran to completion.
```

**结论(这是本 spike 的命门证据)**:
- **pid 27363 → pid 27564,两个完全独立的 `node` 进程**(不是同进程 fork,不是 worker
  thread——各自 `node <script>.mjs` 单独调用,零内存共享)。
- Process B 在**没有任何来自 Process A 的运行时状态**的前提下,`getState(threadConfig)` 就能
  读出和 Process A 中断时**一字不差**的 interrupt payload(`gate`/`diff`/`question`,id 也一致
  `3a31896b...`)——证明 `interrupt()` 抛出的值**真的落盘**了,不是只存在内存里。
- 仅凭 `{configurable: {thread_id: "thread-abc-123"}}` + 指向同一个 sqlite 文件路径的
  `SqliteSaver.fromConnString(dbPath)`,Process B 就能把整条链续到底。
- **直接印证 DESIGN §5 `workflow_runs.langgraph_thread_id` 这个设计**:那一列存的就是这里的
  `thread_id`,`checkpoint.ts` 只要把这个字符串存进 `workflow_runs` 表、下次启动时用同一个
  `thread_id` 构造 `threadConfig` 传给 `compiled.invoke`/`getState`,就能做到"关机重启后继续上次
  卡在 G1/G2/G3 哪个门"——这条设计**在本仓本栈上被真实验证成立**,不是纸面推断。

**API 细节(供 checkpoint.ts 写码时用)**:`SqliteSaver.fromConnString(path)` 内部就是
`new SqliteSaver(new Database(path))`(`Database` 来自 `better-sqlite3`),`.setup()` 首次调用时
自动建 `checkpoints`/`writes` 两张表并开 `journal_mode=WAL`——**这两张表和 DESIGN §5 手画的
`workflow_runs`/`structured_claims`/`approvals` 是完全独立的两套表**,LangGraph 自己的
checkpoint 表管"图执行到哪一步、state 是什么",aeloop 的审计表管"业务语义的审批记录"——两者
不是同一回事,`checkpoint.ts` 接线时要把 `langgraph_thread_id` 当外键桥接两边,不能指望
LangGraph 的 checkpoint 表替代 DESIGN §5 的审计表。

---

## Q5:类型/ESM 契合(strict + noUncheckedIndexedAccess + NodeNext)

`docs/feature/a4a-loop/spike/q5-types.ts` 重写了 Q3 的 interrupt/resume 场景,过一遍
`docs/feature/a4a-loop/spike/tsconfig.q5.json`(`extends` 项目根 `tsconfig.json`,只是
override 了 `rootDir`/`outDir`/`noEmit`/`include`,其余 `strict`/`noUncheckedIndexedAccess`/
`skipLibCheck`/`module: NodeNext` 等全部继承真实项目配置,不是另起一套宽松配置)。

### 第一次跑:TS2345(真实类型坑)

```ts
const resumeCommand = new Command({ resume: "approve" });
const second = await compiled.invoke(resumeCommand, threadConfig);
```
```
$ npx tsc -p docs/feature/a4a-loop/spike/tsconfig.q5.json
docs/feature/a4a-loop/spike/q5-types.ts(68,40): error TS2345: Argument of type
'Command<string, Record<string, unknown>, string>' is not assignable to parameter of type
'CommandInstance<unknown, {...}, "__start__" | "coder" | "g1" | "tester"> | UpdateType<...> | null'.
  ...
    Types of property '[COMMAND_SYMBOL]' are incompatible.
      Type 'string' is not assignable to type '"__start__" | "coder" | "g1" | "tester"'.
exit=1
```

**根因**(读 `node_modules/@langchain/langgraph/dist/constants.d.ts` 确认,非猜测):
```ts
declare class Command<Resume = unknown, Update extends Record<string, unknown> = Record<string, unknown>, Nodes extends string = string> extends CommandInstance<...>
```
`Command` 的第三个泛型参数 `Nodes`(该 Command 允许跳转到哪些节点)**默认值是裸 `string`**,
而 `compiled.invoke()` 期望的是编译后那个具体图的节点名字面量联合类型(如
`"__start__"|"coder"|"g1"|"tester"`)。`new Command({resume: "approve"})` 这种写法没有上下文
能让 TS 反推出 `Nodes` 该是哪几个字面量,于是落回默认的宽泛 `string`,和 `invoke()` 要的窄类型
对不上,structurally 不兼容 → TS2345。

### 修复(显式标注泛型)

```ts
const resumeCommand = new Command<
  unknown,
  Record<string, unknown>,
  "__start__" | "coder" | "g1" | "tester"
>({ resume: "approve" });
```
```
$ npx tsc -p docs/feature/a4a-loop/spike/tsconfig.q5.json
exit=0
```
运行时也验证过这份改完的 `.ts` 文件本身逻辑没坏(Node v24 原生 type-stripping,仅用于验证,
不代表生产 build 路径——aeloop 生产走 `tsc -p tsconfig.build.json` 产出 `.js` 再跑):
```
$ node docs/feature/a4a-loop/spike/q5-types.ts
(node:28692) ExperimentalWarning: Type Stripping is an experimental feature ...
first: { task: 'toy task', coderOutput: '...', __interrupt__: [ { id: '...', value: [Object] } ] }
second: { task: 'toy task', ..., gateDecision: 'approve', testerVerdict: 'approved (fake), saw gateDecision=approve' }
exit=0
```

**对 A4a PRD 的影响**:`src/loop/graph.ts`/`gates.ts` 里任何构造 `new Command({resume: ...})`
的地方,**必须显式标注第三个泛型参数为该图的节点名字面量联合**(或者定义一个共享的
`type LoopNodeName = "coder" | "g1" | "g2" | "g3" | "tester" | ...` 给整个 `loop/` 模块复用),
否则在 aeloop 的 strict tsconfig 下会挂在 TS2345 上,这是写码阶段的已知坑,不是设计缺陷。

### 附带核对:skipLibCheck 是否真的需要

DESIGN §9 第 5 条(spike Q5)问"有没有坑,如需 `skipLibCheck`"。aeloop 项目 `tsconfig.json`
本来就已经 `skipLibCheck: true`(A0 就定的,和 langgraph 无关的既有配置)。本 spike 额外把
它临时关掉单独测(`tsconfig.q5-noskiplib.json`,同目录),确认 **LangGraph 自己的 `.d.ts`
声明文件在 `skipLibCheck: false` 下也是干净的**(`exit=0`,零报错)——也就是说 langgraph 的
类型声明本身没有强制要求 `skipLibCheck`,aeloop 现有的 `skipLibCheck: true` 是历史决定
(A0 定的),不是因为 langgraph 才需要,保持现状即可。

### `noUncheckedIndexedAccess` 有没有踩

本 spike 没有直接索引 `state.tasks[0]` 之类数组下标去读 interrupts 字段(用的是可选链
`state.tasks?.[0]?.interrupts`),这条本身就是 `noUncheckedIndexedAccess` 强制的写法,**spike
过程里被迫这么写、也确实编译通过**,说明这条约束在 loop 层代码里可以自然遵守,不需要例外。

---

## 对 A4a PRD 的建议

1. **DESIGN 章节号小更正**:任务交给我时说"§9.3 标 LangGraph...verity-proven",实际读到的是
   `docs/DESIGN.md` **§9「开工前必跑的 spike」的第 3 条列表项**(不是 9.3 小节编号,DESIGN
   §9 本身没有再拆 9.1/9.2/9.3 子编号)。原文:"3. `[verity-proven]` LangGraph 跨进程
   interrupt/resume、LiteLLM json_schema 透传、e2e 最小闭环 —— Verity 已跑通,aeloop 重写后
   回归验证即可。"——本 spike 覆盖了这条里"LangGraph 跨进程 interrupt/resume"这一半(Q3/Q4),
   **"LiteLLM json_schema 透传"和"e2e 最小闭环"这两块不在本 spike 范围内,仍待后续验证**
   (json_schema 透传更贴近 A2 Harness 范畴,e2e 闭环得等 coder/tester 节点接上真实 adapter 才
   有意义,建议留到 A4a 后段或 A4b)。
2. **`workflow-def.ts` 的编译方式有一个隐含要求**:DESIGN §6 说 `graph.ts` 要"从
   WorkflowDefinition 编译"——本 spike 的图是纯代码手写的(`buildGraph()` 函数),没有验证
   "从一份 JSON/YAML 格式的 workflow 定义动态生成 StateGraph"这件事本身的可行性。这属于
   "aeloop 自己的编排层设计"而不是"LangGraph 能力边界",不在本 spike 的 5 个 Q 范围内,但
   **是 A4a PRD 写 `graph.ts` 时必须单独设计的一块**,建议 PRD 把"WorkflowDefinition → 编译
   StateGraph"列成独立验收项,不要假设它和本 spike 证的"手写图" 一样简单。
3. **G2/G3 门 + escalation 硬分支未在本 spike 验证**:本 spike 只搭了单一个 G1 门(串联到底),
   DESIGN §4 完整状态机还有 G2(修复批准分支)、G3(终审)、`reject_count >= threshold` 的硬
   升级分支(条件边)。LangGraph 的条件边(`addConditionalEdges`)本 spike **完全没碰**——这是
   G1/G2/G3 + 阈值升级要用到的核心机制,建议 A4a 第一个 build 批次里第一件事就是把
   `addConditionalEdges` 走一遍最小验证(哪怕仍是玩具节点),因为这是本 spike 唯一没有实证、
   但 DESIGN §4 图上明确需要的 LangGraph 能力,风险未清零。
4. **批次拆分建议**(基于本 spike 证实的能力边界):
   - **批次1**:`graph.ts` 骨架 + `nodes/coder.ts`/`nodes/tester.ts`(先用 fixture/假数据,
     镜像本 spike Q2)+ 补验 `addConditionalEdges`(建议3的缺口)。
   - **批次2**:`gates.ts`(G1/G2/G3 interrupt,镜像 Q3)+ `escalation.ts`(阈值硬分支,
     用条件边接线)。
   - **批次3**:`checkpoint.ts`(`SqliteSaver` 接线到 `workflow_runs.langgraph_thread_id`,
     镜像 Q4 的跨进程验证方式,但这次要接 DESIGN §5 的三张审计表,不只是 LangGraph 自己的
     `checkpoints`/`writes` 表)。
   - **批次4**:coder/tester 节点换成真实 A2/A3 adapter(ProviderRouter + CliAdapter),做一次
     真正的 e2e 薄垂直切片(DESIGN §8.5 方法论警示要求的"收尾必须真接通")。
   这个拆法把"LangGraph 本身的机制"(批次1-3)和"接上 aeloop 自己的 harness 层"(批次4)分开,
   前三批次风险已经被本 spike 大幅降低,批次4 的风险主要在 A2/A3 adapter 侧,不在 LangGraph 侧。
5. **没有需要指挥官现在就拍板的新岔路**——本 spike 5 个 Q 全部按预期跑通,DESIGN §4/§5/§6 的
   既有设计没有被证伪,唯一算"决策"的是建议1里 npm 上那个非官方 `langgraph-checkpoint-sqlite-native`
   包**不采用**(继续用官方包 + better-sqlite3),这个判断本 spike 已经替 PRD 做了,不需要
   额外升级讨论,PRD 阶段照此写即可。

---

## 附:本 spike 改了什么 / 装了什么(如实列清单)

**改动的文件**(均在 `feature/issue-13-a4a-loop` 分支,未 commit):
- `package.json` / `pnpm-lock.yaml` —— 新增 2 个直接依赖(见 Q1 diff)
- 新增 `docs/feature/a4a-loop/spike/`:`q1-import.mjs` / `q2-two-node-graph.mjs` /
  `q3-interrupt-resume.mjs` / `q4-graph-def.mjs` / `q4-process-a.mjs` / `q4-process-b.mjs` /
  `q5-types.ts` / `tsconfig.q5.json` / `tsconfig.q5-noskiplib.json`
- 新增本文件 `docs/feature/a4a-loop/spike-findings.md`

**装的依赖**:`@langchain/langgraph@1.4.8`、`@langchain/langgraph-checkpoint-sqlite@1.0.3`
(+ pnpm 自动解析的传递依赖:`@langchain/core`、`@langchain/langgraph-checkpoint`、
`@langchain/protocol`、`@langchain/langgraph-sdk`、`@standard-schema/spec` 等,共 20 个包,
详见 `pnpm-lock.yaml` diff)。

**未改动**:`src/`(引擎既有代码零改动)、`main` 分支(全程未切回)、任何其它项目仓库。

**回归确认**:`pnpm lint`(`tsc --noEmit`)、`pnpm test`(228/228 测试)在装完新依赖 + 新增
spike 文件后**仍然全绿**——spike 文件不在 `tsconfig.json` 的 `include: ["src/**/*.ts"]` 范围内,
不干扰既有构建/测试管线。
