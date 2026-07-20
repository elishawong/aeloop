# PRD — aeloop A2:Harness 层(ProviderRouter + ModelAdapter 接口 + LiteLLMAdapter + SchemaValidator)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a0-a1-engine-scaffold-context-prompt/PRD.md`(同仓已有 PRD 的写法惯例,沿用其分层/批次/验收表述风格)。
> 防幻觉:`[?]` = 我未验证 / 需要 spike 或指挥官确认,不编造接口/版本/参数。

- **项目**:aeloop(`elishawong/aeloop`,私有仓)
- **分支**:`feature/issue-6-a2-harness`(单分支,批次内顺序提交 —— 理由见 §7)
- **优先级**:P1
- **状态**:已批(2026-07-20 Elisha 批准。§9.2 ajv 定案 = **跳过**,用 zod 直校;§9.1 ProviderRouter/config.ts 拆分军师已认可)
- **最后更新**:2026-07-20
- **关联 issue**:[elishawong/aeloop#6](https://github.com/elishawong/aeloop/issues/6)(本增量)· 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§7 适配层设计 / §8 里程碑 A2 / §8.5 Verity M2/M3 必修清单 / §1.6 层→代码映射 / §1.7 无跨层反向依赖)

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A0+A1(profile loader / Context 三表+FTS5+事务/injector / Prompt 动态 schema-registry/composer)已 merge,但 aeloop 还没有任何「真的去调一个模型」的能力。这正是 Verity 最大的洞:`ProviderRouter` 压根没做,`LiteLLMAdapter` 硬编码 provider,导致「配置声称模型无关,实际只能用 LiteLLM 一条路」。A2 建 Harness 层,把「选模型 + 调模型 + 校验模型输出」做成可插拔、可测试、模型无关的一层。
- **给谁用**:A2 本身是下游的直接消费方 —— A3(ClaudeCliAdapter/CodexCliAdapter/ToolExecVerifier)要复用同一个 `ModelAdapter` 接口和 `AdapterRegistry`;A4(Loop/LangGraph 编排的 Coder/Tester 节点)要直接调 `ProviderRouter.route(role)` 拿到 adapter、调 `SchemaValidator.validate(...)` 拿到校验过的结构化结果。短期内直接使用者是 Cypher/Zorro 在本增量和后续增量里跑测试。
- **一句话方案**:按 DESIGN §7 建 `ModelAdapter` 接口 + `ProviderRouter`(角色→provider id→adapter 纯查找,零 I/O)+ `AdapterRegistry`(id→adapter 实例的注册表)+ `harness/config.ts`(从 `ProfileConfig` 构造出真实 adapter 并注册进 registry,这是"新增一个 provider 需要碰的地方",不是 router)+ `LiteLLMAdapter`(第一个真实 direct-api 实现)+ `SchemaValidator`(校验 + 失败重试并把上次错误喂回模型),并用一条硬性垂直切片测试证明 `PromptComposer` 的输出真的能流过 `ProviderRouter → adapter.invoke → SchemaValidator` 拿到 typed 结果。

## 2. 目标 / 非目标

**目标**:
- `src/harness/types.ts`:`ModelAdapter` 接口(`id`/`kind`/`checkAvailability()`/`invoke()`/可选 `toolTrace()`)+ `InvokeRequest`/`InvokeResult`/`AvailabilityResult` 类型(DESIGN §7 + §8.5#4)。
- `src/harness/provider-router.ts`:`ProviderRouter` —— 读 `RoleConfig.provider` → 从 `AdapterRegistry` 取对应 adapter;**本身零 I/O、零具体 adapter 类引用**,加一个新 provider 不改这个文件一行(DESIGN §8.5#1)。
- `src/harness/adapter-registry.ts`:`AdapterRegistry` —— 按 `id` 注册/取 `ModelAdapter` 实例(纯 Map 封装,无业务逻辑)。
- `src/harness/config.ts`:`buildAdapterRegistry(profileConfig)` —— 从 `ProfileConfig.providers` 构造真实 adapter 并注册进 `AdapterRegistry`(DESIGN §6 文件结构明确把 `config.ts` 列在 harness 目录下;这是"新增 provider 要碰的地方",不是 router —— 见 §9.1 对这条边界的讨论)。
- `src/harness/adapters/litellm-adapter.ts`:`LiteLLMAdapter`(`kind: "direct-api"`)—— 调 LiteLLM 代理;`JSON.parse` 全包 try-catch → 统一 `AdapterInvokeError`(§8.5#5);`checkAvailability()` 做真实网络探活,不只看 config 里有没有列出这个 provider(§8.5 的 deepseek 教训:「列表可见≠可调用」)。
- `src/harness/schema-validator.ts`:`SchemaValidator` —— 拿 `schema-registry.ts` 已有的 zod schema 校验模型输出;失败重试 1 次,**把上次校验错误文本追加进重试请求的 prompt**,不是原样重发(§8.5#3)。
- `src/harness/errors.ts`:`AdapterInvokeError`/`RoleNotBoundError`/`AdapterNotRegisteredError`/`SchemaValidationError` 等类型化错误。
- **硬性垂直切片**:一条端到端测试证明「`PromptComposer` 输出的 prompt 字符串 → `ProviderRouter` 选中正确 adapter → adapter.invoke(用 fake adapter,不打真实网络)→ `SchemaValidator` 校验通过 → 拿到 typed `CoderOutput`」这条链路真的接通,不是三个各自绿的孤立测试。

**非目标(明确不做,留给后续增量)**:
- ❌ CLI 桥接 adapter(`ClaudeCliAdapter`/`CodexCliAdapter`)+ `ToolExecVerifier` —— A3(含 codex exec spike)。`InvokeResult` 会预留 `toolExecChecked` 字段位置,但本增量任何 adapter 都不会真的填它。
- ❌ Loop 层(LangGraph 编排 / G1-G3 gate / 阈值升级 / checkpoint)—— A4;`workflow_runs`/`structured_claims`/`approvals` 三张表**不在本增量建表范围**(A2 是无状态的调用层,不碰数据库)。
- ❌ 打真实 LiteLLM 公司代理(本地无该环境)—— 测试用本地 `node:http` 假服务器 + fake adapter,不连真实网络;`checkAvailability()` 的真实探活策略(具体打哪个端点)标 `[?]`,留给实现批次内的小 spike(见 §9.3)。
- ❌ `SchemaValidator` 之后「校验彻底失败该怎么办」(标 lowConfidence / 打回 / 升级)—— 那是 A4 Loop 状态机的事;A2 的边界到「重试一次仍失败 → 抛类型化错误」为止。

## 3. 用户故事

- 作为 **A4 的 Loop 开发者**,我想要 `ProviderRouter.route("coder")` 直接给我一个能调的 `ModelAdapter`,不用关心它背后是 LiteLLM 还是别的什么,以便 Coder/Tester 节点的代码完全不知道具体 provider 是谁。
- 作为 **A3 的 CLI 桥接开发者**,我想要 `ModelAdapter` 接口已经稳定,我只需要新写一个 `ClaudeCliAdapter implements ModelAdapter` 并在 `harness/config.ts` 里加一段构造逻辑,不需要改 `provider-router.ts`。
- 作为 **指挥官**,我想要看到一条测试证明「加第二个 provider,路由到它,不改 router 代码」——不是文档自称,是真跑测试证明(Verity 的教训)。
- 作为 **A4 的 Loop 开发者**,我想要模型吐出格式不对的 JSON 时,`SchemaValidator` 能自动重试一次并把「你上次错在哪」喂回模型,而不是原样再问一遍、指望运气。

## 4. 数据模型

本增量**无状态、不建表**——Harness 层本身不持久化任何东西(`structured_claims`/`workflow_runs`/`approvals` 三张表是 A4 Loop 的事,DESIGN §5 已明确)。唯一"数据形状"是内存态的请求/响应类型,列在 §5 的 `harness/types.ts` 里,不是数据库 schema。

## 5. 逐文件任务清单

### Harness 核心
- `src/harness/types.ts` —— 核心类型:
  - `ModelAdapter` 接口(DESIGN §7 原样):
    ```typescript
    interface ModelAdapter {
      readonly id: string;                 // "litellm" | 未来 "claude-cli" | "codex-cli"
      readonly kind: "direct-api" | "cli-bridge";
      checkAvailability(): Promise<AvailabilityResult>;
      invoke(req: InvokeRequest): Promise<InvokeResult>;
      toolTrace?(): ToolCallRecord[];       // cli-bridge 专属,A3 才用,A2 不实现任何返回它的 adapter
    }
    ```
  - `InvokeRequest`:`{ role: Role; prompt: string }`(`prompt` = `PromptComposer.compose()` 的输出字符串;`Role` 复用 `../shared/types.js` 的开放字符串类型,不新增角色约束)。
  - `InvokeResult`:`{ content: string; provider: string; model: string; toolExecChecked?: "pass" | "fail" | "na" }`(§8.5#4 硬性要求 `provider`/`model` 必带;`toolExecChecked` 是 A3 的字段,A2 的 adapter 一律不设置这个字段,不是设置成 `"na"` 占位——`undefined` 比编一个假值更诚实)。
  - `AvailabilityResult`:`{ available: boolean; reason?: string; checkedAt: ISODateString }`。
  - `ToolCallRecord`:`[?]` 形状留空/占位(A3 定义),A2 只需要 `toolTrace?(): ToolCallRecord[]` 这个方法签名存在于接口上,不需要这个类型有实际内容——**建议**本增量把 `ToolCallRecord` 定义成一个最小占位 `interface ToolCallRecord { [key: string]: unknown }` 并在注释里注明"A3 会替换成真实形状",避免 A3 开工时还要回头改这个文件的接口签名。
- `src/harness/errors.ts`:
  - `AdapterInvokeError`(HTTP/网络/`JSON.parse` 失败统一包装,`cause` 保留原始错误,风格对齐 `context/errors.ts`/`profile/errors.ts` 已有的 `describeCause` 惯例)。
  - `RoleNotBoundError`(`ProviderRouter.route(role)` 时 `role` 在 `ProfileConfig.roles` 里没有绑定)。
  - `AdapterNotRegisteredError`(`role` 绑定的 `provider` id 在 `AdapterRegistry` 里没有注册的 adapter —— 覆盖"config 写了但没人构造对应 adapter"和"provider id 打错字"两种情况,`ProviderRouter` 不需要关心是哪一种,都是"这个 id 我这没有")。
  - `SchemaValidationError`(重试后仍未通过校验,携带两次尝试的原始 `content` + zod 错误信息,供调用方/日志诊断,不是静默失败)。
- `src/harness/adapter-registry.ts`:`AdapterRegistry` 类 —— `register(adapter: ModelAdapter): void`(按 `adapter.id` 存)、`get(id: string): ModelAdapter | undefined`、`has(id: string): boolean`。纯数据结构封装,不含任何 provider 具体知识。
- `src/harness/provider-router.ts`:`ProviderRouter` 类 —— 构造函数接收 `roles: ProfileConfig["roles"]` + `registry: AdapterRegistry`(**不接收整个 `ProfileConfig`,只拿它需要的 `roles` 切片**,减少隐式耦合,对齐 A1 `PromptComposer`/`MemoryStore` 一贯的"显式传所需依赖,不传整个大对象"风格)。`route(role: Role): ModelAdapter` —— 查 `roles[role]` 不存在 → 抛 `RoleNotBoundError`;取到 `provider` id 后查 `registry.get(id)` 不存在 → 抛 `AdapterNotRegisteredError`;否则返回 adapter。**这个文件本增量之后新增 provider 永远不需要再改**——这是 §8.5#1 验收项的字面要求,也是本 PRD 唯一一处要求"有测试证明改动量为零"的地方(测试策略见 §9.1)。
- `src/harness/config.ts`:`buildAdapterRegistry(config: ProfileConfig): AdapterRegistry` —— 遍历 `config.providers`,按 `kind` 分派构造:`kind === "direct-api"` → 目前只认得 `LiteLLMAdapter`(`new LiteLLMAdapter(id, providerConfig)`);`kind === "cli-bridge"` → **本增量不构造任何东西,显式跳过**(注释写明"A3 补 ClaudeCliAdapter/CodexCliAdapter 的构造分支于此"),不是报错也不是造一个假 adapter——`profiles/helix/config.yaml` 目前两个 provider 都是 `cli-bridge`,用这份真实配置跑 `buildAdapterRegistry` 应该返回一个空的 `AdapterRegistry`,这是预期行为而非 bug,需要一条测试固定住这个预期(否则未来有人"顺手"给 cli-bridge 分支塞一个占位实现,悄悄违反"A3 才做 CLI 桥接"的边界)。
- `src/harness/adapters/litellm-adapter.ts`:`LiteLLMAdapter implements ModelAdapter`:
  - 构造:`new LiteLLMAdapter(id: string, config: { base_url?: string; api_key?: string; model?: string })`(`config` 形状取自 `ProfileConfig.providers[id]`,即 A1 `ProviderConfig` 类型,字段已在 profile loader 里做过 `${ENV}` 替换)。
  - `kind = "direct-api"`。
  - `invoke(req)`:向 `${base_url}/chat/completions` 发 `POST`(**`[?]` 端点路径/请求体形状未经真实 LiteLLM 代理验证**——假定 LiteLLM 代理暴露 OpenAI 兼容的 `chat/completions` 端点这是 LiteLLM 项目对外的公开定位,但本机没有可连的公司代理实例做实测,不能当"已验证"写;实现时按这个假定写,同时把这条 `[?]` 原样留到 progress.md,等真的接上公司代理才能摘掉)。请求体大致含 `model`/`messages`(把 `req.prompt` 包成单条 `user` message)/可能的 `response_format`(结构化输出相关,`[?]` 是否需要以及具体形状未验证,MVP 可以先不传、只在 prompt 文本里已有的 schema 说明上依赖模型自觉,校验交给 `SchemaValidator` 兜底——即使传了 `response_format` 也不能替代 `SchemaValidator`,那道闸不能因为"上游可能已经保证格式"就跳过)。
  - 拿到 HTTP 响应后:非 2xx → 按状态码分类包成 `AdapterInvokeError`(401/403/429/5xx 各自测试覆盖,见 §5 测试小节);2xx 但响应体 `JSON.parse` 失败或结构不是预期形状 → 同样包成 `AdapterInvokeError`,不裸抛 `SyntaxError`(§8.5#5)。
  - `base_url` 做尾斜线归一化(`base_url.replace(/\/+$/, "")` 再拼路径),避免 `https://x.com/` + `/chat/completions` 拼出 `https://x.com//chat/completions` 这种 Verity 实测踩过的坑(§8.5#6)。
  - `api_key` 缺失时**不裸拼字符串**(避免 ``Authorization: Bearer ${undefined}`` 这种把 `"undefined"` 当 token 发出去的经典 bug——Verity M3 那类"缺列/缺值静默传播"问题的同族);缺失时直接不设 `Authorization` header,让代理自己决定要不要因为没有认证头而 401(测试覆盖这条路径,见 §8.5#6)。
  - `checkAvailability()`:发一次真实 HTTP 请求判定可用性(不是只检查 `base_url`/`api_key` 是否配置了值就算"可用")。**`[?]` 具体打哪个端点/用什么最小请求未定**(留 §9.3 讨论),但无论最终选哪个,验收底线是"这条路径必须发出一次真实网络请求并依据响应判定",不能退化成配置存在性检查——这是 §8.5 表格"列表可见≠可调用"教训的直接对应项。
  - `toolTrace` 不实现(`kind: "direct-api"` 的 adapter 天然没有工具调用流可核,接口上这个方法是可选的,`LiteLLMAdapter` 干脆不定义它)。
- `src/harness/schema-validator.ts`:`SchemaValidator` 类:
  - `validate<T>(params: { schema: z.ZodType<T>; request: InvokeRequest; invoke: (req: InvokeRequest) => Promise<InvokeResult> }): Promise<{ data: T; result: InvokeResult; attempts: 1 | 2 }>`。
  - 第一次:`invoke(request)` → 尝试 `JSON.parse(result.content)` → 失败或 `schema.safeParse()` 不通过 → 进重试分支。
  - 重试分支:构造 `retryRequest = { ...request, prompt: request.prompt + "\n\n---\n\n# Previous Attempt Failed Validation\n\n" + <失败原因,含 JSON parse 错误或 zod 的 issues 摘要> + "\n\nPlease respond again with corrected JSON matching the schema." }`,再 `invoke(retryRequest)`。**测试要能断言第二次 `invoke` 收到的 `req.prompt` 字符串 ≠ 第一次、且包含上一次的错误信息**——这是 §8.5#3 的字面验收标准。
  - 重试仍失败 → 抛 `SchemaValidationError`(携带两次 `content` + 两次错误详情),不静默返回 `null`/`undefined`。
  - `SchemaValidator` **不知道 adapter 是谁**——它只接收一个 `invoke` 回调(通常是调用方传入 `(req) => adapter.invoke(req)`),这样测试不需要构造真实/假 adapter 对象,只需要传一个普通函数,也让 `SchemaValidator` 完全不依赖 `ProviderRouter`/`AdapterRegistry`(层内解耦,便于未来单独复用)。

### 测试(与逐文件任务一一对应)
- `src/harness/provider-router.test.ts` —— 覆盖:①正常路由(role→provider→adapter 返回正确 id);②**注册第二个 fake adapter(id 不同),改 role 绑定的 provider,断言路由到新 adapter,且断言过程中 `provider-router.ts` 源文件未被修改**(用一份"运行前后 diff = 0"或至少测试本身独立成立、不依赖修改 router 源码来证明,具体断言方式见 §9.1);③`role` 未绑定 → `RoleNotBoundError`;④`provider` id 未注册 → `AdapterNotRegisteredError`。
- `src/harness/adapter-registry.test.ts` —— 覆盖:register/get/has 基本行为 + 重复 `register` 同 id 的行为(覆盖 vs 报错,`[?]` 见 §9.4)。
- `src/harness/config.test.ts` —— 覆盖:①传入含 `litellm`(direct-api)的 `ProfileConfig` → registry 里能 `get("litellm")` 拿到 `LiteLLMAdapter` 实例;②传入真实 `profiles/helix/config.yaml` 解析出的 config(两个 provider 都是 cli-bridge)→ registry 为空,这是预期行为不是 bug(见上文 `config.ts` 任务描述)。
- `src/harness/adapters/litellm-adapter.test.ts` —— 用 `node:http.createServer` 起本地假服务器(不打真实网络,不用第三方 mock 库,和 A1 全程"真实但受控"的测试哲学一致):
  - 200 成功路径:返回合法响应体,`invoke()` 返回的 `InvokeResult` 含正确 `content`/`provider`/`model`。
  - 401 / 403 / 429 / 500(5xx 代表)四种状态码各一条测试,断言抛出的是 `AdapterInvokeError` 且带得到状态码信息(不是裸 `Error`/裸 HTTP 库异常泄漏出去)。
  - `base_url` 带尾斜线(如 `"http://127.0.0.1:PORT/"`)时,断言假服务器收到的 `req.url` 路径没有出现连续斜杠(证明归一化生效)。
  - `api_key` 缺失(`config.api_key` 为 `undefined`)时,断言请求没有发出形如 `"Bearer undefined"` 的 `Authorization` header(可以是完全不发这个 header,断言假服务器收到的 headers 里没有这个畸形值)。
  - 响应体不是合法 JSON 时,断言抛出的是 `AdapterInvokeError` 而不是裸 `SyntaxError` 冒出来。
  - `checkAvailability()` 至少一条测试证明它真的发出了 HTTP 请求(用同一个假服务器断言收到了请求),不是只读 config 字段就返回 `available: true`。
- `src/harness/schema-validator.test.ts` —— 覆盖:①第一次校验就通过(1 次 `invoke` 调用,`attempts: 1`);②第一次失败、第二次通过(2 次调用,断言第二次 `req.prompt` 含第一次的错误信息且整串不等于第一次);③两次都失败 → 抛 `SchemaValidationError`;④第一次响应体本身不是合法 JSON(不是 schema 不匹配,是纯 JSON 语法错误)也要走同一条重试路径,不是两套代码。

### 垂直切片(A2 收尾,硬性交付)
- `src/harness.e2e.test.ts`(命名 `[?]`,对齐 `src/context-prompt.e2e.test.ts` 已有的顶层 e2e 文件放置惯例)——端到端测试,复用 A1 已有的真实 Context→Prompt 链路(真实 `MemoryStore` + `ContextInjector` + `PromptComposer`,做法照抄 `context-prompt.e2e.test.ts` 的搭建方式,不重新发明),再往下接:
  1. `PromptComposer.compose("coder", injectedContext, task)` 产出真实 prompt 字符串。
  2. 手写一个 `FakeAdapter implements ModelAdapter`(本条测试里**唯一被替换成 fake 的边界**,代表"不打真实网络"这条非目标约束;`id: "fake-litellm"`,`kind: "direct-api"`,`invoke()` 返回一个 `content` 字段是合法 `CoderOutput` JSON 字符串的 `InvokeResult`),注册进真实 `AdapterRegistry`。
  3. 真实 `ProviderRouter`(`roles: { coder: { provider: "fake-litellm" } }`)路由到这个 fake adapter。
  4. 真实 `SchemaValidator.validate({ schema: CoderOutput, request: { role: "coder", prompt }, invoke: (req) => adapter.invoke(req) })`。
  5. 断言最终拿到的 `data` 是 typed、结构正确的 `CoderOutput` 对象,且 `result.provider === "fake-litellm"`。
  - 这条测试就是 DESIGN §8.5"每个里程碑收尾必须有一条薄垂直切片真正接通"在 A2 的落地证据——证明 Prompt 层输出真的能流过 Harness 全部三个新组件,不是三份孤立绿测试。

### 依赖 / 打包
- `package.json` —— **本增量不新增任何依赖**(A2 用 Node 内建全局 `fetch`/`node:http`,`@types/node@24` 已含 `fetch`/`Headers`/`Request`/`Response` 类型,`tsconfig.json` 的 `"types": ["node"]` 不需要改动;`SchemaValidator` 直接用 `schema-registry.ts` 里已有的 zod `ZodType.safeParse()`,不引入 `ajv`——这条和根 `CLAUDE.md` 技术栈表"ajv(JSON Schema 校验)"字面不完全一致,是本 PRD 明确的一处待指挥官拍板的分歧点,见 §9.2,不是疏漏)。

## 6. 批次拆解

> 单位延用 A0+A1 PRD 的自定义量级:`[S]` ≈ 2-4h、`[M]` ≈ 半天到一天、`[L]` ≈ 1-2 天。全部在同一分支 `feature/issue-6-a2-harness` 上顺序提交(理由见 §7)。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `src/harness/types.ts` + `errors.ts`(接口/类型先行,不含实现) | 无(起点) | [S] |
| **B1** | `src/harness/adapter-registry.ts` + `adapter-registry.test.ts` | B0 | [S] |
| **B2** | `src/harness/provider-router.ts` + `provider-router.test.ts`(含"加第二个 fake adapter、router 不改代码"的硬性测试) | B1 | [M] |
| **B3** | `src/harness/adapters/litellm-adapter.ts` + `litellm-adapter.test.ts`(`node:http` 假服务器,含 401/403/429/5xx/尾斜线/缺 key/非法 JSON/checkAvailability 全部路径) | B0 | [L](本批体量最大,含 spike §9.3) |
| **B4** | `src/harness/config.ts` + `config.test.ts`(含"真实 helix config → 空 registry 是预期行为"这条固定测试) | B2 + B3 | [S] |
| **B5** | `src/harness/schema-validator.ts` + `schema-validator.test.ts`(含重试喂回错误的字面断言) | B0 | [M] |
| **B6** | 垂直切片 `src/harness.e2e.test.ts` | B2 + B3(仅需 `FakeAdapter`,不强依赖 B3 内部实现细节,但需要 B3 已定的 `ModelAdapter` 接口稳定)+ B5 | [S] |
| **B7** | 文档回写(`docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/根 `CLAUDE.md` 技术栈行 + 目录结构行打钩更新)+ 知识库条目(已核实 `ai-agent/CHARTS/knowledge/` 目前只有 `README.md`/`ai-agent.md`/`whoseorder.md`,尚无 `aeloop.md`——本增量若要开始建 aeloop 的模块级知识库索引,是新建 `CHARTS/knowledge/aeloop.md` 而非补一个已有文件;是否本增量就建、还是等 A2 全部 merge 后再统一建,留给指挥官/军师定,不阻塞本 PRD 开工) | B6 | [S] |

**依赖图要点**:B3(LiteLLMAdapter)和 B5(SchemaValidator)彼此独立,理论上可并行开发(B3 不依赖 B5,B5 不依赖具体 adapter 只依赖回调签名);同一 Cypher 顺序实现故不额外拆分支,排序只是顺序选择。B6 垂直切片必须等 B2+B3+B5 全部完成才能做,不可提前用假通过糊弄。

## 7. 分支策略

单分支 `feature/issue-6-a2-harness`,批次按 §6 顺序提交,理由同 A0+A1 PRD §7:一个人顺序实现,批次间大部分是真依赖(B0→B1→B2→B4、B0→B3→B4、B0→B5,B2+B3+B5→B6 汇合),没有需要独立合并的并行协作场景。若指挥官希望 Zorro 分阶段审(而非一次性大 diff),可在同一分支内按"B0-B2(路由骨架)/ B3(LiteLLMAdapter)/ B4-B6(config+SchemaValidator+切片)"三个自然断点分别提交并请求阶段性审查。

## 8. 可测验收标准(可勾选)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess` 无报错),`pnpm lint`(`tsc --noEmit`)同样无报错。
- [ ] `pnpm test` 全绿(vitest run),新增 harness 测试文件全部计入。
- [ ] **ProviderRouter 真路由**(§8.5#1):`provider-router.test.ts` 有一条测试——注册第二个 fake adapter(与第一个 id 不同)、改变某 role 的 `provider` 绑定 → 断言路由到新 adapter——且这条测试通过全程不需要修改 `provider-router.ts` 源码(该文件在本 PRD 范围内只被 B2 写一次,B3-B6 均不再触碰它,`git log -p -- src/harness/provider-router.ts` 在验收时应只有 B2 一次提交)。
- [ ] **SchemaValidator 重试喂回错误**(§8.5#3):`schema-validator.test.ts` 有一条测试断言第二次 `invoke` 收到的 `req.prompt` ≠ 第一次、且包含第一次的校验错误信息(不是重发一模一样的请求)。
- [ ] **InvokeResult 带 provider/model**(§8.5#4):`litellm-adapter.test.ts` 的成功路径测试断言返回的 `InvokeResult.provider`/`InvokeResult.model` 均为非空字符串。
- [ ] **JSON.parse 全包 try-catch**(§8.5#5):`grep -rn "JSON.parse" src/harness` 命中的每一处都在 try-catch 内且失败路径抛类型化 `AdapterInvokeError`/`SchemaValidationError`,不裸抛 `SyntaxError`(litellm-adapter 的"响应体非法 JSON"测试 + schema-validator 的"第一次响应体非法 JSON"测试各自覆盖一处)。
- [ ] **HTTP 错误码 + 尾斜线 + 缺 key 全覆盖**(§8.5#6):`litellm-adapter.test.ts` 401/403/429/5xx 四种状态码测试 + 尾斜线归一化测试 + `api_key` 缺失不产生畸形 header 测试,六条全部存在且通过。
- [ ] **垂直切片必接通**:`harness.e2e.test.ts` 存在且通过——真实 `MemoryStore`+`ContextInjector`+`PromptComposer` 产出的真实 prompt 字符串,经真实 `ProviderRouter`+一个 fake adapter(唯一替身)+真实 `SchemaValidator`,拿到 typed `CoderOutput` 结果,`result.provider` 字段核对为 fake adapter 的 id。
- [ ] `config.ts` 有一条测试固定住"传入真实 `profiles/helix/config.yaml`(两个 cli-bridge provider)→ 返回空 `AdapterRegistry`"这个预期行为,防止未来有人误给 cli-bridge 塞占位实现。
- [ ] `docs/ROADMAP.md` A2 对应行打钩、`docs/PROGRESS.md` 清空或更新、`CHANGELOG.md` 加行、根 `CLAUDE.md` §2 技术栈表 + §3 目录结构行同步更新为"harness 已建"。

## 9. 依赖 / 风险

### 9.1 ProviderRouter / config.ts 接口设计边界(建议指挥官/军师过一眼再开工,不是必须但性价比高)

这是本增量最核心的新接口,设计取舍如下,**已经做出选择并写进 §5**,但因为是"加 provider 零改编排代码"这个硬验收项唯一的落地方式,值得指挥官确认一遍再开工,避免返工:

- **选择**:`ProviderRouter` 只做「`roles[role].provider` → `registry.get(id)`」这一次纯查找,不知道任何具体 adapter 类,不做任何实例化。真正"给一个 provider id 构造出具体 adapter 实例"的逻辑放在 `harness/config.ts` 的 `buildAdapterRegistry()`(DESIGN §6 文件结构本就把 `config.ts` 单独列在 `harness/` 下,和 `provider-router.ts` 分开)。
- **为什么这样分**:"加 provider 零改编排代码"里的"编排代码"指的是 A4 Loop 层调用 `router.route(role)` 的那部分代码——加一个新 provider 不需要动 Loop,也不需要动 `provider-router.ts` 本身。但 `harness/config.ts`(Harness 层内部的"接线"文件)本来就是"换模型只动 H 层"这句话字面指向的地方,加一个新 provider 确实要在这个文件里加一段构造分支——这是预期的、允许的改动,不违反验收标准。验收测试(§8 第 3 条)特意用"注册一个 *fake* adapter 直接进 registry,绕过 `config.ts` 的真实构造逻辑"来证明 `provider-router.ts` 本身不用改,这个测试策略本身就是设计选择的一部分,值得指挥官知道"零改动"具体指哪个文件、不指哪个文件。
- **替代方案(未采用)**:让 `ProviderRouter` 自己持有一个 `Record<providerId, () => ModelAdapter>` 工厂映射并在构造时接收。评估后放弃——这样"加 provider" 仍然不用改 `route()` 方法本身的逻辑,但调用方每次构造 `ProviderRouter` 都要传一份工厂映射,和"config.ts 统一在一个地方接线"比,分散了新增 provider 时要碰的文件数量,不如现选方案干净。

### 9.2 SchemaValidator 校验库:zod 直接校验 vs ajv 【已定案:跳过 ajv,用 zod 直校】

> **决定(2026-07-20 指挥官拍板)**:A2 **不引入 ajv**,SchemaValidator 直接对 `schema-registry.ts` 的 zod 对象 `.safeParse()`。根 `CLAUDE.md` §2 已同步改(ajv 从 A2 依赖移出,留 A4 再评估)。下方为原始论证,保留作决策依据。

根 `CLAUDE.md` §2 技术栈表把 `ajv`(`Ajv2020`,JSON Schema 校验)列为既定技术栈的一部分,且明确写"`ajv` 是 A2(Harness)/A4(Loop)才需要的依赖"——字面上暗示 ajv 该在 A2 落地。但:
- `DESIGN.md` §7(A2 的设计权威段落本身)只字未提 ajv,`schema-registry.ts` 里角色→schema 的注册表存的就是**zod** `ZodType`(不是 JSON Schema),`composer.ts` 现在用 `z.toJSONSchema(schema)` 只是为了把 schema *说明文字* 塞进 prompt 给模型看,不是校验路径。
- 本 PRD §5 的设计是 `SchemaValidator` 直接对 `schema-registry.ts` 已有的 zod 对象调 `.safeParse()`——单一校验源头(zod schema 既是 prompt 里描述给模型看的来源,又是校验模型实际输出的依据),不需要引入 ajv 就能满足 A2 的全部验收项。
- **本 PRD 的立场**:A2 不引入 `ajv`,理由是 YAGNI——目前没有任何一个验收项要求"对着 JSON Schema(而非 zod 对象)校验",引入一个新校验库只会制造"zod schema 和它转出的 JSON Schema 万一不一致该信哪个"这种双源头问题。`ajv` 是否在 A4(Loop 层,例如校验 `workflow-def.ts` 的 workflow 定义文件本身,DESIGN §10 那条 `[?]`)才真正需要,留到 A4 立项时再评估。
- **这条不是我能替指挥官定的**:根 `CLAUDE.md` 是宪法级文档,字面写了 ajv 属于 A2,本 PRD 选择偏离这个字面表述,如果指挥官不同意,请在 PRD 确认阶段直接改 §5/§9.2,我不会自己悄悄改宪法文档去迁就代码。

### 9.3 LiteLLMAdapter 的真实探活策略——需 spike(标 `[?]`)

`checkAvailability()` 打哪个端点、发什么最小请求判定"真的可用"(而不是只查配置存在)——DESIGN §9 已经把"deepseek 探活"列为 verity profile 半边的必跑 spike,但那是"某个具体模型能不能被调"的问题;A2 这里是"LiteLLMAdapter 这个 direct-api 通道本身该怎么探活"的更基础问题,同样没有已验证答案。本机没有可连的公司 LiteLLM 代理实例,B3 批次内需要一个不超过 0.5 天的小 spike(读 LiteLLM 项目公开文档,不越界读公司内网代码),定下具体端点;如果 spike 当场定不下来,**退化底线**:`checkAvailability()` 必须真的发出一次网络请求并依据响应结果判定,不能只是"读一下 config 里有没有 `base_url` 字段"这种假探活——这条底线写进 §5/§8,不因为 spike 没查清楚具体端点就放弃。

### 9.4 AdapterRegistry 重复 `register` 同 id 的行为——待定,非阻塞(标 `[?]`)

同一个 `id` 被 `register()` 两次(例如测试之间没清理、或未来 `config.ts` 逻辑有 bug 重复构造),应该覆盖后一个、报错、还是忽略?本 PRD 未定案,建议实现时选"覆盖 + 不报错"(最简单、和 JS `Map.set` 的原生语义一致),因为目前没有场景需要区分"故意覆盖"和"意外重复",若未来出现真实需求(比如需要防止测试之间串扰导致的静默覆盖掩盖 bug)再收紧。这条不阻塞开工,实现时按建议做即可,不必等指挥官确认。

## 10. 项目约束检查

- **模型无关?** 是——`ProviderRouter`/`AdapterRegistry`/`SchemaValidator`/`ModelAdapter` 接口本身不出现任何具体 provider/model 名字;唯一具体的 provider 实现是 `LiteLLMAdapter`,它是"其中一个可插拔实现"而不是被硬编码进路由逻辑。
- **ProviderRouter 加 provider 零改编排代码?** 是——见 §9.1 设计说明 + §8 第 3 条验收测试(注册 fake adapter 不改 `provider-router.ts`)。
- **无跨层反向依赖?** 是——`src/harness/` 只 import `src/prompt/`(`schema-registry.ts` 的 `SchemaRegistry` 类型 / 具体 schema)、`src/profile/`(`ProfileConfig`/`ProviderConfig`/`RoleBinding` 类型)、`src/shared/`(`Role`/`ISODateString`)的**类型**,不 import `src/context/` 的任何东西(Harness 不需要知道记忆怎么来的,只消费 `PromptComposer` 已经拼好的字符串);`src/loop/`(A4)本增量不存在,自然无引用。
- **`profiles/verity/` 不入仓?** 是——本增量不创建 `profiles/verity/` 任何文件,测试全部用内存态 fixture `ProfileConfig` 对象或已有的 `profiles/helix/`,不新建任何 profile 目录。
- **角色不硬编码?** 是——`ProviderRouter`/`SchemaValidator` 都以 `Role`(开放字符串)为参数,不写 `if role === "coder"` 之类分支;`harness/config.ts` 按 `provider.kind`(`"direct-api"` | `"cli-bridge"`)分派,不按角色名分派。
- **引擎代码不含 Helix 人格?** 是——`src/harness/` 下所有代码零 Helix/companion/私人记忆内容。
