import Database from "better-sqlite3";
import {
  MemoryNotFoundError,
  MemoryTagsParseError,
  RecallError,
} from "./errors.js";
import type {
  ConfidenceState,
  ConfirmationAction,
  Memory,
  MemoryConfirmation,
  MemoryType,
  NewMemoryConfirmationInput,
  NewMemoryInput,
  SystemConfigEntry,
} from "./types.js";
import { nowIso } from "./util.js";

/** Raw SQLite row shape for `memories` (snake_case, `tags` still a JSON string). */
interface MemoryRow {
  id: number;
  type: string;
  title: string;
  content: string;
  source_file: string | null;
  tags: string;
  confidence_state: string;
  stale_override_days: number | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
}

interface MemoryConfirmationRow {
  id: number;
  memory_id: number;
  action: string;
  old_content: string | null;
  new_content: string | null;
  actor: string;
  created_at: string;
}

interface SystemConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

/** Patch accepted by `updateMemoryConfidence` — always writes all four columns together. */
export interface MemoryConfidencePatch {
  confidenceState: ConfidenceState;
  confirmedAt: string | null;
  confirmedBy: string | null;
  updatedAt: string;
}

/**
 * SQLite(+FTS5)-backed store for `memories` / `memory_confirmations` /
 * `system_config` (docs/DESIGN.md §5). Owns the raw `better-sqlite3`
 * connection and the row↔domain mapping boundary — higher-level Context
 * services (`ConfirmationService`, `ContextInjector`, `SystemConfig`,
 * `StalenessEngine`) go through this, none of them touch SQL directly.
 *
 * Takes an explicit `dbPath` (a file path, or `":memory:"` for tests).
 * This increment does not wire it to `profile/loader.ts` (PRD §6 B2 note:
 * "profile needs to decide the db path convention, but store itself can
 * first be implemented with an explicit path parameter, without tightly
 * coupling to profile") — that wiring belongs to a later increment.
 *
 * **Error-wrapping convention** (PRD §8 acceptance criteria): every *read*
 * method (`getMemoryById`/`listMemories`/`searchMemories`/
 * `getConfirmationsForMemory`/`getConfigEntry`) wraps a thrown SQLite error
 * into a typed `RecallError` instead of ever silently downgrading a failed
 * query into an empty result. *Write* methods let `better-sqlite3`'s own
 * typed `SqliteError` propagate unwrapped — they're not "recall" and there
 * is no silent-empty-result temptation to guard against there.
 */
export class MemoryStore {
  private readonly db: Database.Database;

  private readonly insertMemoryStmt: Database.Statement<unknown[]>;
  private readonly getMemoryByIdStmt: Database.Statement<[number], MemoryRow>;
  private readonly listMemoriesStmt: Database.Statement<[], MemoryRow>;
  private readonly deleteMemoryStmt: Database.Statement<[number]>;
  private readonly updateMemoryConfidenceStmt: Database.Statement<unknown[]>;
  private readonly updateMemoryContentStmt: Database.Statement<unknown[]>;
  private readonly insertConfirmationStmt: Database.Statement<unknown[]>;
  private readonly listConfirmationsForMemoryStmt: Database.Statement<[number], MemoryConfirmationRow>;
  private readonly getConfigEntryStmt: Database.Statement<[string], SystemConfigRow>;
  private readonly setConfigEntryStmt: Database.Statement<unknown[]>;
  private readonly searchMemoriesStmt: Database.Statement<[string], MemoryRow>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("foreign_keys = ON");
    this.createSchema();

    this.insertMemoryStmt = this.db.prepare(
      `INSERT INTO memories
        (type, title, content, source_file, tags, confidence_state, stale_override_days, created_at, updated_at, confirmed_at, confirmed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getMemoryByIdStmt = this.db.prepare<[number], MemoryRow>(`SELECT * FROM memories WHERE id = ?`);
    this.listMemoriesStmt = this.db.prepare<[], MemoryRow>(`SELECT * FROM memories ORDER BY id`);
    this.deleteMemoryStmt = this.db.prepare<[number]>(`DELETE FROM memories WHERE id = ?`);
    this.updateMemoryConfidenceStmt = this.db.prepare(
      `UPDATE memories SET confidence_state = ?, confirmed_at = ?, confirmed_by = ?, updated_at = ? WHERE id = ?`,
    );
    this.updateMemoryContentStmt = this.db.prepare(
      `UPDATE memories SET content = ?, updated_at = ? WHERE id = ?`,
    );
    this.insertConfirmationStmt = this.db.prepare(
      `INSERT INTO memory_confirmations (memory_id, action, old_content, new_content, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.listConfirmationsForMemoryStmt = this.db.prepare<[number], MemoryConfirmationRow>(
      `SELECT * FROM memory_confirmations WHERE memory_id = ? ORDER BY created_at, id`,
    );
    this.getConfigEntryStmt = this.db.prepare<[string], SystemConfigRow>(
      `SELECT * FROM system_config WHERE key = ?`,
    );
    this.setConfigEntryStmt = this.db.prepare(
      `INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    // External-content FTS5 table (content='memories', content_rowid='id') —
    // memories_fts carries no data of its own, it indexes memories rows via
    // the sync triggers in createSchema(). Joining back to `memories` gets
    // the full row (fts5 only mirrors title/content/tags).
    this.searchMemoriesStmt = this.db.prepare<[string], MemoryRow>(
      `SELECT m.* FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ?
       ORDER BY rank`,
    );
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a single `better-sqlite3` transaction; rolls back entirely on throw. */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_file TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        confidence_state TEXT NOT NULL DEFAULT 'unconfirmed',
        stale_override_days INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        confirmed_by TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_confirmations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memories(id),
        action TEXT NOT NULL,
        old_content TEXT,
        new_content TEXT,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        title, content, tags,
        content='memories',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.id, new.title, new.content, new.tags);
      END;
    `);
  }

  private mapRow(row: MemoryRow): Memory {
    let tags: string[];
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
        throw new Error(`expected a JSON array of strings, got ${JSON.stringify(parsed)}`);
      }
      tags = parsed;
    } catch (cause) {
      throw new MemoryTagsParseError(row.tags, cause, row.id);
    }

    return {
      id: row.id,
      type: row.type as MemoryType,
      title: row.title,
      content: row.content,
      sourceFile: row.source_file,
      tags,
      confidenceState: row.confidence_state as ConfidenceState,
      staleOverrideDays: row.stale_override_days,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      confirmedAt: row.confirmed_at,
      confirmedBy: row.confirmed_by,
    };
  }

  // ---- memories CRUD ------------------------------------------------

  insertMemory(input: NewMemoryInput, now: string = nowIso()): Memory {
    const tagsJson = JSON.stringify(input.tags ?? []);
    const result = this.insertMemoryStmt.run(
      input.type,
      input.title,
      input.content,
      input.sourceFile ?? null,
      tagsJson,
      input.confidenceState ?? "unconfirmed",
      input.staleOverrideDays ?? null,
      now,
      now,
      null,
      null,
    );
    const id = Number(result.lastInsertRowid);
    const created = this.getMemoryById(id);
    if (!created) {
      throw new RecallError(`Failed to read back memory ${id} immediately after insert`);
    }
    return created;
  }

  getMemoryById(id: number): Memory | undefined {
    let row: MemoryRow | undefined;
    try {
      row = this.getMemoryByIdStmt.get(id);
    } catch (cause) {
      throw new RecallError(`Failed to read memory ${id}`, cause);
    }
    return row === undefined ? undefined : this.mapRow(row);
  }

  listMemories(): Memory[] {
    let rows: MemoryRow[];
    try {
      rows = this.listMemoriesStmt.all();
    } catch (cause) {
      throw new RecallError("Failed to list memories", cause);
    }
    return rows.map((row) => this.mapRow(row));
  }

  deleteMemory(id: number): void {
    this.deleteMemoryStmt.run(id);
  }

  /** Writes `confidence_state`/`confirmed_at`/`confirmed_by`/`updated_at` together. */
  updateMemoryConfidence(id: number, patch: MemoryConfidencePatch): Memory {
    const result = this.updateMemoryConfidenceStmt.run(
      patch.confidenceState,
      patch.confirmedAt,
      patch.confirmedBy,
      patch.updatedAt,
      id,
    );
    if (result.changes === 0) {
      throw new MemoryNotFoundError(id);
    }
    const updated = this.getMemoryById(id);
    if (!updated) {
      throw new MemoryNotFoundError(id);
    }
    return updated;
  }

  /** Writes `content`/`updated_at` (used by `ConfirmationService.correct()`). */
  updateMemoryContent(id: number, content: string, updatedAt: string): Memory {
    const result = this.updateMemoryContentStmt.run(content, updatedAt, id);
    if (result.changes === 0) {
      throw new MemoryNotFoundError(id);
    }
    const updated = this.getMemoryById(id);
    if (!updated) {
      throw new MemoryNotFoundError(id);
    }
    return updated;
  }

  // ---- memory_confirmations -------------------------------------------

  insertConfirmation(input: NewMemoryConfirmationInput, now: string = nowIso()): MemoryConfirmation {
    const result = this.insertConfirmationStmt.run(
      input.memoryId,
      input.action,
      input.oldContent,
      input.newContent,
      input.actor,
      now,
    );
    return {
      id: Number(result.lastInsertRowid),
      memoryId: input.memoryId,
      action: input.action,
      oldContent: input.oldContent,
      newContent: input.newContent,
      actor: input.actor,
      createdAt: now,
    };
  }

  getConfirmationsForMemory(memoryId: number): MemoryConfirmation[] {
    let rows: MemoryConfirmationRow[];
    try {
      rows = this.listConfirmationsForMemoryStmt.all(memoryId);
    } catch (cause) {
      throw new RecallError(`Failed to read confirmations for memory ${memoryId}`, cause);
    }
    return rows.map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      action: row.action as ConfirmationAction,
      oldContent: row.old_content,
      newContent: row.new_content,
      actor: row.actor,
      createdAt: row.created_at,
    }));
  }

  // ---- system_config ---------------------------------------------------

  getConfigEntry(key: string): SystemConfigEntry | undefined {
    let row: SystemConfigRow | undefined;
    try {
      row = this.getConfigEntryStmt.get(key);
    } catch (cause) {
      throw new RecallError(`Failed to read system_config key "${key}"`, cause);
    }
    return row === undefined ? undefined : { key: row.key, value: row.value, updatedAt: row.updated_at };
  }

  setConfigEntry(key: string, value: string, updatedAt: string = nowIso()): SystemConfigEntry {
    this.setConfigEntryStmt.run(key, value, updatedAt);
    return { key, value, updatedAt };
  }

  // ---- FTS5 recall -------------------------------------------------------

  /**
   * FTS5 keyword recall over `title`/`content`/`tags`.
   *
   * `query` is treated as **plain natural-language text**, not raw FTS5
   * query syntax — this is the caller-facing contract (`ContextInjector`
   * feeds this arbitrary task descriptions, DESIGN §3). It is tokenized on
   * whitespace and every token is wrapped as an FTS5 quoted phrase before
   * being sent to `MATCH` (`toSafeFtsQuery` below). This matters because
   * FTS5's query syntax gives special meaning to characters that show up
   * constantly in ordinary text — a bare hyphen is a column-exclusion/NOT
   * operator, so `"retry-backoff"` unquoted is a syntax error, and so is
   * `"C++"` (`+` inside an unquoted term). Quoting each token sidesteps the
   * operator grammar entirely while leaving FTS5's tokenizer (which runs
   * the same way inside a quoted phrase as outside one) to still match
   * multi-word phrases correctly, because insert-time content and
   * query-time phrases are tokenized by the same rules (see
   * `store.test.ts`'s "FTS5 recall — natural-language query safety" cases
   * for concrete hyphenated/punctuated examples).
   *
   * A real SQLite-level failure (e.g. the `memories_fts` index itself
   * missing/corrupted) still throws `RecallError` wrapping the cause —
   * this fix only changes what reaches `MATCH`, it does not swallow a
   * genuine DB error into an empty result (PRD §8).
   */
  searchMemories(query: string): Memory[] {
    const ftsQuery = toSafeFtsQuery(query);
    if (ftsQuery === null) return [];

    let rows: MemoryRow[];
    try {
      rows = this.searchMemoriesStmt.all(ftsQuery);
    } catch (cause) {
      throw new RecallError(`FTS5 recall query failed for "${query}"`, cause);
    }
    return rows.map((row) => this.mapRow(row));
  }
}

/**
 * `\p{L}`/`\p{N}` = Unicode letter/number — used to drop tokens that carry
 * no actual word content after quoting (e.g. a stray `"--"` word in the
 * input), which would otherwise become an empty/degenerate FTS5 phrase.
 */
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Turns free-form text into a safe FTS5 `MATCH` argument: split on
 * whitespace, drop tokens with no letters/digits, wrap each surviving
 * token as a quoted phrase (doubling any embedded `"` per FTS5's string
 * literal escaping), and join with spaces (FTS5's implicit `AND` between
 * adjacent phrases/terms). Returns `null` for input with no matchable
 * tokens at all, so the caller can short-circuit to `[]` without ever
 * touching the database — an empty/whitespace-only search is a legitimate
 * "nothing to search for", not a query failure.
 */
function toSafeFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && HAS_WORD_CHAR.test(token));

  if (tokens.length === 0) return null;

  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}
