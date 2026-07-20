---
feature: a0-a1-engine-scaffold-context-prompt
status: done
last_updated: 2026-07-20
---

# Progress — A0+A1 引擎脚手架 + Context/Prompt 层

> 边写边更。每批做完追加一条:做了什么 + 本地自检结果 + 可追源的证据。

> **▶ 下一步(RESUME 指针)**:**B0-B11 全部完成。** B0-B10 是初次 build;首轮 Zorro 独立审判 **FAIL**(路径穿越安全洞 + FTS5 召回崩溃 + ContextInjector 死代码 + composer schema 硬编码 + 文档幻觉根因),B11 是修复批次,同分支 `feature/issue-1-a0-a1-scaffold` 提交。下一步是把 B11 交回 Zorro 复审,不是新的 Cypher 功能批次。

## B6-B9(Prompt 层 + 垂直切片)收尾摘要

- 状态:**全部完成**,四批依序提交 + push 到 `feature/issue-1-a0-a1-scaffold`(commit `4e6ff3a`/`88852a5`/`64e8240`/`4eb97e4`)。
- 质量门:`pnpm build`(tsc strict + noUncheckedIndexedAccess)/`pnpm lint`(tsc --noEmit)/`pnpm test`(vitest run)全绿,**96/96** 测试通过(61 既有 + 18 B6 + 6 B7 + 9 B8 + 2 B9 = 96,净增 35 条;**此行数字已订正**,原文写"8 B6 + 6 B7"与下方 B6/B7 各批次条目实际数字不符,B7 的"+8"更正见该批次条目)。
- 跨层依赖检查:`grep -n "^import" src/prompt/*.ts`(不含测试文件)确认 `composer.ts` 仅 `import type { ContextInjectionResult, InjectedMemory, InjectionWarning } from "../context/injector.js"`(输出类型)+ `Role` from `../shared/types.js`——零 import `MemoryStore`/`StalenessEngine`/`ContextInjector` 类本身,零 import harness/loop(不存在)。
- 详情见下方 `### B6`-`### B9` 各批次条目。

## B2-B5(Context 层)收尾摘要

- 状态:**全部完成**,四批依序提交 + push 到 `feature/issue-1-a0-a1-scaffold`(commit `0eea001`/`d2af34d`/`b24fa3f`/`06259c9`)。
- 质量门:`pnpm build`(tsc strict + noUncheckedIndexedAccess)/`pnpm lint`(tsc --noEmit)/`pnpm test`(vitest run)全绿,**61/61** 测试通过。跨层反向依赖检查(`grep` `src/context/*.ts` 的 import)确认零命中 harness/loop/prompt。
- 详情见下方 `### B2`-`### B5` 各批次条目。

- **关联 PRD**:`./PRD.md`(批次拆解见 §6,共 B0-B10)
- **分支**:`feature/issue-1-a0-a1-scaffold`(单分支,批次顺序提交)
- **关联 issue**:[elishawong/aeloop#1](https://github.com/elishawong/aeloop/issues/1)

## 批次进度

### B0 — package.json / tsconfig / vitest.config / .env.example / index.ts barrel / shared/types.ts
- 状态:完成
- commit:`c19dff3` — `chore(scaffold): B0 — pnpm + TS strict/ESM/NodeNext project skeleton`
- 做了什么:
  - `package.json`:`"type": "module"`,deps `zod@^4.4.3` / `js-yaml@^5.2.1` / `better-sqlite3@^12.11.1`,devDeps `typescript@^7.0.2` / `vitest@^4.1.10` / `@types/node@^24.13.3` / `@types/js-yaml@^4.0.9` / `@types/better-sqlite3@^7.6.13`。scripts:`build`/`test`/`test:watch`/`lint`。
  - `tsconfig.json`:`strict` + `noUncheckedIndexedAccess` + `module`/`moduleResolution: NodeNext` + `outDir: dist` + `rootDir: src`。
  - **一处偏离 PRD 字面(有意为之,已记录理由)**:PRD §5 写 `build` script 是纯 `tsc`;实现时改为 `tsc -p tsconfig.build.json`(新增 `tsconfig.build.json`,`extends` 主 tsconfig 并 `exclude` 测试文件)。原因:若 `build` 直接用主 tsconfig,`*.test.ts` 会被一起编译进 `dist/`,污染 `npm i -g` 分发内容(PRD §5 构建/分发小节 + DESIGN §8.5 #8 明确关心 dist 干净度)。`lint`(`tsc --noEmit`)仍吃主 tsconfig,测试文件的类型错误照样能被 lint 抓到,不影响验收标准里"所有 JSON/YAML.parse 调用点类型化"这条的覆盖面。
  - `.env.example`:`AI_AGENT_PROFILE=helix` + `LITELLM_BASE_URL`/`LITELLM_TOKEN` 占位(注释标明仅 verity 用)。
  - `src/index.ts`(barrel,B0 时只 re-export `shared/types.ts`,B1 追加)、`src/shared/types.ts`(`Role` 开放字符串 + `ISODateString`)。
- **⚠️ 地基 spike 结论(PRD §9.0#2 要求项)**:
  - 用临时文件 `src/shared/spike.tmp.test.ts`(未提交,验完即删)在 pnpm 装好的依赖下跑通:ESM + NodeNext + `better-sqlite3`(原生模块,含 FTS5 虚拟表建表/写入/`MATCH` 查询)在 vitest 下正常工作,无阻塞。`pnpm run build` 同样干净通过。
  - **真撞上一个坑,已现场修复,如实记录**:默认 tsconfig(无 `types` 字段)下,`tsc` 在 pnpm 的非扁平 `node_modules` 布局里**不会自动发现 `@types/node`**,导致 `node:fs`/`node:path`/`process`/`import.meta.url` 等全部报 `TS2591 Cannot find name`(npm 扁平布局下这个问题不会出现,这是 pnpm 特有的)。**修复**:`tsconfig.json` 显式加 `"types": ["node"]`。加完后 `tsc --noEmit` 干净通过,已验证 `node_modules/@types/node` 的 symlink(指向 `.pnpm/@types+node@24.13.3/...`)本身没问题,只是需要显式声明。这条已写进 B0 commit message,供后续增量/其他 pnpm 项目参考,不用重踩。
  - 结论:ESM + better-sqlite3 + vitest + pnpm 组合本身没有真实阻塞,只有上述一处需要显式配置的已知坑,已在 B0 一并修好,未擅自改回 CommonJS 或改用 npm。
- 本地自检:`pnpm install`(better-sqlite3 原生绑定通过 `prebuild-install` 装好,无编译报错)→ `pnpm run build`(`tsc -p tsconfig.build.json` 无报错)→ `pnpm run test`(spike 测试 1/1 通过,之后已删除)。

### B1 — src/profile/loader.ts + errors.ts + loader.test.ts + profiles/helix/{config.yaml, personas/{coder,tester}.md}
- 状态:完成
- commit:`948fd24` — `feat(profile): B1 — AI_AGENT_PROFILE loader + helix example profile`
- 做了什么:
  - `src/profile/errors.ts`:`ProfileNotFoundError`(缺席场景专用,携带 `profile`/`profileDir`)、`ProfileConfigParseError`(YAML 语法错误或非 mapping 根,用标准 `Error#cause` 包裹原始错误,不裸抛)。
  - `src/profile/loader.ts`:
    - `loadProfile(profile?, profilesRoot?): ProfileLoadResult`——`AI_AGENT_PROFILE` 未传时读环境变量(默认 `"helix"`);`profiles/<name>/` 相对**本模块自身位置**(`import.meta.url`)解析,不依赖 `process.cwd()`(因为 aeloop 是 `npm i -g` 全局 CLI,用户执行目录和包安装目录不是一回事;`src/profile/` 和编译后 `dist/profile/` 到 `profiles/` 的相对深度一致,同一套 `../../profiles` 在两种场景都对)。
    - 缺席(如 `profiles/verity/` 不存在)→ **返回类型化 `{ ok: false, error: ProfileNotFoundError }` 结果,不抛**(严格对齐 PRD §8 验收标准原文"返回类型化『未找到』结果而非抛裸异常")。
    - `config.yaml` 存在但解析失败(YAML 语法错误 / 根节点不是 mapping)→ **抛** `ProfileConfigParseError`(真配置错误,和"缺席"是不同性质,语义上区分对待)。
    - `substituteEnvPlaceholders()`:递归替换字符串值里的 `${ENV_VAR}`;env 未设置时保留原始占位符字符串(不静默变成 `""`),导出为独立可测函数。
  - `profiles/helix/config.yaml`:最小示例,对齐 DESIGN §7 结构(`providers.claude-cli`/`codex-cli` 占位、`roles.coder`/`roles.tester`、`workflow.reject_threshold: 2`)。
  - `profiles/helix/personas/{coder,tester}.md`:纯文本、厂商无关的最小示例人格。
  - `src/index.ts` 追加 re-export `profile/loader.js` + `profile/errors.js`。
- **⚠️ 二个坑,已现场修复,如实记录**(均记进 B1 commit message):
  1. **`@types/node` 在 pnpm 下需要显式 `"types": ["node"]`**——见 B0 记录,B1 写代码时才实际触发报错(`node:fs`/`node:path`/`node:url`/`process` 全报 `TS2591`),已在 B0 的 tsconfig 里修好,B1 直接受益。
  2. **`js-yaml@5.x` 的 ESM 构建(`dist/js-yaml.mjs`)没有 default export,只有具名导出**(`load`/`dump`/…)。最初写成 `import yaml from "js-yaml"; yaml.load(...)`,`tsc` 类型检查竟然通过,但**运行时** `yaml.load` 是 `undefined`(`TypeError: Cannot read properties of undefined (reading 'load')`),被 vitest 抓到——这正是"lint 过不代表真的跑得通"的活教材。**修复**:改成具名导入 `import { load as loadYaml } from "js-yaml"`。
     **⚠️ 根因更正(Zorro 复审 `feature/issue-1-a0-a1-scaffold` 指出,`tsc --traceResolution` 实测证伪原记录,2026-07-20 补记)**:本条最初记录"`tsc` 类型检查通过是因为 `@types/js-yaml@4.0.9` 是给 js-yaml 4.x 老 API 写的类型,和 5.x 实际产物对不上"——这个归因是**错的**,未经验证就写下的猜测。真机核实(`npx tsc --noEmit --traceResolution 2>&1 | grep js-yaml`)显示:TypeScript 解析 `js-yaml` 时走的是它自己 `package.json` 的 `exports`/`types` 字段(`"types": "./dist/js-yaml.d.ts"`),**直接解析到 js-yaml 5.x 包自带的 `dist/js-yaml.d.ts`,`@types/js-yaml@4.0.9` 从头到尾没被 `tsc` 碰过一次**——`@types/js-yaml` 是彻底的死依赖,不是"旧但被用到、只是形状对不上"。`import yaml from "js-yaml"; yaml.load(...)` 之所以类型检查能通过,真正原因是 `tsconfig.json:11` 的 `"esModuleInterop": true`——这个选项允许对一个只有具名导出、没有 default export 的模块写 `import x from "..."` 语法并在类型层面合成一个默认导出,和 `@types/js-yaml` 版本新旧完全无关,js-yaml 5.x 自带的 `dist/js-yaml.d.ts`(真正被 `tsc` 使用的那份类型)同样只有具名导出(`export { ... }`),`esModuleInterop` 才是让这行代码"类型检查过但运行时崩"的唯一原因。
     **处理(本条 B1 遗留 `[?]` 已收敛,不再是遗留项)**:`@types/js-yaml` 是从未被使用的死依赖,已 `pnpm remove @types/js-yaml`(devDependencies 去掉这一项);`pnpm build`/`pnpm lint`/`pnpm test` 去掉后仍全绿(js-yaml 5.x 自带类型顶上,无需它)。PRD §5 devDeps 清单同步去掉 `@types/js-yaml` 这一条(见 PRD.md 改动)。
- 本地自检:`pnpm run build`(`tsc -p tsconfig.build.json`,`dist/` 只有 `index`/`shared/types`/`profile/{errors,loader}` 六组文件,无测试文件泄进去)→ `pnpm run lint`(`tsc --noEmit`,含测试文件类型检查,无报错)→ `pnpm run test`(`vitest run`,**9/9 通过**:helix 正常加载、`AI_AGENT_PROFILE` 未设默认 helix、verity 缺席返回类型化结果、通用缺失 profile 目录场景、YAML 语法错误抛类型化错误、非 mapping 根抛类型化错误、`${ENV}` 已设值替换、`${ENV}` 未设值保留占位符、`substituteEnvPlaceholders` 递归单测)。
- `git status` 确认:`profiles/verity/` 未被误建(本增量完全没创建它),`.gitignore` 对 `dist/`/`node_modules/` 生效(`git status --ignored` 确认)。

### B2 — context/types.ts + errors.ts + util.ts + store.ts(建表+FTS5+CRUD+召回)+ store.test.ts
- 状态:完成
- commit:`0eea001` — `feat(context): B2 — MemoryStore (SQLite+FTS5 store, RecallError not silent)`
- 做了什么:
  - `types.ts`:`Memory`/`MemoryConfirmation`/`SystemConfigEntry`/`ConfidenceState`/`MemoryType`(12 种闭合枚举,对齐 DESIGN §5 注释),camelCase 域类型,和 SQLite 行(snake_case)分离,映射在 store.ts 内完成。
  - `errors.ts`:`RecallError`(读失败包装)、`MemoryTagsParseError`(tags JSON 解析失败)、`ConfirmationError`(预留,B4 未实际抛出,仅声明)、`MemoryNotFoundError`。
  - `store.ts`(`MemoryStore` 类,接受显式 `dbPath`,`:memory:` 供测试):
    - `createSchema()`:`CREATE TABLE IF NOT EXISTS` 三表(含 §4.1 全部列,补齐 `confirmed_at`/`confirmed_by`/`actor`/`updated_at` 四个 aeloop 新补列)+ `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)`(external content 模式,`content='memories'`/`content_rowid='id'`)+ insert/update/delete 三个同步触发器。
    - CRUD:`insertMemory`/`getMemoryById`/`listMemories`/`deleteMemory`/`updateMemoryConfidence`/`updateMemoryContent`/`insertConfirmation`/`getConfirmationsForMemory`/`getConfigEntry`/`setConfigEntry`。
    - **错误包装约定(已写进类注释)**:所有*读*方法(`getMemoryById`/`listMemories`/`searchMemories`/`getConfirmationsForMemory`/`getConfigEntry`)把抛出的 SQLite 错误包成 `RecallError`;*写*方法让 `better-sqlite3` 自己的 `SqliteError` 原样穿透(不是"recall",没有"静默降级成空结果"的诱惑,不需要额外包装)。
    - `searchMemories(query)`:`SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY rank`(真机验证:先用 alias 写 `f MATCH ?` 报 `SqliteError: no such column: f`,改成直接用真实表名 `memories_fts MATCH ?` 才对——已记录在 commit 里,不是凭空写对的)。
    - `runInTransaction<T>(fn)`:`this.db.transaction(fn)()` 直通,供 B4 `ConfirmationService` 复用。
  - **⚠️ 一个坑,已现场修复,如实记录**:FTS5 MATCH 条件不能对 alias 生效(`f MATCH ?` → `no such column: f`),必须用虚拟表真实名字(`memories_fts MATCH ?`)。这是本批开工前用一份临时 spike 测试(`spike.tmp.test.ts`,验完即删,未提交)实测发现并修复的,不是凭记忆写的 SQL。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**28/28 通过**(9 条既有 profile loader + 19 条新增:schema 往返含全部列、幂等重开、CRUD、`MemoryNotFoundError` 缺失路径、tags 非法 JSON → `MemoryTagsParseError`(两种畸形:非 JSON 字符串 / 解析出但不是字符串数组)、FTS5 召回命中+空结果、触发器同步(update/delete 后旧关键词不再命中、新关键词命中)、**RecallError 触发路径**(畸形 FTS5 MATCH 语法 `"unterminated phrase` 触发,断言 `instanceof RecallError`)、事务回滚(`runInTransaction` 内抛错,断言 memories 写入和 confirmation 插入都完整回滚)。

### B3 — context/config.ts(SystemConfig)+ staleness.ts(StalenessEngine)+ 对应测试
- 状态:完成
- commit:`d2af34d` — `feat(context): B3 — SystemConfig + StalenessEngine`
- 做了什么:
  - `config.ts`:`SystemConfig` 类包装 `system_config` 读写,引擎级默认值 `DEFAULTS = { default_stale_days: "30", default_reject_threshold: "2" }`(未写入过的 key 读默认值,未知 key 返回 `undefined`);`getDefaultStaleDays()`/`getDefaultRejectThreshold()` 两个类型化数字读取器,值不可解析时返回 `null` 而非抛错或 `NaN`。
  - `staleness.ts`:`StalenessEngine.isStale(memory, asOf = new Date())`——`memory.staleOverrideDays` 优先,否则读 `config.getDefaultStaleDays()`;两者都拿不到阈值时永不 stale;`asOf` 显式参数化,测试不用假系统时钟。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**41/41 通过**(新增 13 条:默认值回退、未知 key、`set()` 覆盖+`updated_at` 戳记、不可解析值返回 `null`、staleness 未过期/已过期两种边界、无阈值永不 stale、`stale_override_days` 双向覆盖测试——覆盖"override 让记忆比默认值更早 stale"和"override 让记忆比默认值更晚 stale"两个方向)。

### B4 — context/confirmation.ts(ConfirmationService)+ confirmation.test.ts
- 状态:完成
- commit:`b24fa3f` — `feat(context): B4 — ConfirmationService (confirm/correct/reject, transactional)`
- 做了什么:
  - `confirmation.ts`:`ConfirmationService.confirm(memoryId, actor, now?)` / `.correct(memoryId, newContent, actor, now?)` / `.reject(memoryId, actor, now?)`,三方法均 `store.runInTransaction(() => {...})` 包裹 memories 写 + `memory_confirmations` 插入。
  - **`correct()` 语义(PRD §9.0#5 自实现,未读 Verity 内网源码)**:`old_content` 永远取"调用前那一刻"的 `memory.content`(不是原始插入值),让连续 `correct()` 调用正确接续("latest" 而非 "original")。`correct()` 同时把 `confidence_state` 标为 `confirmed`(修正内容本身就是对新内容的一次确认)。
  - **`reject()` 语义**:置 `confidence_state = 'rejected'`,但**刻意不清空** `confirmed_at`/`confirmed_by`——这两列记的是"上一次被确认的时间/人",拒绝不该抹掉这段历史事实;完整动作历史始终在 `memory_confirmations` 里(reject 自己那一行有独立的 `actor`/时间戳)。此设计决策已写进类头注释。
- **必修项断言点**(逐条落到测试文件的哪个 `it`):
  - **事务原子性**(`describe("ConfirmationService — transaction atomicity ...")`,3 条 `it`):`vi.spyOn(store, "insertConfirmation").mockImplementation(() => { throw ... })`,在 `confirm()`/`correct()`/`reject()` 各自的 memories 写入**已经执行完**之后注入失败;断言点——`confirm`:回滚后 `getMemoryById().confidenceState === "unconfirmed"` 且 `confirmedAt`/`confirmedBy` 仍为 `null`;`correct`:回滚后 `content` 仍是 `"original"`(没被改成新内容)且 `confidenceState` 仍 `"unconfirmed"`;`reject`:回滚后 `confidenceState` 仍 `"unconfirmed"`(没被误标成 `"rejected"`)。三条都额外断言 `store.getConfirmationsForMemory(id)` 为空数组(没有半条审计行残留)。
  - **无既有确认记录路径**(`correct()` 两条 `it`):第一条在**从未调用过 confirm/correct/reject** 的全新 memory 上直接调 `correct()`,断言 `getConfirmationsForMemory` 调用前为 `[]`、调用后 `old_content` 等于原始插入内容;第二条紧接着再调一次 `correct()`,断言第二条 confirmation 行的 `old_content` 等于**第一次 correct 后的新内容**(不是最初的原始内容),证明"latest"语义真的生效而不是巧合。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**52/52 通过**(新增 11 条)。

### B5 — context/injector.ts(ContextInjector)+ injector.test.ts
- 状态:完成
- commit:`06259c9` — `feat(context): B5 — ContextInjector (filters rejected, warns stale/unconfirmed)`
- 做了什么:
  - `injector.ts`:`ContextInjector.inject(query?, asOf?)`——`store.listMemories()`(核心全量)+ 可选 `store.searchMemories(query)`(FTS5 召回),按 id 用 `Map` 去重合并;过滤 `confidence_state === 'rejected'`;对剩余记忆逐条计算警告(`isStale` 优先于 `unconfirmed`,两者都为真时"stale"赢——DESIGN 未明确此优先级,已在代码注释里标注这是实现层决策而非规格事实)。**不 import `src/prompt/` 任何东西**(已用 `grep` 核实,见下方跨层检查)。`RecallError` 从 `store.searchMemories()` 直接穿透,`inject()` 不捕获。
- **必修项断言点**(滤 rejected 的针对性测试,逐条落到测试文件的哪个 `it`):`describe("ContextInjector — rejected memories are filtered out (PRD §8 required test)")` 下两条 `it`——① 核心全量集合里混入一条 `confidenceState: "rejected"` 的记忆,断言 `result.memories` 的 id 列表包含 confirmed 那条、**不包含** rejected 那条;② 单独一条 `it` 验证即便一条 rejected 记忆能被 FTS 关键词命中(`inject("zebra", ...)`),它依然不出现在结果里——证明过滤发生在"核心+召回合并之后",不是只对核心集合生效的半吊子实现。
- 本地自检:`pnpm build`/`pnpm lint`/`pnpm test` 全绿,**61/61 通过**(新增 9 条:上述滤 rejected 2 条 + stale/unconfirmed 保留带警告 4 条(含双重命中优先级)+ 核心/召回合并去重 2 条 + RecallError 穿透 1 条)。
- **跨层反向依赖检查**:`grep -rn "^import" src/context/*.ts` 逐行核对,全部命中要么是 `./`(context 内部)要么是 `../shared/types.js`,零命中 `../prompt`/`../harness`/`../loop`。`dist/` 未被 track(`git ls-files | grep '^dist/'` 空)。

### B6 — prompt/schema.ts(ClaimSchema/CoderOutput/TesterOutput,zod)+ schema.test.ts
- 状态:完成
- commit:`4e6ff3a` — `feat(prompt): B6 — ClaimSchema/CoderOutput/TesterOutput (zod)`
- 做了什么:
  - `ClaimConfidence`(`verified`/`inferred`/`unconfirmed`/`stale`,对齐 DESIGN §5 `structured_claims.confidence`)、`VerifiedBy`(`tool_execution`/`human`/`unverified`,对齐 `structured_claims.verified_by`)两个 zod enum。
  - `ClaimSchema`:`claimText`(非空字符串)+ `confidence`(必填)+ `sourceRef`/`verifiedBy`(均可选,`sourceRef` 非空字符串)。**范围决策**(已写进文件头注释):刻意排除 `structured_claims` 里只有引擎处理完模型输出后才会有的列——`id`/`run_id`/`created_at`(持久化簿记)、`model_used`/`provider_used`(Harness 才知道跑的是哪个模型)、`tool_exec_checked`(ToolExecVerifier 事后算出的结果,A3)。剩下的 `claim_text`/`confidence`/`source_ref`/`verified_by` 正是模型能合理自报的部分,对齐 PRD §5"不含持久化列如 run_id"。
  - `CoderOutput`(`diff` 非空字符串 + `claims: ClaimSchema[]` + 整体 `confidence`)、`TesterOutput`(`verdict: "pass"|"reject"`,对齐 DESIGN §4 状态机"通过"/"打回" + `issues: string[]`(非空字符串)+ `claims` + `confidence`),均对齐 DESIGN §3 sequence 图的 `{diff, claims[], confidence}` / `{verdict, issues[], confidence}`。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+18 条新增**(合法/非法输入各字段边界:缺字段、空字符串 min-length、枚举外的值、数组元素非法、`claims`/`issues` 非数组)。

### B7 — prompt/personas.ts(动态角色 persona loader)+ personas.test.ts
- 状态:完成
- commit:`88852a5` — `feat(prompt): B7 — dynamic persona loader (role -> personas/<role>.md)`
- 做了什么:
  - `resolvePersonaPath(role, personasDir)` + `loadPersona(role, personasDir)`:纯字符串键查找 `<personasDir>/<role>.md`,**零 `if role === ...` 分支**(DESIGN §1.7)——`personas/` 目录本身就是角色 registry,加角色只需落一个新 `.md` 文件,不改这个 loader 的代码。`personasDir` 是显式参数(不隐式耦合 profile),延续 `store.ts`(显式 `dbPath`)/`profile/loader.ts`(显式 `profilesRoot`)已有的模式。
  - `PersonaNotFoundError`(role + personaPath):文件缺失时的类型化错误,不裸抛 `ENOENT`。
- **必修项断言点**(角色 persona 文件缺失路径,PRD §8):`describe("loadPersona — missing persona file...")` 两条 `it`——① 目录存在但目标角色 `.md` 缺失;② 整个 `personasDir` 目录都不存在。均断言 `instanceof PersonaNotFoundError` + `.role`/`.personaPath` 字段正确。另有一条"动态加载任意新角色,只需落文件不改代码"的针对性测试(临时目录写一个 `reviewer.md`,验证零代码改动即可加载)。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+6 条新增**(真实 helix coder/tester persona 加载 2 条 + 动态新角色 1 条 + 缺失路径 2 条 + `resolvePersonaPath` 单测 1 条 = 6,共细分见测试文件)。**订正(Zorro 复审指出)**:本条原写"+8 条新增",与自己枚举的 2+1+2+1=6 及 `personas.test.ts` 实际 `it()` 数不符,已改正为 6(B10/顶部摘要处同步订正)。

### B8 — prompt/composer.ts(PromptComposer)+ composer.test.ts
- 状态:完成
- commit:`64e8240` — `feat(prompt): B8 — PromptComposer (persona + schema + injected memories)`
- 做了什么:
  - `PromptComposer`(构造函数接受显式 `personasDir`)`.compose(role, context: ContextInjectionResult, task): string`——拼出:persona 文本(`loadPersona`)+(角色在 schema registry 里有条目时)schema 说明(`z.toJSONSchema(schema)` 序列化成 JSON,不是手写重复一份和 zod 定义可能漂移的文字说明)+ 注入的记忆(逐条渲染 `- [warning: stale|unconfirmed] 标题\n  内容`,`warning: null` 时不带标记)+ 任务描述。
  - **schema registry**(`OUTPUT_SCHEMAS: Record<string, z.ZodType>` = `{coder: CoderOutput, tester: TesterOutput}`)——DESIGN §1.7"persona/schema 按角色名动态查 registry"的 schema 半落地:纯键查找,不是 `if role===` 分支。角色不在 registry 里(有 persona 但没结构化 schema)→ 静默省略"Output Schema"小节,不抛错(已写进类注释,标注为实现层选择:加角色不强制要求同时有 schema)。
  - **依赖方向**(PRD §10 约束,已用 `grep` 核实):只对 `../context/injector.js` 做**类型 only** import(`ContextInjectionResult`/`InjectedMemory`/`InjectionWarning`),零 import `MemoryStore`/`StalenessEngine`/`ContextInjector` 类本身——composer 不知道记忆是怎么查出来、怎么过滤的,只认输出形状。
  - **不重复过滤**:composer 对 `confidenceState` 完全无感,只认 injector 给的 `warning` 字段;`composer.test.ts` 里专门一条测试手工构造一个"混入 `confidenceState: 'rejected'`"的 `ContextInjectionResult`,证明 composer 依然原样渲染——过滤只在 injector 一处发生,不在两处重复/可能矛盾。
- 本地自检:`pnpm build`/`pnpm lint` 无报错;`pnpm test`:**+9 条新增**(coder/tester 角色的 persona+schema+task+记忆渲染、warning 有/无标记、无 schema 条目角色的省略行为、未知角色 persona 缺失时 `PersonaNotFoundError` 透传、不重复过滤断言、空记忆列表渲染)。

### B9 — src/context-prompt.e2e.test.ts(硬性垂直切片,A1 收尾)
- 状态:完成
- commit:`4eb97e4` — `test(e2e): B9 — Context -> Prompt vertical slice, no mocking across the seam`
- 做了什么(真实数据流,零 mock 跨层调用):
  1. **真实 `MemoryStore`**(`:memory:` 真 SQLite,非 stub)`insertMemory()` 写 3 条真实记忆:confirmed(`"aeloop uses pnpm as its package manager."`)/ unconfirmed(`"The API rate limit is believed to be 100 requests/min."`)/ rejected(`"The context store uses MySQL for persistence."`);写入后立即 `store.listMemories()` 核对 3 条真的落库,不是空跑。
  2. **真实 `ContextInjector`**(接同一个 `store` + 真实 `StalenessEngine`/`SystemConfig`)`.inject()` —— 断言其返回值本身(不是任何加工后的副本)已滤掉 rejected、保留 confirmed/unconfirmed。
  3. **真实 `PromptComposer`**(指向真实已提交的 `profiles/helix/personas/`)`.compose("coder", injected, "Implement the retry-backoff helper.")`——`injected` 是上一步 `injector.inject()` 的**原始返回值**直接传入,composer 内部零改造直接消费。
  4. **断言最终 prompt 字符串**:包含 confirmed 内容(`"aeloop uses pnpm as its package manager."`,含精确格式 `"- Build tooling\n  aeloop uses..."`)、**不包含** rejected 内容(两种断言:内容原文 + 标题)、包含 unconfirmed 内容且带 `"[warning: unconfirmed] Rate limit guess"` 可见标记、包含 persona 文本(`"You are the Coder in a two-model coder/tester loop."`)、包含 schema 片段(`'"diff"'`)、包含任务描述。
  - **第二条测试**(同一切片,走 `ConfirmationService.reject()` 而非插入时直接给 `confidenceState: "rejected"`):证明"记忆先 unconfirmed、之后经服务被拒绝"这条更真实的路径,过滤同样在端到端链路里生效,不只是插入时的捷径特例。
  - **未 mock 任何跨层调用**:`grep` 该测试文件的 import,只有 `MemoryStore`/`SystemConfig`/`StalenessEngine`/`ContextInjector`/`PromptComposer`/`ConfirmationService`(动态 `import()`)真实类 + `resolveProfileDir` 定位真实 profile 目录,零 `vi.mock`/`vi.spyOn`。
  - **顺手补齐**:`src/index.ts` 追加 `export * from "./prompt/{schema,personas,composer}.js"`(此前 B6-B8 各批次都专注单文件未回头补 barrel,B9 作为"全部接通"的收尾点一并补上,和 profile/context 层已有模式一致)。
- 本地自检:`pnpm build`/`pnpm lint` 无报错(含新增 barrel export 无命名冲突,已验证 `CoderOutput` 类型+常量同名的 TS 声明合并不冲突);`pnpm test`:**全绿 96/96**(B6-B9 净增 35 条:18(B6)+6(B7)+9(B8)+2(B9)=35,61+35=96,与 vitest 实测总数一致)。
- `git status`/`find dist -name "*.test.*"` 确认:测试文件未泄进 `dist/`,`profiles/verity/` 未被误建。

### B10 — 打包配置核实 + 文档回写(A0+A1 收官)
- 状态:完成
- commit:`b6a6cd1` — `docs(a0-a1): B10 — verify packaging config, wrap up A0+A1 build docs`(**订正**:本行原写"待本批 commit",该状态在这条已经落盘提交之后未回写,已改为真实 commit hash)
- 做了什么:
  - **第 0 步(先做)**:`git merge origin/main`(把 main 上 `a6b8efe` 文档修复——CLAUDE.md §2 技术栈表 + `.claude/skills/run/SKILL.md` 的 npm→pnpm——并进 feature 分支)。**零冲突**(feature 分支未碰过这两个文件),`git log origin/main --oneline feature/issue-1-a0-a1-scaffold..origin/main` 核实合并前只落后这一个 commit。merge 后 `grep -n -i "npm\|pnpm" CLAUDE.md .claude/skills/run/SKILL.md` 确认继承的 pnpm 措辞已在 feature 分支生效。
  - **打包配置核实(PRD §8 倒数第二条)**:`package.json` 无 `.npmignore`(`files` 字段单独生效,B0 已落好 `profiles/*/personas/**/*.md` + `profiles/*/config.yaml`)。用 `pnpm pack` 实打一个 tarball,`tar -tzf aeloop-0.0.1.tgz | sort` 核实:① `package/profiles/helix/personas/{coder,tester}.md` + `package/profiles/helix/config.yaml` 确实在包内,`pnpm add -g` 会分发到位;② `package/dist/**` 只有 `.js`/`.d.ts`/`.js.map`,**零** `*.test.*` 文件泄漏。验证完 `rm -f aeloop-0.0.1.tgz`,`git status --short` 确认无残留。**结论:无需改动,B0 的打包配置已经是对的。**
  - **JSON.parse / YAML.load 复核**(PRD §8 倒数第 4 条):`grep -rn "JSON.parse" src --include="*.ts"` 排除测试文件后唯一命中 `store.ts:209`(tags 反序列化,包在 try-catch → `MemoryTagsParseError`);`profile/loader.ts` 的 `loadYaml(...)` 同样包在 try-catch → `ProfileConfigParseError`。均已在各自批次(B1/B2)落地,B10 只是复核确认没有遗漏点。
  - **文档回写**:`docs/ROADMAP.md` A1 四条 `[ ]` 全部改 `[x]` 并补 commit 引用 + 新增"打包配置核实+文档回写"一条(对应本批);`docs/PROGRESS.md` 清空回「无进行中批次」空模板(A0+A1 已完,下一步是 `/verify` 不是新批次);`CHANGELOG.md` 顶部加一行 A0+A1 build 完成摘要;根 `CLAUDE.md` §2 技术栈表脚注 + §3 目录结构图更新"src/ 尚未建"这类过期状态描述为真实现状(A0+A1 已建 prompt/context/profile/shared,harness/loop/cli 待 A2+;langgraph/checkpoint-sqlite/ajv 尚未装,不再混称"已验证可装"),**未删任何规则/红线,只改状态描述**;PRD §8 十一条验收标准逐条核实并打钩(见上方 §8,每条附commit/验证方式引用)。
- 本地自检(最终全量质量门,真机跑):
  - `pnpm build`(`tsc -p tsconfig.build.json`)—— 无报错。
  - `pnpm lint`(`tsc --noEmit`)—— 无报错。
  - `pnpm test`(`vitest run`)—— **10 test files / 96 tests 全部 passed**,与 B9 收尾时的 96/96 一致(B10 未新增/删除任何 `src/` 测试)。
  - `git status --short` 确认工作区干净;`find dist -name "*.test.*"` 空;`profiles/verity/` 未被误建(`ls profiles/` 只有 `helix/`);`git check-ignore -v profiles/verity/anything` 命中 `.gitignore:16`,规则生效。
- **A0+A1 增量 build 收官**:B0-B10 全部完成,分支 `feature/issue-1-a0-a1-scaffold` 已推送到 `origin`,下一步交 Zorro `/verify` 独立审。

### B11 — Zorro 首轮复审 FAIL 返工(安全洞 + FTS5 崩溃 + 死代码 + composer 硬编码 + 文档幻觉)
- 状态:完成,同分支 `feature/issue-1-a0-a1-scaffold` 顺序提交(每条阻塞项独立 commit,见下方逐条)。
- **背景**:Zorro(Codex 独立引擎)对 B0-B10 判 **FAIL**,五条阻塞项(路径穿越、FTS5 召回崩溃、ContextInjector 死代码、composer schema 硬编码、progress.md 根因幻觉)+ 两条建议改。本批逐条修复,交回 Zorro 复审。
- **① 路径穿越 → 本地文件外泄(安全,最高优先)**:
  - 根因:`src/prompt/personas.ts`(`loadPersona`)和 `src/profile/loader.ts`(`loadProfile`)把外部传入的 `role`/`profile` 字符串直接 `path.join` 进文件路径再读取,无 containment 检查。**真机复现**(修复前):`loadPersona("../../../CLAUDE", "./profiles/helix/personas")` 返回仓库根 `CLAUDE.md` 的完整内容(`node --experimental-strip-types` 实测,见本轮修复过程记录)。
  - 修法:新增 `src/shared/safe-path.ts`(两层防御,`personas.ts`/`loader.ts` 共用):① `isSinglePathSegment`——拒绝含 `/`、`\`、`..`、绝对路径的输入;② `isContainedRealpath`——`fs.realpathSync` 解析后二次核验最终路径仍在 `personasDir`/`profilesRoot` 内(防符号链接逃逸)。`personas.ts` 新增 `InvalidRoleNameError`,`profile/errors.ts` 新增 `InvalidProfileNameError`,均在触碰文件系统前抛出。
  - 断言点:`personas.test.ts`/`loader.test.ts` 各新增一组"path traversal is blocked"测试——① 真实复现原 exploit 字符串(`"../../../CLAUDE"`)现在抛 `InvalidRoleNameError`/`InvalidProfileNameError`;② 更深层遍历、绝对路径、反斜杠、裸 `..`;③ `"..%2F..%2Fsecrets"` 这类 URL 编码字符串证明是惰性的(没有解码逻辑,不构成穿越,落到正常的"未找到"路径);④ 符号链接逃逸(`symlinkSync` 真实建软链指向临时目录外的秘密文件,验证被挡)。`src/shared/safe-path.test.ts`(新增)对两个底层函数本身也做了直接单测。
- **② 正常任务文本让 FTS 召回崩**:
  - 根因:`MemoryStore.searchMemories(query)` 把调用方文本原样传给 FTS5 `MATCH`,连字符(`retry-backoff`)、`C++` 等常见文本触发 FTS5 语法错误。
  - 修法:`store.ts` 新增 `toSafeFtsQuery`——按空白分词、丢弃无字母数字的词、每词转成 quoted phrase(内部 `"` 双写转义)、空格连接(FTS5 隐式 AND)。空/纯标点输入直接短路返回 `[]`,不打 DB。真正的 DB 级错误(如 `memories_fts` 表被删)仍包成 `RecallError` 抛出,不吞。
  - 断言点:`store.test.ts` 新增一组"natural-language query safety"测试——连字符词、`C++`、含标点的完整自然语句(与目标记忆内容共享全部 token,验证 AND 语义下召回仍生效)、原本会报错的 `'"unterminated phrase'` 现在惰性通过、空/纯标点查询返回 `[]`。原来的"RecallError trigger path"测试改为真实 DB 错误路径(`DROP TABLE memories_fts`)触发,不再依赖已被修复的语法错误。
- **③ ContextInjector 的 FTS 召回是死代码 + 测试摆样子**:
  - 根因:`inject()` 的"核心记忆"曾是 `store.listMemories()`(全表),FTS5 召回结果永远是其子集,merge 分支零贡献;`injector.test.ts` 的 merge 断言恒真。
  - 修法:`injector.ts` 新增 `CORE_MEMORY_TYPES`(`identity`/`constraint`/`decision`——Zorro 复审原文举例的"永远要"类型,已在代码注释标注为实现层选择、非规格事实),`inject()` 的核心集合改为按类型过滤,非核心类型只在被 `query` 实际召回时才出现。
  - 断言点:`injector.test.ts` 重写"core vs. recalled"一组测试——① 非核心、未被 query 命中的记忆在无 query 时**缺席**;② 同一条记忆在 query 命中后才出现;③ 核心类型记忆无 query 也存在;④ merge 去重测试改用真核心类型。`context-prompt.e2e.test.ts` 两条测试都改用真实含连字符任务文本(`"Explain the retry-backoff strategy."` / `"Review the retry-backoff change before merging."`)过 `inject()`,不再用 `inject(undefined)` 绕开。
- **④ PromptComposer 硬编码 `{coder,tester}` schema 映射**:
  - 根因:`OUTPUT_SCHEMAS` 是 `composer.ts` 内部私有常量,未知角色静默省略 Output Schema 小节,违反 DESIGN §1.7 的"按角色名动态查 registry"精神(和 persona loader 的动态查找不对称)。
  - 修法:新增 `src/prompt/schema-registry.ts`(`SchemaRegistry` 类型 = `Record<string, z.ZodType | null>`、`DEFAULT_OUTPUT_SCHEMAS`、`SchemaNotRegisteredError`)。`PromptComposer` 构造函数新增可选 `schemas` 参数(默认 `DEFAULT_OUTPUT_SCHEMAS`,不破坏既有调用方)。角色完全不在 registry 里 → 抛 `SchemaNotRegisteredError`(不静默);角色显式注册为 `null` → 视为"故意不要结构化输出",省略小节但不报错(区分"没接线"和"故意不要")。
  - 断言点:`composer.test.ts` 新增/改写——① 显式 `null` 注册仍省略小节;② 完全未注册的角色抛 `SchemaNotRegisteredError`;③ 通过自定义 registry(`{...DEFAULT_OUTPUT_SCHEMAS, reviewer: ReviewerOutput}`)注册新角色 schema,零改 `composer.ts` 即生效。
- **⑤ progress.md 错误根因(幻觉门)+ 删死依赖**:
  - 根因:B1 条目原写"`tsc` 类型检查通过是因为 `@types/js-yaml@4.0.9` 是给 js-yaml 4.x 老 API 写的类型,和 5.x 实际产物对不上"——这是**未经验证的猜测**。真机核实(`npx tsc --noEmit --traceResolution 2>&1 | grep js-yaml`)证明 `tsc` 解析 `js-yaml` 走的是包自身 `package.json` 的 `"types": "./dist/js-yaml.d.ts"`,`@types/js-yaml@4.0.9` 从未被 `tsc` 碰过——是彻底的死依赖。`import yaml from "js-yaml"; yaml.load(...)` 类型检查能过的真正原因是 `tsconfig.json:11` 的 `"esModuleInterop": true`(允许对纯具名导出模块合成默认导入),和 `@types/js-yaml` 新旧无关。
  - 修法:`pnpm remove @types/js-yaml`;`pnpm build`/`pnpm lint`/`pnpm test` 复跑确认去掉后仍全绿(js-yaml 5.x 自带类型顶上)。progress.md B1 条目 + PRD §5 devDeps 清单同步订正(去掉 `@types/js-yaml` 的要求 + 补记根因订正)。
  - 顺手订正的其他文档幻觉/残留(同属本条"文档对账"范畴):B7 测试计数(顶部摘要 + B7 条目原写"+8",实为 6,与自己枚举的 2+1+2+1 求和矛盾,已订正为 6);B10 commit 状态(原写"待本批 commit",该文档在提交之后未回写,已补真实 hash `b6a6cd1`);PRD §9 的 `[?]` 1-5 项(已由 §9.0 指挥官批复收敛为定案,原 `[?]` 标记是文档未回写的残留,已改标"[已定案]"并注明出处)。
- **🟡 建议改(本轮一并修)**:
  - `profile/loader.ts`:新增 `assertProfileConfigShape`——`ProfileConfig` 返回 `ok:true` 前校验 `profile`(字符串)/`providers`(mapping)/`roles`(mapping)三个必需顶层字段存在且类型正确,缺失/类型错 → `ProfileConfigParseError`;替换了原来直接 `as ProfileConfig` 裸类型断言。`loader.test.ts` 新增 5 条测试(缺 `profile`/`providers`/`roles` 各一条 + `providers` 类型错一条 + 真实 helix profile 仍能过的 sanity check)。
  - `confirmation.test.ts` 新增 `correct() -> reject()` 边界测试:锁定"reject 保留最后一次 correct() 写入的 confirmedAt/confirmedBy"这个此前只被"confirm→reject"路径覆盖过的行为,现在补上"correct→reject"路径,防止未来重构悄悄改掉这个有争议的元数据设计决策。
- **本地自检(最终全量质量门,真机跑)**:
  - `pnpm build`(`tsc -p tsconfig.build.json`)—— 无报错。
  - `pnpm lint`(`tsc --noEmit`)—— 无报错。
  - `pnpm test`(`vitest run`)—— **11 test files / 139 tests 全部 passed**(较 B10 收尾 96/96 净增 43 条,逐文件 `it()` 数量核对——`safe-path.test.ts`:新文件 +11;`personas.test.ts`:6→13(+7);`loader.test.ts`:9→21(+12);`store.test.ts`:19→25(+6);`injector.test.ts`:9→13(+4,重写而非纯新增);`composer.test.ts`:9→11(+2);`confirmation.test.ts`:11→12(+1);合计 11+7+12+6+4+2+1=43。`pnpm exec vitest run --reporter=json` 实测总数核对一致)。
  - `pnpm pack` + `tar -tzf aeloop-0.0.1.tgz`:`profiles/helix/{config.yaml,personas/*.md}` 在包内,`dist/` 新增的 `shared/safe-path.*`/`prompt/schema-registry.*` 编译产物齐全,零 `*.test.*` 泄漏;验证完 `rm -f aeloop-0.0.1.tgz`。
  - 跨层反向依赖复核:`grep -n "^import" src/context/*.ts src/prompt/*.ts src/profile/*.ts` 排除测试文件后,新增的 `../shared/safe-path.js` 引用属层内共享工具(不算反向依赖),零命中 `harness`/`loop`;`composer.ts` 对 `../context/injector.js` 仍是纯 type-only import。
  - `src/index.ts` barrel 补齐 `shared/safe-path.js` + `prompt/schema-registry.js` 两个新模块的 re-export,`pnpm build` 确认无命名冲突。
  - `git status --short` / `find dist -name "*.test.*"` / `profiles/verity/` 未被误建,均复核通过。
- **交回**:本批修复已 push 到 `feature/issue-1-a0-a1-scaffold`,交回 Zorro 复审(非新的 Cypher 功能批次)。

## 决策记录(可追源)
- 2026-07-20:包管理器从 npm 切到 **pnpm**(军师本轮口径更正,mid-task 消息)。B0 起未产生任何 npm 遗留物(`package-lock.json`/扁平 `node_modules`)——package.json 写好后先切到 pnpm 才跑的第一次 `install`,无需清理。lockfile = `pnpm-lock.yaml`。
- 2026-07-20:`build` script 用 `tsc -p tsconfig.build.json`(新增文件)而非 PRD §5 字面写的裸 `tsc`,理由见上方 B0 记录(dist 干净度)。`lint` 仍是裸 `tsc --noEmit`,未偏离。
- 2026-07-20:`tsconfig.json` 加 `"types": ["node"]`(PRD 未提及,是 pnpm 下的必要修复,非设计决策,记录为可追溯的环境事实)。
- 2026-07-20(B2):FTS5 `MATCH` 条件必须用虚拟表真实名字(`memories_fts MATCH ?`),不能用 `FROM ... alias` 里的别名(`f MATCH ?` → `SqliteError: no such column: f`)。真机 spike 实测发现,非凭空假设。
- 2026-07-20(B4):`ConfirmationService.reject()` 不清空 `memories.confirmed_at`/`confirmed_by`(保留历史确认事实),仅通过 `memory_confirmations` 审计行记录 reject 本身的 actor/时间——这是 PRD §9.0#5"按语义自实现"授权范围内的具体设计选择,未回头问指挥官(理由已写进 `confirmation.ts` 类注释,可追源)。
- 2026-07-20(B5):`ContextInjector` 中"stale 优先于 unconfirmed"的警告优先级是实现层选择(DESIGN §3 未指定两者同时为真时如何呈现),已在 `injector.ts` 注释中明确标注为非规格事实。
- 2026-07-20(B6):`ClaimSchema` 的字段范围是实现层选择——只保留模型能自报的部分(`claimText`/`confidence`/`sourceRef`/`verifiedBy`),排除 `structured_claims` 里 Harness/Loop 事后才填的列(`model_used`/`provider_used`/`tool_exec_checked`/`run_id`/`id`/`created_at`)。未回头问指挥官,理由已写进 `schema.ts` 文件头注释,PRD §5 措辞("不含持久化列如 run_id")本身就授权了这个范围收窄。
- 2026-07-20(B8):角色→schema 的映射用一个 `Record<string, z.ZodType>` 常量(`OUTPUT_SCHEMAS`)而不是文件系统扫描——因为本增量的 schema(`CoderOutput`/`TesterOutput`)是 B6 定义的固定具名导出,不像 persona 走"目录即 registry"的文件约定;这是 DESIGN §1.7"按角色名动态查 registry"的字面落地(键查找,零 `if role===` 分支),但落地形态和 persona loader 不同,已在 `composer.ts` 注释中说明二者为何不对称。
- 2026-07-20(B8):角色不在 `OUTPUT_SCHEMAS` 里(有 persona 但没结构化 schema)时,`compose()` 静默省略"Output Schema"小节而不抛错——非规格事实,是"加角色不强制同时要求 schema"这个可扩展性考量下的实现选择。
- 2026-07-20(B9):`src/index.ts` barrel 补齐 `prompt/*` 三个模块的 re-export,放在 B9(而非各自批次)一并做——因为 B9 本身就是"证明层与层真的接通"的收尾点,顺带把 barrel 也接通,逻辑上一致;此前 B6/B7/B8 各批次专注单文件未回头补,不是遗漏,是延后到收尾批次统一处理。
