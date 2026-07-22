// B1 — 意图 → TaskContract 翻译器（模板化，不调模型）。
//
// 设计权威：docs/conductor-brain-layer/DESIGN.md §2.1 + PRD §0.1/§0.4/§2/§5。
// "翻译质量不是 spike 要证明的，可以模板化"（DESIGN §2.1 原话）——这里不做任何 NLP 拆解，
// 一句 rawIntent 就是唯一的 Requirement，riskLevel 硬编码 low，brain 硬编码 "company"（PRD §0.1：
// Orchestrator.plan() 的 BrainWorkflowMismatchError 硬约束，走 conductor-work 这条路径只能是
// "company"）。产出前必须过 assertValidTaskContract()（src/conductor/contract.ts）。
//
// 空字符串 rawIntent 走明确拒绝路径（PRD §3 B1 验收点：fail-closed，不产出非法 contract）——
// 不是等 assertValidTaskContract() 事后拒绝（虽然它其实也会拒绝，因为 objective 会是空字符串），
// 而是在翻译器自己这一层就先失败，语义更明确（"这不是一个可翻译的意图"，不是"翻译出的 contract
// 恰好没通过校验"）。

import { assertValidTaskContract } from "../../../../dist/conductor/contract.js";

/**
 * @param {string} rawIntent
 * @param {{ contractId?: string }} [opts]
 * @returns {import("../../../../dist/conductor/types.js").TaskContract}
 */
export function translateIntent(rawIntent, opts = {}) {
  if (typeof rawIntent !== "string" || rawIntent.trim() === "") {
    throw new TypeError("translateIntent: rawIntent must be a non-empty string (fail-closed, no contract produced)");
  }

  const contractId = opts.contractId ?? `brain-spike-${Date.now()}`;

  /** @type {import("../../../../dist/conductor/types.js").TaskContract} */
  const contract = {
    schemaVersion: "1.0",
    contractId,
    objective: rawIntent.trim(),
    requirements: [{ id: "REQ-001", text: rawIntent.trim() }],
    riskLevel: "low",
    policy: {
      allowedPaths: ["docs/conductor-brain-layer/spike/**"],
      forbiddenChanges: ["Do not touch src/** — this is a brain-spike smoke contract"],
      allowedCommands: [],
      allowedDependencies: [],
      allowNetwork: false,
      allowGitWrite: false,
      reviewerReadOnly: true,
    },
    sourceSnapshots: { "brain-spike-driver": "local" },
    createdAt: new Date().toISOString(),
    brain: "company",
  };

  assertValidTaskContract(contract);
  return contract;
}
