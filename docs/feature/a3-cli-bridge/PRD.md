# PRD — aeloop A3:CLI Bridge 层(ClaudeCliAdapter + CodexCliAdapter + ToolExecVerifier)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`(同一仓库里已有的一份 PRD——分层/分批/验收标准的措辞风格照抄自它)。
> 防幻觉:`[?]` = 我未验证 / 需指挥官确认,不编造接口/版本/参数。本 PRD 里所有关于 CLI 行为的陈述都来自 `docs/feature/a3-cli-bridge/spike-findings.md`(issue #10 的前置 spike——真实跑过的命令、真实的输出样本),不是凭回忆/猜测。

- **Project**: aeloop(`elishawong/aeloop`,私有仓库)
- **Branch**: `feature/issue-10-a3-cli-bridge`
- **Priority**: P1
- **Status**: 已批准(Elisha 2026-07-20 批准。§0 的三项决定 + §9.1/§9.2/§9.4 的开放点全部拍板,见 §0 补充)
- **Last updated**: 2026-07-20
- **Related issue**: [elishawong/aeloop#10](https://github.com/elishawong/aeloop/issues/10)(本增量);上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构主 issue)
- **Design authority**: `aeloop/docs/DESIGN.md`(§7 adapter 层设计 / §8 里程碑 A3 / §8.5#4 `InvokeResult` 字段 / §5 `structured_claims.tool_exec_checked`)+ `docs/feature/a3-cli-bridge/spike-findings.md`(这个 issue 的前置 spike,CLI 行为的唯一证据来源)

---

## 0. 已经拍板的决定(指挥官 2026-07-20 拍板,已锁定,不再讨论)

1. **v1 的 `ToolExecVerifier` = 存在性/子集匹配**——"声称执行过的工具 ⊆ trace 里真实出现的工具调用"。**参数级匹配(核对声称的具体文件路径/命令参数是否和 trace 里的真实调用逐字对得上)明确推到 v2**,不在本增量范围内(§2 不做的事)。
2. **`permission_denials` 字段标为 `[?]`**——spike 试了 2-3 次都没能复现它的触发条件(见 spike-findings.md §2.3);v1 不消费这个字段,也不保证任何 adapter 会填充/依赖它。
3. **claude 的"无工具调用"负例在 spike 里没有独立跑过**——本 PRD 的测试计划**必须包含**:用一个明显不需要工具的 prompt 测 `ClaudeCliAdapter` → 断言 trace 是空数组(和 codex 那边已经验证过的负例对称),在 build 阶段第一批加上(§5 测试小节)。

### 0.1 确认阶段补充(2026-07-20,军师复核 PRD 后由指挥官拍板)

- **§0-1 存在性检查 = 最终裁定(方案 A)**:确认 v1 的 `ToolExecVerifier` 就做 §5 描述的那个存在性检查("任何声称 tool_execution 的 claim → trace 必须非空,否则 fail"),而且 **A3 里不动 `ClaimSchema`**。§9.4 提到的"降级"是在现有 schema 下的诚实落地,和决定的原意一致——**理由**:今天 `verifiedBy` 完全没被校验过;v1 把它从"完全信任模型自报"提升到"不能空手声称已验证",本身已经是一道有意义的第一关;codex 的 trace 只提供 shell 级粒度,所以真正的逐工具匹配的价值是不对称的。真正的逐工具匹配(加 `toolsUsed`)= **v2,追踪 issue 已开:[elishawong/aeloop#11](https://github.com/elishawong/aeloop/issues/11)**。
- **§9.1 拒绝执行不可信二进制路径 = v1 跳过**(采纳 Cypher 的建议):这个威胁的前提是本地机器已经被攻破,而且 coder/tester 的输出仍然要过 A4 的 G1-G3 人工审核 gate——不像 Zorro,这不是唯一的一道防线。便宜的那部分保留——`cli-exec`/adapter 会解析出二进制的绝对路径供审计/日志用,但不做"拒绝执行"。
- **§9.2 默认超时 = 硬编码 600s**(跟随 `codex-client.mjs` 既有的惯例),v1 不加 config 开关。
- **§9.3 codex `--json` 没有 model 字段 → `model: "unknown"`**:对策已确认;这一点要补进 `spike-findings.md §5` 的 open items,保持证据文档完整(顺带在 B0/B7 里做)。
- **B7 顺手把 `CHARTS/knowledge/aeloop.md` 建起来**:确认在本增量里建(从 A2 就欠下的账,harness 现在已经成型,是时候建了)。
- **分阶段复审 vs. 一次性复审**:留到 `/verify` 时再定,倾向于按 §7 的 B0-2 / B3-4 / B5-7 断点分三阶段申请复审(本增量属于"cli-bridge 行为验证"这一类,issue #10 也注明应该走完整的 Opus+Codex 双审)。

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A2 建好了 Harness 层,但 `harness/config.ts` 的 `buildAdapterRegistry()` 明确跳过了 `kind === "cli-bridge"`(注释原话是:"A3 fills in the construction branch for ClaudeCliAdapter/CodexCliAdapter here")——意味着对 subscription profile 来说(基于订阅、没有 API key,两个 provider `claude-cli`/`codex-cli` 都是 `cli-bridge`),现在调用 `buildAdapterRegistry(subscriptionConfig)` 只会得到一个**空**的 `AdapterRegistry`,完全没法真正调用模型。同时,DESIGN §8 明确把 `ToolExecVerifier` 定为"真正守住幻觉的那道关"——`ClaimSchema.verifiedBy` 允许模型自报某条 claim 是通过 `"tool_execution"` 验证过的,但现在没有任何机制去核实这个自报是不是真的。一个模型完全可以大大方方写下 `verifiedBy: "tool_execution"`,却压根没调用过任何工具。
- **这是给谁用的**:直接消费方是 A4(由 Loop/LangGraph 编排的 Coder/Tester 节点)——A4 会对 subscription profile 调 `ProviderRouter.route("coder")`/`route("tester")` 拿到一个真实的 `ClaudeCliAdapter`/`CodexCliAdapter` 实例并调 `invoke()`。再往下游是 Elisha 自己的 dogfooding 循环(基于订阅,不计入公司的 API 预算)。短期内直接用户是 Cypher/Zorro,在本增量和 A4 里跑测试。
- **一句话方案**:按照 spike 验证过的真实 CLI 调用形态,构建 `ClaudeCliAdapter`/`CodexCliAdapter`(都 `implements ModelAdapter`,`kind: "cli-bridge"`,共用一个新建的通用子进程执行原语 `cli-exec.ts` 来做 spawn/timeout/stdin 关闭),各自带自己的 JSONL trace 解析器,产出统一形状的 `ToolCallRecord[]`;构建 `ToolExecVerifier`(一个纯函数 `checkToolExecution`),按已经拍板的"存在性匹配"规则,核实"claim 声称有 tool_execution"和"trace 里真的发生过工具调用"是否一致,产出 `InvokeResult.toolExecChecked`;在 `harness/config.ts` 里接上 cli-bridge 分支,让 `profiles/subscription/config.yaml` 能真正构造出这两个真实 adapter;最后用一个硬核纵切测试证明这条通路端到端是真的接通的(`PromptComposer → ProviderRouter → AdapterRegistry(一个真实的 cli-bridge adapter,子进程指向一个受控 fixture 脚本而不是真实的 claude/codex 二进制)→ SchemaValidator → ToolExecVerifier 的判定落进 InvokeResult`)。

## 2. 目标 / 不做的事

**目标**:

- `src/harness/types.ts`:把 A2 留下的 `ToolCallRecord` 占位类型(`{ [key: string]: unknown }`)换成它的真实形状,新增一个 `ToolExecChecked` 类型别名(`"pass" | "fail" | "na"`,`InvokeResult.toolExecChecked` 也复用它)。
- `src/harness/cli-exec.ts`:一个跟具体 CLI 无关的通用子进程执行原语——`spawnWithTimeout()`,墙钟超时 + `SIGKILL` + **立即 `stdin.end()`**(spike §1.6 独立复现了 codex 的 stdin 阻塞坑;claude 可能没有同样的坑,但防御性地也做上不花什么代价)+ stdout/stderr **分开**收集(spike §1.5:codex 的 `--json` 模式下,噪音会跑到 stderr——合并会污染 JSONL 解析;`codex-client.mjs` 那种合并处理方式**不能照抄**)。
- `src/harness/adapters/codex-cli-adapter.ts`:`CodexCliAdapter` —— `codex exec --json --sandbox read-only "<prompt>"`,把 `type==="command_execution"` 的 `item.completed` 事件解析进 trace,取**最后一个** `agent_message` 的 `text` 作为 `content`。
- `src/harness/adapters/claude-cli-adapter.ts`:`ClaudeCliAdapter` —— `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools "<read-only tool set>"`,把 `tool_use`/`tool_result` 事件解析进 trace,取最后一个 `type==="result"` 事件的 `.result` 字段作为 `content`。
- `src/harness/tool-exec-verifier.ts`:`checkToolExecution(content, trace): ToolExecChecked` —— 一个纯函数,实现已经拍板的存在性匹配规则(§5 里有精确定义)。
- `src/harness/config.ts`:填上 `kind === "cli-bridge"` 分支——按 `providerConfig.cmd`(`"claude"` | `"codex"`)分发,构造对应的 adapter;无法识别的 `cmd` 值抛 `InvalidProviderConfigError`(和 direct-api 分支里既有的错误处理风格一致)。
- **硬核纵切**:一个端到端测试,证明这条链路——`PromptComposer` 产出的真实 prompt → 真实的 `buildAdapterRegistry`(用一个指向**受控 fixture 脚本**而不是真实 `claude`/`codex` 二进制的 `ProfileConfig`)→ `ProviderRouter` 选中正确的真实 cli-bridge adapter → adapter 真的 `spawn` 出一个子进程并真的解析它的 JSONL 输出 → `SchemaValidator` 成功校验 → `ToolExecVerifier` 的判定正确落进最终 `InvokeResult.toolExecChecked`——是完整接通的,而不是一堆孤立的绿色测试。

**不做的事(明确不做,留给以后的增量或 v2)**:

- ❌ **参数级匹配**(核对声称的具体文件路径/命令参数是否和 trace 里的真实调用逐字对得上)——已在 §0-1 拍板,推到 v2。
- ❌ **消费 `permission_denials` 字段**——已在 §0-2 拍板,触发条件未验证,v1 不依赖它。
- ❌ **移植 `codex-client.mjs` 的"不可信二进制路径"安全不变量**(那个文件的安全不变量 ⑤,拒绝执行一个解析到仓库本身或系统临时目录的 `codex` 二进制)——那是针对 Zorro 独立复审证据链里一个特定高风险信任边界的加固手段(防止有人伪造 `codex` 输出来骗过独立复审)。aeloop 自己的 coder/tester 循环没有直接对应的同等风险场景。v1 只做 PATH 解析拿到绝对路径供审计用,不实现"拒绝执行"这一层。**如果军师/指挥官认为 `ToolExecVerifier` 的可信度本身依赖于"PATH 上的 `codex`/`claude` 真的是正版二进制",因而需要同样的加固,请在确认阶段(§9.1)明确说出来**——我不是在替指挥官悄悄丢掉这层安全防护;我判断的是这两个场景的威胁模型不一样,把它标出来请求裁决。
- ❌ **通过 `config.yaml` 指定底层模型**(一个 `-m`/`--model` 覆盖项)——v1 用的是 CLI 自己当前配置好的默认模型(spike 实测是 `gpt-5.6-sol`(codex)/`claude-sonnet-5`(claude);这由当前本地配置决定,不是 adapter 硬编码的)。
- ❌ **让 coder 角色真的通过 CLI 把文件改动写到磁盘上** —— `CoderOutput.diff` 是一个**字符串**产物(DESIGN §3 时序图:`Coder-->>Orc: {diff, claims[], confidence}`),不是"CLI 自己把改动写进工作区"。两个 adapter 默认都是只读姿态(codex `--sandbox read-only`;claude 把 `--allowedTools` 限制成一个只读工具集,精确清单见 §5)。coder 角色要不要有直接改文件的更高权限,是 A4 的 Loop 网关设计要管的事,不是 A3 adapter 默认值要管的。
- ❌ **Loop 层的 G1-G3 gate / 持久化 `structured_claims`/`workflow_runs`/`approvals` 三张表** —— 那是 A4 的事;A3 只保证 `InvokeResult.toolExecChecked` 算得对,不碰数据库(和 A2 §4"无状态、无表"的边界一致)。
- ❌ **`profiles/apikey/`** —— apikey profile 里两个角色都走 `LiteLLMAdapter`(direct-api);A3 不碰它。
- ❌ **真实 CLI 进自动化测试套件** —— 按 `CLAUDE.md` 的"远控点火"原则(程序化/自动化调用不能打到交互式、按订阅计费的 CLI)。所有测试都走**受控 fixture 子进程脚本**(完整设计见 §5/§6);没有任何测试真的 `spawn` 生产环境的 `claude`/`codex` 二进制。

## 3. 用户故事

- 作为一个 **A4 Loop 开发者**,我希望对 subscription profile 调 `ProviderRouter.route("coder")` 能直接给我一个真能调用 `claude` CLI 的 `ModelAdapter`,不用操心 spawn/JSONL 解析的细节。
- 作为一个 **A4 Loop 开发者**,我希望当模型谎称"我验证过了"但实际上一个工具都没调用时,`InvokeResult.toolExecChecked` 能明确返回 `"fail"`,而不是悄悄信了模型的自报。
- 作为**指挥官**,我希望看到一个测试,证明这个幻觉场景——"模型自报 `verifiedBy: 'tool_execution'`,但 trace 完全是空的"——真的会被 `ToolExecVerifier` 抓住并标成 `fail`。不是文档里的一句断言,而是一次真实跑过的测试来证明。
- 作为**指挥官**,我希望有信心这套 adapter 不会在自动化测试里偷偷打到真实的 `claude`/`codex`、烧掉订阅额度——测试策略需要把这点讲清楚。

## 4. 数据模型

本增量**无状态、无表**,和 A2 一致——`structured_claims`/`workflow_runs`/`approvals` 仍然是 A4 Loop 的事。唯一的"数据形状"改动在内存类型这一层:
- `src/harness/types.ts` 的 `ToolCallRecord`(占位换成真实形状,定义在 §5)。
- `InvokeResult.toolExecChecked`——一个 A2 就声明了但从没填过的字段——本增量里第一次被真实 adapter 填上,值是 `"pass" | "fail" | "na"`(A2 的 direct-api adapter 仍然不设这个字段,继续留 `undefined`——DESIGN/types.ts 里已经讲清楚了这个区分:`undefined` 表示"这个 adapter 没有验证能力",显式的 `"na"` 表示"这个 adapter 有验证能力,只是这次没什么可验证的"。cli-bridge adapter 属于后一类,不能用 `undefined` 来蒙混过去)。

## 5. 逐文件任务清单

### 类型 / 通用原语

- `src/harness/types.ts`(**修改**,不是新文件):
  - 替换掉 A2 留下的 `ToolCallRecord` 占位定义。真实形状(两个 CLI 的证据都能对得上,spike-findings.md §3.1 对照表):
    ```typescript
    export interface ToolCallRecord {
      /** Unified tool identifier. codex always fills in "shell" (codex --json only exposes
       * shell-level command_execution and can't distinguish which specific underlying tool
       * was called — spike-findings.md §3.1); claude fills in the real tool name (Bash/Read/...). */
      toolName: string;
      /** The order in which this call appeared in the event stream collected during this
       * invoke() call (0-based) — the basis for establishing the premise "happened before the
       * final content" (the core finding of spike-findings.md §1.4). */
      sequenceIndex: number;
      /** Whether this call itself succeeded: codex uses exit_code===0; claude uses
       * tool_result.is_error===false. Left undefined when the underlying CLI gives no clear
       * success/failure signal — don't guess. */
      succeeded?: boolean;
      /** The raw event object, for debugging/auditing; ToolExecVerifier itself does not parse
       * this field any further. */
      raw: Record<string, unknown>;
    }
    export type ToolExecChecked = "pass" | "fail" | "na";
    ```
  - 把 `InvokeResult.toolExecChecked` 的类型改成用 `ToolExecChecked`(避免同一个字符串字面量 union 在两个地方各定义一遍)。
- `src/harness/cli-exec.ts`(**新文件**):
  - `spawnWithTimeout(cmd: string, args: string[], opts): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>` —— 一个跟具体 CLI 无关的通用子进程执行原语,两个 adapter 共用。
  - 照搬 `scripts/openai/codex-client.mjs` 里已经验证过的部分:一个显式的墙钟 `setTimeout` + 到期后 `SIGKILL`;**立即调用 `child.stdin.end()`**(spike §1.6 在纯命令行测试里独立复现了 codex 的 stdin 阻塞坑——这不是纸上谈兵的风险);stdout/stderr **分开**收集,不合并(spike §1.5,而且这一点和 `codex-client.mjs` 的处理方式**不同**——不能原样照搬);一个输出字节数上限(照搬 `codex-client.mjs` 的 32MB 上限,防止内存爆掉)。
  - **不照搬的部分**:`codex-client.mjs` 的 git-HEAD / 文件完整性快照检查,以及 `resolveCodexBinary` 的"不可信路径"执行拒绝逻辑——那些属于 review-wrapper 特有的信任边界(见 §2 不做的事)。`spawnWithTimeout` 只干一件事:"跑一个命令,可靠地拿到它的输出,绝不挂起。"
  - `opts.spawnImpl`(默认 `node:child_process.spawn`)可以被注入,给这个文件自己的单测用(§6 测试小节);**不对任何一个 adapter 的公开构造函数外露**——adapter 层的测试走真实子进程(见下面整体的"测试策略"一节);adapter 这一层不需要再开一个注入点。

### `ToolExecVerifier`

- `src/harness/tool-exec-verifier.ts`(**新文件**):
  - `checkToolExecution(content: string, trace: readonly ToolCallRecord[]): ToolExecChecked` —— 一个纯函数;已拍板规则(§0-1)在 v1 里的具体落地:
    1. 尝试 `JSON.parse(content)`;如果解析失败,或解析出来的对象没有 `claims` 数组 → 返回 `"na"`(**不是** `"fail"`——这种情况一般是 `SchemaValidator` 会重试/兜底的场景;`ToolExecVerifier` 在"看不懂"输入的时候不该猜一个否定判定)。
    2. 如果 `claims` 数组里**任意**一项的 `verifiedBy === "tool_execution"` → 视为"这次响应声称发生过 tool_execution";否则 → 返回 `"na"`(没人声称过,没什么可验证的)。
    3. 如果声称过 → `trace.length > 0` ? `"pass"` : `"fail"`。
  - **这是在当前 `ClaimSchema` 形状下"存在性匹配"的诚实落地,不是随意简化**:`ClaimSchema`(`src/prompt/schema.ts`)目前只有一个类似布尔值的自报字段 `verifiedBy: "tool_execution" | "human" | "unverified"`,**没有**"具体声称调用了哪些工具"这样的字段(比如 `toolsUsed: string[]`)。所以 §0-1 决定的字面表述——"声称的工具类型 ⊆ trace 里真实出现的工具类型"——在现有 schema 下,只能用一种诚实的形式实现:"声称发生过 ⊆ 真的发生过"(对一个单元素集合做子集检查,退化成了存在性检查)。**我认为这是在现有 schema 下唯一诚实的实现方式,但这是我的理解,不是决定文本字面要求的——请在确认阶段确认这是否符合预期。** 如果指挥官/军师希望 v1 给 `ClaimSchema` 加一个 `toolsUsed?: string[]` 字段做更细粒度的匹配,那是对 A1 schema 的改动(不在 A3 的文件清单范围内,而且需要更新两份 persona 文档)——需要另外拍板这算不算本增量的范围。
  - **"时序优先性"在这个设计下自动满足,不需要额外代码**:spike-findings.md §1.4 发现的那个坑(codex 在流式过程中先自报 `tools_used:[]`,直到真正跑完才纠正)本质上是"内容提取必须抓最后一个,不能随便抓一个"的问题——只要 `CodexCliAdapter`/`ClaudeCliAdapter` 各自的内容提取逻辑严格地取"整个事件流里最后一个最终答案"(见下面各 adapter 的任务描述),那么传进 `checkToolExecution` 的 `trace` 自然就是"这整次 `invoke()` 调用期间发生的所有工具调用,全都发生在那个最终 content 之前"(在一次非交互的单轮调用里,事件流严格按时间排序——`turn.completed`/`type:"result"` 永远是最后一行)——`checkToolExecution` 本身不需要做任何时间戳比较。
- `src/harness/__tests__/tool-exec-verifier.test.ts`:覆盖四种组合——① 声称 tool_execution 且 trace 非空 → `"pass"`;② 声称了但 trace 是空的 → `"fail"`(**这是本 PRD 里最重要的一个测试**——它直接对应防幻觉场景"模型谎称验证过了,实际上根本没调用过任何工具");③ 没有任何 claim 声称 tool_execution → `"na"`;④ `content` 不是合法 JSON / 没有 `claims` 字段 → `"na"`,不抛异常。

### `CodexCliAdapter`

- `src/harness/adapters/codex-cli-adapter.ts`(**新文件**):
  - 构造函数:`new CodexCliAdapter(id: string, config: { cmd?: string })`(`cmd` 默认 `"codex"`,取自 `ProviderConfig.cmd`,已经做过 `${ENV}` 替换)。`kind = "cli-bridge"`。
  - `invoke(req)`:调用 `spawnWithTimeout(config.cmd, ["exec", "--json", "--sandbox", "read-only", req.prompt], { timeoutMs: DEFAULT_TIMEOUT_MS })`(默认超时常量照搬 `codex-client.mjs` 的 600s,讨论见 §9.2;**不加** `--skip-git-repo-check`——生产环境永远跑在一个真实仓库里,这个 flag 只是因为这次 spike 的测试目录不是 git 仓库才需要)。
  - 解析 stdout(**必须是分开收集的那份,不带 stderr 噪音**——spike §1.5):逐行 `JSON.parse`,跳过解析失败的行(容错处理,不是每一行都保证是合法 JSON——比如有极小概率 codex 的 banner/warning 会漏进 stdout);
    - trace:收集所有 `type==="item.completed"` 且 `item.type==="command_execution"` 的事件,按出现顺序映射进 `ToolCallRecord`(`toolName: "shell"`,`sequenceIndex` = 出现顺序,`succeeded: item.exit_code === 0`,`raw: item`)。
    - content:取**最后一个** `type==="item.completed"` 且 `item.type==="agent_message"` 事件的 `item.text`。如果一个都没找到 → 视为异常输出,抛 `AdapterInvokeError`(不要返回空字符串蒙混过去)。
    - `model`:**`[?]` 新发现(超出 spike-findings.md 的原始范围,写 PRD 时重新验证过)—— `codex exec --json` 的 JSONL 事件流里根本没有 `model` 字段**(用 `grep -o '"model"'` 把 spike 期间抓到的所有 `--json` 样本重新验证了一遍,零命中;`model: gpt-5.6-sol` 这一行只出现在**没加** `--json` 的人类可读 banner 里——`--json` 模式不打印那部分 banner)。**v1 做法**:把 `InvokeResult.model` 硬编码成 `"unknown"`(照搬 `codex-client.mjs` 自己在 `buildAttestation` 里既有的惯例 `model: model ?? 'unknown'`,满足 `types.ts`"provider/model 必须是非空字符串"这条硬约束,同时不编造一个假的模型名)。如果将来某个 codex 版本的 `--json` 输出开始带 model 字段,到时候可以重新考虑。
  - `provider` 始终填 `this.id`(和 `LiteLLMAdapter` 的惯例一样)。
  - `toolExecChecked`:`invoke()` 内部直接调 `checkToolExecution(content, trace)` 来填这个字段。
  - `checkAvailability()`:`spawnWithTimeout(config.cmd, ["--version"], { timeoutMs: <一个较短的超时,比如 10s> })`,退出码 `0` → `available: true`;非零 / spawn 失败(ENOENT)/ 超时 → `available: false` + 原因(不是单纯检查 `config` 有没有填 `cmd` 就算完事——这直接对应 DESIGN §8.5"出现在 deepseek 列表里 ≠ 真的能调用"这条教训,也和 `LiteLLMAdapter.checkAvailability()` 既有的惯例一致)。
  - `toolTrace()`:返回**最近一次** `invoke()` 调用收集到的 `ToolCallRecord[]`(一个私有内部字段存最近一次的结果;`invoke()` 一开始把它重置成 `[]`,解析过程中逐步填充;如果 `invoke()` 从没被调用过就返回 `[]`,不抛异常)。**已知局限,已写进代码注释**:这个状态是按实例共享的——如果同一个 adapter 实例被并发多次调用 `invoke()`,`toolTrace()` 会有竞态(读到哪次调用的结果是未定义的)。v1 不处理并发场景——DESIGN 里的 coder→tester 循环本身就是顺序的,A4 Loop 目前的调用模式也没有"同一个 adapter 实例被并发调用两次"这种场景;将来万一出现,trace 需要挪到 `InvokeResult` 本身上,而不是靠一个查询式的 `toolTrace()` 去取,但那是一个接口层面的改动,不在 A3 解决的范围内——这里只是如实记一笔这个局限。

### `ClaudeCliAdapter`

- `src/harness/adapters/claude-cli-adapter.ts`(**新文件**):
  - 构造函数:`new ClaudeCliAdapter(id: string, config: { cmd?: string })`(`cmd` 默认 `"claude"`)。`kind = "cli-bridge"`。
  - `invoke(req)`:调用 `spawnWithTimeout(config.cmd, ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--allowedTools", "Bash,Read,Grep,Glob"], { timeoutMs: DEFAULT_TIMEOUT_MS })`。
    - `--verbose` 是硬性必须的(spike §2.4 确认过:`--output-format stream-json` 不带 `--verbose` 会立刻报错失败——不是可选项)。
    - `--permission-mode bypassPermissions` 也是硬性必须的(spike §2.4:非交互模式下,不显式声明这个,行为就取决于调用环境当下的权限状态——不可移植,而且可能卡住等审批)。
    - `--allowedTools "Bash,Read,Grep,Glob"`:**只读工具集**(对应 codex 的 `--sandbox read-only` 姿态,理由见 §2 不做的事)。**如实记一个局限**:这不是操作系统级的沙箱——`Bash` 工具本身理论上仍然能跑 `rm` 这种破坏性命令。claude CLI 的权限系统管的是"这个工具能不能被调用"这个层面,不是 codex `--sandbox` 提供的那种进程级只读挂载。这个差异写进了代码注释;是否需要更强的隔离(比如把整个 adapter 跑在一个专门的沙箱环境里)标为 `[?]`,留给 A4/军师评估——不是 A3 能单方面决定的。
  - 解析 stdout(逐行 `JSON.parse`,跳过解析失败的行):
    - trace:收集所有在 `type==="assistant"` 消息的 `message.content[]` 里出现的 `tool_use` 条目,通过 `tool_use_id`/`id` 和后续 `type==="user"` 消息 `message.content[]` 里对应的 `tool_result` 条目配对,映射进 `ToolCallRecord`(`toolName: tool_use.name`,`sequenceIndex` = `tool_use` 出现的顺序,`succeeded: tool_result.is_error === false`(找不到匹配的 `tool_result` 时留 `undefined`),`raw`:两个事件都存)。
    - content:取最后一行 `type==="result"` 的 `.result` 字段。检查 `.subtype==="success"` 且 `!is_error`;否则抛 `AdapterInvokeError`(带上能从 `.result`/`.subtype` 里扒出来的错误信息)。
    - `model`:取 `type==="system"`、`subtype==="init"` 事件的 `.model` 字段(spike 实测显示这个事件永远是事件流里真正的第一个内容事件,即便是一个没有任何工具调用的纯文本响应也会有——比从某个特定的 assistant 消息里扒要可靠)。找不到 → `"unknown"`(和 codex adapter 一样的兜底策略,不编造)。
  - `provider`/`toolExecChecked`/`checkAvailability()`/`toolTrace()`:和 `CodexCliAdapter` 对应部分设计一样(`checkAvailability()` 用 `<cmd> --version`,以退出码 0 判定;`toolTrace()` 有同样"只存最近一次调用、非并发安全"的局限)。

### `harness/config.ts`(**修改**)

- 把 `case "cli-bridge":` 分支从"明确跳过"改成真正去构造:
  ```typescript
  case "cli-bridge": {
    const cmd = providerConfig.cmd;
    if (cmd === "claude") { registry.register(new ClaudeCliAdapter(id, { cmd })); break; }
    if (cmd === "codex") { registry.register(new CodexCliAdapter(id, { cmd })); break; }
    throw new InvalidProviderConfigError(
      id, `cli-bridge provider "cmd" must be "claude" or "codex", got ${JSON.stringify(cmd)}`,
    );
  }
  ```
  (和 direct-api 分支里既有的"无法识别的 kind 抛 `InvalidProviderConfigError`"是同一套错误处理风格——`cmd` 的校验直接内联在 switch 分支里,没有单独拆出一个 `assertValidProviderConfig` 风格的函数——`cmd` 只有两个合法值,不像 `base_url` 那样需要独立可复用的校验逻辑。)
- 文件顶部的文档注释(目前写着"A3 fills in the construction branch here")需要更新——不能留着一句已经不再成立的话。

### 测试(和逐文件任务清单一一对应)

**测试策略(提前讲清楚——三层,每层有自己的边界,不是随便定的)**:

1. `cli-exec.ts` 自己的单测——注入 `spawnImpl`(一个 EventEmitter 假子进程,照搬 `codex-client.test.mjs` 的 `mockSpawn` 手法),专门测"超时 → SIGKILL"、"立即 stdin.end()"、"stdout/stderr 分开收集"——**这些是跟真实子进程无关的通用机制**——不需要真的等一个真实进程超时(用一个很小的 `timeoutMs: 50` + 一个永远不发 `close` 事件的假子进程,和 `codex-client.test.mjs` 已经验证过的手法一样)。
2. 两个 adapter 的单测——**不**注入 `spawnImpl`;而是把 `cmd` 指向一个**受控 fixture 脚本**(`src/harness/adapters/__tests__/fixtures/fake-codex.fixture.mjs` / `fake-claude.fixture.mjs`,不参与 `tsc` 编译的纯 Node `.mjs` 脚本,读一个环境变量来决定退出前打印哪套预设的 JSONL 输出)。这样 `spawnWithTimeout` **真的会** `child_process.spawn` 一个**真实**子进程——只不过这个子进程是我们自己写的替身:可控、零成本、不联网。这和 A2 的 `LiteLLMAdapter` 测试用的同一套"真实但受控"哲学一样——那边是真起一个本地 `node:http` 服务器而不是 mock `fetch`——只是把边界从"网络"挪到了"子进程"。fixture 脚本打印的 JSONL 是**从 spike-findings.md §1.3/§1.4/§2.2 里真实抓到的样本逐字照抄的**,不是随便编的。
3. 纵切 e2e —— 同样走 fixture 脚本(不是真实二进制),但除了这一处替换,其他所有组件都是真的(见 §6 里纵切批次的描述)。
   > **为什么不测真实的 `claude`/`codex` 二进制**:`CLAUDE.md` 的"远控点火"规则明确禁止程序化/自动化调用交互式、按订阅计费的 CLI(会造成非预期的额度消耗,而且不确定——真实模型的响应每次可能不一样,会让测试变得不稳定)。fixture 脚本策略让测试套件能**真正跑到子进程 spawn/解析的代码路径**,同时保持确定性、零成本、对 CI 友好。这是本 PRD 里刻意做出的测试策略选择,不是图省事走的捷径。

- `src/harness/__tests__/cli-exec.test.ts`:① 正常退出(exitCode 0,完整捕获 stdout);② 非零退出;③ 超时 → `SIGKILL` + `timedOut: true`(小 timeoutMs + 一个永远不 close 的假子进程);④ stdin 立即被关闭(断言假子进程的 `stdin.end` 被调用过,或者等价地断言在一个"假子进程如果 stdin 没被关就会挂起"的场景里,测试仍然在超时窗口内返回);⑤ stdout/stderr 各自落进各自的字段,不混在一起。
- `src/harness/__tests__/tool-exec-verifier.test.ts`:见上面"ToolExecVerifier"一节,四种组合全覆盖。
- `src/harness/adapters/__tests__/codex-cli-adapter.test.ts`(通过 `fake-codex.fixture.mjs`):① 有工具调用的场景(fixture 打印 spike §1.3 的真实 JSONL)→ `toolTrace()` 返回一条 `toolName: "shell"` 的记录,content 提取正确(最后一个 agent_message);② 无工具调用负例(fixture 打印 spike §1.3 里"Just say hello"的 JSONL)→ `toolTrace()` 返回 `[]`(这正是 spike 已经验证过的负例,现在把它固化成一个自动化回归测试);③ 模型声称 tool_execution 但 fixture 只打印没有工具调用的输出(构造一个"content 里嵌了 `verifiedBy: tool_execution` 但 trace 是空的"的场景,可能需要一个单独的 fixture 变体)→ `toolExecChecked === "fail"`,直接验证本 PRD 的核心防幻觉路径在真实 adapter 层也成立(不只是在 `tool-exec-verifier.test.ts` 的纯函数层);④ 非零退出 / 进程找不到(fixture 切换成一个永远退出 1 的东西,或者干脆指向一个不存在的路径)→ 抛 `AdapterInvokeError`;⑤ `checkAvailability()`:fixture 支持一个 `--version` 分支,退出 0 → `available: true`;⑥ `model` 字段固定为 `"unknown"`(对应上面 codex `--json` 缺 model 字段的新发现)。
- `src/harness/adapters/__tests__/claude-cli-adapter.test.ts`(通过 `fake-claude.fixture.mjs`):① 有工具调用的场景(spike §2.2 的真实 JSONL)→ `toolTrace()` 正确提取两条记录,`Bash`/`Read`,顺序正确;② **无工具调用负例**(决定 §0-3 要求的新测试,spike 里没有独立跑过)—— fixture 打印一份真实/等价的"不需要工具、纯文本回答"的 JSONL(可以复用 spike §2.2 claude 样本里的 `system/init` + 一条纯 `text` assistant 消息 + `result`,三行,完全不含 `tool_use`)→ 断言 `toolTrace()` 返回 `[]`;③ 声称 tool_execution 但 trace 是空的 → `toolExecChecked === "fail"`(和上面 codex 侧的 ② 对应);④ "缺 `--verbose` 会报错"这个场景**不需要专门的测试**(这是 adapter 内部硬编码的一个 flag,不是运行时可变的代码路径——没有分支可测);⑤ `model` 从 `system/init` 事件正确提取(断言等于 fixture 里预设的值,`"claude-sonnet-5"` 之类);⑥ `checkAvailability()` 和 codex 侧一样。
- `src/harness/__tests__/config.test.ts`(**扩展既有文件**,不是新文件):① 传入一个 `cmd: "claude"` 的 cli-bridge provider → registry 的 `get(id)` 得到一个 `ClaudeCliAdapter` 实例;② `cmd: "codex"` → 一个 `CodexCliAdapter` 实例;③ `cmd` 是无法识别的值(比如 `"gemini"`)→ 抛 `InvalidProviderConfigError`;④ **既有的 A2 测试,断言"真实 `profiles/subscription/config.yaml` → 空 registry",现在需要更新**——随着 subscription config 的两个 provider 现在真的能构造出 adapter 了,这个测试的断言要从"空 registry"改成"两个 provider 各自产出对应的 adapter 实例"(这是 A3 刻意打破 A2 断言的地方——PR 描述/commit message 必须讲清楚这个测试断言为什么变了,免得 Zorro 看 diff 时误以为是意外改动)。

### 纵切(A3 的收官项,一个硬性交付物)

- `src/harness-cli.e2e.test.ts`(命名对齐 `src/harness.e2e.test.ts` 既有的顶层 e2e 文件放置惯例——是新文件,不是改既有文件,因为 A2 的纵切证明的是"direct-api 路径接通了",而这一个证明的是"cli-bridge 路径接通了"——两个独立的场景,值得用互不干扰的独立文件):
  1. 真实的 `MemoryStore` + `ContextInjector` + `PromptComposer`(照搬 `harness.e2e.test.ts`/`context-prompt.e2e.test.ts` 已经用过的既有搭法,不重新造轮子)产出一个真实的 prompt 字符串。
  2. 一个**内存里的 fixture** `ProfileConfig`(不读真实的 `profiles/subscription/config.yaml`——那份指向真实的 `claude`/`codex` 二进制,e2e 测试需要改指向 fixture 脚本):`providers: { "codex-cli": { kind: "cli-bridge", cmd: "<absolute path to fake-codex.fixture.mjs>" } }`。
  3. 真实的 `buildAdapterRegistry(fixtureConfig)` → 真的构造出一个 `CodexCliAdapter` 实例(**这一步本身是这份纵切和 A2 版本最大的区别**——A2 的纵切直接 `new FakeAdapter()`,手写一个假的 `ModelAdapter`,完全绕过了 `buildAdapterRegistry`;这份纵切走的是 `buildAdapterRegistry` 真实的分发逻辑——唯一被换掉的是"真实的 `claude`/`codex` 二进制",不是"adapter 类本身")。
  4. 真实的 `ProviderRouter` 路由到这个真实的 adapter。
  5. 真实的 `SchemaValidator.validate({ schema: CoderOutput, ... })`,`invoke` 回调是 `(req) => adapter.invoke(req)`(这一步真的会 `spawn` fixture 脚本子进程)。
  6. 断言:最终拿到的 `data` 类型是 `CoderOutput`;`result.provider` 和 config 里的 provider id 一致;`result.toolExecChecked` 是从 fixture 脚本预设输出正确算出来的值(建议这份纵切用"声称 tool_execution 且 fixture 真的打印了一个 command_execution 事件"这个场景,断言 `"pass"`,这样这份纵切也就顺带把整条端到端的 pass 路径一起验证了,不只是"能拿到一个结果");`invoke()` 之后 `adapter.toolTrace()` 返回一个非空数组。
  - 这个测试就是 A3 对 DESIGN §8.5 那条规则——"每个里程碑收尾都必须有一个真正端到端接通的薄纵切"——给出的具体证据。

### 依赖 / 打包

- `package.json` —— **本增量不新增任何依赖**(`child_process`/`node:fs` 都是 Node 内置模块;fixture 脚本是纯 `.mjs`,不需要打进 `dist/`——需要确认 `package.json` 的 `files` 字段和 `tsconfig.build.json` 的排除规则不会不小心把 `__tests__/fixtures/*.fixture.mjs` 扫进发布产物;虽然这些文件已经和 `.test.ts` 文件放在同一目录下,但 `vitest.config.ts` 的 `include` 只捡 `*.test.ts`,`tsc` 只捡 `*.ts`,`.fixture.mjs` 天然不会被任何一条工具链捡到——这是一个确认,不是一个假设)。

## 6. 批次拆分

> 单位沿用和 A0-A2 PRD 一样的自定义刻度:`[S]` ≈ 2-4 小时,`[M]` ≈ 半天到一天,`[L]` ≈ 1-2 天。单分支 `feature/issue-10-a3-cli-bridge`,按批次顺序 commit(理由和 §7 一样)。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `src/harness/types.ts`(真实 `ToolCallRecord` 形状 + `ToolExecChecked` 类型) | 无(起点) | [S] |
| **B1** | `src/harness/cli-exec.ts` + `cli-exec.test.ts`(通用 spawn/timeout/stdin 关闭原语,spawnImpl 注入式单测) | B0 | [M] |
| **B2** | `src/harness/tool-exec-verifier.ts` + `tool-exec-verifier.test.ts`(纯函数,四种组合) | B0 | [S] |
| **B3** | `src/harness/adapters/codex-cli-adapter.ts` + 测试 + `fake-codex.fixture.mjs`(fixture 内容逐字照抄真实 spike 样本) | B0+B1+B2 | [L] |
| **B4** | `src/harness/adapters/claude-cli-adapter.ts` + 测试(含 §0-3 要求的无工具调用负例)+ `fake-claude.fixture.mjs` | B0+B1+B2 | [L] |
| **B5** | `src/harness/config.ts` 接上 cli-bridge 分支 + `config.test.ts` 扩展(含必须点名讲清楚的那一点:"打破 A2 的空 registry 断言") | B3+B4 | [S] |
| **B6** | 纵切 `src/harness-cli.e2e.test.ts` | B5 | [M] |
| **B7** | 文档回写(`docs/ROADMAP.md` 勾掉 A3 那一行 / `docs/PROGRESS.md` 清空 / `CHANGELOG.md` 新条目 / 根 `CLAUDE.md` 的目录结构说明从"loop/cli 待建"改成"cli-bridge 已建,loop 待建" / `CHARTS/knowledge/aeloop.md` 是否该在本增量里建——A2 的 PRD §6 B7 留过同一个开放问题,一直没建;A3 完工后模块更成型了,所以建议这次建,但这仍然是一个"建议",不是我单方面拍板,留给指挥官/军师) | B6 | [S] |

**依赖图说明**:B3(CodexCliAdapter)和 B4(ClaudeCliAdapter)彼此独立——理论上可以并行,因为两者都只依赖 B0+B1+B2 共享的类型/原语/verifier——但因为是同一个 Cypher 顺序实现,不做单独的分支拆分。B5 必须等两个 adapter 都写完才能接线(否则 `config.ts` 的 switch 分支会引用还不存在的类)。B6 的纵切必须等 B5 完成。

## 7. 分支策略

单分支 `feature/issue-10-a3-cli-bridge`,按 §6 的批次顺序 commit,理由和 A0-A2 的 PRD 一样:一个人顺序实现,大多数批次间依赖都是真实的(B0→B1/B2→B3/B4→B5→B6→B7),没有需要独立合并的并行协作场景。如果指挥官想让 Zorro 分阶段复审(而不是最后一次性看一个大 diff),同一分支内的 commit 可以按 §6 的三个自然断点分批提交复审:"B0-B2(类型 + 通用原语 + verifier)/ B3-B4(两个 adapter)/ B5-B7(接线 + 纵切 + 文档)"——考虑到本增量涉及"cli-bridge 行为验证"(issue #10 原文已经注明应该走完整的 Opus+Codex 双审),分阶段复审在这里可能比 A2 更有必要,留给指挥官判断。

## 8. 可核验的验收标准(checklist)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess`,零错误),`pnpm lint`(`tsc --noEmit`)同样零错误。
- [ ] `pnpm test` 全绿(vitest run),包含所有新的 A3 测试文件,并且**不产生任何真实网络/真实 CLI 调用**(可以用类似 `grep -rn "spawn(" src/harness --include="*.test.ts"` 的方式确认没有测试文件直接 `spawn` `'claude'`/`'codex'`——即没有调用指向真实二进制)。
- [ ] **防幻觉核心场景有真实测试**:"模型自报 `verifiedBy: 'tool_execution'` 但 trace 是空的"在**两层**都被测过——`tool-exec-verifier.test.ts`(纯函数层)和至少一个 adapter 的 `*.test.ts`(真实 adapter 层)——都断言 `toolExecChecked === "fail"`。
- [ ] **无工具调用负例是对称的**(§0-3):`claude-cli-adapter.test.ts` 有一个测试断言"一个不需要工具的 prompt → `toolTrace()` 返回 `[]`",和 codex 侧既有的对应测试对称。
- [ ] **两个 adapter 都实现了 `ModelAdapter` 的每一个方法**:`id`/`kind`(固定 `"cli-bridge"`)/`checkAvailability()`(真的 spawn `--version`,不是单纯读 config)/`invoke()`/`toolTrace()`。
- [ ] **`InvokeResult.provider`/`.model` 都是非空字符串**(DESIGN §8.5#4 既有的硬约束,A3 延续):`codex-cli-adapter.test.ts`/`claude-cli-adapter.test.ts` 的成功路径测试各自断言这两个字段非空(codex 侧专门断言 `model === "unknown"`,claude 侧断言从 `system/init` 事件正确提取)。
- [ ] **`config.ts` 接线**:`config.test.ts` 有测试证明真实的 `cmd: "claude"`/`cmd: "codex"` provider 条目能构造出对应的真实 adapter 类实例;无法识别的 `cmd` 抛 `InvalidProviderConfigError`。
- [ ] **打破 A2 断言的地方有明确记录**:对于 `config.test.ts` 里原来那个断言"真实 subscription config → 空 registry"的测试,更新后的测试本身和 commit message/PR 描述都清楚说明这是一个预期内的、A3 范围内的行为变化,不是意外回归。
- [ ] **纵切必须是接通的**:`harness-cli.e2e.test.ts` 存在且通过——一个由真实 `MemoryStore`+`ContextInjector`+`PromptComposer` 产出的真实 prompt,走过真实的 `buildAdapterRegistry`(fixture 脚本替身)+ 真实的 `ProviderRouter` + 真实的 cli-bridge adapter(真的 spawn 子进程)+ 真实的 `SchemaValidator`,得到一个类型正确的 `CoderOutput`,`toolExecChecked` 判定正确。
- [ ] `cli-exec.ts` 的四个机制——超时/SIGKILL/立即关闭 stdin/stdout-stderr 分离——各自都有测试覆盖。
- [ ] `docs/ROADMAP.md` 对应的 A3 那一行勾掉,`docs/PROGRESS.md` 清空或更新,`CHANGELOG.md` 加新条目,根 `CLAUDE.md` 的目录结构说明同步更新。

## 9. 依赖 / 风险

### 9.1 要不要移植 `codex-client.mjs` 的"不可信二进制路径"安全检查——建议指挥官/军师拍板

`codex-client.mjs` 的安全不变量 ⑤(resolveCodexBinary + 拒绝执行一个解析到仓库本身或系统临时目录的二进制)存在的目的是防止有人伪造一个假 `codex` 来骗过 Zorro 独立复审的证据链——那是一个**一次性、高风险的信任边界,结果直接决定"这段代码能不能合并"**。A3 的 `ClaudeCliAdapter`/`CodexCliAdapter` 服务的是 aeloop 自己的 coder/tester 循环——理论上,如果 PATH 上的 `codex`/`claude` 被恶意替换,`ToolExecVerifier` 的判定也会跟着被污染(一个伪造的二进制可以在 trace 里捏造"我调用了工具"的假事件,让 `checkToolExecution` 误判成 `"pass"`)——这和 Zorro 场景是同一类风险,只是触发频率/爆炸半径不同(coder/tester 循环的输出仍然要过 G1-G3 人工审批 gate,所以一个伪造的 `toolExecChecked: "pass"` 不是唯一的防线;而 Zorro 的独立复审往往就是"这段代码能不能直接被信任"这个关键判断本身)。**我的判断**:v1 不做(YAGNI + 控制 A3 自身复杂度),但明确说明这个风险不是"不存在",而是"评估过、推迟了"——如果指挥官认为 `ToolExecVerifier` 的可信度本身值得这层加固,请直接改这一节的结论;我不会在接下来的实现里悄悄加上或悄悄跳过它。

### 9.2 默认超时值——`[?]` 待确认,建议跟随 `codex-client.mjs` 的既有惯例

`cli-exec.ts` 的 `DEFAULT_TIMEOUT_MS` 建议直接跟 `codex-client.mjs` 的 600s(复审 prompt 通常比调研 prompt 大;aeloop 的 coder/tester prompt 同样可能带完整的上下文注入,量级相近)。目前没有任何一条 A3 验收标准要求这个值精确等于某个特定数字;要不要把它做成一个可以通过 `config.yaml` 覆盖的开关(而不是硬编码常量)留给 v2——v1 硬编码,YAGNI,目前没有已知场景需要按角色/provider 用不同的超时长度。

### 9.3 codex `--json` 没有 `model` 字段——写 PRD 时的新发现,对策已记在 §5

这一点不在 `spike-findings.md` 的原始范围内(原始 spike 只验证了纯文本模式能从 banner 里用正则提取 `model`,没有专门检查 `--json` 模式是不是也有这个字段)。写 PRD 阶段对已经抓到的 `--json` 样本重新做了一遍 grep 复核,确认零命中。对策已经在 §5 的 `CodexCliAdapter` 任务描述里拍板(硬编码成 `"unknown"`);这一节只是把这个"新发现"单独点出来给军师复核——如果觉得有用,这一点可以补进 `spike-findings.md` 的 open items(§5),保持证据文档完整(本 PRD 目前不回头去改那份文档——留给军师判断)。

### 9.4 `ClaimSchema` 目前不支持"具体声称了哪些工具"——影响 §0-1 决定能落地到多精确

详细解释见 §5 `tool-exec-verifier.ts` 任务描述:v1 的"存在性匹配"实际上退化成了布尔判断"声称过 tool_execution ⊆ 真的发生过 tool_execution",而不是真正的集合子集判断"声称的具体工具列表 ⊆ trace 里的具体工具列表"——因为 `ClaimSchema` 本身没有携带"具体工具名列表"这样的字段。这不是我能替 A1 做的决定(`ClaimSchema` 在 A1 的文件范围内)——在这里标出来只是为了确认这个理解是否符合决定 §0-1 的原意。

## 10. 项目约束检查表

- **模型无关?** 是——`ClaudeCliAdapter`/`CodexCliAdapter` 都只是 `ModelAdapter` 的一种可插拔实现;`ProviderRouter`/`AdapterRegistry`/`SchemaValidator` 完全不知道它们的存在,和 A2 的 `LiteLLMAdapter` 地位平等。
- **没有反向跨层依赖?** 是——`src/harness/adapters/{codex,claude}-cli-adapter.ts` 只 import 同层的 `harness/types.ts`/`harness/errors.ts`/`harness/cli-exec.ts`/`harness/tool-exec-verifier.ts`,不 import `src/context/`/`src/loop/`(A4 还不存在)。
- **`profiles/apikey/` 未被动?** 是——本增量没有在 `profiles/apikey/` 下创建/修改任何文件。
- **角色未硬编码?** 是——两个 adapter 都不区分调用方是 `coder` 还是 `tester`;`invoke(req: InvokeRequest)` 对角色一无所知(本增量的两个 adapter 甚至不读 `req.role`)。
- **引擎代码不含 Helix persona 内容?** 是——`src/harness/` 下所有新代码零 Helix/companion/个人记忆内容。
- **远控点火(`CLAUDE.md` 规则)?** 是——见 §5 测试策略小节里专门的说明:自动化测试套件完全不产生对真实 `claude`/`codex` 二进制的调用,全都走受控 fixture 脚本子进程。
