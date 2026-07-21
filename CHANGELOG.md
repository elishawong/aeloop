# Changelog — aeloop

> 📌 给人读的「最近做完了什么」摘要。完整、不可篡改的历史以 `git log` 为准。
> 📏 **防膨胀**:只留**最近约 15 条 / 90 天**;超出的删(git 里都在)。最新在上。
> ✍️ **写法**:`- **日期** — 一句话摘要`;细节进 `<details>` 折叠块。

---

- **2026-07-21** — A4a Loop 编排 build 完成:`src/loop/`——`graph.ts`(`buildLoopGraph`/`compileLoopGraph`,DESIGN §4 状态机去 Escalation 子树,**`addConditionalEdges` 首次验证——spike 5 个 Q 唯一未覆盖的 LangGraph 机制,一次性通过**)+ `gates.ts`(G1/G2/G3 门,`interrupt()`/`Command({resume})`,interrupt 前纯函数/interrupt 后才记 `GateLogEntry`,G2 收到非 `approved` 决策 fail loud 抛 `UnhandledGateDecisionError`)+ `checkpoint.ts`(`SqliteSaver.fromConnString`,同进程双阶段"非闭包状态"resume 验证)+ `nodes/coder.ts`/`nodes/tester.ts`(复用 A2 ProviderRouter/A1 PromptComposer/A2 SchemaValidator,零新增模型调用逻辑)+ `types.ts`/`errors.ts`/`workflow-def.ts`(`LOOP_NODES`/`GATE_TYPES` 单一命名来源)+ 硬性垂直切片(`src/loop.e2e.test.ts`,真实 Context→Prompt→`buildAdapterRegistry`(cli-bridge fixture)→ProviderRouter→真实图→真实 SqliteSaver→G1/G3 interrupt+resume happy path→`applied:true`,角色绑定对齐真实 `config.yaml`:coder→claude-cli/tester→codex-cli),254 测试绿(B0-B5)。**待 Zorro 审、待指挥官终批 merge。**
- **2026-07-20** — A3 CLI 桥接层 build 完成:ClaudeCliAdapter/CodexCliAdapter(`kind: cli-bridge`,真 spawn + 真 JSONL 解析:codex `exec --json`/claude `-p --output-format stream-json --verbose`)+ ToolExecVerifier(`checkToolExecution`——声称 `verifiedBy: "tool_execution"` 但 trace 为空 → `fail`,防的正是"模型自称验证过但压根没调用工具"这条幻觉)+ `cli-exec.ts`(通用 spawn/超时/stdin 立即关闭原语)+ `config.ts` 接线(`cmd` 严格相等分派 flavor,可选 `bin` 覆盖实际 spawn 目标)+ profile 改名 `helix`/`verity` → `subscription`/`apikey`(按凭证模型命名,给引擎解耦掉具体人格名)+ 硬性垂直切片(`harness-cli.e2e.test.ts`,cli-bridge 全链路真实接通:真实 Context→Prompt→`buildAdapterRegistry`→ProviderRouter→真实 adapter 真 spawn→SchemaValidator→ToolExecVerifier,唯一替身是受控 fixture 子进程,不打真实 CLI),228 测试绿(spike + B0-B7 + 两轮返工)。**Zorro 两轮对抗审 PASS(R1 FAIL→返工→R2 PASS)+ Codex `gpt-5.6-sol` 跨模型二签,待指挥官终批 merge。**
- **2026-07-20** — A2 Harness 层 build 完成:ProviderRouter(角色→provider 纯查找,零 I/O)/AdapterRegistry/LiteLLMAdapter(direct-api,HTTP 错误码+尾斜线归一化+缺key+非法JSON+真实探活全覆盖)/SchemaValidator(重试并把错误喂回 prompt)+ 硬性垂直切片(真实 Context→Prompt→Harness 全链路接通,唯一替身 FakeAdapter),165 测试绿(B0-B5 共 164 + B6 垂直切片 1)。
- **2026-07-20** — A0+A1 引擎 build 完成:脚手架 + Context(store/FTS5/staleness/confirmation事务/injector滤rejected)+ Prompt(zod schema/动态persona/composer)+ Context→Prompt 垂直切片,96 测试绿。
- **2026-07-20** — DESIGN 补 §8.5「Verity M2/M3 洞 → aeloop 必修清单」:8 项 PRD 硬验收(ProviderRouter 真做 / ContextInjector 接线 / 重试喂回错误 / InvokeResult 带 provider·model / JSON.parse 包错 / HTTP 错误覆盖 / 事务+补缺列 / rejected 过滤)+ 每里程碑「垂直切片必接通」纪律。依据 Verity M2/M3 对抗式审查。
- **2026-07-20** — 项目接入 Helix:铺项目自带层(CLAUDE / docs 体系 / aigit·run skills / .gitignore)+ 落设计权威 `docs/DESIGN.md`。src/ 引擎代码待 `/spec`→build 起(里程碑 A0-A6)。
