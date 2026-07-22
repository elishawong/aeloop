# RUN-LOG — B5 真实 dev-run 存档

- **跑法**：`pnpm run build && node docs/conductor-brain-layer/spike/run-spike.mjs`
- **profile**：`subscription`（本机已认证的 `claude`/`codex` CLI；PRD §5 待决策项"deepseek/seed 真实凭证来源"三选一的选③——本机 subscription 先证明机制，真实 deepseek/seed 凭证跑留待操作者之后在公司电脑补，不是这次 spike 范围）。
- **时间**：2026-07-22（本机 dev-run，非公司电脑）
- **worktree**：`/Users/elishawong/code/github/elishawong/aeloop-worktrees/spike`（分支 `feat/issue-brain-spike`，基线 `origin/main@750d12e`）
- **identity db**：`docs/conductor-brain-layer/spike/data/identity.db`（跑前已清空重建，`*.db` 已被仓库 `.gitignore` 排除，不进 git）

## 完整 stdout（第二次跑，`rm -rf data && mkdir data` 后的干净跑，runId=2）

```
=== brain-spike run-spike.mjs (aeloop issue #80) ===
repoRoot: /Users/elishawong/code/github/elishawong/aeloop-worktrees/spike
identityDbPath: /Users/elishawong/code/github/elishawong/aeloop-worktrees/spike/docs/conductor-brain-layer/spike/data/identity.db
rawIntent: Read docs/conductor-brain-layer/spike/README.md if it exists, and docs/conductor-brain-layer/spike/lib/wake.mjs to confirm it exports openIdentityStore and wake. This is a read-only verification task for the conductor-brain vertical-slice spike (aeloop issue #80) — respond with no_change if nothing needs to be modified.

[步骤1 醒来] 醒来：core memory 0 条，合计 0 条延续线索。

[步骤2 翻译] contractId=brain-spike-1784715885024 brain=company riskLevel=low

[步骤3 aeloop] workflow=coder-tester-loop@1.0.0
[步骤3] startRun -> runId=2 interrupt=(none) done=true
[步骤3] run 已到终态（apply/cancel/no_change）

[步骤4 三态门] evidence[]=1 条, claims[]=0 条, status=completed, runId=?, eventTypes=["run_started","node_started","node_completed","agent_completed","run_completed"]
  evidenceId=no-change-2-draft#1 source=model-reported confirmed=false memoryId=1
  evidenceId=(mechanical-status) source=mechanical-status confirmed=true memoryId=2

[步骤5 再醒来] 醒来：core memory 0 条，FTS5 命中 "brain-spike-1784715885024" 2 条，合计 2 条延续线索。

AC1 (再醒来观察到延续): PASS
  溯源到 memory id=1 title="evidence:no-change-2-draft#1 (contract brain-spike-1784715885024)"
AC2 (全程未绕过三态门): PASS
  1 条 model-reported 证据全部正确停留在 unconfirmed，没有一条被三态门错误 confirm。

=== 结果 ===
AC1: PASS
AC2: PASS
```

Exit code: `0`。

## 独立核实：这不是伪造的 stdout，是真实模型调用

第一次跑（`runId=1`，identity db 未清空前那次）和第二次跑（`runId=2`，本文档存档的这次）都在 `profiles/subscription/workflow.db` 里留下了真实、可查的行——这个文件是仓库既有的 subscription profile 的真实 SQLite audit 库，不是这次 spike 新建的：

```sql
-- workflow_runs（sqlite3 profiles/subscription/workflow.db）
id=2, status=completed, current_state=no_change, created_at=2026-07-22T10:24:45.030Z

-- structured_claims（run_id=2，coder=claude-opus-4-8，真实模型名）
draft#1 coder "docs/conductor-brain-layer/spike/README.md does not exist in the target tree."                                     verified claude-opus-4-8
draft#1 coder "docs/conductor-brain-layer/spike/lib/wake.mjs exports a named function openIdentityStore."                        verified claude-opus-4-8
draft#1 coder "docs/conductor-brain-layer/spike/lib/wake.mjs exports a named function wake."                                     verified claude-opus-4-8
draft#1 coder "No file needed modification; the verification requirement (REQ-001) is already satisfied by the existing source." verified claude-opus-4-8
```

模型（`claude-opus-4-8`，走 `claude-cli` provider）真的读了 `lib/wake.mjs`，正确报告 `README.md` 不存在（任务描述里写了"if it exists"，模型据此正确判断），并给出 `no_change` 结论——这是真实工具调用+真实模型推理的结果，不是一个提前写死的 stub 响应。

**只有 coder 被真实调用，tester 没有**——这是图拓扑本身的行为，不是 driver 的 bug：`draft -> [g1, no_change]` 是条件边（`src/loop/graph.ts`），coder 产出 `no_change` 时直接路由到 `no_change` 终态，完全绕开 `g1`/`review`（tester）。`startRun()` 因此一次调用就直接 `done:true`，`handle.interrupt` 是 `undefined`——driver 的自动放行 while 循环体一次都没进（`while (handle.interrupt && ...)` 条件从第一次就是 false），这也是诚实的：不是"G1/G2 自动放行的逻辑没测到"，是这次真实 run 走的是一条完全不经过任何 gate 的合法路径。

## 一个如实记录的观察（不是这次 spike 要修的 bug）

`ConductorWorkApp.projectEvents(events, contractPath)`（`src/conductor-work/app.ts:53-60`）构造 `EvidenceBundleBuilder` 时只传了 `contractId`/`requirementIds`，**没有传 `runId`**：

```ts
const builder = new EvidenceBundleBuilder({
  contractId: contract?.contractId,
  requirementIds: contract?.requirements.map((requirement) => requirement.id),
});
```

所以即便 driver 明知 `handle.runId === 2`，`app.projectEvents()` 产出的 `EvidenceBundle.runId` 仍然是 `undefined`（stdout 里 `runId=?`，identity db 里 `run-status:unknown`）。这不影响 AC1/AC2 的判定（两条验收标准都靠 `contractId` 字符串溯源，不靠 `runId`），但如实记录：这是 `ConductorWorkApp.projectEvents()` 自己签名层面的一个小完整性缺口（`EvidenceBundleInput` 类型本身支持 `runId`，`projectEvents()` 只是没有把已知的 `runId` 传进去），不是这次 spike 引入的，也不在这次 spike 的改动范围内（PRD §7 明确"不改动 `src/**` 任何一行"）。

## PRD §0.2 一处需要澄清的字面表述（不影响 spike 结论，如实记）

PRD §0.2 引用 `runner.ts` 头注释"the very first `compiled.stream()` call always ends at G1's interrupt"来说明"字面子进程 CLI 命令必然停在 G1"，这句话本身没错（它描述的是 `draft -> g1` 这条边），但没有单独提到 `draft -> no_change` 这条**另一条**、同样从 `draft` 出发的条件边——本次真实 run 走的正是这一条，`startRun()` 一次调用就直接到终态，完全没有中断。这不推翻 PRD §0.2 的结论（库调模式 + resume 仍然是唯一能拿到有意义闭环证据的方式——如果这次 coder 真的产出了 diff 而不是 no_change，就会停在 G1，届时没有 resume 就真的卡住），只是补一句：这次真实跑到的具体路径，连 G1 都没到，是比 PRD §0.2 描述的"至少到 G1"更短的一条合法路径。driver 的 while 循环条件（`handle.interrupt && AUTO_APPROVE_GATES.has(...)`）天然覆盖了这个情况，不需要额外分支。
