# aeloop — Roadmap (总进度)

> 📌 **aeloop 的单一进度真相** —— 回答「现在到哪了 / 接下来做什么」。细节见各批实现文档。
> 🔗 设计权威:[docs/DESIGN.md](./DESIGN.md)(§8 里程碑 A0-A6)
> 最后更新:2026-07-20

---

## 🧭 维护规则(焊死)
1. **三态标记**:`[x]` 完成且已 push(注 commit)· `[~]` 完成验证过但**待 commit/push**(关机会丢)· `[ ]` 未做。已完成项**保留勾选**。
2. **中途冒出新东西**:(a) 立即做的 task → 插当前光标位,走三态;(b) idea 暂不做 → 丢 `💡 Inbox`(标日期);拿不准 → 先问 Elisha。
3. **收尾清 Inbox**:里程碑收尾问一句「Inbox 这些进 issue backlog 吗?」。
4. 每次开新批/收尾,同步更新本文件 + 顶部日期。

---

## ✅ 已完成
> `[x]` 已 push · `[~]` 完成待 commit/push
- [~] **项目接入 Helix** — 铺项目自带层(CLAUDE/docs 体系/skills/.gitignore)+ 设计权威 docs/DESIGN.md(本批,待 commit/push)

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

### A3. CLI 桥接 + 真核实(aeloop 特有)
- [ ] ClaudeCliAdapter + CodexCliAdapter(先跑 codex exec spike)
- [ ] ToolExecVerifier(声称 tool_execution 就必须有真实工具调用)

### A4. Loop
- [ ] LangGraph 编排 + G1/G2/G3 + 阈值强制升级 + 审计表

### A5. CLI/TUI
- [ ] 彩色 diff + y/n 批准 + 升级视觉区分

### A6. profile 双跑验收
- [ ] helix(claude+codex)与 verity(litellm)各跑通一次真实任务

### spike(实现前必跑)
- [ ] codex exec 非交互模式验证
- [ ] deepseek 探活 + 结构化输出验证

---

## 💡 Inbox(待分诊 — 不在上面任何区块的新 idea 先停这)
_（暂无）_
