/**
 * `renderDiff()` unit tests (PRD §6.1 / §8 B1). Asserts against real ANSI
 * escape substrings, not a stripped/plain string — the PRD's own acceptance
 * criterion (§10) is "diff renders with real ANSI color codes present ...
 * not just an uncolored control-character-stripped string".
 */
import { describe, expect, it } from "vitest";
import { renderDiff } from "../diff-render.js";

const GREEN = "[32m";
const RED = "[31m";
const CYAN = "[36m";
const BOLD = "[1m";
const RESET = "[39m";

describe("renderDiff", () => {
  it("colors +++/--- file-header lines bold", () => {
    const out = renderDiff("--- a/example.ts\n+++ b/example.ts\n");
    const lines = out.split("\n");
    expect(lines[0]).toContain(BOLD);
    expect(lines[0]).toContain("--- a/example.ts");
    expect(lines[1]).toContain(BOLD);
    expect(lines[1]).toContain("+++ b/example.ts");
  });

  it("colors @@ hunk headers cyan", () => {
    const out = renderDiff("@@ -1 +1 @@\n");
    expect(out).toContain(CYAN);
    expect(out).toContain("@@ -1 +1 @@");
  });

  it("colors +-prefixed (non +++) lines green", () => {
    const out = renderDiff("+new line\n");
    expect(out).toContain(GREEN);
    expect(out).toContain("+new line");
  });

  it("colors --prefixed (non ---) lines red", () => {
    const out = renderDiff("-old line\n");
    expect(out).toContain(RED);
    expect(out).toContain("-old line");
  });

  it("leaves plain context lines uncolored", () => {
    const out = renderDiff(" unchanged context line\n");
    expect(out).not.toContain(GREEN);
    expect(out).not.toContain(RED);
    expect(out).not.toContain(CYAN);
    expect(out).toContain(" unchanged context line");
  });

  it("+++/--- file-header lines are bold, not green/red (checked before the single-char +/- rule)", () => {
    const out = renderDiff("+++ b/example.ts\n--- a/example.ts\n");
    expect(out).not.toContain(GREEN);
    expect(out).not.toContain(RED);
  });

  it("handles a realistic multi-hunk unified diff end to end (best-effort, not a strict parser)", () => {
    const diff = "--- a/example.ts\n+++ b/example.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n unchanged\n";
    const out = renderDiff(diff);
    const lines = out.split("\n");
    expect(lines).toHaveLength(7); // 6 real lines + trailing empty from the final \n
    expect(lines[0]).toContain(BOLD); // ---
    expect(lines[1]).toContain(BOLD); // +++
    expect(lines[2]).toContain(CYAN); // @@
    expect(lines[3]).toContain(RED); // -old
    expect(lines[4]).toContain(GREEN); // +new
    expect(lines[5]).not.toContain(GREEN); // unchanged context line, plain
    expect(lines[5]).not.toContain(RED);
    expect(lines[6]).toBe(""); // trailing split artifact from the final \n, unchanged
  });

  it("does not throw on input that isn't strictly-formatted unified diff (best-effort, not a validator — PRD §0/§6.1)", () => {
    expect(() => renderDiff("not a diff at all, just prose describing the change")).not.toThrow();
    expect(() => renderDiff("")).not.toThrow();
  });

  it("strips a real embedded terminal control sequence from the diff before rendering it (P1-4, test-report.md) — a model can't smuggle a clear-screen/cursor-move payload into what a human reviews", () => {
    const ESC = "\x1B";
    const malicious = `-old\n+new${ESC}[2J${ESC}[Hfake clean line\n`;
    const out = renderDiff(malicious);
    // Only the ANSI codes chalk itself added should remain — the injected [2J/[H sequences are gone.
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[H`);
    expect(out).toContain("fake clean line"); // the literal text survives — sanitization strips control bytes, not content
  });

  it("resets color at the end of each colored line (chalk's own reset behavior, sanity-checked)", () => {
    const out = renderDiff("+new\n");
    expect(out).toContain(RESET);
  });
});
