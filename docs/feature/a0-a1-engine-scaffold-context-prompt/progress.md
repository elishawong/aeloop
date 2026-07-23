---
feature: a0-a1-engine-scaffold-context-prompt
status: done
last_updated: 2026-07-20
---

# 进度 — A0+A1 引擎脚手架 + Context/Prompt 层

> 边做边更新。每个批次之后追加一条:做了什么 + 本地自检结果 + 可追溯的证据。

> **▶ 下一步(RESUME 指针)**:**B0-B11 全部完成。** B0-B10 是初始构建;Zorro 第一次独立复审判定 **FAIL**(路径遍历安全漏洞 + FTS5 召回崩溃 + ContextInjector 死代码 + composer schema 硬编码 + 一处文档幻觉根因)。B11 是修复批次,提交在同一分支 `feature/issue-1-a0-a1-scaffold` 上。下一步是把 B11 交回 Zorro 重审,不是一个新的 Cypher 功能批次。

## B6-B9(Prompt 层 + 纵切)收尾总结

- 状态:**全部完成**,四个批次已经顺序提交并推送到 `feature/issue-1-a0-a1-scaffold`(commit `4e6ff3a`/`88852a5`/`64e8240`/`4eb97e4`)。
- 质量门:`pnpm build`(tsc strict + noUncheckedIndexedAccess)/ `pnpm lint`(tsc --noEmit)/ `pnpm test`(vitest run)全绿,**96/96** 测试通过(61 个既有 + 18 个 B6 + 6 个 B7 + 9 个 B8 + 2 个 B9 = 96,净增 35;**这个数字已经更正**——原文写的是"8 个 B6 + 6 个 B7",跟下面 B6/B7 批次条目里的实际数字对不上;B7 的"+8"已经在那个批次的条目里更正)。
- 跨层依赖检查:`grep -n "^import" src/prompt/*.ts`(排除测试文件)确认 `composer.ts` 只做了 `import type { ContextInjectionResult, InjectedMemory, InjectionWarning } from "../context/injector.js"`(输出类型)+ `Role` 来自 `../shared/types.js`——零 import `MemoryStore`/`StalenessEngine`/`ContextInjector` 这些类本身,零 import harness/loop(它们还不存在)。
- 细节见下面 `### B6`-`### B9` 的批次条目。

## B2-B5(Context 层)收尾总结

- 状态:**全部完成**,四个批次已经顺序提交并推送到 `feature/issue-1-a0-a1-scaffold`(commit `0eea001`/`d2af34d`/`b24fa3f`/`06259c9`)。
- 质量门:`pnpm build`(tsc strict + noUncheckedIndexedAccess)/ `pnpm lint`(tsc --noEmit)/ `pnpm test`(vitest run)全绿,**61/61** 测试通过。跨层反向依赖检查(`grep` `src/context/*.ts` 的 import)确认零命中 harness/loop/prompt。
- 细节见下面 `### B2`-`### B5` 的批次条目。

- **关联 PRD**:`./PRD.md`(批次拆分见 §6,覆盖 B0-B10)
- **分支**:`feature/issue-1-a0-a1-scaffold`(单分支,批次顺序提交)
- **关联 issue**:[elishawong/aeloop#1](https://github.com/elishawong/aeloop/issues/1)

## 批次进度

### B0 — package.json / tsconfig / vitest.config / .env.example / index.ts barrel / shared/types.ts
- 状态:完成
- commit:`c19dff3` — `chore(scaffold): B0 — pnpm + TS strict/ESM/NodeNext project skeleton`
- 做了什么:
  - `package.json`:`"type": "module"`,依赖 `zod@^4.4.3` / `js-yaml@^5.2.1` / `better-sqlite3@^12.11.1`,devDeps `typescript@^7.0.2` / `vitest@^4.1.10` / `@types/node@^24.13.3` / `@types/js-yaml@^4.0.9` / `@types/better-sqlite3@^7.6.13`。scripts:`build`/`test`/`test:watch`/`lint`。
  - `tsconfig.json`:`strict` + `noUncheckedIndexedAccess` + `module`/`moduleResolution: NodeNext` + `outDir: dist` + `rootDir: src`。
  - **一处跟 PRD 字面表述的故意偏离(有意为之,理由已记录)**:PRD §5 说 `build` script 是直接的 `tsc`;实现里改成了 `tsc -p tsconfig.build.json`(一个新的 `tsconfig.build.json`,`extends` 主 tsconfig 并 `exclude` 测试文件)。理由:如果 `build` 直接用主 tsconfig,`*.test.ts` 文件也会被编译进 `dist/`,污染 `npm i -g` 分发的内容(PRD §5 的 build/distribution 小节 + DESIGN §8.5 #8 明确关心 dist 的干净度)。`lint`(`tsc --noEmit`)依然用主 tsconfig,所以测试文件里的类型错误依然会被 lint 抓到——不影响"所有 JSON/YAML.parse 调用点都有类型"这条验收标准的覆盖率。
  - `.env.example`:`AI_AGENT_PROFILE=helix` + `LITELLM_BASE_URL`/`LITELLM_TOKEN` 占位符(注释说明只有 verity 用)。
  - `src/index.ts`(barrel,B0 时只重导出 `shared/types.ts`,B1 追加),`src/shared/types.ts`(`Role` 开放字符串 + `ISODateString`)。
- **⚠️ 基础 spike 结论(PRD §9.0#2 要求)**:
  - 用一个临时文件 `src/shared/spike.tmp.test.ts`(未提交,验证后删掉),在 pnpm 装好依赖的情况下确认:ESM + NodeNext + `better-sqlite3`(原生模块,包括 FTS5 虚拟表的建表/插入/`MATCH` 查询)在 vitest 下工作正常,没有阻断项。`pnpm run build` 也干净通过。
  - **实际碰到一个坑,当场修好,如实记录**:默认 tsconfig(没有 `types` 字段)下,`tsc` 在 pnpm 的非扁平 `node_modules` 布局下**不会自动发现 `@types/node`**,导致 `node:fs`/`node:path`/`process`/`import.meta.url` 等全部报 `TS2591 Cannot find name`(这个问题在 npm 的扁平布局下不会出现——是 pnpm 特有的)。**修法**:`tsconfig.json` 显式加了 `"types": ["node"]`。加上之后,`tsc --noEmit` 干净通过;确认了 `node_modules/@types/node` 的符号链接(指向 `.pnpm/@types+node@24.13.3/...`)本身没问题——只是需要显式声明。这一点记进了 B0 的 commit message,供未来的增量/其他 pnpm 项目参考,不用重新踩坑。
  - 结论:ESM + better-sqlite3 + vitest + pnpm 这个组合没有真正的阻断项,只有上面这一处需要显式配置,B0 已经修好——没有回退到 CommonJS,也没有换成 npm。
- 本地自检:`pnpm install`(better-sqlite3 原生绑定通过 `prebuild-install` 编译,无编译错误)→ `pnpm run build`(`tsc -p tsconfig.build.json` 无报错)→ `pnpm run test`(spike 测试 1/1 通过,之后删掉)。

### B1 — src/profile/loader.ts + errors.ts + loader.test.ts + profiles/helix/{config.yaml, personas/{coder,tester}.md}
- 状态:完成
- commit:`948fd24` — `feat(profile): B1 — AI_AGENT_PROFILE loader + helix example profile`
- 做了什么:
  - `src/profile/errors.ts`:`ProfileNotFoundError`(专门用于缺失场景,带 `profile`/`profileDir`)、`ProfileConfigParseError`(YAML 语法错误或根节点不是 mapping,用标准的 `Error#cause` 包住原始错误,不原样抛)。
  - `src/profile/loader.ts`:
    - `loadProfile(profile?, profilesRoot?): ProfileLoadResult`——不传时读 `AI_AGENT_PROFILE` 环境变量(默认 `"helix"`);`profiles/<name>/` 相对**这个模块自己的位置**解析(`import.meta.url`),不是 `process.cwd()`(因为 aeloop 是通过 `npm i -g` 全局安装的 CLI,用户的执行目录和包安装目录不是一回事;`src/profile/` 和编译后的 `dist/profile/` 相对 `profiles/` 的深度相同,所以两种场景下同一个 `../../profiles` 都能正确工作)。
    - 缺失(比如 `profiles/verity/` 不存在)→ **返回一个带类型的 `{ ok: false, error: ProfileNotFoundError }` 结果,不抛错**(严格对齐 PRD §8 验收标准的措辞,"返回一个带类型的'没找到'结果,而不是抛原始异常")。
    - `config.yaml` 存在但解析失败(YAML 语法错误 / 根节点不是 mapping)→ **抛出** `ProfileConfigParseError`(一个真正的配置错误,语义上跟"缺失"不同,处理方式也不同)。
    - `substituteEnvPlaceholders()`:递归替换字符串值里的 `${ENV_VAR}` 占位符;环境变量没设置时,保留原始占位符字符串(不会静默变成 `""`),导出为一个可独立测试的函数。
  - `profiles/helix/config.yaml`:最小化示例,对齐 DESIGN §7 结构(`providers.claude-cli`/`codex-cli` 占位符,`roles.coder`/`roles.tester`,`workflow.reject_threshold: 2`)。
  - `profiles/helix/personas/{coder,tester}.md`:纯文本、不绑定厂商的最小化示例 persona。
  - `src/index.ts` 追加重导出 `profile/loader.js` + `profile/errors.js`。
- **⚠️ 两个坑,当场修好,如实记录**(两个都记在 B1 的 commit message 里):
  1. **`@types/node` 在 pnpm 下需要显式 `"types": ["node"]`**——见 B0 的记录;这个问题第一次是在 B1 写代码时实际触发的(`node:fs`/`node:path`/`node:url`/`process` 全都报 `TS2591`),B0 的 tsconfig 已经修好,B1 直接受益。
  2. **`js-yaml@5.x` 的 ESM 构建(`dist/js-yaml.mjs`)没有默认导出,只有命名导出**(`load`/`dump`/…)。最初写成 `import yaml from "js-yaml"; yaml.load(...)`,`tsc` 的类型检查居然通过了——但**运行时**,`yaml.load` 是 `undefined`(`TypeError: Cannot read properties of undefined (reading 'load')`),被 vitest 抓到——一个教科书级的"lint 过了不代表真的能跑"的例子。**修法**:改成命名导入,`import { load as loadYaml } from "js-yaml"`。
     **⚠️ 根因更正(Zorro 复审 `feature/issue-1-a0-a1-scaffold` 时指出,`tsc --traceResolution` 实证推翻了原始记录,2026-07-20 追加)**:B1 条目原本写的是"`tsc` 的类型检查之所以通过,是因为 `@types/js-yaml@4.0.9` 的类型是给 js-yaml 4.x 老 API 用的,跟 5.x 的运行时产物对不上"——这个归因**是错的**,是一个没核实就写下来的猜测。真实验证(`npx tsc --noEmit --traceResolution 2>&1 | grep js-yaml`)显示:TypeScript 解析 `js-yaml` 时,走的是这个包自己 `package.json` 的 `exports`/`types` 字段(`"types": "./dist/js-yaml.d.ts"`),**直接解析到 js-yaml 5.x 自带的 `dist/js-yaml.d.ts`;`@types/js-yaml@4.0.9` 从来没被 `tsc` 碰过,一次都没有**——`@types/js-yaml` 是一个彻底的死依赖,不是"过时但还在用,只是类型对不上"。`import yaml from "js-yaml"; yaml.load(...)` 之所以能过类型检查,真正的原因是 `tsconfig.json:11` 的 `"esModuleInterop": true`——这个选项允许对一个只有命名导出(没有默认导出)的模块写 `import x from "..."` 这种语法,并在类型层面合成一个默认导出,跟 `@types/js-yaml` 的版本完全无关;js-yaml 5.x 自带的 `dist/js-yaml.d.ts`(`tsc` 实际用的那份)同样只有命名导出(`export { ... }`)——`esModuleInterop` 才是这行代码"类型检查通过但运行时崩溃"的唯一原因。
     **处理(这个 B1 遗留的 `[?]` 现在已经解决,不再是待定项)**:`@types/js-yaml` 是一个从没被用过的死依赖,已经 `pnpm remove @types/js-yaml`(从 devDependencies 移除);移除后重跑 `pnpm build`/`pnpm lint`/`pnpm test` 确认全绿(js-yaml 5.x 自带的类型已经覆盖,不再需要它)。PRD §5 的 devDeps 列表也相应同步去掉了 `@types/js-yaml`(见 PRD.md 的改动)。
- 本地自检:`pnpm run build`(`tsc -p tsconfig.build.json`,`dist/` 只有 `index`/`shared/types`/`profile/{errors,loader}` 六组文件,没有测试文件泄漏)→ `pnpm run lint`(`tsc --noEmit`,包括给测试文件做类型检查,无报错)→ `pnpm run test`(`vitest run`,**9/9 通过**:正常 helix 加载、`AI_AGENT_PROFILE` 未设置默认走 helix、verity 缺失返回带类型的结果、通用的缺失 profile 目录场景、YAML 语法错误抛带类型的错误、非 mapping 根节点抛带类型的错误、`${ENV}` 有值替换、`${ENV}` 无值保留占位符、`substituteEnvPlaceholders` 递归单元测试)。
- `git status` 确认:`profiles/verity/` 没有被意外创建(本增量从来没创建过它),`.gitignore` 对 `dist/`/`node_modules/` 生效(通过 `git status --ignored` 确认)。

### B2 — context/types.ts + errors.ts + util.ts + store.ts(建表+FTS5+CRUD+召回)+ store.test.ts
- 状态:完成
- commit:`0eea001` — `feat(context): B2 — MemoryStore (SQLite+FTS5 store, RecallError not silent)`
- 做了什么:
  - `types.ts`:`Memory`/`MemoryConfirmation`/`SystemConfigEntry`/`ConfidenceState`/`MemoryType`(12 个封闭枚举值,对齐 DESIGN §5 的注释),camelCase 的领域类型跟 SQLite 行(snake_case)分开,映射在 store.ts 内部做。
  - `errors.ts`:`RecallError`(包住读取失败)、`MemoryTagsParseError`(tags JSON 解析失败)、`ConfirmationError`(预留,B4 实际没用到,只声明)、`MemoryNotFoundError`。
  - `store.ts`(`MemoryStore` 类,接受显式的 `dbPath`,测试用 `:memory:`):
    - `createSchema()`:三张表的 `CREATE TABLE IF NOT EXISTS`(包括 §4.1 所有列,含 aeloop 新增的四列 `confirmed_at`/`confirmed_by`/`actor`/`updated_at`)+ `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)`(外部内容模式,`content='memories'`/`content_rowid='id'`)+ 三个 insert/update/delete 同步触发器。
    - CRUD:`insertMemory`/`getMemoryById`/`listMemories`/`deleteMemory`/`updateMemoryConfidence`/`updateMemoryContent`/`insertConfirmation`/`getConfirmationsForMemory`/`getConfigEntry`/`setConfigEntry`。
    - **错误包装惯例(记在类的 docstring 里)**:所有*读取*方法(`getMemoryById`/`listMemories`/`searchMemories`/`getConfirmationsForMemory`/`getConfigEntry`)把任何抛出的 SQLite 错误包成 `RecallError`;*写入*方法让 `better-sqlite3` 自己的 `SqliteError` 原样透传(不是"召回",也没有静默退化成空结果的诱惑,所以不需要额外包装)。
    - `searchMemories(query)`:`SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY rank`(实证验证过:最初用别名写成 `f MATCH ?`,报了 `SqliteError: no such column: f`;改成直接用真实表名 `memories_fts MATCH ?` 修好——记在 commit 里,不是凭记忆写对的)。
    - `runInTransaction<T>(fn)`:直接透传给 `this.db.transaction(fn)()`,供 B4 的 `ConfirmationService` 复用。
  - **⚠️ 一个坑,当场修好,如实记录**:FTS5 的 `MATCH` 条件不能用别名(`f MATCH ?` → `no such column: f`),必须用虚拟表的真实名字。这是在本批次工作开始前的一次临时 spike(`spike.tmp.test.ts`,验证后删除,未提交)里用真实机器测试发现并修好的,不是凭记忆写的。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**28/28 通过**(9 个既有的 profile-loader 测试 + 19 个新增:schema 往返包括所有列、幂等重新打开、CRUD、`MemoryNotFoundError` 缺失路径、tags 格式错误的 JSON → `MemoryTagsParseError`(两种格式错误:非 JSON 字符串 / 能解析但不是字符串数组)、FTS5 召回命中 + 空结果、触发器同步(update/delete 之后不再匹配旧关键词,新关键词能匹配)、**RecallError 触发路径**(通过一个格式错误的 FTS5 MATCH 语法 `"unterminated phrase` 触发,断言 `instanceof RecallError`)、事务回滚(在 `runInTransaction` 内部抛错,断言 memories 的写入和 confirmation 的插入都完全回滚)。

### B3 — context/config.ts(SystemConfig)+ staleness.ts(StalenessEngine)+ 对应测试
- 状态:完成
- commit:`d2af34d` — `feat(context): B3 — SystemConfig + StalenessEngine`
- 做了什么:
  - `config.ts`:`SystemConfig` 类包住 `system_config` 的读写,引擎级默认值 `DEFAULTS = { default_stale_days: "30", default_reject_threshold: "2" }`(没写过的键读默认值;未知键返回 `undefined`);两个带类型的数字读取方法 `getDefaultStaleDays()`/`getDefaultRejectThreshold()`,解析不出来时返回 `null`(而不是抛错或 `NaN`)。
  - `staleness.ts`:`StalenessEngine.isStale(memory, asOf = new Date())`——优先用 `memory.staleOverrideDays`,否则读 `config.getDefaultStaleDays()`;两个阈值都拿不到就永远不 stale;`asOf` 是一个显式参数,这样测试不需要伪造系统时钟。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**41/41 通过**(13 个新增:默认值回落、未知键、`set()` 覆盖 + `updated_at` 打时间戳、无法解析的值返回 `null`、staleness 未过期/已过期边界情形、无阈值时永远不 stale、双向 `stale_override_days` 覆盖测试——同时覆盖"覆盖值让一条记忆比默认值更早 stale"和"覆盖值让它更晚 stale"两种情况)。

### B4 — context/confirmation.ts(ConfirmationService)+ confirmation.test.ts
- 状态:完成
- commit:`b24fa3f` — `feat(context): B4 — ConfirmationService (confirm/correct/reject, transactional)`
- 做了什么:
  - `confirmation.ts`:`ConfirmationService.confirm(memoryId, actor, now?)` / `.correct(memoryId, newContent, actor, now?)` / `.reject(memoryId, actor, now?)`,三个全部包在 `store.runInTransaction(() => {...})` 里,同时覆盖 memories 的写入和 `memory_confirmations` 的插入。
  - **`correct()` 语义(按 PRD §9.0#5 自行实现,没读 Verity 内网源码)**:`old_content` 永远取"这次调用**之前那一刻**"记忆的 `content`(不是最初插入的值),这样连续多次 `correct()` 调用能正确链起来("最新"而不是"最初")。`correct()` 同时把 `confidence_state` 标成 `confirmed`(修正内容本身也是对新内容的一次确认)。
  - **`reject()` 语义**:把 `confidence_state` 设成 `'rejected'`,但**故意不清空** `confirmed_at`/`confirmed_by`——这两列记录的是"上次是什么时候/被谁确认的",拒绝不应该抹掉这段历史;完整的操作历史一直都活在 `memory_confirmations` 里(reject 自己那一行有独立的 `actor`/时间戳)。这个设计决定记在类的 docstring 里。
- **必需项断言点**(逐条对应测试文件里的哪个 `it`):
  - **事务原子性**(`describe("ConfirmationService — transaction atomicity ...")`,3 个 `it`):`vi.spyOn(store, "insertConfirmation").mockImplementation(() => { throw ... })`,在 `confirm()`/`correct()`/`reject()` 各自**已经执行完** memories 写入之后注入失败;断言点——对 `confirm`:回滚后 `getMemoryById().confidenceState === "unconfirmed"`,`confirmedAt`/`confirmedBy` 依然是 `null`;对 `correct`:回滚后 `content` 依然是 `"original"`(没变成新内容),`confidenceState` 依然是 `"unconfirmed"`;对 `reject`:回滚后 `confidenceState` 依然是 `"unconfirmed"`(没被错误地标成 `"rejected"`)。三个都额外断言 `store.getConfirmationsForMemory(id)` 是空数组(没留下半写的审计行)。
  - **没有既有确认记录的路径**(`correct()`,2 个 `it`):第一个直接对一条**从没调用过 confirm/correct/reject** 的全新记忆调 `correct()`,断言调用前 `getConfirmationsForMemory` 是 `[]`,调用后 `old_content` 等于原始插入的内容;第二个紧接着第二次调用 `correct()`,断言第二次确认行的 `old_content` 等于**第一次 correct 之后**的内容,而不是原始内容——证明"最新"语义真的起作用,不是巧合。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**52/52 通过**(11 个新增)。

### B5 — context/injector.ts(ContextInjector)+ injector.test.ts
- 状态:完成
- commit:`06259c9` — `feat(context): B5 — ContextInjector (filters rejected, warns stale/unconfirmed)`
- 做了什么:
  - `injector.ts`:`ContextInjector.inject(query?, asOf?)`——`store.listMemories()`(核心全集)+ 可选的 `store.searchMemories(query)`(FTS5 召回),按 id 用一个 `Map` 合并去重;过滤掉 `confidence_state === 'rejected'`;对剩下的记忆逐条计算警告(`isStale` 优先于 `unconfirmed`——两者都为真时,"stale" 胜出;DESIGN 没有明确规定这个优先级,所以在代码注释里标注为实现层的决定,不是规格事实)。**不 import `src/prompt/` 里的任何东西**(通过 `grep` 确认,见下面的跨层检查)。`RecallError` 从 `store.searchMemories()` 直接透传;`inject()` 不捕获它。
- **必需项断言点**(过滤 rejected 的定向测试,逐条对应测试文件里的哪个 `it`):在 `describe("ContextInjector — rejected memories are filtered out (PRD §8 required test)")` 下,两个 `it`——① 在核心全集里混入一条 `confidenceState: "rejected"` 的记忆,断言 `result.memories` 的 id 列表包含 confirmed 的那条、**不包含** rejected 的那条;② 另一个 `it` 验证即便一条 rejected 的记忆能被 FTS 关键词命中(`inject("zebra", ...)`),它依然不会出现在结果里——证明过滤发生在"核心+召回合并之后",不是一个只对核心集生效的半吊子实现。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**61/61 通过**(9 个新增:上面 2 个 rejected 过滤测试 + 4 个 stale/unconfirmed 保留并带警告(包括双重命中的优先级)+ 2 个核心/召回合并去重 + 1 个 RecallError 透传)。
- **跨层反向依赖检查**:`grep -rn "^import" src/context/*.ts`,逐行核对,每个命中要么是 `./`(context 内部)要么是 `../shared/types.js`,零命中 `../prompt`/`../harness`/`../loop`。`dist/` 不受 git 跟踪(`git ls-files | grep '^dist/'` 为空)。

### B6 — prompt/schema.ts(ClaimSchema/CoderOutput/TesterOutput,zod)+ schema.test.ts
- 状态:完成
- commit:`4e6ff3a` — `feat(prompt): B6 — ClaimSchema/CoderOutput/TesterOutput (zod)`
- 做了什么:
  - 两个 zod 枚举:`ClaimConfidence`(`verified`/`inferred`/`unconfirmed`/`stale`,对齐 DESIGN §5 的 `structured_claims.confidence`)和 `VerifiedBy`(`tool_execution`/`human`/`unverified`,对齐 `structured_claims.verified_by`)。
  - `ClaimSchema`:`claimText`(非空字符串)+ `confidence`(必需)+ `sourceRef`/`verifiedBy`(都是可选的,`sourceRef` 是非空字符串)。**范围决定**(记在文件头注释里):故意排除了 `structured_claims` 里那些只有引擎处理完模型输出之后才会有的列——`id`/`run_id`/`created_at`(持久化记账)、`model_used`/`provider_used`(只有 Harness 知道实际跑的是哪个模型)、`tool_exec_checked`(ToolExecVerifier 事后算出来的结果,A3)。剩下的——`claim_text`/`confidence`/`source_ref`/`verified_by`——正是模型能合理自报的那部分,对齐 PRD §5"不含 run_id 这类持久化列"的表述。
  - `CoderOutput`(`diff` 非空字符串 + `claims: ClaimSchema[]` + 总体 `confidence`),`TesterOutput`(`verdict: "pass"|"reject"`,对齐 DESIGN §4 状态机的"pass"/"reject" + `issues: string[]`(非空字符串)+ `claims` + `confidence`),都对齐 DESIGN §3 时序图的形状 `{diff, claims[], confidence}` / `{verdict, issues[], confidence}`。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+18 个新增**(每个字段合法/非法输入的边界情形:缺字段、空字符串最小长度、枚举外的值、非法数组元素、`claims`/`issues` 不是数组)。

### B7 — prompt/personas.ts(动态角色 persona loader)+ personas.test.ts
- 状态:完成
- commit:`88852a5` — `feat(prompt): B7 — dynamic persona loader (role -> personas/<role>.md)`
- 做了什么:
  - `resolvePersonaPath(role, personasDir)` + `loadPersona(role, personasDir)`:对 `<personasDir>/<role>.md` 做纯字符串键查找,**零 `if role === ...` 分支**(DESIGN §1.7)——`personas/` 目录本身就是角色 registry;加一个角色只需要丢一个新的 `.md` 文件,不用改这个 loader 的代码。`personasDir` 是一个显式参数(不隐式耦合到 profile),延续了 `store.ts`(显式 `dbPath`)/`profile/loader.ts`(显式 `profilesRoot`)已经立下的模式。
  - `PersonaNotFoundError`(role + personaPath):给缺失文件场景用的带类型错误,不是原样抛出的 `ENOENT`。
- **必需项断言点**(角色 persona 文件缺失路径,PRD §8):`describe("loadPersona — missing persona file...")`,两个 `it`——① 目录存在但目标角色的 `.md` 缺失;② 整个 `personasDir` 目录都不存在。两个都断言 `instanceof PersonaNotFoundError` 并且 `.role`/`.personaPath` 字段正确。还有一个定向测试测"动态加载一个任意的新角色,只需要丢一个文件,不改代码"(往一个临时目录写一个 `reviewer.md`,验证零代码改动就能加载)。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+6 个新增**(真实的 helix coder/tester persona 加载,2 个 + 一个动态新角色,1 个 + 缺失路径,2 个 + `resolvePersonaPath` 单元测试,1 个 = 6,细节见测试文件的进一步拆分)。**更正(Zorro 复审时指出)**:这条条目原本写的是"+8 个新增",跟它自己列举的 2+1+2+1=6 或 `personas.test.ts` 里实际的 `it()` 数量都对不上——更正为 6(在 B10 / 上面的总结里同步)。

### B8 — prompt/composer.ts(PromptComposer)+ composer.test.ts
- 状态:完成
- commit:`64e8240` — `feat(prompt): B8 — PromptComposer (persona + schema + injected memories)`
- 做了什么:
  - `PromptComposer`(构造函数接受一个显式的 `personasDir`)`.compose(role, context: ContextInjectionResult, task): string`——组装:persona 文本(`loadPersona`)+(当角色在 schema registry 里有条目时)一段 schema 描述(`z.toJSONSchema(schema)` 序列化成 JSON——不是一段可能跟 zod 定义漂移的手写文字描述)+ 注入的记忆(每条渲染成 `- [warning: stale|unconfirmed] Title\n  Content`,`warning: null` 时不加标记)+ 任务描述。
  - **Schema registry**(`OUTPUT_SCHEMAS: Record<string, z.ZodType>` = `{coder: CoderOutput, tester: TesterOutput}`)——DESIGN §1.7"persona/schema 按角色名通过 registry 动态查找"的一次部分落地:纯键查找,不是 `if role===` 分支。角色不在 registry 里时(有 persona 但没有结构化 schema)→"Output Schema"这段静默省略,不抛错(记在类的 docstring 里,作为一个实现层选择:加一个角色不强制它也得有 schema)。
  - **依赖方向**(PRD §10 约束,通过 `grep` 确认):只对 `../context/injector.js` 做**类型层面**的 import(`ContextInjectionResult`/`InjectedMemory`/`InjectionWarning`),零 import `MemoryStore`/`StalenessEngine`/`ContextInjector` 这些类本身——composer 完全不知道记忆是怎么查找/过滤出来的,只知道输出的形状。
  - **不重复过滤**:composer 完全不知道 `confidenceState` 这回事,只读 injector 给的 `warning` 字段;`composer.test.ts` 有一个测试手动构造一个混入了 `confidenceState: 'rejected'` 记忆的 `ContextInjectionResult`,证明 composer 依然照原样渲染它——过滤只发生在 injector 一处,不会在两处重复(也可能互相矛盾)。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+9 个新增**(coder/tester 角色 persona+schema+task+记忆渲染、warning 有/无标记、无 schema 条目角色的省略行为、未知角色的 `PersonaNotFoundError` 透传、不重复过滤断言、空记忆列表渲染)。

### B9 — src/context-prompt.e2e.test.ts(硬核纵切,A1 收尾)
- 状态:完成
- commit:`4eb97e4` — `test(e2e): B9 — Context -> Prompt vertical slice, no mocking across the seam`
- 做了什么(一条真实的数据流,零 mock 跨层调用):
  1. **一个真实的 `MemoryStore`**(`:memory:` 一个真实的 SQLite 实例,不是桩)`insertMemory()` 写入 3 条真实记忆:confirmed(`"aeloop uses pnpm as its package manager."`)/ unconfirmed(`"The API rate limit is believed to be 100 requests/min."`)/ rejected(`"The context store uses MySQL for persistence."`);写完之后立刻用 `store.listMemories()` 确认 3 条确实都落进了 db——不是空跑一遍。
  2. **一个真实的 `ContextInjector`**(给同一个 `store` + 一个真实的 `StalenessEngine`/`SystemConfig`)`.inject()`——断言它的返回值本身(不是任何后处理的副本)就已经过滤掉了 rejected、保留了 confirmed/unconfirmed。
  3. **一个真实的 `PromptComposer`**(指向真实的、已经提交的 `profiles/helix/personas/`)`.compose("coder", injected, "Implement the retry-backoff helper.")`——`injected` 是上一步 `injector.inject()` 的**原始返回值**,直接传过去,composer 内部零转换地消费它。
  4. **断言最终的 prompt 字符串**:包含 confirmed 的内容(`"aeloop uses pnpm as its package manager."`,包括精确的格式 `"- Build tooling\n  aeloop uses..."`),**不包含** rejected 的内容(两个断言:原始内容文本 + 它的标题),包含带可见 `"[warning: unconfirmed] Rate limit guess"` 标记的 unconfirmed 内容,包含 persona 文本(`"You are the Coder in a two-model coder/tester loop."`),包含一段 schema 片段(`'"diff"'`),包含任务描述。
  - **第二个测试**(同一个纵切,但通过 `ConfirmationService.reject()` 而不是插入时直接设 `confidenceState: "rejected"`):证明"一条记忆先是 unconfirmed,后面通过 service 被拒绝"这条更真实的路径——过滤在整条端到端链路里依然成立,不只是插入时的一个走捷径的特例。
  - **没有 mock 任何跨层调用**:`grep` 这个测试文件的 import 只看到真实的类——`MemoryStore`/`SystemConfig`/`StalenessEngine`/`ContextInjector`/`PromptComposer`/`ConfirmationService`(通过动态 `import()`)——加上 `resolveProfileDir` 来定位真实的 profile 目录,零 `vi.mock`/`vi.spyOn`。
  - **顺手也理了一下**:`src/index.ts` 追加了 `export * from "./prompt/{schema,personas,composer}.js"`(B6-B8 各批次都只专注单个文件,从没回头更新 barrel;B9 作为"现在一切都接上了"的收尾点,在这里补上,跟 profile/context 已经立下的模式一致)。
- 本地自检:`pnpm build`/`pnpm lint` 无报错(包括新增的 barrel 导出,没有命名冲突,确认 `CoderOutput` 类型 + 常量同名在 TS 的声明合并下不冲突);`pnpm test`:**全绿,96/96**(B6-B9 净增 35:18(B6)+6(B7)+9(B8)+2(B9)=35,61+35=96,跟 vitest 实际总数对得上)。
- `git status`/`find dist -name "*.test.*"` 确认:测试文件没有泄漏进 `dist/`,`profiles/verity/` 没有被意外创建。

### B10 — 打包配置验证 + 文档回写(A0+A1 收尾)
- 状态:完成
- commit:`b6a6cd1` — `docs(a0-a1): B10 — verify packaging config, wrap up A0+A1 build docs`(**更正**:这一行原本写的是"等这个批次的 commit",而那个状态从没在实际落地后回写过——现在更正为真实的 commit hash)
- 做了什么:
  - **第 0 步(先做)**:`git merge origin/main`(把 main 上的文档修复——`a6b8efe`,CLAUDE.md §2 的技术栈表 + `.claude/skills/run/SKILL.md` 的 npm→pnpm——合进 feature 分支)。**零冲突**(feature 分支从没碰过这两个文件);`git log origin/main --oneline feature/issue-1-a0-a1-scaffold..origin/main` 确认合并前分支只落后一个 commit。合并后,`grep -n -i "npm\|pnpm" CLAUDE.md .claude/skills/run/SKILL.md` 确认继承来的 pnpm 措辞在 feature 分支上生效了。
  - **打包配置验证**(PRD §8,倒数第二项):`package.json` 没有 `.npmignore`(`files` 字段单独工作就够,B0 已经把 `profiles/*/personas/**/*.md` + `profiles/*/config.yaml` 放进去了)。实际跑了一次 `pnpm pack` 打出一个真实的 tarball;`tar -tzf aeloop-0.0.1.tgz | sort` 确认:① `package/profiles/helix/personas/{coder,tester}.md` + `package/profiles/helix/config.yaml` 确实在包里,所以 `pnpm add -g` 会正确分发它们;② `package/dist/**` 只有 `.js`/`.d.ts`/`.js.map`,**零** `*.test.*` 文件泄漏。验证完之后,`rm -f aeloop-0.0.1.tgz`;`git status --short` 确认没有残留。**结论:不需要改动——B0 的打包配置本来就是对的。**
  - **JSON.parse / YAML.load 复核**(PRD §8,倒数第四项):`grep -rn "JSON.parse" src --include="*.ts"`,排除测试文件,唯一命中的是 `store.ts:209`(tags 反序列化,包在 try-catch 里 → `MemoryTagsParseError`);`profile/loader.ts` 的 `loadYaml(...)` 同样包在 try-catch 里 → `ProfileConfigParseError`。两个都已经在各自的批次(B1/B2)落地;B10 只是复核确认没有漏项。
  - **文档回写**:`docs/ROADMAP.md` 的四个 A1 `[ ]` 勾选框全部改成 `[x]` 并加上 commit 引用 + 新增一行"打包配置验证 + 文档回写"(对应本批次);`docs/PROGRESS.md` 清空回到"没有批次在进行中"的空模板(A0+A1 已完成,下一步是 `/verify`,不是新批次);`CHANGELOG.md` 新增一条顶部摘要总结 A0+A1 构建完成;根 `CLAUDE.md` §2 的技术栈表脚注 + §3 的目录结构图更新了陈旧措辞,比如"src/ not yet built"改成反映真实现状(A0+A1 已经搭好 prompt/context/profile/shared;harness/loop/cli 等 A2+;langgraph/checkpoint-sqlite/ajv 还没装,不再一起被描述为"已验证可安装")——**没有删任何规则/红线,只更新了状态措辞**;PRD §8 的十一条验收标准逐条勾选(见上面 §8,各带一个 commit/验证方式引用)。
- 本地自检(最终的完整质量门,真的跑了一遍):
  - `pnpm build`(`tsc -p tsconfig.build.json`)——无报错。
  - `pnpm lint`(`tsc --noEmit`)——无报错。
  - `pnpm test`(`vitest run`)——**10 个测试文件 / 96 个测试全部通过**,跟 B9 收尾时的 96/96 一致(B10 没有新增/删除 `src/` 测试)。
  - `git status --short` 确认工作树干净;`find dist -name "*.test.*"` 为空;`profiles/verity/` 没被意外创建(`ls profiles/` 只有 `helix/`);`git check-ignore -v profiles/verity/anything` 命中 `.gitignore:16`,确认规则生效。
- **A0+A1 增量构建收尾**:B0-B10 全部完成,分支 `feature/issue-1-a0-a1-scaffold` 已推送到 `origin`,下一步是交给 Zorro 做独立的 `/verify` 复审。

### B11 — Zorro 第一轮 FAIL 返工(安全漏洞 + FTS5 崩溃 + 死代码 + composer 硬编码 + 文档幻觉)
- 状态:完成,在同一分支 `feature/issue-1-a0-a1-scaffold` 上顺序提交(每个阻断项各自一个 commit,见下)。
- **背景**:Zorro(Codex 独立引擎)给 B0-B10 判了 **FAIL**,五个阻断项(路径遍历、FTS5 召回崩溃、ContextInjector 死代码、composer schema 硬编码、progress.md 一处根因幻觉)+ 两个建议改进。这个批次逐项修复,然后交回 Zorro 重审。
- **① 路径遍历 → 本地文件外泄(安全,最高优先级)**:
  - 根因:`src/prompt/personas.ts`(`loadPersona`)和 `src/profile/loader.ts`(`loadProfile`)把外部传入的 `role`/`profile` 字符串直接 `path.join` 进一个文件路径就去读,没有任何遏制检查。**在真实机器上复现过**(修复前):`loadPersona("../../../CLAUDE", "./profiles/helix/personas")` 返回了仓库根目录 `CLAUDE.md` 的完整内容(用 `node --experimental-strip-types` 实证确认过,细节见这一轮修复过程的记录)。
  - 修法:新增 `src/shared/safe-path.ts`(两层防御,被 `personas.ts`/`loader.ts` 共用):① `isSinglePathSegment`——拒绝含 `/`、`\`、`..`、或绝对路径的输入;② `isContainedRealpath`——`fs.realpathSync` 解析之后,二次检查最终路径依然被包含在 `personasDir`/`profilesRoot` 内(防符号链接逃逸)。`personas.ts` 新增 `InvalidRoleNameError`,`profile/errors.ts` 新增 `InvalidProfileNameError`,两个都在碰文件系统之前就抛出。
  - 断言点:`personas.test.ts`/`loader.test.ts` 各自新增一组"路径遍历被挡住"的测试——① 复现原始的漏洞字符串(`"../../../CLAUDE"`),现在抛 `InvalidRoleNameError`/`InvalidProfileNameError`;② 更深层的遍历、绝对路径、反斜杠、裸 `..`;③ 一个 URL 编码字符串比如 `"..%2F..%2Fsecrets"` 证明这个检查是惰性的(没有解码逻辑,所以它不构成遍历,直接落进正常的"没找到"路径);④ 符号链接逃逸(用 `symlinkSync` 真的创建一个指向临时目录之外某个秘密文件的符号链接,验证被挡住)。`src/shared/safe-path.test.ts`(新)也直接单元测试这两个底层函数本身。
- **② 普通任务文本让 FTS 召回崩溃**:
  - 根因:`MemoryStore.searchMemories(query)` 把调用方的文本原样传进了 FTS5 的 `MATCH` 子句;常见文本比如连字符(`retry-backoff`)、`C++` 等会触发 FTS5 语法错误。
  - 修法:`store.ts` 新增 `toSafeFtsQuery`——按空白拆分,丢掉没有字母数字字符的词,把每个词转成带引号的短语(内部 `"` 加倍转义),用空格连接(FTS5 的隐式 AND)。空输入或纯标点输入直接短路返回 `[]`,不碰 DB。真正的 DB 层错误(比如 `memories_fts` 表被删了)依然包进 `RecallError` 抛出,不会被吞掉。
  - 断言点:`store.test.ts` 新增一组"自然语言查询安全性"测试——带连字符的词、`C++`、一整句包含标点的自然语言句子(跟目标记忆的内容共享所有 token,验证 AND 语义下召回依然有效)、之前会报错的字符串(`'"unterminated phrase`)现在惰性通过、空/纯标点查询返回 `[]`。原来的"RecallError 触发路径"测试改成通过一个真正的 DB 错误(`DROP TABLE memories_fts`)触发,不再依赖那个现在已经修好的语法错误。
- **③ ContextInjector 的 FTS 召回是死代码 + 测试只是走过场**:
  - 根因:`inject()` 的"核心记忆"以前是 `store.listMemories()`(整张表),所以 FTS5 召回的结果永远是它的子集,合并分支贡献为零;`injector.test.ts` 的合并断言是空洞地为真。
  - 修法:`injector.ts` 新增 `CORE_MEMORY_TYPES`(`identity`/`constraint`/`decision`——Zorro 复审时举的"总是相关"的那几种类型,现在在代码注释里标注为实现层选择,不是规格事实);`inject()` 的核心集现在按 type 过滤,非核心类型只有真的通过 `query` 召回时才会出现。
  - 断言点:`injector.test.ts` 重写了一组"核心 vs 召回"测试——① 一条非核心的、没有被 query 命中的记忆在没有 query 时**不出现**;② 同一条记忆在 query 命中它之后出现;③ 核心类型的记忆即便没有 query 也存在;④ 合并去重测试现在用真实的核心类型。`context-prompt.e2e.test.ts` 的两个测试现在调用 `inject()` 时用带连字符的真实任务文本(`"Explain the retry-backoff strategy."` / `"Review the retry-backoff change before merging."`),不再用 `inject(undefined)` 绕过它。
- **④ PromptComposer 硬编码了 `{coder,tester}` 的 schema 映射**:
  - 根因:`OUTPUT_SCHEMAS` 是 `composer.ts` 内部的一个私有常量,未知角色静默省略 Output Schema 那一段——违反了 DESIGN §1.7"按角色名通过 registry 动态查找"的精神,而且跟 persona loader 的动态查找不对称。
  - 修法:新增 `src/prompt/schema-registry.ts`(`SchemaRegistry` 类型 = `Record<string, z.ZodType | null>`、`DEFAULT_OUTPUT_SCHEMAS`、`SchemaNotRegisteredError`)。`PromptComposer` 的构造函数新增一个可选的 `schemas` 参数(默认 `DEFAULT_OUTPUT_SCHEMAS`,不破坏既有调用方)。一个 registry 里完全没有的角色 → 抛 `SchemaNotRegisteredError`(不再静默);一个显式注册成 `null` 的角色 → 视为"故意选择不要结构化输出",省略这一段但不报错(区分"没接线"和"故意不要")。
  - 断言点:`composer.test.ts` 新增/重写测试——① 显式注册为 `null` 依然省略这一段;② 完全没注册的角色抛 `SchemaNotRegisteredError`;③ 通过一个自定义 registry 给一个新角色注册 schema(`{...DEFAULT_OUTPUT_SCHEMAS, reviewer: ReviewerOutput}`)零改动 `composer.ts` 就生效。
- **⑤ progress.md 的错误根因(幻觉门)+ 移除一个死依赖**:
  - 根因:B1 条目原本写的是"`tsc` 的类型检查之所以通过,是因为 `@types/js-yaml@4.0.9` 的类型是给 js-yaml 4.x 老 API 用的,跟 5.x 的运行时产物对不上"——这个归因是**没验证的猜测**。真实验证(`npx tsc --noEmit --traceResolution 2>&1 | grep js-yaml`)证明 `tsc` 解析 `js-yaml` 时走的是这个包自己 `package.json` 的 `"types": "./dist/js-yaml.d.ts"` 字段——`@types/js-yaml@4.0.9` 从来没被 `tsc` 碰过——一个彻底的死依赖。`import yaml from "js-yaml"; yaml.load(...)` 之所以能过类型检查,真正原因是 `tsconfig.json:11` 的 `"esModuleInterop": true`(它允许对一个只有命名导出的模块合成一个默认导入),跟 `@types/js-yaml` 的版本毫无关系。
  - 修法:`pnpm remove @types/js-yaml`;重跑 `pnpm build`/`pnpm lint`/`pnpm test` 确认移除后依然全绿(js-yaml 5.x 自带的类型已经覆盖)。progress.md 的 B1 条目 + PRD §5 的 devDeps 列表都相应更新(移除 `@types/js-yaml` 要求 + 加上根因更正)。
  - 顺手更正的其他文档幻觉/残留(都属于这一项"文档核对"的范围):B7 的测试数量(顶部总结 + B7 条目原本写的是"+8",实际是 6,跟它自己 2+1+2+1 的和矛盾,现在更正为 6);B10 的 commit 状态(原本写"等这个批次的 commit",实际落地后从没回写,现在有了真实 hash `b6a6cd1`);PRD §9 的 `[?]` 第 1-5 项(已经因指挥官在 §9.0 的批准收敛为已敲定的决定;原来的 `[?]` 标记是一份从没被回写的文档留下的残留,现在重新标成"[已敲定]"并注明来源)。
- **🟡 建议改进(这一轮也一并处理了)**:
  - `profile/loader.ts`:新增 `assertProfileConfigShape`——在 `ProfileConfig` 返回 `ok:true` 之前,验证三个必需的顶层字段 `profile`(字符串)/ `providers`(mapping)/ `roles`(mapping)存在且类型正确;缺失/类型错误 → `ProfileConfigParseError`,取代原来裸的 `as ProfileConfig` 类型断言。`loader.test.ts` 新增 5 个测试(分别测缺 `profile`/`providers`/`roles` + 一个 `providers` 类型错误的 + 一个真实 helix profile 依然通过的健全性检查)。
  - `confirmation.test.ts` 新增一个 `correct() -> reject()` 边界测试:锁定"reject 保留最后一次 correct() 写入的 confirmedAt/confirmedBy"这个行为——之前只覆盖了"confirm→reject"这条路径——现在也覆盖了"correct→reject"这条路径,防止未来的重构悄悄改掉这个有争议的元数据设计决定。
- **本地自检(最终的完整质量门,真的跑了一遍)**:
  - `pnpm build`(`tsc -p tsconfig.build.json`)——无报错。
  - `pnpm lint`(`tsc --noEmit`)——无报错。
  - `pnpm test`(`vitest run`)——**11 个测试文件 / 139 个测试全部通过**(比 B10 收尾时的 96/96 净增 43——逐文件核对 `it()` 数量:`safe-path.test.ts`:新文件 +11;`personas.test.ts`:6→13(+7);`loader.test.ts`:9→21(+12);`store.test.ts`:19→25(+6);`injector.test.ts`:9→13(+4,一次重写而不是纯增量);`composer.test.ts`:9→11(+2);`confirmation.test.ts`:11→12(+1);合计 11+7+12+6+4+2+1=43。`pnpm exec vitest run --reporter=json` 实证确认了总数对得上)。
  - `pnpm pack` + `tar -tzf aeloop-0.0.1.tgz`:`profiles/helix/{config.yaml,personas/*.md}` 在包里,新增的 `dist/` 构建产物 `shared/safe-path.*`/`prompt/schema-registry.*` 都在,零 `*.test.*` 泄漏;验证后 `rm -f aeloop-0.0.1.tgz`。
  - 跨层反向依赖复核:`grep -n "^import" src/context/*.ts src/prompt/*.ts src/profile/*.ts`,排除测试文件——新增的 `../shared/safe-path.js` 引用是同层内共享工具(不是反向依赖),零命中 `harness`/`loop`;`composer.ts` 对 `../context/injector.js` 的 import 依然是类型层面的。
  - `src/index.ts` 的 barrel 现在也重导出了两个新模块 `shared/safe-path.js` + `prompt/schema-registry.js`;`pnpm build` 确认没有命名冲突。
  - `git status --short` / `find dist -name "*.test.*"` / `profiles/verity/` 没被意外创建——全部重新核对通过。
- **交回**:这个修复批次已经推送到 `feature/issue-1-a0-a1-scaffold`,交回 Zorro 重审(不是一个新的 Cypher 功能批次)。

## 决定日志(可追溯)
- 2026-07-20:包管理器从 npm 换成了 **pnpm**(这一轮指挥官的一次中途更正)。从 B0 起没有产生任何 npm 残留(`package-lock.json`/一个扁平的 `node_modules`)——package.json 先写好,第一次 `install` 之前就切到了 pnpm,不需要清理。lockfile = `pnpm-lock.yaml`。
- 2026-07-20:`build` script 用的是 `tsc -p tsconfig.build.json`(一个新文件),而不是 PRD §5 字面写的普通 `tsc`——理由见上面的 B0 条目(dist 干净度)。`lint` 依然是普通的 `tsc --noEmit`,这里没有偏离。
- 2026-07-20:`tsconfig.json` 加了 `"types": ["node"]`(PRD 里没提到;是 pnpm 下必须的修复,不是一个设计决定,记录作可追溯的环境事实)。
- 2026-07-20(B2):FTS5 的 `MATCH` 条件必须用虚拟表的真实名字(`memories_fts MATCH ?`),不能用 `FROM ... alias` 子句里的别名(`f MATCH ?` → `SqliteError: no such column: f`)。通过真实机器 spike 实证发现的,不是凭空假设的。
- 2026-07-20(B4):`ConfirmationService.reject()` 不清空 `memories.confirmed_at`/`confirmed_by`(保留历史确认事实),只通过一行 `memory_confirmations` 审计记录 reject 这个动作本身的 actor/时间戳——这是 PRD §9.0#5("基于含义实现")授权范围内的一个具体设计选择,没有拿回给指挥官(理由记在 `confirmation.ts` 的类 docstring 里,可追溯)。
- 2026-07-20(B5):`ContextInjector` 的"stale 优先于 unconfirmed"警告优先级是一个实现层选择(DESIGN §3 没规定两者同时为真时怎么呈现),已经在 `injector.ts` 的注释里明确标注为非规格事实。
- 2026-07-20(B6):`ClaimSchema` 的字段范围是一个实现层选择——只保留模型能自报的部分(`claimText`/`confidence`/`sourceRef`/`verifiedBy`),排除了 `structured_claims` 里那些只有 Harness/Loop 事后才能填的列(`model_used`/`provider_used`/`tool_exec_checked`/`run_id`/`id`/`created_at`)。没有拿回给指挥官——理由记在 `schema.ts` 的文件头注释里,而且 PRD §5 的措辞("不含 run_id 这类持久化列")本身已经授权了这个收窄范围。
- 2026-07-20(B8):角色→schema 的映射用的是一个 `Record<string, z.ZodType>` 常量(`OUTPUT_SCHEMAS`),而不是文件系统扫描——因为本增量的 schema(`CoderOutput`/`TesterOutput`)是 B6 定义的固定命名导出,跟 persona 遵循的"目录就是 registry"文件惯例不一样;这是 DESIGN §1.7"按角色名通过 registry 动态查找"的字面实现(一个键查找,零 `if role===` 分支),但落地形式跟 persona loader 不一样——两者的不对称在 `composer.ts` 的注释里做了说明。
- 2026-07-20(B8):当一个角色不在 `OUTPUT_SCHEMAS` 里(有 persona 但没有结构化 schema)时,`compose()` 静默省略"Output Schema"这一段而不是抛错——不是规格事实,是一个偏向可扩展性的实现选择("加一个角色不强制它也得有 schema")。
- 2026-07-20(B9):`src/index.ts` 的 barrel 在 B9 才补上三个 `prompt/*` 模块的重导出(而不是各自模块自己的批次)——因为 B9 本身就是证明"各层真的接上了"的收尾点,顺手了结 barrel 这个尾巴是一致的;B6/B7/B8 各自的批次都只专注单个文件、没有回头补——这不是疏漏,只是延后到收尾批次一起处理。
