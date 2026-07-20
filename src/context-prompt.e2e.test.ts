/**
 * B9 — the hardest requirement of A0+A1 (PRD §5 "垂直切片(A1 收尾,硬性交付)"
 * / DESIGN §8.5's "aeloop 每个里程碑收尾必须有一条薄垂直切片真正接通").
 *
 * Verity's M2/M3 shipped layers that each tested green in isolation but
 * were never actually wired together — this test exists specifically to
 * make that failure mode impossible to fake here. It is deliberately NOT a
 * unit test: no mocking, no stubbing, no hand-built fixture objects
 * standing in for a layer. The full real chain, end to end:
 *
 *   1. A real `MemoryStore` backed by a real (in-memory) SQLite database
 *      (`better-sqlite3`, not a fake) — write 3 real rows via
 *      `insertMemory()`: one confirmed, one unconfirmed, one rejected.
 *   2. A real `ContextInjector` (wired to that real store + a real
 *      `StalenessEngine`/`SystemConfig`) — `inject()` reads back from
 *      SQLite and applies the real filtering/warning logic.
 *   3. A real `PromptComposer` (pointed at the real, committed
 *      `profiles/helix/personas/` directory) — `compose()` consumes the
 *      injector's actual return value directly, no intermediate reshaping.
 *   4. Assertions against the final prompt *string* — the one artifact a
 *      Harness-layer caller (A2+) would actually send to a model.
 *
 * If any of these seams were secretly disconnected (e.g. `compose()`
 * silently ignoring its `context` argument, or `inject()` never really
 * calling into `store`), this test would fail — a hand-mocked version of
 * either side could not catch that, which is exactly the gap this test is
 * required to close.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "./profile/loader.js";
import { MemoryStore } from "./context/store.js";
import { SystemConfig } from "./context/config.js";
import { StalenessEngine } from "./context/staleness.js";
import { ContextInjector } from "./context/injector.js";
import { PromptComposer } from "./prompt/composer.js";

const NOW = "2026-07-20T00:00:00.000Z";
const HELIX_PERSONAS_DIR = path.join(resolveProfileDir("helix"), "personas");

const openStores: MemoryStore[] = [];
afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("Context -> Prompt vertical slice (real MemoryStore -> real ContextInjector -> real PromptComposer)", () => {
  it("confirmed content reaches the final prompt, rejected content never does, unconfirmed content reaches it with a visible warning", () => {
    // ---- 1. Real store, real SQLite, real writes ----------------------
    const store = new MemoryStore(":memory:");
    openStores.push(store);

    const confirmed = store.insertMemory(
      {
        type: "decision",
        title: "Build tooling",
        content: "aeloop uses pnpm as its package manager.",
        confidenceState: "confirmed",
      },
      NOW,
    );
    const unconfirmed = store.insertMemory(
      {
        type: "idea",
        title: "Rate limit guess",
        content: "The API rate limit is believed to be 100 requests/min.",
        confidenceState: "unconfirmed",
      },
      NOW,
    );
    const rejected = store.insertMemory(
      {
        type: "decision",
        title: "Wrong database claim",
        content: "The context store uses MySQL for persistence.",
        confidenceState: "rejected",
      },
      NOW,
    );

    // Sanity: all 3 rows really landed in the real database before we go on.
    expect(store.listMemories().map((m) => m.id).sort()).toEqual(
      [confirmed.id, unconfirmed.id, rejected.id].sort(),
    );

    // ---- 2. Real ContextInjector, wired to that same real store -------
    const config = new SystemConfig(store);
    config.set("default_stale_days", "30", NOW);
    const staleness = new StalenessEngine(config);
    const injector = new ContextInjector(store, staleness);

    const injected = injector.inject(undefined, new Date(NOW));

    // Prove the injector really did its job before handing its actual
    // return value (not a reshaped copy) into the composer below.
    const injectedIds = injected.memories.map((m) => m.memory.id);
    expect(injectedIds).toContain(confirmed.id);
    expect(injectedIds).toContain(unconfirmed.id);
    expect(injectedIds).not.toContain(rejected.id);

    // ---- 3. Real PromptComposer, consuming the injector's real output -
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const prompt = composer.compose("coder", injected, "Implement the retry-backoff helper.");

    // ---- 4. Assertions on the actual final prompt string ---------------
    // Confirmed content: present, no warning tag attached to it.
    expect(prompt).toContain("aeloop uses pnpm as its package manager.");
    expect(prompt).toContain("- Build tooling\n  aeloop uses pnpm as its package manager.");

    // Rejected content: must never reach the prompt at all — this is the
    // single assertion the whole slice exists to prove.
    expect(prompt).not.toContain("The context store uses MySQL for persistence.");
    expect(prompt).not.toContain("Wrong database claim");

    // Unconfirmed content: present, but with a visible warning marker.
    expect(prompt).toContain("The API rate limit is believed to be 100 requests/min.");
    expect(prompt).toContain("[warning: unconfirmed] Rate limit guess");

    // The rest of the composed prompt is real too, not just the memory section.
    expect(prompt).toContain("You are the Coder in a two-model coder/tester loop.");
    expect(prompt).toContain('"diff"'); // CoderOutput schema section
    expect(prompt).toContain("Implement the retry-backoff helper.");
  });

  it("a memory rejected via ConfirmationService.reject() (not just inserted pre-rejected) is also filtered out end to end", async () => {
    // Same slice, but exercising the confirmation workflow (B4) rather
    // than inserting a pre-rejected row directly — proves the filtering
    // holds for the realistic path (a memory starts unconfirmed, then
    // gets rejected through the service) too, not only the insert-time
    // shortcut used in the first test.
    const { ConfirmationService } = await import("./context/confirmation.js");

    const store = new MemoryStore(":memory:");
    openStores.push(store);
    const confirmation = new ConfirmationService(store);

    const memory = store.insertMemory(
      { type: "decision", title: "Later rejected", content: "this will be rejected via the service", confidenceState: "unconfirmed" },
      NOW,
    );
    confirmation.reject(memory.id, "zorro", NOW);

    const config = new SystemConfig(store);
    config.set("default_stale_days", "30", NOW);
    const staleness = new StalenessEngine(config);
    const injector = new ContextInjector(store, staleness);
    const injected = injector.inject(undefined, new Date(NOW));

    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const prompt = composer.compose("coder", injected, "task");

    expect(prompt).not.toContain("this will be rejected via the service");
    expect(injected.memories.map((m) => m.memory.id)).not.toContain(memory.id);
  });
});
