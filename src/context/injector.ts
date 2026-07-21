import { ContextBudgetManager, estimateTokens, type ContextCandidate, type ContextPriority } from "./budget.js";
import type { StalenessEngine } from "./staleness.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemoryType } from "./types.js";

export type InjectionWarning = "stale" | "unconfirmed" | null;

/**
 * Recommended `context.token_budget` value for profiles that opt into
 * budget enforcement (`profile/loader.ts`'s `ProfileConfig.context.token_budget`
 * doc comment). Purely a documented suggestion — never applied implicitly;
 * a profile must set it explicitly to change behavior (backward
 * compatibility, issue #36 slice 1).
 *
 * 8000 is a conservative estimate-token budget (see `budget.ts`'s
 * `estimateTokens()`, ~4 chars/token) for the *memories* section alone,
 * leaving headroom in a typical model context window for the persona,
 * output-schema description, and task text `PromptComposer` also renders
 * (none of which are counted against this budget in this slice).
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 8000;

/**
 * Deterministic `MemoryType -> ContextPriority` mapping (issue #36 slice 1
 * required design decision: "Define deterministic MemoryType ->
 * ContextPriority mapping").
 *
 * `constraint`/`requirement`/`decision` are treated as protected
 * governance memory — see `PROTECTED_MEMORY_TYPES` below. This mapping
 * only picks which `ContextPriority` bucket (and therefore which
 * `PRIORITY_WEIGHT` in `budget.ts`) each type sorts into when the budget
 * has to choose among several protected, or several non-protected, items;
 * it is an implementation choice for tie-breaking, not a spec fact.
 *
 * IMPORTANT (explicitly NOT claimed here): this mapping only ever sees
 * `Memory` rows that already made it into a `ContextInjectionResult`. It
 * has no visibility into, and makes no claim about protecting, a
 * `TaskContract` or `RunPolicy` object — those types are not part of this
 * result shape at all in this codebase, so "protects contract/policy" in
 * the issue-#36 sense would be a false claim about this code; what this
 * mapping actually protects is memories of type `constraint`/`requirement`/
 * `decision`.
 */
export const MEMORY_TYPE_CONTEXT_PRIORITY: Readonly<Record<MemoryType, ContextPriority>> = {
  requirement: "contract",
  constraint: "policy",
  decision: "gate",
  identity: "memory",
  agent_spec: "memory",
  active_task: "memory",
  snapshot: "general",
  idea: "general",
  postmortem: "general",
  map: "general",
  relation: "general",
  project_registry: "general",
};

/**
 * The `MemoryType`s treated as protected governance memory for budget
 * purposes (issue #36 slice 1: "Preserve ... as protected context; fail
 * closed if protected content cannot fit"). `ContextBudgetManager.select()`
 * never silently drops a candidate marked `protected: true` — it throws
 * `ContextBudgetExceededError` instead (fail-closed, not fail-open).
 */
export const PROTECTED_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "constraint",
  "requirement",
  "decision",
]);

/**
 * The `MemoryType`s (DESIGN §5's 12-value `memories.type` enum) that count
 * as "core" — always injected in full, independent of any task-specific
 * `query`. Everything else is only injected when it's actually recalled by
 * an FTS5 keyword hit against `query`.
 *
 * This is a documented **implementation choice**, not a spec fact — DESIGN
 * §3's sequence-diagram comment says "core = full recall + FTS5 recall" but never defines
 * which types are "core". Fixing this (review, feature/issue-1-a0-a1-scaffold):
 * the prior implementation treated *every* memory as core (`core =
 * store.listMemories()`), which made the FTS5 recall branch dead code —
 * its results were always a subset of `core`, so merging them in changed
 * nothing observable, and `injector.test.ts`'s old "merge" test could not
 * actually distinguish "FTS5 recall works" from "FTS5 recall does nothing"
 * (both produce the same result when core = everything).
 *
 * The three types chosen here — `identity`/`constraint`/`decision` — are
 * exactly the examples the review itself used for
 * "always-want" memories: durable facts about who/what the agent is and
 * what it has committed to, as opposed to session/task-scoped types
 * (`active_task`/`idea`/`snapshot`/`postmortem`/…) that should only surface
 * when a task's keywords actually recall them.
 */
export const CORE_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  "identity",
  "constraint",
  "decision",
]);

export interface InjectedMemory {
  memory: Memory;
  warning: InjectionWarning;
}

/**
 * One memory that `ContextBudgetManager` chose to omit for lack of budget
 * (issue #36 slice 1: "Record omitted context IDs and reasons in
 * evidence/audit output"). Never present for a protected memory — those
 * either fit or the whole `inject()` call throws
 * `ContextBudgetExceededError` (fail-closed).
 */
export interface OmittedMemory {
  readonly id: number;
  readonly type: MemoryType;
  readonly title: string;
  readonly reason: "token_budget_exceeded";
}

export interface ContextInjectionResult {
  memories: InjectedMemory[];
  /**
   * Present only when this `ContextInjector` was constructed with a
   * `ContextBudgetManager` (i.e. the profile set `context.token_budget`).
   * `undefined` — not an empty array — when no budget manager is
   * configured, so callers can distinguish "budgeting is off" from
   * "budgeting is on and nothing was omitted".
   */
  omitted?: OmittedMemory[];
}

/**
 * Injects memories for a Prompt-layer consumer (`PromptComposer`, B8) to
 * assemble into a final prompt. DESIGN §3 sequence: "ContextInjector injects
 * (core full recall + FTS5 recall, filters rejected, stale/unconfirmed tagged with warning)".
 *
 * Three rules, straight from that sequence-diagram note:
 * 1. Core memories (full recall) + FTS5 keyword recall for an optional
 *    task-specific `query`, merged and deduped by id.
 * 2. `confidence_state === "rejected"` memories are filtered out entirely
 *    — they never reach the Prompt layer.
 * 3. Stale or unconfirmed memories are *kept*, tagged with a warning —
 *    injector only filters rejected, never stale/unconfirmed (that
 *    distinction is deliberate per DESIGN §3's comment).
 *
 * Depends only on Context-layer types (`Memory`, `MemoryStore`,
 * `StalenessEngine`) — never imports anything from `src/prompt/` (DESIGN
 * §1.7: "nesting = the outer layer uses the inner layer, the inner layer
 * doesn't know about the outer layer"; no reverse dependency). A
 * `RecallError` thrown by `store.searchMemories()` propagates unchanged —
 * this class does not catch it and turn a failed recall into an empty
 * result (PRD §8: "RecallError is never silent").
 */
export class ContextInjector {
  /**
   * `budgetManager` is optional and defaults to `undefined` — matching
   * `ProfileConfig.context.token_budget`'s own "absent = today's unbounded
   * behavior" contract (`profile/loader.ts`). When absent, `inject()`
   * behaves exactly as before this slice: no `ContextBudgetManager` is
   * constructed anywhere in this class, `result.omitted` is never set, and
   * every non-rejected core/recalled memory is returned regardless of size.
   */
  constructor(
    private readonly store: MemoryStore,
    private readonly staleness: StalenessEngine,
    private readonly budgetManager?: ContextBudgetManager,
  ) {}

  /**
   * `query` is optional task-specific FTS5 keyword text; when supplied,
   * its hits are merged into the `CORE_MEMORY_TYPES` full-recall set. Core
   * memories are always loaded regardless of `query` — everything else
   * only appears in the result when `query` actually recalls it (see
   * `CORE_MEMORY_TYPES`'s doc comment for why this distinction matters and
   * what changed).
   *
   * `asOf` threads through to `StalenessEngine.isStale()` — an explicit
   * parameter (defaulting to "now") so tests don't need to fake the
   * system clock to exercise staleness boundaries.
   */
  inject(query?: string, asOf: Date = new Date()): ContextInjectionResult {
    const core = this.store.listMemories().filter((memory) => CORE_MEMORY_TYPES.has(memory.type));
    const recalled = query && query.trim().length > 0 ? this.store.searchMemories(query) : [];

    const byId = new Map<number, Memory>();
    for (const memory of [...core, ...recalled]) {
      byId.set(memory.id, memory);
    }

    const memories = [...byId.values()]
      .filter((memory) => memory.confidenceState !== "rejected")
      .map((memory) => ({ memory, warning: this.warningFor(memory, asOf) }));

    if (!this.budgetManager) return { memories };

    return this.applyBudget(memories);
  }

  /**
   * Runs the already rejected-filtered, warning-tagged `memories` through
   * `this.budgetManager`. Selection order (protected-first, then
   * `MEMORY_TYPE_CONTEXT_PRIORITY` weight, per `budget.ts`'s
   * `ContextBudgetManager.select()`) is entirely `ContextBudgetManager`'s
   * job — this method only translates to/from its `ContextCandidate`/
   * `ContextBudgetSelection` shapes and re-attaches the original
   * `InjectedMemory`/`Memory` objects the composer needs.
   *
   * `ContextBudgetExceededError` (protected memory can't fit) is not
   * caught here — it propagates to the caller unchanged, same "never turn
   * a hard failure into a silent empty/partial result" posture
   * `RecallError` already has in this class (fail-closed, PRD-consistent
   * with issue #36's "fail closed if protected content cannot fit").
   */
  private applyBudget(memories: InjectedMemory[]): ContextInjectionResult {
    const byCandidateId = new Map<string, InjectedMemory>();
    const candidates: ContextCandidate[] = memories.map((entry) => {
      const candidateId = String(entry.memory.id);
      byCandidateId.set(candidateId, entry);
      const text = `${entry.memory.title}\n${entry.memory.content}`;
      return {
        id: candidateId,
        text,
        priority: MEMORY_TYPE_CONTEXT_PRIORITY[entry.memory.type],
        relevance: 0,
        tokenCount: estimateTokens(text),
        protected: PROTECTED_MEMORY_TYPES.has(entry.memory.type),
      };
    });

    // this.budgetManager! is safe: applyBudget() is only ever called from
    // inject() right after the `if (!this.budgetManager) return ...` guard.
    const selection = this.budgetManager!.select(candidates);

    const selectedIds = new Set(selection.items.map((item) => item.id));
    const selectedMemories = memories.filter((entry) => selectedIds.has(String(entry.memory.id)));

    const omitted: OmittedMemory[] = selection.omittedIds.map((id) => {
      const entry = byCandidateId.get(id);
      if (!entry) {
        // Unreachable in practice: every omittedId came from a candidate
        // this method itself built from `memories`, via the same `id`
        // encoding (`String(memory.id)`). Kept as a defensive throw rather
        // than a silent `undefined` dereference, consistent with this
        // codebase's "never turn an invariant violation into a quiet
        // wrong answer" posture.
        throw new Error(`ContextBudgetManager reported unknown omitted id: ${id}`);
      }
      return {
        id: entry.memory.id,
        type: entry.memory.type,
        title: entry.memory.title,
        reason: "token_budget_exceeded",
      };
    });

    return { memories: selectedMemories, omitted };
  }

  /**
   * A memory can be both stale and unconfirmed at once; "stale" wins —
   * it's a stronger, time-decay-based signal than the static unconfirmed
   * state, and DESIGN doesn't specify a priority, so this is a documented
   * implementation choice, not a spec fact.
   */
  private warningFor(memory: Memory, asOf: Date): InjectionWarning {
    if (this.staleness.isStale(memory, asOf)) return "stale";
    if (memory.confidenceState === "unconfirmed") return "unconfirmed";
    return null;
  }
}
