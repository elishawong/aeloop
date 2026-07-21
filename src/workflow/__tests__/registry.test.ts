import { describe, expect, it } from "vitest";
import { coderTesterWorkflow } from "../coder-tester.js";
import { DuplicateWorkflowError, WorkflowNotFoundError, WorkflowRegistry } from "../registry.js";

describe("WorkflowRegistry", () => {
  it("registers and lists a built-in workflow manifest", () => {
    const registry = new WorkflowRegistry();
    registry.register(coderTesterWorkflow);
    expect(registry.list()).toEqual([coderTesterWorkflow.manifest]);
    expect(registry.get("coder-tester-loop")).toBe(coderTesterWorkflow);
  });

  it("rejects duplicate and unknown workflow ids", () => {
    const registry = new WorkflowRegistry();
    registry.register(coderTesterWorkflow);
    expect(() => registry.register(coderTesterWorkflow)).toThrow(DuplicateWorkflowError);
    expect(() => registry.get("research-synthesis")).toThrow(WorkflowNotFoundError);
  });

  it("validates coder/tester input before invoking the runtime", () => {
    expect(() => coderTesterWorkflow.validateInput({})).toThrow(/task is required/);
  });
});

