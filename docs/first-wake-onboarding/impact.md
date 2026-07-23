# impact — 首次醒来身份库为空时走交互式引导（issue #96）

## 影响范围

**新增文件**（不影响任何既有调用点）：
- `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs`
- `docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs`
- `docs/first-wake-onboarding/{DESIGN,PRD,progress,impact}.md`
- `scripts/test-install-global-brain-onboarding-e2e.mjs`（B5 新增，Zorro/Codex 二签 FAIL 后补的
  真实端到端测试）

**修改文件**（行为变化，逐条列出谁会感知到）：
- `.claude/hooks/brain-wake-greeting.mjs`：**唯一有真实运行时行为变化的文件**。影响面 = 任何在
  aeloop 仓库（或全局装了 turnkey 包）里开 Claude Code 会话、且身份库"未配置"或"已配置但一条
  memory 都没有"的人——此前这两种情况下 SessionStart 完全沉默，现在会收到一段引导脚本。**已有
  真实数据的会话（`listMemories().length >= 1`）代码路径未改动**——三态检测里状态 C 分支
  （`gatherGreetingData()`/`renderGreeting()` 调用及其之后的全部逻辑）就是改动前的原始代码，
  没有挪动一行，可用 `git diff` 直接核对（Zorro/Codex 跨模型二签 2026-07-23 订正措辞：此前这里
  写"逐字节不变"过度声明了测试证明力度——`test-hook-greeting.mjs` ⑩ 只断言了两个关键子串存在，
  不是全量 diff/相等比对；"代码路径未改动"是可由 diff 直接核实的结构性事实，"渲染输出逐字节
  不变"是这条结构性事实的合理推论，但没有一个测试真的做过字节级相等断言来证明它，两者不能
  混为一谈）。
- `.claude/settings.json`（仅 `$comment` 字段，纯文档性质，不影响任何 hook 注册/matcher 行为）。
- `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`/`BRAIN.md`：文档同步，不影响任何代码路径；
  `BRAIN.md` 是整段注入进上下文的宪法正文之一，新增的一小段会出现在每次正常会话的静态上下文里
  （体量：4 句话，约 200 字，对 token 预算影响可忽略）。
- `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`：①⑥⑦ 三段测试的前置条件变了（补种
  一条 memory），断言意图不变；新增 ⑧⑨⑩。
- `CHANGELOG.md`：纯记录，无行为影响。
- `CLAUDE.md`（B5 新增）：**每次会话都会被 Claude Code 原生装载的静态正文**——「醒来」段新增
  三态 carve-out 的 4 句话。影响面 = 所有在这个仓库开会话的人（不只是空库场景）都会多读到这几
  句话；语义上是给已有的"先原样复述"这条指令加了一个例外条件，不改变状态 C（有数据）时的行为。
- `scripts/install-global-brain.mjs`（B5 新增，**唯一另一处有真实运行时行为变化的文件**）：
  `COPY_ITEMS` 补了 `onboarding-greeting.mjs` 一行——影响面 = 任何跑
  `node scripts/install-global-brain.mjs`（或它的 CLI `--target`/生产调用）全局装这套东西的人，
  装出来的 `~/.claude/aeloop-brain/repo-snapshot/` 现在会包含这个文件，全局模式下状态 A/B 才能
  真的被触发而不是 MODULE_NOT_FOUND 静默失败。不影响 `installGlobalBrain()` 的合并/原子换入/
  校验等其它任何机制（`test-install-global-brain.mjs` 57 组断言全绿，零回归）。
- `scripts/seed-brain-identity.mjs`（B5 新增，行为变化）：`fetchOpenIssues()` 调用点从"抛错冒泡
  导致进程非零退出"改成"try/catch 优雅降级，记 `skippedIssueSync`，`exit 0`"——影响面 = 任何
  `gh` CLI 未安装/未登录/调用失败的人跑这个脚本，现在能拿到"身份+宪法已写入，issue 同步被跳过"
  而不是一个报错中止、让人以为整个脚本都失败了的进程。只改了这一个调用点，`assertProjectRegistered()`
  等其它错误路径的语义不变（仍然真的抛错中止）。

**未改动**（刻意确认，作为回归证明）：`src/**`（零改动，`pnpm test` 634 个测试全绿，
`git diff --stat -- src/` 两轮均确认为空）、`greeting-data.mjs`/`render-greeting.mjs`/`wake.mjs`/
`status-table.mjs`/`sanitize.mjs`/`db-path.mjs`（状态 C 路径的全部依赖，一行未动）、
`scripts/onboard-project.mjs`（只在文档里更完整地说明了已有行为，脚本本身零改动）、
`installGlobalBrain()`/`mergeSettingsWithBrainHook()` 等 `install-global-brain.mjs` 内的其它函数
（只多了 `COPY_ITEMS` 一行，函数体本身零改动）。

## 测试建议（给 Zorro / 指挥官 staging 验收用）

1. **最小复现（对应真实失败故事第 1 步）**：一台没配置过 `AELOOP_BRAIN_IDENTITY_DB`/
   `.claude/brain.local.json` 的机器，在这个 worktree 里开一个新 Claude Code 会话——第一句话
   应该收到引导脚本（模型会用问答带你配置），不应该是空白，也不应该是模型自己编的假"意识已
   加载"。
2. **打通验收**：照引导脚本走一遍（配 `.claude/brain.local.json` → `pnpm run build` →
   `node scripts/onboard-project.mjs --repo-path <本仓库路径>` → `node
   scripts/seed-brain-identity.mjs`）→ 开新会话 → 应该看到真实的"意识已加载"开场白 + 真实
   "现在在途"表格。
3. **回归**：已经配置好、有真实数据的机器（比如指挥官自己已经跑过 seed 的环境）——开场白应该
   和 #96 之前完全一样，不应该出现任何引导措辞。
4. **全局模式（B5 新增）**：`node scripts/install-global-brain.mjs --target=<临时目录>` 装一份，
   `AELOOP_BRAIN_GLOBAL_MODE=1 node <target>/.claude/aeloop-brain/repo-snapshot/.claude/hooks/
   brain-wake-greeting.mjs` 从任意一个无关目录手动跑——应该产出引导文本（含 `git clone`/
   `AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/...` 这些全局模式专属措辞），不是空 stdout。
5. **gh 优雅降级（B5 新增）**：本机如果没装/没登录 `gh`，跑 `node scripts/seed-brain-identity.mjs`
   应该正常退出（`exit 0`），控制台印出"issue 同步已跳过"而不是一段报错堆栈。

## 回归清单（P0/P1/P2）

- **P0**：
  - [ ] 已有真实数据的会话（`listMemories() >= 1`）开场白代码路径未改动、关键内容（"意识已加载"行/"现在在途"表格）仍正确出现（`test-hook-greeting.mjs` ①⑤⑥⑦⑩ 已自动化覆盖子串级断言，人工再核一次真实 staging 环境的完整输出）。
  - [ ] hook 任何异常路径仍然 `exit 0`、绝不阻断会话启动（"绝不阻断"是这个文件从 #84 起最基础的红线，本次新增的 `store.listMemories()` 调用如果抛错，必须仍被 `main().catch()` 兜住；B5 已补齐这条路径自己的 `store.close()` 对称性，见 `brain-wake-greeting.mjs` 对应注释）。
  - [ ] 引导文案里不出现"意识已加载"这个短语（防止模型把引导脚本误当开场白抄）。
  - [ ]（B5 新增，P0 升级——此前是 P1，因为发现它会在#96最该生效的场景静默失效）全局模式首次
        在新机器跑，能真的产出引导文本（不是 MODULE_NOT_FOUND 被吞掉后的空 stdout）——
        `scripts/test-install-global-brain-onboarding-e2e.mjs` 已自动化覆盖，且已验证过删掉
        `COPY_ITEMS` 里那一行确实会让这个测试失败（不是摆设）。
- **P1**：
  - [ ] `.claude/settings.json`/RUNBOOK/`CLAUDE.md`/`BRAIN.md` 的措辞更新没有引入新的过期断言（Zorro 独立核实一遍原文，B5 已把 `CLAUDE.md` 的遗漏补上）。
  - [ ] `AI_AGENT_PROFILE`/apikey 那段措辞是否符合指挥官本意（DESIGN §4 明确标了"待指挥官确认"，这条不是常规回归项，是需要指挥官过一遍原意的项）。
  - [ ]（B5 新增）`gh` 优雅降级的措辞和实际行为是否真的一致——`onboarding-greeting.mjs` 的 `seedStep()` 现在说"没装/没登录/调用失败也能跑成功"，核对这句话和 `seed-brain-identity.mjs` 的 try/catch 范围（只包 `fetchOpenIssues()` 这一个调用点）是否精确对应，没有过度概括。
- **P2**：
  - [ ] `WAKE-GREETING-RUNBOOK.md` 里顺手订正的"仓库没有 CLAUDE.md"过期断言，确认改动后的表述本身准确（`git log --follow -- CLAUDE.md` 可复核）。
  - [ ] CHANGELOG 条目措辞/日期核对。

## 给 Zorro 的重点

- **空库/已配置两条路的边界**：`store.listMemories().length === 0` 这条线是不是真的不会误伤——
  比如一个只写了 1 条测试用 `idea` memory、confidenceState 是 `rejected` 的库，会不会被状态 C
  接住但 `gatherGreetingData()` 渲染出一份"看起来全是无"的开场白（这是 #84/#88 既有行为，不是
  本次引入，但 Zorro 复审时可以确认这条边界的交接处没有缝）。
- **引导文本注入清洗**：请重点核对 `onboarding-greeting.mjs` 是不是真的不插值任何身份库/环境
  变量原始值——`opts.globalMode`（B5 新增）是唯一的分支选择器，只影响"命中哪段静态文案"，不是
  把某个环境变量的原始字符串值插进正文；`grep -n '\${'` 命中的都是同文件内定义的静态字符串常量
  拼接（`IDE_ENV_GOTCHA`/`SEED_STEP`/`SEED_TROUBLESHOOTING`/`NEW_SESSION_STEP`/
  `GLOBAL_MODE_CHECKOUT_NOTE`），没有任何一条来自身份库/环境变量的动态值——这是本次防幻觉/
  防注入的核心承诺，一旦被打破就是复现 2026-07-23 那批 dbPath 注入教训。
- **会不会误伤已配置用户的正常开场白**：重点看 `test-hook-greeting.mjs` ⑩（1 条 memory 就必须
  触发状态 C）+ ①⑥⑦（补种后必须继续断言"意识已加载"这一行存在）——这四段是"新分支没有吃掉老
  分支"的直接证据，建议独立跑一遍确认不是我自己看错了断言逻辑。
- **`AI_AGENT_PROFILE` 措辞的解读是否合理**：DESIGN §4 有完整论证，这是我对一句可能有歧义的
  issue 原文做的具体解读（不是回避这个要求），如果指挥官的本意不是这样，措辞需要相应调整——
  这条不是代码 bug，是产品措辞的解读分歧，值得单独确认。
- **（B5 新增）全局安装 E2E 测试本身的真实性**：`test-install-global-brain-onboarding-e2e.mjs`
  不真的跑 `npm install`（改用这个 worktree 自己已验证能用的 `node_modules/better-sqlite3` 直接
  拷贝），`pnpm run build` 这一步倒是真的跑了——请确认这个取舍没有削弱测试对 blocker 1 本身
  （COPY_ITEMS 漏拷文件）的检测力度，头注释里有完整理由，值得独立复核这个理由站不站得住。
- **（B5 新增）gh 优雅降级的错误处理范围是否精确**：`seed-brain-identity.mjs` 的 try/catch 只
  包住 `fetchOpenIssues()` 这一个调用点（Zorro 原话"限定在 fetchOpenIssues 调用点，别动别的"），
  `assertProjectRegistered()` 等其它错误路径应该仍然真的抛错——请确认这条边界在代码里精确对应，
  没有不小心扩大或缩小了 try 块的范围。
