# Progress — 一键安装 CLI(issue #95)

## B0(单批次,已完成)

- [x] `scripts/quickstart.mjs` —— preflight(Node 版本 + pnpm)→ pnpm install →
      `verifyBetterSqlite3Loads` → pnpm run build → `installGlobalBrain()` →
      （临时环境变量方案)`onboardProject()` + seed `main()` → `verifyInstall()` 自检。
      支持 `--dry-run`/`--task-source=github`/`--target=<dir>`/`--repo-path=<dir>`/`--help`。
- [x] `scripts/test-quickstart.mjs` —— 12 组 assertion,全部 `PASS`(node:assert/strict 风格,
      与仓库既有 `test-*.mjs` 一致)。
- [x] `docs/getting-started/README.md` 更新(零、一键安装 + #106 caveat + 一键化章节改写)。
- [x] `README.md`(根)更新(新增「安装」小节 + 「快速开始」改名区分)。
- [x] `package.json` 加 `"quickstart": "node scripts/quickstart.mjs"`。
- [x] 自测:`pnpm install && pnpm build && pnpm test` —— 58 测试文件 / 634 测试全绿。
- [x] 自测:`node scripts/test-quickstart.mjs` —— 全部 `PASS`。
- [x] 自测:既有四个 `test-*.mjs`(install-global-brain / install-global-brain-onboarding-e2e /
      onboard-project / seed-brain-identity)重跑确认未被本次改动波及,全部 `PASS`。
- [x] 自测:真跑 `node scripts/quickstart.mjs --target=<临时目录>` —— exit 0,自检三项全 OK
      （hook 已注册 / better-sqlite3 能 load / 身份库可读 9 条记忆）。
- [x] 自测:同一 `--target` 再跑一次(幂等)—— exit 0,`SessionStart` 条目仍 1 条,
      `onboard-project`/身份/宪法约束全部 `unchanged`。
- [x] 自测:`node scripts/quickstart.mjs --dry-run`(对真实 `$HOME`)—— 人工确认跑前后
      `~/.claude/aeloop-brain` 不存在、`~/.claude/settings.json` 不含 `aeloop-brain` 字样,
      零真实写入。
- [x] `git diff --stat -- src/` —— 空(未改任何引擎源码)。
- [x] `impact.md`。

## R1(Zorro/Codex 独立复审 FAIL → 返工,已完成)

复审判 FAIL,2 个 blocker,都已复现、修复、补回归:

- **B1**(`quickstart.mjs` 第 4/5 步env 设置处):省略 `--task-source` 时初版只在 opt-in 分支赋值
  `AELOOP_BRAIN_TASK_SOURCE`,没清空——宿主 shell 若 ambient export 过 `=github`,会原样透传进
  seed,击穿 issue #103「shipped 默认零 GitHub」保证。**修法**:补 `else delete
  process.env.AELOOP_BRAIN_TASK_SOURCE`。**回归**:单测(ambient=github + 省略 flag → seed 执行期间
  看到 `undefined`)+ 真实端到端复现(`AELOOP_BRAIN_TASK_SOURCE=github node scripts/quickstart.mjs
  --target=<临时目录>`,不带 `--task-source`,确认输出「在途任务同步已跳过」)。
- **B2**(CLI 入口守卫):`import.meta.url === \`file://${process.argv[1]}\`` 路径含空格时因编码
  不一致恒为 false,静默 no-op exit 0。**修法**:改用 `pathToFileURL(realpathSync(process.argv[1]))
  .href`。**修复过程中额外发现同一行代码的第二个独立根因**(不是 Zorro 报告里点出的,是补回归
  测试时用真实 spawn 复现出来的):`import.meta.url` 经 Node realpath 解析、`process.argv[1]` 不
  解析符号链接,macOS `/tmp`/`os.tmpdir()` 本身是指向 `/private/...` 的符号链接,只加
  `pathToFileURL` 不处理符号链接仍会失效——一并加 `realpathSync()` 才是完整修法(已在真实临时
  目录、真实 `--help` spawn 上验证)。**回归**:真实复制 quickstart.mjs + 它静态 import 的 8 个
  本地文件(不含 node_modules/dist 依赖)到一个路径含空格的临时目录,真实 `spawnSync` 跑
  `--help`,断言 stdout 含用法文案 + exit 0。

**建议级(已顺手折,非 blocker)**:
- `verifyInstall()` 的 `ok` 显式纳入 `errors.length === 0`(此前功能等价但要"细看每条分支"才能
  看出,不是判断式本身能证明)。
- `hookRegistered` 除了匹配 command 字符串,新增 `existsSync(hookEntryPath)`——settings.json 里
  写着看似正确的 command 但快照文件其实不存在时,不再误判成"已注册"。
- 修正 `--dry-run` 日志措辞(区分"前置检查已跑过"和"以下有副作用的步骤不会跑")+
  `test-quickstart.mjs` 头注释措辞(不再说"零依赖",改成"不需要网络/pnpm/npm,但最后一条用例真实
  加载本 worktree 的 better-sqlite3")。

**回归后自测**:`pnpm build && pnpm test`(58/634 全绿)+ 全部 7 个 `scripts/test-*.mjs` 全 PASS
(含新增的 B1/B2 回归)+ 真实端到端 fresh install(ambient `AELOOP_BRAIN_TASK_SOURCE=github` +
省略 flag → 正确跳过)+ 幂等复跑(9 条记忆不变,`SessionStart` 仍 1 条)+
`git diff --stat -- src/` 仍为空。

## R2(Zorro/Codex 独立复审 R2 = FAIL → 返工,已完成)

R1 修复的 B1/B2 都确认修对,但 B2 的修法(`realpathSync(process.argv[1])`)本身**引入一个新
blocker**,Codex 独立指出、Zorro 复现:

- **B3**(CLI 入口守卫在模块顶层无条件 `realpathSync(process.argv[1])`):`argv[1]` 缺失
  (`node -e`/REPL/部分 preload 场景)时 `realpathSync(undefined)` 直接抛 `ENOENT`,**整个模块
  `import` 失败**,连导出的 `runQuickstart`/`verifyInstall` 等函数都拿不到——R1 之前的旧写法
  在这种场景下不抛错,是这轮修法意外收紧的行为,且当时没测到 `node -e` import 路径。**修法**:
  `let isCliEntry = false; if (process.argv[1]) { try {...} catch { isCliEntry = false; } }`,
  两种"判不出是不是 CLI 入口"的情况(argv[1] 缺失 / realpath 解析失败)都归一成"不是 CLI 入口",
  不让 import 本身失败。**回归**:真实 `spawnSync` 跑
  `node --input-type=module -e "import('./scripts/quickstart.mjs')"`,断言 import 成功且
  `runQuickstart` 可用。

**🟡 顺带折了的两条(非 blocker,Zorro 建议"能捎就捎")**:
1. `--preserve-symlinks-main` 边角——只加了知会性注释(该 flag 下 CLI 可能静默 no-op,不会重新
   触发 B3 那种 import 失败,极冷门,不追加代码修复)。
2. `hookRegistered` 判据收紧——原来分别检查"command 含泛化的 `AELOOP_BRAIN_MARKER` 子串"和
   "`hookEntryPath` 存在"两个互相独立的条件,理论上会各自为真却对不上号而误判。改成直接匹配
   "command 是否包含这次 homeDir 算出来的完整 `hookEntryPath`"(比泛化标记更具体)+ 用
   `statSync(...).isFile()` 排除目录。移除因此变成死代码的 `AELOOP_BRAIN_MARKER` import。

**回归后自测**:`pnpm build && pnpm test`(58/634 全绿)+ 全部 7 个 `scripts/test-*.mjs` 全 PASS
(含新增的 B3 回归)+ 真实端到端 fresh install + 幂等复跑(9 条记忆不变,exit 0 两次)+
`git diff --stat -- src/` 仍为空。

## 观察(已记入 impact.md,不在本次范围内处理)

1. 全局安装快照 `package.json` 缺 `"type":"module"` 导致跑自检时 Node 打一条
   `MODULE_TYPELESS_PACKAGE_JSON` 警告(不影响功能,exit 0)——`install-global-brain.mjs` 自己
   的既有行为,本次范围内不能碰该文件。
2. 在 aeloop 仓库自身内验证时,项目级 dogfood `.claude/settings.json` 和新装的全局
   `~/.claude/settings.json` hook 会同时存在——建议在**另一个**项目目录里开新会话验证效果。

## 交给 Zorro

- PRD: `docs/oneshot-install/PRD.md`
- 脚本: `scripts/quickstart.mjs` + `scripts/test-quickstart.mjs`
- 文档改动: `docs/getting-started/README.md` / `README.md` / `package.json`
- 未 commit,等 Zorro PASS + 指挥官批。
