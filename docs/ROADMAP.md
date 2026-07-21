# aeloop — Roadmap (总进度)

> 📌 **aeloop 的单一进度真相** —— 回答「现在到哪了 / 接下来做什么」。细节见各批实现文档。
> 🔗 设计权威:[docs/DESIGN.md](./DESIGN.md)(§8 里程碑 A0-A6)
> 最后更新:2026-07-21(A4b build 收官,待 Zorro `/verify`)

---

## 🧭 维护规则(焊死)
1. **三态标记**:`[x]` 完成且已 push(注 commit)· `[~]` 完成验证过但**待 commit/push**(关机会丢)· `[ ]` 未做。已完成项**保留勾选**。
2. **中途冒出新东西**:(a) 立即做的 task → 插当前光标位,走三态;(b) idea 暂不做 → 丢 `💡 Inbox`(标日期);拿不准 → 先问 Elisha。
3. **收尾清 Inbox**:里程碑收尾问一句「Inbox 这些进 issue backlog 吗?」。
4. 每次开新批/收尾,同步更新本文件 + 顶部日期。

---

## ✅ 已完成
> `[x]` 已 push · `[~]` 完成待 commit/push
- [x] **项目接入 Helix** — 铺项目自带层(CLAUDE/docs 体系/skills/.gitignore)+ 设计权威 docs/DESIGN.md(`2cc30d5`;本行 B7 前一直误留 `[~]`「待 commit/push」,发现是遗留未清的标记 —— 早已 push,这里顺手订正)

## ⬜ 待办(里程碑 A0-A6,详见 DESIGN §8)
### A0. 脚手架
- [x] 新仓 src/ 骨架 + package.json + tsconfig + vitest + profile loader 空壳 —— B0(`c19dff3`)+ B1(`948fd24`),分支 `feature/issue-1-a0-a1-scaffold`,详见 `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md`

### A1. Context + Prompt(先立防幻觉钻石)—— B2-B10 全部完成,详见 `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md`
- [x] ClaimSchema/CoderOutput/TesterOutput(zod)—— B6(`4e6ff3a`)。SchemaValidator 留 A2(Harness 范围,不在本增量)
- [x] SQLite+FTS5 store(RecallError 不静默)+ StalenessEngine + ConfirmationService(三态,db.transaction 包裹)—— B2(`0eea001`)+ B3(`d2af34d`)+ B4(`b24fa3f`)
- [x] ContextInjector(醒来注入 + 滤 rejected)—— Verity 未做,aeloop 补 —— B5(`06259c9`)
- [x] persona loader(按角色名动态查 registry)+ PromptComposer —— B7(`88852a5`)+ B8(`64e8240`)
- [x] 硬性垂直切片测试(Context→Prompt 真接通,含 rejected 过滤断言)—— B9(`4eb97e4`)
- [x] 打包配置核实 + 文档回写(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B10;返工后 139/139 测试绿,已 Zorro 审 + merge(PR #3,`018ab85`)

### A2. Harness —— B0-B7 全部完成,详见 `docs/feature/a2-harness-provider-router-litellm-adapter/`
- [x] ProviderRouter(角色→provider→adapter 纯查找,零 I/O)+ AdapterRegistry + LiteLLMAdapter(direct-api,401/403/429/5xx/尾斜线/缺key/非法JSON/真探活全覆盖)+ SchemaValidator(重试喂回错误)+ config.ts(buildAdapterRegistry)—— B0-B5(`8080f8f`/`e085e04`/`2830f68`)
- [x] 硬性垂直切片测试(Prompt→Harness 真接通:真实 MemoryStore/ContextInjector/PromptComposer/AdapterRegistry/ProviderRouter/SchemaValidator,唯一替身 FakeAdapter)—— B6
- [x] 文档回写(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B7;171/171 测试绿,已 Zorro 四轮对抗审 + Codex `gpt-5.6-sol` 跨模型二签 PASS(R1-R3 FAIL 返工,R4 PASS,双模型同判,详见 `docs/feature/a2-harness-provider-router-litellm-adapter/test-report.md`),merge→main PR#7(`c9c22aa`)

### A3. CLI 桥接 + 真核实(aeloop 特有)—— B0-B7 全部完成,详见 `docs/feature/a3-cli-bridge/`
- [x] ClaudeCliAdapter + CodexCliAdapter(cli-bridge,真 spawn 真解析:codex `exec --json`/claude `-p --output-format stream-json --verbose`)+ `cli-exec.ts`(通用 spawn/超时/stdin 立即关闭原语)+ `ToolExecVerifier`(`checkToolExecution`——声称 `tool_execution` 但 trace 为空 → `fail`)—— B0-B2(`d08f59d`)+ B3(`9abd1d7`)+ B4(`25ab7bc`)
- [x] profile 改名 `helix`/`verity` → `subscription`/`apikey`(按凭证模型命名,给引擎解耦掉具体人格名;独立 commit,不算某个 B 批次)—— `c243f64`
- [x] `config.ts` 接线(`buildAdapterRegistry` 真构造两个 cli-bridge adapter;`cmd` 严格相等分派 flavor + 可选 `bin` 覆盖 spawn 目标,供测试指向受控 fixture)—— B5(`2b472bc`)
- [x] 硬性垂直切片测试(cli-bridge 真接通:真实 MemoryStore/ContextInjector/PromptComposer/`buildAdapterRegistry`/ProviderRouter/真实 CodexCliAdapter 真 spawn/SchemaValidator/ToolExecVerifier,唯一替身是受控 fixture 子进程)—— B6(`12cba2d`)
- [x] 文档回写(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B7;**228/228 测试绿,Zorro 两轮对抗审 PASS(R1 FAIL→返工→R2 PASS)+ Codex 跨模型二签,待指挥官终批 merge**

### A4a. Loop 编排(graph + coder/tester 节点 + G1/G2/G3 门 + happy-path 垂直切片)—— B0-B6 全部完成,详见 `docs/feature/a4a-loop/`
- [x] `types.ts`/`errors.ts`/`workflow-def.ts`(`LoopState` Annotation.Root + `LOOP_NODES`/`GATE_TYPES` 单一命名来源)+ `nodes/coder.ts`/`nodes/tester.ts`(复用 A2 ProviderRouter/A1 PromptComposer/A2 SchemaValidator,零新增模型调用逻辑)—— B0-B1
- [x] `gates.ts`(G1/G2/G3 门,`interrupt()`/`Command({resume})`,interrupt 前纯函数/interrupt 后才构造 GateLogEntry)—— B2
- [x] `graph.ts`(`buildLoopGraph`/`compileLoopGraph`,`addConditionalEdges` 首次验证——spike 唯一未覆盖的 LangGraph 机制,一次性通过)—— B3
- [x] `checkpoint.ts`(`SqliteSaver.fromConnString`)+ 同进程双阶段"非闭包状态"resume 测试(真实图 + 真实磁盘 checkpoint)—— B4
- [x] 硬性垂直切片 `src/loop.e2e.test.ts`(真实 Context→Prompt→`buildAdapterRegistry`(cli-bridge fixture)→ProviderRouter→真实图→真实 SqliteSaver→G1/G3 interrupt+resume happy path→`applied:true`,角色绑定对齐真实 config.yaml:coder→claude-cli/tester→codex-cli)—— B5
- [x] 文档回写(本文件/根 CLAUDE.md/CHANGELOG/ai-agent 仓 CHARTS/knowledge/aeloop.md)—— B6;254/254 测试绿,已 Zorro 审 + merge→main(PR #15,`c6589b7`)

### A4b. 阈值强升 escalation + 审计表持久化 + checkpoint 跨进程生产化(同一 issue #13 后续批次)—— B0-B7 全部完成,详见 `docs/feature/a4b-loop/`
- [x] `types.ts`/`workflow-def.ts`/`errors.ts` 扩充(`rejectThreshold`/`escalationDecision`/`cancelled` 字段、`GateDecision` 加 `"escalate"`、新 `EscalationDecision`/`EscalationResumeValue` 类型、`LOOP_NODES` 加 `escalation`/`cancel`、`GATE_TYPES` 加 `ESCALATION_ACK`、新 `AuditReadError`)—— B0
- [x] `escalation.ts`(`createEscalationNode()`/`routeAfterEscalation()`,DESIGN §4 `HD` 三选一 `revise`/`force_pass`/`abandon`,结构上平行于 `gates.ts` 的 `createGateNode` 而非复用它)+ `gates.ts` 两处路由改动(`routeAfterReview` 阈值分支、`routeAfterG2` "主动升级"分支)—— B1
- [x] `graph.ts` 接入 `escalation`/`cancel` 两节点 + `review`/`g2`/`escalation` 条件边扩充 + `graph.test.ts` 追加 6 条 Escalation 子树分支覆盖(阈值边界/`force_pass`/`revise`/`abandon`/G2 主动升级/未识别决策 fail-loud)—— B2
- [x] `audit-store.ts`(`AuditStore`,`workflow_runs`/`structured_claims`/`approvals` 三表建表+CRUD,`MemoryStore` 结构兄弟、不 import/包裹它)—— B3
- [x] `runner.ts`(`startRun`/`resumeRun`,`compiled.stream(..., {streamMode:"updates"})` 逐节点归因审计写入,`stepCounters` 显式穿透 `RunHandle` 而非模块级可变态)—— B4
- [x] checkpoint 跨进程生产化——两个真实独立 `node` 子进程(不同 pid),进程 B 只凭 `dbPath`+`runId` 查回 `langgraph_thread_id` 续跑到底(`docs/feature/a4b-loop/spike/` 等价的 `src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs`,导入编译后 `dist/` 而非 `src/`)—— B5
- [x] 硬性垂直切片(`src/loop.e2e.test.ts` 追加阈值→escalation→`force_pass`→G3→apply 全链路场景,新增 `fake-codex.fixture.mjs` 的 `tester-reject` 场景)—— B6
- [x] 文档回写(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md/ai-agent 仓 CHARTS/knowledge/aeloop.md + `docs/DESIGN.md` §1.5 ruflo 措辞订正)—— B7(本条);**276/276 测试绿,待 Zorro `/verify`**

### A5. CLI/TUI
- [ ] 彩色 diff + y/n 批准 + 升级视觉区分

### A6. profile 双跑验收
- [ ] subscription(claude+codex)与 apikey(litellm)各跑通一次真实任务

### spike(实现前必跑)
- [x] codex exec 非交互模式验证 —— issue #10 前置 spike(claude 侧 `-p --output-format stream-json --verbose` 一并验过),详见 `docs/feature/a3-cli-bridge/spike-findings.md`(`2017280`)
- [ ] deepseek 探活 + 结构化输出验证(verity/apikey profile tester 半边,A3 不涉及,留 A6/A2 尾账)

---

## 💡 Inbox(待分诊 — 不在上面任何区块的新 idea 先停这)
_（暂无）_
