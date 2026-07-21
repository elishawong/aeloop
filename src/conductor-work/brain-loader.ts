import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import type { BrainManifest } from "../conductor/types.js";

export interface LoadedBrain {
  readonly manifest: BrainManifest;
  readonly systemPrompt: string;
  readonly directory: string;
}

function assertManifest(value: unknown): asserts value is BrainManifest {
  if (!value || typeof value !== "object") throw new TypeError("brain manifest must be a YAML mapping");
  const manifest = value as Partial<BrainManifest>;
  if (typeof manifest.id !== "string" || manifest.id.trim() === "") throw new TypeError("brain manifest id is required");
  if (manifest.kind !== "personal" && manifest.kind !== "company") throw new TypeError("brain manifest kind must be personal or company");
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") throw new TypeError("brain manifest version is required");
  if (typeof manifest.defaultWorkflowId !== "string" || manifest.defaultWorkflowId.trim() === "") throw new TypeError("brain manifest default_workflow_id is required");
  if (manifest.contractSchemaVersion !== "1.0") throw new TypeError("brain manifest contract_schema_version must be 1.0");
}

export function loadBrain(directory: string): LoadedBrain {
  const manifestPath = path.join(directory, "manifest.yaml");
  const systemPromptPath = path.join(directory, "system-prompt.md");
  const parsed = loadYaml(readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new TypeError("brain manifest must be a YAML mapping");
  const raw = parsed as Record<string, unknown>;
  const manifest = {
    id: raw["id"],
    kind: raw["kind"],
    version: raw["version"],
    defaultWorkflowId: raw["defaultWorkflowId"] ?? raw["default_workflow_id"],
    contractSchemaVersion: raw["contractSchemaVersion"] ?? raw["contract_schema_version"],
  };
  assertManifest(manifest);
  return { manifest, systemPrompt: readFileSync(systemPromptPath, "utf8"), directory };
}
