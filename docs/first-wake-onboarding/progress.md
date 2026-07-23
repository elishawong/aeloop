# progress — 首次醒来身份库为空时走交互式引导（issue #96）

- **分支**：`feature/issue-96-first-wake`（worktree：`aeloop-worktrees/issue-96-first-wake`，
  基线 `origin/main` = `d572902`，已含 #88/#93/#94/#98）
- **状态**：批次 B0-B4 全部完成 + Zorro/Codex 跨模型二签 FAIL 后的修复批次（B5）全部完成，
  本地自测全绿，待重新提交 Zorro 复审

---

## 批次进度

| 批次 | 状态 | 做了什么 |
|---|---|---|
| B0 | ✅ done | `onboarding-greeting.mjs`（两段纯静态引导正文）+ `test-onboarding-greeting.mjs`（7 组断言） |
| B1 | ✅ done | `brain-wake-greeting.mjs` 三态检测 + 注入分支 + `wrapOnboardingScript()` 元指令包装 |
| B2 | ✅ done | `test-hook-greeting.mjs`：①⑥⑦ 补种真实 memory（避免被新分支污染）+ 新增 ⑧⑨⑩ 三段端到端用例 |
| B3 | ✅ done | `.claude/settings.json` `$comment`、`WAKE-GREETING-RUNBOOK.md`（含新增"首次醒来引导"一节 + seed 前置条件补记 + 顺手订正一处过期的"没有 CLAUDE.md"断言）、`BRAIN.md`、`CHANGELOG.md` |
| B4 | ✅ done | 本文档 + `impact.md` |
| B5 | ✅ done | Zorro/Codex 跨模型二签 FAIL 修复（详细记录见 `PRD.md` §5）：全局安装 `COPY_ITEMS` 补齐 + 真实 E2E、全局模式路径可达性、`CLAUDE.md` 三态 carve-out、gh 优雅降级、PRD/hook 头注释/impact.md 措辞订正、store 关闭对称化 |

---

## 关键实现决策（详细论证见 `DESIGN.md`，这里只记落地时的具体选择）

1. **三态判定加在 `main()` 里，不改 `resolveIdentityDbPath()`**：`dbPath === null` → 状态 A（直接
   走引导，不开 store）；`dbPath` 非空但 `openIdentityStore(dbPath).listMemories().length === 0`
   → 状态 B（关闭 store 后走引导）；否则 → 状态 C，原有 #84/#88/#93 逻辑零改动。
2. **引导正文是纯静态模板，不插值任何身份库/环境变量数据**（含 dbPath 本身）——延续 2026-07-23
   那一轮复审"诊断信息根上拿掉，不进模型要转达的正文"的选择，不是漏做 `sanitizeText()`；
   `onboarding-greeting.mjs` 头注释里写清楚了这条护栏，供后来者插值前先看。
3. **两段正文自带"不是正常醒来/不要假装"约束**，hook 层再包一层元指令双重强调——防止未来任何
   一层的措辞被后续改动弱化时还有另一层兜底。
4. **`AI_AGENT_PROFILE`/apikey 措辞**：issue 原文"默认只能 apikey profile"经核实和 `.env.example`
   当前真实默认值（`subscription`）字面相反——采纳"推荐起步路径"措辞，不断言当前配置文件默认值，
   详细论证 + 待指挥官确认点见 `DESIGN.md` §4。

## 实现过程中真实发现的、原始 DESIGN 草稿没预料到的坑（如实记录，不是回填假装一开始就想到）

跑端到端自验时，真实执行 `node scripts/seed-brain-identity.mjs`（对着一个刚配置、从未 seed 过的
空 dbPath），发现它在"issue 同步"这一步会要求当前项目先被 `node scripts/onboard-project.mjs
--repo-path <path>`（issue #93 B3）注册过——不是本次改动引入的问题，是这套机制里已经存在但此前
从未被任何 RUNBOOK/onboarding 文案记录过的一个真实前置条件。已经：
- 补进 `onboarding-greeting.mjs` 的 `SEED_TROUBLESHOOTING`（两段引导正文都会提到）；
- 补进 `WAKE-GREETING-RUNBOOK.md`"配置身份库"第 3 步；
- `test-onboarding-greeting.mjs` ③ 增加对应关键字断言。

## 自测证据

- `pnpm test`（vitest，`src/**`）：**634 个测试全部通过**，`git diff --stat` 确认本次改动没有
  触碰 `src/**` 任何一行（build artifacts `dist/`/`src/shared/version-info.generated.ts` 均已
  gitignore，不在 diff 里）。
- `pnpm run build`：成功，`dist/` 刷新。
- `node docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs`：7 组断言全部 `PASS`。
- `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs`：①-⑩ 全部 `PASS`（含更新过的
  ①⑥⑦ 三段 + 新增的 ⑧⑨⑩ 三段）。
- 回归（本次改动理论上不触碰的底层函数，仍然真跑一遍）：`test-greeting.mjs`/`test-wake.mjs`/
  `test-status-table.mjs`/`test-version-info.mjs`/`test-three-state-gate.mjs`/`test-translator.mjs`/
  `.claude/hooks/lib/test-db-path.mjs`/`test-git-remote.mjs`/`test-command-match.mjs`/
  `test-brain-lock.mjs`/`.claude/hooks/test-brain-commit-gate.mjs`/`test-brain-isolation-guard.mjs`/
  `test-brain-issue-gate.mjs`/`test-brain-red-line-guard.mjs`/`scripts/test-dispatch-brain-task.mjs`/
  `test-generate-version.mjs`/`test-install-global-brain.mjs`/`test-onboard-project.mjs`/
  `test-seed-brain-identity.mjs`——全部 `OK`（21 个 spike/hook/script 测试文件逐一手跑，加
  `pnpm test` 的 58 个 vitest 文件，合计全绿）。

## 端到端自验（真实环境，不是自动化测试）

1. **未配置**：`env -u AELOOP_BRAIN_IDENTITY_DB -u AELOOP_BRAIN_GLOBAL_MODE` 真实 spawn hook（`cwd`
   指向一个不含 `.claude/brain.local.json` 的全新临时目录），输出是引导脚本、不含"意识已加载"、
   `exit 0`——和文档里描述的"公司电脑实战踩到的第 1 步失败"完全对应，验证了这次改动确实堵上了
   那个洞。
2. **已配置但空**：`AELOOP_BRAIN_IDENTITY_DB=/tmp/e2e-emptydb/identity.db`（从未 seed 过）真实
   spawn hook，输出是"状态 B"版本的引导脚本，不含"意识已加载"，`exit 0`。
3. **打通全链路**：对同一个 `/tmp/e2e-emptydb/identity.db`，先跑 `scripts/onboard-project.mjs
   --repo-path <本仓库路径>` 注册项目，再跑 `scripts/seed-brain-identity.mjs`（成功写入身份 +
   7 条宪法约束 + 53 条真实 issue），再重新 spawn hook——输出变回完整的"意识已加载。我是 你的
   AI 调度员。"开场白，含"现在在途"真实表格，证明"配置 → 引导 → 照做 → 下一次醒来变正常"这条
   闭环端到端跑通，不是只在单元测试里假设。

（以上手动临时文件已清理，不留在 worktree 里。）

---

## 二签修复后自测证据（B5，Zorro/Codex 跨模型二签 2026-07-23 FAIL 之后）

修复内容逐条见 `PRD.md` §5 表格。这里只记这一轮新增/重跑的验证。

### 全局安装 blocker 1 的回归证明（双向验证，不是只跑通过的那一次）

1. **确认修复前会真的失败**：临时把 `COPY_ITEMS` 里 `onboarding-greeting.mjs` 那一条删掉，跑
   `node scripts/test-install-global-brain-onboarding-e2e.mjs` —— 在断言②（`onboarding-greeting.mjs`
   应该出现在换入后的快照里）就失败退出，`exit 1`，证明这条新测试确实网得住这个 bug，不是摆设。
2. **确认修复后通过**：恢复 `COPY_ITEMS`，同一个测试三段全部 `PASS`——① 真实装到临时 `--target`
   ② `onboarding-greeting.mjs` 真的出现在快照里 ③ 从一个无关项目 cwd、`HOME` 指向临时安装目录、
   `AELOOP_BRAIN_GLOBAL_MODE=1`，真实 spawn 换入后的 hook 子进程，产出真实引导文本（含
   `git clone`/`AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/seed-brain-identity.mjs` 这些全局模式
   专属措辞），不是 MODULE_NOT_FOUND 静默失败。
3. `node_modules/better-sqlite3` 的真实性：这个测试不真的跑 `npm install`（测试环境网络不可控），
   改用这个 worktree 自己已经验证能用的 `node_modules/better-sqlite3`（含真实编译好的 native
   binding）直接拷进 staging 目录——`pnpm run build` 这一步倒是真的跑了（不 stub），细节和取舍
   理由见该测试文件头注释。

### 全套测试（build + lint + vitest + 全部 spike/hook/script test-*.mjs）

- `pnpm run build`：成功。
- `pnpm lint`（`tsc --noEmit`）：**干净，零错误**。
- `pnpm test`（vitest，`src/**`）：**634 个测试全部通过**；`git diff --stat -- src/` 确认本轮
  修复同样没有触碰 `src/**` 任何一行（这轮改动全部落在 `.claude/hooks/`、`scripts/`、
  `docs/`、`CLAUDE.md`）。
- 22 个 spike/hook/script `test-*.mjs` 文件逐一手跑，**全部 `OK`**（比上一轮多了两个新文件：
  `test-onboarding-greeting.mjs` 新增 ⑧ 全局模式分支断言、`scripts/test-install-global-brain-onboarding-e2e.mjs`
  全新真实 E2E；`scripts/test-seed-brain-identity.mjs` 新增 ⑧ gh 优雅降级断言）：
  `test-onboarding-greeting.mjs` / `test-hook-greeting.mjs` / `test-greeting.mjs` / `test-wake.mjs` /
  `test-status-table.mjs` / `test-version-info.mjs` / `test-three-state-gate.mjs` /
  `test-translator.mjs` / `.claude/hooks/lib/test-db-path.mjs` / `test-git-remote.mjs` /
  `test-command-match.mjs` / `test-brain-lock.mjs` /
  `.claude/hooks/test-brain-{commit-gate,isolation-guard,issue-gate,red-line-guard}.mjs` /
  `scripts/test-dispatch-brain-task.mjs` / `test-generate-version.mjs` /
  `test-install-global-brain.mjs`（57 组断言，含 blocker 1 修复没有破坏任何既有安装机制测试）/
  `test-install-global-brain-onboarding-e2e.mjs`（新建） / `test-onboard-project.mjs` /
  `test-seed-brain-identity.mjs`（含新增 gh 优雅降级用例）。

### gh 优雅降级的具体验证

`scripts/test-seed-brain-identity.mjs` 新增用例 ⑧：注入一个 `code: "ENOENT"` 的 Error（真实 `gh`
缺失时 `execFileSync` 会抛出的错误形状）模拟 `fetchOpenIssues()` 失败，断言：`main()` 正常
resolve（不 reject）、`result.skippedIssueSync` 说明原因且带上原始错误信息、`result.issues` 为
`[]`、身份和宪法约束记录仍然正常写入 DB（不只是"返回值说没受影响"，直接重新读库验证记录真的
还在）。这条测试用注入而不是真的卸载本机 `gh` CLI 或断网——理由和范围收窄一致：这次改动的
落点是 `fetchOpenIssues()` 调用点自身的错误处理，不是 `gh` CLI 本身的行为，注入一个真实形状的
错误已经足够验证这条错误处理路径。
