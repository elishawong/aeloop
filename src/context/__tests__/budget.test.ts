import { describe, expect, it } from "vitest";
import { ContextBudgetExceededError, ContextBudgetManager } from "../budget.js";

describe("ContextBudgetManager", () => {
  it("keeps protected contract/policy context and drops lower priority items", () => {
    const result = new ContextBudgetManager(9).select([
      { id: "memory", text: "123456789012", priority: "memory", relevance: 1, tokenCount: 3 },
      { id: "contract", text: "contract", priority: "contract", relevance: 0, tokenCount: 4, protected: true },
      { id: "policy", text: "policy", priority: "policy", relevance: 0, tokenCount: 3, protected: true },
    ]);
    expect(result.items.map((item) => item.id)).toEqual(["contract", "policy"]);
    expect(result.omittedIds).toEqual(["memory"]);
  });

  it("fails closed rather than dropping protected context", () => {
    expect(() => new ContextBudgetManager(2).select([{ id: "contract", text: "contract", priority: "contract", relevance: 1, tokenCount: 3, protected: true }])).toThrow(ContextBudgetExceededError);
  });
});
