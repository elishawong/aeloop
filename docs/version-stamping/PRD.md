# PRD — aeloop 版本戳(issue #98)

> 依赖 #93(全局装 + hook 机制)——已在本分支基线(`9d568ad`,含 #88/#93/#94)。本 PRD 排在
> #93 之后一次打全,覆盖 issue #98 原文点名的四个面:全局安装产物 / CLI / EvidenceBundle /
> 醒来开场白。

## 0. 问题

推出后(全局装到 `~/.claude/aeloop-brain/`,或独立 checkout 跑 CLI/`conductor-work`)完全没有
版本戳——任何一个跑出来的产物(CLI 输出、EvidenceBundle JSON、开场白文字)都不带"这是哪个
版本/哪个 commit"的信息。指挥官/操作者截图排查问题时,没法先确认"你装的是哪个版本",只能靠
猜或者要求对方贴 `git log`(全局装完之后,`~/.claude/aeloop-brain/repo-snapshot/` 本身根本没有
`.git`,git 命令在那连跑都跑不了)。

## 1. 目标 / 非目标

**目标**:四个面各自在自己的产物里带一个人类可读的版本字符串(`packageVersion+gitShortSha`,
无 git 时退化成 `packageVersion+unknown-sha`),且**全部四个面的版本字符串来自同一次生成、
同一个值**(不会出现"CLI 说的版本"和"EvidenceBundle 里的版本"对不上的情况)。

**非目标**:
- 不做语义化版本自动 bump(`package.json` 的 `version` 字段今天是手动维护的
  `"0.0.1"`,`CHANGELOG.md` 自己说"本项目暂未遵循语义化版本号"——这次不改这个既有约定,
  版本区分度主要靠 git SHA,不靠 `package.json` version 数字本身跳动)。
- 不做"防篡改"级别的构建溯源(不签名、不做 SLSA provenance)——只是排查用的诊断信息。
- 不给 `conductor-work` 的 `brain.version`/`workflow.version`(brain manifest/workflow
  定义自己的版本号,和引擎自身版本是两个不同概念)加任何东西——`plan.brain.version`/
  `plan.workflow.version` 现有输出不变。

## 2. 版本号构成与注入时机(本 issue 的技术核心)

### 2.1 构成

```
<package.json version>+<git short SHA>[-dirty]
```

例:`0.0.1+9d568ad`(干净树)、`0.0.1+9d568ad-dirty`(有未提交改动)、
`0.0.1+unknown-sha`(生成时拿不到 git,如纯 tarball 安装)。

### 2.2 单一事实源 + 注入时机(关键设计)

**运行时绝不现算 git SHA**——issue 原文点名的坑:全局装到 `~/.claude/aeloop-brain/
repo-snapshot/` 之后,那个目录**没有 `.git`**,任何运行时 `git rev-parse` 都会失败。所以版本
必须在**生成 `dist/` 的那一刻**(即每次 `pnpm run build`)固化成一个 build 产物,运行时只读
这个产物,不再碰 git。

新增 `scripts/generate-version.mjs`(纯脚本,零依赖,风格对齐 `.claude/hooks/lib/
git-remote.mjs` 的 `execFileSync` + try/catch fail-soft 惯例):

1. 读 `package.json` 的 `version` 字段。
2. `execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot })`——拿不到
   (非 git 目录、`git` 命令不存在、`.git` 损坏)→ **fail-soft**,`gitSha = "unknown-sha"`,
   不抛错、不中止 build。
3. `execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot })`——非空输出 →
   `gitDirty = true`;拿不到 git 或输出为空 → `gitDirty = false`(这是"尽力而为"的软信号,
   不是强承诺——git 不可用时无法判断脏不脏,统一按"不脏"处理,并在生成文件的注释里如实
   标注,不假装这是确定性判断)。
4. 把这三项 + 生成时间戳写成 `src/shared/version-info.generated.ts`(**不进 git**——`.gitignore`
   新增一行;每次 build 都重新生成,不依赖上一次残留的内容)。

**为什么是生成一个 `.ts` 文件,不是运行时读 `package.json` + 拼 SHA**:
- CLI/EvidenceBundle/wake-greeting 三个面都要读同一个值——生成一次、三处消费,不是三处各自
  現算(现算 = 三处对 git 不可达的处理逻辑要各写一遍,还可能三处对不上)。
- 全局安装的 `install-global-brain.mjs` 本来就会在 `installGlobalBrain()` 内部先跑一次
  `pnpm run build`(`execImpl("pnpm", ["run", "build"], { cwd: repoRoot, ... })`,见现有
  `scripts/install-global-brain.mjs:282`)再把 `dist/` 整个拷进 `repo-snapshot/`——这次 build
  天然就是"装的时候固化"的那一刻,不需要给安装脚本本身再加一段专门的版本注入逻辑,只要
  build 本身把版本写进 `dist/` 就行。

**注入链路**(一图说明四个面如何共享同一份数据):

```
package.json.version + git rev-parse (build 时刻)
        │
        ▼
scripts/generate-version.mjs  →  src/shared/version-info.generated.ts (生成,不进 git)
        │
        ▼
src/shared/version.ts (手写包装层,R2 起直接读生成产物的 versionString 字段,不再自己拼接格式化——
                        格式化真源是 generate-version.mjs 的 formatVersionString(),见 §2.2/§3)
        │
   ┌────┼──────────────────────┬───────────────────────────┐
   ▼    ▼                      ▼                            ▼
CLI     EvidenceBundle    全局安装(dist/ 整个被拷进        wake-greeting hook(通过
--version  engineVersion   repo-snapshot/,里面已经含        新 spike lib 动态 import
字段        字段            build 时刻固化的版本信息,        dist/shared/version-info-
                            零额外代码)                      generated.js)
```

### 2.3 何时重新生成(npm script 接线,对齐本仓已有的"显式 `&&` 串联"惯例,不用 npm
pre/post 生命周期钩子——`package.json` 现有的 `demo:company`/`conductor-work` 已经是
`"pnpm run build && node scripts/xxx.mjs"` 这种显式串联写法,延续同一风格):

```jsonc
"build": "node scripts/generate-version.mjs && tsc -p tsconfig.build.json",
"lint": "node scripts/generate-version.mjs && tsc --noEmit",
"test": "node scripts/generate-version.mjs && vitest run",
"test:watch": "node scripts/generate-version.mjs && vitest",
```

`lint`/`test`/`test:watch` 也要重新生成——因为 `src/shared/version.ts` 会 `import` 生成的
`version-info.generated.ts`,这个文件不进 git,新 checkout / `git clean` 之后如果只跑
`vitest`(不经过这几个 npm script)会因为找不到这个模块直接编译失败。这是**已知的、有意的
硬耦合**(不是 fail-soft 的场景——本地开发环境缺文件应该响亮报错,不应该悄悄不显示版本),
Zorro 复审重点关注:必须验证"全新 clone 后先跑 `npm test`(不手动跑 generate 脚本)也能通过"。

### 2.4 无 git 环境的 fail-soft(issue 原文要求)

`generate-version.mjs` 的 `execFileSync` 调用全部包 try/catch,git 不可用时落到
`"unknown-sha"`/`gitDirty:false`,**绝不让 build 因为拿不到 git 而失败**——纯 tarball 场景
(没有 `.git` 目录,比如从 npm pack 出的包解压出来跑 `npm run build`)必须仍能出一份能跑的
`dist/`,只是版本字符串退化成 `0.0.1+unknown-sha`。

## 3. 四个面逐一落地

### 3.1 全局安装产物(`scripts/install-global-brain.mjs`)

**结论:不需要改 `installGlobalBrain()` 本体的逻辑**——它已经在拷贝前跑
`pnpm run build`(2.2 节说明),`dist/` 里天然带上固化好的版本文件,`COPY_ITEMS` 的
`{ src: "dist", type: "dir" }` 项会把整个 `dist/` 原样拷进 `repo-snapshot/dist/`。

**需要改的两处**:
1. `COPY_ITEMS` 新增一条 `docs/conductor-brain-layer/spike/lib/version-info.mjs`(3.4 节新增
   的文件)——`brain-wake-greeting.mjs` 会动态 `import` 它,不在拷贝清单里的话装完就是
   `MODULE_NOT_FOUND`。
2. `installGlobalBrain()` 的返回值/CLI 输出末尾加一行"已安装版本:`<versionString>`"(R2 起从
   **换入后的 snapshotDir**下 `dist/shared/version-info.generated.js` 用**正则**提取
   `GENERATED_VERSION_INFO` 这段 JSON 字面量读出——不是动态 `import()`:那会让
   `installGlobalBrain()` 整个函数变成 async,波及 `test-install-global-brain.mjs` 里几十处
   `assert.throws(() => installGlobalBrain(...))` 的同步抛错断言,得不偿失;读一份已知格式的
   生成产物本来就不需要真的执行它。不是从当前运行这个安装脚本的仓库读——要读的是**刚刚换入
   生效的那份**,才能保证打印的版本和实际装进去的完全一致;这一步失败照 `assertStagingUsable()`
   同款风格 fail-soft:读不出来就打印 `"(无法读取版本信息)"`,不阻断安装本身)。

### 3.2 CLI(`src/cli/main.ts`)

新增 `--version`/`-v`(和 `--help`/`-h` 同等地位,`KNOWN_OPTIONS` 加一条):
- `aeloop --version` → 打印 `VERSION_STRING`(如 `aeloop 0.0.1+9d568ad`),`process.exitCode`
  保持 `undefined`(同 `--help` 的"干净退出"惯例,不组装任何依赖图)。
- `dispatch()` 里 `unknownOption` 的判定要把 `"version"`/`"v"` 也加进已知选项名单,否则会被
  误判成"unrecognized option"。
- `HELP_TEXT` 追加一行 `aeloop --version, -v   Show version`,和现有 `--help, -h` 并列。
- `bin.ts` 不改(两行 shim,`main(process.argv.slice(2))` 天然覆盖新分支)。

### 3.3 EvidenceBundle(`src/evidence/bundle.ts`)

`EvidenceBundle` 接口新增一个**必填**(非 optional)字段:

```ts
readonly engineVersion: string;
```

`EvidenceBundleBuilder.build()` 里从 `VERSION_STRING` 常量填入(和 `schemaVersion: "1"` 同一
行风格,模块顶部 `import { VERSION_STRING } from "../shared/version.js";`)。

判断为什么是必填而不是 optional:审计过 `EvidenceBundle` 唯一的构造点就是
`EvidenceBundleBuilder.build()`(`grep EvidenceBundle` 命中的另外两处——`conductor-work/
app.ts`/`loop/audit-store.ts`——都只是**类型引用**/文档注释,不构造裸对象字面量),所以加一个
必填字段不会破坏任何现有构造点;`bundle.test.ts` 现有断言全部是 `toEqual`/`toMatchObject`
在子字段上(如 `bundle.usage`/`bundle.requirements`),没有对整个 bundle 做全字段相等比较,
新增字段不会让既有测试变红。

### 3.4 醒来开场白

**新文件** `docs/conductor-brain-layer/spike/lib/version-info.mjs`——独立的、fail-soft 的小
lib(风格对齐 `.claude/hooks/lib/git-remote.mjs`:一个纯函数,try/catch 兜底,不抛错):

```js
export async function resolveVersionLine(repoRootGuess) {
  // 动态 import repoRootGuess 下的 dist/shared/version-info.generated.js
  // R2 起直接读其中的 versionString 字段(由 generate-version.mjs 的 formatVersionString()
  // 算好,见 §2.2/§3),这里不再自己拼 "+"/"-dirty" —— 只在前面加 "aeloop " 前缀。
  // 成功 → "aeloop " + info.versionString(如 "aeloop 0.0.1+9d568ad")
  // 失败(dist 没 build / 文件不存在 / versionString 缺失或为空)→ 返回 undefined(不是抛错,
  //   不是空字符串——undefined 让调用方能明确区分"这次没有版本行"和"版本行是空字符串"两种情况)
}
```

`repoRootGuess` 的算法复用 `brain-wake-greeting.mjs` 已有的相对路径惯例(`HERE` = 该 hook
自身所在目录 `.claude/hooks/`,`repoRoot = path.join(HERE, "..", "..")`)——`install-global-
brain.mjs` 头注释已经写明"目录骨架保留…`brain-wake-greeting.mjs` 等文件内部的
`path.join(HERE, "..", "..", ...)` 相对路径逻辑在新位置原样成立,零代码改动",这条对
`dist/shared/version-info.generated.js` 同样成立(`dist/` 本身就在 `COPY_ITEMS` 里,拷贝后
相对层级不变)。

**改动点**:
- `brain-wake-greeting.mjs`:`main()` 里新增一次动态 import + 调用
  `resolveVersionLine(REPO_ROOT)`(`REPO_ROOT = path.join(HERE, "..", "..")`,这个 hook 目前
  没有这个常量,新增),结果合并进 `data`(`data = { ...data, versionLine }`,和现有
  `AELOOP_BRAIN_IDENTITY_NAME` 覆盖逻辑同一位置、同一风格),**必须包在自己的 try/catch 里**
  ——版本行解析失败不能拖累整段开场白(这个 hook 现有的"绝不阻断"红线是整个 `main()` 一层
  catch,版本这一步如果不单独兜底,一次 `dist` 未 build 会导致连开场白本身都不显示,这是不必
  要的过度失败)。
- `render-greeting.mjs`:`renderGreeting(data)` 解构新增 `versionLine`(默认
  `undefined`)——`versionLine` 有值时,在"意识已加载。我是 X。"这一行**之后紧跟着**插入
  一行(放在最上面而不是结尾,呼应 issue 原文"便于用户截图排查时一眼看到"——截图排查场景下
  用户往往只截最上面几行);`versionLine` 走 `sanitizeText()`(和其它每一条要拼进正文的
  字段同一红线,虽然这个值本身是本地生成的可信数据、不是身份库里的不可信输入,但为了不在
  这个文件里维护"这条要不要清洗"的例外名单,一律统一过 `sanitizeText()`,不搞特殊)。
  `versionLine` 为 `undefined`(或空字符串)时**完全不输出这一行**(不是空行占位)——保证
  没有 `dist/` 的老快照/测试夹具跑这个函数,输出和加这个字段之前逐字节相同,不破坏现有
  `test-greeting.mjs` 用例。
- `install-global-brain.mjs` 的 `COPY_ITEMS` 新增一条(3.1 节已经提到)。

## 4. 新增/改动文件清单

| 文件 | 改动 |
|---|---|
| `scripts/generate-version.mjs` | 新增——build 时刻固化版本信息 |
| `scripts/test-generate-version.mjs` | 新增——standalone node 测试(风格对齐 `test-install-global-brain.mjs`,`node scripts/test-generate-version.mjs` 直接跑) |
| `src/shared/version.ts` | 新增——手写包装层,直接读生成产物的 `versionString` 字段导出为 `VERSION_STRING`(R2 起不再自己格式化拼接,格式化真源在 `generate-version.mjs` 的 `formatVersionString()`)+ 原样透传 `VERSION_INFO`,对生成文件缺失的情况按"响亮失败"处理(2.3 节) |
| `src/shared/version-info.generated.ts` | 新增,**不进 git**——`generate-version.mjs` 的输出产物 |
| `src/shared/__tests__/version.test.ts` | 新增——vitest 单测:格式化逻辑、dirty 后缀、unknown-sha 兜底 |
| `.gitignore` | 新增一行忽略 `src/shared/version-info.generated.ts` |
| `package.json` | `build`/`lint`/`test`/`test:watch` 四个 script 前置 `node scripts/generate-version.mjs &&` |
| `src/cli/main.ts` | `KNOWN_OPTIONS` 加 `version`,`dispatch()` 加 `--version` 分支,`HELP_TEXT` 追加一行 |
| `src/cli/__tests__/main.test.ts` | 新增 `--version`/`-v` 用例 |
| `src/evidence/bundle.ts` | `EvidenceBundle` 接口新增 `engineVersion: string`,`build()` 填入 |
| `src/evidence/__tests__/bundle.test.ts` | 新增一条断言 `bundle.engineVersion` 有值且匹配 `VERSION_STRING` |
| `docs/conductor-brain-layer/spike/lib/version-info.mjs` | 新增——`resolveVersionLine()`,fail-soft |
| `docs/conductor-brain-layer/spike/test-version-info.mjs` | 新增——standalone node 测试(同 `test-wake.mjs` 等既有 spike lib 测试风格) |
| `.claude/hooks/brain-wake-greeting.mjs` | 新增 `REPO_ROOT` 常量 + 调用 `resolveVersionLine()` 合并进 `data`,自身 try/catch 兜底 |
| `docs/conductor-brain-layer/spike/lib/render-greeting.mjs` | `renderGreeting()` 新增 `versionLine` 可选字段渲染(有值才输出,过 `sanitizeText`) |
| `docs/conductor-brain-layer/spike/test-greeting.mjs` | 新增 `versionLine` 有/无两种用例;既有用例(不传该字段)保持逐字节不变 |
| `docs/conductor-brain-layer/spike/test-hook-greeting.mjs` | 若该文件驱动 `brain-wake-greeting.mjs` 整个 `main()`,补一条"REPO_ROOT 下没有 dist/ 时开场白仍正常输出、只是没有版本行"的用例 |
| `scripts/install-global-brain.mjs` | `COPY_ITEMS` 新增 `version-info.mjs` 一条;`installGlobalBrain()` 末尾读 staging 出的版本、放进返回值(CLI 打印新增一行) |
| `scripts/test-install-global-brain.mjs` | 复核新增 `COPY_ITEMS` 项被现有"拷贝清单完整性"断言自动覆盖(该文件已经是遍历 `COPY_ITEMS` 生成 fixture,大概率零改动即可通过,若发现有硬编码文件列表的断言则同步更新) |

## 5. 批次(按依赖顺序)

- **B0 — 单一事实源**:`scripts/generate-version.mjs` + `src/shared/version.ts` +
  `version-info.generated.ts` 的 `.gitignore` + `package.json` 四个 script 接线 +
  `scripts/test-generate-version.mjs` + `src/shared/__tests__/version.test.ts`。
  自检:`node scripts/generate-version.mjs` 单跑一次确认产物内容正确;`npm run build` 全绿;
  `npm test` 全绿(含新单测)。
- **B1 — CLI**:`src/cli/main.ts` 的 `--version` 分支 + `main.test.ts` 新用例。
  自检:`node dist/cli/bin.js --version` 真跑,输出含正确版本号。
- **B2 — EvidenceBundle**:`src/evidence/bundle.ts` 新字段 + `bundle.test.ts` 新断言。
  自检:`npm test` 全绿(尤其 `bundle.test.ts` 全部既有用例零回归)。
- **B3 — 醒来开场白**:`version-info.mjs` + `render-greeting.mjs` + `brain-wake-greeting.mjs`
  + 对应三个测试文件。
  自检:`node docs/conductor-brain-layer/spike/test-greeting.mjs`、
  `node docs/conductor-brain-layer/spike/test-version-info.mjs`、
  `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs`(如适用)全绿;真跑一次
  `AELOOP_BRAIN_IDENTITY_DB=<临时db> node .claude/hooks/brain-wake-greeting.mjs < /dev/null`
  确认 stdout JSON 里的 `additionalContext` 含版本行。
- **B4 — 全局安装**:`install-global-brain.mjs` 的 `COPY_ITEMS` + 安装尾声版本回显 +
  `test-install-global-brain.mjs` 复核。
  自检:`node scripts/test-install-global-brain.mjs` 全绿;`--dry-run` 到一个临时 `--target`
  目录真跑一次(非 dry-run,`--target=<tmpdir>`,**绝不碰真实 `~/.claude/`**),确认
  `<tmpdir>/.claude/aeloop-brain/repo-snapshot/dist/shared/version-info.generated.js` 存在
  且内容正确,`repo-snapshot/docs/conductor-brain-layer/spike/lib/version-info.mjs` 也已拷贝。

每批完成跑一次全量 `npm test`(vitest,`src/**/*.test.ts`)确认零回归,再进下一批。

## 6. 验收标准

- [ ] `npm test`(vitest,`src/**/*.test.ts`)全绿,新增用例覆盖:有 git 时版本正确
      (`packageVersion+shortSha`)、脏树带 `-dirty`、git 不可用时 fail-soft 到
      `unknown-sha`、`--version` CLI 输出、`EvidenceBundle.engineVersion` 字段存在且非空。
- [ ] `npm run lint`(`tsc --noEmit`)全绿。
- [ ] 全新 clone / `git clean -fdx` 之后,不手动跑任何脚本,直接 `npm test` 也能通过(验证
      2.3 节"响亮失败"改成"自动重新生成"的接线是真的接上了,不是只在文档里写了)。
- [ ] `node scripts/generate-version.mjs` 在**没有 `.git` 目录**的临时拷贝里跑一次
      (`cp -r` 出一份不带 `.git` 的仓库副本),不抛错,生成的文件里 `gitSha ===
      "unknown-sha"`。
- [ ] 真跑 `node dist/cli/bin.js --version`,输出的版本号和当前 `git rev-parse --short HEAD`
      一致(干净树场景)。
- [ ] 真构造一次 `EvidenceBundle`(`conductor-work run` 或单测)确认 `engineVersion` 字段
      和 CLI `--version` 输出的字符串**完全一致**(跨面一致性,验收核心)。
- [ ] 真跑一次 `brain-wake-greeting.mjs`(有身份库 db 的场景),`additionalContext` 里能看到
      版本行,且和上面 CLI/EvidenceBundle 报的版本号一致。
- [ ] 真跑一次 `install-global-brain.mjs --target=<临时目录>`(非 dry-run),`repo-snapshot/`
      下的 `dist/shared/version-info.generated.js` 存在且版本号和源仓库一致;
      `repo-snapshot/.claude/hooks/brain-wake-greeting.mjs`(装完之后,脱离源仓库、没有
      `.git`)单独跑一次(`AELOOP_BRAIN_GLOBAL_MODE=1 node <snapshot>/.claude/hooks/
      brain-wake-greeting.mjs < /dev/null`,配一个测试用身份库 db)确认版本行依然正确
      渲染——这是证明"运行时不现算 git"真正成立的关键一步(此时该目录已经没有 `.git`
      可读,如果版本行还能读到 SHA,证明是读的 build-time 固化产物,不是运行时现算)。
- [ ] `scripts/test-install-global-brain.mjs` 全绿(含新 `COPY_ITEMS` 项)。

## 7. 给 Zorro 的重点提示(Cypher 自评,不是最终结论)

- **无 git fail-soft 是否真的每一条路径都盖到**:`generate-version.mjs` 里两次
  `execFileSync`(`rev-parse`/`status --porcelain`)是否都各自独立 try/catch(不是共用一个
  大 try 导致第一个失败连累第二个也拿不到值)。
- **`version-info.generated.ts` 不进 git 但 `npm test`/`npm run build` 强依赖它存在**——这是
  本 PRD 唯一一处"新增了一个文件不存在就会让全仓库编译/测试失败"的硬耦合,需要重点验证
  "全新 clone 后先跑 `npm test`"这条验收项是不是真的过,而不是本地残留了一份生成文件掩盖了
  问题。
- **跨面一致性**:四个面是不是真的从同一次 `generate-version.mjs` 输出取值——尤其
  `install-global-brain.mjs` 打印的"已安装版本"是不是读的 **staging 目录**里刚 build 出来
  的那份,而不是不小心读了当前正在跑这个安装脚本的仓库自己的 `dist/`(两者理论上应该一致,
  因为都是同一次 `pnpm run build` 产物,但如果安装脚本的读取路径写错、指向了错误的目录,
  这个 bug 不会在"内容碰巧一致"的开发环境里被测出来)。
- **`brain-wake-greeting.mjs` 的双重 try/catch 边界**:版本行解析失败是否真的只丢版本行,
  不影响开场白其余部分——需要一个专门用例证明(`dist/` 缺失但身份库存在时,开场白照常
  输出,只是没有版本行)。
- **`sanitizeText()` 是否真的套住了 `versionLine`**:虽然这个值目前的构成(纯数字/字母/`+`/
  `-`)理论上不含危险字符,但既然设计决定"一律统一过 sanitizeText,不搞特殊",要验证代码
  是不是真按这个决定写的,不是口头说了没做。
