// Spike: does LangGraph 1.4.8 give a real "node about to execute" (pre-execution)
// signal, without touching node bodies? Empirically tests streamMode combinations
// against a toy 3-node graph (draft -> g1 [interrupt] -> review), with an
// artificial delay inside each real node so a race between "chunk observed" and
// "node body log line" would be visible if the ordering were wrong.
//
// Method: each real node logs an ORDER token the instant its body starts running
// (before any interrupt/await), and again right before it returns. The for-await
// loop over compiled.stream() logs an ORDER token the instant it receives each
// chunk, tagged with which streamMode produced it. If a "tasks"-mode create-shape
// chunk for node X is logged strictly *before* node X's own "body start" line,
// that's a real pre-execution signal — not just "arrived in the same tick by luck"
// (the delay inside each node widens any such race to be trivially observable).
import { StateGraph, START, END, Annotation, MemorySaver, interrupt, Command } from "@langchain/langgraph";

let order = 0;
const next = () => ++order;
function log(tag, extra) {
  console.log(`[${next()}] ${tag}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const State = Annotation.Root({
  task: Annotation(),
  coderOutput: Annotation(),
  gateDecision: Annotation(),
  testerOutput: Annotation(),
});

async function draftNode(state) {
  log("draft: body START", { task: state.task });
  await delay(50); // widen any race — a "chunk arrives after node already ran" bug would still show chunk-after-body-start, but this proves the loop isn't just accidentally interleaving on a zero-delay synchronous node.
  log("draft: body END (about to return)");
  return { coderOutput: `fake diff for: ${state.task}` };
}

function g1Node(state) {
  log("g1: body START (about to interrupt())", { coderOutput: state.coderOutput });
  const decision = interrupt({ gate: "G1_SEND_TO_TESTER", diff: state.coderOutput });
  log("g1: resumed with decision", decision);
  return { gateDecision: decision };
}

async function reviewNode(state) {
  log("review: body START", { gateDecision: state.gateDecision });
  await delay(50);
  log("review: body END (about to return)");
  return { testerOutput: "reviewed (fake)" };
}

const graph = new StateGraph(State)
  .addNode("draft", draftNode)
  .addNode("g1", g1Node)
  .addNode("review", reviewNode)
  .addEdge(START, "draft")
  .addEdge("draft", "g1")
  .addEdge("g1", "review")
  .addEdge("review", END);

const checkpointer = new MemorySaver();
const compiled = graph.compile({ checkpointer });
const cfg = { configurable: { thread_id: "node-start-spike-1" } };

async function driveStream(input, label) {
  log(`=== ${label}: compiled.stream(..., {streamMode: ["updates","tasks"]}) ===`);
  const stream = await compiled.stream(input, { ...cfg, streamMode: ["updates", "tasks"] });
  for await (const [mode, payload] of stream) {
    if (mode === "tasks") {
      const shape = "input" in payload ? "CREATE (pre-exec)" : "result" in payload ? "RESULT (post-exec)" : "UNKNOWN";
      log(`  chunk mode=tasks shape=${shape} name=${payload.name}`, { id: payload.id });
    } else if (mode === "updates") {
      log(`  chunk mode=updates`, { nodeNames: Object.keys(payload) });
    } else {
      log(`  chunk mode=${mode}`);
    }
  }
}

await driveStream({ task: "toy task: add a function" }, "first stream() call (draft -> g1 interrupt)");

log("=== resuming via Command({resume: 'approved'}) ===");
await driveStream(new Command({ resume: "approved" }), "second stream() call (g1 decided -> review -> end)");

log("Spike done.");
