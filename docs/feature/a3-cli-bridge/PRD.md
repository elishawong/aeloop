# PRD — aeloop A3:CLI 桥接层(ClaudeCliAdapter + CodexCliAdapter + ToolExecVerifier)

> 骨架来源:`ai-agent/OPS/_templates/feature/PRD.md`(结构)+ `aeloop/docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`(同仓已有 PRD 的写法惯例,分层/批次/验收表述风格照抄)。
> 防幻觉:`[?]` = 我未验证 / 需要指挥官确认,不编造接口/版本/参数。本 PRD 的每条 CLI 行为描述都来自 `docs/feature/a3-cli-bridge/spike-findings.md`(issue #10 前置 spike,真跑命令 + 真实输出样本),不是回忆/假设。

- **项目**:aeloop(`elishawong/aeloop`,私有仓)
- **分支**:`feature/issue-10-a3-cli-bridge`
- **优先级**:P1
- **状态**:已批(2026-07-20 Elisha 批准。§0 三决策 + §9.1/§9.2/§9.4 开放点全部拍板,见 §0 补录)
- **最后更新**:2026-07-20
- **关联 issue**:[elishawong/aeloop#10](https://github.com/elishawong/aeloop/issues/10)(本增量)· 上游追踪 [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120)(统一引擎架构总 issue)
- **设计权威**:`aeloop/docs/DESIGN.md`(§7 适配层设计 / §8 里程碑 A3 / §8.5#4 `InvokeResult` 字段 / §5 `structured_claims.tool_exec_checked`)+ `docs/feature/a3-cli-bridge/spike-findings.md`(本 issue 的前置 spike,唯一的 CLI 行为证据源)

---

## 0. 已拍板决策(2026-07-20 指挥官裁决,写死,不再讨论)

1. **v1 `ToolExecVerifier` = 存在性/子集匹配**——「声称的工具执行 ⊆ trace 里出现过的真实工具调用」。**参数级匹配(核对声称的具体文件路径/命令参数是否和 trace 里的真实调用逐字对得上)明确推 v2**,不在本增量范围(§2 非目标)。
2. **`permission_denials` 字段标 `[?]`**——spike 未能在 2-3 次尝试内复现它的触发条件(见 spike-findings.md §2.3),v1 不消费这个字段,不保证任何 adapter 会填充/依赖它。
3. **claude 的「无工具调用」负控用例 spike 没独立跑**——PRD 测试计划**必须含**:`ClaudeCliAdapter` 用一条明确不需要工具的 prompt → 断言 trace 为空数组(和 codex 已验证过的负控对称),build 阶段第一批任务里补上(§5 测试小节)。

### 0.1 确认阶段补录(2026-07-20,军师核对 PRD 后指挥官拍板)

- **§0-1 存在性检查 = 最终定论(选项 A)**:确认 v1 `ToolExecVerifier` 就做 §5 描述的存在性检查(「任一 claim 声称 tool_execution → trace 必须非空,否则 fail」),**不在 A3 动 `ClaimSchema`**。§9.4 指出的「退化」是当前 schema 下的诚实落地,符合决策原意——**理由**:今天 `verifiedBy` 是零核实,v1 把它从「全信模型自 report」提到「不能空手声称验证过」已是有意义的第一道闸;codex trace 只给 shell 级、逐工具匹配价值不对称。真·逐工具匹配(加 `toolsUsed`)= **v2,已开跟踪 [elishawong/aeloop#11](https://github.com/elishawong/aeloop/issues/11)**。
- **§9.1 不可信二进制路径拒绝执行 = v1 跳过**(采纳 Cypher 建议):威胁需本机被攻陷,且 coder/tester 产出还过 A4 的 G1-G3 人工门,不像 Zorro 是唯一防线。保留便宜部分——`cli-exec`/adapter 解析出二进制绝对路径供审计/日志,但不做「拒绝执行」。
- **§9.2 超时默认 = 600s 硬编码**(沿用 codex-client.mjs),v1 不做 config knob。
- **§9.3 codex `--json` 无 model 字段 → `model: "unknown"`**:确认对策;并把这条追加进 `spike-findings.md §5` 开放点保持证据文档完整(B0/B7 顺手)。
- **B7 顺手建 `CHARTS/knowledge/aeloop.md`**:确认本增量建(A2 起欠着,harness 已成型,该建)。
- **分阶段审 vs 一次性**:留到 `/verify` 时定,倾向按 §7 的 B0-2 / B3-4 / B5-7 三断点分段请审(本增量属 cli-bridge 行为核实类,issue #10 注明走全套 Opus+Codex)。

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A2 建好了 Harness 层,但 `harness/config.ts` 的 `buildAdapterRegistry()` 对 `kind === "cli-bridge"` 显式跳过(注释原话:「A3 补 ClaudeCliAdapter/CodexCliAdapter 的构造分支于此」)——这意味着 subscription profile(订阅制、无 apikey,两个 provider `claude-cli`/`codex-cli` 都是 `cli-bridge`)目前跑 `buildAdapterRegistry(subscriptionConfig)` 会拿到一个**空的** `AdapterRegistry`,完全没有能力真的调一个模型。同时 DESIGN §8 点名 `ToolExecVerifier` 是「唯一真防幻觉的那道闸」——`ClaimSchema.verifiedBy` 允许模型自称某条 claim 是靠 `"tool_execution"` 验证的,但目前没有任何机制核实这个自称是不是真的,模型完全可以在从未调用任何工具的情况下堂而皇之地写 `verifiedBy: "tool_execution"`。
- **给谁用**:直接消费方是 A4(Loop/LangGraph 编排的 Coder/Tester 节点)—— A4 会对 subscription profile 调 `ProviderRouter.route("coder")`/`route("tester")` 拿到真实的 `ClaudeCliAdapter`/`CodexCliAdapter` 实例并调用 `invoke()`。更下游是 Elisha 本人的实际 dogfood 循环(订阅制,不打公司 API 计费)。短期内直接使用者是 Cypher/Zorro 在本增量和 A4 里跑测试。
- **一句话方案**:按 spike 验证过的真实 CLI 调用形态建 `ClaudeCliAdapter`/`CodexCliAdapter`(都 `implements ModelAdapter`,`kind: "cli-bridge"`,复用同一个新建的通用子进程执行原语 `cli-exec.ts` 处理 spawn/超时/stdin 关闭)+ 各自的 JSONL trace 解析器,产出统一形状的 `ToolCallRecord[]`;建 `ToolExecVerifier`(纯函数 `checkToolExecution`)按已拍板的「存在性匹配」规则核实「claim 声称 tool_execution」与「trace 里真的发生过工具调用」是否一致,产出 `InvokeResult.toolExecChecked`;把 `harness/config.ts` 的 cli-bridge 分支接上,让 `profiles/subscription/config.yaml` 真的能构造出两个真实 adapter;最后用一条硬性垂直切片测试证明这条链路真的接通(`PromptComposer → ProviderRouter → AdapterRegistry(真实 cli-bridge adapter,子进程指向受控 fixture 脚本而非真实 claude/codex 二进制)→ SchemaValidator → ToolExecVerifier 的判定落进 InvokeResult`)。

## 2. 目标 / 非目标

**目标**:
- `src/harness/types.ts`:把 A2 留的 `ToolCallRecord` 占位(`{ [key: string]: unknown }`)换成真实形状,新增 `ToolExecChecked` 类型别名(`"pass" | "fail" | "na"`,复用给 `InvokeResult.toolExecChecked`)。
- `src/harness/cli-exec.ts`:CLI-无关的通用子进程执行原语——`spawnWithTimeout()`,墙钟超时 + `SIGKILL` + **立刻 `stdin.end()`**(spike §1.6 独立复现过 codex 的 stdin 阻塞坑,claude 未必有同样的坑但同样防御一遍不吃亏)+ stdout/stderr **分开**收集(spike §1.5:codex `--json` 模式下噪音走 stderr,合并会污染 JSONL 解析,`codex-client.mjs` 的合并处理**不能照抄**)。
- `src/harness/adapters/codex-cli-adapter.ts`:`CodexCliAdapter`——`codex exec --json --sandbox read-only "<prompt>"`,解析 `item.completed` 里 `type==="command_execution"` 的事件为 trace,取**最后一条** `agent_message` 的 `text` 作为 `content`。
- `src/harness/adapters/claude-cli-adapter.ts`:`ClaudeCliAdapter`——`claude -p "<prompt>" --output-format stream-json --verbose --permission-mode bypassPermissions --allowedTools "<只读工具集>"`,解析 `tool_use`/`tool_result` 事件为 trace,取最后一条 `type==="result"` 的 `.result` 字段作为 `content`。
- `src/harness/tool-exec-verifier.ts`:`checkToolExecution(content, trace): ToolExecChecked`——纯函数,已拍板的存在性匹配规则(§5 有精确定义)。
- `src/harness/config.ts`:填 `kind === "cli-bridge"` 分支——按 `providerConfig.cmd`(`"claude"` | `"codex"`)分派构造对应 adapter;未识别的 `cmd` 值抛 `InvalidProviderConfigError`(和 direct-api 分支已有的错误处理风格一致)。
- **硬性垂直切片**:一条端到端测试证明「`PromptComposer` 输出的真实 prompt → 真实 `buildAdapterRegistry`(用一份指向**受控 fixture 脚本**而非真实 `claude`/`codex` 二进制的 `ProfileConfig`)→ `ProviderRouter` 选中正确的真实 cli-bridge adapter → adapter 真的 `spawn` 一个子进程、真的解析它的 JSONL 输出 → `SchemaValidator` 校验通过 → `ToolExecVerifier` 的判定正确落进最终 `InvokeResult.toolExecChecked`」这条链路全部接通,不是若干孤立绿测试。

**非目标(明确不做,留给后续增量或 v2)**:
- ❌ **参数级匹配**(核对声称的具体文件路径/命令参数与 trace 里真实调用逐字对得上)——已拍板决策 §0-1,推 v2。
- ❌ **消费 `permission_denials` 字段**——已拍板决策 §0-2,触发条件未验证,v1 不依赖它。
- ❌ **搬 `codex-client.mjs` 的「不可信二进制路径」安全不变量**(该文件安全不变量⑤,拒绝执行落在仓库自身/系统临时目录的 `codex` 二进制)——那是 Zorro 独立审查证据链这个**特定高风险信任边界**(防有人伪造 `codex` 输出骗过独立审查)的专属加固,aeloop 自己的 coder/tester 循环没有直接对应的同等风险场景。v1 只做 PATH 解析拿绝对路径供审计,不做"拒绝执行"这层。**这条如果军师/指挥官认为 `ToolExecVerifier` 的可信度本身依赖"PATH 上的 `codex`/`claude` 真的是真身"而需要同等加固,请在确认阶段明说**——不是我替指挥官悄悄放弃这层安全性,是我判断这两个场景的威胁模型不同,标出来请裁决(§9.1)。
- ❌ **通过 `config.yaml` 指定底层模型**(`-m`/`--model` 覆盖)——v1 用 CLI 自身已配置的默认模型(spike 实测出来的是 `gpt-5.6-sol`(codex)/`claude-sonnet-5`(claude),这是本机当前配置决定的,不是 adapter 写死的)。
- ❌ **coder 角色让 CLI 真的落盘改文件**——`CoderOutput.diff` 是**字符串**产物(DESIGN §3 sequence:`Coder-->>Orc: {diff, claims[], confidence}`),不是"CLI 自己把改动写进工作区"。两个 adapter 默认都用只读姿态(codex `--sandbox read-only`;claude 限定 `--allowedTools` 到只读工具集,§5 有精确清单),coder 是否需要更高权限直接改文件是 A4 Loop 网关设计的事,不是 A3 adapter 默认值的事。
- ❌ **Loop 层的 G1-G3 门 / `structured_claims`/`workflow_runs`/`approvals` 建表持久化**——A4;A3 只保证 `InvokeResult.toolExecChecked` 被正确计算出来,不碰数据库(和 A2 §4 的"无状态、不建表"边界一致)。
- ❌ **`profiles/apikey/`**——apikey profile 的两个角色都走 `LiteLLMAdapter`(direct-api),A3 不涉及。
- ❌ **真实 CLI 打进自动化测试套件**——`CLAUDE.md`「远控点火」原则(程序化/自动化不打按订阅计费的交互式 CLI)。测试全部走**受控 fixture 子进程脚本**(§5/§6 有完整设计),没有任何测试会真的 `spawn` 生产环境的 `claude`/`codex` 二进制。

## 3. 用户故事

- 作为 **A4 的 Loop 开发者**,我想要对 subscription profile 调 `ProviderRouter.route("coder")` 直接拿到一个能真的调用 `claude` CLI 的 `ModelAdapter`,不用关心 spawn/JSONL 解析这些细节。
- 作为 **A4 的 Loop 开发者**,我想要 `InvokeResult.toolExecChecked` 在模型谎报「我验证过了」但实际没调用任何工具时明确给我 `"fail"`,而不是沉默地信任模型的自我报告。
- 作为 **指挥官**,我想要看到一条测试证明「模型自称 `verifiedBy: "tool_execution"` 但 trace 里空空如也」这种幻觉场景真的会被 `ToolExecVerifier` 抓出来标 `fail`——不是文档自称,是真跑测试证明。
- 作为 **指挥官**,我想要确认这套 adapter 不会在自动化测试里偷偷打真实 `claude`/`codex` 消耗订阅额度——测试策略要显式交代清楚。

## 4. 数据模型

本增量**无状态、不建表**,和 A2 一致——`structured_claims`/`workflow_runs`/`approvals` 三张表仍是 A4 Loop 的事。唯一"数据形状"变化是内存态类型:
- `src/harness/types.ts` 的 `ToolCallRecord`(占位换成真实形状,§5 定义)。
- `InvokeResult.toolExecChecked` 这个 A2 已声明但从未被填充的字段,本增量首次由真实 adapter 计算并填充为 `"pass" | "fail" | "na"`(A2 的 direct-api adapter 仍然不设置这个字段,继续留 `undefined`——DESIGN/types.ts 已明确的区分:`undefined` =「这个 adapter 没有核实能力」,显式 `"na"` =「这个 adapter 有核实能力,但这次没什么可核的」,cli-bridge adapter 属于后者,不能用 `undefined` 蒙混)。

## 5. 逐文件任务清单

### 类型 / 通用原语

- `src/harness/types.ts`(**修改**,不是新文件):
  - 替换 A2 留的占位 `ToolCallRecord` 定义。真实形状(两个 CLI 的证据都能填,spike-findings.md §3.1 对照表)：
    ```typescript
    export interface ToolCallRecord {
      /** 统一后的工具标识。codex 固定填 "shell"(codex --json 只暴露 shell 级 command_execution,
       * 分不清底层具体调了什么工具——spike-findings.md §3.1);claude 填真实工具名(Bash/Read/...)。 */
      toolName: string;
      /** 这次调用在本次 invoke() 收集到的事件流里的出现顺序(0-based)——建立"发生在最终
       * content 之前"这个时序前提的依据(spike-findings.md §1.4 的核心发现)。 */
      sequenceIndex: number;
      /** 这次调用自身是否成功:codex 用 exit_code===0;claude 用 tool_result.is_error===false。
       * 底层 CLI 没给出明确成败信号时留 undefined,不猜。 */
      succeeded?: boolean;
      /** 原始事件对象,供调试/审计,ToolExecVerifier 自己不再进一步解析这个字段。 */
      raw: Record<string, unknown>;
    }
    export type ToolExecChecked = "pass" | "fail" | "na";
    ```
  - `InvokeResult.toolExecChecked` 的类型改用 `ToolExecChecked`(避免字符串字面量联合在两处重复定义)。
- `src/harness/cli-exec.ts`(**新文件**):
  - `spawnWithTimeout(cmd: string, args: string[], opts): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>`——CLI 无关的通用子进程执行原语,两个 adapter 共用。
  - 镜像 `scripts/openai/codex-client.mjs` 已验证过的部分:显式墙钟 `setTimeout` + 到点 `SIGKILL`;**立刻 `child.stdin.end()`**(spike §1.6 在纯命令行测试里独立复现过 codex 的 stdin 阻塞坑,不是理论风险);stdout/stderr **分开收集**,不合并(spike §1.5,和 `codex-client.mjs` 的处理方式**不同**,不能照抄);输出字节数上限(镜像 `codex-client.mjs` 的 32MB 上限,防内存爆)。
  - **不镜像**:`codex-client.mjs` 的 git HEAD / 文件完整性快照检查、`resolveCodexBinary` 的"不可信路径"拒绝执行逻辑——那是 review-wrapper 专属的信任边界(见 §2 非目标)。`spawnWithTimeout` 只做"跑一个命令、可靠拿到输出、绝不 hang"这一件事。
  - `opts.spawnImpl`(默认 `node:child_process.spawn`)可注入,供本文件自己的单测使用(§6 测试小节),**不对外暴露给两个 adapter 的公开构造函数**——adapter 层测试走真实子进程(见下方"测试策略"整体说明),不需要在 adapter 这一层再开一个注入口。

### `ToolExecVerifier`

- `src/harness/tool-exec-verifier.ts`(**新文件**):
  - `checkToolExecution(content: string, trace: readonly ToolCallRecord[]): ToolExecChecked`——纯函数,已拍板规则(§0-1)在 v1 的具体落地:
    1. 尝试 `JSON.parse(content)`;解析失败,或解析出的对象没有 `claims` 数组 → 返回 `"na"`(**不是** `"fail"`——这种情况通常是 `SchemaValidator` 会去重试/兜底的场景,`ToolExecVerifier` 不该在"看不懂"的时候乱猜出一个负面判定)。
    2. `claims` 数组里**任意一条**的 `verifiedBy === "tool_execution"` → 视为「本次响应声称发生过 tool_execution」;否则 → 返回 `"na"`(没人声称,没什么可核的)。
    3. 声称了 → `trace.length > 0` ? `"pass"` : `"fail"`。
  - **这是"存在性匹配"在当前 `ClaimSchema` 形状下的诚实落地,不是憑空简化**:`ClaimSchema`(`src/prompt/schema.ts`)目前只有 `verifiedBy: "tool_execution" | "human" | "unverified"` 这个布尔性质的自称字段,**没有**"声称调用了哪些具体工具"的字段(如 `toolsUsed: string[]`)。所以 §0-1 决策原话「声称的工具类型 ⊆ trace 里出现过的工具类型」在当前 schema 下唯一能落地的形式就是"声称发生过 ⊆ 真的发生过"(单元素集合的子集判断,退化成存在性检查)。**这条我认为是决策原意在当前 schema 下唯一诚实的实现,但这是我的解读,不是决策原文逐字要求的,请在确认阶段核对是否符合预期**——如果指挥官/军师希望 v1 就往 `ClaimSchema` 加一个 `toolsUsed?: string[]` 字段做更细粒度匹配,那是 A1 schema 的改动(超出 A3 文件范围,且要改两份 persona 文档),需要单独定这算不算本增量范围。
  - **"时序前置"在这个设计下自动满足,不需要额外代码**:spike-findings.md §1.4 发现的坑(codex 中途自称 `tools_used:[]`、跑完才修正)本质是"content 抽取要抓最后一条,不是任意一条"——只要 `CodexCliAdapter`/`ClaudeCliAdapter` 各自的 content 抽取逻辑严格取"整个事件流里最后一条最终答案"(见下方两个 adapter 各自的任务描述),那么传给 `checkToolExecution` 的 `trace` 天然就是"这整个 invoke() 调用期间发生的所有工具调用,全部先于这条最终 content"(非交互单轮调用里,事件流严格按时间顺序排列,`turn.completed`/`type:"result"` 永远是最后一行)——`checkToolExecution` 本身不需要再做时间戳比较。
- `src/harness/__tests__/tool-exec-verifier.test.ts`:覆盖四种组合——① 声称 tool_execution 且 trace 非空 → `"pass"`;② 声称但 trace 为空 → `"fail"`(**这是本 PRD 最核心的一条测试**——直接对应"模型谎报验证过了但压根没调用任何工具"这个防幻觉场景);③ 没有任何 claim 声称 tool_execution → `"na"`;④ `content` 不是合法 JSON / 没有 `claims` 字段 → `"na"`,不抛异常。

### `CodexCliAdapter`

- `src/harness/adapters/codex-cli-adapter.ts`(**新文件**):
  - 构造:`new CodexCliAdapter(id: string, config: { cmd?: string })`(`cmd` 默认 `"codex"`,取自 `ProviderConfig.cmd`,已经过 `${ENV}` 替换)。`kind = "cli-bridge"`。
  - `invoke(req)`:调 `spawnWithTimeout(config.cmd, ["exec", "--json", "--sandbox", "read-only", req.prompt], { timeoutMs: DEFAULT_TIMEOUT_MS })`(默认超时常量镜像 `codex-client.mjs` 的 600s,§9.2 有讨论;**不加** `--skip-git-repo-check`——生产环境永远跑在真实仓库里,那个 flag 只是本 spike 测试目录不是 git repo 时才需要的)。
  - 解析 stdout(**必须是分开收集的那份,不含 stderr 噪音**——spike §1.5):逐行 `JSON.parse`,跳过解析失败的行(容错,不是每行都保证是合法 JSON,如 codex banner/警告有极小概率漏进 stdout);
    - trace:收集所有 `type==="item.completed"` 且 `item.type==="command_execution"` 的事件,按出现顺序映射成 `ToolCallRecord`(`toolName: "shell"`、`sequenceIndex` = 出现顺序、`succeeded: item.exit_code === 0`、`raw: item`)。
    - content:取**最后一条** `type==="item.completed"` 且 `item.type==="agent_message"` 的 `item.text`。找不到任何一条 → 视为异常输出,抛 `AdapterInvokeError`(不返回空字符串蒙混过关)。
    - `model`:**`[?]` 新发现(超出原 spike-findings.md 范围,PRD 写作阶段重新验证过)——`codex exec --json` 的 JSONL 事件流里完全没有 `model` 字段**(用 `grep -o '"model"' ' 对所有 spike 阶段捕获的 `--json` 样本重新核实过,零命中;`model: gpt-5.6-sol` 那行只出现在**不带** `--json` 的人类可读 banner 里,`--json` 模式下这段 banner 不打印)。**v1 做法**:`InvokeResult.model` 固定填 `"unknown"`(镜像 `codex-client.mjs` 自己 `buildAttestation` 里 `model: model ?? 'unknown'` 的既有惯例,满足 `types.ts` "provider/model 必须非空字符串"的硬约束,同时不编造一个假模型名)。如果未来某个 codex 版本的 `--json` 输出开始带 model 字段,再回来改。
  - `provider` 固定填 `this.id`(和 `LiteLLMAdapter` 一致的惯例)。
  - `toolExecChecked`:`invoke()` 内部直接调 `checkToolExecution(content, trace)` 填入。
  - `checkAvailability()`:`spawnWithTimeout(config.cmd, ["--version"], { timeoutMs: 短超时(如 10s) })`,exit code `0` → `available: true`;非 0/spawn 失败(ENOENT)/超时 → `available: false` + reason(不是只检查 config 里有没有填 `cmd` 就算可用——DESIGN §8.5「deepseek 列表可见≠可调用」教训的直接对应项,和 `LiteLLMAdapter.checkAvailability()` 的既有惯例一致)。
  - `toolTrace()`:返回**最近一次** `invoke()` 调用收集到的 `ToolCallRecord[]`(内部私有字段存最近一次结果;`invoke()` 开始时先重置为 `[]`,再随解析过程填充;从未调用过 `invoke()` 时返回 `[]`,不抛)。**已知限制,写进代码注释**:这个状态是单实例共享的,如果同一个 adapter 实例被并发调用多次 `invoke()`,`toolTrace()` 会有竞态(读到哪次调用的结果不确定)。v1 不处理并发场景——DESIGN 的 coder→tester 循环本身是顺序的,A4 Loop 目前的调用模式不存在"同一个 adapter 实例被并发 invoke 两次"这种用法;如果未来出现,需要把 trace 挪到 `InvokeResult` 自己身上而不是查询式的 `toolTrace()`,但那是接口层面的改动,不在 A3 范围内解决,这里只诚实记录限制。

### `ClaudeCliAdapter`

- `src/harness/adapters/claude-cli-adapter.ts`(**新文件**):
  - 构造:`new ClaudeCliAdapter(id: string, config: { cmd?: string })`(`cmd` 默认 `"claude"`)。`kind = "cli-bridge"`。
  - `invoke(req)`:调 `spawnWithTimeout(config.cmd, ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", "--allowedTools", "Bash,Read,Grep,Glob"], { timeoutMs: DEFAULT_TIMEOUT_MS })`。
    - `--verbose` 是硬性必需(spike §2.4 实测:`--output-format stream-json` 不加 `--verbose` 直接报错退出,不是可选项)。
    - `--permission-mode bypassPermissions` 是硬性必需(spike §2.4:非交互模式下不显式声明,行为依赖调用环境已有的权限状态,不可移植,可能挂起等批准)。
    - `--allowedTools "Bash,Read,Grep,Glob"`:**只读工具集**(和 codex 的 `--sandbox read-only` 对应的姿态,§2 非目标已说明理由)。**诚实标注一个局限**:这不是 OS 级沙箱,`Bash` 工具本身理论上仍能跑 `rm` 之类的破坏性命令——claude CLI 的权限系统是"这个工具能不能被调用"级别的许可,不是 codex `--sandbox` 那种进程级只读挂载。这条差异写进代码注释,`[?]` 标注是否需要更强隔离(比如整个 adapter 跑在专门的沙箱环境里)留给 A4/军师评估,不是 A3 能单方面解决的。
  - 解析 stdout(逐行 `JSON.parse`,跳过解析失败的行):
    - trace:收集所有 `type==="assistant"` 消息里 `message.content[]` 中 `type==="tool_use"` 的条目,和随后 `type==="user"` 消息里 `message.content[]` 中 `type==="tool_result"` 的条目按 `tool_use_id`/`id` 配对,映射成 `ToolCallRecord`(`toolName: tool_use.name`、`sequenceIndex` = `tool_use` 出现的顺序、`succeeded: tool_result.is_error === false`(找不到配对的 `tool_result` 时 `succeeded` 留 `undefined`)、`raw`:两个事件都存)。
    - content:取**最后一行** `type==="result"` 的 `.result` 字段。检查 `.subtype==="success"` 且 `!is_error`;否则抛 `AdapterInvokeError`(带上 `.result`/`.subtype` 里能拿到的错误信息)。
    - `model`:取 `type==="system"`、`subtype==="init"` 事件的 `.model` 字段(spike 实测这个事件永远是流的第一条真正的内容事件,即使是纯文本无工具调用的响应也有,可靠性优于从某条 assistant 消息里现挖)。找不到 → `"unknown"`(同 codex adapter 的兜底策略,不编造)。
  - `provider`/`toolExecChecked`/`checkAvailability()`/`toolTrace()`:同 `CodexCliAdapter` 的对应设计(`checkAvailability()` 用 `<cmd> --version`,exit 0 判定;`toolTrace()` 同样的"最近一次调用、非并发安全"限制)。

### `harness/config.ts`(**修改**)

- 把 `case "cli-bridge":` 分支从"显式跳过"改成真实构造:
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
  (和 direct-api 分支已有的"未识别 kind 抛 `InvalidProviderConfigError`"是同一套错误处理风格,`cmd` 校验直接内联在 switch 分支里,不额外抽一个 `assertValidProviderConfig` 式的函数——`cmd` 只有两个合法值,没有 `base_url` 那种需要独立复用的校验逻辑。)
- 顶部文档注释(现在写着"A3 补构造分支于此"那段)要更新掉,不能留一句已经不再成立的话。

### 测试(与逐文件任务一一对应)

**测试策略(先说清楚,三层各自用什么边界,不是随便选的)**:
1. `cli-exec.ts` 自己的单测——注入 `spawnImpl`(EventEmitter 假子进程,镜像 `codex-client.test.mjs` 的 `mockSpawn` 手法),专测"超时→SIGKILL"“立刻 stdin.end()”“stdout/stderr 分开收集”这些**和真实子进程无关的通用机制**,不需要真的等一个真实进程超时(用 `timeoutMs: 50` 这种小数值 + 永不 emit `close` 的假子进程,同 `codex-client.test.mjs` 已验证的手法)。
2. 两个 adapter 的单测——**不注入 spawnImpl**,而是让 `cmd` 指向一个**受控 fixture 脚本**(`src/harness/adapters/__tests__/fixtures/fake-codex.fixture.mjs` / `fake-claude.fixture.mjs`,纯 Node `.mjs` 脚本,不参与 `tsc` 编译,读一个环境变量选择打印哪种预置 JSONL 输出后退出)。这样 `spawnWithTimeout` 是**真的** `child_process.spawn` 了一个**真的**子进程,只是这个子进程是我们自己写的、可控、零成本、零网络的替身——和 A2 `LiteLLMAdapter` 测试"起一个真实本地 `node:http` 服务器,不 mock `fetch`"是同一种"真实但受控"哲学的对应物,只是把边界从"网络"换成"子进程"。fixture 脚本打印的 JSONL **原样复制自 `spike-findings.md` §1.3/§1.4/§2.2 的真实捕获样本**,不是我随手编的假数据。
3. 垂直切片 e2e——同样走 fixture 脚本(不是真实二进制),但除了这一点之外全部是真实组件(见 §6 里对垂直切片的批次描述)。
   > **为什么不用真实 `claude`/`codex` 二进制跑测试**:`CLAUDE.md`「远控点火」明确交互式/订阅制 CLI 不能被程序化自动化调用(会产生非预期的额度消耗、且非确定性——真实模型响应内容每次可能不同,测试会变 flaky)。fixture 脚本策略让测试套件**在真实的子进程 spawn/parse 代码路径上跑**,同时保持确定性、零成本、CI 友好。这是本 PRD 明确的测试策略选择,不是偷懒抄近路。

- `src/harness/__tests__/cli-exec.test.ts`:①正常退出(exitCode 0,拿到完整 stdout);②非零退出;③超时 → `SIGKILL` + `timedOut: true`(小 timeoutMs + 假子进程永不 close);④ stdin 立刻被关闭(断言假子进程的 `stdin.end` 被调用,或等价地断言一个"如果不关闭 stdin 就会挂起"的假子进程场景下测试仍然在超时时间内返回);⑤ stdout/stderr 分别落进对应字段,不混流。
- `src/harness/__tests__/tool-exec-verifier.test.ts`:见上方"ToolExecVerifier"小节,四种组合全覆盖。
- `src/harness/adapters/__tests__/codex-cli-adapter.test.ts`(走 `fake-codex.fixture.mjs`):①含工具调用的场景(fixture 打印 spike §1.3 那份真实 JSONL)→ `toolTrace()` 返回一条 `toolName: "shell"` 的记录,`content` 抽取正确(最后一条 agent_message);②无工具调用的对照组(fixture 打印 spike §1.3 里"Just say hello"那份真实 JSONL)→ `toolTrace()` 返回 `[]`(这条本来就是 spike 已验证过的负控,这里是把它固化成自动化回归测试);③模型自称 tool_execution 但 fixture 只打印无工具调用的输出(構造一个"content 里塞了 verifiedBy: tool_execution 但 trace 为空"的场景,可以是单独一份 fixture 变体)→ `toolExecChecked === "fail"`,直接验证本 PRD 最核心的防幻觉路径在真实 adapter 层面也成立(不只是 `tool-exec-verifier.test.ts` 那层纯函数单测);④非零退出/进程找不到(fixture 换成一个总是 exit 1 或干脆指向不存在的路径)→ 抛 `AdapterInvokeError`;⑤ `checkAvailability()`:fixture 支持 `--version` 分支,exit 0 → `available: true`;⑥ `model` 字段固定为 `"unknown"`(对应上面新发现的 codex `--json` 无 model 字段这条)。
- `src/harness/adapters/__tests__/claude-cli-adapter.test.ts`(走 `fake-claude.fixture.mjs`):①含工具调用场景(spike §2.2 真实 JSONL)→ `toolTrace()` 正确抽出 `Bash`/`Read` 两条记录,顺序正确;②**无工具调用负控**(§0-3 拍板决策要求的新测试,spike 没独立跑过)——fixture 打印一份"不需要工具、纯文字回答"的真实/等价 JSONL(可以复用 spike §2.2 里 claude 的 `system/init` + 一条纯 `text` assistant 消息 + `result` 三行,不含任何 `tool_use`)→ 断言 `toolTrace()` 返回 `[]`;③声称 tool_execution 但 trace 为空 → `toolExecChecked === "fail"`(同 codex 侧②的镜像测试);④缺 `--verbose` 报错场景**不需要专门测试**(这是 adapter 内部固定拼死的 flag,不是运行时可变路径,没有分支可测);⑤ `model` 从 `system/init` 事件正确抽取(断言等于 fixture 里预置的 `"claude-sonnet-5"` 或类似值);⑥ `checkAvailability()` 同 codex 侧。
- `src/harness/__tests__/config.test.ts`(**扩展已有文件**,不是新文件):①传入 `cmd: "claude"` 的 cli-bridge provider → registry 里 `get(id)` 拿到 `ClaudeCliAdapter` 实例;②`cmd: "codex"` → `CodexCliAdapter` 实例;③`cmd` 是未识别值(如 `"gemini"`)→ 抛 `InvalidProviderConfigError`;④**A2 已有的那条"真实 `profiles/subscription/config.yaml` → 空 registry"的固定测试现在要更新**——subscription config 的两个 provider 现在应该真的能构造出 adapter 了,这条测试的断言从"空 registry"改成"两个 provider 都能拿到对应 adapter 实例"(这是 A3 故意打破 A2 那条断言的地方,PR 描述/commit message 要说清楚为什么这条测试的断言变了,不能让 Zorro 看 diff 时以为是意外改动)。

### 垂直切片(A3 收尾,硬性交付)

- `src/harness-cli.e2e.test.ts`(命名对齐 `src/harness.e2e.test.ts` 的顶层 e2e 文件放置惯例,新文件而非改已有的那份——A2 那条切片证明的是"direct-api 路径接通",这条证明的是"cli-bridge 路径接通",两条独立场景值得独立文件,互不干扰):
  1. 真实 `MemoryStore` + `ContextInjector` + `PromptComposer`(照抄 `harness.e2e.test.ts`/`context-prompt.e2e.test.ts` 已有的搭建方式,不重新发明)产出真实 prompt 字符串。
  2. 一份**内存态 fixture** `ProfileConfig`(不是读真实 `profiles/subscription/config.yaml`——那份指向真实 `claude`/`codex` 二进制,e2e 测试要指向 fixture 脚本):`providers: { "codex-cli": { kind: "cli-bridge", cmd: "<绝对路径指向 fake-codex.fixture.mjs>" } }`。
  3. 真实 `buildAdapterRegistry(fixtureConfig)` → 真实构造出一个 `CodexCliAdapter` 实例(**这一步本身就是本条切片和 A2 版本最大的区别**——A2 的切片直接 `new FakeAdapter()` 手写一个假的 `ModelAdapter`,完全绕过了 `buildAdapterRegistry`;这条切片走真实的 `buildAdapterRegistry` 分派逻辑,唯一被替身替换的是"`claude`/`codex` 这个真实二进制",不是"adapter 这个类本身")。
  4. 真实 `ProviderRouter` 路由到这个真实 adapter。
  5. 真实 `SchemaValidator.validate({ schema: CoderOutput, ... })`,`invoke` 回调就是 `(req) => adapter.invoke(req)`(这一步会真的 `spawn` fixture 脚本子进程)。
  6. 断言:最终拿到的 `data` 是 typed `CoderOutput`;`result.provider` 是配置里的 provider id;`result.toolExecChecked` 是根据 fixture 脚本预置输出正确计算出的值(建议这条切片用"声称 tool_execution 且 fixture 真的打印了 command_execution 事件"的场景,断言 `"pass"`,让这条切片顺带验证一次"端到端 pass 路径全部接通",而不只是"能拿到结果");`adapter.toolTrace()` 在 `invoke()` 之后返回非空数组。
  - 这条测试是 DESIGN §8.5"每个里程碑收尾必须有一条薄垂直切片真正接通"在 A3 的落地证据。

### 依赖 / 打包

- `package.json` —— **本增量不新增任何依赖**(`child_process`/`node:fs` 都是 Node 内建;fixture 脚本是纯 `.mjs`,不需要打包进 `dist/`——需要确认 `package.json` 的 `files` 字段和 `tsconfig.build.json` 的 exclude 规则不会不小心把 `__tests__/fixtures/*.fixture.mjs` 卷进发布产物,虽然它们本来就在 `.test.ts` 同目录下、`vitest.config.ts` 的 `include` 只认 `*.test.ts`,`tsc` 只认 `*.ts`,`.fixture.mjs` 天然不会被两边任何一个工具链捡到,这条只是确认一遍不是假设)。

## 6. 批次拆解

> 单位延用 A0-A2 PRD 的自定义量级:`[S]` ≈ 2-4h、`[M]` ≈ 半天到一天、`[L]` ≈ 1-2 天。单分支 `feature/issue-10-a3-cli-bridge` 顺序提交(理由同 §7)。

| 批次 | 内容 | 依赖 | 规模 |
|---|---|---|---|
| **B0** | `src/harness/types.ts`(`ToolCallRecord` 真实形状 + `ToolExecChecked` 类型) | 无(起点) | [S] |
| **B1** | `src/harness/cli-exec.ts` + `cli-exec.test.ts`(通用 spawn/超时/stdin 关闭原语,注入 spawnImpl 单测) | B0 | [M] |
| **B2** | `src/harness/tool-exec-verifier.ts` + `tool-exec-verifier.test.ts`(纯函数,四种组合) | B0 | [S] |
| **B3** | `src/harness/adapters/codex-cli-adapter.ts` + 测试 + `fake-codex.fixture.mjs`(fixture 内容原样复制 spike 真实样本) | B0+B1+B2 | [L] |
| **B4** | `src/harness/adapters/claude-cli-adapter.ts` + 测试(含 §0-3 拍板要求的无工具调用负控)+ `fake-claude.fixture.mjs` | B0+B1+B2 | [L] |
| **B5** | `src/harness/config.ts` 接入 cli-bridge 分支 + `config.test.ts` 扩展(含"打破 A2 空 registry 断言"这条要点名交代的变更) | B3+B4 | [S] |
| **B6** | 垂直切片 `src/harness-cli.e2e.test.ts` | B5 | [M] |
| **B7** | 文档回写(`docs/ROADMAP.md` A3 行打钩 / `docs/PROGRESS.md` 清空 / `CHANGELOG.md` 加行 / 根 `CLAUDE.md` 目录结构行更新为"loop/cli 待建"改成"cli-bridge 已建、loop 待建" / `CHARTS/knowledge/aeloop.md` 是否本增量就建——A2 PRD §6 B7 留过同样的开放问题,一直没建,A3 完成后模块更多了,建议这次一并建,但仍是"建议"不是我单方面决定,留给指挥官/军师定) | B6 | [S] |

**依赖图要点**:B3(CodexCliAdapter)和 B4(ClaudeCliAdapter)彼此独立,理论上可并行(都只依赖 B0+B1+B2 共享的类型/原语/verifier),同一个 Cypher 顺序实现故不额外拆分支。B5 必须等两个 adapter 都写完才能接线(否则 `config.ts` 的 switch 分支会引用还不存在的类)。B6 垂直切片必须等 B5 完成才能做。

## 7. 分支策略

单分支 `feature/issue-10-a3-cli-bridge`,批次按 §6 顺序提交,理由同 A0-A2 PRD:一个人顺序实现,批次间大部分是真依赖(B0→B1/B2→B3/B4→B5→B6→B7),没有需要独立合并的并行协作场景。若指挥官希望 Zorro 分阶段审(而非一次性大 diff),可在同一分支内按"B0-B2(类型+通用原语+verifier)/ B3-B4(两个 adapter)/ B5-B7(接线+切片+文档)"三个自然断点分别提交并请求阶段性审查——考虑到本增量涉及"cli-bridge 行为核实类"(issue #10 原文已注明"走全套 Opus+Codex"),分阶段审可能比 A2 更有必要,留给指挥官判断。

## 8. 可测验收标准(可勾选)

- [ ] `pnpm build` 成功(tsc strict + `noUncheckedIndexedAccess` 无报错),`pnpm lint`(`tsc --noEmit`)同样无报错。
- [ ] `pnpm test` 全绿(vitest run),新增 A3 测试文件全部计入,且**不产生任何真实网络/真实 CLI 调用**(可用 `grep -rn "spawn(" src/harness --include="*.test.ts"` 之类的检查确认测试文件里没有直接 `spawn('claude', ...)`/`spawn('codex', ...)` 这种指向真实二进制的调用)。
- [ ] **防幻觉核心场景有真测试**:「模型自称 `verifiedBy: 'tool_execution'` 但 trace 为空」这个场景在 `tool-exec-verifier.test.ts`(纯函数层)和至少一个 adapter 的 `*.test.ts`(真实 adapter 层)**两层都有测试**,都断言 `toolExecChecked === "fail"`。
- [ ] **无工具调用负控对称**(§0-3):`claude-cli-adapter.test.ts` 有一条测试断言"不需要工具的 prompt → `toolTrace()` 返回 `[]`",和 codex 侧已有的对应测试对称存在。
- [ ] **两个 adapter 都实现 `ModelAdapter` 全部方法**:`id`/`kind`(固定 `"cli-bridge"`)/`checkAvailability()`(真的 spawn `--version`,不是只读配置)/`invoke()`/`toolTrace()`。
- [ ] **`InvokeResult.provider`/`.model` 非空字符串**(DESIGN §8.5#4 的既有硬约束,A3 继续遵守):`codex-cli-adapter.test.ts`/`claude-cli-adapter.test.ts` 的成功路径测试各自断言这两个字段非空(codex 侧固定断言 `model === "unknown"`,claude 侧断言从 `system/init` 事件正确抽取)。
- [ ] **`config.ts` 接线**:`config.test.ts` 有测试证明真实 `cmd: "claude"`/`cmd: "codex"` 的 provider 条目能构造出对应的真实 adapter 类实例;未识别 `cmd` 抛 `InvalidProviderConfigError`。
- [ ] **打破 A2 断言的地方被显式记录**:`config.test.ts` 里原来断言"真实 subscription config → 空 registry"的那条测试,改动后的版本 + commit message/PR 描述里都清楚说明这是预期的、A3 范围内的行为变化,不是意外回归。
- [ ] **垂直切片必接通**:`harness-cli.e2e.test.ts` 存在且通过——真实 `MemoryStore`+`ContextInjector`+`PromptComposer` 产出的真实 prompt,经真实 `buildAdapterRegistry`(fixture 脚本替身)+真实 `ProviderRouter`+真实 cli-bridge adapter(真的 spawn 子进程)+真实 `SchemaValidator`,拿到 typed `CoderOutput` 且 `toolExecChecked` 判定正确。
- [ ] `cli-exec.ts` 的超时/SIGKILL/stdin 立刻关闭/stdout-stderr 分流 四条机制各有测试覆盖。
- [ ] `docs/ROADMAP.md` A3 对应行打钩、`docs/PROGRESS.md` 清空或更新、`CHANGELOG.md` 加行、根 `CLAUDE.md` 目录结构行同步更新。

## 9. 依赖 / 风险

### 9.1 要不要搬 `codex-client.mjs` 的"不可信二进制路径"安全检查——建议指挥官/军师拍板

`codex-client.mjs` 的安全不变量⑤(resolveCodexBinary + 拒绝执行落在仓库自身/系统临时目录的二进制)是为了防止有人伪造一个假 `codex` 骗过 Zorro 的独立审查证据链——那是一个**单次、高风险、结果直接决定"代码能不能合并"的信任边界**。A3 的 `ClaudeCliAdapter`/`CodexCliAdapter` 服务的是 aeloop 自己的 coder/tester 循环,理论上如果 PATH 上的 `codex`/`claude` 被恶意替换,`ToolExecVerifier` 的判定也会被污染(伪造的二进制可以在 trace 里编造"我调用过工具"的假事件,让 `checkToolExecution` 误判 `"pass"`)——这和 Zorro 场景的风险性质是同一类,只是触发频率/影响半径不同(coder/tester 循环的产出还要经过 G1-G3 人工审批门,伪造的 `toolExecChecked: "pass"` 不是唯一防线;而 Zorro 的独立审查经常是"这段代码能不能直接信"的关键判断)。**我的判断**:v1 先不做(YAGNI + 降低 A3 本身的复杂度),但明确写出这条风险不是"不存在",是"评估后延后"——如果指挥官认为 `ToolExecVerifier` 的可信度本身值得这层加固,请直接改本节结论,我不会自己在后续实现里悄悄加上或悄悄跳过。

### 9.2 超时默认值——`[?]` 待确认,建议先按 `codex-client.mjs` 的既有惯例定

`cli-exec.ts` 的 `DEFAULT_TIMEOUT_MS` 建议直接沿用 `codex-client.mjs` 的 600s(审查 prompt 通常比研究 prompt 大;aeloop 的 coder/tester prompt 同样可能带上完整 context 注入,量级接近)。这个值目前没有被任何 A3 验收项要求精确到某个数字,是否要做成可通过 `config.yaml` 覆盖的 knob(而不是硬编码常量)留作 v2——v1 硬编码,YAGNI,没有已知场景需要按 role/provider 区分超时长度。

### 9.3 codex `--json` 无 `model` 字段——PRD 写作阶段新发现,已在 §5 记录对策

这条不在原 `spike-findings.md` 的记录范围内(原 spike 只验证了 codex 纯文本模式能从 banner 正则抽出 `model`,没有专门检查 `--json` 模式是否也有这个字段)。PRD 写作阶段重新对已捕获的 `--json` 样本做了 grep 复核,确认零命中。已在 §5 `CodexCliAdapter` 任务描述里定了对策(固定填 `"unknown"`),这里只是把这条"新发现"单独点出来,方便军师核对——如果觉得有必要,可以把这条追加进 `spike-findings.md` 的开放点(§5)里,保持证据文档的完整性(本 PRD 暂未回头改那份文档,视军师意见决定)。

### 9.4 `ClaimSchema` 目前不支持"声称了哪些具体工具"——影响 §0-1 决策的精确落地方式

见 §5 `tool-exec-verifier.ts` 任务描述里的详细说明:v1 的"存在性匹配"实际上退化成"声称过 tool_execution ⊆ 真的发生过 tool_execution"的布尔判断,而不是"声称的具体工具列表 ⊆ trace 里的具体工具列表"这种真正意义上的集合子集判断——因为 `ClaimSchema` 本身没有携带"具体工具名列表"这个字段。这条不是我能替 A1 的 schema 做决定的地方(`ClaimSchema` 属于 A1 文件范围),只标出来供确认这个理解和 §0-1 决策原意是否一致。

## 10. 项目约束检查

- **模型无关?** 是——`ClaudeCliAdapter`/`CodexCliAdapter` 都是 `ModelAdapter` 的其中一种可插拔实现,`ProviderRouter`/`AdapterRegistry`/`SchemaValidator` 完全不感知它们的存在,和 A2 的 `LiteLLMAdapter` 处于同等地位。
- **跨层无反向依赖?** 是——`src/harness/adapters/{codex,claude}-cli-adapter.ts` 只 import 同层的 `harness/types.ts`/`harness/errors.ts`/`harness/cli-exec.ts`/`harness/tool-exec-verifier.ts`,不 import `src/context/`/`src/loop/`(A4 尚不存在)。
- **`profiles/apikey/` 不入仓?** 是——本增量不创建/不修改 `profiles/apikey/` 任何文件。
- **角色不硬编码?** 是——两个 adapter 都不区分调用方是 `coder` 还是 `tester`,`invoke(req: InvokeRequest)` 对角色一无所知(`req.role` 字段本增量的两个 adapter 甚至不读取它)。
- **引擎代码不含 Helix 人格?** 是——`src/harness/` 下所有新代码零 Helix/companion/私人记忆内容。
- **远控点火(`CLAUDE.md` 铁律)?** 是——见 §5 测试策略小节的专门说明,自动化测试套件不产生任何对真实 `claude`/`codex` 二进制的调用,全部走受控 fixture 脚本子进程。
