# Zorro 审查报告 — aeloop A4a Loop 编排(Round 1)

> 稽核官 Zorro 对抗式独立复审。生产者(Cypher)≠审查者(Zorro)。
> 跨模型二签:Codex `gpt-5.6-sol`(read-only 沙箱)+ Claude 变异测试双引擎,互抓幻觉。
> 分支 `feature/issue-13-a4a-loop`,审前 HEAD `539f650`(工作区未 commit)。
> 关联:[elishawong/aeloop#13](https://github.com/elishawong/aeloop/issues/13) · 上游 [ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)

---

## Codex 独立审查 attestation(原样嵌入,wrapper 输出,未改一字)

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-20T23:30:14.801Z",
  "completed_at": "2026-07-20T23:38:00.315Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "aeloop A4a Loop milestone: src/loop/ graph+gates+nodes+checkpoint+types+e2e vertical slice",
  "git_commit": "539f6504a636ae93298f6632cc53e9099174893d",
  "diff_base": "539f6504a636ae93298f6632cc53e9099174893d",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "09a322c146447c3ee6ff2c5c2fe87dab2cc6943fc84734ebeaa7a9ce732cd464",
  "independent_review_completed": true,
  "fallback_used": false
}
```

- `raw_output_sha256`:`09a322c146447c3ee6ff2c5c2fe87dab2cc6943fc84734ebeaa7a9ce732cd464`(非空,独立审查真实完成)
- Codex 沙箱为 read-only:能读源码/diff/文档、能跑 `pnpm lint`/`tsc --noEmit`/直接运行 fixture,**但无法跑 `pnpm test`**(read-only 阻止 Vitest 建 `.vite-temp` 临时目录,30 个 suite 全部在 import 前 EPERM 停止)。测试红绿证据由 **Zorro 自己在沙箱外真跑**提供(下方),Codex 负责静态/逻辑核对——分工正确。

## 审查结论:**FAIL**

- **Blocker:1 条** · **Minor:2 条**
- **两模型同判 FAIL**,且都判在同一根因(偏离3:真实 `graph.ts` 的非 happy-path 拓扑无测试覆盖)。
- 生产 `pathMap` 当前静态值**与 PRD 一致**(无 live bug 正在发货),但缺覆盖 = 未来任何对真实图 reject 边的改动会**带绿发货**,违反 PRD §8 明写的验收项 + DESIGN §8.5 反"孤立绿测试"方法论。

---

### 🔴 必须改(blocker)

**B1 — 真实 `graph.ts` 的 reject / fix-forward 条件边零行为覆盖(偏离3 最终判定)**
- **落点**:`src/loop/graph.ts:73-83`(review→g2、g2→draft、g3→draft 三条 pathMap 目标)· 违反 `docs/feature/a4a-loop/PRD.md:267`(验收项:"`addConditionalEdges` 的每一条分支……都各自有一条测试实际走过")· DESIGN §8.5 反孤立绿测试。
- **根因**:`graph.test.ts` 用**本地复刻**的 `buildToyGraph()`(`src/loop/__tests__/graph.test.ts:88-103`)把生产 `pathMap` **抄了第二份**,所有 reject/fix-forward 分支跑的是这份复刻图。真实 `buildLoopGraph()` 只被 `checkpoint.test.ts:125/141` 和 `loop.e2e.test.ts:137` 调用,而这两者**都只走 happy path**(`G1 approved → review pass → G3 approved → apply`)。真实图里 `G1 rejected→draft`、`G2 approved→draft`、`G3 rejected→draft`(以及真实图的 G2 fail-loud 路径)**没有任何测试实际走过**。
- **变异证据(Zorro 亲跑,决定性)**:
  - 把真实 `graph.ts` 的 G2 pathMap `draft: LOOP_NODES.draft` 改成 `draft: LOOP_NODES.apply`(结构合法——`draft` 仍经 `START→draft` 可达,不触发 `UnreachableNodeError`)→ **全 26 个 loop 测试仍全绿**。这正是 PRD §8:267 要防的"复刻图对、生产图改坏仍全绿"。
  - 对照:把真实 `graph.ts` 的 **happy-path** 边(G1 `review: LOOP_NODES.review`→`draft`)改坏 → `checkpoint.test.ts` + `loop.e2e.test.ts` **立刻转红**(happy path 确实被真实图覆盖)。所以缺的精确是**非 happy-path 那几条真实边**,不是全部。
  - 注:`review→g2` 若被 mis-map,会因 `g2` 变不可达被 LangGraph 编译期 `UnreachableNodeError` 顺带挡下(结构校验,非行为测试);但 `G2→draft`/`G3→draft` mis-map 后 `draft` 仍可达,纯行为错误零报警。
- **两模型一致**:Codex(gpt-5.6-sol)独立指出同一 blocker(见其八项核查 #1);Zorro 变异测试实证坐实。Cypher 在 PRD 自报偏离3 时称 B4/B5"间接覆盖"真实图——变异证明该覆盖**只到 happy path,不到 reject 分支**,间接覆盖不成立。
- **建议改法(低风险,非重设计)**:让 `graph.test.ts` 直接驱动真实 `buildLoopGraph()`(把 draft/review 依赖换成 `FakeAdapter`,复用 `checkpoint.test.ts` 已有的 FakeCoder/FakeTester 手法),用真实图跑一遍 G1 reject / review reject→G2 approve / G3 reject / G2 fail-loud 每条分支;或在 `checkpoint.test.ts` 追加 reject-path 用例。核心是**每条真实图条件边至少被真实 `buildLoopGraph()` 走过一次**,消灭"复刻拓扑"这份可漂移的第二真源。

### 🟡 建议改(minor,非 FAIL 触发,但应随返工一并修)

**M1 — `gateLog`"只在内存、进程退出即消失"的注释/PRD 陈述不准确**
- **落点**:`src/loop/types.ts:63`("it does not survive process exit")+ `docs/feature/a4a-loop/PRD.md` §9.2#3。
- **实情**:`gateLog` 是 `LoopState` 的 Annotation channel(`types.ts:112`),真实图用 `SqliteSaver` 编译(`graph.ts:92`),LangGraph 会把**整个 state(含 gateLog)序列化进 SQLite checkpoint**——`checkpoint.test.ts` 的两阶段 resume 正是证明整份 state 落盘可恢复。准确说法应是"gateLog **不写入 A4b 的 `approvals` 业务表**",而不是"只在内存/进程退出即消失"。功能无错(A4a 确实不建业务表),纯属注释/PRD 措辞过度声明,幻觉门 minor。两模型一致(Codex 八项核查 #8 / §9.2#3)。

**M2 — fixture 头部"ONLY by codex-cli-adapter.test.ts"陈述过期**
- **落点**:`src/harness/adapters/__tests__/fixtures/fake-codex.fixture.mjs:3`("used ONLY by codex-cli-adapter.test.ts")。
- **实情**:该 fixture 现已被 `src/loop.e2e.test.ts:59/89`(`tester-pass` 场景)spawn。头部虽新增了"**A4a addition**"块说明 tester-pass,但第 3 行的"ONLY"旧句未同步。文档 staleness,minor。

### ✅ 检查过且 OK(独立核实,非采信自报)

- **占位符拒收**:无 TODO/stub/假数据冒充真实(Codex + Zorro 双查零命中)。
- **危险代码**:无删库/明文密钥/注入/未授权外发/越权(Codex 确认)。
- **G2 fail-loud**:`routeAfterG2`(`gates.ts:141-144`)非 `"approved"` 抛 `UnhandledGateDecisionError`;G1/G3 default 抛普通 `Error`——区分合理(G1/G3 两分支都实现、default=损坏兜底;G2 的 `"rejected"` 是合法 `GateDecision` 但 A4a 刻意无目标,专用错误)。**变异证据**:删掉 `routeAfterG2` 的 throw 改成无条件 `return "draft"` → `graph.test.ts` "G2 non-approved throws" 转红。
- **interrupt 前置副作用重跑坑规避**:`buildPayload` 在 `interrupt()`(`gates.ts:45`)前、纯读 state 无副作用;`GateLogEntry`+`new Date().toISOString()`(`gates.ts:49`)在 `interrupt()` 返回后才构造。符合 spike Q3。
- **rejectCount 递增语义**:`tester.ts:63` 仅 `verdict === "reject"` 时 +1;A4a 零代码读 `rejectCount` 做路由(阈值判断留 A4b)。**变异证据**:改成无条件 `state.rejectCount + 1` → `tester.test.ts` "does not change rejectCount when pass" 转红。
- **四层无反向依赖**:`grep -rln "from.*loop" src/harness src/context src/prompt` **零命中**;`src/loop/*` 只 import `harness/`/`prompt/`,context 仅 type-only(`types.ts:16`)。
- **loop 层零 spawn/fetch**:`grep -rn "spawn\|fetch(" src/loop --include="*.ts"` **零命中**。
- **checkpoint 非闭包状态 resume**:`checkpoint.test.ts` 丢弃 phase1 全部对象后用全新实例 + 同 db 路径 + 同 thread_id 续跑。**变异证据**:把 `createSqliteCheckpointer` 改成返回全新 `MemorySaver`(无共享磁盘)→ `checkpoint.test.ts` 转红(`fs.existsSync(dbPath)` false)——证明该测试真依赖磁盘跨实例,不是假绿。
- **垂直切片真接通**:`loop.e2e.test.ts` 真跑 MemoryStore→ContextInjector→PromptComposer→`buildAdapterRegistry`→ProviderRouter→真实 cli-bridge adapter(真 spawn fixture 子进程)→真实图→真实 SqliteSaver→G1/G3 interrupt+resume→`applied:true`,唯一替身是 fixture 子进程。角色绑定 coder→claude-cli/tester→codex-cli 与真实 `profiles/subscription/config.yaml:18` 一致。**变异证据**:把 e2e 的 roles 绑反 → `SchemaValidationError`(coder 拿到 tester fixture 缺 `diff`),证明绑定真被行为验证、绑反不会静默过。
- **tester-pass fixture 无污染**:只加独立 `case`,未改 A3 已有场景;产出符合 `TesterOutput`(`verdict:"pass"`/`issues:[]`/合法 `claims[]`/`confidence`)。A3 既有测试仍全绿(下方 254/254 含之)。
- **命令实测(Zorro 沙箱外真跑)**:`pnpm build`(tsc strict + noUncheckedIndexedAccess)= 通过;`pnpm lint`(`tsc --noEmit`)= 通过;`pnpm test` = **254/254 全绿(30 suites)**。变异全部验完后工作区已复原,复原后再跑一遍 254/254 仍绿。

### 七道门

- 需求贴合 **[✗]**(B1:PRD §8:267 真实图分支覆盖验收项未满足) · 影响范围 **[✓]** · 占位符拒收 **[✓]** · 危险代码 **[✓]** · 幻觉核查 **[✗]**(M1:`gateLog` 不落盘的陈述与真实 checkpoint 行为矛盾;偏离3"间接覆盖"自报被变异证伪) · 文档齐套 **[✓]**(PRD/spike/impact/本 report 齐;M2 是既有 fixture 头部 staleness,非缺失) · 文档同步(仅大设计级)**[N.A.]**(A4a 未触及 BASE-ARCHITECTURE/AI_COMPANY_PLAN/CORE/CLAUDE 四份权威文档结构)

### 📚 知识库(核对,不维护)

- 本次改动是否触及已索引模块 **[是]**——`CHARTS/knowledge/aeloop.md`(ai-agent 仓)本增量新增 5 条 Loop 层索引(types/errors/workflow-def · nodes · gates · checkpoint · graph)。
- 对照真实代码是否仍准 **[✓]**——逐条核实接口签名(`buildLoopGraph`/`compileLoopGraph`/`LoopGraphDeps`/`createGateNode` 四参/四个 `routeAfter*` 返回类型/`GateDecision`/`GatePayload`/`GateLogEntry`/`LoopNodeName` 含 `Exclude<...,"__end__">` 边界/`createSqliteCheckpointer`)全部与真实代码一致;依赖方向、"graph.test.ts 不调 buildLoopGraph 而本地复刻拓扑"这条**也如实写进了知识库**(与偏离3 一致)。无悬空引用、无路径漂移。
- 若漂移已要求 Cypher 同步 **[N.A.]**——未发现漂移。惟建议:B1 返工闭掉覆盖缺口后,知识库 graph.ts 条目里"graph.test.ts 本地复刻拓扑、不调 buildLoopGraph"那句应随之更新(届时真实图会被直接测到)。

---

## 复审循环指引

Cypher 修 B1(真实图每条条件边至少被 `buildLoopGraph()` 走过一次)+ 顺手修 M1/M2 → Zorro Round 2 复审(重点重跑上面 B1 那条变异:mis-map 真实图 reject 边后对应测试必须转红)→ 通过 + CI 绿 → 交指挥官终批。**未经指挥官审批不 commit / 不 merge。**

---
---

# Round 2 复审(返工后)

> Cypher 按 R1 报告返工三条(B1 + M1 + M2)。Zorro 独立核实,不采信自述。分支 `feature/issue-13-a4a-loop`,审前 HEAD `539f650`,未 commit。

## Codex R2 独立审查 attestation(原样嵌入,wrapper 输出)

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-20T23:57:16.091Z",
  "completed_at": "2026-07-21T00:02:20.975Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "aeloop A4a Loop R2 rework: graph.test.ts real-graph coverage + M1 gateLog comment + M2 fixture header",
  "git_commit": "539f6504a636ae93298f6632cc53e9099174893d",
  "diff_base": "539f6504a636ae93298f6632cc53e9099174893d",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec",
  "independent_review_completed": true,
  "fallback_used": false
}
```

- R2 `raw_output_sha256`:`ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec`(非空,与 R1 `09a322c1…` 不同,是本轮真实独立执行)。
- Codex R2 首次启动疑似跨仓超时无果(已知问题 ai-agent#115);**有界重试**后拿到真实输出(started 23:57→completed 00:02,~5 min)。read-only 沙箱同 R1,`pnpm test` 仍被 EPERM 挡下,测试红绿由 Zorro 沙箱外亲跑提供。

## R2 结论:**FAIL**(两模型同判)

- **Blocker:1 条(B1 收窄但未完全关闭)** · **Minor:2 条**
- B1 的**大洞已修好**(真实图不再无测试);但 Codex 抓到一个我自己 R2 变异集**漏掉**的残留缝隙——正是跨模型二签的价值所在,如实记录。

### 🔴 必须改(blocker)

**B1-residual — G3 reject→draft 用例缺"必经 draft"回归断言,一类 sneaky mis-map 仍带绿发货**
- **落点**:`src/loop/__tests__/graph.test.ts:248-271`("G3 rejects once" 用例)· 真实边 `src/loop/graph.ts:82`(`draft: LOOP_NODES.draft`)。
- **根因**:该用例 G3 reject 后**只断言 `next===[g1]`**(line 262),没有像姊妹用例那样取 `coder` 并断言 `coder.calls===2`(对照:G1-reject 用例 line 199、G2-approve 用例 line 236 都锁了 `coder.calls===2` 证明 draft 真重跑)。
- **变异证据(Zorro 亲跑,决定性)**:把真实 `graph.ts` 的 G3 `draft: LOOP_NODES.draft` 改成 `draft: LOOP_NODES.g1`(sneaky——跳过 coder 重绘、直接回 g1,`next` 观测值仍是 `[g1]`)→ **全 5 个 graph.test.ts 仍全绿**。而我 R2 自己那轮 G3 变异用的是 `draft→apply`(loud,会被 `applied`/`next` 抓到转红),所以**我一个人会误放这条**;Codex 用 `draft→g1` 揭出残留缝隙。两模型交叉才补上。
- **为什么是真 bug 不是吹毛求疵**:G3-reject→draft 的语义是"终审打回→coder 拿反馈重绘"。若误接成 →g1,G3 打回后会 g1→review→g3 无限循环审同一份**从未修改**的 diff,反馈永远到不了 coder——真实功能缺陷,值得锁成回归断言。
- **建议改法(一行级)**:"G3 rejects once" 用例从 `buildDeps` 取 `coder`,G3 reject 后加 `expect(coder.calls).toBe(2)`(+ 可选断言第二次 coder prompt 含 G3 的 `reasoningText`),与 G1-reject/G2-approve 两个姊妹用例对齐。

### 🟡 建议改(minor)

**M1-residual — `types.ts:66` 注释过度声明 checkpoint.test 证明了什么**
- 注释称"phase 2's brand-new instance reads back a `gateLog`-bearing state from disk"。但 `checkpoint.test.ts` 暂停在**未决策的 G1**,此刻 `gateLog` 仍是初始空数组(`checkpoint.test.ts:94` `gateLog: []`),且测试**从不跨实例断言 gateLog 内容**。gateLog 随 SqliteSaver 落盘的**机制判断正确**(graph.ts:92 配 checkpointer + gateLog 是 Annotation channel),只是"该测试具体证明了 gateLog 内容跨实例恢复"这句过度声明。改法:软化措辞(该测证明的是**整份 state** 跨实例恢复;gateLog 有内容且被 checkpoint 的实证在 `loop.e2e.test.ts` 末尾 `final.gateLog` 断言里,可改引它)。两模型一致。

**M2-new — 返工后两处注释仍称 graph.test.ts 用 "toy graph/toy nodes",已过期**
- `src/loop/graph.ts:9`("`graph.test.ts` deliberately verifies it first, with toy nodes")+ `src/loop.e2e.test.ts:18`("not a toy graph (that's `graph.test.ts`'s job)")。返工已把 graph.test.ts 改成 FakeAdapter-backed 真实图,不再是 toy graph/toy nodes,这两句需同步。文档 staleness。

### ✅ 返工验收(独立核实)

- **B1 修的是真图不是又一份复刻**:`graph.test.ts:48` 真 import `buildLoopGraph`/`compileLoopGraph`,五个用例均 `compileLoopGraph(buildLoopGraph(deps), ...)` 驱动真实图;文件内**零** `new StateGraph`/`addNode`/`addConditionalEdges`/`buildToyGraph` 拓扑定义(仅注释/describe 串提及历史)。**大洞已闭**——两模型一致确认"是真图、无残留复刻"。
- **每条真实条件边的 mis-map 捕获(Zorro R2 变异逐条,决定性)**:
  - G1 rejected→draft:mis-map `→apply` → "G1 reject once" 用例**行为转红** ✓
  - G2 approved→draft:mis-map `→apply` → "tester rejects once" 用例**行为转红** ✓
  - G3 rejected→draft:mis-map `→apply` → "G3 rejects once" 用例行为转红 ✓;**但** mis-map `→g1`(sneaky)→ **全绿**(见 blocker B1-residual)。
  - review→g2:mis-map `→apply` → 编译期 `UnreachableNodeError`(g2 单一入边被孤立)——**结构校验**捕获(Cypher 自述属实,这是唯一靠结构而非行为断言兜底的边,仍 fail-closed 不可发货)。
  - happy-path 边(G1 approved→review、review pass→g3、G3 approved→apply):由 happy-path 用例 + e2e/checkpoint 覆盖(R1 已证)。
- **M1 行为正确**:gateLog 是 concat-reducer 的 Annotation channel(`types.ts:112`),真实图 `graph.ts:92` 配 SqliteSaver → 整份 state 落盘;A4a 无写 A4b `approvals` 表代码。
- **M2 属实**:fixture 头部已更新为"也被 `src/loop.e2e.test.ts` spawn",e2e 确用它作 `codex-cli` 的 `bin`(`loop.e2e.test.ts:59/121/165`)。
- **无回归**:`pnpm build`/`pnpm lint` 通过;`pnpm test` **254/254 全绿(30 suites,与 R1 同数——graph.test.ts 仍 5 用例)**;R1 已 PASS 项未破坏——G2 fail-loud(`gates.ts:141` typed error)、四层无反向依赖(grep 零命中)、loop 层零 spawn/fetch(grep 零命中)、垂直切片真接通、checkpoint 非闭包 resume 均仍成立。
- **FakeTesterAdapter 队列**:先读 `calls` 再 `+=1`,`["reject","pass"]` 顺序正确,无 off-by-one(两模型一致)。

### 七道门(R2)

- 需求贴合 **[✗]**(B1-residual:PRD §8:267 的"每条分支被测试实际走过"精神——G3-reject 分支虽走过但 mis-map 未锁死,与姊妹用例不一致) · 影响范围 **[✓]** · 占位符拒收 **[✓]** · 危险代码 **[✓]** · 幻觉核查 **[✗]**(M1-residual 注释过度声明) · 文档齐套 **[✓]**(M2 是注释 staleness,非缺失) · 文档同步(仅大设计级)**[N.A.]**

### 📚 知识库(R2 核对)

- 知识库 `CHARTS/knowledge/aeloop.md` graph.ts 条目那句"graph.test.ts 本地复刻拓扑、不调 buildLoopGraph"Cypher 已按返工同步(改成"直接调真实 buildLoopGraph 驱动")—— 核对与真实 graph.test.ts 一致 **[✓]**,无新悬空引用。

### R2 判定小结

R1 的 blocker(真实图**完全**无测试)**已修**;剩一条**收窄的** blocker(G3-reject 单条边的 sneaky mis-map 未被行为断言锁死)+ 2 minor 注释问题。**修法都是一行到几行级,无生产逻辑改动**(生产 `graph.ts` 本轮一行未动,R1 的 Codex 二签 `09a322c1…` 已覆盖其生产逻辑)。Cypher 补齐 G3-reject 用例的 `coder.calls===2` 断言 + 两处注释 → Zorro R3 只需重跑 G3 `draft→g1` 变异确认转红即可闭环。**未经指挥官审批不 commit / 不 merge。**

---
---

# Round 3 复审(闭环)

> Cypher 按 R2 报告修三条(B1-residual blocker + M1 + M2)。Zorro 聚焦闭环,独立核实,不采信自述。分支 `feature/issue-13-a4a-loop`,审前 HEAD `539f650`,未 commit。

## R3 结论:**PASS** ✅ — A4a 闭环

- 三条(1 blocker + 2 minor)全部修实并经变异/代码核验;build/lint/`pnpm test` **254/254 全绿**;工作区 byte-identical 复原。

## Codex R3:**免二签**(如实标注理由,未假装拿到 sha)

R3 改动**纯测试断言 + 注释级,生产逻辑零变更**:
- 亲自 `git diff` 生产 `graph.ts`:与 R2 后**逐字一致,仅 line 9-12 注释块**改了措辞(把 "with toy nodes" 更新为 "driving this file's real buildLoopGraph()/compileLoopGraph() with FakeAdapter-backed deps");`addNode`/`addEdge`/四个 `addConditionalEdges` 的 pathMap 目标**一字未动**。
- R2 的 Codex 二签 `ce3fa5486d4c0a762ce1a651388545344aec3a252782cbad4e5329b6fb6962ec`(非空)已对这份**未变的**生产逻辑做过独立审查。
- B1-residual 的修复是**测试断言补强**,其闭合与否由**确定性变异测试**判定(G3 `draft→g1` → `expected 1 to be 2`),这是 model-independent 的客观检验,不是需要第二个模型的判断题。

据此免发 R3 Codex(经军师授权:生产逻辑未变 + R2 二签已覆盖 + R3 纯测试/注释)。**未拿到 R3 sha,不伪造**;A4a 全程的独立二签证据是 R1 `09a322c1…`(覆盖初版生产逻辑)+ R2 `ce3fa54…`(覆盖返工后未变的生产逻辑)两份真实签名。

## R3 决定性核验(Zorro 亲跑,沙箱外真跑)

### ✅ B1-residual 已闭合(决定性)
- **变异**:真实 `graph.ts:84` `draft: LOOP_NODES.draft` → `draft: LOOP_NODES.g1`(R2 揭出的 sneaky mis-map:跳过 coder 重绘、仍停 g1)。
- **结果**:"G3 rejects once" 用例**转红**,报 `AssertionError: expected 1 to be 2`——命中 Cypher 新加的 `expect(coder.calls).toBe(2)`(`graph.test.ts:266`,+ 打回前基线 `toBe(1)` line 258)。R2 时同一变异全绿漏检,现已锁死。改坏→确认红→复原 byte-identical。

### ✅ loud 变异无退化(regression 扫)
G1/G2/G3 三条 reject 边同时 mis-map `→apply` → 三个对应用例(G1-reject / tester-rejects / G3-reject)各自**行为转红**,无 `UnreachableNodeError`,无退化。复原 byte-identical。

### ✅ 生产 graph.ts 仅注释改动
`diff /tmp/graph.r2.bak src/loop/graph.ts` = 仅 line 9-10→9-12 注释块;pathMap/边逐字一致。Cypher"只改注释"自述**亲自 diff 核实属实**,未蒙混。

### ✅ M1 注释与真实行为一致(幻觉门过)
`types.ts:62-72` 改后措辞:checkpoint.test 的两阶段 resume 证明的是"whole state survives",其 interrupt 点在**未决 G1、gateLog 仍 `[]`**,从不断言 gateLog 内容;真正验证 gateLog 内容跨 checkpoint 的是 `loop.e2e.test.ts` 末尾 `final.gateLog` 断言。**核实**:`loop.e2e.test.ts:189-190` 确有 `final.gateLog.filter(entry => entry.gate === "G1_SEND_TO_TESTER"/"G3_FINAL_MERGE")` 对 G1/G3 条目的断言。措辞与代码/测试行为一致,不再过度声明。

### ✅ M2 注释更新属实
`graph.ts:9-12` + `loop.e2e.test.ts:18` 的"toy graph/toy nodes"过期措辞已更新(graph.ts 改成"driving real buildLoopGraph with FakeAdapter-backed deps";e2e 改成"driven here with real subprocess-backed ModelAdapters, not FakeAdapter-backed deps that's graph.test.ts/checkpoint.test.ts's job")。与返工后 graph.test.ts 真实形态一致。

### ✅ 无回归
`pnpm build`(tsc strict + noUncheckedIndexedAccess)= 通过;`pnpm lint` = 通过;`pnpm test` = **254/254 全绿(30 suites)**。

## 七道门(R3,全过)

- 需求贴合 **[✓]**(PRD §8:267 真实图每条条件边 mis-map 均被捕获:3 条 reject 边行为断言锁死 + review→g2 结构校验兜底 + happy-path 边由 e2e/checkpoint 覆盖) · 影响范围 **[✓]** · 占位符拒收 **[✓]** · 危险代码 **[✓]** · 幻觉核查 **[✓]**(M1/M2 注释均已与真实行为对齐) · 文档齐套 **[✓]** · 文档同步(仅大设计级)**[N.A.]**

## 📚 知识库(R3)

未再触及知识库改动;R2 已确认 `CHARTS/knowledge/aeloop.md` graph.ts 条目与真实 graph.test.ts 一致,本轮生产/测试形态无使其漂移的变化 **[✓]**。

## A4a 最终判定

**PASS。** 经三轮对抗式复审(R1 FAIL→R2 FAIL→R3 PASS):真实图 `buildLoopGraph()`/`compileLoopGraph()` 的每一条 `addConditionalEdges` 分支(含所有 reject/fix-forward 回边)现均被真实图驱动的行为测试锁死,任一 pathMap mis-map(loud 或 sneaky)都会被捕获;垂直切片真接通、四层无反向依赖、loop 层零 spawn/fetch、checkpoint 非闭包 resume、G2 fail-loud 均成立;254/254 测试绿;跨模型二签 R1 `09a322c1…` + R2 `ce3fa54…` 覆盖生产逻辑演进,R3 纯测试/注释免签(已如实标注)。工作区 byte-identical 复原,HEAD 仍 `539f650`,未 commit/push/merge。**交指挥官终批 → 批准后方可 commit/merge。**
