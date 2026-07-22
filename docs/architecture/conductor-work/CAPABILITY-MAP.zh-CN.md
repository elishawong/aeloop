# Conductor Work / Aeloop 诚实能力地图

> 用途:pitch 的**诚实底牌**——被领导尖锐提问时,照这张表答,不过度声称。分级沿用 pitch 页图例:
> `● 已证明`(有 merged PR + 测试/真跑)· `◐ 部分`(建了但仅设计/adapter/fixture,未端到端真跑)· `○ 规划`(未建)· `⚠️ 已知限制`。
>
> 基准:origin/main `c7a236d`,vitest 全绿(#63 后 609 tests,Node 24)。来源逐条可追 merged PR / open issue / 真跑记录,非自述。

## ● 已证明(可当面演示 / 有测试铁证)

| 能力 | 证据 |
|---|---|
| 四层引擎 A0–A5(Prompt⊂Context⊂Harness⊂Loop + profile overlay) | PR #3/#5/#7/#12/#15/#20/#33 已合并 |
| coder/tester 闭环 + G1/G2/G3 + 升级门 + 跨进程 resume | PR #15/#20;`no_change` 终态 PR #49 |
| CLI/TUI 真人入口(start/resume/list + 交互门审) | PR #33,全套 594 测试绿 |
| 事件体系(LoopEvent 可观测性) | PR #29(issue-29-events) |
| EvidenceBundle + Token 账本 | PR #57(provider usage → 事件 → EvidenceBundle) |
| fail-closed 安全策略 + TaskContract 校验/注入 | PR #34/#56 |
| 无凭证公司 demo(`pnpm run demo:company`) | 确定性校验 + 选中 workflow,不调模型/不碰仓库/不带凭证 |
| 公司 `conductor-work run`(candidate-only,pending gate,不自动 approve) | PR #52,禁 commit/push/PR/merge |
| **公司 LiteLLM / apikey 路径 → 真实模型端到端已跑通** | **Run #25 真跑**:apikey/LiteLLM 直连,coder(deepseek 系)出候选 → G1 → 独立 tester(seed 系,**不同模型**)跑 → 抓到 surrogate-pair bug(`split('')` 拆 `😀a` 出乱码)→ coder 改 `Array.from` 修复 → G3 → 完成;EvidenceBundle `usage.models` 含两个不同模型名 |
| **多模型独立复核(真·双不同模型)** | Run #25 + **Run #31(公司电脑)** —— tester 独立于 coder、用不同模型,真抓出 coder 没发现的字素/代理对 bug(`split('')` → `Intl.Segmenter` grapheme 修),两次不同任务都复现,不是 fixture |
| **半自动 gate mode(semi-auto,可选开关)** | **Run #31 公司电脑真跑**:`workflow.gate_mode: semi-auto` 自动批 G1/G2(诚实记 `decidedBy="system (semi-auto)", not a human decision`),**G3 最终应用 + Escalation 恒人工**;fail-closed `reject_threshold` 守卫防无界循环(到点升级到人)。PR #67(#63),默认 `manual` 字节级不变;Zorro 内部独立审 PASS + 双守卫 mutation kill-test(⚠️ Codex 跨模型佐证本轮超时,留 fast-follow) |

## ◐ 部分(建了 / 有单测,但未端到端真跑)

| 能力 | 缺口 | 关联 |
|---|---|---|
| Prompt cache / delta | 仅设计契约(PromptSnapshot/PromptDelta) | PR #41,运行时未启用;issue #36 |
| Context 预算/压缩 | 预算接入 + omission 投影已落,delta/cache 待做 | PR #38/#39 |
| 可视化 UI demo | 真 `EvidenceEventProjector` 投影,但**输入是 fixture,非 live stream** | 已标 DEMO DATA |
| gate-controller(点 approve→真 resume 的桥) | 代码在(resume-only,start/stop fail-closed),未提交、未接 CLI/UI | worktree company-gate-controller |

## ○ 规划(未建,不得声称已做)

- ~~A6 双 profile 真实验收~~ **已完成**:指挥官在公司电脑用公司 LiteLLM 端点跑通半自动闭环 + 多模型独立复核(**Run #31**,见上「已证明」)。剩可选步 = 采集一份正式 EvidenceBundle 当展板素材(runbook + preflight 已备),是产物物流,不是能力缺口。
- research / prd-authoring / design-compliance / release-readiness workflow —— 仅路线图名字,零实现。
- 声明式 YAML/JSON DSL。
- usage_records 落库 / 跨进程持久化(issue #59)、逐 attempt token + retry-waste 核算(issue #58)。
- 协议版本兼容运行时校验(issue #37,仅文档层)。
- live UI 事件流、外部 GateCommand 通道(gate-controller 是其半成品)。

## ⚠️ 已知限制(被问安全/正确性时,主动诚实答)

| 限制 | 说明 | issue |
|---|---|---|
| coder 在人类批准前理论可写盘 | `bypassPermissions` + `Bash` 非只读;Harness 层未做真沙箱 | #31 |
| 同 run 并发 resume 无锁 | 并发/重复 resume 可能记相反决策 | #19 |
| A4b 未经独立复审 | 治理债,待补审或指挥官明确接受 | #32 |

---

**一句话对外定性:** 引擎骨架(四层 + 闭环 + 门 + 证据 + fail-closed)**已真跑通、有测试**;公司 LiteLLM 侧**已在公司电脑用真实模型端到端跑通、双模型独立复核真抓出 bug(Run #25 + Run #31)**;**半自动 gate mode(可选:自动 G1/G2、人工守 G3 + Escalation、fail-closed 升级)也已在公司电脑真跑通过(Run #31)**;更多 workflow 是**路线图**。—— 说到这个程度,任何提问都戳不穿。
