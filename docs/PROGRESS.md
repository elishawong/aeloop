# PROGRESS — 当前批次恢复点

> 📌 **「跑到一半关机还能继续」的单一事实来源。** 长任务/批次的实时状态停这。
> 🔁 **新会话/关机重开开场**:① 读本文件 → ② `git status` → ③ 从「进行中」那步接。
> 🧹 批次彻底完成 → **清空**(只留下面空模板),成果写进 `CHANGELOG.md`。
> 规则见 [docs/README.md §4](./README.md)。

---

## 当前批次
- **批次名**: A4b Loop 编排收尾,分支 `feature/issue-13-a4b-loop`(从 A4a merge 后的 main `c6589b7` 新开)。B0 类型/命名骨架(`types.ts`/`workflow-def.ts`/`errors.ts` 扩充)→ B1 `escalation.ts`(新)+ `gates.ts` 阈值/主动升级路由改动 → B2 `graph.ts` 接入 `escalation`/`cancel` 节点 + `graph.test.ts` 追加 6 条 Escalation 子树分支 → B3 `audit-store.ts`(新,三张审计表)+ 单测 → B4 `runner.ts`(新,`startRun`/`resumeRun`,**本增量整合复杂度最高的一批**,`compiled.stream(..., {streamMode:"updates"})` 逐节点归因)+ 单测 → B5 checkpoint 跨进程生产化(真实两个独立 `node` 子进程,`src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs` 导入编译后 `dist/`)→ B6 硬性垂直切片(`src/loop.e2e.test.ts` 追加阈值→escalation→`force_pass`→apply 场景 + `fake-codex.fixture.mjs` 新增 `tester-reject` 场景)→ B7 文档回写(本文件/ROADMAP/CHANGELOG/根 CLAUDE.md/ai-agent 仓 `CHARTS/knowledge/aeloop.md` + `docs/DESIGN.md` §1.5 ruflo 措辞订正)。**276/276 测试绿**,`pnpm build`(tsc strict + noUncheckedIndexedAccess)/ `pnpm lint`(`tsc --noEmit`)双绿。`grep -rln "from.*loop" src/harness src/context src/prompt` 零命中(无反向依赖)、`grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 零命中(图节点/门继续零 I/O)、`grep -n "from \"\.\./\.\./context\|from \"\.\./context" src/loop/audit-store.ts` 零命中(§9.2 决策1;`runner.ts` 的 `ContextInjectionResult` type-only import 不受此检——见 PRD handoff 备注)。B4/B6 各做过一轮针对性变异自验(阈值比较符/`stepRef` 计数器/`routeAfterReview` 分支改坏后对应测试转红、改回复绿)。**尚未 commit/push(等指挥官审批)—— 待 Zorro `/verify` 审。** 详见 `docs/feature/a4b-loop/PRD.md`。
- 上一批(A4a Loop 编排)成果:B0-B6 全部完成,254/254 测试绿,已 Zorro 审 + merge→main(PR #15,`c6589b7`),详见 `docs/feature/a4a-loop/PRD.md` + CHANGELOG.md。
