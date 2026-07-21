/**
 * aeloop engine entry barrel.
 *
 * Only re-exports what actually exists in this increment (A0+A1). Do not
 * add re-exports for harness/loop/cli — those layers don't exist yet
 * (see docs/DESIGN.md §8 milestones A2-A5).
 */
export * from "./shared/types.js";
export * from "./shared/safe-path.js";
export * from "./profile/loader.js";
export * from "./profile/errors.js";
export * from "./context/types.js";
export * from "./context/errors.js";
export * from "./context/store.js";
export * from "./context/config.js";
export * from "./context/staleness.js";
export * from "./context/confirmation.js";
export * from "./context/injector.js";
export * from "./context/budget.js";
export * from "./prompt/schema.js";
export * from "./prompt/schema-registry.js";
export * from "./prompt/personas.js";
export * from "./prompt/composer.js";
export * from "./prompt/delta.js";
export * from "./workflow/index.js";
export * from "./conductor/index.js";
export * from "./conductor-work/index.js";
export * from "./conductor-personal/index.js";
export * from "./evidence/index.js";
