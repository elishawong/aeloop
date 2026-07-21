/**
 * Small chalk-based theming helpers shared by `diff-render.ts`/`gate-view.ts`
 * (PRD §6.2) — centralizes "this looks like an ordinary gate" vs. "this
 * looks like an escalation" in one place instead of each call site picking
 * its own ad hoc chalk calls.
 *
 * **Color level forced to 3 (truecolor), not chalk's default TTY
 * autodetection** — my judgment call, no direct PRD/library-doc evidence
 * for this specific choice, flagged rather than silently deviating from
 * chalk's own default posture (auto-detect would make output silently plain
 * whenever `process.stdout` isn't a TTY — piped output, or vitest's
 * non-interactive stdout during tests — even though this PRD's target usage
 * is always a real human at a real terminal, and its acceptance criteria
 * (§10) require real ANSI codes to be present and assertable in
 * `gate-view.test.ts`/`diff-render.test.ts`, not conditionally so).
 */
import { Chalk } from "chalk";

const chalk = new Chalk({ level: 3 });

/** A section heading (e.g. "G1: approve sending this diff to the tester?"). */
export function heading(text: string): string {
  return chalk.bold.cyan(text);
}

/** A positive/approved-leaning label. */
export function ok(text: string): string {
  return chalk.green(text);
}

/** A cautionary label — not necessarily an error, just "pay attention". */
export function warn(text: string): string {
  return chalk.yellow(text);
}

/** A negative/rejected-leaning or error label. */
export function danger(text: string): string {
  return chalk.red(text);
}

/**
 * The Escalation gate's distinguishing treatment (PRD §6.2/§6.3, DESIGN §8's
 * "visual distinction for escalations" requirement): bold text on a yellow
 * background, framed with a banner line above/below — a *structurally*
 * different rendering from any color G1/G2/G3 ever use on their own
 * (`ok()`/`warn()`/`danger()` are all foreground-only), not merely "pick a
 * fourth ANSI color and call it done".
 */
export function escalationBanner(text: string): string {
  const frame = chalk.bold.bgYellow.black("⚠".repeat(3) + " ESCALATION " + "⚠".repeat(3));
  return `${frame}\n${chalk.bold.yellow(text)}\n${frame}`;
}
