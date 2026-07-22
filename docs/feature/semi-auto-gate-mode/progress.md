---
feature: semi-auto-gate-mode
status: awaiting-zorro-rereview
last_updated: 2026-07-22
---

# Progress — #63 `workflow.gate_mode: "manual" | "semi-auto"`

> **▶ 下一步(RESUME 指针)**:R2(本轮,针对 Zorro/Codex 独立复审 2 个 blocker + 1 个加固建议的返工)已完成,609/609 测试绿(含本轮新增 8 条),`pnpm lint`/`pnpm build` 干净。等 Zorro 再审 + 指挥官批准后 commit/push(**未提交**,Cypher 不自行 commit/push——头号门禁)。

- **关联 PRD**:`./PRD.md`
- **关联 issue**:[elishawong/aeloop#63](https://github.com/elishawong/aeloop/issues/63)
- **分支**:`feature/semi-auto-gate-mode`(worktree `/Users/elishawong/code/github/elishawong/aeloop-worktrees/gate-mode`,off `origin/main`)

## 轮次进度

### R1 — 半自动门开关本体(先前会话实现,未单独留 progress 记录)
- 状态:完成(功能本体),但送独立复审后判 FAIL
- 做了什么:`profile/loader.ts` 加 `workflow.gate_mode` 字段 + fail-closed 校验;`cli/run-loop.ts` 加 `AUTO_APPROVABLE_GATES`/`SEMI_AUTO_DECIDED_BY` + `runInteractiveLoop()` 半自动分支;对应两个测试文件新增用例。
- 改了哪些文件:`src/profile/loader.ts`、`src/profile/__tests__/loader.test.ts`、`src/cli/run-loop.ts`、`src/cli/__tests__/run-loop.test.ts`。
- 本地自检(R1 完成时):601/601 测试绿。
- 送审结果:Zorro + Codex 独立跨模型复审 —— **FAIL**,2 个 blocker + 1 个强烈建议加固(见 `test-report.md`)。

### R2 — 本轮返工(本次任务)
- 状态:完成,等 Zorro 再审
- **Blocker 1(文档链 + 悬空引用)**:
  - 做了什么:建 `docs/feature/semi-auto-gate-mode/{PRD,impact,progress,test-report}.md` 四份文档;把 `run-loop.ts`(文件头注释 + `AUTO_APPROVABLE_GATES` doc comment,原本两处都说"per the PRD's explicit requirement"却指不到任何真实文件)和 `loader.ts`(`gate_mode` 字段 doc comment)里对不存在 PRD 的措辞改成指向真实的 `docs/feature/semi-auto-gate-mode/PRD.md`;顺手在 `docs/DESIGN.md` 的 `config.yaml` 示例块(§7,和既有 `workflow.reject_threshold` 说明同一处)加了 `workflow.gate_mode` 一行 + 一段新说明段落,链接回本 PRD。
  - 改了哪些文件:`docs/feature/semi-auto-gate-mode/*.md`(新,4 份)、`src/cli/run-loop.ts`(仅注释)、`src/profile/loader.ts`(仅注释)、`docs/DESIGN.md`(+3 行)。
  - 本地自检:`grep -rn "per the PRD\|the PRD's" src/` 确认剩下的四处命中全部是既有、无关的 A2/A4a/A5 自己 PRD 的合法引用(`harness/provider-router.ts`/`loop/graph.ts`/`loop/__tests__/gates.test.ts` 两处),没有一处再指向 #63 的不存在文档。
- **Blocker 2(`reject_threshold` fail-closed 校验)**:
  - 做了什么:`cli/assemble.ts`'s `resolveRejectThreshold()` 加 `Number.isInteger(fromProfile) && fromProfile >= 1` 守卫,和同文件 `resolveSchemaMaxAttempts()` 完全同款(逐字抄来保持代码一致性,未发明新姿势)。不合法的 tier-1 值(`NaN`/`Infinity`/负数/`0`/小数)现在落到 tier 2(`SystemConfig.getDefaultRejectThreshold()`)/tier 3(硬编码 `2`),不再原样返回。
  - 改了哪些文件:`src/cli/assemble.ts`(+guard +doc comment)、`src/cli/__tests__/assemble.test.ts`(新增 `it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` 6 条 fail-closed 回归 + 1 条"仍接受合法正整数 1"的非过严回归,共 +7)。
  - 本地自检:**变异自验**——临时去掉守卫(`if (typeof fromProfile === "number")` 不带 `Number.isInteger`/`>= 1`),重跑 `assemble.test.ts`,6 条新 fail-closed 测试全部正确转红(具体失败:`NaN`/`+Infinity`/`-Infinity`/`0`/`-1`/`1.5` 全部原样返回而非落到 tier 2 的 `7`);改回后 42/42 复绿。证明这条守卫真的是这些测试通过的原因,不是巧合绿。
- **加固(gate-identity 断言)**:
  - 做了什么:`run-loop.ts` 新增 `AUTO_APPROVABLE_DB_STATE` 映射(`GateType` → `LOOP_NODES` 对应值)+ 半自动分支里的 2 行断言——`deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]` → 抛错,在构造自动放行的 resume value **之前**执行。
  - 为什么这条断言有意义(不是走流程的摆设):`resumeRun()` 既有的 `resumeDecisionsFor(run.currentState).includes(resume.decision)` 域检查(`loop/runner.ts:1078-1079`)不会挡住 G1/G2 与 G3 混淆的情形——因为 `"approved"` 同时是 G1/G3 两者决策域的合法值。真出现 `interrupt.gate` 和 `current_state` 不一致时(理论不可达,但两者并非同一次读取的同一个字段,是两条独立路径),旧代码会把 `{decision:"approved"}` 发给一个其实是 G3 的 run 而不被现有检查拦下。
  - 改了哪些文件:`src/cli/run-loop.ts`(+断言 +映射常量)、`src/cli/__tests__/run-loop.test.ts`(新增 1 条测试,用独立 `better-sqlite3` 写连接直接改 `workflow_runs.current_state` 伪造不一致场景)。
  - 本地自检:**变异自验**——临时去掉这 3 行断言,重跑 `run-loop.test.ts`,新测试正确转红(`runInteractiveLoop()` resolve 成功而非按预期 reject,且 `prompter.calls` 会被跳过检查前就已经不是 0 —— 实际失败信息是 promise resolved 而非 rejected);改回后 12/12 复绿。

## 本地自检总表(R2 完成时)

| 检查项 | 结果 |
|---|---|
| `pnpm lint` | 干净(`tsc --noEmit` 零错误) |
| `pnpm build` | 干净(`tsc -p tsconfig.build.json` 零错误) |
| `pnpm test` | **609/609** 绿(57 个测试文件),R1 基线 601 + 本轮新增 8(assemble.test.ts +7、run-loop.test.ts +1) |
| `grep -rn "per the PRD\|the PRD's" src/` | 零处指向 #63 的不存在文档;剩余命中均为既有、无关的合法引用 |
| `ls docs/feature/semi-auto-gate-mode/` | `PRD.md`/`impact.md`/`progress.md`(本文件)/`test-report.md` 均已建成,无 `<占位符>` 残留 |
| `git diff --stat -- src/loop` | 空——本轮和 R1 均未触碰 `src/loop/**`(graph/gates/escalation/runner/audit-store 生产代码零改动) |
| 变异自验(gate-identity 断言) | 去掉断言 → 新测试转红;恢复 → 复绿 |
| 变异自验(reject_threshold 守卫) | 去掉守卫 → 6 条新测试转红;恢复 → 复绿 |
| `git status`(commit/push) | **未提交、未推送** —— 等 Zorro 再审 + 指挥官批准 |
