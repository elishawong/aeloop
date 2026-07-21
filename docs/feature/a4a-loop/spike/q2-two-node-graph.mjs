// Q2: minimal coder->tester StateGraph. Toy nodes return fake data only.
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";

const State = Annotation.Root({
  task: Annotation(),
  coderOutput: Annotation(),
  testerVerdict: Annotation(),
  log: Annotation({
    reducer: (a, b) => a.concat(b),
    default: () => [],
  }),
});

function coderNode(state) {
  console.log("[coder] received state.task =", state.task);
  return {
    coderOutput: `fake diff for: ${state.task}`,
    log: ["coder ran"],
  };
}

function testerNode(state) {
  console.log("[tester] received state.coderOutput =", state.coderOutput);
  return {
    testerVerdict: "approved (fake)",
    log: ["tester ran"],
  };
}

const graph = new StateGraph(State)
  .addNode("coder", coderNode)
  .addNode("tester", testerNode)
  .addEdge(START, "coder")
  .addEdge("coder", "tester")
  .addEdge("tester", END);

const compiled = graph.compile();

const result = await compiled.invoke({ task: "toy task: add a function" });
console.log("Q2 final state:", JSON.stringify(result, null, 2));
console.log("Q2 OK: coder->tester StateGraph compiled and ran a full cycle.");
