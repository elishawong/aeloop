# issue #36 slice 1 — wire `ContextBudgetManager` into the real `ContextInjector` -> `PromptComposer` path

## issue #36 slice 2 — carry context-omission metadata into `EvidenceBundle`

Follow-up to slice 1: slice 1 stopped at "the omission list visible in the
injector's return value and in the composed prompt text" — this slice
carries that same information one hop further, into the engine's
`LoopEvent`/`EvidenceBundle` observability surface (issue #29), so a
subscriber of the evidence layer can see what got omitted without reaching
into `ContextInjectionResult` directly.

**What was added:**

- **`src/loop/events.ts`** — `RunStartedEvent` gained an optional
  `contextOmitted?: readonly {id:number; type:string; title:string;
  reason:string}[]` field. No new `LoopEvent` variant was introduced and no
  existing event ordering changed — this rides entirely on the existing
  `run_started` event.
- **`src/loop/runner.ts`** — `startRun()` now populates `contextOmitted`
  from `input.injectedContext.omitted` when that field is present and
  non-empty. When absent (budgeting off) or empty (nothing omitted),
  `contextOmitted` itself is left **absent** (the key is not set at all,
  not set to `[]`) — matching `ContextInjectionResult.omitted`'s own
  "absent means nothing to report" convention, and keeping every
  pre-existing `run_started` fixture/assertion in `runner.test.ts`
  (`toMatchObject`, which doesn't otherwise care about extra fields) valid
  unchanged.
- **`src/evidence/bundle.ts`**:
  - New `OmittedContextEntry` type (mirrors `RunStartedEvent`'s
    `contextOmitted` element shape).
  - `EvidenceBundle` gained a new required `omittedContext: readonly
    OmittedContextEntry[]` collection, following the same
    always-present/default-to-`[]` convention its sibling collections
    (`requirements`/`claims`/`evidence`/`eventTypes`) already use — never
    `undefined`.
  - `EvidenceBundleBuilder.recordEvent()` picks up `contextOmitted` off a
    `run_started` event when present; any other event, or a `run_started`
    event without that field (an old event, or budgeting-off), leaves
    `omittedContext` at its `[]` default — no throw, no special-casing.
  - `EvidenceEventProjector` needed no code change — it already forwards
    every event to `builder.recordEvent()` unconditionally, so this new
    field rides through the same path as `eventTypes`/`status`.

**Explicitly NOT touched in this slice** (next slice's boundary):

- `PromptDelta` / `buildPromptDelta()` — still untouched, same as slice 1.
- Provider-level caching — still untouched, same as slice 1.
- `AuditStore` schema — no new column/table; `omittedContext` lives only in
  the in-memory `EvidenceBundle`/`LoopEvent` layer, not persisted anywhere
  durable yet. Wiring it into `AuditStore` (if ever needed) is a separate,
  not-yet-started piece of work.
- No new `LoopEvent` type was added, and no existing event's relative
  ordering was changed anywhere in `runner.ts`.

## Scope of this slice

This slice implements exactly one bounded piece of aeloop#36: making the
already-tested `ContextBudgetManager` (`src/context/budget.ts`) actually
reachable from the real CLI/loop path, so a profile can put a hard token
ceiling on injected context and see, in an auditable way, what got left out
and why.

**Explicitly out of scope for this slice** (separate follow-up work, not
started here):

- `buildPromptDelta()` / `PromptDelta` (stable-prefix caching, delta-only
  retries) — still has no caller anywhere in loop/CLI/harness after this
  slice. Whether it belongs in `PromptComposer`, the adapter request layer,
  or the provider cache layer is an open design question the original issue
  itself flags as undecided; this slice does not attempt to answer it.
- Provider-level caching (e.g. Anthropic prompt caching headers) is
  untouched.
- Wiring `omitted` context into a persistent evidence/audit store. This
  slice makes the omission list visible in the injector's return value and
  in the composed prompt text (see below); it does not write it anywhere
  durable (`AuditStore`, etc.).

## What changed

- **`src/profile/loader.ts`** — `ProfileConfig` gained an optional
  `context.token_budget?: number` field. Omitting `context` (or
  `context.token_budget` within it) leaves behavior completely unchanged —
  there is no implicit default applied. `DEFAULT_CONTEXT_TOKEN_BUDGET`
  (`src/context/injector.ts`) is a documented, opt-in recommended value
  (`8000`), never auto-applied.
- **`src/context/injector.ts`**:
  - `MEMORY_TYPE_CONTEXT_PRIORITY`: a deterministic `MemoryType ->
    ContextPriority` mapping covering all 12 memory types.
  - `PROTECTED_MEMORY_TYPES`: `constraint` / `requirement` / `decision` are
    treated as protected governance memory — `ContextBudgetManager` never
    silently drops them; if one can't fit, `inject()` throws
    `ContextBudgetExceededError` (fail-closed), it does not fall back to an
    empty/partial result.
  - `ContextInjector`'s constructor takes an optional third
    `budgetManager?: ContextBudgetManager` parameter. When absent (the
    default), `inject()` is byte-for-byte the same as before this slice.
    When present, the already rejected-filtered, warning-tagged memory list
    is run through the budget manager, and `ContextInjectionResult` gains
    an optional `omitted?: OmittedMemory[]` field recording which memory
    ids were left out and why.
  - **Note on what "protected" means here**: this mapping only ever sees
    `Memory` rows already present in a `ContextInjectionResult`. It does
    not protect a `TaskContract` or `RunPolicy` object — neither type is
    part of this result shape in this codebase, so no such claim is made
    anywhere in the comments.
- **`src/prompt/composer.ts`** — `compose()`'s signature is unchanged.
  When `context.omitted` is a non-empty array, the rendered prompt gains an
  `# Omitted Context` section listing each omitted memory's type, title,
  and reason. When `omitted` is `undefined` or empty (every existing
  caller, since no profile enables budgeting by default), this section
  never appears — output is identical to before this slice.
- **`src/cli/assemble.ts`** — `resolveContextBudgetManager(profileConfig)`
  builds a `ContextBudgetManager` from `profileConfig.context?.token_budget`,
  or returns `undefined` when that field is absent (mirroring the existing
  `resolveRejectThreshold()` three-tier-fallback pattern's "explicit inputs,
  independently testable" shape, minus the fallback tiers since this field
  has none). `assembleProfileDeps()` passes the result to
  `new ContextInjector(memoryStore, staleness, budgetManager)`.

## Backward compatibility

A profile's `config.yaml` that has no `context:` key at all (e.g. the
committed `profiles/subscription/config.yaml`) gets exactly the pre-slice
behavior: unlimited memory injection, `result.omitted === undefined`, and
an unchanged rendered prompt. This is asserted directly in
`src/cli/__tests__/assemble.test.ts`'s "context.token_budget wiring
end-to-end" describe block.
