# aeloop — Repo Memory (Claude 自动读)

> 开工先读这份 + [docs/README.md](./docs/README.md)。这里是 aeloop 这个 repo 的硬约束、目录、命名、SOP、边界。
> **最后更新:2026-07-21**

## 1. 这是什么
aeloop = **模型无关、治理优先的 coder/tester 引擎**(四层嵌套 Prompt⊂Context⊂Harness⊂Loop + 一层 profile overlay)。
一套引擎两张脸:**Helix**(私人订阅,claude/codex CLI)和 **Verity**(公司 LiteLLM 代理)都是长在它上面的 **profile overlay**(分别对应 `subscription`/`apikey` profile),**不是** aeloop 的子模块。aeloop 中立,不属于任何一边。
> 设计权威:[docs/DESIGN.md](./docs/DESIGN.md)。战略判断在 Helix 侧 `ai-agent/docs/verity-port/UNIFIED-ARCHITECTURE-JUDGMENT.md`(不在本仓)。

## 2. 技术栈(真实,非计划)
| 项 | 用什么 |
|---|---|
| 语言 / 运行时 | TypeScript + Node.js v24 |
| 数据层 | SQLite(better-sqlite3;评估 `node:sqlite` 减依赖)+ FTS5 |
| 校验 | zod(输出 schema + 直接 `safeParse` 校验模型输出;ajv 原列此处,#6 定 A2 跳过 → 用 zod 直校避免双真源,留 A4 真需 JSON-Schema 原生校验时再评估) |
| 编排 | `@langchain/langgraph` + `checkpoint-sqlite`(官方 SqliteSaver) |
| 配置 | js-yaml(config.yaml)+ `${ENV}` 占位替换 |
| 测试 | vitest |
| 包管理 | pnpm |
| 部署 | CLI 工具(`pnpm add -g`),**非 server** |
| env | `LITELLM_BASE_URL` / `LITELLM_TOKEN`(仅 apikey profile);无统一前缀 |
> A0+A1(`src/prompt/` `src/context/` `src/profile/` `src/shared/`)已 merge 到 main(PR #3,139/139 测试绿),详见 `docs/feature/a0-a1-engine-scaffold-context-prompt/`。A2(`src/harness/` 的 ProviderRouter/AdapterRegistry/LiteLLMAdapter/SchemaValidator)已 merge 到 main(PR #7,171/171 测试绿,四轮 Zorro 对抗审 + Codex 跨模型二签 PASS),详见 `docs/feature/a2-harness-provider-router-litellm-adapter/`。A3(`src/harness/adapters/` 的 ClaudeCliAdapter/CodexCliAdapter + `tool-exec-verifier.ts` + `cli-exec.ts`)已完成、228/228 测试绿,**Zorro 两轮对抗审 PASS(R1 FAIL→返工→R2 PASS)+ Codex 跨模型二签,待指挥官终批 merge**,详见 `docs/feature/a3-cli-bridge/`。A4a(`src/loop/` 的 graph.ts/gates.ts/checkpoint.ts/nodes/{coder,tester}.ts + 硬性垂直切片 `src/loop.e2e.test.ts`,DESIGN §4 状态机去 Escalation 子树)build 完成、254/254 测试绿,详见 `docs/feature/a4a-loop/`。A4b(阈值强升 escalation + `escalation.ts`/`audit-store.ts`/`runner.ts` + 三张审计表落盘 + checkpoint 跨进程生产化)build 完成、276/276 测试绿,**待 Zorro 审**,详见 `docs/feature/a4b-loop/`。`better-sqlite3` 已装并实测(含 FTS5)。`@langchain/langgraph`/`@langchain/langgraph-checkpoint-sqlite`(A4a 实装,`1.4.8`/`1.0.3`)已装并实测(SqliteSaver 真实磁盘 checkpoint,见 spike-findings.md Q4;A4b 新用 `compiled.stream(..., {streamMode: "updates"})` 做逐节点审计归因,`docs/feature/a4b-loop/PRD.md` 未指定这层实现精度,build 阶段核实的真实 API 用法)。`ajv` 经 A2(#6)评估**不用**(SchemaValidator 直接对 schema-registry 的 zod 对象 `safeParse`,避免双真源)—— 见 DESIGN §8 里程碑 A0-A6。

## 3. 目录结构(现状 · A0-A3 已建 prompt/context/profile/shared/harness(含 cli-bridge),A4a+A4b 已建 loop;cli 待 A5)
```
aeloop/
├── CLAUDE.md / README.md / CHANGELOG.md / .gitignore
├── docs/  (README 索引 / DESIGN 权威 / BACKLOG / PROGRESS / ROADMAP)
├── .claude/skills/  (aigit / run)
├── src/  (prompt / context / profile / shared / harness 已建 —— A0-A3;harness 含 cli-bridge:
│         adapters/{claude-cli,codex-cli}-adapter.ts + tool-exec-verifier.ts + cli-exec.ts,
│         待 Zorro 审;loop/ 已建 —— A4a 六节点(graph.ts/gates.ts/checkpoint.ts/
│         nodes/{coder,tester}.ts/types.ts/errors.ts/workflow-def.ts)+ A4b 增量
│         (escalation.ts:Escalation 门+HD 三选一路由、audit-store.ts:workflow_runs/
│         structured_claims/approvals 三表落盘、runner.ts:startRun/resumeRun 编排层,
│         接入 escalation/cancel 两节点)+ 硬性垂直切片 src/loop.e2e.test.ts(含阈值→
│         escalation→force_pass→apply 场景),待 Zorro 审;cli 待建 —— A5)
├── workflows/  ← 不建(A4a PRD §5 明确降级:`coder-tester-loop.json` 这份 DESIGN §6 提到的文件
│                 不创建,graph.ts 的图结构是手写代码 + `workflow-def.ts` 的 LOOP_NODES/GATE_TYPES
│                 常量做单一命名来源,不是运行时从 JSON 动态生成;等真正出现第二个 workflow
│                 需要动态加载时再评估要不要建)
└── profiles/  (subscription/ 私人 overlay;apikey/ 只在公司内部 git,.gitignore 屏蔽)
```

## 4. 命名 / 约定(焊死)
- 代码注释英文;面向指挥官的文档可中文。
- 引擎代码**不硬编码** provider/model/role 名 —— `role` 是开放字符串,按名查 registry(见 DESIGN §1.7)。
- 输出契约用 zod schema;**跨层无反向依赖**(prompt/context 不 import harness/loop)。

## 5. 这里 NEVER 出现的东西(0 侵入 / 不越界)
- ❌ 引擎 `src/` 里**不放** Helix 的魂/companion/私人记忆 —— 那些属 `profiles/subscription/` overlay,不属引擎。
- ❌ **`profiles/apikey/` 永不进本仓**(公司内容,只在公司内部 git);`.gitignore` 已屏蔽。
- ❌ 不硬编码任何 provider/model / 厂商专属语法(模型无关是立身之本)。
- ❌ 不提交秘密(config 只放 `${ENV}` 指针,真值在环境变量)。
- **跨 repo 边界**:引擎**单一著作源 = 个人机 → GitHub**;Helix(ai-agent)是**消费方 / overlay-parent**,不是上游。要动 ai-agent → 去那个 repo。公司侧只 pull 不 push(单向阀,见 DESIGN §4)。

## 6. 文档 + changelog + backlog 体系
见 [docs/README.md](./docs/README.md)。核心:单一事实来源 / 完成即删 / 历史归 git;队列 = GitHub Issues + BACKLOG 镜像;**设计权威 = `docs/DESIGN.md`(本仓)**。

## 7. 「跑到一半关机还能继续」(resume)
进度落 [docs/PROGRESS.md](./docs/PROGRESS.md)。新会话开场:读 PROGRESS → `git status` → 从「进行中」续。

## 8. 收尾铁律(每次任务结束)
1. 回写文档(BACKLOG 删完成项 + CHANGELOG 加行 + 关 Issue;有中断风险则更 PROGRESS + ROADMAP)。
2. commit 前(走 `/aigit`)先确认已回写。
3. 主动报「doc 已更 / 无需更」「PROGRESS 已存 / 已清」,不等被问。
4. 自测再报完成(跑起来看一眼,不只编译过)。
