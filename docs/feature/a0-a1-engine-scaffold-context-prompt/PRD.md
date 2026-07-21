# PRD — aeloop A0+A1: Engine Scaffold + Context/Prompt Layer (incl. ContextInjector wiring + M2/M3 required items)

> Skeleton source: `ai-agent/OPS/_templates/feature/PRD.md`.
> Anti-hallucination: `[?]` = unverified by me / needs a spike or commander confirmation; no invented interfaces/versions/parameters.

- **Project**: aeloop (`elishawong/aeloop`, private repo)
- **Branch**: `feature/issue-1-a0-a1-scaffold` (single branch, sequential commits within batches — rationale in §7 Branch Strategy)
- **Priority**: P1
- **Status**: Approved (approved by Elisha 2026-07-20; 5 `[?]` items finalized — see §9.0)
- **Last updated**: 2026-07-20
- **Related issue**: [elishawong/aeloop#1](https://github.com/elishawong/aeloop/issues/1) (this increment) · Upstream tracking [elishawong/ai-agent#120](https://github.com/elishawong/ai-agent/issues/120) (unified engine architecture umbrella issue)
- **Design authority**: `aeloop/docs/DESIGN.md` (§1.5-1.7 four-layer relationship / §5 DB schema / §6 file structure / §8 milestones / §8.5 required checklist)

---

## 1. Problem / Users / Approach

- **Problem to solve**: aeloop is currently an empty repo (only the project's own layer: CLAUDE.md/docs/.claude/skills). We need to build the innermost two engine layers (Prompt, Context) + scaffold from scratch, while **avoiding from day one the holes Verity M2/M3 already exposed in real testing** (layers wrote tests green but were never wired together; confirmation without a transaction; missing columns; JSON.parse throwing raw; rejected memories not filtered).
- **For whom**: the aeloop engine itself (downstream consumers are the A2 Harness's PromptComposer caller, the A4 Loop's Coder/Tester nodes); in the near term the direct users are Cypher/Zorro running tests and wiring in subsequent increments.
- **One-line approach**: Following the target structure in DESIGN §6, build out `src/prompt/`, `src/context/`, `src/profile/`, `src/shared/` plus matching vitest/tsconfig/package.json, and use **one end-to-end vertical-slice test** to prove that Context (ContextInjector, including rejected filtering) → Prompt (PromptComposer) is actually wired together — not three layers each green in isolation with no glue.

## 2. Goals / Non-Goals

**Goals (A0 scaffold)**:
- TypeScript + Node v24 project skeleton: package.json / tsconfig (strict + `noUncheckedIndexedAccess`) / vitest.config.ts / .env.example.
- `src/profile/loader.ts`: read `AI_AGENT_PROFILE` (`helix` | `verity`) → locate and parse the `config.yaml` under the corresponding profile directory; when `profiles/verity/` doesn't exist, **degrade gracefully** (an explicit "not found" error/state, no raw throw, no silently pretending success).
- Minimal `profiles/helix/config.yaml` + `profiles/helix/personas/{coder,tester}.md` examples, for loader/persona tests to use.

**Goals (A1 Context + Prompt)**:
- Context layer: SQLite (+FTS5) store (`memories` / `memory_confirmations` / `system_config` three tables, aligned to DESIGN §5 ER, filling in columns missing from Verity), StalenessEngine, ConfirmationService (three states: confirm/correct/reject, wrapped in `db.transaction`), ContextInjector (injection + filtering rejected), types/errors, RecallError that doesn't fail silently.
- Prompt layer: `ClaimSchema`/`CoderOutput`/`TesterOutput` (zod), persona loader (looks up the registry dynamically by role name, doesn't hardcode `{coder,tester}`), PromptComposer (persona + schema + injected memories → final prompt string).
- **Hard vertical slice**: one end-to-end test proving `ContextInjector` really injects confirmed memories from the `memories` table into `PromptComposer`'s output, with rejected memories filtered out — not isolated per-layer tests.

**Non-goals (explicitly out of scope, left for later increments)**:
- ❌ Harness layer (ProviderRouter / LiteLLMAdapter / SchemaValidator / adapters/*) — A2.
- ❌ CLI bridge adapters (ClaudeCliAdapter / CodexCliAdapter) + ToolExecVerifier — A3 (including the codex exec spike).
- ❌ Loop layer (LangGraph orchestration / G1-G3 gates / threshold escalation / checkpoints) — A4; the three tables `workflow_runs` / `structured_claims` / `approvals` are **not in this increment's table-creation scope** (A1 only builds `memories`/`memory_confirmations`/`system_config`).
- ❌ CLI/TUI (colored diff / y/n approval) — A5.
- ❌ Real profile dual-run acceptance (running one real task each for helix/verity) — A6.
- ❌ The `workflows/coder-tester-loop.json` workflow definition file — needs the Loop layer (A4) as a consumer, not built in this increment.

## 3. User Stories

- As **a developer of a later increment's Harness/Loop (Cypher starting from A2)**, I want `PromptComposer` to already be able to get filtered memories from `ContextInjector` and assemble a complete prompt, so A2 can call it directly instead of going back to fix the Context/Prompt wiring.
- As **the commander**, I want every milestone wrap-up to have a runnable test proving "the layers are actually connected," rather than trusting docs that claim completion (the lesson from Verity M2/M3).
- As **a profile user (future A6)**, I want that when `AI_AGENT_PROFILE=helix` and `profiles/verity/` can't be found, it doesn't error out and crash — it should only error when a verity overlay is genuinely needed.

## 4. Data Model

> Authority: DESIGN §5 ER diagram. This increment **only builds 3 tables** (the other 3 belong to Loop/Harness, not in this increment's DDL scope).

### 4.1 Tables shipped in this increment

**`memories`** (aligned to DESIGN §5, including columns added relative to Verity M2):
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| type | TEXT | 12 types (identity/snapshot/active_task/idea/decision/postmortem/map/constraint/relation/agent_spec/requirement/project_registry) |
| title | TEXT | |
| content | TEXT | |
| source_file | TEXT | |
| tags | TEXT | serialized storage (JSON or delimiter — `[?]` see §9) |
| confidence_state | TEXT | `unconfirmed` / `confirmed` / `rejected` |
| stale_override_days | INTEGER NULL | NULL reads from `system_config` |
| created_at | TEXT | |
| updated_at | TEXT | |
| **confirmed_at** | TEXT NULL | **new in A1** (missing in Verity M2, see DESIGN §8.5 #7) |
| **confirmed_by** | TEXT NULL | **new in A1** |

**`memory_confirmations`**:
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| memory_id | INTEGER FK → memories.id | |
| action | TEXT | `confirm` / `correct` / `reject` |
| old_content | TEXT | |
| new_content | TEXT | |
| **actor** | TEXT | **new in A1** (missing in Verity M2) |
| created_at | TEXT | |

**`system_config`**:
| Column | Type | Notes |
|---|---|---|
| key | TEXT PK | `default_stale_days` / `default_reject_threshold` / … |
| value | TEXT | |
| **updated_at** | TEXT | **new in A1** (missing in Verity M2) |

### 4.2 Tables not built in this increment (left for A2-A4, recorded but not implemented)
`workflow_runs` (A4), `structured_claims` (A4 — this increment defines the zod validation shape for `ClaimSchema`, but persisting it to this table is A4's job), `approvals` (A4).

### 4.3 Migration strategy
`[?]` Whether the first version needs a formal migration tool, or whether `store.ts` can just do `CREATE TABLE IF NOT EXISTS` + `CREATE VIRTUAL TABLE IF NOT EXISTS ... USING fts5(...)` on startup (because aeloop is a personal CLI tool with a fresh db per profile — there's no "production DB needing rolling upgrades" scenario). **Recommendation**: A1 should use inline `CREATE TABLE IF NOT EXISTS` first (simple, no extra dependency), and not introduce a separate migration framework; add a migration script later only if a schema change is actually needed. This recommendation is unconfirmed by the commander, marked `[?]`.

## 5. File-by-file task list

### A0 scaffold
- `package.json` — deps: `zod`, `js-yaml`, SQLite driver (finalized in §9.0#1: `better-sqlite3`); devDeps: `typescript`, `vitest`, `@types/node` (+ the DB driver's `@types/*` if needed). **Does not include `@types/js-yaml`** (found during Zorro's re-review of `feature/issue-1-a0-a1-scaffold`: `tsc --traceResolution` empirically proved TypeScript never resolves this package — js-yaml 5.x ships its own `dist/js-yaml.d.ts` and is used directly via its own `package.json`'s `exports`/`types` fields, making `@types/js-yaml` a completely dead dependency; already `pnpm remove @types/js-yaml`, and `pnpm build`/`pnpm lint`/`pnpm test` remained all green after removal — see the root-cause correction in the progress.md B1 entry for details). scripts: `build` (`tsc -p tsconfig.build.json` — B0 already shipped `tsconfig.build.json`, excluding `*.test.ts` so test artifacts don't pollute `dist/`, aligned with §8.5#8), `test` (`vitest run`), `test:watch`, `lint` (`tsc --noEmit`, including type-checking test files). Package manager: pnpm.
- `tsconfig.json` — `strict: true`, `noUncheckedIndexedAccess: true`, `target`/`module` aligned to Node v24 (ESM-first, `[?]` needs confirmation on CommonJS vs ESM, see §9), `outDir: dist`, `rootDir: src`.
- `vitest.config.ts` — basic config, `include: ['src/**/*.test.ts']`.
- `.env.example` — `LITELLM_BASE_URL=` / `LITELLM_TOKEN=` (only used by the verity profile, helix doesn't need real values in this increment), `AI_AGENT_PROFILE=helix`.
- `src/index.ts` — engine entry barrel (this increment only re-exports modules already built in A0/A1, doesn't pretend A2+ exists).
- `src/shared/types.ts` — cross-layer shared types (e.g. `Role` as an open string type, `ISODateString`, etc. — a minimal set, not over-engineered).
- `src/profile/loader.ts` — reads `AI_AGENT_PROFILE` + locates/parses `profiles/<name>/config.yaml` (js-yaml) + substitutes `${ENV}` placeholders; when `profiles/verity/` is absent, returns a typed "not found" result, doesn't throw a raw error.
- `src/profile/errors.ts` — typed errors like `ProfileNotFoundError`.
- `src/profile/loader.test.ts` — covers: normal helix load / verity absence graceful degradation / malformed config.yaml (YAML parse failure) not thrown raw.
- `profiles/helix/config.yaml` — minimal example (aligned to DESIGN §7 structure: providers/roles/workflow.reject_threshold); this increment leaves the providers field as a placeholder (the real calls for claude-cli/codex-cli are A3's job — here the loader just needs to parse out the structure).
- `profiles/helix/personas/coder.md` — minimal example persona text (plain text, vendor-agnostic).
- `profiles/helix/personas/tester.md` — same as above.

### A1 Context layer
- `src/context/types.ts` — `Memory`, `MemoryConfirmation`, `SystemConfigEntry`, `ConfidenceState` and other types, aligned to the §4 table structure.
- `src/context/errors.ts` — `RecallError` (not silent, replaces swallowing errors into an empty array), `ConfirmationError`, typed JSON parse errors.
- `src/context/store.ts` — SQLite connection + `CREATE TABLE IF NOT EXISTS` (memories/memory_confirmations/system_config) + `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(...)` + FTS5 trigger sync (insert/update/delete), basic CRUD, FTS recall queries (failure states wrapped in `RecallError`, not silently returning empty).
- `src/context/config.ts` — `SystemConfig` read/write (defaults for `default_stale_days`/`default_reject_threshold` etc. + overrides), writes `updated_at`.
- `src/context/staleness.ts` — `StalenessEngine`: determines whether a memory is stale based on `stale_override_days` or `system_config.default_stale_days`.
- `src/context/confirmation.ts` — `ConfirmationService`: three methods `confirm(memoryId, actor)` / `correct(memoryId, newContent, actor)` / `reject(memoryId, actor)`, **all wrapped in `db.transaction`** (writing `memories.confidence_state`/`confirmed_at`/`confirmed_by` + inserting a `memory_confirmations` row including `actor` is the same transaction); add tests for the "no existing confirmation record" missing-path case (see the §9 `replaceLatest` semantics `[?]`).
- `src/context/injector.ts` — `ContextInjector`: ① full set of core memories + FTS5 keyword recall; ② **filters out `confidence_state === 'rejected'`**; ③ stale/unconfirmed memories are kept but tagged with a warning marker (not filtered, only flagged, aligned with the annotation in DESIGN §3's sequence diagram); ④ outputs a structure for `PromptComposer` to consume.
- `src/context/store.test.ts` / `config.test.ts` / `staleness.test.ts` / `confirmation.test.ts` / `injector.test.ts` — individual unit tests each, including: confirmation transaction atomicity (mid-way failure rolls back the whole thing), a targeted test for injector filtering rejected, RecallError trigger-path tests.

### A1 Prompt layer
- `src/prompt/schema.ts` — `ClaimSchema` (aligned with the `structured_claims` concept but here it's just a zod validation shape, not including persistence columns like `run_id`), `CoderOutput`, `TesterOutput` (zod).
- `src/prompt/personas.ts` — persona loader: **dynamically** looks up the matching `.md` under the profile's `personas/` directory by role name string (not hardcoded as `if role === 'coder'`); typed error when the role doesn't exist; add a test for the "role's persona file is missing" path.
- `src/prompt/composer.ts` — `PromptComposer`: input (role name + `ContextInjector` output + task description) → output the final prompt string (persona text + schema description + injected memories; rejected has already been filtered upstream so composer doesn't need to filter again).
- `src/prompt/schema.test.ts` / `personas.test.ts` / `composer.test.ts`.

### Vertical slice (A1 wrap-up, a hard deliverable)
- `src/context-prompt.e2e.test.ts` (or an equivalent location, exact naming `[?]` TBD) — end-to-end test: ① use `store.ts` to write 3 memories (one each confirmed/unconfirmed/rejected) → ② `ContextInjector.inject(...)` → ③ feed into `PromptComposer.compose('coder', ...)` → ④ assert the final prompt string contains the confirmed content, **does not contain** the rejected content, and contains the unconfirmed content with a warning marker. This test is the hard evidence for DESIGN §8.5's "every aeloop milestone wrap-up must have a thin vertical slice that really proves connectivity."

### Build/distribution related (DESIGN §8.5 #8)
- Confirm that `package.json`'s `files` field (or `.npmignore`) includes `profiles/*/personas/**/*.md`, so persona text is distributed along with the package on `pnpm add -g` installs. **Structural note**: in aeloop's target file structure, personas live under the top-level `profiles/`, not under `src/`, so `tsc` compilation never touches them — Verity's "dist doesn't copy .md" problem **cannot recur in the same form** under aeloop's directory structure; this increment only needs to confirm the packaging config is correct, no extra build-time copy script needed. If the §9 `[?]` (ESM/CJS, driver choice) ends up introducing a toolchain change, this conclusion should be re-verified then.

### Zorro re-review fixes (2026-07-20, same branch `feature/issue-1-a0-a1-scaffold`, second round, after B0-B10)
> First round Zorro independent verdict was **FAIL**; below is the file list added/changed by the fix itself, appended to §5 for future readers to trace (the original B0-B10 file-by-file list is already complete and is not being rewritten — this only adds the increment).
- `src/shared/safe-path.ts` (new) + `src/shared/safe-path.test.ts` (new) — two layers of path-traversal defense, `isSinglePathSegment`/`isContainedRealpath`, shared by `src/prompt/personas.ts` (`loadPersona`) and `src/profile/loader.ts` (`loadProfile`).
- `src/prompt/personas.ts` — added `InvalidRoleNameError`; `loadPersona` now does path-safety validation before touching the filesystem.
- `src/profile/errors.ts` — added `InvalidProfileNameError`.
- `src/profile/loader.ts` — `loadProfile` likewise wired into path-safety validation; added `assertProfileConfigShape` (minimal validation of required top-level fields `profile`/`providers`/`roles` existing with correct types, replacing a raw `as ProfileConfig`).
- `src/context/store.ts` — added `toSafeFtsQuery` (FTS5 keyword safe-escaping: split on whitespace + convert each word to a quoted phrase), `searchMemories` now consumes the safely escaped query string.
- `src/context/injector.ts` — added `CORE_MEMORY_TYPES` (`identity`/`constraint`/`decision`), `inject()`'s "core full set" changed from a full table scan to filtering by type, so the FTS5 recall branch actually takes effect.
- `src/prompt/schema-registry.ts` (new) — `SchemaRegistry`/`DEFAULT_OUTPUT_SCHEMAS`/`SchemaNotRegisteredError`, moving the role→schema mapping out of `composer.ts`'s internal hardcoding into an externally injectable registry.
- `src/prompt/composer.ts` — `PromptComposer`'s constructor gets a new optional `schemas: SchemaRegistry` parameter; a role not in the registry → throws `SchemaNotRegisteredError` (replacing the previous silent omission).
- `src/context-prompt.e2e.test.ts` — both tests now feed `inject()` real task text containing hyphens (e.g. `"Explain the retry-backoff strategy."`), no longer using `inject(undefined)` to bypass the FTS5 recall path.
- `package.json` — `pnpm remove @types/js-yaml` (dead dependency, see this file's "Dependencies" subsection + the root-cause correction in the progress.md B1 entry for details).
- Corresponding test files (`personas.test.ts`/`loader.test.ts`/`store.test.ts`/`injector.test.ts`/`composer.test.ts`/`confirmation.test.ts`) all had adversarial assertions added/rewritten — see the new B11 entry in progress.md for details.

## 6. Batch breakdown

> Units: `[S]` ≈ 2-4h, `[M]` ≈ half a day to a day, `[L]` ≈ 1-2 days (this repo has no existing estimation convention; this is a custom scale for this PRD, for scheduling reference only). All committed sequentially on the same branch `feature/issue-1-a0-a1-scaffold` — rationale in §7.

| Batch | Content | Dependency | Size |
|---|---|---|---|
| **B0** | package.json / tsconfig / vitest.config / .env.example / pnpm scripts | none (starting point) | [S] |
| **B1** | src skeleton directories + shared/types.ts + profile/loader.ts + profile/errors.ts + profiles/helix/config.yaml + persona examples + corresponding tests | B0 | [M] |
| **B2** | context/types.ts + errors.ts + store.ts (table creation + FTS5 + CRUD + RecallError) + store.test.ts | B1 (needs profile to determine the db-path convention, but store itself can be implemented first with an explicit path parameter, not tightly coupled to profile) | [M] |
| **B3** | context/config.ts (SystemConfig) + staleness.ts (StalenessEngine) + corresponding tests | B2 | [S] |
| **B4** | context/confirmation.ts (ConfirmationService three states + db.transaction + added columns) + confirmation.test.ts (including transaction atomicity + missing-path tests) | B2 | [M] |
| **B5** | context/injector.ts (ContextInjector, includes filtering rejected) + injector.test.ts | B2 + B3 + B4 | [M] |
| **B6** | prompt/schema.ts (zod: ClaimSchema/CoderOutput/TesterOutput) + schema.test.ts | B0 (independent of Context, could be written in parallel with B2-B5 but committed sequentially on the same branch) | [S] |
| **B7** | prompt/personas.ts (dynamic role persona loader) + personas.test.ts | B1 (needs profile to provide the personas directory) | [S] |
| **B8** | prompt/composer.ts (PromptComposer) + composer.test.ts | B5 + B6 + B7 | [M] |
| **B9** | vertical-slice end-to-end test (Context→Prompt actually connected, including a rejected-filtering assertion) | B8 | [S] |
| **B10** | packaging config verification (`files`/`.npmignore` includes personas `.md`) + README/CLAUDE.md checkbox updates + docs/ROADMAP.md/PROGRESS.md/CHANGELOG.md write-back | B9 | [S] |

**Dependency graph notes**: B6 (Prompt schema) doesn't depend on Context and could in theory be developed in parallel with B2-B5; but since this increment is implemented sequentially by the same Cypher (not multi-person collaboration), no separate branch is split out — B6 being placed after B2-B5 is purely a sequencing choice, not a hard dependency. If multi-agent parallelism is needed in the future, B6/B7 could be split onto a parallel branch. B9, the vertical slice, is the only wrap-up batch that **must wait for everything before it to be complete** — it cannot be faked through early.

## 7. Branch strategy

Single branch `feature/issue-1-a0-a1-scaffold`, batches committed in the §6 order, rationale:
- This increment is one person (Cypher) building an entirely new `src/` skeleton from scratch; most of the inter-batch dependencies are real (a B2→B3→B4→B5→B8→B9 chain) — there's no independently mergeable parallel workflow.
- B6 (Prompt schema) is logically independent, but the code volume is small and doesn't warrant the merge overhead of its own branch.
- If the commander wants finer-grained PRs for Zorro to review in batches (rather than one giant diff), commits within this same branch can be split at the natural breakpoints B0-B1 / B2-B5 (Context) / B6-B9 (Prompt+slice) / B10 and reviewed in stages, without waiting for full completion.

## 8. Testable acceptance criteria (checkable)

- [x] `pnpm build` succeeds (tsc strict + noUncheckedIndexedAccess, no errors). — Re-verified in B10, passed.
- [x] `pnpm test` all green (vitest run). — Re-verified in B10, **96/96** actually passed.
- [x] When `AI_AGENT_PROFILE=helix`, `profile/loader.ts` correctly parses `profiles/helix/config.yaml`; when `AI_AGENT_PROFILE=verity` and `profiles/verity/` doesn't exist, returns a typed "not found" result instead of throwing a raw exception or silently returning an empty object. — B1 (`948fd24`).
- [x] The three tables `memories`/`memory_confirmations`/`system_config` are built with all columns per §4.1 (including the four newly added columns `confirmed_at`/`confirmed_by`/`actor`/`updated_at`). — B2 (`0eea001`).
- [x] `ConfirmationService`'s `confirm`/`correct`/`reject` methods are all wrapped in `db.transaction`; a test proves "if the transaction fails mid-way, it rolls back entirely, leaving no half-written state." — B4 (`b24fa3f`).
- [x] `ContextInjector` has a **targeted test** proving that memories with `confidence_state === 'rejected'` never show up in the injection result. — B5 (`06259c9`).
- [x] The persona loader resolves dynamically by role-name string (not hardcoded `{coder,tester}`), with test coverage for the "role's persona file is missing" path. — B7 (`88852a5`).
- [x] Every `JSON.parse` call site in this increment (`tags` deserialization / config.yaml-related as applicable) is wrapped in try-catch, failing into a typed error rather than throwing a raw `SyntaxError`. — Re-verified in B10: `grep -rn "JSON.parse" src` finds the only hit (`store.ts:209`, tags deserialization) wrapped in try-catch → `MemoryTagsParseError`; `profile/loader.ts`'s `loadYaml(...)` is likewise wrapped in try-catch → `ProfileConfigParseError`.
- [x] **The hard vertical-slice test exists and passes**: an end-to-end test proving Context (`ContextInjector`) → Prompt (`PromptComposer`) is really connected (seed data → inject → compose → assert final prompt content), not a false impression stitched together from isolated layer tests. — B9 (`4eb97e4`).
- [x] `package.json`'s `files`/`.npmignore` confirmed that `profiles/*/personas/**/*.md` will be distributed with the package. — B10 verified with an actual `pnpm pack`: the `files` field (no `.npmignore`, `files` works standalone) already includes `profiles/*/personas/**/*.md` + `profiles/*/config.yaml` (already shipped in B0, B10 just re-checked); `tar -tzf` confirmed no `*.test.*` leaked into the tarball's `dist/`.
- [x] `docs/ROADMAP.md`'s A0/A1 checkboxes updated, `docs/PROGRESS.md` cleared or updated, a `CHANGELOG.md` line added, `profiles/verity/` never accidentally committed (`git status` confirms `.gitignore` is effective). — Completed in this B10 batch.

## 9. Dependencies / Risks

### 9.0 Decisions finalized (approved by the commander 2026-07-20; the `[?]`s below converge accordingly and are no longer open items)
1. **SQLite driver = better-sqlite3** (stability first; `node:sqlite` empirically works with FTS5 but is still Experimental, kept as a future dependency-reduction option).
2. **Module system = ESM** (`"type":"module"` + NodeNext); if B0 finds vitest/better-sqlite3 have any issues under ESM, report immediately rather than forcing through.
3. **lint = A0 only uses `tsc --noEmit`, no eslint**; eslint is deferred to a later increment (the engine needs it long-term, but it's out of A0's scope).
4. **`tags` serialization = a JSON array string** (`JSON.stringify`/`JSON.parse` + try-catch).
5. **`replaceLatest` semantics = implemented from scratch based on meaning** (the Verity source lives on the internal company network — out of bounds, not to be read; not copied from external naming); `ConfirmationService.correct()` carries the "correct the latest content" responsibility, with tests for both the "with" and "without" an existing confirmation record paths.

**Dependencies**:
- Node v24 (confirmed locally as `v24.1.0`, consistent with `CLAUDE.md` §2).
- npm registry reachability (this run confirmed the currently resolvable versions of the following packages, for `package.json` version-range reference, not pinned exact versions): `zod@4.4.3`, `js-yaml@5.2.1`, `vitest@4.1.10`, `typescript@7.0.2`, `better-sqlite3@12.11.1`. These are actual `npm view` results as of 2026-07-20; use `^` ranges rather than pinning these exact values in `package.json`.

**Risks / historical `[?]`s (items 1-5 have been converged into finalized decisions by the commander's approval in §9.0, no longer open — the original text is kept as a traceable record, with the label changed to "finalized" instead of `[?]`; Zorro's re-review of `feature/issue-1-a0-a1-scaffold` pointed out that all five of these should have had their labels synced once §9.0 was finalized — the original `[?]` was a leftover from a doc that was never written back)**:

1. **[Finalized, see §9.0#1]** SQLite driver: better-sqlite3 vs node:sqlite. Locally verified that `node:sqlite`'s (built into Node v24.1.0) `DatabaseSync` supports `CREATE VIRTUAL TABLE ... USING fts5(...)` and can create tables normally (empirically confirmed — during this PRD's drafting, a spike: `node -e "require('node:sqlite')..."` successfully created an FTS5 table). But `node:sqlite` still carries an `ExperimentalWarning` (an experimental API, subject to change), while `better-sqlite3@12.11.1` is a mature, stable third-party native module. The commander has approved: A0/A1 use `better-sqlite3`, with the `node:sqlite` verification results kept on record as a future dependency-reduction option.
2. **[Finalized, see §9.0#2]** ESM vs CommonJS. The commander has approved: ESM (`"type": "module"` + `NodeNext` module resolution). The B0 spike found no real blocker (see the B0 entry in progress.md); it was not reverted to CommonJS.
3. **[Finalized, see §9.0#3]** Lint tool choice. The commander has approved: A0 only uses `tsc --noEmit`, no eslint; eslint is deferred to a later increment.
4. **[Finalized, see §9.0#4]** `tags` column serialization format. The commander has approved: a JSON array string (`JSON.stringify`/`JSON.parse`, with try-catch), already implemented in `store.ts`/`errors.ts` (`MemoryTagsParseError`).
5. **[Finalized, see §9.0#5]** The exact semantics of `replaceLatest` / persona missing-path tests. The commander has approved: implement from scratch based on meaning, not copied from Verity's internal naming. `ConfirmationService.correct()` handles "correcting the latest content of a memory," and now has both "with an existing confirmation record" / "without one" path tests + a `correct()→reject()` metadata boundary test (`confirmation.test.ts`, added in this Zorro re-review round); the persona loader already has a "role file missing" path test.
6. **Risk (not a `[?]`, a reminder)**: B2 (store.ts) is the largest single file in this increment (table creation + FTS5 triggers + CRUD + recall) — recommend further splitting it into smaller commits within B2 (table creation → CRUD → FTS5 triggers → recall query) to avoid one giant hard-to-review change.
7. **Risk**: the vertical-slice test (B9) is the key item for whether this whole increment passes Zorro's review — it must run real seed data against a real SQLite file (or in-memory db), and must not mock out the call between `ContextInjector`/`PromptComposer` to "manufacture" a fake pass — this is exactly the methodology warning called out in DESIGN §8.5, and Zorro will adversarially scrutinize this item closely. **Zorro's first-round re-review (2026-07-20) caught exactly two problems in B9 in real testing: it went through `inject(undefined)` (bypassing the real FTS5 recall path), and `ContextInjector`'s "core full set" was at the time equal to a full table scan (making the FTS5 recall branch dead code) — both have been fixed in this round (see `injector.ts`'s `CORE_MEMORY_TYPES` + `context-prompt.e2e.test.ts` switching to real task text with hyphens to exercise `inject()`) — confirming that this risk note was accurate.**

## 10. Project constraint check

- **Model-agnostic?** Yes — this increment (A0/A1) contains no specific provider/model names; the `providers.claude-cli`/`codex-cli` entries in `profiles/helix/config.yaml` are just configuration-structure placeholders, with the real invocation logic in A3; this increment's loader only parses the YAML structure and doesn't hardcode any branching logic.
- **No reverse cross-layer dependencies?** Yes — `src/prompt/` does not import internal implementation details of `src/context/` (`PromptComposer` only depends on `ContextInjector`'s **output type**, not a reverse dependency on Prompt); `src/context/` does not import `src/harness/`/`src/loop/` (neither layer exists in this increment).
- **`profiles/verity/` not checked in?** Yes — this increment creates no `profiles/verity/` files whatsoever; the repo's `.gitignore` already has a `profiles/verity/` rule (confirmed, see the aeloop repo root `.gitignore`); B10's wrap-up will re-check `git status` once more to confirm nothing was accidentally created.
- **Roles not hardcoded?** Yes — the persona loader and `PromptComposer` both look up dynamically by role-name string, not `if role === 'coder'` (aligned with DESIGN §1.7).
- **Engine code contains no Helix persona?** Yes — everything under `src/` is 100% free of Helix/companion/personal-memory content; only `profiles/helix/` contains example persona text (a personal overlay, allowed to exist within the private repo).
