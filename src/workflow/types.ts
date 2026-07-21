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

export interface WorkflowManifest {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputVersion: string;
  readonly outputVersion: string;
  readonly roles: readonly string[];
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
