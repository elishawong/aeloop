/**
 * `board.ts` — 多 workflow 实时进度看板的纯函数组装层（issue #2 batch 1,
 * docs/conductor-mvp/DESIGN.md §3）。只读、无状态：接收已经从 `AuditStore` 查出的
 * `WorkflowRun`/`step_ref` 数据，组装出看板一行要渲染的 `BoardRow`。
 *
 * **不新增/不改动任何 `AuditStore` 方法**（batch 1 刻意的风险控制：不碰核心引擎持久化层，只用
 * 它已经公开的 `listRunsByStatus()`/`listStepRefsByRun()`，见 `conductor-work/ui/server.mjs` 的
 * 调用点）——这意味着 `coderRoundCompleted` 用的是一个**近似判据**，不是 DESIGN 早期草稿设想的
 * "是否存在一条已决策 `Approval.diffRef`"（那需要一个 `AuditStore` 今天没有的
 * `listApprovalsByRun()` 方法，是核心引擎改动，超出 batch 1 范围）——具体判据见
 * `coderRoundCompletedFromStepRefs()` 的文档注释，如实标注这是近似值。
 *
 * **Zorro R1 blocker B4 修复**：`PHASE_MAP` 的 key 集合直接从 `LOOP_NODES`
 * （`src/loop/workflow-def.ts`，`runner.ts` 的 `computeRunProgress()` 实际写进
 * `WorkflowRun.currentState` 的唯一真源）派生，不再手写一份可能漂移的字符串字面量列表——
 * `no_change` 是真实终态（`runner.ts:304-317`：`snapshot.values.noChange` 时
 * `currentState = LOOP_NODES.noChange, status = "completed"`），之前的 `PHASE_MAP` 漏了它；
 * `__end__` 从未出现过（`computeRunProgress()` 的 `done` 分支只产出
 * `apply`/`no_change`/`cancel` 三者之一，`__end__`/`__start__` 是 LangGraph 内部图节点名，
 * 从不写进 `current_state` 列）,已经从 `PHASE_MAP` 里删掉这个虚构条目。
 */
import type { WorkflowRun, WorkflowRunStatus } from "../loop/audit-store.js";
import { LOOP_NODES } from "../loop/workflow-def.js";

export type BoardPhase =
  | "coder_drafting"
  | "waiting_g1"
  | "tester_reviewing"
  | "waiting_g2"
  | "waiting_g3"
  | "escalated"
  | "completed"
  | "completed_no_change"
  | "cancelled"
  | "unknown";

export interface PhaseLabel {
  readonly phase: BoardPhase;
  readonly label: string;
}

/**
 * `WorkflowRun.currentState`(真源 = `LOOP_NODES`,`src/loop/workflow-def.ts`）→ 看板阶段标签,
 * DESIGN.md §3.5 映射表的逐字实现。key 集合是 `LOOP_NODES` 的全部 9 个真实值——`board.test.ts`
 * 用 `Object.values(LOOP_NODES)` 派生覆盖断言，这个对象漏掉任何一个真实节点名都会让测试失败，
 * 不依赖人工记得同步。
 */
const PHASE_MAP: Readonly<Record<string, PhaseLabel>> = {
  [LOOP_NODES.draft]: { phase: "coder_drafting", label: "Coder 生成候选中" },
  [LOOP_NODES.g1]: { phase: "waiting_g1", label: "等待 G1(送审)" },
  [LOOP_NODES.review]: { phase: "tester_reviewing", label: "Tester 复核中" },
  [LOOP_NODES.g2]: { phase: "waiting_g2", label: "等待 G2(送修)" },
  [LOOP_NODES.g3]: { phase: "waiting_g3", label: "等待 G3(最终批准)" },
  [LOOP_NODES.escalation]: { phase: "escalated", label: "已升级,等待人工介入" },
  [LOOP_NODES.apply]: { phase: "completed", label: "已完成" },
  [LOOP_NODES.noChange]: { phase: "completed_no_change", label: "已完成(无改动)" },
  [LOOP_NODES.cancel]: { phase: "cancelled", label: "已取消" },
};

/**
 * `status` 参数今天不参与判断本身(判断完全由 `currentState` 驱动,和 DESIGN §3.5 表格一致——
 * `status` 只是表格里附带的交叉参考列,不是分支条件)。保留这个参数是为了让调用方传全信息、给
 * 未来加防御性交叉校验(比如"currentState 是 apply 但 status 不是 completed,这本身就是个异常
 * 该报"）留出扩展点,不是死代码——`board.test.ts` 会验证"传任意 status 值都不改变返回结果"这条
 * 当前行为契约,防止未来有人不小心让 status 悄悄影响了判断却没同步更新 DESIGN。
 *
 * 未识别的 `currentState` → 显式标"❓ 未知阶段",绝不冒充任何已知阶段（同 BRAIN.md §4 对"未知
 * status tag"的既有红线:宁可显式标未知,不静默错配)。
 */
export function phaseLabelFor(currentState: string, _status: WorkflowRunStatus): PhaseLabel {
  const found = PHASE_MAP[currentState];
  if (found) return found;
  return { phase: "unknown", label: `❓ 未知阶段(${currentState})` };
}

/**
 * 从 `AuditStore.listStepRefsByRun(runId)` 返回的 `step_ref` 字符串数组（形如 `"draft#1"`/
 * `"g1#1"`）里数出精确的 coder 轮次数——比 `WorkflowRun.rejectCount` 更精确（`rejectCount` 只统计
 * 被拒次数，不统计"这是第几轮 draft"本身）。找不到任何 `draft#` 前缀的 step_ref 时（理论上不该
 * 发生在一个已经启动过的 run 上，但防御性地兜底）退化到 `fallbackRejectCount`。
 */
export function loopCountFromStepRefs(stepRefs: readonly string[], fallbackRejectCount: number): number {
  const draftRounds = stepRefs
    .filter((ref) => ref.startsWith("draft#"))
    .map((ref) => Number(ref.slice("draft#".length)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (draftRounds.length === 0) return fallbackRejectCount;
  return Math.max(...draftRounds);
}

/**
 * **近似判据,如实标注,Zorro R1 yellow①改名**：是否至少有一次 coder 完整跑完一轮
 * （`draft#N` 这个 step_ref 存在）。
 *
 * 原名 `hasCandidateDiffFromStepRefs()` 有一个真实的误报场景：coder 判定"不需要改动"
 * （`CoderOutput.status === "no_change"`）时同样会产出一条 `draft#1` step marker
 * （`insertStepMarker()` 在 draft 节点完成后无条件调用，不管这一轮是不是 no_change），旧名字
 * `hasCandidateDiff` 在这种情况下会返回 `true`，但**根本没有 diff**——`no_change` 这个终态的
 * 定义就是"确认不需要任何改动"。改名为 `coderRoundCompleted`：这个更朴素的问题（"coder 这一路上
 * 有没有真的跑完过一轮处理"）无论这一轮是否产生真实 diff 都成立，不再暗示"一定有 diff 存在"。
 *
 * 这**仍然不等于**"存在一条已决策、`diffRef` 非空的 `Approval`"——那需要 `AuditStore` 今天没有
 * 公开的 `listApprovalsByRun()` 方法（batch 1 刻意不新增核心引擎方法，见文件头）。也**不等于**
 * "当前这一轮候选已经可以在详情页看到完整 diff"——一个 run 卡在 `g1`（等待送审）时，coder 已经
 * 完成过一轮（`draft#1` 存在），这个函数会返回 `true`，但那一轮的 `diffRef` 要等 G1 被决策之后
 * 才真正持久化进 `approvals` 表（DESIGN.md §3.2/§9.8 已记录这条限制）。
 */
export function coderRoundCompletedFromStepRefs(stepRefs: readonly string[]): boolean {
  return stepRefs.some((ref) => ref.startsWith("draft#"));
}

export interface BoardRow {
  readonly runId: number;
  readonly task: string;
  readonly profile: string;
  readonly phase: BoardPhase;
  readonly phaseLabel: string;
  readonly loopCount: number;
  readonly coderRoundCompleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 组装一行看板数据——纯函数,不做任何 I/O(调用方负责查出 `run`/`stepRefs`)。 */
export function toBoardRow(run: WorkflowRun, stepRefs: readonly string[]): BoardRow {
  const { phase, label } = phaseLabelFor(run.currentState, run.status);
  return {
    runId: run.id,
    task: run.task,
    profile: run.profile,
    phase,
    phaseLabel: label,
    loopCount: loopCountFromStepRefs(stepRefs, run.rejectCount),
    coderRoundCompleted: coderRoundCompletedFromStepRefs(stepRefs),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
