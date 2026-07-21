import path from "node:path";
import { Orchestrator, type OrchestrationPlan } from "../conductor/orchestrator.js";
import type { WorkflowRegistry } from "../workflow/registry.js";
import { loadBrain, type LoadedBrain } from "./brain-loader.js";
import { loadTaskContract } from "./contract-loader.js";

export interface ConductorWorkConfig {
  readonly brainDirectory: string;
  readonly workflows: WorkflowRegistry;
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

  getBrain(): LoadedBrain {
    return this.brain;
  }
}

export function companyBrainDirectory(repoRoot: string): string {
  return path.join(repoRoot, "brains", "company");
}
