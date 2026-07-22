import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConductorWorkApp } from "../app.js";
import { run } from "../main.js";
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

  it("produces a versioned RunPlan with budget, capabilities, and policy", () => {
    const fixture = makeFixture();
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: fixture.root, workflows });
    const runPlan = app.planRun(fixture.contractPath);
    expect(runPlan.planVersion).toBe("1");
    expect(runPlan.brain.id).toBe("company-brain");
    expect(runPlan.contract.contractId).toBe("contract-001");
    expect(runPlan.workflow.id).toBe("coder-tester-loop");
    expect(Array.isArray(runPlan.workflow.capabilities)).toBe(true);
    expect(runPlan.policy).toEqual(runPlan.contract.policy);
    expect(runPlan.budget).toEqual({
      inputTokens: 24_000,
      outputTokens: 8_000,
      retryTokens: 4_000,
    });
  });

  it("normalizes a partial budget override into the versioned RunPlan", () => {
    const fixture = makeFixture();
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: fixture.root, workflows });
    const runPlan = app.planRun(fixture.contractPath, undefined, { inputTokens: 1_000 });
    expect(runPlan.budget.inputTokens).toBe(1_000);
    expect(runPlan.budget.outputTokens).toBe(8_000);
  });
});

function makeCliContractPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-work-cli-"));
  const contractPath = path.join(tmpDir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify({
    schemaVersion: "1.0",
    contractId: "contract-cli-001",
    objective: "Do the approved work",
    requirements: [{ id: "REQ-001", text: "Keep scope fixed" }],
    riskLevel: "low",
    policy: { allowedPaths: ["src/**"], forbiddenChanges: [], allowedCommands: [], allowedDependencies: [], allowNetwork: false, allowGitWrite: false, reviewerReadOnly: true },
    sourceSnapshots: { PRD: "local" },
    createdAt: "2026-07-21T00:00:00.000Z",
    brain: "company",
  }));
  return contractPath;
}

describe("conductor-work CLI", () => {
  it("fails closed for a run request when the selected profile is unavailable", async () => {
    const contractPath = makeCliContractPath();
    const lines: string[] = [];
    const exitCode = await run(["run", contractPath, "--profile", "missing-profile", "--json"], (line) => lines.push(line));
    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("ProfileNotFoundError");
  });

  it("keeps the existing plain-text plan output unchanged without --json", () => {
    const contractPath = makeCliContractPath();
    const lines: string[] = [];
    const exitCode = run(["plan", contractPath], (line) => lines.push(line));
    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "brain: company-brain@1.0.0",
      "contract: contract-cli-001",
      "workflow: coder-tester-loop@1.0.0",
      "requirements: 1",
      "policy: git writes disabled; reviewer read-only",
    ]);
  });

  it("emits a single JSON line with the versioned RunPlan when --json is passed", () => {
    const contractPath = makeCliContractPath();
    const lines: string[] = [];
    const exitCode = run(["plan", contractPath, "--json"], (line) => lines.push(line));
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const runPlan = JSON.parse(lines[0]!);
    expect(runPlan.planVersion).toBe("1");
    expect(runPlan.brain.id).toBe("company-brain");
    expect(runPlan.contract.contractId).toBe("contract-cli-001");
    expect(runPlan.workflow.id).toBe("coder-tester-loop");
    expect(Array.isArray(runPlan.workflow.capabilities)).toBe(true);
    expect(runPlan.policy).toEqual(runPlan.contract.policy);
    expect(runPlan.budget).toEqual({
      inputTokens: 24_000,
      outputTokens: 8_000,
      retryTokens: 4_000,
    });
  });

  it("accepts --json before the positional arguments as well", () => {
    const contractPath = makeCliContractPath();
    const lines: string[] = [];
    const exitCode = run(["--json", "plan", contractPath], (line) => lines.push(line));
    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});
