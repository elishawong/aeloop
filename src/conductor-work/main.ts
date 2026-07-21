import path from "node:path";
import { fileURLToPath } from "node:url";
import { coderTesterWorkflow } from "../workflow/coder-tester.js";
import { WorkflowRegistry } from "../workflow/registry.js";
import { ConductorWorkApp, companyBrainDirectory } from "./app.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function run(argv: readonly string[], output: (line: string) => void = console.log): number {
  const positionals = argv.filter((arg) => arg !== "--json");
  const jsonOutput = argv.includes("--json");
  const [command, contractPath] = positionals;
  if (command !== "plan" || !contractPath) {
    output("Usage: conductor-work plan <contract.json> [--json]");
    return 2;
  }
  try {
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: companyBrainDirectory(REPO_ROOT), workflows });
    if (jsonOutput) {
      const runPlan = app.planRun(path.resolve(contractPath));
      output(JSON.stringify(runPlan));
      return 0;
    }
    const plan = app.plan(path.resolve(contractPath));
    output(`brain: ${plan.brain.id}@${plan.brain.version}`);
    output(`contract: ${plan.contract.contractId}`);
    output(`workflow: ${plan.workflow.id}@${plan.workflow.version}`);
    output(`requirements: ${plan.contract.requirements.length}`);
    output("policy: git writes disabled; reviewer read-only");
    return 0;
  } catch (error) {
    output(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
