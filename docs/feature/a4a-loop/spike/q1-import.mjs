// Q1: import smoke test — does @langchain/langgraph + checkpoint-sqlite import
// cleanly under Node v24 + pnpm + ESM (type:"module", NodeNext)?
import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

console.log("StateGraph:", typeof StateGraph);
console.log("START:", START);
console.log("END:", END);
console.log("SqliteSaver:", typeof SqliteSaver);
console.log("Q1 OK: imports resolved under Node", process.version);
