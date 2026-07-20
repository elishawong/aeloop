# A3 CLI-Bridge 前置 Spike — 实测发现(issue #10)

> **投石问路,不写 adapter 代码。** 目标:用真实命令输出回答「`ToolExecVerifier`
> 到底能不能核实工具调用」,给 PRD 提供证据而非假设。
>
> 实测环境:`codex-cli 0.144.1`(`/opt/homebrew/bin/codex`)、`claude 2.1.215 (Claude Code)`
> (`~/.nvm/.../bin/claude`),macOS,测试目录
> `/private/tmp/.../scratchpad/spike-testdir`(内含 `fileA.txt`/`fileB.txt`,各一行文本)。
> 所有命令都是本次会话里真跑的,输出样本原文粘贴(未编造/未回忆)。

## 一句话结论(先行)

- **两个 CLI 都能给出可解析的 tool trace**——但要用对 flag:codex 要加 `--json`,
  claude 要用 `--output-format stream-json --verbose`。默认/其它 flag 组合下
  tool trace 要么不结构化(codex 纯文本)要么完全拿不到(claude `--output-format json`)。
- **推荐 v1 核实粒度:「声称的工具 ⊆ 实际调用的工具」存在性/子集匹配**,不是逐字段深度匹配
  command 内容——理由见下文「ToolExecVerifier 证据源推荐」。
- **两个 CLI 都没有内置超时 flag**,`ToolExecVerifier`/adapter 必须自己实现墙钟超时
  (`spawn` + `setTimeout` + `SIGKILL`),这部分可直接镜像 `codex-client.mjs` 已验证过的模式。

---

## 1. codex exec 实测

### 1.1 命令行形态

参照 `scripts/openai/codex-client.mjs`(`buildExecArgs`),基础形态:

```
codex exec --sandbox read-only --skip-git-repo-check "<prompt>"
```

`--skip-git-repo-check` 是本 spike 加的(测试目录不是 git 仓库),生产 adapter 跑在真实仓库里
应该不需要。`codex-client.mjs` 本身不加 `--json`(它把 codex 整段输出当不透明的 "answer" 文本,
靠**执行前后 git/文件 hash 快照**间接核实"有没有动东西",而不是解析 codex 自己吐出的工具调用
记录——这是本 spike 的一个重要发现,见下文§3)。

### 1.2 默认(纯文本)模式 — 有 tool trace,但非结构化

命令:
```
codex exec --sandbox read-only --skip-git-repo-check \
  "List the files in the current directory, then read the contents of fileA.txt and tell me what it says."
```

真实输出(stdout+stderr 混流,节选,完整见 spike 执行记录):
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

**结论**:纯文本模式**确实**打印了实际执行的 shell 命令(`exec` 段 + 完整命令行 + `succeeded in
Xms:` + 命令输出),tool trace 客观存在、可见。但这是给人看的自由格式文本(段落顺序、措辞可能随
版本变化),要做机器可靠解析得写脆弱的正则,不推荐作为 `ToolExecVerifier` 的主证据源。

### 1.3 `--json` 模式 — 结构化 JSONL,推荐用这个

命令:
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>"
```

**stdout 是纯净的逐行 JSON**(noise 如 "Reading additional input from stdin..."、
`rmcp::transport::worker` MCP 鉴权报错都在 **stderr**,分流验证过,见 §1.5),真实样本:

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
- `item.type === "command_execution"` → **这就是 tool trace**:`command`(实际跑的 shell 命令
  字符串)、`exit_code`、`status`(`in_progress`/`completed`)、`aggregated_output`(命令实际输出)。
  `item.started` 和 `item.completed` 成对出现(同 `id`),`completed` 事件才有 `exit_code`。
- `item.type === "agent_message"` → 模型的文本发言(可能出现多次;最后一条 `agent_message`
  一般就是最终回答,和 `turn.completed` 前最后一个 `item.completed` 对齐)。
- `turn.completed.usage` → token 用量。

**无工具调用的对照组**(prompt: "Just say hello, do not use any tools."):
```json
{"type":"thread.started","thread_id":"019f7eec-7614-7af1-926f-0913fc9f6c86"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello!"}}
{"type":"turn.completed","usage":{"input_tokens":17125,"cached_input_tokens":9984,"output_tokens":6,"reasoning_output_tokens":0}}
```
确认:**没有工具调用时,事件流里完全不出现 `command_execution` 类型的 item**——"有没有
`command_execution` item"本身就是一个干净的存在性信号,不需要额外推断。

### 1.4 结构化输出 + tool trace 同时拿到(`--output-schema`)

这是最贴近 `ToolExecVerifier` 真实使用场景的测试:要求模型按 schema 吐结构化 JSON(其中一个
字段自称 `tools_used`),同时用 `--json` 拿事件流,对比"模型自称"和"事件流记录的真实调用"。

命令(⚠️ 踩坑见 §1.6):
```
codex exec --json --sandbox read-only --skip-git-repo-check \
  --output-schema schema.json \
  "List the files in the current directory and read fileA.txt. Respond with a JSON object \
   matching the schema: summary of what you found, and tools_used listing which tool types \
   you invoked (e.g. shell)." < /dev/null
```

真实输出(节选,完整 6 行 JSONL):
```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"summary\":\"I'll inspect the current directory and read fileA.txt, then return only the requested JSON fields.\",\"tools_used\":[]}"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"pwd && rg --files -g '*' && sed -n '1,200p' fileA.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"...\"","aggregated_output":".../spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file A\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\"summary\":\"The current directory contains fileA.txt and fileB.txt. fileA.txt contains: \\\"hello world spike file A\\\".\",\"tools_used\":[\"shell\"]}"}}
```

**这条证据非常关键,直接影响 ToolExecVerifier 设计**:
- 模型在**执行工具之前**先吐了一版 `agent_message`(`item_0`),里面 `tools_used:[]`——这是
  它计划要做的事的自述,不是最终答案。
- 真正执行 `command_execution`(`item_1`)之后,**最后一条** `agent_message`(`item_2`,
  `turn.completed` 前的最后一个 item)才是权威最终结构化输出,`tools_used:["shell"]` 与
  `item_1` 的真实执行**吻合**。
- **推论**:`ToolExecVerifier` 不能只抓"任意一条声称结构化输出",必须认定**最后一个
  `agent_message`(即 `turn.completed` 前最后一个 item)才是权威声明**,且核实时要看这条声明
  **之前**出现过的 `command_execution` 事件(时序前置,不是"文档任意位置出现过就算数")——
  否则"先说没用工具、后面才真正用"这种中间态会被误判。这也是"声称≠行为"检测真正要防的
  case:模型完全有可能在最终结构化输出里谎报 `tools_used`(多报/漏报/张冠李戴),
  `ToolExecVerifier` 的价值就是拿 `command_execution` 事件流去对账,不采信模型自己的话。

### 1.5 stdout/stderr 分流验证

命令(显式分流,不用 `2>&1`):
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>" \
  > stdout.txt 2> stderr.txt
```
结果:**stdout 是纯净 JSONL(逐行可 `JSON.parse`,无杂质)**;stderr 里是:
```
Reading additional input from stdin...
2026-07-20T09:47:13.498720Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(...resource_metadata="https://mcp.vercel.com/.well-known/oauth-protected-resource"...)
```
（这条 MCP 鉴权报错是本机 codex 配置里挂了 Vercel MCP server 导致的噪音,和本 spike 无关,
但确认了一件事:**adapter 必须分开收集 stdout/stderr,不能像 `codex-client.mjs` 那样
`out + '\n' + err` 合并后再解析**——合并会把非 JSON 噪音混进本该逐行 `JSON.parse` 的流,
`--json` 模式下这点和 `codex-client.mjs` 现有实现不同,是 A3 要新增的处理逻辑,不能照抄。)

### 1.6 踩到的坑

- **stdin 不显式关闭会挂起**:第一次跑 `--output-schema` 测试时,不加 `< /dev/null`
  直接超时(120s 无任何输出,stderr 只停在 `Reading additional input from stdin...`)。
  加 `< /dev/null` 后立即恢复正常(~15s 内完成)。这印证了 `codex-client.mjs` 头注释里
  安全不变量⑥记录的坑(`child.stdin.end()` 必须立刻调),**本 spike 的命令行测试也踩了一遍
  同样的坑,是可复现的真问题,不是巧合**。
- `--skip-git-repo-check` 只是测试目录不是 git repo 时需要,生产 adapter 应该跑在真实仓库里,
  不必加。

### 1.7 最终文本输出 / 成功判定

- **拿最终文本**:`-o/--output-last-message <FILE>` 直接把最后一条消息写入文件,
  实测样本(prompt "Just say hello, do not use any tools."):文件内容为 `Hello!`
  ——这是最干净的方式,不需要从 JSONL 里再解析一次。也可以从 `--json` 流里取最后一个
  `agent_message` 类型 item 的 `text` 字段(见 §1.4 分析)。
- **判非交互成功/失败**:进程 exit code(`0` 成功);`--json` 模式下还能看
  `turn.completed` 事件是否出现(出现即本轮正常收尾)。
- **超时**:**无内置 flag**(`codex exec --help`/`codex --help` 均无 `--timeout` 类选项),
  必须 adapter 自己 `spawn` + 墙钟 `setTimeout` + `SIGKILL`,直接镜像
  `codex-client.mjs` 的 `runCodexReview` 里已验证过的模式(含"立刻 `stdin.end()`"这条,
  见 §1.6 本 spike 独立复现的同一个坑)。
- **checkAvailability**:`codex --version` → 实测 `codex-cli 0.144.1`,exit code `0`。
  推荐镜像 `codex-client.mjs` 的 `resolveCodexBinary`(手动复刻 PATH 查找拿绝对路径,
  而不是让 `spawn('codex',...)` 隐式查找)+ 校验路径不落在不可信位置——这条`codex-client.mjs`
  已经踩过坑、写好了,A3 应直接复用/镜像这部分逻辑,不必重新设计。

---

## 2. claude CLI 实测

### 2.1 `--output-format json`(单结果)— 没有 tool trace

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

**结论**:`--output-format json` 只给最终文本(`result` 字段)+ 用量/成本元数据 +
`num_turns`(暗示发生了几轮,但**不透露每轮做了什么**)+ `permission_denials`(空数组,
说明这个字段结构上存在、可以承载"被拒绝的工具调用"信息,但**这个模式下拿不到"实际调用了
哪些工具"这个核心问题的答案**)。**这个模式对 `ToolExecVerifier` 没用。**

### 2.2 `--output-format stream-json --verbose` — 有完整 tool trace,推荐用这个

命令(`--verbose` 是硬性要求,见 §2.4 踩坑):
```
claude -p "List the files in the current directory and read fileB.txt, tell me what it says." \
  --output-format stream-json --verbose \
  --allowedTools "Bash,Read" --permission-mode bypassPermissions < /dev/null
```

真实输出(JSONL,17 行,关键行节选):
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
  `name`(工具名,如 `Bash`/`Read`——**比 codex 的 `command_execution` 更细粒度**,能区分
  具体工具而不只是"跑了 shell")、`input`(该工具的具体调用参数)、`id`(用于配对结果)。
- `type==="user"` 且 `message.content[].type==="tool_result"` → 对应结果,`tool_use_id`
  和上面的 `id` 配对,`is_error` 标成功/失败,`content`/`tool_use_result` 里有实际输出。
- `type==="result"`(最后一行)→ 汇总:`result`(最终文本,和 `--output-format json`
  的 `result` 字段同源同格式)、`num_turns`、`permission_denials`、`total_cost_usd`。

比 codex 的 `command_execution`(只知道"跑了 shell 命令")更进一步:claude 的 `tool_use`
直接给**工具名**(`Bash`/`Read`/`Edit`/...),对"声称调用了工具 X"这种按工具类型/名字做
匹配的核实场景更友好。

### 2.3 无工具调用对照组 + 权限拒绝场景

- **prompt 明确要求"不许用工具"**(用 `--disallowedTools Bash`,让模型自己发现工具不在
  可用列表里):实测模型自己在最终文本里说"我没有 Bash 工具,可以用 Glob 代替",
  **`permission_denials` 仍是空数组**——说明 `--disallowedTools` 是在"工具定义阶段"就把
  该工具从模型可见的工具列表里拿掉,模型压根不会尝试调用,不会产生"尝试了但被拒绝"的
  denial 记录。**结论**:`permission_denials` 这个字段的触发条件本次 spike 未能实测复现
  (未在 2-3 次内找到能稳定触发它的手段,标 `[?]`,留给后续),但字段结构上存在,
  `ToolExecVerifier` 如果要用它,需要额外验证它在什么条件下才会非空。

### 2.4 踩到的坑

- **`--output-format stream-json` 必须加 `--verbose`**:实测不加会直接报错退出(exit 1)——
  ```
  Error: When using --print, --output-format=stream-json requires --verbose
  ```
  这是 claude CLI 自己的硬校验,不是本 spike 的配置问题,adapter 必须固定带上 `--verbose`。
- **默认权限行为环境依赖,不可信任**:本机不加 `--allowedTools`/`--permission-mode` 也能
  成功跑通工具调用(因为本机 `settings.json` 已经预授权了常见 Bash 命令),但这是**本机
  环境状态**,不是 CLI 的可移植默认行为——换一台干净机器/CI 环境很可能会在非交互模式下
  卡住等权限批准(拿不到 TTY 批准 = 挂起,踩坑逻辑上和 codex 的 stdin 阻塞是同一类"非交互
  模式必须显式声明,不能依赖交互期默认值"问题)。**adapter 必须显式传
  `--permission-mode bypassPermissions`(或等价的显式 `--allowedTools` 全集),不能依赖
  调用环境已有的权限状态**,这是本 spike 认为对 PRD 影响最大的一条建议。

### 2.5 最终文本输出 / 成功判定 / checkAvailability

- **拿最终文本**:两种模式下都是 `result` 字段(`--output-format json` 的顶层 `result`;
  `stream-json` 最后一行 `type:"result"` 的 `result` 字段),同一套解析逻辑可以复用。
- **判成功/失败**:`type:"result"` 行的 `subtype`(`"success"` vs 其它)+ `is_error`
  布尔 + 进程 exit code。
- **超时**:同 codex,**无内置 flag**,必须 adapter 自己实现墙钟超时(镜像
  `codex-client.mjs` 模式,含显式 `stdin.end()`)。
- **checkAvailability**:`claude --version` → 实测 `2.1.215 (Claude Code)`,exit code `0`。

---

## 3. ToolExecVerifier 证据源推荐(本 spike 核心产出)

### 3.1 两个 CLI 各自的证据源

| | codex | claude |
|---|---|---|
| 需要的 flag | `--json` | `--output-format stream-json --verbose` |
| tool trace 事件类型 | `item.completed` where `item.type==="command_execution"` | `assistant` msg 里 `content[].type==="tool_use"` + 对应 `user` msg 里 `tool_result` |
| 粒度 | 只知道"跑了一条 shell 命令"(`command` 字段是完整 shell 命令行,不区分"底层工具"——codex 把 Read/List/Write 都表现为 shell 命令) | 精确到工具名(`Bash`/`Read`/`Edit`/...)+ 具体 input 参数 |
| 无工具调用时 | 事件流里完全没有 `command_execution` item(实测对照组验证过) | 事件流里完全没有 `tool_use` content block(未逐一实测但结构上同理,`[?]` 未单独跑对照组) |
| 执行结果可见性 | `aggregated_output` + `exit_code` | `tool_result.content` + `is_error` |

**两个 CLI 都能给出可解析的 tool trace,没有出现"某个 CLI 根本给不出"的情况**——DESIGN §8
点名的"如果某个 CLI 实测下来根本给不出可解析的 tool trace"这个最坏分支**没有发生**,
`ToolExecVerifier` 在两个 adapter 上都有真实可用的证据源。

### 3.2 推荐 v1 核实粒度

**推荐:「声称的工具类型 ⊆ 实际调用记录中出现过的工具类型」存在性/子集匹配**,不做
逐字段深度匹配(不比对 command 具体文本/具体参数是否和声称完全一致)。理由:

1. **codex 的粒度上限就是"跑没跑 shell",到不了"具体调用了哪个逻辑工具"**——如果核实标准
   定得比 codex 能提供的证据更细(比如要求"claim 里的 tool 名字必须和 codex trace 里的某个
   具体字段逐字匹配"),codex adapter 天生做不到,会把两个 CLI 的核实基线人为拉不一致。
   子集/存在性匹配是两个 CLI 共同能满足的最大公约数。
2. **时序前置是必须的**(见 §1.4 分析):核实不能只看"claim 出现前后整个事件流里有没有
   出现过某类工具调用",必须确认 `command_execution`/`tool_use` 事件发生在**最终结构化
   声明(最后一个 `agent_message` / 最后一个 assistant 消息)之前**——防的正是 §1.4 里
   实测到的"模型先说没用工具、后面才真正用"这种中间态被误判为"真的没用"。
3. **v1 不建议做"参数级"匹配**(比如声称"读了 fileA.txt"要去比对 `tool_use.input.file_path`
   或 `command_execution.command` 字符串里是否真的出现 `fileA.txt`)——这个粒度理论上两个
   CLI 都能支持(claude 的 `input.file_path` 很干净;codex 得从 shell 命令行字符串里正则
   摘,脆弱),但值不值得在 v1 做值得军师/指挥官再权衡:做了能抓"声称读了 X 但实际读的是 Y"
   这类更精细的幻觉,不做的话 v1 只能抓"声称用了工具但压根没调用任何工具"这类更粗的幻觉。
   本 spike 的立场:**v1 先上存在性/子集匹配,参数级匹配留作 v2 增强项**,好处是两个
   adapter 的 `toolTrace()` 实现复杂度大致对齐,不会因为 claude 数据更干净就诱使 v1 把
   verifier 逻辑往 claude-only 的丰富字段上过度设计,导致 codex 侧实现被迫打折扣或另开分支。

### 3.3 对 `InvokeResult.toolExecChecked` 的映射建议

`src/harness/types.ts` 已定义 `toolExecChecked?: "pass" | "fail" | "na"`。建议:
- `"na"`:`kind === "direct-api"` 的 adapter(litellm)—— A2 现状,没有 trace 可核。
- `"pass"`:`kind === "cli-bridge"` 且 declared tool ⊆ trace 里时序前置出现过的工具类型集合。
- `"fail"`:`kind === "cli-bridge"` 且声称调用了某工具,但 trace 里在声明产生前从未出现
  该类工具的调用记录(即"声称≠行为")。
- **`ToolCallRecord`(目前是 `types.ts` 里的占位 `{[key:string]:unknown}`)建议至少统一
  出这几个跨 CLI 通用字段**:`toolName`(codex 侧固定填 `"shell"`,claude 侧填实际
  `tool_use.name`)、`raw`(原始 item/tool_use 对象,保底调试用)、`sequenceIndex`
  (在事件流里的顺序位置,供"时序前置"判断用)。具体 schema 留给 PRD/写码阶段定,
  这里只给方向性建议。

---

## 4. 对 `codex-client.mjs` 可镜像 / 不可镜像清单

**可直接镜像(A3 应该复用同一套已验证模式,不必重新踩坑)**:
- 墙钟超时:`spawn` + `setTimeout` + `SIGKILL`,且必须**立刻 `child.stdin.end()`**
  (codex 非 TTY stdin 下会阻塞——本 spike 在纯命令行测试里独立复现了同一个坑,§1.6)。
- `resolveCodexBinary`(手动复刻 PATH 查找拿绝对路径,不让 `spawn` 用裸字符串隐式查找)+
  不可信位置校验——这条是安全加固,和 tool trace 无关,但 A3 的 `CodexCliAdapter`
  没理由重新发明,直接复用/镜像即可。
- `extractCliVersion`/`extractModel` 的正则抽取思路(codex 纯文本 header 块格式没变,
  本 spike 实测输出里 `model: gpt-5.6-sol`/`OpenAI Codex v0.144.1` 这两行的格式和
  `codex-client.mjs` 现有正则假设的格式一致)。

**不可镜像 / A3 需要新增的部分(codex-client.mjs 没做,因为它的场景不需要)**:
- **codex-client.mjs 完全不解析 `--json` 事件流**,它甚至不加 `--json` flag——它把 codex
  整段纯文本输出当不透明字符串,靠**执行前后 git HEAD + tracked 文件内容 hash 快照**这种
  "旁路"方式间接核实"有没有产生未授权改动",这是 review-only 场景的特定设计
  (见该文件头注释安全不变量③),和 A3 要做的"解析 tool trace、核对声称 vs 实际调用"是
  完全不同的两件事,**不能照抄这部分逻辑**,`ToolExecVerifier` 得自己新写 JSONL 解析。
- `codex-client.mjs` 把 stdout+stderr **合并**处理(`out + '\n' + err`)——A3 必须**分开**
  收集(§1.5 已验证:`--json` 模式下 stderr 噪音混进 stdout 会污染 JSONL 解析)。
- claude 侧完全没有对应参照(`codex-client.mjs` 只服务 codex),`ClaudeCliAdapter` 的
  `--allowedTools`/`--permission-mode bypassPermissions`/`--verbose` 这几个参数组合是
  本 spike 新验证出来的,PRD 里要写清楚这是硬性默认值,不是可选项(§2.4)。

---

## 5. 给 PRD 的开放点 / 建议军师定夺

1. **参数级匹配要不要做 v1**(§3.2 第 3 点)——建议先不做,留 v2,但这是产品判断不是
   技术判断,标出来让军师/指挥官拍板。
2. **`permission_denials` 字段的触发条件未实测复现**(§2.3),如果 PRD 想用这个字段做
   "工具被拒绝"的信号,需要专门再花时间实测,本 spike 未在预算内打通,标 `[?]`。
3. **claude 侧"无工具调用"对照组未单独跑**(§3.1 表格备注)——结构上推断应该和 codex
   一样(没有 `tool_use` block),但没有像 codex 那样专门用一条"不许用工具"的 prompt 去
   验证,如果 PRD 认为这条边界很关键,建议 build 阶段第一批任务里补一个单测/集成测试锁定,
   不要假设。
4. **【PRD 写作阶段补测,追加发现】codex `--json` 的 JSONL 事件流里没有 `model` 字段**——
   写 PRD 时重新对本 spike 已捕获的所有 `--json` 样本(`codex-json-stdout.txt`/
   `codex-schema-stdout.txt`)做了 `grep -o '"model"'` 复核,零命中。§1.3/§1.7 原文只验证
   了纯文本模式能从 banner(`model: gpt-5.6-sol` 那一行)正则抽取 model,没有专门检查
   `--json` 模式是否也带这个字段——这是本 spike 原本的一处遗漏,不是新跑的命令,是对既有
   捕获样本的重新核对。结论:`--json` 模式下拿不到 model 信息,PRD(`docs/feature/
   a3-cli-bridge/PRD.md` §5/§9.3)已定对策——`CodexCliAdapter` 固定填 `model: "unknown"`
   (镜像 `codex-client.mjs` 自己 `buildAttestation` 的既有兜底惯例),不影响 `InvokeResult`
   "provider/model 必须非空字符串"这条硬约束,只是诚实地承认拿不到具体版本号。
