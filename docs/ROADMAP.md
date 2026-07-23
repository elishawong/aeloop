# aeloop — Roadmap(总体进度)

> 📌 **aeloop 进度的单一事实来源**——回答"现在到哪了/下一步是什么"。逐批次实现细节见各自文档。
> 🔗 设计权威:[docs/DESIGN.md](./DESIGN.md)(§8 里程碑 A0-A6)
> 最后更新:2026-07-21(A5 build 收尾,等独立复审)

---

## 🧭 维护规则(已定盘)
1. **三态标记**:`[x]` 完成且已推送(注明 commit)• `[~]` 完成且已验证但**尚未 commit/push**(关机会丢)• `[ ]` 未完成。已完成项**保留勾选标记**。
2. **过程中冒出来的新项**:(a) 要马上做的任务 → 插入到当前光标位置,用三态标记;(b) 暂不做的想法 → 丢进 `💡 Inbox`(带日期);拿不准 → 先问 Elisha。
3. **收尾时清空 Inbox**:里程碑收尾时,问一句"这些 Inbox 项要不要转进 issue backlog?"
4. 每次新批次开始或收尾都要更新本文件 + 顶部日期。

---

## ✅ 已完成
> `[x]` 已推送 • `[~]` 已完成,待 commit/push
- [x] **项目已接入内部工具链** —— 铺好了项目自带层(CLAUDE.md/docs 结构/skills/.gitignore)+ 设计权威 docs/DESIGN.md(`2cc30d5`;这一行曾被误标为 `[~]`"待 commit/push" 一直到 B7 —— 后来发现是个从没清理过的陈旧标记,其实早就推送过了;顺手在此更正)

## ⬜ 待办(里程碑 A0-A6,详见 DESIGN §8)
### A0. 脚手架
- [x] 新仓库 src/ 骨架 + package.json + tsconfig + vitest + profile loader 桩 —— B0(`c19dff3`)+ B1(`948fd24`),分支 `feature/issue-1-a0-a1-scaffold`,详见 `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md`

### A1. Context + Prompt(防幻觉菱形先搭起来)—— B2-B10 全部完成,详见 `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md`
- [x] ClaimSchema/CoderOutput/TesterOutput(zod)—— B6(`4e6ff3a`)。SchemaValidator 延后到 A2(Harness 范围,不在本增量内)
- [x] SQLite+FTS5 存储(RecallError 绝不吞掉)+ StalenessEngine + ConfirmationService(三态,包在 db.transaction 里)—— B2(`0eea001`)+ B3(`d2af34d`)+ B4(`b24fa3f`)
- [x] ContextInjector(醒来注入 + 过滤掉被拒绝项)—— 之前的内部实现没有这个,aeloop 新增 —— B5(`06259c9`)
- [x] persona loader(按角色名动态查 registry)+ PromptComposer —— B7(`88852a5`)+ B8(`64e8240`)
- [x] 硬核纵切测试(Context→Prompt 真实端到端接通,含 rejected-filter 断言)—— B9(`4eb97e4`)
- [x] 验证打包配置 + 回写文档(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B10;返工后 139/139 测试全绿,通过独立复审 + 合并(PR #3,`018ab85`)

### A2. Harness —— B0-B7 全部完成,详见 `docs/feature/a2-harness-provider-router-litellm-adapter/`
- [x] ProviderRouter(role→provider→adapter 纯查找,零 I/O)+ AdapterRegistry + LiteLLMAdapter(direct-api,覆盖 401/403/429/5xx/尾斜杠/缺 key/非法 JSON/真实存活探测)+ SchemaValidator(重试时把错误喂回去)+ config.ts(buildAdapterRegistry)—— B0-B5(`8080f8f`/`e085e04`/`2830f68`)
- [x] 硬核纵切测试(Prompt→Harness 真实端到端接通:真实 MemoryStore/ContextInjector/PromptComposer/AdapterRegistry/ProviderRouter/SchemaValidator,唯一的替身是 FakeAdapter)—— B6
- [x] 回写文档(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B7;171/171 测试全绿,通过四轮对抗式独立复审 + Codex `gpt-5.6-sol` 跨模型二签 PASS(R1-R3 FAIL 并返工,R4 PASS,两个模型意见一致,详见 `docs/feature/a2-harness-provider-router-litellm-adapter/test-report.md`),合并→main PR#7(`c9c22aa`)

### A3. CLI bridge + 真实校验(aeloop 特有)—— B0-B7 全部完成,详见 `docs/feature/a3-cli-bridge/`
- [x] ClaudeCliAdapter + CodexCliAdapter(cli-bridge,真实 spawn + 真实解析:codex `exec --json` / claude `-p --output-format stream-json --verbose`)+ `cli-exec.ts`(通用的 spawn/timeout/立即关闭 stdin 原语)+ `ToolExecVerifier`(`checkToolExecution` —— 声称有 `tool_execution` 但 trace 是空的 → `fail`)—— B0-B2(`d08f59d`)+ B3(`9abd1d7`)+ B4(`25ab7bc`)
- [x] profile 从早期基于 persona 的命名改成 `subscription`/`apikey`(改按凭证模型命名,让引擎和具体 persona 名解耦;独立提交,不属于任何特定 B 批次)—— `c243f64`
- [x] `config.ts` 接线(`buildAdapterRegistry` 真正构造出两个 cli-bridge adapter;`cmd` 严格相等分发 flavor + 可选的 `bin` override 指定 spawn 目标,让测试能指向受控 fixture)—— B5(`2b472bc`)
- [x] 硬核纵切测试(cli-bridge 真实端到端接通:真实 MemoryStore/ContextInjector/PromptComposer/`buildAdapterRegistry`/ProviderRouter/真实 CodexCliAdapter 真实 spawn/SchemaValidator/ToolExecVerifier,唯一的替身是受控 fixture 子进程)—— B6(`12cba2d`)
- [x] 回写文档(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md)—— B7;**228/228 测试全绿,两轮对抗式独立复审 PASS(R1 FAIL→返工→R2 PASS)+ Codex 跨模型二签,等最终签字合并**

### A4a. Loop 编排(graph + coder/tester 节点 + G1/G2/G3 gate + happy-path 纵切)—— B0-B6 全部完成,详见 `docs/feature/a4a-loop/`
- [x] `types.ts`/`errors.ts`/`workflow-def.ts`(`LoopState` Annotation.Root + `LOOP_NODES`/`GATE_TYPES` 命名单一事实来源)+ `nodes/coder.ts`/`nodes/tester.ts`(复用 A2 ProviderRouter/A1 PromptComposer/A2 SchemaValidator,零新增模型调用逻辑)—— B0-B1
- [x] `gates.ts`(G1/G2/G3 gate,`interrupt()`/`Command({resume})`,interrupt 之前是纯函数 / GateLogEntry 只在 interrupt 之后才构造)—— B2
- [x] `graph.ts`(`buildLoopGraph`/`compileLoopGraph`,首次验证 `addConditionalEdges`——spike 没覆盖到的唯一 LangGraph 机制,一次跑通)—— B3
- [x] `checkpoint.ts`(`SqliteSaver.fromConnString`)+ 同进程两阶段"非闭包 state"续跑测试(真实 graph + 真实落盘 checkpoint)—— B4
- [x] 硬核纵切 `src/loop.e2e.test.ts`(真实 Context→Prompt→`buildAdapterRegistry`(cli-bridge fixture)→ProviderRouter→真实 graph→真实 SqliteSaver→G1/G3 interrupt+resume happy path→`applied:true`,角色绑定对齐真实 config.yaml:coder→claude-cli/tester→codex-cli)—— B5
- [x] 回写文档(本文件/根 CLAUDE.md/CHANGELOG/ai-agent 仓库 CHARTS/knowledge/aeloop.md)—— B6;254/254 测试全绿,通过独立复审 + 合并→main(PR #15,`c6589b7`)

### A4b. 阈值升级 + 审计表持久化 + 跨进程 checkpoint 生产化(同一个 issue #13 的后续批次)—— B0-B7 全部完成,详见 `docs/feature/a4b-loop/`
- [x] `types.ts`/`workflow-def.ts`/`errors.ts` 扩展(`rejectThreshold`/`escalationDecision`/`cancelled` 字段,`GateDecision` 新增 `"escalate"`,新增 `EscalationDecision`/`EscalationResumeValue` 类型,`LOOP_NODES` 新增 `escalation`/`cancel`,`GATE_TYPES` 新增 `ESCALATION_ACK`,新增 `AuditReadError`)—— B0
- [x] `escalation.ts`(`createEscalationNode()`/`routeAfterEscalation()`,DESIGN §4 `HD` 三选一 `revise`/`force_pass`/`abandon`,结构上和 `gates.ts` 的 `createGateNode` 平行而非复用它)+ `gates.ts` 里的两处路由改动(`routeAfterReview` 的阈值分支、`routeAfterG2` 的"主动升级"分支)—— B1
- [x] `graph.ts` 接入 `escalation`/`cancel` 节点 + 扩展 `review`/`g2`/`escalation` 条件边 + `graph.test.ts` 新增 6 个 Escalation 子树分支覆盖用例(阈值边界/`force_pass`/`revise`/`abandon`/G2 主动升级/无法识别的决定直接失败)—— B2
- [x] `audit-store.ts`(`AuditStore`,创建并 CRUD 三张表 `workflow_runs`/`structured_claims`/`approvals`,结构上是 `MemoryStore` 的兄弟,不导入/包装它)—— B3
- [x] `runner.ts`(`startRun`/`resumeRun`,`compiled.stream(..., {streamMode:"updates"})` 写入按节点归属的审计条目,`stepCounters` 显式穿透 `RunHandle` 而非模块级可变状态)—— B4
- [x] Checkpoint 跨进程生产化 —— 两个真正独立的 `node` 子进程(不同 pid),进程 B 只靠 `dbPath`+`runId` 查到 `langgraph_thread_id` 并一路续跑到底(`src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs`,等价于 `docs/feature/a4b-loop/spike/`,导入的是编译产物 `dist/` 而非 `src/`)—— B5
- [x] 硬核纵切(`src/loop.e2e.test.ts` 新增完整的 threshold→escalation→`force_pass`→G3→apply 链路场景,外加 `fake-codex.fixture.mjs` 新增一个 `tester-reject` 场景)—— B6
- [x] 回写文档(本文件/PROGRESS/CHANGELOG/根 CLAUDE.md/ai-agent 仓库 CHARTS/knowledge/aeloop.md + `docs/DESIGN.md` §1.5 一处措辞修正)—— B7(本项);**276/276 测试全绿,等独立复审**

### A5. CLI/TUI —— B0-B9 全部完成,详见 `docs/feature/a5-cli-tui/`
- [x] `src/cli/errors.ts`(带类型的 `UnsupportedProfileError`/`RunNotResumableError`)+ `package.json` 的 `bin`/`chalk`/`@inquirer/prompts` 依赖 —— B0
- [x] `colors.ts`(chalk 主题辅助函数,`escalationBanner()`)+ `diff-render.ts`(尽力而为的按行前缀 diff 上色器——`CoderOutput.diff` 是模型自报的字符串,不是真的 `git diff`,所以刻意不做成 unified-diff 解析器/校验器)—— B1
- [x] `gate-view.ts`(纯函数 `GatePayload -> string`,按 gate 区分,Escalation 用结构上明显不同的 banner 包起来,不只是换个颜色)—— B2
- [x] `prompter.ts`(`Prompter` 接口、真实的 `InquirerPrompter`、可编排脚本的 `FakePrompter`——让交互式 loop 在没有 TTY 时也能测,也是 B8 硬核纵切用来非交互驱动真实 run 的接缝)—— B3
- [x] `runner.ts` 新增 `getPendingInterrupt()`——这份 PRD 唯一动了 Loop 层的改动(为没有内存态 `RunHandle` 的全新 CLI 进程,只读重建一个暂停 run 待处理 gate 的 payload);3 个变异测试抓出的回归(漏掉的 run 校验、错误的 thread_id、永远 done)—— B4
- [x] `assemble.ts`(`assembleSubscriptionDeps()`——subscription profile 的真实依赖图接线,`AI_AGENT_PROFILE=apikey` 在碰到 `profiles/apikey` 之前就被硬性挡成 `UnsupportedProfileError`;`resolveRejectThreshold()` 的三层链)—— B5
- [x] `run-loop.ts`(`runInteractiveLoop()`——共享的启动/续跑编排器;G1/G3 用 `confirm()`,G2/Escalation 用 `select()`,按 `gates.ts` 真实的 `routeAfterG2` 契约,G2 从不提供第三个"rejected"选项;对 gate 路由/渲染逻辑的 4 个变异测试抓出的回归)—— B6
- [x] `main.ts`(`node:util.parseArgs` 解析 argv,`start`/`resume`/`list` 分发,每个错误都被捕获并打印成 `Name: message`——绝不打印原始 stack trace——SIGINT handler 每次调用都装上/卸掉)+ `bin.ts`(真实的两行生产入口)—— B7
- [x] 硬核纵切(`src/cli.e2e.test.ts`):真实 `main()` 分发 + 真实 subscription-profile 依赖图 + 真实 cli-bridge fixture 子进程 + 可编排脚本的 `FakePrompter`,happy path(G1→G3→apply)和阈值升级路径(reject-to-threshold→ESCALATION_ACK→force_pass→G3→apply)都跑了 —— B8
- [x] 回写文档(本文件/PROGRESS/CHANGELOG/README/ai-agent 仓库 `CHARTS/knowledge/aeloop.md`)—— B9(本项);**368/368 测试全绿**,`pnpm build`/`pnpm lint` 均干净,等独立复审

### A6. 双 profile 真实验收
- [ ] subscription(claude+codex)和 apikey(litellm)各真实跑通一个端到端任务

### 重构基础(A6 之前)
- [~] Workflow 插件边界、确定性的 brain/contract/orchestrator 边界、profile-中立的 CLI 装配、外部私有 profile root、无凭证的公司演示 —— 本地分支 `refactor/conductor-foundation`(`df79d27`);A6 最终验收还需要一个真实的公司 profile

### Spikes(实现前必须先跑)
- [x] codex exec 非交互模式验证 —— issue #10 前置 spike(claude 侧的 `-p --output-format stream-json --verbose` 同时验证过),详见 `docs/feature/a3-cli-bridge/spike-findings.md`(`2017280`)
- [ ] deepseek 存活探测 + 结构化输出验证(apikey profile 的 tester 那一半,改名前的名字——不在 A3 范围内,留作 A6/A2 的尾项)

---

## 💡 Inbox(待分诊 —— 归不进上面任何一节的新想法先放这里)
_(暂无)_
