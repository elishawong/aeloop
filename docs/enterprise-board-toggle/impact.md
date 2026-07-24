# impact — 在途任务来源可插拔（默认关）+ seed 解耦 gh（issue #103）

## 影响范围

**新增文件**（不影响任何既有调用点）：
- `.claude/hooks/lib/task-source.mjs`
- `.claude/hooks/lib/test-task-source.mjs`
- `docs/enterprise-board-toggle/{DESIGN,PRD,progress,impact}.md`

**修改文件（有真实运行时行为变化，逐条列出谁会感知到）**：

- **`docs/conductor-brain-layer/spike/lib/greeting-data.mjs` / `render-greeting.mjs`
  （核心行为变化）**：影响面 = 任何会触发 `gatherGreetingData()`/`renderGreeting()` 的场景，
  也就是每一次正常醒来开场白（状态 C）。**这是一次有意的默认值翻转，不是零回归**——`taskSource`
  省略/未显式配置时（shipped 默认），开场白不再包含"现在在途"/"Idea Queue 积压"两段，"待你
  决策"只保留身份/宪法候选（如果原来有任务/idea 候选，这部分会消失）。任何已经在跑这套 hook、
  且没有显式设置 `AELOOP_BRAIN_TASK_SOURCE=github`（或对应 `--task-source=github`/
  `.claude/brain.local.json` 的 `taskSource` 字段）的会话，升级后会感知到这个变化。
- **`scripts/seed-brain-identity.mjs`（行为变化）**：影响面 = 任何跑
  `node scripts/seed-brain-identity.mjs` 的人。默认（未 opt-in）不再反查 owner/repo、不检查
  项目注册、不调 `gh`——`result.issues` 恒为空数组，`result.skippedTaskSync` 恒有值。**破坏性
  改动**：`result.skippedIssueSync` 字段改名 `result.skippedTaskSync`——任何读这个字段名的
  外部调用方（如果存在）需要同步改名，本仓库内的调用方（CLI 输出/测试）已经同步改。
- **`docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs`（#96 首醒引导，行为变化）**：
  影响面 = 身份库"未配置"/"已配置但空"两种状态下看到引导脚本的人。默认引导正文不再提 `gh`/
  GitHub issue 同步，改说"不需要 gh" + 怎么 opt-in；只有已经 opt-in 的场景才会看到 #96 原有的
  gh 相关措辞。
- **`.claude/hooks/brain-wake-greeting.mjs`**：新增一次 `resolveTaskSource()` 调用 + 一个
  透传参数，不改变任何既有分支的判定条件（状态 A/B/C 判定逻辑本身零改动，DESIGN §9 已论证
  taskSource 和三态判定是正交轴）。
- **`scripts/install-global-brain.mjs`（行为变化，仅当显式使用 `--task-source` 时才有感知）**：
  `COPY_ITEMS` 新增一项（`task-source.mjs`）——影响面 = 任何跑这个安装脚本全局装机的人，装出来
  的快照现在多一个文件（不影响装机流程本身）。`mergeSettingsWithBrainHook()` 的幂等判据变更是
  **本次唯一一处即便不使用新 flag 也可能感知到差异的地方**：如果一台机器的 `~/.claude/
  settings.json` 里已经有一条老版本的 aeloop SessionStart 条目（`command` 字符串和这次要写入
  的完全一致），行为不变（真幂等，走 no-op 分支）；如果 `command` 字符串因为任何原因（不只是
  `--task-source`，理论上未来任何改变 `hookCommand` 拼接方式的改动都会触发这条路径）和既有条目
  不同，**旧版本的行为是"追加一条新的、留下重复条目"，新版本的行为是"原地替换"**——新版本行为
  更安全，但这是一处从"追加"到"替换"的语义改变，如实标注。
  - **匹配判据本身**（2026-07-24 Zorro 复审 FAIL 后订正）：识别"哪条是本工具装的"用的是
    `AELOOP_BRAIN_MARKER = "/.claude/aeloop-brain/repo-snapshot/"`——一段只有真实由
    `installPaths()` 生成的 `hookEntryPath` 才会天然带上的高特异性路径片段。初版用的是裸
    `"aeloop-brain"`（不带路径分隔符），Zorro 真实复现过这个判据会把一个 command 里恰好含
    这几个字符、但和本工具完全无关的第三方 hook 误判成"自己的旧条目"并**覆盖掉**——已修复
    （`test-install-global-brain.mjs` 新增反例用例锁死这条边界，用一个 command 含
    "aeloop-brain" 字样但不含完整路径结构的第三方 hook 验证不会被覆盖）。
  - **已知局限，如实标注（不是遗漏，是刻意限定的修复范围）**：`mergeSettingsWithBrainHook()`
    只处理"第一条命中标记的条目"（`break` 后不再继续找）——**如果一台机器在这次修复上线之前
    就已经因为老版本的判据攒出了两条重复的 aeloop SessionStart 条目**，本次改动不会自动侦测/
    合并这种既存重复：只会把排在前面那一条原地替换成新 command，排在后面那条**原样保留、
    继续注册、继续跑**（两条 hook 都会在下次会话启动时执行，行为仍然不可预测，只是不会再变成
    第三条）。这是本次改动明确限定的范围（"防止以后再新增重复"，不是"自动清理已经存在的重复"）
    ——如果指挥官怀疑自己的机器已经因为 #103 上线前的老逻辑攒出过重复条目，需要手动检查
    `~/.claude/settings.json` 的 `hooks.SessionStart` 数组，人工删掉多余的那条；自动合并已存在
    的重复条目留给 #105（uninstall-global-brain）或未来一个专门的"体检/去重"工具去做，不在
    本次范围内。
- **`.claude/brain.local.json.example`**：纯文档性质模板文件，新增 `taskSource` 字段说明，不
  影响任何代码路径（这个文件本身不被任何脚本读取，只是给用户复制的模板）。

**测试文件改动（逐个列出，不是笼统说"更新了测试"）**：
- `docs/conductor-brain-layer/spike/test-greeting.mjs`：既有全部用例的 `gatherGreetingData()`
  调用补了 `{taskSource:"github"}`（保留原有断言意图和覆盖面）；新增 ⑧ 段。
- `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`：⑤ 段 env 补一行；新增 ⑪ 段。
- `docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs`：新增两个变体常量 + ①②③⑧
  段扩展覆盖四变体；新增 ⑨ 段。
- `scripts/test-seed-brain-identity.mjs`：全文 `skippedIssueSync`→`skippedTaskSync` 改名；既有
  6 处 `main()` 调用补 `taskSource:"github"`；新增 ⑨⑩ 段。
- `scripts/test-install-global-brain.mjs`：1 处既有用例改用真实形状 hookCommand；新增 2 条纯
  函数用例 + 2 条 `installGlobalBrain()` 端到端用例。
- `scripts/test-install-global-brain-onboarding-e2e.mjs`：新增 ④ 段（含真实 `pnpm run build`/
  `npm install` 替身/真实 spawn，是本批次里执行成本最高的一段测试，约几秒到十几秒量级）。

**零改动确认**：
- `src/**`（TypeScript 引擎源码）——`git diff --stat -- src/` 为空。
- `docs/conductor-brain-layer/spike/lib/status-table.mjs`/`wake.mjs`/`sanitize.mjs`/
  `version-info.mjs`——本次改动完全没碰这几个文件，`renderStatusTable()`/`collectStatusRows()`
  的既有契约不变。
- `docs/conductor-brain-layer/spike/print-status-table.mjs`（按需查询 skill 的 CLI 入口）——
  刻意不改（DESIGN §7），用户显式主动查询不受"默认不推看板"策略约束。
- README.md / WAKE-GREETING-RUNBOOK.md 等面向人读的文档——刻意排除在本次范围外（DESIGN §7），
  留作独立的后续 P2，不阻塞本次落地。

---

## 测试建议（给 Zorro / 指挥官看 staging 时的重点）

1. **真实跑一次 `node scripts/seed-brain-identity.mjs`**（不设 `AELOOP_BRAIN_TASK_SOURCE`）：
   确认不调 gh、不报"目标项目尚未注册"、`skippedTaskSync` 输出措辞通用（不提 GitHub）。
2. **真实开一个会话**（`AELOOP_BRAIN_IDENTITY_DB` 指向一个有身份 + 至少一条 active_task 的库，
   不设 `AELOOP_BRAIN_TASK_SOURCE`）：确认开场白没有"现在在途"/"Idea Queue 积压"两段，"待你
   决策"如果本来就没有身份/宪法候选则显示"无"（不是被砍掉整段）。
3. **设 `AELOOP_BRAIN_TASK_SOURCE=github` 再开一次**：确认行为和 #96 之前完全一致（回归）。
4. **`node scripts/install-global-brain.mjs --dry-run --task-source=github`**：确认
   `hookCommand` 输出含 `AELOOP_BRAIN_TASK_SOURCE=github`；`--task-source=bogus` 应报错退出。
5. Zorro 复审时重点核对 `docs/enterprise-board-toggle/DESIGN.md` §12 的裁决记录和实际代码是否
   一致（尤其④ install 幂等这条，涉及往用户真实 `~/.claude/settings.json` 写文件，风险等级高）。

## 回归清单（P0/P1/P2）

**P0（阻断级，必须验证）**：
- [ ] `pnpm test`（vitest，`src/**`）全绿——`src/**` 零改动，理论上不可能不绿，但仍要真跑一次
  确认没有隐藏的跨目录依赖。
- [ ] 全部 `test-*.mjs`（21 个文件）逐个跑通，见 `progress.md` 已记录的命令。
- [ ] `pnpm run lint`（`tsc --noEmit`）零报错。
- [ ] `taskSource:"github"` 场景下渲染出的开场白文本/写入身份库的数据/GitHub 拉取副作用和
  #96 落地时的行为等价（零回归底线，不含 `skippedIssueSync`→`skippedTaskSync` 这类内部字段名
  改动——那是本次明确的破坏性改动，不在这条零回归承诺范围内，见上方"影响范围"）。已有测试
  覆盖，人工复核时重点看 `test-greeting.mjs` 的既有断言是否真的原样保留，不是被悄悄改弱。

**P1（本次改动的核心新行为，必须验证）**：
- [ ] `taskSource:"none"`/默认时，渲染输出不含 `"**现在在途："`/`"**Idea Queue 积压："` 子串
  （不是含但显示"无"）。
- [ ] `taskSource:"none"` 时 seed 对未注册/非 git 目录的 cwd 也能正常跑完，`fetchOpenIssues`
  零调用。
- [ ] `install-global-brain.mjs` 反复用不同 `taskSource` 重装同一 `homeDir`，
  `settings.json` 里 aeloop 的 SessionStart 条目数始终为 1。
- [ ] 首醒引导（#96 状态 A/B）默认措辞不提 `gh`/GitHub。

**P2（体验/文档，不阻断）**：
- [ ] README.md/WAKE-GREETING-RUNBOOK.md 等面向人读的文档同步更新（本次范围外，独立跟进）。
- [ ] `CHANGELOG.md` 补一条本次改动记录（如果仓库有维护 CHANGELOG 的惯例，本次未确认是否需要，
  留给指挥官/军师判断是否要求补）。
