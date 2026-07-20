# PRD — aeloop A0+A1:引擎脚手架 + Context/Prompt 层(含 ContextInjector 接线 + M2/M3 必修项)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`。
> 防幻觉:`[?]` = 我未验证 / 需要 spike 或指挥官确认,不编造接口/版本/参数。

- **项目**:aeloop(`elishawong/aeloop`,私有仓)
- **分支**:`feature/issue-1-a0-a1-scaffold`(单分支,批次内顺序提交 —— 理由见 §7 分支策略)
- **优先级**:P1
- **状态**:已批(2026-07-20 Elisha 批准,5 个 `[?]` 已定案 —— 见 §9.0)
- **最后更新**:2026-07-20
- **关联 issue**:[elishawong/aeloop#1](https://github.com/elishawong/aeloop/issues/1)(本增量)· 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§1.5-1.7 四层关系 / §5 DB schema / §6 文件结构 / §8 里程碑 / §8.5 必修清单)

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:aeloop 现为空仓(仅项目自带层:CLAUDE.md/docs/.claude/skills)。需要从零建出引擎最内两层(Prompt、Context)+ 脚手架,同时**从第一天避开 Verity M2/M3 已实测暴露的洞**(层写完测试绿但没接线;confirmation 无事务;缺列;JSON.parse 裸抛;rejected 记忆未过滤)。
- **给谁用**:aeloop 引擎本身(下游是 A2 Harness 的 PromptComposer 调用方、A4 Loop 的 Coder/Tester 节点);短期内直接使用者是 Cypher/Zorro 在后续增量里跑测试和接线。
- **一句话方案**:按 DESIGN §6 目标结构,建出 `src/prompt/`、`src/context/`、`src/profile/`、`src/shared/` + 配套 vitest/tsconfig/package.json,并用**一条端到端垂直切片测试**证明 Context(ContextInjector,含 rejected 过滤)→ Prompt(PromptComposer)真的接通,而不是三层各自绿但没胶水。

## 2. 目标 / 非目标

**目标(A0 脚手架)**:
- TypeScript + Node v24 项目骨架:package.json / tsconfig(strict + `noUncheckedIndexedAccess`)/ vitest.config.ts / .env.example。
- `src/profile/loader.ts`:读 `AI_AGENT_PROFILE`(`helix` | `verity`)→ 定位并解析对应 profile 目录下的 `config.yaml`;`profiles/verity/` 不存在时**优雅降级**(明确的「未找到」错误 / 状态,不裸抛、不静默假装成功)。
- `profiles/helix/config.yaml` + `profiles/helix/personas/{coder,tester}.md` 最小示例,供 loader / persona 测试使用。

**目标(A1 Context + Prompt)**:
- Context 层:SQLite(+FTS5)store(`memories` / `memory_confirmations` / `system_config` 三张表,对齐 DESIGN §5 ER,补齐 Verity 缺列)、StalenessEngine、ConfirmationService(三态:confirm/correct/reject,`db.transaction` 包裹)、ContextInjector(注入 + 滤 rejected)、types/errors、RecallError 不静默。
- Prompt 层:`ClaimSchema`/`CoderOutput`/`TesterOutput`(zod)、persona loader(按角色名动态查 registry,不写死 `{coder,tester}`)、PromptComposer(人格 + schema + 注入的记忆 → 最终 prompt 字符串)。
- **硬性垂直切片**:一条端到端测试证明 `ContextInjector` 真的把 `memories` 表里 confirmed 记忆注入进 `PromptComposer` 输出、rejected 记忆被滤掉 —— 不是分层孤立测试。

**非目标(明确不做,留给后续增量)**:
- ❌ Harness 层(ProviderRouter / LiteLLMAdapter / SchemaValidator / adapters/*)—— A2。
- ❌ CLI 桥接适配器(ClaudeCliAdapter / CodexCliAdapter)+ ToolExecVerifier —— A3(含 codex exec spike)。
- ❌ Loop 层(LangGraph 编排 / G1-G3 gate / 阈值升级 / checkpoint)—— A4;`workflow_runs` / `structured_claims` / `approvals` 三张表**不在本增量建表范围**(A1 只建 `memories`/`memory_confirmations`/`system_config`)。
- ❌ CLI/TUI(彩色 diff / y/n 批准)—— A5。
- ❌ profile 双跑真实验收(helix/verity 各跑一次真实任务)—— A6。
- ❌ `workflows/coder-tester-loop.json` workflow 定义文件 —— 要 Loop 层(A4)才有消费方,本增量不建。

## 3. 用户故事

- 作为**后续增量的 Harness/Loop 开发者(A2 起的 Cypher)**,我想要 `PromptComposer` 已经能从 `ContextInjector` 拿到过滤好的记忆并拼出完整 prompt,以便 A2 直接调用而不用回头修 Context/Prompt 的接线。
- 作为**指挥官**,我想要每个里程碑收尾有一条可运行的测试证明"层与层真的接通了",而不是相信文档自称完成(Verity M2/M3 的教训)。
- 作为**profile 使用者(未来 A6)**,我想要 `AI_AGENT_PROFILE=helix` 时找不到 `profiles/verity/` 也不报错崩溃,只在真正需要 verity overlay 时才报错。

## 4. 数据模型

> 权威:DESIGN §5 ER 图。本增量**只建 3 张表**(其余 3 张属 Loop/Harness,不在此增量 DDL 范围)。

### 4.1 本增量落地的表

**`memories`**(对齐 DESIGN §5,含相对 Verity M2 补齐的列):
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT | 12 种(identity/snapshot/active_task/idea/decision/postmortem/map/constraint/relation/agent_spec/requirement/project_registry) |
| title | TEXT | |
| content | TEXT | |
| source_file | TEXT | |
| tags | TEXT | 序列化存储(JSON 或分隔符 —— `[?]` 见 §9) |
| confidence_state | TEXT | `unconfirmed` / `confirmed` / `rejected` |
| stale_override_days | INTEGER NULL | NULL 则读 `system_config` |
| created_at | TEXT | |
| updated_at | TEXT | |
| **confirmed_at** | TEXT NULL | **A1 新补**(Verity M2 缺失,见 DESIGN §8.5 #7) |
| **confirmed_by** | TEXT NULL | **A1 新补** |

**`memory_confirmations`**:
| 列 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | |
| memory_id | INTEGER FK → memories.id | |
| action | TEXT | `confirm` / `correct` / `reject` |
| old_content | TEXT | |
| new_content | TEXT | |
| **actor** | TEXT | **A1 新补**(Verity M2 缺失) |
| created_at | TEXT | |

**`system_config`**:
| 列 | 类型 | 说明 |
|---|---|---|
| key | TEXT PK | `default_stale_days` / `default_reject_threshold` / … |
| value | TEXT | |
| **updated_at** | TEXT | **A1 新补**(Verity M2 缺失) |

### 4.2 本增量不建的表(留给 A2-A4,仅记录不实现)
`workflow_runs`(A4)、`structured_claims`(A4,`ClaimSchema` 的 zod 校验形状本增量要定,但持久化到这张表是 A4 的事)、`approvals`(A4)。

### 4.3 迁移策略
`[?]` 首版是否需要正式 migration 工具,还是 `store.ts` 启动时 `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE IF NOT EXISTS ... USING fts5(...)` 一把梭(因为 aeloop 是个人 CLI 工具、每 profile 一份全新 db,不存在"生产库要滚动升级"的场景)。**建议**:A1 先用 `CREATE TABLE IF NOT EXISTS` 内联建表(简单、无额外依赖),不引入独立 migration 框架;若未来需要 schema 变更再补迁移脚本。此建议未经指挥官确认,标 `[?]`。

## 5. 逐文件任务清单

### A0 脚手架
- `package.json` — deps:`zod`、`js-yaml`、SQLite 驱动(见 §9 `[?]` DB 驱动选型);devDeps:`typescript`、`vitest`、`@types/node`、`@types/js-yaml`(+ DB 驱动对应 `@types/*` 如需要)。scripts:`build`(`tsc -p tsconfig.build.json` —— B0 已落 `tsconfig.build.json`,排除 `*.test.ts` 使测试产物不进 `dist/` 污染分发,对齐 §8.5#8)、`test`(`vitest run`)、`test:watch`、`lint`(`tsc --noEmit`,含测试文件类型检查)。包管理器 pnpm。
- `tsconfig.json` — `strict: true`、`noUncheckedIndexedAccess: true`、`target`/`module` 对齐 Node v24(ESM 优先,`[?]` 需确认 CommonJS vs ESM,见 §9)、`outDir: dist`、`rootDir: src`。
- `vitest.config.ts` — 基本配置,`include: ['src/**/*.test.ts']`。
- `.env.example` — `LITELLM_BASE_URL=` / `LITELLM_TOKEN=`(仅 verity profile 用到,helix 本增量不需要真实值)、`AI_AGENT_PROFILE=helix`。
- `src/index.ts` — 引擎入口 barrel(本增量只 re-export A0/A1 已建的模块,不假装 A2+ 存在)。
- `src/shared/types.ts` — 跨层公共类型(如 `Role` 开放字符串类型、`ISODateString` 等最小集合,不过度设计)。
- `src/profile/loader.ts` — `AI_AGENT_PROFILE` 读取 + `profiles/<name>/config.yaml` 定位解析(js-yaml)+ `${ENV}` 占位替换;`profiles/verity/` 缺席时返回类型化"未找到"结果,不 throw 裸错误。
- `src/profile/errors.ts` — `ProfileNotFoundError` 等类型化错误。
- `src/profile/loader.test.ts` — 覆盖:helix 正常加载 / verity 缺席优雅降级 / config.yaml 格式错误(YAML parse 失败)不裸抛。
- `profiles/helix/config.yaml` — 最小示例(对齐 DESIGN §7 结构:providers/roles/workflow.reject_threshold),本增量 providers 字段先占位(claude-cli/codex-cli 的真实调用是 A3 的事,这里只需 loader 能解析出结构)。
- `profiles/helix/personas/coder.md` — 最小示例 persona 文本(纯文本,厂商无关)。
- `profiles/helix/personas/tester.md` — 同上。

### A1 Context 层
- `src/context/types.ts` — `Memory`、`MemoryConfirmation`、`SystemConfigEntry`、`ConfidenceState` 等类型,对齐 §4 表结构。
- `src/context/errors.ts` — `RecallError`(不静默,替代吞错误返回空数组)、`ConfirmationError`、类型化 JSON 解析错误。
- `src/context/store.ts` — SQLite 连接 + `CREATE TABLE IF NOT EXISTS`(memories/memory_confirmations/system_config)+ `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)` + FTS5 触发器同步(insert/update/delete)、基础 CRUD、FTS 召回查询(失败态用 `RecallError` 包装,不静默返回空)。
- `src/context/config.ts` — `SystemConfig` 读写(`default_stale_days`/`default_reject_threshold` 等默认值 + 覆盖),`updated_at` 写入。
- `src/context/staleness.ts` — `StalenessEngine`:按 `stale_override_days` 或 `system_config.default_stale_days` 判定一条记忆是否 stale。
- `src/context/confirmation.ts` — `ConfirmationService`:`confirm(memoryId, actor)` / `correct(memoryId, newContent, actor)` / `reject(memoryId, actor)` 三方法,**全部 `db.transaction` 包裹**(写 `memories.confidence_state`/`confirmed_at`/`confirmed_by` + 插入 `memory_confirmations` 行含 `actor` 是同一个事务);补 "无既有确认记录" 缺失路径测试(见 §9 `replaceLatest` 语义 `[?]`)。
- `src/context/injector.ts` — `ContextInjector`:①核心记忆全量 + FTS5 关键词召回;②**滤掉 `confidence_state === 'rejected'`**;③ stale/unconfirmed 记忆保留但带警告标记(不滤,只标注,对齐 DESIGN §3 sequence 图注释);④ 输出结构供 `PromptComposer` 消费。
- `src/context/store.test.ts` / `config.test.ts` / `staleness.test.ts` / `confirmation.test.ts` / `injector.test.ts` — 各自单元测试,含:confirmation 事务原子性(中途失败整体回滚)、injector 滤 rejected 的针对性测试、RecallError 触发路径测试。

### A1 Prompt 层
- `src/prompt/schema.ts` — `ClaimSchema`(对齐 `structured_claims` 概念但这里只是 zod 校验形状,不含持久化列如 `run_id`)、`CoderOutput`、`TesterOutput`(zod)。
- `src/prompt/personas.ts` — persona loader:按角色名字符串**动态**从 profile 的 `personas/` 目录查找对应 `.md`(不写死 `if role === 'coder'`),角色不存在时类型化错误;补"角色 persona 文件缺失"路径测试。
- `src/prompt/composer.ts` — `PromptComposer`:输入(角色名 + `ContextInjector` 输出 + 任务描述)→ 输出最终 prompt 字符串(人格文本 + schema 说明 + 注入的记忆,rejected 已被上游滤掉、不需要 composer 重复过滤)。
- `src/prompt/schema.test.ts` / `personas.test.ts` / `composer.test.ts`。

### 垂直切片(A1 收尾,硬性交付)
- `src/context-prompt.e2e.test.ts`(或等价位置,命名 `[?]` 待定)—— 端到端测试:①用 `store.ts` 写入 3 条记忆(confirmed/unconfirmed/rejected 各一条)→ ②`ContextInjector.inject(...)` → ③喂给 `PromptComposer.compose('coder', ...)` → ④断言最终 prompt 字符串包含 confirmed 内容、**不包含** rejected 内容、unconfirmed 内容存在但带警告标记。这条测试就是 DESIGN §8.5 "aeloop 每个里程碑收尾必须有一条薄垂直切片真正接通" 的硬证据。

### 构建/分发相关(DESIGN §8.5 #8)
- 确认 `package.json` 的 `files` 字段(或 `.npmignore`)包含 `profiles/*/personas/**/*.md`,使 `pnpm add -g` 安装时 persona 文本随包分发。**结构性说明**:aeloop 目标文件结构里 personas 位于顶层 `profiles/`、不在 `src/` 下,tsc 编译不会处理它们,所以 Verity 那种"dist 不拷 .md"问题在 aeloop 目录结构下**不会以相同形式重现**;本增量只需确认打包配置正确即可,不需要额外的构建期拷贝脚本。若 §9 `[?]`(ESM/CJS、driver 选型)决定引入构建工具链变化,届时重新核实此结论。

## 6. 批次拆解

> 单位:`[S]` ≈ 2-4h、`[M]` ≈ 半天到一天、`[L]` ≈ 1-2 天(本仓无既有估时惯例,此为本 PRD 自定义量级,仅供排期参考)。全部在同一分支 `feature/issue-1-a0-a1-scaffold` 上顺序提交 —— 理由见 §7。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | package.json / tsconfig / vitest.config / .env.example / pnpm scripts | 无(起点) | [S] |
| **B1** | src 骨架目录 + shared/types.ts + profile/loader.ts + profile/errors.ts + profiles/helix/config.yaml + personas 示例 + 对应测试 | B0 | [M] |
| **B2** | context/types.ts + errors.ts + store.ts(建表 + FTS5 + CRUD + RecallError)+ store.test.ts | B1(需要 profile 决定 db 路径约定,但 store 本身可先用显式路径参数实现,不强耦合 profile) | [M] |
| **B3** | context/config.ts(SystemConfig)+ staleness.ts(StalenessEngine)+ 对应测试 | B2 | [S] |
| **B4** | context/confirmation.ts(ConfirmationService 三态 + db.transaction + 补列)+ confirmation.test.ts(含事务原子性 + 缺失路径测试) | B2 | [M] |
| **B5** | context/injector.ts(ContextInjector,含滤 rejected)+ injector.test.ts | B2 + B3 + B4 | [M] |
| **B6** | prompt/schema.ts(zod:ClaimSchema/CoderOutput/TesterOutput)+ schema.test.ts | B0(独立于 Context,可与 B2-B5 并行写但同分支顺序提交) | [S] |
| **B7** | prompt/personas.ts(动态角色 persona loader)+ personas.test.ts | B1(需要 profile 提供 personas 目录) | [S] |
| **B8** | prompt/composer.ts(PromptComposer)+ composer.test.ts | B5 + B6 + B7 | [M] |
| **B9** | 垂直切片端到端测试(Context→Prompt 真接通,含 rejected 过滤断言) | B8 | [S] |
| **B10** | 打包配置核实(`files`/`.npmignore` 含 personas `.md`)+ README/CLAUDE.md 打钩更新 + docs/ROADMAP.md/PROGRESS.md/CHANGELOG.md 回写 | B9 | [S] |

**依赖图要点**:B6(Prompt schema)不依赖 Context,理论上可与 B2-B5 并行开发;但因本增量由同一个 Cypher 顺序实现(非多人协作),不额外开分支拆分,B6 排在 B2-B5 之后只是顺序选择,不是硬依赖 —— 若未来需要多 agent 并行,B6/B7 可独立拆到并行分支。B9 垂直切片是唯一**必须等前面全部完成**才能做的收尾批次,不可提前造假通过。

## 7. 分支策略

单分支 `feature/issue-1-a0-a1-scaffold`,批次按 §6 顺序提交,理由:
- 本增量是一个人(Cypher)从零建全新 src/ 骨架,批次间大部分是真依赖(B2→B3→B4→B5→B8→B9 链式),没有独立可合并的并行工作流。
- B6(Prompt schema)虽逻辑独立,但代码量小、无需为此单独开分支承担合并开销。
- 若指挥官希望拆更细粒度的 PR 供 Zorro 分批审(而非一次性大 diff),可在同一分支内按 B0-B1 / B2-B5(Context)/ B6-B9(Prompt+切片)/ B10 四个自然断点分别提交并请求阶段性审查,不必等全部完工才交审。

## 8. 可测验收标准(可勾选)

- [x] `pnpm build` 成功(tsc strict + noUncheckedIndexedAccess 无报错)。—— B10 复核实测通过。
- [x] `pnpm test` 全绿(vitest run)。—— B10 复核实测 **96/96**。
- [x] `AI_AGENT_PROFILE=helix` 时 `profile/loader.ts` 正确解析 `profiles/helix/config.yaml`;`AI_AGENT_PROFILE=verity` 且 `profiles/verity/` 不存在时返回类型化"未找到"结果而非抛裸异常或静默返回空对象。—— B1(`948fd24`)。
- [x] `memories`/`memory_confirmations`/`system_config` 三张表按 §4.1 列齐全建出(含新补 `confirmed_at`/`confirmed_by`/`actor`/`updated_at` 四列)。—— B2(`0eea001`)。
- [x] `ConfirmationService` 的 `confirm`/`correct`/`reject` 三方法均用 `db.transaction` 包裹;有一条测试证明"事务中途失败则整体回滚,不留半写状态"。—— B4(`b24fa3f`)。
- [x] `ContextInjector` 有一条**针对性测试**证明 `confidence_state === 'rejected'` 的记忆不会出现在注入结果里。—— B5(`06259c9`)。
- [x] persona loader 按角色名字符串动态解析(非硬编码 `{coder,tester}`),有测试覆盖"角色 persona 文件缺失"路径。—— B7(`88852a5`)。
- [x] 所有 `JSON.parse` 调用点(本增量涉及的:`tags` 反序列化 / config.yaml 相关如适用)都包在 try-catch 里,失败进类型化 error,不裸抛 `SyntaxError`。—— B10 复核 `grep -rn "JSON.parse" src` 唯一命中点(`store.ts:209` tags 反序列化)包在 try-catch → `MemoryTagsParseError`;`profile/loader.ts` 的 `loadYaml(...)` 同样包在 try-catch → `ProfileConfigParseError`。
- [x] **硬性垂直切片测试存在且通过**:一条端到端测试证明 Context(`ContextInjector`)→ Prompt(`PromptComposer`)真的接通(种子数据 → 注入 → 组装 → 断言最终 prompt 内容),不是分层孤立测试拼出来的假象。—— B9(`4eb97e4`)。
- [x] `package.json` `files`/`.npmignore` 确认 `profiles/*/personas/**/*.md` 会随包分发。—— B10 用 `pnpm pack` 实打包核实:`files` 字段(无 `.npmignore`,`files` 单独生效)已含 `profiles/*/personas/**/*.md` + `profiles/*/config.yaml`(B0 已落好,B10 只复核);`tar -tzf` 确认 tarball 内 `dist/` 无任何 `*.test.*` 泄漏。
- [x] `docs/ROADMAP.md` 对应 A0/A1 勾选项更新、`docs/PROGRESS.md` 清空或更新、`CHANGELOG.md` 加行、`profiles/verity/` 未被误提交(`git status` 确认 `.gitignore` 生效)。—— B10 本批完成。

## 9. 依赖 / 风险

### 9.0 决策已定(2026-07-20 指挥官批,下方 `[?]` 据此收敛,不再当未决项)
1. **SQLite 驱动 = better-sqlite3**(稳定优先;node:sqlite 实测 FTS5 可用但仍 Experimental,留作未来减依赖备选)。
2. **模块系统 = ESM**(`"type":"module"` + NodeNext);B0 若发现 vitest/better-sqlite3 在 ESM 下有坑,当场报告不硬扛。
3. **lint = A0 只用 `tsc --noEmit`,不引 eslint**;eslint 留到后续增量再补(引擎长期要养,但非 A0 范围)。
4. **`tags` 序列化 = JSON 数组字符串**(`JSON.stringify`/`JSON.parse` + try-catch)。
5. **`replaceLatest` 语义 = 按语义自实现**(Verity 源码在公司内网、越界不读,不照抄外部命名);`ConfirmationService.correct()` 承载「修正最新内容」,补有/无既有确认记录两条路径测试。

**依赖**:
- Node v24(已确认本机 `v24.1.0`,与 `CLAUDE.md` §2 一致)。
- npm registry 可达(本次核实以下包当前可解析版本,供 `package.json` 版本区间参考,非锁定具体版本):`zod@4.4.3`、`js-yaml@5.2.1`、`vitest@4.1.10`、`typescript@7.0.2`、`better-sqlite3@12.11.1`。以上为 2026-07-20 当天 `npm view` 实测结果,写入 `package.json` 时用 `^` 区间而非锁死这些精确值。

**风险 / `[?]` 待 spike 或指挥官确认**(逐条明确,不编造结论):

1. `[?]` **SQLite 驱动:better-sqlite3 vs node:sqlite**。已本机验证 `node:sqlite`(Node v24.1.0 内置)的 `DatabaseSync` 支持 `CREATE VIRTUAL TABLE ... USING fts5(...)` 且可正常建表(实测通过,见本次 PRD 撰写过程中的 spike:`node -e "require('node:sqlite')..."` 建 FTS5 表成功)。但 `node:sqlite` 目前仍带 `ExperimentalWarning`(实验性 API,可能变动),而 `better-sqlite3@12.11.1` 是成熟稳定的第三方原生模块。**建议**:A0/A1 用 `better-sqlite3` 作为主选(稳定、CLAUDE.md 已列为技术栈首选、"已在开发机验证可装"),`node:sqlite` 的验证结果记录在案作为未来减依赖的备选,不在本增量切换。此建议未经指挥官拍板,标 `[?]`。
2. `[?]` **ESM vs CommonJS**。`package.json`/`tsconfig.json` 的 module 系统本次未与指挥官核实,CLAUDE.md 技术栈表未写明。建议默认 ESM(`"type": "module"` + `NodeNext` module 解析,Node v24 对 ESM 支持成熟),但需指挥官确认或在 B0 批次开工前用一次小 spike(建最小 vitest+TS ESM 项目跑通)验证 vitest/better-sqlite3 在 ESM 下无坑再定案。
3. `[?]` **lint 工具选型**。CLAUDE.md 技术栈表未列 eslint 或其他 lint 工具;DESIGN §8.5 #8 只写"配 lint 脚本"未指定用什么。本增量默认先用 `tsc --noEmit` 作为最小静态检查(已有依赖,零新增),不引入 eslint 等未在技术栈表出现的新依赖,除非指挥官确认要加。
4. `[?]` **`tags` 列序列化格式**。DESIGN §5 ER 图只标 `tags TEXT`,未定是 JSON 数组字符串还是逗号分隔。本增量默认 JSON 数组字符串(`JSON.stringify`/`JSON.parse`,配 try-catch),因为要支持 FTS5 关键词召回时可能需要结构化处理;此选择未经指挥官确认。
5. `[?]` **`replaceLatest` / persona 缺失路径测试的确切语义**。军师给的必修项原文提到"加一个 replaceLatest / persona 解析测试",但 aeloop 是全新著作(Verity 源码属公司内部仓,不在本项目可见性边界内,未读取),我无法核实 Verity 侧 `replaceLatest` 的确切方法名/签名。**本增量按语义实现**:`ConfirmationService.correct()` 处理"修正一条记忆的最新内容"这个动作,并补两条测试(有既有 `memory_confirmations` 记录时 / 该记忆是首次被确认、无既有记录时);persona loader 补"角色文件缺失"路径测试。具体方法命名以本仓 A1 实现为准,不强行照抄一个我没验证过的外部命名。
6. **风险(非 [?],是提醒)**:B2(store.ts)是本增量体量最大的单文件(建表+FTS5 触发器+CRUD+召回),建议在 B2 内部再细分小提交(建表→CRUD→FTS5 触发器→召回查询),避免一次性大改动不好审。
7. **风险**:垂直切片测试(B9)是整个增量能否通过 Zorro 审的关键项,必须真实种子数据跑真实 SQLite 文件(或内存 db),不能 mock 掉 `ContextInjector`/`PromptComposer` 之间的调用来"造出"通过的假象——这正是 DESIGN §8.5 点名的方法论警示,Zorro 审查时会重点对抗式核这条。

## 10. 项目约束检查

- **模型无关?** 是——本增量(A0/A1)不出现任何具体 provider/model 名字;`profiles/helix/config.yaml` 里的 `providers.claude-cli`/`codex-cli` 只是配置结构占位,真实调用逻辑在 A3,本增量的 loader 只解析 YAML 结构、不硬编码判断分支。
- **无跨层反向依赖?** 是——`src/prompt/` 不 import `src/context/` 的内部实现细节(`PromptComposer` 只依赖 `ContextInjector` 的**输出类型**,不反向依赖 Prompt);`src/context/` 不 import `src/harness/`/`src/loop/`(这两层本增量不存在)。
- **`profiles/verity/` 不入仓?** 是——本增量完全不创建 `profiles/verity/` 任何文件;仓库 `.gitignore` 已有 `profiles/verity/` 规则(已核实,见 aeloop 仓根 `.gitignore`),B10 收尾会再核一次 `git status` 确认没有误建。
- **角色不硬编码?** 是——persona loader 与 `PromptComposer` 按角色名字符串动态查找,不写 `if role === 'coder'`(对齐 DESIGN §1.7)。
- **引擎代码不含 Helix 人格?** 是——`src/` 下所有代码零 Helix/companion/私人记忆内容,仅 `profiles/helix/` 下的示例 persona 文本(个人 overlay,允许在私有仓内存在)。
