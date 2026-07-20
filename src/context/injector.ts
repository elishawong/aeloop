import type { StalenessEngine } from "./staleness.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";

export type InjectionWarning = "stale" | "unconfirmed" | null;

export interface InjectedMemory {
  memory: Memory;
  warning: InjectionWarning;
}

export interface ContextInjectionResult {
  memories: InjectedMemory[];
}

/**
 * Injects memories for a Prompt-layer consumer (`PromptComposer`, B8) to
 * assemble into a final prompt. DESIGN §3 sequence: "ContextInjector 注入
 * (核心全量+FTS5召回, 滤 rejected, stale/unconfirmed 带警告)".
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
 * §1.7: "嵌套 = 外层用内层,内层不知道外层"; no reverse dependency). A
 * `RecallError` thrown by `store.searchMemories()` propagates unchanged —
 * this class does not catch it and turn a failed recall into an empty
 * result (PRD §8: "RecallError 不静默").
 */
export class ContextInjector {
  constructor(
    private readonly store: MemoryStore,
    private readonly staleness: StalenessEngine,
  ) {}

  /**
   * `query` is optional task-specific FTS5 keyword text; when supplied,
   * its hits are merged into the "core memories" set. "Core memories, full
   * recall" is implemented as everything currently in the store — aeloop
   * targets personal-CLI scale (DESIGN §4.3), and no curated
   * core-memory-type filter is specified anywhere in DESIGN/PRD for this
   * increment, so a full table scan is the honest MVP baseline rather than
   * an invented filter.
   *
   * `asOf` threads through to `StalenessEngine.isStale()` — an explicit
   * parameter (defaulting to "now") so tests don't need to fake the
   * system clock to exercise staleness boundaries.
   */
  inject(query?: string, asOf: Date = new Date()): ContextInjectionResult {
    const core = this.store.listMemories();
    const recalled = query && query.trim().length > 0 ? this.store.searchMemories(query) : [];

    const byId = new Map<number, Memory>();
    for (const memory of [...core, ...recalled]) {
      byId.set(memory.id, memory);
    }

    const memories = [...byId.values()]
      .filter((memory) => memory.confidenceState !== "rejected")
      .map((memory) => ({ memory, warning: this.warningFor(memory, asOf) }));

    return { memories };
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
