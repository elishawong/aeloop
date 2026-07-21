import { resumeRun, startRun } from "../loop/runner.js";
import type { WorkflowDependencies, WorkflowManifest, WorkflowPlugin, WorkflowRunContext, CoderTesterWorkflowInput } from "./types.js";

export const CODER_TESTER_MANIFEST: WorkflowManifest = {
  id: "coder-tester-loop",
  version: "1.0.0",
  displayName: "Coder / Tester Loop",
  description: "Generate a candidate change, verify it independently, and pause at human gates.",
  inputVersion: "1",
  outputVersion: "1",
  roles: ["coder", "tester"],
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
  return value as CoderTesterWorkflowInput;
}

export const coderTesterWorkflow: WorkflowPlugin<CoderTesterWorkflowInput> = {
  manifest: CODER_TESTER_MANIFEST,
  validateInput: assertCoderTesterInput,
  start(input, deps: WorkflowDependencies) {
    return startRun(deps.loop, input);
  },
  resume(context: WorkflowRunContext, resumeValue, decidedBy, stepCounters, deps: WorkflowDependencies) {
    return resumeRun(deps.loop, context.runId, context.threadId, resumeValue as Parameters<typeof resumeRun>[3], decidedBy, stepCounters);
  },
};

