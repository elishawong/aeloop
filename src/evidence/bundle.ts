import type { AgentCompletedEvent, LoopEvent } from "../loop/events.js";
import type { ProviderUsage, ToolExecChecked } from "../harness/types.js";
import type { Claim } from "../prompt/schema.js";

export type EvidenceKind = "source" | "tool" | "test" | "artifact" | "human";
export type ClaimStatus = "supported" | "unsupported" | "unknown" | "rejected";
export type RequirementStatus = "unverified" | "in_progress" | "verified" | "failed";

export interface RequirementCoverage {
  readonly requirementId: string;
  readonly status: RequirementStatus;
  readonly evidenceRefs: readonly string[];
  readonly note?: string;
}

export interface EvidenceClaim {
  readonly id: string;
  readonly text: string;
  readonly status: ClaimStatus;
  readonly requirementIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

/**
 * Provenance of an {@link EvidenceItem}'s content — distinct from `kind`
 * (what *category* of evidence this is: source/tool/test/artifact/human).
 * `source` instead answers "how much should `passed` be trusted": `"verified"`
 * means an independent, mechanized check produced this item (a test runner, a
 * tool invocation, a diff review); `"model-reported"` means the agent itself
 * asserted it with no independent check backing it up (e.g. a coder's
 * `no_change` `reason`/`evidence` prose — see `CoderOutputNoChange`,
 * `src/prompt/schema.ts`). Optional/absent is treated as `"verified"` for
 * backward compatibility with evidence recorded before this field existed.
 */
export type EvidenceSource = "verified" | "model-reported";

export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly title: string;
  readonly ref: string;
  readonly contentHash?: string;
  readonly passed?: boolean;
  readonly content?: string;
  readonly source?: EvidenceSource;
}

export interface UsageRecord {
  readonly node: "draft" | "review";
  readonly role: "coder" | "tester";
  readonly provider: string;
  readonly model: string;
  readonly attempt: number;
  readonly usage: ProviderUsage;
  readonly latencyMs?: number;
}

/**
 * Mirrors `RunStartedEvent["contextOmitted"]`'s element shape
 * (`src/loop/events.ts`, issue #36 slice 2) — kept as its own named type
 * here rather than importing `RunStartedEvent`'s inline element type
 * directly, matching this file's existing convention of not depending on
 * `LoopEvent`'s per-event-type fields beyond `event.type` (see
 * `EvidenceEventProjector.accept`).
 */
export interface OmittedContextEntry {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly reason: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly retryTokens: number;
  readonly estimated: boolean;
  /**
   * The single model these aggregated counters came from — populated only
   * while every `recordUsage()` call contributing to this total agreed on
   * one model name (the common case: one coder/tester model per run).
   * `undefined` once a *second* distinct model is recorded, rather than
   * silently overwriting with whichever call happened last — a coder on
   * one model and a tester on another must never be summarized as if only
   * the more recently recorded one ran. See `models` for the multi-model
   * case; `usageRecords` (`EvidenceBundle.usageRecords`) remains the
   * authoritative per-call breakdown regardless.
   */
  readonly model?: string;
  /**
   * Every distinct model name recorded so far, in first-seen order.
   * Present whenever at least one `recordUsage()` call carried a `model`;
   * a single entry here is the backward-compatible case `model` also
   * reports. Two or more entries is the signal that `model` was
   * deliberately left `undefined` above because the aggregate spans
   * multiple models.
   */
  readonly models?: readonly string[];
  readonly costUsd?: number;
}

export interface EvidenceBundle {
  readonly schemaVersion: "1";
  readonly runId?: number;
  readonly contractId?: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "escalated";
  readonly requirements: readonly RequirementCoverage[];
  readonly claims: readonly EvidenceClaim[];
  readonly evidence: readonly EvidenceItem[];
  readonly usage: TokenUsage;
  readonly usageRecords: readonly UsageRecord[];
  readonly eventTypes: readonly string[];
  readonly unprovenItems: readonly string[];
  /**
   * Issue #36 slice 2: memories `ContextBudgetManager` omitted for lack of
   * token budget on this run's `run_started` event, if any. Empty (not
   * absent) when no `run_started` event has been recorded yet, or when it
   * was recorded without a `contextOmitted` payload (budgeting off, or
   * nothing omitted) — matches this class's existing convention of
   * defaulting derived collections to `[]` rather than `undefined`
   * (`requirements`/`claims`/`evidence`/`eventTypes` all do the same).
   */
  readonly omittedContext: readonly OmittedContextEntry[];
}

export interface EvidenceBundleInput {
  readonly runId?: number;
  readonly contractId?: string;
  readonly requirementIds?: readonly string[];
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function addUnique(items: readonly string[], value: string): readonly string[] {
  return items.includes(value) ? items : [...items, value];
}

/**
 * Issue #81 batch2 (`docs/evidence-wiring/SCOPING.md` 接点2): the round
 * number `nextStepRef()`/`previewStepRef()` (`src/loop/runner.ts`) minted
 * into a `stepRef` like `"draft#3"`/`"review#3"` — reused here, not
 * independently re-derived, to pair a tester round's `agent_completed`
 * event back to the coder round it reviewed (draft#N reviewed by review#N).
 *
 * **Honest scope of the lockstep guarantee (Zorro hardening #81)**: this
 * only holds along the review-reject (G2) loop-back path — verified
 * against `runner.test.ts`'s own reject-loop assertions
 * (`coderStepRefs`/`testerStepRefs` both land on `["draft#1","draft#2"]` /
 * `["review#1","review#2"]` together, one-for-one). It does **not** hold
 * across a **G1 human reject** (`gates.ts` `routeAfterG1`: a `"rejected"`
 * decision routes straight back to `"draft"`, *before* `review` ever ran
 * for that round): `draft#1 -> G1 reject -> draft#2 -> G1 approve ->
 * review#1` bumps the draft counter to 2 while the review counter is only
 * about to mint its first `review#1` — permanently offsetting the two
 * counters by one for the rest of that run. This is a **known, accepted
 * gap, not something this function silently gets wrong**:
 * `recordTesterClaims()`'s `coderRound.round === round` check simply stops
 * matching once a G1 reject has desynced the counters, so that (and every
 * later) round's coder-claim verdict-folding is skipped by design —
 * fail-closed (no claim ever gets a *wrong* status), never a silent
 * misattribution. Both sides' claims are still recorded as plain
 * `EvidenceItem`s regardless of whether the pairing matched. Returns
 * `undefined` for a `stepRef` that doesn't match the `"<node>#<n>"` shape
 * at all — callers must fail closed on that too, not guess.
 */
function roundFromStepRef(stepRef: string): number | undefined {
  const match = /#(\d+)$/.exec(stepRef);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `EvidenceKind` for one structured `Claim` (issue #81 batch2, SCOPING §接点2
 * coder侧): `verifiedBy` maps onto the existing `EvidenceKind` vocabulary —
 * `"tool_execution"` -> `"tool"`, `"human"` -> `"human"`, anything else
 * (`"unverified"` or absent) -> `"source"` (the model's own claim text is
 * the only "source" backing it).
 */
function evidenceKindFor(claim: Claim): EvidenceKind {
  if (claim.verifiedBy === "tool_execution") return "tool";
  if (claim.verifiedBy === "human") return "human";
  return "source";
}

/**
 * **The batch2 correctness red line** (`docs/evidence-wiring/SCOPING.md`
 * "最大正确性风险", mirrors `EvidenceSource`'s own doc comment above):
 * `"verified"` is returned **only** when `claim.verifiedBy ===
 * "tool_execution"` *and* `toolExecChecked === "pass"` — i.e. an
 * independent mechanism (`ToolExecVerifier`, computed by the harness from
 * the real `InvokeResult`, `src/harness/types.ts`) actually confirmed it.
 * `claim.confidence === "verified"` (the model's own self-reported
 * confidence, `ClaimConfidence`) is a completely different, orthogonal
 * field and is **never** read here — a model can self-report
 * `confidence: "verified"` on a claim nobody independently checked, and
 * that must still resolve to `"model-reported"`. Every other combination
 * (`verifiedBy: "human"`/`"unverified"`/absent, or `"tool_execution"` with
 * `toolExecChecked` `"fail"`/`"na"`/absent) also falls through to
 * `"model-reported"`.
 */
function evidenceSourceFor(claim: Claim, toolExecChecked: ToolExecChecked | undefined): EvidenceSource {
  return claim.verifiedBy === "tool_execution" && toolExecChecked === "pass" ? "verified" : "model-reported";
}

export class EvidenceBundleBuilder {
  private readonly requirements = new Map<string, RequirementCoverage>();
  private readonly claims = new Map<string, EvidenceClaim>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly eventTypes = new Set<string>();
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, retryTokens: 0, estimated: false };
  private readonly usageRecords: UsageRecord[] = [];
  /** Distinct model names seen across every `recordUsage()` call, in first-seen order — see `TokenUsage.model`/`.models` doc comments for why this needs to be tracked separately from `this.usage.model`. */
  private readonly modelsSeen: string[] = [];
  private status: EvidenceBundle["status"] = "running";
  private omittedContext: readonly OmittedContextEntry[] = [];
  /**
   * Issue #81 batch2 round-pairing state (SCOPING §接点2): the most recent
   * coder round's claims + the `EvidenceItem` id each was projected into,
   * remembered only long enough for the *matching* tester round
   * (`runId` **and** `roundFromStepRef` both equal — Zorro hardening #81:
   * `runId` is carried alongside `round` even though this builder's own
   * production call site, `ConductorWorkApp.projectEvents()`, only ever
   * feeds it one run's events at a time and can't reach a cross-run
   * collision today — `EvidenceBundleBuilder`/`recordEvent()` are public
   * surface with no such single-run contract enforced on any caller, so a
   * future/other caller replaying a multi-run event stream through one
   * builder must not have round #1 of run A's coder claims silently paired
   * with round #1 of run B's tester verdict just because the round numbers
   * happen to coincide) to fold a claim status into `claims[]`. `undefined`
   * whenever the last coder `agent_completed` event's `stepRef` didn't
   * yield a derivable round — fail-closed, per SCOPING's "round对不上就不
   * 建claim" guidance (and see `roundFromStepRef()`'s own doc comment for
   * the G1-reject case this same fail-closed check also covers), rather
   * than pairing against a stale/guessed round.
   */
  private lastCoderRound?: {
    readonly runId: number;
    readonly round: number;
    readonly stepRef: string;
    readonly pairs: readonly { readonly claim: Claim; readonly evidenceId: string }[];
  };

  constructor(private readonly input: EvidenceBundleInput = {}) {
    for (const requirementId of input.requirementIds ?? []) {
      if (requirementId.trim() !== "") this.requirements.set(requirementId, { requirementId, status: "unverified", evidenceRefs: [] });
    }
  }

  recordEvent(event: LoopEvent): this {
    this.eventTypes.add(event.type);
    this.status = event.type === "run_completed" ? "completed" : event.type === "run_cancelled" ? "cancelled" : event.type === "run_failed" ? "failed" : this.status;
    // Issue #36 slice 2: `run_started` is the only event carrying
    // `contextOmitted` (`RunStartedEvent`, `src/loop/events.ts`) — an old
    // `run_started` event (or any other event type) without this field
    // simply leaves `omittedContext` at its `[]` default, never throws.
    if (event.type === "run_started" && event.contextOmitted) {
      this.omittedContext = [...event.contextOmitted];
    }
    if (event.type === "agent_completed" && event.usage) {
      const attempt = event.stepRef?.match(/#(\d+)$/)?.[1];
      const record: UsageRecord = {
        node: event.node,
        role: event.actor,
        provider: event.provider ?? "unknown",
        model: event.model ?? "unknown",
        attempt: attempt ? Number(attempt) : 1,
        usage: event.usage,
        ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }),
      };
      this.usageRecords.push(record);
      this.recordUsage({
        inputTokens: event.usage.inputTokens ?? 0,
        outputTokens: event.usage.outputTokens ?? 0,
        cacheReadTokens: event.usage.cacheReadTokens ?? 0,
        retryTokens: 0,
        estimated: event.usage.source === "estimate",
        model: event.model ?? "unknown",
      });
    }
    // Issue #81 batch2 (SCOPING §接点2): project real claim content —
    // additive, alongside (not replacing) the pre-existing usage/no_change
    // handling above/below. Guarded on `event.claims !== undefined` (not
    // `.length > 0`) so a legally-empty round (`prompt/schema.ts`'s
    // `CoderOutput.claims`/`TesterOutput.claims` have no `.min(1)`) still
    // updates `lastCoderRound`'s round-tracking correctly instead of
    // leaving a stale earlier round in place.
    if (event.type === "agent_completed" && event.actor === "coder" && event.claims !== undefined) {
      this.recordCoderClaims(event);
    }
    if (event.type === "agent_completed" && event.actor === "tester" && event.claims !== undefined) {
      this.recordTesterClaims(event);
    }
    if (event.type === "agent_completed" && event.outcome === "no_change" && event.noChangeReason && event.noChangeEvidence) {
      // Trust fix (issue #54 PR #57 review): `noChangeEvidence` is prose the
      // coder model itself wrote (`CoderOutputNoChange.evidence`,
      // `src/prompt/schema.ts`) to justify producing no diff — nothing here
      // independently checked it against the actual repository state.
      // Recording it as `passed: true` would tell downstream consumers a
      // mechanized check confirmed "no change was needed", when in truth
      // it's an unverified, model-reported claim. Fail-closed: `passed` is
      // explicitly `false` (never `true`) and `source: "model-reported"`
      // names why, so this can never be mistaken for `"verified"` evidence
      // (e.g. a real test run) without a caller opting in by inspecting
      // `source` itself.
      this.addEvidence({
        id: `no-change-${event.runId}-${event.stepRef ?? "draft"}`,
        kind: "artifact",
        title: event.noChangeReason,
        ref: `evidence://run/${event.runId}/no-change`,
        content: event.noChangeEvidence,
        passed: false,
        source: "model-reported",
      });
    }
    return this;
  }

  /**
   * Issue #81 batch2 (SCOPING §接点2 coder侧): every claim the coder made
   * this round becomes its own `EvidenceItem` (`content` = the claim text,
   * `source` decided by `evidenceSourceFor()`'s red-line rule above — never
   * `"verified"` off the model's own say-so). Also remembers this round
   * (`lastCoderRound`) so a *matching* tester round below can fold a
   * `ClaimStatus` on top of these same evidence ids — deliberately does
   * **not** call `addClaim()` itself: a coder's claim has no verdict of its
   * own yet, only the tester's review produces one (SCOPING: "tester的
   * verdict是这一整轮的裁决").
   */
  private recordCoderClaims(event: AgentCompletedEvent): void {
    const claims = event.claims ?? [];
    const stepRefLabel = event.stepRef ?? "draft";
    const pairs: { claim: Claim; evidenceId: string }[] = [];
    claims.forEach((claim, i) => {
      const evidenceId = `claim-evidence-${event.runId}-${stepRefLabel}-${i}`;
      this.addEvidence({
        id: evidenceId,
        kind: evidenceKindFor(claim),
        title: claim.claimText,
        ref: `evidence://run/${event.runId}/${stepRefLabel}/claim-${i}`,
        content: claim.claimText,
        source: evidenceSourceFor(claim, event.toolExecChecked),
      });
      pairs.push({ claim, evidenceId });
    });
    const round = event.stepRef ? roundFromStepRef(event.stepRef) : undefined;
    // Fail-closed (SCOPING "最大正确性风险" 次要风险): a stepRef this
    // builder can't parse a round out of must not leave a *previous*
    // round's pairing lying around for a later, unrelated tester event to
    // accidentally match against.
    this.lastCoderRound = round === undefined ? undefined : { runId: event.runId, round, stepRef: event.stepRef!, pairs };
  }

  /**
   * Issue #81 batch2 (SCOPING §接点2 tester侧): the tester's own claims
   * (what *it* checked to reach its verdict) become independent
   * `EvidenceItem`s — never merged into/mistaken for the coder's claims
   * ("不冒充coder的claim"). Separately, when this event's round
   * (`roundFromStepRef(event.stepRef)`) matches `lastCoderRound`'s round
   * *exactly*, this tester's whole-round `verdict` is folded onto each of
   * that matching coder round's claims as an `EvidenceClaim` — `"pass"` ->
   * `"supported"`, `"reject"` -> `"rejected"`, `evidenceRefs` pointing at
   * that specific claim's own `EvidenceItem` id from `recordCoderClaims()`.
   * A round or runId mismatch (or no prior coder round at all — including
   * the G1-reject-desynced-counters case `roundFromStepRef()`'s doc comment
   * describes) fails closed: no `addClaim()` call, rather than guessing a
   * pairing. `runId` is checked alongside `round` (Zorro hardening #81) as
   * an extra, purely-tightening guard: the real production call site
   * (`ConductorWorkApp.projectEvents()`) only ever feeds one run's events
   * through a builder, so this can never fire *stricter* than needed today
   * — it only guards a hypothetical future/other caller that replays a
   * multi-run event stream through one builder from a cross-run
   * misattribution (round #1 of run A's coder claims silently paired with
   * round #1 of run B's tester verdict, just because the round numbers
   * happen to coincide).
   */
  private recordTesterClaims(event: AgentCompletedEvent): void {
    const claims = event.claims ?? [];
    const stepRefLabel = event.stepRef ?? "review";
    claims.forEach((claim, i) => {
      this.addEvidence({
        id: `claim-evidence-${event.runId}-${stepRefLabel}-${i}`,
        kind: evidenceKindFor(claim),
        title: claim.claimText,
        ref: `evidence://run/${event.runId}/${stepRefLabel}/claim-${i}`,
        content: claim.claimText,
        source: evidenceSourceFor(claim, event.toolExecChecked),
      });
    });

    const round = event.stepRef ? roundFromStepRef(event.stepRef) : undefined;
    const coderRound = this.lastCoderRound;
    if (event.verdict && round !== undefined && coderRound && coderRound.runId === event.runId && coderRound.round === round) {
      const status: ClaimStatus = event.verdict === "pass" ? "supported" : "rejected";
      coderRound.pairs.forEach(({ claim, evidenceId }, i) => {
        this.addClaim({
          id: `claim-${event.runId}-${coderRound.stepRef}-${i}`,
          text: claim.claimText,
          status,
          // Issue #81 batch3 (claim<->requirement linkage) is explicitly
          // out of scope for this batch — `ClaimSchema` has no
          // `requirementIds` field yet (SCOPING §接点3), so this can never
          // be anything but `[]` here.
          requirementIds: [],
          evidenceRefs: [evidenceId],
        });
      });
    }
  }

  addEvidence(item: EvidenceItem): this {
    if (item.id.trim() === "" || item.title.trim() === "" || item.ref.trim() === "") throw new TypeError("evidence id, title, and ref are required");
    this.evidence.set(item.id, item);
    return this;
  }

  addClaim(claim: EvidenceClaim): this {
    if (claim.id.trim() === "" || claim.text.trim() === "") throw new TypeError("claim id and text are required");
    this.claims.set(claim.id, claim);
    for (const requirementId of claim.requirementIds) {
      const existing = this.requirements.get(requirementId) ?? { requirementId, status: "unverified" as const, evidenceRefs: [] };
      const status: RequirementStatus = claim.status === "supported" ? "verified" : claim.status === "rejected" ? "failed" : "in_progress";
      this.requirements.set(requirementId, { ...existing, status, evidenceRefs: claim.evidenceRefs.reduce(addUnique, existing.evidenceRefs) });
    }
    return this;
  }

  markRequirement(requirementId: string, status: RequirementStatus, note?: string): this {
    const existing = this.requirements.get(requirementId) ?? { requirementId, status: "unverified" as const, evidenceRefs: [] };
    this.requirements.set(requirementId, { ...existing, status, ...(note === undefined ? {} : { note }) });
    return this;
  }

  recordUsage(usage: TokenUsage): this {
    nonNegativeInteger(usage.inputTokens, "inputTokens");
    nonNegativeInteger(usage.outputTokens, "outputTokens");
    nonNegativeInteger(usage.cacheReadTokens, "cacheReadTokens");
    nonNegativeInteger(usage.retryTokens, "retryTokens");
    if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) throw new TypeError("costUsd must be a non-negative finite number");
    if (usage.model !== undefined && !this.modelsSeen.includes(usage.model)) this.modelsSeen.push(usage.model);
    this.usage = {
      inputTokens: this.usage.inputTokens + usage.inputTokens,
      outputTokens: this.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + usage.cacheReadTokens,
      retryTokens: this.usage.retryTokens + usage.retryTokens,
      estimated: this.usage.estimated || usage.estimated,
      // Trust fix (issue #54 PR #57 review): never collapse two distinct
      // models into "whichever was recorded last" — see `TokenUsage.model`.
      model: this.modelsSeen.length === 1 ? this.modelsSeen[0] : undefined,
      ...(this.modelsSeen.length > 0 ? { models: [...this.modelsSeen] } : {}),
      costUsd: (this.usage.costUsd ?? 0) + (usage.costUsd ?? 0),
    };
    return this;
  }

  build(): EvidenceBundle {
    const requirements = [...this.requirements.values()];
    return {
      schemaVersion: "1",
      runId: this.input.runId,
      contractId: this.input.contractId,
      status: this.status,
      requirements,
      claims: [...this.claims.values()],
      evidence: [...this.evidence.values()],
      usage: this.usage,
      usageRecords: [...this.usageRecords],
      eventTypes: [...this.eventTypes],
      unprovenItems: requirements.filter((item) => item.status !== "verified").map((item) => item.requirementId),
      omittedContext: this.omittedContext,
    };
  }
}

/** Read-only adapter from engine events to a product-facing EvidenceBundle. */
export class EvidenceEventProjector {
  constructor(private readonly builder: EvidenceBundleBuilder) {}

  accept(event: LoopEvent): void {
    this.builder.recordEvent(event);
  }

  snapshot(): EvidenceBundle {
    return this.builder.build();
  }
}

export class TokenBudgetLedger {
  private usedInputTokens = 0;
  private usedOutputTokens = 0;
  private usedRetryTokens = 0;

  constructor(private readonly budget: TokenBudgetLimit) {}

  canRecord(usage: Pick<TokenUsage, "inputTokens" | "outputTokens" | "retryTokens">): boolean {
    return this.usedInputTokens + usage.inputTokens <= this.budget.inputTokens && this.usedOutputTokens + usage.outputTokens <= this.budget.outputTokens && this.usedRetryTokens + usage.retryTokens <= this.budget.retryTokens;
  }

  record(usage: Pick<TokenUsage, "inputTokens" | "outputTokens" | "retryTokens">): void {
    for (const [field, value] of Object.entries(usage)) nonNegativeInteger(value, field);
    if (!this.canRecord(usage)) throw new TokenBudgetExceededError(this.snapshot(), usage);
    this.usedInputTokens += usage.inputTokens;
    this.usedOutputTokens += usage.outputTokens;
    this.usedRetryTokens += usage.retryTokens;
  }

  snapshot(): TokenBudgetSnapshot {
    return {
      budget: this.budget,
      usedInputTokens: this.usedInputTokens,
      usedOutputTokens: this.usedOutputTokens,
      usedRetryTokens: this.usedRetryTokens,
      remainingInputTokens: this.budget.inputTokens - this.usedInputTokens,
      remainingOutputTokens: this.budget.outputTokens - this.usedOutputTokens,
      remainingRetryTokens: this.budget.retryTokens - this.usedRetryTokens,
    };
  }
}

export interface TokenBudgetLimit {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly retryTokens: number;
}

export interface TokenBudgetSnapshot {
  readonly budget: TokenBudgetLimit;
  readonly usedInputTokens: number;
  readonly usedOutputTokens: number;
  readonly usedRetryTokens: number;
  readonly remainingInputTokens: number;
  readonly remainingOutputTokens: number;
  readonly remainingRetryTokens: number;
}

export class TokenBudgetExceededError extends Error {
  readonly code = "TOKEN_BUDGET_EXCEEDED" as const;

  constructor(public readonly snapshot: ReturnType<TokenBudgetLedger["snapshot"]>, public readonly requested: Pick<TokenUsage, "inputTokens" | "outputTokens" | "retryTokens">) {
    super("token budget exceeded");
    this.name = "TokenBudgetExceededError";
  }
}
