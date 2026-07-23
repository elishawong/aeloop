# PRD — aeloop A0+A1:引擎脚手架 + Context/Prompt 层(含 ContextInjector 接线 + M2/M3 必需项)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`。
> 防幻觉:`[?]` = 我没验证过 / 需要 spike 或指挥官确认;不编造接口/版本/参数。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-1-a0-a1-scaffold`(单分支,批次内顺序 commit——理由见 §7 分支策略)
- **优先级**:P1
- **状态**:已批准(Elisha 2026-07-20 批准;5 个 `[?]` 项已敲定——见 §9.0)
- **最后更新**:2026-07-20
- **关联 issue**:[elishawong/aeloop#1](https://github.com/elishawong/aeloop/issues/1)(本增量)· 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§1.5-1.7 四层关系 / §5 DB schema / §6 文件结构 / §8 里程碑 / §8.5 必查清单)

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:aeloop 目前是个空仓库(只有项目自带层:CLAUDE.md/docs/.claude/skills)。我们需要从零搭出引擎最内层的两层(Prompt、Context)+ 脚手架,同时**从第一天起就避开 Verity M2/M3 在真实测试中已经暴露过的坑**(各层写测试各自绿但从没接过线;confirm 没有事务;缺列;JSON.parse 直接抛原始错误;被拒绝的记忆没有过滤)。
- **服务对象**:aeloop 引擎本身(下游消费者是 A2 Harness 的 PromptComposer 调用方、A4 Loop 的 Coder/Tester 节点);短期内的直接用户是 Cypher/Zorro,他们在后续增量里跑测试、接线。
- **一句话方案**:按 DESIGN §6 的目标结构,搭出 `src/prompt/`、`src/context/`、`src/profile/`、`src/shared/` 以及配套的 vitest/tsconfig/package.json,用**一个端到端纵切测试**证明 Context(ContextInjector,包括过滤 rejected)→ Prompt(PromptComposer)真的接上了线——不是三层各自绿、彼此没有胶水。

## 2. 目标 / 非目标

**目标(A0 脚手架)**:
- TypeScript + Node v24 项目骨架:package.json / tsconfig(strict + `noUncheckedIndexedAccess`)/ vitest.config.ts / .env.example。
- `src/profile/loader.ts`:读 `AI_AGENT_PROFILE`(`helix` | `verity`)→ 定位并解析对应 profile 目录下的 `config.yaml`;当 `profiles/verity/` 不存在时,**优雅降级**(一个显式的"没找到"错误/状态,不原样抛错,不悄悄假装成功)。
- 最小化的 `profiles/helix/config.yaml` + `profiles/helix/personas/{coder,tester}.md` 示例,给 loader/persona 测试用。

**目标(A1 Context + Prompt)**:
- Context 层:SQLite(+FTS5)存储(`memories` / `memory_confirmations` / `system_config` 三张表,对齐 DESIGN §5 ER,补上 Verity 缺的列)、StalenessEngine、ConfirmationService(三态:confirm/correct/reject,包在 `db.transaction` 里)、ContextInjector(注入 + 过滤 rejected)、types/errors、不会静默失败的 RecallError。
- Prompt 层:`ClaimSchema`/`CoderOutput`/`TesterOutput`(zod)、persona loader(按角色名动态查 registry,不硬编码 `{coder,tester}`)、PromptComposer(persona + schema + 注入的记忆 → 最终 prompt 字符串)。
- **硬核纵切**:一个端到端测试,证明 `ContextInjector` 真的把 `memories` 表里已确认的记忆注入进了 `PromptComposer` 的输出,rejected 的记忆被过滤掉——不是各层各自独立的测试。

**非目标(明确排除在外,留给后续增量)**:
- ❌ Harness 层(ProviderRouter / LiteLLMAdapter / SchemaValidator / adapters/*)——A2。
- ❌ CLI bridge adapter(ClaudeCliAdapter / CodexCliAdapter)+ ToolExecVerifier——A3(包括 codex exec spike)。
- ❌ Loop 层(LangGraph 编排 / G1-G3 gate / 阈值升级 / checkpoint)——A4;三张表 `workflow_runs` / `structured_claims` / `approvals` **不在本增量的建表范围内**(A1 只建 `memories`/`memory_confirmations`/`system_config`)。
- ❌ CLI/TUI(彩色 diff / y/n 批准)——A5。
- ❌ 真实 profile 双跑验收(helix/verity 各真实跑一次任务)——A6。
- ❌ `workflows/coder-tester-loop.json` 这份 workflow 定义文件——需要 Loop 层(A4)作为消费者,本增量不建。

## 3. 用户故事

- 作为**后续增量 Harness/Loop 的开发者(从 A2 开始的 Cypher)**,我希望 `PromptComposer` 已经能从 `ContextInjector` 拿到过滤好的记忆并组装出完整的 prompt,这样 A2 可以直接调用,不用回头修 Context/Prompt 的接线。
- 作为**指挥官**,我希望每个里程碑收尾都有一个能跑的测试证明"各层真的接上了",而不是信一份声称完成的文档(Verity M2/M3 的教训)。
- 作为**profile 用户(未来的 A6)**,我希望 `AI_AGENT_PROFILE=helix` 且找不到 `profiles/verity/` 时不会报错崩溃——只有真的需要 verity overlay 时才应该报错。

## 4. 数据模型

> 权威:DESIGN §5 ER 图。本增量**只建 3 张表**(另外 3 张属于 Loop/Harness,不在本增量的 DDL 范围内)。

### 4.1 本增量交付的表

**`memories`**(对齐 DESIGN §5,包括相对 Verity M2 新增的列):
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT | 12 种类型(identity/snapshot/active_task/idea/decision/postmortem/map/constraint/relation/agent_spec/requirement/project_registry) |
| title | TEXT | |
| content | TEXT | |
| source_file | TEXT | |
| tags | TEXT | 序列化存储(JSON 还是分隔符——`[?]` 见 §9) |
| confidence_state | TEXT | `unconfirmed` / `confirmed` / `rejected` |
| stale_override_days | INTEGER NULL | NULL 读 `system_config` |
| created_at | TEXT | |
| updated_at | TEXT | |
| **confirmed_at** | TEXT NULL | **A1 新增**(Verity M2 缺失,见 DESIGN §8.5 #7) |
| **confirmed_by** | TEXT NULL | **A1 新增** |

**`memory_confirmations`**:
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| memory_id | INTEGER FK → memories.id | |
| action | TEXT | `confirm` / `correct` / `reject` |
| old_content | TEXT | |
| new_content | TEXT | |
| **actor** | TEXT | **A1 新增**(Verity M2 缺失) |
| created_at | TEXT | |

**`system_config`**:
| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | `default_stale_days` / `default_reject_threshold` / … |
| value | TEXT | |
| **updated_at** | TEXT | **A1 新增**(Verity M2 缺失) |

### 4.2 本增量不建的表(留给 A2-A4,记录但不实现)
`workflow_runs`(A4)、`structured_claims`(A4——本增量定义 `ClaimSchema` 的 zod 校验形状,但持久化到这张表是 A4 的活)、`approvals`(A4)。

### 4.3 迁移策略
`[?]` 第一个版本要不要一个正式的 migration 工具,还是 `store.ts` 启动时直接 `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE IF NOT EXISTS ... USING fts5(...)` 就够了(因为 aeloop 是个人用的 CLI 工具,每个 profile 一份新 db——不存在"生产 DB 需要滚动升级"这种场景)。**建议**:A1 先用内联的 `CREATE TABLE IF NOT EXISTS`(简单,不引入额外依赖),不引入单独的 migration 框架;真的需要改 schema 时再加迁移脚本。这条建议还没经指挥官确认,标 `[?]`。

## 5. 逐文件任务清单

### A0 脚手架
- `package.json`——依赖:`zod`、`js-yaml`、SQLite 驱动(§9.0#1 已敲定:`better-sqlite3`);devDeps:`typescript`、`vitest`、`@types/node`(+ 如果需要,DB 驱动的 `@types/*`)。**不包含 `@types/js-yaml`**(Zorro 复审 `feature/issue-1-a0-a1-scaffold` 时发现的:`tsc --traceResolution` 实证证明 TypeScript 从来没解析过这个包——js-yaml 5.x 自带 `dist/js-yaml.d.ts`,直接靠它自己 `package.json` 的 `exports`/`types` 字段使用,让 `@types/js-yaml` 成了一个彻底的死依赖;已经 `pnpm remove @types/js-yaml`,移除后 `pnpm build`/`pnpm lint`/`pnpm test` 重跑依然全绿——细节见 progress.md B1 条目里的根因更正)。scripts:`build`(`tsc -p tsconfig.build.json`——B0 已经交付 `tsconfig.build.json`,排除 `*.test.ts` 避免测试产物污染 `dist/`,对齐 §8.5#8)、`test`(`vitest run`)、`test:watch`、`lint`(`tsc --noEmit`,包括给测试文件做类型检查)。包管理器:pnpm。
- `tsconfig.json`——`strict: true`、`noUncheckedIndexedAccess: true`、`target`/`module` 对齐 Node v24(ESM 优先,`[?]` 需要确认 CommonJS 还是 ESM,见 §9)、`outDir: dist`、`rootDir: src`。
- `vitest.config.ts`——基础配置,`include: ['src/**/*.test.ts']`。
- `.env.example`——`LITELLM_BASE_URL=` / `LITELLM_TOKEN=`(只有 verity profile 才用,helix 在本增量不需要真实值)、`AI_AGENT_PROFILE=helix`。
- `src/index.ts`——引擎入口 barrel(本增量只重导出 A0/A1 已经搭好的模块,不假装 A2+ 已经存在)。
- `src/shared/types.ts`——跨层共享类型(比如 `Role` 作为开放字符串类型、`ISODateString` 等——一个最小集合,不过度设计)。
- `src/profile/loader.ts`——读 `AI_AGENT_PROFILE` + 定位/解析 `profiles/<name>/config.yaml`(js-yaml)+ 替换 `${ENV}` 占位符;`profiles/verity/` 不存在时,返回一个带类型的"没找到"结果,不原样抛错。
- `src/profile/errors.ts`——带类型的错误,比如 `ProfileNotFoundError`。
- `src/profile/loader.test.ts`——覆盖:正常 helix 加载 / verity 缺失优雅降级 / 格式错误的 config.yaml(YAML 解析失败)不原样抛错。
- `profiles/helix/config.yaml`——最小化示例(对齐 DESIGN §7 的结构:providers/roles/workflow.reject_threshold);本增量把 providers 字段留作占位符(claude-cli/codex-cli 的真实调用是 A3 的活——这里 loader 只需要解析出结构)。
- `profiles/helix/personas/coder.md`——最小化示例 persona 文本(纯文本,不绑定厂商)。
- `profiles/helix/personas/tester.md`——同上。

### A1 Context 层
- `src/context/types.ts`——`Memory`、`MemoryConfirmation`、`SystemConfigEntry`、`ConfidenceState` 等类型,对齐 §4 的表结构。
- `src/context/errors.ts`——`RecallError`(不静默,取代把错误吞成空数组)、`ConfirmationError`、带类型的 JSON 解析错误。
- `src/context/store.ts`——SQLite 连接 + `CREATE TABLE IF NOT EXISTS`(memories/memory_confirmations/system_config)+ `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)` + FTS5 触发器同步(insert/update/delete)、基础 CRUD、FTS 召回查询(失败状态包进 `RecallError`,不静默返回空)。
- `src/context/config.ts`——`SystemConfig` 读写(`default_stale_days`/`default_reject_threshold` 等的默认值 + 覆盖),写 `updated_at`。
- `src/context/staleness.ts`——`StalenessEngine`:根据 `stale_override_days` 或 `system_config.default_stale_days` 判断一条记忆是不是 stale。
- `src/context/confirmation.ts`——`ConfirmationService`:三个方法 `confirm(memoryId, actor)` / `correct(memoryId, newContent, actor)` / `reject(memoryId, actor)`,**全部包在 `db.transaction` 里**(写 `memories.confidence_state`/`confirmed_at`/`confirmed_by` + 插入一行带 `actor` 的 `memory_confirmations` 是同一个事务);给"没有既有确认记录"的缺失路径加测试(见 §9 的 `replaceLatest` 语义 `[?]`)。
- `src/context/injector.ts`——`ContextInjector`:① 核心记忆全集 + FTS5 关键词召回;② **过滤掉 `confidence_state === 'rejected'`**;③ stale/unconfirmed 的记忆保留但打上警告标记(不过滤,只标记,对齐 DESIGN §3 时序图里的注释);④ 输出一个供 `PromptComposer` 消费的结构。
- `src/context/store.test.ts` / `config.test.ts` / `staleness.test.ts` / `confirmation.test.ts` / `injector.test.ts`——各自独立的单元测试,包括:确认事务的原子性(中途失败整个回滚)、一个针对 injector 过滤 rejected 的定向测试、RecallError 触发路径测试。

### A1 Prompt 层
- `src/prompt/schema.ts`——`ClaimSchema`(对齐 `structured_claims` 的概念,但这里只是个 zod 校验形状,不含 `run_id` 这类持久化列)、`CoderOutput`、`TesterOutput`(zod)。
- `src/prompt/personas.ts`——persona loader:按角色名字符串,**动态**在 profile 的 `personas/` 目录下查对应的 `.md`(不硬编码成 `if role === 'coder'`);角色不存在时抛带类型的错误;给"角色的 persona 文件缺失"这条路径加测试。
- `src/prompt/composer.ts`——`PromptComposer`:输入(角色名 + `ContextInjector` 输出 + 任务描述)→ 输出最终 prompt 字符串(persona 文本 + schema 描述 + 注入的记忆;rejected 在上游已经过滤过,composer 不需要再过滤一遍)。
- `src/prompt/schema.test.ts` / `personas.test.ts` / `composer.test.ts`。

### 纵切(A1 收尾,一个硬核交付物)
- `src/context-prompt.e2e.test.ts`(或等价位置,具体命名 `[?]` 待定)——端到端测试:① 用 `store.ts` 写 3 条记忆(confirmed/unconfirmed/rejected 各一条)→ ② `ContextInjector.inject(...)` → ③ 喂进 `PromptComposer.compose('coder', ...)` → ④ 断言最终 prompt 字符串包含 confirmed 的内容,**不包含** rejected 的内容,包含带警告标记的 unconfirmed 内容。这个测试是 DESIGN §8.5"aeloop 每个里程碑收尾都必须有一个真正证明连通性的硬核纵切"的实锤证据。

### 构建/分发相关(DESIGN §8.5 #8)
- 确认 `package.json` 的 `files` 字段(或 `.npmignore`)包含 `profiles/*/personas/**/*.md`,这样 `pnpm add -g` 安装时 persona 文本会跟包一起分发。**结构性说明**:在 aeloop 的目标文件结构里,persona 放在顶层 `profiles/` 下,不在 `src/` 下,所以 `tsc` 编译从来不会碰它们——Verity"dist 没拷贝 .md"那个问题**在 aeloop 的目录结构下不可能以同样的形式重演**;本增量只需要确认打包配置正确,不需要额外的构建期拷贝脚本。如果 §9 的 `[?]`(ESM/CJS、驱动选型)最终引入了工具链变动,这个结论到时候要重新验证。

### Zorro 复审修复(2026-07-20,同一分支 `feature/issue-1-a0-a1-scaffold`,第二轮,B0-B10 之后)
> 第一轮 Zorro 独立判定是 **FAIL**;下面是修复本身新增/改动的文件清单,追加到 §5 供后续读者追溯(原本 B0-B10 的逐文件清单已经完整,不重写——这里只加增量)。
- `src/shared/safe-path.ts`(新)+ `src/shared/safe-path.test.ts`(新)——两层路径遍历防御,`isSinglePathSegment`/`isContainedRealpath`,被 `src/prompt/personas.ts`(`loadPersona`)和 `src/profile/loader.ts`(`loadProfile`)共用。
- `src/prompt/personas.ts`——新增 `InvalidRoleNameError`;`loadPersona` 现在在碰文件系统之前先做路径安全校验。
- `src/profile/errors.ts`——新增 `InvalidProfileNameError`。
- `src/profile/loader.ts`——`loadProfile` 同样接入路径安全校验;新增 `assertProfileConfigShape`(最小化验证必需的顶层字段 `profile`/`providers`/`roles` 存在且类型正确,取代原来的裸 `as ProfileConfig`)。
- `src/context/store.ts`——新增 `toSafeFtsQuery`(FTS5 关键词安全转义:按空白拆分 + 每个词转成带引号的短语),`searchMemories` 现在消费安全转义过的查询字符串。
- `src/context/injector.ts`——新增 `CORE_MEMORY_TYPES`(`identity`/`constraint`/`decision`),`inject()` 的"核心全集"从全表扫描改成按 type 过滤,这样 FTS5 召回分支才真的起作用。
- `src/prompt/schema-registry.ts`(新)——`SchemaRegistry`/`DEFAULT_OUTPUT_SCHEMAS`/`SchemaNotRegisteredError`,把角色→schema 的映射从 `composer.ts` 内部硬编码挪成一个外部可注入的 registry。
- `src/prompt/composer.ts`——`PromptComposer` 的构造函数新增一个可选的 `schemas: SchemaRegistry` 参数;registry 里没有的角色 → 抛 `SchemaNotRegisteredError`(取代之前的静默忽略)。
- `src/context-prompt.e2e.test.ts`——两个测试现在都给 `inject()` 喂含连字符的真实任务文本(比如 `"Explain the retry-backoff strategy."`),不再用 `inject(undefined)` 绕过 FTS5 召回路径。
- `package.json`——`pnpm remove @types/js-yaml`(死依赖,细节见本文件"依赖"小节 + progress.md B1 条目的根因更正)。
- 对应的测试文件(`personas.test.ts`/`loader.test.ts`/`store.test.ts`/`injector.test.ts`/`composer.test.ts`/`confirmation.test.ts`)都新增/重写了对抗式断言——细节见 progress.md 新增的 B11 条目。

## 6. 批次拆分

> 单位:`[S]` ≈ 2-4h,`[M]` ≈ 半天到一天,`[L]` ≈ 1-2 天(本仓库没有既有的估算惯例;这是本 PRD 自定的刻度,只供排期参考)。全部在同一分支 `feature/issue-1-a0-a1-scaffold` 上顺序提交——理由见 §7。

| 批次 | 内容 | 依赖 | 大小 |
|---|---|---|---|
| **B0** | package.json / tsconfig / vitest.config / .env.example / pnpm scripts | 无(起点) | [S] |
| **B1** | src 骨架目录 + shared/types.ts + profile/loader.ts + profile/errors.ts + profiles/helix/config.yaml + persona 示例 + 对应测试 | B0 | [M] |
| **B2** | context/types.ts + errors.ts + store.ts(建表 + FTS5 + CRUD + RecallError)+ store.test.ts | B1(需要 profile 来定 db 路径的惯例,但 store 本身可以先用显式路径参数实现,不跟 profile 强耦合) | [M] |
| **B3** | context/config.ts(SystemConfig)+ staleness.ts(StalenessEngine)+ 对应测试 | B2 | [S] |
| **B4** | context/confirmation.ts(ConfirmationService 三态 + db.transaction + 新增列)+ confirmation.test.ts(包括事务原子性 + 缺失路径测试) | B2 | [M] |
| **B5** | context/injector.ts(ContextInjector,含过滤 rejected)+ injector.test.ts | B2 + B3 + B4 | [M] |
| **B6** | prompt/schema.ts(zod:ClaimSchema/CoderOutput/TesterOutput)+ schema.test.ts | B0(跟 Context 独立,理论上可以跟 B2-B5 并行写,但同一分支上顺序提交) | [S] |
| **B7** | prompt/personas.ts(动态角色 persona loader)+ personas.test.ts | B1(需要 profile 提供 personas 目录) | [S] |
| **B8** | prompt/composer.ts(PromptComposer)+ composer.test.ts | B5 + B6 + B7 | [M] |
| **B9** | 纵切端到端测试(Context→Prompt 真的接通,包括一条 rejected 过滤断言) | B8 | [S] |
| **B10** | 打包配置验证(`files`/`.npmignore` 包含 personas `.md`)+ README/CLAUDE.md 勾选更新 + docs/ROADMAP.md/PROGRESS.md/CHANGELOG.md 回写 | B9 | [S] |

**依赖图说明**:B6(Prompt schema)不依赖 Context,理论上可以跟 B2-B5 并行开发;但因为本增量是同一个 Cypher 顺序实现的(不是多人协作),不为此单独拆分支——B6 放在 B2-B5 之后纯粹是排序选择,不是硬依赖。如果未来需要多 agent 并行,B6/B7 可以拆到一条并行分支上。B9 这个纵切批次是唯一一个**必须等前面全部完成**才能做的收尾批次——没法提前造假。

## 7. 分支策略

单分支 `feature/issue-1-a0-a1-scaffold`,批次按 §6 的顺序提交,理由:
- 本增量是一个人(Cypher)从零搭一整个新的 `src/` 骨架;批次间的大部分依赖是真实的(B2→B3→B4→B5→B8→B9 一条链)——没有可以独立合并的并行工作流。
- B6(Prompt schema)逻辑上独立,但代码量小,不值得为它单开分支的合并开销。
- 如果指挥官想要更细粒度的 PR 让 Zorro 分批审(而不是一个大 diff),同一分支内的 commit 可以按 B0-B1 / B2-B5(Context)/ B6-B9(Prompt+纵切)/ B10 这些天然断点分阶段审,不用等全部完成。

## 8. 可测试的验收标准(可核对)

- [x] `pnpm build` 成功(tsc strict + noUncheckedIndexedAccess,无报错)。——B10 重新验证过,通过。
- [x] `pnpm test` 全绿(vitest run)。——B10 重新验证过,实际通过 **96/96**。
- [x] `AI_AGENT_PROFILE=helix` 时,`profile/loader.ts` 正确解析 `profiles/helix/config.yaml`;`AI_AGENT_PROFILE=verity` 且 `profiles/verity/` 不存在时,返回一个带类型的"没找到"结果,而不是抛原始异常或静默返回空对象。——B1(`948fd24`)。
- [x] 三张表 `memories`/`memory_confirmations`/`system_config` 按 §4.1 建好,所有列都在(包括新增的四列 `confirmed_at`/`confirmed_by`/`actor`/`updated_at`)。——B2(`0eea001`)。
- [x] `ConfirmationService` 的 `confirm`/`correct`/`reject` 方法全部包在 `db.transaction` 里;有测试证明"事务中途失败会整个回滚,不留下半写的状态"。——B4(`b24fa3f`)。
- [x] `ContextInjector` 有一个**定向测试**,证明 `confidence_state === 'rejected'` 的记忆永远不会出现在注入结果里。——B5(`06259c9`)。
- [x] persona loader 按角色名字符串动态解析(不硬编码 `{coder,tester}`),覆盖"角色的 persona 文件缺失"路径的测试。——B7(`88852a5`)。
- [x] 本增量里每个 `JSON.parse` 调用点(`tags` 反序列化 / 相关的 config.yaml)都包在 try-catch 里,失败落进一个带类型的错误,而不是原样抛 `SyntaxError`。——B10 重新验证:`grep -rn "JSON.parse" src` 只找到一处命中(`store.ts:209`,tags 反序列化)包在 try-catch 里 → `MemoryTagsParseError`;`profile/loader.ts` 的 `loadYaml(...)` 同样包在 try-catch 里 → `ProfileConfigParseError`。
- [x] **硬核纵切测试存在且通过**:一个端到端测试证明 Context(`ContextInjector`)→ Prompt(`PromptComposer`)真的接通了(种子数据 → inject → compose → 断言最终 prompt 内容),不是拿孤立的各层测试拼出来的假象。——B9(`4eb97e4`)。
- [x] `package.json` 的 `files`/`.npmignore` 确认 `profiles/*/personas/**/*.md` 会随包分发。——B10 用实际的 `pnpm pack` 验证过:`files` 字段(没有 `.npmignore`,`files` 单独工作就够)已经包含 `profiles/*/personas/**/*.md` + `profiles/*/config.yaml`(B0 已经交付,B10 只是复核);`tar -tzf` 确认没有 `*.test.*` 泄漏进打包的 `dist/`。
- [x] `docs/ROADMAP.md` 的 A0/A1 勾选框更新,`docs/PROGRESS.md` 清空或更新,`CHANGELOG.md` 加一行,`profiles/verity/` 从没被意外提交过(`git status` 确认 `.gitignore` 生效)。——在本 B10 批次完成。

## 9. 依赖 / 风险

### 9.0 已敲定的决定(指挥官 2026-07-20 批准;下面的 `[?]` 相应收敛,不再是待定项)
1. **SQLite 驱动 = better-sqlite3**(稳定性优先;`node:sqlite` 实证可用于 FTS5,但依然是 Experimental,留作未来的减依赖选项)。
2. **模块系统 = ESM**(`"type":"module"` + NodeNext);如果 B0 发现 vitest/better-sqlite3 在 ESM 下有任何问题,立刻上报,不强推。
3. **lint = A0 只用 `tsc --noEmit`,不上 eslint**;eslint 延后到后续增量(引擎长期需要它,但不在 A0 的范围内)。
4. **`tags` 序列化 = JSON 数组字符串**(`JSON.stringify`/`JSON.parse` + try-catch)。
5. **`replaceLatest` 语义 = 从零基于含义实现**(Verity 源码在公司内网——越界,不读;不照抄外部命名);`ConfirmationService.correct()` 承担"修正最新内容"这个职责,"有"和"没有"既有确认记录两条路径都有测试。

**依赖**:
- Node v24(本地确认为 `v24.1.0`,跟 `CLAUDE.md` §2 一致)。
- npm registry 可达性(这次跑确认了以下包当时可解析的版本,供 `package.json` 版本范围参考,不是钉死的精确版本):`zod@4.4.3`、`js-yaml@5.2.1`、`vitest@4.1.10`、`typescript@7.0.2`、`better-sqlite3@12.11.1`。这些是 2026-07-20 实际的 `npm view` 结果;`package.json` 里用 `^` 范围,不要钉死这些精确值。

**风险 / 历史 `[?]`(第 1-5 项已经因为指挥官在 §9.0 的批准收敛为已敲定的决定,不再是待定项——原文保留作可追溯的记录,标签从 `[?]` 改成"已敲定";Zorro 复审 `feature/issue-1-a0-a1-scaffold` 时指出这五项本该在 §9.0 敲定时就同步标签——原来的 `[?]` 是一份从没被回写的文档留下的残留)**:

1. **[已敲定,见 §9.0#1]** SQLite 驱动:better-sqlite3 vs node:sqlite。本地验证过 `node:sqlite`(Node v24.1.0 内置)的 `DatabaseSync` 支持 `CREATE VIRTUAL TABLE ... USING fts5(...)`,能正常建表(实证确认过——写这份 PRD 期间做过一次 spike:`node -e "require('node:sqlite')..."` 成功建出一张 FTS5 表)。但 `node:sqlite` 依然带着 `ExperimentalWarning`(一个实验性 API,可能会变),而 `better-sqlite3@12.11.1` 是一个成熟、稳定的第三方原生模块。指挥官已批准:A0/A1 用 `better-sqlite3`,`node:sqlite` 的验证结果留档作为未来的减依赖选项。
2. **[已敲定,见 §9.0#2]** ESM vs CommonJS。指挥官已批准:ESM(`"type": "module"` + `NodeNext` 模块解析)。B0 的 spike 没发现真正的阻断项(见 progress.md 的 B0 条目);没有回退到 CommonJS。
3. **[已敲定,见 §9.0#3]** lint 工具选型。指挥官已批准:A0 只用 `tsc --noEmit`,不上 eslint;eslint 延后到后续增量。
4. **[已敲定,见 §9.0#4]** `tags` 列的序列化格式。指挥官已批准:JSON 数组字符串(`JSON.stringify`/`JSON.parse`,配 try-catch),已经在 `store.ts`/`errors.ts`(`MemoryTagsParseError`)里实现。
5. **[已敲定,见 §9.0#5]** `replaceLatest` 的精确语义 / persona 缺失路径测试。指挥官已批准:从零基于含义实现,不照抄 Verity 内部命名。`ConfirmationService.correct()` 负责"修正一条记忆的最新内容",现在"有既有确认记录"/"没有"两条路径都有测试 + 一个 `correct()→reject()` 元数据边界测试(`confirmation.test.ts`,这轮 Zorro 复审新增),persona loader 也已经有"角色文件缺失"路径的测试。
6. **风险(不是 `[?]`,一条提醒)**:B2(store.ts)是本增量单个最大的文件(建表 + FTS5 触发器 + CRUD + 召回)——建议在 B2 内部进一步拆成更小的 commit(建表 → CRUD → FTS5 触发器 → 召回查询),避免一次巨大且难审的改动。
7. **风险**:纵切测试(B9)是本增量能不能通过 Zorro 复审的关键项——必须跑真实的种子数据,对着真实的 SQLite 文件(或内存 db),不能把 `ContextInjector`/`PromptComposer` 之间的调用 mock 掉来"制造"一次假通过——这正是 DESIGN §8.5 方法论提醒点名的那一项,Zorro 会对抗式地仔细审这一项。**Zorro 第一轮复审(2026-07-20)在真实测试中恰好在 B9 抓到两个问题:它走的是 `inject(undefined)`(绕过了真实的 FTS5 召回路径),而且当时 `ContextInjector` 的"核心全集"等于全表扫描(让 FTS5 召回分支成了死代码)——两个都已经在这一轮修好(见 `injector.ts` 的 `CORE_MEMORY_TYPES` + `context-prompt.e2e.test.ts` 改用带连字符的真实任务文本来驱动 `inject()`)——确认了这条风险提示是准的。**

## 10. 项目约束检查

- **模型无关?** 是——本增量(A0/A1)不含任何特定 provider/模型名;`profiles/helix/config.yaml` 里的 `providers.claude-cli`/`codex-cli` 条目只是配置结构占位符,真实调用逻辑在 A3;本增量的 loader 只解析 YAML 结构,不硬编码任何分支逻辑。
- **没有反向跨层依赖?** 是——`src/prompt/` 不 import `src/context/` 的内部实现细节(`PromptComposer` 只依赖 `ContextInjector` 的**输出类型**,不反向依赖 Prompt);`src/context/` 不 import `src/harness/`/`src/loop/`(本增量这两层都不存在)。
- **`profiles/verity/` 不进仓库?** 是——本增量完全不创建任何 `profiles/verity/` 文件;仓库的 `.gitignore` 已经有 `profiles/verity/` 规则(确认过,见 aeloop 仓库根目录的 `.gitignore`);B10 收尾会再核一次 `git status` 确认没有意外创建。
- **角色不硬编码?** 是——persona loader 和 `PromptComposer` 都按角色名字符串动态查找,不是 `if role === 'coder'`(对齐 DESIGN §1.7)。
- **引擎代码不含 Helix 人格?** 是——`src/` 下的一切 100% 不含 Helix/companion/个人记忆内容;只有 `profiles/helix/` 包含示例 persona 文本(一份个人 overlay,允许存在于私有仓库内)。
