import path from "node:path";
import { Orchestrator, type OrchestrationPlan } from "../conductor/orchestrator.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { loadBrain, type LoadedBrain } from "./brain-loader.js";
import { loadTaskContract } from "./contract-loader.js";
import type { LoopEvent } from "../loop/events.js";
import { LoopEventEmitter } from "../loop/events.js";
import type { StartRunDeps, RunHandle } from "../loop/runner.js";
import { startRun } from "../loop/runner.js";
import type { ContextInjectionResult } from "../context/injector.js";
import { EvidenceBundleBuilder, EvidenceEventProjector, type EvidenceBundle } from "../evidence/bundle.js";
import type { RunPlan, TokenBudget } from "../conductor/run.js";

export interface ConductorWorkConfig {
  readonly brainDirectory: string;
  readonly workflows: WorkflowRegistry;
}

export interface CompanyRunResult {
  readonly plan: RunPlan;
  readonly handle: RunHandle;
  readonly events: readonly LoopEvent[];
  readonly evidence: EvidenceBundle;
}

export class ConductorWorkApp {
  private readonly brain: LoadedBrain;
  private readonly orchestrator: Orchestrator;

  constructor(private readonly config: ConductorWorkConfig) {
    this.brain = loadBrain(config.brainDirectory);
    this.orchestrator = new Orchestrator(config.workflows);
  }

  plan(contractPath: string, workflowId?: string): OrchestrationPlan {
    const contract = loadTaskContract(contractPath);
    return this.orchestrator.plan({ brain: this.brain.manifest, contract, workflowId });
  }

  /** Produce the versioned, auditable RunPlan (budget + capabilities + policy) for a runtime adapter. */
  planRun(contractPath: string, workflowId?: string, budget?: Partial<TokenBudget>): RunPlan {
    const contract = loadTaskContract(contractPath);
    return this.orchestrator.planRun({ brain: this.brain.manifest, contract, workflowId, budget });
  }

  getBrain(): LoadedBrain {
    return this.brain;
  }

  /** Project read-only engine events into a company-safe EvidenceBundle. */
  projectEvents(events: Iterable<LoopEvent>, contractPath?: string): EvidenceBundle {
    const contract = contractPath ? loadTaskContract(contractPath) : undefined;
    const builder = new EvidenceBundleBuilder({
      contractId: contract?.contractId,
      requirementIds: contract?.requirements.map((requirement) => requirement.id),
    });
    const projector = new EvidenceEventProjector(builder);
    for (const event of events) projector.accept(event);
    return projector.snapshot();
  }

  /** Start one candidate-only company run. Human gates are returned, never auto-approved. */
  async runCandidate(
    contractPath: string,
    profile: string,
    deps: StartRunDeps,
    options: { readonly injectedContext?: ContextInjectionResult; readonly rejectThreshold?: number; readonly schemaMaxAttempts?: number } = {},
  ): Promise<CompanyRunResult> {
    const plan = this.planRun(contractPath);
    const capturedEvents: LoopEvent[] = [];
    const emitter = new LoopEventEmitter();
    emitter.on((event) => {
      capturedEvents.push(event);
    });
    const handle = await startRun(
      { ...deps, events: emitter, schemaMaxAttempts: options.schemaMaxAttempts },
      {
        task: plan.contract.objective,
        profile,
        workflowDefId: plan.workflow.id,
        injectedContext: options.injectedContext ?? { memories: [] },
        rejectThreshold: options.rejectThreshold ?? 2,
      },
    );
    return { plan, handle, events: capturedEvents, evidence: this.projectEvents(capturedEvents, contractPath) };
  }
}

export function companyBrainDirectory(repoRoot: string): string {
  return path.join(repoRoot, "brains", "company");
}
