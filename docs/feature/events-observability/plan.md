# 计划 — aeloop:事件系统(LoopEvent + EventEmitter)

> 是 `PRD.md`(issue [elishawong/aeloop#29](https://github.com/elishawong/aeloop/issues/29))的配套文档。**Rev. 2** —— 在 指挥官 选定方案 C("真实的节点启动语义")、后续的 spike(`spike-node-start.md`)确认 `streamMode: ["updates","tasks"]` 能零纯净性影响地实现它之后做的修订。各批次依次落在既有分支 `feature/issue-29-events` 上 —— 依赖关系的推理见 PRD §6/§7。

## B1 — `src/loop/events.ts` [S]

**文件**:
- `src/loop/events.ts`(新增)
- `src/loop/__tests__/events.test.ts`(新增)

**要做**:
1. 定义 `LoopEventBase { runId: number; threadId: string; ts: string; }`。
2. 定义 **11** 个继承自 `LoopEventBase` 的具体事件接口(PRD §4.2),每个都带一个字面量 `type` 判别字段 —— 包括新增的 `node_started`,以及改名后的 `node_completed`(rev. 1 里叫 `node_entered`)。从 `./types.js` 做 type-only import:`GateType`、`GateDecision`、`EscalationDecision`、`GatePayload`、`LoopNodeName`。
3. `export type LoopEvent = <union of the 11>`。
4. `export type LoopEventListener = (event: LoopEvent) => void | Promise<void>;`
5. `export class LoopEventEmitter`:
   - 私有的 `listeners = new Set<LoopEventListener>()`
   - `on(listener): () => void` —— 加进 set,返回一个会删除它的取消订阅闭包
   - `emit(event: LoopEvent): void` —— 遍历 `listeners`,每个都包在 `try/catch` 里调用;如果返回值是 thenable,给它挂上 `.catch()`(PRD §9.3);捕获到任何错误时(同步或异步),`console.error("LoopEventEmitter: listener threw for event ...", err)` —— 绝不重新抛出。
6. 测试:多监听器扇出;同步抛错隔离(监听器 A 抛错,监听器 B 照样跑,`emit()` 不抛错);异步 rejection 隔离(监听器返回 `Promise.reject(...)`,`emit()` 同步返回、不抛错,rejection 靠一个 spy 挂在错误上报器上来观测);`on()` 的取消订阅确实能停止后续投递。

**交接给 B2 之前的自检**:`npx tsc --noEmit`,`npx vitest run src/loop/__tests__/events.test.ts`。

---

## B2 — `runner.ts` 接线:切换 `streamMode` + 事件类型 1-10 [M/L]

**依赖**:B1。

**文件**:
- `src/loop/runner.ts`(改动)
- `src/loop/__tests__/runner.test.ts`(改动 —— 新增测试小节,不改现有测试)

**要做**(全部在 `runner.ts` 内部,不碰其他文件):
1. 导入 `type { LoopEvent } from "./events.js"`,以及从 `"./events.js"` 导入 `{ LoopEventEmitter }`(值导入)。
2. `StartRunDeps` 新增 `events?: LoopEventEmitter;`。
3. `runStreamAndPersist(...)` 的签名新增第 8 个参数 `emitter: LoopEventEmitter`(排在 `stepCountersIn` 之后)。事件 payload 用的 `threadId` 从既有的 `cfg.configurable.thread_id` 读取 —— 不为它新增参数。
4. **`compiled.stream()` 调用**:`{ ...cfg, streamMode: "updates" as const }` → `{ ...cfg, streamMode: ["updates", "tasks"] as const }`(PRD §4.1/§9.8 —— 这才是真正产出 `node_started` 信号的地方;产出的 tuple 联合类型具体怎么做 TS narrowing,是这里要解决的一个构建期细节,按 PRD §9.8)。
5. **重构外层循环**:`for await (const chunk of stream) { for (const [nodeName, rawUpdate] of Object.entries(chunk)) {...} ; <computeRunProgress+updateRunProgress> }` 变成:
   ```
   for await (const [mode, payload] of stream) {
     if (mode === "tasks") {
       if ("input" in payload) {
         const node = payload.name as LoopNodeName;
         const stepRef = node === LOOP_NODES.apply || node === LOOP_NODES.cancel ? undefined : previewStepRef(stepCounters, node);
         emitter.emit({ type: "node_started", runId, threadId, ts: nowIso(), node, stepRef });
       }
       continue; // "result"-shaped tasks payloads: nothing to do, "updates" mode covers completion.
     }
     // mode === "updates" — payload is exactly today's old bare `chunk`. Everything below this line
     // is the EXISTING draft/review/gate/apply-cancel branch logic, unchanged, just re-nested here.
     for (const [nodeName, rawUpdate] of Object.entries(payload)) { ...unchanged... }
     const progress = await computeRunProgress(compiled, cfg);
     audit.updateRunProgress(runId, progress.patch);
     latestProgress = { interrupt: progress.interrupt, done: progress.done };
   }
   ```
   **关键**:`computeRunProgress()`/`updateRunProgress()` 必须留在 `mode === "updates"` 分支*内部*(也就是靠上面那个 `continue`,`"tasks"` 的迭代完全跳过它)—— 见 PRD §9.6。这是一次粗心的重构里最容易搞错的地方;调用次数的回归测试(下面步骤 9)要在宣布这个批次做完*之前*写,不是之后。
6. 新增辅助函数:`function previewStepRef(counters: Record<string, number>, node: string): string { return \`${node}#${(counters[node] ?? 0) + 1}\`; }` —— 只读,不修改 `counters`(PRD §9.4)。
7. `startRun()`:在 `insertRun()` 返回后(`compileLoopGraph` 之前)立刻 `const emitter = deps.events ?? new LoopEventEmitter();`,然后发出 `run_started`。把 `emitter` 传进 `runStreamAndPersist(...)`。
8. `resumeRun()`:`const emitter = deps.events ?? new LoopEventEmitter();`(这里不发 `run_started`),传进 `runStreamAndPersist(...)`。
9. 在 `mode === "updates"` 分支里(现在多嵌套了一层,函数体除下面标注的以外和 rev. 1 的 plan 一样不变):
   - `draft` 分支:在 `const stepRef = nextStepRef(...)` 之后,发出 `node_completed({node:"draft", stepRef})`。在既有的 `if (update.coderOutput && update.coderResult)` 块内部,`audit.runInTransaction(...)` 返回之后,发出 `agent_completed({node:"draft", actor:"coder", claimCount: coderOutput.claims.length})`。
   - `review` 分支:照上面的样子对应发出 `node_completed({node:"review", stepRef})` / `agent_completed({node:"review", actor:"tester", claimCount: testerOutput.claims.length})`。另外:如果 `testerOutput.verdict === "reject"`,算出 `rejectCount = update.rejectCount ?? prior.values.rejectCount` 并发出 `tester_rejected({rejectCount, rejectThreshold: prior.values.rejectThreshold})`;如果 `rejectCount >= prior.values.rejectThreshold`,还要发出 `escalation_triggered({rejectCount})`。
   - `GATE_NODE_NAMES` 分支:**新增** —— 发出 `node_completed({node: nodeName, stepRef})`(rev. 2 加的;rev. 1 这里没覆盖 gate 节点)。然后,在 `audit.runInTransaction(() => { for (entry of entries) insertApproval(...) })` 返回之后(闭包外面,commit 之后),再遍历一次 `entries`,对每一条发出 `gate_decided({gate: entry.gate, decision: entry.decision, decidedBy: decidedBy!})`。
   - **新增**最后一个分支:`else if (nodeName === LOOP_NODES.apply || nodeName === LOOP_NODES.cancel) { emitter.emit({type:"node_completed", ..., node: nodeName, stepRef: undefined}); }`。
   - **Zorro R1/R2 之后对这一步的修正**(下面原始 plan 低估了一个真实风险 —— 完整来龙去脉见 PRD §9.6/§9.9):`computeRunProgress()`/`updateRunProgress()` 在两个调用点(循环内,以及零 chunk 兜底那处)依然是无条件执行的。但 `gate_requested`/`run_completed`/`run_cancelled` 的发出**不是**简单地"`computeRunProgress()` 跑到哪就在哪发"——LangGraph 的提前执行意味着,处理*更早*一个 chunk 时发出的 `getState()` 读取,可能已经反映了*更晚*那个 gate 的 interrupt,所以事件发出要卡在 `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` 这两个标志位后面,只有在*真正、因果意义上*属于 interrupt/终止信号的那个 chunk 上才为真(只在循环内的调用点生效)—— 零 chunk 兜底那处完全不发这三种事件类型,只同步 progress,因为它本该报告的东西早就被更早到达那个状态的调用报告过了。
10. 测试(`runner.test.ts` 里新增一个小节,和现有 describe 块并列 —— 不要修改任何现有的 `it(...)`):
    - 完整 happy path(start → G1 批准 → review 通过 → G3 批准 → apply):通过 `StartRunDeps.events` 收集事件,断言对每个被访问的节点 `X`,`node_started(X)` 都在 `node_completed(X)`/`agent_completed(X)`/`gate_decided(X)` 之前,并且整体有序的 `type` 序列和 PRD §8 一致。
    - 经过 G2 的 reject-然后-恢复 路径。
    - reject-到-阈值 路径:断言每次 reject 都有 `tester_rejected`,在触及阈值那一轮恰好发出一次 `escalation_triggered`。
    - Escalation "abandon" 路径,以 `node_started(cancel)` + `node_completed(cancel)` + `run_cancelled` 结尾。
    - **新增**:`updateRunProgress` 调用次数的回归测试 —— 在新的 `["updates","tasks"]` streamMode 下,对一次脚本完全相同的 run,spy/统计 `audit.updateRunProgress` 的调用次数,确认和纯 `"updates"` 下应有的次数一致(PRD §9.6/§8)。
    - 回归:跑**既有的**(未改动的)`runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts` 测试套件,确认全部原样通过。

**交接给 B3 之前的自检**:`npx tsc --noEmit`,`npx vitest run src/loop/__tests__/runner.test.ts src/loop/__tests__/audit-store.test.ts src/__tests__/loop.e2e.test.ts`,外加 PRD §8 那三项 grep 检查(零 I/O 纯净性没被碰、`runner.ts` 之外没有 emit 调用点、`streamMode` 显示 `["updates","tasks"]`)。

---

## B3 — `run_failed`(事件类型 11)[S]

**依赖**:B1、B2。

**文件**:
- `src/loop/runner.ts`(改动)
- `src/loop/__tests__/runner.test.ts`(改动 —— 只新增测试小节)

**要做**:
1. 把 `runStreamAndPersist()` 函数体从 `const stream = await compiled.stream(...)` 往后的部分包进 `try { ... } catch (error) { emitter.emit({type:"run_failed", runId, threadId, ts: nowIso(), reason: error instanceof Error ? error.message : String(error)}); throw error; }`。这个 `throw error;` 必须原样重新抛出同一个值 —— 不包装、不换新的错误类型。
2. 测试:强制让一个 adapter 在 run 中途抛错(复用这个套件里别处已经有的"会抛错的 fixture adapter"手法,按 R6-B2 doc comment 里自己提到的 "the tester adapter being unavailable")—— 断言 (a) 调用依然原样抛出同一个错误 (b) 在抛错传到调用方之前,恰好触发了一次 `run_failed` 事件,`reason` 来自那个错误 (c) 抛错之前已经落盘的那些 `AuditStore` 行(同一次调用里更早的 chunk 产生的)依然存在、不受影响 —— 也就是说,加上 try/catch 之后,R6-B2 的"部分进度不变量"依然成立。

**自检**:`npx tsc --noEmit`,`npx vitest run src/loop/__tests__/runner.test.ts`,完整套件 `npx vitest run` 做最后一轮回归。

---

## 完成的定义(全部 3 个批次)

- PRD §8 全部验收标准都打勾。
- `npx tsc --noEmit` 干净。
- 完整 `npx vitest run` 全绿(没有任何既有测试被碰/被弄坏)。
- 交给 Zorro 之前写好 `progress.md`/`impact.md`(按 Helix 基地工作流)。
