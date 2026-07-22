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
//     去重（按 memory.id）——2026-07-23 Zorro/Codex 跨模型复审"建议项"（可选，采纳）：两者都
//     排除 confidenceState === "rejected" 的记录。"继续的话题"不该包含一条操作者已经明确否掉
//     的记忆——这条对 issue #84 开场白本身零行为影响（render-greeting.mjs 根本不读
//     continuedThreads/openingSummary 这两个字段，只读 pendingDecisions），纯粹是为了不让
//     wake() 这个 #80 spike 和 #84 共用的函数，把 rejected 悄悄包进"延续线索"这个概念里，
//     保护 #80 自己的契约不被本次改动间接污染。
//   - pendingDecisions: continuedThreads 里 confidenceState === "unconfirmed" 的子集（"待你决策"）——
//     显式只认 "unconfirmed"，不是 "!== confirmed"：三态里的 "rejected"（操作者已明确否掉）不是
//     "待确认"，绝不能被复活进 pendingDecisions（2026-07-22 Zorro/Codex 跨模型复审 blocker 2）。
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
  const core = store
    .listMemories()
    .filter((memory) => CORE_MEMORY_TYPES.has(memory.type) && memory.confidenceState !== "rejected");
  const hinted = queryHint
    ? store.searchMemories(queryHint).filter((memory) => memory.confidenceState !== "rejected")
    : [];

  const byId = new Map();
  for (const memory of [...core, ...hinted]) {
    byId.set(memory.id, memory);
  }
  const continuedThreads = [...byId.values()].sort((a, b) => a.id - b.id);
  // Zorro/Codex 跨模型复审 blocker 2（2026-07-22）：ConfidenceState 是三态
  // （unconfirmed|confirmed|rejected，src/context/types.ts:33），"!== confirmed" 会把
  // rejected（操作者已经明确否掉的）也当成"待确认"复活。rejected 不是"还没确认"，是"确认过、
  // 否掉了"——不该出现在 pendingDecisions 里。改成显式只认 "unconfirmed"。
  const pendingDecisions = continuedThreads.filter((memory) => memory.confidenceState === "unconfirmed");

  const openingSummary = queryHint
    ? `醒来：core memory ${core.length} 条，FTS5 命中 "${queryHint}" ${hinted.length} 条，合计 ${continuedThreads.length} 条延续线索。`
    : `醒来：core memory ${core.length} 条，合计 ${continuedThreads.length} 条延续线索。`;

  return { openingSummary, continuedThreads, pendingDecisions };
}
