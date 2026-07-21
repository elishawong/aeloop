import type { TaskContract } from "./types.js";

export interface ContractValidationIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidTaskContractError extends Error {
  readonly code = "INVALID_TASK_CONTRACT" as const;

  constructor(public readonly issues: readonly ContractValidationIssue[]) {
    super(`invalid task contract: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "InvalidTaskContractError";
  }
}

/**
 * Deterministic validation at the brain/engine boundary. This intentionally
 * does not interpret natural language or call a model.
 */
export function validateTaskContract(contract: unknown): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  if (!contract || typeof contract !== "object") return [{ path: "$", message: "must be an object" }];
  const value = contract as Partial<TaskContract>;
  if (value.schemaVersion !== "1.0") issues.push({ path: "schemaVersion", message: "must be 1.0" });
  for (const field of ["contractId", "objective", "createdAt"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") issues.push({ path: field, message: "must be a non-empty string" });
  }
  if (value.brain !== "personal" && value.brain !== "company") issues.push({ path: "brain", message: "must be personal or company" });
  if (value.riskLevel !== "low" && value.riskLevel !== "medium" && value.riskLevel !== "high") issues.push({ path: "riskLevel", message: "must be low, medium, or high" });
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    issues.push({ path: "requirements", message: "must contain at least one requirement" });
  } else {
    const seen = new Set<string>();
    value.requirements.forEach((requirement, index) => {
      if (!requirement || typeof requirement !== "object") {
        issues.push({ path: `requirements[${index}]`, message: "must be an object" });
        return;
      }
      if (typeof requirement.id !== "string" || requirement.id.trim() === "") issues.push({ path: `requirements[${index}].id`, message: "must be a non-empty string" });
      else if (seen.has(requirement.id)) issues.push({ path: `requirements[${index}].id`, message: "must be unique" });
      else seen.add(requirement.id);
      if (typeof requirement.text !== "string" || requirement.text.trim() === "") issues.push({ path: `requirements[${index}].text`, message: "must be a non-empty string" });
    });
  }
  const policy = value.policy;
  if (!policy || typeof policy !== "object") {
    issues.push({ path: "policy", message: "is required" });
  } else {
    for (const field of ["allowedPaths", "forbiddenChanges", "allowedCommands", "allowedDependencies"] as const) {
      if (!Array.isArray(policy[field]) || policy[field].some((item) => typeof item !== "string")) issues.push({ path: `policy.${field}`, message: "must be an array of strings" });
    }
    if (policy.allowGitWrite !== false) issues.push({ path: "policy.allowGitWrite", message: "must be false" });
    if (policy.reviewerReadOnly !== true) issues.push({ path: "policy.reviewerReadOnly", message: "must be true" });
    if (typeof policy.allowNetwork !== "boolean") issues.push({ path: "policy.allowNetwork", message: "must be boolean" });
  }
  if (!value.sourceSnapshots || typeof value.sourceSnapshots !== "object" || Array.isArray(value.sourceSnapshots)) issues.push({ path: "sourceSnapshots", message: "must be a mapping" });
  return issues;
}

export function assertValidTaskContract(contract: unknown): asserts contract is TaskContract {
  const issues = validateTaskContract(contract);
  if (issues.length > 0) throw new InvalidTaskContractError(issues);
}

