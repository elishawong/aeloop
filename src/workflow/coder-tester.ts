import { resumeRun, startRun } from "../loop/runner.js";
import { assertValidTaskContract } from "../conductor/contract.js";
import type { TaskContract } from "../conductor/types.js";
import type { WorkflowDependencies, WorkflowManifest, WorkflowPlugin, WorkflowRunContext, CoderTesterWorkflowInput } from "./types.js";

export const CODER_TESTER_MANIFEST: WorkflowManifest = {
  id: "coder-tester-loop",
  version: "1.0.0",
  displayName: "Coder / Tester Loop",
  description: "Generate a candidate change, verify it independently, and pause at human gates.",
  inputVersion: "1",
  outputVersion: "1",
  roles: ["coder", "tester"],
  capabilities: ["code-generation", "test-execution", "human-gate"],
  riskClass: "high",
  inputSchema: {
    type: "object",
    properties: {
      task: { type: "string" },
      profile: { type: "string" },
      workflowDefId: { type: "string" },
      injectedContext: { type: "object" },
      rejectThreshold: { type: "number" },
      contract: { type: "object" },
    },
    required: ["task", "profile", "workflowDefId", "injectedContext", "rejectThreshold"],
  },
  outputSchema: {
    type: "object",
    properties: {
      runId: { type: "number" },
      threadId: { type: "string" },
      done: { type: "boolean" },
      stepCounters: { type: "object" },
      interrupt: { type: "object" },
    },
    required: ["runId", "threadId", "done", "stepCounters"],
  },
};

function assertCoderTesterInput(input: unknown): CoderTesterWorkflowInput {
  if (!input || typeof input !== "object") throw new TypeError("coder-tester workflow input must be an object");
  const value = input as Partial<CoderTesterWorkflowInput>;
  if (typeof value.task !== "string" || value.task.trim() === "") throw new TypeError("coder-tester input.task is required");
  if (typeof value.profile !== "string" || value.profile.trim() === "") throw new TypeError("coder-tester input.profile is required");
  if (typeof value.workflowDefId !== "string" || value.workflowDefId.trim() === "") throw new TypeError("coder-tester input.workflowDefId is required");
  if (!value.injectedContext || typeof value.injectedContext !== "object") throw new TypeError("coder-tester input.injectedContext is required");
  if (typeof value.rejectThreshold !== "number" || !Number.isInteger(value.rejectThreshold) || value.rejectThreshold < 1) {
    throw new TypeError("coder-tester input.rejectThreshold must be a positive integer");
  }
  if (value.contract !== undefined) assertValidTaskContract(value.contract);
  return value as CoderTesterWorkflowInput;
}

/** Renders the immutable contract into the task text seen by both roles. */
export function renderTaskContract(task: string, contract: TaskContract): string {
  const requirements = contract.requirements
    .map((requirement) => `- ${requirement.id}: ${requirement.text}${requirement.sourceRef ? ` (source: ${requirement.sourceRef})` : ""}`)
    .join("\n");
  const acceptance = contract.requirements
    .flatMap((requirement) => requirement.acceptanceCriteria?.map((criterion) => `- ${requirement.id}: ${criterion}`) ?? [])
    .join("\n");
  const criteriaSection = acceptance ? `\n\nAcceptance criteria:\n${acceptance}` : "";
  return `${task}\n\n---\n\n# Task Contract\nContract ID: ${contract.contractId}\nObjective: ${contract.objective}\nRisk: ${contract.riskLevel}\n\nRequirements:\n${requirements}${criteriaSection}\n\nAllowed paths: ${contract.policy.allowedPaths.join(", ") || "(none)"}\nForbidden changes:\n${contract.policy.forbiddenChanges.map((item) => `- ${item}`).join("\n")}\nAllowed commands: ${contract.policy.allowedCommands.join(", ") || "(none)"}\nAllowed dependencies: ${contract.policy.allowedDependencies.join(", ") || "(none)"}\nNetwork allowed: ${contract.policy.allowNetwork ? "yes" : "no"}\nGit writes allowed: no`;
}

export const coderTesterWorkflow: WorkflowPlugin<CoderTesterWorkflowInput> = {
  manifest: CODER_TESTER_MANIFEST,
  validateInput: assertCoderTesterInput,
  start(input, deps: WorkflowDependencies) {
    const { contract, ...runInput } = input;
    return startRun(deps.loop, {
      ...runInput,
      task: contract ? renderTaskContract(runInput.task, contract) : runInput.task,
    });
  },
  resume(context: WorkflowRunContext, resumeValue, decidedBy, stepCounters, deps: WorkflowDependencies) {
    return resumeRun(deps.loop, context.runId, context.threadId, resumeValue as Parameters<typeof resumeRun>[3], decidedBy, stepCounters);
  },
};
