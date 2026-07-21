// Q3: human-in-the-loop gate. Node pauses at G1 via interrupt(), external caller
// resumes with Command({resume: <decision>}).
import { StateGraph, START, END, Annotation, MemorySaver, interrupt, Command } from "@langchain/langgraph";

const State = Annotation.Root({
  task: Annotation(),
  coderOutput: Annotation(),
  gateDecision: Annotation(),
  testerVerdict: Annotation(),
});

function coderNode(state) {
  console.log("[coder] drafting for task:", state.task);
  return { coderOutput: `fake diff for: ${state.task}` };
}

// G1: pause here, hand the pending diff out to the caller, wait for approve/reject.
function g1GateNode(state) {
  console.log("[G1] about to interrupt(), coderOutput =", state.coderOutput);
  const decision = interrupt({
    gate: "G1_SEND_TO_TESTER",
    diff: state.coderOutput,
    question: "approve sending this diff to tester?",
  });
  console.log("[G1] resumed with decision =", decision);
  return { gateDecision: decision };
}

function testerNode(state) {
  console.log("[tester] reviewing, gateDecision was:", state.gateDecision);
  return { testerVerdict: "approved (fake)" };
}

const graph = new StateGraph(State)
  .addNode("coder", coderNode)
  .addNode("g1", g1GateNode)
  .addNode("tester", testerNode)
  .addEdge(START, "coder")
  .addEdge("coder", "g1")
  .addEdge("g1", "tester")
  .addEdge("tester", END);

const checkpointer = new MemorySaver();
const compiled = graph.compile({ checkpointer });

const threadConfig = { configurable: { thread_id: "q3-thread-1" } };

console.log("=== first invoke: should stop at G1 interrupt ===");
const first = await compiled.invoke({ task: "toy task: add a function" }, threadConfig);
console.log("first result (should show __interrupt__):", JSON.stringify(first, null, 2));

const state1 = await compiled.getState(threadConfig);
console.log("state.next after interrupt:", state1.next);
console.log("state.tasks[0].interrupts:", JSON.stringify(state1.tasks?.[0]?.interrupts, null, 2));

console.log("=== resume with Command({resume: 'approve'}) ===");
const second = await compiled.invoke(new Command({ resume: "approve" }), threadConfig);
console.log("second (final) result:", JSON.stringify(second, null, 2));

console.log("Q3 OK: interrupt paused the graph, external Command({resume}) continued it to completion.");
