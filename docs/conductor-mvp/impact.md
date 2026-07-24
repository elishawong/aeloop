# Impact — Conductor 层 MVP(issue #2,batch 0 + batch 1,Zorro R3 返工后)

> batch 0/1 已经真的 build 完并自测过。**Zorro R1 = FAIL**(6 blocker + 7 yellow)→ 返工 →
> **Zorro R2 = FAIL,离 PASS 很近**(2 个小 blocker + #106 rebase/reconcile 集成事 + 4 个低优先级
> yellow)→ 返工 → **Zorro R3 = FAIL,代码面 100% 干净**(RB1 红线独立攻击验证真堵死、
> post-#106 融合无损、665+27 测试全绿、红线未弱化——唯一 blocker 是 PRD/DESIGN 里"#106 状态"
> 多处自相矛盾的纯文档问题,R2 只补了一处、漏了其余)→ 本轮**零代码改动**,只做文档一致性 sweep,
> 本文件是 **R3 返工后**的 impact。batch 2-5 未开始,这轮不做(指挥官原话"这轮只到 batch 1"),
> 它们的 impact 留给各自 build 时再补。

- **关联 PRD**:`./PRD.md`
- **关联 DESIGN**:`./DESIGN.md`
- **分支**:`feature/issue-2-conductor-mvp`(**未 commit**——等指挥官看完 Zorro R3 返工结果,送
  Zorro R4,指挥官批准后才 commit)
- **最后更新**:2026-07-24(Zorro R3 文档一致性 sweep,零代码改动)

## 1. 改动摘要

Batch 0:抽出共享派发核心 `scripts/lib/conductor-dispatch-core.mjs`,重构
`scripts/dispatch-brain-task.mjs` 委托调用它(零行为回归);核实修正④(角色 schema 动态
registry)真实范围——机制已建成,缺的是调用点,不建议现在动手实现。

Batch 1:新增会话触发入口 `scripts/dispatch-conductor-task.mjs`;`docs/conductor-brain-layer/
BRAIN.md` 新增 §6(工作请求识别与派发指引)+ 更新 §1.6/§6 诚实边界措辞(B1);`.claude/hooks/
brain-wake-greeting.mjs` 在状态 C(正常醒来)追加一段派发指令的 additionalContext;新增
`src/conductor-work/board.ts`(阶段标签映射 + 看板行组装);扩展 `conductor-work/ui/
{server.mjs,app.js,index.html,README.md}` 新增 `/api/runs` 总览端点 + 前端轮询渲染。

**Zorro R1 返工新增改动**:`src/loop/audit-store.ts` 新增可选只读构造模式(B2);
`conductor-work/ui/server.mjs` 的 profile 解析改为复用 `loadProfile()`(B3);
`src/conductor-work/board.ts` 的 `PHASE_MAP` 补 `no_change`、删虚构的 `__end__`,`hasCandidateDiff`
改名 `coderRoundCompleted`(B4 + yellow①);`scripts/dispatch-conductor-task.mjs` 输出真实候选摘要
+ claims/evidence 内容(B5);`conductor-work/ui/app.js` 的拉取失败处理改为真正保留上次渲染
(yellow②);`scripts/test-conductor-dispatch-core.mjs` 新增 fake-adapter 驱动的深水区回归
(yellow③);`test-hook-greeting.mjs` 新增 A/B/C 三态派发指令断言(yellow④)。

## 2. 受影响面

- **直接改动(新建)**:`scripts/lib/conductor-dispatch-core.mjs`、
  `scripts/dispatch-conductor-task.mjs`、`scripts/test-conductor-dispatch-core.mjs`、
  `scripts/test-dispatch-conductor-task.mjs`、`src/conductor-work/board.ts`、
  `src/conductor-work/__tests__/board.test.ts`。
- **直接改动(修改既有文件)**:`scripts/dispatch-brain-task.mjs`(重构,委托共享核心)、
  `docs/conductor-brain-layer/BRAIN.md`(新增 §6 + 诚实边界措辞订正)、
  `.claude/hooks/brain-wake-greeting.mjs`(状态 C 路径追加 `CONDUCTOR_DISPATCH_INSTRUCTION`,
  状态 A/B 路径**零改动**,已有自动化断言验证——见 yellow④)、`conductor-work/ui/server.mjs`
  (新增 `/api/runs`,新增 profile 解析复用 `loadProfile()`,新增只读 `AuditStore` 打开;既有
  `/api/state` **零改动**)、`conductor-work/ui/app.js`(新增看板轮询渲染 + 真正的失败态保留,
  既有 `/api/state` 渲染逻辑**零改动**)、`conductor-work/ui/index.html`(新增看板 section,既有
  summary/layout section 保留)、`conductor-work/ui/README.md`(新增一节说明)、
  **`src/loop/audit-store.ts`(核心引擎,+29/-3 行,新增默认关闭的可选只读构造参数)**。
- **间接波及,已验证(Zorro R1 返工后重新全量跑过一遍)**:
  - `scripts/test-dispatch-brain-task.mjs`(issue #93 既有测试,10 组断言)——**零回归**。
  - `src/loop/__tests__/audit-store.test.ts`(既有 20 个 vitest 用例,B2 新增只读模式后)——
    **零回归**(新参数可选,省略时行为等价——构造函数本身多了几行分支判断代码,不是字面"一字节
    都没变",但省略 `opts` 时产出的实例行为和改动前完全一致,措辞和 PRD 对齐,Zorro R3 yellow③)。
  - `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`(11 段断言 + yellow④新增的 A/B/C
    派发指令断言)——**零回归**。
  - `docs/conductor-brain-layer/spike/` 其余 7 个测试文件——全部跑过,**零回归**。
  - `pnpm run test`(vitest 全量套件)——**59 files / 660 tests 全绿**(`rm -rf dist` 后干净重新
    编译 + 全量重跑,不是增量侥幸过)。
  - `pnpm run lint`(`tsc --noEmit`)——通过,零类型错误。
  - 其余 `scripts/test-*.mjs`——全部跑过,**零回归**。
  - **17 个独立测试文件(9 个 `scripts/test-*.mjs` + 8 个 `spike/test-*.mjs`)全部手动逐一重跑,
    零失败**。
- **跨项目波及**:无——aeloop 是独立 private repo,本轮完全不涉及 whoseorder/whosehere 等其它
  项目,不跨项目读写。

## 3. 开放风险(issue #31,Zorro R1 blocker B1,指挥官已拍处理方式——诚实记录,不是已解决项)

**candidate-only 今天只是 prompt/契约层约束,不是运行时机械强制**:
- `TaskContract.policy.allowGitWrite:false` 是契约字段级校验,不是运行时检查。
- coder 走 `bypassPermissions --allowedTools Bash`,Bash 工具本身不是只读的。
- `evaluateExecutionPolicy()`(fail-closed 的执行策略检查函数)今天没有接进这条派发链路。
- coder 工具执行 cwd 钉在 aeloop 仓库自身——解决了"不碰真实业务项目",**没有解决**"理论上能写
  aeloop 自己工作树"这个问题。

**指挥官处理方式**:本轮只做诚实声明 + 标风险(`BRAIN.md`/`DESIGN.md §1.5`/本文件三处同步),
**不建机械隔离**——真·机械隔离(只读工作区/去掉可写 Bash/落地 `evaluateExecutionPolicy()`)延后到
issue #31 单独做。**demo 的现实兜底**:因为没有机械隔离,batch 1 的 demo 严格只在 aeloop 自己仓库
这个沙箱内跑,不指向任何真实业务项目——这是当前唯一现实的安全网。

## 4. #106 合并——**本轮已执行**(issue #31 之外的另一个开放项,Zorro R1 blocker B6,Zorro R2 落地)

**状态更新(2026-07-24)**:#106 已 merge 到 `origin/main`(`1e36531`)。本分支和 #106**都改动了
同一个文件** `.claude/hooks/brain-wake-greeting.mjs`——本分支追加约 25 行(状态 C 分支的
`CONDUCTOR_DISPATCH_INSTRUCTION`),#106 改动约 171 行(新增 event 分派、`--standalone` 模式、
guard 插入点)+ 重写 `docs/conductor-brain-layer/spike/test-hook-greeting.mjs` + 改
`docs/conductor-brain-layer/BRAIN.md`——**如预期产生了真实文本冲突**,不是"两条独立触发路径互不
干扰"这句设计层面的话能自动避免的。

**已执行的操作(不再是"记录,本轮不执行"——真做了)**:
1. ✅ `git fetch origin` + `git stash push -u`(含未跟踪文件)→ `git rebase origin/main`(本分支
   零自有 commit,纯 fast-forward,零冲突)→ `git stash pop`。
2. ✅ 手工 reconcile `.claude/hooks/brain-wake-greeting.mjs`——冲突集中在常量声明区域,两边都
   保留(`VALID_HOOK_EVENT_NAMES` + `CONDUCTOR_DISPATCH_INSTRUCTION` + 新签名
   `emitAdditionalContext(text, hookEventName)`);**状态 C 的实际拼接/调用逻辑那一行,git 三方
   合并自动处理正确,没有冲突标记,不需要人工改动**。
3. ✅ 手工 reconcile `docs/conductor-brain-layer/BRAIN.md`——§5"Phase1 诚实边界"的两条各自更新
   过的 bullet 都保留,补一条收尾说明把两边逻辑连起来。
4. ✅ `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`——**三方合并自动成功,零手工
   干预**(#106 给每个既有测试块的 `env` 加 `HOME: fakeHome`,和本分支新增的 A/B/C 断言落在
   不重叠的行,git 的上下文合并算法正确处理)。
5. ✅ 重跑三路径守卫(#106 的 `test-hook-greeting.mjs` ⑫-㉑,10 段)+ A/B/C 注入测试(本分支的
   ⑧⑨⑩)——**21 段全部通过**,两边行为都不回归。

完整操作细节 + 每一步的验证证据见 `progress.md`"Zorro R2 返工 §0"。

## 5. 与 PRD/DESIGN 原稿的诚实偏离(build 时发现,均已记进 `progress.md`,非隐瞒)

1. **共享核心文件位置**:PRD 原写 `src/conductor-work/dispatch.ts`,实际落地为
   `scripts/lib/conductor-dispatch-core.mjs`——原因:放进 `src/` 会破坏
   `docs/conductor-brain-layer/spike-PRD.md` §0 已定的"不改动 `src/**`,spike 层代码不升级进
   `src/`"这条既有架构边界。PRD §9.2 本就授权 build 阶段按实际代码形状判断,不是违反 PRD。
2. **`coderRoundCompleted`(原 `hasCandidateDiff`)的判据**:PRD/DESIGN 早期设想是"是否存在一条
   已决策的 `Approval.diffRef`",实际实现是"是否存在至少一个 `draft#` 前缀的 step_ref"——原因:
   前者需要 `AuditStore` 新增一个今天不存在的公开方法(按 runId 查完整 `Approval` 行),属于核心
   引擎持久化层改动,超出 batch 1"不碰核心引擎"的风险控制范围。**Zorro R1 yellow①进一步指出**
   原字段名 `hasCandidateDiff` 在 `no_change` 场景下会误报(coder 判定不需要改动时仍有 `draft#1`
   这个 step_ref)——已改名 `coderRoundCompleted`,语义收窄为"coder 有没有真的跑完过一轮"。
3. **共享核心返回值补充 `pendingGate`/`done`/`runId`/`threadId`**:PRD 原稿的
   `ConductorDispatchResult` 接口没有列出这几个字段,build 时发现对话层要诚实回复"候选停在哪个
   gate"离不开它们。**Zorro R1 blocker B5 进一步要求** `pendingGate` 补上 `diffRef`(真实候选 diff
   文本),CLI 层新增 claims/evidence 真实内容摘要——不只是计数。
4. **`AuditStore` 新增可选只读构造模式(Zorro R1 blocker B2)**:核心引擎的唯一改动,纯 additive,
   不在原 PRD/DESIGN 的文件清单里,是返工阶段才发现必要的修复。

## 6. 测试建议(batch 2 及之后)

- **该重点测**:①真实完整闭环(需要真实认证的 subscription profile)——本轮未做,人工 self-check
  待补;②多次连续派发时看板总览是否正确显示多行、互不覆盖;③`coderRoundCompleted` 在真实多轮
  reject 场景下是否符合直觉。
- **边界/异常场景**:①G3/Escalation 前停住时,`dispatch-conductor-task.mjs` 的输出 JSON 传给模型
  后,模型的转述措辞是否诚实(不能暗示"已经批准"或"已经继续"、能不能真的说出候选改了什么)——这
  条依赖模型行为,不是代码能 100% 保证的,BRAIN.md §6 已经写了措辞要求,但没有自动化断言能验证
  "模型真的照做了";②高频真实派发场景下 SQLite 并发读写的长时间稳定性(本轮只做过一次 726ms 的
  压力测试,见 progress.md 实测记录,不是长时间验证);③ #106 merge 后的合并 reconcile(见 §4)。

## 7. 回归清单(带优先级,Zorro R3 返工后状态)

| 优先级 | 回归项 | 状态 |
|---|---|---|
| P0 | `scripts/test-dispatch-brain-task.mjs` 全绿,断言零回归 | ✅ 已验证(R1+R2 各重跑一遍) |
| P0 | candidate-only 红线(`allowGitWrite:false`、不指向真实项目 cwd、G3/Escalation 恒人工)全程成立,**且诚实标注它今天只在 prompt/契约层生效**(#31 开放风险) | ✅ 红线本身未弱化;✅ 诚实标注已完成(BRAIN.md/DESIGN §1.5/本文件 §3) |
| P0 | `AUTO_APPROVE_GATES` 不可被外部调用方污染(RB1) | ✅ 已修复:模块私有 `Set` + 导出 `Object.freeze()` 快照 + `isAutoApproveGate()` 判定函数,`.push()` 真的抛 `TypeError` |
| P0 | `.claude/hooks/brain-wake-greeting.mjs` 既有三态判断(状态 A/B/C)+ #96 防幻觉红线零回归,**且状态 A/B 不含派发指令、状态 C 必含**(yellow④),**且与 #106 三路径分派融合后仍然成立** | ✅ 已验证(reconcile 后 test-hook-greeting.mjs 21 段全绿,含 #106 新增 ⑫-㉑ 十段 + 本分支 A/B/C 断言) |
| P0 | 看板对 `workflow.db`/身份库**物理只读**(不只是逻辑层面没调写方法) | ✅ 已实测(blocker B2:只读连接读正常、写真的抛 `SQLITE_READONLY`、mtime 不变、缺失文件抛错不隐式建库);✅ R2 补了持久化的 vitest 单测(yellow③,5 个用例) |
| P0 | 看板 profile 解析 honor `AELOOP_PROFILES_ROOT`,`CONDUCTOR_WORK_PROFILE` 防路径穿越 + 空字符串边界 | ✅ 已实测(blocker B3:三个场景——默认/外置 profiles root/路径穿越尝试——均验证通过);✅ R2 修了空字符串边界(yellow②) |
| P0 | `no_change` 真实终态正确映射,测试覆盖集合防漂移 | ✅ 已验证(blocker B4:`board.test.ts` 26 个用例,覆盖集合从 `LOOP_NODES` 派生) |
| P0 | 会话入口能说出候选实际改了什么、证据是什么(不是只报计数) | ✅ 已验证(blocker B5:深水区全链路测试确认 `pendingGate.diffRef` 含真实 diff 内容) |
| P0 | #106 rebase + reconcile 真正完成,不是记录成"待做" | ✅ 已执行(§4),21 段融合测试全绿 |
| P1 | fixture 降级路径保留 | ✅ 已验证(`/api/state` 零改动,`/api/runs` 自己也有独立降级路径) |
| P1 | `aeloop list` CLI 输出和看板 `/api/runs` 数据一致 | ✅ 已手动交叉核对 |
| P1 | SQLite 并发读写无 `SQLITE_BUSY`/异常 | ✅ 已实测(726ms/380 次操作零错误,局限见 progress.md) |
| P1 | 看板拉取失败时真正保留上次渲染内容(不是文案空承诺) | ✅ 已验证(yellow②:`renderBoardFetchError()` 不碰 `#board-rows` DOM) |
| P1 | 文档幻觉门(R2 范围,4 个低优先级 yellow):README AELOOP_PROFILES_ROOT/coderRoundCompleted 措辞、PRD"逐字节不变"→"行为等价"、BRAIN.md evidence.evidence 字段说明、`AuditStore` readonly 单测 | ✅ 已订正(R2 范围内,**这条当时的表述范围仅限这 4 项,不是"全部文档都一致"——R3 又抓到另一类,见下一行**) |
| P0 | **文档幻觉门(R3 复发类):PRD/DESIGN 里"#106 状态/reconcile/base commit"多处自相矛盾**——R2 只补了 PRD 的一处(`Batch 1 验收点`那条),PRD §7 项目约束检查、两份文档的文件头基线、DESIGN §9.3 标题framing 均未同步,与"reconcile 本轮已执行"的事实矛盾 | ✅ 已用 `grep -n '自动补上\|自动生效\|尚未 merge\|这轮不执行\|13c2bf1'` 全量扫过 `docs/conductor-mvp/` 逐条核对,DESIGN/PRD 的文件头、§2.3/§9.3、§7 项目约束检查、progress.md 的历史记录标注均已对齐"#106 已 merge、reconcile 已执行、HEAD=1e36531"这个事实 |
| P2 | 真实完整闭环端到端(需要真实凭证) | ⬜ 未做,人工 self-check 待补(同既有惯例) |

## 8. 项目约束自查

- whoseorder:不涉及(aeloop 独立仓库),N/A。
- 占位符/假数据残留:无——所有测试用的 fixture 数据(含 B2/B3 实测用的临时 `workflow.db`、
  `/tmp/external-profiles-root`)在验证结束后已清理,不留任何测试产物在磁盘/仓库里;`dist/`/
  `workflow.db` 均已确认 gitignore 覆盖。
- 严禁关门嵌套 agent:本轮 build 会话未起任何 `claude -p --dangerously-skip-permissions` 类调用,
  真实 LLM 调用路径(`assembleProfileDeps`→真实 `claude`/`codex` CLI)如实标注为"未在本轮验证",
  不是假装测过。
- candidate-only 红线未被弱化:自动放行只含 G1/G2(`isAutoApproveGate()` 判定函数 + `Object.
  freeze()` 快照锁定,RB1 修复后不再是可被外部调用方 `.add()` 污染的活 `Set`)、G3/Escalation
  恒人工(已用真实全链路测试验证停止行为)——B1 只是诚实标注机械层缺失,不是放开或降低任何一条
  既有约束。
