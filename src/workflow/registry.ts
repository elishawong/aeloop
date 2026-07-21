import type { WorkflowManifest, WorkflowPlugin } from "./types.js";

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

