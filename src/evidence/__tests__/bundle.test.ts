import { describe, expect, it } from "vitest";
import { EvidenceBundleBuilder, TokenBudgetExceededError, TokenBudgetLedger } from "../bundle.js";

describe("EvidenceBundle", () => {
  it("keeps requirement coverage and explicitly reports unproven items", () => {
    const bundle = new EvidenceBundleBuilder({ runId: 1, contractId: "c-1", requirementIds: ["REQ-1", "REQ-2"] })
      .addEvidence({ id: "test-1", kind: "test", title: "unit test", ref: "artifact://test-1", passed: true })
      .addClaim({ id: "claim-1", text: "behavior is covered", status: "supported", requirementIds: ["REQ-1"], evidenceRefs: ["test-1"] })
      .build();
    expect(bundle.requirements).toEqual(expect.arrayContaining([{ requirementId: "REQ-1", status: "verified", evidenceRefs: ["test-1"] }, expect.objectContaining({ requirementId: "REQ-2", status: "unverified" })]));
    expect(bundle.unprovenItems).toEqual(["REQ-2"]);
  });

  it("aggregates usage without hiding estimates", () => {
    const bundle = new EvidenceBundleBuilder().recordUsage({ inputTokens: 3, outputTokens: 2, cacheReadTokens: 1, retryTokens: 0, estimated: true }).recordUsage({ inputTokens: 4, outputTokens: 1, cacheReadTokens: 0, retryTokens: 2, estimated: false }).build();
    expect(bundle.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, retryTokens: 2, estimated: true });
  });
});

describe("TokenBudgetLedger", () => {
  it("stops a run before it exceeds its allocated budget", () => {
    const ledger = new TokenBudgetLedger({ inputTokens: 5, outputTokens: 5, retryTokens: 1 });
    ledger.record({ inputTokens: 5, outputTokens: 1, retryTokens: 0 });
    expect(() => ledger.record({ inputTokens: 1, outputTokens: 0, retryTokens: 0 })).toThrow(TokenBudgetExceededError);
    expect(ledger.snapshot().remainingInputTokens).toBe(0);
  });
});
