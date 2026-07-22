# EvidenceBundle 真实证据链接线 — Scoping 提案

> **状态:待操作者确认。本文档只出方案,未实现任何代码,未 commit。**
> 承接 issue [#81](https://github.com/elishawong/aeloop/issues/81)(真实 run 几乎不填 `EvidenceBundle.claims[]`/`evidence[]`)。
> worktree:`aeloop-worktrees/evidence-wiring`(分支 `feat/issue-evidence-wiring`,基线 `origin/main` `750d12e`)。

---

## TL;DR 根因

一句话:结构化 claim **已经存在**——coder/tester 的 `CoderOutput.claims`/`TesterOutput.claims` 是真实产出,而且已经逐条落进 `structured_claims` 表——但从"引擎事件"到"`EvidenceBundle`"这段管线在两处被掐断:事件把 claim 内容压扁成一个数字(`claimCount`),`EvidenceBundleBuilder` 压根没有消费 `agent_completed` 事件里 claim 内容的代码路径。外加一个更深的模型层缺口:claim 本身不知道自己在回答哪条 requirement,就算前两处接上,`requirements[]` 覆盖率也翻不动。

**是"没接线",不是"schema 完全没结构"。**

---

## 证据链现状(逐跳,全部可追源)

1. **coder/tester 产结构化输出** — `src/prompt/schema.ts:42-64` `ClaimSchema`(`claimText`/`confidence`/`sourceRef`/`verifiedBy`/`toolsUsed`),`CoderOutputChanged`/`CoderOutputNoChange`/`TesterOutput` 都带 `claims: Claim[]`(`schema.ts:71-75,169-176`)。这一步是真的:两份 persona 文件(`profiles/subscription/personas/coder.md:12-21`、`tester.md:9-22`)确实要求模型标注 confidence/verifiedBy/toolsUsed,且明确"claim with no verification method behind it is not confirmed, say so"。

2. **落盘到 `structured_claims`** — `src/loop/runner.ts:645-658`(draft/coder)与 `687-700`(review/tester)把每条 claim 逐条 `audit.insertClaim()`,带 `toolExecChecked`(`ToolExecVerifier` 的机制化校验结果,`src/harness/tool-exec-verifier.ts:61-81`,不是模型自评)。**这条腿是活的,数据真实落盘。**

3. **事件把内容压扁成计数** — 同一处紧接着 emit 一个 `agent_completed`(`runner.ts:660-675` / `702-715`),但只塞了 `claimCount: coderOutput.claims.length`。`coderOutput.claims`/`testerOutput.claims` 的完整内容在 emit 时其实就在作用域里(第 645/687 行的 `for` 循环刚遍历过),但没有被塞进事件对象。`AgentCompletedEvent` 类型定义本身(`src/loop/events.ts:100-113`)也只声明了 `claimCount: number`,没有 claim 内容字段,也没有 tester `verdict` 字段。
   → **断点 1:内容在 emit 那一刻被主动丢弃。**

4. **投影层没有消费路径** — `EvidenceBundleBuilder.recordEvent()`(`src/evidence/bundle.ts:159-213`)是唯一在生产代码路径调用 `addClaim`/`addEvidence` 的地方(经 `EvidenceEventProjector.accept()` → `src/conductor-work/app.ts:52-61` `projectEvents()`,这是 `ConductorWorkApp` 里唯一构造 `EvidenceBundleBuilder` 的地方)。它对 `agent_completed` 事件唯一的处理分支是第 190-211 行:只在 `outcome === "no_change"` 时把 `noChangeReason`/`noChangeEvidence` 投影成一条 `passed:false, source:"model-reported"` 的 artifact evidence。**没有任何分支处理"有 diff 的 changed 结果"或"tester 的裁决"。**
   → **断点 2:就算断点 1 修好、内容真的塞进事件,这里也没有代码去消费它。**

5. **更深一层:claim 不知道自己对应哪条 requirement** — `ClaimSchema`(`schema.ts:42-64`)没有 `requirementIds` 字段。`renderTaskContract()`(`src/workflow/coder-tester.ts:56-64`)只是把 requirement id 塞进模型读到的**自然语言 prompt**(`- R1: <text>`),从未要求模型把 claim 标回某个 requirement id。而 `EvidenceBundleBuilder.addClaim()`(`bundle.ts:221-230`)恰恰是靠 `claim.requirementIds` 去翻转 `requirements[].status`(→`"verified"`/`"failed"`)的——没有这个字段,`requirements[]`/`unprovenItems` 就算 1-4 步全接上依旧翻不动,只有 `claims[]`/`evidence[]` 会被填出来。

结论与 run #38 观察一致(`claims: []`,evidence 只有 no_change artifact):三层断点叠加,产出一个几乎空壳的 `EvidenceBundle`。

---

## 应该在哪接(逐点)

### 接点 1 — 事件携带 claim 内容
- `src/loop/events.ts` `AgentCompletedEvent`:增量加可选字段 `claims?: readonly Claim[]`(`import type { Claim } from "../prompt/schema.js"`)、`verdict?: "pass" | "reject"`(仅 tester 侧有意义,来自 `testerOutput.verdict`)、`toolExecChecked?: ToolExecChecked`(来自 `coderResult`/`testerResult`,这两者已经带这个字段,`src/harness/types.ts:166`)。`claimCount` 保留不删(向后兼容)。
- `src/loop/runner.ts`:两处 `emitter.emit({ type: "agent_completed", ... })`(draft `660-675`、review `702-715`)沿用文件里已有的可选字段展开写法(`...(x === undefined ? {} : {...})`,`usage`/`latencyMs`/`noChangeReason` 已经这么写)追加 `claims`/`verdict`/`toolExecChecked`。数据本来就在作用域内,零新增 I/O。

### 接点 2 — `EvidenceEventProjector` 真的消费它
`src/evidence/bundle.ts` `EvidenceBundleBuilder.recordEvent()`,在现有 `no_change` 分支(190-211 行)旁边新增对 `agent_completed && event.claims` 非空的处理:
- **coder 侧**(`actor === "coder"`):每条 claim → 一条 `addEvidence()`,`kind` 按 `verifiedBy` 映射(`tool_execution`→`"tool"`、`human`→`"human"`、否则→`"source"`),`content: claim.claimText`,`source` 按下面的红线规则判定。
- **tester 侧**(`actor === "tester"`):tester 的 `verdict` 是"这一整轮"的裁决,不是逐条 claim 的裁决。MVP 方向:tester 轮 `agent_completed` 到达时,对**同一轮**(靠 `stepRef`/round 配对——draft→review 在这张图里严格顺序执行,`runner.ts` 已有类似"同一 tick 严格顺序"的既有假设可以复用)coder 报的每条 claim 调 `addClaim()`,`status = verdict==="pass" ? "supported" : "rejected"`,`evidenceRefs` 指向接点2 coder 侧刚建的 evidence id。tester 自己声称"我验证了什么"的 `claims[]` 同样各自 `addEvidence()`,作为独立证据项(不冒充 coder 的 claim)。
- 需要 `EvidenceBundleBuilder` 内部新增一点状态(记住"上一轮 coder 建的 evidence id 列表",供下一次 review 轮次引用)——具体实现细节留给 build 阶段设计,这里只定方向 + 标出正确性红线(见下)。

### 接点 3(可选,更深的洞)— claim 关联 requirement
- `src/prompt/schema.ts` `ClaimSchema`:加可选字段 `requirementIds: z.array(z.string().min(1)).optional()`。`ClaimSchema` 目前不是 `.strict()`,加可选字段不破坏现有 fixture/测试的解析。
- `profiles/subscription/personas/coder.md`/`tester.md`:house rule 加一句"如果这条 claim 是在回应某条 requirement,把它的 id 填进 `requirementIds`"。
- **不做这步**,接点1+2 依然能把 `claims[]`/`evidence[]` 填出来(issue 标题描述的症状直接解决),但 `requirements[].status`/`unprovenItems` 仍会像现在一样几乎不翻转(`addClaim()` 收到的 `requirementIds` 会一直是空数组)。这是本提案里唯一"做不做都能过 issue 验收,但做了才算完整解决"的一块,留给操作者拍板。

---

## 方案 + 批次

| 批次 | 大小 | 内容 | 触碰文件 | 正确性风险 |
|---|---|---|---|---|
| 批次1 | [S] | 接点1:事件携带内容 | `src/loop/events.ts`、`src/loop/runner.ts` | 低 — 纯增量字段,不改现有字段语义 |
| 批次2 | [M] | 接点2:投影消费 + builder 配对状态 | `src/evidence/bundle.ts` | **高 — 本 issue 的核心正确性红线在这批,见下节** |
| 批次3(可选) | [M] | 接点3:claim-requirement 关联 | `src/prompt/schema.ts`、`profiles/subscription/personas/{coder,tester}.md` | 中 — 改动模型可见的 schema/prompt,建议独立 PR,先看批次1+2 真实效果再决定要不要做 |
| 批次4(不建议现在做) | [L] | tester 逐条裁决(而非整轮裁决) | 需要 tester 侧 schema 大改(claim 需要稳定 id 供 tester 引用) + persona 改写 | 高且范围大 — 建议记为已知局限,写进 impact.md,不在本 issue 内做 |

验收锚点:
- 批次1:单测断言 `agent_completed` 事件对象上能读到 `claims`/`verdict`/`toolExecChecked`。
- 批次2:接一条真实/贴近真实的 `LoopEvent[]` 序列跑 `ConductorWorkApp.projectEvents()`,断言 changed 结果下 `claims[]`/`evidence[]` 非空,`source` 字段按红线规则分布(不能出现"model-reported 的东西被标 verified")。
- 批次3(如果做):`requirements[].status` 在一次真实 pass 裁决后翻成 `"verified"`,`unprovenItems` 相应变短。

---

## 最大正确性风险(红线)

`EvidenceSource`(`bundle.ts:34`,类型定义的 doc comment 本身就写明了这条红线)的核心承诺是:**`"verified"` 只能来自独立机制检查过,不能是模型自评**。`no_change` 分支已经是先例——即使模型自己说的是真的,`passed` 也强制 `false` + `source:"model-reported"`。批次2 必须严守同一条红线:

- 一条 claim 的 `EvidenceItem.source: "verified"` **当且仅当** `claim.verifiedBy === "tool_execution"` **且** `toolExecChecked === "pass"`(独立机制 `ToolExecVerifier` 真的确认过,不是模型自称"我跑了工具"就算数)。
- 其余全部情况——`verifiedBy: "human"`、`"unverified"`、缺失,或 `verifiedBy: "tool_execution"` 但 `toolExecChecked` 是 `"fail"`/`"na"`——一律 `source: "model-reported"`,哪怕模型自己把 `confidence` 填成了 `"verified"`(`ClaimConfidence` 是模型自报的置信度,和 `EvidenceSource` 是否被独立机制查过,是两个不同维度,不能互相替代)。
- **tester 的 `verdict: "pass"` 本身也是模型输出**——不能因为 tester "过了"就把 coder 的 claim 提升成 `source: "verified"`。`EvidenceClaim.status: "supported"`(裁决结果)和 `EvidenceItem.source: "verified"`(是否被独立机制查过)是正交的两个维度:一条 claim 完全可能 `status: "supported"`(tester 认可)同时 `source: "model-reported"`(没有工具执行独立验证过)。批次2 实现和 Zorro 审查时要重点盯住这条,别把两个维度混成一个。
- 次要风险:批次2 引入的"记住上一轮 coder evidence 供 tester 轮次引用"的 builder 内部配对状态,依赖"draft→review 严格顺序、一轮对一轮"的既有假设。如果未来某个 workflow 变体打破这个假设(比如并发多轮),配对逻辑可能静默配错。建议实现时加显式防御:round 对不上就不建 claim(fail-closed,而不是硬凑出一个可能错误的关联)。

---

## 和 #80(brain spike)的关系

- #80(`docs/conductor-brain-layer/DESIGN.md`,尚未出 PRD,未开始实现)范围是新建 brain/MemoryStore 相关文件,读取 `EvidenceBundle` 做"经三态门折回记忆"。
- 本 issue 改动的文件(`src/loop/events.ts`、`src/loop/runner.ts`、`src/evidence/bundle.ts`,视批次3 是否做还可能加 `src/prompt/schema.ts` + 两份 persona md)和 #80 大概率新建的文件(`src/conductor-work/` 下新文件或新 `brains/` 目录)**没有重叠 —— 可以并行,不互相阻塞**,与 issue #81 正文"关系"一节的判断一致。
- 但存在一条单向的"效果依赖"值得指出(不是文件冲突,是顺序建议):#80"把 confirmed 证据折回记忆"这一步,天然需要 `EvidenceBundle` 里真的有非空 `claims[]`/`evidence[]` 才有东西可折——如果 #80 先跑、#81 批次1+2 还没落地,#80 spike 观察到的"证据折回"效果会和 issue #81 描述的现状一样弱(只有 no_change artifact 可折)。建议:**批次1+2 先合并,再让 #80 的垂直切片跑真实 run**,这样 #80 观察到的记忆折回效果才有代表性。不构成硬阻塞,只是顺序上更省一轮返工。

---

## 待操作者确认的关键决策点

1. 批次3(claim-requirement 关联)要不要在本 issue 内一起做,还是先只做批次1+2、批次3 拆成后续 issue?
2. 批次2 里"tester 整轮 verdict → 该轮全部 coder claim 同一 status"这个粗粒度近似,是否可接受作为 MVP(逐条裁决是批次4,范围明显更大)?
3. 是否同意"批次1+2 先于 #80 落地"的顺序建议?
