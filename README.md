# aeloop

**模型无关、以治理为核心的 coder/tester 引擎。**

四层嵌套架构 —— **Prompt ⊂ Context ⊂ Harness ⊂ Loop** —— 再加一层 profile
overlay,让同一个引擎支撑两个 profile:一个**个人订阅 profile**(claude-cli
/ codex-cli,CLI bridge)和一个**公司 API / LiteLLM profile**(LiteLLM
代理),分别对应 `subscription` 和 `apikey` 两个 overlay。两者都不是子模块,
而是 aeloop 之上的 *profile*。

## 为什么这么设计

- **靠机制防幻觉,而不是指望模型"说实话"**:结构化输出 schema 强制每条 claim 都要带上置信度和来源;一个独立的 tester(用**不同**模型)复审 coder 的产出;在 CLI-bridge 路径上,工具执行会被拿去和模型*声称*做过的动作做核对。
- **人工把关的 loop**:Coder → G1 → Tester → 拒绝阈值 → 升级 → G3 最终签字。每一次写入都经过 gate。
- **模型无关**:任意角色可配任意 provider,走适配器 —— LiteLLM(`direct-api`)或 claude/codex CLI(`cli-bridge`)。

## 当前状态

A0 到 A4b 已经全部完成:四个引擎层(Prompt、Context、Harness、Loop)均已
实现,profile/overlay 机制也已就绪。**300 个测试全部通过**,覆盖 34 个测试
文件;`pnpm lint`(`tsc --noEmit`)和 `pnpm build` 均保持干净。剩余里程碑是
**A5(CLI/TUI)**和**A6(双 profile 验收跑)**——完整的里程碑拆解见
[`docs/ROADMAP.md`](./docs/ROADMAP.md)。

## 快速开始

```sh
pnpm install
cp .env.example .env   # 设置 AI_AGENT_PROFILE;如果用 apikey profile,还要设置 LITELLM_BASE_URL/LITELLM_TOKEN
pnpm test
pnpm build
```

## 文档

- [`docs/DESIGN.md`](./docs/DESIGN.md) —— 完整设计:架构、时序图、数据库 schema、文件结构、里程碑。
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) —— 按里程碑划分的进度看板。
