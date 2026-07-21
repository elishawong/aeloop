import { describe, expect, it } from "vitest";
import { buildPromptDelta } from "../delta.js";

describe("buildPromptDelta", () => {
  it("sends only changed dynamic fields and records a stable hash", () => {
    const delta = buildPromptDelta({ stable: "system-v1", dynamic: { task: "same", feedback: "old" } }, { stable: "system-v1", dynamic: { task: "same", feedback: "new", gate: "G1" } });
    expect(delta.changed).toEqual({ feedback: "new", gate: "G1" });
    expect(delta.removed).toEqual([]);
    expect(delta.estimatedTokens).toBeGreaterThan(0);
    expect(delta.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
