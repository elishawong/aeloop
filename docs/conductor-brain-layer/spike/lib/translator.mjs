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
//
// issue #93 B5 新增两个可选参数（默认值和 #75/#80 spike 原有行为逐字节不变，`test-translator.mjs`
// 现有全部用例零改动继续通过）：
//   - `opts.allowedPaths`：覆盖默认的 `docs/conductor-brain-layer/spike/**`。
//     `scripts/dispatch-brain-task.mjs`（B5）传入一个独立的新安全区
//     `docs/conductor-brain-multiproject/spike/**`，**绝不**传入任何目标项目（如 whoseorder）的
//     真实路径——docs/conductor-brain-multiproject/PRD.md §3.2 已经定的范围决定：coder/tester
//     的实际工具执行 cwd 今天不指向任何目标项目（§3.1 判定：这条透传管线今天不存在，片①不做），
//     这里的 allowedPaths 只是"证据层面允许被改动的路径"，即便 cwd 层面已经不可能触达目标项目，
//     也不应该在契约里写一个自己都不打算真的允许触达的路径，写代码时要断言这一点，防止未来有人
//     "顺手"把它接上（PRD §4.6 plan.md 步骤3 明确要求的测试）。
//   - `opts.objectivePrefix`：拼进 `objective`/`requirements[0].text` 前面的一段文本（如
//     "以下任务与项目 whoseworks/whoseorder 相关……"），让"这个 dispatch 是为哪个项目发起的"这层
//     语义在契约文本层面成立（PRD §3.2 描述的"契约层面项目关联"）——纯文本拼接，不改变
//     `TaskContract` 的字段形状，不新增字段。

import { assertValidTaskContract } from "../../../../dist/conductor/contract.js";

const DEFAULT_ALLOWED_PATHS = ["docs/conductor-brain-layer/spike/**"];

/**
 * @param {string} rawIntent
 * @param {{ contractId?: string, allowedPaths?: string[], objectivePrefix?: string }} [opts]
 * @returns {import("../../../../dist/conductor/types.js").TaskContract}
 */
export function translateIntent(rawIntent, opts = {}) {
  if (typeof rawIntent !== "string" || rawIntent.trim() === "") {
    throw new TypeError("translateIntent: rawIntent must be a non-empty string (fail-closed, no contract produced)");
  }

  const contractId = opts.contractId ?? `brain-spike-${Date.now()}`;
  const objectiveText = opts.objectivePrefix ? `${opts.objectivePrefix}\n\n${rawIntent.trim()}` : rawIntent.trim();

  /** @type {import("../../../../dist/conductor/types.js").TaskContract} */
  const contract = {
    schemaVersion: "1.0",
    contractId,
    objective: objectiveText,
    requirements: [{ id: "REQ-001", text: objectiveText }],
    riskLevel: "low",
    policy: {
      allowedPaths: opts.allowedPaths ?? DEFAULT_ALLOWED_PATHS,
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
