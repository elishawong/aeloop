import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorWorkApp } from "../app.js";
import { coderTesterWorkflow } from "../../workflow/coder-tester.js";
import { WorkflowRegistry } from "../../workflow/registry.js";

let tmpDir = "";

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});
function makeFixture(): { root: string; contractPath: string } {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-work-"));
  const brainDir = path.join(tmpDir, "brain");
  fs.mkdirSync(brainDir);
  fs.writeFileSync(path.join(brainDir, "manifest.yaml"), "id: company-brain\nkind: company\nversion: 1.0.0\ndefault_workflow_id: coder-tester-loop\ncontract_schema_version: '1.0'\n");
  fs.writeFileSync(path.join(brainDir, "system-prompt.md"), "# Company brain\n");
  const contractPath = path.join(tmpDir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify({
    schemaVersion: "1.0",
    contractId: "contract-001",
    objective: "Do the approved work",
    requirements: [{ id: "REQ-001", text: "Keep scope fixed" }],
    riskLevel: "low",
    policy: { allowedPaths: ["src/**"], forbiddenChanges: [], allowedCommands: [], allowedDependencies: [], allowNetwork: false, allowGitWrite: false, reviewerReadOnly: true },
    sourceSnapshots: { PRD: "local" },
    createdAt: "2026-07-21T00:00:00.000Z",
    brain: "company",
  }));
  return { root: brainDir, contractPath };
}

describe("ConductorWorkApp", () => {
  it("loads the company brain and plans a registered workflow from a contract file", () => {
    const fixture = makeFixture();
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: fixture.root, workflows });
    const plan = app.plan(fixture.contractPath);
    expect(plan.brain.id).toBe("company-brain");
    expect(plan.workflow.id).toBe("coder-tester-loop");
  });

  it("projects loop events into a read-only company evidence bundle", () => {
    const fixture = makeFixture();
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: fixture.root, workflows });
    const bundle = app.projectEvents([
      { type: "run_started", runId: 1, threadId: "t-1", ts: "2026-07-21T00:00:00.000Z", task: "demo", profile: "company", workflowDefId: "coder-tester-loop", rejectThreshold: 2 },
      { type: "run_completed", runId: 1, threadId: "t-1", ts: "2026-07-21T00:00:01.000Z", currentState: "completed" },
    ], fixture.contractPath);
    expect(bundle.status).toBe("completed");
    expect(bundle.contractId).toBe("contract-001");
    expect(bundle.eventTypes).toEqual(["run_started", "run_completed"]);
    expect(bundle.unprovenItems).toEqual(["REQ-001"]);
  });
});
