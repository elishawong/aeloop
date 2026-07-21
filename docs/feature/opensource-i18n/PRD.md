# PRD — aeloop Open-Sourcing: Repo-Wide Chinese→English Translation + Internal Governance File Stripping

> Skeleton source: `docs/feature/a4b-loop/PRD.md` (structure/phrasing style copied verbatim, adapted for the "translation + cleanup" nature of this task — this PRD is not new feature development, so batches are split by directory/file type, not by code module).
> Anti-hallucination: `[?]` = unverified by me / needs Commander confirmation; no invented interfaces/versions/word counts. Every number in this PRD (file counts, Chinese character counts, brand-name occurrence counts) comes from actually running `rg`/`wc` against the real files in this worktree, not copied from the issue's original (possibly stale) numbers; wherever there is a discrepancy with issue #17's original text, §1 lists the difference item by item — it does not quietly go with the old numbers.

- **Project**: aeloop (`elishawong/aeloop`, private repo, about to be open-sourced)
- **Branch**: `feature/issue-17-opensource` (an independent worktree has already been cut from the latest `origin/main` `0343111`: `/Users/elishawong/code/github/elishawong/aeloop-worktrees/issue-17-opensource`)
- **Priority**: P1
- **Status**: Awaiting Commander confirmation (**PRD only — no file has actually been translated/deleted yet**)
- **Last updated**: 2026-07-21
- **Related issue**: [elishawong/aeloop#17](https://github.com/elishawong/aeloop/issues/17) (scope authority, settled by the Commander on 2026-07-21)
- **Prerequisite**: A4b (#13) has already been merged into main (PR#20, commit `0343111`) — the dependency is cleared, work can start.
- **Design authority**: aeloop#17's original text (sole source of scope/acceptance criteria) + this PRD's §1 real-repo-state verification

---

## 0. What This PRD Is / Isn't

- **Is**: Turns #17's already-settled scope into an executable, batch-split task list, and re-verifies #17's original numbers/file list against the real repo state, recording any differences.
- **Isn't**: Does not re-brainstorm scope (#17 has already been settled with the Commander); does not do any actual translation/deletion at this step (see instruction item 4).
- This task is by nature "mechanical translation + cleanup + a small amount of editorial judgment," not feature development, so batches are split by **directory/file type**, not by code module — this keeps each batch's change surface narrow, makes `git diff` easy to review, and lets `pnpm test` be run frequently to verify zero logic drift.

---

## 1. Real Repo State Verification (Against #17's Original Text, Recording Differences)

### 1.1 Verification Method

In this worktree (`origin/main` HEAD `0343111`, including `audit-store.ts`/`runner.ts`/`escalation.ts` and other files added after the A4b merge), the following commands were actually run, `ripgrep 15.1.0`:

```
rg -Pl '[\p{Han}]' <path>     # find files containing Chinese characters
rg -o -P '[\p{Han}]' <path> | wc -l   # count total Chinese characters (not "word count" — it's a code-point count, matching the same ballpark as a human "~XXX characters" estimate)
rg -io 'helix|verity|cypher|zorro' <path> | wc -l   # brand-name occurrence count (case-insensitive, substring match)
```

### 1.2 Results Table

| Item | #17's original description | Measured result | Difference |
|---|---|---|---|
| Number of files in src/ containing Chinese comments | "~40 files" | **43 files** (including comments in the body of 6 `.e2e.test.ts`/`.test.ts` test files, 2 `.mjs` fixtures) | Roughly matches, slightly higher; #17's "~40" was an estimate, measured is 43, within a reasonable margin |
| Total Chinese character count in src/ | "~860 characters" | **874 Chinese characters** | Roughly matches (the new Chinese comments brought in by A4b merge's changes to `audit-store.ts`/`runner.ts`/`escalation.ts`/`gates.ts` add up to a very small net increase compared to the old estimate #17 was written against, indicating that during A4a→A4b most newly-added code's comments were already English, with only a handful of spots still embedding Chinese — see §1.3) |
| Total Chinese character count in docs/feature/* | "~47K characters" | **62,712 Chinese characters** | **Noticeably higher, exceeding by about 33%**. Reason: #17's number was estimated **before** the A4b merge; A4b added two complete documents, `docs/feature/a4b-loop/PRD.md` + `test-report.md` (the full record of A4b's build + two rounds of Zorro review), which is not a small volume. Batch B's workload is planned against the measured number, not #17's old number. |
| docs/{ROADMAP,PROGRESS,BACKLOG,README}.md | No word count given separately | **1,846 Chinese characters combined** | No comparison baseline, recorded as supplementary |
| docs/DESIGN.md | No word count given separately (part of Batch G's added scope) | **3,181 Chinese characters** | No comparison baseline, recorded as supplementary |
| CLAUDE.md (to be deleted) | No word count given | 847 Chinese characters, a plain `git rm` suffices, no translation workload involved | — |
| CHANGELOG.md (to be rewritten) | No word count given | 807 Chinese characters, this is a **full rewrite**, not a translation — workload isn't measured by character count | — |
| `pnpm test` baseline | No specific number mentioned (CHANGELOG's A4b entry says "276 tests green") | **Measured: 34 test files, 300 tests, all green** (`pnpm test`/`pnpm lint`/`pnpm build` are all currently clean) | CHANGELOG's "276" is the number as of the moment the A4b build finished, and differs from the current HEAD (doesn't affect this PRD — the baseline record just uses the measured 300, not CHANGELOG's old number) |
| Repo-wide brand-name (`helix\|verity\|cypher\|zorro`) occurrence count | No total given (only describes "removing the aliases") | **466 total** (excluding node_modules/dist), broken down: docs/feature/* 242, src/ 126 (of which Zorro 118, Verity 7, Helix 1), docs/DESIGN.md 40, CLAUDE.md 7 (deleted entirely along with Batch D), the rest (CHANGELOG.md/README.md/docs/ROADMAP.md etc.) 51 | **This is the item with the biggest discrepancy from #17's original framing**, see §1.4 for details — #17's description of "removing brand names" focuses on the profile-alias layer, but the actual measured largest source of brand names isn't the profile at all — it's the large number of "Zorro Round-N review references" scattered through code comments/docs |

### 1.3 The Nature of the Chinese Remaining in src/ (Not "Forgotten Translation," but Embedded Quotation)

`CLAUDE.md` §4 (about to be deleted, but reflects an existing convention) already stipulates "code comments in English; documents facing the Commander may be in Chinese." Verification found that the 874 Chinese characters in src/ are **not large blocks of Chinese comments**, but are concentrated in two categories:

1. **Verbatim quotations of Chinese original sentences from `docs/DESIGN.md`** — e.g. both `src/prompt/personas.ts:9` and `src/prompt/schema-registry.ts` verbatim-quote a Chinese sentence from DESIGN §1.7 ("persona/schema looked up dynamically by role name from the registry, instead of a hardcoded {coder,tester} Record like Verity did"), used to explain "which exact sentence of the design doc this line of code corresponds to."
2. **Scattered leftover Chinese phrases** interspersed within otherwise-English doc-comments (e.g. `context/config.ts`/`harness/errors.ts`, etc.).

**Batch-ordering impact**: For category 1 (verbatim quotes of DESIGN.md), if src/ is translated first (Batch A) and DESIGN.md afterward (Batch G), the two translations could end up inconsistent, creating a new problem where "what the code comment says doesn't match the English design doc." **Recommendation: Batch G (DESIGN.md's English version) should finish before, or at minimum in the same batch as, Batch A for those cross-referenced spots' terminology alignment** — see §3's Batch A task notes for specifics.

### 1.4 The Real Nature of the Brand-Name (Helix/Verity/Cypher/Zorro) Residue (#17's Original Framing Needs One More Layer of Editorial Rule Here)

#17's original item 6 frames "removing brand names" as "profiles are already generically named; Helix/Verity are just brand aliases, so simply removing the aliases is enough." Measured findings:

- **The profile config files themselves are already clean** — `profiles/subscription/config.yaml` and `profiles/subscription/personas/{coder,tester}.md` contain **zero** occurrences of "Helix"/"Verity" (the CHANGELOG record shows profiles were already renamed from `helix`/`verity` to `subscription`/`apikey` during the A3 phase). `profiles/apikey/` is already excluded by `.gitignore` and isn't in the public repo. **The specific action #17 item 6 describes — "profile alias cleanup" — has effectively already been done; the profile files themselves don't need to be touched again.**
- **The real bulk of the brand-name residue is "review references" in code comments and "product comparisons" in design docs**, not profile naming:
  - **`Zorro` (118 occurrences in src/)**: Almost all of them are **review-provenance references** shaped like `// Zorro Round-1 D1 rework (docs/feature/a4b-loop/test-report.md): ...` — when explaining "why this piece of code is written this way," they point to exactly which review round found the issue; this is genuine engineering traceability documentation, not product marketing. Concentrated in `src/loop/runner.ts` (18), `src/loop/audit-store.ts` (11), `src/harness/adapters/{claude,codex}-cli-adapter.ts` (9 combined), and other files.
  - **`Verity` (7 occurrences in src/ + 40 in docs/DESIGN.md)**: Refers to a sister internal project (a "proven-out" predecessor implementation that aeloop's design draws on), e.g. "Verity's M2/M3 shipped layers that each tested green in isolation but were never actually wired together" — this kind of reference **explains the backstory of a design decision** (why aeloop needs to fill a gap somewhere that Verity didn't cover), which is likewise genuine documentation value, not a marketing term.
  - **`Helix` (1 occurrence in src/)**: One spot, `src/loop/audit-store.ts:26`, "Portability (Helix 2026-07-21 dispatch note, ai-agent#127)."
  - **`Cypher`**: 0 hits in src/ (only appears in docs/feature/*'s historical records and the already-to-be-deleted CLAUDE.md).
- **Additional finding: cross-repo issue references** (`ai-agent#NNN`) — 9 occurrences repo-wide (src/ 1, docs/DESIGN.md 2, CHANGELOG.md 1, docs/feature/* 5), pointing to issues in the private repo `elishawong/ai-agent`; a public reader clicking them will hit a 404. This kind of reference is the same category of "internal-workflow leakage" as the brand names — #17's acceptance criterion's `rg -i 'helix|verity|cypher|zorro'` scan by itself doesn't catch `ai-agent#`, but it's the same nature, so it's recommended to handle it together (folded into Batch F, see §3 for details).
- `docs/ROADMAP.md`/`docs/DESIGN.md` also contain **same-repo issue references** like `issue #2`/`issue #13` (pointing to aeloop's own repo, not ai-agent) — after open-sourcing, these links are themselves resolvable (assuming the issues are also public), **not a leak, no action needed**, left in place.

**Conclusion**: #17's acceptance criterion "`rg -i 'helix|verity|cypher|zorro'` zero hits (or list, item by item, the rationale for any deliberately-kept spots)" — faced with 466 hits, of which 242 live inside historical documents (docs/feature/*) that are being "kept as-is" — involves an editorial judgment call that needs Commander confirmation. See §4's naming-replacement rules.

---

## 2. Overall Acceptance Criteria (Copied Verbatim from #17's Original Text, Nothing Omitted)

- [ ] `rg -Pl '[\p{Han}]'` zero hits across the whole repo (excluding `node_modules/`, `dist/`, `pnpm-lock.yaml`; whitelisting `*.zh-CN.md`).
- [ ] `rg -i 'helix|verity|cypher|zorro'` zero hits across the whole repo (excluding `node_modules/`, `dist/`), **or** hits remain only within the historical-record documents under `docs/feature/**` — this PRD's §4 proposes treating this category as a **single written blanket exemption** (not enumerating all 242 lines individually), requiring the Commander to sign off on this reading before Batch F (see §4/§7 open items).
- [ ] All four files `README.md` / `README.zh-CN.md` / `docs/DESIGN.md` / `docs/DESIGN.zh-CN.md` present and content-aligned (English is the source of truth).
- [ ] `pnpm test` all green — the measured baseline is **34 test files, 300 tests**; at the end of every batch during execution it must still be this number (the test count itself shouldn't change — translation/file deletion doesn't change test content).
- [ ] No `CLAUDE.md` / `.claude/` internal-skill residue.
- [ ] `git diff` review: aside from comments/docs/deleted governance files, **no logic-code changes** (`pnpm build`/`pnpm lint` must also stay clean — both are currently clean at baseline).

---

## 3. Batch Split

> Every batch is independently verifiable and independently submittable for review; for the dependency-based recommended execution order see §6 — the batch numbering order does not imply the execution order.

### Batch A — Translate src/'s Inline Chinese Comments to English (Zero Logic Change)

- **Scope**: 43 `src/` files containing Chinese characters (including `.ts`/`.test.ts`/`.e2e.test.ts`/`.mjs`), further split by directory into 4 independently-submittable sub-batches:
  - A1 `context/` (6 files: `config.ts`/`errors.ts`/`injector.ts`/`staleness.ts`/`store.ts` + `context-prompt.e2e.test.ts`)
  - A2 `harness/` (13 files: `errors.ts`/`provider-router.ts`/`schema-validator.ts`/`tool-exec-verifier.ts`/`types.ts`/`adapters/{claude-cli,codex-cli,litellm}-adapter.ts` + their corresponding `__tests__/*` + 2 `.mjs` fixtures + `harness-cli.e2e.test.ts`/`harness.e2e.test.ts`)
  - A3 `loop/` (14 files: `audit-store.ts`/`errors.ts`/`gates.ts`/`graph.ts`/`nodes/{coder,tester}.ts`/`runner.ts`/`types.ts`/`workflow-def.ts` + their corresponding `__tests__/*` + 2 `.mjs` fixtures + `loop.e2e.test.ts`)
  - A4 `prompt/` + `profile/` (6 files: `composer.ts`/`personas.ts`/`schema-registry.ts`/`schema.ts`/`loader.ts` + their corresponding tests)
- **How to change**: Locate Chinese character by character, translate in place to English, **do not change a single line of logic code, do not change the runtime semantics of any string literal** (if a Chinese string is actually a value compared/asserted at runtime rather than a comment, it must be individually confirmed before touching it — no such case is expected to exist, but every file's diff must be reviewed after editing to confirm all changes land inside comments/JSDoc).
- **Special handling**: The two spots in A4 (`prompt/personas.ts`, `prompt/schema-registry.ts`) that verbatim-quote the Chinese original sentence from `docs/DESIGN.md` §1.7 should, when translated, use **the same translation Batch G's DESIGN.md English version uses for the same sentence**, to keep the code comment and the design doc's terminology consistent (see §6 for the dependency).
- **Acceptance**:
  - `rg -Pl '[\p{Han}]' src/` zero hits.
  - `pnpm test` still 34/300 all green (run once per sub-batch).
  - `pnpm lint` (`tsc --noEmit`) clean.
  - Manually walk through `git diff`, confirming every hunk only touches explanatory text inside comments/JSDoc/string constants, not executable logic.
- **Risk**: If JSDoc contains special syntax parsed by TypeDoc/other tools (no sign of this in this repo, but watch for it while translating), make sure the translation doesn't break Markdown code-fence delimiters.

### Batch B — Translate docs/feature/*'s Internal Documents Entirely to English (Kept As-Is)

- **Scope**: 5 feature directories, 10 `.md` files, measured at 62,712 Chinese characters total (**about 33% higher than #17's original ~47K estimate**; workload is planned against this number):
  - `a0-a1-engine-scaffold-context-prompt/{PRD.md, progress.md}`
  - `a2-harness-provider-router-litellm-adapter/{PRD.md, test-report.md}`
  - `a3-cli-bridge/{PRD.md, spike-findings.md}`
  - `a4a-loop/{PRD.md, spike-findings.md, test-report.md}` (there's also an `a4a-loop/spike/` subdirectory — needs confirming whether it contains text content while verifying; per the task instructions it's not in scope for translation this round, just watch not to miss it)
  - `a4b-loop/{PRD.md, test-report.md}`
- **How to change**: Content/structure/technical judgments are **kept as-is**, only a language translation — including the large number of `Zorro Round-N`/`Helix`/`Verity`/`ai-agent#NNN` references within them — **no brand-name replacement is done for these references in this batch**, rationale in §4 (these files are historical records, not user-facing product documentation).
- **Suggested execution mode**: The 5 feature directories are mutually independent — 5 agents can be fanned out to translate in parallel (#17's "execution mode" section already recommends this), one sub-batch per directory, independently accepted.
- **Acceptance**:
  - `rg -Pl '[\p{Han}]' docs/feature/` zero hits.
  - Spot check: randomly pick 2-3 technical-detail paragraphs (e.g. a specific bug description found by a Zorro review in A4b test-report.md), verify the translation hasn't lost/distorted the original meaning (Zorro's anti-hallucination gate standard: a review must trace back to the source text — "looks correctly translated" doesn't count).
  - Doesn't touch code, `pnpm test` doesn't need re-running (but per §6's recommendation, run it once uniformly at the end of the whole batch to confirm no code references were accidentally deleted).

### Batch C — Translate docs/{ROADMAP,PROGRESS,BACKLOG,README}.md to English

- **Scope**: `docs/ROADMAP.md` (607 words), `docs/PROGRESS.md` (167 words), `docs/BACKLOG.md` (66 words), `docs/README.md` (198 words), 1,846 Chinese characters combined.
- **How to change**: Translate to English, **at the same time** handling the brand names/cross-repo references appearing in these files (see §4's replacement rules) — this batch isn't part of the "kept as-is" historical record, these are actively-maintained living documents, so brand-name cleanup applies.
- **Acceptance**: `rg -Pl '[\p{Han}]' docs/ROADMAP.md docs/PROGRESS.md docs/BACKLOG.md docs/README.md` zero hits; `rg -i 'helix|verity|cypher|zorro'` zero hits on the same four files.

### Batch D — Governance File Stripping

- **Scope**:
  - Delete `CLAUDE.md` (847 Chinese characters, plain `git rm`, no translation)
  - Delete `.claude/skills/` (two files, `aigit/SKILL.md` and `run/SKILL.md`, `git rm -r`)
  - `CHANGELOG.md`: retire the existing 807-Chinese-character version, **rewrite** (not translate) into a generic open-source changelog — Keep a Changelog style, strip all Helix/Cypher/Zorro/`issue #NN`/`ai-agent#NNN` references, keep only the "what was done" layer that's externally meaningful (at the granularity of e.g. "A4b: threshold escalation + audit persistence + cross-process checkpoint resume shipped, 300 tests passing," with no internal review-round detail)
  - Add `CONTRIBUTING.md` (replacing the part of `CLAUDE.md` useful to contributors: the tech-stack table, directory structure, test/build commands, PR expectations — **not including** internal-workflow descriptions such as the "strategist/Cypher/Zorro" role division, `/aigit`/`/spec` internal-skill references, or `ai-agent` cross-repo references)
- **Acceptance**:
  - `test -f CLAUDE.md` should fail (file doesn't exist).
  - `find .claude -type f` should be empty / the `.claude` directory doesn't exist.
  - `CONTRIBUTING.md` exists and contains no brand names/internal-workflow descriptions.
  - After `CHANGELOG.md`'s rewrite, `rg -i 'helix|verity|cypher|zorro|ai-agent#|issue #'` (internal issue-number references in the public repo are likewise cleaned up) zero hits.

### Batch E — Translate .gitignore's Comments to English

- **Scope**: `.gitignore` (359 bytes, 5 Chinese comment blocks: `# runtime state...`, `# pipeline runtime state...`, `# company overlay never enters this repo...`, `# environment`, `# misc`).
- **How to change**: Translate the comments to English, **keep the rules themselves unchanged** (exclusion rules like `profiles/apikey/`, `.helix/`, `*.db` etc. are kept as-is, only the explanatory comments are translated).
- **Acceptance**: `rg -Pl '[\p{Han}]' .gitignore` zero hits; confirm via `git status` that the exclusion rules' effective scope hasn't changed (spot-check a few known paths with `git check-ignore`, e.g. `profiles/apikey/foo`, `.helix/bar` should still be ignored).

### Batch F — Remove Brand Names (Repo-Wide Scan + Replace, Covering All Prior Batches' Output)

- **Scope**: All files produced by Batches A/C/D/E/G + `docs/DESIGN.md` (40 occurrences) + any corner missed by Batches A-E, **explicitly excluding `docs/feature/**`** (Batch B's historical record, rationale in §4).
- **How to change**: Handle each category per §4's replacement-rules table — this is not a simple string-replace of "Helix" → "something" — each category of reference needs different handling (review-provenance references vs. product-comparison references vs. profile descriptions vs. cross-repo issue links).
- **Acceptance**:
  - `rg -i 'helix|verity|cypher|zorro' --glob '!docs/feature'` (excluding node_modules/dist) zero hits.
  - `rg 'ai-agent#'` zero hits (repo-wide, including docs/feature — this one is an exception: cross-repo dead links are recommended to be cleaned up or turned into plain-text descriptions even inside historical documents, leaving no clickable-but-404 reference; if the Commander decides docs/feature should be left completely untouched, this item narrows to "zero hits outside docs/feature only" — see §7 open items for the two possible readings).
  - Run `pnpm test` once uniformly at the end to confirm 34/300 all green (if brand-name replacement accidentally hits a string literal, tests will blow up first).

### Batch G — Maintain README + DESIGN's Chinese/English Dual Versions

- **Scope**:
  - `README.md` (English, currently already in English but its content is **out of date** — it says "Status: Pre-spec... project scaffold only," while in reality A0-A4b are all complete and 300 tests are green; Batch G needs a **substantive content update**, not simply "it's already English so it doesn't need touching") + add `README.zh-CN.md` (Chinese version, content-aligned)
  - `docs/DESIGN.md` (3,181 Chinese characters, translate to English + brand-name cleanup, English is the source of truth) + add `docs/DESIGN.zh-CN.md` (Chinese version, content-aligned, likewise passed through the brand-name cleanup rules once)
- **How to change**:
  - README.md first gets a content correction (reflecting the real current state, removing the dead link to `CLAUDE.md`, pointing instead to `CONTRIBUTING.md`), then the zh-CN mirror is produced.
  - When translating DESIGN.md to English, apply §4's replacement rules at the same time (this is the currently-maintained design authority document, not a historical record — brand-name cleanup applies); once the English version is finalized, produce the zh-CN mirror, with the two versions content-aligned (not independently drafted in a way that lets them drift).
- **Acceptance**:
  - All four files present: `test -f README.md README.zh-CN.md docs/DESIGN.md docs/DESIGN.zh-CN.md`.
  - `rg -Pl '[\p{Han}]' README.md docs/DESIGN.md` zero hits (the English versions must be clean; `*.zh-CN.md` is whitelisted, Chinese is allowed).
  - `rg -i 'helix|verity|cypher|zorro'` zero hits across the four files.
  - Manual spot check: compare the Chinese and English versions' content for the same section paragraph by paragraph, confirming nothing's missing/no independently-drifted content (mechanical checks like heading count, code-block count can help, e.g. `grep -c '^#' README.md README.zh-CN.md` should be equal).
  - README.md no longer links to the deleted `CLAUDE.md`.

---

## 4. Brand-Name Replacement Rules Table (Batch F's Execution Basis)

| Reference type | Where it appears | Handling rule | Example |
|---|---|---|---|
| **`Zorro Round-N ...` review-provenance references** | src/ code comments (118 occurrences), docs/DESIGN.md (some) | Remove the persona name, keep the round number + the original doc reference path, change to the neutral phrasing `Review Round-N` | `Zorro Round-1 D1 rework (docs/feature/a4b-loop/test-report.md)` → `Review Round-1 D1 rework (docs/feature/a4b-loop/test-report.md)` |
| **`Verity` sister-project comparison references** | src/ (7 occurrences), docs/DESIGN.md (40 occurrences, including Helix) | Replace with a neutral descriptive phrase, don't name the specific internal project; keep phrasing consistent within the same file | `Verity's M2/M3 shipped layers that...` → `a prior internal implementation's M2/M3 layers that...`; `avoid a hardcoded Record like Verity did` → `avoid a hardcoded Record like an earlier internal implementation did` |
| **`Helix` dispatch-note reference** | src/loop/audit-store.ts:26 (1 occurrence) | Remove the persona name and the cross-repo reference, keep only the technical rationale itself | `(Helix 2026-07-21 dispatch note, ai-agent#127)` → rewritten per context into a pure technical footnote, with no internal-organization reference left |
| **`ai-agent#NNN` cross-repo dead links** | 9 occurrences (src/ 1, DESIGN.md 2, CHANGELOG.md 1, docs/feature/* 5) | Within Batches A/C/D/G's scope (i.e. outside docs/feature/*), remove entirely or rewrite into a non-clickable plain-text note; the docs/feature/* scope is left for §7's open item to decide | — |
| **profile brand-alias descriptions** | README.md, docs/DESIGN.md (phrasing like "Helix (running the subscription profile)") | Remove the persona name, keep only the profile name + a neutral description; adopt #17's original wording directly | `Helix (running the subscription profile)` → `personal subscription profile`; `Verity (running the apikey profile)` → `company API / LiteLLM profile` |
| **All brand names inside `docs/feature/**` (242 occurrences)** | Batch B's scope | **Not replaced — kept as-is and translated** — this is a real historical record of build/review activity, its content includes "who found what issue in which review round"; replacing it with pseudonyms or deleting it would distort the historical record and lose traceability (when a reader wants to dig into the backstory of a particular technical decision, these documents are the sole primary record). Corresponds to #17's acceptance criterion "or list, item by item, the rationale for any deliberately-kept spots" — **this PRD proposes satisfying that clause via "a blanket exemption for `docs/feature/**` + this table row as the written rationale,"** rather than enumerating all 242 lines individually. This is an editorial judgment call that needs the Commander to sign off on before Batch F executes (§7). |
| **Same-repo issue references (`issue #2`/`issue #13`)** | docs/ROADMAP.md, docs/DESIGN.md | Kept as-is — points to aeloop's own repo, resolves normally after open-sourcing, not counted as internal-workflow leakage | — |

---

## 5. Out-of-Scope Findings (Not Within #17's Scope, for the Commander's Reference — This PRD Does Not Fold These into a Mandatory Batch)

- **`package.json`'s `"private": true` + `"license": "UNLICENSED"`**: literally inconsistent with the "open-sourcing" goal (a private package with no license can't be externally installed/referenced). #17's original text doesn't mention this item; this PRD doesn't unilaterally expand scope to add it as a mandatory batch, but records it honestly: if the Commander wants this handled as part of this round, an open-source license type (MIT/Apache-2.0, etc.) needs to be additionally decided and a top-level `LICENSE` file added — this is a product judgment call for the Commander/the strategist to make, not something a translation task can decide on its behalf.
- **No top-level `LICENSE` file currently exists** — same as above, a downstream consequence of it.

---

## 6. Recommended Execution Order (Dependency Relationships — Doesn't Mean the Build Phase Must Be Strictly Sequential, but Notes Who Depends on Whom)

1. **Batch D (governance file stripping) + Batch E (.gitignore)** — mutually independent, small change surface, can be done first; this also directly removes CLAUDE.md's 7 brand-name occurrences from the "to-process list" (deletion resolves it, no translation needed).
2. **Batch G's DESIGN.md English finalization** — recommended to complete before Batch A (at minimum, complete the §1.7 sentence verbatim-quoted by `personas.ts`/`schema-registry.ts`), to avoid Batch A and Batch G independently translating two inconsistent English versions (see §1.3).
3. **Batch A (src/)** — the 4 sub-batches (A1-A4) can run in parallel, A4 depends on the previous step's DESIGN.md §1.7 translation.
4. **Batch C (docs/ROADMAP etc.) + the rest of Batch G (README content refresh + bilingual mirrors)** — can run in parallel with Batch A, no conflict (different files).
5. **Batch B (docs/feature/*)** — fully independent, can be run in parallel at any time, the 5 subdirectories are mutually independent, fan-out recommended.
6. **Batch F (repo-wide brand-name-removal scan)** — placed last, doing one full-repo `rg` scan + final replacement after A/C/D/E/G are all done and the content is already English — this is less likely to miss things than handling it scattered throughout the translation process. **Before Batch F executes, the Commander needs to sign off on §4's table's last row (the blanket exemption for docs/feature/*)**, otherwise Batch F's acceptance criteria are ambiguous (zero hits vs. zero hits excluding docs/feature — the two readings give different acceptance results).
7. At the end of every step, run `pnpm test && pnpm lint && pnpm build` uniformly, keeping 34/300 all green + both commands clean.

---

## 7. Items Awaiting Commander Confirmation (Doesn't Block Reviewing the PRD Itself, but Blocks Batch F / Part of Batch B's Wrap-Up)

1. **How to handle the exemption for the 242 brand-name occurrences inside docs/feature/*** (§4's last row): adopt this PRD's proposed "blanket exemption + one written rationale," or require replacing each one individually with neutral phrasing (which would change Batch B's workload and nature, from "pure translation" to "translation + rewriting historical records," with a risk of distortion)?
2. **How to handle the `ai-agent#NNN` cross-repo references inside docs/feature/*** (5 of the 9 occurrences are in this directory): keep them along with docs/feature's blanket exemption, or remove the clickable-but-404 cross-repo links even inside historical records?
3. **The `package.json` license/private fields mentioned in §5**: decide this as part of this round, or explicitly exclude it from this issue's scope and leave it for the Commander to decide separately later?

It's recommended that the Commander give a ruling on all three items together after reading through the PRD — no separate meeting is needed for this; if the Commander is inclined to "go with the PRD's proposed default approach," simply saying "approved" is enough, and PRD §4/§6's default plan will be treated as confirmed.

---

## 8. Process-Gap Disclosure: Zorro's Independent Review Was Skipped This Round (Explicitly Waived by the Commander)

After the Commander approved §1/§4/§7's three default plans on 2026-07-21, the strategist raised that this round's 14+1 batches (D/E/C/B1-B5/G-DESIGN/A1-A5/G-remainder/F) were **all executed by the Cypher-role agent, without having gone through Zorro's independent review** — per the top-priority gate "Cypher finishes → Zorro PASS → the Commander approves → only then can it be committed," this should have been a hard prerequisite step. The strategist gave two options (① go through Zorro's `/verify` first, ② the Commander explicitly waives it, following the A4b R6 precedent), and **the Commander chose ②, explicitly waiving this round's Zorro independent review**.

**Recorded honestly, nothing concealed**:
- This round's changes are, by nature, mechanical translation + brand-name cleanup + governance-file deletion/rewriting, not new feature code; but a real risk of semantic drift still exists (at least one instance was actually caught: Batch B2 once mistranslated the role title "junshi" (the Chinese source term for "the strategist") into the proper noun "Helix," and self-corrected afterward; Batch F has specifically done a second pass to check for this kind of residue).
- The entire acceptance process (CJK scan / brand-name scan / `pnpm test`/`lint`/`build`) was executed by Cypher itself + reviewed by Cypher itself — **this does not constitute independent review in the sense of the "producer ≠ reviewer" rule (Iron Rule 4)**.
- If a translation distortion / brand-name-cleanup collateral damage / CHANGELOG-rewrite factual inaccuracy is discovered somewhere later, this section is the first place to start the suspect investigation.
- commit/push still requires the Commander's re-confirmation **at that moment**, each time (this Zorro waiver does not incidentally grant default commit authorization — the two are two independent gates).
