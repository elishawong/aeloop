import { describe, expect, it } from "vitest";
import { phaseLabelFor, loopCountFromStepRefs, coderRoundCompletedFromStepRefs, toBoardRow, type BoardPhase } from "../board.js";
import { LOOP_NODES } from "../../loop/workflow-def.js";
import type { WorkflowRun } from "../../loop/audit-store.js";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1,
    task: "Implement the approved change",
    workflowDefId: "coder-tester-loop",
    profile: "subscription",
    status: "running",
    rejectCount: 0,
    rejectThreshold: 2,
    currentState: "draft",
    langgraphThreadId: "thread-1",
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("phaseLabelFor", () => {
  // Zorro R1 B4 修复：不再手写一份可能漂移的 currentState 列表——从 LOOP_NODES（runner.ts
  // computeRunProgress() 实际写进 WorkflowRun.currentState 的唯一真源）派生覆盖集合。未来
  // LOOP_NODES 新增一个节点名而 board.ts 的 PHASE_MAP 没跟上，这条测试会失败，不是"看起来测了
  // 全部，其实是一份手抄的旧列表"。
  const expectedPhaseByNode: Record<string, BoardPhase> = {
    [LOOP_NODES.draft]: "coder_drafting",
    [LOOP_NODES.g1]: "waiting_g1",
    [LOOP_NODES.review]: "tester_reviewing",
    [LOOP_NODES.g2]: "waiting_g2",
    [LOOP_NODES.g3]: "waiting_g3",
    [LOOP_NODES.escalation]: "escalated",
    [LOOP_NODES.apply]: "completed",
    [LOOP_NODES.noChange]: "completed_no_change",
    [LOOP_NODES.cancel]: "cancelled",
  };

  it("Object.values(LOOP_NODES) 的每一个真实节点名都必须有映射（防漂移，不是手抄列表）", () => {
    const realNodeNames = Object.values(LOOP_NODES);
    expect(realNodeNames.length).toBeGreaterThan(0); // 防止 LOOP_NODES 本身意外清空导致这条测试假绿
    for (const nodeName of realNodeNames) {
      expect(
        Object.hasOwn(expectedPhaseByNode, nodeName),
        `LOOP_NODES 里的 "${nodeName}" 在测试的期望表里没有对应条目——这条测试自己也要跟着 LOOP_NODES 同步，不只是 board.ts`,
      ).toBe(true);
    }
  });

  it.each(Object.entries(expectedPhaseByNode))("currentState=%s → phase=%s", (currentState, expectedPhase) => {
    const result = phaseLabelFor(currentState, "running");
    expect(result.phase).toBe(expectedPhase);
  });

  it("no_change（真实终态，runner.ts:304-317）→ 已完成(无改动)，不是未知阶段", () => {
    const result = phaseLabelFor(LOOP_NODES.noChange, "completed");
    expect(result.phase).toBe("completed_no_change");
    expect(result.label).toBe("已完成(无改动)");
  });

  it("__end__ 不是真实的 currentState 值（LangGraph 内部图节点名，从不写进 WorkflowRun.currentState）——落到未知阶段，不冒充已完成", () => {
    const result = phaseLabelFor("__end__", "running");
    expect(result.phase).toBe("unknown");
  });

  it("未识别的 currentState → 显式标 ❓ 未知阶段，不冒充任何已知阶段", () => {
    const result = phaseLabelFor("some-future-node-nobody-registered", "running");
    expect(result.phase).toBe("unknown");
    expect(result.label).toBe("❓ 未知阶段(some-future-node-nobody-registered)");
  });

  it("空字符串 currentState 同样落到未知阶段（不是抛错，不是崩溃）", () => {
    const result = phaseLabelFor("", "running");
    expect(result.phase).toBe("unknown");
  });

  it("status 参数不影响返回结果（今天的行为契约，见函数头注释）", () => {
    const withRunning = phaseLabelFor("draft", "running");
    const withEscalated = phaseLabelFor("draft", "escalated");
    const withCompleted = phaseLabelFor("draft", "completed");
    const withCancelled = phaseLabelFor("draft", "cancelled");
    expect(withRunning).toEqual(withEscalated);
    expect(withRunning).toEqual(withCompleted);
    expect(withRunning).toEqual(withCancelled);
  });
});

describe("loopCountFromStepRefs", () => {
  it("从 draft# 前缀的 step_ref 里数出最大轮次", () => {
    expect(loopCountFromStepRefs(["draft#1", "g1#1", "draft#2", "g1#2"], 0)).toBe(2);
  });

  it("没有任何 draft# step_ref 时退化到 fallbackRejectCount", () => {
    expect(loopCountFromStepRefs([], 3)).toBe(3);
    expect(loopCountFromStepRefs(["g1#1"], 5)).toBe(5);
  });

  it("非数字后缀的 draft# 条目被忽略，不产生 NaN", () => {
    expect(loopCountFromStepRefs(["draft#abc", "draft#2"], 0)).toBe(2);
  });

  it("draft#0 或负数不计入（防御性，理论上不应出现）", () => {
    expect(loopCountFromStepRefs(["draft#0"], 7)).toBe(7);
  });
});

describe("coderRoundCompletedFromStepRefs（原 hasCandidateDiffFromStepRefs，Zorro R1 yellow①改名）", () => {
  it("存在至少一条 draft# → true", () => {
    expect(coderRoundCompletedFromStepRefs(["draft#1"])).toBe(true);
  });

  it("完全没有 draft# → false", () => {
    expect(coderRoundCompletedFromStepRefs([])).toBe(false);
    expect(coderRoundCompletedFromStepRefs(["g1#1", "review#1"])).toBe(false);
  });

  it("no_change 场景下 draft#1 仍然存在（coder 跑完了一轮，只是判定不需要改动）——这正是改名的理由：这个函数如实回答'跑完了一轮'，不暗示'一定有 diff'", () => {
    // no_change 场景下 insertStepMarker() 对 draft 节点无条件调用，所以 draft#1 存在——
    // 调用方（toBoardRow()）应该结合 phase==="completed_no_change" 来判断要不要展示"候选 diff"
    // 这个概念，本函数自己不做这层判断（职责边界见函数头注释）。
    expect(coderRoundCompletedFromStepRefs(["draft#1"])).toBe(true);
  });
});

describe("toBoardRow", () => {
  it("组装出的一行数据字段和 WorkflowRun 一一对应", () => {
    const run = makeRun({ id: 42, currentState: "g1", status: "running", rejectCount: 1 });
    const row = toBoardRow(run, ["draft#1", "g1#1"]);
    expect(row.runId).toBe(42);
    expect(row.task).toBe(run.task);
    expect(row.profile).toBe(run.profile);
    expect(row.phase).toBe("waiting_g1");
    expect(row.phaseLabel).toBe("等待 G1(送审)");
    expect(row.loopCount).toBe(1);
    expect(row.coderRoundCompleted).toBe(true);
    expect(row.createdAt).toBe(run.createdAt);
    expect(row.updatedAt).toBe(run.updatedAt);
  });

  it("刚起步、coder 还没跑完一轮的 run → coderRoundCompleted=false，loopCount 退化到 rejectCount", () => {
    const run = makeRun({ id: 7, currentState: "draft", rejectCount: 0 });
    const row = toBoardRow(run, []);
    expect(row.coderRoundCompleted).toBe(false);
    expect(row.loopCount).toBe(0);
  });

  it("no_change 终态的 run → phase=completed_no_change，不是未知阶段", () => {
    const run = makeRun({ id: 9, currentState: LOOP_NODES.noChange, status: "completed" });
    const row = toBoardRow(run, ["draft#1"]);
    expect(row.phase).toBe("completed_no_change");
    expect(row.phaseLabel).toBe("已完成(无改动)");
  });

  it("未识别的 currentState 不会让整个组装函数抛错", () => {
    const run = makeRun({ currentState: "some-brand-new-node" });
    expect(() => toBoardRow(run, [])).not.toThrow();
    const row = toBoardRow(run, []);
    expect(row.phase).toBe("unknown");
  });
});
