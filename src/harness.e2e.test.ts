/**
 * B6 — the hardest requirement of A2 (PRD §5 "垂直切片(A2 收尾,硬性交付)"
 * / DESIGN §8.5's "aeloop 每个里程碑收尾必须有一条薄垂直切片真正接通"),
 * this time proving the *next* seam: that a real `PromptComposer` output
 * string actually flows through the three new Harness components —
 * `ProviderRouter` → `AdapterRegistry` → `SchemaValidator` — and comes out
 * the other side as a typed, schema-valid result. `src/context-prompt.e2e
 * .test.ts` (A1's B9) already proved Context → Prompt; this test starts
 * from that same real chain and extends it one layer further, exactly like
 * PRD §5 asks ("做法照抄 context-prompt.e2e.test.ts 的搭建方式,不重新发明").
 *
 * The only thing replaced with a test double anywhere in this file is the
 * `FakeAdapter` below — it stands in for "an actual network call to a
 * model provider", which is explicitly out of scope for A2 (PRD §2 非目标:
 * "不打真实 LiteLLM 公司代理"). Every other component — `MemoryStore`,
 * `ContextInjector`, `PromptComposer`, `AdapterRegistry`, `ProviderRouter`,
 * `SchemaValidator` — is the real class, doing real work, wired together
 * exactly as a Loop-layer (A4) caller would wire them. If any of these
 * seams were secretly disconnected (e.g. `ProviderRouter.route()` silently
 * returning the wrong adapter, or `SchemaValidator` never actually calling
 * its `invoke` callback), this test would fail — three isolated green unit
 * tests could not catch that, which is exactly the gap this test exists to
 * close.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "./profile/loader.js";
import { MemoryStore } from "./context/store.js";
import { SystemConfig } from "./context/config.js";
import { StalenessEngine } from "./context/staleness.js";
import { ContextInjector } from "./context/injector.js";
import { PromptComposer } from "./prompt/composer.js";
import { CoderOutput } from "./prompt/schema.js";
import { AdapterRegistry } from "./harness/adapter-registry.js";
import { ProviderRouter } from "./harness/provider-router.js";
import { SchemaValidator } from "./harness/schema-validator.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "./harness/types.js";

const NOW = "2026-07-20T00:00:00.000Z";
const HELIX_PERSONAS_DIR = path.join(resolveProfileDir("helix"), "personas");

/**
 * The one test double in this file (see file header). Represents "not
 * hitting a real network" — PRD §5 B6 task description names this exact
 * class by this exact shape: `id: "fake-litellm"`, `kind: "direct-api"`,
 * `invoke()` returns a valid `CoderOutput` JSON string as `content`.
 *
 * `checkAvailability()` is on the `ModelAdapter` interface but unused by
 * this slice (`ProviderRouter`/`SchemaValidator` never call it) — it's
 * implemented minimally just to satisfy the interface, not exercised or
 * asserted on here.
 */
class FakeAdapter implements ModelAdapter {
  readonly id = "fake-litellm";
  readonly kind = "direct-api" as const;

  /** Records every request actually handed to `invoke()`, in order — lets
   * the test assert `SchemaValidator` really drove this adapter itself,
   * not a reshaped/short-circuited copy of the request. */
  readonly receivedRequests: InvokeRequest[] = [];

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.receivedRequests.push(req);
    const payload: CoderOutput = {
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [
        {
          claimText: "the new line replaces the old one",
          confidence: "verified",
          sourceRef: "diff above",
          verifiedBy: "tool_execution",
        },
      ],
      confidence: "verified",
    };
    return {
      content: JSON.stringify(payload),
      provider: this.id,
      model: "fake-model-v1",
    };
  }
}

const openStores: MemoryStore[] = [];
afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("Prompt -> Harness vertical slice (real MemoryStore -> real ContextInjector -> real PromptComposer -> real ProviderRouter -> real SchemaValidator, fake adapter as the only network-facing double)", () => {
  it("a composed coder prompt flows through the router and schema validator to a typed CoderOutput", async () => {
    const task = "Explain the retry-backoff strategy.";

    // ---- 1. Real Context -> Prompt chain (identical setup to A1's B9
    // src/context-prompt.e2e.test.ts, not reinvented) ---------------------
    const store = new MemoryStore(":memory:");
    openStores.push(store);

    store.insertMemory(
      {
        type: "decision",
        title: "Build tooling",
        content: "aeloop uses pnpm as its package manager.",
        confidenceState: "confirmed",
      },
      NOW,
    );

    const config = new SystemConfig(store);
    config.set("default_stale_days", "30", NOW);
    const staleness = new StalenessEngine(config);
    const injector = new ContextInjector(store, staleness);
    const injected = injector.inject(task, new Date(NOW));

    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const prompt = composer.compose("coder", injected, task);

    // Sanity: this really is a composed prompt string, not a stub.
    expect(prompt).toContain("You are the Coder in a two-model coder/tester loop.");
    expect(prompt).toContain(task);

    // ---- 2. Real AdapterRegistry + real ProviderRouter, routing to the
    // one fake (network) adapter --------------------------------------
    const fakeAdapter = new FakeAdapter();
    const registry = new AdapterRegistry();
    registry.register(fakeAdapter);

    const router = new ProviderRouter({ coder: { provider: "fake-litellm" } }, registry);
    const adapter = router.route("coder");

    // Prove the router really resolved to this exact fake instance, not a
    // reshaped stand-in.
    expect(adapter).toBe(fakeAdapter);

    // ---- 3. Real SchemaValidator, driving the routed adapter through the
    // real composed prompt --------------------------------------------
    const validator = new SchemaValidator();
    const { data, result, attempts } = await validator.validate({
      schema: CoderOutput,
      request: { role: "coder", prompt },
      invoke: (req) => adapter.invoke(req),
    });

    // ---- 4. Assertions on the final typed result -----------------------
    // The prompt SchemaValidator actually sent the adapter is the real
    // composed prompt from step 1, unmodified (first attempt succeeded).
    expect(fakeAdapter.receivedRequests).toHaveLength(1);
    expect(fakeAdapter.receivedRequests[0]?.prompt).toBe(prompt);
    expect(attempts).toBe(1);

    expect(result.provider).toBe("fake-litellm");

    // `data` is a typed CoderOutput — not just "parsed JSON", the zod
    // schema actually accepted its shape.
    expect(data.diff).toContain("+new");
    expect(data.confidence).toBe("verified");
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0]?.claimText).toBe("the new line replaces the old one");
  });
});
