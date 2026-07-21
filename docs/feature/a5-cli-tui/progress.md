---
feature: a5-cli-tui
status: done
last_updated: 2026-07-21
---

# Progress — A5 CLI/TUI

> **▶ 下一步(RESUME 指针)**:B0-B11(B11 = Zorro R2 独立复审返工)已完成,419/419 测试绿,build/lint 干净。等 Zorro R3 独立复审 + 指挥官批准后 commit/push(未提交,Cypher 不自行 commit)。

- **关联 PRD**:`./PRD.md`
- **关联 issue**:[elishawong/aeloop#22](https://github.com/elishawong/aeloop/issues/22)
- **分支**:`feature/issue-22-a5-cli-tui`(基于 main `c8d0289`)

## 批次进度

### B0 — 依赖/错误类型 [S]
- 状态:完成
- 做了什么:`package.json` 加 `chalk@5.6.2`/`@inquirer/prompts@8.5.2` 依赖 + `bin.aeloop` 字段;`src/cli/errors.ts` 新增 `UnsupportedProfileError`/`RunNotResumableError` 两个类型化错误(镜像 `profile/errors.ts`/`loop/errors.ts` 既有惯例)。
- 改了哪些文件:`package.json`、`src/cli/errors.ts`(新)
- 本地自检:`pnpm lint` 干净。

### B1 — 着色/diff 渲染 [M]
- 状态:完成
- 做了什么:`colors.ts`(chalk 主题辅助函数 + `escalationBanner()`)+ `diff-render.ts`(best-effort 按行前缀上色,非 unified-diff 校验器)。两文件都用 `new Chalk({level:3})` 强制 truecolor,不用默认 TTY 自动探测(判断调用,已在代码/知识库注明原因)。
- 改了哪些文件:`src/cli/colors.ts`(新)、`src/cli/diff-render.ts`(新)、对应测试
- 本地自检:`pnpm test -- diff-render`(9/9)+ `pnpm test -- colors`(6/6)绿,断言真实 ANSI 转义序列存在。

### B2 — 门视图 [M]
- 状态:完成
- 做了什么:`gate-view.ts` 四个纯函数(`renderG1`/`renderG2`/`renderG3`/`renderEscalation`),Escalation 包进结构性区别的 banner。
- 改了哪些文件:`src/cli/gate-view.ts`(新)、`src/cli/__tests__/gate-view.test.ts`(新)
- 本地自检:8/8 测试绿,含 diffRef/issues 缺省场景、Escalation 与 G1 结构性区分断言。

### B3 — prompter 抽象 [M]
- 状态:完成
- 做了什么:`Prompter` 接口 + `InquirerPrompter`(委托真实 `@inquirer/prompts`)+ `FakePrompter`(三种应答独立 FIFO 队列,记录调用,耗尽抛 `FakePrompterExhaustedError`)。
- 改了哪些文件:`src/cli/prompter.ts`(新)、`src/cli/__tests__/prompter.test.ts`(新,`@inquirer/prompts` 用 `vi.mock` 验证委托参数)
- 本地自检:9/9 测试绿。

### B4 — `runner.ts` 新增 `getPendingInterrupt()` [S]
- 状态:完成
- 做了什么:`src/loop/runner.ts` 新增唯一一个新导出——只读重建暂停中 run 的当前门 payload,复用已有 `computeRunProgress()`,零新写入。
- 改了哪些文件:`src/loop/runner.ts`、`src/loop/__tests__/runner.test.ts`(新增 5 条测试)
- 本地自检:26/26(该文件全部)测试绿。**3 处独立变异自验**(改坏→测试转红→改回→复绿):① 去掉 `getRunById` 缺失 guard;② `thread_id` 传错值;③ `done` 硬编码 `true`。三处均被对应测试正确捕获。

### B5 — assemble.ts(真实依赖装配)[L]
- 状态:完成
- 做了什么:`assembleSubscriptionDeps()` 真实对象图装配(同 `loop.e2e.test.ts` 手搭那套收敛成一个函数);`resolveRejectThreshold()` 三层链。`AI_AGENT_PROFILE=apikey` 在 `loadProfile()` 之前就地拦截,不会先报 `ProfileNotFoundError`。**必要偏离 PRD 签名草图**(已文档化):`CliDeps` 多 `injector`/`memoryStore` 两个字段;新增可选 `profilesRoot` 参数。
- 改了哪些文件:`src/cli/assemble.ts`(新)、`src/cli/__tests__/assemble.test.ts`(新,用临时 `profilesRoot` 避免污染真实 `profiles/subscription/`)
- 本地自检:9/9 测试绿;手动确认测试跑完 `profiles/subscription/` 无新增 `.db` 文件(`git status --porcelain profiles/` 干净)。

### B6 — run-loop.ts(交互式编排器)[L]
- 状态:完成
- 做了什么:`runInteractiveLoop()` 共享 start/resume 循环——渲染当前门 → 按门形状问 `Prompter` → `resumeRun()`,循环结束读 `AuditStore` 打印真实终局摘要。G2 严格二选一(approved/escalate),不给第三个 rejected 选项。
- 改了哪些文件:`src/cli/run-loop.ts`(新)、`src/cli/__tests__/run-loop.test.ts`(新,真图 + Fake 适配器 + `FakePrompter`)
- 本地自检:8/8 测试绿。**4 处独立变异自验**:① G1/G3 决策硬编码 approved;② Escalation 决策硬编码 abandon;③ `renderGate()` 把 G1/G3 render 函数调换(**初次未被抓到**,补了断言真实 `[G1]`/`[G3]` 标签文本后重跑变异确认转红,如实记录这一处漏检+补强的过程)。

### B7 — main.ts + bin.ts(argv + dispatch)[M]
- 状态:完成
- 做了什么:`main.ts`(`node:util.parseArgs`,`start`/`resume`/`list` 三命令,统一错误处理打印 `Name: message` 从不带 stack,SIGINT handler 每次调用装/卸不累积监听器)+ `bin.ts`(两行 shebang 生产入口)。
- 改了哪些文件:`src/cli/main.ts`(新)、`src/cli/bin.ts`(新)、`src/cli/__tests__/main.test.ts`(新,mock 掉 `assemble.js`/`runner.js`/`run-loop.js` 专测 dispatch/错误处理/清理逻辑)
- 本地自检:12/12 测试绿;`pnpm build` 后手动烟测编译产物 `dist/cli/bin.js`——argv 错误路径干净打印+exit 1,`node dist/cli/bin.js list`(真实 subscription profile)打印 "No resumable runs." + exit 0;烟测产生的 `profiles/subscription/*.db` 已清理(gitignored)。

### B8 — 硬性垂直切片 e2e [L]
- 状态:完成
- 做了什么:`src/cli.e2e.test.ts` —— 真 `main()` dispatch + 真 subscription-profile 依赖图(临时 `profilesRoot`,真实 config.yaml/personas 忠实拷贝 + fixture `bin` 覆盖)+ 真 cli-bridge fixture 子进程 + 脚本化 `FakePrompter`。happy path(G1→G3→apply)+ escalation path(reject 到阈值→ESCALATION_ACK→force_pass→G3→apply)两条用例均跑到 `applied:true`,收尾读真实落盘 `workflow_runs`/`approvals` 核实。
- 改了哪些文件:`src/cli.e2e.test.ts`(新)
- 本地自检:2/2 测试绿(`pnpm test -- src/cli.e2e.test.ts --reporter=verbose` 人工核对过真实打印输出,含 escalation banner 的真实渲染效果)。

### B9 — 文档回写 [S]
- 状态:完成
- 做了什么:`docs/ROADMAP.md`(A5 行标 done,附批次摘要)、`docs/PROGRESS.md`(替换成 A5 当前批次)、`CHANGELOG.md`(新条目)、`README.md`(Status + Getting started 加 `aeloop start` 示例)、ai-agent 仓 `CHARTS/knowledge/aeloop.md`(顶部横幅更新为 A0-A4b已merged+A5本机分支;`startRun/resumeRun` 条目补 `getPendingInterrupt()`;新增 6 个 CLI 层模块条目)。
- 改了哪些文件:见上
- 本地自检:`node _engine/verify-knowledge.mjs aeloop`(ai-agent 仓)只报 `src/cli/*`/`src/cli.e2e.test.ts` 路径不存在——符合预期(这些文件在本机未提交分支,注册的 aeloop 仓库根检出的是另一分支,不是这个 worktree)。**发现并修复一处文档结构 bug**:CLI 层总览段落最初写成模块之间的浮动引用块,导致机械扫描器把它的反引号路径误抓进上一个模块(`runner.ts`)的「关键文件路径」——已改成放进 `colors.ts` 模块自己的第一条 bullet(`- **`开头),重跑扫描确认 leak 消失。

### B10 — Zorro 独立复审(含 Codex `gpt-5.6-sol` 二签)返工 [L]
- 状态:完成
- 触发:Zorro 独立复审(`docs/feature/a5-cli-tui/test-report.md`,真实执行非 fallback)判 FAIL,指挥官对两个 P0 做了范围裁决(P0-1 本轮不修代码只订正文档 + 开 aeloop#31 追踪;P0-2 A5 范围内轻量兜底,不动 audit-store schema)。

**P0-1(文档订正,不改代码)**:
- `docs/feature/a5-cli-tui/PRD.md` §0 订正——原表述"coder 的 `--allowedTools Bash,Read,Grep,Glob` 是 read-only 白名单"是事实错误,已改成准确表述:`claude-cli-adapter.ts` 用 `--permission-mode bypassPermissions` 启动 coder,`Bash` 不是只读工具,coder 在 G1 门批准前理论上就能通过 Bash 直接写盘,已知限制,追踪 [aeloop#31](https://github.com/elishawong/aeloop/issues/31),非 A5 范围。
- `CHARTS/knowledge/aeloop.md`(ai-agent 仓)`ClaudeCliAdapter` 条目同一处错误表述("固定只读等效工具白名单")一并订正,同步补充 aeloop#31 追踪链接。

**P0-2(跨进程 resume 可能作用到错误仓库,A5 范围内轻量兜底)**:
- 新增 `src/cli/run-origin.ts`:JSON sidecar(`<profileDir>/run-origins.json`,`memory.db`/`workflow.db` 的兄弟文件,不动 `audit-store.ts` schema)记录每个 run 的 `cwd` 来源目录。`recordRunOrigin()`/`getRunOrigin()` 均 best-effort(读写失败只警告不抛),`describeCwdMismatch()` 产生警告文案。`.gitignore` 补了 `run-origins.json` 一行(此前只有 `*.db` 规则,这个新 sidecar 是 `.json` 不会被那条规则覆盖——写代码时发现随手补的,不是单独一批)。
- `src/cli/assemble.ts`:`CliDeps` 新增 `profileDir: string` 字段(供 `run-origin.ts` 定位 sidecar 文件)。
- `src/cli/main.ts`:`runStart` 成功后记录 origin;`runResume`/`runList` 读回 origin,和当前 `process.cwd()` 不一致时打印警告(不阻断,`list` 额外在对应行末尾加 `⚠` 标记 + 尾部一行汇总提示)。
- 测试:`src/cli/__tests__/run-origin.test.ts`(新,9 条,含损坏 JSON/非对象 JSON/目录不存在的降级路径)+ `main.test.ts` 新增 6 条(start 记录、resume 命中/不命中/无记录三态、list 标记/不标记两态)+ `assemble.test.ts` 补一条 `profileDir` 断言。

**P1-3(`MainOverrides.env` 安全 seam 收紧)**:
- `src/cli/main.ts`:`MainOverrides` 删掉 `env` 字段——`main()` 是可编程调用的公开入口(不止 `bin.ts`),此前允许调用方伪造 `env` 声称 `AI_AGENT_PROFILE=subscription` 绕过 `assembleSubscriptionDeps()` 的"no bypass path"保证。`withDeps()` 现在无条件用真实 `process.env`。`profilesRoot`/`prompter` 两个 seam 保留(不能让调用方谎报 profile,只影响文件位置/应答来源)。
- `src/cli.e2e.test.ts`(B8):两处 `main()` 调用删掉 `env: {...}` override,改为 `beforeEach`/`afterEach` 临时 scope 真实 `process.env.AI_AGENT_PROFILE`(用完恢复)。

**P1-4(终端控制符清洗)**:
- 新增 `src/cli/sanitize-terminal.ts`:`stripControlSequences()` 剥离 OSC/CSI/其它 ESC 序列 + 裸 C0/C1 控制字符(保留 `\n`/`\t`)。
- `src/cli/diff-render.ts`:`renderDiff()` 上色前先过 `stripControlSequences()`。
- `src/cli/gate-view.ts`:四个 `render*()` 函数的 `payload.question` + `renderIssuesList()` 的每条 issue 都过 `stripControlSequences()`。
- `src/cli/run-loop.ts`:`decideForGate()` 传给 `prompter.confirm()`/`prompter.select()` 的 `question` 也做同样清洗(超出原始文件清单,但不做这处闭环,`@inquirer/prompts` 的 `message` 渲染仍会重新暴露同一个漏洞——见下方"发现的新问题")。
- `src/cli/main.ts`:`list` 命令的 `task` 列(用户输入,非模型产出,但同样是直接打印到终端的动态字符串)同样过清洗。
- 测试:`sanitize-terminal.test.ts`(新,13 条)+ `diff-render.test.ts`/`gate-view.test.ts` 各补一条端到端场景("real 文本被保留 + 注入的控制序列被剥离")。

**P1-5(真实跨进程 resume 垂直切片)**:
- `src/cli.e2e.test.ts` 新增第三条测试:第一个 `main(["start",...])` 调用用只够 G1 一次的 `FakePrompter` 脚本,故意在 G3 处耗尽脚本抛 `FakePrompterExhaustedError`(exitCode 1)模拟"进程 1 死在这里"——此时 checkpoint/`workflow_runs` 已经真实推进到 G3 暂停态(R6-B2 逐 chunk 同步的既有保证)。第二个完全独立的 `main(["resume", runId])` 调用(自己的 `FakePrompter`,不复用任何内存态)驱动到 `applied:true`,并用独立 `better-sqlite3` 只读连接核实 approvals 表恰好一条 G1 + 一条 G3(证明 `getPendingInterrupt()` 真的重建了 G3 的 payload,不是重放 G1 或伪造决策)。

**🟡 假绿/覆盖不全(4 项一并修)**:
1. `src/cli/prompter.ts`:`FakePrompter.select()` 现在真的记录 `choices` 数组(此前 `_choices` 被丢弃)。`run-loop.test.ts` 对应测试改成断言 `selectCall?.choices` 恰好是 `["approved","escalate"]`。
2. `src/loop/__tests__/runner.test.ts`:`getPendingInterrupt` 的"不写入"测试扩宽快照覆盖到 `step_markers` 表 + checkpointer 自己的 `checkpoints`/`writes` 表(新增 `readStepMarkers()`/`readCheckpointTables()` 辅助函数)。
3. `src/cli/__tests__/assemble.test.ts`:"tier 3" 测试原先只是不设置 `default_reject_threshold`(命中 `SystemConfig` 自己的 `DEFAULTS` 回退到 `"2"`,实际测的是 tier 2),改成真的存一个非数字值(`systemConfig.set("default_reject_threshold","not-a-number")`)让 `getDefaultRejectThreshold()` 真返回 `null`,走到 `resolveRejectThreshold()` 硬编码 `2` 的分支——判断这是设计上有意的兜底(类型签名允许 `null`),不是死代码,保留分支,只修测试。
4. `src/cli.e2e.test.ts` happy-path 测试:`fake-claude.fixture.mjs` 新增 opt-in `FAKE_CLAUDE_PROMPT_CAPTURE_FILE` 环境变量(不设置时行为完全不变,不影响任何既有测试),把真实收到的 `-p` prompt 文本落盘;测试断言 seed 的 memory 内容("aeloop uses pnpm as its package manager.")真的出现在捕获的 prompt 里。

**顺手修(小项)**:
- `src/cli/main.ts`:`parseArgs` 新增已知 `--help`/`-h` 选项 + 未知 option 报错(而非静默吞掉);`start`/`resume`/`list` 对多余 positional 参数报错(而非静默截断到第一个,如 `aeloop start fix the bug` 不再悄悄变成 `task="fix"`)。
- `src/cli/main.ts`:真正的 `--help`/`-h`(以及裸 `aeloop` 无命令)输出用法说明并干净退出,不再落进"unrecognized command"错误分支。
- `src/cli/run-loop.ts`:`printFinalSummary()` 措辞从"completed — applied."改成"completed — G3 approved, audit trail closed (no file-write step in this engine yet)."(鉴于 P0-1 的现实,"applied"这个词本身有误导性);未完成分支同步从"(not applied)"改成"(not completed)"。
- `src/cli/main.ts`:`withDeps()` 的 `finally` 块新增关闭 checkpointer 底层 `better-sqlite3` 连接(`(deps.checkpointer as SqliteSaver).db.close()`)——此前每条命令都会泄漏一个文件句柄。

**测试新增/改动统计**:改动前 368/368(军师报告口径);本轮改完 **407/407**(净增 39 条:`run-origin.test.ts` 9 + `sanitize-terminal.test.ts` 13 + `diff-render.test.ts`/`gate-view.test.ts` 各 +1/+2 + `main.test.ts` +14 + `assemble.test.ts` +1 + `run-loop.test.ts`/`runner.test.ts` 各改而非增 + `cli.e2e.test.ts` +1 新测试)。`pnpm test`/`pnpm lint`/`pnpm build` 三者本轮均重新跑过确认全绿,不是沿用军师之前报的数字。

**变异自验(改前红、改后绿,逐条见 impact.md)**:`sanitize-terminal.ts` 核心函数 no-op 化 → 13 条测试转红;`main.ts` P0-2 警告条件改 `if(false)` → 1 条转红;`prompter.ts` `select()` 丢弃 `choices` → 1 条转红;`assemble.ts` tier-3 硬编码值改错 → 1 条转红;`runner.test.ts` widened 快照对拍——手动往 `writes` 表插一条真实行 → 1 条转红;`main.ts` checkpointer close 行删掉 → 1 条转红;`main.ts` `runResume` 传错 `runId+1` → P1-5 新测试转红;B8 happy-path seed 的 memory 内容改成无关文本 → item-4 新断言转红。全部改回后复绿,详见本次 HANDOFF 报告正文。

**发现的新问题(未在本轮范围内修,如实记录)**:
- `run-loop.ts` 的 `decideForGate()` 把 `question` 传给 `prompter.confirm()`/`prompter.select()` 时,`@inquirer/prompts` 自己也会把这段文本渲染到终端(不经过 `gate-view.ts`)——本轮已经在这条路径也补了 `stripControlSequences()`(超出原清单的 3 个文件,但认为是同一个漏洞的另一半,不修就没有真正闭合),但没有新增专门针对这条路径的单元测试(`decideForGate` 是模块内部函数,未导出;引擎里真实门的 `question` 文本目前都来自 `gates.ts` 硬编码字符串,不受模型/用户输入影响,所以现状下这条路径实际不可达攻击面——只是防御纵深)。建议后续如果 `question` 来源变成可被模型/用户影响的文本,再补针对性测试。

### B11 — Zorro R2 独立复审(含 Codex `gpt-5.6-sol` 二签)返工 [M]
- 状态:完成
- 触发:R2 独立复审判 FAIL——`run-origin.ts` 的兜底代码本身有一个真实崩溃 bug(B1,Zorro/Codex 亲手复现),另有 4 项建议改动。方向和 B10 的大部分内容(删 env seam、跨进程 resume e2e、sanitize 安全属性)已确认干净,本轮不动。

**B1(真 bug,必须改)**:
- `src/cli/run-origin.ts`:`getRunOrigin()` 此前对 `readRunOrigins()`[String(runId)]` 的返回值不做任何形状校验,直接 `as RunOriginsFile` 盲转。一个语法合法但条目损坏的 sidecar(如 `{"1": null}`)会让它原样返回 `null`;`main.ts` 的 `runResume`(:142)/`runList`(:184)都只判断 `origin !== undefined` 就去读 `origin.cwd`,`null !== undefined` 为真 → `null.cwd` 抛 `TypeError`,整条 `resume`/`list` 命令崩溃退出(exitCode 1),而这个文件的头注释明确承诺"never throws / degrades to no-origin"。
- 修法:新增 `isValidRunOrigin()` 形状守卫(必须是非 null 非数组对象,且 `cwd`/`recordedAt` 都是字符串),`getRunOrigin()` 现在对读到的条目跑这个守卫,任何不合法形状(`null`、裸字符串、缺字段的对象)一律降级成 `undefined`,复用既有的"无记录"静默路径。文件头注释同步更新说明这条新增的降级路径。
- 测试:`run-origin.test.ts` 新增 5 条(`{"1":null}`、裸字符串、缺 `cwd`、缺 `recordedAt`、"损坏条目不连累同文件里其它合法条目"各一条);`main.test.ts` 在 `resume`/`list` 两个 describe 块各新增真实调用 `main()` 的端到端回归(`{"9":null}`/字符串条目直接写进临时 sidecar,断言 `main()` 不抛、`exitCode` 不被设成 1、命令正常完成),精确对应崩溃现场那两处调用点。

**建议改(与 B1 同轮一并处理)**:
- **P0-1 头注释订正**(纯注释,零行为变更):`src/harness/adapters/claude-cli-adapter.ts` 文件头 + `ALLOWED_TOOLS` 常量注释,把"read-only-equivalent tool allowlist"的旧表述改成和 PRD §0 一致的准确说法——`--permission-mode bypassPermissions` + `Bash` 在白名单内,coder 理论上能在 G1 批准前直接写盘,已知限制,追踪 aeloop#31。
- **P1-4 补漏**:`main.ts` 的 `runList` 此前只清洗了 `task` 列,没清洗 sidecar 里的 `cwd`;`run-origin.ts` 的 `describeCwdMismatch()` 也没清洗 `origin.cwd`/`currentCwd`。两处都补上 `stripControlSequences()`(`runList` 里保留用未清洗的原始值做 mismatch 判断,只对展示用的拷贝清洗,避免清洗改变比较语义)。新增回归:`run-origin.test.ts` 一条(两个 cwd 都清洗)+ `main.test.ts` 一条(list 表格首行不含注入的 ESC 字节)。
- **sanitize 注释订正**:`sanitize-terminal.ts:34` 的 `OTHER_ESCAPE_SEQUENCE` 举例说能处理 `ESC c`(RIS)/`ESC 7`/`ESC 8`——正则 `[@-Z\^_]` 实际不匹配 `c`/`7`/`8`,这几个序列是靠后面 `RAW_CONTROL_CHARS` 剥掉裸 ESC 字节间接中和的(残留可见字符,如 `ESC c` → 裸 `c`)。安全属性没问题(没有控制字节能存活),只是举例说错了机制。订正注释 + 新增一条测试锁定这个真实行为(`ESC c`/`ESC 7`/`ESC 8` 各自剥离后剩裸字符)。
- **assemble.ts 错误路径泄漏**:`memoryStore` 在 `buildAdapterRegistry()`/`createSqliteCheckpointer()`/`new AuditStore()`(均可抛)之前就已打开真实 `better-sqlite3` 连接;这几步任一抛错,函数直接 rethrow,从不返回 `CliDeps`,已打开的连接就没有主人来 `close()`,永久泄漏一个文件句柄。改成 `try/catch`:成功路径不变,失败路径显式 `checkpointer?.db.close()` + `memoryStore.close()` 后再 rethrow。新增回归(`assemble.test.ts`):构造一个 `kind: not-a-real-kind` 的非法 provider 触发 `InvalidProviderConfigError`,`vi.spyOn(MemoryStore.prototype, "close")` 断言恰好被调用一次。

**变异自验(改前红、改后绿,逐条真实执行过,非声称)**:
- B1:临时把 `getRunOrigin()` 改回无校验的旧实现 → `run-origin.test.ts` 5 条新测试全部转红(`{"1":null}` 断言 `toBeUndefined()` 收到真实 `null`;`main.test.ts` 两条端到端回归 `exitCode` 从预期 `undefined` 变成真实 `1`,证明确实复现了崩溃)。改回后全部复绿。
- P1-4:临时去掉 `main.ts`/`run-origin.ts` 两处新增的 `stripControlSequences()` 调用 → `run-origin.test.ts` 1 条 + `main.test.ts` 1 条转红(实测输出里真的含裸 ESC 字节 `\x1B[2J`)。改回后复绿。
- sanitize 注释订正测试:锁定的是既有行为(非本轮新改的逻辑),未做改前红验证(逻辑本身未变,只是补一条此前缺失的覆盖)。
- assemble.ts 泄漏:临时改回无 `try/catch` 的旧实现 → 新增测试从 `closeSpy` 期望调用 1 次变成实测 0 次,转红。改回后复绿。

**测试新增/改动统计**:改动前 407/407(R1 返工后口径);本轮改完 **419/419**(净增 12 条:`run-origin.test.ts` +7、`main.test.ts` +4、`sanitize-terminal.test.ts` +1、`assemble.test.ts` +1)。`pnpm test`/`pnpm build`/`pnpm lint` 三者本轮均重新跑过确认全绿,不沿用 R1 报的 407 数字。

**未在本轮范围内(指挥官已定盘)**:
- P0-1 的代码级修复(真只读沙箱)不在这轮范围,已开 [aeloop#31](https://github.com/elishawong/aeloop/issues/31) 追踪。

## 决策记录(可追源)
- 2026-07-21 决定 `CliDeps` 比 PRD §6.5 签名草图多 `injector`/`memoryStore` 两个字段,因为 PRD §6.7 明确要求 `main.ts` 的 `start` 命令调 `ContextInjector.inject(task)`,但 §6.5 的接口草图没地方装这个实例;`memoryStore` 供命令结束时 `close()`。源:PRD §6.5/§6.7 原文 + `src/cli/assemble.ts` 代码注释。
- 2026-07-21 决定给 `assembleSubscriptionDeps()`/`main()` 都加可选的测试注入点(`profilesRoot`/`overrides`),PRD 签名草图没有,因为没有它们 B8 硬性垂直切片无法把真实 `main()` dispatch 指向 fixture profile 根目录而不触碰真实 `profiles/subscription/`。源:PRD §2 "hard vertical slice ... FakePrompter" 验收目标 + `loadProfile()` 自己已有的 `profilesRoot` 注入点先例(`src/profile/loader.ts`)。
- 2026-07-21 决定 chalk 颜色等级强制设为 3(truecolor),不用默认 TTY 自动探测,因为验收标准(PRD §10)要求"real ANSI color codes present"可断言,自动探测在非 TTY(测试/管道)环境会静默变无色。无直接 PRD/库文档依据,标注为判断调用。
