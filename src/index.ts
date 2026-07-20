/**
 * aeloop engine entry barrel.
 *
 * Only re-exports what actually exists in this increment (A0+A1). Do not
 * add re-exports for harness/loop/cli — those layers don't exist yet
 * (see docs/DESIGN.md §8 milestones A2-A5).
 */
export * from "./shared/types.js";
export * from "./profile/loader.js";
export * from "./profile/errors.js";
