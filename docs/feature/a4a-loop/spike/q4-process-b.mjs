// Q4 Process B: a WHOLLY SEPARATE `node` invocation. Never saw Process A's
// in-memory state. Rebuilds the same graph def, points a fresh SqliteSaver
// at the SAME db file, and resumes purely by thread_id + Command({resume}).
import { Command } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { buildGraph } from "./q4-graph-def.mjs";

const DB_PATH = process.argv[2];
const THREAD_ID = process.argv[3] ?? "q4-cross-process-thread";
if (!DB_PATH) {
  console.error("usage: node q4-process-b.mjs <db-path> [thread-id]");
  process.exit(1);
}

const checkpointer = SqliteSaver.fromConnString(DB_PATH);
const compiled = buildGraph().compile({ checkpointer });

const threadConfig = { configurable: { thread_id: THREAD_ID } };

console.log(`[pid ${process.pid}] Process B starting (fresh process), db=${DB_PATH}, thread_id=${THREAD_ID}`);

// Prove we can read the pending interrupt state purely from disk, with no
// in-memory carryover from process A.
const stateBeforeResume = await compiled.getState(threadConfig);
console.log(`[pid ${process.pid}] Process B getState() BEFORE resume — state.next:`, stateBeforeResume.next);
console.log(`[pid ${process.pid}] Process B getState() BEFORE resume — pending interrupts:`,
  JSON.stringify(stateBeforeResume.tasks?.[0]?.interrupts, null, 2));

console.log(`[pid ${process.pid}] Process B resuming with Command({resume: 'approve-from-process-b'})...`);
const result = await compiled.invoke(new Command({ resume: "approve-from-process-b" }), threadConfig);
console.log(`[pid ${process.pid}] Process B final result:`);
console.log(JSON.stringify(result, null, 2));

console.log(`[pid ${process.pid}] Q4 OK: process B, a fresh node invocation, resumed purely from thread_id + on-disk sqlite checkpoint and ran to completion.`);
