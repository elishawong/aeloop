# PRD — Conductor 层 MVP(issue #2,对话协调 + 多 workflow 实时看板)

- **项目**: aeloop(`elishawong/aeloop`,private repo)
- **分支**: `feature/issue-2-conductor-mvp`(原始 cut 基线 `origin/main` @ `13c2bf1`;**#106 已于
  2026-07-24 merge 到 origin/main(`1e36531`),本分支已 rebase + reconcile,当前 HEAD = `1e36531`**)。
- **优先级**: P0(指挥官点名的 MVP 头号亮点)
- **状态**: 指挥官已确认方向 + §9 关键决策;Zorro R1 = FAIL(6 blocker + 7 yellow 已修)→
  Zorro R2 = FAIL,离 PASS 很近(2 个小 blocker + #106 rebase/reconcile + 4 个低优先级 yellow
  已修)→ **Zorro R3 = FAIL(纯文档自相矛盾,零代码问题,本轮零代码改动,只做文档一致性 sweep)**,
  详见 `progress.md`"Zorro R3 返工"一节。
- **最后更新**: 2026-07-24(Zorro R3 文档一致性 sweep)
- **关联 issue**: [elishawong/aeloop#2](https://github.com/elishawong/aeloop/issues/2)(本 PRD 覆盖的
  需求)、[#106](https://github.com/elishawong/aeloop/issues/106)(**指挥官已确认与 batch 1 并行,
  非 CLI demo 阻塞项,但会与本分支产生真实合并冲突,见 DESIGN §2.3/§9.3**)、
  [#31](https://github.com/elishawong/aeloop/issues/31)(**开放风险**:candidate-only 今天只是
  prompt/契约层约束,非运行时机械强制,见 DESIGN §1.5)、#75/#80/#93(既有实现,大量复用)。
- **设计权威**: `docs/conductor-mvp/DESIGN.md`(本 PRD 是它的可执行拆解,不重复架构论证,只做
  逐文件任务清单 + 批次拆解 + 验收标准;每条任务的"为什么这么设计"去 DESIGN 对应章节找)。
- **防幻觉声明**: 本 PRD 引用到的每一个类型/方法签名都逐条读过 aeloop 当前源码(路径已列出),
  不是转述 DESIGN 或凭记忆;`[?]` = 未能独立核实,不编接口/字段/版本号。

---

## 0. 范围声明(摘要 DESIGN 关键结论,不重复整份基线表)

1. **派发闭环的核心机制已存在并被证明过**(`run-spike.mjs`/`dispatch-brain-task.mjs`)——本 PRD
   batch 1 是"把它接进一个真实会话会主动触发的入口",不是从零建闭环。
2. **多 run 注册表已存在并被生产 CLI(`aeloop list`)使用**(`AuditStore.listRunsByStatus()`)——
   看板 batch 1/2 是"给它一个 web 面 + 阶段标签映射",不是新造事件总线。
3. **Cardinality 已核实**:今天 1 个 `TaskContract` → 1 个 workflow(= 1 行 `workflow_runs`)→ N 个
   node,**不支持**一句意图自动拆成多个并行 workflow(DESIGN §3.0)。看板的"多 workflow"来自"多次
   派发各自一行"。
4. **4 项必须修正里,①②在引擎层已满足、对话层未接线;③未建;④是 `[?]`**(DESIGN §5)——本 PRD
   batch 0 先核实④,batch 3/4/5 补齐对话层接线,batch 1/2(本 PRD 重点)完全不触碰这 4 项。

---

## 1. 问题 / 用户 / 方案

**问题**:用户(指挥官/未来企业开发者)想要"说一句话就派发一个真实的、有独立复核的工作任务",且想
"一眼看清现在有几个任务在跑、各自到哪一步"。今天两件事都得靠手动敲命令行脚本(`dispatch-brain-task.mjs`)
和读一个 fixture-only 的 demo 页面(`conductor-work/ui/`),不成一条可演示的产品体验。

**用户**:MVP demo 的直接观众是指挥官/企业侧决策者;长期用户是有自己开发者的企业客户
(DESIGN §6"企业 profile"）。

**方案**:①新建一层薄的"派发胶水"(复用已验证的库调驱动序列,不重新发明),接入会话触发;②扩展
现有 `conductor-work/ui/` 成一个真读 `workflow.db` 的多 run 看板,总览优先、详情随后。

---

## 2. 目标 / 非目标

### 2.1 目标(batch 0-2,本 PRD 主体范围)

- G1. 用户在会话里说一句自然语言意图,系统自动完成"翻译→派发→coder/tester 独立复核→候选+证据",
  停在 G3 前,不需要用户手动敲任何命令行。
- G2. 一个 web 看板能同时列出"当前有哪些 workflow 在跑",每行显示:当前阶段标签、loop 次数、coder
  是否完成过一轮(`coderRoundCompleted`,build 时从"是否已有候选 diff"改名,见 §3)——不需要
  fixture,数据来自真实 `workflow.db`,且对它**物理只读**(`AuditStore` 只读模式,Zorro R1 blocker
  B2)。
- G3. 点开一行 run,能看到该 run 的完整节点历史 + 候选 diff + EvidenceBundle(只读,batch 2)。
- G4. 全程不违反 candidate-only(不写候选到工作区/不 apply/不 git write)既有红线——**这条红线
  今天只在 prompt/契约层生效,不是运行时机械强制(#31 开放风险,DESIGN §1.5),demo 因此只在
  aeloop 自己仓库内跑**。

### 2.2 目标(batch 3-5,本 PRD 一并给出批次拆解,但非本轮 build 的默认范围——待指挥官排期确认)

- G5. 用户能对着看板/对话打 `approve`/`reject`/`stop`,系统用确定性代码解析(不经 LLM)驱动真实
  `resumeRun()`(修正①②)。
- G6. 对话交换本身(用户说了什么、系统回了什么)持久化进身份库 `memories` 表(修正③)。
- G7. 新增一个 conductor 角色只需要往 registry 丢 schema,不改 composer(修正④,视 batch 0 核实
  结果确定具体范围)。

### 2.3 非目标(明确不做,呼应 DESIGN §8)

- ❌ 不做"一句意图自动拆成多个并行 workflow"(orchestrator 意图分解能力)——DESIGN §3.0/§7.6。
- ❌ 不做"cwd 透传到真实目标项目"——coder/tester 只在 aeloop 自己仓库内的沙箱路径操作,Level 1
  约束原样继承(DESIGN §1.3 第 5 点)。
- ❌ 不重新设计 `translateIntent()` 的 NLP 质量(DESIGN §7.4)。
- ❌ 不做看板实时推送(WebSocket/SSE)——batch 1-2 用轮询(DESIGN §3.4)。
- ❌ 不做看板"当前挂起中(未决策)那一轮"的候选 diff 展示——已知缺口,留 `[?]`(DESIGN §3.2/§9-8)。
- ❌ 不做确定性意图分类器(DESIGN §7.2)。
- ❌ 不新建/不清理 `gate-controller` 半成品。
- ❌ 不做审批按钮的真实接线(现有 fixture 页面 Approve/Reject"只改本地显示"这条既有行为在 batch
  1-2 保持不变)。

---

## 3. 数据模型

### 3.1 复用的既有类型(不新增字段,只读引用——逐条核实签名)

| 类型 | 来源 | batch 1-2 用到的字段 |
|---|---|---|
| `TaskContract` | `src/conductor/types.ts:28-38` | 全部(`translateIntent()` 产出) |
| `WorkflowRun` | `src/loop/audit-store.ts:51-64` | `id`/`task`/`workflowDefId`/`profile`/`status`/`rejectCount`/`currentState`/`createdAt`/`updatedAt` |
| `StepMarker`(经 `listStepRefsByRun()`) | `src/loop/audit-store.ts:181-189` | `stepRef`(推导轮次) |
| `Approval` | `src/loop/audit-store.ts:110-141` | 未直接使用(见下方 build 时订正——`AuditStore` 无按 runId 查完整 `Approval` 行的公开方法,改用 `StepMarker` 判据) |
| `EvidenceBundle` | `src/evidence/bundle.ts:104-131` | batch 2 详情页用(`requirements`/`claims`/`evidence`/`usage`);batch 1 的 `dispatch-conductor-task.mjs` 也直接消费 `claims`/`evidence`/`requirements`(Zorro R1 blocker B5) |

### 3.2 新增类型(batch 1-2 净新增,纯函数/接口,不改任何既有 schema)

> **⚠️ build 时对本节的两处订正(均已在 `progress.md`/`impact.md` 记录,不是隐瞒)**:
> ① 共享核心实际落点是 `scripts/lib/conductor-dispatch-core.mjs`(plain JS),不是下面原写的
> `src/conductor-work/dispatch.ts`——放进 `src/` 会破坏 `docs/conductor-brain-layer/spike-PRD.md`
> §0 已定的"spike 层代码不升级进 `src/`"边界(PRD §9.2 本就授权 build 阶段按实际代码形状判断)。
> ② `hasCandidateDiff`(判据:是否存在已决策 `Approval.diffRef`)在 build 时发现不可行——
> `AuditStore` 没有公开的"按 runId 查完整 `Approval` 行"方法,新增等于改动核心引擎持久化层,
> 超出 batch 1"不碰核心引擎"的风险控制范围;且这个字段名本身在 `no_change` 场景下会误报（coder
> 判定不需要改动时也会有 `draft#1` 这个 step_ref，旧字段名会暗示"有 diff"但根本没有）。改名为
> `coderRoundCompleted`,判据改用已有的 `listStepRefsByRun()` 返回的 `draft#N` 存在性
> (Zorro R1 blocker B4 + yellow①)。下面的类型定义已更新为 build 后的真实形状。

```ts
// scripts/lib/conductor-dispatch-core.mjs 里 toBoardRow() 组装出的形状,类型定义实际在
// src/conductor-work/board.ts(新建,batch 1,真实 TypeScript 源文件)

/** WorkflowRun.currentState → 看板阶段标签,纯函数(DESIGN §3.5,key 集合直接从 LOOP_NODES 派生)。 */
export type BoardPhase =
  | "coder_drafting" | "waiting_g1" | "tester_reviewing" | "waiting_g2"
  | "waiting_g3" | "escalated" | "completed" | "completed_no_change" | "cancelled" | "unknown";

export function phaseLabelFor(currentState: string, status: WorkflowRunStatus): {
  phase: BoardPhase;
  label: string; // 人类可读,如 "等待 G1(送审)"
};

/** 一行看板总览数据(batch 1,GET /api/runs 的元素类型)。 */
export interface BoardRow {
  readonly runId: number;
  readonly task: string; // WorkflowRun.task,已经是 renderTaskContract() 产出的可读文本
  readonly profile: string;
  readonly phase: BoardPhase;
  readonly phaseLabel: string;
  readonly loopCount: number; // 优先用 listStepRefsByRun() 精确计数,退化到 rejectCount
  readonly coderRoundCompleted: boolean; // 近似判据:是否存在至少一条 draft# step_ref(不等于"有已决策 diff")
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

```ts
// scripts/lib/conductor-dispatch-core.mjs(新建,batch 0——§7.3 方案 B 抽取出的共享核心,
// build 时从原定的 src/conductor-work/dispatch.ts 改落点,见上方 build 订正说明)

export interface ConductorDispatchResult {
  readonly contract: TaskContract;
  readonly contractPath: string;
  readonly runId: number | null;
  readonly threadId: string | null;
  // Zorro R1 blocker B5:diffRef 补上——不只是"停在哪个 gate",还要能说出"这一轮候选实际改了
  // 什么"。这份文本只在进程内存里,一旦决策落地就会持久化进 approvals.diff_ref(那是另一条路径,
  // 见 DESIGN §3.2 表格第 4 行的订正说明)。
  readonly pendingGate: { readonly gate: string; readonly question: string | null; readonly diffRef: string | null } | null;
  readonly done: boolean;
  readonly evidenceBundle: EvidenceBundle;
  readonly gateResults: readonly { evidenceId: string | null; memoryId: number; source: string; confirmed: boolean }[];
  readonly runError: Error | null;
}

/** 共享核心:翻译 → 库调驱动(自动批 G1/G2,停 G3/Escalation 前)→ 折回。
 *  不要求项目注册——`dispatch-brain-task.mjs` 的 `--project` 语义在这之上包一层薄壳(§7.3 方案 B)。
 *  不含 cwd 保护/互斥锁——那是多项目 CLI 场景特有的并发保护,调用方各自决定要不要加。 */
export function runConductorDispatch(
  rawIntent: string,
  ctx: { readonly store: MemoryStore; readonly assembleDeps?: (profileName: string, env: NodeJS.ProcessEnv) => Promise<unknown> },
  opts?: { readonly allowedPaths?: string[]; readonly objectivePrefix?: string; readonly contractDir?: string; readonly profile?: string; readonly decidedByLabel?: string },
): Promise<ConductorDispatchResult>;
```

**不新增任何持久化 schema**——`BoardRow`/`ConductorDispatchResult` 都是纯内存态的投影/返回值类型,
不新建数据库表、不改 `workflow.db`/身份库既有 schema。`dispatch-conductor-task.mjs`(CLI 入口)在
这之上再做一层"经大小限制的候选摘要 + claims/evidence 真实内容"格式化(Zorro R1 blocker B5),不
在共享核心里做截断——截断策略是"展示给谁看"这一层的关注点。

---

## 4. 逐文件任务清单(按批次分组)

### Batch 0 — 核实 + 基础重构 [S]

| 文件 | 改动 | 依赖 |
|---|---|---|
| `docs/conductor-mvp/progress.md`(已存在,追加) | 记录 batch 0 核实结果:①`src/harness/` composer/registry 现有覆盖程度(修正④范围核实,输出结论:能不能直接加 conductor 角色/需要改哪些文件,给 batch 5 排期用,不实现④本身) | 无 |
| `scripts/dispatch-brain-task.mjs` | 重构:把"翻译→库调驱动→折回"这段核心逻辑抽到共享核心（见下一行）,本文件改为调用 `runConductorDispatch()` + 包一层 `--project` 校验/tag 逻辑(cwd 互斥锁/chdir 逻辑保留在本文件,因为那是"多项目 CLI 调用"场景特有的并发保护,不属于共享核心) | 无 |
| `scripts/lib/conductor-dispatch-core.mjs`(新建,**build 时落点从原定 `src/conductor-work/dispatch.ts` 改为这里**——放进 `src/` 会破坏 spike 层代码不升级进 `src/` 的既有边界,PRD §9.2 已授权 build 阶段按实际代码形状判断) | `runConductorDispatch()` 共享核心(§3.2 类型定义),从 `dispatch-brain-task.mjs`/`run-spike.mjs` 已验证的调用序列提炼(assembleProfileDeps → planRun → startRun → 自动批 G1/G2 → 停 G3/Escalation 前 → projectEvents → applyThreeStateGate) | `scripts/dispatch-brain-task.mjs` 重构完成 |
| `scripts/test-conductor-dispatch-core.mjs`(新建,同样因落点变化改为 `scripts/` 下的 `.mjs` 测试,不是 `src/conductor-work/__tests__/dispatch.test.ts`) | 单测:合法 `rawIntent` → 产出的 contract 过 `assertValidTaskContract()`;`brain` 恒 `"company"`;空 `rawIntent` fail-closed;**Zorro R1 深水区补测**(yellow③):真实驱动 `startRun`/`resumeRun` 走 G1→G2→G3 停止、Escalation 停止、`no_change` 终态三条真实路径(fake adapter,不调真实 LLM),`isAutoApproveGate()`/`AUTO_APPROVE_GATE_NAMES` 内容 + 冻结性断言(Zorro R2 blocker RB1 之后的接口,不是 R1 阶段曾经直接导出的可变 `Set`) | `conductor-dispatch-core.mjs` |
| `scripts/test-dispatch-brain-task.mjs` | 回归:确认重构后所有既有断言(尤其 cwd 互斥锁并发测试、`--project` 校验、`allowedPaths` 不被 `--project` 覆盖)零回归 | 重构完成 |

**Batch 0 验收点**:①修正④范围核实结论写进 `progress.md`,不是"待核实"占位;②`dispatch-brain-task.mjs`
重构后 `scripts/test-dispatch-brain-task.mjs` 100% 通过,零断言改动(除非明确记录为"本次重构导致的
预期变化");③新的共享核心单测通过,含 Zorro R1 补的深水区回归。

### Batch 1 — 派发单向闭环 + 看板总览(MVP 头号 demo 切片)[M]

| 文件 | 改动 | 依赖 |
|---|---|---|
| `scripts/dispatch-conductor-task.mjs`(新建) | 薄命令行入口,调 `scripts/lib/conductor-dispatch-core.mjs` 的 `runConductorDispatch()`,不要求项目注册;cwd 钉死在 REPO_ROOT(不需要 `dispatch-brain-task.mjs` 那把跨调用互斥锁——一次性 CLI 调用,每次是独立 OS 进程);**Zorro R1 blocker B5**:输出经大小限制的候选摘要(`pendingGate.diff`)+ claims/evidence 真实内容(`summarizeClaims()`/`summarizeEvidence()`,不是计数)+ `threadId`(yellow⑤) | batch 0 完成 |
| `scripts/test-dispatch-conductor-task.mjs`(新建) | 纯 CLI 入口没有可注入 mock 的库函数接口,改用 `execFileSync` 真实子进程调用测两条 fail-fast 路径:空/纯空白参数→exit 2;身份库未配置→exit 1 + 结构化错误 JSON | `dispatch-conductor-task.mjs` |
| `docs/conductor-brain-layer/BRAIN.md` | 新增 §6"工作请求识别与派发":描述"识别到工作请求就调用 `dispatch-conductor-task.mjs`"这条指引(DESIGN §7.2 方案 A 的具体落地文案);**Zorro R1 blocker B1**:更新"candidate-only 诚实边界"措辞,不实声明("是代码层 posture 不靠自觉")改为诚实版本(prompt/契约层约束,非运行时机械强制,#31 开放风险) | `dispatch-conductor-task.mjs` |
| `.claude/hooks/brain-wake-greeting.mjs` | 只在**状态 C**(正常醒来)分支追加 `CONDUCTOR_DISPATCH_INSTRUCTION` 常量(明确标注"不是开场白,不要念给用户听",含 B1 诚实边界摘要);状态 A/B(首次引导)**零改动**——新增 A/B/C 三路径回归断言(yellow④,`test-hook-greeting.mjs`) | BRAIN.md 改动 |
| `src/conductor-work/board.ts`(新建,真实 `src/` TS 文件) | `phaseLabelFor()`(PHASE_MAP 的 key 直接从 `LOOP_NODES` 派生,含 `no_change`——Zorro R1 blocker B4)+ `loopCountFromStepRefs()` + `coderRoundCompletedFromStepRefs()`(原定名 `hasCandidateDiffFromStepRefs`,yellow①改名)+ `toBoardRow()` | 无(可与上面几行并行) |
| `src/conductor-work/__tests__/board.test.ts`(新建) | 覆盖集合从 `Object.values(LOOP_NODES)` 派生(不是手写列表,防漂移——B4);`no_change` 终态映射到 `completed_no_change`;`__end__` 验证落到未知阶段(从未真实出现过) | `board.ts` |
| `src/loop/audit-store.ts` | **新增可选只读构造模式**(Zorro R1 blocker B2):`new AuditStore(dbPath, {readonly:true})` 用 `better-sqlite3` 的 `{readonly:true, fileMustExist:true}` 打开、跳过 `createSchema()`——省略 `opts`(所有既有调用点)时走原有分支,**行为等价**(措辞收窄:构造函数本身多了几行分支判断代码,不是字面"一字节都没变",但省略 `opts` 时产出的 `AuditStore` 实例行为和改动前完全一致,纯 additive,不影响任何既有调用点/测试) | 无 |
| `conductor-work/ui/server.mjs` | 新增 `GET /api/runs` 端点:`resolveWorkflowDbPath()` **复用引擎自己的 `loadProfile()`**(`src/profile/loader.ts`,内置 `isSinglePathSegment`/`isContainedRealpath` 校验,同时解决 `CONDUCTOR_WORK_PROFILE` 路径穿越——Zorro R1 blocker B3)、honor `AELOOP_PROFILES_ROOT` → `new AuditStore(dbPath, {readonly:true})`(物理只读——blocker B2)→ `listRunsByStatus()` × 2 → `toBoardRow()` 组装。降级路径:profile 解析失败/`workflow.db` 不存在/`dist/` 未 build 均返回 `source:"static-fallback"` + 具体原因,不崩页面 | `board.ts`、`audit-store.ts` 只读模式 |
| `conductor-work/ui/app.js` | 新增总览页渲染逻辑:轮询 `/api/runs`(2-3s);**yellow②修复**:拉取失败时 `renderBoardFetchError()` 只更新错误提示条,不碰 `#board-rows` DOM——真正做到"保留上一次成功渲染的内容",不是文案空承诺;字段用 `row.coderRoundCompleted`(不是 `hasCandidateDiff`);`escapeHtml()` 防 XSS。**不改动**现有单 run fixture 渲染逻辑 | server.mjs 改动 |
| `conductor-work/ui/index.html` | 新增总览表格容器,列头"Coder 完成轮次"(不是"候选 Diff",带 title 提示近似语义) | app.js 改动 |
| `conductor-work/ui/README.md` | 新增"多 workflow 总览看板"一节:数据源(`loadProfile()`/`AELOOP_PROFILES_ROOT`)、只读保证(物理层面)、`coderRoundCompleted` 近似语义;**保留**现有"fixture 阶段"说明 | 上述改动完成 |
| `docs/conductor-mvp/progress.md` | 记 §9.6 SQLite 并发实测结论(**已完成**:1 写者 80 轮 + 2 读者各 150 次真并发,0 错误,`journal_mode` 实测 `"delete"`) | 上述功能已跑起来 |

**Batch 1 验收点**:见 §6.1/§6.2。**指挥官已确认(2026-07-24)**:batch 1 demo 先在 CLI 环境验证,
不等 #106(DESIGN §2.3/§9.3)。**Zorro R2 blocker RB2 订正(2026-07-24)**:上一版这里写"VSCode 入口
待 #106 落地后自动生效,不需要 batch 1 回头改代码"——这句话已被 DESIGN §2.3 判定为不准确(两个
分支都改 `.claude/hooks/brain-wake-greeting.mjs`,不是"自动生效")。**#106 已于 2026-07-24 merge
到 origin/main(`1e36531`),本轮已完成 rebase + 手工 reconcile**(不是"待做"):`brain-wake-
greeting.mjs`/`BRAIN.md`/`test-hook-greeting.mjs` 三个文件的冲突均已手工解决,融合后 #106 的三路径
守卫测试(⑫-㉑)+ 本分支的 A/B/C 派发指令断言(⑧⑨⑩)全部重跑通过,详见 `progress.md`"Zorro R2
返工"一节的完整证据。

### Batch 2 — 看板详情钻取(单 run 完整视图,只读)[M]

| 文件 | 改动 | 依赖 |
|---|---|---|
| `conductor-work/ui/server.mjs` | 新增 `GET /api/runs/:id` 端点:`getRunById(id)` + `listStepRefsByRun(id)` + 相关 `Approval`/`StepMarker` 行,加上 `ConductorWorkApp.projectEvents()`(若能重建该 run 的 `EvidenceBundle`——`[?]` 待 build 阶段核实"离线只用 `workflow.db` 里的持久化记录,能不能重建出一份和实时 `projectEvents()` 等价的 `EvidenceBundle`,还是只能展示 `StepMarker`/`Approval` 这一层更粗的历史";如果不能等价重建,详情页诚实展示"能拿到的都是持久化审计记录,不是完整 LoopEvent 回放",不假装完整) | batch 1 完成 |
| `conductor-work/ui/app.js` | 点开总览一行 → 请求 `/api/runs/:id` → 渲染详情(复用已有的 `timelineFrom()`/`requirementsFrom()`/`evidenceFrom()` 渲染函数,只换数据源) | server.mjs 改动 |
| `conductor-work/ui/index.html` | 详情视图的容器/导航(从总览进入详情、从详情返回总览) | app.js 改动 |

**Batch 2 验收点**:见 §6.3。

### Batch 3 — 修正①②:控制命令确定性解析 + G3/gate 对话层 resume 接线 [L,依赖排期]

> 本批次的具体文件清单需要 batch 0 对 `[?]`(修正④范围)之外的"对话层怎么承接
> `parseGateCommand()`/`resumeRun()`"做一次独立设计核实(今天 `gate-controller` 半成品不可直接用,
> DESIGN §1.1 已述)——**本 PRD 不在这里假装已经设计好具体文件**,留一个待办:build 阶段先出一份
> batch 3 的补充设计小节(可以是 DESIGN.md 的追加章节,不必是新文档),再列逐文件任务清单。

### Batch 4 — 修正③:对话历史持久化进 Context `memories` 表 [M,依赖排期]

同上,需要先确定"对话交换"记进 `memories` 表的具体 `type`/`title`/`tags` 约定(参照 BRAIN.md §4 的
既有约定风格),本 PRD 不在此臆造具体 schema,留 batch 0/3 之后补一次小型设计。

### Batch 5 — 修正④:角色 schema 动态 registry [S/M,视 batch 0 核实结果]

文件清单完全依赖 batch 0 的核实结论(DESIGN §9-1),本 PRD 不预先假设。

---

## 5. 批次拆解总表([S/M/L] + 依赖关系,按依赖序排列)

| 批次 | 规模 | 内容 | 依赖 | 可独立 demo? |
|---|---|---|---|---|
| batch 0 | S | 核实 + 抽取 `runConductorDispatch()` 共享核心 | 无 | 否(基础设施) |
| **batch 1** | M | 派发单向闭环 + 看板总览 | batch 0 | **是——MVP 头号亮点** |
| batch 2 | M | 看板详情钻取 | batch 1 | 是(增强体验) |
| batch 3 | L | 修正①②对话层接线 | batch 0(需要额外补充设计) | 是(真对话打断/恢复) |
| batch 4 | M | 修正③对话历史持久化 | batch 0 | 否(体验增强,不独立可 demo) |
| batch 5 | S/M | 修正④动态 registry | batch 0 核实结果 | 否(架构债务清偿) |

---

## 6. 可测验收标准(勾选式)

### 6.1 Batch 0

- [x] `progress.md` 记录修正④范围核实结论(不是"待核实"占位)。
- [x] `scripts/test-dispatch-brain-task.mjs` 重构后 100% 通过,断言零回归(除非明确记录预期变化)。
- [x] `scripts/lib/conductor-dispatch-core.mjs` 的单测:合法意图 100% 过 `assertValidTaskContract()`;
      空/纯空白意图 fail-closed 抛错,不产出非法 contract。**Zorro R1 补充**(yellow③):真实全链路
      G1→G2→G3 停止、Escalation 停止、`no_change` 终态三条路径均有 fake-adapter 驱动的真实回归。

### 6.2 Batch 1(核心验收——对应"聊天→自动派发"这条头号亮点)

- [ ] **未做,人工 self-check 待补**:在一个已配置 profile 的会话里,对着醒来后的调度员说一句
      自然语言工作请求,系统**不需要用户手动敲任何命令行**,自动完成:翻译 → `startRun` → 自动批
      G1/G2 → 停在 G3 前(或 no_change/cancel 提前终态)→ 折回身份库 → 对话层回复候选摘要 +
      Requirement Coverage + pending gate 说明。**这条需要真实认证的 subscription profile(真实
      claude/codex CLI 调用),本轮 build 会话没有真实凭证、也不应该在这类环境里尝试起真实嵌套
      agent 调用(红线④)——等价的确定性行为已用 fake-adapter 在
      `scripts/test-conductor-dispatch-core.mjs` 里验证过(G1→G2→G3 停止/Escalation/no_change 三条
      真实路径),但"真实 LLM 说人话"这一层没有被自动化或本轮验证过。**
- [x] 上述整条链路全程 `TaskContract.policy.allowGitWrite === false`,coder/tester 工具执行不指向
      任何真实项目 cwd(只在沙箱路径操作)——代码审查 + `translateIntent()`/`assertValidTaskContract()`
      既有测试确认;**注意 §1.5/DESIGN §1.5 已如实标注:这是契约字段级约束,不是运行时机械强制
      (#31 开放风险)**。
- [x] `GET /api/runs` 返回的每一行都能在 `aeloop list` CLI 的输出里找到对应的 run(同一份
      `workflow.db` 数据,两个视图不冲突)——已手动交叉核对(同一份 fixture 数据跑两个视图,字段
      完全一致)。
- [x] 看板总览页面能同时展示 ≥2 条 run(通过两次独立派发验证),每行阶段标签、loop 次数、
      `coderRoundCompleted` 三项都不是硬编码/fixture 数据——已手动验证(两条 `AuditStore` 真实
      写入的 run,`/api/runs` 正确反映)。
- [x] `phaseLabelFor()` 对 §3.5 映射表列出的**全部**已知 `currentState` 值返回正确标签(含
      `no_change`,覆盖集合从 `LOOP_NODES` 派生防漂移);传入一个未识别值(含 `__end__`,验证它
      从未被冒充为已知阶段)时返回"❓ 未知阶段"——`board.test.ts` 21 个用例全绿。
- [x] `workflow.db` 不存在/profile 名路径穿越/`dist/` 未 build 这三种"打不开"场景,`/api/runs`
      走降级路径返回诚实的 `static-fallback`,不报错崩页面——已手动验证。**Zorro R3 yellow②措辞
      收窄**(不是"读取失败"泛指所有失败场景):`getBoardRows()` 里真正查询数据的那一段
      (`listRunsByStatus()`/`listStepRefsByRun()`/`toBoardRow()`,`server.mjs:225-231`)是
      `try/finally`、**没有 `catch`**——这几个调用真的抛错时,错误会冒泡到 HTTP handler 层,
      返回**HTTP 500**(`{source:"error", ...}`),不是 `static-fallback`。两条路径分工明确:
      "打不开数据源" → 降级;"打开了但查询本身出错" → 500,不是同一件事,本轮不改代码统一它们
      (batch 2 若需要可以再评估)。
- [ ] Zorro 独立审查确认:本批次新增代码没有新增任何写路径指向 `workflow.db`/身份库(UI server 对
      它们全程**物理只读**——`AuditStore` 只读模式已实测:读操作正常、写操作真的抛
      `SQLITE_READONLY`、文件 mtime 不变、缺失文件时 `fileMustExist:true` 抛错而非静默建库)。

### 6.3 Batch 2

- [ ] 点开总览任意一行 run,详情页展示节点级历史、候选 diff(已决策轮次)、EvidenceBundle 摘要、
      Requirement Coverage——数据来自真实 `workflow.db`/离线重建的 `EvidenceBundle`,不是 fixture。
- [ ] `completed`/`cancelled` 状态的 run 同样能在总览/详情里查到(不只是 `running`/`escalated`)。

### 6.4 Batch 3-5

留待各批次自己的补充设计出来后再定验收标准(本 PRD 不预先臆造)。

---

## 7. 项目约束检查

- **candidate-only 红线(措辞收窄,Zorro R1 yellow⑥)**:准确说法是"不把候选写进目标工作区/不
  apply/不 git write",不是笼统的"不写盘"——共享核心确实把 `TaskContract` JSON 写到磁盘的安全
  沙箱路径,`runner.ts`/三态门也确实写 `workflow.db`/身份库,这些是有意的、审计需要的落盘。
  batch 1-2 新增代码(派发胶水层 + 看板)全程遵守这条红线——派发胶水层复用既有
  `runCandidate()`/`resumeRun()` 的 "candidate-only; git writes disabled" posture,不新增任何
  写路径;看板对 `workflow.db`/身份库**物理只读**(`AuditStore` 只读模式,Zorro R1 blocker B2
  已实测确认)。**⚠️ 这条红线今天只在 prompt/契约层生效,不是运行时机械强制**(issue #31 开放
  风险,DESIGN §1.5)——真·机械隔离延后到 #31 单独做,本轮只做诚实标注。
- **Level 1 沙箱约束**:`translateIntent()` 的 `allowedPaths` 继续指向安全沙箱目录,不指向任何
  目标项目真实路径;batch 1-2 不新增/不解除这条约束(DESIGN §1.3 第 5 点)。因为 #31 尚未解决,
  这条沙箱约束是**唯一现实的安全网**,demo 严格只在 aeloop 自己仓库内跑。
- **#106 依赖 —— 已完成(Zorro R3 blocker RB2 复发订正,2026-07-24)**:**指挥官已确认
  (2026-07-24)**——batch 1 与 #106 并行,不互相阻塞;batch 1 demo 先在 CLI 环境验证(SessionStart
  已验证可靠),VSCode 入口(UserPromptSubmit/Layer3)在#106 落地后生效(DESIGN §2.3/§9.3)。
  **#106 已于 2026-07-24 merge 到 origin/main(`1e36531`)**——两个分支确实都改了
  `.claude/hooks/brain-wake-greeting.mjs`(Zorro R1 blocker B6 预判成立,不是自动无冲突生效),
  **本分支已完成 rebase(`git rebase origin/main`)+ 手工 reconcile**(`brain-wake-greeting.mjs`/
  `BRAIN.md` 两处真实冲突已解决,`test-hook-greeting.mjs` 三方合并自动成功),当前 HEAD = `1e36531`,
  融合后 21 段测试(#106 的 10 段三路径守卫测试 + 本分支的 3 段 A/B/C 派发指令断言)全部通过。完整
  操作记录见 `progress.md`"Zorro R2 返工 §0"。
- **profile 差异**:batch 1-2 的实现在 Helix/企业 profile 之间**共用同一套代码**,不新建任何
  profile-specific 分支(DESIGN §6 已论证)。
- **不重复造轮子**:batch 0 的重构必须保证 `scripts/dispatch-brain-task.mjs`(issue #93 既有产物)
  的既有测试/行为不回归;`scripts/lib/conductor-dispatch-core.mjs` 是共享核心,不是并行的第二套
  实现。
- **whoseorder/whosehere 等其它项目**:本 PRD 完全不涉及,aeloop 是独立 private repo,不跨项目
  读写。
- **禁止关门嵌套 agent**:build 阶段任何验证脚本/CLI 调用,不使用 `claude -p
  --dangerously-skip-permissions` 类关门嵌套 agent 模式(#106 build 已因此吃过安全警告);需要验证
  行为时用有门的方式,或如实标注"未实测"。

---

## 8. 决策点状态(汇总 DESIGN §9,2026-07-24 更新)

**已拍板(不再是开放问题)**:
1. ~~batch 1 demo 是否等 #106 落地~~ → **不等,CLI 先演,#106 与 batch 1 并行**(DESIGN §2.3/§9.3)。
2. ~~"一句意图拆多个并行 workflow"是否要单独立项~~ → **不做,确认不是 MVP 诉求**(DESIGN §7.6/§9.7)。

**其余按 DESIGN 既有推荐 default 走,build 阶段不再逐个问指挥官**(DESIGN §9.1/9.2/9.4/9.5/9.6/9.8):
派发胶水层文件位置由 Cypher 按实际代码形状判断;修正④范围/SQLite 并发安全性在 batch 0/1 build 时
实测,结论记 `progress.md`;`riskLevel` 验证、独立产品化入口、pending-diff 缺口均后延,不在本轮
batch 0-1 范围。
