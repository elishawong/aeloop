---
feature: events-observability
status: in_progress
last_updated: 2026-07-21 (Zorro R4 返工后 —— code 层 merge-ready,纯 doc 收尾)
---

# Progress — aeloop Event System (LoopEvent + EventEmitter, issue #29)

> **▶ 下一步(RESUME 指针)**:第四轮 Zorro 审 FAIL——Zorro 明确说代码全对、R3 的 export blocker 真闭合、spy 测法变异验证过,**code 层 merge-ready**,FAIL 只因两处文档没跟上 shipped 行为(纯 doc 轮,未碰任何代码逻辑)。已修完,本地自检全绿(build/lint/test,317/317)。下一步是**再交 Zorro 五审**(预期只是确认这轮 doc 修正,不再有代码层 blocker)——尚未提交/推送(未获授权),分支 `feature/issue-29-events` 上有未提交的工作区改动。知识库 `CHARTS/knowledge/aeloop.md` 更新留到 merge 后(军师裁定,不在这轮)。

## 返工记录(第四轮 Zorro 审 FAIL → 修复,纯 doc 轮,2026-07-21)

Zorro R4:代码全对,唯二问题都是文档没跟上 B1 修复后的实际行为。

### 🔴 必修 1 —— PRD §4.2 事件目录 rows 5/9/10 还在描述 B1 修复前的行为,且假标"✅ verified (unchanged from rev. 1)"
- **问题**:row 5(`gate_requested`)写的是"Right after **either** `computeRunProgress()` call site whenever `progress.interrupt` is truthy"——这正是 R1 那个制造重复/顺序错乱的旧行为,不是 shipped 的样子。rows 9/10(`run_completed`/`run_cancelled`)同款泛化措辞。三行都还标着"✅ verified (unchanged from rev. 1)",但这段发射逻辑恰恰是 B1 整个重写的,不是"unchanged"。
- **修法**:三行都重写成 shipped 实况——row 5 说清楚:`computeRunProgress()`/`updateRunProgress()` 仍然每次 `"updates"` 迭代无条件跑,但**事件发射**只在 `interruptSeenThisChunk` 为真(in-loop 遇到那个真正带 `__interrupt__` 键的因果 chunk)时才发,zero-chunk 兜底分支永远不发;row 9/10 同理绑定到 `terminalNodeSeenThisChunk`。三行的"Verified?"列都改成"✅ verified against shipped code"+ 明确标注"不是 unchanged from rev.1,这段发射逻辑是 B1 重写的"。这张表是下游 Conductor/EventProjector 理解语义的设计权威,必须和代码一致。

### 🔴 必修 2 —— `runner.ts:459` 注释点名错 prototype + rebuild
- **问题**:注释说测试用的是 `Pregel.prototype.stream` spy,但 R3 实际改成了 spy `CompiledStateGraph.prototype.stream`(因为 `Pregel` 是 `.d.ts`-only 类型,运行时 `undefined`)——注释没跟着改名。
- **修法**:改注释为正确的 `CompiledStateGraph.prototype.stream`,并补一句解释为什么不是 `Pregel.prototype`(`Pregel` 是类型层导出、不是真实运行时导出)。跑了 `pnpm build`,确认 `dist/loop/runner.js` 里的注释文本真的更新了(用时间戳 + grep 核实过)。

### 🟡 顺手 1 —— spy 测试加计数断言
- `runner.test.ts` 的 zero-chunk spy 测试加了 `expect(streamSpy).toHaveBeenCalledTimes(1)`,锁死注入点本身:既防"spy 压根没触发导致后面断言全是空对空",也防"除了这次 resumeRun 还有别的地方意外碰了 .stream()"。

### 🟡 顺手 2 —— `compiled.stream()` "both call sites" 表述收敛
- `PRD.md`(原 §8 acceptance criteria 那条 grep 断言)和 `spike-node-start.md` 都有一句说 `compiled.stream()` 有"两个调用点"——实际上整个文件只有**一个**共享的 `compiled.stream()` 语法调用点(在 `runStreamAndPersistCore()` 里),`startRun`/`resumeRun` 都是走同一个函数、同一次调用,不是各自独立调两次。两处都订正为"one call site, shared by both entry points"。(和上一轮已经修过的 `emitProgressEvents` "both call sites" 是两码事,那条说的是 emitProgressEvents 曾经有 in-loop + zero-chunk 两个调用点,已在 R2/R3 收敛成一个;这条说的是 `compiled.stream()` 本身从来就只有一个调用点,表述一直是错的,现在才发现。)

### 本轮自检
- **纪律**:本轮**只碰了** `runner.ts` 一处注释(逻辑字节零改动,用 diff against 上一轮备份确认过)+ `runner.test.ts` 一条新断言 + 三份文档(`PRD.md`/`spike-node-start.md`/本文件)。
- `pnpm build && pnpm lint && pnpm test`:全绿,317/317(测试数没变——只是给已有测试加了一条断言,没加新 `it()`)。rebuild 后确认 `dist/loop/runner.js` 的注释文本已同步。
- grep 纯度检查依旧全空。
- 未 commit / 未 push。

## 返工记录(第三轮 Zorro 审 FAIL → 修复,2026-07-21)

Zorro R3 确认 R2 的两条收尾都真封口了(变异验证过),唯一 blocker 是 R2 为测 zero-chunk 分支临时导出的 `runStreamAndPersist`——这本身是个新风险。

### 🔴 必修 —— 删掉 `export runStreamAndPersist`,测试改走 public API + spy
- **根因**:`runStreamAndPersist` 自身零 runId↔threadId 绑定校验、零决策域校验——那些守卫(`RunThreadMismatchError`、R5-B1/R6-B1 的 per-gate resume-decision domain 检查)全在 `resumeRun()` 里,在调用这个函数**之前**。R2 把它 export 出去,等于对外开了一个绕过三轮加固守卫的原语——直调 `threadId B + runId A` 能造出审计分裂态。`// test-only` 注释不构成真实边界,编译产物 `dist/*.d.ts` 也照样把它暴露出去(已用 `grep -n "declare function\|export declare" dist/loop/runner.d.ts` 核实:修完后只剩 `startRun`/`resumeRun`/`getResumableRuns` 三个导出,`runStreamAndPersist` 不在里面)。
- **修法**:`runStreamAndPersist` 去掉 `export`,回到内部函数;`runner.test.ts` 删掉对它的直接 import。
- **测试改法(Zorro+Codex 已验证的替代方案,照做)**:zero-chunk 分支现在经**真实公开 API**(`resumeRun`)+ 一次性 spy 命中——具体注入点:`compileLoopGraph()`/`buildLoopGraph()` 建出的是 `CompiledStateGraph` 实例(继承链 `CompiledStateGraph extends CompiledGraph extends Pregel`,`.stream()` 定义在 `Pregel.prototype` 上,`CompiledStateGraph`/`CompiledGraph` 都没有自己重写它)。**踩了一个坑**:一开始想直接 `import { Pregel } from "@langchain/langgraph"` 去 spy `Pregel.prototype.stream`,`tsc` 编译通过(`.d.ts` 里有 `Pregel` 的类型声明),但**运行时 `Pregel` 是 `undefined`**——核实过:真实的 `dist/index.js` 自己的 `export {...}` 语句里根本没有 `Pregel`(只在 `.d.ts` 类型层出现,是类型声明和运行时导出对不上的一个真实陷阱)。改成 spy **`CompiledStateGraph.prototype.stream`**(`CompiledStateGraph` 确认是真实的运行时导出)——`vi.spyOn` 在 `CompiledStateGraph.prototype` 上定义一个新的**自有**属性遮蔽掉从 `Pregel.prototype` 继承来的那个,`Pregel.prototype` 本身完全不受影响,而 `runner.ts` 内部建的每个 compiled 图实例都是真正的 `CompiledStateGraph` 实例,`.stream()` 调用会先命中这个遮蔽属性。
- **测试场景**:在一个**真实 G1-paused 的 run**(经 `startRun` 公开 API 驱动)上,用 `mockImplementationOnce` 让下一次 `compiled.stream()` 调用(即 `resumeRun` 内部那次)返回一个空 async generator——这样 resume 的 `Command` 从未真正被处理,checkpoint 原地不动,run 仍卡在 G1(比 R2 那个"已终态 apply 后再调一次"的场景更贴近旧 bug 本来的样子:"门仍 pending"时不该重发)。断言:`resumed.interrupt?.gate === "G1_SEND_TO_TESTER"`、`resumed.done === false`、且这次调用**没有**新的 `gate_requested`/`run_completed`/`run_cancelled` 事件。
- **先红后绿**:临时把 R2 的修复换回旧版本(`emitProgressEvents` 无条件加回 zero-chunk 分支)跑这条新测试,确认真的红(`gate_requested` 被重发了一次);换回修复版本后确认转绿。

### 🟡 顺手 1 —— stale 注释订正
- `runner.ts` 的 `emitProgressEvents` doc comment 原来写"服务 in-loop + zero-chunk 两个调用点",R2 已经把 zero-chunk 那次调用删了,现在只剩一个调用点——订正措辞,顺带把"为什么只剩一个"的原因(exactly-once 不变量)写清楚。
- `plan.md` 里同款的过期表述("At both computeRunProgress() call sites...")一并改成反映最终实现(gate_requested 等三个事件类型只在 in-loop 那个因果 chunk 命中时发,zero-chunk 兜底分支不发)。

### 🟡 顺手 2 —— PRD §9.9 措辞收紧
- 把安全性质的框架从"同步 vs 异步 checkpointer"改成真正决定性的两条:①**每个 thread 被串行驱动**(没有两个 `resumeRun`/`startRun` 并发打同一个 thread)②读的是**读后写一致**的 checkpoint store——一个强一致的异步 saver 也可能安全,反之亦然。
- 明确标出 ①**不是**这个代码库结构性保证的东西——`audit-store.ts` 的 R5-B2 注释原文就写着"no lock/CAS/serialization backs resumeRun() against two concurrent calls resuming the *same* run",317 个测试证明的是"串行使用下这条路径每一步都对",证明不了"并发不会发生"。措辞已经如实标注,不再暗示"单调用者被强制"。

### 🟡 顺手 3 —— 测试数统一
- `PRD.md` §9.9、`impact.md`、`progress.md` 的当前状态描述统一订正为最终的 317(历史记录里各轮"之前→之后"的过程数字保留不改,那些是真实的时间线记录,不是当前状态声明)。

### 本轮自检
- `pnpm build && pnpm lint && pnpm test`:全绿,317→317(测试总数没变——1:1 替换了 zero-chunk 那条测试的实现方式,没加也没删测试条目)。
- `diff` 校验:每次临时改动(revert 测试确认红/CompiledStateGraph 调试)后都用备份文件比对确认恢复干净,`git diff --stat -- src/loop/runner.ts` 显示的改动只有预期的这几处,没有意外 diff。
- grep 纯度检查依旧全空。
- 未 commit / 未 push。

## 返工记录(第二轮 Zorro 审 FAIL → 修复,2026-07-21)

Zorro R2 确认 R1 的两个 blocker 真修好了(它自己的探针复现 `gr_g3=1`、顺序对),但又挑出几处收尾问题:

### 🔴 必修 1 —— `safeErrorReason` 修一半,注释兑现不了(幻觉门命中)
- **根因**:R1 版本的 `safeErrorReason` 只把 `String(error)` 那个 fallback 分支包进了 try,`error instanceof Error` 判断和 `error.message` 的访问都在 try **外面**——但函数自己的注释写着「guaranteed never to throw itself」。一个 `message` getter 会抛的 `Error` 直接戳穿这个保证,注释兑现不了,是 Zorro 判定的幻觉门(声称的行为和代码实际行为不一致)。
- **修法**:把 `instanceof` 判断和 `.message` 访问都挪进同一个 try,`String(error.message)` 多包一层防止 `.message` 本身是个 toString 会抛的怪值。
- **测试**(先红后绿,但过程里发现一个重要的额外事实):最初写了一个"tester adapter 抛出一个 `.message` getter 会抛的 Error"的测试,结果发现 **LangGraph 自己的 `PregelRunner._commit()`**(`dist/pregel/runner.js:205`)在节点抛错时会**在到达我们自己的 catch 之前**先访问一次 `.message`——这是 LangGraph 内部的脆弱点,不是我们 `safeErrorReason` 能修的,也不是 Zorro 这次要求修的范围。把测试改成**从 `audit.updateRunProgress` 直接抛**(绕开 LangGraph 的节点执行/错误提交机制,直接命中 runner.ts 自己的 catch 块)才是真正隔离测试 `safeErrorReason` 自己契约的正确方式。改用这个技术后,先临时把 `safeErrorReason` 换回半修版本跑一遍确认真的红(拿到的是"0 个 run_failed 事件",不是"error 被换掉"——因为外层 wrapper 的 `try{emit}finally{throw error}` 结构本身已经保证了重抛不受影响,半修版本真正丢失的是 `run_failed` 事件本身,没发出去),修复后确认转绿。

### 🟡 必修 2 —— zero-chunk 兜底分支破坏「gate_requested 恰好一次」的结构性保证
- **根因**:`if (!latestProgress)` 这个"这次调用一个 chunk 都没产生"的兜底分支,原来无条件调 `emitProgressEvents`。虽然经由 `resumeRun`/`startRun` 这条合法公开路径今天走不到这个分支处于已暂停/已终态的场景(每个门的 resume-decision-domain 守卫会先拦下来,且任何合法 decision 都会让暂停的节点重跑、至少产生一个 chunk),但代码结构本身没有把这件事钉死——纯属"现在没被戳穿",不是"结构上不可能"。
- **修法**:这个分支现在只同步 `computeRunProgress`/`updateRunProgress`/`latestProgress`,不再调用 `emitProgressEvents`。
- **测试**(先红后绿):由于这个分支确实经公开 API 走不到,新增测试把 `runStreamAndPersist` 本身导出(**仅供测试用**,doc comment 写明不是公开 API 的一部分,`startRun`/`resumeRun` 已完整覆盖真实调用方),绕开 `resumeRun` 自己的 domain 守卫,直接驱动同一个真实编译图连续 4 次:①draft→g1 暂停 ②g1 approve→review(pass)→g3 暂停 ③g3 approve→apply(done)④**同一个已终态的 thread 上再调一次**——第 4 次调用经验证(用真实 LangGraph 1.4.8 行为验证过)`compiled.stream()` 确实吐 0 个 chunk,不抛异常。临时把修复换回旧版本跑这条测试,确认真的红(`run_completed` 被重发了一次);修复后确认转绿(第 4 次调用不产生任何新事件)。

### 🟡 doc nit
- `impact.md` 里写的测试数(313)和 `progress.md`(当时 315)对不上——已订正为本轮最终的 317,并把 P0 回归项那行的分解写清楚(299 原有 + 首轮 14 + R1 返工 2 + R2 返工 2)。

### PRD 补记(军师裁定:不重构代码,只记 known-limitation)
- Zorro 的 B1-1(事件身份/内容仍然源自事后 `getState()`,而不是直接从因果 chunk 自己的载荷派生)——军师判定:在 aeloop **同步 SQLite checkpointer + 单进程驱动单 run**(不支持同 thread 并发 resume)的当前架构下,这条路径的每一步都是对的(317 个测试 + Zorro 自己的探针为证),只有引入异步 checkpointer 或允许同 thread 并发 resume 才会重新打开这类 race 窗口。**加进 `PRD.md` §9.9 "Known Limitation"**,写明这个限制的边界条件 + 未来真要做这两件事之一时应该怎么改(直接从 `__interrupt__`/终态 chunk 自己的载荷派生事件内容,不再依赖第二次 `getState()` 读)。本轮**不碰代码**,纯文档补记。

### 本轮自检
- `pnpm build && pnpm lint && pnpm test`:全绿,315(上轮)→317(+2:必修 1 的 message-getter 测试 + 必修 2 的 zero-chunk 回归测试)。
- grep 纯度检查依旧全空。
- 未 commit / 未 push。

## 返工记录(第一轮 Zorro 审 FAIL → 修复,2026-07-21)

Zorro(Codex 二签 + 亲自写探针在真实图上复现)判 FAIL,两个真 bug + 三条顺手硬化:

### 🔴 B1(主 blocker)—— `gate_requested`/`run_completed`/`run_cancelled` 重复发射 + 顺序错乱
- **根因**:`emitProgressEvents()` 挂在"每个 `mode==='updates'` chunk 处理完都无条件调用一次”,而 `computeRunProgress()`/`getState()` 反映的是**调用那一刻的图真实位置**,不是"这个 chunk 对应的位置"——LangGraph 内部执行会跑在consumer 消费节奏前面(和 spike 里 `node_started` 的"观测到的时机会晚于真实执行"是同一类 race,只是这次反过来:`getState()` 提前看到了下一个门已经暂停),导致同一个门的 `gate_requested` 在处理"更早的 chunk"时就先发了一次(且发生在该门自己的 `node_started` 之前),又在真正处理 `__interrupt__` chunk 时再发一次。
- **修法**:新增 `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` 两个每次 outer-loop 迭代重置的标志位,只在**真正处理到 `__interrupt__` 键**或**真正处理到 `apply`/`cancel` 节点键**的那次迭代才调用 `emitProgressEvents()`;`computeRunProgress()`/`audit.updateRunProgress()` 本身仍然每次 `"updates"` 迭代都无条件调用(R6-B2 不变量 + PRD §9.6 写入 cadence 回归测试都依赖这点不变)。zero-chunk 兜底路径(`if (!latestProgress)`)保持无条件发射不变——那条路径没有 race 风险(这次调用压根没有任何 chunk 产生,`getState()` 反映的就是调用前已有的真实状态)。
- **测试**:先在既有的 "full G1-approve...apply run" 测试和 "reject-to-threshold" 测试里追加 `gate_requested` 精确计数(每个门恰好 1 次)+ `node_started(X) < gate_requested(X)` 顺序断言,**在修 runner.ts 之前先跑,两条都复现红**(`expected [...] to have a length of 1 but got 2`)——证实这就是 Zorro 描述的那个 bug,不是别的。修完 runner.ts 后两条转绿。同时补了 escalation 路径的 `node_started(escalation)` 覆盖 + g1/g2 门的 `node_completed` 覆盖(Zorro 点名的测试盲区)。

### 🔴 B3(顺手修)—— `run_failed` 的 `String(error)` 可抛,导致原始 error 丢失
- **根因**:`reason: error instanceof Error ? error.message : String(error)` 在构造 `run_failed` 事件对象字面量时求值,如果 `error` 不是 `Error` 且它自己的 `toString()` 会抛,`String(error)` 本身就在 `emitter.emit(...)` 被调用**之前**抛出——这个新异常会替换掉 catch 块里原本要 `throw error` 重抛的那个原始值,永久丢失。
- **修法**:新增 `safeErrorReason()`(自身绝不抛,`toString()` 抛就回退成固定占位串);把 `emit(run_failed)` 包进 `try { ... } finally { throw error; }`——`finally` 里的 `throw` 无条件执行且会覆盖 try 块内任何异常,保证不管 emit 阶段发生什么,重抛的**永远是原始 `error`**。
- **测试**:新增一个 `toString()` 自身会抛的自定义抛出物测试,**先在修复前跑(临时把 wrapper 换回未加固版本)确认真的红**(`.rejects.toBe(thrownValue)` 断言失败,实际收到的是 LangGraph 包装过的 `Error`,原始值已经丢了——和 Zorro 描述的后果完全一致),修复后确认转绿(`.rejects.toBe(thrownValue)` 通过,`reason` 是占位串)。

### 🟡 顺手硬化(非阻断)
- `LoopEventEmitter.emit()`:`.catch()` 直接调在 `result` 上 → 改成 `Promise.resolve(result).catch(...)`,兼容"裸 thenable"(只有 `.then`、没有 `.catch` 方法的对象)。**验证方式**:临时把 emit() 换回旧写法跑新测试,确认差异真实存在——旧写法虽然不会让异常逃出 `emit()`(外层 try/catch 兜底),但会**误报**成 `"result.catch is not a function"` 而不是真实的拒绝原因;新写法能正确报出真实原因。这也印证了 Zorro 的判断:这条本来就不是阻断项(隔离在旧代码下已经成立),现在是硬化。
- `reportListenerError` 自身包一层 try/catch,让"emit 永不抛"在 `console.error` 本身被换掉也抛的极端情况下依然成立。
- `runner.ts` 的 `"tasks"` 分支:`payload.name as RealLoopNodeName` 加一层 `isRealLoopNodeName()` 运行时成员校验(基于 `Object.values(LOOP_NODES)`),不认识的节点名直接跳过、不再盲目 cast。`"updates"` 分支里同类型的 cast 本来就已经被 `GATE_NODE_NAMES.includes(...)`/`nodeName === LOOP_NODES.apply/cancel` 的 if 分支守住了,不需要再加。

### 本轮自检
- `pnpm build && pnpm lint && pnpm test`:全绿,313(上轮)→315(+2:B3 新增 1 条 toString 测试 + events.test.ts 新增 1 条裸 thenable 硬化测试;B1 的新断言是加在既有测试里,没新增 `it()` 数量)。
- grep 纯度检查(`gates.ts`/`escalation.ts`/`graph.ts`/`nodes/`)依旧全空——本轮改动只碰了 `runner.ts`/`events.ts`/两个测试文件。
- 未 commit / 未 push。

- **关联 PRD / Plan**:`./PRD.md`(rev. 2)· `./plan.md` · `./spike-node-start.md`

## 批次进度

### B1 — `src/loop/events.ts` (LoopEvent + LoopEventEmitter)
- 状态:完成
- 做了什么:新建 `src/loop/events.ts`(11 个 LoopEvent 类型的判别联合 + `LoopEventEmitter` 类:同步 emit + 每监听器 try/catch 隔离 + async 监听器 rejection 靠 `.catch()` 兜底);新建 `src/loop/__tests__/events.test.ts`(6 个纯 emitter 单测:多监听器 fan-out、unsubscribe、同步抛错隔离、async rejection 隔离、非 thenable 返回值不误报、零监听器不报错)。
- 改了哪些文件:`src/loop/events.ts`(新)、`src/loop/__tests__/events.test.ts`(新)
- 本地自检:`pnpm build` 绿 / `pnpm lint`(`tsc --noEmit`)绿 / `pnpm test` 299→305(+6)全绿
- 备注 / 卡点:无

### B2 — `runner.ts` 接线:`streamMode` 切换 + 事件类型 1-10
- 状态:完成
- 做了什么:
  - `StartRunDeps` 加 `events?: LoopEventEmitter`(可选,缺省内部 `new LoopEventEmitter()`)。
  - `runStreamAndPersist`(现拆成 thin wrapper + `runStreamAndPersistCore`)的 `compiled.stream()` 调用从 `streamMode:"updates"` 换成 `streamMode:["updates","tasks"]`(spike 已证:零改 `gates.ts`/`nodes/*.ts`)。
  - 外层 for-await 循环重构成 `[mode,payload]` 判别元组分派:`mode==="tasks"` 分支(仅 create 形态)发 `node_started`(全部 8 个真实节点均覆盖,不再像 rev.1 排除 gate 节点);`mode==="updates"` 分支保留现有 draft/review/gate/apply-cancel 持久化逻辑**逐字未改**,只是多缩进一层 + 在旁边追加 `node_completed`/`agent_completed`/`gate_decided`/`tester_rejected`/`escalation_triggered` 的 emit 调用。
  - 新增 `previewStepRef()`(只读预览,不 mutate `stepCounters`)+ `emitProgressEvents()`(把 `gate_requested`/`run_completed`/`run_cancelled` 的判定逻辑收敛成一个共享 helper,供 in-loop 和 zero-chunk fallback 两个调用点共用,避免两处判断逻辑跑偏)。
  - `startRun()` 在 `insertRun()` 后立刻发 `run_started`(先于任何其他事件)。
  - 新增测试(`runner.test.ts` 追加一个 `describe` 块):startRun 首次调用的精确事件顺序(spike 验证过的 2-节点交错模式)、全通过路径(G1→review pass→G3→apply)的 node_started 先于 node_completed/agent_completed/gate_decided 的相对顺序断言、reject-to-threshold 路径的 tester_rejected/escalation_triggered 精确计数与顺序、abandon 路径的 run_cancelled、一个抛错监听器不崩真实 run 且不影响审计写入的端到端隔离验证、**`updateRunProgress` 调用次数回归测试**(独立起一份手动 `streamMode:"updates"`-only 的对照 drive,和真实实现的 spy 计数比对,证明加了 `"tasks"` 模式后调用次数没变)。
- 改了哪些文件:`src/loop/runner.ts`(改)、`src/loop/__tests__/runner.test.ts`(改,只追加新 describe 块,未动任何既有 `it(...)`)
- 本地自检:`pnpm build` 绿 / `pnpm lint` 绿 / `pnpm test` 305→311(+6)全绿;`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 空(纯度不变量未破);`grep -n "emit(\|LoopEvent" src/loop/gates.ts src/loop/escalation.ts src/loop/nodes/coder.ts src/loop/nodes/tester.ts src/loop/audit-store.ts` 空(所有 emit 调用点确实只在 runner.ts)。
- 备注 / 卡点:写测试时踩了两个我自己的测试逻辑错(非生产代码 bug):① `gate_decided` 索引查找忘了按 `gate` 字段过滤,拿到的是"第一个 gate_decided"而不是"这个 gate 自己的";② reject-to-threshold 测试漏算了一步(G2 approve 后会先回到 g1 再到 review,不是直接到 review)。两处已修正,测试现在准确反映真实图拓扑。

### B3 — `run_failed`(事件类型 11)
- 状态:完成
- 做了什么:把原 `runStreamAndPersist` 函数体原封不动地重命名为 `runStreamAndPersistCore`(**一行未改、未重新缩进**),新增一个薄 wrapper `runStreamAndPersist`(签名不变,`startRun`/`resumeRun` 的调用点因此零改动)在 try/catch 里调用 core:catch 到任何异常就 `emit({type:"run_failed",...reason})`,然后 `throw error`(原样重抛同一个 error 实例,不包装、不换类型)。
- 改了哪些文件:`src/loop/runner.ts`(改)、`src/loop/__tests__/runner.test.ts`(改,追加一个 describe 块)
- 本地自检:`pnpm build` 绿 / `pnpm lint` 绿 / `pnpm test` 311→313(+2)全绿。新测试验证:(a) 强制 tester adapter 抛错场景下 `resumeRun(...).rejects.toBe(thrownError)`——**同一个** Error 实例,不是包装/换类型的副本;(b) 恰好一个 `run_failed` 事件、reason 取自该 error、是这次调用最后一个事件;(c) R6-B2 那条"已落地的部分进度不受影响"的老不变量重新验证一遍(G1 approval 仍在,`workflow_runs.current_state` 仍然是 `review` 而非卡在 `g1`);(d) 额外补了一条"`run_failed` 不覆盖 `resumeRun` 的前置校验抛错(如 `RunThreadMismatchError`)"的范围测试,佐证 PRD §9.5 的 scoping 决定。
- 备注 / 卡点:无

## `[?]` 解决记录
- rev. 2 PRD 唯一悬而未决的 `[?]`——`["tasks", StreamTasksOutput] | ["updates", ...]` 判别元组在真 `tsc` 下能不能干净窄化——已在 B2 实现时用一个临时探针文件(`src/loop/__typecheck_probe.ts`,验证完即删除,未留痕)证实:`mode==="tasks"` 分支里 `payload` 确实窄化成 `StreamTasksCreateOutput`(用 `@ts-expect-error` 故意戳一个不存在的属性、一个只该在另一分支存在的属性,两次都被 `tsc` 正确捕获),**未使用任何 cast/类型断言绕过**,`mode==="updates"` 分支同理干净窄化。全程 `pnpm lint`(`tsc --noEmit`,`strict:true` + `noUncheckedIndexedAccess:true`)零告警。

## 决策记录(可追源)
- 2026-07-21 决定用「wrapper 函数 + 原函数体一字不改地重命名为 `...Core`」的方式实现 B3,而不是在原函数体中间插入 `try{`/`}catch{}`——因为后者要把 ~250 行既有代码整体重新缩进,diff 风险远高于加一层薄 wrapper。理由:降低 Zorro 审查这段改动时的核对成本,且完全不触碰任何已经过 A4b 五轮 review 验证过的持久化逻辑本体。
- 2026-07-21 决定 `computeRunProgress()`/`audit.updateRunProgress()` 严格只在 `mode==="updates"` 分支触发,`"tasks"` 分支一律 `continue` 跳过——源于 PRD §9.6 的风险,已用独立的调用次数回归测试(手动 `"updates"`-only drive vs 真实实现的 spy 计数比对)坐实,不是嘴上保证。
