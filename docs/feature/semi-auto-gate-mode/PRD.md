# PRD — aeloop #63: `workflow.gate_mode: "manual" | "semi-auto"`

> 防幻觉:`[?]` = 我未验证 / 需指挥官确认;不编造接口/版本/参数。本 PRD 里所有关于既有代码的陈述都来自我亲自读过的真实代码(`src/cli/{run-loop,assemble}.ts`、`src/profile/loader.ts`、`src/loop/{runner,gates,workflow-def,audit-store}.ts`)+ `gh issue view 63 --repo elishawong/aeloop`(在本 PRD 自己的调研过程中现查的,不是凭记忆),不是凭记忆写的。这份文档是**在代码写完之后**才写的(Cypher 平时"先 PRD 后代码"的顺序这次反过来了:先实现了开关,Zorro 的独立复审随后发现这个功能对一个安全敏感行为零文档——那轮复审的 blocker 1——这份 PRD 就是那个缺口的直接补救,是对着真实的、已经实现的代码写的,不是前瞻性设计)。

- **Project**: aeloop(`elishawong/aeloop`,私有仓库)
- **Branch**: `feature/semi-auto-gate-mode`(worktree:`aeloop-worktrees/gate-mode`)
- **Priority**: P1(按 issue label)
- **Status**: 已实现,正在处理 Zorro/Codex 独立复审的 FAIL(2 个 blocker + 1 个加固要求);尚未 commit
- **Last updated**: 2026-07-22
- **Related issue**: [elishawong/aeloop#63](https://github.com/elishawong/aeloop/issues/63)
- **Design authority**: issue #63 本身的正文(通过 `gh issue view 63` 拉取,§1 里逐字引用)+ `src/cli/run-loop.ts`、`src/cli/assemble.ts`、`src/profile/loader.ts` 里的真实代码。issue #63 正文里为一个"auto-until-threshold"模型引用了"Design doc §5.2"——**我在 `docs/DESIGN.md` 里没找到 §5.2**(那份文件根本没有 `###` 级子章节;它自己的 §5 是"DB schema",跟 gate 自动化无关),`docs/` 下其他文件里也没有。标为 `[?]`——要么是 issue 写完之后文档结构变了、引用没跟上,要么是指向仓库之外的东西(比如某份 pitch deck)。不管哪种,对本 PRD 都不是 load-bearing 的:issue 正文自己的"What"/"Constraints" 两节讲得很清楚,实现实际跟的就是这两节。

---

## 1. 问题 / 用户 / 方案

**要解决的问题**(issue #63,逐字引用):
> Current interactive CLI gates every step (high-touch). For real productivity + the pitch demo, the intermediate revision cycles should run autonomously, surfacing to the human only for final apply + when stuck.

A5 CLI(`src/cli/run-loop.ts` 的 `runInteractiveLoop()`)里的每一个 gate,不管哪个 profile,都无条件地通过 `Prompter` 真人过问,四种 gate 类型(G1/G2/G3/Escalation)全都一样。对一个要 reject-retry 好几轮、最后要么通过要么撞上 reject 次数阈值的 coder→tester 修订循环来说,这意味着每一次往返都要人坐着批一遍——即便 G1("把 coder 的草稿发给 tester")和 G2("把 tester 的发现打回给 coder 修")对大多数 run 来说根本没有真正的判断含量,只是"是的,继续跑"的橡皮图章;真正值得人看的只有**最终**的 diff(G3)和循环卡住的场景(Escalation)。

**这是给谁用的**:指挥官,跑 `aeloop start`/`resume` 做正式工作或 pitch demo,希望 coder↔tester 循环能自己跑完正常的来回,只在真有事要决定的时候才被拉进来。

**一句话方案**:`config.yaml`(`profile/loader.ts` 的 `ProfileConfig.workflow`,在 load 时做 fail-closed 校验)里新增一个 `workflow.gate_mode: "manual" | "semi-auto"` 字段,只在一处被消费——`run-loop.ts` 的 `runInteractiveLoop()`——在 `"semi-auto"` 下,G1/G2 用一个合成的 `{decision:"approved"}` 自动批准,记在一个独立的系统 `decidedBy` 字符串下,而 G3 和 Escalation 在结构上被排除在自动批准之外(一个固定的、封闭的集合,不是从 config 推导出来的),外加一个守护自动批准路径的运行时防御性断言(§5)。

## 2. 目标

1. `workflow.gate_mode` 这个 config key:`"manual"`(默认值,包括 key/`workflow` 块整个缺失的情况)或 `"semi-auto"`。任何其他值都 fail closed——`profile/loader.ts` 在 load 时抛出 `ProfileConfigParseError`,绝不悄悄回落到默认值,也绝不悄悄忽略(`profile/loader.ts:~34-56`)。
2. 在 `"semi-auto"` 下:G1(`GATE_TYPES.G1_SEND_TO_TESTER`)和 G2(`GATE_TYPES.G2_SEND_TO_FIX`)完全跳过 `Prompter` 调用,直接以 `{decision:"approved"}` resume,记进审计轨迹(`approvals.decided_by`),用的是字面字符串 `"system (semi-auto)"`——绝不是调用 `runInteractiveLoop()` 时传入的那个真人 `decidedBy` 值。这是 issue #63 自己的约束:"Gate decisions must still be auditable (log auto-approvals with actor=system/semi-auto)."
3. **G3(`G3_FINAL_MERGE`)和 Escalation(`ESCALATION_ACK`)在任何模式下都始终保持人工,没有任何 config 开关能改变这一点。** 这是 `gate_mode` 永远不能覆盖的唯一安全不变量——见 §3。
4. `"manual"`(或该 key 缺失)跟这次改动之前 `runInteractiveLoop()` 走的代码路径一字不差——任何没有主动选用这个新模式的 profile 都不会有行为变化(issue #63 自己的约束:"Default `manual` → all 594 tests stay green")。
5. 侵入面最小的接入点:只有 `run-loop.ts` 会根据 `gate_mode` 分支(issue #63 自己的约束:"likely run-loop / prompter layer, not the graph")。`loop/graph.ts`/`loop/gates.ts` 不做任何改动,也完全不知道这个开关的存在——从 `resumeRun()` 的视角看,一次 semi-auto 自动批准和一次人工批准没有区别,唯一的差异是 `decided_by` 里落的是哪个字符串。

## 3. 安全边界(这个功能里 load-bearing 的那部分)

这是对四个 gate 里两个的人工审核**移除**——动的是一个专门用来保证有人在编码 agent 的输出往下走之前先看一眼的控制点。设计里刻意保留了三层独立的防线,防止自动批准错误的东西:

1. **封闭白名单,不是黑名单。** `run-loop.ts` 的 `AUTO_APPROVABLE_GATES` 是一个固定的 `Set([GATE_TYPES.G1_SEND_TO_TESTER, GATE_TYPES.G2_SEND_TO_FIX])`——一个硬编码的、封闭的 2 元素集合,不是从 4 值的 `GateType` union 里"除了 G3/Escalation 之外全都算"这样算出来的。将来万一新增第五种 gate 类型,默认会**不**可自动批准,除非有人显式把它加进这里。
2. **`reject_threshold` fail-closed 校验**(`cli/assemble.ts` 的 `resolveRejectThreshold()`,见下面 §5.2):reject 次数升级到 Escalation 的安全网,保证一个卡住的 semi-auto 循环最终还是能到达人工,靠的是 `rejectCount >= rejectThreshold`(`loop/runner.ts:725`)最终为真。一个格式错误的 `reject_threshold`(比如 YAML 的 `.nan`/`.inf` tag)绝不能让这个比较永远为假。
3. **防御性 gate 身份断言**(`run-loop.ts`,见下面 §5.1):在自动批准之前,交叉核对 `workflow_runs.current_state`(DB 持久化的状态)是否真的独立同意 `interrupt.gate`(CLI 层即将据以行动的值)真的是 G1 或 G2,而不是 G3/Escalation。走真实的 `startRun()`/`resumeRun()` 代码路径应该不可能触发这个分支(两个值最终都来自同一次 `computeRunProgress()` 调用),但自动批准这件事安全敏感到不能只信一个信号源——这个断言 fail closed(抛异常),不是只信 `interrupt.gate` 一家之言。

不做的事:本 PRD 不加 `--gate-mode` CLI flag(只走 config,和其他所有 `workflow.*`/`harness.*` 开关的既有先例一致),不改 `resumeDecisionsFor()` 每个 gate 的决策域(`loop/runner.ts`,未改动),也不加第三档 gate_mode(比如"连 G3 都自动"的全自动档)——issue #63 没提这个要求,而且会违反 §3 的安全边界。

## 4. 实际上线了什么(实现,写在这份 PRD 之前就已经写完了)

### 4.1 `src/profile/loader.ts`
- `ProfileConfig.workflow.gate_mode?: "manual" | "semi-auto"` —— 既有 `workflow` 块上新增的可选字段(和 `reject_threshold` 是兄弟字段)。
- `assertProfileConfigShape()` 新增一个 fail-closed 检查:如果 `workflow` 是个普通对象且 `workflow.gate_mode` 存在但既不是 `"manual"` 也不是 `"semi-auto"`,抛 `ProfileConfigParseError`(和同一函数里既有的 `profile`/`providers`/`roles` 形状检查手法一致)。

### 4.2 `src/cli/run-loop.ts`
- `AUTO_APPROVABLE_GATES: ReadonlySet<GateType>` —— 封闭的 `{G1_SEND_TO_TESTER, G2_SEND_TO_FIX}` 集合(§3.1)。
- `AUTO_APPROVABLE_DB_STATE: Record<string, string>` —— 把那两个 `GateType` 值分别映射到对应的 `LOOP_NODES`(`"g1"`/`"g2"`),只给 gate 身份断言用(§5.1)。
- `SEMI_AUTO_DECIDED_BY = "system (semi-auto)"` —— 独立的审计轨迹标记(目标 2)。
- `runInteractiveLoop()`:每次调用只读一次 `deps.profileConfig.workflow?.gate_mode ?? "manual"`(不是每个 gate 读一次——`gate_mode` 是每次 run/每个 profile 的设置,循环中途不会变)。循环内部,当 `gateMode === "semi-auto" && AUTO_APPROVABLE_GATES.has(interrupt.gate)` 时:先跑 gate 身份断言(§5.1),往终端打印一条明确的 `[semi-auto] auto-approved — <gate>` 横幅(这样即便没被问,旁边看着的人也能看到发生了什么),然后以 `{decision:"approved"}`、`SEMI_AUTO_DECIDED_BY` 身份 resume——完全跳过 `Prompter` 调用。其他所有 gate(包括 `"manual"` 模式下的 G1/G2,以及始终不变的 G3/Escalation)走的还是原来那条 `decideForGate()` → `Prompter` → `resumeRun(..., decidedBy, ...)` 路径,没有改动。

### 4.3 测试
- `src/profile/__tests__/loader.test.ts`:`gate_mode` 接受的值(`"manual"`/`"semi-auto"`/缺失)、拒绝的值(fail-closed `ProfileConfigParseError`)。
- `src/cli/__tests__/run-loop.test.ts`:semi-auto happy path(G1/G2 自动批准,G3 仍然会问,`decided_by` 每个 gate 都归属正确——用真实的 `LoopEventEmitter` 观察到的 `gate_decided` 事件,不是 mock 出来的)、semi-auto 走到 Escalation(即便在 semi-auto 下也仍会问人)、显式 `"manual"` 和缺失时行为一致,以及(这一轮新加,见 §6)gate 身份不一致的测试。

## 5. Zorro/Codex 独立复审 —— FAIL,以及这一轮的修复

独立复审(Zorro + Codex 跨模型二签)认为实现本身在 gate 路由逻辑上是对的,但判了 2 个 blocker + 1 个加固建议:

### 5.1 Blocker —— gate 身份断言(加固项,这一轮已完成)
**发现**:semi-auto 分支仅凭 `interrupt.gate`(一个从 `computeRunProgress()` 一路传下来的值)来决定要不要自动批准,然后无条件发出 `{decision:"approved"}`。没有任何环节在动手之前把这个值和 DB 持久化的 `workflow_runs.current_state` 做交叉核对。具体来说:`resumeRun()` 自己既有的 domain 检查(`resumeDecisionsFor(run.currentState).includes(resume.decision)`,`loop/runner.ts:1078-1079`)**抓不住** G1/G2 和 G3 混淆的情况,因为 `"approved"` 对 G1 和 G3 的 domain(`["approved","rejected"]`)来说**都**合法——所以如果 `interrupt.gate` 和 `current_state` 真的不一致(理论上真实代码里不可能触发,因为两者都来自同一次读取),一次自动批准就可能打到 G3 而不被这道既有防线拦下来。
**修复**:在 `run-loop.ts` 的 semi-auto 分支里加了一个 2 行断言——`deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]` → 抛异常,放在构造自动批准 resume 值之前。测试:`src/cli/__tests__/run-loop.test.ts`,`"refuses to auto-approve when workflow_runs.current_state disagrees with interrupt.gate"`——通过对同一条 run 记录再开一个独立的 `better-sqlite3` 写连接(和 `loop/__tests__/runner.test.ts` 已经在用的读侧 DB 断言技巧一样)强行制造不一致,然后断言 `runInteractiveLoop()` 会拒绝并报一个 gate-identity-mismatch 错误,`Prompter` 一次都没被调用过。

### 5.2 Blocker —— `reject_threshold` fail-closed 校验
**发现**:`cli/assemble.ts` 的 `resolveRejectThreshold()` 只要 `profileConfig.workflow.reject_threshold` 是 `typeof === "number"` 就直接接受,没有更进一步的校验——不像它的兄弟函数 `resolveSchemaMaxAttempts()`(同一个文件)已经用 `Number.isInteger(fromProfile) && fromProfile >= 1` 守住了。一个 YAML 的 `.nan`/`.inf` tag 会被解析成真正的 JS `NaN`/`Infinity`(`typeof` 是 `"number"`,但不是整数),这样的值会原样从三层链的第一层被返回。后果:`loop/runner.ts:725` 的 `rejectCount >= rejectThreshold` 升级检查在一个 `NaN`/`Infinity` 的阈值面前永远不可能为真——悄悄废掉了整个"reject 次数升级到 Escalation"的安全网,而 §3 里 semi-auto 的安全边界恰恰依赖这道网在循环卡住时还能到达人工。
**修复**:`resolveRejectThreshold()` 现在套用和 `resolveSchemaMaxAttempts()` 一模一样的 `Number.isInteger(fromProfile) && fromProfile >= 1` 守卫(原样照抄,不是新模式)——一个非法的第一层值现在会落到第二层(`SystemConfig.getDefaultRejectThreshold()`)/第三层(硬编码的 `2`),和这个函数本来就有的三层 fallback 设计一致(已有一个测试证明非数字值就是这么落下去的;这一轮把同样的落空行为扩展到 `NaN`/`Infinity`/负数/零/非整数——这些值之前被**错误地**当成合法的第一层值)。测试:`src/cli/__tests__/assemble.test.ts`,`it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` 全部落到第二层,外加一个回归测试确认一个真正合法的 `reject_threshold: 1` 在第一层仍然被接受(证明这道守卫没有矫枉过正)。

### 5.3 Blocker —— 一个安全敏感功能零文档(这份文档)
**发现**:`run-loop.ts`/`loader.ts` 的文档注释都引用了"the PRD's explicit requirement"来说明为什么 G3/Escalation 保持人工,但仓库里 issue #63 根本没有任何 PRD——对一个安全敏感的行为(自动批准人工审核 gate)来说,这是一处悬空引用。防幻觉政策把一条无法验证的"per the PRD"引用视为幻觉风险,不管底下的代码本身对不对。
**修复**:这份文档(`docs/feature/semi-auto-gate-mode/PRD.md`),外加更新两处悬空引用的落点(`run-loop.ts` 的文件头 + 它的 `AUTO_APPROVABLE_GATES` 文档注释,`loader.ts` 的 `gate_mode` 字段文档注释),把"the PRD"这种不加限定的说法改成指向这里,再加一个新的 `docs/DESIGN.md` 里的 `workflow.gate_mode` 小节(这份仓库权威设计文档,已经在同一个 `config.yaml` 示例块里记录了 `workflow.reject_threshold`)链回这份 PRD。

## 6. 验收标准

- [x] `workflow.gate_mode` 缺失或 `"manual"` → 零行为变化(既有测试原样保持全绿)。
- [x] `workflow.gate_mode: "semi-auto"` → G1/G2 自动批准,不调 `Prompter`,`decided_by = "system (semi-auto)"`。
- [x] G3/Escalation 在任何模式下都始终问人——包括 semi-auto 的循环走到 Escalation 的时候。
- [x] 非法的 `gate_mode` 值 → profile load 时抛 `ProfileConfigParseError`,不是悄悄落回默认值/忽略。
- [x] `reject_threshold` 对 `NaN`/`Infinity`/负数/零/非整数 fail-closed(这一轮 blocker 2 的修复)。
- [x] semi-auto 自动批准路径里有防御性 gate 身份断言,并且有测试证明它真的会触发(这一轮的加固修复)。
- [x] `src/` 下不再有悬空的"per the PRD"引用(`grep -rn "per the PRD" src/` 只剩真实存在的 A5 `docs/feature/a5-cli-tui/PRD.md` 的引用)。
- [ ] `pnpm lint && pnpm build && pnpm test` 全绿——最终数字见 `progress.md`。
- [ ] Zorro 复审(这一轮)—— PASS。
- [ ] 指挥官批准 → commit/push(不是 Cypher 自己做)。
