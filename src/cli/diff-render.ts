/**
 * `renderDiff()` — best-effort line-prefix diff colorizer (PRD §6.1). Reads
 * `CoderOutput.diff` (`src/prompt/schema.ts`): "a unified diff or equivalent
 * patch text" — a self-reported model string, not a real `git diff` and not
 * guaranteed to be strictly-formatted unified-diff syntax (PRD §0/§3 point
 * 3). This is therefore deliberately **not** a unified-diff parser/validator
 * — it never throws or "corrects" malformed input, it just colors whatever
 * lines look like the conventional prefixes and leaves everything else
 * untouched, plain.
 *
 * Per-line rule (PRD §6.1, checked in this order — `+++`/`---` file-header
 * lines are checked before the single-char `+`/`-` hunk-line rule, since
 * every `+++`/`---` line would otherwise also match the single-char rule):
 * 1. `+++`/`---` (file header) → bold.
 * 2. `@@` (hunk header) → cyan.
 * 3. `+`-prefixed → green.
 * 4. `-`-prefixed → red.
 * 5. anything else → unchanged, plain text.
 *
 * Color level forced to 3 (truecolor) rather than chalk's default TTY
 * autodetection — same judgment call and reasoning as `colors.ts`'s
 * identical choice (see that file's header for the full account); this
 * file uses its own `Chalk` instance rather than importing `colors.ts`'s
 * to keep the two files' responsibilities cleanly separated per PRD §6.1/§6.2.
 *
 * **Control-sequence sanitization (2026-07-21, Zorro re-review P1-4)**:
 * `diff` is `CoderOutput.diff` — model-produced text, printed to a real
 * terminal, then colored by this very file. Before this fix, a diff
 * containing a real ANSI/OSC escape sequence (clear-screen, cursor
 * repositioning, a fake shell prompt) would render for real, undermining
 * the human reviewer's ability to trust what G1/G3 actually show them.
 * `sanitize-terminal.ts`'s `stripControlSequences()` runs on the raw diff
 * text *before* line-splitting/coloring — see that file's header for the
 * full account of what it strips and why.
 */
import { Chalk } from "chalk";
import { stripControlSequences } from "./sanitize-terminal.js";

const chalk = new Chalk({ level: 3 });

export function renderDiff(diff: string): string {
  return stripControlSequences(diff)
    .split("\n")
    .map((line) => colorLine(line))
    .join("\n");
}

function colorLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return chalk.bold(line);
  if (line.startsWith("@@")) return chalk.cyan(line);
  if (line.startsWith("+")) return chalk.green(line);
  if (line.startsWith("-")) return chalk.red(line);
  return line;
}
