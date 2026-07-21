// Q5: does this compile clean under this repo's real tsconfig (strict +
// noUncheckedIndexedAccess + NodeNext ESM)? Reuses the Q3 interrupt/resume
// shape but in TypeScript, to see what type surface LangGraph exposes.
import {
  StateGraph,
  START,
  END,
  Annotation,
  MemorySaver,
  interrupt,
  Command,
} from "@langchain/langgraph";

const State = Annotation.Root({
  task: Annotation<string>(),
  coderOutput: Annotation<string>(),
  gateDecision: Annotation<string | undefined>(),
  testerVerdict: Annotation<string | undefined>(),
});

type GraphState = typeof State.State;

interface G1InterruptPayload {
  gate: "G1_SEND_TO_TESTER";
  diff: string;
  question: string;
}

function coderNode(state: GraphState): Partial<GraphState> {
  return { coderOutput: `fake diff for: ${state.task}` };
}

function g1GateNode(state: GraphState): Partial<GraphState> {
  // NOTE: interrupt()'s return type is `unknown` in the current LangGraph
  // types (no generic to type the resume value) — this is a real type-surface
  // finding, not an oversight; see spike-findings.md Q5.
  const decision = interrupt<G1InterruptPayload>({
    gate: "G1_SEND_TO_TESTER",
    diff: state.coderOutput,
    question: "approve sending this diff to tester?",
  });
  return { gateDecision: String(decision) };
}

function testerNode(state: GraphState): Partial<GraphState> {
  return { testerVerdict: `approved (fake), saw gateDecision=${state.gateDecision}` };
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

const threadConfig = { configurable: { thread_id: "q5-types-thread" } };

async function main(): Promise<void> {
  const first = await compiled.invoke({ task: "toy task" }, threadConfig);
  console.log("first:", first);

  // Command's `Nodes` type param defaults to bare `string`, which does NOT
  // structurally match `compiled.invoke`'s expected literal node-name union
  // unless explicitly supplied here — see spike-findings.md Q5 for the raw
  // TS2345 this produces without the explicit type argument below.
  const resumeCommand = new Command<
    unknown,
    Record<string, unknown>,
    "__start__" | "coder" | "g1" | "tester"
  >({ resume: "approve" });
  const second = await compiled.invoke(resumeCommand, threadConfig);
  console.log("second:", second);
}

await main();
