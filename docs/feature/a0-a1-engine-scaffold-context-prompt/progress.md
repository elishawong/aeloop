---
feature: a0-a1-engine-scaffold-context-prompt
status: in_progress
last_updated: 2026-07-20
---

# Progress — A0+A1 引擎脚手架 + Context/Prompt 层

> 边写边更。每批做完追加一条:做了什么 + 本地自检结果 + 可追源的证据。

> **▶ 下一步(RESUME 指针)**:B6 —— `src/prompt/schema.ts`(zod:`ClaimSchema`/`CoderOutput`/`TesterOutput`)+ `schema.test.ts`。B6 不依赖 Context 层(PRD §6:"B6 不依赖 Context,理论上可与 B2-B5 并行开发"),可独立开工。之后依序 B7(persona loader)→B8(PromptComposer,依赖 B5+B6+B7)→B9(硬性垂直切片端到端测试)。见 PRD §5 A1 Prompt 层 / §6 批次拆解。

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
  2. **`js-yaml@5.x` 的 ESM 构建(`dist/js-yaml.mjs`)没有 default export,只有具名导出**(`load`/`dump`/…)。最初写成 `import yaml from "js-yaml"; yaml.load(...)`,`tsc` 类型检查竟然通过(因为 `@types/js-yaml@4.0.9` 是给 js-yaml 4.x 老 API 写的类型,还带着 default export 的类型声明,和 js-yaml 5.x 实际的 ESM 产物对不上),但**运行时** `yaml.load` 是 `undefined`(`TypeError: Cannot read properties of undefined (reading 'load')`),被 vitest 抓到——这正是"lint 过不代表真的跑得通"的活教材。**修复**:改成具名导入 `import { load as loadYaml } from "js-yaml"`。**遗留观察(标 `[?]`,未处理,不影响本段验收)**:`@types/js-yaml@4.0.9` 相对 js-yaml 5.x 可能已经过期/形状不完全匹配(js-yaml 5.x 自己在 `exports.types` 里也带了 `dist/js-yaml.d.ts`),这次只是恰好没在类型层面报错、被运行时测试兜住;要不要把 `@types/js-yaml` 从 devDependencies 里去掉、改吃 js-yaml 自带类型,留给后续增量评估,本段不动(PRD 明确要求 devDeps 含 `@types/js-yaml`,未经指挥官确认不擅自去掉)。
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

## 决策记录(可追源)
- 2026-07-20:包管理器从 npm 切到 **pnpm**(军师本轮口径更正,mid-task 消息)。B0 起未产生任何 npm 遗留物(`package-lock.json`/扁平 `node_modules`)——package.json 写好后先切到 pnpm 才跑的第一次 `install`,无需清理。lockfile = `pnpm-lock.yaml`。
- 2026-07-20:`build` script 用 `tsc -p tsconfig.build.json`(新增文件)而非 PRD §5 字面写的裸 `tsc`,理由见上方 B0 记录(dist 干净度)。`lint` 仍是裸 `tsc --noEmit`,未偏离。
- 2026-07-20:`tsconfig.json` 加 `"types": ["node"]`(PRD 未提及,是 pnpm 下的必要修复,非设计决策,记录为可追溯的环境事实)。
- 2026-07-20(B2):FTS5 `MATCH` 条件必须用虚拟表真实名字(`memories_fts MATCH ?`),不能用 `FROM ... alias` 里的别名(`f MATCH ?` → `SqliteError: no such column: f`)。真机 spike 实测发现,非凭空假设。
- 2026-07-20(B4):`ConfirmationService.reject()` 不清空 `memories.confirmed_at`/`confirmed_by`(保留历史确认事实),仅通过 `memory_confirmations` 审计行记录 reject 本身的 actor/时间——这是 PRD §9.0#5"按语义自实现"授权范围内的具体设计选择,未回头问指挥官(理由已写进 `confirmation.ts` 类注释,可追源)。
- 2026-07-20(B5):`ContextInjector` 中"stale 优先于 unconfirmed"的警告优先级是实现层选择(DESIGN §3 未指定两者同时为真时如何呈现),已在 `injector.ts` 注释中明确标注为非规格事实。
