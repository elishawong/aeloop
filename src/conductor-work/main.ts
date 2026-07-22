import path from "node:path";
import { fileURLToPath } from "node:url";
import { coderTesterWorkflow } from "../workflow/coder-tester.js";
import { WorkflowRegistry } from "../workflow/registry.js";
import { ConductorWorkApp, companyBrainDirectory } from "./app.js";
import { assembleProfileDeps, resolveSchemaMaxAttempts } from "../cli/assemble.js";
import fs from "node:fs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function run(argv: readonly string[], output: (line: string) => void = console.log): number | Promise<number> {
  const positionals = argv.filter((arg) => arg !== "--json");
  const jsonOutput = argv.includes("--json");
  const [command, contractPath] = positionals;
  const profileIndex = argv.indexOf("--profile");
  const profile = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  const eventsIndex = argv.indexOf("--events");
  const eventsPath = eventsIndex >= 0 ? argv[eventsIndex + 1] : undefined;
  if ((command !== "plan" && command !== "run") || !contractPath || (command === "run" && !profile)) {
    output("Usage: conductor-work plan <contract.json> [--json]");
    output("       conductor-work run <contract.json> --profile <profile> [--json] [--events <path>]");
    return 2;
  }
  try {
    const workflows = new WorkflowRegistry();
    workflows.register(coderTesterWorkflow);
    const app = new ConductorWorkApp({ brainDirectory: companyBrainDirectory(REPO_ROOT), workflows });
    if (command === "run") {
      return (async () => {
        const deps = assembleProfileDeps(profile!, process.env);
        try {
          const result = await app.runCandidate(path.resolve(contractPath), profile!, deps, {
            rejectThreshold: deps.profileConfig.workflow?.reject_threshold,
            schemaMaxAttempts: resolveSchemaMaxAttempts(deps.profileConfig),
          });
          if (eventsPath) fs.writeFileSync(path.resolve(eventsPath), result.events.map((event) => JSON.stringify(event)).join("\n") + (result.events.length ? "\n" : ""), { encoding: "utf8", flag: "w" });
          output(JSON.stringify({ plan: result.plan, run: result.handle, evidence: result.evidence, policy: "candidate-only; git writes disabled" }));
          return 0;
        } finally {
          deps.audit.close();
          deps.memoryStore.close();
          (deps.checkpointer as unknown as { db: { close(): void } }).db.close();
        }
      })().catch((error: unknown) => {
        output(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      });
    }
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
