/**
 * Cross-layer shared types. Kept minimal (YAGNI) — grow this file only when
 * a real second layer needs a given type, not speculatively.
 *
 * `Role` is deliberately an open string, not a union of `"coder" | "tester"`.
 * The engine never hardcodes role names (see docs/DESIGN.md §1.7) — persona
 * and schema lookup happen dynamically by name, so a new role should not
 * require touching this type.
 */
export type Role = string;

/**
 * An ISO-8601 date-time string (e.g. `new Date().toISOString()`), as stored
 * in SQLite TEXT columns across the engine's DB schema (docs/DESIGN.md §5).
 */
export type ISODateString = string;
