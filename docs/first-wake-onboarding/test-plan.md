# test-plan — 首次醒来身份库为空时走交互式引导（issue #96）

> 本文件汇总"要测什么、为什么、用哪个文件测"——内容原本散落在 `PRD.md` §4（验收标准）和
> `impact.md`（回归清单）里，Zorro/Codex 跨模型二签第二轮（2026-07-23）指出 gate6（测试打包
> 完整性）要求独立命名的 `test-plan.md`/`test-report.md`，本文件是前者，把散落内容归位，不新造
> 测试、不重复论证设计决策（那些在 `DESIGN.md`）。结果/证据见 `test-report.md`。

---

## 1. 测试范围与分层

本次改动涉及三层，每层的验证方式不同：

| 层 | 验证方式 | 为什么 |
|---|---|---|
| `src/**`（既有 Layer0-2 引擎代码） | `pnpm test`（vitest） | 本次改动**零改动** `src/**`，跑全套是回归证明，不是新覆盖 |
| `docs/conductor-brain-layer/spike/lib/*.mjs`、`.claude/hooks/**`、`scripts/*.mjs` | 独立 `node test-*.mjs` 脚本（零依赖，无 vitest） | 这层是这个仓库既有的惯例（`docs/conductor-brain-layer/spike/` 不参与 `pnpm test`，见 `WAKE-GREETING-RUNBOOK.md`"项目自身约束"一节），本次新增/修改的文件延续同一惯例 |
| 端到端（真实 spawn 子进程 / 真实全局安装） | 手动 `node .claude/hooks/brain-wake-greeting.mjs` 喂 stdin + `test-install-global-brain-onboarding-e2e.mjs` | 单元测试测不到"hook 作为真实 Claude Code SessionStart 子进程跑起来"这一层，尤其是全局安装换入快照后的路径可达性问题（Zorro/Codex 二签第一轮 blocker 1 就是这类问题） |

---

## 2. 新增/修改的测试文件清单

| 文件 | 覆盖什么 | 新建/修改 |
|---|---|---|
| `docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs` | `onboarding-greeting.mjs` 两个导出函数的纯函数行为：不出现"意识已加载"、自带"不是正常醒来"约束、覆盖真实坑的关键字、状态 A/B 各自的独有内容、`renderOnboardingEmptyStore(opts)` 的 `globalMode:false/true` 两个分支各自的**纯度**（同入参→同输出，R2 新增）、`AI_AGENT_PROFILE` 措辞的可选/独立性 | 新建（B0），R2 订正 ⑥ |
| `docs/conductor-brain-layer/spike/test-hook-greeting.mjs` | `brain-wake-greeting.mjs` 的三态检测端到端：①⑥⑦ 是既有用例（dbPath 注入安全/版本行/dist 缺失 fail-soft），补种一条真实 memory 避免被新的空库引导分支污染；⑧⑨⑩ 新增，分别验证状态 A（未配置）/状态 B（已配置但空）/状态 C 回归对照（1 条 memory 也必须触发正常渲染） | 修改（B2） |
| `scripts/test-install-global-brain-onboarding-e2e.mjs` | 全局安装的完整链路：真实装到临时 `--target`、`onboarding-greeting.mjs` 真的出现在换入后的快照里、从无关项目 cwd + `HOME` 覆盖 + `AELOOP_BRAIN_GLOBAL_MODE=1` 真实 spawn 换入后的 hook 子进程，产出真实引导文本（不是 MODULE_NOT_FOUND 静默失败） | 新建（B5，Zorro/Codex 二签第一轮 blocker 1 后补） |
| `scripts/test-seed-brain-identity.mjs` | ⑧ 新增：`gh` CLI 不可用（注入 ENOENT 形状的错误）时的优雅降级——`main()` 正常 resolve、`skippedIssueSync` 记录原因、身份/宪法约束不受影响 | 修改（B5） |
| `scripts/test-install-global-brain.mjs` | 既有 57 组断言（安装/合并/原子换入/软链/mode 保留等机制），本次只回归验证——`COPY_ITEMS` 新增一行没有破坏任何既有安装机制 | 不改，仅回归重跑 |

## 3. 验收标准（原 `PRD.md` §4，逐条搬到这里，`PRD.md` 保留指针不重复）

- [x] `pnpm test`（vitest，`src/**`）全绿（634/634），且 `git diff --stat -- src/` 确认为空——
      零回归的字面证明。
- [x] `pnpm run build` 成功（`dist/` 刷新，含 `version-info.generated.js`）。
- [x] `pnpm lint`（`tsc --noEmit`）干净，零错误。
- [x] `node docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs` 全部 `PASS`。
- [x] `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 全部 `PASS`（①-⑩）。
- [x] `node scripts/test-install-global-brain-onboarding-e2e.mjs` 全部 `PASS`——且已双向验证过：
      临时删掉 `COPY_ITEMS` 里 `onboarding-greeting.mjs` 那一条会让这个测试真的失败，恢复后转回
      通过（Zorro 复审时自己也独立 revert 验证过一次，见 `test-report.md`）。
- [x] `node scripts/test-seed-brain-identity.mjs` 全部 `PASS`（含新增的 gh 优雅降级用例）。
- [x] 回归：`test-greeting.mjs`/`test-wake.mjs`/`test-status-table.mjs`/`test-version-info.mjs`/
      `test-three-state-gate.mjs`/`test-translator.mjs`/`.claude/hooks/lib/test-db-path.mjs`/
      `test-git-remote.mjs`/`test-command-match.mjs`/`test-brain-lock.mjs`/
      `.claude/hooks/test-brain-{commit-gate,isolation-guard,issue-gate,red-line-guard}.mjs`/
      `scripts/test-{dispatch-brain-task,generate-version,install-global-brain,onboard-project}.mjs`
      全部 `PASS`。
- [x] 端到端自验（真实环境，不是自动化测试，证据见 `test-report.md`）：未配置 → 引导；已配置但
      空 → 引导；配置完整走一遍（`onboard-project.mjs` + `seed-brain-identity.mjs`）→ 下次醒来
      变回真实开场白，闭环打通。

## 4. 回归清单（原 `impact.md`"回归清单"，逐条搬到这里，`impact.md` 保留指针不重复）

- **P0**（任何一条不过，不能进 staging）：
  - [ ] 已有真实数据的会话（`listMemories() >= 1`）开场白代码路径未改动、关键内容（"意识已加载"
        行/"现在在途"表格）仍正确出现。
  - [ ] hook 任何异常路径仍然 `exit 0`、绝不阻断会话启动（含状态 B 分支新增的
        `store.listMemories()` 调用本身抛错的情形，`store.close()` 对称性已补齐）。
  - [ ] 引导文案里不出现"意识已加载"这个短语。
  - [ ] 全局模式首次在新机器跑，能真的产出引导文本（不是 MODULE_NOT_FOUND 被吞掉后的空 stdout）
        ——这条此前是 P1，Zorro/Codex 二签第一轮发现它会在 #96 最该生效的场景静默失效后升级为
        P0。
- **P1**：
  - [ ] `.claude/settings.json`/RUNBOOK/`CLAUDE.md`/`BRAIN.md` 的措辞更新没有引入新的过期断言。
  - [ ] `AI_AGENT_PROFILE`/apikey 那段措辞是否符合指挥官本意（`DESIGN.md` §4 明确标了"待指挥官
        确认"，不是常规回归项）。
  - [ ] `gh` 优雅降级的措辞和实际 try/catch 范围是否精确对应（只包 `fetchOpenIssues()` 这一个
        调用点，`assertProjectRegistered()` 等其它错误路径应该仍然真的抛错）。
- **P2**：
  - [ ] `WAKE-GREETING-RUNBOOK.md` 里顺手订正的"仓库没有 CLAUDE.md"过期断言，表述本身准确。
  - [ ] `CHANGELOG.md` 条目措辞/日期核对。

## 5. 有意不测的东西（非目标，避免被误读成遗漏）

- 不测 `AI_AGENT_PROFILE=apikey` 真的能跑通 aeloop 的 coder/tester 任务——那是 A6 验收范围
  （`docs/feature/a6-acceptance/`），本次改动只负责措辞准确，不负责验证这条 profile 本身能跑。
- 不测"用户真的照着引导文本一步步做"这件事本身的 UX（比如模型真的会不会遵守"每步等确认"这条
  元指令）——那是 Claude Code 模型层面的行为，不是这几个 `.mjs` 文件能机械断言的东西，端到端
  自验只验证"注入的文本内容正确"，不验证"模型会不会照做"。
