// Shared graph definition for Q4 (both process A and process B build this
// identical graph — LangGraph checkpoints persist STATE, not the graph
// definition itself, so both processes must independently construct the
// same StateGraph).
import { StateGraph, START, END, Annotation, interrupt } from "@langchain/langgraph";

export const State = Annotation.Root({
  task: Annotation(),
  coderOutput: Annotation(),
  gateDecision: Annotation(),
  testerVerdict: Annotation(),
});

function coderNode(state) {
  console.log(`[pid ${process.pid}] [coder] drafting for task:`, state.task);
  return { coderOutput: `fake diff for: ${state.task}` };
}

function g1GateNode(state) {
  console.log(`[pid ${process.pid}] [G1] about to interrupt(), coderOutput =`, state.coderOutput);
  const decision = interrupt({
    gate: "G1_SEND_TO_TESTER",
    diff: state.coderOutput,
    question: "approve sending this diff to tester?",
  });
  console.log(`[pid ${process.pid}] [G1] resumed with decision =`, decision);
  return { gateDecision: decision };
}

function testerNode(state) {
  console.log(`[pid ${process.pid}] [tester] reviewing, gateDecision was:`, state.gateDecision);
  return { testerVerdict: "approved (fake)" };
}

export function buildGraph() {
  return new StateGraph(State)
    .addNode("coder", coderNode)
    .addNode("g1", g1GateNode)
    .addNode("tester", testerNode)
    .addEdge(START, "coder")
    .addEdge("coder", "g1")
    .addEdge("g1", "tester")
    .addEdge("tester", END);
}
