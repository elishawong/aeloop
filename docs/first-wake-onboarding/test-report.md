# test-report — 首次醒来身份库为空时走交互式引导（issue #96）

> 记本轮 Zorro/Codex 跨模型二签的 R1/R2 审查结论与证据。**如实标注来源**：R1/R2 的审查结论本身
> 是稽核官 Zorro 转述给造物官 Cypher 的（Cypher 没有直接持有 Codex 原始 attestation JSON，不像
> `docs/feature/a4a-loop/test-report.md` 那种由 Zorro 亲自撰写、内嵌原始 JSON 的报告），下面 R1/R2
> 各自的"审查结论"小节转述的是收到的复审消息原文要点，不是 Cypher 编造的；"修复证据"小节是
> Cypher 自己真实跑出来的命令输出，可独立复核。本文件写完后按 Zorro 要求转 Zorro 本人核对齐，
> 核对结果视为本文件的最终有效性来源，不是 Cypher 单方面的自我认证。

---

## R1（第一轮）：Zorro 调 Codex（gpt-5.6-sol）独立复审，判 **FAIL**

**转述的审查结论要点**（来自协调消息，非 Cypher 直接持有的原始 attestation）：Codex 真跑、
exit 0、attestation 落盘；本地核心逻辑（三态判定 + 注入安全）Codex 独立复现全绿；FAIL 集中在
全局安装打包 + 宪法/PRD 文档一致性，逐条如下：

| 级别 | 问题 |
|---|---|
| 🔴 P0 | blocker 1：`scripts/install-global-brain.mjs` 的 `COPY_ITEMS` 漏拷 `onboarding-greeting.mjs`——全局模式下首次空库会在 `import()` 阶段 `MODULE_NOT_FOUND`，被 `main().catch()` 静默吞掉，stdout 完全空，正好变回 #96 要堵的"沉默=模型脑补假开场白"那个洞 |
| 🔴 P0/高P1 | blocker 2：`CLAUDE.md`「醒来」段无条件写"先原样复述"，没有 A/B carve-out，和引导指令互相矛盾（`BRAIN.md` 已补，`CLAUDE.md` 漏了） |
| 🟡 | `onboarding-greeting.mjs` 里"没有 gh 也能跑"的说法当时不实——`seed-brain-identity.mjs` 的 `fetchOpenIssues()` 抛错会让整个进程非零退出；建议优雅降级，不只是改文案 |
| 🟡 | `PRD.md` 写"两段正文都必须覆盖 DESIGN §0 四个坑"，但状态 B 的实现和测试刻意不重复"配置方式二选一/IDE 坑"——PRD 措辞和实现不一致 |
| 🟡 | `brain-wake-greeting.mjs` 头注释仍写"两源都没有→安静跳过、本次未变"，已被推翻未同步 |
| 🟡 | 状态 B 分支的 `store` 在 `listMemories()` 抛错时不会被关闭（状态 C 有 `try/finally` 保护，不对称） |
| 🟡 | `impact.md` 称测试证明状态 C"逐字节不变"，但对应测试只断言了两个子串存在，过度声明 |

### R1 修复（Cypher，同一 worktree，未 commit）

- blocker 1：`COPY_ITEMS` 补上 `onboarding-greeting.mjs`；新增真实端到端测试
  `scripts/test-install-global-brain-onboarding-e2e.mjs`（真装到临时 `--target`，从无关项目
  cwd + `HOME` 覆盖 + `AELOOP_BRAIN_GLOBAL_MODE=1` 真实 spawn 换入后的 hook）；同时发现并修复
  一个附带问题——引导正文里的 `node scripts/...` 命令在全局模式下 cwd-relative 不可达（运行时
  快照不含管理脚本），`renderOnboardingEmptyStore()` 新增 `opts.globalMode` 分支处理。
- blocker 2：`CLAUDE.md`「醒来」段补齐三态 carve-out，措辞对齐 `BRAIN.md`。
- gh 文案不实：选择**优雅降级**（不是仅改文案）——`seed-brain-identity.mjs` 的
  `fetchOpenIssues()` 调用点包 try/catch，失败时记 `skippedIssueSync`、`exit 0`，只改这一个
  调用点；文案同步成真实行为。
- PRD 契约冲突：订正 `PRD.md` §2 对应行的措辞，说明"两坑只属于状态 A"是刻意的产品选择。
- hook 头注释过期：同步更新。
- store 未对称关闭：`listMemories()` 调用包 try/catch，抛错先关 store 再重新抛出。
- impact.md 过度声明：把"逐字节不变"降为"代码路径未改动"，并说明测试实际验证的力度。

**R1 修复后自测证据**（Cypher 直接跑出）：`pnpm run build` 成功、`pnpm lint` 干净、`pnpm test`
634/634 全绿、22 个 spike/hook/script `test-*.mjs` 文件逐一手跑全部 `OK`（含新建的
`test-install-global-brain-onboarding-e2e.mjs` 与新增用例的 `test-seed-brain-identity.mjs`）、
`git diff --stat -- src/` 为空。COPY_ITEMS 修复的双向验证：临时删掉 `onboarding-greeting.mjs`
那一条 `COPY_ITEMS`，`test-install-global-brain-onboarding-e2e.mjs` 在断言②（文件应出现在换入
后的快照里）就失败退出（`exit 1`）；恢复后转回全部 `PASS`——证明这条新测试真的网得住这个 bug。

---

## R2（第二轮）：Zorro 独立复审，判 **PASS（代码）+ FAIL（纯文档一致性）**

**转述的审查结论要点**：代码修复扎实，双签确认（2 个 P0 + 注入红线 + gh 降级 + 三态零回归全部
独立复现绿）；Zorro 自己 revert 了 `COPY_ITEMS` 那一行，独立验证过
`test-install-global-brain-onboarding-e2e.mjs` 真的能抓回归（不是只信 Cypher 单方面的复现）。
本轮 FAIL 不涉及任何代码逻辑，纯文档一致性问题：

| 级别 | 问题 |
|---|---|
| 🔴 幻觉门 | `docs/first-wake-onboarding/DESIGN.md`（§3，原 lines 102-104）仍写"状态 B 的引导文案本身不需要区分 dbPath 来源，都是同一句文案"——这个结论被 R1 修复（`renderOnboardingEmptyStore()` 新增 `opts.globalMode` 分支）推翻了，`DESIGN.md` 被 PRD/impact/hook/onboarding-greeting 全部指名为"设计权威"，权威文档写 X、代码做 not-X 且没有 amendment 标注 = 幻觉门要挡的典型情形 |
| 🔴 | `PRD.md`（原 §5 表格"store 未在 finally 关"一行）措辞写"包进 try/finally"，但实际实现是 try/catch（抛错时关闭并重新抛出）——且这里字面上**不能**用 try/finally（会在状态 C 的成功路径上也把 store 提前关掉），代码选对了，是文档描述错了 |
| 🟡 | `test-onboarding-greeting.mjs` ⑥ 仍断言"两个函数零参数"，但 `renderOnboardingEmptyStore(opts={})` 现在确实接收可选参数——靠默认参数不计入 `Function.length` 侥幸通过，断言意图已过期；且纯度测试从没跑过 `{globalMode:true}` 分支的确定性 |
| 🟡 | gate6（测试打包完整性）：需求目录只有 `DESIGN`/`PRD`/`impact`/`progress`，缺独立命名的 `test-plan.md`/`test-report.md`——内容已经散落在 `PRD.md` §4 验收标准 + `impact.md` 回归清单里，需要归位成独立文件，不新造测试 |

### R2 修复（Cypher，同一 worktree，未 commit，只动文档 + 一处测试断言，不碰任何生产代码逻辑）

- `DESIGN.md` §3：在原结论下方追加一段醒目的"R2 amendment"，明确废止"文案本身不需要区分 dbPath
  来源"这句话，解释清楚"判定不需要感知全局模式"（继续成立）和"文案内容需要感知全局模式"（新增
  的正确结论）是两个独立的问题，说明为什么会需要独立文案分支（运行时快照不含管理脚本）。
- `PRD.md`：原"store 未在 finally 关"一行订正为准确描述 try/catch-close-then-rethrow 语义，并
  解释为什么这里字面上不能用 `try/finally`；同步订正 §2 任务清单表格里同一处的旧措辞。
- `test-onboarding-greeting.mjs` ⑥：改为分别验证 `renderOnboardingEmptyStore({globalMode:false})`
  和 `{globalMode:true}` 两个分支各自"同入参→同输出"的纯度，`renderOnboardingNotConfigured()`
  仍验证零参数（这个函数没有变化，物理上不需要感知全局模式，DESIGN §3 已定盘）。
- 新建 `test-plan.md`（本次改动测试范围/文件清单/验收标准/回归清单/有意不测的东西）+ 本文件
  `test-report.md`——把 `PRD.md` §4 和 `impact.md` 回归清单里已有的内容归位，`PRD.md`/`impact.md`
  原文保留，不删除既有内容（避免读者从旧链接跳进来找不到东西），但新的权威落点是这两份新文件。

**R2 修复后自测证据**（Cypher 直接跑出，命令与输出见下）：

```
$ pnpm run build      # 成功，dist/ 刷新
$ pnpm lint            # tsc --noEmit，干净，零错误
$ pnpm test            # vitest：Test Files 58 passed (58) / Tests 634 passed (634)
$ node docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs
PASS ①-⑧ 全部通过（含订正后的 ⑥）
$ node docs/conductor-brain-layer/spike/test-hook-greeting.mjs
PASS ①-⑩ 全部通过
$ node scripts/test-install-global-brain-onboarding-e2e.mjs
PASS ①②③ 全部通过
$ node scripts/test-seed-brain-identity.mjs
PASS（含 gh 优雅降级用例 ⑧）
$ node scripts/test-install-global-brain.mjs
PASS（57 组断言，COPY_ITEMS 新增一行零回归）
```

其余既有回归测试（`test-greeting.mjs`/`test-wake.mjs`/`test-status-table.mjs`/
`test-version-info.mjs`/`test-three-state-gate.mjs`/`test-translator.mjs`/
`.claude/hooks/lib/test-db-path.mjs`/`test-git-remote.mjs`/`test-command-match.mjs`/
`test-brain-lock.mjs`/`.claude/hooks/test-brain-{commit-gate,isolation-guard,issue-gate,
red-line-guard}.mjs`/`scripts/test-{dispatch-brain-task,generate-version,onboard-project}.mjs`）
逐一手跑，全部 `OK`。`git status --porcelain` 确认改动范围与 R2 要求一致（只有文档 + 一个测试
文件的一处断言），`git diff --stat -- src/` 为空。**未 commit**。

---

## 待确认事项（不是测试失败，是需要指挥官拍板的产品措辞问题）

- `DESIGN.md` §4：`AI_AGENT_PROFILE`/apikey 措辞的解读——Zorro 已确认代码没有断言假默认值（用
  "推荐起步路径"措辞），幻觉门 OK，这一点留给指挥官定，不阻塞本次 PASS。
