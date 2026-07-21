import { describe, expect, it } from "vitest";
import { PersonalBrainAdapter } from "../adapter.js";
import type { PersonalTaskInput } from "../types.js";
import { InvalidTaskContractError } from "../../conductor/contract.js";
import type { ExecutionPolicy } from "../../conductor/types.js";

const policy: ExecutionPolicy = {
  allowedPaths: ["src/**"],
  forbiddenChanges: ["Do not touch company code"],
  allowedCommands: ["pnpm test"],
  allowedDependencies: [],
  allowNetwork: false,
  allowGitWrite: false,
  reviewerReadOnly: true,
};

const validInput: PersonalTaskInput = {
  contractId: "personal-contract-001",
  objective: "Tidy up the personal notes app",
  requirements: [{ id: "REQ-001", text: "The notes list renders without errors" }],
  riskLevel: "low",
  policy,
  sourceSnapshots: { "NOTES.md": "sha256:abc" },
  createdAt: "2026-07-22T00:00:00.000Z",
};

function makeAdapter(): PersonalBrainAdapter {
  return new PersonalBrainAdapter({
    brainId: "personal-brain",
    brainVersion: "0.1.0",
    defaultWorkflowId: "coder-tester-loop",
  });
}

describe("PersonalBrainAdapter", () => {
  it("builds a valid, frozen TaskContract stamped brain: personal", () => {
    const adapter = makeAdapter();
    const contract = adapter.buildContract(validInput);

    expect(contract.brain).toBe("personal");
    expect(contract.contractId).toBe(validInput.contractId);
    expect(contract.requirements).toEqual(validInput.requirements);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.policy)).toBe(true);
    expect(Object.isFrozen(contract.requirements)).toBe(true);
    expect(Object.isFrozen(contract.sourceSnapshots)).toBe(true);
    expect(() => {
      (contract as { objective: string }).objective = "mutated";
    }).toThrow();
  });

  it("does not mutate or freeze the caller's original input object/fields", () => {
    const adapter = makeAdapter();
    const originalRequirements = [{ id: "REQ-001", text: "The notes list renders without errors" }];
    const originalPolicy: ExecutionPolicy = { ...policy };
    const originalSourceSnapshots = { "NOTES.md": "sha256:abc" };
    const input: PersonalTaskInput = {
      contractId: "personal-contract-002",
      objective: "Tidy up the personal notes app",
      requirements: originalRequirements,
      riskLevel: "low",
      policy: originalPolicy,
      sourceSnapshots: originalSourceSnapshots,
      createdAt: "2026-07-22T00:00:00.000Z",
    };

    const contract = adapter.buildContract(input);

    // The returned contract is frozen (existing guarantee, unaffected).
    expect(Object.isFrozen(contract)).toBe(true);

    // The caller's original input and its nested fields must remain
    // fully mutable -- buildContract must not freeze or otherwise alter
    // objects it did not itself allocate.
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(originalRequirements)).toBe(false);
    expect(Object.isFrozen(originalPolicy)).toBe(false);
    expect(Object.isFrozen(originalSourceSnapshots)).toBe(false);

    expect(() => {
      originalRequirements.push({ id: "REQ-002", text: "added after buildContract" });
    }).not.toThrow();
    expect(originalRequirements).toHaveLength(2);

    expect(() => {
      (originalPolicy as { allowNetwork: boolean }).allowNetwork = true;
    }).not.toThrow();
    expect(originalPolicy.allowNetwork).toBe(true);

    expect(() => {
      (originalSourceSnapshots as Record<string, string>)["NEW.md"] = "sha256:def";
    }).not.toThrow();
    expect(originalSourceSnapshots).toHaveProperty("NEW.md", "sha256:def");

    expect(() => {
      (input as { objective: string }).objective = "mutated original input";
    }).not.toThrow();
    expect(input.objective).toBe("mutated original input");

    // And mutating the original after the fact must not leak into the
    // already-built (and frozen) contract -- confirms no shared references.
    expect(contract.requirements).toHaveLength(1);
    expect(contract.policy.allowNetwork).toBe(false);
    expect(contract.sourceSnapshots).not.toHaveProperty("NEW.md");
    expect(contract.objective).toBe("Tidy up the personal notes app");
  });

  it("defaults createdAt and sourceSnapshots when omitted", () => {
    const adapter = makeAdapter();
    const { createdAt, sourceSnapshots, ...rest } = validInput;
    const contract = adapter.buildContract(rest as PersonalTaskInput);

    expect(typeof contract.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(contract.createdAt))).toBe(false);
    expect(contract.sourceSnapshots).toEqual({});
  });

  it("rejects input that would fail the shared conductor boundary check, e.g. an empty requirements list", () => {
    const adapter = makeAdapter();
    const invalidInput: PersonalTaskInput = { ...validInput, requirements: [] };

    expect(() => adapter.buildContract(invalidInput)).toThrow(InvalidTaskContractError);
  });

  it("rejects input that attempts to enable Git writes via the policy", () => {
    const adapter = makeAdapter();
    const invalidInput: PersonalTaskInput = {
      ...validInput,
      policy: { ...policy, allowGitWrite: true as unknown as false },
    };

    expect(() => adapter.buildContract(invalidInput)).toThrow(InvalidTaskContractError);
  });

  it("exposes only static, credential-free adapter identity", () => {
    const adapter = makeAdapter();
    const config = adapter.getConfig();

    expect(config).toEqual({
      brainId: "personal-brain",
      brainVersion: "0.1.0",
      defaultWorkflowId: "coder-tester-loop",
    });
    expect(Object.keys(config)).not.toContain("apiKey");
    expect(Object.keys(config)).not.toContain("credential");
  });
});
