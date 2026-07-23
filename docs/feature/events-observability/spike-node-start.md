# Spike — LangGraph 1.4.8 是否真的给出"节点即将执行"信号?

> 受 指挥官 选择方案 C("真实的节点启动语义",而非原 PRD 出货时用的"完成时"语义)委托而做。按 aeloop 的 spike-先行 惯例(参照 A4a 先例,`docs/feature/a4a-loop/spike-findings.md`):先做实证调研,再动 PRD。**这一步不改动任何生产代码** —— `src/loop/*` 未被触碰;唯一新增的文件是 spike 脚本本身(`docs/feature/events-observability/spike/node-start.mjs`)加上这份调研发现文档。

- **环境**:本次会话第一次在这个 worktree 里跑 `pnpm install`(`node_modules` 之前没装过)—— 确认 `@langchain/langgraph@1.4.8` 解析到 `node_modules/.pnpm/@langchain+langgraph@1.4.8_@langchain+core@1.2.3_zod@4.4.3/node_modules/@langchain/langgraph`。
- **Spike 脚本**:`docs/feature/events-observability/spike/node-start.mjs`(真实可跑 —— `node docs/feature/events-observability/spike/node-start.mjs`),一个玩具级 3 节点 graph `draft -> g1 [interrupt] -> review`,和 A4a 自己的 `spike/q3-interrupt-resume.mjs` 同款形状。

## 1. 真实存在的 `streamMode` 选项(核对过真实的 `.d.ts`,不是凭记忆)

`node_modules/.pnpm/@langchain+langgraph@1.4.8_.../dist/pregel/types.d.ts:19`:

```typescript
type StreamMode = "values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools";
```

`runner.ts` 目前只用 `"updates"`(`grep -n streamMode src/loop/runner.ts` → 一处命中,第 330 行 —— 这个 spike 开始前就验证过)。**`"tasks"` 才是这个问题真正要看的**—— 它的类型形状(`types.d.ts:32-40`):

```typescript
interface StreamTasksOutputBase { id: string; name: string; interrupts: Interrupt[]; }
interface StreamTasksCreateOutput<StreamValues> extends StreamTasksOutputBase { input: StreamValues; triggers: string[]; }   // pre-exec shape
interface StreamTasksResultOutput<Keys, StreamUpdates> extends StreamTasksOutputBase { result: [Keys, StreamUpdates][]; }  // post-exec shape
type StreamTasksOutput<...> = StreamTasksCreateOutput<...> | StreamTasksResultOutput<...>;
```

也就是说,`"tasks"` 模式本身在运行时,对*同一次*节点访问会产出**两种不同形状**:一个 `"input" in payload` 的 **create**(执行前)事件,和一个 `"result" in payload` 的 **result**(执行后)事件 —— 靠哪个字段存在来区分。

## 2. 源码级确认:create 形状的事件在结构上确实是在节点执行*之前*发出的

`dist/pregel/loop.js` 里 `PregelLoop.tick()`("准备 + 决定要不要推进一步"这个方法):

```js
// loop.js:521-524
if (this.stream.modes.has("tasks") || this.stream.modes.has("debug")) {
  const debugOutput = await gatherIterator(prefixGenerator(mapDebugTasks(taskList), "tasks"));
  this._emit(debugOutput);   // <-- emits the CREATE-shaped events
}
return true;
```

`dist/pregel/index.js` 里的 `_runLoop()`(真正驱动每一步的循环):

```js
// index.js:1201-1207 (abridged)
while (await loop.tick({ inputKeys: this.inputChannels })) {   // <-- CREATE events emitted inside loop.tick(), which fully resolves here
  ...
  await runner.tick({ ... });   // <-- THIS is what actually invokes node bodies (PregelRunner.tick(), runner.js:47)
}
```

`loop.tick()`(它会为这一步里每个即将运行的 task 发出 `"tasks"` CREATE 事件)在 `runner.tick()`(真正调用节点函数的那个)被调用之前**就已经返回**。这是一个真实的、结构性的、引擎级的"先宣布、再调用"顺序 —— 不是异步调度的偶然结果 —— 而且**完全不需要改动任何节点函数体**:`mapDebugTasks()` 读的是 `taskList`(已经由 `_prepareNextTasks()` 从 checkpoint + channels 算好),从不碰 `gates.ts`/`nodes/*.ts`/`escalation.ts`。

## 3. 实证证据(真实跑出来的,不是模拟的)

`node docs/feature/events-observability/spike/node-start.mjs` 的完整捕获输出:

```
[1] === first stream() call (draft -> g1 interrupt): compiled.stream(..., {streamMode: ["updates","tasks"]}) ===
[2] draft: body START {"task":"toy task: add a function"}
[3]   chunk mode=tasks shape=CREATE (pre-exec) name=draft {"id":"4436389d-..."}
[4] draft: body END (about to return)
[5]   chunk mode=updates {"nodeNames":["draft"]}
[6] g1: body START (about to interrupt()) {"coderOutput":"fake diff for: toy task: add a function"}
[7]   chunk mode=tasks shape=RESULT (post-exec) name=draft {"id":"4436389d-..."}
[8]   chunk mode=tasks shape=CREATE (pre-exec) name=g1 {"id":"d0c63e06-..."}
[9]   chunk mode=updates {"nodeNames":["__interrupt__"]}
[10]   chunk mode=tasks shape=RESULT (post-exec) name=g1 {"id":"d0c63e06-..."}
[11] === resuming via Command({resume: 'approved'}) ===
[12] === second stream() call (g1 decided -> review -> end): compiled.stream(..., {streamMode: ["updates","tasks"]}) ===
[13] g1: body START (about to interrupt()) {"coderOutput":"fake diff for: toy task: add a function"}
[14] g1: resumed with decision "approved"
[15]   chunk mode=tasks shape=CREATE (pre-exec) name=g1 {"id":"d0c63e06-..."}
[16]   chunk mode=updates {"nodeNames":["g1"]}
[17] review: body START {"gateDecision":"approved"}
[18]   chunk mode=tasks shape=RESULT (post-exec) name=g1 {"id":"d0c63e06-..."}
[19]   chunk mode=tasks shape=CREATE (pre-exec) name=review {"id":"2ff17307-..."}
[20] review: body END (about to return)
[21]   chunk mode=updates {"nodeNames":["review"]}
[22]   chunk mode=tasks shape=RESULT (post-exec) name=review {"id":"2ff17307-..."}
[23] Spike done.
```

**结论:是的 —— `streamMode: ["updates", "tasks"]` 用一个现成的、有文档记载的 LangGraph 特性,给每个节点提供了真实的 create / 执行前形状的事件,而且不需要改动任何节点函数体。** 这就解决了 PRD 里原本那个 `[?]` —— 方案 A(LangGraph 干净地给出这个信号)才是真正的答案,**不是**"必须给节点函数体打桩、破坏零 I/O 纯净性"那条兜底路径。

## 4. 实测中发现的一个如实警告 —— 在过度断言"严格在……之前"前先读这段

看顺序 `[2]`/`[3]` 和 `[13]`/`[15]`:某个节点的 `tasks` CREATE chunk,**外部的 `for await` 消费者**每次观测到的时机,都是在那个节点自己的同步开场逻辑已经打印之后(`[2]` 是 `draft: body START`,`[3]` 才是 CREATE;续跑时,`[13]`/`[14]` 的 `g1: body START`+`resumed` 完全跑完,才在 `[15]` 观测到 CREATE(g1))。

**原因**:`loop.tick()` 确实是在 `runner.tick()` 调用节点之前,把 CREATE 事件真实地塞进了 stream 内部队列(§2 那条引擎级保证是真的)。但*外部*的 `for await` 消费者只有在自己那个挂起的 `.next()` promise 的 microtask 被调度到时,才拿得到排队的 chunk —— 而一个刚被调用节点的同步代码(直到它第一个真正的 `await` 为止的所有部分,如果这个节点根本没有 `await`,像这次 spike 里的 `g1Node`,那就是它的全部代码)会先跑完,JS 才会把控制权交还给另一条独立挂起的 microtask 链。这是消费者一侧的 **JS 续延排序特性**,不是 LangGraph 自身内部时序的缺陷 —— 引擎确实是"先决定 + 宣布,再执行",但"宣布"落到外部消费者手里要走普通的 microtask 排队,一段同步的(或已经排好队的)消费者外部代码可以在这个排队过程里抢跑到前面。

**对这份代码库真实节点的实际影响**(`nodes/coder.ts`/`nodes/tester.ts`,两个都是 `async` 函数,真正干活的部分是通过 `adapter.invoke()` 发出的网络/API 调用,生产环境里要花几百毫秒到几秒):`runner.ts` 的消费循环观测到 CREATE 事件的时机,会比节点的同步开场逻辑(组装 prompt、解析 adapter)开始运行晚个亚毫秒到几毫秒 —— 就所有实际用途而言(CLI/TUI 进度指示器、`EventProjector` 的时间戳),这和"节点刚刚启动"没有区别,而且比现在已上线的行为(要等*整个*耗时数秒的 LLM 往返彻底结束才会触发任何东西)早得多。**这和数学上可证明的"永远严格在节点函数体第一行运行之前"这种保证不是一回事** —— 那种保证一般情况下不成立(这次 spike 自己的 `g1Node`,完全同步,就是一个反例)—— 但对这个事件真正要服务的那些真实节点来说,这是一个数量级上的、分类意义上的改善,而且不需要碰任何节点函数体。

## 5. 选定的机制(直接喂进修订版 PRD)

- `runner.ts` 里的 `compiled.stream(input, { ...cfg, streamMode: ["updates", "tasks"] })` —— `runStreamAndPersistCore()` 内部**唯一**一处 `compiled.stream()` 调用点(`startRun()` 和 `resumeRun()` 共用,两者都调用同一个函数 —— 不是两个独立调用点),目前是 `streamMode: "updates" as const`,会变成一个数组。
- 现有的 `"updates"` 模式处理逻辑(draft/review/gate/apply-cancel 各分支,`computeRunProgress()`/`updateRunProgress()` 的调用节奏)**内容完全不变** —— 只是往 `mode === "updates"` 这个判断下面多嵌套了一层,因为外层的 `for await` 现在产出的是 `[mode, payload]` 元组,而不是裸的 chunk 对象(形状通过上面的 `[5]`/`[9]`/`[16]`/`[21]` 确认过:`mode==="updates"` 时的 `payload`,和 `runner.ts` 今天已经在消费的 `{nodeName: partialUpdate}` 形状逐字节相同)。
- **`computeRunProgress()`/`audit.updateRunProgress()` 只能在 `mode==="updates"` 的迭代里跑,不能在 `"tasks"` 的迭代里跑** —— 否则加上 `"tasks"` 模式会让每次调用的外层循环迭代次数大致翻倍(真实每次节点访问会有一个 `updates` + 一到两个 `tasks` chunk,比如 `[3]`+`[5]`+`[7]` —— 一次 `draft` 访问就有 3 个 tasks/updates chunk),如果对每一个都调用 `computeRunProgress`/`updateRunProgress`(而不是像今天这样只对 `updates` 的调用),会没必要地让 `AuditStore` 的写入和 `getState()` 的读取相对现在翻倍。这是唯一一处值得标出来的"如果实现不小心就会意外回归"的风险点 —— 修订版 PRD 把这个明确列成了一条可测试的验收标准。
- CREATE 形状的 `"tasks"` chunk(`"input" in payload`)→ 发出新的 `node_started` 事件,覆盖**每一个**真实节点名(`draft`/`g1`/`review`/`g2`/`g3`/`apply`/`escalation`/`cancel` —— 全部 8 个,不再需要排除 gate 节点,因为这个机制对所有节点类型都是统一的)。RESULT 形状的 `"tasks"` chunk(`"result" in payload`)**不使用** —— PRD 其余 8 种事件类型需要的完成数据,`"updates"` 模式已经给出了等价或更丰富的版本。

## 6. 对零 I/O 纯净性的影响:无

在这个设计下,`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 依然是空的 —— 这些路径下没有任何文件被这次改动碰到。唯一变动的文件是 `runner.ts`(一个 `streamMode` 值 + 它自己消费循环的解构方式)。**这个 issue 不存在需要签字确认的纯净性取舍** —— 军师标出来要权衡的"必须给节点函数体打桩"那条兜底路径,根本用不上。
