/**
 * `stripControlSequences()` unit tests — A5 re-review P1-4
 * (`docs/feature/a5-cli-tui/test-report.md`). Real ANSI/OSC/control-byte
 * strings, not stand-ins — this file's whole point is proving those exact
 * byte sequences are gone from the output.
 */
import { describe, expect, it } from "vitest";
import { stripControlSequences } from "../sanitize-terminal.js";

const ESC = "\x1B";

describe("stripControlSequences", () => {
  it("leaves plain text with no control sequences untouched", () => {
    expect(stripControlSequences("hello world")).toBe("hello world");
  });

  it("preserves \\n and \\t", () => {
    expect(stripControlSequences("line one\nline two\tindented")).toBe("line one\nline two\tindented");
  });

  it("strips a CSI SGR color sequence (the same shape chalk's own output uses)", () => {
    const colored = `${ESC}[32mgreen text${ESC}[39m`;
    expect(stripControlSequences(colored)).toBe("green text");
  });

  it("strips a CSI cursor-movement sequence (e.g. move cursor up)", () => {
    expect(stripControlSequences(`before${ESC}[2Aafter`)).toBe("beforeafter");
  });

  it("strips a CSI clear-screen sequence", () => {
    expect(stripControlSequences(`${ESC}[2J${ESC}[Hfake clean terminal`)).toBe("fake clean terminal");
  });

  it("strips an OSC sequence terminated by BEL (e.g. a terminal-title/hyperlink payload)", () => {
    const osc = `${ESC}]0;fake title\x07visible text`;
    expect(stripControlSequences(osc)).toBe("visible text");
  });

  it("strips an OSC sequence terminated by ST (ESC \\\\)", () => {
    const osc = `${ESC}]8;;http://example.com${ESC}\\link text${ESC}]8;;${ESC}\\`;
    expect(stripControlSequences(osc)).toBe("link text");
  });

  it("strips a bare, unmatched ESC byte with nothing recognizable after it", () => {
    expect(stripControlSequences(`before${ESC}after`)).toBe("beforeafter");
  });

  it("strips \\r (can overwrite a rendered line in place)", () => {
    expect(stripControlSequences("real line\rFAKE OVERWRITE")).toBe("real lineFAKE OVERWRITE");
  });

  it("strips other raw C0 control characters (e.g. \\x07 BEL, \\x08 backspace) outside of any escape sequence", () => {
    expect(stripControlSequences("a\x07b\x08c")).toBe("abc");
  });

  it("strips DEL (0x7F)", () => {
    expect(stripControlSequences("a\x7Fb")).toBe("ab");
  });

  it("a diff-shaped string with an embedded fake-prompt injection payload comes out with only the real diff text", () => {
    const malicious = `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new${ESC}[2J${ESC}[H$ rm -rf /\n`;
    const out = stripControlSequences(malicious);
    expect(out).not.toContain(ESC);
    expect(out).toContain("$ rm -rf /"); // the literal text survives sanitization — only control bytes are stripped, not content
    expect(out).toContain("+new");
  });

  it("does not throw on an empty string", () => {
    expect(stripControlSequences("")).toBe("");
  });

  /**
   * Comment-accuracy regression (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md`):
   * `OTHER_ESCAPE_SEQUENCE`'s comment used to (incorrectly) claim it handles `ESC c` (RIS) and
   * `ESC 7`/`ESC 8` — `c`/`7`/`8` all fall outside that regex's `@-Z\^_` byte class, so no ESC
   * byte survives, no live escape sequence remains — the security property (no control byte
   * survives sanitization) holds either way, via `RAW_CONTROL_CHARS` stripping the bare ESC.
   */
  it("neutralizes ESC c / ESC 7 / ESC 8 by stripping the ESC byte (not via OTHER_ESCAPE_SEQUENCE, which doesn't match c/7/8) — no ESC survives, but the second byte remains as plain text", () => {
    expect(stripControlSequences(`${ESC}c`)).toBe("c");
    expect(stripControlSequences(`${ESC}7`)).toBe("7");
    expect(stripControlSequences(`${ESC}8`)).toBe("8");
  });
});
