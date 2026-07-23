# PRD — 首次醒来身份库为空时走交互式引导（issue #96）

- **项目**: aeloop
- **依赖**: #93（已 CLOSED）、#84/#88（醒来开场白/turnkey 包本体）
- **设计权威**: `docs/first-wake-onboarding/DESIGN.md`（本 PRD 的三态判定/候选方案对比/注入安全
  选择/`AI_AGENT_PROFILE` 边界澄清，均在那份文档定盘，本文档不重复论证，只列怎么落地）
- **状态**: 实现完成，本地自测全绿，待 Zorro 独立复审 + 指挥官确认（含 `DESIGN.md` §4 标注的
  `AI_AGENT_PROFILE` 措辞解读待确认点）

---

## 1. 范围

**做什么**：`brain-wake-greeting.mjs`（SessionStart hook）新增两条分支——身份库"未配置"
（状态 A）和"已配置但空"（状态 B，`listMemories().length === 0`）——命中时不再彻底沉默/渲染
诚实占位符开场白，改为注入一段"引导脚本"，指示模型带用户走一遍配置问答，而不是逐字复述。状态
C（已有真实数据）**零改动**，走既有 #84/#88/#93 全部逻辑。

**不做什么**（DESIGN §2 已列非目标，这里重复一次防止实现时范围膨胀）：
- 不新建 `aeloop init` 交互式 CLI。
- 不做"跳过一次不再提醒"的抑制开关。
- 不给引导文案加版本行（`resolveVersionLine()`）。
- 不修 #102（better-sqlite3 native binding）本身，只在文案里带一句已知 troubleshooting。
- 不改 `resolveIdentityDbPath()`/`greeting-data.mjs`/`render-greeting.mjs`/`wake.mjs` 任何一行
  （状态 C 路径完全复用现有实现，`src/**` 零改动）。

---

## 2. 逐文件任务清单

| 文件 | 改动 | 依赖 |
|---|---|---|
| `docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs`（**新建**） | 两个函数：`renderOnboardingNotConfigured()`（状态 A 正文，零参数）、`renderOnboardingEmptyStore(opts)`（状态 B 正文，`opts.globalMode` 可选，默认读真实 `AELOOP_BRAIN_GLOBAL_MODE` 环境变量——这不是身份库/环境变量数据插值，是静态文案的分支选择器，见 DESIGN §5/二签修复记录）。**不插值任何身份库/环境变量原始值**（dbPath 本身不放进正文），不需要 `sanitizeText()`（没有那类插值面）；模块头注释写清楚"为什么不插值 dbPath"+"未来如果要插值必须过 sanitizeText()"这条护栏，呼应 `render-greeting.mjs` 同类头注释的写法。两段正文都必须：① 不出现"意识已加载"字样 ② 明确说"这不是正常醒来/不要假装有身份" ③ 覆盖 seed 脚本 + #102 troubleshooting + 项目注册坑 ④ 独立小节提一句 `AI_AGENT_PROFILE`（DESIGN §4 采纳的"推荐路径"措辞，不断言当前默认值）。**订正（Zorro/Codex 跨模型二签 2026-07-23 FAIL 后发现的实现-PRD 契约冲突）**：DESIGN §0 列的"配置方式二选一 + IDE 不继承 env 的坑"这两条**只属于状态 A**——状态 B 触发时路径已经配好了，正文不应该重复"怎么选路径"这一步（`test-onboarding-greeting.mjs` ⑤ 反向断言状态 B 不含 launchctl/二选一字样，这是刻意的产品选择，不是实现漏做了 PRD 要求的覆盖面，本条是给这份 PRD 本身订正措辞，不是改代码）。 | 无 |
| `docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs`（**新建**） | 单元测试上面两个函数：内容断言（覆盖 DESIGN §0 四个坑各至少一条关键字命中）+ 反向断言（不含"意识已加载"）+ 纯度断言（同一份入参多次调用输出完全一致，证明没有隐藏的时间戳/随机性/环境依赖） | onboarding-greeting.mjs |
| `.claude/hooks/brain-wake-greeting.mjs`（**修改**） | `resolveIdentityDbPath()` 返回后新增判断：`null` → 状态 A；非空则 `openIdentityStore(dbPath)` 后 `store.listMemories().length === 0` → 状态 B（判空前的 `listMemories()` 调用本身包 `try/catch`，抛错先关 store 再重新抛出；判定为空后再显式 `store.close()`——**不是**统一套一层 `finally`，见 §5 表格"store 未在 catch 里关"一行的详细订正）；否则原逻辑不变（状态 C）。状态 A/B 各自：动态 import `onboarding-greeting.mjs`，取对应正文，包一层"这是引导脚本不是逐字复述"的元指令（区别于现有"请原样复述"那段包装），`emitAdditionalContext()`。stderr 诊断行相应调整（状态 A：`[brain-wake-greeting] 身份库未配置，已注入首次引导`；状态 B：延续现有 `已连上身份库：${dbPath}` 后加一句 `（当前为空，已注入首次引导脚本）`，保持 `已连上身份库` 这个既有子串不变，不破坏依赖它的既有测试断言）。头注释"配置"一节补充说明这条新分支的存在 + 指回 `docs/first-wake-onboarding/DESIGN.md`。**必须保持"绝不阻断"红线**：新增逻辑一样要在现有 `main().catch()` 兜底范围内，任何异常仍然吞掉、`exit 0`、不打印任何东西——不能让"检测空库"这个新增的 `store.listMemories()` 调用本身出错时打破这条既有承诺。 | onboarding-greeting.mjs |
| `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（**修改**） | ① 段：`injectedDir` 建好后，在 spawn 前先用 `openIdentityStore` 插入一条真实 `confirmed` memory（如 `identity:name`），确保这个测试继续测的是"正常开场白路径下 dbPath 注入不了假内容"，不被新的状态 B 分支污染——更新头注释说明为什么现在需要补种数据。⑥/⑦ 段同理：`dbPath6`/`dbPath7` 对应的 store spawn 前各插入一条真实 memory，保持这两段测试原本要测的东西（版本行/dist 缺失 fail-soft）不被状态 B 分支污染，更新对应注释。**新增**两段端到端测试：⑧ 状态 A——`spawnSync` 时 `cwd` 指向一个全新临时目录（无 `.claude/brain.local.json`）、`env` 里删掉 `AELOOP_BRAIN_IDENTITY_DB`/`AELOOP_BRAIN_GLOBAL_MODE`，断言 `additionalContext` 不含"意识已加载"、含引导脚本的关键内容（如"launchctl"/"brain.local.json"/"seed-brain-identity"）、`exit 0`；⑨ 状态 B——全新空 dbPath（不插入任何 memory），断言同上（不含"意识已加载"，含 seed 脚本指引 + #102 提示关键字）；⑩ 回归——状态 C（已有 ⑤ 段的两条真实 active_task 场景）继续断言含"意识已加载"，证明"有数据 → 正常路径"这条红线没有被新分支误伤。 | onboarding-greeting.mjs、brain-wake-greeting.mjs |
| `.claude/settings.json`（**修改**） | `$comment` 更新："`AELOOP_BRAIN_IDENTITY_DB` 未设置时安静跳过……零副作用"这句不再准确，改写为如实描述状态 A/B 会注入引导脚本，指向 `docs/first-wake-onboarding/DESIGN.md` | brain-wake-greeting.mjs 落地后同步 |
| `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`（**修改**） | "让'你好' → 开场白 真的跑起来"一节末尾"安全默认：……零副作用"一句改写为准确描述；新增一小节"首次醒来引导（issue #96）"，简述状态 A/B 会得到什么、指回 `docs/first-wake-onboarding/DESIGN.md`/`PRD.md`，不重复展开 | 同上 |
| `docs/conductor-brain-layer/BRAIN.md`（**修改**） | "2. 醒来协议"一节补一句：身份库未配置/为空时，这段开场白格式不适用，会先走一段引导脚本（不点名具体步骤，指回 RUNBOOK），保持这份文档本身简洁（它是整段注入进上下文的宪法正文，不适合塞太多细节） | 同上 |
| `CHANGELOG.md`（**修改**） | `[Unreleased]` 新增一条，日期 2026-07-23，简述本次改动 | 全部落地后 |
| `docs/first-wake-onboarding/progress.md`（**新建**） | 实现过程中的批次记录 + 自测结果，随实现推进更新 | — |
| `docs/first-wake-onboarding/impact.md`（**新建**） | 完成后补：影响范围、测试建议、P0/P1/P2 回归清单 | 全部批次完成后 |

---

## 3. 批次拆分

- **B0**（无依赖）：`onboarding-greeting.mjs` + `test-onboarding-greeting.mjs`——先把两段引导正文
  的内容和纯度锁定，独立可测，不涉及 hook 集成。
- **B1**（依赖 B0）：`brain-wake-greeting.mjs` 三态检测 + 注入分支。
- **B2**（依赖 B1）：`test-hook-greeting.mjs` 更新既有 3 处用例 + 新增 3 处端到端用例——必须在
  B1 落地后才能跑，因为要真实 spawn 修改后的 hook。
- **B3**（依赖 B2 全绿）：文档同步——`.claude/settings.json` `$comment`、`WAKE-GREETING-RUNBOOK.md`、
  `BRAIN.md`、`CHANGELOG.md`。
- **B4**（依赖 B0-B3）：`progress.md`/`impact.md` 收尾。

---

## 4. 验收标准（可勾选，全部已在实现阶段真实验证，证据见 `progress.md`）

- [x] `pnpm test`（vitest，`src/**`）全绿（634/634），且 `git diff --stat` 确认 diff 不触碰
      `src/**` 任何一行——零回归的字面证明。
- [x] `pnpm run build` 成功（`dist/` 刷新，含 `version-info.generated.js`）。
- [x] `node docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs` 全部 `PASS`（7 组）。
- [x] `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 全部 `PASS`（含更新过的 ①⑥⑦
      三段 + 新增的 ⑧⑨⑩ 三段）。
- [x] 回归：`test-greeting.mjs`/`test-wake.mjs`/`test-status-table.mjs`/`test-version-info.mjs`/
      `test-three-state-gate.mjs`/`test-translator.mjs`/`.claude/hooks/lib/test-db-path.mjs`/
      `test-git-remote.mjs`/`test-command-match.mjs`/`test-brain-lock.mjs`/
      `.claude/hooks/test-brain-{commit-gate,isolation-guard,issue-gate,red-line-guard}.mjs`/
      `scripts/test-{dispatch-brain-task,generate-version,install-global-brain,onboard-project,
      seed-brain-identity}.mjs` 全部 `PASS`（比原计划的 3 个更全，逐个手跑核实零回归）。
- [x] 端到端自验①：真造一个完全没配置的环境（`cwd` 指向不含 `.claude/brain.local.json` 的全新
      临时目录，env 剔除 `AELOOP_BRAIN_IDENTITY_DB`/`AELOOP_BRAIN_GLOBAL_MODE`），手动
      `node .claude/hooks/brain-wake-greeting.mjs` 喂真实 stdin payload，输出是引导脚本、不含
      "意识已加载"、`exit 0`。
- [x] 端到端自验②：真造一个配置了路径但从未 seed 的空库，同样手动跑 hook，输出是状态 B 版本的
      引导脚本（提到"已经配置了路径"），`exit 0`。
- [x] 端到端自验③（比原计划更完整——真的走完整条链路，不只是复用已有种子数据）：对②同一个空库
      先跑 `scripts/onboard-project.mjs --repo-path` + `scripts/seed-brain-identity.mjs`（真实
      写入身份 + 7 条宪法约束 + 53 条 issue），再重新跑 hook，输出变回完整的"意识已加载"开场白
      （含"现在在途"真实表格），证明"引导 → 照做 → 下次醒来变正常"这条闭环端到端跑通。
- [x] 引导文案不含任何**身份库/环境变量数据**的插值——`grep -n '\${'` 在两个导出函数体内确实有
      命中，但命中的全部是同文件内定义的静态字符串常量（`IDE_ENV_GOTCHA`/`SEED_STEP`/
      `SEED_TROUBLESHOOTING`/`NEW_SESSION_STEP`，供多处复用，不是身份库/env 数据），不是最初
      验收标准字面写的"零命中"——如实订正这条验收标准的措辞，实质承诺（不插值身份库/环境变量
      数据、因此不需要 `sanitizeText()`）成立。
- [x] `.claude/settings.json`/`WAKE-GREETING-RUNBOOK.md` 不再包含"未配置时安静跳过、零副作用"这类
      现在不准确的措辞（同时顺手订正了 RUNBOOK 里一处更早就已过期的"仓库没有 CLAUDE.md"断言）。
- [x]（B5 新增）`pnpm lint`（`tsc --noEmit`）干净，零错误。
- [x]（B5 新增）`node scripts/test-install-global-brain-onboarding-e2e.mjs` 全部 `PASS`——真实
      安装到临时 `--target`、从无关项目 cwd + 空全局库真实 spawn 换入后的 hook，产出真实引导
      文本；已验证过"删掉 `COPY_ITEMS` 里 `onboarding-greeting.mjs` 那一条 → 这个测试真的会
      失败"，不是摆设断言。
- [x]（B5 新增）`node scripts/test-seed-brain-identity.mjs` 新增 ⑧ 全部 `PASS`——`gh` 调用失败
      时优雅降级（`skippedIssueSync` + `issues:[]` + `exit 0`），身份/宪法约束不受影响。
- [x]（B5 新增）`CLAUDE.md`「醒来」段三态 carve-out 已补齐，和 `BRAIN.md` 表述一致。

---

## 5. Zorro/Codex 跨模型二签 FAIL 修复记录（2026-07-23，第一轮实现之后）

第一轮实现交出后，Zorro 调 Codex（gpt-5.6-sol，真跑 exit0 + attestation 落盘）独立复审，判
**FAIL**：本地核心逻辑（三态判定 + 注入安全）独立复现全绿，FAIL 集中在全局安装打包 + 宪法/PRD
文档一致性。逐条修复记录（不改第 1-4 节的原始决策记录，作为独立追加小节，保留"当时哪里想得不
够"这个事实，不事后美化成一次就对）：

| 问题 | 根因 | 修法 | 新增/修改文件 |
|---|---|---|---|
| 🔴 blocker 1：全局安装漏拷 `onboarding-greeting.mjs` | `scripts/install-global-brain.mjs` 的 `COPY_ITEMS` 拷了 wake/greeting-data/render-greeting/status-table/sanitize/version-info，唯独漏了这次新增的 `onboarding-greeting.mjs`——同文件 line 59-61 给 `version-info.mjs` 记过一模一样的坑（"不在清单里会 MODULE_NOT_FOUND"），这次没照做，属于知道模式却没套用到新文件上 | ① 补进 `COPY_ITEMS` ② 新增真实 E2E（不是 fixture 单测）：真装到临时 `--target`，从无关项目 cwd + 空全局 DB 真实 spawn 换入后的 hook，断言产出真实引导文本（非 MODULE_NOT_FOUND、stdout 非空）——已验证过"删掉 COPY_ITEMS 那一条 → 这个新测试真的会失败"，不是摆设 ③ 想清楚全局模式下 cwd-relative 路径的可达性问题（见下一行） | `scripts/install-global-brain.mjs`（COPY_ITEMS）、`scripts/test-install-global-brain-onboarding-e2e.mjs`（新建） |
| 🔴 blocker 1 附带发现：引导正文里的 `node scripts/...` 在全局模式下不可达 | `~/.claude/aeloop-brain/repo-snapshot/` 这份运行时快照从未打算含 `scripts/seed-brain-identity.mjs`/`scripts/onboard-project.mjs`（那两个脚本各自还要拉一串 `.claude/hooks/lib/*` 依赖，硬塞进"快照"这个概念会失真）——引导正文如果写死相对路径，全局模式下从无关项目 cwd 触发时这些命令根本无法执行 | `renderOnboardingEmptyStore()` 新增 `opts.globalMode` 分支（默认读真实 `AELOOP_BRAIN_GLOBAL_MODE` 环境变量）：全局模式下明确提示"需要一份真实 aeloop 源码 checkout（不是运行时快照），命令带 `AELOOP_BRAIN_GLOBAL_MODE=1` 前缀"；`renderOnboardingNotConfigured()` 不需要同样处理——状态 A 物理上只可能在非全局模式触发（全局模式 dbPath 恒非 null），DESIGN §3 已定盘 | `onboarding-greeting.mjs`、`test-onboarding-greeting.mjs`（新增 ⑧） |
| 🔴 blocker 2：常驻 `CLAUDE.md`「醒来」段和 A/B 引导互相矛盾 | `CLAUDE.md` 每会话静态装载，"醒来"一节无条件写"先原样复述"，没有 A/B 例外——三态 carve-out 只补进了 `BRAIN.md`（人读文档），PRD 原始任务清单只列了 settings/RUNBOOK/BRAIN/CHANGELOG 四份，漏了 `CLAUDE.md` 这份模型每次真的会读到的静态正文 | `CLAUDE.md`「醒来」段补三态分流措辞，和 `BRAIN.md` 已有的表述对齐 | `CLAUDE.md` |
| 🟡 gh 行为文案不实 + 优雅降级 | `seed-brain-identity.mjs` 的 `fetchOpenIssues()` 调用点原本没有任何错误处理——`gh` 缺失/未登录/调用失败会让 `main()` 整体拒绝、进程非零退出（哪怕身份+宪法约束途①②已经写完），但引导文案却写"没有 gh 也能跑，只是没 active_task"——指挥官真机实测撞到这个不一致 | 采纳"优雅降级"（不是仅改文案）：`fetchOpenIssues()` 调用点包 try/catch，失败时记 `skippedIssueSync`、`issues` 退化为空数组、`main()` 正常返回、exit 0；只改这一个调用点，不改 `assertProjectRegistered()` 等其它错误路径的语义。文案同步成新的真实行为 | `scripts/seed-brain-identity.mjs`、`scripts/test-seed-brain-identity.mjs`（新增 ⑧）、`onboarding-greeting.mjs`（`seedStep()` 措辞） |
| 🟡 PRD 与实现契约冲突 | 原 PRD §2 写"两段正文都必须覆盖 DESIGN §0 四个坑"，但状态 B 的实现（+ 对应测试）刻意省掉"配置方式二选一/IDE 不继承 env"这两条（路径已经配好，不该重复怎么选路径）——这是产品判断更对的选择，只是 PRD 原文没跟上 | 订正本文档 §2 对应表格行的措辞，明确"这两条只属于状态 A" | `PRD.md`（本文件） |
| 🟡 hook 头注释过期 | `brain-wake-greeting.mjs` 顶部"配置"一节仍写"两源都没有→安静跳过、本次未变"——这句话被 #96 本次改动整体推翻了，头注释没跟着更新 | 头注释同步（见下方"头注释同步"小节，独立于 main() 里那段已经更新过的"首次醒来引导"说明） | `.claude/hooks/brain-wake-greeting.mjs` |
| 🟡 store 未在 catch 里关 | 状态 B 分支手动 `store.close()` 后 `return`，中间 `store.listMemories()` 如果抛错则不经这行、store 不会被关闭——状态 C 分支有 `try/finally` 保护，空检测这条没有，是遗漏不是刻意的不对称 | `store.listMemories()` 包进 `try { … } catch (err) { store.close(); throw err; }`——**订正（Zorro/Codex 跨模型二签第二轮，2026-07-23）**：本行原写"包进 `try/finally`"，措辞不准确，实际实现用的是 `try/catch`（抛错时关闭并重新抛出），不是 `try/finally`；这里字面上**不能**用 `try/finally`——`listMemories()` 成功且 `memoriesCount >= 1`（状态 C）时 store 必须保持打开，交给后面 `gatherGreetingData()` 自己的 `try/finally` 关闭，一个无条件执行的 `finally` 会在成功路径上也把 store 提前关掉，反而破坏状态 C。代码选对了模式，是这份 PRD 当初描述错了，现已订正 | `.claude/hooks/brain-wake-greeting.mjs` |
| 🟡 `impact.md` 过度声明 | 称测试证明状态 C 开场白"逐字节不变"，但 ⑩ 只断言了两个子串存在，没做全量相等比对 | 降低措辞为"关键内容存在"，不再用"逐字节不变"这个更强的、测试实际没验证到的说法 | `impact.md` |

修复过程的完整测试证据（新一轮全绿）见本目录 `progress.md`「二签修复后自测证据」一节。
