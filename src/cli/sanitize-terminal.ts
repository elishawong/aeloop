/**
 * `stripControlSequences()` — A5 re-review P1-4 (`docs/feature/a5-cli-tui/
 * test-report.md`). `diff-render.ts`/`gate-view.ts`/`main.ts`'s `list`
 * command all print model-produced text (`CoderOutput.diff`, `TesterOutput.
 * issues[]`) or user-typed text (`aeloop start "<task>"`'s task string)
 * straight to the real terminal, then wrap *that* in chalk color codes.
 * Nothing before this file stripped ANSI/OSC escape sequences or raw C0/C1
 * control characters from that text first — a model (or, for the `task`
 * string, a human) could embed a real escape sequence (clear-screen, cursor
 * repositioning, a fake `$ ` prompt, an OSC terminal-title/hyperlink
 * sequence) inside a diff line or an issue string, and it would render for
 * real when printed, undermining the human reviewer's ability to trust what
 * G1/G2/G3/Escalation actually show them — which is the entire point of
 * having a human-in-the-loop gate at all (PRD §0's framing).
 *
 * This is deliberately narrow: strip control sequences, keep `\n`/`\t`
 * (the two whitespace control characters real diff/issue text legitimately
 * needs), and otherwise leave the text's actual characters untouched. Not a
 * general-purpose terminal sanitizer library — just enough to remove a
 * model's ability to control the terminal cursor/screen/title through text
 * this file's callers are going to print verbatim.
 */

// OSC (Operating System Command) sequences: ESC ] ... (BEL | ESC \). Checked first —
// it also starts with ESC, so it must be stripped before the generic CSI/control-char
// passes would otherwise leave its body partially intact.
const OSC_SEQUENCE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;

// CSI (Control Sequence Introducer) sequences: ESC [ <parameter bytes> <intermediate bytes> <final byte>.
// Covers cursor movement, SGR color codes, screen/line clears, etc. — the standard shape chalk's
// own output uses, and the standard shape a malicious cursor-control payload would use too.
const CSI_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

// Other two-character "Fe" escape sequences (ESC followed by a single `@`-`Z`, `\`, `^`, or `_`
// byte — 0x40-0x5A, 0x5C, 0x5E, 0x5F) not covered by CSI/OSC above. **Comment correction (Zorro R2
// re-review, `docs/feature/a5-cli-tui/test-report.md`)**: this used to claim the regex here
// handles "ESC c (RIS, full terminal reset)" and "ESC 7/8 (save/restore cursor)" — it does not:
// `c` (0x63), `7` (0x37), and `8` (0x38) all fall outside this class's byte range. Those
// particular sequences are still rendered harmless — not by this regex, but by
// `RAW_CONTROL_CHARS` below stripping the leading ESC byte itself, which breaks the two-byte
// sequence apart. What's left behind after that is the sequence's second byte as an ordinary
// visible character (e.g. `ESC c` becomes a bare `c`, `ESC 7` becomes a bare `7`) — inert text,
// not a live escape sequence, so the security property (no control byte survives) still holds;
// only the illustrative examples in this comment were wrong about *which* mechanism neutralizes
// them.
const OTHER_ESCAPE_SEQUENCE = /\x1B[@-Z\\^_]/g;

// Remaining raw C0 control characters (0x00-0x1F) and DEL (0x7F), excluding \t (0x09) and \n
// (0x0A) — includes a stray, unmatched ESC (0x1B) and \r (0x0D, which can overwrite a rendered
// line in place). Plus the C1 control range (U+0080-U+009F, some terminals' 8-bit-encoded
// equivalent of ESC-prefixed sequences).
const RAW_CONTROL_CHARS = /[\x00-\x08\x0B-\x1F\x7F\x80-\x9F]/g;

export function stripControlSequences(text: string): string {
  return text.replace(OSC_SEQUENCE, "").replace(CSI_SEQUENCE, "").replace(OTHER_ESCAPE_SEQUENCE, "").replace(RAW_CONTROL_CHARS, "");
}
