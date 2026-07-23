/**
 * issue #98 版本戳——`.ts` 消费者的薄包装层。`./version-info.generated.ts` is a build-time
 * artifact (`scripts/generate-version.mjs`, run before every `build`/`lint`/`test`/`test:watch`
 * — see `package.json`), never committed (`.gitignore`).
 *
 * **Accurate scope of "single source" (issue #98 Zorro independent review #2 — the previous
 * version of this docstring overclaimed "the one place every consumer imports from", which was
 * only true for `.ts` consumers)**: `docs/conductor-brain-layer/spike/lib/version-info.mjs` and
 * `scripts/install-global-brain.mjs` are plain `.mjs` files and **cannot** `import` this `.ts`
 * file — they read `version-info.generated.js`'s compiled output directly. The actual single
 * source of truth that spans *both* the `.ts` and `.mjs` worlds is `versionString` — a field
 * `generate-version.mjs` computes and writes into the generated artifact itself (see
 * `formatVersionString()` there), not the `<packageVersion>+<gitSha>[-dirty]` format expression.
 * This file, the `.mjs` wake-greeting lib, and the install script all now **read**
 * `versionString` verbatim from the generated data — none of them re-derive the `+`/`-dirty`
 * formatting rule independently, so cross-face agreement is a physical guarantee (the same
 * string literal, copied three places) rather than three independent implementations that
 * happen to agree today. See `docs/version-stamping/PRD.md` §3 for the full four-face map, and
 * `src/evidence/__tests__/bundle.test.ts` / `docs/conductor-brain-layer/spike/
 * test-version-info.mjs` for the tests that pin this consistency down across the `.ts`/`.mjs`
 * boundary.
 *
 * Deliberately **not** fail-soft at the import boundary: a missing generated file is a real dev
 * setup problem (forgot to build/generate before running tests directly against `vitest`, not
 * through an npm script), and should fail loudly at compile/import time rather than silently
 * showing a blank version everywhere. The *content* of the generated file is what's fail-soft
 * (`gitSha` degrades to `"unknown-sha"` — see `scripts/generate-version.mjs`), not its existence.
 */
import { GENERATED_VERSION_INFO, type GeneratedVersionInfo } from "./version-info.generated.js";

export type VersionInfo = GeneratedVersionInfo;

/** Re-exported as-is — the single generated fact every consumer reads. */
export const VERSION_INFO: VersionInfo = GENERATED_VERSION_INFO;

/**
 * `<packageVersion>+<gitSha>[-dirty]`, e.g. `"0.0.1+9d568ad"` / `"0.0.1+9d568ad-dirty"` /
 * `"0.0.1+unknown-sha"` (git unavailable at generation time). Read verbatim from
 * `VERSION_INFO.versionString` (computed once by `generate-version.mjs`'s `formatVersionString()`
 * at generation time) — **not** reconstructed here — this is the exact string every face (CLI
 * `--version`, `EvidenceBundle.engineVersion`, wake-greeting's version line, the global-install
 * echo) must agree on, and now physically does (see this file's header doc for why).
 */
export const VERSION_STRING = VERSION_INFO.versionString;
