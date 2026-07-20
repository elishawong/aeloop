import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";
import { MemoryNotFoundError, MemoryTagsParseError, RecallError } from "./errors.js";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

/** Every test opens its own in-memory db — nothing shared across tests. */
const openStores: MemoryStore[] = [];
function openStore(): MemoryStore {
  const store = new MemoryStore(":memory:");
  openStores.push(store);
  return store;
}

afterEach(() => {
  while (openStores.length > 0) {
    openStores.pop()?.close();
  }
});

describe("MemoryStore — schema", () => {
  it("creates memories/memory_confirmations/system_config + memories_fts with all PRD §4.1 columns", () => {
    const store = openStore();
    // Round-trip a memory through every §4.1 column, including the four
    // aeloop-added ones (confirmed_at/confirmed_by on memories, actor on
    // memory_confirmations, updated_at on system_config).
    const memory = store.insertMemory(
      {
        type: "decision",
        title: "T",
        content: "C",
        sourceFile: "docs/DESIGN.md",
        tags: ["a", "b"],
        confidenceState: "unconfirmed",
        staleOverrideDays: 7,
      },
      NOW,
    );
    expect(memory).toMatchObject({
      type: "decision",
      title: "T",
      content: "C",
      sourceFile: "docs/DESIGN.md",
      tags: ["a", "b"],
      confidenceState: "unconfirmed",
      staleOverrideDays: 7,
      createdAt: NOW,
      updatedAt: NOW,
      confirmedAt: null,
      confirmedBy: null,
    });

    const updated = store.updateMemoryConfidence(memory.id, {
      confidenceState: "confirmed",
      confirmedAt: LATER,
      confirmedBy: "elisha",
      updatedAt: LATER,
    });
    expect(updated.confirmedAt).toBe(LATER);
    expect(updated.confirmedBy).toBe("elisha");

    const confirmation = store.insertConfirmation(
      { memoryId: memory.id, action: "confirm", oldContent: null, newContent: null, actor: "elisha" },
      LATER,
    );
    expect(confirmation.actor).toBe("elisha");

    const configEntry = store.setConfigEntry("default_stale_days", "30", LATER);
    expect(configEntry.updatedAt).toBe(LATER);
    expect(store.getConfigEntry("default_stale_days")).toEqual(configEntry);
  });

  it("is idempotent — reopening the same db file does not error on CREATE TABLE/TRIGGER", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "aeloop-store-test-"));
    const dbPath = path.join(dir, "memory.db");
    try {
      const store1 = new MemoryStore(dbPath);
      store1.insertMemory({ type: "idea", title: "x", content: "y" }, NOW);
      store1.close();

      // Reopening must not throw despite tables/triggers already existing.
      const store2 = new MemoryStore(dbPath);
      expect(store2.listMemories()).toHaveLength(1);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MemoryStore — CRUD", () => {
  it("insertMemory defaults tags to [] and confidenceState to unconfirmed", () => {
    const store = openStore();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);
    expect(memory.tags).toEqual([]);
    expect(memory.confidenceState).toBe("unconfirmed");
    expect(memory.sourceFile).toBeNull();
    expect(memory.staleOverrideDays).toBeNull();
  });

  it("getMemoryById returns undefined (not an error) for a missing id", () => {
    const store = openStore();
    expect(store.getMemoryById(999)).toBeUndefined();
  });

  it("listMemories returns all rows ordered by id", () => {
    const store = openStore();
    const a = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);
    const b = store.insertMemory({ type: "idea", title: "B", content: "b" }, NOW);
    expect(store.listMemories().map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("deleteMemory removes the row", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);
    store.deleteMemory(m.id);
    expect(store.getMemoryById(m.id)).toBeUndefined();
  });

  it("updateMemoryConfidence throws MemoryNotFoundError for a missing id", () => {
    const store = openStore();
    expect(() =>
      store.updateMemoryConfidence(999, {
        confidenceState: "confirmed",
        confirmedAt: NOW,
        confirmedBy: "elisha",
        updatedAt: NOW,
      }),
    ).toThrow(MemoryNotFoundError);
  });

  it("updateMemoryContent throws MemoryNotFoundError for a missing id", () => {
    const store = openStore();
    expect(() => store.updateMemoryContent(999, "new content", NOW)).toThrow(MemoryNotFoundError);
  });

  it("getConfirmationsForMemory returns [] (not an error) when none exist yet", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);
    expect(store.getConfirmationsForMemory(m.id)).toEqual([]);
  });

  it("getConfigEntry returns undefined for an unset key", () => {
    const store = openStore();
    expect(store.getConfigEntry("nope")).toBeUndefined();
  });

  it("setConfigEntry upserts (second call overwrites value + updated_at)", () => {
    const store = openStore();
    store.setConfigEntry("default_stale_days", "30", NOW);
    const second = store.setConfigEntry("default_stale_days", "45", LATER);
    expect(second).toEqual({ key: "default_stale_days", value: "45", updatedAt: LATER });
    expect(store.getConfigEntry("default_stale_days")).toEqual(second);
  });
});

describe("MemoryStore — tags JSON parse errors are typed, never a raw SyntaxError", () => {
  it("throws MemoryTagsParseError when the stored tags column isn't valid JSON", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);
    // Corrupt the stored value directly — simulates data written by a
    // future buggy caller that bypasses insertMemory's JSON.stringify.
    (store as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("UPDATE memories SET tags = ? WHERE id = ?")
      .run("{not valid json", m.id);

    let thrown: unknown;
    try {
      store.getMemoryById(m.id);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MemoryTagsParseError);
    expect((thrown as Error).name).toBe("MemoryTagsParseError");
    expect((thrown as MemoryTagsParseError).memoryId).toBe(m.id);
  });

  it("throws MemoryTagsParseError when tags parses but isn't an array of strings", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);
    (store as unknown as { db: import("better-sqlite3").Database }).db
      .prepare("UPDATE memories SET tags = ? WHERE id = ?")
      .run(JSON.stringify({ not: "an array" }), m.id);

    expect(() => store.getMemoryById(m.id)).toThrow(MemoryTagsParseError);
  });
});

describe("MemoryStore — FTS5 recall", () => {
  it("searchMemories finds memories by keyword in title or content", () => {
    const store = openStore();
    const match = store.insertMemory(
      { type: "decision", title: "Use pnpm", content: "Chosen for workspace speed." },
      NOW,
    );
    store.insertMemory({ type: "idea", title: "Unrelated", content: "Something about bananas." }, NOW);

    const results = store.searchMemories("pnpm");
    expect(results.map((m) => m.id)).toEqual([match.id]);
  });

  it("searchMemories returns [] (a successful empty result) for no matches — not an error", () => {
    const store = openStore();
    store.insertMemory({ type: "idea", title: "A", content: "nothing relevant" }, NOW);
    expect(store.searchMemories("zzznomatchzzz")).toEqual([]);
  });

  it("keeps the FTS index in sync on update (old keyword stops matching, new keyword starts)", () => {
    const store = openStore();
    const m = store.insertMemory(
      { type: "decision", title: "Fixed title", content: "mentions workspace tooling" },
      NOW,
    );
    expect(store.searchMemories("workspace").map((r) => r.id)).toContain(m.id);

    store.updateMemoryContent(m.id, "mentions zebra instead", LATER);

    expect(store.searchMemories("workspace").map((r) => r.id)).not.toContain(m.id);
    expect(store.searchMemories("zebra").map((r) => r.id)).toContain(m.id);
  });

  it("keeps the FTS index in sync on delete (deleted memory stops matching)", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "decision", title: "Fixed title", content: "mentions giraffe" }, NOW);
    expect(store.searchMemories("giraffe").map((r) => r.id)).toContain(m.id);

    store.deleteMemory(m.id);

    expect(store.searchMemories("giraffe").map((r) => r.id)).not.toContain(m.id);
  });

  it("RecallError trigger path: a malformed FTS5 query string throws RecallError, not a raw SqliteError, and never silently returns []", () => {
    const store = openStore();
    store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);

    // An unterminated quoted phrase is invalid FTS5 MATCH syntax.
    let thrown: unknown;
    try {
      store.searchMemories('"unterminated phrase');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallError);
    expect((thrown as Error).name).toBe("RecallError");
  });
});

describe("MemoryStore — transactions", () => {
  it("runInTransaction rolls back all writes when the callback throws", () => {
    const store = openStore();
    const m = store.insertMemory({ type: "idea", title: "A", content: "a" }, NOW);

    expect(() =>
      store.runInTransaction(() => {
        store.updateMemoryConfidence(m.id, {
          confidenceState: "confirmed",
          confirmedAt: NOW,
          confirmedBy: "elisha",
          updatedAt: NOW,
        });
        store.insertConfirmation(
          { memoryId: m.id, action: "confirm", oldContent: null, newContent: null, actor: "elisha" },
          NOW,
        );
        throw new Error("simulated mid-transaction failure");
      }),
    ).toThrow("simulated mid-transaction failure");

    const after = store.getMemoryById(m.id);
    expect(after?.confidenceState).toBe("unconfirmed");
    expect(store.getConfirmationsForMemory(m.id)).toEqual([]);
  });
});
