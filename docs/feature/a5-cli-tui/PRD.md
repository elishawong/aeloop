# PRD — aeloop A5: CLI/TUI(第一个真正的终端入口)

> 骨架来源:`docs/feature/a4b-loop/PRD.md`(结构/批次/措辞风格直接照搬)。
> 防幻觉:`[?]` = 我未验证 / 需要指挥官确认;不发明接口/版本号/参数。本 PRD 里所有关于既有代码的陈述都来自我亲自阅读真实 A0-A4b 代码(`src/**/*.ts`,不含 `*.test.ts`)+ `docs/DESIGN.md` + `docs/ROADMAP.md` + issue #22,不凭记忆。所有关于第三方库(`chalk`、`@inquirer/prompts`)API 的说法,都是在写这份 PRD 期间对照该库自己发布的 README/registry 元数据核实过的,不是从训练记忆里回忆的——精确来源见 §9。任何没有直接代码/文档证据、需要我自己判断的设计决策,单独列在 §9,不混进"已验证"部分。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库)
- **分支**:`feature/issue-22-a5-cli-tui`(从 `main` `c8d0289` 新切出,即 A4b + 开源就绪合并之后的 HEAD)
- **优先级**:P1
- **状态**:等待指挥官确认
- **最后更新**:2026-07-21
- **关联 issue**:[elishawong/aeloop#22](https://github.com/elishawong/aeloop/issues/22)
- **设计权威**:`docs/DESIGN.md` §8 里程碑表("A5 CLI/TUI: colorized diff + y/n approval + visual distinction for escalations")+ 真实 A0-A4b 代码:`src/loop/{types,gates,escalation,graph,runner,audit-store,workflow-def}.ts`、`src/harness/{provider-router,config,types}.ts`、`src/prompt/{schema,composer}.ts`、`src/context/{injector,store,config,staleness}.ts`、`src/profile/loader.ts` + `docs/feature/a4b-loop/PRD.md`(runner.ts 的契约,尤其 `getResumableRuns` 上"给未来 A5 CLI 一个现成入口"那条注释)+ issue #22 指挥官已定的范围(2026-07-21:只做 subscription profile、轻量 chalk+prompt 库方案、不做完整 TUI 框架)。

---

## 0. A5 到底是什么(以及不是什么)—— 本次调研最重要的一条发现

在做任何接口设计之前:**A0-A4b 里没有任何代码把 coder 的 diff 写成磁盘上的真实文件,也没有任何代码去应用它。** 这不是 A5 需要修的东西,但它改变了"批准一个 diff"在这一增量里具体意味着什么。证据:

- `src/loop/graph.ts` 的 `applyNode()`(`Apply` 终止态,DESIGN §4):`return { applied: true };` —— 没有任何文件系统 I/O。它自己的文档注释写着这是"DESIGN §4 的终止态,按 [A4a] PRD §0/§2 **降级**处理:只标记 run 完成,从不碰文件系统"——这是一个已文档化、刻意为之的 A4a 决策,不是 A5 该补的疏漏。
- **订正(2026-07-21,Zorro + Codex `gpt-5.6-sol` 独立复审,`docs/feature/a5-cli-tui/test-report.md` P0-1,追踪于 [elishawong/aeloop#31](https://github.com/elishawong/aeloop/issues/31))**:本节早先的草稿曾声称 `ClaudeCliAdapter` 给 coder 角色的 `--allowedTools "Bash,Read,Grep,Glob"` 是一个只读工具白名单(没有 `Write`/`Edit`)。**这个说法是事实错误,已被划掉。** `src/harness/adapters/claude-cli-adapter.ts` 用 `--permission-mode bypassPermissions` 启动 coder,而 `Bash` 不是只读工具——`sed -i`、shell 重定向、`git apply` 都能通过它写盘;`Read`/`Grep`/`Glob` 是只读的,并不代表当 `Bash` 也在白名单里时整个*白名单*就是只读的。`profiles/subscription/personas/coder.md` 明确指示 coder"直接在目标代码库里实现所请求的改动"。具体来说,这意味着**在人类看到 G1 渲染出来的 diff 并批准之前,coder 可能已经对目标仓库做了真实的改动**——G1/G2/G3 门是对模型自报的 diff 和 claims 的真实审计/复审步骤(如 §0 上文所述,有真实价值),但它们并不是 coder 已经改动文件系统这件事的技术前提条件。这是底层 Harness 层 adapter 一个已知的、目前尚未修复的限制(不是 A5 自己的 `src/cli/` 层能在其范围内修的——修复应该落在 `claude-cli-adapter.ts` 的权限/工具配置上,那是 Harness 层的改动),追踪于 aeloop#31,不在本 PRD 各批次的范围内。
- `CoderOutput.diff`(`src/prompt/schema.ts`)的文档说明是"a unified diff or equivalent patch text"(一份 unified diff 或等价的补丁文本)——这是模型作为其结构化 JSON 答案的一部分**自行报告的字符串**,不是针对某个工作树真实计算出来的 `git diff`,也不保证是严格格式化的 unified-diff 语法。

**这对 A5 意味着什么**:CLI 的 G1/G3"批准这个 diff"门,是对模型自报的改动描述及其审计轨迹(claims/confidence/工具校验)一次真实的、真正 human-in-the-loop 的复审——这是真实价值(对应 DESIGN 的防幻觉 + 审计轨迹目标)——但今天批准 G3 **不会**导致磁盘上任何文件真的发生变化。A5 渲染的、以及在其上设门的,恰好就是 A0-A4b 引擎真实产出的东西;它不新增一个"把 diff 写进工作区"的能力(那会是新的 Loop 层范围,不是 CLI 层该管的事,issue #22 和 DESIGN §8 的 A5 那一行也都没有要求这个)。这里明确标出来,而不是留着让人默认,因为很容易读到"彩色 diff + y/n 批准"就以为批准会执行写入。

## 1. 问题 / 用户 / 方案

- **要解决的问题**:A0-A4b 建好了整个引擎(Context→Prompt→Harness→Loop,四层全部完成,300/300 测试全绿),但今天驱动一次 run 的*唯一*方式是编程调用——`src/loop.e2e.test.ts` 直接调用 `startRun()`/`resumeRun()`,传入硬编码的 `GateResumeValue`/`EscalationResumeValue` 对象。没有任何人类能跑的终端命令,没有对 coder/tester 实际产出内容的渲染,四个决策点(G1/G2/G3/Escalation)里也没有任何交互式提示。`src/index.ts` 的 barrel 甚至还没导出 `loop`/`harness`/`cli`(这是刻意的,它自己的文件头写着"这些层还不存在")。`package.json` 里零个面向 CLI 的依赖。
- **给谁用**:指挥官,从终端针对 `subscription` profile(claude-cli 任 coder / codex-cli 任 tester)运行 aeloop,作为一个人类第一次真正端到端地使用这个引擎——而不是作为测试 harness。
- **一句话方案**:新增一个 `src/cli/` 层(DESIGN §6 的目标文件树已经把这一层预留为 `profile/` 的兄弟目录,在四个嵌套引擎层之外),它 (1) 组装真实的 `subscription` profile 依赖图(`loadProfile` → `MemoryStore`/`ContextInjector` → `PromptComposer` → `buildAdapterRegistry`/`ProviderRouter` → `AuditStore`/checkpointer),完全按 `src/loop.e2e.test.ts` 已经证明可行的方式;(2) 驱动 `runner.ts` 现有的 `startRun()`/`resumeRun()`(外加本 PRD 新增的一个很小的、纯新增的 `runner.ts` 导出——见 §5),通过一个交互式循环,用 chalk 上色的 diff/issue 文本渲染每个门的 payload,并用 `@inquirer/prompts` 提示做决策,Escalation 门有一套视觉上明显不同的处理;(3) 通过一个真实的 `bin` 入口暴露三个子命令(`start`、`resume`、`list`)。

## 2. 目标 / 非目标

**目标**:

- 一个真实的、可安装/可运行的 CLI 命令(`aeloop start "<task>"` / `aeloop resume <runId>` / `aeloop list`),只针对 `subscription` profile 驱动一次 Loop run。
- G1/G3 处的彩色 diff 渲染(`CoderOutput.diff`,尽力而为的按行前缀上色——不是严格的 unified-diff 解析器,因为该字段不保证严格格式化——见 §0/§6)。
- G1 门:渲染 diff + 问题,`approved`/`rejected` 决策(`@inquirer/prompts confirm`),reject 时可选填自由文本理由(喂给 `GateResumeValue.reasoningText`,`gates.ts` 的 `createG1Node` 已经把它接入下一轮的 `feedback`)。
- G2 门:渲染 tester 的 `issues[]` 列表 + 问题,决策严格限定为 `gates.ts` 的 `routeAfterG2` 今天实际接受的选项——**`approved`(送回给 coder 修复)或 `escalate`(主动升级)**——没有第三个"rejected"选项(见下文 §0.1 的订正)。
- G3 门:再次渲染 diff(完成前最后一眼)+ 问题,`approved`/`rejected` 决策,形状和 G1 一样。
- Escalation 门(`ESCALATION_ACK`):视觉上明显不同的渲染(一个把它和普通门区分开的 banner——chalk 背景色/加粗处理,不只是换个单一颜色)+ 渲染 diff + tester issues + 三选一决策(`revise`/`force_pass`/`abandon`),`revise` 时可选填自由文本理由(喂给 `escalation.ts` 已实现的同一套 `deriveFeedback` 模式)。
- `aeloop resume <runId>`:从磁盘重建一个暂停 run 的待处理门 payload(通过 §5 新增的一个 `runner.ts` 导出),并在**新进程**里继续,不依赖原始 `start` 调用留下的任何内存态——这是"A5 是否真的复用了 A4b 的跨进程 resume,而不是重新发明一套"的具体验收测试。
- `aeloop list`:对已有的 `getResumableRuns()`(`runner.ts`)做一层薄 CLI 包装——打印出人类可以 resume 的 `running`/`escalated` runs(id/task/currentState/updatedAt)。
- 硬核纵切(DESIGN §8.5 每个里程碑的强制规则):一个真实的端到端测试,驱动真实的 `subscription` profile 依赖图(真实 `MemoryStore`/`ContextInjector`/`PromptComposer`/`buildAdapterRegistry`/`ProviderRouter`/真实 cli-bridge fixture 子进程,和 `src/loop.e2e.test.ts` 已经确立的同一个 fixture 替身边界),经由 `src/cli/main.ts` 的真实命令分发,用一个脚本化的 `FakePrompter` 替身站在键盘前的真实人类——证明 CLI 层真的接到了真实引擎上,而不是自始至终只针对 fake 做单元测试。

**非目标**(明确列出,免得有人把一处缺口读成疏漏):

1. **apikey/direct-api profile 支持**——指挥官已定(2026-07-21,issue #22):A5 只接通 `subscription`。如果设置了 `AI_AGENT_PROFILE=apikey`(或除 `subscription` 外的任何值),`aeloop` 会以一个清晰的、类型化的错误退出——绝不静默回落,也绝不无关的崩溃。落在 A6,和 apikey 验收 run 一起做。
2. **真正把 diff 应用/写入真实文件**——A0-A4b 既有的范围边界(§0),不是 A5 新增的东西。批准 G3 会在审计轨迹里把 run 标记为 `applied: true`;它不会碰 `profiles/subscription/*.db` 之外的任何文件。
3. **完整 TUI 框架**(多面板布局、实时刷新、光标寻址渲染——ink/blessed 那一类工具)——指挥官已定(2026-07-21):只做轻量的 chalk + 一个面向行的 prompt 库,按照 DESIGN §8 的实际要求("彩色 diff + y/n 批准 + escalation 的视觉区分"——没提到面板/实时 UI)。
4. **续跑一个在模型调用中途被打断的 run**——一个真实的、已验证的缺口(见下文 §0.2),本 PRD 不修复;作为一个已知限制记录下来,不是悄悄漏掉没发现。
5. **同一个 profile 磁盘 DB 上的多个并发 CLI 会话/并发 run**——不在范围内,和引擎其余部分已经假设的单本地用户姿态一致(不新增任何锁/协调机制)。
6. **`--reject-threshold`(或任何其它)CLI 参数覆盖层**——reject-threshold 的解析链保持 `runner.ts` 自己的文档注释和 A4b PRD §9.2 决策 2 已经确立的样子(`config.yaml` → `SystemConfig.getDefaultRejectThreshold()` → 硬编码 `2`);A5 不会在这条链上再发明第四层 CLI 参数——PRD 的指示明确说了没有证据不要擅自扩展它。
7. **`workflowDefId` 选择**——硬编码为唯一存在的那个真实 graph,`"coder-tester-loop"`(和现有每个测试已经在用的字面字符串一致;`workflow-def.ts` 的 `CODER_TESTER_LOOP_DEFINITION` 只是文档性质的,不是运行时解读的,所以目前也没有别的可选)。
8. **git commit/push 自动化**——DESIGN §3 的时序图已经写明"把文件写进工作区(**不自动 git commit/push**)";A5 不改变这个姿态(而且按非目标 2,它现在连文件都还没写)。

### 0.1 对 issue #22 简写说法的订正:G2 不是"approved/rejected/escalate"

Issue #22 正文自己把 G2 的决策列成"approved/rejected/escalate"(三选一)。**这不是真实代码接受的样子。** `src/loop/gates.ts` 的 `routeAfterG2()`:
```ts
export function routeAfterG2(state: LoopStateType): "draft" | "escalation" {
  if (state.g2Decision === "approved") return "draft";
  if (state.g2Decision === "escalate") return "escalation";
  throw new UnhandledGateDecisionError(GATE_TYPES.G2_SEND_TO_FIX, state.g2Decision ?? "undefined");
}
```
G2 处的 `"rejected"` 会抛出 `UnhandledGateDecisionError`——这是一个**永久性的、已文档化的 A4a 决策**(PRD §2 非目标 #2,在 `gates.ts` 自己的文档注释和 `runner.ts` 的 `G2_RESUME_DECISIONS = ["approved", "escalate"]` 里都明确重申"A4b 未改变这一点")。因此 A5 的 G2 提示恰好只给两个选项——批准(把修复送回给 coder)或升级——从不给第三个"拒绝"选项。上文本 PRD §2 的目标部分已经反映了这个经代码核实后订正的契约,而不是 issue #22 的简写说法。

### 0.2 一个真实的、已验证的限制:在模型调用进行中按 Ctrl+C 无法续跑

`runner.ts` 的 `startRun()`/`resumeRun()` 只在 `compiled.stream()` 吐出一个 chunk 之后——也就是某个节点(`draft`/`review`/某个门)真正完成之后——才调用 `AuditStore.updateRunProgress()`(它才是把 `workflow_runs.current_state` 从起始值往前推进的动作)。如果在 coder/tester 模型调用还在进行中时 CLI 进程被杀掉(Ctrl+C、崩溃)——一个真实的 `claude -p`/`codex exec` 子进程可能跑上好几分钟——`workflow_runs.current_state` 仍然停留在那次调用开始之前的状态(对一个全新的 run 来说是 `"draft"`,因为 `startRun()` 的 `insertRun()` 调用在 graph 真正跑起来之前就同步把 `currentState` 设成了 `LOOP_NODES.draft`)。LangGraph 自己的 `SqliteSaver` checkpoint 同样只在节点边界写入,所以也没有节点内部的 checkpoint 可以续跑。具体表现:`resumeRun()` 的 `resumeDecisionsFor("draft")` 返回 `[]`(不是一个可识别的待处理门状态),所以任何 `aeloop resume <那个 runId>` 的尝试都会抛出 `ResumeDecisionDomainMismatchError`——这是设计使然(宁可大声失败,也不破坏状态),但这个 run 确实是卡住了,无法续跑。**这是一个真实的缺口,A5 不修复它**(修复它意味着 Loop 层要持久化/续跑节点内部状态,这比"加一个 CLI"要大得多)。遇到这种情况的用户的变通办法是:用相同的任务文本重新起一个新 run。这一点在 `main.ts` 的 Ctrl+C 处理里(一条清晰的提示信息,而不是静默挂起)以及本 PRD B9 批次新增的 CLI `--help`/README 章节里都有明确说明。

相比之下:**在停在一个交互式门提示(等待人类输入)时按 Ctrl+C 是完全安全的**——此时 `interrupt()` 已经把控制权交还给了调用者,checkpoint 也已经持久化写入(这正是 `checkpoint.test.ts` 的同进程两阶段续跑,以及 `src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs` 真正跨独立进程的续跑,已经为底层机制证明过的)。`aeloop resume <runId>` 能正确接上这种情况——这正是本 PRD 验收标准所针对的主要 resume 路径。

---

## 3. 对五个调研问题的回答(指挥官布置的任务,已对照真实代码验证)

1. **CLI 启动输入的形状**:`startRun()` 的 `StartRunInput`(`src/loop/runner.ts`)需要 `task: string`、`profile: string`、`workflowDefId: string`、`injectedContext: ContextInjectionResult`、`rejectThreshold: number`。其中,只有 `task` 是真正面向用户的 CLI 参数(`aeloop start "<task text>"`);`profile` 硬编码为 `"subscription"`(非目标 #1);`workflowDefId` 硬编码为 `"coder-tester-loop"`(非目标 #7);`injectedContext` 通过调用真实的 `ContextInjector.inject(task)`(`src/context/injector.ts`)、传入同一个 task 字符串产生,和 `src/loop.e2e.test.ts` 已经在做的一样;`rejectThreshold` 由 `src/cli/assemble.ts` 里一个新的小函数 `resolveRejectThreshold()` 解析,实现的是既有文档化的解析链(`profileConfig.workflow?.reject_threshold` → `SystemConfig.getDefaultRejectThreshold()` → `2`)——不需要目标仓库路径参数:`ClaudeCliAdapter`/`CodexCliAdapter` 通过 `spawnWithTimeout(cmd, args, { timeoutMs })` 启动,**不传 `cwd`**,所以 `SpawnWithTimeoutOptions` 文档化的默认值(`process.cwd()`)生效——coder/tester 子进程的工作目录就是人类运行 `aeloop` 时所在的那个目录,和 `git`/大多数 CLI 工具的做法一样。本 PRD 不新增 `--cwd`/`--repo` 参数(现有的 adapter 代码里没有任何地方读取这样一个参数,新增它需要把一个新选项一路接到 `ClaudeCliAdapter`/`CodexCliAdapter`,不在本增量范围内)——想让 coder 操作某个特定仓库的用户,从那个仓库目录里运行 `aeloop` 即可。
2. **复用 A4b 的跨进程 resume**:是的,完全复用,就用建好的 `resumeRun()`——`runner.ts` 自己的文档注释("给未来的 A5 CLI 一个现成的入口,回答'现在能续跑什么'"写在 `getResumableRuns` 上)和 `src/loop.e2e.test.ts` 的 escalation 测试(已经纯靠一个以 `handle.interrupt?.gate` 为键的循环、只用 `startRun()`/`resumeRun()` 驱动完整一次 run)都证实了这一点。唯一的缺口是:一个**全新的 CLI 进程**在续跑一个既有 run 时,没有内存中的 `RunHandle` 可以从中读出待处理门 payload(diff/issues/question)——`resumeRun()` 本身只在决策做出*之后*、作为它返回的 handle 的一部分才返回这个 payload,而不是在决策之前。§5 新增了一个小的 `runner.ts` 导出 `getPendingInterrupt()` 来补上这个缺口——它做的事情不比 `runStreamAndPersist` 内部的 `computeRunProgress()` 已经在做的多(一次 `compiled.getState(cfg)` 读取),只是把它作为一个公开的、只读的入口暴露出来,给还没有活 handle 的调用方用。
3. **Diff 渲染的来源**:`CoderOutput.diff`(`src/prompt/schema.ts`,`z.string().min(1)`,"the change itself, as a unified diff or equivalent patch text")——通过 `GatePayload.diffRef`(`src/loop/types.ts`)到达,`gates.ts` 的 `createG1Node`/`createG3Node` 和 `escalation.ts` 的 `createEscalationNode` 直接从 `state.coderOutput?.diff` 填充它。没有使用任何外部 diff 解析库——一个自己写的、尽力而为的按行前缀上色器(`+`→绿,`-`→红,`@@`→青,`+++`/`---`→加粗,其余原样)已经足够,而且鉴于该字段不保证是严格的 unified-diff 语法(见 §0/§6.1),这样做也是诚实的。
4. **G2/Escalation 的交互设计**:见 §2 目标(G2:approve/escalate 二选一,不是三选一——见 §0.1 的订正)和 §6.3(escalation 视觉上明显不同的 banner 处理)。具体来说:G2(两个选项在语义上不是"是/否")和 Escalation(三个选项)用 `select()`(而不是 `confirm()`);G1/G3(真正的二元 approve/reject)用 `confirm()`。
5. **Profile loader 的接入**:`loadProfile()`(`src/profile/loader.ts`)读取 `AI_AGENT_PROFILE`(默认 `"subscription"`),返回 `{ok, profile, profileDir, configPath, config}` 或一个类型化的 `ProfileNotFoundError`。`src/cli/assemble.ts` 调用它一次,硬性守卫 `result.config.profile === "subscription"`(否则抛出一个新的类型化 `UnsupportedProfileError`——非目标 #1),然后构造 `personasDir = path.join(profileDir, "personas")` 供 `PromptComposer` 使用,以及本 PRD 引入的两个新的按 profile 划分的数据库文件路径(见 §6.2):`path.join(profileDir, "memory.db")`(DESIGN §6 已经为 `MemoryStore` 记录的既有约定)和 `path.join(profileDir, "workflow.db")`(新的——DESIGN §6 目前还没给这个文件命名;A4b 自己"AuditStore + checkpointer 共用一个文件"的先例,PRD §9.2 决策 3,之前只在测试里用过临时路径——本 PRD 是第一个需要给它一个真实的、永久位置的地方,选定 `workflow.db` 作为 `memory.db` 的兄弟文件,两者都已经被仓库既有的 `*.db` `.gitignore` 规则覆盖)。

---

## 4. Spike 决策:不需要

本 PRD 新增的两个第三方库(`chalk@5.6.2`、`@inquirer/prompts@8.5.2`)都很成熟、ESM 原生(本仓库是 `"type": "module"`、`moduleResolution: "NodeNext"`——两个包都是 ESM-first 的,已经对照它们自己发布的 README/registry 元数据核实过,不是凭记忆回忆的——精确来源见 §9),而且这里用到的都是它们最基础的、有文档记录的用法(`confirm({message})`、`select({message, choices})`、`input({message})`、`chalk.green(...)`)。这里没有可以和 A4a 的 `codex exec` 非交互模式 spike(一个未验证、未文档化的 CLI 行为)或 A2 的 deepseek 存活探测 spike(一个未验证的第三方 API 的真实行为)相提并论的真正集成不确定性——这是驾轻就熟、有充分文档记录的库用法,指挥官自己对这个决策的判断("A5 风险明显小很多,不要为了走流程而走流程")和调研结果一致。**不做 spike。** 唯一真正值得在 B8 的自动化 e2e 切片之前做一次人工冒烟检查的地方——`@inquirer/prompts` 的真实 `confirm()`/`select()` 是否在真实终端里正确渲染,而不只是库的 API 表面和本 PRD 的假设相符——已经作为一个人工验证步骤纳入本 PRD 的验收标准(§8),而不是单独的 spike 阶段。

---

## 5. `runner.ts` 新增内容(本 PRD 唯一的 Loop 层改动)

`src/loop/runner.ts` 新增一个导出函数:

```ts
/** Read-only reconstruction of a paused run's current pending-gate payload,
 * for a caller (A5's CLI) that has no in-memory RunHandle to read it from —
 * e.g. a fresh process resuming a run `startRun()`/`resumeRun()` returned a
 * handle for in a previous process. Does nothing `runStreamAndPersist`'s
 * internal `computeRunProgress()` doesn't already do (a `compiled.getState(cfg)`
 * read) — exposed here as a public, side-effect-free entry point instead of
 * duplicated in `src/cli/`, keeping "only runner.ts constructs a compiled
 * graph + reads/writes AuditStore" true for this layer too.
 */
export async function getPendingInterrupt(
  deps: StartRunDeps,
  runId: number,
): Promise<{ runId: number; threadId: string; interrupt?: RunHandle["interrupt"]; done: boolean }>
```
实现思路(不是最终代码——build 批次 B4 会写出确切实现):查 `run = deps.audit.getRunById(runId)`(缺失就抛 `AuditReadError`,和本文件里其它接受 `runId` 的函数保持一致);像 `startRun`/`resumeRun` 已经做的那样构造 `compiled`;调用 `computeRunProgress(compiled, { configurable: { thread_id: run.langgraphThreadId } })`,把它的 `interrupt`/`done` 和 `runId`/`threadId` 一起返回。**零新增写入**——这个函数从不调用任何 `audit.insert*`/`updateRunProgress`,和它"只读"的契约一致。测试覆盖落在既有的 `src/loop/__tests__/runner.test.ts` 里,沿用该文件既有的 FakeAdapter 模式(不需要新的测试基础设施)。

这是本 PRD 在 `src/cli/` 之外触碰的**唯一**文件——其余所有文件(`gates.ts`、`escalation.ts`、`graph.ts`、`types.ts`、`audit-store.ts`、`context/*`、`harness/*`、`prompt/*`)都只读、不修改,符合 CONTRIBUTING.md 的依赖方向规则(按 DESIGN §6 的目标文件树,CLI 位于四个嵌套层之外/之上,所以它可以依赖全部四层;`src/cli/` 之下的任何模块都不能依赖它,本 PRD 也没有创建这样的依赖)。

---

## 6. 新增文件(`src/cli/`)

### 6.1 `src/cli/diff-render.ts`
纯函数:`renderDiff(diff: string): string`——按 `\n` 拆分,按前缀给每一行上色(`+`开头的非 `+++` 行用 `chalk.green`,`-`开头的非 `---` 行用 `chalk.red`,`@@`开头的 hunk header 用 `chalk.cyan`,`+++`/`---` 文件头行用 `chalk.bold`,其余不变文本/纯文本保持原样)。明确标注为**尽力而为的展示性上色,不是 unified-diff 校验器**——`CoderOutput.diff` 的 schema 注释("or equivalent patch text")已经提示我们不要假设严格格式(见 §0)。

### 6.2 `src/cli/colors.ts`
`diff-render.ts`/`gate-view.ts` 共用的一组小型 chalk 主题辅助函数:`heading()`、`ok()`/`warn()`/`danger()` 语义化包装,以及一个专用的 `escalationBanner(text: string): string`(背景色/加粗处理——见 §6.3),让"这个看起来和普通门不一样"这件事集中在一个地方,而不是在每个调用点临时重复写。

### 6.3 `src/cli/gate-view.ts`
把 `GatePayload`(`src/loop/types.ts`)转成可渲染文本的纯函数,每种门类型一个:
- `renderG1(payload): string` / `renderG3(payload): string` —— question + `renderDiff(payload.diffRef)`。
- `renderG2(payload): string` —— question + 一份带项目符号的 `payload.issues` 列表。
- `renderEscalation(payload): string` —— **包在 `escalationBanner()` 里**(例如一个用加粗黄底/红底做出来的、带框的 `⚠ ESCALATION — reject threshold reached ⚠` 标题,和 G1/G2/G3 用过的任何颜色都不一样)+ question + issues + diff。这是 DESIGN §8"escalation 的视觉区分"要求的具体实现——一个结构上不同的渲染,而不只是从普通门那里换个单一的 ANSI 颜色。

不需要任何 TTY/prompt 库就能测试——纯粹的 `GatePayload → string` 函数,用普通字符串 `.includes()`/快照断言(包含 ANSI 码,因为上色本身对"escalation 渲染得不一样"这条验收标准确实重要)。

### 6.4 `src/cli/prompter.ts`
```ts
export interface Prompter {
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T>;
  input(message: string): Promise<string>;  // free-text reason; empty string allowed
}
export class InquirerPrompter implements Prompter { /* wraps @inquirer/prompts confirm/select/input */ }
```
生产代码只会构造 `InquirerPrompter`。测试用一个 `FakePrompter`(脚本化应答,和本代码库整个 `src/loop/__tests__/` 里已经在用的"用一个显式 fake 顶在真实实现前面"的 `ModelAdapter`/`FakeAdapter` 模式一样)——这就是让 `run-loop.ts`/`main.ts` 在没有真实终端的情况下也能单元测试的原因,B8 的硬核纵切也是靠它来非交互地驱动一次真实的端到端 run。

### 6.5 `src/cli/assemble.ts`
```ts
export interface CliDeps extends StartRunDeps { profileConfig: ProfileConfig; }
export function assembleSubscriptionDeps(env?: NodeJS.ProcessEnv): CliDeps
export function resolveRejectThreshold(profileConfig: ProfileConfig, systemConfig: SystemConfig): number
```
`assembleSubscriptionDeps()`:调用 `loadProfile()`;如果不 `ok` → 类型化错误;如果 `config.profile !== "subscription"` → 一个新的 `UnsupportedProfileError`(非目标 #1 的硬性守卫——在这里抛出,不留到栈更深处让它以令人困惑的方式失败);否则接线组装 `MemoryStore(memoryDbPath)` → `SystemConfig(store)` → `StalenessEngine(config)` → `ContextInjector(store, staleness)`、`PromptComposer(personasDir)`、`buildAdapterRegistry(config)` → `ProviderRouter(config.roles, registry)`、`createSqliteCheckpointer(workflowDbPath)`、`new AuditStore(workflowDbPath)`——和 `src/loop.e2e.test.ts` 已经手工搭建的那套真实对象图完全一样,只是收敛成了一个可复用的函数。`resolveRejectThreshold()` 把文档化的三层解析链(§2 非目标 #6)实现成一个可独立单元测试的小纯函数。

### 6.6 `src/cli/run-loop.ts`
```ts
export async function runInteractiveLoop(deps: CliDeps, prompter: Prompter, handle: RunHandle, decidedBy: string): Promise<RunHandle>
```
主体:`while (!handle.done) { render(handle.interrupt) via gate-view.ts; ask prompter for a decision shaped for handle.interrupt.gate; handle = await resumeRun(deps, handle.runId, handle.threadId, decision, decidedBy, handle.stepCounters); }`,然后打印一份最终摘要(`applied`/`cancelled`)。`start`(其初始 `handle` 直接来自 `startRun()`)和 `resume`(其初始 `handle` 通过 §5 新增的 `getPendingInterrupt()` 重建,产出同样形状的 `{runId, threadId, interrupt, done: false}`,这个函数可以像消费一个真实 `RunHandle` 一样消费它)共用这个函数。

### 6.7 `src/cli/main.ts` + `src/cli/bin.ts`
`main.ts`:通过 Node 内置的 `node:util` `parseArgs` 解析 argv(这里不新增依赖——整个项目从 `src/harness/cli-exec.ts` 等地方体现出的既有理念是"针对这么窄的场景自己手写一个小原语,好过引入一个库",而且这个仓库在 CLI 参数解析上也没有任何既有先例可以参照——标注为我自己的判断,见 §9)。三个子命令:
- `aeloop start "<task>"` → `assembleSubscriptionDeps()` + `ContextInjector.inject(task)` + `resolveRejectThreshold()` + `startRun()`,立即打印 `Run #<id> started`,然后 `runInteractiveLoop()`。
- `aeloop resume <runId>` → `assembleSubscriptionDeps()` + `getPendingInterrupt(deps, runId)`(如果 run 已经是 `completed`/`cancelled`,或者 `runId` 根本不存在——`AuditReadError`——都清楚地报错)+ `runInteractiveLoop()`。
- `aeloop list` → `assembleSubscriptionDeps()` + `getResumableRuns(deps, "running")` + `getResumableRuns(deps, "escalated")`,以一个纯文本表格打印(id/task/currentState/updatedAt)。
传给 `resumeRun()`/`runInteractiveLoop()` 的 `decidedBy`:`os.userInfo().username`(Node 内置,不新增依赖——我自己的判断,见 §9)。
一个 `SIGINT` handler 打印 §0.2 里那条"模型调用进行中不可续跑,但一个暂停中的门是可以的——见 `aeloop list`"的消息,而不是静默挂起或抛出原始堆栈。
`bin.ts`:一个两行的 shebang 入口(`#!/usr/bin/env node`,然后 `await main(process.argv.slice(2))`),编译到 `dist/cli/bin.js`。`package.json` 新增 `"bin": { "aeloop": "dist/cli/bin.js" }`。

### 6.8 `src/cli/errors.ts`
仿照 `src/loop/errors.ts` 惯例的类型化错误:`UnsupportedProfileError`(非目标 #1 的守卫)、`RunNotResumableError`(`resume <runId>` 的目标已经是 `completed`/`cancelled`,或者根本不是一个真实存在过的 run——把这种情况和 `AuditReadError` 的"根本没有这个 runId"清楚地区分开)。

---

## 7. Package 改动

- `package.json` `dependencies`:`+ chalk@^5.6.2`、`+ @inquirer/prompts@^8.5.2`(两者都已核实是真实存在的、当前版本的、ESM 原生的包——来源见 §9)。
- `package.json`:`+ "bin": { "aeloop": "dist/cli/bin.js" }`。
- `package.json` `files`:已经包含 `dist/**/*`——编译后的 CLI 打包发布不需要改动。
- 不需要改 `tsconfig.build.json`/`tsconfig.json`——`src/cli/**/*.ts` 已经被既有的 `include: ["src/**/*.ts"]` 覆盖。

---

## 8. 批次(按依赖顺序——每一批依赖上一批)

| 批次 | 文件 | 规模 | 内容 |
|---|---|---|---|
| B0 | `package.json`, `src/cli/errors.ts` | S | 加 `chalk`/`@inquirer/prompts` 依赖 + `bin` 字段;类型化 CLI 错误 |
| B1 | `src/cli/colors.ts`, `src/cli/diff-render.ts`(+ 测试) | M | Chalk 主题辅助函数 + 尽力而为的按行前缀 diff 上色器 |
| B2 | `src/cli/gate-view.ts`(+ 测试) | M | 按门类型的纯 `GatePayload → string` 渲染,含 escalation banner |
| B3 | `src/cli/prompter.ts`(+ 测试) | M | `Prompter` 接口、真实的 `InquirerPrompter`、测试用 `FakePrompter` |
| B4 | `src/loop/runner.ts`(+ `runner.test.ts` 新增) | S | 新增 `getPendingInterrupt()`——唯一的 Loop 层改动(见 §5) |
| B5 | `src/cli/assemble.ts`(+ 测试) | L | `subscription` profile 的真实依赖图接线 + `resolveRejectThreshold()` + 硬性 profile 守卫 |
| B6 | `src/cli/run-loop.ts`(+ 测试) | L | 交互式 start/resume 循环,由 `FakePrompter`+`FakeAdapter` 支撑的测试 |
| B7 | `src/cli/main.ts`, `src/cli/bin.ts`(+ 测试) | M | argv 解析(`node:util.parseArgs`)、`start`/`resume`/`list` 分发、`SIGINT` 处理 |
| B8 | `src/cli.e2e.test.ts` | L | 硬核纵切:真实 cli-bridge fixture + 真实 `src/cli/main.ts` 分发 + `FakePrompter`,happy path + escalation path |
| B9 | `docs/ROADMAP.md`, `docs/PROGRESS.md`, `CHANGELOG.md`, `README.md` | S | 文档收尾(A5 那一行标为 done,README 的"Getting started"新增一个 `aeloop start` 示例) |

---

## 9. 我的判断调用(没有直接代码/文档证据——标注出来,不混进"已验证"部分)

1. **用 `node:util.parseArgs` 解析 argv,而不是用一个库**(`commander`/`yargs`)——这个仓库在这方面没有任何既有先例;之所以这么选,是因为指挥官"轻量、不上完整框架"的指示很自然地也延伸到了 argv 解析上,而且 Node 的内置模块对三个各带一个位置参数的子命令来说已经足够稳定、够用。
2. **`chalk@5.6.2` 和 `@inquirer/prompts@8.5.2`** 作为具体的库和大版本——通过 `npm view chalk version` / `npm view @inquirer/prompts version`(在本 PRD 调研期间执行的 registry 查询)核实了真实存在/是当前版本,并且对照 `@inquirer/prompts` 真实的 README(`raw.githubusercontent.com/SBoudrias/Inquirer.js/main/packages/prompts/README.md`,在本 PRD 调研期间抓取)核实了 `confirm()`/`select()`/`input()` 的确切签名——不是从训练记忆里回忆的。具体选 `@inquirer/prompts`(而不是更老、维护不那么积极的 `prompts@2.4.2`,同样核实过确实存在)是我自己的判断:它是 TypeScript 原生的、ESM-first 的(和本仓库 `"type": "module"`/`NodeNext` 的设置相符,不需要 interop 垫片),而且持续在发新版本。
3. **`workflow.db`** 作为 `AuditStore`+checkpointer 新的按 profile 划分的文件名(§3 第 5 点)——DESIGN §6 只命名了 `memory.db`;这是第一个需要给审计+checkpoint 文件一个永久(非临时目录)位置的增量,所以本 PRD 必须挑一个名字。`workflow.db`,作为 `profiles/<profile>/` 下 `memory.db` 的兄弟文件,已经被既有的 `*.db`/`.gitignore` 规则覆盖。
4. **`decidedBy: os.userInfo().username`**——`resumeRun()` 需要一个非空字符串标识是谁做的决策;现有惯例里没有一个"人类 CLI 用户的 `decidedBy` 值该是什么"的约定(测试代码永远用字面量如 `"test-harness"`)。OS 用户名是一个合理的、无需额外依赖的默认值;标注出来以防指挥官更想要一个提示输入姓名,或从 `.env` 读取。
5. **不加 `--cwd`/`--repo` 参数**(§3 第 1 点)——加起来成本不高,但既有的 adapter 代码里没有任何地方在子进程继承的默认值之外再多传一个工作目录,如果加了这个参数却不同时把它接到 `ClaudeCliAdapter`/`CodexCliAdapter` 的 `spawnWithTimeout` 调用里(目前没有这么做)——那就是一个静默什么都不做的参数——比没有它还糟。如果指挥官想要这个,可以作为一个小的、可拆分的后续项(会碰到 `harness/adapters/*.ts`,在本 PRD 声明的 `src/cli/` 范围之外)。

---

## 10. 验收标准

- [ ] `pnpm build && pnpm test && pnpm lint` 全部干净;既有 300 个测试仍然全绿,外加 §6/§5 每个文件对应的新测试。
- [ ] `node dist/cli/bin.js start "<task>"`(或 `npm link`/全局安装后的 `aeloop start "<task>"`)针对真实的 `subscription` profile 跑一轮真实的 coder/tester,并在真实终端里停在一个真实的交互式 G1 提示上——由人工冒烟测试验证(不只是自动化 e2e 切片),因为一个无头测试无法完全证明真实终端渲染的正确性。
- [ ] G1/G3 的 diff 渲染中,`+`/`-`/`@@` 行确实存在真实的 ANSI 颜色码(在 `gate-view.test.ts` 里通过对上色后子字符串的 `.includes()` 断言,而不只是断言一个剥离了控制字符的无色字符串)。
- [ ] G2 只提供两个选项(批准并送去修复 / 升级)——从不给第三个"reject"选项(针对 `gates.ts` 真实 `routeAfterG2` 契约的回归测试,补上 §0.1 的缺口)。
- [ ] Escalation 门的渲染输出在结构上能和普通门区分开(不只是"用了和 G1 不一样的 chalk 颜色"——一个 banner/边框,直接对它做断言)。
- [ ] `AI_AGENT_PROFILE=apikey aeloop start "..."` 以一个清晰的、类型化的 `UnsupportedProfileError` 消息失败——从不抛堆栈,也从不静默回落到 `subscription`。
- [ ] 在停在一个门提示处时杀掉进程(SIGINT),然后在**全新进程**里运行 `aeloop resume <runId>`,能正确续跑到完成——这是 A5 确实复用了 A4b 的跨进程 resume、而不是重新发明一套的具体证明。
- [ ] `aeloop list` 显示一个停在某个门上的 run,`currentState` 正确。
- [ ] 硬核纵切(B8)覆盖 happy path(G1→G3→apply)和一条 escalation 路径(reject-to-threshold→`ESCALATION_ACK`→`force_pass`→G3→apply),两者都通过真实的 `main.ts` 分发、用脚本化的 `FakePrompter` 驱动,都针对真实的 cli-bridge fixture 子进程(和 `src/loop.e2e.test.ts` 一样的 fixture 替身边界)。
- [ ] 除了 §5 那一处新增的、纯新增的 `runner.ts` 导出之外,`src/cli/**` 之外没有其它改动——复审时用 `git diff --stat` 对照本 PRD 声明的文件清单验证。
- [ ] 文档(`ROADMAP.md`/`PROGRESS.md`/`CHANGELOG.md`/`README.md`)按 B9 更新。
