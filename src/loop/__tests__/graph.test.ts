/**
 * `graph.ts` structural tests (PRD §5 "graph.test.ts") — the PRD's
 * declared technical risk core: `addConditionalEdges` is the one
 * LangGraph mechanism none of spike-findings.md's 5 Qs exercised (all toy
 * graphs there were linear or used a single unconditional `interrupt()`).
 * This file's first job (§6 B3: "the first thing to verify is
 * addConditionalEdges") is
 * clearing that risk before trusting `graph.ts`'s real wiring.
 *
 * **Review Round-1 B1 rework**: this file used to build a *local replica* of
 * `graph.ts`'s edge topology (`buildToyGraph()`, same real `gates.ts`
 * nodes/routers, but never calling `buildLoopGraph()` itself) because toy
 * `draft`/`review` nodes couldn't be substituted into the real
 * `createDraftNode`/`createReviewNode` factories, which require a real
 * `ProviderRouter`/`PromptComposer`. That replica proved the *replica's*
 * topology was right, not `graph.ts`'s own pathMaps — a mutation ("mis-map
 * `graph.ts`'s real G2 pathMap target `draft: LOOP_NODES.draft` to
 * `LOOP_NODES.apply`") left every test in this file green, because none of
 * them ever invoked `buildLoopGraph()`. See
 * `docs/feature/a4a-loop/test-report.md` B1 for the full mutation record.
 *
 * **Fix**: this file now drives `graph.ts`'s own exported `buildLoopGraph()`
 * + `compileLoopGraph()` directly — same FakeAdapter-backed real
 * `ProviderRouter`/`PromptComposer` pattern `checkpoint.test.ts` already
 * uses for its own real-graph happy-path proof (layer 3 of PRD §5's testing
 * strategy), except the tester `FakeAdapter` here is *scriptable* (a
 * per-call verdict queue), so each test can drive the real, production
 * `graph.ts` through a specific reject/fix-forward branch, not just the
 * happy path. `MemorySaver` (not `SqliteSaver`) is still the right
 * checkpointer choice here — this file's job is topology/routing coverage,
 * not checkpoint persistence (that's `checkpoint.test.ts`'s already-covered
 * job); nothing below needs real disk.
 *
 * Every `addConditionalEdges` branch `graph.ts` actually declares now has a
 * test that drives the real compiled graph through it: G1 approve/reject,
 * review pass/reject, G2 approved (+ non-approved fail-loud), G3
 * approve/reject.
 */
import path from "node:path";
import { MemorySaver, Command } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { resolveProfileDir } from "../../profile/loader.js";
import { PromptComposer } from "../../prompt/composer.js";
import { AdapterRegistry } from "../../harness/adapter-registry.js";
import { ProviderRouter } from "../../harness/provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../harness/types.js";
import type { CoderOutput, TesterOutput } from "../../prompt/schema.js";
import { UnhandledGateDecisionError } from "../errors.js";
import { buildLoopGraph, compileLoopGraph, type LoopGraphDeps } from "../graph.js";
import { LOOP_NODES } from "../workflow-def.js";
import type { EscalationResumeValue, GateResumeValue, LoopNodeName, LoopStateType } from "../types.js";

const NOW = "2026-07-21T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const FAKE_DIFF = "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n";

/**
 * Counts real `invoke()` calls (so a test can assert `draft` genuinely
 * re-ran on a loop-back, not that the graph merely looks like it did) and
 * records each request's `prompt` (so a test can assert *what* `draft` saw
 * on a re-run — in particular, `state.feedback` as it existed when `draft`
 * actually ran, which `getState()` can't observe directly once `draft`'s
 * own return has already cleared `feedback` again by the time the graph
 * next pauses).
 */
class FakeCoderAdapter implements ModelAdapter {
  readonly id = "fake-coder";
  readonly kind = "direct-api" as const;
  calls = 0;
  readonly receivedRequests: InvokeRequest[] = [];

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.calls += 1;
    this.receivedRequests.push(req);
    const payload: CoderOutput = { diff: FAKE_DIFF, claims: [], confidence: "verified" };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

/**
 * Scriptable per-call verdict queue (mirrors this file's old
 * `createToyReviewNode`'s index-based queue, now sitting behind the real
 * `createReviewNode`/`SchemaValidator`/adapter path instead of a bare
 * function): the index only advances on a real `invoke()` call, i.e. only
 * when the real graph actually schedules `review`, so a test can assert on
 * `calls` to prove `review` really ran N times, not just that the final
 * state looks right.
 */
class FakeTesterAdapter implements ModelAdapter {
  readonly id = "fake-tester";
  readonly kind = "direct-api" as const;
  calls = 0;

  constructor(private readonly verdicts: readonly TesterOutput["verdict"][]) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const verdict = this.verdicts[Math.min(this.calls, this.verdicts.length - 1)] ?? "pass";
    this.calls += 1;
    const payload: TesterOutput = {
      verdict,
      issues: verdict === "reject" ? ["fake issue found by review"] : [],
      claims: [],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

function buildDeps(testerVerdicts: readonly TesterOutput["verdict"][]): {
  deps: LoopGraphDeps;
  coder: FakeCoderAdapter;
  tester: FakeTesterAdapter;
} {
  const coder = new FakeCoderAdapter();
  const tester = new FakeTesterAdapter(testerVerdicts);
  const registry = new AdapterRegistry();
  registry.register(coder);
  registry.register(tester);
  const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
  const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
  return { deps: { router, composer }, coder, tester };
}

function threadConfig(threadId: string) {
  return { configurable: { thread_id: threadId } };
}

/** `graph.ts`'s real compiled node union — every real `LOOP_NODES` value plus `"__start__"`, minus `"__end__"` (mirrors `checkpoint.test.ts`'s `RealGraphNode`, same reasoning). */
type RealGraphNode = Exclude<LoopNodeName, "__end__">;

function resumeCommand(resume: GateResumeValue) {
  return new Command<GateResumeValue, Record<string, unknown>, RealGraphNode>({ resume });
}

/** Same shape as `resumeCommand`, for the Escalation gate's three-way `EscalationResumeValue` (A4b PRD §5 "graph.test.ts"). */
function escalationResumeCommand(resume: EscalationResumeValue) {
  return new Command<EscalationResumeValue, Record<string, unknown>, RealGraphNode>({ resume });
}

function initialState(overrides: Partial<LoopStateType> = {}): LoopStateType {
  return {
    task: "real graph coverage: add a function",
    feedback: undefined,
    injectedContext: { memories: [] },
    coderOutput: undefined,
    coderResult: undefined,
    testerOutput: undefined,
    testerResult: undefined,
    rejectCount: 0,
    g1Decision: undefined,
    g2Decision: undefined,
    g3Decision: undefined,
    gateLog: [],
    applied: false,
    rejectThreshold: 2,
    escalationDecision: undefined,
    cancelled: false,
    ...overrides,
  };
}

describe("buildLoopGraph()/compileLoopGraph() — every real addConditionalEdges branch driven end-to-end", () => {
  it("happy path: draft -> g1(approved) -> review(pass) -> g3(approved) -> apply -> END", async () => {
    const { deps } = buildDeps(["pass"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("happy-path");

    await compiled.invoke(initialState(), cfg);
    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);

    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);

    const final = await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    expect(final.applied).toBe(true);
    expect(final.g1Decision).toBe("approved");
    expect(final.g3Decision).toBe("approved");
    expect(final.rejectCount).toBe(0);

    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([]);
  });

  it("G1 reject once, then approve: graph.ts's real G1 pathMap routes 'rejected' -> draft, which really re-runs (real coder adapter invoked again), before reaching review", async () => {
    const { deps, coder } = buildDeps(["pass"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("g1-reject-then-approve");

    await compiled.invoke(initialState(), cfg);
    expect(coder.calls).toBe(1);

    // Reject at G1 -> graph.ts's real G1 pathMap `draft: LOOP_NODES.draft`.
    await compiled.invoke(resumeCommand({ decision: "rejected", reasoningText: "not ready" }), cfg);

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
    expect(snapshot.values.g1Decision).toBe("rejected");
    expect(coder.calls).toBe(2); // draft genuinely re-ran, not skipped/short-circuited

    // Approve this time -> graph.ts's real G1 pathMap `review: LOOP_NODES.review` -> pass -> g3.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);
    expect(snapshot.values.g1Decision).toBe("approved");

    // gateLog has both the reject and the approve entries (accumulated, not overwritten).
    expect(snapshot.values.gateLog).toHaveLength(2);
  });

  it("tester rejects once: graph.ts's real review pathMap routes verdict 'reject' -> g2; G2 approve routes graph.ts's real `draft: LOOP_NODES.draft` target back to draft, which re-runs (carrying G2's derived feedback) and reaches review again (rejectCount becomes 1, real tester adapter invoked twice)", async () => {
    const { deps, coder, tester } = buildDeps(["reject", "pass"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("tester-reject-then-g2-approve");

    await compiled.invoke(initialState(), cfg);
    // Approve G1 -> review runs (1st real invoke, scripted "reject") -> graph.ts's real review pathMap routes to g2.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
    expect(snapshot.values.rejectCount).toBe(1);
    expect(snapshot.values.testerOutput?.verdict).toBe("reject");
    expect(tester.calls).toBe(1);
    expect(coder.calls).toBe(1); // draft has only run once so far

    // Approve G2 -> graph.ts's real G2 pathMap `draft: LOOP_NODES.draft` -> draft re-runs (in the
    // same invoke() call, before the graph next pauses at g1) -> g1 interrupts again. `getState()`
    // afterwards would show `feedback` already cleared again (draft's own node body always clears
    // it once consumed) — so the real evidence that the loop-back actually carried G2's derived
    // feedback into draft is what draft's 2nd real request actually contained.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
    expect(snapshot.values.g2Decision).toBe("approved");
    expect(coder.calls).toBe(2); // draft genuinely re-ran, not skipped/short-circuited
    expect(coder.receivedRequests[1]?.prompt).toContain("fake issue found by review");

    // Approve G1 -> review really re-runs (2nd real invoke, scripted "pass") -> g3.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);
    expect(snapshot.values.rejectCount).toBe(1); // pass round doesn't increment further
    expect(snapshot.values.testerOutput?.verdict).toBe("pass");
    expect(tester.calls).toBe(2);
  });

  it("G3 rejects once: graph.ts's real G3 pathMap routes 'rejected' -> draft, looping back before a second approve reaches apply", async () => {
    const { deps, coder } = buildDeps(["pass"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("g3-reject-then-approve");

    await compiled.invoke(initialState(), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // G1 approve -> review(pass) -> g3

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);
    expect(coder.calls).toBe(1);

    // Reject at G3 -> graph.ts's real G3 pathMap `draft: LOOP_NODES.draft` -> g1 interrupts again.
    await compiled.invoke(resumeCommand({ decision: "rejected", reasoningText: "still broken" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
    expect(snapshot.values.g3Decision).toBe("rejected");
    expect(snapshot.values.applied).toBe(false);
    expect(coder.calls).toBe(2); // draft genuinely re-ran, not skipped/short-circuited (mirrors G1-reject/G2-approve)

    // Approve G1 -> review(pass) -> g3 again -> approve -> graph.ts's real G3 pathMap `apply: LOOP_NODES.apply` -> END.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    const final = await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    expect(final.applied).toBe(true);
    expect(final.g3Decision).toBe("approved");
  });

  it("G2 receiving a non-'approved' decision throws UnhandledGateDecisionError through the real graph, not a silent/wrong route (PRD §2 non-goal)", async () => {
    const { deps } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("g2-unhandled-decision");

    await compiled.invoke(initialState(), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // G1 approve -> review(reject) -> g2

    const snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);

    await expect(compiled.invoke(resumeCommand({ decision: "rejected" }), cfg)).rejects.toBeInstanceOf(UnhandledGateDecisionError);
  });
});

/**
 * A4b's Escalation subtree (docs/feature/a4b-loop/PRD.md §5/§8) — every new
 * `addConditionalEdges` branch `graph.ts` now declares, driven end-to-end
 * through the real compiled graph, same FakeAdapter-backed pattern as the
 * describe block above.
 */
describe("buildLoopGraph()/compileLoopGraph() — A4b Escalation subtree driven end-to-end", () => {
  it("reject_count reaching rejectThreshold routes to escalation, not g2; below threshold still routes to g2 (both edges of the boundary)", async () => {
    const { deps, tester } = buildDeps(["reject", "reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("threshold-escalation-boundary");

    await compiled.invoke(initialState({ rejectThreshold: 2 }), cfg);
    // G1 approve -> review (1st real invoke, scripted "reject") -> rejectCount=1 < threshold(2) -> g2.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
    expect(snapshot.values.rejectCount).toBe(1);

    // G2 approve -> graph.ts's real G2 pathMap `draft: LOOP_NODES.draft` -> draft re-runs -> g1 interrupts again.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);

    // G1 approve -> review (2nd real invoke, scripted "reject") -> rejectCount=2 >= threshold(2) -> escalation, not g2.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);
    expect(snapshot.values.rejectCount).toBe(2);
    expect(tester.calls).toBe(2);
  });

  /**
   * Review Round-1 B1 rework (`docs/feature/a4b-loop/test-report.md`): the
   * boundary test above only ever drives `rejectCount` up to *exactly*
   * `rejectThreshold` (2 == 2), which can't distinguish `gates.ts`'s real
   * `routeAfterReview`'s `rejectCount >= rejectThreshold` from a mutant
   * `rejectCount === rejectThreshold` — both agree at the boundary. The
   * mutation run confirmed this: flipping `>=` to `===` left every existing
   * test green. DESIGN §4 calls escalation-on-threshold "un-bypassable"
   * specifically because `rejectCount` keeps climbing past
   * `rejectThreshold` on a `revise` loop-back (a human can route out of
   * escalation back to `draft`, tester can reject *again*) — `>=` must keep
   * escalating every time, `===` would silently stop escalating and route
   * back to `g2` instead the moment `rejectCount` exceeds `rejectThreshold`
   * by even one. This test drives `rejectCount` to 3 against
   * `rejectThreshold: 2` (via threshold-escalation -> Escalation 'revise' ->
   * draft re-runs -> another tester reject) specifically to make `>=` and
   * `===` disagree — the boundary test above can't do that, this one can.
   */
  it("rejectCount exceeding (not just reaching) rejectThreshold still routes to escalation, not g2 — DESIGN §4's 'un-bypassable' escalation, proven past the boundary", async () => {
    const { deps, tester } = buildDeps(["reject", "reject", "reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("threshold-escalation-beyond-boundary");

    await compiled.invoke(initialState({ rejectThreshold: 2 }), cfg);
    // G1 approve -> review (1st reject) -> rejectCount=1 < threshold(2) -> g2.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
    expect(snapshot.values.rejectCount).toBe(1);

    // G2 approve -> draft re-runs -> g1 interrupts again.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    // G1 approve -> review (2nd reject) -> rejectCount=2 >= threshold(2) -> escalation (both >= and === agree here).
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);
    expect(snapshot.values.rejectCount).toBe(2);

    // Escalation 'revise' -> draft re-runs (carrying feedback) -> g1 interrupts again.
    await compiled.invoke(escalationResumeCommand({ decision: "revise", reasoningText: "please address the tester's findings" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]);
    expect(snapshot.values.escalationDecision).toBe("revise");

    // G1 approve -> review (3rd reject) -> rejectCount=3 > threshold(2). Real `>=`: 3 >= 2 -> escalation
    // (still un-bypassable). Mutant `===`: 3 === 2 is false -> g2 (the exact bypass DESIGN §4 forbids).
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);
    expect(snapshot.values.rejectCount).toBe(3);
    expect(tester.calls).toBe(3);
  });

  /**
   * Review Round-2 R2-1 (`docs/feature/a4b-loop/test-report.md`): every
   * threshold test above this one exercises `rejectThreshold` values of 1
   * or 2 — none drives `rejectCount` up while `rejectThreshold` is a real
   * variable *greater than* 2. That leaves a mutation like `rejectCount >=
   * Math.min(rejectThreshold, 2)` — which is only wrong once `rejectThreshold
   * > 2` — completely undetected: for threshold 1/2, `Math.min(threshold, 2)`
   * equals `threshold` itself, so the mutant agrees with the real
   * `routeAfterReview` on every case those tests drive. A manual run of this
   * exact mutation confirmed all 23 pre-R2 threshold-related assertions
   * stayed green. This test sets `rejectThreshold: 5` and drives
   * `rejectCount` to 2 via two reject/g2-approve rounds — real `>=`: `2 >= 5`
   * is false, routes to `g2` both times; the `Math.min(5, 2)` mutant would
   * compute `2 >= 2` as true on the *second* reject and escalate early,
   * which this test's final assertion (still `g2`, not `escalation`) directly
   * catches.
   */
  it("rejectThreshold as a real variable above 2 is honored, not silently capped at 2 (rejectCount=2 against threshold=5 still routes to g2, not escalation)", async () => {
    const { deps, tester } = buildDeps(["reject", "reject", "pass"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("threshold-above-two-not-capped");

    await compiled.invoke(initialState({ rejectThreshold: 5 }), cfg);
    // G1 approve -> review (1st reject) -> rejectCount=1 < threshold(5) -> g2.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
    expect(snapshot.values.rejectCount).toBe(1);

    // G2 approve -> draft re-runs -> g1 interrupts again.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    // G1 approve -> review (2nd reject) -> rejectCount=2. Real `>=`: 2 >= 5 is false -> g2 (not escalation).
    // Mutant `Math.min(threshold, 2)`: 2 >= min(5,2)=2 is true -> would wrongly escalate here.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);
    expect(snapshot.values.rejectCount).toBe(2);
    expect(tester.calls).toBe(2);
  });

  it("Escalation 'force_pass' routes straight to g3 (no re-running review/draft); subsequent G3 approve reaches apply", async () => {
    const { deps, coder } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("escalation-force-pass");

    await compiled.invoke(initialState({ rejectThreshold: 1 }), cfg);
    // G1 approve -> review(reject) -> rejectCount=1 >= threshold(1) -> escalation.
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);

    await compiled.invoke(escalationResumeCommand({ decision: "force_pass", reasoningText: "ship it anyway" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g3]);
    expect(snapshot.values.escalationDecision).toBe("force_pass");
    expect(coder.calls).toBe(1); // draft never re-ran — force_pass skips straight to g3, not through draft again.

    const final = await compiled.invoke(resumeCommand({ decision: "approved" }), cfg);
    expect(final.applied).toBe(true);
    expect(final.g3Decision).toBe("approved");
  });

  it("Escalation 'revise' routes to draft, which really re-runs (real coder adapter invoked again) carrying the tester's issues + human reasoning as feedback", async () => {
    const { deps, coder } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("escalation-revise");

    await compiled.invoke(initialState({ rejectThreshold: 1 }), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // -> review(reject) -> escalation
    expect(coder.calls).toBe(1);

    await compiled.invoke(escalationResumeCommand({ decision: "revise", reasoningText: "please address the tester's findings" }), cfg);
    const snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g1]); // escalation -> draft (re-ran, in the same invoke) -> g1 interrupts.
    expect(snapshot.values.escalationDecision).toBe("revise");
    expect(coder.calls).toBe(2); // draft genuinely re-ran, not skipped/short-circuited.
    expect(coder.receivedRequests[1]?.prompt).toContain("fake issue found by review");
    expect(coder.receivedRequests[1]?.prompt).toContain("please address the tester's findings");
  });

  it("Escalation 'abandon' routes to cancel; final state has cancelled: true, applied stays false, graph reaches END", async () => {
    const { deps } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("escalation-abandon");

    await compiled.invoke(initialState({ rejectThreshold: 1 }), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // -> escalation

    const final = await compiled.invoke(escalationResumeCommand({ decision: "abandon", reasoningText: "not worth pursuing" }), cfg);
    expect(final.cancelled).toBe(true);
    expect(final.applied).toBe(false);
    expect(final.escalationDecision).toBe("abandon");

    const snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([]); // cancel -> END, graph is done.
  });

  it("G2 receiving 'escalate' (DESIGN §4's 'proactively escalate' edge) routes to escalation, not draft — distinct from G2's existing 'approved'->draft path", async () => {
    const { deps } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("g2-escalate");

    // Threshold high enough that the first reject still routes to g2, not straight to escalation via the threshold path — isolates this test to G2's own "proactively escalate" edge.
    await compiled.invoke(initialState({ rejectThreshold: 5 }), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // -> review(reject) -> rejectCount=1 < 5 -> g2

    let snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.g2]);

    await compiled.invoke(resumeCommand({ decision: "escalate", reasoningText: "tester found something serious" }), cfg);
    snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);
    expect(snapshot.values.g2Decision).toBe("escalate");
  });

  it("Escalation receiving an unrecognized decision throws through the real graph, not a silent/wrong route (mirrors G1/G3's default-throw backstop)", async () => {
    const { deps } = buildDeps(["reject"]);
    const compiled = compileLoopGraph(buildLoopGraph(deps), new MemorySaver());
    const cfg = threadConfig("escalation-unhandled-decision");

    await compiled.invoke(initialState({ rejectThreshold: 1 }), cfg);
    await compiled.invoke(resumeCommand({ decision: "approved" }), cfg); // -> escalation

    const snapshot = await compiled.getState(cfg);
    expect(snapshot.next).toEqual([LOOP_NODES.escalation]);

    const bogus = { decision: "bogus" } as unknown as EscalationResumeValue;
    await expect(compiled.invoke(escalationResumeCommand(bogus), cfg)).rejects.toThrow(/routeAfterEscalation/);
  });
});
