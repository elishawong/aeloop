# aeloop — Repo Memory (Claude 自动读)

> 开工先读这份 + [docs/README.md](./docs/README.md)。这里是 aeloop 这个 repo 的硬约束、目录、命名、SOP、边界。
> **最后更新:2026-07-20**

## 1. 这是什么
aeloop = **模型无关、治理优先的 coder/tester 引擎**(四层嵌套 Prompt⊂Context⊂Harness⊂Loop + 一层 profile overlay)。
一套引擎两张脸:**Helix**(私人订阅,claude/codex CLI)和 **Verity**(公司 LiteLLM 代理)都是长在它上面的 **profile overlay**,**不是** aeloop 的子模块。aeloop 中立,不属于任何一边。
> 设计权威:[docs/DESIGN.md](./docs/DESIGN.md)。战略判断在 Helix 侧 `ai-agent/docs/verity-port/UNIFIED-ARCHITECTURE-JUDGMENT.md`(不在本仓)。

## 2. 技术栈(真实,非计划)
| 项 | 用什么 |
|---|---|
| 语言 / 运行时 | TypeScript + Node.js v24 |
| 数据层 | SQLite(better-sqlite3;评估 `node:sqlite` 减依赖)+ FTS5 |
| 校验 | zod(输出 schema)+ ajv(`Ajv2020`,JSON Schema 校验) |
| 编排 | `@langchain/langgraph` + `checkpoint-sqlite`(官方 SqliteSaver) |
| 配置 | js-yaml(config.yaml)+ `${ENV}` 占位替换 |
| 测试 | vitest |
| 包管理 | npm |
| 部署 | CLI 工具(`npm i -g`),**非 server** |
| env | `LITELLM_BASE_URL` / `LITELLM_TOKEN`(仅 verity profile);无统一前缀 |
> M0-M3 相关依赖(langgraph/checkpoint-sqlite/better-sqlite3)已在开发机验证可装。src/ 代码尚未建(由 `/spec`→build 起,见 DESIGN §8 里程碑 A0-A6)。

## 3. 目录结构(目标 · src/ 由 /spec 建,当前仅项目自带层)
```
aeloop/
├── CLAUDE.md / README.md / CHANGELOG.md / .gitignore
├── docs/  (README 索引 / DESIGN 权威 / BACKLOG / PROGRESS / ROADMAP)
├── .claude/skills/  (aigit / run)
├── src/  (prompt / context / harness / loop / cli / profile / shared) ← 待建
├── workflows/  (coder-tester-loop.json) ← 待建
└── profiles/  (helix/ 私人 overlay;verity/ 只在公司内部 git,.gitignore 屏蔽)
```

## 4. 命名 / 约定(焊死)
- 代码注释英文;面向指挥官的文档可中文。
- 引擎代码**不硬编码** provider/model/role 名 —— `role` 是开放字符串,按名查 registry(见 DESIGN §1.7)。
- 输出契约用 zod schema;**跨层无反向依赖**(prompt/context 不 import harness/loop)。

## 5. 这里 NEVER 出现的东西(0 侵入 / 不越界)
- ❌ 引擎 `src/` 里**不放** Helix 的魂/companion/私人记忆 —— 那些属 `profiles/helix/` overlay,不属引擎。
- ❌ **`profiles/verity/` 永不进本仓**(公司内容,只在公司内部 git);`.gitignore` 已屏蔽。
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
