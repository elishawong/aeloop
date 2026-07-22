/**
 * `gates.ts` unit tests (PRD §5 "gates.test.ts") — **toy-node layer**
 * (PRD §5's three-layer testing strategy, layer 1): each gate node under
 * test is real, but wired into a minimal `StateGraph` with `MemorySaver`
 * (no real disk, no real adapters) — the point is proving `interrupt()`/
 * `Command({resume})` mechanics (mirroring spike-findings.md Q3), not
 * exercising the full A4a state machine (that's `graph.test.ts`, B3).
 *
 * The `gateLog`-accumulation test (`describe("gateLog accumulation")`) uses
 * `addConditionalEdges` as scaffolding to get a gate node visited twice in
 * one run — this is *not* the PRD's "first verification of
 * `addConditionalEdges`" (that's `graph.test.ts`'s explicit job, per PRD §5/
 * §6's B3 description); it's the minimum wiring needed to observe
 * `gateLog`'s `concat` reducer actually accumulate across two passes
 * through the same gate, which cannot be observed by calling a gate node
 * function directly (`interrupt()` throws when called outside a compiled
 * graph's execution context — see `interrupt.d.ts`'s `@throws` doc).
 */
import { StateGraph, START, END, MemorySaver, Command } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { LoopState, type LoopStateType, type GateResumeValue } from "../types.js";
import { LOOP_NODES } from "../workflow-def.js";
import { createG1Node, createG2Node, createG3Node, routeAfterG1 } from "../gates.js";

function buildState(overrides: Partial<LoopStateType> = {}): LoopStateType {
  return {
    task: "toy task: add a function",
    feedback: undefined,
    injectedContext: { memories: [] },
    coderOutput: {
      status: "changed",
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [],
      confidence: "verified",
    },
    coderResult: undefined,
    testerOutput: {
      verdict: "reject",
      issues: ["off-by-one in the loop bound", "missing null check"],
      claims: [],
      confidence: "verified",
    },
    testerResult: undefined,
    rejectCount: 0,
    g1Decision: undefined,
    g2Decision: undefined,
    g3Decision: undefined,
    gateLog: [],
    applied: false,
    rejectThreshold: 2,
    escalationDecision: undefined,
    cancelled: false,
    noChange: false,
    ...overrides,
  };
}

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

/**
 * `N` must be explicitly supplied at each call site as the *exact* node
 * union of the specific toy graph being resumed (spike-findings.md Q5's
 * `Command` generic-defaults-to-`string` pitfall — types.ts's shared
 * `LoopNodeName` union is deliberately **not** used here: each of this
 * file's single-node toy graphs has a narrower compiled `Nodes` type
 * (e.g. `"__start__" | "g1"`, no `"__end__"`, since only one real node was
 * ever `addNode`'d into it) than the six-node production graph
 * `graph.ts` builds, and `tsc` correctly rejects the wider union as not
 * assignable to the narrower one).
 */
function resumeCommand<N extends string>(resume: GateResumeValue) {
  return new Command<GateResumeValue, Record<string, unknown>, N>({ resume });
}

describe("createG1Node — interrupt() pauses, Command({resume}) resumes without re-pausing", () => {
  it("approve: resumes to completion, g1Decision=approved, one gateLog entry", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g1, createG1Node())
      .addEdge(START, LOOP_NODES.g1)
      .addEdge(LOOP_NODES.g1, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g1-approve");

    await compiled.invoke(buildState(), cfg);

    const paused = await compiled.getState(cfg);
    expect(paused.next).toEqual([LOOP_NODES.g1]);
    const pendingPayload = paused.tasks[0]?.interrupts[0]?.value;
    expect(pendingPayload).toMatchObject({ gate: "G1_SEND_TO_TESTER", question: expect.any(String) });

    const final = await compiled.invoke(resumeCommand<"__start__" | "g1">({ decision: "approved", reasoningText: "looks good" }), cfg);

    const finished = await compiled.getState(cfg);
    expect(finished.next).toEqual([]);

    expect(final.g1Decision).toBe("approved");
    expect(final.feedback).toBe("looks good");
    expect(final.gateLog).toHaveLength(1);
    expect(final.gateLog[0]).toMatchObject({ gate: "G1_SEND_TO_TESTER", decision: "approved" });
  });

  it("reject: g1Decision=rejected, feedback carries the human's reasoning text", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g1, createG1Node())
      .addEdge(START, LOOP_NODES.g1)
      .addEdge(LOOP_NODES.g1, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g1-reject");

    await compiled.invoke(buildState(), cfg);
    const final = await compiled.invoke(resumeCommand<"__start__" | "g1">({ decision: "rejected", reasoningText: "diff is incomplete" }), cfg);

    expect(final.g1Decision).toBe("rejected");
    expect(final.feedback).toBe("diff is incomplete");
  });
});

describe("createG2Node — feedback derivation", () => {
  it("approve: feedback contains the tester's issues, not just the human's reasoningText", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g2, createG2Node())
      .addEdge(START, LOOP_NODES.g2)
      .addEdge(LOOP_NODES.g2, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g2-approve");

    await compiled.invoke(buildState(), cfg);
    const final = await compiled.invoke(resumeCommand<"__start__" | "g2">({ decision: "approved" }), cfg);

    expect(final.g2Decision).toBe("approved");
    expect(final.feedback).toContain("off-by-one in the loop bound");
    expect(final.feedback).toContain("missing null check");
  });

  it("approve with reasoningText: feedback contains both the issues and the human's text", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g2, createG2Node())
      .addEdge(START, LOOP_NODES.g2)
      .addEdge(LOOP_NODES.g2, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g2-approve-with-text");

    await compiled.invoke(buildState(), cfg);
    const final = await compiled.invoke(resumeCommand<"__start__" | "g2">({ decision: "approved", reasoningText: "please address both" }), cfg);

    expect(final.feedback).toContain("off-by-one in the loop bound");
    expect(final.feedback).toContain("please address both");
  });
});

describe("createG3Node — interrupt() pauses, Command({resume}) resumes", () => {
  it("reject: g3Decision=rejected", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g3, createG3Node())
      .addEdge(START, LOOP_NODES.g3)
      .addEdge(LOOP_NODES.g3, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g3-reject");

    await compiled.invoke(buildState(), cfg);
    const final = await compiled.invoke(resumeCommand<"__start__" | "g3">({ decision: "rejected", reasoningText: "still fails a test" }), cfg);

    expect(final.g3Decision).toBe("rejected");
    expect(final.feedback).toBe("still fails a test");
  });

  it("approve: g3Decision=approved", async () => {
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g3, createG3Node())
      .addEdge(START, LOOP_NODES.g3)
      .addEdge(LOOP_NODES.g3, END);
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g3-approve");

    await compiled.invoke(buildState(), cfg);
    const final = await compiled.invoke(resumeCommand<"__start__" | "g3">({ decision: "approved" }), cfg);

    expect(final.g3Decision).toBe("approved");
  });
});

describe("gateLog accumulation across multiple passes through the same gate", () => {
  it("two rounds through G1 (reject, then approve) leaves two gateLog entries, not one", async () => {
    // Minimal `addConditionalEdges` scaffolding to route back to "g1" itself
    // on "draft" (reject) and to END on "review" (approve) — see file
    // header for why this is scaffolding, not the PRD's dedicated
    // addConditionalEdges verification (that's graph.test.ts).
    const graph = new StateGraph(LoopState)
      .addNode(LOOP_NODES.g1, createG1Node())
      .addEdge(START, LOOP_NODES.g1)
      .addConditionalEdges(LOOP_NODES.g1, routeAfterG1, { review: END, draft: LOOP_NODES.g1 });
    const compiled = graph.compile({ checkpointer: new MemorySaver() });
    const cfg = threadConfig("g1-two-rounds");

    await compiled.invoke(buildState(), cfg);
    // Round 1: reject -> routes back to g1, which immediately re-interrupts.
    await compiled.invoke(resumeCommand<"__start__" | "g1">({ decision: "rejected", reasoningText: "round 1 feedback" }), cfg);

    const midway = await compiled.getState(cfg);
    expect(midway.next).toEqual([LOOP_NODES.g1]);

    // Round 2: approve -> routes to END.
    const final = await compiled.invoke(resumeCommand<"__start__" | "g1">({ decision: "approved", reasoningText: "round 2 approved" }), cfg);

    expect(final.gateLog).toHaveLength(2);
    expect(final.gateLog[0]).toMatchObject({ decision: "rejected", reasoningText: "round 1 feedback" });
    expect(final.gateLog[1]).toMatchObject({ decision: "approved", reasoningText: "round 2 approved" });
    expect(final.g1Decision).toBe("approved");
  });
});
