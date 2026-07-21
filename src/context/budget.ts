export type ContextPriority = "contract" | "policy" | "gate" | "evidence" | "memory" | "general";

export interface ContextCandidate {
  readonly id: string;
  readonly text: string;
  readonly priority: ContextPriority;
  readonly relevance: number;
  readonly tokenCount?: number;
  readonly protected?: boolean;
}

export interface ContextBudgetSelection {
  readonly items: readonly ContextCandidate[];
  readonly usedTokens: number;
  readonly omittedIds: readonly string[];
}

const PRIORITY_WEIGHT: Record<ContextPriority, number> = {
  contract: 6,
  policy: 5,
  gate: 4,
  evidence: 3,
  memory: 2,
  general: 1,
};

/** Deterministic, model-free context selection. Protected contract/policy items
 * are never silently dropped; callers must allocate enough budget for them. */
export class ContextBudgetManager {
  constructor(private readonly tokenBudget: number) {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1) throw new TypeError("context token budget must be a positive safe integer");
  }

  select(candidates: readonly ContextCandidate[]): ContextBudgetSelection {
    const normalized = candidates.map((candidate) => ({ ...candidate, tokenCount: candidate.tokenCount ?? estimateTokens(candidate.text) }));
    const ordered = [...normalized].sort((a, b) => Number(Boolean(b.protected)) - Number(Boolean(a.protected)) || PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || b.relevance - a.relevance || a.id.localeCompare(b.id));
    const selected: ContextCandidate[] = [];
    const omittedIds: string[] = [];
    let usedTokens = 0;
    for (const candidate of ordered) {
      const fits = usedTokens + candidate.tokenCount <= this.tokenBudget;
      if (fits) {
        selected.push(candidate);
        usedTokens += candidate.tokenCount;
      } else if (candidate.protected) {
        throw new ContextBudgetExceededError(candidate.id, this.tokenBudget, usedTokens + candidate.tokenCount);
      } else {
        omittedIds.push(candidate.id);
      }
    }
    return { items: selected, usedTokens, omittedIds };
  }
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

export class ContextBudgetExceededError extends Error {
  readonly code = "CONTEXT_BUDGET_EXCEEDED" as const;

  constructor(public readonly candidateId: string, public readonly budget: number, public readonly required: number) {
    super(`context budget exceeded by protected item ${candidateId}`);
    this.name = "ContextBudgetExceededError";
  }
}
