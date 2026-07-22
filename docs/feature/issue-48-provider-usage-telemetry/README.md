# Issue #48 — Preserve provider token usage and latency in LiteLLM adapters

Direction and acceptance for this slice were already approved (no separate
PRD written for it, per the task instructions this slice was implemented
under). This document records what was actually built and the contract
decisions made along the way, for future readers of `types.ts`/
`litellm-adapter.ts`.

## Scope

- `InvokeResult` (`src/harness/types.ts`) gains two new **optional**
  fields: `usage?: ProviderUsage` and `latencyMs?: number`. Both are
  additive — every existing adapter (`ClaudeCliAdapter`, `CodexCliAdapter`)
  and every existing consumer of `InvokeResult` keeps compiling and behaving
  unchanged, since nothing was made required and nothing existing was
  renamed/removed.
- `LiteLLMAdapter.invoke()` (`src/harness/adapters/litellm-adapter.ts`) is
  the only adapter that populates these fields in this slice — it parses
  the `usage` block out of both response shapes it already supports
  (Anthropic `/v1/messages` and OpenAI-compatible `/chat/completions`, per
  `LiteLLMAdapterConfig.api_style`), and measures the network round trip.

**Explicitly out of scope for this slice** (per the issue body and the
task's own instructions):

- `ClaudeCliAdapter`/`CodexCliAdapter` — their `stream-json`/`--json` event
  streams do carry their own provider-usage fields (e.g. Claude Code's
  `result` event, Codex's per-turn `usage` events — see
  `__tests__/fixtures/fake-codex.fixture.mjs`), but wiring those into
  `usage`/`latencyMs` is separate follow-up work, not this issue's stated
  boundary ("... in LiteLLM adapters").
- Local token estimation. `ProviderUsage.source` has an `"estimate"` variant
  reserved in the type for a future slice; nothing in this slice ever
  produces one — every `ProviderUsage` this slice returns has
  `source: "provider"`.
- `src/loop/*`, `src/cli/*`, `src/loop/events.ts`, the A5 gate-view
  checklist — none of these were touched. Nothing currently reads
  `InvokeResult.usage`/`.latencyMs`; this slice only makes the harness layer
  capable of reporting it.

## `ProviderUsage` shape

```ts
export type UsageSource = "provider" | "estimate";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  source: UsageSource;
}
```

Every counter is independently optional. A provider that reports some
fields and omits others gets exactly those fields populated — never a
zero-filled or guessed value for the rest.

## Contract decisions

1. **`totalTokens` is never a blind sum of every counter.** Cache token
   accounting isn't uniform across the two response shapes this slice
   parses:
   - Anthropic: `cache_creation_input_tokens`/`cache_read_input_tokens` are
     **additive** to `input_tokens` (a cache read/write is never already
     counted inside `input_tokens`).
   - OpenAI: `prompt_tokens_details.cached_tokens` is a **subset** of
     `prompt_tokens` (already included, not additional).

   Folding cache counts into `totalTokens` under one blanket rule would
   silently double-count for one shape or undercount for the other. So
   `totalTokens` is computed only from `inputTokens + outputTokens` (when
   both are present) — or, for the OpenAI shape, the provider's own
   `total_tokens` field when it's a valid number (preferred over the
   computed sum, since a provider-declared total is more defensible than
   one this adapter derives). Cache counts are always available separately
   via `cacheReadTokens`/`cacheWriteTokens` for a caller that wants to
   reason about them explicitly.

2. **LiteLLM Anthropic-passthrough variant.** When LiteLLM proxies an
   Anthropic model through its OpenAI-compatible `/chat/completions`
   endpoint, it has been observed carrying the Anthropic-native
   `cache_creation_input_tokens`/`cache_read_input_tokens` field names
   straight through inside the otherwise-OpenAI-shaped `usage` object
   (LiteLLM's own cost tracking needs the Anthropic-specific split). This
   adapter reads that variant into the same `cacheWriteTokens`/
   `cacheReadTokens` fields, falling back to it only when the OpenAI-native
   `prompt_tokens_details.cached_tokens` isn't present — the two aren't
   guaranteed to mean the same thing (subset-of-prompt vs.
   additive-to-prompt) and a response shouldn't realistically carry both for
   the same underlying count.

3. **Fail-safe parsing, always.** `extractAnthropicUsage()`/
   `extractOpenAIUsage()` never throw. A missing `usage` block, a `usage`
   that isn't an object, or individual fields that are the wrong type /
   negative / non-finite are all treated as "provider didn't tell us this"
   and mapped to `undefined` — never coerced, never guessed, never a reason
   to fail an otherwise-successful `invoke()`. When *no* counter could be
   read at all, `InvokeResult.usage` is omitted entirely (not a degenerate
   `{ source: "provider" }` shell with every field `undefined`).

4. **`latencyMs` measurement.** Measured with `performance.now()`
   (monotonic — immune to wall-clock/NTP adjustments, unlike `Date.now()`)
   bracketing exactly the network round trip: from immediately before
   `fetch()` is issued to immediately after the full response body has been
   read (`response.text()` resolving). Request-body serialization before it
   and `JSON.parse`/content-shape validation after it are deliberately
   excluded — those are this process's own CPU work, not time spent waiting
   on the provider, so including them would overstate the network latency
   the field is meant to report. `latencyMs` is always populated on a
   successful `invoke()` (every current adapter has exactly one round trip
   per call); no adapter needs to omit it in this slice.

## What changed

- **`src/harness/types.ts`** — new `UsageSource`/`ProviderUsage` types;
  `InvokeResult` gained optional `usage`/`latencyMs` fields, both
  documented as backward-compatible additions.
- **`src/harness/adapters/litellm-adapter.ts`** — `extractAnthropicUsage()`/
  `extractOpenAIUsage()` (plus the shared `toTokenCount()`/`buildUsage()`
  helpers) parse the two response shapes' `usage` blocks; `invoke()` times
  the network round trip with `performance.now()` and returns both new
  fields.
- **`src/harness/adapters/__tests__/litellm-adapter.test.ts`** — a new
  `describe("usage/latency normalization (issue #48)")` block: strict
  OpenAI usage, computed `totalTokens` fallback, OpenAI-native cache reads,
  the LiteLLM Anthropic-passthrough cache variant, Anthropic-native usage
  (including its `totalTokens` = input+output-only rule), missing usage,
  malformed/wrong-typed usage fields, non-object `usage`, partial usage
  (no guessed `totalTokens`), and a `latencyMs` sanity check.

## Verification note

Verification completed in the worktree: `pnpm run lint`, `pnpm run build`,
and `pnpm test -- --run` all passed (57 test files, 584 tests). The local
machine used Node 23.10.0 while the package declares Node >=24, so pnpm
printed the existing engine warning; the native `better-sqlite3` binding was
rebuilt for the active runtime before the test run. No provider credentials
were used: the adapter tests exercise a local fake HTTP server.
