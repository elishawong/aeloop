---
feature: a0-a1-engine-scaffold-context-prompt
status: in_progress
last_updated: 2026-07-20
---

# Progress — A0+A1 引擎脚手架 + Context/Prompt 层

> 边写边更。每批做完追加一条:做了什么 + 本地自检结果 + 可追源的证据。

> **▶ 下一步(RESUME 指针)**:B2 —— `src/context/types.ts` + `src/context/errors.ts` + `src/context/store.ts`(建表 memories/memory_confirmations/system_config + FTS5 虚拟表及触发器 + 基础 CRUD + `RecallError` 不静默)+ `store.test.ts`。见 PRD §5 A1 Context 层 / §6 批次拆解。风险提示(PRD §9 风险6):B2 是本增量体量最大的单文件,建议内部再拆小提交(建表→CRUD→FTS5 触发器→召回查询)。

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

## 决策记录(可追源)
- 2026-07-20:包管理器从 npm 切到 **pnpm**(军师本轮口径更正,mid-task 消息)。B0 起未产生任何 npm 遗留物(`package-lock.json`/扁平 `node_modules`)——package.json 写好后先切到 pnpm 才跑的第一次 `install`,无需清理。lockfile = `pnpm-lock.yaml`。
- 2026-07-20:`build` script 用 `tsc -p tsconfig.build.json`(新增文件)而非 PRD §5 字面写的裸 `tsc`,理由见上方 B0 记录(dist 干净度)。`lint` 仍是裸 `tsc --noEmit`,未偏离。
- 2026-07-20:`tsconfig.json` 加 `"types": ["node"]`(PRD 未提及,是 pnpm 下的必要修复,非设计决策,记录为可追溯的环境事实)。
