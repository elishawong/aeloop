/**
 * `createReviewNode` unit tests (PRD §5 "nodes/tester.test.ts"). Same
 * `FakeAdapter` + real `ProviderRouter`/`PromptComposer` boundary as
 * `coder.test.ts`.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProfileDir } from "../../../profile/loader.js";
import { PromptComposer } from "../../../prompt/composer.js";
import { AdapterRegistry } from "../../../harness/adapter-registry.js";
import { ProviderRouter } from "../../../harness/provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../../harness/types.js";
import type { CoderOutput, TesterOutput } from "../../../prompt/schema.js";
import { createReviewNode } from "../tester.js";
import type { LoopStateType } from "../../types.js";

const NOW = "2026-07-20T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const CODER_OUTPUT: CoderOutput = {
  diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
  claims: [
    { claimText: "the tests were run and passed", confidence: "verified", sourceRef: "test output", verifiedBy: "tool_execution" },
  ],
  confidence: "verified",
};

class FakeAdapter implements ModelAdapter {
  readonly id = "fake-tester";
  readonly kind = "direct-api" as const;
  readonly receivedRequests: InvokeRequest[] = [];

  constructor(private readonly response: () => InvokeResult) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.receivedRequests.push(req);
    return this.response();
  }
}

function resultOf(output: TesterOutput): InvokeResult {
  return { content: JSON.stringify(output), provider: "fake-tester", model: "fake-model-v1" };
}

function buildRouter(adapter: ModelAdapter): ProviderRouter {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new ProviderRouter({ tester: { provider: adapter.id } }, registry);
}

function buildState(overrides: Partial<LoopStateType> = {}): LoopStateType {
  return {
    task: "Add a function that reverses a string.",
    feedback: undefined,
    injectedContext: { memories: [] },
    coderOutput: CODER_OUTPUT,
    coderResult: undefined,
    testerOutput: undefined,
    testerResult: undefined,
    rejectCount: 0,
    g1Decision: undefined,
    g2Decision: undefined,
    g3Decision: undefined,
    gateLog: [],
    applied: false,
    ...overrides,
  };
}

describe("createReviewNode", () => {
  it("composes a task text that includes the diff and the coder's claims", async () => {
    const passOutput: TesterOutput = { verdict: "pass", issues: [], claims: [], confidence: "verified" };
    const adapter = new FakeAdapter(() => resultOf(passOutput));
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createReviewNode({ router, composer });

    await node(buildState());

    const prompt = adapter.receivedRequests[0]?.prompt ?? "";
    expect(prompt).toContain(CODER_OUTPUT.diff);
    expect(prompt).toContain("the tests were run and passed");
  });

  it("increments rejectCount when verdict is 'reject'", async () => {
    const rejectOutput: TesterOutput = { verdict: "reject", issues: ["off-by-one in the loop bound"], claims: [], confidence: "verified" };
    const adapter = new FakeAdapter(() => resultOf(rejectOutput));
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createReviewNode({ router, composer });

    const update = await node(buildState({ rejectCount: 0 }));

    expect(update.rejectCount).toBe(1);
    expect(update.testerOutput).toEqual(rejectOutput);
  });

  it("does not change rejectCount when verdict is 'pass'", async () => {
    const passOutput: TesterOutput = { verdict: "pass", issues: [], claims: [], confidence: "verified" };
    const adapter = new FakeAdapter(() => resultOf(passOutput));
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createReviewNode({ router, composer });

    const update = await node(buildState({ rejectCount: 1 }));

    expect(update.rejectCount).toBe(1);
  });

  it("throws a plain Error (not a bare crash) when state.coderOutput is missing", async () => {
    const passOutput: TesterOutput = { verdict: "pass", issues: [], claims: [], confidence: "verified" };
    const adapter = new FakeAdapter(() => resultOf(passOutput));
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createReviewNode({ router, composer });

    await expect(node(buildState({ coderOutput: undefined }))).rejects.toThrow(/coderOutput/);
    expect(adapter.receivedRequests).toHaveLength(0);
  });
});
