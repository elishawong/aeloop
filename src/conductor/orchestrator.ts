import { assertValidTaskContract } from "./contract.js";
import type { BrainManifest, TaskContract } from "./types.js";
import { WorkflowRegistry } from "../workflow/registry.js";
import type { RunHandle } from "../loop/runner.js";
import type { WorkflowDependencies, WorkflowManifest } from "../workflow/types.js";
import { DEFAULT_TOKEN_BUDGET, normalizeTokenBudget, type RunPlan, type RunRequest } from "./run.js";

export interface OrchestrationRequest {
  readonly brain: BrainManifest;
  readonly contract: unknown;
  readonly workflowId?: string;
}
export interface OrchestrationPlan {
  readonly brain: BrainManifest;
  readonly contract: TaskContract;
  readonly workflow: WorkflowManifest;
}

export class BrainWorkflowMismatchError extends Error {
  readonly code = "BRAIN_WORKFLOW_MISMATCH" as const;

  constructor(brainKind: BrainManifest["kind"], contractBrain: TaskContract["brain"]) {
    super(`brain kind ${brainKind} does not match contract brain ${contractBrain}`);
    this.name = "BrainWorkflowMismatchError";
  }
}

/**
 * The deterministic coordinator between a brain and Aeloop. It selects a
 * registered workflow and validates the contract, but it does not interpret
 * conversation text or make human decisions. The actual workflow runtime
 * remains in `src/workflow`/`src/loop`.
 */
export class Orchestrator {
  constructor(private readonly workflows: WorkflowRegistry) {}

  plan(request: OrchestrationRequest): OrchestrationPlan {
    assertValidTaskContract(request.contract);
    if (request.brain.kind !== request.contract.brain) {
      throw new BrainWorkflowMismatchError(request.brain.kind, request.contract.brain);
    }
    const workflow = this.workflows.get(request.workflowId ?? request.brain.defaultWorkflowId);
    return { brain: request.brain, contract: request.contract, workflow: workflow.manifest };
  }

  /** Create the versioned, auditable plan consumed by a runtime adapter. */
  planRun(request: RunRequest): RunPlan {
    const plan = this.plan(request);
    return {
      planVersion: "1",
      brain: plan.brain,
      contract: plan.contract,
      workflow: {
        id: plan.workflow.id,
        version: plan.workflow.version,
        capabilities: plan.workflow.capabilities ?? [],
      },
      policy: plan.contract.policy,
      budget: normalizeTokenBudget(request.budget ?? DEFAULT_TOKEN_BUDGET),
    };
  }

  /** Validate the brain contract, validate workflow input, then start the selected workflow. */
  start<TInput, TResume>(
    request: OrchestrationRequest,
    input: TInput,
    deps: WorkflowDependencies,
  ): Promise<RunHandle> {
    const plan = this.plan(request);
    const workflow = this.workflows.get<TInput, TResume>(plan.workflow.id);
    return workflow.start(workflow.validateInput(input), deps);
  }
}
