// B0 — 醒来：开 brain 自己的 identity MemoryStore(dbPath)，组一份开场白。
//
// 设计权威：docs/conductor-brain-layer/DESIGN.md §2.2（WakeResult 接口草案）+ §10 步骤1/5。
// 不调用任何模型（DESIGN §10 步骤1 字面描述本身不要求模型调用；PRD §0.4 的解读选择）。
//
// `openIdentityStore(dbPath)` 只是 `new MemoryStore(dbPath)` 的一个薄包装，存在的唯一理由是
// 让调用方（run-spike.mjs）在同一处显式声明"这是 brain 自己的 identity db，不是任何 Layer2
// profile 的 memory.db"——两者是完全不同的 SQLite 文件（DESIGN §3 第1条）。
//
// `wake(store, queryHint?)` 组装 WakeResult：
//   - openingSummary: 人类可读的一句话摘要（core memories 数 + hint 命中数）
//   - continuedThreads: CORE_MEMORY_TYPES（identity/constraint/decision）全量 + FTS5 命中的并集，
//     去重（按 memory.id）
//   - pendingDecisions: continuedThreads 里 confidenceState !== "confirmed" 的子集（"待你决策"）
//
// 不判定"宪法约束是否漂移"（DESIGN §2.2 WakeResult.constitutionWarnings 标 [?] 未定型，
// DESIGN §0.5 图1自己承认这一步在现有参考实现里也是"靠自觉"——本 spike 不假装能机制化掉它，
// 直接不做这个字段，不产出一个假装存在但永远空的 constitutionWarnings）。

import { MemoryStore } from "../../../../dist/context/store.js";
import { CORE_MEMORY_TYPES } from "../../../../dist/context/injector.js";

/**
 * 开一个独立于任何 Layer2 profile 的 identity MemoryStore 实例。
 * @param {string} dbPath
 * @returns {import("../../../../dist/context/store.js").MemoryStore}
 */
export function openIdentityStore(dbPath) {
  return new MemoryStore(dbPath);
}

/**
 * @param {import("../../../../dist/context/store.js").MemoryStore} store
 * @param {string} [queryHint]
 * @returns {{openingSummary: string, continuedThreads: import("../../../../dist/context/types.js").Memory[], pendingDecisions: import("../../../../dist/context/types.js").Memory[]}}
 */
export function wake(store, queryHint) {
  const core = store.listMemories().filter((memory) => CORE_MEMORY_TYPES.has(memory.type));
  const hinted = queryHint ? store.searchMemories(queryHint) : [];

  const byId = new Map();
  for (const memory of [...core, ...hinted]) {
    byId.set(memory.id, memory);
  }
  const continuedThreads = [...byId.values()].sort((a, b) => a.id - b.id);
  const pendingDecisions = continuedThreads.filter((memory) => memory.confidenceState !== "confirmed");

  const openingSummary = queryHint
    ? `醒来：core memory ${core.length} 条，FTS5 命中 "${queryHint}" ${hinted.length} 条，合计 ${continuedThreads.length} 条延续线索。`
    : `醒来：core memory ${core.length} 条，合计 ${continuedThreads.length} 条延续线索。`;

  return { openingSummary, continuedThreads, pendingDecisions };
}
