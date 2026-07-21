/**
 * B0 smoke test — `LoopState` (the `Annotation.Root` object, src/loop/types.ts)
 * really is something `new StateGraph()` accepts. Not a business-logic test:
 * this only exists so a future refactor that breaks the `Annotation.Root`
 * shape fails loudly here instead of surfacing three files downstream, in
 * `graph.test.ts`, with a much less obvious error (PRD §5 "types.test.ts").
 */
import { StateGraph, START, END } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { LoopState } from "../types.js";

describe("LoopState", () => {
  it("is accepted by new StateGraph() and compiles a trivial one-node graph", async () => {
    const graph = new StateGraph(LoopState)
      .addNode("noop", () => ({}))
      .addEdge(START, "noop")
      .addEdge("noop", END);

    const compiled = graph.compile();
    const result = await compiled.invoke({
      task: "smoke test task",
      injectedContext: { memories: [] },
    });

    expect(result.task).toBe("smoke test task");
    expect(result.rejectCount).toBe(0);
    expect(result.gateLog).toEqual([]);
    expect(result.applied).toBe(false);
  });
});
