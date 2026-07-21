/**
 * Public contracts for pluggable workflows.
 *
 * A workflow owns business steps and routing. Aeloop owns the runtime
 * services (prompt, context, harness, checkpoints, audit, and events).
 * Keeping this contract independent from a concrete graph leaves room for
 * coding, research, PRD, and design-compliance workflows without turning the
 * runner into a coder/tester-specific switch statement.
 */

import type { StartRunDeps, RunHandle, StartRunInput } from "../loop/runner.js";
import type { TaskContract } from "../conductor/types.js";

/** Coarse-grained risk classification used for governance/routing decisions. */
export type WorkflowRiskClass = "low" | "medium" | "high";

/**
 * Minimal JSON-Schema-shaped description of a workflow's input or output
 * contract. This intentionally does not pull in a full JSON Schema type
 * (or a schema library) as a hard dependency of the workflow contract; it
 * captures just enough structure for the registry to validate that a
 * manifest declares a real, checkable shape rather than an empty stub.
 */
export interface WorkflowJsonSchema {
  readonly type: "object" | "array" | "string" | "number" | "boolean" | "null";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

export interface WorkflowManifest {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputVersion: string;
  readonly outputVersion: string;
  readonly roles: readonly string[];
  /** Non-empty list of capability tags this workflow declares (e.g. "code-generation"). */
  readonly capabilities: readonly string[];
  /** Governance risk classification; drives approval/routing policy upstream. */
  readonly riskClass: WorkflowRiskClass;
  /** JSON-Schema-shaped description of the shape accepted by `validateInput`. */
  readonly inputSchema: WorkflowJsonSchema;
  /** JSON-Schema-shaped description of the shape produced by a completed run. */
  readonly outputSchema: WorkflowJsonSchema;
}

export interface WorkflowRunContext {
  readonly workflowId: string;
  readonly runId: number;
  readonly threadId: string;
}

export interface WorkflowDependencies {
  readonly loop: StartRunDeps;
}

export interface WorkflowPlugin<TInput = unknown, TResume = unknown> {
  readonly manifest: WorkflowManifest;
  validateInput(input: unknown): TInput;
  start(input: TInput, deps: WorkflowDependencies): Promise<RunHandle>;
  resume(
    context: WorkflowRunContext,
    resumeValue: TResume,
    decidedBy: string,
    stepCounters: Record<string, number>,
    deps: WorkflowDependencies,
  ): Promise<RunHandle>;
}

/** The input shape of the built-in coder/tester workflow. */
export type CoderTesterWorkflowInput = StartRunInput & {
  /** Optional for backward compatibility; supplied by a Brain for governed runs. */
  readonly contract?: TaskContract;
};
