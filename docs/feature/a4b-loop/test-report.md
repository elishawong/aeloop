---ATTESTATION---
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T02:38:25.425Z",
  "completed_at": "2026-07-21T02:47:57.691Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "",
  "git_commit": "c6589b71d990d21ca859a7b16889c8e22a0ecae2",
  "diff_base": "",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "8620ab5cafab9886953e9f5b4f5097cad0ad94a78139860cdd60f2c5706dbda1",
  "independent_review_completed": true,
  "fallback_used": false
}
---END ATTESTATION---

# A4b Loop — Zorro 测试报告(对抗式独立复审)

- 审查对象:`feature/issue-13-a4b-loop`(未 commit 的 worktree,基线 aeloop main `c6589b7`)
- 二签引擎:Codex `gpt-5.6-sol`(只读),`raw_output_sha256` 非空,落盘证据文件的 hash 匹配(`.helix/zorro-raw-output/8620ab5c….txt`)
- 独立重跑:`pnpm build` / `pnpm lint` / `pnpm test` = 33 个文件,**276/276 全绿**(自己跑的,不是听自报)
- 变异测试:手动破坏生产代码验证测试会不会变红/变绿(细节见下),编辑后工作区逐字节恢复原样(四个文件的 shasum 重新核对一致,HEAD 未动)

## 复审结论:FAIL

两个模型都独立判定 FAIL。核心问题:**升级硬分支"不可绕过"这条不变量没有被任何测试锁住**(我手动变异确认过),再加上**审计写入在跨 run/失败场景下不安全**——而"一条可审计的链路"正是 aeloop 的差异化卖点。

---

## 1. 需求符合度(逐行对照 PRD §8)

| 验收项 | 结论 | 证据 |
|---|---|---|
| build/lint/test 全绿 276/276 | 达标 | 自己跑的 |
| threshold 真的能触发 escalation,两个边界都测了 | **部分达标** | 低于(count<threshold→g2)和等于(count==threshold→escalation)都测了;但**count>threshold 的再次升级路径("硬分支不可绕过")零测试覆盖**——`>=`→`===` 的变异能存活(见变异①) |
| Escalation 三选一,所有路径 + 测试 | 达标 | graph.test 有三个独立测试用例分别测 revise/force_pass/abandon,都驱动了真实 graph |
| G2 主动升级分支 | 达标 | "G2 收到 escalate" 那个测试用例 |
| 三张审计表真的建出来 + 真的写进去了 | 达标(但见 bug#2/#3) | audit-store.test 9 个用例 + runner.test + e2e |
| checkpoint 跨进程生产化 | 达标(但见 bug#4,一个已知局限) | 两个真实进程,不同 pid,只靠磁盘 SQLite 通信 |
| 纵切必须端到端真连接(包括 escalation) | 达标 | e2e 用真实的 cli-bridge fixture→runner→三张表都能查到(§8.5 说的那种"胶水"确实存在) |
| graph 节点/gate 零 I/O | 达标 | grep 零命中,自己验证的 |
| 没有反向跨层依赖 | 达标 | `grep -rln "from.*loop" src/harness src/context src/prompt` 为空;audit-store 跟 context 零耦合;runner 对 `ContextInjectionResult` 是类型层面的 import(Loop→Context 是允许的方向) |

## 2. 变异测试结果(决定性证据)

| # | 变异 | 位置 | 对应测试 | 结果 |
|---|---|---|---|---|
| ① | `rejectCount >= rejectThreshold` → `=== ` | gates.ts:143 | graph.test/runner.test/e2e,全部 | **存活(全绿)**——没有测试驱动 count>threshold,硬分支可以被 `===` 悄悄绕过而不被抓到 |
| ② | review 的 escalation pathMap 目标 `escalation`→`g2` | graph.ts:95 | graph.test | 被抓到(5 个变红)——结构性路由错误被抓到了 |

变异①是这一轮最硬的 FAIL 证据:DESIGN §4 明确说 escalation 是一条"硬分支,不可绕过"。真实反例——threshold=2,count 到 2,升级,人工选 revise 回 draft,tester 再次拒绝让 count=3;正确的 `>=` 应该再次升级,但 `===` 会路由回 g2,悄悄绕过硬分支。既有的 revise 测试停在下一个 G1 就结束了,后面从来没有再驱动一次拒绝,所以这个没法被抓到。变异②证明测试套件对结构性路由是有效的——我的批评针对的是一个具体的覆盖缺口,不是说整个套件在空转。

## 3. 发现的 bug

### 🔴 阻断级

- **B1(=变异①):升级硬分支这条不变量没有被任何测试锁住。** gates.ts:143。`>=`→`===` 的变异能存活(手动验证过)。count>threshold 的再次升级路径(DESIGN §4"不可绕过")零覆盖。**要求 Cypher:加一个测试,把 count 打过 threshold(比如 revise 回 draft,再拒绝一次),断言它依然路由到 escalation。**
- **B2:`resumeRun` 的审计写入没有绑定到正确的 run。** runner.ts:302–315。这个函数独立接受 `runId` 和 `threadId`:`threadId` 用来通过 LangGraph checkpoint 推进 graph,`runId` 用来写**所有**claim/approval/`workflow_runs`——这两者是不是属于同一个 run,**从来没有被校验过**。传一对不匹配的值(A 的 runId + B 的 threadId)→ 会推进 B 的 graph,但把 B 的 approvals/claims/state/reject_count 写进 A 的名下,悄悄污染审计链。每个 runner 测试都只在一个 store 里创建一个 run,所以这个抓不到。对一个卖点就是"治理/可审计"的产品来说,这是个核心正确性漏洞。**修法:`resumeRun` 应该只接受 `runId`,内部 `getRunById` 拿到 threadId(runner 反正已经持有审计存储),或者断言这一对是匹配的。**
- **B3:runner 从来没用过 `runInTransaction`,多行审计写入不是原子的。** runner.ts:140–239,每个 insertClaim/insertApproval/updateRunProgress 各自独立提交;PRD §4.2/§5 明确把 `runInTransaction` 分配给 runner,用来"把插入好几条 claim 这类多行写入包进一个事务",但实现从来没用过(grep 零命中,手动验证)。如果某次调用中途某个 insert 抛错 → 半条 claim 落进 DB + `workflow_runs.status` 永远不刷新,审计状态不一致。(跨 LangGraph checkpoint 连接的完全原子性可以说不在范围内,但把多行分组在一次调用里是 PRD 明写的设计,却被跳过了。)

### 待指挥官裁决 / 已知局限(不是硬阻断)

- **D1(Codex 判定阻断级):跨进程的 step_ref 冲突。** runner.ts:29/104。计数器只活在 `RunHandle` 里;新进程从 `{}` 开始,所以如果跨进程续跑又绕回同一个节点(比如第二次 draft),它会覆盖 `draft#1` 而不是写 `draft#2`,让审计的轮次编号变得模糊。**这一点已经在 runner.ts 的头注释和 PRD §9.2 决定 4 里被如实标为"已知局限,在单跳跨进程验收路径之外",我也确认过它确实在 A4b 所有验收路径之外。** 但它削弱了"跨进程续跑生产化"这个卖点(graph state 是生产级的,审计归属不是)。便宜又稳健的修法 = 续跑时从 DB 重建计数器。建议开一个追踪 issue。
- **D2(Codex 判定阻断级):threshold 来源优先级链没有实现。** config.yaml→system_config→写死 2 这条链哪里都没接线;`startRun` 只接受一个已经算好的数字,e2e/测试里都是写死 `rejectThreshold`。**但这是 PRD §9.2 决定 2 + §2 的非目标明确委托给调用方/未来 A5 的**,Codex 不知道这一点,判成了阻断级——我不接受这个严重度评级。仍然值得按 §8.5"绿色层缺胶水"的思路提醒指挥官一句:没有测试证明 config→run threshold 这条流真的通。决定 2 本身就是明确要求指挥官确认的六个决定之一。

### 🟡 轻微

- **M1:`approvals.diff_ref` 内联了整个 diff。** runner.ts:197。DESIGN §5 说的是"hash/路径,不要内联大段文本"。这属于 PRD §9.2#2 已经记录过的一个决定(diffRef 从 A4a 起就是内联的)——可以接受,但记一笔。
- **M2:runner 丢掉了 gate 的真实 `decidedAt`。** runner.ts:197 只传了 decision/reasoningText,没传 `entry.decidedAt`;insertApproval 用的是自己持久化那一刻的时间戳 → `approvals.decided_at` ≠ checkpoint 里记录的真实决定时刻。对审计精度来说是个小问题,修起来容易(把 `entry.decidedAt` 传过去)。
- **M3(幻觉门):注释跟代码矛盾。** gates.ts:110 的注释说"GateDecision 只有两个值"(现在是三个:approved/rejected/escalate);types.ts:155 说 runner 计算 threshold 优先级,runner.ts:83 说调用方计算——两者互相矛盾,而且都没实现。修一下注释。

## 4. bug 归因拆解

| 归因 | 项目 |
|---|---|
| 边界条件 | B1(`>=` threshold 边界没测) |
| 集成问题 | B2(run/thread 绑定)、B3(事务/原子性)、D1(跨进程计数器) |
| 需求理解落差 | D2(优先级链延后,分歧在严重度,不在事实本身) |
| 其他(审计精度/文档) | M1、M2、M3 |

## 5. 提炼出来的可执行测试清单(Cypher 返工时必须加)

- P0:一个驱动 `rejectCount > rejectThreshold` 再次升级的测试(锁住 B1 的硬分支不变量,直接杀死 `===` 变异)。
- P0:断言 `resumeRun` 收到不匹配的 runId/threadId 对时应该拒绝/不污染另一个 run(锁住 B2)。
- P1:断言 runner 多行写入中途失败时整组回滚(锁住 B3)。
- P1(建议):多次跨进程续跑时 step_ref 的唯一性(锁住 D1,或者改成从 DB 重建计数器)。

## 6. 七道质量门

- 需求符合度 ✗(硬分支不变量没测,§8"两个边界都测了"有点言过其实)
- 影响范围 ⚠(披露了 6 处偏差,但 B2 的跨 run 绑定 / B3 的事务缺失没有作为影响范围被提出来)
- 占位符拒绝 ✓(没有 TODO/stub/假数据)
- 危险代码 ✓(没有 drop-database/密钥/注入/外泄)
- 幻觉检查 ⚠(M3 陈旧/矛盾的注释;§8 的勾选框对覆盖率有轻微夸大;没有实质性假数据)
- 文档完整性 ⚠(PRD 很详尽,内嵌了 impact/测试策略,但没有独立的 impact.md/test-plan.md;这份 test-report 文件补上了这块)
- 文档同步(大设计级别) 不适用(项目级 aeloop;DESIGN §1.5 已同步;基地的四份权威文档不涉及)

## 7. 知识库交叉核对(核对它,不是维护它)

- 触及已索引模块:**是**(escalation.ts/audit-store.ts/runner.ts 新增 + gates/graph/types 改动)。
- 跟 `CHARTS/knowledge/aeloop.md` 交叉核对:**基本准确**,接口/路径/依赖跟真实代码对得上。一处小漂移:AuditStore 条目说 `runInTransaction` 是"给 runner.ts 把多行写入包进一个事务用的",暗示 runner 已经在用了——实际上 runner **没有调用它**(跟 B3 一样);runId/threadId 没被校验这件事也没提到。因为这个分支还没 commit,返工反正会改代码,建议**返工后 Cypher 顺手改这一行 + 重新同步的时候顺便 bump last-verified**,现在不用单独修。

## 8. 待指挥官裁决的事项

- D2:threshold 优先级链明确延后给未来的 A5——确认这个延后,还是要求 A4b 至少加一条证据把 config.yaml→run threshold 这条流连起来(呼应 §8.5)?
- D1:跨进程的 step_ref 冲突——接受为已知局限 + 开一个追踪 issue,还是这一轮就靠从 DB 重建计数器修掉?
- M1:diff_ref 内联要不要保留(§9.2#2 已经定了),还是趁现在动审计持久化顺手改成 hash/路径?

## 结论

**FAIL。** 返工优先级:B1(加硬分支再次升级测试,最难的一个)、B2(resumeRun 绑定校验)、B3(runInTransaction)。修完回 Zorro 重审 + 还需要再来一轮 Codex 二签。等指挥官裁决 D1/D2/M1 之后再合并。

---

# A4b Loop — Zorro Round 2 复审(返工之后)

---ATTESTATION (R2)---
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T03:21:02.196Z",
  "completed_at": "2026-07-21T03:30:59.983Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "git_commit": "c6589b71d990d21ca859a7b16889c8e22a0ecae2",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "b17b98a3b9f9b72ebe59388eeacb1ed7b97477f203bb50c0aa98852982b4416a",
  "independent_review_completed": true,
  "fallback_used": false
}
---END ATTESTATION (R2)---

## 复审结论:FAIL(比 R1 窄——三个 R1 阻断级的架构和核心修法方向都是对的、也锁住了;新问题在边界正确性 + 覆盖完整性)

两个模型都独立判定 FAIL。**我手动逐个核对了 R1 三个阻断级的核心修法,4/4 变异,全部真正锁住**(见下表),知识库重新同步是准确的,verify-knowledge 是绿的。但 Codex R2 又往下挖了一层,发现:D1 的落盘重建漏掉了"零 claim 轮次"(一个真实 adapter 可以合法地返回 `claims:[]`),大于 2 的 threshold 配置没有测试覆盖(`Math.min(threshold,2)` 的变异能存活,手动验证过),review/gate 事务没有回归锁,再加两个加固项——B2 的唯一性和 decidedBy 守卫的时机。

## 对四个 R1 返工项重新跑变异(逐个手动验证,不是听 Cypher 自报的)

| 项目 | 变异 | 结果 | 结论 |
|---|---|---|---|
| B1 | `gates.ts` 的 `>=`→`===` | count=3 vs threshold=2 的测试**变红**(1 个失败) | ✅ 真正锁住 |
| B2 | 去掉 `RunThreadMismatchError` 这道守卫(`if(false&&…)`) | 不匹配测试**变红** | ✅ 真正锁住 |
| B3 | 把 draft 分支的 `runInTransaction` 包装剥掉 | 回滚测试**变红**(半行存活下来) | ✅ 真正锁住 |
| D1 | 把续跑改成只信任传入的 `stepCounters`(丢掉 DB 重建) | 冲突测试**变红**(round2 塌缩回 draft#1) | ✅ 真正锁住 |

四个变异全部还原之后,shasum 重新核对逐字节一致,全套测试重新变绿 281/281。R1 的修法本身是扎实的;这一轮的 FAIL 不是回归,是 Codex 挖出的下一层严谨度要求。

## R2 新发现(各自独立评级,不照抄 Codex 的严重度)

### 🔴 应该在合并前修(真实缺陷 / 核心不变量覆盖)

- **R2-1(=Codex 阻断级,手动验证过):大于 2 的 threshold 配置没有测试覆盖,`Math.min(rejectThreshold,2)` 的变异能存活。** gates.ts:150 / graph.test.ts。测试只用了 threshold 1/2/5,但 threshold=5 的场景只把 count 打到过 1。`rejectCount >= Math.min(threshold,2)` 对 1/2 是对的,对 threshold=5 是错的——在这种情况下会提前 3 轮就在 count=2 时升级——**我手动跑了这个变异,23 个 threshold 测试全部存活变绿。** DESIGN §4 的 escalation"不可绕过"只在 threshold≤2 时被锁住;threshold 是一个真实的变量(≥3)时,没有任何证据证明配置行为是对的。**修法:加一个 threshold=5、连续拒绝两次的测试,断言依然是 g2(不是 escalation)。**
- **R2-2(=Codex 阻断级,通过代码+schema 验证):D1 的落盘重建漏掉了"零 claim 轮次"。** runner.ts:192。`nextStepRef` 在每次 draft/review 执行时都会自增,但 `listStepRefsByRun` 只能看到**真正写过的行**里的 step_ref;`CoderOutput.claims`/`TesterOutput.claims` 是 `z.array(...)`,**没有 `.min(1)`**(手动核对过,schema.ts:58)——一个真实模型可以合法返回 `claims:[]`,所以那一轮压根不会写任何 step_ref → 跨进程/`{}` 续跑时,`rebuildStepCounters` 数不到它 → 同一个节点的下一次执行又从 `#1` 开始,跟磁盘上已有的冲突。这正是 D1 本该消灭的那种审计冲突,只是触发条件换成了零 claim。Codex 还指出 `effectiveStepCounters = dbStepCounters` 这个变异(丢掉调用方那一侧的合并)也全绿存活。**修法:让每次节点执行都可重建(要么独立持久化一个计数器,要么每次执行都写一个 step marker),不要把 step_ref 编号的来源绑在"这一轮有没有 claim"上;或者指挥官裁决把 D1 留作已记录的局限 + 追踪 issue。**

### 🟡 应该修(覆盖完整性 + 加固)

- **R2-3(Codex 阻断级,我降级为覆盖轻微项):B3 只有 draft 事务有回归锁。** runner.ts:224(review)/254(gate)的 `runInTransaction` **代码本身是对的**(手动读过),但 `FakeTesterAdapter` 每次只发 1 条 claim,一个 gate 通常只有 1 条 approval——把这两处的包装剥掉,测试照样全绿。**修法:加一个多 claim 的 tester fixture + 一个多 approval 场景,给 review 和 gate 各加一个中途失败零幸存者的测试。**
- **R2-4(Codex 阻断级,我降级为加固轻微项):`langgraph_thread_id` 没有唯一性约束,B2 的守卫理论上可以被重复的 thread_id 绕过。** audit-store.ts:285-298。守卫读的字段和拿来比较的值都是对的(手动验证过,对照 runner.ts:388 交叉核实),但如果两条 `workflow_runs` 行共用了同一个 thread_id,`resumeRun(B.id, A.threadId)` 会通过守卫,同时还是在推进 A 的 graph。实际情况下 `threadId` 是 `randomUUID()` 生成的,碰撞概率低到天文数字——得手动插入一条重复行才能复现——**但纵深防御依然应该加一个 `UNIQUE` 索引**(顺带也让 `getRunByThreadId` 的语义不含糊)。
- **R2-5(Codex 阻断级,我降级为轻微项):`decidedBy` 守卫在 graph 已经推进之后才抛错。** `decidedBy===undefined` 这个检查在 runner.ts:243,位置在 `compiled.stream()`(第 183 行)**之后**——真实调用时会先推进 checkpoint,然后才抛错,留下一个 checkpoint 已经前进而 `workflow_runs`/approval 从没更新的不一致状态。**但类型签名 `decidedBy: string` 是非 optional 的,所以一个符合类型的调用方永远走不到这条路径,而且 startRun 的拓扑也保证第一次调用永远不会完成任何 gate**,所以只有绕过类型系统的运行时 JS 才能触发它。**修法:把 `decidedBy` 校验挪到 `resumeRun` 的最开头,graph 推进之前。**

### 🟡 轻微(代码是对的,测试/注释缺失)

- **R2-6:M2 的 `decidedAt` 透传没有测试覆盖。** 删掉 `decidedAt: entry.decidedAt` 测试照样全绿(runner 的 approval 查询压根没有 select `decided_at`)。**修法:用一个假计时器/一个刻意不同的时间戳,断言 `approvals.decided_at` 是 gate 决定的那一刻,不是写进 DB 的那一刻。**
- **R2-7(幻觉门):遗留的陈旧注释。** graph.ts:2 的文件头注释还写着"六个节点……减去 Escalation 子树"(escalation/cancel 早就加上了);escalation.ts:6 还在说 `GateResumeValue` 是二选一(现在是三选一)。M3 只修了 gates.ts 里的那一处,同一类漂移在别处还在。**修法:同步这两处注释。**

## R2 无回归确认(R1 通过的项目没有被这一轮改动破坏)

- 四层之间都没有反向依赖:`grep -rln "from.*loop" src/harness src/context src/prompt` 为空;audit-store 跟 context 零耦合(两个模型独立确认)。
- graph 节点/gate 零 SQLite I/O;cross-process-resume 依然真的启动了两个独立的 node 进程(断言 pid 不同);e2e 纵切依然真的连通了 Context→Prompt→cli-bridge→runner→三张表。
- build/lint/test 手动跑 **281/281 全绿**;审计事务是同步的,没有嵌套在 checkpointer 连接内部,没有死锁(Codex 独立确认)。

## R2 bug 归因拆解

| 归因 | 项目 |
|---|---|
| 边界条件 | R2-1(threshold>2 覆盖)、R2-2(零 claim 冲突) |
| 集成问题 | R2-4(thread_id 唯一性)、R2-5(守卫时机) |
| 其他(覆盖率/审计精度/文档) | R2-3、R2-6、R2-7 |

## R2 七道门

- 需求符合度 ✗(threshold 作为一个真实变量 >2 时没有证据;D1 的零 claim 冲突) / 影响范围 ⚠ / 占位符 ✓ / 危险代码 ✓ / 幻觉检查 ⚠(R2-7 陈旧注释) / 文档完整性 ⚠(依然没有独立的 impact/test-plan) / 文档同步 不适用

## R2 知识库交叉核对(核对它,不是维护它)

- 触及已索引模块:是(runner/gates/audit-store/errors)。重新同步**准确**:我在 R1 标的"runInTransaction 未使用",现在已经明确改成"B3 返工之后 runner 真的有调用方了……之前 grep 是零命中";新增的 `listStepRefsByRun`/`RunThreadMismatchError`/`decidedAt?` 都记录了;`verify-knowledge aeloop` 手动跑绿,没有路径/签名漂移,没有新的悬空引用。**不需要 Cypher 再改一次知识库**(但下一轮修完 R2 之后,那句零 claim 局限的话还需要同步)。

## R2 待指挥官裁决的事项

- D2(threshold 优先级链延后给 A5)——记录为已经被 #18 批准,这一轮没动,runner 注入点的注释没有误导性,确认维持原样。
- R2-2(D1 的零 claim 冲突)——真的修(让计数器不再依赖 claim 是否存在),还是按 D1 原本"待裁决"的性质,接受为已记录的局限 + 追踪 issue?
- R2-4(thread_id 唯一约束)——这一轮就加 `UNIQUE` 索引(推荐,便宜)?

## R2 结论

**FAIL,需要 Round 3。** 比 R1 窄:R1 的三个阻断级真的修好了、真的锁住了(4/4 变异重新验证)。R3 返工:R2-1(threshold>2 测试,最难的一个)、R2-2(零 claim 冲突,或者指挥官裁决为局限)、R2-3(review/gate 事务回归锁)、R2-4(thread_id UNIQUE)、R2-5(守卫提前)、R2-6(M2 测试)、R2-7(注释)。如果 runner/gates 因为生产逻辑再次被动,还需要第三轮 Codex 二签。目前**未 commit/push**,工作区逐字节恢复原样(gates 5fbac639 / runner 96769b65),HEAD `c6589b7` 未动。

---

# A4b Loop — Zorro Round 3 复审(R2 七个返工项之后)

---ATTESTATION (R3)---
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T04:10:19.700Z",
  "completed_at": "2026-07-21T04:15:30.078Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "",
  "git_commit": "c6589b71d990d21ca859a7b16889c8e22a0ecae2",
  "diff_base": "",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "df9b889459be28da6a09ab146fcd03d88457d6544e6e84378aafd6d34e5b4c67",
  "independent_review_completed": true,
  "fallback_used": false
}
---END ATTESTATION (R3)---

## 复审结论:FAIL(窄——R2 的七个核心修法 6.5/7 真正锁住并验证过;还剩两个小项:一个幻觉门同类扫尾漏项,一个守卫完整性缺口)

- 二签引擎:Codex `gpt-5.6-sol`(只读),`raw_output_sha256=df9b8894…` 非空,手动核对落盘证据文件 `.helix/zorro-raw-output/df9b8894….txt` 的 hash 匹配(独立复审真的发生过)。
- 独立重跑:`pnpm build`(tsc)/ `pnpm lint`(tsc --noEmit)/ `pnpm test` = **288/288 全绿**(33 个文件,自己跑的,不是听自报——比 R2 的 281 多 7 个,新增了测试)。
- 变异测试:R2 七个项目逐个在生产代码里手动变异,验证测试变红/变绿(见下表),5 个文件编辑后逐字节恢复原样(`shasum -c` 全部 OK),HEAD `c6589b7` 未动。
- 两个模型的结论:Zorro FAIL / Codex FAIL。唯一分歧是 R2-5-null 的严重度评级(Codex 判定阻断级,我降级为轻微,理由见下)。

## 对 R2 七个返工项重新跑变异(逐个手动验证,不是听 Cypher 自报的)

| 项目 | 我做的变异 | 目标测试 | 结果 | 结论 |
|---|---|---|---|---|
| R2-1 | 在 `gates.ts:150` 注入 `Math.min(rejectThreshold, 2)` | graph.test.ts:420 "threshold=5,rejectCount=2 依然是 g2" | **变红**(预期 g2,得到 escalation) | ✅ 真正锁住 |
| R2-2 | 删掉 draft+review 里两处 `insertStepMarker` 调用 | runner.test.ts "零 claim 轮次 draft#2/review#2" | **变红**(塌缩回 draft#1,正好是那种冲突) | ✅ 真正锁住 |
| R2-3(review) | 解开 review 分支的 `runInTransaction` | runner.test.ts:650 "review 两条 claim 中途失败整组回滚" | **变红** | ✅ 真正锁住 |
| R2-3(gate) | 解开 gate 分支的 `runInTransaction` | runner.test.ts:723 gate 回滚测试 | **全绿(不变红)** | ✅ 印证了 Cypher 的如实披露 |
| R2-4 | 去掉 `langgraph_thread_id` 上的 `UNIQUE` | audit-store.test.ts:150 "重复 thread_id 被拒绝" | **变红**(不再抛 UNIQUE) | ✅ 真正锁住 |
| R2-5 | 去掉 `resumeRun` 开头的 `decidedBy===undefined` 守卫 | runner.test.ts:777 守卫提前测试 | **变红**(错误变成了兜底的"gate 节点已产生决定"= 一个更晚的失败,checkpoint 已经推进) | ✅ 真正锁住(而且确认失败模式确实是"晚失败") |
| R2-6 | 去掉 `decidedAt: entry.decidedAt` 的透传 | runner.test.ts:822 decidedAt 交叉核对 | **变红** | ✅ 真正锁住 |

**6/7 变异真正变红并被杀死;gate 分支的变异保持绿色印证了那条结构性论断是真的。** 没有回归:全套测试重新变绿 288/288,build/lint 干净,逐字节恢复原样。

## R2-3 关于 gate 路径事务的独立结论(指挥官点名要求核实的那次如实披露)

**① "gate 路径的事务分组永远是 size 1" 这条结构性论断——为真(手动读代码验证过 + 变异二次确认)。** `createGateNode`(gates.ts:64)和 `createEscalationNode`(escalation.ts:63)的每一次真实执行都只会返回 `gateLog: [entry]`(单元素数组);`compiled.stream(..., {streamMode:"updates"})` 每个 chunk 携带的是节点的**原始返回值**(单个元素),不是 reducer 累积之后的整个 `gateLog`(Codex 另外交叉核对了 `@langchain/langgraph/dist/pregel/io.js:103-127`,确认 updates 发出的是原始的 task writes)。所以 `runner.ts:266` 的 `entries` 永远是 length=1,事务分组永远是 size 1。我解开 gate 事务之后,全部 14 个 runner 测试保持全绿——黑盒测试真的分不出一个 size 1 的事务和一次裸调用的区别,这跟 Cypher 披露的一模一样。

**② 这次披露是如实且正确的,不构成 FAIL。** 一次单行 SQLite INSERT 本身就是原子的,所以 gate 路径的 `runInTransaction` 目前是一个行为上的空操作——它**不是**需要移除的过度工程,是一份便宜的前瞻性防御(那个 `for (const entry of entries)` 循环已经把结构留在那,给未来某个可能在一个 chunk 里发出多条 entry 的 gate 用);留着它是无害的。**独立补充一点(Cypher 和 Codex 都没主动提到)**:这个事务**不**提供跨行的原子性——approval 的插入(runner.ts:285)和 `updateRunProgress`(runner.ts:332,在循环之后,事务之外)不在同一个事务里,所以这种跨行不一致("approval 落进 DB 但 workflow_runs 从没刷新")本来就不在这个事务的保护范围之内(而且这是系统对**任何**中途写入失败的既有失效模式——runner.test.ts:723 那个 gate 事务测试已经锁住了"workflow_runs 从不被虚假推进")。Cypher 选择如实披露而不是编造一个"看着能证明什么、实际证明不了"的测试,这种行为应该被奖励,不该被扣分。

## R3 新发现(还剩两个小项 → 需要 R4)

### 🔴/🟡 R3-1(幻觉门,Codex 判定轻微,我当成**阻断门的项目**处理):R2-7 的同类陈旧内容没扫干净——`errors.ts` 被漏掉了

- `escalation.ts`/`graph.ts` 那两处**已经改好了**(手动验证过:graph.ts 的文件头现在写的是"八个节点……A4b 补齐",escalation.ts 的文件头现在写的是三选一的决定域)。**但同一类陈旧内容在 `errors.ts` 里还在**:
  - errors.ts:9-18 的类注释还是用 A4a 的时态写的:"A4a 既没有搭 Escalation 节点……直到 A4b 搭出 Escalation 子树"——A4b 早就搭出了 Escalation 节点,G2 现在真的有一条"主动升级→Esc"的边(routeAfterG2 识别 escalate);这句"直到 A4b 搭出"的措辞暗示这个 error 是临时的,但实际上 G2 的 `rejected` 是**永久**不处理的(PRD §2 的非目标),这个 error 不会消失。
  - errors.ts:26-27 **实际抛出的错误信息**是 `"...which A4a has no routing target for(A4b will add one — see …§2/§9.2)"`——在 A4b 的语境下这句话**事实上是错的**:A4b 没有给 G2 的 `rejected` 加路由,是故意保持不处理。开发者在 A4b 阶段撞到这个,会被"A4b will add one"误导。这是**已经上线的运行时文本**,不只是注释。
- **为什么这会阻断门**:这正是门 #2(扫尾检查)存在的目的——"只修指出的那一点,不扫同一个根因在别处的残留"。R2 指出了两处(graph/escalation);Cypher 修了那两处,但没有扫同一个家族的第三处。幻觉门(#5,专门盯注释和代码互相矛盾)不应该在一个刚被点名的同类残留还在的情况下放行。
  - **修法**:重写 errors.ts 的类注释 + 抛出信息,反映 A4b 的现实——Escalation 子树已经搭好了;G2 的 `rejected` 是一道**故意永久**的失败即报错守卫,不是"A4b 会填补的占位符"。
  - **扫尾核实(门 #2 要求,手动跑过)**:`grep -rniE "will add|until A4b|A4a (builds|has no)|minus the escalation" src/loop/*.ts` → 命中 errors.ts:13/18/26/27(确实陈旧,R4-1),graph.ts:8("以前是这么写的……"——一处已经修正的历史注释,准确),types.ts:147(`A4a has no code that reads this…that's A4b's threshold escalation`——**一个准确的历史+现状归因,不是虚假陈述**:A4b 的阈值升级确实读了它,保持原样)。确认**errors.ts 是这个家族里唯一真正的残留**;修完 errors.ts 之后,同样的 grep 依然预期命中 graph.ts:8 / types.ts:147(两处都准确),不需要再追。

### 🟡 R3-2(守卫完整性,Codex 判定阻断级,我**降级为轻微**):`decidedBy` 运行时守卫只挡 `undefined`,不挡 `null`

- **事实确认(手动验证过)**:提前守卫(runner.ts:431)和兜底守卫(runner.ts:274)都是检查 `decidedBy === undefined`。一个绕过 TS 类型系统的调用方传 `null`:`null !== undefined` → 两道守卫都放行 → graph 在 runner.ts:456 推进 → `null` 到达 insertApproval → 撞上 `decided_by TEXT NOT NULL` 约束(audit-store.ts:390)抛出 SqliteError。checkpoint 已经推进,审计从没写入,workflow_runs 从没刷新——正是 R2-5 本该消灭的"晚失败/不一致",只是触发值从 `undefined` 换成了 `null`。这道守卫自述的目的是"防范调用方绕过类型系统"(runner.ts:432 的注释),但它只挡住了非法值里的一个,比它自称的职责范围要窄。
- **为什么我降级,不照抄 Codex 的阻断级评级**:① 实际可达性接近零——需要同时"绕过 TS"和"specifically 传 null";② **不存在悄悄污染**:`decided_by NOT NULL` 保证它永远会**大声失败**,永远不会写出一条损坏的行;③ "checkpoint 推进但 workflow_runs 从没刷新"这种失效类别本来就是系统对**任何**中途写入失败的既有行为(runner.test.ts:723 的 gate 事务测试已经接受并锁住了"workflow_runs 从不被虚假推进",之后用正确类型续跑还能继续)——这不是 null 特有的新腐蚀;④ 早在 R2,Zorro 自己就已经把整个 R2-5 家族评为轻微加固项。
- **既然 R4-1 反正要强制返工一轮,顺手修一下**:把两道守卫从 `=== undefined` 放宽到 `typeof decidedBy !== "string"`(或至少 `decidedBy == null`),给 R2-5 的测试加一个 `null` 用例。

## R3 无回归确认

- 四层之间都没有反向依赖:`grep -rln "from.*loop" src/harness src/context src/prompt` **为空**;`audit-store.ts` 没有 import `@langchain/langgraph`(只在第 27 行的注释里提到过)。
- graph 节点/gate 零 SQLite I/O:`grep -rnE "better-sqlite3|Database\(" src/loop/{gates,escalation,graph}.ts src/loop/nodes` **为空**。
- 占位符/危险代码:没有——没有装成真实数据的 TODO/stub/假数据,没有 drop-database/密钥/注入/外泄(两个模型都确认)。
- R2-2 的一个潜在顾虑已经手动核实并排除:虽然 draft/review 分支里的 `nextStepRef` 在输出守卫**之前**就无条件自增,但 coder/tester 节点(coder.ts:62 / tester.ts:60)总是要么返回一个输出、要么抛错——不存在"一个 chunk 带着节点名但没有输出"这种路径——所以不存在"计数器推进了但标记从没写"这种新的冲突情形(Codex 独立同意)。记一笔前瞻性提醒:这条不变量依赖于节点的契约;如果未来某个节点被改成可以返回一个没有输出的 partial,这里需要同步收紧——这一轮不是 bug。

## R3 bug 归因拆解

| 归因 | 项目 |
|---|---|
| 其他(审计精度/文档/幻觉) | R3-1(errors.ts 陈旧注释+信息,幻觉门同类扫尾漏项) |
| 集成问题(守卫完整性) | R3-2(decidedBy 守卫挡住 undefined 但不挡 null) |

## R3 七道门

- 需求符合度 ✓(R2-1/R2-2 threshold 作为一个真实变量 >2 + 零 claim 冲突现在都被测试锁住了;escalation 硬分支不变量真正锁住)
- 影响范围 ✓(R2 所有区域都覆盖了;扫尾检查手动跑过并交叉核对了同一类家族,抓到 errors.ts 一处残留)
- 占位符拒绝 ✓
- 危险代码 ✓
- **幻觉检查 ✗**(R3-1:errors.ts 的注释 + 运行时信息跟 A4b 现实矛盾,R2-7 没扫干净的同一个家族——这是这道门被卡住的地方)
- 文档完整性 ✓(PRD/impact 内嵌在 PRD + 本测试报告里,R1-R3 三轮完整;R3 这一节是追加的,没动 R1/R2)
- 文档同步(大设计级别) 不适用(项目级 aeloop;基地的四份权威文档不涉及)

## R3 知识库交叉核对(核对它,不是维护它)

- **触及已索引模块:是**(runner.ts/audit-store.ts 再次改动:新增 `step_markers` 表 + `insertStepMarker` + `listStepRefsByRun` 现在联合三张表,`langgraph_thread_id UNIQUE`,decidedBy 守卫提前)。
- 跟 `CHARTS/knowledge/aeloop.md`(ai-agent 仓库,last-verified 2026-07-21)交叉核对:**已经漂移,需要 Cypher 同步**——
  - 第 221 行:`listStepRefsByRun` 记录的是联合"**两张表**,`structured_claims`∪`approvals`"→ 现在是**三张表**(+`step_markers`)。**陈旧。**
  - **缺失**了 `step_markers` 表 + `insertStepMarker()` 条目(R2-2 新增)。
  - **缺失**了 `langgraph_thread_id UNIQUE` 约束(R2-4 新增)。
  - **缺失**了 decidedBy 守卫被挪到 `resumeRun` 开头这件事(R2-5)。
  - 顶部 banner 的"281/281 测试全绿"/"等 Zorro R2 复审"都陈旧了(现在是 288,R3 阶段)。
- **要求**:Cypher 完成 R4 返工之后,需要同步上面 4 项 + bump `last-verified`。维护知识库是 Cypher 的活,我只报告漂移。

## R4 返工清单(给 Cypher)

- **R4-1(阻断门,幻觉门)**:重写 `errors.ts` 的类注释(:9-18)+ `UnhandledGateDecisionError` 的抛出信息(:26-27),反映 A4b 的现实——Escalation 子树已经搭好了;G2 的 `rejected` 是**故意永久**不处理的失败即报错守卫,不是"A4b 会填补的占位符"。修完之后,`grep -rniE "will add|until A4b|A4a (builds|has no)"` 应该只剩下"以前是这么写的……"这种(修正过的历史注释)命中。
- **R4-2(轻微加固,顺手做)**:把 `resumeRun` 的提前守卫(runner.ts:431)+ `runStreamAndPersist` 的兜底守卫(runner.ts:274)从 `=== undefined` 放宽到 `typeof decidedBy !== "string"`(或 `decidedBy == null`);给 R2-5 的测试加一个 `null as unknown as string` 用例,断言在 graph 推进之前依然抛错,checkpoint 不动。
- **R4-3(知识库同步,不是代码)**:重新同步 `CHARTS/knowledge/aeloop.md` 的 4 处漂移 + bump last-verified(见上面"知识库交叉核对")。
- 如果 R4-2 因为生产逻辑再次动到 runner,还需要第四轮 Codex 二签(errors.ts 纯文本/知识库改动不强制重新二签,但如果同一批次里 runner 也被动了,就一起签)。

## R3 待指挥官裁决的事项

- **R3-2 严重度分歧**:Codex 判定阻断级(null 绕过守卫,重建出一个不一致的状态),我判定轻微(不存在悄悄污染,需要双重非标准触发,这本来就是系统对任何写入失败的既有失效模式)。目前按轻微处理,但仍然列进 R4(顺手修)。如果指挥官同意 Codex 的看法、想升级成阻断级,返工清单不需要变,只是叙述的严重度变。
- D1/D2/M1(R1/R2 遗留待定项)——这一轮没有新证据,状态跟 R2 一致。

## R3 结论

**FAIL,需要 Round 4(窄)。** 我通过变异真正锁住了 R2 七个核心修法里的 6/7 + gate 分支的变异印证了那次如实披露;Codex 的独立二签也独立同意七个里有六个真正闭环了。只剩两个小项挡门:**R4-1**(errors.ts 幻觉门同类陈旧内容,挡幻觉门)+ **R4-2**(decidedBy 守卫的 null 完整性,顺手修)+ **R4-3**(知识库同步)。都是小改动,预计一轮就能收敛。目前**未 commit/push**,工作区 5 个文件逐字节恢复原样(`shasum -c` 全部 OK:gates 5fbac639 / runner c84ef31e / audit-store b30bd84a / graph ed767f27 / escalation b51634b3),HEAD `c6589b7` 未动。

---

# A4b Loop — Zorro Round 4 复审(R3 三个返工项之后)

---ATTESTATION (R4)---
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T04:37:46.737Z",
  "completed_at": "2026-07-21T04:46:42.129Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "A4b R4 wrap-up: errors.ts wording accuracy + decidedBy guard typeof hardening + adversarial scan of errors/runner production logic",
  "git_commit": "c6589b71d990d21ca859a7b16889c8e22a0ecae2",
  "diff_base": "c6589b7",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "8c3bb8d583a1fe38d60fc43e1be385f49a99edbcc2679a6b263b2d7620206171",
  "independent_review_completed": true,
  "fallback_used": false
}
---END ATTESTATION (R4)---

## 复审结论:FAIL(R3 的三个项 R4-1/R4-2/R4-3 都真正闭环了;但 Codex 第四轮二签挖出了两个**前三轮都漏掉的既有审计一致性阻断级问题**,其中一个我亲手复现过)

- 二签引擎:Codex `gpt-5.6-sol`(只读),`raw_output_sha256=8c3bb8d5…` 非空,手动核对落盘证据文件 `aeloop repo .helix/zorro-raw-output/8c3bb8d5….txt` 的 shasum == 其内容寻址的文件名(独立复审真的发生过)。
- 独立重跑:`pnpm build`(tsc)/ `pnpm lint`(tsc --noEmit)/ `pnpm test` = **291/291 全绿**(34 个文件,自己跑的,不是听自报——比 R3 的 288 多 3 个,新增 errors.test.ts 2 个用例 + runner 一个 null 用例,共 1)。
- 变异测试:R4-1/R4-2 各自在生产代码里手动变异,验证测试变红/变绿(见下表),errors.ts/runner.ts/gates.ts 编辑后逐字节恢复原样(errors `c02496fd` / runner `4e23fc8f` / gates `5fbac639`),HEAD `c6589b7` 未动。**注意**:errors.ts 是一个受 git 跟踪且已改动的文件,所以 `git checkout` 会把它恢复到 HEAD(旧的 A4a 版本)而不是 R4 worktree 版本——我改用"Edit 正向变异→Edit 反向恢复",或者先 Read 快照再 Write 写回,并且之后交叉核对恢复的 shasum == R4 基线。
- 两个模型的结论:Zorro FAIL / Codex FAIL。**分歧点**:Codex 把两个既有问题都评为阻断级;我接受 B1 是事实(亲手复现过,评为阻断级),但 B2(并发)我接受事实的同时,对"这一轮该不该硬挡门,还是记为已知局限"保留判断(理由见下,类比 D1)。

## 核实 R3 三个返工项(逐个手动验证,不是听 Cypher 自报的)

| 项目 | 我做的变异/验证 | 目标 | 结果 | 结论 |
|---|---|---|---|---|
| R4-1 | 把 `errors.ts` 的抛出信息还原成旧的陈旧措辞(`A4a has no routing target...A4b will add one`) | `errors.test.ts:25-27` "信息不包含旧短语" | **变红**(1 个失败:匹配到了 `/A4b will add/`) | ✅ 真正锁住 |
| R4-1 | 扫尾 grep `grep -rniE "will add\|until A4b\|A4a (builds\|has no)\|minus the escalation" src/loop/*.ts` | 同类陈旧内容有没有扫干净 | 只剩 `graph.ts:8`("以前是这么写的……"——修正过的历史,准确)+ `types.ts:147`(A4a/A4b 归因,准确);**errors.ts 现在彻底干净了** | ✅ 扫干净了 |
| R4-1 | 悬空引用检查:注释里引用了 `gates.ts routeAfterG2` "A4b 未改动"+ 信息里引用了"a4a PRD §2 非目标 #2" | 引用真实性(幻觉门) | `gates.ts:159` 确实有"A4b 未改动"这句话;`a4a PRD` 的第二个非目标项确实就是那个 G2/rejected 的——两者都是真的,没有张冠李戴 | ✅ 无幻觉 |
| R4-2 | 把两道守卫都还原成 `=== undefined` | `runner.test.ts:820` null 用例 | **变红**,而且失败模式确实是"晚失败":错误从 `/decidedBy is required/` 变成了 DB 层的 `NOT NULL constraint failed: approvals.decided_by`(证明 null 以前真的会溜过两道守卫,而这时 graph 已经推进了) | ✅ 真正锁住 + 失败模式确认 |
| R4-2 | 同一个变异 | `runner.test.ts:785` undefined 用例(R2-5 场景) | **依然全绿**(14 通过 / 1 失败) | ✅ R2-5 没被破坏 |
| R4-2 | 手动读提前守卫的位置 | graph 推进之前 | 提前守卫(runner.ts:449)在 `getRunById`(456)/`compileLoopGraph`(464)/`compiled.stream()` **之前**;两道守卫都是 `typeof decidedBy !== "string"` | ✅ 位置正确 |
| R4-3 | 知识库语义交叉核对(见下"知识库交叉核对")+ `verify-knowledge aeloop` | 知识库是不是真的同步了 | step_markers 第四张表 / `insertStepMarker` 签名 / `langgraph_thread_id UNIQUE` / 三表联合 / decidedBy 守卫历史 / 顶部 banner"291 + 等 R4 复审" 全部跟代码对得上;机械扫描绿 | ✅ 真正同步了 |

**R3 的三个项 R4-1/R4-2/R4-3 都真正闭环了**(Codex 独立二签同意:R4-1 的注释+信息 OK,R4-2 的两道守卫 OK)。这一轮的 FAIL **不是**因为这三个没修好——是 Codex 第四轮二签把审查面从"R4 的三个项"扩大到了整个 `errors.ts`/`runner.ts` 生产逻辑,挖出了两个**从 R1 起就存在、前三轮(包括前三次 Codex 二签)都漏掉的审计一致性漏洞**——之前几轮的续跑测试只喂过"gate 决定域匹配"的合法值,也从来没有并发跑过同一个 run,所以这类问题以前根本抓不到。

## R4 新发现(两个既有阻断级问题 → 需要 R5)

### 🔴 R5-B1(Codex 判定阻断级,**我亲手复现过,接受为阻断级**):`resumeRun` 没有校验"当前暂停的 gate"跟 `resume.decision` 的值域是不是匹配 → 非法 approval 落进 DB + checkpoint/审计分裂

- **机制**:`resumeRun` 的 `resume: GateResumeValue | EscalationResumeValue` 是一个**没有判别标签的联合类型**。`{decision:"force_pass"}` 是一个合法的 `EscalationResumeValue`,而把它传进一个**当前暂停在 G1** 的 run,**TS 层面是合法的,不需要任何类型断言**。
- **我亲手复现过**(一个临时的 vitest 探针,跑完立刻删掉,之后核实工作区干净):startRun 暂停在 G1 → `resumeRun(deps, runId, threadId, {decision:"force_pass"}, "human", …)` →
  - `approvals` 多出一行**非法的 approval**:`{gate_type:"G1_SEND_TO_TESTER", step_ref:"g1#1", decision:"force_pass", decided_by:"human"}`——把一个 Escalation 决定值记成了一次 G1-gate approval;
  - `routeAfterG1` 随即抛出 `routeAfterG1: unexpected g1Decision "force_pass"`;
  - **分裂状态**:checkpoint `next=[]`(graph 已经越过 G1 推进了)vs. `workflow_runs` 依然是 `status=running/current_state=g1`(从没推进)——两个事实来源互相矛盾,外加一条本不该存在的 approval 行。
- **为什么这是阻断级**:① 这跟 R1 的 **B2**(runId/threadId 不匹配 → 悄悄污染审计)是**同一类缺陷**——调用方传了一个本不该被接受的输入,系统本该在**任何写入之前就大声失败**(B2 正是这么修的:`RunThreadMismatchError`,零写入);这里却是先落一条非法行,然后才抛错;B2 当时被判定为阻断级,按同一把尺子,B1 也是阻断级。② 这比 R4-2 刚加固过的 null 情形**更容易触达**:null 需要 `as unknown as string` 才能强行绕过类型系统,B1 **完全不需要任何类型断言**。Zorro 自己这一轮才加固了 null 情形(判定值得修),没理由放过一条不需要断言就能落一条非法 approval 的路径。③ aeloop 的差异化卖点正是"一条可审计的链路"——一条非法的 approval 行 + 一个分裂的状态直接砸在这个卖点上。
- **修法(给 Cypher 的 R5)**:在 `resumeRun` 的最开头,碰 graph 或写任何行之前,先校验 `resume` 的决定域是不是跟这次 run 当前暂停的 gate 匹配——从 checkpoint/`getState().next` 读出当前待处理的节点;如果是 G1/G2/G3 gate,resume 必须是 `GateResumeValue`(approved/rejected,G2 额外允许 escalate);如果是 escalation gate,才允许 `EscalationResumeValue`;不匹配就抛一个带类型的错误(仿照 `RunThreadMismatchError`,大声失败,零写入)。

### 🟡/🔴 R5-B2(Codex 判定阻断级,**我接受事实,把严重度交给指挥官裁决**,类比 D1):同一个 run 的并发 `resumeRun` 调用没有串行化/CAS/版本检查 + 审计表没有 `(run_id, step_ref)` 唯一性约束

- **Codex 的复现**(针对生产 SqliteSaver 的一个探针;并发场景我自己没有亲手重跑,但**手动验证了两个代码层面的前提**):
  - 两次并发的 approve 调用都成功 → 出现两条 `G1/g1#1` approval 行 + tester 跑了两次;
  - 一次并发的 approve 和 reject 都成功 → 同一个 `g1#1` 同时记了两个相反的决定,一次调用返回 G3,另一次返回 G1,checkpoint 最终落在 reject 分支上。
- **代码层面的印证(手动验证过)**:① `runner.ts` 的 `resumeRun` **哪里都没有**锁/互斥/CAS/`BEGIN IMMEDIATE`/版本检查(手动 grep 过,只命中不相关的注释);② `approvals` 和 `step_markers` 表都**除了 `id` 主键之外没有别的约束——没有 `UNIQUE(run_id, step_ref)`**(手动读 DDL 验证过,audit-store.ts:381/401)——重复的 step_ref 在 schema 层面完全没被拦住。两个前提都成立,所以 Codex 的并发竞态在代码里是站得住的。
- **为什么我把严重度交给指挥官裁决(不照抄 Codex 的阻断级评级)**:A4b 是一个**单操作者 CLI** 的 loop 模型;"两次调用同时续跑同一个 run"目前在验收范围之外,性质上跟 **D1(跨进程的 step_ref 冲突)**类似——Zorro 当时判的是"待指挥官裁决/一个已知局限",不是硬阻断。但 aeloop 对外的卖点正是"生产化的跨进程续跑",这确实会引来并发场景,所以我没法像对 D1 那样直接把它归为可接受的局限。**这个交给指挥官裁决**:硬挡进 R5,还是记为已知局限 + 开一个追踪 issue。**不管选哪个,纵深防御都很便宜**:加 `UNIQUE(run_id, step_ref)`(至少挡住重复的 approval 行)+ 给同一个 run 的续跑加串行化(`BEGIN IMMEDIATE` 或应用层的按 run 加锁 + checkpoint 版本检查)。

## R4 轻微项(不挡门,记一笔)

- **M-R4a(Codex 判定轻微,我接受)**:`errors.test.ts:9-16` 的注释声称旧措辞"在 A4a 自己的增量里是准确的"——Codex 指出 A4a PRD **早就**规定了 `rejected` 会抛错,A4b 加的是独立的 `escalate` 值,不是"给 rejected 加一条路由"——所以这句"旧措辞在 A4a 里是准确的"本身有点不精确;而且那个测试只对三个旧短语做了 `not.toMatch`,从没正面锁定完整信息文本。**生产信息本身是对的**(我验证过),这是一个测试注释/覆盖率的小问题,不挡幻觉门。建议 Cypher 顺手把注释措辞收紧一点 + 可以加一条正面断言锁定核心语义(比如信息里包含"permanent"/"no routing target")。

## R4 无回归确认(R1/R2/R3 通过的项目没有被这一轮改动破坏)

- Codex 独立重新核对:B2(run/thread 配对 + thread UNIQUE,runner.ts:456 / audit-store.ts:361)、B3(draft/review/gate 分组事务,runner.ts:214)、D1(落盘计数器重建 + 调用方取最大值,runner.ts:144/223)、R2-2(零 claim step marker)**都没有回归**。
- 占位符/危险代码:Codex 和我判断一致——`src/loop` 里没有装成生产代码的 TODO/stub/假数据,没有 drop-database/密钥/网络外泄/SQL 注入;动态 `UPDATE` 的列名来自一个写死的集合,值都是参数化的。
- 291/291 手动跑绿,build/lint 干净,三个文件逐字节恢复原样,HEAD 未动。

## R4 bug 归因拆解

| 归因 | 项目 |
|---|---|
| 集成问题(缺少输入域校验) | R5-B1(gate/决定域没被校验 → 非法 approval + 分裂状态) |
| 并发/竞态条件 | R5-B2(并发续跑没有串行化 + 审计表缺少 step_ref 唯一性约束) |
| 其他(测试注释/覆盖率) | M-R4a(errors.test.ts 注释措辞 + 没有正面锁定全文) |

## R4 七道门

- 需求符合度 ✓(R3 的三个项 R4-1/R4-2/R4-3 都真正闭环;escalation 硬分支/threshold 作为真实变量/三张审计表都还锁着)
- **影响范围 ✗**(`resumeRun` 的**输入域校验面**不完整:缺少 gate↔决定域的交叉校验 → 一条非法 approval 可以落进 DB,B1;并发续跑面没有防御,B2——前三轮的影响分析都没提出过这两个面)
- 占位符拒绝 ✓
- 危险代码 ✓
- 幻觉检查 ✓(R4-1 的注释+信息跟 A4b 现实对得上,引用都是真的;M-R4a 只是测试注释措辞轻微,生产文本是对的,不挡这道门)
- 文档完整性 ✓(PRD/impact 内嵌在 PRD + 本测试报告里,R1-R4 完整;R4 这一节是追加的,没动 R1/R2/R3)
- 文档同步(大设计级别) 不适用(项目级 aeloop;基地的四份权威文档不涉及)

## R4 知识库交叉核对(核对它,不是维护它)

- **触及已索引模块:是**(errors.ts/runner.ts 的生产逻辑这一轮又改了)。
- 跟 `CHARTS/knowledge/aeloop.md`(ai-agent 仓库,last-verified 2026-07-21)交叉核对:**Cypher 在 R4 已经同步过了,我逐项手动核对准确**——
  - R4-2 的守卫历史:第 234 行记录"R2-5 提前 + R4-2 放宽到 `typeof decidedBy !== "string"`,自我验证变异的失败点从 'decidedBy is required' 变成 NOT NULL"——跟 runner.ts 的代码对得上 ✓
  - 第四张表 step_markers + `insertStepMarker({runId,stepRef,node,actor,claimCount})`:第 217/222 行——跟 audit-store.ts 的 DDL(step_markers 的 CREATE TABLE)+ 签名对得上 ✓
  - `langgraph_thread_id TEXT NOT NULL UNIQUE`:第 217/361 行——对得上 ✓
  - `listStepRefsByRun` 的三表联合(structured_claims∪approvals∪step_markers):第 221 行——跟 `[...claimRows,...approvalRows,...markerRows]`(audit-store.ts:562)对得上 ✓
  - 顶部 banner:291/291 + "等 Zorro R4 复审" + R4-1/R4-2 描述——已经同步 ✓
  - `verify-knowledge aeloop` 的机械扫描是**绿的**(没有路径/签名漂移)。
- **知识库不需要再改。** ⚠️ 但如果 R5 按上面的方式修了 B1(+可能修 B2),`runner.ts`/`errors.ts`/`audit-store.ts` 会再次被动(一个新的带类型的 error / 一个新的 UNIQUE 约束),**R5 返工之后 Cypher 需要重新同步对应的知识库条目 + bump last-verified。**

## R4 待指挥官裁决的事项

- **R5-B2 的严重度**:并发续跑的竞态条件——这一轮硬挡进 R5 修掉,还是记为已知局限(类比 D1)+ 开一个追踪 issue,等真到 A5(CLI/多操作者)才需要的时候再处理?(不管选哪个,建议至少加 `UNIQUE(run_id, step_ref)` 作为一份便宜的纵深防御。)
- D1/D2/M1(R1/R2 遗留待定项)——这一轮没有新证据,状态不变。

## R4 结论

**FAIL,需要 Round 5。** **给指挥官的明确信息:A4b 这一轮不能进 commit/merge 流水线。** 我亲手验证了 R3 分配的三个项(R4-1 errors.ts 措辞、R4-2 decidedBy 守卫加固、R4-3 知识库同步)都真正闭环了,291/291 全绿,没有回归——**这三个,Cypher 做对了。** 但这一轮不是能收尾的那一轮:Codex 第四轮二签把审查面扩大到了整个 `errors.ts`/`runner.ts`,挖出了两个从 R1 就潜伏、前三轮(包括三次 Codex 二签)都漏掉的既有审计一致性阻断级问题——**R5-B1**(gate/决定域没被校验 → 非法 approval 落进 DB + checkpoint/审计分裂,**我亲手复现过,不需要类型断言就能触发**,跟 B2 是同一类缺陷,接受为阻断级)+ **R5-B2**(并发续跑没有串行化 + 审计表缺少 step_ref 唯一性约束,事实已确认,严重度交给指挥官裁决,类比 D1)。两个都直接砸在 aeloop 的卖点上(一条可审计的链路),B1 尤其不能带着这个问题合并。R5 返工:**B1 是必修项**(在 resumeRun 开头校验决定域是否匹配当前暂停的 gate,大声失败,零写入)+ **B2 待指挥官裁决**(硬修或记为局限,建议至少加 `UNIQUE(run_id, step_ref)`)+ M-R4a(顺手做)。runner/errors(+可能 audit-store,如果 B2 被硬修)的生产逻辑还会再被动,**R5 还需要第五轮 Codex 二签 + 一次知识库重新同步。** 目前**未 commit/push**,工作区三个文件逐字节恢复原样(errors `c02496fd` / runner `4e23fc8f` / gates `5fbac639`),HEAD `c6589b7` 未动。

---

# A4b Loop — Zorro Round 5 复审(R4 两个返工项之后——预期的收尾轮)

---ATTESTATION (R5)---
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T05:16:22.219Z",
  "completed_at": "2026-07-21T05:26:08.084Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop",
  "review_scope": "A4b R5 closing-level full review: R5-B1 decision-domain validation + R5-B2 UNIQUE + full A4b (runner/gates/escalation/audit-store/errors) adversarial scan",
  "git_commit": "c6589b71d990d21ca859a7b16889c8e22a0ecae2",
  "diff_base": "c6589b7",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "ac548af6c10aae177f7eb7e34b8d4bb815a4aab83e80eab59477429576ff2ea6",
  "independent_review_completed": true,
  "fallback_used": false
}
---END ATTESTATION (R5)---

## 复审结论:FAIL(**没收尾**——R4 的两个返工项方向都对、也确实锁住了各自设计要解决的场景,但 R5-B1 的修法**颗粒度不够精细**,只堵住了它本该消灭的失效类别的一半:两个模型独立同意,同一个失效类别还有 **3 条不需要类型断言的路径**能溜过去)

- 二签引擎:Codex `gpt-5.6-sol`(只读),`raw_output_sha256=ac548af6…` 非空,手动核对落盘证据文件 `aeloop repo .helix/zorro-raw-output/ac548af6….txt` 的 `shasum -a 256` == 其内容寻址的文件名(独立复审真的发生过)。
- 独立重跑:`pnpm build`(tsc)/ `pnpm lint`(tsc --noEmit)/ `pnpm test` = **296/296 全绿**(34 个文件,自己跑的,不是听自报——跟 Cypher 自报的 296/296 对得上)。
- 变异测试:R5-B1 的守卫 + R5-B2 的两个 UNIQUE 约束各自在生产代码里手动变异,验证测试变红/变绿(见下表);另外用**临时探针**(跑完立刻删掉,之后核实工作区干净)亲手复现了 R5-B1 遗留的 3 条渗透路径 + Codex 说的 B2 中途分裂状态。工作区 5 个文件全部 shasum 逐字节恢复原样(runner `5c61ed2c` / gates `5fbac639` / audit-store `5ef19e01` / errors `8b15e1b0` / escalation `b51634b3`),HEAD `c6589b7` 未动。
- 两个模型的结论:Zorro FAIL / Codex FAIL。**独立同意**:R5-B1 的决定域守卫映射不精确,同一个失效类别的 3 条不需要断言的路径依然完全存在;各自也分别指出一个正常中途失败导致的 checkpoint/workflow_runs 分裂(B2)。

## 对两个 R4 返工项重新跑变异(逐个手动验证,不是听 Cypher 自报的)

| 项目 | 我做的变异 | 目标测试 | 结果 | 结论 |
|---|---|---|---|---|
| R5-B1(设计场景) | 把 `runner.ts:515` 的决定域校验 `if(...)` 改成 `if(false && ...)` | `runner.test.ts:467` "force_pass 喂给 G1 → ResumeDecisionDomainMismatchError,零 approval,workflow_runs 不动,checkpoint 不推进" | **变红**(错误变成了 `routeAfterG1: unexpected g1Decision`,精确复现了 R4 描述的失效模式:"非法 approvals 行先落地→之后才撞上 routeAfterG1") | ✅ 这道守卫真正锁住了**它设计要解决的跨域场景** |
| R5-B2(approvals) | 在 `audit-store.ts` 里去掉 `approvals` 表的 `UNIQUE(run_id, step_ref)` | `audit-store.test.ts:325` "重复 (run_id, step_ref) 的 approval 被拒绝" | **变红**(不再抛 UNIQUE constraint failed) | ✅ 真正锁住 |
| R5-B2(step_markers) | 在 `audit-store.ts` 里去掉 `step_markers` 表的 `UNIQUE(run_id, step_ref)` | `audit-store.test.ts:411` "重复 (run_id, step_ref) 的 marker 被拒绝" | **变红** | ✅ 真正锁住 |

**R4 的两个返工项都真正锁住了各自设计要解决的场景**(force_pass 跨域被守卫抓到,两个 UNIQUE 约束都真正生效)。这一轮的 FAIL 不是因为方向错了,是 R5-B1 的守卫有一个**颗粒度**缺口——一个跟它本该消灭的失效类别属于同一家族的漏洞。

## R5 新发现(1 个必修阻断级 + 1 个严重度交给指挥官裁决)

### 🔴 R6-B1(必修阻断级,两个模型独立同意,我亲手逐一复现了全部 3 条路径):`resumeDecisionsFor` 的决定域映射不精确,3 条不需要类型断言的路径依然会落下非法 approval + 分裂状态

- **机制**:`runner.ts:152` 的 `resumeDecisionsFor` 把 g1/g2/g3 **三个 gate 统一**映射成 `["approved","rejected","escalate"]`,但按 `gates.ts` 的 `routeAfterG1/G2/G3` switch 语句,三个 gate **实际**接受的集合各不相同:

  | Gate | 路由函数实际接受的值 | 守卫**过度放行**的非法值 | 命中的位置 |
  |---|---|---|---|
  | G1 | `approved` / `rejected` | `escalate` | `routeAfterG1` 的 `default: throw` |
  | G2 | `approved` / `escalate` | `rejected` | `routeAfterG2` 的 `UnhandledGateDecisionError` |
  | G3 | `approved` / `rejected` | `escalate` | `routeAfterG3` 的 `default: throw` |
  | escalation | `revise` / `force_pass` / `abandon` | 无(这个 gate 是精确的) | — |

- **这三个泄漏的值都是合法的 `GateResumeValue`(`{decision:"escalate"}` / `{decision:"rejected"}`),完全不需要类型断言**——跟 R4-2 刚加固过的 `null` 情形(需要 `as unknown as string`)一样容易触达,也跟 `force_pass`(跨域,R4 判定阻断级)一样容易触达(force_pass 同样不需要断言)。
- **我亲手逐一复现了全部 3 条**(临时 vitest 探针,跑完立刻删掉,之后核实工作区干净)——每一条都精确复现了 R5-B1 本该消灭的那种失效类别:
  - **G1 + `escalate`**:守卫放行(`isDomainMismatch:false`)→ 一条非法行落地:`{gate_type:"G1_SEND_TO_TESTER", step_ref:"g1#1", decision:"escalate"}` → `routeAfterG1: unexpected g1Decision "escalate"` 抛错 → 分裂状态(checkpoint `next=[]` vs. `workflow_runs` 依然是 `status=running/current_state=g1`)。
  - **G3 + `escalate`**:一条非法行落地:`{gate_type:"G3_FINAL_MERGE", step_ref:"g3#1", decision:"escalate"}` → `routeAfterG3` 抛错 → 同一类分裂状态(`current_state=g3` vs. `next=[]`)。
  - **G2 + `rejected`**:一条非法行落地:`{gate_type:"G2_SEND_TO_FIX", step_ref:"g2#1", decision:"rejected"}` → `UnhandledGateDecisionError` 抛错 → 同一类分裂状态(`current_state=g2` vs. `next=[]`)。
- **为什么这是阻断级(拿 R4 判定 B1 阻断级的同一把尺子量)**:① **同一失效类别**——非法输入本该在**任何写入之前**大声失败(这正是 B1 修法自我承诺的东西,见 `errors.ts:107` 的 ResumeDecisionDomainMismatchError 文档原文:"拒绝推进 graph 或写一条 approvals 行,如果那个决定跟它被应用的 gate 不匹配")——但这三条依然是**先落一条非法 approval 行,然后才抛错**;② **不需要类型断言**,跟 force_pass 一样容易触达,而 force_pass 已经被 R4 判定为阻断级;Zorro 自己这一轮才加固了(需要断言的)`null` 情形,没理由放过一条不需要断言就能落一条非法 approval 的路径;③ 直接砸在 aeloop 的卖点上(一条可审计的链路)——一条伪造的 gate-决定行 + 两个互相矛盾的事实来源;④ **偏离了 R4 明确分配的修法**:R4-1 的返工文字明写着,"对于 G1/G2/G3 gate,resume 必须是 `GateResumeValue`(approved/rejected,**G2 额外允许 escalate**)"——已经写明 G1/G3 只接受 approved/rejected,只有 G2 额外接受 escalate;实现却把三个 gate 拍平成同一个三值域,而正是这个拍平打开了这个漏洞。
- **这不是"一个未知的新问题",它其实已经被记进知识库和注释里当成"已接受"的东西——但那个"已接受"的说法站不住**:`runner.test.ts:520` 的注释自述"这道守卫只检查粗粒度的 resume 值域,不做逐 gate 的路由校验",`CHARTS/knowledge/aeloop.md:234` 同样把"G1 收到 `escalate` 依然会落进 `routeAfterG1` 的 `default: throw` 兜底,不变"当成一条中性的设计说明——**但同一段话刚宣称 R5-B1 消灭了"先落一行本不该存在的行 + 分裂状态",它自己后半句就承认这条路径依然会这样干**——自相矛盾。PRD §4.1(第 89 行)确实**提前**把"escalate 落到 G1/G3 的 default:throw"框定为可接受的——但那句话是在 R5-B1 被发现**之前**写的,R5-B1 整件事的意义就是发现了"它会抛错,但只有在写了一条脏 approval 行 + 撞裂 checkpoint 之后才抛错"对一个以审计为先的产品来说**不可接受**。force_pass-at-G1 具有一模一样的"PRD 曾说类型允许/gate 不识别是可接受的"性质,R4 依然判定它是必修阻断级并且修了它——不能一个实例判必修,同一类的另一个实例就放它当已接受局限溜走。
- **另一处幻觉门印证(Codex 也指出了同一点,手动验证过)**:`errors.ts:123-128` **实际抛出的运行时信息**是"G1/G2/G3 gates only accept GateResumeValue's approved/rejected/escalate"——这句话**事实上是错的**(G1/G3 不接受 escalate,G2 不接受 rejected),意味着那个不精确的域模型已经直接印进了一条已经上线的错误信息里。
- **修法(给 Cypher 的 R6)**:让 `resumeDecisionsFor` 按 gate 精确返回,照着每个 `routeAfter*` switch 语句里实际接受的集合:`g1→[approved,rejected]` / `g2→[approved,escalate]` / `g3→[approved,rejected]` / `escalation→[revise,force_pass,abandon]`;顺手更正 `ResumeDecisionDomainMismatchError` 的信息、`runner.test.ts:520` 的注释,以及知识库第 234 行的说法;给 G1+escalate / G3+escalate / G2+rejected 各加一个拒绝测试(断言 `ResumeDecisionDomainMismatchError`,零 approval,workflow_runs 不动,checkpoint 不推进)。

### 🟡/🔴 R6-B2(Codex 判定阻断级,**我接受事实,把严重度交给指挥官裁决**,比 D1 更容易触达):一次正常的中途节点失败 → checkpoint 已经推进但 `workflow_runs` 从没刷新,两个事实来源分裂

- **机制**:`runStreamAndPersist` 是逐个 chunk 边跑边写 approval/claim 的(从 runner.ts:229 开始),但 `updateRunProgress`(刷新 `workflow_runs.status/current_state` 的那个)只在**整个 stream 成功跑完之后**才运行(runner.ts:372)。如果中途任何节点抛错(比如 tester adapter 变得不可用,或者模型输出解析失败),错误直接向外传播,`updateRunProgress` 从来不会运行——而 LangGraph 自己的 checkpoint 是**增量落盘**的,所以一个已经推进的 gate(比如 G1 approved)早就落进了 checkpoint。
- **我亲手复现过**(一个临时探针,把 tester adapter 设成 `throw "tester unavailable"`):一次合法的 G1 approve → graph 推进到 review → tester 抛错 →
  - `approvals` 已经有 `g1#1/approved`(G1 那一步完成时留下的合法行);
  - checkpoint:`next=["review"]`,`g1Decision="approved"`(**已经越过 G1 推进**);
  - `workflow_runs`:`status=running / current_state=g1`(**从没推进**);
  - `resumeRun` 整体抛出 `tester unavailable`,`updateRunProgress` 从来没跑。
  → 业务账本的 `current_state=g1` 跟 graph 的真实位置(review)变成**永久不一致**;`getResumableRuns`/未来的 CLI 读 `workflow_runs` 会拿到错的当前位置。**完全不需要任何非法输入,纯粹由一次正常的 adapter 失败触发。**
- **为什么我把严重度交给指挥官裁决(不照抄 Codex 的阻断级评级)**:R3 的复审(见上面 R2-3 的 gate 路径那一节)已经如实披露过这个架构缺口——"approval/claim 写入和 `updateRunProgress` 不在同一个跨行事务里"——当时锁定的方向是"`workflow_runs` 从不被**虚假推进**"(那个 gate 事务测试,runner.test.ts:723),指挥官在 R3 的报告里已经被告知这个缺口存在。B2 是同一个缺口的**另外那一半、不对称的一半**(checkpoint 推进了,workflow_runs 落后了),这一半以前从没被具体锁定过,也没被具体接受过。**但它跟 D1/#19(并发)不一样**——D1/#19 需要多个操作者/并发才能触达(在 A4b 单操作者-CLI 范围之外),而 B2 是一次普通的 adapter 失败就能触发,aeloop 的卖点正是"生产化的跨进程续跑"——这把 adapter 失败纳入了那个范围之内。所以我没法像对 D1 那样直接把它归为可接受的局限。**这个交给指挥官裁决**:R6 里硬修(建议:stream 失败时 `catch → 依据 checkpoint 的真实位置对 workflow_runs 做一次调和`,或者在 resume 开头做一次 checkpoint↔workflow_runs 的调和),还是记为已知局限 + 开一个追踪 issue(类比 D1/#19)。**我自己的倾向:偏向硬修,或者至少明确记录**——因为它落在产品对外承诺的容错生产续跑范围之内,不像并发那样明显在 A5 的范围之外。

## R5 轻微项(不挡门,记一笔)

- **M-R5a(=R4 的 M-R4a 遗留,Codex 又提了一次)**:`errors.test.ts:10` 的注释还在说旧信息"在 A4a 阶段是准确的"——但 G2 的 `rejected` 从 A4a 起就是故意永久失败即报错的,所以这句措辞还是有点不精确。生产信息本身是对的,测试注释是个小问题,顺手收紧。

## R5 无回归确认(R1-R4 通过的项目没有被这一轮改动破坏)

- R5-B2 的两个 `UNIQUE(run_id, step_ref)` 约束都真正生效(变异二次确认);`structured_claims` 正确地**没有**加同样的 UNIQUE——合理情况下同一轮内多条 claim 可以共享同一个 `step_ref`,加约束会破坏这个合法场景;对并发重复轮次的防护改由 **`step_markers` 事务内的标记**来覆盖(`runner.ts:245/277`,draft/review 分支的 insertStepMarker 跟 insertClaim 共用一个 `runInTransaction`)+ step_markers 的 UNIQUE 的**传递效果**(一个 marker 撞上 UNIQUE → 整组 claim 一起回滚),所以 structured_claims 不需要自己的 UNIQUE。两个模型 + 我自己本地重新验证(1 个 approval / 1 个 marker / 2 条合法 claim,没有残留冲突组)都同意这条排除是站得住的。
- 追踪 issue `elishawong/aeloop#19`:手动读过,**准确**——它记录了 R4 报告的 R5-B2 复现(并发 approve/reject 记下相反的决定)+ 指挥官的裁决(单操作者 CLI,完整并发控制延后到 A5+)+ 这一轮的便宜纵深防御(两表 UNIQUE + 变异测试)+ 如实记录的已知局限(UNIQUE 挡不住读侧竞态/checkpoint 层的并发)+ 未来修法的方向(乐观锁/串行化队列/BEGIN IMMEDIATE)。
- Codex 独立重新核对:阈值升级/三选一路由/graph 拓扑/workflow 定义都一致;四层之间没有反向依赖;gates/graph 节点零 SQLite I/O;没有 TODO/stub,没有 drop-database/密钥/注入/外泄;`git diff --check` 干净。我本地手动跑 296/296 全绿,build/lint 干净,5 个文件逐字节恢复原样,HEAD 未动。
- ⚠️ 因为 Codex 的只读沙箱不允许 Vite 写临时目录,它**没能启动完整的 Vitest 套件**;它的失败复现全部是针对当前 `dist` 的内存态真实 graph 跑的——**测试执行覆盖由我本地 296/296 全套跑通补上**,两者加在一起提供了完整覆盖(Codex 提供跨模型逻辑二签 + 真实 graph 失败复现,Zorro 提供全套测试执行 + 变异测试 + 探针式复现)。

## R5 bug 归因拆解

| 归因 | 项目 |
|---|---|
| 集成问题(输入域校验颗粒度不足) | R6-B1(决定域映射不精确,3 条不需要断言的路径落下非法 approval + 分裂状态) |
| 集成问题(缺少调用级原子性) | R6-B2(一次正常的中途失败 → checkpoint/workflow_runs 分裂) |
| 其他(测试注释) | M-R5a(errors.test.ts 注释措辞) |
| 幻觉门(运行时文本不精确) | R6-B1 的附带项:errors.ts:123 的信息把 G1/G2/G3 的域说错了 |

## R5 七道门

- 需求符合度 ✗(R5-B1"续跑决定域必须匹配当前暂停的 gate"这条要求只满足了一半——跨域情形被抓到了,但 3 个同域错 gate 的值没被抓到,而且 PRD §4.1 和 R4 的返工清单都明写了 G1/G3 只接受 approved/rejected)
- **影响范围 ✗**(`resumeRun` 的输入域校验**颗粒度**不完整:守卫是域级别的,不是 gate 级别的,漏了 3 条同类路径;中途失败的调用级原子性这个面,B2,也从没被影响分析提出来过)
- 占位符拒绝 ✓(没有 TODO/stub/假数据)
- 危险代码 ✓(没有 drop-database/密钥/注入/外泄;动态 UPDATE 列名来自一个写死的集合,值都是参数化的)
- **幻觉检查 ✗**(已上线的运行时信息 `errors.ts:123-128` 把"G1/G2/G3 全部接受 approved/rejected/escalate"说错了;知识库第 234 行 + `runner.test.ts:520` 的注释把 B1 的遗留漏洞框成了"一个可接受的设计",跟同一段话宣称"分裂状态已经被消灭"自相矛盾)
- 文档完整性 ✓(PRD/impact 内嵌在 PRD + 本测试报告里,R1-R5 完整;R5 这一节是追加的,没动 R1-R4)
- 文档同步(大设计级别) 不适用(项目级 aeloop;基地的四份权威文档不涉及)

## R5 知识库交叉核对(核对它,不是维护它)

- **触及已索引模块:是**(runner.ts/errors.ts/audit-store.ts 这一轮全部改动)。
- 机械扫描:`node _engine/verify-knowledge.mjs aeloop` **绿**(没有路径/签名漂移)。
- 语义交叉核对(机器判断不了的,这是 Zorro 的活):**发现一处需要 Cypher 更正的框定漂移**——`CHARTS/knowledge/aeloop.md:234` 把"G1 收到 `escalate` 落进 `routeAfterG1` 的 `default: throw` 兜底,不变"框成了一条中性的设计说明,但**同一段话刚宣称 R5-B1 消灭了"先落一行本不该存在的行 + 分裂状态"**,紧接着的下一句就承认这条路径依然会这样干。知识库把一个**从没真正闭环过的阻断级残留**记成了"已经闭环 + 一个可接受的设计选择"。R6 修好 B1 之后,Cypher 重新同步知识库时需要:① 写入新事实——`resumeDecisionsFor` 现在按 gate 精确映射;② 删除/重写"default:throw 兜底,不变"这句(它描述的正是刚被修好的那个漏洞);③ 同时记录 errors.ts:123 的信息更正;④ bump `last-verified`。**维护知识库是 Cypher 的活,我只报告漂移。**

## R5 待指挥官裁决的事项

- **R6-B2 的严重度**:一次正常的中途失败导致的 checkpoint/workflow_runs 分裂——R6 里硬修(失败时调和 / resume 开头调和),还是记为已知局限 + 开一个追踪 issue(类比 D1/#19)?我自己的倾向:偏向硬修,或者至少明确记录,因为它比 D1/#19 的并发场景容易触达得多(一次普通的 adapter 失败就能触发,不需要多个操作者)。
- D1/D2/M1(R1/R2 遗留待定项)——这一轮没有新证据,状态不变。#19(并发),按指挥官在 R4 的裁决,维持"延后到 A5+ + 便宜的 UNIQUE 纵深防御",这一轮的 UNIQUE 已经确认真正生效。

## R5 结论

**FAIL,需要 Round 6。现在不能进 commit/merge 流水线,未 commit/push。** 清楚区分挡门项和不挡门项,不是一刀切盖章:

- **必须在 R6 修好才能 PASS 的项(1 项,硬挡门)**:**R6-B1**——`resumeDecisionsFor` 的决定域映射不精确;G1+escalate / G3+escalate / G2+rejected 是**3 条不需要类型断言**的路径,依然会落一条非法 approval 行 + 撞出一个 checkpoint/workflow_runs 分裂,精确复现了 R5-B1 本该消灭的失效类别——两个模型独立同意,我亲手逐一复现了三条。这偏离了 R4 明确分配的修法(G1/G3 只接受 approved/rejected,只有 G2 额外接受 escalate),而且被知识库/注释错误地框成了"一个可接受的设计"——不能带着这个问题合并。修法很小(把守卫按 gate 精确映射 + 3 个拒绝测试 + 更正 errors.ts:123 的信息/知识库/测试注释)。
- **严重度交给指挥官裁决,可能挡门也可能不挡(1 项)**:**R6-B2**——一次正常的中途失败导致的 checkpoint-已推进-但-workflow_runs-没推进的分裂状态。事实已经被两个模型 + 我自己手动复现确认;这一轮硬修还是记为已知局限(类比 D1/#19)交给指挥官决定。我自己的倾向是偏向硬修,或者至少明确记录(比并发容易触达得多)。
- **一个不挡门的轻微项(1 项)**:M-R5a(errors.test.ts:10 的注释措辞,顺手修)。

**R4 的两个返工项(R5-B1 的守卫 + R5-B2 的 UNIQUE 约束)方向都对、也各自真正锁住了设计要解决的场景**(force_pass 跨域被抓到,两个 UNIQUE 约束真正生效,structured_claims 的排除站得住,#19 的记录准确)——这一轮的 FAIL 卡在 R5-B1 的**颗粒度**上,不是方向错了。R6 返工:B1 必修(小改动)+ B2 待指挥官裁决 + M-R5a(顺手做)。生产逻辑还会再次被动 runner/errors(+可能 audit-store,如果 B2 被硬修),**R6 还需要第六轮 Codex 二签 + 一次知识库重新同步。** 目前**未 commit/push**,工作区 5 个文件逐字节恢复原样(runner `5c61ed2c` / gates `5fbac639` / audit-store `5ef19e01` / errors `8b15e1b0` / escalation `b51634b3`),HEAD `c6589b7` 未动。

---

# A4b Loop — R6 状态记录(未经 Zorro 独立复审,指挥官明确裁决直接合并)

R6 由 Cypher 完成(2026-07-21):

- **R6-B1**:`resumeDecisionsFor` 从"g1/g2/g3 统一映射"改成精确的逐 gate 映射(照着 `routeAfterG1`/`G2`/`G3` 各自实际接受的集合:g1→[approved,rejected],g2→[approved,escalate],g3→[approved,rejected],escalation→[revise,force_pass,abandon])。新增 3 个拒绝测试(G1+escalate / G3+escalate / G2+rejected),Cypher 自报变异验证(还原成统一映射 → 3 个测试变红,之后逐字节恢复原样)。`errors.ts` 的信息 + `runner.test.ts:520` 的注释同时更正。
- **R6-B2**:`workflow_runs` 的状态更新从"整个 stream 跑完之后一次性写"改成**处理每个 chunk 之后就增量同步**(把 `computeRunProgress()` 提取出来在循环里调用),这样中途失败(比如 tester adapter 抛错)之后,账本会停在最后一次成功处理的位置,而不是卡在起点。Cypher 自报新增了回归测试 + 变异验证。

**Cypher 自报:300/300 测试全绿(34 个文件),build/lint 干净。Helix(军师)独立重跑了 `npx vitest run`,确认 300/300 全绿(见 commit 前的 CI 记录 / 本仓库的操作日志)。**

**⚠️ 如实记录:R6 没有走第六轮独立 Zorro 复审 + 没有走第六轮 Codex 二签。** 2026-07-21,指挥官明确裁决:考虑到 R1-R5 已经连续五轮独立复审(包括五轮 Codex 二签)反复探查同一个子系统(`resumeRun`/审计一致性),而且每一轮 Cypher"已经修好了"的自报都被下一轮独立复审证伪或发现了新角度(R4→R5 就是一个例子:R5-B1 的"统一映射"本身被 R5 判定为颗粒度不够,产生了 R6-B1)——这个模式在历史上确实有"自查不够,需要独立复审才能抓到漏掉的"这样的实证。**但考虑到多条工作线的时间成本,指挥官明确指示这一轮跳过 Zorro R6 复审,直接合并。** 这意味着 R6-B1/R6-B2 的修复质量目前只有 Cypher 单方面的证明(破坏→变红→恢复→再次变绿),没有独立第三方(Zorro 手动重跑变异)或跨模型(Codex 二签)验证。**如果在生产使用中发现任何跟续跑决定域校验或 workflow_runs/checkpoint 一致性相关的异常,R6 这两处改动应该是第一嫌疑对象,应该考虑安排一轮后续的独立复审。**
