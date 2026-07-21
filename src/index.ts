/**
 * aeloop engine entry barrel.
 *
 * Re-exports the intentional public API surface: profile/context/prompt
 * config layers, the workflow/conductor graph builders, the loop runner
 * (start/resume a run, audit trail, checkpointing, events), and the model
 * harness (provider routing, adapter registry, adapter contract types).
 *
 * Internal graph/node helpers and CLI wiring (src/cli/**) are intentionally
 * not re-exported here — they are implementation details of the `aeloop`
 * binary, not library consumer API.
 */
export * from "./shared/types.js";
export * from "./shared/safe-path.js";
export * from "./profile/loader.js";
export * from "./profile/errors.js";
export * from "./profile/personas-root.js";
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

// Loop: run lifecycle, events, audit trail, checkpointing.
export * from "./loop/runner.js";
export * from "./loop/events.js";
export * from "./loop/audit-store.js";
export * from "./loop/checkpoint.js";
export * from "./loop/errors.js";

// Harness: model adapter contract, provider routing, adapter registry.
export * from "./harness/types.js";
export * from "./harness/provider-router.js";
export * from "./harness/adapter-registry.js";
export * from "./harness/config.js";
export * from "./harness/errors.js";
