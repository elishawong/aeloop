# Impact — aeloop Event System (LoopEvent + EventEmitter, issue #29)

- **关联 PRD**:`./PRD.md`(rev. 2 + known-limitations 补记)
- **分支**:`feature/issue-29-events`
- **最后更新**:2026-07-21(Zorro R2 返工后)

## 1. 改动摘要
引擎新增一套公开可观测性 API:`src/loop/events.ts`(新)定义 11 种 `LoopEvent` + `LoopEventEmitter`;`src/loop/runner.ts`(改)在 `startRun()`/`resumeRun()` 共用的 `runStreamAndPersist()` 里,把 `compiled.stream()` 的 `streamMode` 从单一 `"updates"` 换成 `["updates","tasks"]`(spike 验证过的真实 LangGraph 机制,零改 `gates.ts`/`nodes/*.ts`),在正确时点发射事件——覆盖真正的「节点即将开始」(`node_started`,新)与「节点已完成」(`node_completed`,原 `node_entered` 改名)。所有既有 `AuditStore` 持久化行为原样保留(加法式,PRD §9.2)。

## 2. 受影响面
- **直接改动**:
  - `src/loop/events.ts`(新文件,零依赖于 `runner.ts`/graph 层)。
  - `src/loop/runner.ts`:`StartRunDeps` 加一个可选字段 `events?`;`runStreamAndPersist` 拆成 wrapper(`run_failed` 边界)+ `runStreamAndPersistCore`(原逻辑,含新的事件发射)。新增两个私有 helper:`previewStepRef()`、`emitProgressEvents()`。
- **间接波及**:
  - `startRun`/`resumeRun` 的**公开签名不变**(`StartRunDeps` 只多一个可选字段),现有 ~64 个测试调用点(`runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts`)零改动、全部照常通过——不是"应该不受影响",是本轮已实测确认。
  - `AuditStore`/`gates.ts`/`escalation.ts`/`nodes/coder.ts`/`nodes/tester.ts`/`types.ts`/`workflow-def.ts`:**一行未改**(grep 已验证,见 progress.md)。
- **跨项目波及**:无。aeloop 是独立仓库,本次改动完全在 `src/loop/` 内部,未涉及任何跨项目契约。

## 3. 测试建议
- **该重点测**(Zorro 复审时建议优先看):
  1. `runner.test.ts` 新增的 `updateRunProgress` 调用次数回归测试——这是 PRD 明确标出的头号风险(加 `"tasks"` 模式后审计读写翻倍),值得独立复核这条测试本身的逻辑是否真的构成有效的 A/B 对照(手动 `"updates"`-only drive vs 真实实现的 spy 计数),而不只是看它绿了。
  2. `run_failed` 的 wrapper 实现(`runStreamAndPersist` → `runStreamAndPersistCore`)——确认 `throw error` 确实重抛的是同一个 error 实例(测试用 `.rejects.toBe(thrownError)` 而非 `.rejects.toThrow(message)`,后者对"是否包装成新错误"这件事不敏感)。
  3. `previewStepRef()` 的非变异性——确认它真的不写 `stepCounters`(否则会和 `nextStepRef()` 的真实分配产生偏差)。
- **边界 / 异常场景**:
  - 一个监听器同步抛错 / 返回 rejected Promise,是否真的不影响 `AuditStore` 的既有写入(`events.test.ts` 纯 emitter 级别 + `runner.test.ts` 端到端级别各有一条)。
  - `resumeRun` 的前置校验抛错(`RunThreadMismatchError`/`ResumeDecisionDomainMismatchError`/`decidedBy` 类型守卫)不应该触发 `run_failed`——已有专门测试锁定这个范围边界(PRD §9.5)。

## 4. 回归清单(带优先级)
| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | `pnpm build && pnpm lint && pnpm test` 全绿(317/317——299 原有 + B1/B2/B3 首轮 14 条 + Zorro R1 返工 2 条 + Zorro R2 返工 2 条) | 头号门禁:任何回归都必须在这三个命令里现形 |
| P0 | `grep -rn "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts src/loop/graph.ts src/loop/nodes` 保持空 | 零 I/O 纯度不变量——这是本次改动全程反复强调、指挥官也知情接受风险的红线 |
| P1 | 现有 ~64 个 `startRun`/`resumeRun` 调用点(`runner.test.ts`/`audit-store.test.ts`/`loop.e2e.test.ts`)零改动仍全绿 | 证明 `StartRunDeps.events` 可选字段设计真的向后兼容,不是理论上兼容 |
| P1 | `updateRunProgress` 调用次数回归测试本身的有效性(见上方"该重点测" 1) | 这是 PRD 明确标出的头号新风险,测试设计本身值得二次审视 |
| P2 | `run_started`/`node_started`/`node_completed` 等 payload 字段形状是否和 `docs/feature/events-observability/PRD.md` §4.2 表格逐条对得上 | 文档与代码一致性,防止 PRD 描述和实现漂移 |

## 5. 项目约束自查
- whoseorder:N/A(aeloop 不是 whoseorder 项目)。
- 占位符 / 假数据残留:无。
- aeloop 项目内约束(零 I/O 纯度):已用 grep 机械验证,见上方 P0 回归项。
