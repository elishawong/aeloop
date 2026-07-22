/**
 * B6 — A3's hardest requirement (PRD §5 "vertical slice (A3 wrap-up,
 * hard deliverable)" / DESIGN §8.5's "every aeloop milestone wrap-up must
 * have one thin vertical slice actually wired end-to-end"),
 * proving the *cli-bridge* seam this time: that a real `PromptComposer`
 * output string flows all the way through a real `cli-bridge` `ModelAdapter`
 * — real subprocess spawn, real JSONL parsing, real `ToolExecVerifier`
 * verdict — and comes out the other side as a typed, schema-valid result
 * with a correctly-computed `toolExecChecked`.
 *
 * This is a **separate file from `src/harness.e2e.test.ts`** (A2's slice,
 * not touched here) — that one proves the `direct-api` seam with a
 * hand-built `FakeAdapter`; this one proves the different, `cli-bridge`
 * seam, and needs a fundamentally different "only test double" boundary
 * (see below), so it doesn't belong bolted onto the same file/describe.
 *
 * **What's real vs. what's replaced — the point of this test**:
 * - Real: `MemoryStore` → `ContextInjector` → `PromptComposer` (identical
 *   setup to `harness.e2e.test.ts`/`context-prompt.e2e.test.ts`, not
 *   reinvented, PRD §5's explicit instruction).
 * - Real: `buildAdapterRegistry()` — this is the crucial difference from
 *   A2's slice, which hand-constructed a `FakeAdapter` and skipped
 *   `buildAdapterRegistry()`/`config.ts` entirely. This test drives the
 *   *actual* `cli-bridge` dispatch branch (`config.ts`, B5) against a
 *   `ProfileConfig`, so a real `CodexCliAdapter` instance comes out the
 *   other end — if B5's dispatch logic were broken (wrong class, wrong
 *   `cmd` routing), this test would fail; A2-style FakeAdapter tests
 *   structurally cannot catch that class of bug.
 * - Real: `ProviderRouter`, `SchemaValidator`.
 * - Real: the `CodexCliAdapter`'s own `invoke()` — it really `spawn()`s a
 *   child process and really parses real stdout, exactly as it would
 *   against the genuine `codex` binary.
 * - **The only thing replaced**: the process on the other end of that
 *   spawn. `config.providers["codex-cli"].cmd` stays `"codex"` — the real,
 *   unchanged, strict flavor dispatch key `config.ts` uses to pick
 *   `CodexCliAdapter` (exactly as it would for the real, committed
 *   `profiles/subscription/config.yaml`) — and a separate `bin` field
 *   overrides *only* the spawn target to point at `fake-codex.fixture.mjs`
 *   (a real, controlled child process — same "real but controlled"
 *   boundary `codex-cli-adapter.test.ts` and A2's `LiteLLMAdapter` tests
 *   already established) instead of the real `codex` binary. If any seam
 *   here were secretly disconnected — `config.ts` routing to the wrong
 *   adapter class, `ProviderRouter` losing the binding, `SchemaValidator`
 *   not really driving `invoke()`, or `ToolExecVerifier` never actually
 *   being consulted — this test would
 *   fail; isolated unit tests for each piece could not catch that.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../profile/loader.js";
import type { ProfileConfig } from "../profile/loader.js";
import { MemoryStore } from "../context/store.js";
import { SystemConfig } from "../context/config.js";
import { StalenessEngine } from "../context/staleness.js";
import { ContextInjector } from "../context/injector.js";
import { PromptComposer } from "../prompt/composer.js";
import { CoderOutput, isCoderOutputChanged } from "../prompt/schema.js";
import { buildAdapterRegistry } from "../harness/config.js";
import { ProviderRouter } from "../harness/provider-router.js";
import { SchemaValidator } from "../harness/schema-validator.js";
import { CodexCliAdapter } from "../harness/adapters/codex-cli-adapter.js";

const NOW = "2026-07-20T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX_FIXTURE = path.join(HERE, "..", "harness", "adapters", "__tests__", "fixtures", "fake-codex.fixture.mjs");
const ENV_KEY = "FAKE_CODEX_SCENARIO";

const openStores: MemoryStore[] = [];
afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
  delete process.env[ENV_KEY];
});

describe("Prompt -> Harness cli-bridge vertical slice (real MemoryStore -> real ContextInjector -> real PromptComposer -> real buildAdapterRegistry -> real ProviderRouter -> real CodexCliAdapter (spawns a real but controlled fixture subprocess) -> real SchemaValidator -> real ToolExecVerifier)", () => {
  it("a composed coder prompt flows through a real cli-bridge adapter to a typed CoderOutput with toolExecChecked: \"pass\"", async () => {
    // `claims-with-trace`: the fixture scenario built specifically for this
    // slice (fake-codex.fixture.mjs) — a real command_execution pair PLUS a
    // final agent_message whose text is CoderOutput-shaped JSON claiming
    // `verifiedBy: "tool_execution"`. Set before any spawn happens (only
    // `adapter.invoke()` below actually spawns the fixture).
    process.env[ENV_KEY] = "claims-with-trace";

    const task = "Run the test suite and report whether it passes.";

    // ---- 1. Real Context -> Prompt chain (identical setup to
    // harness.e2e.test.ts / context-prompt.e2e.test.ts, not reinvented) ----
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

    const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
    const prompt = composer.compose("coder", injected, task);

    // Sanity: this really is a composed prompt string, not a stub.
    expect(prompt).toContain("You are the Coder in a two-model coder/tester loop.");
    expect(prompt).toContain(task);

    // ---- 2. In-memory fixture ProfileConfig — NOT the real, committed
    // `profiles/subscription/config.yaml` (that one has no `bin` at all,
    // so `cmd` alone points at the real "codex" binary). `cmd: "codex"`
    // is the unchanged, strict flavor dispatch key (config.ts routes to
    // CodexCliAdapter exactly as it would for the real config.yaml);
    // `bin` is the spawn-target override — an absolute path to the fixture
    // script — the only replaced boundary in this whole slice (see file
    // header, and `config.ts`'s `extractBin()` for why this split exists).
    const fixtureConfig: ProfileConfig = {
      profile: "fixture",
      providers: {
        "codex-cli": { kind: "cli-bridge", cmd: "codex", bin: FAKE_CODEX_FIXTURE },
      },
      roles: { coder: { provider: "codex-cli" } },
    };

    // ---- 3. Real buildAdapterRegistry — the actual cli-bridge dispatch
    // branch (config.ts, B5), not a hand-built FakeAdapter. -----------------
    const registry = buildAdapterRegistry(fixtureConfig);

    // ---- 4. Real ProviderRouter, routing to the real adapter --------------
    const router = new ProviderRouter(fixtureConfig.roles, registry);
    const routedAdapter = router.route("coder");

    // Prove the router really resolved to a real CodexCliAdapter (not a
    // reshaped stand-in, and not the wrong class — B5's dispatch-by-cmd
    // logic is what's under test here). A real `if (!instanceof) throw`
    // guard, not just a vitest `toBeInstanceOf` assertion, so TypeScript
    // actually narrows `adapter`'s type below — `toolTrace()` is optional
    // on the broad `ModelAdapter` interface (direct-api adapters omit it
    // entirely), but concrete and always-present on `CodexCliAdapter`.
    if (!(routedAdapter instanceof CodexCliAdapter)) {
      throw new Error("expected ProviderRouter to resolve a CodexCliAdapter for the \"coder\" role");
    }
    const adapter = routedAdapter;
    expect(adapter.id).toBe("codex-cli");
    expect(adapter.kind).toBe("cli-bridge");

    // ---- 5. Real SchemaValidator, driving the routed adapter through the
    // real composed prompt — this call really spawns the fixture subprocess
    // (fake-codex.fixture.mjs), parses its real stdout, and computes a real
    // ToolExecVerifier verdict. -------------------------------------------
    const validator = new SchemaValidator();
    const { data, result, attempts } = await validator.validate({
      schema: CoderOutput,
      request: { role: "coder", prompt },
      invoke: (req) => adapter.invoke(req),
    });

    // ---- 6. Assertions on the final typed result ---------------------
    expect(attempts).toBe(1);
    expect(result.provider).toBe("codex-cli");

    // `data` is a typed CoderOutput — not just "parsed JSON", the zod
    // schema actually accepted its shape (produced by the fixture's
    // "claims-with-trace" scenario, which is deliberately CoderOutput-shaped).
    // Narrow via the shared guard (schema.ts's `isCoderOutputChanged`) before
    // reading `.diff` — issue #47's discriminated union only has that field
    // on the "changed" variant.
    if (!isCoderOutputChanged(data)) {
      throw new Error(`expected a "changed" CoderOutput, got status "${data.status}"`);
    }
    expect(data.diff).toContain("+new");
    expect(data.confidence).toBe("verified");
    expect(data.claims).toHaveLength(1);
    expect(data.claims[0]?.verifiedBy).toBe("tool_execution");

    // The end-to-end "pass" path: the claim asserted tool_execution AND the
    // real parsed trace is non-empty — ToolExecVerifier's core job, proven
    // here through the whole real chain, not just at the adapter unit-test
    // layer (codex-cli-adapter.test.ts already covers that layer; this
    // slice's job is proving the seam between it and everything upstream).
    expect(result.toolExecChecked).toBe("pass");

    // adapter.toolTrace() reflects the real command_execution event the
    // fixture printed, readable after invoke() via the adapter's own
    // stateful query method (not re-derived here — proves the same trace
    // ToolExecVerifier consulted is externally observable too).
    const trace = adapter.toolTrace();
    expect(trace.length).toBeGreaterThan(0);
    expect(trace[0]?.toolName).toBe("shell");
  });
});
