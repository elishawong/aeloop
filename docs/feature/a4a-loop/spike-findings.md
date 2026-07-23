# A4a Loop 前置 Spike — LangGraph.js 带 gate 的 loop 实证验证(issue #13)

> **只是侦察,不是生产实现,不 commit。** 目标:在 aeloop 自己的机器和技术栈上(Node v24 + pnpm + ESM +
> TypeScript strict),实际跑命令验证 LangGraph.js 能不能撑起 DESIGN §4 描述的带 gate 状态机
> (Draft→G1→Review→G3,包括 interrupt human-in-the-loop + 跨进程 checkpoint 续跑)。DESIGN §9 第 3 项
> 把这个模式标了 `[verity-proven]`——那是在 Verity 代码库里被证明过的,**本仓库不能照抄 Verity 实现**(隔墙),
> 只能独立地重新证明一遍。这份 spike 就是那次重新证明。
>
> 测试环境:macOS,Node `v24.1.0`,pnpm `9.12.3`,分支 `feature/issue-13-a4a-loop`(基于 main
> `539f650`)。所有命令都在这个会话里实际跑过,输出样本是原样贴出来的(不是编的/不是凭记忆写的)。
> 脚本在 `docs/feature/a4a-loop/spike/`,可以直接用 `node`/`npx tsc` 复现。

## 一句话结论(先说结论)

**5 个问题全过。DESIGN §9 第 3 项的"verity-proven"这个说法,已经在本仓库自己的技术栈上独立确认过了,没有出现
"某部分压根不 work"的最坏分支。** 唯一需要在 PRD 里特殊处理的是 Q5 的一个类型坑(`Command` 的
`Nodes` 泛型参数默认是 `string`,不显式标注会报 TS2345)——这不是设计级问题,是写 `nodes/` 代码时的一条硬约束。

| Q | 问题 | 结论 |
|---|---|---|
| Q1 | 装得上吗? | ✅ 成功。`@langchain/langgraph@1.4.8` + `@langchain/langgraph-checkpoint-sqlite@1.0.3`,在 Node v24 + pnpm + ESM 下 `pnpm add` 干净装上、import 无报错 |
| Q2 | StateGraph 两节点 | ✅ 成功。coder→tester 玩具图编译成功、跑完一整轮,state 流转正确 |
| Q3 | interrupt human-in-the-loop | ✅ 成功。`interrupt()` 真的会在 G1 暂停,把待审内容抛给调用方;外部的 `Command({resume})` 真的能续到跑完 |
| Q4 | 跨进程 checkpoint(最关键) | ✅ 成功。两个完全独立的 `node` 进程(不同 pid),纯靠 `thread_id` + 落盘的 sqlite 文件做到暂停→续跑,零内存共享 |
| Q5 | 类型/ESM 兼容性 | ✅ 成功,但有一个必须显式处理的坑(见下)。`tsc --noEmit`(strict + noUncheckedIndexedAccess)最终全绿 |

---

## Q1:装得上吗?

### 真实包名和版本(用 npm 验证过,不是凭记忆)

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

**选定版本**:`@langchain/langgraph@1.4.8`(npm 上当时最新的),
`@langchain/langgraph-checkpoint-sqlite@1.0.3`(当时最新的,LangChain 官方维护)。

**和 aeloop 现有依赖的兼容性检查**(不是猜的,一项一项核过):
- `@langchain/langgraph-checkpoint-sqlite` 的 `better-sqlite3` 依赖要求 `^12.10.0`,aeloop 的
  `package.json` 已经有 `better-sqlite3@^12.11.1`——**兼容,不会产生第二份 better-sqlite3**。
- `@langchain/langgraph` 的 `zod` peer dep 要求 `^3.25.32 || ^4.2.0`,aeloop 已有 `zod@^4.4.3`
  ——**兼容**。
- `engines.node: >=18`,aeloop 要求 `>=24`——**兼容(更严格的子集)**。
- `node:sqlite` 变体没装(DESIGN §10 的待定项提过这可能是个可以拉的杠杆)——官方的
  `@langchain/langgraph-checkpoint-sqlite` 包底层用的是 `better-sqlite3`,不是 `node:sqlite`,所以"切到 node:sqlite 来减依赖"
  **对这个官方 checkpoint 包不适用**(它的实现选型已经锁死了 better-sqlite3);npm 上有个
  第三方包 `langgraph-checkpoint-sqlite-native`(用 node:sqlite,不是 LangChain 官方维护,单
  maintainer,版本 `0.0.2`)——这次 spike **没有评估这个第三方包**,只验证了官方的
  `@langchain/langgraph-checkpoint-sqlite`;如实记一笔,DESIGN §10 的待定项应该改写成"官方包锁死了
  better-sqlite3;真要用 node:sqlite,得换成第三方包,风险自担。"

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
干净安装,没有 peer dep 冲突警告(唯一的 WARN 是 `prebuild-install@7.1.3` 被标记为 deprecated,
跟 langgraph 无关——它是 better-sqlite3 生态里已有的子依赖,不是这次新引入的)。

### Import 冒烟测试

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

**对 A4a PRD 的影响**:`package.json` 应该钉住 `@langchain/langgraph@1.4.8` +
`@langchain/langgraph-checkpoint-sqlite@1.0.3`(或者后面 PRD 阶段可以重跑 `npm view` 拿到当时最新的,
但至少这两个是这次 spike 实际测过的基线,不是猜的版本号)。不需要另外装
`@langchain/langgraph-checkpoint`(基础包)——它是两者共同的 peer dep,pnpm 已经自动解析并装好了(反映在
`+20` 里,包括 `@langchain/core`/`@langchain/langgraph-checkpoint`/`@langchain/protocol`/`@langchain/langgraph-sdk`
等传递依赖)。

---

## Q2:StateGraph 两节点(coder→tester)

`docs/feature/a4a-loop/spike/q2-two-node-graph.mjs`——`Annotation.Root` 定义 state,两个纯函数
节点(`coderNode`/`testerNode`)只是返回假数据,`addEdge` 把 `START→coder→tester→END` 串起来。

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

**结论**:`StateGraph` 这套 API 跟 DESIGN §6 设想的 `graph.ts` 编译方式对得上——节点是普通函数,
接收累积的 state、返回一份局部更新,用 `addEdge` 把它们串起来;没有什么意料之外的认知负担。`log` 字段用了
`reducer: (a,b)=>a.concat(b)`,验证了 state 可以承载"累积型"字段(审计轨迹 `structured_claims`
后面很可能也需要用这个模式来累积历史)。

---

## Q3:interrupt human-in-the-loop(G1 暂停 + Command 续跑)

`docs/feature/a4a-loop/spike/q3-interrupt-resume.mjs`——在 coder 和 tester 之间插了一个 `g1GateNode`,
内部调用 `interrupt({gate, diff, question})`。

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

**真实 API 形状(供 PRD 精确落笔)**:
- 暂停:在节点函数内部调用 `interrupt(payload)`——`payload` 是任意可序列化值(这次 spike 用的是
  `{gate, diff, question}`,直接映射到 DESIGN §5 `approvals.gate_type`/`diff_ref`/`reasoning_text` 的一个原型)。
  `compile({checkpointer})` **必须**配一个 checkpointer(哪怕是内存版的 `MemorySaver`);
  没有 checkpointer,`interrupt()` 就没法真正"暂停并保留断点"——虽然这次 spike 没有反过来测试
  "没有 checkpointer 会怎样",但 `interrupt` 对 checkpoint 机制的这层依赖是官方文档里明写的前提,
  Q4 进一步确认了这层依赖关系。
- 顶层 `invoke()` 的返回值里带一个 `__interrupt__` 数组字段,每项形状是 `{id, value}`——`id` 是
  这次 interrupt 的唯一标识,`value` 就是节点传给 `interrupt()` 的那份 payload,原样返回。
- 续跑:`compiled.invoke(new Command({resume: <决定值>}), threadConfig)`——用**同一个**
  `thread_id` 的 `threadConfig`,`resume` 的值会原样成为 `interrupt()` 调用的返回值(`decision === "approve"`)。
- `compiled.getState(threadConfig)` 可以在暂停期间用来查 `state.next`(下一个要跑的节点,这里是
  `['g1']`)和 `state.tasks[0].interrupts`(跟 `__interrupt__` 一样的 payload)——这是读取"待审内容"的
  入口,G1/G2/G3;`escalation.ts`/TUI 层很可能需要用这个查询来查看暂停详情。

**⚠️ 不是 bug,但会影响 `nodes/` 代码怎么写的一个行为**:续跑时,`g1GateNode` 的**整个函数体会再执行
一遍**(日志里 `[G1] about to interrupt()...` 打印了两次——第一次是真正的 interrupt,第二次是续跑时,
又打印了一遍,只不过这次 `interrupt()` 直接返回 `decision`,不再暂停)。**推论**:`interrupt()` 调用**之前**的
任何代码(包括节点可能有的任何日志/副作用)在续跑时都会**重跑一遍**。
写 `nodes/gates.ts` 里的 G1/G2/G3 节点时,`interrupt()` 调用之前绝不能有非幂等副作用(比如
"发一次通知"或"往 approvals 表写一条 INSERT"这类事——非幂等操作必须挪到 `interrupt()` **之后**,
或者靠 `checkpoint_id` 去重);这是 PRD/build 阶段的硬约束,不是这里发现的 bug。

---

## Q4:跨进程 checkpoint(最关键)

三个文件:`q4-graph-def.mjs`(两个进程共用的图定义——checkpoint 存的是**state**,不是图定义
本身,所以两个进程各自都得独立构造一份结构相同的图)、`q4-process-a.mjs`(跑到 G1 interrupt 就
调用 `process.exit(0)`,不续跑)、`q4-process-b.mjs`(全新的一次 `node` 调用,只知道 `thread_id` +
磁盘上的 sqlite 文件)。

### 进程 A(跑到一半就退出)

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
进程退出后,确认磁盘文件确实存在(WAL 模式,三个文件):
```
$ ls -la /tmp/q4-cross-process.sqlite*
-rw-r--r--  1 elishawong  wheel   4096 ... q4-cross-process.sqlite
-rw-r--r--  1 elishawong  wheel  74192 ... q4-cross-process.sqlite-wal
-rw-r--r--  1 elishawong  wheel  32768 ... q4-cross-process.sqlite-shm
```

### 进程 B(全新进程,不同 pid,纯靠 thread_id 续跑)

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

**结论(这是这次 spike 最铁的证据)**:
- **pid 27363 → pid 27564,两个完全独立的 `node` 进程**(不是同一个进程 fork 出来的,也不是 worker
  thread——每个都是单独用 `node <script>.mjs` 调起来的,零内存共享)。
- 进程 B **没有拿到任何**来自进程 A 的运行时状态,`getState(threadConfig)` 就能
  读出一份跟进程 A interrupt 时状态**完全一致**的 interrupt payload(`gate`/`diff`/`question`,连 id 都对得上,
  `3a31896b...`)——证明 `interrupt()` 抛出的值**真的落盘了**,不只是内存里存着。
- 纯靠 `{configurable: {thread_id: "thread-abc-123"}}` + 指向同一个 sqlite 文件路径的
  `SqliteSaver.fromConnString(dbPath)`,进程 B 就能把整条链跑完。
- **直接印证了 DESIGN §5 `workflow_runs.langgraph_thread_id` 的设计**:那一列存的正是这个
  `thread_id`;`checkpoint.ts` 只需要把这个字符串存进 `workflow_runs` 表,下次启动时用同一个
  `thread_id` 构造 `threadConfig` 传给 `compiled.invoke`/`getState`,就能做到"重启后从卡在 G1/G2/G3
  里任何一个的地方接着跑"——这个设计**已经在本仓库自己的技术栈上验证为真**,不只是纸面上的说法。

**API 细节(供写 checkpoint.ts 时用)**:`SqliteSaver.fromConnString(path)` 内部是
`new SqliteSaver(new Database(path))`(`Database` 来自 `better-sqlite3`),第一次调用时 `.setup()` 会自动创建
`checkpoints`/`writes` 表并启用 `journal_mode=WAL`——**这两张表跟 DESIGN §5 手绘的
`workflow_runs`/`structured_claims`/`approvals` 完全独立**;LangGraph 自己的 checkpoint 表管的是"图执行走到哪一步、
state 是什么",而 aeloop 自己的审计表管的是"业务语义上的审批记录"——这不是一回事;
接 `checkpoint.ts` 时,`langgraph_thread_id` 应该当作连接两边的外键来处理,不应该指望
LangGraph 的 checkpoint 表能替代 DESIGN §5 的审计表。

---

## Q5:类型/ESM 兼容性(strict + noUncheckedIndexedAccess + NodeNext)

`docs/feature/a4a-loop/spike/q5-types.ts` 把 Q3 的 interrupt/resume 场景重写了一遍,跑在
`docs/feature/a4a-loop/spike/tsconfig.q5.json`(`extends` 项目根目录的 `tsconfig.json`,只
覆盖 `rootDir`/`outDir`/`noEmit`/`include`,其余——`strict`/`noUncheckedIndexedAccess`/
`skipLibCheck`/`module: NodeNext` 等——全部继承自真实的项目配置,不是另外搭了一份更宽松的配置)。

### 第一次跑:TS2345(一个真实的类型坑)

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

**根因**(通过读 `node_modules/@langchain/langgraph/dist/constants.d.ts` 确认的,不是猜的):
```ts
declare class Command<Resume = unknown, Update extends Record<string, unknown> = Record<string, unknown>, Nodes extends string = string> extends CommandInstance<...>
```
`Command` 的第三个泛型参数 `Nodes`(这个 Command 允许跳到哪些节点)**默认是裸的
`string`**,而 `compiled.invoke()` 期望的是那份编译好的图对应节点名的字面量联合类型(比如
`"__start__"|"coder"|"g1"|"tester"`)。`new Command({resume: "approve"})` 这么写,TS 拿不到任何
上下文去推断 `Nodes` 该是什么,于是退回到默认的、宽泛的 `string`,跟 `invoke()` 期望的更窄的类型
对不上,结构上不兼容 → TS2345。

### 修法(显式标注泛型)

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
同时在运行时验证了修好后的 `.ts` 文件自身逻辑没坏(Node v24 原生 type-stripping,只用于验证,
不代表生产构建路径——aeloop 生产走的是 `tsc -p tsconfig.build.json` 先出 `.js` 再跑):
```
$ node docs/feature/a4a-loop/spike/q5-types.ts
(node:28692) ExperimentalWarning: Type Stripping is an experimental feature ...
first: { task: 'toy task', coderOutput: '...', __interrupt__: [ { id: '...', value: [Object] } ] }
second: { task: 'toy task', ..., gateDecision: 'approve', testerVerdict: 'approved (fake), saw gateDecision=approve' }
exit=0
```

**对 A4a PRD 的影响**:`src/loop/graph.ts`/`gates.ts` 里任何构造 `new Command({resume: ...})` 的地方
**都必须显式把第三个泛型参数标注成那张图节点名的字面量联合类型**(或者给整个 `loop/` 模块定义一个共享的
`type LoopNodeName = "coder" | "g1" | "g2" | "g3" | "tester" | ...` 供各处复用),
否则在 aeloop 的 strict tsconfig 下会撞上 TS2345——这是编码阶段的一个已知坑,不是设计缺陷。

### 附带检查:skipLibCheck 到底需不需要

DESIGN §9 第 5 项(spike Q5)问"有没有坑,是不是需要 `skipLibCheck`。" aeloop 项目的 `tsconfig.json`
已经有 `skipLibCheck: true`(A0 时设的,跟 langgraph 无关,是个既有配置)。这次 spike 额外临时把
它关掉单独测了一遍(`tsconfig.q5-noskiplib.json`,同目录),确认了 **LangGraph 自己的 `.d.ts`
声明文件在 `skipLibCheck: false` 下也是干净的**(`exit=0`,零报错)——换句话说,langgraph 的
类型声明本身并不强制要求 `skipLibCheck`;aeloop 现有的 `skipLibCheck: true` 是个历史决定
(A0 时定的),不是 langgraph 要求的,维持现状没问题。

### noUncheckedIndexedAccess 有没有被触发

这次 spike 没有直接用数组下标(比如 `state.tasks[0]`)去读 interrupts 字段(用的是
可选链 `state.tasks?.[0]?.interrupts`),这本身正是 `noUncheckedIndexedAccess` 强制要求的写法——这次
spike 在写的过程中被迫这么写,而且确实编译成功了,说明这条约束在 loop 层的代码里能自然遵守,
不需要例外。

---

## 给 A4a PRD 的建议

1. **一处小的 DESIGN 章节号更正**:任务分派时说的是"§9.3 标了 LangGraph...verity-proven",但我实际
   读到的是 `docs/DESIGN.md` **§9"开工前必须先跑的 spike"这个列表里的第 3 项**(不是子章节 9.3——DESIGN
   §9 本身没有再细分 9.1/9.2/9.3)。原文:"3. `[verity-proven]` LangGraph 跨进程
   interrupt/resume、LiteLLM json_schema 透传、e2e 最小闭环——Verity 已经证明过了;对 aeloop 来说,重写之后
   只需回归验证。"——这次 spike 覆盖的是这一项里"LangGraph 跨进程 interrupt/resume"这半边(Q3/Q4);
   **"LiteLLM json_schema 透传"和"e2e 最小闭环"不在这次 spike 的范围内,后面还需要验证**
   (json_schema 透传更贴合 A2 Harness 的范围;e2e 闭环要等 coder/tester 节点接上真实
   adapter 才有意义,建议留给 A4a 后段或 A4b)。
2. **`workflow-def.ts` 的编译方式隐含一个要求**:DESIGN §6 说 `graph.ts` 应该"从
   WorkflowDefinition 编译而来"——这次 spike 的图是纯手写在代码里的(一个 `buildGraph()` 函数);没有验证
   "从 JSON/YAML 格式的 workflow 定义动态生成一个 StateGraph"这件事本身是否可行。这属于
   "aeloop 自己编排层的设计",而不是"LangGraph 的能力边界",不在这次 spike 5 个问题的范围内,但
   **写 `graph.ts` 时 A4a PRD 必须单独设计这一块**;建议 PRD 把"WorkflowDefinition → 编译到
   StateGraph"列成一条独立的验收项,不要假设它像这次 spike 证明的"手写图"那么简单。
3. **G2/G3 gate + escalation 硬分支这次 spike 没验证**:这次 spike 只搭了一个单独的 G1 gate(直通);
   DESIGN §4 完整的状态机还有 G2(fix 批准分支)、G3(最终复审)、以及 `reject_count >= threshold` 的硬
   escalation 分支(一条条件边)。这次 spike **完全没碰**过 LangGraph 的条件边(`addConditionalEdges`)——这是
   G1/G2/G3 + threshold escalation 所需要的核心机制;建议 A4a 第一个 build 批次把
   `addConditionalEdges` 的最小验证作为最先做的事(哪怕还是用玩具节点),因为这是这次 spike 唯一没有
   实证验证过、而 DESIGN §4 的图上明确需要的一项 LangGraph 能力——风险还没排除。
4. **拆批次的建议**(基于这次 spike 证明的能力边界):
   - **批次 1**:`graph.ts` 骨架 + `nodes/coder.ts`/`nodes/tester.ts`(先用 fixture/假数据起步,
     照着这次 spike 的 Q2)+ 补一份 `addConditionalEdges` 的验证(建议 3 提到的那个缺口)。
   - **批次 2**:`gates.ts`(G1/G2/G3 interrupt,照着 Q3)+ `escalation.ts`(threshold 硬分支,
     用条件边接线)。
   - **批次 3**:`checkpoint.ts`(把 `SqliteSaver` 接到 `workflow_runs.langgraph_thread_id`,
     照着 Q4 的跨进程验证方式,但这次要接到 DESIGN §5 的三张审计表,而不只是 LangGraph 自己的
     `checkpoints`/`writes` 表)。
   - **批次 4**:把 coder/tester 节点换成真实的 A2/A3 adapter(ProviderRouter + CliAdapter),做一次
     真正的 e2e 纵切(DESIGN §8.5 反碎片化方法论警告要求的那种"终点必须是真连接")。
   这样拆能把"LangGraph 机制本身"(批次 1-3)和"接上 aeloop 自己的 harness 层"(批次 4)分开——
   前三个批次的风险已经被这次 spike 大幅降低;批次 4 的风险主要在 A2/A3 adapter 那边,不在
   LangGraph 这边。
5. **目前没有需要指挥官现在就拍板的新岔路**——这次 spike 的 5 个问题都跑得符合预期,DESIGN §4/§5/§6
   现有设计没有被证伪;唯一算得上"决定"的一条是,建议 1 里提到的非官方 npm 包
   `langgraph-checkpoint-sqlite-native` **不应该采用**(继续用官方包 + better-sqlite3)——这次 spike 已经
   替 PRD 把这个判断做了,不需要
   再额外升级讨论;PRD 阶段可以直接这么写。

---

## 附录:这次 spike 改了/装了什么(如实清点)

**改动的文件**(都在 `feature/issue-13-a4a-loop` 分支上,未 commit):
- `package.json` / `pnpm-lock.yaml`——新增 2 个直接依赖(见 Q1 的 diff)
- 新增 `docs/feature/a4a-loop/spike/`:`q1-import.mjs` / `q2-two-node-graph.mjs` /
  `q3-interrupt-resume.mjs` / `q4-graph-def.mjs` / `q4-process-a.mjs` / `q4-process-b.mjs` /
  `q5-types.ts` / `tsconfig.q5.json` / `tsconfig.q5-noskiplib.json`
- 新增文件 `docs/feature/a4a-loop/spike-findings.md`(本文件)

**装的依赖**:`@langchain/langgraph@1.4.8`、`@langchain/langgraph-checkpoint-sqlite@1.0.3`
(+ pnpm 自动解析的传递依赖:`@langchain/core`、`@langchain/langgraph-checkpoint`、
`@langchain/protocol`、`@langchain/langgraph-sdk`、`@standard-schema/spec` 等,一共 20 个包,
细节见 `pnpm-lock.yaml` 的 diff)。

**没改的东西**:`src/`(引擎既有代码零改动)、`main` 分支(整个过程从来没切回去过)、其他任何项目仓库。

**回归确认**:装新依赖 + 加 spike 文件之后,`pnpm lint`(`tsc --noEmit`)和 `pnpm test`(228/228 测试)
保持**全绿**——spike 文件不在 `tsconfig.json` 的 `include: ["src/**/*.ts"]` 范围内,
所以不会干扰现有的 build/test pipeline。
