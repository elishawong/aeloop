# PRD — aeloop A5: CLI/TUI (first real terminal entry point)

> Skeleton source: `docs/feature/a4b-loop/PRD.md` (structure/batch/wording style copied directly).
> Anti-hallucination: `[?]` = unverified by me / needs Commander confirmation; no invented interfaces/versions/parameters. Every statement in this PRD about existing code comes from my own reading of the real A0-A4b code (`src/**/*.ts`, excluding `*.test.ts`) + `docs/DESIGN.md` + `docs/ROADMAP.md` + issue #22, not from memory. Every claim about a third-party library's API (`chalk`, `@inquirer/prompts`) was checked against that library's own published README/registry metadata during this PRD's research, not recalled from training — see §9 for the exact sources. Any design decision without direct code/document evidence that required my own judgment is listed separately in §9, not mixed into the "verified" parts.

- **Project**: aeloop (`elishawong/aeloop`, private repo)
- **Branch**: `feature/issue-22-a5-cli-tui` (newly cut from `main` `c8d0289`, i.e. the HEAD right after the A4b + open-source-readiness merges)
- **Priority**: P1
- **Status**: Awaiting Commander confirmation
- **Last updated**: 2026-07-21
- **Related issue**: [elishawong/aeloop#22](https://github.com/elishawong/aeloop/issues/22)
- **Design authority**: `docs/DESIGN.md` §8 milestones table ("A5 CLI/TUI: colorized diff + y/n approval + visual distinction for escalations") + real A0-A4b code: `src/loop/{types,gates,escalation,graph,runner,audit-store,workflow-def}.ts`, `src/harness/{provider-router,config,types}.ts`, `src/prompt/{schema,composer}.ts`, `src/context/{injector,store,config,staleness}.ts`, `src/profile/loader.ts` + `docs/feature/a4b-loop/PRD.md` (runner.ts contract, especially its "gives a future A5 CLI a ready-made entry point" comment on `getResumableRuns`) + issue #22's Commander-decided scope (2026-07-21: subscription-profile-only, lightweight chalk+prompt-library approach, no full TUI framework).

---

## 0. What A5 actually is (and isn't) — the single most important finding from research

Before any interface design: **nothing in A0-A4b writes a coder's diff to a real file on disk, and nothing applies it.** This is not something A5 needs to fix, and it changes what "approving a diff" concretely means for this increment. Evidence:

- `src/loop/graph.ts`'s `applyNode()` (the `Apply` terminal state, DESIGN §4): `return { applied: true };` — no filesystem I/O. Its own doc comment says this is "DESIGN §4's terminal state, **downgraded** per [A4a] PRD §0/§2: marks the run as finished, never touches the filesystem" — a documented, deliberate A4a decision, not an oversight A5 is expected to close.
- **Correction (2026-07-21, Zorro + Codex `gpt-5.6-sol` independent re-review, `docs/feature/a5-cli-tui/test-report.md` P0-1, tracked at [elishawong/aeloop#31](https://github.com/elishawong/aeloop/issues/31))**: an earlier draft of this section claimed `ClaudeCliAdapter`'s coder-role `--allowedTools "Bash,Read,Grep,Glob"` is a read-only tool allowlist (no `Write`/`Edit`). **That claim was factually wrong and has been struck.** `src/harness/adapters/claude-cli-adapter.ts` starts the coder with `--permission-mode bypassPermissions`, and `Bash` is not a read-only tool — `sed -i`, shell redirection, and `git apply` can all write to disk through it; `Read`/`Grep`/`Glob` being read-only doesn't make the *allowlist* read-only when `Bash` is also in it. `profiles/subscription/personas/coder.md` explicitly instructs the coder to "implement the requested change directly in the target codebase". Concretely, this means **the coder can already have written real changes to the target repository before a human ever sees G1's rendered diff and approves it** — the G1/G2/G3 gates are a genuine audit/review step over the model's self-reported diff and claims (real value, per §0's framing above), but they are not a technical precondition for the coder having already mutated the filesystem. This is a known, currently-unfixed limitation of the underlying Harness-layer adapter (not something A5's `src/cli/` layer can fix from its own scope — the fix would live in `claude-cli-adapter.ts`'s permission/tool configuration, a Harness-layer change), tracked at aeloop#31, out of scope for this PRD's batches.
- `CoderOutput.diff` (`src/prompt/schema.ts`) is documented as "a unified diff or equivalent patch text" — a **self-reported string** the model produces as part of its structured JSON answer, not a real `git diff` computed against a working tree, and not guaranteed to be strictly-formatted unified-diff syntax.

**What this means for A5**: the CLI's G1/G3 "approve this diff" gates are a genuine, real human-in-the-loop review of the model's self-reported change description and its audit trail (claims/confidence/tool-verification) — that is real value (DESIGN's anti-hallucination + audit-trail goals) — but approving G3 today does **not** result in any file on disk actually changing. A5 renders and gates on exactly what A0-A4b's engine actually produces; it does not add a new "write the diff to the workspace" capability (that would be new Loop-layer scope, not a CLI-layer concern, and is not requested by issue #22 or DESIGN §8's A5 row). Flagged explicitly here rather than left implicit, since it's easy to read "colorized diff + y/n approval" and assume approval performs a write.

## 1. Problem / Users / Solution

- **Problem to solve**: A0-A4b built the entire engine (Context→Prompt→Harness→Loop, all four layers, 300/300 tests green) but the *only* way to drive a run today is programmatic — `src/loop.e2e.test.ts` calls `startRun()`/`resumeRun()` directly with hardcoded `GateResumeValue`/`EscalationResumeValue` objects. There is no terminal command a human can run, no rendering of what the coder/tester actually produced, and no interactive prompt at any of the four decision points (G1/G2/G3/Escalation). `src/index.ts`'s barrel doesn't even export `loop`/`harness`/`cli` yet (deliberately, per its own header: "these layers don't exist yet"). `package.json` has zero CLI-facing dependencies.
- **Who it's for**: The Commander, running aeloop from a terminal against the `subscription` profile (claude-cli coder / codex-cli tester) to actually use the engine for the first time, end to end, as a human — not as a test harness.
- **One-sentence solution**: A new `src/cli/` layer (DESIGN §6's target file tree already reserves this as a sibling of `profile/`, outside the four nested engine layers) that (1) assembles the real `subscription`-profile dependency graph (`loadProfile` → `MemoryStore`/`ContextInjector` → `PromptComposer` → `buildAdapterRegistry`/`ProviderRouter` → `AuditStore`/checkpointer) exactly the way `src/loop.e2e.test.ts` already proves works, (2) drives `runner.ts`'s existing `startRun()`/`resumeRun()` (plus one small, additive `runner.ts` export this PRD adds — §5) through an interactive loop that renders each gate's payload with chalk-colorized diff/issue text and prompts for a decision with `@inquirer/prompts`, with a visually distinct treatment for the Escalation gate, and (3) exposes three subcommands (`start`, `resume`, `list`) via a real `bin` entry point.

## 2. Goals / Non-goals

**Goals**:
- A real, installable/runnable CLI command (`aeloop start "<task>"` / `aeloop resume <runId>` / `aeloop list`) that drives one Loop run against the `subscription` profile only.
- Colorized diff rendering at G1/G3 (`CoderOutput.diff`, best-effort line-prefix coloring — not a strict unified-diff parser, since the field isn't guaranteed to be strictly formatted — see §0/§6).
- G1 gate: render diff + question, `approved`/`rejected` decision (`@inquirer/prompts confirm`), optional free-text reason on reject (feeds `GateResumeValue.reasoningText`, which `gates.ts`'s `createG1Node` already threads into the next round's `feedback`).
- G2 gate: render the tester's `issues[]` list + question, decision restricted to exactly what `gates.ts`'s `routeAfterG2` actually accepts today — **`approved` (send back to coder for a fix) or `escalate` (voluntary escalation)** — not a third "rejected" option (see §0.1 correction below).
- G3 gate: render diff again (final look before completion) + question, `approved`/`rejected` decision, same shape as G1.
- Escalation gate (`ESCALATION_ACK`): visually distinct rendering (a banner distinguishing it from an ordinary gate — chalk background/bold treatment, not merely a different single color used elsewhere) + render diff + tester issues + three-way decision (`revise`/`force_pass`/`abandon`), optional free-text reason on `revise` (feeds the same `deriveFeedback` pattern `escalation.ts` already implements).
- `aeloop resume <runId>`: reconstructs a paused run's pending gate payload from disk (via one new `runner.ts` export, §5) and continues, in a **new process**, with no in-memory state from the original `start` invocation — this is the concrete acceptance test for "does A5 actually reuse A4b's cross-process resume, not reinvent it."
- `aeloop list`: thin CLI wrapper over the already-existing `getResumableRuns()` (`runner.ts`) — prints `running`/`escalated` runs (id/task/currentState/updatedAt) a human can resume.
- Hard vertical slice (DESIGN §8.5's mandatory per-milestone rule): a real end-to-end test driving the real `subscription`-profile dependency graph (real `MemoryStore`/`ContextInjector`/`PromptComposer`/`buildAdapterRegistry`/`ProviderRouter`/real cli-bridge fixture subprocesses, same fixture-substitution boundary `src/loop.e2e.test.ts` already established) through `src/cli/main.ts`'s real command dispatch, with a scripted `FakePrompter` standing in for a real human at the keyboard — proving the CLI layer is really wired onto the real engine, not just unit-tested against fakes throughout.

**Non-goals** (explicit, so nobody reads a gap as an oversight):
1. **apikey/direct-api profile support** — Commander-decided (2026-07-21, issue #22): A5 only wires up `subscription`. `aeloop` exits with a clear, typed error if `AI_AGENT_PROFILE=apikey` (or any value other than `subscription`) is set — never a silent fallback, never an unrelated crash. Lands in A6 alongside the apikey acceptance run.
2. **Actually applying/writing the diff to a real file** — pre-existing A0-A4b scope boundary (§0), not something A5 adds. Approving G3 marks the run `applied: true` in the audit trail; it does not touch any file outside `profiles/subscription/*.db`.
3. **Full TUI framework** (multi-pane layout, live-refresh, cursor-addressed rendering — ink/blessed-class tooling) — Commander-decided (2026-07-21): lightweight chalk + a line-oriented prompt library only, per DESIGN §8's actual requirement ("colorized diff + y/n approval + visual distinction for escalations" — no mention of panels/real-time UI).
4. **Resuming a run interrupted mid-model-call** — a real, verified gap (§0.2 below), not fixed by this PRD; documented as a known limitation, not silently left undiscovered.
5. **Multiple simultaneous CLI sessions / concurrent runs against the same profile's on-disk DBs** — out of scope, same single-local-user posture the rest of the engine already assumes (no new locking/coordination mechanism added).
6. **`--reject-threshold` (or any other) CLI-flag override tier** — the reject-threshold resolution chain stays exactly what `runner.ts`'s own doc comment and A4b PRD §9.2 Decision 2 already establish (`config.yaml` → `SystemConfig.getDefaultRejectThreshold()` → hardcoded `2`); A5 does not invent a fourth, CLI-flag tier on top of a chain the PRD instructions explicitly said not to extend without evidence.
7. **`workflowDefId` selection** — hardcoded to the one real graph that exists, `"coder-tester-loop"` (matches the literal string every existing test already uses; `workflow-def.ts`'s `CODER_TESTER_LOOP_DEFINITION` is documentation-only, not runtime-interpreted, so there's nothing to select between yet).
8. **git commit/push automation** — DESIGN §3's sequence diagram already says "writes files to the workspace (**no automatic git commit/push**)"; A5 doesn't change that posture (and, per non-goal 2, doesn't even write files yet).

### 0.1 Correction to issue #22's shorthand: G2 is not "approved/rejected/escalate"

Issue #22's own body lists G2's decisions as "approved/rejected/escalate" (three-way). **That's not what the real code accepts.** `src/loop/gates.ts`'s `routeAfterG2()`:
```ts
export function routeAfterG2(state: LoopStateType): "draft" | "escalation" {
  if (state.g2Decision === "approved") return "draft";
  if (state.g2Decision === "escalate") return "escalation";
  throw new UnhandledGateDecisionError(GATE_TYPES.G2_SEND_TO_FIX, state.g2Decision ?? "undefined");
}
```
`"rejected"` at G2 throws `UnhandledGateDecisionError` — this is a **permanent, documented A4a decision** (PRD §2 non-goal #2, explicitly reaffirmed as "unchanged by A4b" in `gates.ts`'s own doc comment and in `runner.ts`'s `G2_RESUME_DECISIONS = ["approved", "escalate"]`). A5's G2 prompt therefore offers exactly two choices — approve (send fix back to coder) or escalate — never a third "reject" option. This PRD's §2 Goals above already reflects the corrected, code-grounded contract, not issue #22's shorthand.

### 0.2 A real, verified limitation: Ctrl+C during an in-flight model call is not resumable

`runner.ts`'s `startRun()`/`resumeRun()` only call `AuditStore.updateRunProgress()` (which is what advances `workflow_runs.current_state` away from whatever it started at) **after** `compiled.stream()` yields a chunk — i.e., after a node (`draft`/`review`/a gate) actually completes. If the CLI process is killed (Ctrl+C, crash) while a coder/tester model call is still in flight — a real `claude -p`/`codex exec` subprocess can run for minutes — `workflow_runs.current_state` is still whatever it was before that call started (`"draft"` for a brand-new run, since `startRun()`'s `insertRun()` call sets `currentState: LOOP_NODES.draft` synchronously before the graph ever runs). LangGraph's own `SqliteSaver` checkpoint is written at node boundaries too, so there is no mid-node checkpoint to resume from either. Concretely: `resumeRun()`'s `resumeDecisionsFor("draft")` returns `[]` (not a recognized pending-gate state), so any attempt to `aeloop resume <that runId>` throws `ResumeDecisionDomainMismatchError` — by design (fail loud, not corrupt state), but the run is genuinely stuck, not resumable. **This is a real gap, not fixed by A5** (fixing it would mean the Loop layer persisting/resuming mid-node state, a materially bigger change than "add a CLI"). The workaround for a user who hits this is: start a new run with the same task text. This is called out explicitly in `main.ts`'s Ctrl+C handling (a clear message, not a silent hang) and in the CLI's `--help`/README section this PRD's B9 batch adds.

By contrast: **Ctrl+C while sitting at an interactive gate prompt (waiting on human input) is fully safe** — `interrupt()` has already returned control to the caller and the checkpoint is already durably written at that point (this is exactly what `checkpoint.test.ts`'s same-process two-phase resume and `src/loop/__tests__/fixtures/cross-process-{start,resume}.mjs`'s genuinely-separate-process resume already prove for the underlying mechanism). `aeloop resume <runId>` picks this case up correctly — this is the main resume path this PRD's acceptance criteria target.

---

## 3. Answers to the five research questions (Commander's assignment, verified against real code)

1. **CLI startup input shape**: `startRun()`'s `StartRunInput` (`src/loop/runner.ts`) needs `task: string`, `profile: string`, `workflowDefId: string`, `injectedContext: ContextInjectionResult`, `rejectThreshold: number`. Of these, only `task` is a genuine user-facing CLI argument (`aeloop start "<task text>"`); `profile` is hardcoded `"subscription"` (non-goal #1); `workflowDefId` is hardcoded `"coder-tester-loop"` (non-goal #7); `injectedContext` is produced by calling the real `ContextInjector.inject(task)` (`src/context/injector.ts`) with the same task string, exactly as `src/loop.e2e.test.ts` already does; `rejectThreshold` is resolved by a small new `resolveRejectThreshold()` helper in `src/cli/assemble.ts` implementing the existing documented chain (`profileConfig.workflow?.reject_threshold` → `SystemConfig.getDefaultRejectThreshold()` → `2`) — no target-repo-path argument is required: `ClaudeCliAdapter`/`CodexCliAdapter` spawn via `spawnWithTimeout(cmd, args, { timeoutMs })` with **no `cwd` passed**, so `SpawnWithTimeoutOptions`'s documented default (`process.cwd()`) applies — the coder/tester subprocess's working directory is simply wherever the human ran `aeloop` from, the same way `git`/most CLI tools work. This PRD does not add a `--cwd`/`--repo` flag (nothing in the existing adapter code reads one, and adding one would require plumbing a new option through `ClaudeCliAdapter`/`CodexCliAdapter`, out of this increment's scope) — a user who wants the coder to operate on a specific repo runs `aeloop` from inside that repo's directory.
2. **Reusing A4b's cross-process resume**: yes, fully, via `resumeRun()` exactly as built — confirmed by `runner.ts`'s own doc comment ("gives a future A5 CLI a ready-made entry point for 'what can I resume right now'" on `getResumableRuns`) and by `src/loop.e2e.test.ts`'s escalation test already driving a full run purely through `startRun()`/`resumeRun()` in a loop keyed off `handle.interrupt?.gate`. The one gap: a **fresh CLI process** resuming an existing run has no in-memory `RunHandle` to read the pending gate's payload (diff/issues/question) from — `resumeRun()` itself only returns that payload as part of the handle it hands back *after* a decision is made, not before. §5 adds one small new `runner.ts` export, `getPendingInterrupt()`, to close this — it does nothing `runStreamAndPersist`'s internal `computeRunProgress()` doesn't already do (a `compiled.getState(cfg)` read), just exposed as a public, read-only entry point for a caller that has no live handle yet.
3. **Diff rendering source**: `CoderOutput.diff` (`src/prompt/schema.ts`, `z.string().min(1)`, "the change itself, as a unified diff or equivalent patch text") — reached via `GatePayload.diffRef` (`src/loop/types.ts`), which `gates.ts`'s `createG1Node`/`createG3Node` and `escalation.ts`'s `createEscalationNode` populate directly from `state.coderOutput?.diff`. No external diff-parsing library is used — a self-written, best-effort line-prefix colorizer (`+`→green, `-`→red, `@@`→cyan, `+++`/`---`→bold, else plain) is sufficient and honest given the field isn't guaranteed to be strict unified-diff syntax (see §0/§6.1).
4. **G2/Escalation interaction design**: see §2 Goals (G2: two-way approve/escalate, not three-way — §0.1's correction) and §6.3 (escalation's visually distinct banner treatment). Concretely: `select()` (not `confirm()`) is used at G2 (its two choices aren't semantically "yes/no") and at Escalation (three choices); `confirm()` is used at G1/G3 (genuinely binary approve/reject).
5. **Profile loader integration**: `loadProfile()` (`src/profile/loader.ts`) reads `AI_AGENT_PROFILE` (defaults `"subscription"`) and returns `{ok, profile, profileDir, configPath, config}` or a typed `ProfileNotFoundError`. `src/cli/assemble.ts` calls it once, hard-guards `result.config.profile === "subscription"` (throwing a new typed `UnsupportedProfileError` otherwise — non-goal #1), then builds `personasDir = path.join(profileDir, "personas")` for `PromptComposer`, and two new per-profile DB file paths this PRD introduces (§6.2): `path.join(profileDir, "memory.db")` (already the convention DESIGN §6 documents for `MemoryStore`) and `path.join(profileDir, "workflow.db")` (new — DESIGN §6 doesn't name this file yet; A4b's own `AuditStore`+checkpointer-share-one-file precedent, PRD §9.2 Decision 3, only ever used ad hoc temp paths in tests — this PRD is the first to need a real, permanent location for it, and picks `workflow.db` as a sibling of `memory.db`, both already covered by the repo's existing `*.db` `.gitignore` rule).

---

## 4. Spike decision: not needed

Both third-party libraries this PRD adds (`chalk@5.6.2`, `@inquirer/prompts@8.5.2`) are mature, ESM-native (this repo is `"type": "module"`, `moduleResolution: "NodeNext"` — both packages ship ESM-first, verified against their own published README/registry metadata, not recalled from memory — see §9's sources list), and their usage here is their most basic documented case (`confirm({message})`, `select({message, choices})`, `input({message})`, `chalk.green(...)`). There's no genuine integration uncertainty comparable to A4a's `codex exec` non-interactive-mode spike (an unverified, undocumented CLI behavior) or A2's deepseek liveness-probe spike (an unverified third-party API's actual behavior) — this is well-trodden, extensively-documented library usage, and the Commander's own framing of this decision ("A5 风险明显小很多,不要为了走流程而走流程") matches what the research turned up. **No spike.** The one thing genuinely worth a manual smoke check before B8's automated e2e slice is written — that `@inquirer/prompts`' real `confirm()`/`select()` render correctly in a real terminal, not just that the library's API surface matches this PRD's assumptions — is covered by this PRD's acceptance criteria (§8) as a manual verification step, not a separate spike phase.

---

## 5. `runner.ts` addition (the one Loop-layer change this PRD makes)

`src/loop/runner.ts` gains one new exported function:

```ts
/** Read-only reconstruction of a paused run's current pending-gate payload,
 * for a caller (A5's CLI) that has no in-memory RunHandle to read it from —
 * e.g. a fresh process resuming a run `startRun()`/`resumeRun()` returned a
 * handle for in a previous process. Does nothing `runStreamAndPersist`'s
 * internal `computeRunProgress()` doesn't already do (a `compiled.getState(cfg)`
 * read) — exposed here as a public, side-effect-free entry point instead of
 * duplicated in `src/cli/`, keeping "only runner.ts constructs a compiled
 * graph + reads/writes AuditStore" true for this layer too.
 */
export async function getPendingInterrupt(
  deps: StartRunDeps,
  runId: number,
): Promise<{ runId: number; threadId: string; interrupt?: RunHandle["interrupt"]; done: boolean }>
```
Implementation sketch (not final code — build batch B4 works out the exact body): look up `run = deps.audit.getRunById(runId)` (throw `AuditReadError` if missing, mirroring every other `runId`-taking function in this file); build `compiled` the same way `startRun`/`resumeRun` already do; call `computeRunProgress(compiled, { configurable: { thread_id: run.langgraphThreadId } })` and return its `interrupt`/`done` alongside `runId`/`threadId`. **Zero new writes** — this function never calls any `audit.insert*`/`updateRunProgress`, matching its "read-only" contract. Test coverage lands in the existing `src/loop/__tests__/runner.test.ts`, following that file's existing FakeAdapter-backed patterns (no new test infra needed).

This is the **only** file outside `src/cli/` this PRD touches — everything else (`gates.ts`, `escalation.ts`, `graph.ts`, `types.ts`, `audit-store.ts`, `context/*`, `harness/*`, `prompt/*`) is read, never modified, matching CONTRIBUTING.md's dependency-direction rule (CLI sits outside/above the four nested layers per DESIGN §6's target tree, so it may depend on all of them; nothing below `src/cli/` may depend on it, and this PRD doesn't create any such dependency).

---

## 6. New files (`src/cli/`)

### 6.1 `src/cli/diff-render.ts`
Pure function(s): `renderDiff(diff: string): string` — splits on `\n`, colors each line by prefix (`chalk.green` for `+`-prefixed non-`+++` lines, `chalk.red` for `-`-prefixed non-`---` lines, `chalk.cyan` for `@@`-prefixed hunk headers, `chalk.bold` for `+++`/`---` file-header lines, unchanged/plain text otherwise). Explicitly documented as **best-effort presentational coloring, not a unified-diff validator** — `CoderOutput.diff`'s schema comment ("or equivalent patch text") already tells us not to assume strict format (§0).

### 6.2 `src/cli/colors.ts`
Small chalk-based theming helpers shared by `diff-render.ts`/`gate-view.ts`: `heading()`, `ok()`/`warn()`/`danger()` semantic wrappers, and one dedicated `escalationBanner(text: string): string` (background/bold treatment — see §6.3) so "this looks different from a normal gate" is centralized in one place rather than repeated ad hoc at each call site.

### 6.3 `src/cli/gate-view.ts`
Pure functions turning a `GatePayload` (`src/loop/types.ts`) into renderable text, one per gate type:
- `renderG1(payload): string` / `renderG3(payload): string` — question + `renderDiff(payload.diffRef)`.
- `renderG2(payload): string` — question + a bulleted `payload.issues` list.
- `renderEscalation(payload): string` — **wrapped in `escalationBanner()`** (e.g. a framed `⚠ ESCALATION — reject threshold reached ⚠` header in bold-on-yellow/red, distinct from any color G1/G2/G3 ever use) + question + issues + diff. This is the concrete implementation of DESIGN §8's "visual distinction for escalations" requirement — a structurally different rendering, not merely a different single ANSI color reused from an ordinary gate.

Testable without any TTY/prompt library — pure `GatePayload → string` functions, asserted against with plain string `.includes()`/snapshot checks (ANSI codes included, since coloring genuinely matters to the row acceptance criterion "escalation renders differently").

### 6.4 `src/cli/prompter.ts`
```ts
export interface Prompter {
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T>;
  input(message: string): Promise<string>;  // free-text reason; empty string allowed
}
export class InquirerPrompter implements Prompter { /* wraps @inquirer/prompts confirm/select/input */ }
```
Production code only ever constructs `InquirerPrompter`. Tests use a `FakePrompter` (scripted answers, same "explicit fake over the real thing behind an interface" pattern this codebase already uses for `ModelAdapter`/`FakeAdapter` throughout `src/loop/__tests__/`) — this is what makes `run-loop.ts`/`main.ts` unit-testable without a real terminal, and is also what B8's hard vertical slice uses to drive a real end-to-end run non-interactively.

### 6.5 `src/cli/assemble.ts`
```ts
export interface CliDeps extends StartRunDeps { profileConfig: ProfileConfig; }
export function assembleSubscriptionDeps(env?: NodeJS.ProcessEnv): CliDeps
export function resolveRejectThreshold(profileConfig: ProfileConfig, systemConfig: SystemConfig): number
```
`assembleSubscriptionDeps()`: calls `loadProfile()`; if not `ok` → typed error; if `config.profile !== "subscription"` → new `UnsupportedProfileError` (non-goal #1's hard guard — thrown here, not left to fail confusingly deeper in the stack); otherwise wires `MemoryStore(memoryDbPath)` → `SystemConfig(store)` → `StalenessEngine(config)` → `ContextInjector(store, staleness)`, `PromptComposer(personasDir)`, `buildAdapterRegistry(config)` → `ProviderRouter(config.roles, registry)`, `createSqliteCheckpointer(workflowDbPath)`, `new AuditStore(workflowDbPath)` — the exact same real-object graph `src/loop.e2e.test.ts` already builds by hand, just centralized into one reusable function. `resolveRejectThreshold()` implements the documented three-tier chain (§2 non-goal #6) as a small pure function, independently unit-testable.

### 6.6 `src/cli/run-loop.ts`
```ts
export async function runInteractiveLoop(deps: CliDeps, prompter: Prompter, handle: RunHandle, decidedBy: string): Promise<RunHandle>
```
Body: `while (!handle.done) { render(handle.interrupt) via gate-view.ts; ask prompter for a decision shaped for handle.interrupt.gate; handle = await resumeRun(deps, handle.runId, handle.threadId, decision, decidedBy, handle.stepCounters); }` then prints a final summary (`applied`/`cancelled`). Shared by both `start` (whose initial `handle` comes straight from `startRun()`) and `resume` (whose initial `handle` is reconstructed via §5's new `getPendingInterrupt()`, itself producing a same-shaped `{runId, threadId, interrupt, done: false}` this function can consume identically to a real `RunHandle`).

### 6.7 `src/cli/main.ts` + `src/cli/bin.ts`
`main.ts`: argv parsing via Node's built-in `node:util` `parseArgs` (no new dependency for this — the project's existing ethos throughout `src/harness/cli-exec.ts` etc. is "hand-roll a small primitive over pulling in a library for something this narrow," and this repo has zero existing CLI-arg-parsing precedent to match against either way — flagged as my judgment call, §9). Three subcommands:
- `aeloop start "<task>"` → `assembleSubscriptionDeps()` + `ContextInjector.inject(task)` + `resolveRejectThreshold()` + `startRun()` + prints `Run #<id> started` immediately, then `runInteractiveLoop()`.
- `aeloop resume <runId>` → `assembleSubscriptionDeps()` + `getPendingInterrupt(deps, runId)` (errors clearly if the run is already `completed`/`cancelled`, or if `runId` doesn't exist — `AuditReadError`) + `runInteractiveLoop()`.
- `aeloop list` → `assembleSubscriptionDeps()` + `getResumableRuns(deps, "running")` + `getResumableRuns(deps, "escalated")`, printed as a plain table (id/task/currentState/updatedAt).
`decidedBy` passed into `resumeRun()`/`runInteractiveLoop()`: `os.userInfo().username` (Node built-in, no new dependency — my judgment call, §9).
A `SIGINT` handler prints the "in-flight model call is not resumable, but a paused gate is — see `aeloop list`" message from §0.2 rather than a silent hang or a raw stack trace.
`bin.ts`: a two-line shebang entry (`#!/usr/bin/env node`, then `await main(process.argv.slice(2))`), compiled to `dist/cli/bin.js`. `package.json` gains `"bin": { "aeloop": "dist/cli/bin.js" }`.

### 6.8 `src/cli/errors.ts`
Typed errors mirroring `src/loop/errors.ts`'s convention: `UnsupportedProfileError` (non-goal #1's guard), `RunNotResumableError` (a `resume <runId>` target that's already `completed`/`cancelled`, or was never a real run — distinguishes this cleanly from `AuditReadError`'s "no such runId at all").

---

## 7. Package changes

- `package.json` `dependencies`: `+ chalk@^5.6.2`, `+ @inquirer/prompts@^8.5.2` (both verified real, current, ESM-native packages — §9 sources).
- `package.json`: `+ "bin": { "aeloop": "dist/cli/bin.js" }`.
- `package.json` `files`: already includes `dist/**/*` — no change needed for the compiled CLI to ship.
- No `tsconfig.build.json`/`tsconfig.json` changes needed — `src/cli/**/*.ts` is already covered by the existing `include: ["src/**/*.ts"]`.

---

## 8. Batches (dependency-ordered — each depends on the previous)

| Batch | Files | Size | Content |
|---|---|---|---|
| B0 | `package.json`, `src/cli/errors.ts` | S | Add `chalk`/`@inquirer/prompts` deps + `bin` field; typed CLI errors |
| B1 | `src/cli/colors.ts`, `src/cli/diff-render.ts` (+ tests) | M | Chalk theming helpers + best-effort line-prefix diff colorizer |
| B2 | `src/cli/gate-view.ts` (+ tests) | M | Pure `GatePayload → string` rendering per gate, incl. escalation banner |
| B3 | `src/cli/prompter.ts` (+ tests) | M | `Prompter` interface, real `InquirerPrompter`, test `FakePrompter` |
| B4 | `src/loop/runner.ts` (+ `runner.test.ts` additions) | S | Add `getPendingInterrupt()` — the one Loop-layer change (§5) |
| B5 | `src/cli/assemble.ts` (+ tests) | L | Real dependency-graph wiring for the `subscription` profile + `resolveRejectThreshold()` + hard profile guard |
| B6 | `src/cli/run-loop.ts` (+ tests) | L | Interactive start/resume loop, `FakePrompter`+`FakeAdapter`-backed tests |
| B7 | `src/cli/main.ts`, `src/cli/bin.ts` (+ tests) | M | argv parsing (`node:util.parseArgs`), `start`/`resume`/`list` dispatch, `SIGINT` handling |
| B8 | `src/cli.e2e.test.ts` | L | Hard vertical slice: real cli-bridge fixtures + real `src/cli/main.ts` dispatch + `FakePrompter`, happy path + escalation path |
| B9 | `docs/ROADMAP.md`, `docs/PROGRESS.md`, `CHANGELOG.md`, `README.md` | S | Docs wrap-up (A5 row → done, README's "Getting started" gains an `aeloop start` example) |

---

## 9. My judgment calls (no direct code/document evidence — flagged, not mixed into "verified")

1. **`node:util.parseArgs` for argv parsing, over a library** (`commander`/`yargs`) — no existing precedent in this repo either way; chosen to minimize new dependencies given the Commander's "lightweight, no full framework" instruction extends naturally to argv parsing too, and Node's built-in is stable and sufficient for three subcommands with one positional arg each.
2. **`chalk@5.6.2` and `@inquirer/prompts@8.5.2`** as the specific libraries and major versions — verified real/current via `npm view chalk version` / `npm view @inquirer/prompts version` (registry queries run during this PRD's research) and `@inquirer/prompts`' real README (`raw.githubusercontent.com/SBoudrias/Inquirer.js/main/packages/prompts/README.md`, fetched during this PRD's research) for `confirm()`/`select()`/`input()`'s exact signatures — not recalled from training. Picking `@inquirer/prompts` specifically (over the older, less actively maintained `prompts@2.4.2`, also verified to exist) is my judgment call: it's TypeScript-native, ESM-first (matches this repo's `"type": "module"`/`NodeNext` setup with no interop shimming needed), and actively released.
3. **`workflow.db` as the new per-profile file name** for `AuditStore`+checkpointer (§3 point 5) — DESIGN §6 only names `memory.db`; this is the first increment that needs a permanent (non-temp-dir) location for the audit+checkpoint file, so this PRD has to pick a name. `workflow.db`, sibling to `memory.db` under `profiles/<profile>/`, already covered by the existing `*.db`/`.gitignore` rule.
4. **`decidedBy: os.userInfo().username`** — `resumeRun()` requires a non-empty string identifying who decided; no existing convention exists for what a human CLI user's `decidedBy` value should be (test code always uses a literal like `"test-harness"`). OS username is a reasonable, dependency-free default; flagged in case the Commander would rather prompt for a name or read it from `.env`.
5. **No `--cwd`/`--repo` flag** (§3 point 1) — could be added cheaply, but nothing in the existing adapter code plumbs a working directory through beyond the subprocess-inherited default, and adding the flag without also wiring it through `ClaudeCliAdapter`/`CodexCliAdapter`'s `spawnWithTimeout` call (which doesn't happen today) would be a flag that silently does nothing — worse than not having it. If the Commander wants this, it's a small, separable follow-up (touches `harness/adapters/*.ts`, outside this PRD's stated `src/cli/` scope).

---

## 10. Acceptance criteria

- [ ] `pnpm build && pnpm test && pnpm lint` all clean; existing 300 tests still green, plus new tests for every file in §6/§5.
- [ ] `node dist/cli/bin.js start "<task>"` (or `aeloop start "<task>"` after `npm link`/global install) runs a real coder/tester round against the real `subscription` profile and stops at a real interactive G1 prompt in a real terminal — verified by manual smoke test (not just the automated e2e slice), since a headless test can't fully prove real-terminal rendering.
- [ ] G1/G3 diff renders with real ANSI color codes present for `+`/`-`/`@@` lines (asserted in `gate-view.test.ts` via `.includes()` on the colored substrings, not just an uncolored control-character-stripped string).
- [ ] G2 offers exactly two choices (approve-fix-forward / escalate) — never a third "reject" option (regression test against `gates.ts`'s real `routeAfterG2` contract, closing the §0.1 gap).
- [ ] Escalation gate's rendered output is structurally distinguishable from an ordinary gate's (not just "uses a different chalk color than G1" — a banner/frame, asserted against directly).
- [ ] `AI_AGENT_PROFILE=apikey aeloop start "..."` fails with a clear, typed `UnsupportedProfileError` message — never a stack trace, never a silent fallback to `subscription`.
- [ ] Killing the process (SIGINT) while paused at a gate prompt, then running `aeloop resume <runId>` in a **fresh process**, continues the run correctly to completion — the concrete proof A5 reuses A4b's cross-process resume rather than reinventing it.
- [ ] `aeloop list` shows a run paused at a gate, with the correct `currentState`.
- [ ] Hard vertical slice (B8) exercises both the happy path (G1→G3→apply) and an escalation path (reject-to-threshold→`ESCALATION_ACK`→`force_pass`→G3→apply), both driven through real `main.ts` dispatch with a scripted `FakePrompter`, both against real cli-bridge fixture subprocesses (same fixture-substitution boundary as `src/loop.e2e.test.ts`).
- [ ] No changes outside `src/cli/**` except the single, additive `runner.ts` export (§5) — verified by `git diff --stat` against this PRD's stated file list at review time.
- [ ] Docs (`ROADMAP.md`/`PROGRESS.md`/`CHANGELOG.md`/`README.md`) updated per B9.
