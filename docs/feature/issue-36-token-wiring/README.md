# issue #36 slice 1 — 把 `ContextBudgetManager` 接进真实的 `ContextInjector` -> `PromptComposer` 路径

## issue #36 slice 2 — 把 context-omission 元数据带进 `EvidenceBundle`

slice 1 的后续:slice 1 停在"省略列表在 injector 的返回值和组装出的 prompt 文本里可见"这一步——这一
slice 把同一份信息再往前带一跳,带进引擎的 `LoopEvent`/`EvidenceBundle` 可观测性表面(issue #29),
这样 evidence 层的订阅方不用直接伸手进 `ContextInjectionResult` 就能看到哪些东西被省略了。

**新增了什么:**

- **`src/loop/events.ts`** —— `RunStartedEvent` 新增一个可选的
  `contextOmitted?: readonly {id:number; type:string; title:string;
  reason:string}[]` 字段。没有新增 `LoopEvent` 变体,也没有改动任何既有事件的顺序——这完全是搭
  `run_started` 这个既有事件的便车。
- **`src/loop/runner.ts`** —— `startRun()` 现在会在 `input.injectedContext.omitted` 字段存在
  且非空时,用它填充 `contextOmitted`。当该字段缺失(budgeting 关闭)或为空(没有任何东西被省略)
  时,`contextOmitted` 本身保持**缺失**(这个 key 根本不设置,而不是设成 `[]`)——和
  `ContextInjectionResult.omitted` 自己"缺失即无需上报"的约定保持一致,并让 `runner.test.ts` 里
  每一条既有的 `run_started` fixture/断言(`toMatchObject`,本来就不关心多出来的字段)原样保持有效。
- **`src/evidence/bundle.ts`**:
  - 新增 `OmittedContextEntry` 类型(和 `RunStartedEvent` 的 `contextOmitted` 元素形状一致)。
  - `EvidenceBundle` 新增一个必填的 `omittedContext: readonly
    OmittedContextEntry[]` 集合,遵循它那几个兄弟集合
    (`requirements`/`claims`/`evidence`/`eventTypes`)已经在用的"始终存在/默认为 `[]`"约定——
    永不是 `undefined`。
  - `EvidenceBundleBuilder.recordEvent()` 会在 `run_started` 事件上有 `contextOmitted` 时把它取
    出来;其它任何事件,或者一个没有该字段的 `run_started` 事件(旧事件,或 budgeting 关闭),
    都让 `omittedContext` 停在它的 `[]` 默认值——不抛错,也不做特殊处理。
  - `EvidenceEventProjector` 不需要任何代码改动——它本来就无条件把每个事件转发给
    `builder.recordEvent()`,所以这个新字段和 `eventTypes`/`status` 走的是同一条路径。

**这一 slice 明确没有动的地方**(留给下一 slice 的边界):

- `PromptDelta` / `buildPromptDelta()` —— 仍未动,和 slice 1 一样。
- Provider 层缓存 —— 仍未动,和 slice 1 一样。
- `AuditStore` schema —— 没有新增列/表;`omittedContext` 目前只活在内存里的
  `EvidenceBundle`/`LoopEvent` 层,还没有落到任何持久化的地方。把它接进 `AuditStore`(如果确实
  需要的话)是另一块尚未开始的工作。**(已在下面的 slice 3 里完成——这一条按原样保留,作为 slice 2
  当时覆盖范围的历史记录。)**
- 没有新增任何 `LoopEvent` 类型,`runner.ts` 里任何既有事件的相对顺序也都没有变。

## issue #36 slice 3 —— 把 context-omission 遥测数据持久化进 `AuditStore`

slice 2 的后续,收口那一节明确留开的边界("把 `omitted` context 接进一个持久化的 evidence/audit
store"——当时列为"这一 slice 没动"/"另一块尚未开始的工作")。slice 2 把省略列表带到了内存里的
`LoopEvent`/`EvidenceBundle` 层为止;这一 slice 把它带完剩下的路,带进 `AuditStore` 的持久化
SQLite 表,让这条省略轨迹能像 `structured_claims`/`approvals`/`step_markers` 那样扛得住进程重启。

**新增了什么:**

- **`src/loop/audit-store.ts`** —— 一张新的、向后兼容的
  `CREATE TABLE IF NOT EXISTS context_omissions` 表(`run_id` 引用
  `workflow_runs(id)`,加上 `memory_id`、`memory_type`、`title`、`reason`、`created_at`),外加一个
  `UNIQUE (run_id, memory_id)` 约束——和 `approvals`/`step_markers` 的 `UNIQUE (run_id,
  step_ref)` 约束同一种低成本纵深防御,按 run 范围隔离,所以两个不同的 run 各自都可以独立省略同一
  条 memory。新增了带类型的 domain 类型(`ContextOmission`/`NewContextOmissionInput`)、一个行形状
  接口(`ContextOmissionRow`),外加两个新方法——`insertContextOmission(input, now?)`(插入 +
  读回,和 `insertClaim`/`insertApproval`/`insertStepMarker` 同一种错误包装约定:写入错误原样
  往外抛,读回失败抛 `AuditReadError`)和 `listContextOmissionsByRun(runId)`(把抛出的 SQLite
  错误包成 `AuditReadError`,和 `listStepRefsByRun`/`listRunsByStatus` 同一种约定)。
- **`src/loop/runner.ts`** —— `startRun()` 现在把它的 `workflow_runs` 插入操作包起来,并且在
  `input.injectedContext.omitted` 存在且非空时,为每一条被省略的条目调一次
  `insertContextOmission()`,全部包在单独一次 `AuditStore.runInTransaction()` 调用里。因此一次
  遥测写入失败也会把 `workflow_runs` 那一行一起回滚,而不会留下一行没有对应省略轨迹的 run 记录。
  当 `input.injectedContext.omitted` 缺失或是空数组时,不会写入任何 `context_omissions` 行,
  无省略路径和这一 slice 之前逐字节保持一致。

**这一 slice 明确没有动的地方:**

- `PromptDelta` / `buildPromptDelta()` 和 provider 层缓存——仍未动,和 slice 1、2 一样。
- 没有引入新的 `LoopEvent` 类型;`RunStartedEvent.contextOmitted`(slice 2)保持不变,依然是这份
  数据在事件层唯一的载体——`context_omissions` 是一个独立的、持久化的落点,由同一个
  `input.injectedContext.omitted` 值喂进去,不是要取代它。

## 这一 slice 的范围

这一 slice 只实现 aeloop#36 里一块边界清楚的部分:让已经测试过的 `ContextBudgetManager`
(`src/context/budget.ts`)真正能从真实的 CLI/loop 路径够得到,这样一个 profile 就能给注入的
context 设一个硬性 token 上限,并以可审计的方式看到哪些东西被留在外面、为什么。

**这一 slice 明确不在范围内**(另外的后续工作,这里还没开始):

- `buildPromptDelta()` / `PromptDelta`(稳定前缀缓存、只差量重试)—— 这一 slice 之后,loop/CLI/
  harness 里依然没有任何调用方调用它。它到底该属于 `PromptComposer`、adapter 请求层,还是 provider
  缓存层,是原始 issue 自己标注为尚未定论的一个开放设计问题;这一 slice 不打算回答它。
- Provider 层缓存(比如 Anthropic 的 prompt caching header)——未动。
- 把 `omitted` context 接进一个持久化的 evidence/audit store。这一 slice 让省略列表在 injector 的
  返回值和组装出的 prompt 文本里可见(见下文);它不会把这份数据写到任何持久化的地方
  (`AuditStore` 等)。

## 改了什么

- **`src/profile/loader.ts`** —— `ProfileConfig` 新增一个可选的
  `context.token_budget?: number` 字段。不写 `context`(或其中的
  `context.token_budget`)的话行为完全不变——没有任何隐式的默认值会被套用。
  `DEFAULT_CONTEXT_TOKEN_BUDGET`(`src/context/injector.ts`)是一个有文档记录、可选择启用的推荐
  值(`8000`),从不会被自动套用。
- **`src/context/injector.ts`**:
  - `MEMORY_TYPE_CONTEXT_PRIORITY`:一份确定性的 `MemoryType ->
    ContextPriority` 映射,覆盖全部 12 种 memory 类型。
  - `PROTECTED_MEMORY_TYPES`:`constraint` / `requirement` / `decision` 被当作受保护的治理类
    memory——`ContextBudgetManager` 永远不会悄悄丢掉它们;如果放不下一条,`inject()` 会抛
    `ContextBudgetExceededError`(fail-closed),不会退化成一个空的/部分的结果。
  - `ContextInjector` 的构造函数新增一个可选的第三参数
    `budgetManager?: ContextBudgetManager`。缺省(默认情况)时,`inject()` 和这一 slice 之前逐
    字节完全一样。传入时,已经过拒绝过滤、打上警告标记的 memory 列表会被丢进 budget manager 里跑
    一遍,`ContextInjectionResult` 新增一个可选的 `omitted?: OmittedMemory[]` 字段,记录哪些
    memory id 被留在外面、原因是什么。
  - **关于这里"受保护"是什么意思的说明**:这份映射只会看到已经存在于
    `ContextInjectionResult` 里的 `Memory` 行。它不保护 `TaskContract` 或 `RunPolicy` 对象——
    这两种类型都不是这个代码库里这个结果形状的一部分,所以注释里任何地方都没有做这样的声明。
- **`src/prompt/composer.ts`** —— `compose()` 的签名没变。当 `context.omitted` 是一个非空数组
  时,组装出的 prompt 会新增一个 `# Omitted Context` 小节,列出每条被省略 memory 的类型、标题和
  原因。当 `omitted` 是 `undefined` 或为空(现有的每一个调用方都是这样,因为默认没有任何 profile
  启用 budgeting)时,这个小节永远不会出现——输出和这一 slice 之前完全一致。
- **`src/cli/assemble.ts`** —— `resolveContextBudgetManager(profileConfig)` 从
  `profileConfig.context?.token_budget` 构造一个 `ContextBudgetManager`,该字段缺失时返回
  `undefined`(仿照既有的 `resolveRejectThreshold()` 三层回退模式那种"显式输入、可独立测试"的形
  状,只是少了回退层级,因为这个字段没有回退层级)。`assembleProfileDeps()` 把结果传给
  `new ContextInjector(memoryStore, staleness, budgetManager)`。

## 向后兼容性

一个完全没有 `context:` 这个 key 的 profile 的 `config.yaml`(比如仓库里已提交的
`profiles/subscription/config.yaml`)得到的行为和这一 slice 之前一模一样:无限制的 memory 注入、
`result.omitted === undefined`、组装出的 prompt 不变。这一点直接在
`src/cli/__tests__/assemble.test.ts` 的 "context.token_budget wiring end-to-end" describe 块里
有断言。
