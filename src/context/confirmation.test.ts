import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "./store.js";
import { ConfirmationService } from "./confirmation.js";
import { MemoryNotFoundError } from "./errors.js";

const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-20T01:00:00.000Z";

const openStores: MemoryStore[] = [];
function setup(): { store: MemoryStore; service: ConfirmationService } {
  const store = new MemoryStore(":memory:");
  openStores.push(store);
  return { store, service: new ConfirmationService(store) };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (openStores.length > 0) openStores.pop()?.close();
});

describe("ConfirmationService.confirm()", () => {
  it("marks the memory confirmed and records a confirm audit row", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);

    const updated = service.confirm(memory.id, "elisha", NOW);

    expect(updated.confidenceState).toBe("confirmed");
    expect(updated.confirmedAt).toBe(NOW);
    expect(updated.confirmedBy).toBe("elisha");

    const history = store.getConfirmationsForMemory(memory.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: "confirm",
      oldContent: null,
      newContent: null,
      actor: "elisha",
    });
  });

  it("throws MemoryNotFoundError for a missing memory id, without writing anything", () => {
    const { store, service } = setup();
    expect(() => service.confirm(999, "elisha", NOW)).toThrow(MemoryNotFoundError);
    expect(store.getConfirmationsForMemory(999)).toEqual([]);
  });
});

describe("ConfirmationService.correct() — 'latest content' semantics (PRD §9.0#5)", () => {
  it("no prior memory_confirmations row: old_content comes from the memory's original content", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "original" }, NOW);
    expect(store.getConfirmationsForMemory(memory.id)).toEqual([]); // missing-history path

    const updated = service.correct(memory.id, "corrected once", "elisha", NOW);

    expect(updated.content).toBe("corrected once");
    expect(updated.confidenceState).toBe("confirmed");
    expect(updated.confirmedAt).toBe(NOW);
    expect(updated.confirmedBy).toBe("elisha");

    const history = store.getConfirmationsForMemory(memory.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      action: "correct",
      oldContent: "original",
      newContent: "corrected once",
      actor: "elisha",
    });
  });

  it("with a prior correction: old_content is the latest content, not the original insert", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "original" }, NOW);
    service.correct(memory.id, "corrected once", "elisha", NOW);

    const updated = service.correct(memory.id, "corrected twice", "elisha", LATER);

    expect(updated.content).toBe("corrected twice");
    const history = store.getConfirmationsForMemory(memory.id);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      action: "correct",
      oldContent: "corrected once", // NOT "original" — proves "latest" chaining
      newContent: "corrected twice",
    });
  });

  it("throws MemoryNotFoundError for a missing memory id, without writing anything", () => {
    const { store, service } = setup();
    expect(() => service.correct(999, "x", "elisha", NOW)).toThrow(MemoryNotFoundError);
    expect(store.getConfirmationsForMemory(999)).toEqual([]);
  });
});

describe("ConfirmationService.reject()", () => {
  it("marks the memory rejected and records a reject audit row", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);

    const updated = service.reject(memory.id, "elisha", NOW);

    expect(updated.confidenceState).toBe("rejected");
    const history = store.getConfirmationsForMemory(memory.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ action: "reject", oldContent: "C", newContent: null, actor: "elisha" });
  });

  it("preserves confirmed_at/confirmed_by from a prior confirm() — reject doesn't erase that history", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);
    service.confirm(memory.id, "elisha", NOW);

    const rejected = service.reject(memory.id, "someone-else", LATER);

    expect(rejected.confidenceState).toBe("rejected");
    expect(rejected.confirmedAt).toBe(NOW); // untouched, not wiped/updated
    expect(rejected.confirmedBy).toBe("elisha"); // untouched
    // the reject action itself is still fully attributed in the audit trail
    const history = store.getConfirmationsForMemory(memory.id);
    expect(history[1]).toMatchObject({ action: "reject", actor: "someone-else" });
  });

  it("throws MemoryNotFoundError for a missing memory id, without writing anything", () => {
    const { store, service } = setup();
    expect(() => service.reject(999, "elisha", NOW)).toThrow(MemoryNotFoundError);
    expect(store.getConfirmationsForMemory(999)).toEqual([]);
  });

  it("correct() -> reject(): preserves the confirmed_at/confirmed_by set by the prior correct(), not wiped by reject() (locks the documented, disputable behavior — Zorro review suggestion, protects against silent drift)", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "original" }, NOW);

    const corrected = service.correct(memory.id, "corrected content", "elisha", NOW);
    expect(corrected.confidenceState).toBe("confirmed"); // correct() also confirms, per class doc
    expect(corrected.confirmedAt).toBe(NOW);
    expect(corrected.confirmedBy).toBe("elisha");

    const rejected = service.reject(memory.id, "zorro", LATER);

    expect(rejected.confidenceState).toBe("rejected");
    expect(rejected.content).toBe("corrected content"); // reject() never touches content
    // The disputed behavior this test locks down: reject() preserves the
    // confirmed_at/confirmed_by written by the *preceding correct() call*
    // — not just a preceding confirm() (already covered above) — because
    // correct() itself sets those same two columns as part of "a
    // correction is itself an act of confirming the corrected text"
    // (confirmation.ts class doc).
    expect(rejected.confirmedAt).toBe(NOW);
    expect(rejected.confirmedBy).toBe("elisha");

    const history = store.getConfirmationsForMemory(memory.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ action: "correct", actor: "elisha" });
    expect(history[1]).toMatchObject({ action: "reject", actor: "zorro", oldContent: "corrected content" });
  });
});

describe("ConfirmationService — transaction atomicity (PRD §8 acceptance criterion)", () => {
  it("confirm(): a failure after the memories write but before the confirmation insert rolls back both", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);

    vi.spyOn(store, "insertConfirmation").mockImplementation(() => {
      throw new Error("simulated failure between the two writes");
    });

    expect(() => service.confirm(memory.id, "elisha", NOW)).toThrow(
      "simulated failure between the two writes",
    );

    // memories write must have been rolled back too — not left half-applied
    const after = store.getMemoryById(memory.id);
    expect(after?.confidenceState).toBe("unconfirmed");
    expect(after?.confirmedAt).toBeNull();
    expect(after?.confirmedBy).toBeNull();
    expect(store.getConfirmationsForMemory(memory.id)).toEqual([]);
  });

  it("correct(): a failure after the content write rolls back the content change too", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "original" }, NOW);

    vi.spyOn(store, "insertConfirmation").mockImplementation(() => {
      throw new Error("simulated failure between the writes");
    });

    expect(() => service.correct(memory.id, "should not persist", "elisha", NOW)).toThrow(
      "simulated failure between the writes",
    );

    const after = store.getMemoryById(memory.id);
    expect(after?.content).toBe("original"); // content write rolled back
    expect(after?.confidenceState).toBe("unconfirmed"); // confidence write rolled back
    expect(store.getConfirmationsForMemory(memory.id)).toEqual([]);
  });

  it("reject(): a failure after the memories write rolls back the confidence_state flip", () => {
    const { store, service } = setup();
    const memory = store.insertMemory({ type: "idea", title: "T", content: "C" }, NOW);

    vi.spyOn(store, "insertConfirmation").mockImplementation(() => {
      throw new Error("simulated failure between the writes");
    });

    expect(() => service.reject(memory.id, "elisha", NOW)).toThrow(
      "simulated failure between the writes",
    );

    const after = store.getMemoryById(memory.id);
    expect(after?.confidenceState).toBe("unconfirmed"); // NOT left as "rejected"
    expect(store.getConfirmationsForMemory(memory.id)).toEqual([]);
  });
});
