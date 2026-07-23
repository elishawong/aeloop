import { describe, expect, it } from "vitest";
import { EvidenceBundleBuilder, EvidenceEventProjector, TokenBudgetExceededError, TokenBudgetLedger } from "../bundle.js";
import type { LoopEvent } from "../../loop/events.js";
import { VERSION_STRING } from "../../shared/version.js";

describe("EvidenceBundle", () => {
  it("issue #98: engineVersion is always populated and matches the single VERSION_STRING every other face reads (CLI --version, wake-greeting)", () => {
    const bundle = new EvidenceBundleBuilder({ runId: 1 }).build();
    expect(bundle.engineVersion).toBe(VERSION_STRING);
    expect(bundle.engineVersion).not.toBe("");
  });

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

describe("EvidenceEventProjector — issue #81 batch1+2 real claim wiring", () => {
  it("projects a changed round's coder+tester claims into claims[]/evidence[], deriving source from the independent tool_exec check, not model self-report", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 20 }));
    projector.accept({
      type: "agent_completed",
      runId: 20,
      threadId: "thread-20",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 2,
      provider: "litellm-deepseek",
      model: "deepseek-v4-pro",
      outcome: "changed",
      toolExecChecked: "pass",
      claims: [
        { claimText: "added a null check", confidence: "verified", sourceRef: "tsc", verifiedBy: "tool_execution" },
        { claimText: "matches requested behavior", confidence: "inferred" },
      ],
    });
    projector.accept({
      type: "agent_completed",
      runId: 20,
      threadId: "thread-20",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      actor: "tester",
      stepRef: "review#1",
      claimCount: 1,
      provider: "litellm-openai",
      model: "gpt-5-high",
      verdict: "pass",
      toolExecChecked: "pass",
      claims: [{ claimText: "ran the tests", confidence: "verified", sourceRef: "test output", verifiedBy: "tool_execution" }],
    });

    const bundle = projector.snapshot();

    // All three claims (2 coder + 1 tester) became evidence, with `source`
    // decided by the independent tool_exec check, never by `confidence`.
    expect(bundle.evidence).toHaveLength(3);
    expect(bundle.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "added a null check", kind: "tool", source: "verified" }),
        expect.objectContaining({ content: "matches requested behavior", kind: "source", source: "model-reported" }),
        expect.objectContaining({ content: "ran the tests", kind: "tool", source: "verified" }),
      ]),
    );

    // Only the coder's 2 claims are judged (tester's own claim is evidence, not a judged claim).
    expect(bundle.claims).toHaveLength(2);
    expect(bundle.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "added a null check", status: "supported" }),
        expect.objectContaining({ text: "matches requested behavior", status: "supported" }),
      ]),
    );
    // Each projected claim's evidenceRefs points at its own coder EvidenceItem — not a shared/guessed one.
    for (const claim of bundle.claims) {
      expect(claim.evidenceRefs).toHaveLength(1);
      const evidenceItem = bundle.evidence.find((e) => e.id === claim.evidenceRefs[0]);
      expect(evidenceItem).toBeDefined();
      expect(evidenceItem?.content).toBe(claim.text);
    }
  });

  it("a reject verdict marks the round's coder claims rejected, not supported", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 21 }));
    projector.accept({
      type: "agent_completed",
      runId: 21,
      threadId: "thread-21",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      claims: [{ claimText: "fixed the bug", confidence: "verified" }],
    });
    projector.accept({
      type: "agent_completed",
      runId: 21,
      threadId: "thread-21",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      actor: "tester",
      stepRef: "review#1",
      claimCount: 1,
      verdict: "reject",
      claims: [{ claimText: "found a regression", confidence: "verified", verifiedBy: "tool_execution" }],
    });
    const bundle = projector.snapshot();
    expect(bundle.claims).toEqual([expect.objectContaining({ text: "fixed the bug", status: "rejected" })]);
  });

  it("fails closed on a round mismatch: a tester event whose stepRef round doesn't match the last coder round projects no claims[] entry", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 22 }));
    projector.accept({
      type: "agent_completed",
      runId: 22,
      threadId: "thread-22",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      claims: [{ claimText: "round 1 claim", confidence: "verified" }],
    });
    // A stray review event stamped round 2, with no matching draft#2 ever seen by this builder.
    projector.accept({
      type: "agent_completed",
      runId: 22,
      threadId: "thread-22",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      actor: "tester",
      stepRef: "review#2",
      claimCount: 1,
      verdict: "pass",
      claims: [{ claimText: "tester claim", confidence: "verified" }],
    });
    const bundle = projector.snapshot();
    expect(bundle.claims).toEqual([]);
    // Both sides' claims are still independently recorded as evidence — only the addClaim() pairing is skipped.
    expect(bundle.evidence.some((e) => e.content === "round 1 claim")).toBe(true);
    expect(bundle.evidence.some((e) => e.content === "tester claim")).toBe(true);
  });
});

describe("EvidenceEventProjector — issue #81 red line: EvidenceItem.source is independent of tester verdict and model self-confidence", () => {
  it("a claim with verifiedBy:tool_execution but no independent tool_exec confirmation stays model-reported even when the tester passes it", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 30 }));
    projector.accept({
      type: "agent_completed",
      runId: 30,
      threadId: "thread-30",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      // toolExecChecked deliberately absent — mirrors a FakeAdapter/non-CLI
      // adapter (this codebase's own test doubles) that never sets it, even
      // though the claim itself self-reports verifiedBy: "tool_execution".
      claims: [{ claimText: "ran the tests", confidence: "verified", verifiedBy: "tool_execution" }],
    });
    projector.accept({
      type: "agent_completed",
      runId: 30,
      threadId: "thread-30",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      actor: "tester",
      stepRef: "review#1",
      claimCount: 0,
      verdict: "pass",
      claims: [],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "ran the tests");
    expect(item).toBeDefined();
    expect(item?.source).toBe("model-reported");
    // ClaimStatus ("supported", the tester's verdict) and EvidenceItem.source
    // ("model-reported", no independent check) are orthogonal — the former
    // being true must never leak into/upgrade the latter.
    const claim = bundle.claims.find((c) => c.text === "ran the tests");
    expect(claim?.status).toBe("supported");
  });

  it("toolExecChecked: 'fail' also stays model-reported, not verified, even though the claim self-reports verifiedBy: tool_execution", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 31 }));
    projector.accept({
      type: "agent_completed",
      runId: 31,
      threadId: "thread-31",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      toolExecChecked: "fail",
      claims: [{ claimText: "ran a tool that actually failed", confidence: "verified", verifiedBy: "tool_execution" }],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "ran a tool that actually failed");
    expect(item?.source).toBe("model-reported");
  });

  it("a claim with confidence:'verified' but verifiedBy:'unverified' never becomes EvidenceItem.source:'verified'", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 32 }));
    projector.accept({
      type: "agent_completed",
      runId: 32,
      threadId: "thread-32",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      toolExecChecked: "pass", // even with an independent pass on the round, verifiedBy itself is what gates it.
      claims: [{ claimText: "very confident but never actually checked", confidence: "verified", verifiedBy: "unverified" }],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "very confident but never actually checked");
    expect(item?.source).toBe("model-reported");
  });

  it("toolExecChecked: 'na' also stays model-reported, not verified, even though the claim self-reports verifiedBy: tool_execution", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 33 }));
    projector.accept({
      type: "agent_completed",
      runId: 33,
      threadId: "thread-33",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      toolExecChecked: "na",
      claims: [{ claimText: "tool exec was not applicable this round", confidence: "verified", verifiedBy: "tool_execution" }],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "tool exec was not applicable this round");
    expect(item?.source).toBe("model-reported");
  });

  it("a claim with verifiedBy:'human' never becomes EvidenceItem.source:'verified', even with an independent toolExecChecked:'pass' on the round", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 34 }));
    projector.accept({
      type: "agent_completed",
      runId: 34,
      threadId: "thread-34",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      toolExecChecked: "pass", // a mechanized check happened this round, but not the kind this claim itself claims backs it.
      claims: [{ claimText: "a human reviewed this manually", confidence: "verified", verifiedBy: "human" }],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "a human reviewed this manually");
    expect(item?.source).toBe("model-reported");
    expect(item?.kind).toBe("human");
  });

  it("a claim with verifiedBy entirely absent never becomes EvidenceItem.source:'verified', even with an independent toolExecChecked:'pass' on the round", () => {
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder({ runId: 35 }));
    projector.accept({
      type: "agent_completed",
      runId: 35,
      threadId: "thread-35",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      toolExecChecked: "pass",
      claims: [{ claimText: "no verification method given at all", confidence: "verified" }],
    });
    const bundle = projector.snapshot();
    const item = bundle.evidence.find((e) => e.content === "no verification method given at all");
    expect(item?.source).toBe("model-reported");
    expect(item?.kind).toBe("source");
  });
});

describe("EvidenceEventProjector — issue #81 batch2 hardening: round-pairing also requires a matching runId (Zorro review)", () => {
  it("does not fold a tester verdict onto a same-numbered round that belongs to a different runId", () => {
    // One builder fed two different runs' event streams (not how the real
    // ConductorWorkApp.projectEvents() call site uses it today, but
    // EvidenceBundleBuilder/recordEvent() are public surface with no
    // single-run contract enforced on the caller) — round #1 must not be
    // paired across runId 40 and runId 41 just because the round numbers
    // happen to coincide.
    const projector = new EvidenceEventProjector(new EvidenceBundleBuilder());
    projector.accept({
      type: "agent_completed",
      runId: 40,
      threadId: "thread-40",
      ts: "2026-01-01T00:00:00.000Z",
      node: "draft",
      actor: "coder",
      stepRef: "draft#1",
      claimCount: 1,
      outcome: "changed",
      claims: [{ claimText: "run 40's claim", confidence: "verified" }],
    });
    projector.accept({
      type: "agent_completed",
      runId: 41,
      threadId: "thread-41",
      ts: "2026-01-01T00:00:01.000Z",
      node: "review",
      actor: "tester",
      stepRef: "review#1",
      claimCount: 1,
      verdict: "pass",
      claims: [{ claimText: "run 41's tester claim", confidence: "verified" }],
    });
    const bundle = projector.snapshot();
    // No addClaim() projection happened at all — the round numbers matched but the runIds didn't.
    expect(bundle.claims).toEqual([]);
    // Both sides' claims are still recorded as independent evidence.
    expect(bundle.evidence.some((e) => e.content === "run 40's claim")).toBe(true);
    expect(bundle.evidence.some((e) => e.content === "run 41's tester claim")).toBe(true);
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
