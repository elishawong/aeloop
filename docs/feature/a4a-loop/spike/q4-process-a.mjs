// Q4 Process A: build graph, run to G1 interrupt, checkpoint to sqlite on disk,
// then exit WITHOUT resuming. Proves the interrupt + partial state survives
// to disk via SqliteSaver, ready for a wholly separate process to pick up.
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph } from "./q4-graph-def.mjs";

const DB_PATH = process.argv[2];
const THREAD_ID = process.argv[3] ?? "q4-cross-process-thread";
if (!DB_PATH) {
  console.error("usage: node q4-process-a.mjs <db-path> [thread-id]");
  process.exit(1);
}

const checkpointer = SqliteSaver.fromConnString(DB_PATH);
const compiled = buildGraph().compile({ checkpointer });

const threadConfig = { configurable: { thread_id: THREAD_ID } };

console.log(`[pid ${process.pid}] Process A starting, db=${DB_PATH}, thread_id=${THREAD_ID}`);
const result = await compiled.invoke({ task: "toy task: cross-process resume" }, threadConfig);
console.log(`[pid ${process.pid}] Process A invoke() returned (should show __interrupt__):`);
console.log(JSON.stringify(result, null, 2));

const state = await compiled.getState(threadConfig);
console.log(`[pid ${process.pid}] Process A state.next (should be ['g1']):`, state.next);

console.log(`[pid ${process.pid}] Process A exiting now WITHOUT resuming. Checkpoint should be on disk at ${DB_PATH}.`);
process.exit(0);
