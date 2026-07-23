# Issue #48 — 在 LiteLLM adapter 里保留 provider token 用量和延迟

这一块的方向和验收标准已经批过了(按这块任务是在其之下实现的那份任务指令,没有为它
单独写 PRD)。本文档记录实际构建了什么、以及过程中做的契约决定,供未来读
`types.ts`/`litellm-adapter.ts` 的人参考。

## 范围

- `InvokeResult`(`src/harness/types.ts`)新增两个**可选**字段:`usage?: ProviderUsage`
  和 `latencyMs?: number`。两者都是纯增量——每个既有 adapter(`ClaudeCliAdapter`、
  `CodexCliAdapter`)以及每个既有的 `InvokeResult` 消费者都照常编译、行为不变,因为没有
  任何字段被改成必填,也没有任何既有东西被改名/删除。
- `LiteLLMAdapter.invoke()`(`src/harness/adapters/litellm-adapter.ts`)是这块任务里
  唯一填充这两个字段的 adapter——它从自己已经支持的两种响应形状(Anthropic
  `/v1/messages` 和 OpenAI 兼容的 `/chat/completions`,按 `LiteLLMAdapterConfig.api_style`
  区分)里解析出 `usage` 块,并测量网络往返耗时。

**明确排除在这块任务范围之外的**(按 issue 正文和任务指令本身):

- `ClaudeCliAdapter`/`CodexCliAdapter`——它们的 `stream-json`/`--json` 事件流确实带有
  自己的 provider-usage 字段(比如 Claude Code 的 `result` 事件、Codex 按轮次的 `usage`
  事件——见 `__tests__/fixtures/fake-codex.fixture.mjs`),但把它们接进
  `usage`/`latencyMs` 是单独的后续工作,不在这个 issue 声明的边界内("...in LiteLLM
  adapters")。
- 本地 token 估算。`ProviderUsage.source` 的类型里保留了一个 `"estimate"` 变体给未来某块
  任务用;这块任务从不产出这个值——这块任务返回的每个 `ProviderUsage` 都是
  `source: "provider"`。
- `src/loop/*`、`src/cli/*`、`src/loop/events.ts`、A5 的 gate-view 清单——这些一个都没动。
  目前没有任何地方读取 `InvokeResult.usage`/`.latencyMs`;这块任务只是让 harness 层有能力
  报告它。

## `ProviderUsage` 形状

```ts
export type UsageSource = "provider" | "estimate";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  source: UsageSource;
}
```

每个计数字段都是独立可选的。一个只上报部分字段、省略其余字段的 provider,得到的就是
恰好那些字段被填充——其余字段绝不会被填零或猜测。

## 契约决定

1. **`totalTokens` 绝不是所有计数字段的盲目求和。** 这块任务解析的两种响应形状,缓存
   token 的计数方式并不一致:
   - Anthropic:`cache_creation_input_tokens`/`cache_read_input_tokens` 是**叠加**在
     `input_tokens` 之上的(缓存读/写从不会已经被计入 `input_tokens`)。
   - OpenAI:`prompt_tokens_details.cached_tokens` 是 `prompt_tokens` 的一个**子集**
     (已经包含在内,不是额外的)。

   如果用一条统一规则把缓存计数折进 `totalTokens`,会对其中一种形状悄悄重复计数、对
   另一种形状漏计。所以 `totalTokens` 只从 `inputTokens + outputTokens`(两者都存在时)
   算出——或者对 OpenAI 形状,当 provider 自己的 `total_tokens` 字段是个合法数字时优先用
   它(比这个 adapter 自己算出的和更站得住脚,因为它是 provider 自己声明的总数)。
   缓存计数始终可以通过 `cacheReadTokens`/`cacheWriteTokens` 单独拿到,供想显式对它们
   做推理的调用方使用。

2. **LiteLLM 的 Anthropic 透传(passthrough)变体。** 当 LiteLLM 通过它的 OpenAI 兼容
   `/chat/completions` 端点代理一个 Anthropic 模型时,观察到它会把 Anthropic 原生的
   `cache_creation_input_tokens`/`cache_read_input_tokens` 字段名原样透传进那个原本是
   OpenAI 形状的 `usage` 对象里(LiteLLM 自己的成本追踪需要这个 Anthropic 专属的拆分)。
   这个 adapter 会把这个变体读进同样的 `cacheWriteTokens`/`cacheReadTokens` 字段,
   仅在 OpenAI 原生的 `prompt_tokens_details.cached_tokens` 不存在时才回退用它——两者不
   保证含义相同(prompt 的子集 vs. 叠加在 prompt 之上),而且一个响应现实中不应该同时
   为同一个底层计数携带这两种字段。

3. **永远是 fail-safe 的解析。** `extractAnthropicUsage()`/`extractOpenAIUsage()` 从不
   抛错。缺失的 `usage` 块、不是对象的 `usage`、或者类型错误/负数/非有限数的个别字段,
   都被当作"provider 没告诉我们这个"处理,映射成 `undefined`——绝不强转,绝不猜测,
   绝不因此让一次原本成功的 `invoke()` 失败。当**完全**读不到任何计数字段时,
   `InvokeResult.usage` 会被整个省略(不是一个每个字段都是 `undefined` 的退化
   `{ source: "provider" }` 空壳)。

4. **`latencyMs` 的测量方式。** 用 `performance.now()`(单调时钟——不受挂钟/NTP 调整
   影响,不像 `Date.now()`)精确框住网络往返:从 `fetch()` 发出前的那一刻,到完整响应体
   读取完毕(`response.text()` resolve)后的那一刻。发起请求前的请求体序列化、以及之后的
   `JSON.parse`/内容形状校验,都被刻意排除在外——那些是这个进程自己的 CPU 工作,不是
   等待 provider 的时间,把它们算进去会高估这个字段本该反映的网络延迟。`latencyMs` 在
   一次成功的 `invoke()` 上始终会被填充(目前每个 adapter 每次调用恰好一次往返);这块
   任务里没有 adapter 需要省略它。

## 改了什么

- **`src/harness/types.ts`**——新增 `UsageSource`/`ProviderUsage` 类型;`InvokeResult`
  新增可选的 `usage`/`latencyMs` 字段,两者都记录为向后兼容的增量。
- **`src/harness/adapters/litellm-adapter.ts`**——`extractAnthropicUsage()`/
  `extractOpenAIUsage()`(加上共用的 `toTokenCount()`/`buildUsage()` 辅助函数)解析两种
  响应形状的 `usage` 块;`invoke()` 用 `performance.now()` 给网络往返计时,并返回这两个
  新字段。
- **`src/harness/adapters/__tests__/litellm-adapter.test.ts`**——新增一个
  `describe("usage/latency normalization (issue #48)")` 代码块:严格的 OpenAI 用量、
  计算得出的 `totalTokens` 回退、OpenAI 原生缓存读取、LiteLLM 的 Anthropic 透传缓存变体、
  Anthropic 原生用量(含它"`totalTokens` = 仅 input+output"的规则)、缺失用量、格式错误/
  类型错误的用量字段、非对象的 `usage`、部分用量(不猜测 `totalTokens`)、以及一个
  `latencyMs` 的合理性检查。

## 验证记录

在这个 worktree 里完成了验证:`pnpm run lint`、`pnpm run build`、以及
`pnpm test -- --run` 全部通过(57 个测试文件,584 个测试)。本机使用的是 Node
23.10.0,而 package 声明要求 Node >=24,所以 pnpm 打印了既有的引擎警告;原生
`better-sqlite3` 绑定在跑测试前已针对当前运行时重新构建过。没有用到任何 provider
凭证:adapter 测试跑的是一个本地假 HTTP server。
</content>
