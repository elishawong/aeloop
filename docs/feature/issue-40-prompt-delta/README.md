# Issue #40 — PromptSnapshot Delta Delivery:设计契约

状态:**仅设计**——没有运行时代码。这份文档是未来某次实现的验收契约;它本身不改变任何行为。

## 1. 问题

对支持基于会话(session-based)或基于缓存(cache-based)上下文的 provider 来说,每次
checkpoint/resume 都重发完整 prompt 是种浪费。本文档规定 `PromptSnapshot` 如何拆分成
**稳定(stable)** 部分和**动态(dynamic)** 部分、各自如何算哈希、默认落盘什么(仅元数据,
不含原始 prompt 内容)、provider 如何协商 delta 支持、以及哈希对不上时 retry/resume 失败
如何处理。

## 2. PromptSnapshot:stable 与 dynamic 的边界

一个 `PromptSnapshot` 代表某一轮发给 provider 的完整 prompt 上下文。它被划分成两个不相交
的区域:

- **Stable 区域**——同一 session 内跨轮次不变的内容:
  - system prompt / 指令
  - tool/function 定义(schema)
  - session 开始时绑定装载的 skill/agent 定义
  - 任何只注入一次的长生命周期上下文(比如项目 CLAUDE.md、CORE 文件),不按轮次重新派生
- **Dynamic 区域**——每轮都变或频繁变化的内容:
  - 对话历史的增量(自上一轮以来新增的 user/assistant/tool 消息)
  - 按轮次注入的上下文(文件读取、tool 结果、system-reminder)
  - 任何从实时状态计算出的内容(时间戳、工作目录、session env)

**边界规则:** 区域归属由**内容块类型**决定,在 session 开始时固定——上面列出的四类块
(system prompt、tool/function 定义、已装载的 skill/agent 定义、只注入一次的长生命周期
上下文)**始终**属于 stable 区域;对话增量、按轮次注入的上下文、以及从实时状态派生的内容
**始终**属于 dynamic 区域。归属**不**取决于某个块的字节自上一轮以来是否变化过——一个在
session 中途被热重载的 system prompt 仍然是 stable 区域的块;它不会被挪到 dynamic 区域。

`stableHash` 是对当前这一轮 stable 区域内容(**当下它实际是什么就是什么**,见 §3)算出的。
因此,如果 stable 区域的某个块发生漂移(比如 session 中途 system prompt 被编辑),
`stableHash` 必然会变,因为它哈希的是这一轮该块的真实字节——它不会排除掉变化的那个块。
这个哈希变化正是 §6/§7 检测并当作"stable drift(稳定漂移)"处理的信号:该轮的 delta
delivery 会被阻断,harness 回退到发送完整 prompt。完整的不匹配处理规则、以及为什么这里是
stable drift 唯一的事实来源,见 §7。

Stable/dynamic 的归属是一次**按 session、按块类型**做的分类,在 session 开始时固定;它不是
逐轮针对上一份 snapshot 做 diff 重新推导出来的。每轮真正会被**重新校验**的是 `stableHash`
本身(§3),这正是用来检测(固定的)stable 区域内部漂移的手段。

## 3. 哈希规范化

每份 snapshot 计算两个哈希:

- `stableHash` —— 仅对 stable 区域算的哈希
- `turnHash`(被某个 delta 引用时也叫 `baseHash`)—— 对该轮实际发送的完整 snapshot
  (stable + dynamic)算的哈希

### 规范化规则(哈希前必须按顺序应用)

1. **确定性序列化**:内容块被序列化成一个有序的 `{role, type, content}` 对象数组——
   任何具有不确定迭代顺序的 map/object key 都不会被直接拿去哈希。
2. **仅在非代码文本块内部规范化空白**:哈希前,行尾空白和换行风格(`\r\n` → `\n`)会被
   规范化。代码块、tool payload、文件内容按字节精确哈希(不做空白规范化)。
3. **剥离易变字段**:请求 ID、时间戳、以及任何按次调用的 nonce,即使出现在实际传输的
   payload 里,也会被排除在哈希输入之外。
4. **编码为 UTF-8**,用 **SHA-256** 哈希,输出为小写十六进制。
5. **stableHash 的拼接顺序**:stable 区域的各个块按它们在规范化 snapshot 中出现的顺序
   哈希(system → tools → 静态上下文),不是调用方传入时的插入顺序。

`stableHash` 和 `turnHash` 是独立计算的;`turnHash` **不是**简单的
`hash(stableHash + dynamicContent)`——它是对完整规范化序列化结果的哈希,所以如果规范化
规则本身变了它也会跟着变(见 §9,版本化)。

## 4. Checkpoint:默认仅存元数据

默认情况下,checkpoint 持久化只存**元数据**:

```
{
  sessionId,
  turnIndex,
  stableHash,
  turnHash,
  providerId,
  providerSessionRef,   // opaque provider-side session/cache handle, if any
  deltaCapable: boolean,
  tokenAccounting: { stableTokens, dynamicTokens, cachedTokens? },
  createdAt
}
```

**默认情况下,不会有任何原始 prompt 内容——无论是私人的还是公司的——写入 checkpoint
存储。** 这包括 system prompt、user 消息、tool 输出、以及文件内容。只有哈希、计数、
provider 引用会被持久化。

原始内容捕获仅是可选开启(opt-in),需要一个明确的 flag(比如 `--debug-persist-raw`),
限定在本地/临时的调试存储里,且绝不能是任何 checkpoint 路径(包括崩溃/错误 checkpoint)
的默认行为。

## 5. Provider 能力协商

在尝试 delta delivery 之前,harness 必须先确认目标 provider 对当前活跃 session 是否支持:

1. 通过 provider adapter 的能力描述符查询/声明能力(静态的,在 adapter 注册时就已知——
   不是针对存活 API 的运行时探测,因为并非所有 provider 都暴露这种探测手段)。
2. 一个 provider 只有同时满足以下两点才算**支持 delta(delta-capable)**:
   - 有一个能在服务端或缓存端跨调用持久化 stable 内容的 session/context handle,**并且**
   - harness 有办法在后续调用里引用这个 handle(session ID、cache ID、或等价物)。
3. 只要缺其中任何一项,该 provider 就被当作**只支持完整 prompt**,永远不会对它尝试
   delta delivery。

### 回退

如果能力协商失败、结果不明确、或者 provider 在调用时返回一个能力不匹配的错误,harness
会为该轮回退发送**完整 prompt**,并清掉该 session 的任何 `providerSessionRef`,强制在
下一轮重新协商能力。

### 当前 provider 状态(截至本文档)

**Claude CLI、Codex CLI、以及 LiteLLM 在各自明确实现并验证 delta/能力支持之前,所有流量
都保持全量 prompt。** 在那项工作落地之前,这三者中任何一个的能力描述符都不应报告
`deltaCapable: true`;本文档不改变这一点。

## 6. Delta delivery 的前置条件

只有**全部**以下条件都成立,才会尝试 delta delivery(只发送 dynamic 区域):

1. 本 session 的 provider 能力协商(§5)已成功。
2. harness 持有一个 provider 已**确认**(即在之前的响应里返回/确认过)对本 session 有效
   的 `providerSessionRef`——本地生成或假定的引用永远不够。
3. harness 为这一轮本地算出的 `stableHash`,与该 `providerSessionRef` 被确认时记录的
   `stableHash` 一致。
4. harness 打算拿来做 delta 基准的 `baseHash`(turnHash),与 provider 为该 session
   确认过的最后一个 turnHash 一致。

只要有任何一个前置条件不满足,harness 就必须为该轮发送完整 prompt(绝不发送
部分/尽力而为的 delta)。

## 7. Retry / resume 不匹配处理

在 retry 或 resume 时(进程重启、重连、checkpoint 重放):

1. 加载该 session 最后一次的 checkpoint 元数据(§4)。
2. 从当前的实时 snapshot 重新计算 `stableHash`/`turnHash`。
3. 与 checkpoint 记录的哈希做比较:
   - **匹配**:可以安全地用 checkpoint 里的 `providerSessionRef` 尝试 delta delivery,
     前提是 §6 的前置条件仍然成立(provider 可能已经在服务端让该 session 过期——把
     provider 明确拒绝该 session ref 当作能力丧失处理,而不是致命错误)。
   - **stableHash 不匹配**:stable 内容自 checkpoint 以来已经漂移(比如 system prompt
     变了)。把 provider session 当作无效,丢弃 `providerSessionRef`,强制发送完整
     prompt,重新协商能力。
   - **仅 turnHash 不匹配(stableHash 匹配)**:dynamic 内容发生了偏离(比如在部分历史
     被重放后从轮次中途 resume)。不要拿这个过期的 base 尝试 delta;为该轮发送完整
     prompt 以重新建立一个已知良好的基准,然后从下一轮起恢复 delta delivery。
4. 调用时 provider 侧返回的"未知 session/cache 引用"错误,无论本地哈希状态如何,一律按
   情况(b)处理——provider 对其 session 是否存活拥有权威判断权。
5. 所有不匹配/回退事件都会被记录(仅元数据,不含原始内容)以支持可观测性——provider
   ID、session ID、不匹配类型、轮次索引。

## 8. Token 计数

Checkpoint 元数据(§4)按轮次记录:

- `stableTokens` —— 本地计数/估算的 stable 区域 token 数
- `dynamicTokens` —— 实际传输的 dynamic 区域 token 数
- `cachedTokens`(可选,由 provider 上报)—— 当 provider 的 API 暴露这个数字时,
  provider 上报的、来自缓存/session 而非重新处理的 token 数

delta delivery 生效时,成本/用量报告必须区分"这次调用实际发送的 token"(仅 dynamic)
和"如果发完整 prompt 会是多少 token"(stable + dynamic),这样节省的部分才能按轮次审计,
而不只是汇总数字。

回退到完整 prompt 时(§5、§7),计数反映的是完整发送量——发生回退的那一轮不会声称有
任何 delta 节省。

## 9. 版本化

规范化规则集(§3)有一个 `promptDeltaVersion`,和 `stableHash`/`turnHash` 一起记在
checkpoint 元数据里。在某个版本下算出的哈希永远不会拿去和另一个版本下算出的哈希比较——
版本不匹配和 stableHash 不匹配(§7b)按同样方式处理:丢弃 session ref、回退到完整
prompt、重新协商。

## 10. 安全 / 隐私

- Checkpoint 存储默认不含任何原始 prompt 内容(§4)——这既不含任何私人用户内容,也不含
  任何公司内部的 prompt/system-instruction 内容。
- 哈希是单向的;它们不可逆,无法用来还原 prompt 内容,但跨 session/checkpoint 的哈希
  **相等**可能泄露出两轮曾共享相同的 stable 内容。在这是个问题的场景下(比如跨租户
  checkpoint 存储),哈希必须按 session 或按租户做作用域/命名空间隔离,让没有该作用域
  访问权限的任何人都无法跨边界比较相等性。
- `providerSessionRef` 的值被当作敏感信息处理(它们本质上是用于复用上下文的 provider
  侧凭证/句柄),必须和 API key 一样受同等访问控制——不得在元数据存储之外以明文记日志,
  不得出现在任何面向用户的错误信息里。
- 调试用的原始内容捕获(§4)必须明确 opt-in,和默认的元数据 checkpoint 路径分开存储,
  且排除在 checkpoint 状态的任何默认备份/同步之外。
- Token 计数(§8)和不匹配日志(§7.5)仅含元数据,可以安全地导出用于可观测性,
  不需要额外审查。

## 11. 未来的验收测试

以下是未来实现这份设计时必须通过的验收测试。目前一个都不存在;这是它们将来会被写来
对照的契约。

1. **Stable/dynamic 划分正确性**
   - 给定连续两轮,system prompt/tools 相同,只新追加了一条 user 消息,stable 区域边界
     应恰好包含未变化的前缀,dynamic 区域应恰好包含新消息。
   - 给定 session 中途对 system prompt 的一次编辑,下一轮的划分仍然把 system prompt
     归类为 stable 区域(块类型归属是固定的,§2),但 `stableHash` 会变,因为它哈希的
     是被编辑过的字节——这是 §6/§7 消费的 stable-drift 信号,而不是区域重新分配。

2. **哈希规范化的确定性**
   - 对同一个逻辑上的 snapshot 哈希两次(内容相同,内存表示里 object key 的插入顺序
     不同),得到相同的 `stableHash` 和 `turnHash`。
   - 只在一个被剥离的易变字段(时间戳、请求 ID)上不同的两份 snapshot,得到相同的哈希。
   - 只在非代码文本块的行尾空白上不同的两份 snapshot,得到相同的哈希;同样的差异出现在
     代码块内部则得到不同的哈希。

3. **默认仅元数据的 checkpoint**
   - 在默认设置下写入一次 checkpoint 后,checkpoint 存储不应含有任何值为原始
     prompt/user/tool 内容的字段——通过断言 checkpoint payload 的 key 集合是 §4 schema
     的子集来验证。
   - 在未设置 `--debug-persist-raw` 的情况下,在后续 session 里启用它不会回溯性地为
     之前的 checkpoint 填充原始内容。

4. **能力协商与回退**
   - 对 Claude CLI、Codex CLI、以及 LiteLLM adapter,能力描述符报告
     `deltaCapable: false`,且无论 session 状态如何,永远不会尝试 delta。
   - 对一个 mock 的支持 delta 的 provider,任何 delta 尝试之前都必须先协商能力成功;
     关掉该 mock 的能力响应会强制下一轮发送完整 prompt。

5. **Delta delivery 的前置条件**
   - 只有当 `providerSessionRef` 被 provider 确认过时才会尝试 delta;一个本地捏造的
     session ref 永远不会触发 delta 发送(而是改发完整 prompt)。
   - 本地 `stableHash` 与最后一次确认的值不匹配,会阻断该轮的 delta delivery。

6. **Retry/resume 不匹配处理**
   - stableHash 和 turnHash 都匹配的 resume 会尝试 delta delivery。
   - stableHash 不匹配的 resume 会丢弃 session ref 并发送完整 prompt。
   - stableHash 匹配但 turnHash 不匹配的 resume,仅为该次 resume 的那一轮发送完整
     prompt,然后在下一轮恢复 delta。
   - 调用时模拟的 provider "未知 session" 错误,即使本地哈希匹配,也会强制回退到完整
     prompt 并使 session-ref 失效。

7. **Token 计数**
   - 使用 delta delivery 的一轮,记录的 `dynamicTokens` 应少于完整 prompt 等价值
     `stableTokens + dynamicTokens`,且任何 provider 上报的 `cachedTokens` 会被原样
     记录。
   - 回退的一轮记录的是完整 prompt 的 token 数,且不计入 delta 节省总量。

8. **版本化**
   - 在 `promptDeltaVersion` 为 N 时写入的 checkpoint,当运行中的 harness 处于规范化
     版本 N+1 时不会被用于 delta delivery;会发送完整 prompt,并写入一份新的
     版本 N+1 checkpoint。

9. **安全/隐私**
   - checkpoint 存储的任何测试 fixture 或 snapshot 往返后都不应含有匹配测试所用已知
     私人/公司 prompt fixture 的明文内容。
   - `providerSessionRef` 的值不应出现在默认日志级别下发出的任何日志行里。
</content>
