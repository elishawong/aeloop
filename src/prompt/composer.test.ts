import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../profile/loader.js";
import type { ContextInjectionResult } from "../context/injector.js";
import { PromptComposer } from "./composer.js";
import { PersonaNotFoundError } from "./personas.js";

const HELIX_PERSONAS_DIR = path.join(resolveProfileDir("helix"), "personas");

const tmpDirs: string[] = [];
function makeTmpPersonasDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aeloop-composer-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a structurally-valid `ContextInjectionResult` by hand, no store/injector involved. */
function makeContext(
  entries: Array<{ title: string; content: string; warning: "stale" | "unconfirmed" | null; confidenceState?: "unconfirmed" | "confirmed" | "rejected" }>,
): ContextInjectionResult {
  return {
    memories: entries.map((e, i) => ({
      memory: {
        id: i + 1,
        type: "decision",
        title: e.title,
        content: e.content,
        sourceFile: null,
        tags: [],
        confidenceState: e.confidenceState ?? "confirmed",
        staleOverrideDays: null,
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
        confirmedAt: null,
        confirmedBy: null,
      },
      warning: e.warning,
    })),
  };
}

describe("PromptComposer — coder role (real committed helix persona + real CoderOutput schema)", () => {
  it("includes the persona text, the CoderOutput schema, the task, and injected memories", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([{ title: "House rule", content: "prefer smallest correct change", warning: null }]);

    const prompt = composer.compose("coder", context, "Implement the widget resize handler.");

    expect(prompt).toContain("You are the Coder in a two-model coder/tester loop.");
    expect(prompt).toContain('"diff"');
    expect(prompt).toContain('"claims"');
    expect(prompt).toContain("Implement the widget resize handler.");
    expect(prompt).toContain("House rule");
    expect(prompt).toContain("prefer smallest correct change");
  });

  it("does not include a warning tag for a memory with warning: null", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([{ title: "Fresh fact", content: "no issues", warning: null }]);

    const prompt = composer.compose("coder", context, "task");

    expect(prompt).not.toContain("[warning:");
  });

  it("includes a visible warning tag for a stale memory", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([{ title: "Old fact", content: "may be outdated", warning: "stale" }]);

    const prompt = composer.compose("coder", context, "task");

    expect(prompt).toContain("[warning: stale] Old fact");
  });

  it("includes a visible warning tag for an unconfirmed memory", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([{ title: "Unreviewed fact", content: "not yet confirmed", warning: "unconfirmed" }]);

    const prompt = composer.compose("coder", context, "task");

    expect(prompt).toContain("[warning: unconfirmed] Unreviewed fact");
  });
});

describe("PromptComposer — tester role (real committed helix persona + real TesterOutput schema)", () => {
  it("includes the tester persona text and the TesterOutput schema", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([]);

    const prompt = composer.compose("tester", context, "Review the diff for the resize handler.");

    expect(prompt).toContain("adversarially");
    expect(prompt).toContain('"verdict"');
    expect(prompt).toContain('"issues"');
    expect(prompt).toContain("Review the diff for the resize handler.");
  });

  it("renders '(no memories injected)' when the context has none", () => {
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const prompt = composer.compose("tester", makeContext([]), "task");

    expect(prompt).toContain("(no memories injected)");
  });
});

describe("PromptComposer — role with a persona but no entry in the output-schema registry", () => {
  it("omits the Output Schema section instead of throwing", () => {
    const dir = makeTmpPersonasDir();
    writeFileSync(path.join(dir, "reviewer.md"), "# Reviewer\n\nBe thorough.\n", "utf-8");
    const composer = new PromptComposer(dir);

    const prompt = composer.compose("reviewer", makeContext([]), "task");

    expect(prompt).toContain("Be thorough.");
    expect(prompt).not.toContain("# Output Schema");
  });
});

describe("PromptComposer — unknown role with no persona file at all", () => {
  it("propagates PersonaNotFoundError rather than composing a broken prompt", () => {
    const dir = makeTmpPersonasDir();
    const composer = new PromptComposer(dir);

    expect(() => composer.compose("ghost-role", makeContext([]), "task")).toThrow(PersonaNotFoundError);
  });
});

describe("PromptComposer — does not re-filter by confidenceState (PRD: rejected already filtered upstream)", () => {
  it("renders an entry verbatim even if its underlying memory.confidenceState is 'rejected'", () => {
    // Simulates a hand-built (not really possible via the real ContextInjector,
    // which already drops rejected memories) injection result, to prove this
    // layer has no confidence-based filtering logic of its own to accidentally
    // duplicate or contradict the injector's.
    const composer = new PromptComposer(HELIX_PERSONAS_DIR);
    const context = makeContext([
      { title: "Smuggled rejected content", content: "should still render, composer does not filter", warning: null, confidenceState: "rejected" },
    ]);

    const prompt = composer.compose("coder", context, "task");

    expect(prompt).toContain("Smuggled rejected content");
    expect(prompt).toContain("should still render, composer does not filter");
  });
});
