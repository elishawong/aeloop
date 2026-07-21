/**
 * Boundary contracts between a product brain (personal or company) and the
 * Aeloop execution engine. A brain may be implemented by a CLI, a service,
 * or a model-backed conversation; Aeloop only receives the resulting,
 * versioned contract and never depends on brain prompts.
 */

export type BrainKind = "personal" | "company";
export type RiskLevel = "low" | "medium" | "high";

export interface Requirement {
  readonly id: string;
  readonly text: string;
  readonly sourceRef?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface ExecutionPolicy {
  readonly allowedPaths: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly allowedCommands: readonly string[];
  readonly allowedDependencies: readonly string[];
  readonly allowNetwork: boolean;
  readonly allowGitWrite: false;
  readonly reviewerReadOnly: true;
}

export interface TaskContract {
  readonly schemaVersion: "1.0";
  readonly contractId: string;
  readonly objective: string;
  readonly requirements: readonly Requirement[];
  readonly riskLevel: RiskLevel;
  readonly policy: ExecutionPolicy;
  readonly sourceSnapshots: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly brain: BrainKind;
}

export interface BrainManifest {
  readonly id: string;
  readonly kind: BrainKind;
  readonly version: string;
  readonly defaultWorkflowId: string;
  readonly contractSchemaVersion: TaskContract["schemaVersion"];
}

