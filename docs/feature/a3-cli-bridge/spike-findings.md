# A3 CLI-Bridge 预研 Spike —— 真实环境调研结论(issue #10)

> **是侦察,不是 adapter 代码。** 目标:用真实命令输出回答"`ToolExecVerifier` 到底能不能真的校验
> 工具调用",给 PRD 提供证据而不是假设。
>
> 测试环境:`codex-cli 0.144.1`(`/opt/homebrew/bin/codex`)、`claude 2.1.215 (Claude Code)`
> (`~/.nvm/.../bin/claude`)、macOS,测试目录
> `/private/tmp/.../scratchpad/spike-testdir`(内含 `fileA.txt`/`fileB.txt`,各一行文字)。
> 下面每条命令都是在这个 session 里真实跑过的;输出样本都是原样粘贴
> (不是编造的/不是凭记忆回想的)。

## 一句话结论(先说重点)

- **两个 CLI 都能产出可解析的 tool trace**—— 但前提是用对 flag:codex 需要 `--json`,
  claude 需要 `--output-format stream-json --verbose`。默认/其他 flag 组合下,
  tool trace 要么是非结构化的(codex 纯文本模式),要么根本拿不到(claude `--output-format json`)。
- **推荐 v1 的校验粒度:「声称的工具 ⊆ 实际调用的工具」的存在性/子集匹配**,
  而不是对命令内容做逐字段深度匹配——理由见下文「`ToolExecVerifier` 证据来源建议」。
- **两个 CLI 都没有内置的 timeout flag**——`ToolExecVerifier`/adapter 必须自己实现墙钟超时
  (`spawn` + `setTimeout` + `SIGKILL`),可以直接照搬 `codex-client.mjs` 里已经验证过的模式。

---

## 1. `codex exec` 真实环境测试

### 1.1 命令行形态

参考 `scripts/openai/codex-client.mjs`(`buildExecArgs`),基础形态:

```
codex exec --sandbox read-only --skip-git-repo-check "<prompt>"
```

`--skip-git-repo-check` 是本次 spike 专门加的(测试目录不是 git repo);生产环境的 adapter
跑在真实 repo 里,应该用不上。`codex-client.mjs` 本身不会加 `--json`(它把 codex 的整段输出
当成一个不透明的"answer"字符串,靠的是**执行前后拍的文件/git hash 快照**来间接校验"有没有东西被动过",
而不是解析 codex 自己吐出的 tool-call 记录——这是本次 spike 的一个重要发现,见下文 §3)。

### 1.2 默认(纯文本)模式 —— 有 tool trace,但非结构化

命令:
```
codex exec --sandbox read-only --skip-git-repo-check \
  "List the files in the current directory, then read the contents of fileA.txt and tell me what it says."
```

真实输出(stdout+stderr 合并,节选;完整文本见 spike 执行记录):
```
OpenAI Codex v0.144.1
--------
workdir: .../spike-testdir
model: gpt-5.6-sol
...
codex
I'll inspect the current directory and read `fileA.txt`.
exec
/bin/zsh -lc "pwd && rg --files -g '*' -0 | xargs -0 -n1 printf '%s\\n' && sed -n '1,240p' fileA.txt" in .../spike-testdir
 succeeded in 0ms:
.../spike-testdir
fileA.txt
fileB.txt
hello world spike file A

codex
Files in the current directory:
- `fileA.txt`
- `fileB.txt`
`fileA.txt` says: "hello world spike file A"
tokens used
14,042
```

**结论**:纯文本模式**确实**会打印实际执行的 shell 命令(`exec` 块 + 完整命令行 +
`succeeded in Xms:` + 命令输出),tool trace 客观存在且可见。但这是给人看的自由格式文本
(段落顺序、措辞可能随版本变化);要机器可靠解析就得写脆弱的正则——不建议作为
`ToolExecVerifier` 的主要证据来源。

### 1.3 `--json` 模式 —— 结构化 JSONL,推荐

命令:
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>"
```

**stdout 是纯逐行 JSON**("Reading additional input from stdin..."这类噪声、
`rmcp::transport::worker` MCP 鉴权错误全部走 **stderr**,分离已确认——见 §1.5),
真实样本:

```json
{"type":"thread.started","thread_id":"019f7eec-21a0-7773-97a0-d856c70ba65f"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll inspect the current directory and read `fileB.txt`."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"pwd && rg --files -g '*' -0 | sort -z | xargs -0 -n1 printf '%s\\\\n' && sed -n '1,240p' fileB.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"...\"","aggregated_output":".../spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file B\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Files in the current directory:\n\n- `fileA.txt`\n- `fileB.txt`\n\n`fileB.txt` says: \"hello world spike file B\""}}
{"type":"turn.completed","usage":{"input_tokens":34509,"cached_input_tokens":26112,"output_tokens":189,"reasoning_output_tokens":0}}
```

**可提取字段**(逐行 `JSON.parse`):
- `item.type === "command_execution"` → **这就是 tool trace**:`command`(实际跑的 shell
  命令字符串)、`exit_code`、`status`(`in_progress`/`completed`)、`aggregated_output`
  (命令的实际输出)。`item.started` 和 `item.completed` 成对出现(靠 `id` 配对),
  只有 `completed` 事件带 `exit_code`。
- `item.type === "agent_message"` → 模型的文本发言(可能出现多次;最后一条
  `agent_message` 一般就是最终答案,和 `turn.completed` 之前最后一个 `item.completed` 对齐)。
- `turn.completed.usage` → token 用量。

**无工具调用对照组**(prompt: "Just say hello, do not use any tools."):
```json
{"type":"thread.started","thread_id":"019f7eec-7614-7af1-926f-0913fc9f6c86"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello!"}}
{"type":"turn.completed","usage":{"input_tokens":17125,"cached_input_tokens":9984,"output_tokens":6,"reasoning_output_tokens":0}}
```
已确认:**没有工具调用时,事件流里完全不会出现任何 `command_execution` 类型的
item**——"有没有 `command_execution` item"本身就是一个干净的存在性信号,不需要额外推断。

### 1.4 同时拿到结构化输出 + tool trace(`--output-schema`)

这是最贴近 `ToolExecVerifier` 真实使用场景的测试:要求模型按 schema 吐出结构化 JSON
(其中一个字段自报 `tools_used`),同时用 `--json` 抓事件流,对比"模型声称的"和
"事件流实际记录到的调用"。

命令(⚠️ 踩到一个坑,见 §1.6):
```
codex exec --json --sandbox read-only --skip-git-repo-check \
  --output-schema schema.json \
  "List the files in the current directory and read fileA.txt. Respond with a JSON object \
   matching the schema: summary of what you found, and tools_used listing which tool types \
   you invoked (e.g. shell)." < /dev/null
```

真实输出(节选,完整是 6 行 JSONL):
```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"summary\":\"I'll inspect the current directory and read fileA.txt, then return only the requested JSON fields.\",\"tools_used\":[]}"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"pwd && rg --files -g '*' && sed -n '1,200p' fileA.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"...\"","aggregated_output":".../spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file A\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\"summary\":\"The current directory contains fileA.txt and fileB.txt. fileA.txt contains: \\\"hello world spike file A\\\".\",\"tools_used\":[\"shell\"]}"}}
```

**这段证据非常关键,直接影响 `ToolExecVerifier` 的设计**:
- 模型在**真正执行工具之前**先吐出了一版草稿 `agent_message`(`item_0`),里面
  `tools_used:[]`——这是它对"打算做什么"的自我描述,不是最终答案。
- 只有在实际执行了 `command_execution`(`item_1`)之后,**最后一条** `agent_message`
  (`item_2`,`turn.completed` 之前的最后一个 item)才成为权威的最终结构化输出,
  其中 `tools_used:["shell"]` 和 `item_1` 的真实执行**一致**。
- **推论**:`ToolExecVerifier` 不能随便抓"任意一条结构化输出声明"就当数——必须认定
  **最后一条** `agent_message`(即 `turn.completed` 之前的最后一个 item)才是**权威声明**,
  校验时要检查在这条声明**之前**是否发生过 `command_execution` 事件(是时间先后顺序,
  不是"文档里任意位置出现过就算")——否则像"先声称没用工具、后面又实际用了"这种中间态就会被误判。
  这其实正是"声明 ≠ 行为"检测真正要防的东西:模型完全可能在最终结构化输出里错报
  `tools_used`(多报、少报、报错工具),`ToolExecVerifier` 的价值恰恰在于拿
  `command_execution` 事件流去交叉核对,而不是听模型自己说。

### 1.5 stdout/stderr 分离验证

命令(显式分离,不用 `2>&1`):
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>" \
  > stdout.txt 2> stderr.txt
```
结果:**stdout 是纯 JSONL(可以逐行用 `JSON.parse` 解析,无污染)**;stderr 里有:
```
Reading additional input from stdin...
2026-07-20T09:47:13.498720Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(...resource_metadata="https://mcp.vercel.com/.well-known/oauth-protected-resource"...)
```
(这条 MCP 鉴权错误是这台机器本地 codex 配置里挂了个 Vercel MCP server 造成的噪声,和本次
spike 无关,但它确实证实了一件事:**adapter 必须把 stdout/stderr 分开采集,不能像
`codex-client.mjs` 那样合并**(`out + '\n' + err`)——合并会把非 JSON 噪声混进本该逐行
`JSON.parse` 的流里。这和 `codex-client.mjs` 目前在 `--json` 模式下的实现不一样,是 A3
需要新加的处理逻辑——不能照抄。)

### 1.6 踩到的坑

- **不显式关闭 stdin 会挂住**:第一次跑 `--output-schema` 测试时没加 `< /dev/null`,
  直接超时(120s 完全没输出,stderr 卡在"Reading additional input from stdin...")。
  加上 `< /dev/null` 立刻就好了(约 15s 跑完)。这印证了 `codex-client.mjs` 头部注释里
  安全不变量 ⑥ 记录的坑(必须立刻调用 `child.stdin.end()`)——**本次 spike 单纯用命令行测试
  也独立踩到了完全一样的坑,这是可复现的真实问题,不是巧合**。
- `--skip-git-repo-check` 只是因为测试目录不是 git repo 才需要;生产环境的 adapter 跑在
  真实 repo 里,应该不需要。

### 1.7 最终文本输出 / 成功判定

- **拿最终文本**:`-o/--output-last-message <FILE>` 会把最后一条消息直接写进文件;
  真实样本(prompt "Just say hello, do not use any tools."):文件内容是 `Hello!`
  ——这是最干净的方式,不用再从 JSONL 里重新解析。也可以从 `--json` 流里最后一个
  `agent_message` 类型 item 的 `text` 字段拿(见 §1.4 的分析)。
- **判定非交互式成功/失败**:进程退出码(`0` 表示成功);`--json` 模式下也可以看
  `turn.completed` 事件有没有出现(出现就表示这一轮正常收尾)。
- **超时**:**没有内置 flag**(`codex exec --help` 和 `codex --help` 都没有 `--timeout`
  这类选项),adapter 必须自己 `spawn` + 墙钟 `setTimeout` + `SIGKILL`,直接照搬
  `codex-client.mjs` 的 `runCodexReview` 里已经验证过的模式(包括"立刻关闭 `stdin`"这部分,
  见 §1.6——本次 spike 独立复现了同一个坑)。
- **checkAvailability**:`codex --version` → 实测 `codex-cli 0.144.1`,退出码 `0`。建议照搬
  `codex-client.mjs` 的 `resolveCodexBinary`(手动复刻 PATH 查找拿到绝对路径,而不是让
  `spawn('codex',...)` 做隐式查找)+ 校验路径不会解析到不可信位置——`codex-client.mjs`
  已经踩过这个坑并写了修复;A3 应该直接复用/照搬这段逻辑,不用重新设计。

---

## 2. `claude` CLI 真实环境测试

### 2.1 `--output-format json`(单条结果)—— 没有 tool trace

命令:
```
claude -p "List the files in the current directory and read fileA.txt, tell me what it says." \
  --output-format json --allowedTools "Bash,Read" --permission-mode bypassPermissions < /dev/null
```

真实输出(单行 JSON,节选关键字段):
```json
{"type":"result","subtype":"success","is_error":false,"num_turns":3,
 "result":"The directory contains two files: `fileA.txt` and `fileB.txt`.\n\n`fileA.txt` says: **\"hello world spike file A\"**",
 "session_id":"da8c5f11-...","total_cost_usd":0.0976,
 "usage":{...},"permission_denials":[],"terminal_reason":"completed"}
```

**结论**:`--output-format json` 只给最终文本(`result` 字段)+ usage/cost 元数据 +
`num_turns`(提示发生了几轮,但**不会透露每轮具体做了什么**)+ `permission_denials`
(一个空数组,说明这个字段结构上确实存在、可以携带"哪些工具调用被拒绝"的信息,
但**这个模式下拿不到"到底实际调用了哪些工具"这个核心问题的答案**。**这个模式对
`ToolExecVerifier` 没用。**

### 2.2 `--output-format stream-json --verbose` —— 有完整 tool trace,推荐

命令(`--verbose` 是硬性要求,见 §2.4 的坑):
```
claude -p "List the files in the current directory and read fileB.txt, tell me what it says." \
  --output-format stream-json --verbose \
  --allowedTools "Bash,Read" --permission-mode bypassPermissions < /dev/null
```

真实输出(JSONL,共 17 行,节选关键行):
```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01TF9wjf6yW3W4RvcYoSMZSM","name":"Bash","input":{"command":"ls -la","description":"List files in current directory"},"caller":{"type":"direct"}}]},...}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01TF9wjf6yW3W4RvcYoSMZSM","type":"tool_result","content":"total 16\n...\nfileA.txt\nfileB.txt","is_error":false}]}},"tool_use_result":{"stdout":"...","stderr":"","interrupted":false,...}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01VWt8Hpo7EG7cuVatU3ZoaZ","name":"Read","input":{"file_path":".../fileB.txt"},"caller":{"type":"direct"}}]},...}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01VWt8Hpo7EG7cuVatU3ZoaZ","type":"tool_result","content":"1\thello world spike file B\n2\t"}]},"tool_use_result":{"type":"text","file":{"filePath":".../fileB.txt","content":"hello world spike file B\n",...}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`."}]},...}
{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`.",...}
```

**可提取字段**(逐行 `JSON.parse`):
- `type==="assistant"` 且 `message.content[].type==="tool_use"` → **这就是 tool trace**:
  `name`(工具名,比如 `Bash`/`Read`——**比 codex 的 `command_execution` 更细粒度**,
  能区分具体是哪个工具,而不只是"跑了个 shell 命令")、`input`(该工具具体的调用参数)、
  `id`(用来和结果配对)。
- `type==="user"` 且 `message.content[].type==="tool_result"` → 对应的结果,`tool_use_id`
  和上面的 `id` 配对,`is_error` 标记成功/失败,`content`/`tool_use_result` 携带实际输出。
- `type==="result"`(最后一行)→ 汇总:`result`(最终文本,和 `--output-format json` 的
  `result` 字段同源同格式)、`num_turns`、`permission_denials`、`total_cost_usd`。

比 codex 的 `command_execution`(只知道"跑了个 shell 命令")更细粒度:claude 的
`tool_use` 直接给出**工具名**(`Bash`/`Read`/`Edit`/...),对需要按工具类型/名称匹配
"声称调用了工具 X"的校验场景更友好。

### 2.3 无工具调用对照组 + 权限拒绝场景

- **明确要求"不许用工具"的 prompt**(用 `--disallowedTools Bash`,让模型自己发现这个工具
  不在可用列表里):实测结果是模型在最终文本里说"I don't have the Bash tool, I can use Glob instead,"
  **`permission_denials` 仍然是空数组**——说明 `--disallowedTools` 是在"工具定义阶段"
  就把该工具从模型可见的工具列表里去掉了;模型压根不会尝试调用它,也就不会产生
  "尝试了但被拒绝"的拒绝记录。**结论**:本次 spike 没能稳定复现触发 `permission_denials`
  字段的方法(试了 2-3 次没找到,标 `[?]`,留待后续),虽然这个字段结构上确实存在——如果
  `ToolExecVerifier` 想用它,需要进一步测试确认在什么条件下它会变成非空。

### 2.4 踩到的坑

- **`--output-format stream-json` 必须搭配 `--verbose`**:实测漏掉它会立刻报错失败(exit 1)——
  ```
  Error: When using --print, --output-format=stream-json requires --verbose
  ```
  这是 claude CLI 自己内置的硬校验,不是本次 spike 的配置问题;adapter 必须始终带上
  `--verbose`。
- **默认权限行为依赖环境,不能信**:在这台机器上,就算不带 `--allowedTools`/`--permission-mode`
  工具调用也能成功(因为这台机器的 `settings.json` 已经预授权了常见 Bash 命令),但这是
  **本机状态**,不是 CLI 可移植的默认行为——在一台干净的机器/CI 环境上,非交互模式下极大概率会
  卡住等权限批准(没有 TTY 能批准 = 挂死,逻辑上和 codex 的 stdin 阻塞问题属于同一类
  "非交互模式必须显式声明,不能依赖交互式 session 的默认值"的问题)。**adapter 必须显式传
  `--permission-mode bypassPermissions`(或等价的显式完整 `--allowedTools` 集合),不能依赖
  调用方环境凑巧有什么权限状态**——这是本次 spike 认为对 PRD 影响最大的一条建议。

### 2.5 最终文本输出 / 成功判定 / checkAvailability

- **拿最终文本**:两种模式都用 `result` 字段(`--output-format json` 的顶层 `result`;
  `stream-json` 的最后一行,`type:"result"` 那条的 `result` 字段),可以复用同一套解析逻辑。
- **判定成功/失败**:`type:"result"` 那一行的 `subtype`(`"success"` 与否)+ `is_error`
  布尔值 + 进程退出码。
- **超时**:和 codex 一样,**没有内置 flag**,adapter 必须自己实现墙钟超时
  (照搬 `codex-client.mjs` 的模式,包括显式 `stdin.end()`)。
- **checkAvailability**:`claude --version` → 实测 `2.1.215 (Claude Code)`,退出码 `0`。

---

## 3. `ToolExecVerifier` 证据来源建议(本次 spike 的核心交付物)

### 3.1 各 CLI 的证据来源

| | codex | claude |
|---|---|---|
| 需要的 flag | `--json` | `--output-format stream-json --verbose` |
| tool-trace 事件类型 | `item.type==="command_execution"` 的 `item.completed` | `assistant` 消息的 `content[].type==="tool_use"` + 对应 `user` 消息的 `tool_result` |
| 粒度 | 只知道"跑了个 shell 命令"(`command` 字段是完整 shell 命令行,分不出"底层具体是哪个工具"——codex 把 Read/List/Write 都表示成 shell 命令) | 精确到工具名(`Bash`/`Read`/`Edit`/...)+ 具体的 input 参数 |
| 没有工具调用时 | 事件流完全没有 `command_execution` item(通过真实对照组测试验证过) | 事件流完全没有 `tool_use` content block(没单独测过,但结构上道理相同,`[?]`——没跑专门的对照组) |
| 执行结果可见性 | `aggregated_output` + `exit_code` | `tool_result.content` + `is_error` |

**两个 CLI 都能产出可解析的 tool trace,没有出现"某个 CLI 压根给不了"的情况**——
DESIGN §8 里点名的最坏分支,"如果某个 CLI 经真实测试证明确实做不到产出可解析 tool trace"
**没有发生**——`ToolExecVerifier` 在两个 adapter 上都有真实可用的证据来源。

### 3.2 推荐的 v1 校验粒度

**建议:「声称的工具类型 ⊆ 实际调用记录里出现的工具类型」的存在性/子集匹配**,
而不是逐字段深度匹配(不比较具体命令文本/参数是否和声称的完全一致)。理由:

1. **codex 的粒度上限就是"跑没跑 shell",做不到"具体调用了哪个逻辑工具"这个精度**——
   如果校验标准定得比 codex 实际能提供的证据更细(比如要求"声明里的工具名必须和 codex
   trace 里某个具体字段逐字匹配"),codex 这边的 adapter 天生就做不到,人为造成两个 CLI
   的校验基线不一致。子集/存在性匹配是两个 CLI 都能满足的最大公约数。
2. **时间先后顺序是硬性要求**(见 §1.4 的分析)——校验不能只看"整个事件流里,声明的前后
   任意位置有没有出现过某种工具调用";必须确认 `command_execution`/`tool_use` 事件发生在
   最终结构化声明(最后一条 `agent_message` / 最后一条 assistant 消息)**之前**——这正是
   为了防住 §1.4 里实际观察到的中间态,"模型先说没用工具、后面又实际用了",被误判成
   "真的没用"。
3. **v1 不建议做"参数级"匹配**(比如声称"读了 fileA.txt",然后去检查
   `tool_use.input.file_path` 或 `command_execution.command` 字符串里是不是真的包含
   `fileA.txt`)——这个粒度理论上两个 CLI 都支持(claude 的 `input.file_path` 很干净;
   codex 得从 shell 命令行字符串里正则抠出来,脆弱),但值不值得在 v1 做,值得军师/指挥官
   进一步权衡——做了能抓到更细粒度的幻觉,比如"声称读了 X 但实际读了 Y";不做的话 v1
   只能抓住"声称用了工具但压根没调用任何工具"这种粗粒度的幻觉。本次 spike 的立场:
   **v1 应该先上存在性/子集匹配,参数级匹配留作 v2 的增强**——好处是两个 adapter 的
   `toolTrace()` 实现能保持大致相当的复杂度,v1 也不会因为 claude 这边数据碰巧更干净,
   就忍不住围着它更丰富、更干净的字段过度设计 verifier 逻辑,那样会逼得 codex 这边的实现
   要么力不从心,要么单独分支处理。

### 3.3 `InvokeResult.toolExecChecked` 的映射建议

`src/harness/types.ts` 已经定义了 `toolExecChecked?: "pass" | "fail" | "na"`。建议:
- `"na"`:给 `kind === "direct-api"` 的 adapter(litellm)——A2 目前的状态,没有 trace 可校验。
- `"pass"`:给 `kind === "cli-bridge"` 且声明的工具 ⊆ trace 里在时间上先出现的工具类型集合的情况。
- `"fail"`:给 `kind === "cli-bridge"` 且声称调用了某工具,但 trace 里在这条声明产出之前
  完全没有该类型工具的调用记录的情况(即"声明 ≠ 行为")。
- **建议 `ToolCallRecord`(目前在 `types.ts` 里是占位的 `{[key:string]:unknown}`)至少统一
  这几个跨 CLI 通用字段**:`toolName`(codex 这边固定填 `"shell"`,claude 这边填真实的
  `tool_use.name`)、`raw`(原始的 item/tool_use 对象,留作调试兜底)、`sequenceIndex`
  (在事件流顺序里的位置,用于"时间先后"判断)。具体 schema 留到 PRD/build 阶段再定,
  这里只是方向性建议。

---

## 4. 哪些能从 `codex-client.mjs` 照搬,哪些不能

**可以直接照搬(A3 应该复用这套已经验证过的模式,不用再踩一遍坑)**:
- 墙钟超时:`spawn` + `setTimeout` + `SIGKILL`,并且必须**立刻调用 `child.stdin.end()`**
  (codex 在非 TTY stdin 下会阻塞——本次 spike 在纯命令行测试里独立复现了完全一样的坑,§1.6)。
- `resolveCodexBinary`(手动复刻 PATH 查找拿到绝对路径,而不是让 `spawn` 对裸字符串做隐式
  查找)+ 不可信位置校验——这是和 tool trace 无关的安全加固措施,但 A3 的 `CodexCliAdapter`
  没理由重新发明它——直接复用/照搬就行。
- `extractCliVersion`/`extractModel` 背后的正则提取方式(codex 纯文本 header 块的格式没变;
  本次 spike 实测到的 `model: gpt-5.6-sol`/`OpenAI Codex v0.144.1` 这几行,格式和
  `codex-client.mjs` 现有正则已经假设的格式一致)。

**不能照搬 / A3 需要新加的部分(`codex-client.mjs` 没做的事,因为它的用例不需要)**:
- **`codex-client.mjs` 完全不解析 `--json` 事件流**——它甚至都没加 `--json` flag——
  它把 codex 的整段纯文本输出当成一个不透明字符串,靠的是"带外"的方式:**执行前后对
  git HEAD + 被跟踪文件内容做哈希快照**,来间接校验"有没有未授权的改动"。这是专门针对
  review-only 用例的设计(见该文件头部注释,安全不变量 ③),和 A3 需要做的"解析 tool trace、
  交叉核对声称与实际调用"完全是两码事——**这段逻辑不能照抄**,`ToolExecVerifier` 得从零
  自己写一个 JSONL parser。
- `codex-client.mjs` 把 stdout+stderr **合并**处理(`out + '\n' + err`)——A3 必须**分开**
  采集(§1.5 已经确认:`--json` 模式下,stderr 噪声混进 stdout 会污染 JSONL 解析)。
- claude 这边完全没有可参照的东西(`codex-client.mjs` 只服务 codex);`ClaudeCliAdapter`
  用的 `--allowedTools`/`--permission-mode bypassPermissions`/`--verbose` 这套组合是本次 spike
  新验证出来的——PRD 需要明确写清楚这些是硬编码的强制默认值,不是可选参数(§2.4)。

---

## 5. 留给 PRD / 军师裁定的开放问题

1. **v1 要不要做参数级匹配**(§3.2 第 3 点)——建议不做,留给 v2,但这是产品判断,不是
   技术判断——在此标记出来交给军师/指挥官裁定。
2. **`permission_denials` 字段的触发条件没能通过测试复现出来**(§2.3)——如果 PRD 想用
   这个字段作为"某个工具调用被拒绝"的信号,需要专门再花时间测试;本次 spike 没有预算
   把它彻底搞清楚,标 `[?]`。
3. **claude 这边"无工具调用"的对照组没有单独跑过**(§3.1 表格脚注)——结构上应该和 codex
   同样的道理(没有 `tool_use` block),但没有像 codex 那样用专门的"不许用工具"prompt
   去验证过——如果 PRD 认为这个边界重要,建议在 build 阶段第一批就加一个单元测试/集成测试
   把它锁死,不要假设。
4. **【写 PRD 阶段补测,新发现】codex `--json` 的 JSONL 事件流里完全没有 `model` 字段**——
   写 PRD 时,针对本次 spike 已经抓到的所有 `--json` 样本(`codex-json-stdout.txt`/
   `codex-schema-stdout.txt`)用 `grep -o '"model"'` 重新核了一遍,零匹配。§1.3/§1.7 原文
   只验证了纯文本模式可以从 banner 里正则提取 `model`(`model: gpt-5.6-sol` 那一行),没有
   专门检查 `--json` 模式是否也带这个字段——这是本次 spike 原本的一个疏漏,不是新跑的命令,
   只是对已抓到的样本重新审了一遍。结论:`--json` 模式不提供 model 信息;PRD
   (`docs/feature/a3-cli-bridge/PRD.md` §5/§9.3)已经定好了对策——`CodexCliAdapter`
   硬编码 `model: "unknown"`(照搬 `codex-client.mjs` 自己现有的 `buildAttestation`
   回退惯例),这不违反 `InvokeResult` "provider/model 必须是非空字符串" 的硬性约束——
   只是如实承认拿不到具体的版本字符串。
