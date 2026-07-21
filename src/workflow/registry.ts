import type { WorkflowJsonSchema, WorkflowManifest, WorkflowPlugin } from "./types.js";

const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

function assertJsonSchema(value: unknown, path: string): asserts value is WorkflowJsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`workflow manifest ${path} must be an object`);
  }
  const schema = value as Partial<WorkflowJsonSchema>;
  if (typeof schema.type !== "string" || !JSON_SCHEMA_TYPES.has(schema.type)) {
    throw new TypeError(`workflow manifest ${path}.type must be one of: ${[...JSON_SCHEMA_TYPES].join(", ")}`);
  }
  if (schema.properties !== undefined && (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties))) {
    throw new TypeError(`workflow manifest ${path}.properties must be an object when present`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    throw new TypeError(`workflow manifest ${path}.required must be an array of strings when present`);
  }
}

export class DuplicateWorkflowError extends Error {
  readonly code = "DUPLICATE_WORKFLOW" as const;

  constructor(public readonly workflowId: string) {
    super(`workflow already registered: ${workflowId}`);
    this.name = "DuplicateWorkflowError";
  }
}

export class WorkflowNotFoundError extends Error {
  readonly code = "WORKFLOW_NOT_FOUND" as const;

  constructor(public readonly workflowId: string) {
    super(`workflow not found: ${workflowId}`);
    this.name = "WorkflowNotFoundError";
  }
}

function assertManifest(manifest: WorkflowManifest): void {
  for (const field of ["id", "version", "displayName", "description", "inputVersion", "outputVersion"] as const) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      throw new TypeError(`workflow manifest field must be a non-empty string: ${field}`);
    }
  }
  if (!Array.isArray(manifest.roles) || manifest.roles.some((role) => typeof role !== "string" || role.trim() === "")) {
    throw new TypeError("workflow manifest roles must be an array of non-empty strings");
  }
  if (
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.length === 0 ||
    manifest.capabilities.some((capability) => typeof capability !== "string" || capability.trim() === "")
  ) {
    throw new TypeError("workflow manifest capabilities must be a non-empty array of non-empty strings");
  }
  if (manifest.riskClass !== "low" && manifest.riskClass !== "medium" && manifest.riskClass !== "high") {
    throw new TypeError("workflow manifest riskClass must be low, medium, or high");
  }
  assertJsonSchema(manifest.inputSchema, "inputSchema");
  assertJsonSchema(manifest.outputSchema, "outputSchema");
}

/** In-memory registry; persistence and remote plugin loading belong outside the engine. */
export class WorkflowRegistry {
  private readonly plugins = new Map<string, WorkflowPlugin>();

  register<TInput, TResume>(plugin: WorkflowPlugin<TInput, TResume>): void {
    assertManifest(plugin.manifest);
    if (this.plugins.has(plugin.manifest.id)) {
      throw new DuplicateWorkflowError(plugin.manifest.id);
    }
    this.plugins.set(plugin.manifest.id, plugin as WorkflowPlugin);
  }

  get<TInput, TResume>(workflowId: string): WorkflowPlugin<TInput, TResume> {
    const plugin = this.plugins.get(workflowId);
    if (!plugin) throw new WorkflowNotFoundError(workflowId);
    return plugin as WorkflowPlugin<TInput, TResume>;
  }

  list(): readonly WorkflowManifest[] {
    return [...this.plugins.values()].map(({ manifest }) => manifest);
  }
}

