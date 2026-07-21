/**
 * Typed errors for the Context layer (src/context/*).
 *
 * PRD §8 acceptance criteria this file exists to satisfy:
 * - "RecallError is never silent" — recall/read failures must be thrown as a typed
 *   `RecallError`, never swallowed into an empty array.
 * - "every JSON.parse call site is wrapped in try-catch, failures become a typed
 *   error, never a raw thrown SyntaxError" — `tags` deserialization failures become
 *   `MemoryTagsParseError`, never a raw `SyntaxError`.
 */

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A read/search against the store failed (SQLite raised, malformed FTS5
 * query, closed connection, etc.). Thrown, never returned as data and never
 * silently downgraded to an empty result — a caller that wants "no memories
 * found" gets an empty array from a *successful* query, which is a
 * different thing from "the query itself failed".
 */
export class RecallError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause !== undefined ? `${message}: ${describeCause(cause)}` : message, {
      cause,
    });
    this.name = "RecallError";
  }
}

/**
 * A `memories.tags` column value failed to parse as the JSON array string
 * it's expected to be (PRD §9.0#4). Distinct from `RecallError`: the SQL
 * query itself succeeded, it's the stored payload that's malformed.
 */
export class MemoryTagsParseError extends Error {
  readonly memoryId: number | undefined;
  readonly raw: string;

  constructor(raw: string, cause: unknown, memoryId?: number) {
    super(
      `Failed to parse memory${memoryId !== undefined ? ` ${memoryId}` : ""} tags as JSON: ${describeCause(cause)}`,
      { cause },
    );
    this.name = "MemoryTagsParseError";
    this.raw = raw;
    this.memoryId = memoryId;
  }
}

/** A confirmation/correct/reject operation failed (outside the "memory not found" case below). */
export class ConfirmationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause !== undefined ? `${message}: ${describeCause(cause)}` : message, {
      cause,
    });
    this.name = "ConfirmationError";
  }
}

/** `ConfirmationService`/`ContextInjector` operated on a memory id that doesn't exist. */
export class MemoryNotFoundError extends Error {
  readonly memoryId: number;

  constructor(memoryId: number) {
    super(`Memory ${memoryId} not found`);
    this.name = "MemoryNotFoundError";
    this.memoryId = memoryId;
  }
}
