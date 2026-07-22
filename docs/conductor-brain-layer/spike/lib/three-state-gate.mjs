// B2 — 三态确认门：把一个 EvidenceBundle 折回 identity MemoryStore，绝不把
// evidence[].source === "model-reported" 的证据当 confirmed 写回（DESIGN §2.2 那个
// "必须诚实处理的耦合点"）。
//
// 设计权威：docs/conductor-brain-layer/DESIGN.md §2.2 + PRD §2/§3(B2)/§4(AC2)。
//
// 规则（逐条对应 PRD §2 B2 那一行）：
//   1. evidence[].source === "verified" 或缺省（"absent = verified"，src/evidence/bundle.ts:31-32
//      注释原话）且 passed === true → insertMemory(unconfirmed) 后立即 confirm()。
//   2. evidence[].source === "model-reported" → 只 insertMemory({confidenceState:"unconfirmed"})，
//      绝不调用 confirm()——无论 passed 是 true 还是 false，这条规则不看 passed，只看 source。
//   3. 无论 evidence[] 是否为空，都基于 evidenceBundle.status（机械字段，来自 LoopEvent.type
//      判断，不是模型自称）写一条 active_task 记录本轮状态并直接 confirm()——这条走"机械事实"
//      通道，不受"model-reported 不能 confirm"这条规则约束（status 不是 EvidenceItem.source
//      意义上的"model-reported"证据）。
//
// 写入的 memory.content 里带 evidenceBundle.contractId/runId 字符串，方便 AC1（"第5步真观察到
// 延续"）通过字符串匹配溯源到是哪一次 run 写回的。

import { ConfirmationService } from "../../../../dist/context/confirmation.js";

/**
 * @param {import("../../../../dist/evidence/bundle.js").EvidenceBundle} evidenceBundle
 * @param {import("../../../../dist/context/store.js").MemoryStore} identityStore
 * @param {{ actor?: string }} [opts]
 * @returns {Array<{ evidenceId: string | null, memoryId: number, source: string, confirmed: boolean }>}
 */
export function applyThreeStateGate(evidenceBundle, identityStore, opts = {}) {
  const actor = opts.actor ?? "brain-spike-driver (three-state-gate)";
  const confirmation = new ConfirmationService(identityStore);
  const results = [];

  for (const item of evidenceBundle.evidence ?? []) {
    // "absent = verified" — src/evidence/bundle.ts:31-32 注释原话。
    const treatedAsVerified = item.source === undefined || item.source === "verified";

    const memory = identityStore.insertMemory({
      type: "postmortem",
      title: `evidence:${item.id} (contract ${evidenceBundle.contractId ?? "unknown"})`,
      content: [
        `contractId=${evidenceBundle.contractId ?? "unknown"} runId=${evidenceBundle.runId ?? "unknown"}`,
        `evidence.id=${item.id} kind=${item.kind} source=${item.source ?? "(absent=verified)"} passed=${item.passed}`,
        item.content ?? "",
      ].join("\n"),
      sourceFile: item.ref,
      tags: ["brain-spike", "evidence", item.source ?? "verified"],
    });

    // 规则核心：source === "model-reported" 的证据，无论 passed 是 true 还是 false，
    // 绝不调用 confirm() —— 这是本模块唯一必须证明成立的规则。
    let confirmed = false;
    if (treatedAsVerified && item.passed === true) {
      confirmation.confirm(memory.id, actor);
      confirmed = true;
    }
    results.push({ evidenceId: item.id, memoryId: memory.id, source: item.source ?? "verified", confirmed });
  }

  // 机械事实通道：evidenceBundle.status 不是 EvidenceItem.source 意义上的 "model-reported"
  // 证据（它来自 LoopEvent.type 的机械判断，见 src/evidence/bundle.ts recordEvent()），
  // 所以无论上面 evidence[] 是否为空，都写一条 active_task 并直接 confirm()。
  const statusMemory = identityStore.insertMemory({
    type: "active_task",
    title: `run-status:${evidenceBundle.runId ?? "unknown"} (contract ${evidenceBundle.contractId ?? "unknown"})`,
    content: `contractId=${evidenceBundle.contractId ?? "unknown"} runId=${evidenceBundle.runId ?? "unknown"} status=${evidenceBundle.status}`,
    sourceFile: null,
    tags: ["brain-spike", "run-status"],
  });
  confirmation.confirm(statusMemory.id, `${actor} (mechanical: evidenceBundle.status)`);
  results.push({ evidenceId: null, memoryId: statusMemory.id, source: "mechanical-status", confirmed: true });

  return results;
}
