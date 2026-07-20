import { MemoryNotFoundError } from "./errors.js";
import type { MemoryStore } from "./store.js";
import type { Memory } from "./types.js";
import { nowIso } from "./util.js";

/**
 * Confirm / correct / reject a memory's confidence state (DESIGN §5's
 * `memories.confidence_state` three-state model), each backed by a
 * `memory_confirmations` audit row.
 *
 * **Atomicity (PRD §8 acceptance criterion)**: every method wraps its
 * `memories` write *and* its `memory_confirmations` insert in a single
 * `MemoryStore.runInTransaction()` call — a failure partway through rolls
 * back both, never leaving a half-written state (e.g. `confidence_state`
 * flipped to "confirmed" with no corresponding audit row, or vice versa).
 * `MemoryStore.runInTransaction` delegates to `better-sqlite3`'s
 * `db.transaction()`, which auto-rolls-back on any thrown error.
 *
 * **`correct()` semantics (PRD §9.0#5, self-implemented — Verity's
 * `replaceLatest` lives in a company-internal repo this project does not
 * read, so this is not a port of that method's name/signature, just the
 * same underlying idea worked out independently)**: "correct the memory's
 * *current* content." `old_content` on the audit row is always the
 * memory's content *right before this call* — not its original
 * as-inserted content — so a second `correct()` call chains correctly off
 * the first one's result ("latest", not "original"). A correction is
 * itself an act of confirming the corrected text, so `correct()` also
 * marks the memory `confirmed` (same effect on `confidence_state`/
 * `confirmed_at`/`confirmed_by` as `confirm()`).
 *
 * **`reject()` semantics**: sets `confidence_state = "rejected"` but
 * deliberately does *not* clear `confirmed_at`/`confirmed_by` — those
 * columns name a specific historical fact ("when/by whom was this memory
 * last confirmed"), and rejecting it later doesn't retroactively un-happen
 * a prior confirmation. The full action history (including the reject
 * itself, with its own `actor`/timestamp) is always available via
 * `memory_confirmations` regardless of what `memories` currently shows.
 */
export class ConfirmationService {
  constructor(private readonly store: MemoryStore) {}

  confirm(memoryId: number, actor: string, now: string = nowIso()): Memory {
    return this.store.runInTransaction(() => {
      const memory = this.store.getMemoryById(memoryId);
      if (!memory) {
        throw new MemoryNotFoundError(memoryId);
      }

      const updated = this.store.updateMemoryConfidence(memoryId, {
        confidenceState: "confirmed",
        confirmedAt: now,
        confirmedBy: actor,
        updatedAt: now,
      });
      this.store.insertConfirmation(
        { memoryId, action: "confirm", oldContent: null, newContent: null, actor },
        now,
      );
      return updated;
    });
  }

  correct(memoryId: number, newContent: string, actor: string, now: string = nowIso()): Memory {
    return this.store.runInTransaction(() => {
      const memory = this.store.getMemoryById(memoryId);
      if (!memory) {
        throw new MemoryNotFoundError(memoryId);
      }
      const oldContent = memory.content; // "latest" content, not original-as-inserted

      this.store.updateMemoryContent(memoryId, newContent, now);
      const updated = this.store.updateMemoryConfidence(memoryId, {
        confidenceState: "confirmed",
        confirmedAt: now,
        confirmedBy: actor,
        updatedAt: now,
      });
      this.store.insertConfirmation(
        { memoryId, action: "correct", oldContent, newContent, actor },
        now,
      );
      return updated;
    });
  }

  reject(memoryId: number, actor: string, now: string = nowIso()): Memory {
    return this.store.runInTransaction(() => {
      const memory = this.store.getMemoryById(memoryId);
      if (!memory) {
        throw new MemoryNotFoundError(memoryId);
      }

      const updated = this.store.updateMemoryConfidence(memoryId, {
        confidenceState: "rejected",
        confirmedAt: memory.confirmedAt, // preserved, not wiped — see class doc
        confirmedBy: memory.confirmedBy,
        updatedAt: now,
      });
      this.store.insertConfirmation(
        { memoryId, action: "reject", oldContent: memory.content, newContent: null, actor },
        now,
      );
      return updated;
    });
  }
}
