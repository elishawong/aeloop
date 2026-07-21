/**
 * Boundary types for the personal-brain adapter.
 *
 * This module is intentionally the *only* place a personal brain touches
 * before handing control to `src/conductor` / Aeloop. It is not a brain
 * implementation itself -- it has no memory, no model calls, no chat log,
 * and no tool/Git execution. It only shapes already-distilled input into a
 * contract that `assertValidTaskContract` (src/conductor/contract.ts)
 * accepts.
 *
 * Explicit exclusions (enforced by the shape of these types, not by
 * documentation alone):
 *  - No full chat transcript field. Callers must pass already-summarized
 *    `objective` / `requirements` text, never a message array or raw log.
 *  - No provider credential / API key field anywhere in this module.
 *  - No company-only identifiers (this adapter only ever produces
 *    `brain: "personal"` contracts; see `PersonalBrainAdapter.buildContract`).
 */

import type { ExecutionPolicy, Requirement, RiskLevel } from "../conductor/types.js";

/** Static identity of a personal-brain instance. Never contains credentials. */
export interface PersonalBrainAdapterConfig {
  readonly brainId: string;
  readonly brainVersion: string;
  readonly defaultWorkflowId: string;
}

/**
 * Already-distilled task input from a personal brain.
 *
 * This is deliberately *not* a chat/transcript shape: no `messages`,
 * `history`, or `transcript` field exists here, and none should be added.
 * A personal brain is responsible for summarizing its own conversation
 * into `objective` + `requirements` before calling this adapter; Aeloop
 * (and this adapter) never sees or stores the underlying conversation.
 */
export interface PersonalTaskInput {
  readonly contractId: string;
  readonly objective: string;
  readonly requirements: readonly Requirement[];
  readonly riskLevel: RiskLevel;
  readonly policy: ExecutionPolicy;
  /** Content-hash-style references only (e.g. `"NOTES.md": "sha256:..."`), never raw document bodies. */
  readonly sourceSnapshots?: Readonly<Record<string, string>>;
  /** Defaults to the adapter's build-time clock if omitted. */
  readonly createdAt?: string;
}
