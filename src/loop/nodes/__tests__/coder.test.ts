/**
 * `createDraftNode` unit tests (PRD §5 "nodes/coder.test.ts"). Test-double
 * boundary per PRD §5's three-layer testing strategy: a hand-written
 * `FakeAdapter` (mirrors `harness.e2e.test.ts`'s `FakeAdapter` — no real
 * subprocess/network) behind a **real** `ProviderRouter` + real
 * `PromptComposer`. What's under test is whether `createDraftNode` calls
 * those two real collaborators correctly (feedback handling, task
 * assembly), not whether the collaborators themselves work (already
 * covered by their own unit tests).
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProfileDir } from "../../../profile/loader.js";
import { PromptComposer } from "../../../prompt/composer.js";
import { AdapterRegistry } from "../../../harness/adapter-registry.js";
import { ProviderRouter } from "../../../harness/provider-router.js";
import { SchemaValidationError } from "../../../harness/errors.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../../harness/types.js";
import type { CoderOutput } from "../../../prompt/schema.js";
import { createDraftNode } from "../coder.js";
import type { LoopStateType } from "../../types.js";

const NOW = "2026-07-20T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const VALID_CODER_OUTPUT: CoderOutput = {
  diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
  claims: [{ claimText: "the change compiles", confidence: "verified" }],
  confidence: "verified",
};

/** Mirrors `harness.e2e.test.ts`'s `FakeAdapter` — a queue of canned responses, one per call, the last one repeating if `invoke()` is called more times than there are entries. */
class FakeAdapter implements ModelAdapter {
  readonly id = "fake-coder";
  readonly kind = "direct-api" as const;
  readonly receivedRequests: InvokeRequest[] = [];
  private callIndex = 0;

  constructor(private readonly responses: Array<() => InvokeResult>) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.receivedRequests.push(req);
    const index = Math.min(this.callIndex, this.responses.length - 1);
    this.callIndex += 1;
    const responder = this.responses[index];
    if (!responder) throw new Error("FakeAdapter misconfigured: no response for this call");
    return responder();
  }
}

function validResult(content: unknown): InvokeResult {
  return { content: JSON.stringify(content), provider: "fake-coder", model: "fake-model-v1" };
}

function invalidResult(): InvokeResult {
  return { content: "not valid json {{{", provider: "fake-coder", model: "fake-model-v1" };
}

function buildRouter(adapter: ModelAdapter): ProviderRouter {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new ProviderRouter({ coder: { provider: adapter.id } }, registry);
}

function buildState(overrides: Partial<LoopStateType> = {}): LoopStateType {
  return {
    task: "Add a function that reverses a string.",
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

describe("createDraftNode", () => {
  it("without feedback: composes the prompt from the original task alone, and returns typed coderOutput/coderResult", async () => {
    const adapter = new FakeAdapter([() => validResult(VALID_CODER_OUTPUT)]);
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createDraftNode({ router, composer });

    const state = buildState();
    const update = await node(state);

    expect(adapter.receivedRequests).toHaveLength(1);
    expect(adapter.receivedRequests[0]?.prompt).toContain(state.task);
    expect(adapter.receivedRequests[0]?.prompt).not.toContain("Feedback from the previous round");

    expect(update.coderOutput).toEqual(VALID_CODER_OUTPUT);
    expect(update.coderResult?.provider).toBe("fake-coder");
  });

  it("with feedback: appends it to the task text under a 'Feedback from the previous round' marker", async () => {
    const adapter = new FakeAdapter([() => validResult(VALID_CODER_OUTPUT)]);
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createDraftNode({ router, composer });

    const state = buildState({ feedback: "the diff broke the build" });
    await node(state);

    const prompt = adapter.receivedRequests[0]?.prompt ?? "";
    expect(prompt).toContain("Feedback from the previous round");
    expect(prompt).toContain("the diff broke the build");
    expect(prompt).toContain(state.task);
  });

  it("clears state.feedback in its return value once consumed", async () => {
    const adapter = new FakeAdapter([() => validResult(VALID_CODER_OUTPUT)]);
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createDraftNode({ router, composer });

    const state = buildState({ feedback: "please fix the off-by-one" });
    const update = await node(state);

    expect(update.feedback).toBeUndefined();
  });

  it("propagates SchemaValidationError (not caught/swallowed) when both attempts fail validation", async () => {
    const adapter = new FakeAdapter([invalidResult, invalidResult]);
    const router = buildRouter(adapter);
    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const node = createDraftNode({ router, composer });

    await expect(node(buildState())).rejects.toBeInstanceOf(SchemaValidationError);
    expect(adapter.receivedRequests).toHaveLength(2);
  });
});
