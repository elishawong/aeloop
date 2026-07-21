import type { GateDecision, EscalationDecision } from "../loop/types.js";
import type { BrainManifest, ExecutionPolicy, TaskContract } from "./types.js";

export interface TokenBudget {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly retryTokens: number;
  readonly costLimitUsd?: number;
}

export interface RunRequest {
  readonly brain: BrainManifest;
  readonly contract: unknown;
  readonly workflowId?: string;
  readonly budget?: Partial<TokenBudget>;
}

export interface RunPlan {
  readonly planVersion: "1";
  readonly brain: BrainManifest;
  readonly contract: TaskContract;
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly capabilities: readonly string[];
  };
  readonly policy: ExecutionPolicy;
  readonly budget: TokenBudget;
}

export const DEFAULT_TOKEN_BUDGET: TokenBudget = {
  inputTokens: 24_000,
  outputTokens: 8_000,
  retryTokens: 4_000,
};

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidRunRequestError([{ path, message: "must be a non-negative safe integer" }]);
  }
}

export function normalizeTokenBudget(input?: Partial<TokenBudget>): TokenBudget {
  const value = { ...DEFAULT_TOKEN_BUDGET, ...(input ?? {}) };
  assertNonNegativeInteger(value.inputTokens, "budget.inputTokens");
  assertNonNegativeInteger(value.outputTokens, "budget.outputTokens");
  assertNonNegativeInteger(value.retryTokens, "budget.retryTokens");
  if (value.costLimitUsd !== undefined && (typeof value.costLimitUsd !== "number" || !Number.isFinite(value.costLimitUsd) || value.costLimitUsd < 0)) {
    throw new InvalidRunRequestError([{ path: "budget.costLimitUsd", message: "must be a non-negative finite number" }]);
  }
  return value;
}

export interface RunRequestIssue {
  readonly path: string;
  readonly message: string;
}

export class InvalidRunRequestError extends Error {
  readonly code = "INVALID_RUN_REQUEST" as const;

  constructor(public readonly issues: readonly RunRequestIssue[]) {
    super(`invalid run request: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "InvalidRunRequestError";
  }
}

export type GateCommand =
  | { readonly type: "start"; readonly request: RunRequest }
  | { readonly type: "resume"; readonly runId: number; readonly threadId: string; readonly decision: GateDecision | EscalationDecision; readonly decidedBy: string; readonly reasoningText?: string }
  | { readonly type: "stop"; readonly runId: number; readonly threadId: string; readonly decidedBy: string; readonly reasoningText?: string };

export class InvalidGateCommandError extends Error {
  readonly code = "INVALID_GATE_COMMAND" as const;

  constructor(public readonly issues: readonly RunRequestIssue[]) {
    super(`invalid gate command: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "InvalidGateCommandError";
  }
}

const GATE_DECISIONS = new Set<string>(["approved", "rejected", "escalate", "revise", "force_pass", "abandon"]);

function requiredString(value: unknown, path: string, issues: RunRequestIssue[]): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path, message: "must be a non-empty string" });
    return false;
  }
  return true;
}

/** Parse only external control commands; model-shaped output is never accepted here. */
export function parseGateCommand(input: unknown): GateCommand {
  const issues: RunRequestIssue[] = [];
  if (!input || typeof input !== "object") throw new InvalidGateCommandError([{ path: "$", message: "must be an object" }]);
  const value = input as Record<string, unknown>;
  if (!requiredString(value.type, "type", issues)) throw new InvalidGateCommandError(issues);
  if (value.type === "start") {
    if (!value.request || typeof value.request !== "object") issues.push({ path: "request", message: "must be an object" });
    if (issues.length > 0) throw new InvalidGateCommandError(issues);
    return { type: "start", request: value.request as RunRequest };
  }
  if (value.type !== "resume" && value.type !== "stop") {
    throw new InvalidGateCommandError([{ path: "type", message: "must be start, resume, or stop" }]);
  }
  if (typeof value.runId !== "number" || !Number.isSafeInteger(value.runId) || value.runId < 1) issues.push({ path: "runId", message: "must be a positive safe integer" });
  requiredString(value.threadId, "threadId", issues);
  requiredString(value.decidedBy, "decidedBy", issues);
  if (value.reasoningText !== undefined && typeof value.reasoningText !== "string") issues.push({ path: "reasoningText", message: "must be a string when provided" });
  if (value.type === "resume" && (typeof value.decision !== "string" || !GATE_DECISIONS.has(value.decision))) issues.push({ path: "decision", message: "must be an allowed gate decision" });
  if (issues.length > 0) throw new InvalidGateCommandError(issues);
  if (value.type === "stop") return { type: "stop", runId: value.runId as number, threadId: value.threadId as string, decidedBy: value.decidedBy as string, reasoningText: value.reasoningText as string | undefined };
  return { type: "resume", runId: value.runId as number, threadId: value.threadId as string, decision: value.decision as GateDecision | EscalationDecision, decidedBy: value.decidedBy as string, reasoningText: value.reasoningText as string | undefined };
}
