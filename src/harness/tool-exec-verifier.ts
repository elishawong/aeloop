/**
 * `checkToolExecution` — `ToolExecVerifier`'s core (A3 PRD §5), the "one true
 * anti-hallucination gate" DESIGN §8 names. Pure function: given the raw `content`
 * string a cli-bridge adapter's `invoke()` collected and the
 * `ToolCallRecord[]` trace it parsed alongside it, decide whether a claim
 * that says "I verified this via tool_execution" is actually backed by a
 * real tool call, rather than just trusting the model's self-report.
 *
 * v2 rule (issue #11 — "ToolExecVerifier v2"), a per-claim refinement of
 * v1's schema-level "singleton-set existence check" limitation (`ClaimSchema`
 * gained an optional `toolsUsed: string[]` field, `src/prompt/schema.ts`,
 * specifically to unlock this):
 *   1. `content` doesn't parse as JSON, or doesn't have a `claims` array →
 *      `"na"` (nothing this function can confidently assert; a malformed
 *      response is `SchemaValidator`'s retry path to deal with, not this
 *      function's job to guess at).
 *   2. No entry in `claims` has `verifiedBy === "tool_execution"` → `"na"`
 *      (nobody claimed anything this function needs to check).
 *   3. At least one entry does. For each such claim:
 *      - if it declares a non-empty `toolsUsed` array, EVERY name in it
 *        must appear in the trace's set of `toolName`s — `"pass"` only if
 *        all declared tools are actually present, `"fail"` otherwise. This
 *        is real per-tool subset matching, not just "some tool ran".
 *      - if it declares no `toolsUsed` (or an empty one — schema-invalid
 *        but this function stays tolerant per its "never throws" contract
 *        below), it falls back to v1's exact existence-only behavior:
 *        `"pass"` if `trace` is non-empty, `"fail"` if empty. This keeps
 *        legacy claims — written before `toolsUsed` existed — working
 *        exactly as before.
 *      - `"fail"` on any checked claim short-circuits the whole result to
 *        `"fail"`; only if every `tool_execution` claim individually
 *        passes does the result come out `"pass"`.
 *
 * Known limitation, honestly not papered over: `CodexCliAdapter` fixes
 * every `ToolCallRecord.toolName` it produces to the literal string
 * `"shell"` (its `--json` stream only exposes shell-level
 * `command_execution`, it can't distinguish `read_file` vs `grep` vs
 * anything else — see the doc comment on `ToolCallRecord.toolName` in
 * `src/harness/types.ts`). This function matches `toolsUsed` names
 * honestly against whatever `toolName` strings the trace actually reports
 * — it does not, and cannot, fabricate finer granularity than the trace
 * has. Concretely: on a Codex-run trace, a claim declaring
 * `toolsUsed: ["read_file"]` will only pass if the trace itself contains a
 * record with `toolName === "read_file"` (which `CodexCliAdapter` never
 * produces); a claim declaring `toolsUsed: ["shell"]` is the only shape
 * that can pass against a Codex trace today. This is an inherent
 * limitation of Codex's event stream, not a bug in this function — see A3
 * PRD / spike-findings.md §3.1 for the underlying adapter constraint.
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
  const claims = toolExecutionClaims(content);
  if (claims === null) return "na";

  const traceToolNames = new Set(trace.map((record) => record.toolName));

  let sawFail = false;
  for (const claim of claims) {
    const toolsUsed = (claim as { toolsUsed?: unknown }).toolsUsed;
    if (Array.isArray(toolsUsed) && toolsUsed.length > 0 && toolsUsed.every((t) => typeof t === "string")) {
      // v2: every declared tool name must actually appear in the trace.
      const allPresent = (toolsUsed as string[]).every((name) => traceToolNames.has(name));
      if (!allPresent) sawFail = true;
    } else {
      // v1 fallback: no (valid, non-empty) toolsUsed declared — existence-only check.
      if (trace.length === 0) sawFail = true;
    }
  }

  return sawFail ? "fail" : "pass";
}

/**
 * Best-effort, tolerant peek at `content` for "which claims in here assert
 * `verifiedBy: 'tool_execution'`?" — deliberately looser than full
 * `ClaimSchema` zod validation (that's `SchemaValidator`'s job, run
 * separately). Never throws: any shape mismatch just means "can't tell",
 * which this function treats the same as "nobody claimed it" (`null`), not
 * as a failure to verify. Returns `null` when there is nothing to check
 * (malformed content, no `claims` array, or no matching claims); otherwise
 * the array of matching claim objects, for `checkToolExecution` to inspect
 * their `toolsUsed` field.
 */
function toolExecutionClaims(content: string): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const claims = (parsed as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) return null;

  const matching = claims.filter(
    (claim) =>
      typeof claim === "object" &&
      claim !== null &&
      (claim as { verifiedBy?: unknown }).verifiedBy === "tool_execution",
  );

  return matching.length > 0 ? matching : null;
}
