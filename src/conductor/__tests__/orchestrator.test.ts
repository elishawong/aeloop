import { describe, expect, it } from "vitest";
import { BrainWorkflowMismatchError, Orchestrator } from "../orchestrator.js";
import { coderTesterWorkflow } from "../../workflow/coder-tester.js";
import { renderTaskContract } from "../../workflow/coder-tester.js";
import { WorkflowRegistry } from "../../workflow/registry.js";
import type { BrainManifest, TaskContract } from "../types.js";

const brain: BrainManifest = {
  id: "company-brain",
  kind: "company",
  version: "1.0.0",
  defaultWorkflowId: "coder-tester-loop",
  contractSchemaVersion: "1.0",
};

const contract: TaskContract = {
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

describe("Orchestrator", () => {
  it("renders the contract into deterministic execution context", () => {
    const rendered = renderTaskContract("user task", contract);
    expect(rendered).toContain("Contract ID: contract-001");
    expect(rendered).toContain("REQ-001: The requested behavior is implemented");
    expect(rendered).toContain("Git writes allowed: no");
  });

  it("selects the brain's default registered workflow after contract validation", () => {
    const registry = new WorkflowRegistry();
    registry.register(coderTesterWorkflow);
    const plan = new Orchestrator(registry).plan({ brain, contract });
    expect(plan.workflow.id).toBe("coder-tester-loop");
    expect(plan.contract.contractId).toBe("contract-001");
  });

  it("rejects a contract produced by the wrong brain kind", () => {
    const registry = new WorkflowRegistry();
    registry.register(coderTesterWorkflow);
    expect(() => new Orchestrator(registry).plan({ brain, contract: { ...contract, brain: "personal" } })).toThrow(BrainWorkflowMismatchError);
  });
});
