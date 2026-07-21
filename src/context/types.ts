/**
 * Context-layer domain types. Aligned to docs/DESIGN.md §5 (DB schema —
 * `[prior-proven]` M2, with the three columns aeloop adds back:
 * `memories.confirmed_at`/`confirmed_by`, `memory_confirmations.actor`,
 * `system_config.updated_at`).
 *
 * These are *domain* shapes (camelCase, parsed `tags`), not raw SQLite row
 * shapes (snake_case, `tags` as a JSON string) — `store.ts` owns the
 * row↔domain mapping at the boundary.
 */
import type { ISODateString } from "../shared/types.js";

/**
 * The 12 memory types listed in docs/DESIGN.md §5's `MEMORIES.type` comment.
 * Kept as a union (not an open string like `Role`) because this set is a
 * closed vocabulary defined by the schema design, not a plugin extension
 * point like role names (see DESIGN §1.7).
 */
export type MemoryType =
  | "identity"
  | "snapshot"
  | "active_task"
  | "idea"
  | "decision"
  | "postmortem"
  | "map"
  | "constraint"
  | "relation"
  | "agent_spec"
  | "requirement"
  | "project_registry";

export type ConfidenceState = "unconfirmed" | "confirmed" | "rejected";

export interface Memory {
  id: number;
  type: MemoryType;
  title: string;
  content: string;
  sourceFile: string | null;
  /** Parsed from the `tags` TEXT column (JSON array string, PRD §9.0#4). */
  tags: string[];
  confidenceState: ConfidenceState;
  /** NULL means "read `system_config.default_stale_days` instead" (DESIGN §5). */
  staleOverrideDays: number | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  confirmedAt: ISODateString | null;
  confirmedBy: string | null;
}

/** Fields the caller supplies when creating a memory; the store assigns id/timestamps. */
export interface NewMemoryInput {
  type: MemoryType;
  title: string;
  content: string;
  sourceFile?: string | null;
  tags?: string[];
  confidenceState?: ConfidenceState;
  staleOverrideDays?: number | null;
}

export type ConfirmationAction = "confirm" | "correct" | "reject";

export interface MemoryConfirmation {
  id: number;
  memoryId: number;
  action: ConfirmationAction;
  oldContent: string | null;
  newContent: string | null;
  actor: string;
  createdAt: ISODateString;
}

/** Fields the caller supplies when recording a confirmation-history row. */
export interface NewMemoryConfirmationInput {
  memoryId: number;
  action: ConfirmationAction;
  oldContent: string | null;
  newContent: string | null;
  actor: string;
}

export interface SystemConfigEntry {
  key: string;
  value: string;
  updatedAt: ISODateString;
}
