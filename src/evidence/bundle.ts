import type { LoopEvent } from "../loop/events.js";

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

export interface EvidenceItem {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly title: string;
  readonly ref: string;
  readonly contentHash?: string;
  readonly passed?: boolean;
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
  readonly model?: string;
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

export class EvidenceBundleBuilder {
  private readonly requirements = new Map<string, RequirementCoverage>();
  private readonly claims = new Map<string, EvidenceClaim>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly eventTypes = new Set<string>();
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, retryTokens: 0, estimated: false };
  private status: EvidenceBundle["status"] = "running";
  private omittedContext: readonly OmittedContextEntry[] = [];

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
    return this;
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
    this.usage = {
      inputTokens: this.usage.inputTokens + usage.inputTokens,
      outputTokens: this.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + usage.cacheReadTokens,
      retryTokens: this.usage.retryTokens + usage.retryTokens,
      estimated: this.usage.estimated || usage.estimated,
      model: usage.model ?? this.usage.model,
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
