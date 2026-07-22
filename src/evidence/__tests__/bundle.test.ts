import { describe, expect, it } from "vitest";
import { EvidenceBundleBuilder, EvidenceEventProjector, TokenBudgetExceededError, TokenBudgetLedger } from "../bundle.js";
import type { LoopEvent } from "../../loop/events.js";

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

describe("EvidenceEventProjector — issue #36 slice 2 omittedContext", () => {
  const baseRunStarted: LoopEvent = {
    type: "run_started",
    runId: 1,
    threadId: "thread-1",
    ts: "2026-01-01T00:00:00.000Z",
    task: "add a function",
    profile: "subscription",
    workflowDefId: "coder-tester-loop",
    rejectThreshold: 2,
  };

  it("populates omittedContext from a run_started event's contextOmitted", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 1 }));
    projector.accept({ ...baseRunStarted, contextOmitted: [{ id: 7, type: "idea", title: "old idea", reason: "token_budget_exceeded" }] });
    expect(projector.snapshot().omittedContext).toEqual([{ id: 7, type: "idea", title: "old idea", reason: "token_budget_exceeded" }]);
  });

  it("defaults omittedContext to [] for a run_started event without contextOmitted (backward compat, no throw)", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 1 }));
    expect(() => projector.accept(baseRunStarted)).not.toThrow();
    expect(projector.snapshot().omittedContext).toEqual([]);
  });

  it("defaults omittedContext to [] before any run_started event has been recorded", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 1 }));
    expect(projector.snapshot().omittedContext).toEqual([]);
  });
});

describe("EvidenceEventProjector — issue #54 usage and no-change evidence", () => {
  it("records provider usage metadata and no-change evidence without inventing a diff", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 9, contractId: "company-a6-readonly-001", requirementIds: ["REQ-READONLY-001"] }));
    projector.accept({
      type: "agent_completed",
      runId: 9,
      threadId: "thread-9",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      stepRef: "draft#1",
      actor: "coder",
      claimCount: 0,
      provider: "litellm-deepseek",
      model: "deepseek-v4-pro",
      usage: { inputTokens: 120, outputTokens: 12, totalTokens: 132, cacheReadTokens: 40, source: "provider" },
      latencyMs: 321,
      outcome: "no_change",
      noChangeReason: "the requested behavior is already present",
      noChangeEvidence: "inspected src/example.ts and found the existing implementation",
    });
    const bundle = projector.snapshot();
    expect(bundle.usage).toMatchObject({ inputTokens: 120, outputTokens: 12, cacheReadTokens: 40, estimated: false, model: "deepseek-v4-pro", models: ["deepseek-v4-pro"] });
    expect(bundle.usageRecords).toEqual([expect.objectContaining({ node: "draft", role: "coder", provider: "litellm-deepseek", model: "deepseek-v4-pro", attempt: 1, latencyMs: 321 })]);
    // Trust fix (PR #57 review): `noChangeEvidence` is the coder model's own
    // unverified prose, never a mechanized check — it must never surface as
    // `passed: true`, and must be tagged `source: "model-reported"` so
    // consumers can tell it apart from real (`"verified"`) evidence.
    expect(bundle.evidence).toEqual([expect.objectContaining({ kind: "artifact", passed: false, source: "model-reported", content: "inspected src/example.ts and found the existing implementation" })]);
  });

  it("never marks model-reported no-change evidence as passed, regardless of how confident the reason/evidence prose reads (trust fix, PR #57 review)", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 11 }));
    projector.accept({
      type: "agent_completed",
      runId: 11,
      threadId: "thread-11",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      claimCount: 0,
      outcome: "no_change",
      noChangeReason: "definitely already implemented, verified and passing",
      noChangeEvidence: "I am certain this is correct",
    });
    const [item] = projector.snapshot().evidence;
    expect(item).toBeDefined();
    expect(item?.passed).toBe(false);
    expect(item?.source).toBe("model-reported");
  });

  it("keeps usage.model unambiguous when coder and tester report usage from different models (trust fix, PR #57 review)", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 10 }));
    projector.accept({
      type: "agent_completed",
      runId: 10,
      threadId: "thread-10",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      stepRef: "draft#1",
      actor: "coder",
      claimCount: 1,
      provider: "litellm-deepseek",
      model: "deepseek-v4-pro",
      usage: { inputTokens: 100, outputTokens: 10, source: "provider" },
    });
    projector.accept({
      type: "agent_completed",
      runId: 10,
      threadId: "thread-10",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      stepRef: "review#1",
      actor: "tester",
      claimCount: 1,
      provider: "litellm-openai",
      model: "gpt-5-high",
      usage: { inputTokens: 50, outputTokens: 5, source: "provider" },
    });
    const bundle = projector.snapshot();
    // The aggregate must not silently collapse to "gpt-5-high" (the last
    // model recorded) — that would misrepresent the coder's tokens as if
    // they'd also come from the tester's model.
    expect(bundle.usage.model).toBeUndefined();
    expect(bundle.usage.models).toEqual(["deepseek-v4-pro", "gpt-5-high"]);
    expect(bundle.usage).toMatchObject({ inputTokens: 150, outputTokens: 15 });
    // usageRecords remains the authoritative per-call detail, unaffected.
    expect(bundle.usageRecords).toEqual([
      expect.objectContaining({ node: "draft", role: "coder", provider: "litellm-deepseek", model: "deepseek-v4-pro" }),
      expect.objectContaining({ node: "review", role: "tester", provider: "litellm-openai", model: "gpt-5-high" }),
    ]);
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
