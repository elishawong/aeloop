import { describe, expect, it } from "vitest";
import { coderTesterWorkflow, CODER_TESTER_MANIFEST } from "../coder-tester.js";
import { DuplicateWorkflowError, WorkflowNotFoundError, WorkflowRegistry } from "../registry.js";
import type { WorkflowManifest, WorkflowPlugin } from "../types.js";

function makePlugin(manifest: WorkflowManifest): WorkflowPlugin {
  return {
    manifest,
    validateInput: (input) => input,
    start: async () => {
      throw new Error("not implemented");
    },
    resume: async () => {
      throw new Error("not implemented");
    },
  };
}

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

  it("accepts a fully-specified manifest with capabilities/riskClass/schemas", () => {
    const registry = new WorkflowRegistry();
    expect(() => registry.register(makePlugin(CODER_TESTER_MANIFEST))).not.toThrow();
  });

  it("rejects a manifest missing capabilities", () => {
    const registry = new WorkflowRegistry();
    const { capabilities: _capabilities, ...rest } = CODER_TESTER_MANIFEST;
    const manifest = rest as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/capabilities/);
  });

  it("rejects a manifest with an empty capabilities array", () => {
    const registry = new WorkflowRegistry();
    const manifest = { ...CODER_TESTER_MANIFEST, capabilities: [] };
    expect(() => registry.register(makePlugin(manifest))).toThrow(/capabilities/);
  });

  it("rejects a manifest missing riskClass", () => {
    const registry = new WorkflowRegistry();
    const { riskClass: _riskClass, ...rest } = CODER_TESTER_MANIFEST;
    const manifest = rest as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/riskClass/);
  });

  it("rejects a manifest with an invalid riskClass value", () => {
    const registry = new WorkflowRegistry();
    const manifest = { ...CODER_TESTER_MANIFEST, riskClass: "critical" } as unknown as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/riskClass/);
  });

  it("rejects a manifest missing inputSchema", () => {
    const registry = new WorkflowRegistry();
    const { inputSchema: _inputSchema, ...rest } = CODER_TESTER_MANIFEST;
    const manifest = rest as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/inputSchema/);
  });

  it("rejects a manifest whose inputSchema.type is not a recognized JSON Schema type", () => {
    const registry = new WorkflowRegistry();
    const manifest = {
      ...CODER_TESTER_MANIFEST,
      inputSchema: { type: "banana" },
    } as unknown as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/inputSchema\.type/);
  });

  it("rejects a manifest missing outputSchema", () => {
    const registry = new WorkflowRegistry();
    const { outputSchema: _outputSchema, ...rest } = CODER_TESTER_MANIFEST;
    const manifest = rest as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/outputSchema/);
  });

  it("rejects a manifest whose outputSchema is not an object", () => {
    const registry = new WorkflowRegistry();
    const manifest = { ...CODER_TESTER_MANIFEST, outputSchema: "not-a-schema" } as unknown as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/outputSchema/);
  });

  it("rejects a manifest whose inputSchema.required contains non-string entries", () => {
    const registry = new WorkflowRegistry();
    const manifest = {
      ...CODER_TESTER_MANIFEST,
      inputSchema: { type: "object", required: ["task", 42] },
    } as unknown as WorkflowManifest;
    expect(() => registry.register(makePlugin(manifest))).toThrow(/inputSchema\.required/);
  });
});

