import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store.js";
import { SystemConfig } from "../config.js";
import { StalenessEngine } from "../staleness.js";
import { ContextInjector, CORE_MEMORY_TYPES } from "../injector.js";
import { RecallError } from "../errors.js";

const NOW = "2026-07-20T00:00:00.000Z";

const openStores: MemoryStore[] = [];
function setup(): { store: MemoryStore; injector: ContextInjector } {
  const store = new MemoryStore(":memory:");
  openStores.push(store);
  const config = new SystemConfig(store);
  config.set("default_stale_days", "30", NOW);
  const staleness = new StalenessEngine(config);
  return { store, injector: new ContextInjector(store, staleness) };
}

afterEach(() => {
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("ContextInjector — rejected memories are filtered out (PRD §8 required test)", () => {
  it("a memory with confidence_state === 'rejected' never appears in the injection result", () => {
    const { store, injector } = setup();
    const confirmed = store.insertMemory(
      { type: "decision", title: "Confirmed", content: "kept", confidenceState: "confirmed" },
      NOW,
    );
    const rejected = store.insertMemory(
      { type: "decision", title: "Rejected", content: "must not appear", confidenceState: "rejected" },
      NOW,
    );

    const result = injector.inject(undefined, new Date(NOW));

    const ids = result.memories.map((m) => m.memory.id);
    expect(ids).toContain(confirmed.id);
    expect(ids).not.toContain(rejected.id);
  });

  it("a memory recalled via FTS keyword match is still filtered if rejected", () => {
    const { store, injector } = setup();
    const rejected = store.insertMemory(
      { type: "decision", title: "Zebra plan", content: "rejected zebra content", confidenceState: "rejected" },
      NOW,
    );

    const result = injector.inject("zebra", new Date(NOW));

    expect(result.memories.map((m) => m.memory.id)).not.toContain(rejected.id);
  });
});

describe("ContextInjector — stale/unconfirmed are kept, not filtered, and carry a warning", () => {
  it("an unconfirmed memory stays in the result with warning='unconfirmed'", () => {
    const { store, injector } = setup();
    const memory = store.insertMemory(
      { type: "decision", title: "New idea", content: "not yet reviewed", confidenceState: "unconfirmed" },
      NOW,
    );

    const result = injector.inject(undefined, new Date(NOW));

    const entry = result.memories.find((m) => m.memory.id === memory.id);
    expect(entry).toBeDefined();
    expect(entry?.warning).toBe("unconfirmed");
  });

  it("a stale confirmed memory stays in the result with warning='stale'", () => {
    const { store, injector } = setup();
    const memory = store.insertMemory(
      { type: "constraint", title: "Old constraint", content: "aging", confidenceState: "confirmed" },
      NOW,
    );
    const asOf = new Date("2026-09-01T00:00:00.000Z"); // well past 30-day default threshold

    const result = injector.inject(undefined, asOf);

    const entry = result.memories.find((m) => m.memory.id === memory.id);
    expect(entry).toBeDefined();
    expect(entry?.warning).toBe("stale");
  });

  it("a fresh confirmed memory carries no warning", () => {
    const { store, injector } = setup();
    const memory = store.insertMemory(
      { type: "constraint", title: "Fresh", content: "just written", confidenceState: "confirmed" },
      NOW,
    );

    const result = injector.inject(undefined, new Date(NOW));

    const entry = result.memories.find((m) => m.memory.id === memory.id);
    expect(entry?.warning).toBeNull();
  });

  it("a memory that is both stale and unconfirmed reports 'stale' (documented priority)", () => {
    const { store, injector } = setup();
    const memory = store.insertMemory(
      { type: "decision", title: "Old + unreviewed", content: "x", confidenceState: "unconfirmed" },
      NOW,
    );
    const asOf = new Date("2026-09-01T00:00:00.000Z");

    const result = injector.inject(undefined, asOf);

    expect(result.memories.find((m) => m.memory.id === memory.id)?.warning).toBe("stale");
  });
});

describe("ContextInjector — core vs. recalled (review: the old implementation made FTS5 recall dead code)", () => {
  it("CORE_MEMORY_TYPES is the documented always-want set: identity/constraint/decision", () => {
    expect([...CORE_MEMORY_TYPES].sort()).toEqual(["constraint", "decision", "identity"]);
  });

  it("a non-core, non-matching memory is absent from the result with no query", () => {
    const { store, injector } = setup();
    const nonCore = store.insertMemory(
      { type: "active_task", title: "Session-scoped task", content: "not core, not queried" },
      NOW,
    );

    const result = injector.inject(undefined, new Date(NOW));

    expect(result.memories.map((m) => m.memory.id)).not.toContain(nonCore.id);
  });

  it("that same non-core memory appears only once its keywords are actually queried", () => {
    const { store, injector } = setup();
    const nonCore = store.insertMemory(
      { type: "active_task", title: "Giraffe task", content: "mentions a giraffe explicitly" },
      NOW,
    );

    const withoutQuery = injector.inject(undefined, new Date(NOW));
    expect(withoutQuery.memories.map((m) => m.memory.id)).not.toContain(nonCore.id);

    const withQuery = injector.inject("giraffe", new Date(NOW));
    expect(withQuery.memories.map((m) => m.memory.id)).toContain(nonCore.id);
  });

  it("a core-type memory is present even with no query and no keyword match", () => {
    const { store, injector } = setup();
    const core = store.insertMemory({ type: "identity", title: "Always in core", content: "core content" }, NOW);

    const result = injector.inject(undefined, new Date(NOW));

    expect(result.memories.map((m) => m.memory.id)).toContain(core.id);
  });

  it("merges FTS keyword hits into the core full-recall set, deduped by id", () => {
    const { store, injector } = setup();
    const core = store.insertMemory({ type: "constraint", title: "Always in core", content: "core content" }, NOW);
    const recalled = store.insertMemory(
      { type: "decision", title: "Giraffe decision", content: "mentions a giraffe explicitly" },
      NOW,
    );

    const result = injector.inject("giraffe", new Date(NOW));

    const ids = result.memories.map((m) => m.memory.id);
    expect(ids).toContain(core.id);
    expect(ids).toContain(recalled.id);
    // no duplicate entries for a memory present in both the core set and the recall hits
    expect(ids.filter((id) => id === core.id)).toHaveLength(1);
  });

  it("with no query, only the core set is returned — a non-core memory with no query is excluded", () => {
    const { store, injector } = setup();
    const core = store.insertMemory({ type: "identity", title: "Core", content: "always here" }, NOW);
    store.insertMemory({ type: "idea", title: "Non-core", content: "session-scoped, no query given" }, NOW);

    const result = injector.inject(undefined, new Date(NOW));

    expect(result.memories.map((m) => m.memory.id)).toEqual([core.id]);
  });
});

describe("ContextInjector — RecallError propagates, is never swallowed into an empty result", () => {
  it("a real SQLite-level recall failure propagates out of inject()", () => {
    const { store, injector } = setup();
    store.insertMemory({ type: "identity", title: "A", content: "a" }, NOW);
    (store as unknown as { db: import("better-sqlite3").Database }).db.exec("DROP TABLE memories_fts");

    expect(() => injector.inject("anything", new Date(NOW))).toThrow(RecallError);
  });
});
