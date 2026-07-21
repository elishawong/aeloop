#!/usr/bin/env node

import {
  Orchestrator,
  WorkflowRegistry,
  assertValidTaskContract,
  coderTesterWorkflow,
} from "../dist/index.js";

const brain = {
  id: "company-brain",
  kind: "company",
  version: "1.0.0",
  defaultWorkflowId: "coder-tester-loop",
  contractSchemaVersion: "1.0",
};

const contract = {
  schemaVersion: "1.0",
  contractId: "company-demo-001",
  objective: "Implement only the approved demo behavior",
  requirements: [{ id: "REQ-001", text: "The workflow selection is deterministic" }],
  riskLevel: "low",
  policy: {
    allowedPaths: ["src/**"],
    forbiddenChanges: ["Do not add unrelated features"],
    allowedCommands: ["pnpm test"],
    allowedDependencies: [],
    allowNetwork: false,
    allowGitWrite: false,
    reviewerReadOnly: true,
  },
  sourceSnapshots: { "demo-input": "local" },
  createdAt: new Date().toISOString(),
  brain: "company",
};

assertValidTaskContract(contract);
const workflows = new WorkflowRegistry();
workflows.register(coderTesterWorkflow);
const plan = new Orchestrator(workflows).plan({ brain, contract });

console.log("Company brain demo");
console.log(`brain: ${plan.brain.id}`);
console.log(`contract: ${plan.contract.contractId}`);
console.log(`workflow: ${plan.workflow.id}@${plan.workflow.version}`);
console.log("policy: git writes disabled; reviewer read-only");
