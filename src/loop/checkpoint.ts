/**
 * `createSqliteCheckpointer` — thin wrapper around `SqliteSaver.fromConnString(dbPath)`
 * (spike-findings.md Q4's verified usage pattern). The only reason this
 * exists as its own function is so `graph.ts`/test code all go through one
 * place instead of each repeating `import { SqliteSaver } from
 * "@langchain/langgraph-checkpoint-sqlite"` (PRD §5 "checkpoint.ts").
 *
 * **Deliberately no `MemorySaver` equivalent here** (PRD §5): A4a's graph
 * always compiles against a real `SqliteSaver`, even in tests (pointed at a
 * temp file) — never an in-memory, process-lifetime-only checkpointer. The
 * whole reason G1/G2/G3 gates exist is that a run can be paused and
 * resumed from *outside* the process that started it (PRD §8's acceptance
 * criterion), and a default that silently drops state on process exit
 * would be an easy trap for a future caller to reach for by habit.
 * `gates.test.ts`/`graph.test.ts` use `MemorySaver` directly (not through
 * this file) because *those* files are deliberately testing gate/graph
 * mechanics in isolation from disk I/O — this file's own
 * `checkpoint.test.ts` is what proves the real, disk-backed, cross-instance
 * resume path (PRD §5/§6 B4, spike-findings.md Q4's checkpoint mechanism,
 * §9.1's "same-process two-phase" variant of it).
 */

import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

export function createSqliteCheckpointer(dbPath: string): SqliteSaver {
  return SqliteSaver.fromConnString(dbPath);
}
