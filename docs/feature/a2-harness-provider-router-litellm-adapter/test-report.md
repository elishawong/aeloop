# test-report — A2 Harness (Provider Router + LiteLLMAdapter)

> An honest audit trail, recording the actual results of the Zorro review loop (round-1 → round-2 → round-3 → round-4), not a substitute for impact/test-plan (the Commander has already ruled that this requirement only needs this one document).

## Scope

The A2 Harness layer increment (PRD `docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`): `ProviderRouter` + `AdapterRegistry` (routing core), `LiteLLMAdapter` (`direct-api` adapter), `SchemaValidator`, `harness/config.ts`, the `src/harness.e2e.test.ts` vertical slice, branch `feature/issue-6-a2-harness`.

Final commit (before this round's fix): `c3523d4` (`fix(harness): Zorro round-1 rework — 3 blockers + config validation`).

## Zorro round-1 — judged FAIL

3 blockers + 1 🟡:
1. `litellm-adapter.ts`: the network read `response.text()` was not wrapped in try/catch — if the body read fails, a bare `TypeError` escapes, breaking `errors.ts`'s contract that "adapters only throw `AdapterInvokeError`."
2. `extractModel()` had no guard against the empty string `"model": ""`, allowing `InvokeResult.model === ""`, violating the non-empty invariant in `types.ts`.
3. The `schema-validator.test.ts` guard test wasn't tight enough (details in the round-1 review record).
4. 🟡: `config.ts`'s provider entries lack typed validation (Commander already approved adding `InvalidProviderConfigError`).

codex `gpt-5.6-sol` second signature: `raw_output_sha256=bb869a1b58177cf83bf322903b00e789a752ef0575732c5421ccbf6e8e0f0eb8`

## Rework (`c3523d4`)

- Blocker 1: in `litellm-adapter.ts:148-156`, wrapped `response.text()` in its own try/catch, catching and throwing `AdapterInvokeError` (message contains `failed to read response body`).
- Blocker 2: added `extractModel()`, which validates `parsed.model` as a non-empty string (`.trim().length > 0`); `invoke()` uses `extractModel(parsed) ?? model` to fall back to the configured model.
- Blocker 3: tightened the assertions in the `schema-validator.test.ts` guard test.
- 🟡: added `InvalidProviderConfigError` to `config.ts`, doing typed validation of `ProfileConfig.providers[id]`.

## Zorro round-2 — judged FAIL

The 4 production-code fixes were each verified to **all be correct** — round-2 didn't overturn a single production-code change. The problem was entirely in the tests:

- **Blocker-1's regression test was a false green** (`litellm-adapter.test.ts:157-179`, titled with "Zorro round-1 blocker 1"). Zorro did mutation testing: reverted the body-read try/catch at `litellm-adapter.ts:148-156` back to the bare `const rawBody = await response.text();`, and the test **was still 5/5 green** — zero guard value.
- Root cause: the fake server used by the test truncates the connection synchronously via `res.write(partial) → res.socket.destroy()`, and this happens *before* `fetch()` even gets the `Response` (i.e., before headers arrive) — so the error lands in the **request-level** catch at `litellm-adapter.ts:117-131` (which also throws `AdapterInvokeError`, equally able to pass the `toBeInstanceOf(AdapterInvokeError)` assertion), never reaching the **body-read** catch (:148-156) that blocker-1 actually fixed. The assertions only checked `toBeInstanceOf(AdapterInvokeError)` / `not.toBeInstanceOf(TypeError)`, and both catch branches produce `AdapterInvokeError`, so there's no way to tell which one got hit — hence reverting the body-read fix still passed green.

codex `gpt-5.6-sol` second signature: `raw_output_sha256=1ccd7fbe6367f3f2bca8e2eb40d7b4bfb3037d04bc39c378dc5018c130fa2576`

## round-3 (this round) — fix

### B1-TEST (blocker)

- **No production code touched** (round-2 already confirmed all 4 production-code fixes are correct).
- Reworked the fake server for that test in `litellm-adapter.test.ts`: `res.writeHead(200, {...Content-Length: 10000})` → `res.flushHeaders()` (make sure headers are pushed onto the wire immediately, not buffered behind subsequent `write()` calls) → `res.write(partial)` → `setTimeout(() => res.socket?.destroy(), 50)` (giving the client a real window of time to receive the headers, letting `fetch()`'s `Response` resolve first, only after which does the body stream get cut mid-flight).
- Tightened the assertion from the generic `toBeInstanceOf(AdapterInvokeError)` to specifically pinning down the body-read path: `error.message` contains `"failed to read response body"` (the text at :153), `error.cause` is a `TypeError` (undici's original error type for a body-read failure).
- **Mutation verification**: temporarily reverted the body-read try/catch at `litellm-adapter.ts:148-156` back to the bare `const rawBody = await response.text();`, and the test **turned red** (`AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError`, failing at the `toBeInstanceOf(AdapterInvokeError)` line before it even got to the newly added `error.message`/`error.cause` assertions) — proving the test now genuinely guards the body-read fix. Reverted the production code back to its original state after verification (`git diff` confirms `litellm-adapter.ts` has no changes relative to `c3523d4`).

### P2 (incidental)

- `litellm-adapter.test.ts`: added a case for blocker-2's `extractModel` test with a purely-whitespace `"model": "   "` value, asserting `result.model` falls back to the configured model and ≠ `"   "` (previously only `""` was covered).
- `docs/PROGRESS.md:11`: wording correction to reflect the actual state — B0-B7 have all been committed/pushed (`1de735e`, `c3523d4`), no longer "pending commit/push"; added a note about the round-2 FAIL + round-3 rework.

## Regression

- `pnpm test`: 171 passed (170 at round-2 + 1 new from P2).
- `pnpm exec tsc --noEmit`: clean, exit 0.
- `pnpm exec tsc -p tsconfig.build.json`: clean, exit 0.
- lint (`package.json`'s `"lint": "tsc --noEmit"`, same command as above): clean.

## Zorro round-3 — judged FAIL (single blocker, safety property already met)

codex `gpt-5.6-sol` second signature: `raw_output_sha256=c9cb2402448c43b362b08c05ccd325529e9addd6ce83aefdaa4ba27eba82e41d`

- **Safety property met**: round-2's false-green finding has been genuinely fixed, production code `litellm-adapter.ts` has zero changes relative to `c3523d4`, `pnpm test` is 171 fully green.
- **Sole blocker**: the `setTimeout(() => res.socket?.destroy(), 50)` introduced in round-3 to fix the false green is a non-deterministic timing bet — the B1 test is betting that within 50ms the client will definitely have received the headers and `fetch()`'s `Response` will have already resolved; under a heavily loaded CI, this timer could fire **before** `fetch()` resolves, and the connection breaking too early would pour the failure into the request-level catch at `litellm-adapter.ts:117-131` instead of the body-read catch (:148-156), causing the assertion that `error.message` contains `"failed to read response body"` to fail — **an intermittent false red**. This can only false-red, never false-green (not a safety vulnerability), but a flaky guard test tends to get muted by whoever/whatever comes along later, which would effectively disable blocker-1's guard — judged FAIL, requiring a switch to a deterministic approach.

## round-4 (this round) — remove the timer, switch to a deterministic handshake

### B1-TEST (blocker)

- **No production code touched** (`litellm-adapter.ts` has zero diff relative to `ffabeeb`, `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` is empty).
- Removed the `setTimeout(50)` timing bet, replaced with temporarily wrapping the global `fetch` inside the test (`LiteLLMAdapter.invoke()` internally calls the bare `fetch(url, ...)`, going through `globalThis.fetch`, so wrapping it can intercept it directly):

  ```ts
  let serverSocket: import("node:net").Socket | undefined;

  activeServer = await startFakeServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
    res.flushHeaders();
    res.write('{"model":"gpt-4o-mini","choices":[{"message":{"content":"partial');
    serverSocket = res.socket ?? undefined;
    // Deliberately not destroying here — leave it to the wrapped fetch below to act only once it has the Response.
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await originalFetch(...args);
    // originalFetch() resolving is itself the event of "the client has already received the headers" —
    // the same event the old 50ms timer was trying to approximate, now made a mechanical guarantee instead.
    serverSocket?.destroy();
    return res;
  }) as typeof fetch;
  ```

  Restored `globalThis.fetch = originalFetch` in a `finally` block, so it doesn't pollute other tests.
- Rationale: Node/undici's `fetch()` Promise resolves once the status line + headers are received (the body isn't fully read yet) — this is exactly the point in time the old `setTimeout(50)` was trying to approximate. Round-4 no longer "bets that it probably happens within 50ms," but instead waits for this event to actually happen before destroying the socket, turning "headers have arrived → only then break the connection" into a happens-before relationship, no longer a probability. `Content-Length: 10000` remains far larger than the bytes actually written, guaranteeing that at the moment of destroy, `response.text()` is still waiting for more bytes, so the body-read failure path is hit mechanically.
- Assertions unchanged: `error.message` contains `"failed to read response body"`, `error.cause instanceof TypeError`.

### Mutation verification (round-4 redone)

Temporarily reverted the body-read try/catch at `litellm-adapter.ts:148-156` back to the bare `const rawBody: string = await response.text();`, ran `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts`:

- Result: **1 failed / 13 passed**, and the failure was exactly this body-read guard test, reporting `AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError` (failing at the `toBeInstanceOf(AdapterInvokeError)` line first, meaning what it got was a bare `TypeError` — i.e., after reverting the fix, the error genuinely did escape unaltered from the body-read path, and the test caught it faithfully).
- Reverted `litellm-adapter.ts` back to its original state after verification, confirmed `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` is empty.

### Stability verification (for the round-3 blocker itself)

- `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts` run 15 times consecutively: 15/15 fully green (14 tests passed each time), no timer of any kind remaining, theoretically shouldn't flake — and in practice didn't flake either.
- `pnpm exec vitest run` (full suite) run another 5 times: 171/171 fully green (every time).

## Regression (round-4)

- `pnpm test`: 171 passed.
- `pnpm exec tsc --noEmit`: clean, exit 0.
- `pnpm exec tsc -p tsconfig.build.json`: clean, exit 0.
- `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts`: empty (zero production-code changes).

## Status

**Staged, pending Commander approval to commit/push, then handed to Zorro round-4 review.**
