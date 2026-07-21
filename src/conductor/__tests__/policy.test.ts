import { describe, expect, it } from "vitest";
import { evaluateExecutionPolicy } from "../policy.js";
import type { ExecutionPolicy } from "../types.js";

const policy: ExecutionPolicy = {
  allowedPaths: ["src/**", "tests/*.ts"],
  forbiddenChanges: [],
  allowedCommands: ["pnpm test"],
  allowedDependencies: ["zod"],
  allowNetwork: false,
  allowGitWrite: false,
  reviewerReadOnly: true,
};

describe("evaluateExecutionPolicy", () => {
  it("accepts allowed paths and exact allowed commands", () => {
    expect(evaluateExecutionPolicy(policy, {
      changedPaths: ["src/loop/runner.ts", "tests/a.ts"],
      commands: ["pnpm test"],
      dependenciesAdded: ["zod"],
    })).toEqual([]);
  });

  it("reports every observed violation instead of silently downgrading it", () => {
    const violations = evaluateExecutionPolicy(policy, {
      changedPaths: ["README.md"],
      commands: ["pnpm install"],
      dependenciesAdded: ["unknown-package"],
      networkUsed: true,
      gitWriteAttempted: true,
      reviewerWroteFiles: true,
    });
    expect(violations.map((violation) => violation.code)).toEqual([
      "PATH_NOT_ALLOWED",
      "COMMAND_NOT_ALLOWED",
      "DEPENDENCY_NOT_ALLOWED",
      "NETWORK_NOT_ALLOWED",
      "GIT_WRITE_FORBIDDEN",
      "REVIEWER_WRITE_FORBIDDEN",
    ]);
  });
});
