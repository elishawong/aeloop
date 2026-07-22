/**
 * Prompt-layer structured-output schemas (zod). Aligned to the shape of
 * docs/DESIGN.md §5's `structured_claims` table and the sequence diagram's
 * `{diff, claims[], confidence}` (Coder) / `{verdict, issues[], confidence}`
 * (Tester) payloads — but this is the *validation shape a model's output is
 * checked against*, not the persisted row. PRD §5 A1 Prompt layer is
 * explicit: "aligned to the structured_claims concept, but this section is
 * only the zod validation shape — it doesn't include persistence columns
 * like run_id". Concretely, `ClaimSchema` deliberately excludes every column
 * `structured_claims` carries that only exists once the *engine* (Harness/
 * Loop) has processed the model's response — `id`/`run_id`/`created_at`
 * (persistence bookkeeping), `model_used`/`provider_used` (Harness knows
 * which model ran, the model itself doesn't self-report this),
 * `tool_exec_checked` (ToolExecVerifier's verdict, computed by Harness after
 * the fact, A3). What's left — `claim_text`/`confidence`/`source_ref`/
 * `verified_by` — is exactly what a model can plausibly self-report about
 * one claim it's making, which is what this schema validates.
 */
import { z } from "zod";

/**
 * `structured_claims.confidence` enum (DESIGN §5): "verified/inferred/
 * unconfirmed/stale". Reused here for both the per-claim confidence and the
 * `CoderOutput`/`TesterOutput` top-level `confidence` field — DESIGN doesn't
 * define a separate vocabulary for an aggregate confidence, so using the
 * same closed set for both is the honest MVP choice rather than inventing a
 * second one.
 */
export const ClaimConfidence = z.enum(["verified", "inferred", "unconfirmed", "stale"]);
export type ClaimConfidence = z.infer<typeof ClaimConfidence>;

/** `structured_claims.verified_by` enum (DESIGN §5): "tool_execution/human/unverified". */
export const VerifiedBy = z.enum(["tool_execution", "human", "unverified"]);
export type VerifiedBy = z.infer<typeof VerifiedBy>;

/**
 * One claim a Coder or Tester makes about behavior, per both personas'
 * house rules (profiles/subscription/personas/{coder,tester}.md): "label every
 * claim about behavior with how you know it's true" / "a claim with no
 * verification method behind it is not confirmed, say so".
 */
export const ClaimSchema = z.object({
  /** The claim itself, in prose (e.g. "the new endpoint returns 404 for an unknown id"). */
  claimText: z.string().min(1),
  confidence: ClaimConfidence,
  /** Where this claim's evidence comes from (e.g. a test name, a file path, "read the diff"). Optional — a model may not always have one. */
  sourceRef: z.string().min(1).optional(),
  /** How the claim was checked, if it was. Optional for the same reason as `sourceRef`. */
  verifiedBy: VerifiedBy.optional(),
  /**
   * ToolExecVerifier v2 (A3 PRD, issue #11): the specific tool names a
   * `verifiedBy: "tool_execution"` claim asserts were actually run to back
   * it (e.g. `["Read", "Bash"]`) — a refinement of v1's schema-level
   * "singleton-set existence check" limitation (see the note in
   * `src/harness/tool-exec-verifier.ts`). Optional and independent of
   * `verifiedBy`: a claim can declare `toolsUsed` without asserting
   * `tool_execution` (harmless, `ToolExecVerifier` only reads it when
   * `verifiedBy === "tool_execution"`), and — for backward compatibility —
   * a `tool_execution` claim can still omit `toolsUsed` entirely, in which
   * case `ToolExecVerifier` falls back to v1's existence-only check.
   */
  toolsUsed: z.array(z.string().min(1)).min(1).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Fields both `CoderOutput` variants share (DESIGN §3 sequence:
 * `Coder-->>Orc: {diff, claims[], confidence}` — `claims[]`/`confidence` are
 * common to both outcomes, only the "what changed" payload differs).
 */
const CoderOutputCommon = {
  claims: z.array(ClaimSchema),
  /** Overall confidence across the whole change, not any single claim. */
  confidence: ClaimConfidence,
};

/**
 * The "there's a real change" variant — DESIGN §3's original, only shape of
 * `CoderOutput` before issue #47. `.strict()` so this variant can't silently
 * also carry a `no_change`-shaped `reason`/`evidence` field (mirrors
 * `CoderOutputNoChange`'s own `.strict()`, which exists precisely so it
 * can't carry a fabricated `diff`).
 */
export const CoderOutputChanged = z
  .object({
    status: z.literal("changed"),
    /**
     * The change itself, as a unified diff or equivalent patch text.
     * `.min(1)` alone would still accept a whitespace-only string (e.g.
     * `" "`) as "non-empty" — issue #47's acceptance criterion is a diff
     * that's actually blank in substance, not merely non-zero-length, hence
     * the `refine()` below on top of `.min(1)`.
     */
    diff: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, { message: "diff must not be empty or whitespace-only" }),
    ...CoderOutputCommon,
  })
  .strict();
export type CoderOutputChanged = z.infer<typeof CoderOutputChanged>;

/**
 * The "nothing to change" variant (issue #47): a read-only or
 * already-satisfied task legitimately produces no diff. `reason` (why no
 * change was needed) and `evidence` (what the coder actually checked to
 * reach that conclusion) are both required non-empty prose, mirroring
 * `ClaimSchema.claimText`'s "a claim needs a knowable basis" convention
 * rather than accepting a bare "no changes needed" with nothing backing it.
 * `.strict()` means this variant **cannot** carry a `diff` field at all —
 * accepting one alongside `reason`/`evidence` would let a model fabricate a
 * "no_change" completion that's secretly also claiming a diff, exactly the
 * ambiguity this variant exists to rule out.
 */
export const CoderOutputNoChange = z
  .object({
    status: z.literal("no_change"),
    /** Why no code change was needed (e.g. "the requested behavior was already implemented"). */
    reason: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, { message: "reason must not be empty or whitespace-only" }),
    /** What was actually checked to reach that conclusion (e.g. a file path read, a command run, a test that already passes). */
    evidence: z
      .string()
      .min(1)
      .refine((value) => value.trim().length > 0, { message: "evidence must not be empty or whitespace-only" }),
    ...CoderOutputCommon,
  })
  .strict();
export type CoderOutputNoChange = z.infer<typeof CoderOutputNoChange>;

/**
 * Coder's structured output (DESIGN §3 sequence: `Coder-->>Orc: {diff,
 * claims[], confidence}`), now a discriminated union on `status` (issue #47:
 * "Support no-change workflow completion without G1 loop" — a read-only or
 * already-satisfied task can legitimately produce no diff at all, and
 * forcing that through G1/the tester review, both of which only make sense
 * once there's an actual diff, was the bug this issue fixes).
 *
 * **Backward compatibility**: every `CoderOutput` produced before this
 * change (every existing model call, adapter fixture, and persisted
 * `structured_claims` row) is shaped exactly like `CoderOutputChanged` minus
 * the `status` field — `status` didn't exist yet. `z.preprocess()` below
 * defaults a *missing* `status` to `"changed"` before the discriminated
 * union ever runs, so that legacy shape still parses successfully as
 * `CoderOutputChanged`, without requiring every existing caller/fixture to
 * be rewritten. A payload that already carries an explicit `status` (either
 * variant) passes through unchanged.
 */
export const CoderOutput = z.preprocess((value) => {
  if (value !== null && typeof value === "object" && !("status" in value)) {
    return { ...value, status: "changed" };
  }
  return value;
}, z.discriminatedUnion("status", [CoderOutputChanged, CoderOutputNoChange]));
export type CoderOutput = z.infer<typeof CoderOutput>;

/** Narrows a `CoderOutput` to its `"changed"` variant — the one place every `.diff`-reading call site (`loop/gates.ts`/`loop/escalation.ts`/`loop/nodes/tester.ts`/`loop/runner.ts`) should go through, rather than re-checking `output.status === "changed"` independently in each. */
export function isCoderOutputChanged(output: CoderOutput): output is CoderOutputChanged {
  return output.status === "changed";
}

/**
 * Tester's structured output (DESIGN §3 sequence: `Tester-->>Orc: {verdict, issues[], confidence}`).
 * `verdict` mirrors the state machine's (DESIGN §4) two outcomes at the
 * review step: "approved" → `pass`, "bounced back" → `reject`.
 */
export const TesterOutput = z.object({
  verdict: z.enum(["pass", "reject"]),
  /** Concrete problems found, in prose — required to be specific per the tester persona's house rules, but the schema itself only enforces "a list of non-empty strings", not prose quality. */
  issues: z.array(z.string().min(1)),
  claims: z.array(ClaimSchema),
  confidence: ClaimConfidence,
});
export type TesterOutput = z.infer<typeof TesterOutput>;
