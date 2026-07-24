# progress — 在途任务来源可插拔（默认关）+ seed 解耦 gh（issue #103）

- **分支**：`feature/issue-103-enterprise-board`（worktree：
  `aeloop-worktrees/issue-103-enterprise-board`，基线 `origin/main` = `e9beac4`，已含
  #88/#93/#94/#98/#96）
- **状态**：批次 B0-B7 全部完成（B7 = Zorro 复审 FAIL 后的修复批次），本地自测全绿（22 个
  `test-*.mjs` + `pnpm test` 634 条 vitest 用例 + `pnpm run lint`），待 Zorro 重新复审

---

## 批次进度

| 批次 | 状态 | 做了什么 |
|---|---|---|
| B0 | ✅ done | `.claude/hooks/lib/task-source.mjs`（`resolveTaskSource()`，precedence 照抄 `db-path.mjs`）+ `test-task-source.mjs`（10 组断言：默认/env 优先/全局模式跳过本地 json/非法值 fail-closed/组合场景） |
| B1 | ✅ done | `greeting-data.mjs`（`taskSource` 归一化 + `boardEnabled` 门控 statusRows/backlogItems/任务候选，身份候选不受影响，返回值透传 `taskSource`）+ `render-greeting.mjs`（整块渲染门控，不落"无"占位坑）+ `test-greeting.mjs`（既有 7 段全部补 `taskSource:"github"` 保留原有回归覆盖 + 新增 ⑧ 段 taskSource 门控专测） |
| B2 | ✅ done | `brain-wake-greeting.mjs`（resolve 一次 taskSource，透传进 gatherGreetingData；状态 A/B 引导调用不显式传，沿用既有 globalMode 自解析模式）+ `test-hook-greeting.mjs`（⑤ 段补 env，新增 ⑪ 段真实 spawn 端到端） |
| B3 | ✅ done | `onboarding-greeting.mjs`（`seedStep()`/`seedTroubleshooting()` 按 taskSource 分支措辞）+ `test-onboarding-greeting.mjs`（四变体覆盖 + 新增 ⑨ 段专测措辞分支） |
| B4 | ✅ done | `seed-brain-identity.mjs`（途③整段包进 taskSource gate，`skippedIssueSync`→`skippedTaskSync` 改名）+ `test-seed-brain-identity.mjs`（既有用例补 `taskSource:"github"`，新增 ⑨⑩ 段） |
| B5 | ✅ done | `install-global-brain.mjs`（COPY_ITEMS 加 task-source.mjs；导出 `AELOOP_BRAIN_MARKER`；`mergeSettingsWithBrainHook()` 幂等判据改按标记子串原地替换；`--task-source=github` CLI flag）+ `test-install-global-brain.mjs`（幂等用例改用真实形状 command + 新增 2 条纯函数用例 + 2 条端到端用例）+ `test-install-global-brain-onboarding-e2e.mjs`（新增 ④ 段：快照存在性 + 真实 shell 执行 hookCommand 端到端） |
| B6 | ✅ done | 全量自测（21 个 `test-*.mjs` 手工逐个跑 + `pnpm test` + `pnpm run lint`，`git diff --stat -- src/` 确认零改动）；`.claude/brain.local.json.example` 补 `taskSource` 字段；`DESIGN.md` 状态改"指挥官已确认"+ §12 从"待确认"改写成裁决记录 5 条 + §3/§8 措辞按裁决③更正；本文档 + `impact.md` |
| B7 | ✅ done | **Zorro 独立复审（Codex `gpt-5.6-sol` 真跑）FAIL 后的修复批次**——详见下方"Zorro 复审 FAIL 修复记录" |

## Zorro 复审 FAIL 修复记录（2026-07-24，B7）

Zorro 独立复审（引擎 Codex `gpt-5.6-sol`，真实执行，attestation exit_code=0）判 **FAIL**，1 条
🔴 blocker + 3 条 🟡 建议，Zorro 自己独立复现了 blocker（不是只信 Codex 的报告）。逐条修复：

- **🔴 blocker（唯一阻断项）——`mergeSettingsWithBrainHook()` 的所有权判据太宽，会误伤第三方
  hook**：初版 `AELOOP_BRAIN_MARKER = "aeloop-brain"`（裸子串，不带路径分隔符）。Zorro 真实
  构造了一个 command 为 `node "/opt/vendor/aeloop-brain-observer/hook.mjs" --keep-me` 的第三方
  hook（和本工具完全无关，只是路径里恰好含"aeloop-brain"六个字符），跑装机流程后这条第三方
  hook 的 command 被**原地覆盖**成 aeloop 自己的命令——数据丢失级别的回归，且是 #103 本身新
  引入的（基线用精确全串匹配，物理上不会误伤）。**修法**：`AELOOP_BRAIN_MARKER` 改成高特异性
  路径片段 `"/.claude/aeloop-brain/repo-snapshot/"`（只有真实由 `installPaths()` 生成的
  `hookEntryPath` 才会天然带上这整段结构），把碰撞面从"任何含这几个字的命令"收窄到"确实装在
  `~/.claude/aeloop-brain/repo-snapshot/` 下的本工具条目"。补了一条反例回归测试
  （`test-install-global-brain.mjs`，用上面那个第三方 command 原样复现 Zorro 的场景，断言不被
  覆盖）。修复后重跑 `test-install-global-brain-onboarding-e2e.mjs`（真实全局模式端到端）确认
  ④ 段依然全绿——新 marker 值没有破坏真实场景下的匹配。
- **🟡 API/CLI 校验口径不一致**：`installGlobalBrain({taskSource:"bogus"})`（编程调用，绕开
  CLI）此前会静默降级成默认 hookCommand，不报错；只有 CLI 的 `parseArgs()` 做了 fail-closed。
  抽出共享函数 `assertValidTaskSourceOpt()`，`installGlobalBrain()`/`parseArgs()` 都调用它，
  口径统一（两处现在都会对非法值 fail-closed 抛错）。新增用例验证 `installGlobalBrain()` 直接
  调用时非法值会在任何 `execImpl`/写入之前抛错。
- **🟡 `impact.md` 没交代"多条命中只更新第一条"的实际后果**：补了一段——如果一台机器在这次
  修复上线前就已经因为老判据攒出过两条重复的 aeloop SessionStart 条目，本次改动不会自动侦测/
  合并，只保证从此以后不再新增新的重复，排在后面那条既存重复会继续原样保留、继续跑。已知局限，
  留给 #105 或未来的体检工具处理，不在本次范围内。
- **🟡 PRD §4.1"github 路径逐字节相同"措辞过头**：`GreetingData` 新增了 `taskSource` 字段、
  `skippedIssueSync`→`skippedTaskSync` 改名，这些都是本次明确的破坏性改动（impact.md 已经
  如实列出），PRD §4 不该用比 impact.md 更强的措辞自相矛盾。收窄成"渲染出的开场白文本/身份库
  写入/GitHub 拉取副作用等价"，DESIGN.md §10 和 impact.md 的 P0 回归清单同步改了同一处措辞。

**跑法验证**：修复后重跑 `pnpm run build && pnpm run lint && pnpm test`（634 条全绿）+ 全部 22 个
`test-*.mjs` 逐个跑（0 FAIL，`test-install-global-brain.mjs` 从 62 组断言涨到 63 组）+
`git diff --stat -- src/` 确认仍为空。

---

## 关键实现决策（详细论证见 `DESIGN.md`，这里只记落地时的具体选择）

1. **配置轴归一化在数据层再做一次，不只信任调用方**：`gatherGreetingData()` 内部
   `const taskSource = opts.taskSource === "github" ? "github" : "none";`——即便调用方（未来
   某个新调用点）传了一个既不是 `"github"` 也不是 `"none"` 的野值，数据层自己也会 fail-closed，
   不依赖 `resolveTaskSource()` 已经做过一次校验这个假设，纵深防御。
2. **"待你决策"拆分的具体落点**：`greeting-data.mjs` 里 `wakeResult.pendingDecisions`（身份/
   宪法候选）和 `unconfirmedActiveTasks`/`unconfirmedIdeas`（任务/idea 候选）本来就是分开算的
   两个数组，只在最后 `pendingDecisions = [...a, ...b, ...c]` 合并——本次改动只是把后两个数组的
   计算包进 `boardEnabled` 判断，第一个不动，是这份既有代码结构天然支持的最小改动，不是推倒
   重来。
3. **渲染层"整段不出现"用 `if` 包住 `parts.push(...)`，不是给 `labeledSection`/`renderStatusTable`
   加一个新的"隐藏"参数**——保持这两个渲染函数本身的纯度和既有调用契约不变（`status-table.mjs`
   完全没动一行），门控逻辑全部收在 `render-greeting.mjs` 一处。
4. **seed 的 gate 放在最外层（连 `getOriginOwnerRepo` 都不调），不是只包 `fetchOpenIssues`**——
   这是 DESIGN §6 已经定盘的选择，实现时验证了一个额外的好处：`taskSource:"none"` 时对着一个
   **连 git 仓库都不是**的 cwd 也能正常跑完（`test-seed-brain-identity.mjs` ⑨ 段用一个没
   `git init` 过的目录验证），比"只跳过 gh 调用"更彻底地免除了对"当前目录是不是一个已注册的
   git 项目"这件事的依赖。
5. **install 幂等判据改造时选择"定位到具体 hook 对象再替换"，不是替换整个 entry**——`entry.hooks`
   数组理论上可能混有别的工具的 hook（虽然本工具自己写的 entry 目前只会有单个 hook），只替换
   命中标记的那一个 hook 对象、其余原样保留，是更保守的改法，`test-install-global-brain.mjs`
   新增的"混合第三方条目"用例专门验证了这条边界。
6. **`test-install-global-brain-onboarding-e2e.mjs` 的 github 变体真实走 shell 执行
   `resultGithub.hookCommand` 字符串本身**（`spawnSync(command, {shell:true})`），不是像同文件
   其它段那样手动网 `spawnSync("node", [hookEntryPath], {env:{...手动加变量...}})`——这是刻意
   的选择：后者只能证明 `resolveTaskSource()` 认 env，前者才能真正证明"`--task-source=github`
   烘焙进 hookCommand 字符串"这个机制本身端到端生效（这条区别在实现过程中调试时被发现——最初
   写成手动加 env 的版本，测试全绿但没测到真正要测的东西，见下方"踩到的坑"）。

## 实现过程中真实踩到的坑（如实记录）

写 `test-install-global-brain-onboarding-e2e.mjs` ④ 段最初版本时，仿照同文件③段的既有写法直接
`spawnSync("node", [hookEntryPath], {env: {...process.env, HOME: tempHome, AELOOP_BRAIN_GLOBAL_MODE: "1"}})`，
断言"带 `--task-source=github` 装机后板块应该出现"——实际跑发现失败：因为这种写法压根没有把
`AELOOP_BRAIN_TASK_SOURCE=github` 传进子进程 env（那段前缀只存在于 `hookCommand` 这个**字符串**
里，只有真的经过 shell 解析"`VAR=value command`"这种前缀赋值语法才会生效，直接 `spawnSync("node",
[path])` 跳过了 shell，这段前缀从未被任何东西读取过）。改成 `spawnSync(resultGithub.hookCommand,
{shell: true, ...})` 后测试才真正验证到"烘焙进命令行"这个机制本身，而不是巧合地测到
"`resolveTaskSource()` 认识手动设置的 env"这件本来就已经被 `test-task-source.mjs`/
`test-hook-greeting.mjs` ⑪ 覆盖过的事。
