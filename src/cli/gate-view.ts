/**
 * Pure `GatePayload -> string` rendering, one function per gate type (PRD
 * §6.3). `GatePayload` (`src/loop/types.ts`) is what a gate node hands to
 * `interrupt()` — `main.ts`/`run-loop.ts` pass it straight through to these
 * functions, never reaching into `diffRef`/`issues` themselves.
 *
 * Testable without any TTY/prompt library — every function here is a pure
 * function of its input, asserted against with plain string
 * `.includes()`/substring checks (ANSI codes included, per this file's own
 * header note in `colors.ts`/`diff-render.ts` about why coloring is always
 * on, not TTY-conditional).
 *
 * **Control-sequence sanitization (2026-07-21, Zorro re-review P1-4)**:
 * `payload.question`/`payload.issues[]` are model-produced text, same as
 * `diffRef` (`renderDiffSection()` already gets sanitization for free via
 * `renderDiff()`'s own fix) — sanitized here with the same
 * `stripControlSequences()` before being wrapped in `heading()`/`warn()`'s
 * chalk coloring, so a model can't smuggle a real terminal escape sequence
 * into the one piece of text every gate renders (the question) or into an
 * issue list.
 */
import { escalationBanner, heading, warn } from "./colors.js";
import { renderDiff } from "./diff-render.js";
import { stripControlSequences } from "./sanitize-terminal.js";
import type { GatePayload } from "../loop/types.js";

function renderIssuesList(issues: readonly string[] | undefined): string {
  if (issues === undefined || issues.length === 0) return "";
  const lines = issues.map((issue) => `  - ${stripControlSequences(issue)}`);
  return `\n${warn("Issues:")}\n${lines.join("\n")}`;
}

function renderDiffSection(diffRef: string | undefined): string {
  if (diffRef === undefined) return "";
  return `\n${renderDiff(diffRef)}`;
}

/** G1: approve sending the coder's diff to the tester (`gates.ts`'s `createG1Node`). */
export function renderG1(payload: GatePayload): string {
  return `${heading(`[G1] ${stripControlSequences(payload.question)}`)}${renderDiffSection(payload.diffRef)}`;
}

/** G2: approve sending the tester's findings back to the coder for a fix, or escalate (`gates.ts`'s `createG2Node`). */
export function renderG2(payload: GatePayload): string {
  return `${heading(`[G2] ${stripControlSequences(payload.question)}`)}${renderIssuesList(payload.issues)}`;
}

/** G3: final sign-off before Apply (`gates.ts`'s `createG3Node`). */
export function renderG3(payload: GatePayload): string {
  return `${heading(`[G3] ${stripControlSequences(payload.question)}`)}${renderDiffSection(payload.diffRef)}`;
}

/**
 * The Escalation gate (`escalation.ts`'s `createEscalationNode`) — wrapped
 * in `escalationBanner()` (PRD §6.3: "a structurally different rendering,
 * not merely a different single ANSI color reused from an ordinary gate"),
 * then the question, the tester's issues, and the diff, in that order —
 * everything a human needs to actually decide revise/force_pass/abandon.
 */
export function renderEscalation(payload: GatePayload): string {
  const body = `${stripControlSequences(payload.question)}${renderIssuesList(payload.issues)}${renderDiffSection(payload.diffRef)}`;
  return escalationBanner(body);
}
