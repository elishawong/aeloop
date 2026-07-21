import { describe, expect, it } from "vitest";
import { assertValidTaskContract, InvalidTaskContractError, validateTaskContract } from "../contract.js";
import type { TaskContract } from "../types.js";

const validContract: TaskContract = {
  schemaVersion: "1.0",
  contractId: "contract-001",
  objective: "Implement the approved change",
  requirements: [{ id: "REQ-001", text: "The requested behavior is implemented" }],
  riskLevel: "medium",
  policy: {
    allowedPaths: ["src/**"],
    forbiddenChanges: ["Do not add unrelated features"],
    allowedCommands: ["pnpm test"],
    allowedDependencies: [],
    allowNetwork: false,
    allowGitWrite: false,
    reviewerReadOnly: true,
  },
  sourceSnapshots: { "PRD.md": "sha256:abc" },
  createdAt: "2026-07-21T00:00:00.000Z",
  brain: "company",
};

describe("TaskContract validation", () => {
  it("accepts a complete contract and enforces the company-safe git policy", () => {
    expect(validateTaskContract(validContract)).toEqual([]);
    expect(() => assertValidTaskContract(validContract)).not.toThrow();
  });

  it("rejects duplicate requirements and any attempt to enable git writes", () => {
    const invalid = {
      ...validContract,
      requirements: [
        { id: "REQ-001", text: "first" },
        { id: "REQ-001", text: "duplicate" },
      ],
      policy: { ...validContract.policy, allowGitWrite: true },
    } as unknown;
    const issues = validateTaskContract(invalid);
    expect(issues.map((issue) => issue.path)).toEqual(["requirements[1].id", "policy.allowGitWrite"]);
    expect(() => assertValidTaskContract(invalid)).toThrow(InvalidTaskContractError);
  });

  it("fails closed when the contract is not an object", () => {
    expect(validateTaskContract(null)).toEqual([{ path: "$", message: "must be an object" }]);
  });
});

