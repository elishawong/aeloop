# Issue #37 — Fail-closed protocol compatibility for RunPlan and workflow versions: audit status

Status: **doc-only, no runtime code changed**. This audit found that the specific
boundary the issue asks to gate — a `RunPlan` reload/replay/re-entry call site — does
not exist yet anywhere in the codebase. Per the task's decision rule, no fail-closed
check was added; this document records exactly what's missing and what has to exist
first.

## 1. What the issue assumes vs. what the code does

The issue body says:

> RunPlan.planVersion is emitted as `1` but never validated on re-entry.

That's accurate as far as it goes, but "never validated on re-entry" undersells the
actual gap: there is no re-entry of a `RunPlan` at all, validated or not. `RunPlan`
is a **write-only, in-memory, single-call artifact**. Nothing in the runtime persists
one to disk/DB and later loads it back to resume, replay, or re-enter anything.

## 2. Tracing `RunPlan` end to end

- `RunPlan` is defined in `src/conductor/run.ts:18-29` with `planVersion: "1"`.
- The only producer is `Orchestrator.planRun()` (`src/conductor/orchestrator.ts:47-61`),
  which builds a fresh `RunPlan` object from a `RunRequest` every time it's called —
  there is no cache, no store, no lookup by id.
- The only caller of `planRun()` is `ConductorWorkApp.planRun()`
  (`src/conductor-work/app.ts:29-33`), which itself is only invoked from the CLI's
  `plan --json` command (`src/conductor-work/main.ts:21-24`):
  ```ts
  const runPlan = app.planRun(path.resolve(contractPath));
  output(JSON.stringify(runPlan));
  ```
  That's the entire lifecycle: build once, `JSON.stringify` to stdout, done. No file
  write, no DB insert, no second command that reads a previously emitted `RunPlan`
  back in.
- Confirmed via `grep -rn "planRun|RunPlan" src` (excluding tests): every non-test hit
  is one of the three definitions/call sites above. There is no `readFile`/`JSON.parse`
  of a persisted plan anywhere, and no `planVersion` comparison anywhere.

**Conclusion:** a "RunPlan reload/replay/re-entry boundary" cannot be implemented today
because the reload half of that sentence doesn't exist. Adding an
`assertCompatibleRunPlan()` function and calling it inside `planRun()` (the only place
a `RunPlan` object currently touches code) would not be gating a reload — it would be
validating a plan against itself, in the same call that just constructed it, which
can never fail for any input the type system already accepts. That's exactly the
"unused validation function nothing in the runtime actually calls [for its real
purpose]" pattern the task calls out as forbidden.

## 3. The nearest real reload/re-entry boundary — and why it isn't `RunPlan`'s

The codebase does have one genuine "load persisted state and re-enter execution"
call site: `resumeRun()` in `src/loop/runner.ts:1008` (reached via `aeloop resume
<runId>` → `src/cli/main.ts:141-162` → `src/cli/run-loop.ts` → `getPendingInterrupt`/
`resumeRun`). It:

- loads a persisted `workflow_runs` row by id (`deps.audit.getRunById(runId)`,
  `src/loop/audit-store.ts:602`),
- validates `run.langgraphThreadId === threadId` (`RunThreadMismatchError`,
  `runner.ts:1027-1029`),
- validates the resume decision belongs to the pending gate's decision domain
  (`ResumeDecisionDomainMismatchError`, `runner.ts:1036-1038`),
- then re-enters the LangGraph checkpoint for that thread.

This is a real, currently-reachable reload/re-entry path with existing fail-closed
guards — but it reloads a **different struct** than `RunPlan`, and that struct has no
version dimension to gate on:

- The persisted row type is `WorkflowRun` (`src/loop/audit-store.ts:51-64`):
  `id`, `task`, `workflowDefId`, `profile`, `status`, `rejectCount`,
  `rejectThreshold`, `currentState`, `langgraphThreadId`, `createdAt`, `updatedAt`.
  No `planVersion`, no workflow `version`/`inputVersion`/`outputVersion`, no schema
  version field of any kind. The `CREATE TABLE workflow_runs` DDL
  (`audit-store.ts:405-`) has no such column either.
- `resumeRun()`'s signature (`runner.ts:1008-1015`) doesn't take a `WorkflowManifest`
  or `RunPlan` — it rebuilds a **hardcoded** graph via
  `compileLoopGraph(buildLoopGraph({ router, composer }), checkpointer)`
  (`runner.ts:1040`), not one selected per-run from a `WorkflowRegistry` lookup keyed
  by the persisted `workflowDefId`. `workflowDefId` is written on `startRun`/`resumeRun`
  bookkeeping (`runner.ts:859`, `893`) but never read back to select or validate
  anything during resume.
- The CLI's actual `aeloop resume <runId>` path (`cli/main.ts` → `run-loop.ts`) never
  touches `Orchestrator`, `WorkflowRegistry`, or `WorkflowManifest` at all — it calls
  `getPendingInterrupt`/`resumeRun` directly. So even the workflow manifest's own
  `version`/`inputVersion`/`outputVersion` fields (`src/workflow/types.ts:31-32`),
  which do exist as static metadata, are never consulted on this path.
- Those manifest version fields are today only: (a) copied verbatim into a freshly
  built `RunPlan.workflow.version` at `planRun()` time (`orchestrator.ts:55`), with no
  comparison to anything, and (b) checked for shape only (non-empty string) at
  `WorkflowRegistry.register()` time (`registry.ts:39-43`, `assertManifest`) — never
  checked for *compatibility* against a persisted value anywhere.

**Conclusion:** the one real reload/re-entry call site in the runtime (`resumeRun`)
operates on a persisted structure that carries no version information today, and is
architecturally disconnected from `RunPlan`/`WorkflowManifest` (single hardcoded
workflow graph, no per-workflow-version dispatch). Gating it on "RunPlan version"
would require first inventing and threading through new persisted state — a
`workflow_runs` schema migration to add a version column, code to populate it at
`startRun` time from the `RunPlan`/manifest that was never itself persisted, and code
to read it back in `resumeRun` — none of which exists today. That's materially more
than the "minimal fail-closed check at an existing call site" the task allows; it's
building the boundary from scratch, which the task explicitly says not to do.

## 4. What must exist first (in dependency order)

1. **A `RunPlan` (or equivalent) must actually be persisted somewhere it can later be
   reloaded from** — e.g. `startRun()` writes the `RunPlan` (or just its
   `planVersion` + `workflow.id`/`workflow.version`) into `workflow_runs` (or a new
   table) at run-creation time. Today `startRun()`/`NewWorkflowRunInput`
   (`audit-store.ts:67-76`) never see a `RunPlan` at all — `ConductorWorkApp`/
   `Orchestrator` and `src/loop/runner.ts` are separate layers that don't currently
   call each other in production code (only wired together, if at all, in tests/
   fixtures — see `src/workflow/coder-tester.ts`'s direct calls to `startRun`/
   `resumeRun`, which bypass `Orchestrator.planRun()` entirely).
2. **`resumeRun()` (or its caller) must load that persisted version value back** when
   reloading a run, alongside the `workflow_runs` row it already loads.
3. **Only then** does a fail-closed `assertCompatibleRunPlan(persistedVersion)` (or
   `assertCompatibleWorkflowVersion(...)`) call at that reload site have a real,
   currently-produced value to check against — at which point the check the issue
   asks for becomes a minimal, non-invented addition to an already-real call site,
   exactly per the task's first branch.
4. Separately, if/when `resumeRun()` starts selecting its graph per persisted
   `workflowDefId` via `WorkflowRegistry.get()` instead of the current hardcoded
   `buildLoopGraph()`, that's the point at which a genuine "workflow manifest
   compatibility" consumer would exist (comparing the manifest version the run was
   started with against the manifest version currently registered for that
   `workflowDefId`) — today there is exactly one workflow definition in the registry
   (`coderTesterWorkflow`) and no code path that dispatches by id during resume, so
   there is nothing for a compatibility check to compare against.

## 5. Why no code was written for this issue

Per the task's decision rule: implementing a version check requires an actual reload
call site that consumes the thing being version-checked. `RunPlan` has a producer
(`planRun()`) but no consumer that reloads a previously-produced instance — every
`RunPlan` that has ever existed in this codebase's execution lived and died within a
single `plan --json` CLI invocation. The nearest thing that does reload persisted
state (`resumeRun()`) reloads a different, unversioned structure not derived from or
connected to `RunPlan`/`WorkflowManifest`. Writing `assertCompatibleRunPlan()` and
calling it anywhere reachable today would necessarily be either (a) validating a
`RunPlan` against itself inside the same call that built it (vacuous — can't fail),
or (b) an unused/uncalled helper function exported for a future caller that doesn't
exist yet. Both are exactly what the task explicitly forbids. §4 above is the
prerequisite list; once step 1-2 land, this issue's "minimal fail-closed check" is a
small, well-scoped follow-up with a real value to check.
