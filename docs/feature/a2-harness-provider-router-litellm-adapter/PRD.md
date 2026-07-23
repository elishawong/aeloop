# PRD — aeloop A2:Harness 层(ProviderRouter + ModelAdapter 接口 + LiteLLMAdapter + SchemaValidator)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a0-a1-engine-scaffold-context-prompt/PRD.md`(同仓库内一份已有 PRD 的写作惯例——复用了它的分层/分批次/验收标准措辞风格)。
> 防幻觉:`[?]` = 我未验证 / 需要 spike 或指挥官确认;不编造接口/版本/参数。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-6-a2-harness`(单分支,批次内顺序提交——理由见 §7)
- **优先级**:P1
- **状态**:已批准(Elisha 于 2026-07-20 批准。§9.2 ajv 决策 = **跳过**,直接用 zod 校验;§9.1 ProviderRouter/config.ts 拆分军师已确认)
- **最后更新**:2026-07-20
- **相关 issue**:[elishawong/aeloop#6](https://github.com/elishawong/aeloop/issues/6)(本增量)——上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构的总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§7 adapter 层设计 / §8 里程碑 A2 / §8.5 Verity M2/M3 必查清单 / §1.6 层→代码映射 / §1.7 禁止跨层反向依赖)

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A0+A1(profile loader / Context 的三张表 + FTS5 + 事务 / injector / Prompt 的动态 schema-registry/composer)已经合并,但 aeloop 依然没有真正「调用一个模型」的能力。这正是 Verity 最大的缺口:`ProviderRouter` 根本没造出来,`LiteLLMAdapter` 把 provider 写死,导致「配置号称模型无关,实际上只有一条路径(LiteLLM)真正能跑通」。A2 把 Harness 层搭出来,把「选模型 + 调模型 + 校验模型输出」变成一个可插拔、可测试、模型无关的层。
- **服务对象**:A2 自己就是直接下游消费者——A3(ClaudeCliAdapter/CodexCliAdapter/ToolExecVerifier)会复用同一套 `ModelAdapter` 接口和 `AdapterRegistry`;A4(Loop 层由 LangGraph 编排的 Coder/Tester 节点)会直接调用 `ProviderRouter.route(role)` 拿到 adapter,再用 `SchemaValidator.validate(...)` 拿到经过校验的结构化结果。短期内直接用户是本增量及后续增量里跑测试的 Cypher/Zorro。
- **一句话方案**:按 DESIGN §7,搭建一个 `ModelAdapter` 接口 + `ProviderRouter`(role → provider id → adapter,纯查找,零 I/O)+ `AdapterRegistry`(id → adapter 实例的登记表)+ `harness/config.ts`(从 `ProfileConfig` 构造出真实 adapter 并注册进登记表——这是「新增 provider 时要动的地方」,不是 router)+ `LiteLLMAdapter`(第一个真实的 direct-api 实现)+ `SchemaValidator`(校验 + 失败重试一次,把上一次的错误喂回给模型),外加一个硬核纵切测试,证明 `PromptComposer` 的输出真的能走通 `ProviderRouter → adapter.invoke → SchemaValidator` 拿到一个带类型的结果。

## 2. 目标 / 非目标

**目标**:
- `src/harness/types.ts`:`ModelAdapter` 接口(`id`/`kind`/`checkAvailability()`/`invoke()`/可选的 `toolTrace()`)+ `InvokeRequest`/`InvokeResult`/`AvailabilityResult` 类型(DESIGN §7 + §8.5#4)。
- `src/harness/provider-router.ts`:`ProviderRouter`——读取 `RoleConfig.provider` → 从 `AdapterRegistry` 取出对应 adapter;**零 I/O、不引用任何具体 adapter 类**,新增 provider 不得改动这个文件一行代码(DESIGN §8.5#1)。
- `src/harness/adapter-registry.ts`:`AdapterRegistry`——按 `id` register/get `ModelAdapter` 实例(一个纯粹的 Map 包装,无业务逻辑)。
- `src/harness/config.ts`:`buildAdapterRegistry(profileConfig)`——从 `ProfileConfig.providers` 构造出真实 adapter,注册进 `AdapterRegistry`(DESIGN §6 的文件结构明确把 `config.ts` 单列在 harness 目录下;这是「新增 provider 时要动的地方」,不是 router——这条边界的讨论见 §9.1)。
- `src/harness/adapters/litellm-adapter.ts`:`LiteLLMAdapter`(`kind: "direct-api"`)——调用 LiteLLM 代理;每处 `JSON.parse` 都包在 try-catch 里 → 统一成 `AdapterInvokeError`(§8.5#5);`checkAvailability()` 做真实的网络探测,不是只看「这个 provider 有没有列在配置里」(§8.5 的 deepseek 教训:「列出来 ≠ 能调用」)。
- `src/harness/schema-validator.ts`:`SchemaValidator`——用 `schema-registry.ts` 里已有的 zod schema 校验模型输出;失败后重试一次,**把上一次的校验错误文本追加进重试请求的 prompt 里**,而不是原封不动重发同一个请求(§8.5#3)。
- `src/harness/errors.ts`:带类型的错误 `AdapterInvokeError`/`RoleNotBoundError`/`AdapterNotRegisteredError`/`SchemaValidationError` 等。
- **硬核纵切**:一个端到端测试,证明「`PromptComposer` 输出的 prompt 字符串 → `ProviderRouter` 选出正确的 adapter → `adapter.invoke`(用假 adapter,不发真实网络请求)→ `SchemaValidator` 校验成功 → 拿到带类型的 `CoderOutput`」这条链路真的接通了——不是三个各自独立跑绿的测试。

**非目标**(明确不做,推迟到后续增量):
- ❌ CLI-bridge adapter(`ClaudeCliAdapter`/`CodexCliAdapter`)+ `ToolExecVerifier`——放到 A3(含 codex exec spike)。`InvokeResult` 会给 `toolExecChecked` 字段预留位置,但本增量里没有任何 adapter 会真的去填它。
- ❌ Loop 层(LangGraph 编排 / G1-G3 gate / 阈值升级 / checkpoint)——放到 A4;`workflow_runs`/`structured_claims`/`approvals` 三张表**不在本增量的建表范围内**(A2 是无状态的调用层,不碰数据库)。
- ❌ 打真实的公司 LiteLLM 代理(本地没有这个环境)——测试用本地 `node:http` 假服务器 + 假 adapter,不发真实网络连接;`checkAvailability()` 真实的探测策略(具体打哪个 endpoint)标 `[?]`,留给实现批次里的一个小 spike(见 §9.3)。
- ❌ `SchemaValidator` 彻底校验失败之后该怎么办(标 lowConfidence / 打回 / 升级)——这是 A4 Loop 状态机的事;A2 的边界到「重试一次,仍失败 → 抛一个带类型的错误」为止。

## 3. 用户故事

- 作为 **A4 的 Loop 开发者**,我想让 `ProviderRouter.route("coder")` 直接给我一个可调用的 `ModelAdapter`,不用管背后是 LiteLLM 还是别的什么,这样 Coder/Tester 节点的代码完全不知道具体是哪个 provider。
- 作为 **A3 的 CLI-bridge 开发者**,我想让 `ModelAdapter` 接口已经稳定下来,这样我只需要写一个新的 `ClaudeCliAdapter implements ModelAdapter`,在 `harness/config.ts` 里加一个构造分支,不用动 `provider-router.ts`。
- 作为**指挥官**,我想看到一个测试证明「加一个第二 provider,能路由到它,router 代码不用改」——不是文档里的一句声称,而是一个真跑起来的测试证明它(Verity 的教训)。
- 作为 **A4 的 Loop 开发者**,我想让模型吐出格式错误的 JSON 时,`SchemaValidator` 能自动重试一次并反馈「上次哪里错了」,而不是原样再问一遍碰运气。

## 4. 数据模型

本增量**无状态、不建表**——Harness 层本身不持久化任何东西(`structured_claims`/`workflow_runs`/`approvals` 三张表是 A4 Loop 的事,DESIGN §5 已经说清楚了)。唯一的「数据形状」是 §5 里 `harness/types.ts` 列出的内存态请求/响应类型——不是数据库 schema。

## 5. 逐文件任务清单

### Harness Core
- `src/harness/types.ts` —— 核心类型:
  - `ModelAdapter` 接口(DESIGN §7 原文):
    ```typescript
    interface ModelAdapter {
      readonly id: string;                 // "litellm" | future "claude-cli" | "codex-cli"
      readonly kind: "direct-api" | "cli-bridge";
      checkAvailability(): Promise<AvailabilityResult>;
      invoke(req: InvokeRequest): Promise<InvokeResult>;
      toolTrace?(): ToolCallRecord[];       // cli-bridge-exclusive, only used by A3; A2 implements no adapter that returns it
    }
    ```
  - `InvokeRequest`:`{ role: Role; prompt: string }`(`prompt` = `PromptComposer.compose()` 的输出字符串;`Role` 复用 `../shared/types.js` 里那个开放的字符串类型,不新增 role 约束)。
  - `InvokeResult`:`{ content: string; provider: string; model: string; toolExecChecked?: "pass" | "fail" | "na" }`(§8.5#4 硬性要求 `provider`/`model` 必须永远存在;`toolExecChecked` 是 A3 的字段——A2 的 adapter 绝不能去设这个字段,而不是拿 `"na"` 当占位符去填——`undefined` 比编造一个假值更诚实)。
  - `AvailabilityResult`:`{ available: boolean; reason?: string; checkedAt: ISODateString }`。
  - `ToolCallRecord`:`[?]` 形状先留空/占位(由 A3 定义),A2 只需要接口上存在 `toolTrace?(): ToolCallRecord[]` 这个方法签名,不需要这个类型有真实内容——**建议**:本增量把 `ToolCallRecord` 定义成一个最小占位符 `interface ToolCallRecord { [key: string]: unknown }`,加注释说明「A3 会把它换成真实形状」,避免 A3 开工时还要回头改这个文件的接口签名。
- `src/harness/errors.ts`:
  - `AdapterInvokeError`(统一包装 HTTP/网络/`JSON.parse` 失败,通过 `cause` 保留原始错误,风格对齐 `context/errors.ts`/`profile/errors.ts` 里已有的 `describeCause` 惯例)。
  - `RoleNotBoundError`(`role` 在 `ProfileConfig.roles` 里没有绑定时,由 `ProviderRouter.route(role)` 抛出)。
  - `AdapterNotRegisteredError`(某个 `role` 绑定的 `provider` id 在 `AdapterRegistry` 里没有注册对应 adapter 时抛出——同时覆盖「配置里写了但没人构造出对应 adapter」和「provider id 写错了」两种情况;`ProviderRouter` 不需要区分是哪一种,反正都是「我这里没有这个 id」)。
  - `SchemaValidationError`(重试后依然校验失败,携带两次尝试的原始 `content` + zod 错误信息,供调用方/日志排查——不是静默失败)。
- `src/harness/adapter-registry.ts`:`AdapterRegistry` 类——`register(adapter: ModelAdapter): void`(按 `adapter.id` 存储)、`get(id: string): ModelAdapter | undefined`、`has(id: string): boolean`。一个纯数据结构包装,不含任何具体 provider 的知识。
- `src/harness/provider-router.ts`:`ProviderRouter` 类——构造函数接收 `roles: ProfileConfig["roles"]` + `registry: AdapterRegistry`(**不接收整个 `ProfileConfig`,只拿它需要的 `roles` 切片**,减少隐式耦合,和 A1 里 `PromptComposer`/`MemoryStore`「传显式依赖,不传整个大对象」的惯例一致)。`route(role: Role): ModelAdapter`——查 `roles[role]`;查不到 → 抛 `RoleNotBoundError`;拿到 `provider` id,查 `registry.get(id)`;查不到 → 抛 `AdapterNotRegisteredError`;否则返回这个 adapter。**未来新增 provider 时这个文件绝不应该再需要改动**——这是 §8.5#1 验收项的字面要求,也是本 PRD 里唯一一处要求「用测试证明改动量为零」的地方(测试策略见 §9.1)。
- `src/harness/config.ts`:`buildAdapterRegistry(config: ProfileConfig): AdapterRegistry`——遍历 `config.providers`,按 `kind` 分发构造:`kind === "direct-api"` → 目前只认 `LiteLLMAdapter`(`new LiteLLMAdapter(id, providerConfig)`);`kind === "cli-bridge"` → **本增量完全不构造任何东西,显式跳过**(加注释说明「A3 会在这里填入 ClaudeCliAdapter/CodexCliAdapter 的构造分支」),既不报错也不塞假 adapter——`profiles/helix/config.yaml` 目前两个 provider 都是 `cli-bridge`,所以对着这份真实配置跑 `buildAdapterRegistry` 应该返回一个空的 `AdapterRegistry`;这是预期行为,不是 bug,需要一个测试把这个预期钉死(否则以后有人可能「顺手」在 cli-bridge 分支里塞一个占位实现,悄悄违反「CLI-bridge 是 A3 的事」这条边界)。
- `src/harness/adapters/litellm-adapter.ts`:`LiteLLMAdapter implements ModelAdapter`:
  - 构造函数:`new LiteLLMAdapter(id: string, config: { base_url?: string; api_key?: string; model?: string })`(`config` 的形状来自 `ProfileConfig.providers[id]`,即 A1 的 `ProviderConfig` 类型,字段已经被 profile loader 做过 `${ENV}` 替换)。
  - `kind = "direct-api"`。
  - `invoke(req)`:向 `${base_url}/chat/completions` 发一个 `POST`(**`[?]` 这个 endpoint 路径/请求体形状还没有对着真实的 LiteLLM 代理验证过**——假设 LiteLLM 代理暴露一个兼容 OpenAI 的 `chat/completions` endpoint,这是 LiteLLM 官方宣称的公开定位,但本地没有可达的公司代理实例能真正验证,所以不能写成「已验证」;先按这个假设实现,并把这个 `[?]` 原样带进 progress.md,等真正接上公司代理后再摘掉)。请求体大致包含 `model`/`messages`(把 `req.prompt` 包成一条 `user` 消息)/可能包含 `response_format`(和结构化输出相关,`[?]` 是否需要、具体形状都未验证;MVP 阶段跳过它也没关系,靠 prompt 文本里已有的 schema 描述让模型自律,校验则由 `SchemaValidator` 兜底——即便发了 `response_format`,也不能替代 `SchemaValidator`;这道门不能因为「上游可能已经保证格式了」就跳过)。
  - 拿到 HTTP 响应之后:非 2xx → 按状态码分类,包装成 `AdapterInvokeError`(401/403/429/5xx 各自有独立测试覆盖,见 §5 的测试小节);2xx 但响应体 `JSON.parse` 失败或形状不对 → 同样包装成 `AdapterInvokeError`,绝不让裸的 `SyntaxError` 逃逸出去(§8.5#5)。
  - `base_url` 尾斜杠归一化(拼路径前先 `base_url.replace(/\/+$/, "")`),避免 `https://x.com/` + `/chat/completions` 拼出 `https://x.com//chat/completions`——这是 Verity 实际踩过的坑(§8.5#6)。
  - 当 `api_key` 缺失时,**不能裸拼字符串**(避免 `` Authorization: Bearer ${undefined} `` 这种经典 bug,把 `"undefined"` 当 token 发出去——和 Verity M3「缺失的列/值悄悄传播下去」是同一类问题);缺失时就干脆不设 `Authorization` 头,让代理自己决定要不要因为没有认证头而 401(这条路径有测试覆盖,见 §8.5#6)。
  - `checkAvailability()`:发一个真实的 HTTP 请求来判断可用性(不是只看 `base_url`/`api_key` 有没有配值就算「可用」)。**`[?]` 具体打哪个 endpoint / 发什么最小请求还没定**(留到 §9.3 讨论),但无论最终选哪个,验收底线是「这条路径必须真的发一个网络请求,并根据响应判断」——不能退化成配置存在性检查——这是对 §8.5 表里「列出来 ≠ 能调用」这条教训的直接呼应。
  - `toolTrace` 不实现(`kind: "direct-api"` 的 adapter 天然没有工具调用轨迹可审计;这个方法在接口上是可选的,所以 `LiteLLMAdapter` 干脆不定义它)。
- `src/harness/schema-validator.ts`:`SchemaValidator` 类:
  - `validate<T>(params: { schema: z.ZodType<T>; request: InvokeRequest; invoke: (req: InvokeRequest) => Promise<InvokeResult> }): Promise<{ data: T; result: InvokeResult; attempts: 1 | 2 }>`。
  - 第一次尝试:`invoke(request)` → 尝试 `JSON.parse(result.content)` → 失败,或 `schema.safeParse()` 没通过 → 进入重试分支。
  - 重试分支:构造 `retryRequest = { ...request, prompt: request.prompt + "\n\n---\n\n# Previous Attempt Failed Validation\n\n" + <失败原因,包括 JSON parse 错误或 zod issues 摘要> + "\n\nPlease respond again with corrected JSON matching the schema." }`,然后再次调用 `invoke(retryRequest)`。**测试必须能断言第二次 `invoke` 调用收到的 `req.prompt` 字符串 ≠ 第一次,且包含上一次的错误信息**——这是 §8.5#3 验收标准的字面要求。
  - 重试后依然失败 → 抛出 `SchemaValidationError`(携带两次尝试的 `content` + 两次错误的详情),而不是静默返回 `null`/`undefined`。
  - `SchemaValidator` **不知道 adapter 是谁**——它只接收一个 `invoke` 回调(调用方一般传 `(req) => adapter.invoke(req)`),所以测试不需要构造真/假 adapter 对象,传一个普通函数就够了,这也让 `SchemaValidator` 完全独立于 `ProviderRouter`/`AdapterRegistry`(层内解耦,方便未来单独复用)。

### 测试(和文件任务清单一一对应)
- `src/harness/provider-router.test.ts` —— 覆盖:① 正常路由(role→provider→adapter 返回正确的 id);② **注册第二个假 adapter(不同 id),改一个 role 的 `provider` 绑定,断言路由到了新 adapter,并断言过程中没有修改 `provider-router.ts` 源文件**(用「跑前跑后 diff = 0」的方式,或至少测试本身独立证明它不依赖修改 router 源码——具体断言方式见 §9.1);③ `role` 未绑定 → `RoleNotBoundError`;④ `provider` id 未注册 → `AdapterNotRegisteredError`。
- `src/harness/adapter-registry.test.ts` —— 覆盖:基本的 register/get/has 行为 + 同一个 id 调用两次 `register` 的行为(覆盖 vs 报错,`[?]` 见 §9.4)。
- `src/harness/config.test.ts` —— 覆盖:① 传入一个含 `litellm`(direct-api)的 `ProfileConfig` → registry 能 `get("litellm")` 取到一个 `LiteLLMAdapter` 实例;② 传入从真实 `profiles/helix/config.yaml` 解析出的配置(两个 provider 都是 cli-bridge)→ registry 为空;这是预期行为,不是 bug(见上面 `config.ts` 的任务描述)。
- `src/harness/adapters/litellm-adapter.test.ts` —— 用 `node:http.createServer` 起一个本地假服务器(不发真实网络请求,不用第三方 mock 库,和 A1 一以贯之的「真实但受控」测试理念一致):
  - 200 成功路径:返回一个合法响应体,`invoke()` 返回的 `InvokeResult` 包含正确的 `content`/`provider`/`model`。
  - 401 / 403 / 429 / 500(代表 5xx)——四个状态码各自一个测试,断言抛出的是携带状态码信息的 `AdapterInvokeError`(不是裸的 `Error`/泄漏出来的原始 HTTP 库异常)。
  - 当 `base_url` 带尾斜杠(如 `"http://127.0.0.1:PORT/"`)时,断言假服务器收到的 `req.url` 路径没有连续斜杠(证明归一化生效了)。
  - 当 `api_key` 缺失(`config.api_key` 是 `undefined`)时,断言请求没有发出像 `"Bearer undefined"` 这样格式错误的 `Authorization` 头(可以是这个头压根没发——断言假服务器收到的 headers 里不含这个畸形值)。
  - 当响应体不是合法 JSON 时,断言抛出的是 `AdapterInvokeError`,而不是裸的 `SyntaxError` 冒上来。
  - `checkAvailability()` —— 至少一个测试证明它真的发了一个 HTTP 请求(用同一个假服务器,断言请求被收到了),而不是只读一个配置字段就返回 `available: true`。
- `src/harness/schema-validator.test.ts` —— 覆盖:① 第一次就通过校验(1 次 `invoke` 调用,`attempts: 1`);② 第一次失败,第二次通过(2 次调用,断言第二次的 `req.prompt` 包含第一次错误的信息,且整个字符串 ≠ 第一次);③ 两次都失败 → 抛出 `SchemaValidationError`;④ 第一次响应体本身就不是合法 JSON(不是 schema 不匹配,是纯粹的 JSON 语法错误)——也走同一条重试路径,不是单独的代码路径。

### 纵切测试(A2 收尾,硬性交付物)
- `src/harness.e2e.test.ts`(文件名 `[?]`,对齐 `src/context-prompt.e2e.test.ts` 已有的顶层 e2e 文件放置惯例)—— 一个端到端测试,复用 A1 已有的真实 Context→Prompt 链路(真实 `MemoryStore` + `ContextInjector` + `PromptComposer`,搭法和 `context-prompt.e2e.test.ts` 一样,不重新发明),然后往下游继续接:
  1. `PromptComposer.compose("coder", injectedContext, task)` 产出一个真实的 prompt 字符串。
  2. 手写一个 `FakeAdapter implements ModelAdapter`(**这个测试里唯一被换成假的东西**,对应「不发真实网络请求」这条非目标约束;`id: "fake-litellm"`、`kind: "direct-api"`、`invoke()` 返回一个 `content` 字段是合法 `CoderOutput` JSON 字符串的 `InvokeResult`),注册进一个真实的 `AdapterRegistry`。
  3. 一个真实的 `ProviderRouter`(`roles: { coder: { provider: "fake-litellm" } }`)路由到这个假 adapter。
  4. 一个真实的 `SchemaValidator.validate({ schema: CoderOutput, request: { role: "coder", prompt }, invoke: (req) => adapter.invoke(req) })`。
  5. 断言最终拿到的 `data` 是一个带类型、结构正确的 `CoderOutput` 对象,且 `result.provider === "fake-litellm"`。
  - 这个测试是 DESIGN §8.5「每个里程碑收尾都必须有一个真正接通的薄纵切」这条要求,在 A2 这一步的具体证据——证明 Prompt 层的真实输出真的能流过全部三个新的 Harness 组件,不是三个各自独立跑绿的测试。

### 依赖 / 打包
- `package.json` —— **本增量不新增任何依赖**(A2 用 Node 内建的全局 `fetch`/`node:http`;`@types/node@24` 已经包含 `fetch`/`Headers`/`Request`/`Response` 类型,`tsconfig.json` 的 `"types": ["node"]` 不需要改;`SchemaValidator` 直接用 `schema-registry.ts` 里已有的 zod `ZodType.safeParse()`,不引入 `ajv`——这和根 `CLAUDE.md` 技术栈表里列出的「ajv(JSON Schema 校验)」字面上不完全一致,是本 PRD 里一处明确留待指挥官签字的分歧点,见 §9.2——不是漏做)。

## 6. 批次拆分

> 尺寸单位沿用 A0+A1 PRD 的自定义刻度:`[S]` ≈ 2-4 小时,`[M]` ≈ 半天到一天,`[L]` ≈ 1-2 天。全部在同一个分支 `feature/issue-6-a2-harness` 上顺序提交(理由见 §7)。

| 批次 | 内容 | 依赖 | 尺寸 |
|---|---|---|---|
| **B0** | `src/harness/types.ts` + `errors.ts`(先接口/类型,不含实现) | 无(起点) | [S] |
| **B1** | `src/harness/adapter-registry.ts` + `adapter-registry.test.ts` | B0 | [S] |
| **B2** | `src/harness/provider-router.ts` + `provider-router.test.ts`(含「加第二个假 adapter,router 代码不变」的硬测试) | B1 | [M] |
| **B3** | `src/harness/adapters/litellm-adapter.ts` + `litellm-adapter.test.ts`(`node:http` 假服务器,覆盖 401/403/429/5xx/尾斜杠/缺 key/非法 JSON/checkAvailability,每条路径都覆盖) | B0 | [L](最大的批次,含 §9.3 的 spike) |
| **B4** | `src/harness/config.ts` + `config.test.ts`(含「真实 helix 配置 → 空 registry 是预期行为」的固定测试) | B2 + B3 | [S] |
| **B5** | `src/harness/schema-validator.ts` + `schema-validator.test.ts`(含重试把错误喂回去这一字面断言) | B0 | [M] |
| **B6** | 纵切测试 `src/harness.e2e.test.ts` | B2 + B3(只需要 `FakeAdapter`,不强依赖 B3 内部实现细节,但需要 B3 的 `ModelAdapter` 接口已经稳定) + B5 | [S] |
| **B7** | 文档回写(`docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/根 `CLAUDE.md` 的技术栈行 + 目录结构行勾选/更新)+ 知识库条目(已确认 `ai-agent/CHARTS/knowledge/` 目前只有 `README.md`/`ai-agent.md`/`whoseorder.md`,还没有 `aeloop.md`——如果本增量要启动 aeloop 的模块级知识库索引,意味着要新建一个 `CHARTS/knowledge/aeloop.md`,而不是往已有文件里补;是在本增量里搭还是等整个 A2 合并后统一搭,留给指挥官/军师决定,不阻塞本 PRD 的开工) | B6 | [S] |

**依赖图说明**:B3(LiteLLMAdapter)和 B5(SchemaValidator)互相独立,理论上可并行(B3 不依赖 B5,B5 不依赖任何具体 adapter,只依赖回调签名);因为是同一个 Cypher 顺序实现,不额外拆分支——顺序只是一个排序选择。B6 的纵切测试必须等 B2+B3+B5 全部完成才能做,不能提前假装通过。

## 7. 分支策略

单分支 `feature/issue-6-a2-harness`,按 §6 顺序提交批次,理由和 A0+A1 PRD §7 一样:一个人顺序实现,批次间大多数依赖是真实的(B0→B1→B2→B4,B0→B3→B4,B0→B5,B2+B3+B5→B6 汇合),没有需要独立合并的并行协作场景。如果指挥官想让 Zorro 分阶段审(而不是一个大 diff),可以在同一个分支里按三个自然断点分批提交审查:「B0-B2(路由骨架)/ B3(LiteLLMAdapter)/ B4-B6(config+SchemaValidator+纵切)」。

## 8. 可测试验收标准(可勾选)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess`,无错误),`pnpm lint`(`tsc --noEmit`)同样无错误。
- [ ] `pnpm test` 全绿(vitest run),包含所有新增的 harness 测试文件。
- [ ] **ProviderRouter 真实路由**(§8.5#1):`provider-router.test.ts` 里有一个测试——注册第二个假 adapter(id 和第一个不同),改一个 role 的 `provider` 绑定 → 断言路由到新 adapter——全程通过,不需要修改 `provider-router.ts` 源码(在本 PRD 范围内,这个文件只被 B2 写一次;B3-B6 都不再碰它——验收时 `git log -p -- src/harness/provider-router.ts` 应该只显示 B2 那一次提交)。
- [ ] **SchemaValidator 重试并反馈错误**(§8.5#3):`schema-validator.test.ts` 里有一个测试,断言第二次 `invoke` 收到的 `req.prompt` ≠ 第一次,且包含第一次校验错误的信息(不是原封不动重发同一个请求)。
- [ ] **InvokeResult 携带 provider/model**(§8.5#4):`litellm-adapter.test.ts` 的成功路径测试断言返回的 `InvokeResult.provider`/`InvokeResult.model` 都是非空字符串。
- [ ] **`JSON.parse` 全部包在 try-catch 里**(§8.5#5):`grep -rn "JSON.parse" src/harness` 命中的每一处都在 try-catch 里,失败路径抛出带类型的 `AdapterInvokeError`/`SchemaValidationError`,绝不是裸的 `SyntaxError`(litellm-adapter 的「响应体 JSON 非法」测试 + schema-validator 的「第一次响应体 JSON 非法」测试各覆盖一处)。
- [ ] **HTTP 错误码 + 尾斜杠 + 缺 key 全部覆盖**(§8.5#6):`litellm-adapter.test.ts` 的 401/403/429/5xx 四个状态码测试 + 尾斜杠归一化测试 + 「`api_key` 缺失不产生畸形头」测试——六个全部存在且通过。
- [ ] **纵切测试必须真正接通**:`harness.e2e.test.ts` 存在且通过——真实 `MemoryStore`+`ContextInjector`+`PromptComposer` 产出的真实 prompt 字符串,走过真实 `ProviderRouter`+一个假 adapter(唯一的替身)+真实 `SchemaValidator`,得到一个带类型的 `CoderOutput` 结果,`result.provider` 对着假 adapter 的 id 做了核对。
- [ ] `config.ts` 有一个测试把「传入真实的 `profiles/helix/config.yaml`(两个 cli-bridge provider)→ 返回一个空的 `AdapterRegistry`」这个预期行为钉死,防止以后有人误把占位实现塞进 cli-bridge 分支。
- [ ] `docs/ROADMAP.md` 的 A2 行已勾选,`docs/PROGRESS.md` 清空或更新,`CHANGELOG.md` 新增一行,根 `CLAUDE.md` §2 技术栈表 + §3 目录结构行同步更新,反映「harness 已搭好」。

## 9. 依赖 / 风险

### 9.1 ProviderRouter / config.ts 接口设计边界(开工前值得指挥官/军师看一眼,非强制但价值高)

这是本增量里最核心的新接口;下面这个设计取舍**已经定下并写进了 §5**,但因为它是「新增 provider 要求编排代码零改动」这条硬验收项的唯一具体实现方式,值得开工前让指挥官确认一下,避免返工:

- **选择**:`ProviderRouter` 只做一次纯查找——「`roles[role].provider` → `registry.get(id)`」——它不知道任何具体 adapter 类,也完全不做实例化。「给定一个 provider id,构造出一个具体 adapter 实例」的真正逻辑放在 `harness/config.ts` 的 `buildAdapterRegistry()` 里(DESIGN §6 的文件结构已经把 `config.ts` 单独列在 `harness/` 下,和 `provider-router.ts` 区分开)。
- **为什么这样拆**:「新增 provider 要求编排代码零改动」——这里的「编排代码」指的是 A4 Loop 层里调用 `router.route(role)` 的那部分——新增一个 provider 不需要改 Loop,也不需要改 `provider-router.ts` 本身。但 `harness/config.ts`(Harness 层内部的「接线」文件)字面上就是「换模型只动 H 层」这句话所指的地方——新增 provider 确实意味着要在这个文件里加一个构造分支,这是预期且被允许的,不违反验收标准。验收测试(§8 第 3 项)故意用「直接往 registry 里注册一个*假* adapter,绕过 `config.ts` 真实的构造逻辑」来证明 `provider-router.ts` 本身不需要改动——这个测试策略本身就是设计选择的一部分,值得让指挥官清楚知道「零改动」具体指哪个文件,不指哪个文件。
- **备选方案(未采纳)**:让 `ProviderRouter` 自己在构造时接收一个 `Record<providerId, () => ModelAdapter>` 的工厂映射。评估后否决——这样「新增 provider」时 `route()` 方法自身的逻辑确实不用改,但每个构造 `ProviderRouter` 的调用方就都得传一份工厂映射,相比「在 config.ts 里一处接好线」,这会把新增 provider 时要动的文件分散开——不如现在选的方案干净。

### 9.2 SchemaValidator 的校验库:zod 直接校验 vs. ajv 【已决策:跳过 ajv,直接用 zod 校验】

> **决策(指挥官签字,2026-07-20)**:A2 **不引入 ajv**;SchemaValidator 直接对 `schema-registry.ts` 的 zod 对象调用 `.safeParse()` 做校验。根 `CLAUDE.md` §2 已同步更新(ajv 从 A2 的依赖里移除,推迟到 A4 重新评估)。下面保留原始理由作为决策记录。

根 `CLAUDE.md` §2 的技术栈表把 `ajv`(`Ajv2020`,JSON Schema 校验)列为既定技术栈的一部分,并明确写着「`ajv` 只有 A2(Harness)/A4(Loop)需要」——字面上暗示 ajv 应该落在 A2。但是:
- `DESIGN.md` §7(A2 自己的设计权威章节)完全没提到 ajv;`schema-registry.ts` 的 role→schema 登记表存的是 **zod** 的 `ZodType` 对象(不是 JSON Schema);`composer.ts` 目前用 `z.toJSONSchema(schema)` 只是把 schema 的*描述文本*塞进 prompt 给模型看,不属于校验路径的一部分。
- 本 PRD §5 的设计让 `SchemaValidator` 直接对 `schema-registry.ts` 里已有的 zod 对象调用 `.safeParse()`——单一校验源(zod schema 既是 prompt 里给模型看的描述文本的来源,也是校验模型实际输出的依据),不需要引入 ajv 就能满足 A2 的每一项验收标准。
- **本 PRD 的立场**:A2 不引入 `ajv`,理由是 YAGNI——目前没有任何验收项要求「对着 JSON Schema(而不是 zod 对象)做校验」,引入一个新校验库只会制造出「zod schema 和它转换出来的 JSON Schema 可能不一致——该信哪个」这种双源问题。`ajv` 在 A4(Loop 层,例如校验 `workflow-def.ts` 里的工作流定义文件本身,DESIGN §10 里的 `[?]`)是否真的需要,留到 A4 定范围时再评估。
- **这不是我能替指挥官决定的事**:根 `CLAUDE.md` 是宪法级文档,字面上写着 ajv 属于 A2;本 PRD 选择偏离这句字面表述——如果指挥官不同意,请在确认 PRD 时直接改 §5/§9.2;我不会为了迁就代码就悄悄自己去改宪法级文档。

### 9.3 LiteLLMAdapter 真实的探测策略——需要一个 spike(标 `[?]`)

`checkAvailability()` 具体打哪个 endpoint、发什么最小请求来判断「真的可用」(而不是只看配置存在性)——DESIGN §9 已经把「deepseek 探测」列为 verity-profile 那一半的必做 spike,但那是「这个具体模型能不能调用」的问题;这里 A2 的问题更基础,是「LiteLLMAdapter 这个 direct-api 通道本身应该怎么探测」——同样还没有经过验证的答案。本地没有可达的公司 LiteLLM 代理实例;需要在 B3 批次里做一个不超过 0.5 天的小 spike(读 LiteLLM 的公开项目文档,不跨进公司内网代码)来定下具体 endpoint;如果 spike 当场定不下来,**兜底下限**:`checkAvailability()` 必须真的发一个网络请求,并根据响应判断——不能只是「读配置里有没有 `base_url` 字段」这种假探测——这条下限已经写进 §5/§8,不会因为 spike 定不下具体 endpoint 就被放弃。

### 9.4 AdapterRegistry 对同一 id 重复 `register` 的行为——待定,不阻塞(标 `[?]`)

如果同一个 `id` 被 `register()` 两次(例如测试之间没清理干净,或未来 `config.ts` 逻辑有 bug 重复构造),应该覆盖前一个、报错,还是忽略?本 PRD 不对此做决定;实现建议是「覆盖 + 不报错」(最简单,且和 JS `Map.set` 的原生语义一致),因为目前没有场景需要区分「故意覆盖」和「意外重复」——如果未来出现真实需求(例如需要防止测试间交叉污染通过静默覆盖悄悄掩盖一个 bug),到时候再收紧。这不阻塞开工——按建议实现即可,不需要等指挥官确认。

## 10. 项目约束检查

- **模型无关?** 是——`ProviderRouter`/`AdapterRegistry`/`SchemaValidator`/`ModelAdapter` 接口本身不含任何具体 provider/model 名字;唯一的具体 provider 实现是 `LiteLLMAdapter`,它是「可插拔实现之一」,不是被硬编码进路由逻辑里的东西。
- **ProviderRouter 新增 provider 时编排代码零改动?** 是——见 §9.1 的设计说明 + §8 第 3 项的验收测试(注册一个假 adapter,不改 `provider-router.ts`)。
- **没有跨层反向依赖?** 是——`src/harness/` 只从 `src/prompt/`(`schema-registry.ts` 的 `SchemaRegistry` 类型 / 具体 schema)、`src/profile/`(`ProfileConfig`/`ProviderConfig`/`RoleBinding` 类型)、`src/shared/`(`Role`/`ISODateString`)导入**类型**,不从 `src/context/` 导入任何东西(Harness 不需要知道记忆是怎么取的,它只消费 `PromptComposer` 已经拼好的字符串);`src/loop/`(A4)在本增量里还不存在,自然也没有引用它。
- **`profiles/verity/` 不进仓库?** 是——本增量完全不在 `profiles/verity/` 下创建任何文件;测试全部用内存态 fixture `ProfileConfig` 对象或已有的 `profiles/helix/`,不新建 profile 目录。
- **没有硬编码 role?** 是——`ProviderRouter`/`SchemaValidator` 都把 `Role`(一个开放字符串)当参数接收,没有 `if role === "coder"` 这类分支;`harness/config.ts` 按 `provider.kind`(`"direct-api"` | `"cli-bridge"`)分发,不按 role 名字分发。
- **引擎代码里没有 Helix persona 内容?** 是——`src/harness/` 下的所有东西都是零 Helix/companion/个人记忆内容。
