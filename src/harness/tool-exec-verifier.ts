/**
 * `checkToolExecution` — `ToolExecVerifier`'s core (A3 PRD §5), the "唯一真
 * 防幻觉的那道闸" DESIGN §8 names. Pure function: given the raw `content`
 * string a cli-bridge adapter's `invoke()` collected and the
 * `ToolCallRecord[]` trace it parsed alongside it, decide whether a claim
 * that says "I verified this via tool_execution" is actually backed by a
 * real tool call, rather than just trusting the model's self-report.
 *
 * v1 rule (A3 PRD §0 decision 1, and §5/§9.4's note on what "existence/
 * subset matching" concretely means against the current `ClaimSchema`
 * shape, `src/prompt/schema.ts` — that schema only has a boolean-ish
 * `verifiedBy: "tool_execution" | "human" | "unverified"` field per claim,
 * not a list of specific declared tool names, so "subset matching" is
 * honestly a singleton-set existence check at this schema's current
 * granularity, not per-tool matching — flagged for confirmation, PRD §9.4):
 *   1. `content` doesn't parse as JSON, or doesn't have a `claims` array →
 *      `"na"` (nothing this function can confidently assert; a malformed
 *      response is `SchemaValidator`'s retry path to deal with, not this
 *      function's job to guess at).
 *   2. No entry in `claims` has `verifiedBy === "tool_execution"` → `"na"`
 *      (nobody claimed anything this function needs to check).
 *   3. At least one entry does → `"pass"` if `trace` is non-empty, `"fail"`
 *      if it's empty — the "声称≠行为" case this verifier exists to catch.
 *
 * No timestamp/ordering comparison is needed here: within one `invoke()`
 * call, both CLIs' non-interactive event streams are strictly chronological
 * with the final answer always last (spike-findings.md §1.4), so every
 * `ToolCallRecord` a `CodexCliAdapter`/`ClaudeCliAdapter` collects during
 * one invoke necessarily happened before that invoke's `content` was
 * emitted — the `trace` handed to this function is already "everything
 * that happened before this claim", by construction of how the adapters
 * build it (A3 PRD §5's note under `tool-exec-verifier.ts`).
 */
import type { ToolCallRecord, ToolExecChecked } from "./types.js";

export function checkToolExecution(content: string, trace: readonly ToolCallRecord[]): ToolExecChecked {
  if (!declaresToolExecution(content)) return "na";
  return trace.length > 0 ? "pass" : "fail";
}

/**
 * Best-effort, tolerant peek at `content` for "does any claim in here
 * assert `verifiedBy: 'tool_execution'`?" — deliberately looser than full
 * `ClaimSchema` zod validation (that's `SchemaValidator`'s job, run
 * separately). Never throws: any shape mismatch just means "can't tell",
 * which this function treats the same as "nobody claimed it" (`false`),
 * not as a failure to verify.
 */
function declaresToolExecution(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;

  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return false;

  return claims.some(
    (claim) =>
      typeof claim === "object" &&
      claim !== null &&
      (claim as { verifiedBy?: unknown }).verifiedBy === "tool_execution",
  );
}
