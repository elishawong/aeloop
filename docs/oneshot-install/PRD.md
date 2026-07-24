# PRD — 一键安装 CLI(issue #95)

> 需求来源:[aeloop#95](https://github.com/elishawong/aeloop/issues/95)。轻量 PRD——机制已经在
> `docs/getting-started/README.md`(#108)讲透,本需求只是把已经跑通、已经过 Zorro 审的手动五步
> **收拢成一条幂等命令**,不引入新的产品概念,因此不单独出 DESIGN 节点。

## 1. 背景

`docs/getting-started/README.md` 已经把"从干净机器到能醒来"的手动五步讲清楚(依赖装 →
build → 全局装 → onboard-project → seed 身份库),但今天仍然要求使用者逐条手敲五条命令、
自己拼对顺序、自己判断每一步有没有成功。issue #95 要求把这五步收拢成**一条命令**,clone 完
就能跑,不改变五步本身的行为/顺序/产物——只是编排层。

## 2. 范围

**在这次范围内**:
- 一个新的编排脚本,原样调用(import 现有导出的函数,不复制/重写它们的逻辑):
  1. `pnpm install`
  2. `pnpm run build`
  3. `installGlobalBrain()`(`scripts/install-global-brain.mjs`)
  4. `onboardProject()`(`scripts/onboard-project.mjs`)
  5. `main()`(`scripts/seed-brain-identity.mjs`)
- 前置检查(Node 版本、pnpm 是否存在)+ 装完自检(better-sqlite3 原生模块能 load / 身份库可读
  非空 / SessionStart hook 已注册)。
- `docs/getting-started/README.md` 顶部加一键安装入口(手动五步保留,标注为 fallback)。
- 仓库根 `README.md` 加一条到 getting-started 的显眼安装入口(今天根 README 的"快速开始"讲的
  是 aeloop 引擎自身的开发者 quickstart——`pnpm install && pnpm test && pnpm build`——不是
  conductor-brain 层的"开箱醒来"这条链路,两者是不同的东西,必须分开说清楚,不能混着写成
  一节)。

**明确不做(指挥官 2026-07-24 拍板,不留作开放项,当它不存在)**:
- **不做"救护模式"/重装-修复子命令**。一键脚本只有"装"这一个动作;`installGlobalBrain()`/
  `onboardProject()`/seed 本身已经是幂等 upsert,重跑等价于"修复",不需要一个专门命名的
  救护/repair 模式,也不在本 PRD 里留开放项讨论要不要做。
- 不做一键卸载(`docs/getting-started/README.md` 已经把它标成"规划中",不是这次范围)。
- 不改 `install-global-brain.mjs`/`onboard-project.mjs`/`seed-brain-identity.mjs`/
  `db-path.mjs`/`task-source.mjs` 任何一行——这几个文件都已经过 Zorro 多轮复审(#93/#96/#98/
  #102/#103),本需求只是新增一层编排,零侵入。

## 3. 设计要点(已核实的真实行为,不是复述)

### 3.1 为什么选 `scripts/quickstart.mjs`(纯 node,零新增依赖)而不是 `install.sh`

- 仓库 `scripts/` 下已有 11 个 `.mjs` 编排脚本(`install-global-brain.mjs`/
  `onboard-project.mjs`/`seed-brain-identity.mjs`/`generate-version.mjs`/…),全部走同一套
  「导出纯函数 + `execImpl`/`homeDir`/`cwd` 依赖注入 + `if (import.meta.url === ...)` CLI 入口」
  风格,且都有对应的 `test-*.mjs`(用 `node:assert/strict`,不是 vitest——`vitest.config.ts`
  的 `include` 只扫 `src/**/*.test.ts`,`scripts/test-*.mjs` 是独立跑的,约定证据:跑
  `node scripts/test-install-global-brain.mjs` 等四个既有文件全部 `PASS`,实测见 progress.md)。
  用同一门语言、同一套约定写 wrapper,能直接 `import` 现有导出函数(`installGlobalBrain`/
  `onboardProject`/seed 的 `main`),不需要再拼一层 shell 参数转译;`install.sh` 则要么重新
  用 shell 拼一遍这几个脚本的调用序列(重复一份逻辑、容易和 `.mjs` 实现漂移),要么本质上也只是
  `exec node quickstart.mjs`的一层壳,没有实质收益。
- 跨平台:仓库 `package.json` `engines.node` 要求 `>=24`,Windows 用户跑 `.sh` 需要 Git Bash/
  WSL,纯 `.mjs`(`node scripts/quickstart.mjs`)在有 Node 的地方天然跨平台。

### 3.2 五步怎么串起来(关键:db 路径怎么让 4/5 步找到 3 步装的那份全局库)

- 步骤 3(`installGlobalBrain()`)把身份库固定装在
  `<homeDir>/.claude/aeloop-brain/data/identity.db`(`db-path.mjs` 的
  `globalDefaultDbPath(homeDir)`,已核实为导出函数)。
- 步骤 4/5 各自默认的 dbPath 解析逻辑(`onboardProject()` 默认 `resolveDbPath =
  resolveIdentityDbPath`;seed 的 `main()` 内部固定调 `resolveIdentityDbPath({ cwd })`,**不支持
  传入 `homeDir` 覆盖**——已读源码确认,`seed-brain-identity.mjs` 的 `main(opts)` 签名里没有
  `homeDir` 字段)都遵循同一条优先级:**环境变量 `AELOOP_BRAIN_IDENTITY_DB` 最高优先**,其次才
  是 `AELOOP_BRAIN_GLOBAL_MODE=1`(走 `os.homedir()` 真实主目录,不接受注入)。
- 因为 seed 的 `main()` 没有 `homeDir` 注入口子,**只设 `AELOOP_BRAIN_GLOBAL_MODE=1` 在自测用
  `--target=<临时目录>` 场景下会失效**(会去解析真实 `os.homedir()`,违反"绝不碰真实
  `~/.claude/`"的安全约束)。本脚本因此**同时**设置两个环境变量:
  `AELOOP_BRAIN_GLOBAL_MODE=1`(让 `resolveTaskSource()` 在没显式传 `--task-source` 时锁定
  默认值 `"none"`,不去读任何 `<cwd>/.claude/brain.local.json` 的 `taskSource` 字段,物理上
  保证"shipped 默认零 GitHub")+ `AELOOP_BRAIN_IDENTITY_DB=<globalDefaultDbPath(homeDir)>`
  (不管 `homeDir` 是真实主目录还是自测用的临时目录,步骤 4/5 都会精确落到步骤 3 装的那份库,
  且这条路径本身优先级最高,物理上不依赖 `os.homedir()` 是否等于步骤 3 用的 `homeDir`)。
  两者都设不冲突:`resolveIdentityDbPath()` 先查 `AELOOP_BRAIN_IDENTITY_DB`,命中即返回,根本
  不会走到 `AELOOP_BRAIN_GLOBAL_MODE` 分支;这个环境变量只在 `runQuickstart()` 执行期间临时
  设置,`finally` 里恢复成调用前的值,不污染宿主进程/后续代码。
- 一键脚本本身**不修改** `onboard-project.mjs`/`seed-brain-identity.mjs` 任何一行去支持
  `homeDir` 注入——这样改会扩大对两个已过 Zorro 审的文件的改动面;改用"设对环境变量"这个已有的
  最高优先级配置口子达到同样效果,零侵入。

### 3.3 `--task-source=github` 怎么透传

- 透传给 `installGlobalBrain({ taskSource: "github" })`(烘焙进真实 hook 的 `AELOOP_BRAIN_
  TASK_SOURCE=github` 前缀,供*未来*会话使用);
- 同时设 `process.env.AELOOP_BRAIN_TASK_SOURCE = "github"`(供*这次*跑 seed 时的
  `resolveTaskSource()` 命中,触发第③类"在途任务"seed,此时需要 `gh` 已登录——不是本脚本新增
  的前置,是 seed 脚本本来就有的行为,只在显式 opt-in 时才涉及)。
- 省略 `--task-source` 时两者都不设,`resolveTaskSource()` 落到 `AELOOP_BRAIN_GLOBAL_MODE=1`
  分支的默认值 `"none"`——**shipped 默认零 GitHub**,`gh` 不是必需前置(issue #103 已定盘的
  约束,本次不改变,只是复用)。

### 3.4 幂等性从哪来(不是本脚本自己发明的)

`installGlobalBrain()`/`onboardProject()`/seed 的 `main()` 三者本身都已经是幂等实现(原子换入
+ 按标记子串识别重复 hook 条目 / `upsertMemory` 按 `(type,title)` 或 `matchTag` 匹配已有记录)。
`quickstart.mjs` 只是按顺序调用它们,不额外发明一层"这次装过没有"的状态文件——重复跑的安全性
完全继承自这三个已经被测试覆盖、被 Zorro 审过的函数本身。**验收标准里"跑两次不炸"验证的正是
这条继承关系**,不是给 `quickstart.mjs` 自己新写一套幂等判断。

### 3.5 自检覆盖到"真的会被 SessionStart 用到的那份代码"

自检不读本地 `dist/`(那是给 4/5 两步用的开发态产物),而是动态 `import()` 换入后的
**快照**里的 `store.js`(`<snapshotDir>/dist/context/store.js`,用它自己目录下的
`node_modules/better-sqlite3`)去开真实装好的身份库、跑 `listMemories()`——这条路径和真实
`SessionStart` hook 运行时加载的代码/原生模块**是同一份**,比"检查本地 repo 的 dist 能不能跑"
更贴近"用户实际会不会看到开场白"这个问题。同时检查 `settings.json` 里确实有一条
command 含 `AELOOP_BRAIN_MARKER`(复用 `install-global-brain.mjs` 已导出的同一个常量,不
自己另写一份字面量)的 `SessionStart` 条目。

## 4. 逐文件任务清单(单批次 B0,改动小,不需要拆多批)

| # | 文件 | 改动 |
|---|---|---|
| 1 | `scripts/quickstart.mjs`(新增) | 一键安装脚本本体:`preflight()`(Node 版本 + pnpm 存在性)→ `verifyBetterSqlite3Loads()`(pnpm install 后立即校验原生模块,早失败早诊断)→ `pnpm run build` → `installGlobalBrain()` → `onboardProject()` + seed `main()`(同临时环境变量方案,见 §3.2/§3.3)→ `verifyInstall()`(自检:hook 已注册 / 原生模块能 load / 身份库可读非空)。全部关键步骤(`repoRoot`/`homeDir`/`execImpl`/`installGlobalBrainImpl`/`onboardProjectImpl`/`seedBrainIdentityImpl`)可依赖注入,供单测不碰真实系统。CLI 支持 `--dry-run`、`--task-source=github`、`--target=<dir>`(测试/高级用途,覆盖 `homeDir`,日常安装不用)、`--repo-path=<dir>`(默认等于脚本自己所在仓库根,一般不用传)。 |
| 2 | `scripts/test-quickstart.mjs`(新增) | 单测:沿用仓库既有 `test-*.mjs` 风格(`node:assert/strict`,不进 vitest)。覆盖:preflight 拒绝低版本 Node / 拒绝 pnpm 不存在;`--dry-run` 不触发任何 side-effecting `execImpl` 调用;正常路径下五步按序调用、`AELOOP_BRAIN_IDENTITY_DB`/`AELOOP_BRAIN_GLOBAL_MODE`/`AELOOP_BRAIN_TASK_SOURCE` 在 `finally` 里被还原成调用前的值(不泄漏进宿主进程);`--task-source=github` 时两处透传都命中。全部用注入的假 `execImpl`/`installGlobalBrainImpl` 等,不碰真实 pnpm/网络/文件系统之外的临时目录。 |
| 3 | `docs/getting-started/README.md` | 顶部加「一键安装」小节:`node scripts/quickstart.mjs`(一条命令跑完五步 + 自检),把原有「一键化(规划中)」那节的规划描述改成指向已落地的脚本(不再是"规划中")。「醒来那一刻发生什么」/「已知坑」两节维持不变;新增一条 #106 caveat(见 §3.6 措辞)。 |
| 4 | `README.md`(仓库根) | 在「快速开始」附近加一条独立小节/链接:「conductor-brain 层(开箱醒来)安装见 [`docs/getting-started/README.md`](./docs/getting-started/README.md)」——不和现有"快速开始"(讲的是 aeloop 引擎自身的开发者 quickstart)混在一节,避免读者把两件不同的事看成同一件事。 |
| 5 | `package.json` | `scripts` 段加一条 `"quickstart": "node scripts/quickstart.mjs"` 便捷别名(可选,`pnpm run quickstart`)。主文档一律推荐 `node scripts/quickstart.mjs`(不依赖 pnpm 已经能跑起来这个前提——脚本自己的 preflight 才是检查 pnpm 是否存在的地方)。 |
| 6 | `docs/oneshot-install/PRD.md`(本文件)/ `progress.md` / `impact.md` | 文档留痕。 |

## 5. #106 caveat 措辞(诚实标注,不打包票)

`docs/getting-started/README.md`「已知坑与注意」表已有一行「IDE 扩展环境下 hook 可能不触发…
(追踪中)」——一键安装脚本跑完打印的「下一步」提示复用**同一措辞基调**:

> 下一步:开一个新的 Claude Code **终端 CLI** 会话(在任意项目目录都可以),第一行应该出现
> "意识已加载"。目前这条路径**在 CLI 会话里已确认生效**;IDE 扩展环境下 SessionStart hook 的
> 触发性正在核实中(aeloop#106),如果你在 IDE 里没看到开场白,先在纯终端 CLI 里确认机制本身
> 生效,不代表安装失败。

不写"打开任意会话就会醒来"这种一刀切承诺。

## 6. 验收标准

1. `pnpm install && pnpm build && pnpm test` 全绿(不因新增文件破坏既有测试)。
2. `node scripts/test-quickstart.mjs` 全部 assertion `PASS`(zero 真实系统副作用)。
3. 真跑一次 `node scripts/quickstart.mjs --target=<临时目录>`(不碰真实 `~/.claude/`):
   - 进程 exit 0;
   - 打印的自检结果三项全部为真(hook 已注册 / better-sqlite3 能 load / 身份库可读且
     `memoryCount > 0`);
   - `<临时目录>/.claude/settings.json` 里能看到一条含 `AELOOP_BRAIN_MARKER` 的
     `SessionStart` 条目。
4. 对同一个 `--target=<临时目录>` **再跑一次**:进程仍然 exit 0,不重复累加 `SessionStart`
   条目(仍是 1 条),身份/宪法约束记录数不因重跑而翻倍(`upsertMemory` 的 unchanged 语义)。
5. `git diff --stat -- src/` 为空(本需求不改任何引擎源码)。
6. `docs/getting-started/README.md` 顶部能看到一键安装入口;仓库根 `README.md` 能看到指向
   `docs/getting-started/` 的安装链接。

## 7. 开放项

无("救护模式"已被指挥官明确拍板不做,不作为开放项列出;见 §2「明确不做」)。
