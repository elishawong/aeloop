import { describe, expect, it } from "vitest";
import { InvalidGateCommandError, normalizeTokenBudget, parseGateCommand } from "../run.js";

describe("Conductor run protocol", () => {
  it("normalizes a bounded token budget", () => {
    expect(normalizeTokenBudget({ inputTokens: 100 })).toEqual({ inputTokens: 100, outputTokens: 8_000, retryTokens: 4_000 });
  });

  it("rejects negative or non-finite budgets", () => {
    expect(() => normalizeTokenBudget({ retryTokens: -1 })).toThrow("budget.retryTokens");
    expect(() => normalizeTokenBudget({ costLimitUsd: Number.NaN })).toThrow("budget.costLimitUsd");
  });

  it("accepts only explicit external resume commands", () => {
    expect(parseGateCommand({ type: "resume", runId: 7, threadId: "t-7", decision: "approved", decidedBy: "reviewer" })).toEqual({
      type: "resume", runId: 7, threadId: "t-7", decision: "approved", decidedBy: "reviewer", reasoningText: undefined,
    });
  });

  it("fails closed for model-shaped or unknown commands", () => {
    expect(() => parseGateCommand({ type: "model_output", decision: "approved" })).toThrow(InvalidGateCommandError);
    expect(() => parseGateCommand({ type: "resume", runId: 7, threadId: "t-7", decision: "approve", decidedBy: "reviewer" })).toThrow(InvalidGateCommandError);
  });
});
