# Impact — aeloop conductor-brain turnkey 落地包（issue #88）

> **状态标注**：本文档在 `/build` 开始前写成，是**预期影响评估**（基于已确认的 PRD 文件清单推导），不是"已发生的改动"——PRD.md/plan.md 已经把逐文件任务钉死，这里提前把"影响面/该重点测什么"想清楚，供 Zorro 复审时对照，也供 operator 判断这个包的改动面有多大。**待 `/build` 完成后，需要用真实改动重新过一遍本文档，把"预期"改成"实测"，不能让这份文档停在预期就交差。**

- **关联 PRD**：`./PRD.md` + `./plan.md`
- **方案权威**：`docs/conductor-brain-layer/TURNKEY-DESIGN.md`（operator 已确认）
- **分支**：`design/issue-88-conductor-brain-turnkey`
- **最后更新**：2026-07-23（PRD 阶段，build 未开始）

## 1. 改动摘要（预期）

新增一整套"公司大脑 turnkey 包"：3 个共享库（`git-remote.mjs`/`command-match.mjs`/`brain-lock.mjs`）+ 4 个 PreToolUse/SessionStart hook（3 个真 deny + 1 个 warn-only）+ 1 个幂等 seed 脚本 + 1 个 dbPath fallback 共享库 + 1 个新建根 `CLAUDE.md` + 对 `BRAIN.md`/`WAKE-GREETING-RUNBOOK.md`/`brain-wake-greeting.mjs`/`.claude/settings.json`/`.gitignore` 的定点扩写。全部落在 `.claude/hooks/`、`scripts/`、`docs/conductor-brain-layer/`、根目录 `CLAUDE.md`，**不碰 `src/**` 一行**。

## 2. 受影响面（预期）

- **直接新增**（11 个新文件，PRD §4/§5 已逐条列出）：
  - `.claude/hooks/lib/{git-remote,command-match,brain-lock,db-path}.mjs` + 各自 `test-*.mjs`（8 个文件）
  - `.claude/hooks/{brain-commit-gate,brain-issue-gate,brain-red-line-guard,brain-isolation-guard}.mjs` + 各自 `test-*.mjs`（8 个文件）
  - `scripts/seed-brain-identity.mjs` + `scripts/test-seed-brain-identity.mjs`
  - `CLAUDE.md`（aeloop 根）
  - `.claude/brain.local.json.example`
- **直接编辑**（5 个既有文件，均为追加，不改动既有内容）：
  - `docs/conductor-brain-layer/BRAIN.md`：新增 §1.5/§1.6 + §4 表格追加一行。
  - `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`：新增三节。
  - `.claude/hooks/brain-wake-greeting.mjs`：**唯一一处逻辑改动**——dbPath 解析从直接读 env 改成调 `resolveIdentityDbPath()`（一行 + 一个 import）。
  - `.claude/settings.json`：追加 5 条 hook 注册（4 个新 hook，其中 `brain-red-line-guard.mjs` 占 2 条 matcher）。
  - `.gitignore`：追加 2 行。
- **间接波及**：
  - #84 既有的醒来开场白流程（`brain-wake-greeting.mjs` → `gatherGreetingData()` → `renderGreeting()`）**功能不变**，只是 dbPath 来源多了一层 fallback——回归测试需要证明"两个配置源都没有时，行为和改动前完全一致"（PRD §6.5）。
  - `docs/conductor-brain-layer/spike/lib/{wake,greeting-data,render-greeting,status-table,sanitize}.mjs` **完全不改**——DESIGN §4(iii) 已核实"unconfirmed constraint → 待你决策"这条闭环今天就是通的，本次不需要碰这几个文件。
  - **跨项目波及**：无。aeloop 是独立仓库，本次改动完全在 aeloop 内部；ai-agent 仓库的 `session-commit-gate.mjs`/`session-issue-gate.mjs`/`session-isolation-guard.mjs`/`_engine/{session-lock,commit-gate-match,gh}.mjs` 是**移植参考**，不是依赖关系——aeloop 新文件不 import 任何 ai-agent 仓库路径，两边完全独立。

## 3. 测试建议（预期，对齐 PRD §7 风险清单）

- **该重点测**（Zorro 复审时建议优先看）：
  1. **B5 `brain-red-line-guard.mjs`**：判据本身有没有漏洞/误伤——`rm -rf` 白名单是否过窄导致误伤正常操作、force-push 检测是否有绕过路径、`.env` 检测的三条路径（Bash 重定向/`tee`/Edit\|Write）是否真的覆盖了实际会发生的写入方式。这批不适合用"和 Helix 版本比对"的审法（没有对应蓝本），要独立判断判据本身的正确性。
  2. **B8 `seed-brain-identity.mjs` 的幂等性**：二次运行是否真的零写入（不是"重跑不报错"这种弱幂等），`fetchOpenIssues` 是否真的可注入（不依赖真实网络才能测）。
  3. **B4 `brain-issue-gate.mjs` 的默认档位**：这是本次和 Helix 原版行为差异最大的一处（默认恒 allow，非白名单角色判定），要确认判定链第一条真的是 env 档位检查，没有被后续逻辑意外覆盖。
- **边界/异常场景**：
  - 四个 hook 在 `AELOOP_BRAIN_IDENTITY_DB`/身份库完全未配置的情况下是否零副作用（红线拦截不依赖身份库配置，PRD §4.2 已声明，但需要实测确认没有隐藏依赖）。
  - `brain-commit-gate.mjs`/`brain-red-line-guard.mjs` 在非本仓库 cwd 下调用（fail-open 边界）是否真的不误拦别的项目。
  - `CLAUDE.md`/`BRAIN.md` 关于 issue-gate 默认档位的措辞，是否和 B4 实测行为一致（PRD §7 已列的交叉核对项）。

## 4. 回归清单（带优先级，预期）

| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | 四个新 hook 各自的"真的 deny"自动化验证全绿（PRD §6.2） | 头号交付承诺——机制强制不是 warn，这是本 epic 的核心卖点 |
| P0 | `brain-wake-greeting.mjs` 在两种配置源都缺失时行为与改动前完全一致（PRD §6.5） | #84 已有能力不能因本次改动退化 |
| P0 | `.gitignore` 命中 `.claude/brain.local.json`/`.claude/brain-locks/`（`git check-ignore` 验证） | 防止本地敏感/临时数据被误提交 |
| P1 | `brain-issue-gate.mjs` 默认档位恒 allow（不设 env 时） | 这是 operator 明确拍板要求的低摩擦默认，不是可有可无的细节 |
| P1 | `scripts/seed-brain-identity.mjs` 幂等性（二次运行零多余写入） | 设计上要求可以放进"日常习惯"重复跑，脆弱的幂等会破坏这个使用模式 |
| P2 | `CLAUDE.md`/`BRAIN.md` 关于各 hook 默认档位的措辞与实际行为一致 | 文档与代码脱节本身就是防幻觉铁律要防的事，虽然不是自动化项，人工核对不能省 |

## 5. 项目约束自查（预期）

- whoseorder：N/A。
- aeloop 项目内约束（不碰 `src/context/**`/`src/**`）：PRD §8 已声明，build 完成后需要用 `git diff --stat` 实测确认 `src/` 目录零改动行数。
- 占位符/假数据残留：预期无——所有 env 变量名/kill-switch 命名在 PRD 阶段已经是最终形态，不存在"占位符待填"的中间态。

---

**⚠️ 本文档待 `/build` 完成后必须回来更新**：把"预期"改成"实测"，§2 受影响面按真实 `git diff --stat` 核对、§3/§4 按 Zorro 复审实际发现的问题调整，不能让这份文档停留在 PRD 阶段的预测就当作最终交付物。
