import type { ExecutionPolicy } from "./types.js";

export interface PolicyObservation {
  readonly changedPaths?: readonly string[];
  readonly commands?: readonly string[];
  readonly dependenciesAdded?: readonly string[];
  readonly networkUsed?: boolean;
  readonly gitWriteAttempted?: boolean;
  readonly reviewerWroteFiles?: boolean;
}

export interface PolicyViolation {
  readonly code:
    | "PATH_NOT_ALLOWED"
    | "COMMAND_NOT_ALLOWED"
    | "DEPENDENCY_NOT_ALLOWED"
    | "NETWORK_NOT_ALLOWED"
    | "GIT_WRITE_FORBIDDEN"
    | "REVIEWER_WRITE_FORBIDDEN";
  readonly value: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function matchesPath(pattern: string, path: string): boolean {
  const parts = pattern.split("**");
  const source = parts.map((part) => escapeRegex(part).replace(/\*/g, "[^/]*")).join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/** Pure, fail-closed evaluation of observed execution facts against a contract policy. */
export function evaluateExecutionPolicy(policy: ExecutionPolicy, observation: PolicyObservation): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  for (const changedPath of observation.changedPaths ?? []) {
    if (!policy.allowedPaths.some((pattern) => matchesPath(pattern, changedPath))) {
      violations.push({ code: "PATH_NOT_ALLOWED", value: changedPath });
    }
  }
  for (const command of observation.commands ?? []) {
    if (!policy.allowedCommands.includes(command)) violations.push({ code: "COMMAND_NOT_ALLOWED", value: command });
  }
  for (const dependency of observation.dependenciesAdded ?? []) {
    if (!policy.allowedDependencies.includes(dependency)) violations.push({ code: "DEPENDENCY_NOT_ALLOWED", value: dependency });
  }
  if (observation.networkUsed === true && !policy.allowNetwork) violations.push({ code: "NETWORK_NOT_ALLOWED", value: "network" });
  if (observation.gitWriteAttempted === true || policy.allowGitWrite !== false) violations.push({ code: "GIT_WRITE_FORBIDDEN", value: "git-write" });
  if (observation.reviewerWroteFiles === true || policy.reviewerReadOnly !== true) violations.push({ code: "REVIEWER_WRITE_FORBIDDEN", value: "reviewer-write" });
  return violations;
}
