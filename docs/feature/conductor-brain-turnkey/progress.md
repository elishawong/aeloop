---
feature: conductor-brain-turnkey
status: not_started   # not_started / in_progress / blocked / done
last_updated: 2026-07-23
---

# Progress — conductor-brain turnkey 落地包（issue #88）

> 边写边更。每批做完追加一条：做了什么 + 本地自检结果（`node .claude/hooks/test-*.mjs` 等）+ 可追源的证据。**改完即写回。**

> **▶ 下一步（RESUME 指针）**：PRD/plan 已写完，待 operator 确认后开始 B1（`git-remote.mjs`+`command-match.mjs`）。**尚未开始任何实现代码。**

- **关联 PRD / Plan**：`./PRD.md` · `./plan.md`
- **方案权威**：`docs/conductor-brain-layer/TURNKEY-DESIGN.md`（operator 已确认）

## 批次进度

### B1 — 共享库：`git-remote.mjs` + `command-match.mjs`
- 状态：未开始

### B2 — 共享库：`brain-lock.mjs`
- 状态：未开始

### B9 — env fallback：`db-path.mjs` + `brain-wake-greeting.mjs` 编辑 + runbook 扩写
- 状态：未开始

### B7 — 宪法文档：`CLAUDE.md` + `BRAIN.md` 扩写
- 状态：未开始

### B3 — `brain-commit-gate.mjs`
- 状态：未开始

### B4 — `brain-issue-gate.mjs`
- 状态：未开始

### B6 — `brain-isolation-guard.mjs`
- 状态：未开始

### B5 — `brain-red-line-guard.mjs`（⚠️ 从零设计，最需要 Zorro 重点盯）
- 状态：未开始

### B8 — `scripts/seed-brain-identity.mjs`
- 状态：未开始

## 决策记录（可追源）
- 2026-07-23：operator 确认 DESIGN §4 人格加载方案 = (iii)，§7 issue-gate 范围 = opt-in/env 开关默认收窄——已焊进 `docs/conductor-brain-layer/TURNKEY-DESIGN.md`（见该文件 §4/§6/§7 变更标注），并据此写出本 PRD/plan。理由见 `TURNKEY-DESIGN.md` 对应章节，不在此重复。
- 2026-07-23：PRD 阶段核实"unconfirmed constraint memory → 待你决策段"这条闭环今天就是通的（`wake.mjs:44-61` + `greeting-data.mjs:167-170`），因此本次改动**不需要碰** `docs/conductor-brain-layer/spike/lib/{wake,greeting-data,render-greeting,status-table,sanitize}.mjs`——见 `TURNKEY-DESIGN.md` §4 新增段落 + `PRD.md` §3。
