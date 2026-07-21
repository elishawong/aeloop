/**
 * Minimal adapter that lets a personal ("private scene") brain produce a
 * frozen, contract-valid `TaskContract` for Aeloop, without becoming a
 * brain implementation itself.
 *
 * Scope, deliberately narrow:
 *  - Converts already-distilled `PersonalTaskInput` into a `TaskContract`.
 *  - Validates the result with `assertValidTaskContract`
 *    (src/conductor/contract.ts) -- the same deterministic boundary check
 *    every brain (personal or company) must pass.
 *  - Freezes the produced contract before returning it.
 *
 * Explicitly out of scope (see also src/conductor-personal/types.ts):
 *  - No company data. This file imports only from `../conductor/*`
 *    (the public, product-neutral contract types) and never from any
 *    company-only module.
 *  - No persistence of chat history / transcripts. There is no code path
 *    here that reads or stores a conversation; `PersonalTaskInput` has no
 *    transcript-shaped field to begin with.
 *  - No provider credentials. Nothing in this module accepts or forwards
 *    an API key, token, or model endpoint.
 *  - No tool execution or Git operations. This module has no `exec`,
 *    `spawn`, `child_process`, or `git` usage -- it only builds and
 *    returns data.
 *
 * Dependency direction: this module depends on `src/conductor/*` (public
 * exports only). `src/conductor/*` must never import from
 * `src/conductor-personal/*`.
 */

import { assertValidTaskContract } from "../conductor/contract.js";
import type { TaskContract } from "../conductor/types.js";
import type { PersonalBrainAdapterConfig, PersonalTaskInput } from "./types.js";

/**
 * Deep-freezes a plain, JSON-shaped value in place and returns it. Contract
 * fields are always plain objects/arrays/primitives (see `TaskContract` in
 * `src/conductor/types.ts`), so a structural recursive freeze is safe here
 * and gives the adapter's output the same "frozen once built" guarantee the
 * rest of the conductor boundary relies on via TypeScript `readonly`.
 */
function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && (typeof value === "object" || typeof value === "function") && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Adapts a personal brain's already-distilled task input into a frozen,
 * schema-valid `TaskContract`. Holds only static, non-secret identity
 * (`PersonalBrainAdapterConfig`); holds no memory, no conversation state,
 * and no credentials.
 */
export class PersonalBrainAdapter {
  constructor(private readonly config: PersonalBrainAdapterConfig) {}

  /** Static, credential-free identity for this adapter instance. */
  getConfig(): PersonalBrainAdapterConfig {
    return this.config;
  }

  /**
   * Build a frozen `TaskContract` from already-distilled personal-brain
   * input. Throws `InvalidTaskContractError` (via `assertValidTaskContract`)
   * when the resulting contract does not satisfy the conductor/Aeloop
   * boundary contract -- this adapter never silently coerces invalid input.
   */
  buildContract(input: PersonalTaskInput): TaskContract {
    const candidate: TaskContract = {
      schemaVersion: "1.0",
      contractId: input.contractId,
      objective: input.objective,
      requirements: input.requirements,
      riskLevel: input.riskLevel,
      policy: input.policy,
      sourceSnapshots: input.sourceSnapshots ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
      brain: "personal",
    };
    // Deep-clone before validating/freezing so the caller's original
    // requirements/policy/sourceSnapshots objects (referenced directly in
    // `candidate` above) are never frozen or otherwise mutated as a side
    // effect of building this contract. `structuredClone` is used because
    // `candidate` is guaranteed JSON-shaped (see `TaskContract` in
    // `src/conductor/types.ts`) -- plain objects/arrays/strings/numbers/
    // booleans/null -- which `structuredClone` handles natively without the
    // lossy edge cases of `JSON.parse(JSON.stringify(...))` (e.g. it would
    // silently accept `undefined` values that JSON round-tripping drops).
    const clone = structuredClone(candidate);
    assertValidTaskContract(clone);
    return deepFreeze(clone);
  }
}
