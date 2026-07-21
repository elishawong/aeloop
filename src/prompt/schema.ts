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
});
export type Claim = z.infer<typeof ClaimSchema>;

/**
 * Coder's structured output (DESIGN §3 sequence: `Coder-->>Orc: {diff, claims[], confidence}`).
 */
export const CoderOutput = z.object({
  /** The change itself, as a unified diff or equivalent patch text. */
  diff: z.string().min(1),
  claims: z.array(ClaimSchema),
  /** Overall confidence across the whole change, not any single claim. */
  confidence: ClaimConfidence,
});
export type CoderOutput = z.infer<typeof CoderOutput>;

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
