import type { ISODateString } from "../shared/types.js";

/**
 * Current timestamp in the ISO-8601 form stored in every Context-layer
 * TEXT timestamp column (DESIGN §5). A single helper so tests can pass an
 * explicit `now` and production code has one obvious default.
 */
export function nowIso(): ISODateString {
  return new Date().toISOString();
}
