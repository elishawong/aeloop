# Issue #40 — PromptSnapshot Delta Delivery: Design Contract

Status: **design only** — no runtime code. This document is the acceptance contract
for a future implementation; it does not itself change behavior.

## 1. Problem

Full-prompt resend on every checkpoint/resume is wasteful for providers that support
session-based or cache-based context. This doc specifies how `PromptSnapshot` splits
into a **stable** part and a **dynamic** part, how each is hashed, what gets persisted
by default (metadata-only, no raw prompt content), how providers negotiate delta
support, and how retry/resume failure is handled when hashes don't line up.

## 2. PromptSnapshot: stable vs dynamic boundary

A `PromptSnapshot` represents the full prompt context sent to a provider for one turn.
It is partitioned into two disjoint regions:

- **Stable region** — content that does not change across turns within a session:
  - system prompt / instructions
  - tool/function definitions (schemas)
  - loaded skill/agent definitions bound at session start
  - any long-lived context injected once (e.g. project CLAUDE.md, CORE files) that is
    not re-derived per turn
- **Dynamic region** — content that changes every turn or frequently:
  - conversation history deltas (new user/assistant/tool messages since last turn)
  - per-turn injected context (file reads, tool results, system-reminders)
  - anything computed from live state (timestamps, working directory, session env)

**Boundary rule:** region membership is determined **by content-block type**, fixed at
session start — the four block kinds listed above (system prompt, tool/function
definitions, loaded skill/agent definitions, once-injected long-lived context) are
**always** the stable region; conversation deltas, per-turn injected context, and
live-state-derived content are **always** the dynamic region. Membership does **not**
depend on whether a block's bytes changed since the previous turn — a system prompt
that gets hot-reloaded mid-session is still a stable-region block; it does not move to
the dynamic region.

`stableHash` is computed over the current turn's stable-region content, **whatever
that content currently is** (see §3). Consequently, if a stable-region block drifts
(e.g. the system prompt is edited mid-session), `stableHash` necessarily changes,
because it hashes the actual bytes of that block this turn — it does not exclude the
changed block. That hash change is what §6/§7 detect and treat as "stable drift":
delta delivery is blocked for that turn and the harness falls back to a full-prompt
send. See §7 for the full mismatch-handling rule and why this is the single source of
truth for stable drift.

Stable/dynamic membership is a **per-session classification by block type**, fixed at
session start; it is not re-derived turn-by-turn from a diff against the previous
snapshot. What *is* re-verified every turn is `stableHash` itself (§3), which is how
drift within the (fixed) stable region is detected.

## 3. Hash canonicalization

Two hashes are computed per snapshot:

- `stableHash` — hash of the stable region only
- `turnHash` (a.k.a. `baseHash` when referenced by a delta) — hash of the full
  snapshot (stable + dynamic) as sent for that turn

### Canonicalization rules (must be applied before hashing, in order)

1. **Serialize deterministically**: content blocks are serialized as an ordered array
   of `{role, type, content}` objects — no map/object key with nondeterministic
   iteration order is hashed directly.
2. **Normalize whitespace only inside non-code text blocks**: trailing whitespace and
   line-ending style (`\r\n` → `\n`) are normalized before hashing. Code blocks, tool
   payloads, and file content are hashed byte-exact (no whitespace normalization).
3. **Strip volatile fields**: request IDs, timestamps, and any per-call nonce are
   excluded from the hash input even if present in the transmitted payload.
4. **Encode as UTF-8**, hash with **SHA-256**, output as lowercase hex.
5. **Concatenation order for stableHash**: stable blocks are hashed in the order they
   appear in the canonical snapshot (system → tools → static context), not
   insertion order from the caller.

`stableHash` and `turnHash` are computed independently; `turnHash` is **not** simply
`hash(stableHash + dynamicContent)` — it is the hash of the full canonical
serialization, so it changes if canonicalization rules themselves change (see §9,
versioning).

## 4. Checkpointing: metadata-only by default

By default, checkpoint persistence stores **metadata only**:

```
{
  sessionId,
  turnIndex,
  stableHash,
  turnHash,
  providerId,
  providerSessionRef,   // opaque provider-side session/cache handle, if any
  deltaCapable: boolean,
  tokenAccounting: { stableTokens, dynamicTokens, cachedTokens? },
  createdAt
}
```

**No raw prompt content — private or company — is written to checkpoint storage by
default.** This includes system prompts, user messages, tool outputs, and file
contents. Only hashes, counts, and provider references are persisted.

Raw content capture is opt-in only, behind an explicit flag (e.g.
`--debug-persist-raw`), scoped to a local/ephemeral debug store, and must never be the
default for any checkpoint path (including crash/error checkpoints).

## 5. Provider capability negotiation

Before attempting delta delivery, the harness must confirm the target provider
supports it for the active session:

1. Query/declare capability via the provider adapter's capability descriptor (static,
   known at adapter-registration time — not a runtime probe against the live API,
   since not all providers expose one).
2. A provider is **delta-capable** only if it exposes both:
   - a session/context handle that persists stable content server-side or
     cache-side across calls, **and**
   - a way for the harness to reference that handle on a subsequent call (session
     ID, cache ID, or equivalent).
3. If either is missing, the provider is treated as **full-prompt only** and delta
   delivery is never attempted for it.

### Fallback

If capability negotiation fails, is ambiguous, or the provider returns a
capability-mismatch error at call time, the harness falls back to sending the
**full prompt** for that turn and clears any `providerSessionRef` for the session,
forcing capability re-negotiation on the next turn.

### Current provider status (as of this doc)

**Claude CLI, Codex CLI, and LiteLLM remain full-prompt for all traffic until
explicit delta/capability support is implemented and verified for each.** No
capability descriptor for any of the three should report `deltaCapable: true` until
that work lands; this doc does not change that.

## 6. Delta delivery preconditions

Delta delivery (sending only the dynamic region) is only attempted when **all** of
the following hold:

1. Provider capability negotiation (§5) succeeded for this session.
2. The harness holds a `providerSessionRef` that the provider has **acknowledged**
   (i.e. returned/confirmed in a prior response) as valid for this session — a
   locally-generated or assumed reference is never sufficient.
3. The harness's locally computed `stableHash` for this turn matches the
   `stableHash` recorded against that `providerSessionRef` at the time it was
   acknowledged.
4. The `baseHash` (turnHash) the harness intends to delta against matches the last
   turnHash the provider acknowledged for that session.

If any precondition fails, the harness must send the full prompt for that turn
(never a partial/best-effort delta).

## 7. Retry / resume mismatch handling

On retry or resume (process restart, reconnect, checkpoint replay):

1. Load the last checkpoint metadata (§4) for the session.
2. Recompute `stableHash`/`turnHash` from the current live snapshot.
3. Compare against checkpoint's recorded hashes:
   - **Match**: safe to attempt delta delivery using the checkpointed
     `providerSessionRef`, subject to §6 preconditions still holding (provider may
     have expired the session server-side — treat an explicit provider rejection of
     the session ref as capability loss, not a fatal error).
   - **Mismatch on stableHash**: stable content has drifted since the checkpoint
     (e.g. system prompt changed). Treat provider session as invalid, drop
     `providerSessionRef`, force full-prompt send, re-negotiate capability.
   - **Mismatch on turnHash only** (stableHash matches): dynamic content diverged
     (e.g. resumed mid-turn after partial history was replayed). Do not attempt
     delta against the stale base; send full prompt for this turn to re-establish a
     known-good base, then resume delta delivery from the next turn.
4. A provider-side "unknown session/cache reference" error at call time is always
   treated as case (b) regardless of local hash state — the provider is authoritative
   over whether its session is alive.
5. All mismatch/fallback events are logged (metadata only, no raw content) for
   observability — provider ID, session ID, mismatch type, turn index.

## 8. Token accounting

Checkpoint metadata (§4) records, per turn:

- `stableTokens` — token count of the stable region as counted/estimated locally
- `dynamicTokens` — token count of the dynamic region actually transmitted
- `cachedTokens` (optional, provider-reported) — tokens the provider reports as
  served from cache/session rather than freshly processed, when the provider's API
  exposes this figure

When delta delivery is active, cost/usage reporting must distinguish "tokens sent
this call" (dynamic only) from "tokens the full prompt would have been" (stable +
dynamic), so savings are auditable per turn, not just aggregated.

When falling back to full-prompt (§5, §7), the accounting reflects the full send —
no delta savings are claimed for a turn where a fallback occurred.

## 9. Versioning

The canonicalization ruleset (§3) has a `promptDeltaVersion` recorded alongside
`stableHash`/`turnHash` in checkpoint metadata. A hash computed under one version is
never compared against a hash computed under another — a version mismatch is treated
identically to a stableHash mismatch (§7b): drop session ref, full-prompt fallback,
re-negotiate.

## 10. Security / privacy

- Checkpoint storage contains no raw prompt content by default (§4) — this includes
  no private user content and no company-internal prompt/system-instruction content.
- Hashes are one-way; they are not reversible to recover prompt content, but hash
  **equality** across sessions/checkpoints can leak that two turns shared identical
  stable content. Where this is a concern (e.g. cross-tenant checkpoint stores),
  hashes must be scoped/namespaced per session or per tenant so equality is not
  comparable across boundaries by anyone without access to that scope.
- `providerSessionRef` values are treated as sensitive (they are effectively
  provider-side credentials/handles for reusing context) and must be handled with
  the same access controls as API keys — not logged in plaintext outside the
  metadata store, not included in any user-facing error message.
- Debug raw-content capture (§4) must be explicitly opt-in, stored separately from
  the default metadata checkpoint path, and excluded from any default backup/sync of
  checkpoint state.
- Token accounting (§8) and mismatch logs (§7.5) are metadata-only and safe to
  export for observability without additional review.

## 11. Future acceptance tests

These are the acceptance tests a future implementation of this design must pass.
None exist yet; this is the contract they will be written against.

1. **Stable/dynamic partition correctness**
   - Given two consecutive turns with identical system prompt/tools and only a new
     user message appended, the stable region boundary includes exactly the
     unchanged prefix and the dynamic region contains exactly the new message.
   - Given a mid-session edit to the system prompt, the next turn's partition still
     classifies the system prompt as stable-region (block-type membership is fixed,
     §2), but `stableHash` changes because it hashes the edited bytes — this is the
     stable-drift signal consumed by §6/§7, not a region reassignment.

2. **Hash canonicalization determinism**
   - Hashing the same logical snapshot twice (same content, different object key
     insertion order in the in-memory representation) yields identical `stableHash`
     and `turnHash`.
   - Two snapshots differing only in a stripped volatile field (timestamp, request
     ID) yield identical hashes.
   - Two snapshots differing only in trailing whitespace in a non-code text block
     yield identical hashes; the same difference inside a code block yields
     different hashes.

3. **Metadata-only checkpointing by default**
   - After a checkpoint write with default settings, the checkpoint store contains
     no field whose value is raw prompt/user/tool content — verified by asserting
     checkpoint payload keys are a subset of the schema in §4.
   - With `--debug-persist-raw` unset, enabling it in a follow-up session does not
     retroactively populate raw content for prior checkpoints.

4. **Capability negotiation and fallback**
   - For Claude CLI, Codex CLI, and LiteLLM adapters, capability descriptor reports
     `deltaCapable: false` and no delta attempt is ever made, regardless of session
     state.
   - For a mock delta-capable provider, capability negotiation succeeding is
     required before any delta attempt; disabling the mock's capability response
     forces full-prompt send on the next turn.

5. **Delta delivery preconditions**
   - Delta is attempted only when `providerSessionRef` is provider-acknowledged;
     a locally-fabricated session ref never triggers a delta send (full prompt sent
     instead).
   - A local `stableHash` mismatch against the last acknowledged value blocks delta
     delivery for that turn.

6. **Retry/resume mismatch handling**
   - Resume with matching stableHash and turnHash attempts delta delivery.
   - Resume with mismatched stableHash drops the session ref and sends full prompt.
   - Resume with matched stableHash but mismatched turnHash sends full prompt for
     the resumed turn only, then resumes delta on the following turn.
   - A simulated provider "unknown session" error at call time forces full-prompt
     fallback and session-ref invalidation even when local hashes matched.

7. **Token accounting**
   - A turn using delta delivery records `dynamicTokens` less than the full-prompt
     equivalent `stableTokens + dynamicTokens`, and any provider-reported
     `cachedTokens` is captured verbatim.
   - A fallback turn records full-prompt token counts and is not counted toward
     delta savings totals.

8. **Versioning**
   - A checkpoint written under `promptDeltaVersion` N is not used for delta
     delivery when the running harness is on canonicalization version N+1; full
     prompt is sent and a new version-N+1 checkpoint is written.

9. **Security/privacy**
   - No test fixture or snapshot in the checkpoint store round-trip contains
     plaintext content matching a known private/company prompt fixture used in the
     test.
   - `providerSessionRef` values do not appear in any log line emitted at default
     log level.
