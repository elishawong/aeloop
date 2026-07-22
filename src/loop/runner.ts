/**
 * `startRun()`/`resumeRun()` — the business-orchestration layer above
 * `graph.ts` (A4b PRD §5 "runner.ts"). This is the **only** file that
 * simultaneously holds both "graph deps" (`router`/`composer`) and "audit
 * deps" (`AuditStore`/`BaseCheckpointSaver`) — every graph node/gate under
 * `src/loop/` continues to know nothing about `AuditStore` (PRD §8's "graph
 * nodes/gates continue to maintain zero I/O purity" acceptance criterion;
 * `grep -rn
 * "better-sqlite3\|Database(" src/loop/gates.ts src/loop/escalation.ts
 * src/loop/graph.ts src/loop/nodes` must stay empty).
 *
 * **How this file attributes new audit rows to the right node/round**
 * (the mechanism PRD §5's "diff the state before/after invoke, and persist
 * whatever newly appears...into approvals/structured_claims" describes, at
 * the level of precision build
 * had to work out): `compiled.stream(input, {...cfg, streamMode:
 * "updates"})` — verified empirically against this repo's real
 * `buildLoopGraph()`/`compileLoopGraph()` output before writing this file
 * — yields one chunk per node that actually *completes* during this call,
 * shaped `{ [nodeName]: partialStateUpdate }`, plus a final `{
 * __interrupt__: [...] }` chunk when the graph pauses. This is a precise,
 * per-node-execution trace — the right mechanism for "did draft/review
 * really run again this round", not identity/content diffing of
 * `coderOutput`/`testerOutput` across two `getState()` snapshots (which
 * are freshly deserialized on every call and therefore never
 * reference-equal even when unchanged, and which can coincide in *content*
 * across rounds for a deterministic adapter — either pitfall would have
 * silently mis-attributed claims to the wrong round, or dropped them).
 * `invoke()` is never used in this file for that reason.
 *
 * **`step_ref`'s per-node counters are threaded through `RunHandle` *and*
 * rebuilt from disk on every `resumeRun()` call** (PRD §4.2: "this counter
 * only lives in runner.ts's runtime variable, it isn't persisted as part
 * of LoopState" — still
 * true, `stepCounters` itself is never persisted as its own column/table —
 * but the *authoritative starting point* for a resume is no longer only
 * whatever in-memory value the caller happens to hand back).
 *
 * **Review Round-1 D1 rework** (`docs/feature/a4b-loop/test-report.md`):
 * this used to trust the caller-supplied `stepCounters` param alone,
 * defaulting to `{}`. That was fine for a same-process resume where the
 * caller always threads the previous call's returned `stepCounters`
 * forward, but silently wrong the moment it wasn't — a resume landing in a
 * *new* process (no in-memory `RunHandle` to inherit), or simply a caller
 * that forgot to thread it — started every node's counter back at `{}`.
 * If that resume then revisited an already-visited node (e.g. a second
 * `draft` round after a G2 loop-back), the freshly-restarted counter would
 * re-mint a `step_ref` already on disk from an earlier round (`draft#1`
 * again, not `draft#2`), silently colliding.
 *
 * **Fix**: `resumeRun()` now calls `AuditStore.listStepRefsByRun(runId)`
 * and rebuilds each node's counter as the max `#n` suffix already on disk
 * for that run (`rebuildStepCounters()` below), then merges that with
 * whatever the caller supplied (`mergeStepCounters()`, element-wise max) —
 * the DB read makes a brand-new process's resume just as collision-safe as
 * a same-process one, and the merge means a caller that *does* still have
 * a fresher in-memory value (mid-flight within the same call, before this
 * round's own writes have landed on disk yet) never regresses below it.
 * `startRun()` doesn't need this — a brand-new run has no prior rows to
 * rebuild from, so its counters correctly start at `{}`.
 *
 * **Review Round-2 R2-2 addendum** (`docs/feature/a4b-loop/test-report.md`):
 * D1's disk-rebuild only works if every round actually leaves a row for
 * `AuditStore.listStepRefsByRun()` to find. A round whose `claims` array is
 * empty (legal per `prompt/schema.ts` — no `.min(1)`) used to leave *no*
 * row at all, so the D1 bug this file's header above already describes
 * could still happen via a different trigger: "no claims this round"
 * instead of "no in-memory counter this process". Fixed by writing an
 * unconditional `AuditStore.insertStepMarker()` row for every draft/review
 * round (see the claims-persistence block below), inside the same
 * transaction as that round's claims — `rebuildStepCounters()` itself
 * needed no change, it already trusts whatever `listStepRefsByRun()`
 * returns.
 */
import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { AuditStore, type WorkflowRun, type WorkflowRunProgressPatch, type WorkflowRunStatus } from "./audit-store.js";
import { AuditReadError, ResumeDecisionDomainMismatchError, RunThreadMismatchError } from "./errors.js";
import { LoopEventEmitter, type RealLoopNodeName } from "./events.js";
import { buildLoopGraph, compileLoopGraph } from "./graph.js";
import { LOOP_NODES } from "./workflow-def.js";
import type {
  EscalationResumeValue,
  GatePayload,
  GateResumeValue,
  GateType,
  LoopNodeName,
  LoopStateType,
} from "./types.js";
import type { ContextInjectionResult } from "../context/injector.js";
import type { ProviderRouter } from "../harness/provider-router.js";
import type { PromptComposer } from "../prompt/composer.js";
import { isCoderOutputChanged } from "../prompt/schema.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Graph deps (identical to `LoopGraphDeps`) plus the two audit-layer deps only this file touches. */
export interface StartRunDeps {
  router: ProviderRouter;
  composer: PromptComposer;
  audit: AuditStore;
  checkpointer: BaseCheckpointSaver;
  /**
   * Optional subscriber to this run's `LoopEvent` stream (issue #29,
   * `docs/feature/events-observability/PRD.md` §9.1 decision 1). Deliberately
   * **optional**, not required — ~64 pre-existing `startRun`/`resumeRun` call
   * sites across this codebase's own test suite construct `StartRunDeps`
   * with no `events` field, and this keeps every one of them compiling and
   * passing unmodified. When absent, `startRun()`/`resumeRun()` fall back to
   * a fresh, unlistened `new LoopEventEmitter()` — costs nothing (nobody's
   * subscribed, so `emit()` just iterates an empty listener set).
   */
  events?: LoopEventEmitter;
  /**
   * Optional (issue #45 follow-up): forwarded to `buildLoopGraph()`'s own
   * `LoopGraphDeps.schemaMaxAttempts` at every call site below
   * (`startRun`/`resumeRun`/`getPendingInterrupt`) — same "optional,
   * defaults to `SchemaValidator`'s own hardcoded fallback when absent, zero
   * behavior change for the ~64 pre-existing call sites that don't set it"
   * posture as `events` just above. Completely independent of
   * `StartRunInput.rejectThreshold` below (tester-rejection escalation
   * count, not a schema-validation attempt count) — see
   * `cli/assemble.ts`'s `resolveSchemaMaxAttempts()` for the fuller
   * separation note.
   */
  schemaMaxAttempts?: number;
}

export interface StartRunInput {
  task: string;
  profile: string;
  workflowDefId: string;
  injectedContext: ContextInjectionResult;
  /** This run's threshold snapshot — the caller (test/future CLI) is responsible for computing it per PRD §9.2 Decision 2's priority chain (config.yaml -> system_config -> hardcoded 2); `startRun` only ever receives an already-resolved number. */
  rejectThreshold: number;
}

/** `Command`'s node-union generic — every real `LOOP_NODES` value plus `"__start__"`, minus `"__end__"` (mirrors every A4a/A4b test file's identically-reasoned `RealGraphNode` alias). */
type RealGraphNode = Exclude<LoopNodeName, "__end__">;

/** What `startRun()`/`resumeRun()` hand back to their caller. */
export interface RunHandle {
  runId: number;
  threadId: string;
  /** Present exactly when this call ended with the graph paused at a gate awaiting a human decision. */
  interrupt?: { gate: GateType; payload: GatePayload };
  /** `true` once the run has reached a terminal node (`apply`/`cancel`) — nothing left to resume. */
  done: boolean;
  /** Thread this back into the next `resumeRun()` call for this same run (see file header). */
  stepCounters: Record<string, number>;
}

const GATE_NODE_NAMES: readonly string[] = [LOOP_NODES.g1, LOOP_NODES.g2, LOOP_NODES.g3, LOOP_NODES.escalation];

/**
 * Every real node name this graph can produce a `"tasks"`-mode create-shaped
 * chunk for (Zorro hardening) — `Object.values(LOOP_NODES)` is the single
 * source of truth `workflow-def.ts` already establishes, not independently
 * re-derived here. Backs `isRealLoopNodeName()` below: a `payload.name` this
 * set doesn't recognize (e.g. some internal LangGraph bookkeeping task name
 * this codebase has never seen and doesn't expect) is skipped rather than
 * blindly cast to `RealLoopNodeName` and emitted as a `node_started` event
 * naming a node that doesn't exist in this graph.
 */
const REAL_LOOP_NODE_NAMES: ReadonlySet<string> = new Set(Object.values(LOOP_NODES));

function isRealLoopNodeName(name: string): name is RealLoopNodeName {
  return REAL_LOOP_NODE_NAMES.has(name);
}

/**
 * Review Round-5 R6-B1 rework (`docs/feature/a4b-loop/test-report.md`): R5-B1
 * (below `resumeDecisionsFor()`'s history) originally lumped g1/g2/g3 into
 * one shared `GATE_RESUME_DECISIONS = ["approved","rejected","escalate"]`
 * domain — but the three gates' *real* accepted decisions, per each
 * `routeAfter*` switch in `gates.ts`, are not identical: `routeAfterG1`
 * only handles `"approved"`/`"rejected"` (its `default` throws on anything
 * else, including `"escalate"`); `routeAfterG3` is the same shape;
 * `routeAfterG2` only handles `"approved"`/`"escalate"` (its
 * `UnhandledGateDecisionError` fires on `"rejected"`, PRD §2 non-goal #2).
 * The old uniform three-value domain therefore let three no-cast-required
 * values through the R5-B1 guard that each gate's own router would still
 * reject — `{decision:"escalate"}` to a run paused at G1 or G3, and
 * `{decision:"rejected"}` to a run paused at G2 — reproducing R5-B1's exact
 * failure class (an illegitimate `approvals` row lands first, *then*
 * `routeAfterG1`/`routeAfterG3`/`routeAfterG2` throws once the graph
 * notices, leaving the checkpoint advanced past the gate while
 * `workflow_runs` never moved). Each gate below now maps to its own real
 * accepted set instead of one shared one — mirroring `gates.ts`'s
 * `routeAfterG1`/`routeAfterG2`/`routeAfterG3` switches exactly, not
 * independently re-derived.
 */
const G1_RESUME_DECISIONS: readonly string[] = ["approved", "rejected"];
const G2_RESUME_DECISIONS: readonly string[] = ["approved", "escalate"];
const G3_RESUME_DECISIONS: readonly string[] = ["approved", "rejected"];
const ESCALATION_RESUME_DECISIONS: readonly string[] = ["revise", "force_pass", "abandon"];

/**
 * Which decisions a run's *currently pending* gate (`workflow_runs.
 * current_state`, read fresh via `getRunById` before this call writes
 * anything) actually accepts. `g1`/`g3` accept only `approved`/`rejected`;
 * `g2` accepts only `approved`/`escalate` (not `rejected` — PRD §2 non-goal
 * #2, `UnhandledGateDecisionError`'s permanent guard); `escalation` accepts
 * `EscalationResumeValue`'s `revise`/`force_pass`/`abandon`; any other
 * `currentState` (`draft`/`review`/`apply`/`cancel` — not a paused gate at
 * all) accepts nothing, so `resumeDecisionsFor()` returns an empty set and
 * every `resume.decision` fails the membership check in `resumeRun()` below
 * (the guard is "does this decision belong to the set *this specific*
 * pending gate expects", not merely "gate vs escalation" or "any gate" —
 * see the Round-5 R6-B1 rework note above for why per-gate precision, not a
 * shared gate-wide domain, is what actually closes the failure class).
 */
function resumeDecisionsFor(pendingGate: string): readonly string[] {
  switch (pendingGate) {
    case LOOP_NODES.g1:
      return G1_RESUME_DECISIONS;
    case LOOP_NODES.g2:
      return G2_RESUME_DECISIONS;
    case LOOP_NODES.g3:
      return G3_RESUME_DECISIONS;
    case LOOP_NODES.escalation:
      return ESCALATION_RESUME_DECISIONS;
    default:
      return [];
  }
}

function nextStepRef(counters: Record<string, number>, node: string): string {
  const next = (counters[node] ?? 0) + 1;
  counters[node] = next;
  return `${node}#${next}`;
}

/**
 * A **read-only preview** of what `nextStepRef()` will allocate for `node`'s
 * next round — used only for `node_started`'s `stepRef` (PRD §9.4), which
 * fires *before* that round's real `nextStepRef()` call happens. Does
 * **not** mutate `counters`. Provably identical to the value `nextStepRef()`
 * allocates once that same round actually completes, because this graph's
 * execution is strictly sequential per node — no two visits to the same
 * node name are ever in flight concurrently within one
 * `runStreamAndPersist()` call, so nothing else can touch `counters[node]`
 * between this preview and the real allocation.
 */
function previewStepRef(counters: Record<string, number>, node: string): string {
  return `${node}#${(counters[node] ?? 0) + 1}`;
}

const STEP_REF_PATTERN = /^(.+)#(\d+)$/;

/**
 * Rebuilds per-node `stepCounters` from every `step_ref` already on disk
 * for this run (`AuditStore.listStepRefsByRun`) — see the file header's
 * "Review Round-1 D1 rework" note. A `step_ref` this doesn't recognize the
 * shape of is skipped, not thrown on — this is a best-effort reconstruction
 * of a counter, not a schema validator.
 */
function rebuildStepCounters(audit: AuditStore, runId: number): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const stepRef of audit.listStepRefsByRun(runId)) {
    const match = STEP_REF_PATTERN.exec(stepRef);
    if (!match) continue;
    const node = match[1];
    const n = Number(match[2]);
    if (node === undefined || !Number.isFinite(n)) continue;
    counters[node] = Math.max(counters[node] ?? 0, n);
  }
  return counters;
}

/** Element-wise max of two `stepCounters` maps — never regresses below either input (file header's D1 note). */
function mergeStepCounters(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [node, count] of Object.entries(b)) {
    merged[node] = Math.max(merged[node] ?? 0, count);
  }
  return merged;
}

/**
 * Reads the graph's *current* position via `getState()` and derives what
 * `workflow_runs`' `status`/`current_state`/`reject_count` should be right
 * now — factored out of `runStreamAndPersist`'s old single end-of-call
 * computation (PRD §5 runner.ts point 4) so it can be called after every
 * processed chunk, not just once at the very end (see Review Round-5 R6-B2
 * rework in `runStreamAndPersist`'s own doc comment for why "only once at
 * the end" was the bug this closes).
 */
async function computeRunProgress(
  compiled: ReturnType<typeof compileLoopGraph>,
  cfg: { configurable: { thread_id: string } },
): Promise<{ patch: WorkflowRunProgressPatch; interrupt?: RunHandle["interrupt"]; done: boolean }> {
  const snapshot = await compiled.getState(cfg);
  const rejectCount = snapshot.values.rejectCount;

  let currentState: string;
  let status: WorkflowRunStatus;
  let interrupt: RunHandle["interrupt"];
  const done = snapshot.next.length === 0;

  if (done) {
    // Issue #47: a third terminal outcome alongside `apply`/`cancel` — a
    // `no_change` round (`snapshot.values.noChange`) also ends the run
    // `"completed"` (nothing went wrong, there was just nothing to change),
    // but with its own `current_state: "no_change"`, distinct from the
    // `g1`/`apply` path's `current_state: "apply"` (PRD-equivalent
    // acceptance for this issue: don't reuse the `g1`/`changed` completion's
    // `current_state` value for a run that never went through `g1` at all).
    if (snapshot.values.applied) {
      currentState = LOOP_NODES.apply;
      status = "completed";
    } else if (snapshot.values.noChange) {
      currentState = LOOP_NODES.noChange;
      status = "completed";
    } else {
      currentState = LOOP_NODES.cancel;
      status = "cancelled";
    }
  } else {
    const nextNode = snapshot.next[0];
    if (nextNode === undefined) {
      throw new Error("runner: getState() reported not done, but next[] was empty");
    }
    currentState = nextNode;
    status = nextNode === LOOP_NODES.escalation ? "escalated" : "running";
    const pending = snapshot.tasks[0]?.interrupts[0];
    if (pending) {
      const payload = pending.value as GatePayload;
      interrupt = { gate: payload.gate, payload };
    }
  }

  return { patch: { status, rejectCount, currentState, updatedAt: nowIso() }, interrupt, done };
}

/**
 * Emits whichever of `gate_requested`/`run_completed`/`run_cancelled` (if
 * any) a `computeRunProgress()` result implies (issue #29 PRD §4.2 rows 5/9/
 * 10). Factored out as its own function for readability/naming, not
 * because it's shared across multiple call sites — Zorro R2/R3: this is
 * called from exactly **one** place in `runStreamAndPersistCore()` (the
 * in-loop `mode === "updates"` iteration, gated on
 * `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` — see that call
 * site's own comment). The zero-chunk fallback branch (`if
 * (!latestProgress)`) deliberately does **not** call this (R2 fix) — it
 * only syncs `computeRunProgress`/`updateRunProgress`, since re-emitting
 * from that branch could report a gate/terminal-state that an *earlier*
 * call already reported, breaking the "exactly once per gate/terminal-state
 * across the whole run" contract those three event types promise. Mirrors
 * `computeRunProgress()`'s own mutually-exclusive `interrupt` vs `done`
 * branches (types.ts/runner.ts: a call site is never both paused *and*
 * done), so at most one event fires per call to this function.
 */
function emitProgressEvents(
  emitter: LoopEventEmitter,
  runId: number,
  threadId: string,
  progress: { patch: WorkflowRunProgressPatch; interrupt?: RunHandle["interrupt"]; done: boolean },
): void {
  if (progress.interrupt) {
    emitter.emit({
      type: "gate_requested",
      runId,
      threadId,
      ts: nowIso(),
      gate: progress.interrupt.gate,
      payload: progress.interrupt.payload,
    });
    return;
  }
  if (progress.done) {
    const currentState = progress.patch.currentState ?? "";
    if (progress.patch.status === "completed") {
      emitter.emit({ type: "run_completed", runId, threadId, ts: nowIso(), currentState });
    } else if (progress.patch.status === "cancelled") {
      emitter.emit({ type: "run_cancelled", runId, threadId, ts: nowIso(), currentState });
    }
  }
}

/**
 * Shared body of `startRun()`/`resumeRun()`: drive one `compiled.stream()`
 * call to its next pause/completion, persisting every new claim/approval
 * row as its owning node's chunk arrives, then read the graph's resulting
 * position via one `getState()` call to compute `workflow_runs`'
 * `status`/`current_state`/`reject_count` (PRD §5 runner.ts point 4).
 *
 * **Review Round-5 R6-B2 rework** (`docs/feature/a4b-loop/test-report.md`):
 * `workflow_runs`' `status`/`current_state` used to be synced from
 * `computeRunProgress()` (née this function's own inline tail) exactly
 * once, *after* the `for await` loop below had fully drained the stream —
 * meaning after *every* node this call was going to run had already
 * finished. `structured_claims`/`approvals` rows, by contrast, are written
 * incrementally, per chunk, as each node actually completes. A node that
 * throws mid-execution (a real adapter failure — e.g. the tester adapter
 * being unavailable — needs no illegal input and no concurrency) makes the
 * `for await` loop itself throw, propagating straight out of this function
 * and skipping the trailing sync entirely. LangGraph's own checkpoint, in
 * contrast, is persisted incrementally as each node completes — so a claim/
 * approval already landed (and the checkpoint already advanced past the
 * node that produced it) while `workflow_runs.current_state` stayed
 * wherever it was *before* this call started, a permanent split between
 * the checkpoint (the graph's real position) and the business ledger this
 * product's audit trail is supposed to make legible. Manual reproduction:
 * G1 approve succeeds (an `approvals` row lands, checkpoint
 * advances past G1 into `review`), the tester adapter throws inside
 * `review` before that node can produce a chunk — `approvals` shows
 * `g1#1/approved`, the checkpoint's `next` is `["review"]`, but
 * `workflow_runs` was still reading `current_state="g1"` forever, because
 * nothing had told it otherwise. Fixed by calling `computeRunProgress()`
 * (and writing its patch via `audit.updateRunProgress`) after *every*
 * chunk this loop finishes processing, not only once after the loop ends —
 * so if a later node throws before yielding its own chunk, `workflow_runs`
 * already reflects the last chunk that *did* land, matching the
 * checkpoint's real position instead of lagging behind it. The loop's
 * final iteration already covers the "stream completed normally" case, so
 * nothing calls `computeRunProgress()` a second time for that path; the
 * only case needing an explicit extra call is a stream that yields zero
 * chunks at all (see below).
 */
type ResumeCommand = InstanceType<typeof Command<GateResumeValue | EscalationResumeValue, Record<string, unknown>, RealGraphNode>>;

/**
 * A `reason` string for `run_failed`. **Zorro R2**: the first cut of this
 * function (`if (error instanceof Error) return error.message;` *outside*
 * any `try`, only the `String(error)` fallback branch wrapped) claimed in
 * this very doc comment to "never throw itself" — false: a real `Error`
 * instance whose own `.message` accessor throws (a getter that throws, or a
 * `Proxy` wrapping one) would make `error.message` throw right here, still
 * outside any `try`, reproducing the exact "the original `error` gets lost"
 * failure mode this function exists to prevent (verified: a dedicated test
 * using `Object.create(Error.prototype)` + a throwing `message` getter
 * failed against that version, confirming the gap was real, not
 * theoretical). Both the `instanceof` check *and* the `.message` access are
 * now inside the same `try` as the `String(error)` fallback, so **every**
 * branch of this function is covered — it now actually is exception-free no
 * matter how badly-behaved `error` is, matching what this comment claims.
 */
function safeErrorReason(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "<error could not be converted to a string>";
  }
}

/**
 * Issue #29 PRD §4.2 row 11 (`run_failed`) / §9.7: a thin wrapper around
 * `runStreamAndPersistCore()` (the function this doc comment used to sit
 * directly on, unchanged below) that exists **only** to emit `run_failed`
 * on any throw, then rethrow the exact same `error` value unchanged —
 * preserving this file's pre-existing "propagates straight out of this
 * function" contract verbatim (the R6-B2 doc comment on
 * `runStreamAndPersistCore` below, and its own test, both still describe
 * real, current behavior). Implemented as a wrapper around the untouched
 * original function body, rather than a `try` inserted into the middle of
 * it, so that not one line of the existing, already-reviewed
 * chunk-processing logic needed to be re-indented or otherwise touched to
 * add this — lower diff risk for a change this file's own history (R5/R6
 * rounds) shows is easy to get subtly wrong.
 *
 * **`try { emit(...) } finally { throw error; }`, not a plain sequential
 * `emit(...); throw error;`** (Zorro's fix): if `emitter.emit()` itself were
 * ever to throw for some reason `LoopEventEmitter`'s own isolation didn't
 * anticipate, a bare sequential `throw error` right after it would never be
 * reached — that new, unrelated exception would propagate instead, silently
 * replacing the real failure this function is supposed to surface. A `throw`
 * inside a `finally` block runs unconditionally (whether or not the `try`
 * itself threw) and — per JS semantics — *supersedes* whatever the `try`
 * block was doing, so `error` (the original failure) is what this function
 * always rethrows, no matter what happens while emitting `run_failed`.
 *
 * **Not exported** (Zorro R3): an earlier round of this fix briefly
 * exported this function so its zero-chunk fallback branch (unreachable
 * through `startRun()`/`resumeRun()`'s own public surface) could be tested
 * directly. That export was itself a real risk, not just an unused escape
 * hatch — this function has **none** of `resumeRun()`'s own guards
 * (`RunThreadMismatchError`'s runId↔threadId binding check, R5-B1/R6-B1's
 * per-gate resume-decision domain checks all live in `resumeRun()`, called
 * *before* this function, never inside it) — exporting it handed any
 * caller a primitive that bypasses three rounds of hardening against
 * exactly the kind of runId/threadId mismatch those guards exist to catch,
 * a `// test-only` doc comment notwithstanding (a compiled `.d.ts` doesn't
 * carry doc comments as an enforcement boundary). The zero-chunk branch is
 * now tested via the public API + a `CompiledStateGraph.prototype.stream`
 * spy instead (`runner.test.ts`) — no internal export needed. (Spying on
 * `CompiledStateGraph.prototype`, not `Pregel.prototype` which actually
 * defines `.stream()`: `Pregel` is a `.d.ts`-only type surface of
 * `@langchain/langgraph`, not a real runtime export of that package's own
 * `dist/index.js` — `CompiledStateGraph` is, so the test shadows `.stream()`
 * there instead; see `runner.test.ts`'s own comment on that spy for the
 * full explanation.)
 */
async function runStreamAndPersist(
  compiled: ReturnType<typeof compileLoopGraph>,
  input: LoopStateType | ResumeCommand,
  cfg: { configurable: { thread_id: string } },
  audit: AuditStore,
  runId: number,
  decidedBy: string | undefined,
  stepCountersIn: Record<string, number>,
  emitter: LoopEventEmitter,
): Promise<{ interrupt?: RunHandle["interrupt"]; done: boolean; stepCounters: Record<string, number> }> {
  try {
    return await runStreamAndPersistCore(compiled, input, cfg, audit, runId, decidedBy, stepCountersIn, emitter);
  } catch (error) {
    try {
      emitter.emit({
        type: "run_failed",
        runId,
        threadId: cfg.configurable.thread_id,
        ts: nowIso(),
        reason: safeErrorReason(error),
      });
    } finally {
      throw error;
    }
  }
}

async function runStreamAndPersistCore(
  compiled: ReturnType<typeof compileLoopGraph>,
  input: LoopStateType | ResumeCommand,
  cfg: { configurable: { thread_id: string } },
  audit: AuditStore,
  runId: number,
  decidedBy: string | undefined,
  stepCountersIn: Record<string, number>,
  emitter: LoopEventEmitter,
): Promise<{ interrupt?: RunHandle["interrupt"]; done: boolean; stepCounters: Record<string, number> }> {
  const stepCounters = { ...stepCountersIn };
  const threadId = cfg.configurable.thread_id;

  // Baseline for `diffRef` sourcing on approval rows written *this* call —
  // a gate's own decision-completion chunk carries no diff, only the
  // coder/tester chunk that ran earlier (possibly in a *previous* call, for
  // any gate but g1) does. `getState()` here is a fresh, on-disk read, safe
  // to call from a brand-new process (not a carried-over in-memory
  // reference) — the same "resume is driven by what's on disk" property
  // `checkpoint.test.ts` proves for the graph itself.
  const prior = await compiled.getState(cfg);
  let latestCoderOutput = prior.values.coderOutput;

  // Issue #29 PRD §4.1 (spike-verified,
  // `docs/feature/events-observability/spike-node-start.md`): `"tasks"` is
  // added alongside the pre-existing `"updates"` mode solely to source
  // `node_started` — a real pre-execution signal LangGraph's own
  // `PregelLoop.tick()` emits before `PregelRunner.tick()` ever invokes a
  // node body (zero change to any node body required, `gates.ts`/
  // `nodes/*.ts` zero-I/O-purity invariant untouched). Every existing
  // `"updates"`-mode payload shape/handling below is byte-for-byte
  // unchanged from before this mode was added — it just now lives behind
  // an explicit `mode === "updates"` dispatch instead of being the only
  // thing this stream ever yielded.
  const stream = await compiled.stream(input, { ...cfg, streamMode: ["updates", "tasks"] as const });

  // R6-B2: the last `computeRunProgress()` result actually written to
  // `workflow_runs` this call — populated inside the loop below (once per
  // processed chunk) and used for this function's return value, so the
  // return value and the last DB write it produced always agree.
  let latestProgress: { interrupt?: RunHandle["interrupt"]; done: boolean } | undefined;

  for await (const [mode, payload] of stream) {
    if (mode === "tasks") {
      // Issue #29 PRD §4.1/§5: only the create-shaped payload ("input" in
      // payload) is used — it's the one LangGraph emits *before*
      // `PregelRunner.tick()` invokes the node body (spike-verified). The
      // result-shaped payload ("result" in payload) is ignored: "updates"
      // mode below already covers node completion with equal-or-richer data.
      if ("input" in payload && isRealLoopNodeName(payload.name)) {
        const node = payload.name;
        const stepRef =
          node === LOOP_NODES.apply || node === LOOP_NODES.cancel ? undefined : previewStepRef(stepCounters, node);
        emitter.emit({ type: "node_started", runId, threadId, ts: nowIso(), node, stepRef });
      }
      // No computeRunProgress()/updateRunProgress() here — PRD §9.6: gating
      // that call to "updates" iterations only keeps its call cadence
      // identical to before "tasks" mode was added (regression-tested by
      // runner.test.ts's updateRunProgress call-count assertion).
      continue;
    }

    // mode === "updates": `payload` is byte-for-byte the same shape this
    // function consumed as its bare `chunk` before "tasks" mode was added
    // (spike-verified) — everything below is unchanged persistence logic,
    // just re-nested one level under this dispatch, plus new emit() calls
    // dropped alongside the existing audit writes (PRD §9.2 decision 2:
    // additive, not a replacement).
    //
    // Zorro B1 fix: `computeRunProgress()`/`getState()` below reflects
    // whatever the graph's *actual current* position is at the moment it's
    // called — not necessarily "the position implied by the chunk this
    // iteration just processed". LangGraph runs ahead of this consumer's
    // own iteration pace (the same "tasks" CREATE/RESULT interleaving the
    // spike documented for `node_started`'s honest timing caveat applies
    // here too), so a `getState()` call issued while processing an *earlier*
    // chunk (e.g. `g1`'s own decision chunk) can already reflect a *later*
    // gate's interrupt (e.g. `g3`, several nodes ahead) having *already*
    // paused internally — `gate_requested`/`run_completed`/`run_cancelled`
    // must NOT be derived from every `computeRunProgress()` call as a
    // result (that reproduced both a premature emission — before that
    // gate's own `node_started` — and a duplicate one, once per chunk this
    // call happened to still see the same already-reached interrupt).
    // `interruptSeenThisChunk`/`terminalNodeSeenThisChunk` bind the
    // event emission to the one chunk that's *actually, causally* the
    // interrupt/terminal signal — `computeRunProgress()`/
    // `updateRunProgress()` themselves still run unconditionally every
    // "updates" iteration, unchanged (R6-B2's own invariant + PRD §9.6's
    // write-cadence guarantee both depend on that never changing).
    let interruptSeenThisChunk = false;
    let terminalNodeSeenThisChunk: "apply" | "cancel" | "no_change" | undefined;

    for (const [nodeName, rawUpdate] of Object.entries(payload)) {
      if (nodeName === "__interrupt__") {
        interruptSeenThisChunk = true;
        continue; // position after pausing is read via getState() below, not this key.
      }
      const update = rawUpdate as Partial<LoopStateType>;

      if (nodeName === LOOP_NODES.draft) {
        if (update.coderOutput !== undefined) latestCoderOutput = update.coderOutput;
        const stepRef = nextStepRef(stepCounters, LOOP_NODES.draft);
        emitter.emit({ type: "node_completed", runId, threadId, ts: nowIso(), node: LOOP_NODES.draft, stepRef });
        if (update.coderOutput && update.coderResult) {
          const coderOutput = update.coderOutput;
          const coderResult = update.coderResult;
          // Review Round-1 B3 (docs/feature/a4b-loop/test-report.md): a
          // multi-claim round is one logical audit event — PRD §4.2/§5's
          // `runInTransaction` exists precisely to make "insert N claims for
          // this round" atomic, so a mid-group insert failure never leaves
          // half the round's claims on disk.
          audit.runInTransaction(() => {
            // Review Round-2 R2-2 (docs/feature/a4b-loop/test-report.md):
            // write this round's step marker *unconditionally*, before the
            // claims loop below — `coderOutput.claims` has no `.min(1)`
            // (prompt/schema.ts), so a real coder can legally return zero
            // claims, which would otherwise leave nothing on disk for this
            // stepRef at all (the claims loop below simply wouldn't run).
            // Same transaction as the claims it's paired with, so the
            // marker and its round's claims commit/roll back together.
            audit.insertStepMarker({ runId, stepRef, node: LOOP_NODES.draft, actor: "coder", claimCount: coderOutput.claims.length });
            for (const claim of coderOutput.claims) {
              audit.insertClaim({
                runId,
                stepRef,
                actor: "coder",
                claimText: claim.claimText,
                confidence: claim.confidence,
                sourceRef: claim.sourceRef ?? null,
                verifiedBy: claim.verifiedBy ?? null,
                toolExecChecked: coderResult.toolExecChecked ?? null,
                modelUsed: coderResult.model,
                providerUsed: coderResult.provider,
              });
            }
          });
          emitter.emit({
            type: "agent_completed",
            runId,
            threadId,
            ts: nowIso(),
            node: LOOP_NODES.draft,
            stepRef,
            actor: "coder",
            claimCount: coderOutput.claims.length,
            provider: coderResult.provider,
            model: coderResult.model,
            ...(coderResult.usage === undefined ? {} : { usage: coderResult.usage }),
            ...(coderResult.latencyMs === undefined ? {} : { latencyMs: coderResult.latencyMs }),
            outcome: coderOutput.status,
            ...(coderOutput.status === "no_change" ? { noChangeReason: coderOutput.reason, noChangeEvidence: coderOutput.evidence } : {}),
            // Issue #81 batch1: the same `coderOutput.claims` the loop above
            // just persisted to `structured_claims` — carried on the event
            // too, so EvidenceBundleBuilder (batch2) can project it.
            claims: coderOutput.claims,
            ...(coderResult.toolExecChecked === undefined ? {} : { toolExecChecked: coderResult.toolExecChecked }),
          });
        }
      } else if (nodeName === LOOP_NODES.review) {
        const stepRef = nextStepRef(stepCounters, LOOP_NODES.review);
        emitter.emit({ type: "node_completed", runId, threadId, ts: nowIso(), node: LOOP_NODES.review, stepRef });
        if (update.testerOutput && update.testerResult) {
          const testerOutput = update.testerOutput;
          const testerResult = update.testerResult;
          // Same B3 atomicity as the draft branch above.
          audit.runInTransaction(() => {
            // Same R2-2 zero-claim marker as the draft branch above.
            audit.insertStepMarker({ runId, stepRef, node: LOOP_NODES.review, actor: "tester", claimCount: testerOutput.claims.length });
            for (const claim of testerOutput.claims) {
              audit.insertClaim({
                runId,
                stepRef,
                actor: "tester",
                claimText: claim.claimText,
                confidence: claim.confidence,
                sourceRef: claim.sourceRef ?? null,
                verifiedBy: claim.verifiedBy ?? null,
                toolExecChecked: testerResult.toolExecChecked ?? null,
                modelUsed: testerResult.model,
                providerUsed: testerResult.provider,
              });
            }
          });
          emitter.emit({
            type: "agent_completed",
            runId,
            threadId,
            ts: nowIso(),
            node: LOOP_NODES.review,
            stepRef,
            actor: "tester",
            claimCount: testerOutput.claims.length,
            provider: testerResult.provider,
            model: testerResult.model,
            ...(testerResult.usage === undefined ? {} : { usage: testerResult.usage }),
            ...(testerResult.latencyMs === undefined ? {} : { latencyMs: testerResult.latencyMs }),
            // Issue #81 batch1: same `testerOutput.claims`/`.verdict` the
            // loop above just persisted to `structured_claims` — carried on
            // the event too, so EvidenceBundleBuilder (batch2) can project it.
            claims: testerOutput.claims,
            verdict: testerOutput.verdict,
            ...(testerResult.toolExecChecked === undefined ? {} : { toolExecChecked: testerResult.toolExecChecked }),
          });
          // Issue #29 PRD §4.2 rows 7/8 — same guard/data this branch
          // already has in scope, no new read needed. `update.rejectCount`
          // is always present on a real `review`-node partial update
          // (nodes/tester.ts always returns it, reject or pass), the `??`
          // fallback only guards a caller that bypassed that at runtime.
          if (testerOutput.verdict === "reject") {
            const rejectCount = update.rejectCount ?? prior.values.rejectCount;
            const rejectThreshold = prior.values.rejectThreshold;
            emitter.emit({ type: "tester_rejected", runId, threadId, ts: nowIso(), rejectCount, rejectThreshold });
            if (rejectCount >= rejectThreshold) {
              emitter.emit({ type: "escalation_triggered", runId, threadId, ts: nowIso(), rejectCount });
            }
          }
        }
      } else if (GATE_NODE_NAMES.includes(nodeName)) {
        const entries = update.gateLog ?? [];
        // Backstop only — `resumeRun()` (R2-5, see its own doc comment)
        // already checks `typeof decidedBy !== "string"` before this
        // function is ever called, so this branch is unreachable from that
        // call site. Kept here because `startRun()` also calls this shared
        // helper (legitimately, with `decidedBy: undefined` — its first
        // stream call can never complete a gate) and any future direct
        // caller of this un-exported helper gets the same protection.
        //
        // Review Round-3 R3-2 (docs/feature/a4b-loop/test-report.md): this
        // used to check only `decidedBy === undefined`, which a caller
        // bypassing this function's `string | undefined` type at runtime
        // (e.g. `null as unknown as string`) could slip past — the graph
        // would then advance and only fail later, loudly but too late, at
        // `decided_by TEXT NOT NULL` (audit-store.ts). `typeof decidedBy !==
        // "string"` catches `null`/any other non-string value the same way
        // it already caught `undefined`.
        if (entries.length > 0 && typeof decidedBy !== "string") {
          throw new Error(
            `runner: gate node "${nodeName}" produced a decision (${JSON.stringify(entries[0]?.decision)}) but no decidedBy was supplied to this call`,
          );
        }
        // Same B3 atomicity — a gate node can in principle produce more than
        // one gateLog entry in a single chunk; the group of approval rows
        // for this chunk is one transaction, not N independent autocommits.
        // `decidedBy!`: the guard above already threw if this weren't a
        // string while entries is non-empty (the only case this closure
        // actually runs the loop body). `gateStepRefs` mirrors `entries`
        // index-for-index so the post-commit emit loop below can reuse the
        // exact same `stepRef` each `approvals` row was written with,
        // instead of re-deriving/re-allocating a second one (PRD §4.2 row
        // 3's "same value agent_completed/gate_decided use for that round").
        const gateStepRefs: string[] = [];
        audit.runInTransaction(() => {
          for (const entry of entries) {
            const stepRef = nextStepRef(stepCounters, nodeName);
            gateStepRefs.push(stepRef);
            audit.insertApproval({
              runId,
              gateType: entry.gate,
              stepRef,
              diffRef: latestCoderOutput && isCoderOutputChanged(latestCoderOutput) ? latestCoderOutput.diff : null,
              reasoningText: entry.reasoningText ?? null,
              decision: entry.decision,
              decidedBy: decidedBy!,
              decidedAt: entry.decidedAt, // Review Round-1 M2: the gate's real decision moment, not the DB-write moment.
            });
          }
        });
        // Emitted *after* the transaction commits, not inside its closure
        // (PRD §9.3) — a listener's side effect should never run
        // interleaved with an open SQLite transaction it has no
        // relationship to.
        entries.forEach((entry, i) => {
          const stepRef = gateStepRefs[i];
          emitter.emit({
            type: "node_completed",
            runId,
            threadId,
            ts: nowIso(),
            node: nodeName as RealLoopNodeName,
            stepRef,
          });
          emitter.emit({
            type: "gate_decided",
            runId,
            threadId,
            ts: nowIso(),
            gate: entry.gate,
            decision: entry.decision,
            decidedBy: decidedBy!,
          });
        });
      } else if (nodeName === LOOP_NODES.apply || nodeName === LOOP_NODES.cancel || nodeName === LOOP_NODES.noChange) {
        // Issue #29 PRD §4.2 row 3 — these terminal nodes had no per-chunk
        // handling at all before this event system (nothing to persist for
        // them beyond what `computeRunProgress()` below already computes);
        // `node_completed` is the only new thing this branch does. No
        // `stepRef` — `apply`/`cancel`/`noChange` (issue #47 adds the third)
        // have no counter concept anywhere else in this codebase (PRD §9.4).
        emitter.emit({
          type: "node_completed",
          runId,
          threadId,
          ts: nowIso(),
          node: nodeName as RealLoopNodeName,
          stepRef: undefined,
        });
        // Zorro B1 fix: this chunk is the causal terminal-node signal —
        // `run_completed`/`run_cancelled` below is bound to it, not to every
        // `computeRunProgress()` call this function happens to make.
        terminalNodeSeenThisChunk = nodeName;
      }
    }

    // Review Round-5 R6-B2 (see this function's doc comment): sync
    // `workflow_runs` to the graph's real position after *every* chunk this
    // loop finishes processing — not only once after the whole stream
    // drains — so a later node throwing before it can yield its own chunk
    // (a plain adapter failure, no illegal input or concurrency needed)
    // leaves `workflow_runs` matching the last chunk that *did* land,
    // instead of stuck wherever it was before this call started. Unchanged
    // by the Zorro B1 fix below — `computeRunProgress()`/`updateRunProgress()`
    // still run on every "updates" iteration, exactly as before.
    const progress = await computeRunProgress(compiled, cfg);
    audit.updateRunProgress(runId, progress.patch);
    latestProgress = { interrupt: progress.interrupt, done: progress.done };
    // Zorro B1 fix: only emit gate_requested/run_completed/run_cancelled when
    // *this* chunk was actually the interrupt/terminal-node signal — not on
    // every processed chunk (see the long comment above `interruptSeenThisChunk`'s
    // declaration for why "computeRunProgress() says so" alone isn't safe to
    // act on here, unlike `updateRunProgress()`'s own write, which is fine to
    // repeat/overwrite idempotently on every chunk).
    if (interruptSeenThisChunk || terminalNodeSeenThisChunk) {
      emitProgressEvents(emitter, runId, threadId, progress);
    }
  }

  if (!latestProgress) {
    // The stream yielded zero chunks — nothing above ran, so nothing has
    // synced `workflow_runs` yet this call. Still need a real getState()
    // read so the caller's returned `interrupt`/`done` reflect reality
    // (mirrors this function's pre-R6-B2 behavior of always calling
    // updateRunProgress exactly once, just now via the shared helper).
    //
    // Zorro R2: deliberately does **not** call `emitProgressEvents()` here.
    // A zero-chunk call means nothing advanced *this* call, but whatever
    // `computeRunProgress()` reports is wherever the run *already was*
    // before this call started — which, if that's a paused gate or a
    // terminal state, was already reported by whichever *earlier* call
    // first reached it. Re-emitting here would violate "exactly once per
    // gate/terminal-state across the whole run," not just within this one
    // call. There is currently no valid public-API path that reaches this
    // branch while already paused/terminal (every gate's resume-decision
    // domain guard + every valid resume produces at least one chunk), so
    // this isn't observably reachable today — but nothing about this
    // function's own structure *proves* that, so this branch stays
    // correct-by-construction (sync progress only, never re-emit) rather
    // than relying on "nothing currently calls it that way."
    const progress = await computeRunProgress(compiled, cfg);
    audit.updateRunProgress(runId, progress.patch);
    latestProgress = { interrupt: progress.interrupt, done: progress.done };
  }

  return { interrupt: latestProgress.interrupt, done: latestProgress.done, stepCounters };
}

/**
 * Starts a brand-new run: generates a `threadId`, inserts the
 * `workflow_runs` row, and drives the graph from a fresh `LoopState` to its
 * first pause (always G1, per `graph.ts`'s topology — `draft -> g1` is an
 * unconditional edge, so the very first `compiled.stream()` call always
 * ends at G1's interrupt, never completes a gate decision itself; that's
 * why `runStreamAndPersist` is called here with `decidedBy: undefined` —
 * this call can never hit the "gate node produced a decision" branch).
 */
export async function startRun(deps: StartRunDeps, input: StartRunInput): Promise<RunHandle> {
  const threadId = randomUUID();
  // Issue #36 slice 3: the `workflow_runs` insert and this run's
  // `context_omissions` rows (one per `input.injectedContext.omitted`
  // entry, if any) go inside a single `AuditStore.runInTransaction` call —
  // same B3-style atomicity `step_markers`/its claims already use — so a
  // telemetry-write failure rolls back the run row too, instead of leaving
  // a `workflow_runs` row with no matching omission trail. When
  // `input.injectedContext.omitted` is absent or empty, no `context_omissions`
  // rows are written and behavior is unchanged from before this slice.
  const run: WorkflowRun = deps.audit.runInTransaction(() => {
    const insertedRun = deps.audit.insertRun({
      task: input.task,
      workflowDefId: input.workflowDefId,
      profile: input.profile,
      status: "running",
      rejectCount: 0,
      rejectThreshold: input.rejectThreshold,
      currentState: LOOP_NODES.draft,
      langgraphThreadId: threadId,
    });
    for (const entry of input.injectedContext.omitted ?? []) {
      deps.audit.insertContextOmission({
        runId: insertedRun.id,
        memoryId: entry.id,
        memoryType: entry.type,
        title: entry.title,
        reason: entry.reason,
      });
    }
    return insertedRun;
  });

  // Issue #29 PRD §9.1 decision 1: `deps.events` is optional, defaulted to a
  // fresh, unlistened emitter when absent — costs nothing (nobody's
  // subscribed). `run_started` is the one event this file emits outside
  // `runStreamAndPersist()` — it fires exactly once, right after the
  // `workflow_runs` row exists (so `runId` is known) and before the graph is
  // ever driven, so it's always the first event a subscriber sees for this run.
  const emitter = deps.events ?? new LoopEventEmitter();
  emitter.emit({
    type: "run_started",
    runId: run.id,
    threadId,
    ts: nowIso(),
    task: input.task,
    profile: input.profile,
    workflowDefId: input.workflowDefId,
    rejectThreshold: input.rejectThreshold,
    // Issue #36 slice 2: only set when `input.injectedContext.omitted` is
    // itself present and non-empty — mirrors `ContextInjectionResult`'s own
    // "absent means nothing to report" convention rather than forcing an
    // empty array on every run (which would break existing subscribers'
    // `toMatchObject`-style assertions that don't expect this field at all).
    ...(input.injectedContext.omitted && input.injectedContext.omitted.length > 0
      ? { contextOmitted: input.injectedContext.omitted.map((entry) => ({ id: entry.id, type: entry.type, title: entry.title, reason: entry.reason })) }
      : {}),
  });

  const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer, schemaMaxAttempts: deps.schemaMaxAttempts }), deps.checkpointer);
  const cfg = { configurable: { thread_id: threadId } };

  const initial: LoopStateType = {
    task: input.task,
    feedback: undefined,
    injectedContext: input.injectedContext,
    coderOutput: undefined,
    coderResult: undefined,
    testerOutput: undefined,
    testerResult: undefined,
    rejectCount: 0,
    g1Decision: undefined,
    g2Decision: undefined,
    g3Decision: undefined,
    gateLog: [],
    applied: false,
    rejectThreshold: input.rejectThreshold,
    escalationDecision: undefined,
    cancelled: false,
    noChange: false,
  };

  const result = await runStreamAndPersist(compiled, initial, cfg, deps.audit, run.id, undefined, {}, emitter);
  return { runId: run.id, threadId, interrupt: result.interrupt, done: result.done, stepCounters: result.stepCounters };
}

/**
 * Resumes an existing run. **Requires nothing but `runId`/`threadId` plus a
 * freshly-constructed `checkpointer` pointed at the same on-disk file** —
 * no in-memory reference to anything `startRun()` (or a previous
 * `resumeRun()`) produced is read here (`stepCounters` is accepted as a
 * plain, caller-supplied value, not implicitly captured from a closure).
 * This is what "production-grade cross-process resume" concretely means
 * for this file (A4b PRD §5 runner.ts: "this function doesn't require the
 * caller to hold any in-memory object reference from startRun()").
 *
 * **Review Round-1 B2 rework** (`docs/feature/a4b-loop/test-report.md`):
 * `runId` and `threadId` used to be trusted as an already-matching pair —
 * `threadId` drove the graph, `runId` alone drove every audit write, with
 * nothing checking the two actually named the same run. A caller that
 * mismatched them (e.g. run A's `runId` with run B's `threadId`) would
 * silently advance B's graph while attributing B's claims/approvals/
 * `reject_count` to A's audit trail. This now looks up `runId`'s real
 * `langgraphThreadId` via `AuditStore.getRunById` *before* touching the
 * graph or writing anything, and throws `RunThreadMismatchError` on any
 * mismatch (fail loud, zero writes) rather than ever reaching a single
 * `audit.insert*` call with an unverified pair.
 *
 * **Review Round-2 R2-5 rework** (`docs/feature/a4b-loop/test-report.md`):
 * a `decidedBy` guard used to live only inside `runStreamAndPersist`'s
 * per-chunk loop (still there below, as a backstop for any other caller of
 * that shared helper) — which only fires *after* `compiled.stream()` has
 * already advanced the graph/checkpoint past whichever gate produced this
 * call's decision. `decidedBy: string` is non-optional in this function's
 * own type signature, so every real TS call site is statically required to
 * supply one; the only way to reach a runtime-invalid value here at all is
 * a caller bypassing that type at runtime. But *if* that happens, the old
 * ordering meant the checkpoint had already moved on while
 * `workflow_runs`/`approvals` never got the corresponding write — an
 * inconsistent state, not just a thrown error. Checked here first, before
 * `getRunById`/the graph/anything else, so a runtime-invalid `decidedBy`
 * now fails loud before touching the checkpoint or the DB at all.
 *
 * **Review Round-3 R3-2 rework** (`docs/feature/a4b-loop/test-report.md`):
 * this guard (and its `runStreamAndPersist` backstop) originally checked
 * only `decidedBy === undefined`, which caught a bypassing caller that
 * passed `undefined` but not one that passed `null` (`null !== undefined`
 * sails past both checks, the graph advances, and the write only fails
 * later — loudly, but after the checkpoint already moved — at
 * `decided_by TEXT NOT NULL`, audit-store.ts). Both guards now check
 * `typeof decidedBy !== "string"`, which rejects `null` and any other
 * non-string value the same way they already rejected `undefined`.
 *
 * **Review Round-4 R5-B1 rework** (`docs/feature/a4b-loop/test-report.md`):
 * `resume`'s parameter type, `GateResumeValue | EscalationResumeValue`, is
 * an **undiscriminated** union — nothing here used to check that the
 * `resume` value's decision domain actually matched the gate the run was
 * paused at. A caller could hand a `{decision: "force_pass"}`
 * (`EscalationResumeValue`, no cast required — TS-legal on its own) to a
 * run paused at **G1**, which only understands `GateResumeValue`. That
 * used to insert an illegitimate `approvals` row first, then fail loud
 * only once `routeAfterG1`'s own `default: throw` ran — by which point the
 * checkpoint had already advanced past G1 while `workflow_runs` hadn't,
 * a split state, plus a spurious audit row. Now checked immediately after
 * the B2 threadId/runId guard above (same "before touching the graph or
 * writing anything" ordering) via `resumeDecisionsFor(run.currentState)`,
 * throwing `ResumeDecisionDomainMismatchError` (zero writes) on a mismatch.
 *
 * **Review Round-5 R6-B1 rework** (`docs/feature/a4b-loop/test-report.md`):
 * the R5-B1 guard above closed the *cross-domain* case (an Escalation-shaped
 * value reaching a g1/g2/g3 gate, or vice versa) but `resumeDecisionsFor()`
 * still mapped all three gates to one shared three-value
 * `["approved","rejected","escalate"]` domain — three *same-domain* values
 * each gate's own `routeAfter*` router doesn't actually accept
 * (`{decision:"escalate"}` to G1 or G3, `{decision:"rejected"}` to G2)
 * still needed no cast and still reproduced R5-B1's exact failure class
 * (illegitimate `approvals` row landed first, gate router's own
 * `default`/`UnhandledGateDecisionError` threw second, checkpoint/
 * `workflow_runs` split). `resumeDecisionsFor()` now maps each gate to its
 * own real accepted set (see its doc comment above) instead of one shared
 * one, so all three of those paths are caught here too, before anything is
 * written.
 */
export async function resumeRun(
  deps: StartRunDeps,
  runId: number,
  threadId: string,
  resume: GateResumeValue | EscalationResumeValue,
  decidedBy: string,
  stepCounters: Record<string, number> = {},
): Promise<RunHandle> {
  if (typeof decidedBy !== "string") {
    throw new Error(
      "resumeRun: decidedBy is required (this function's TS signature already requires it; " +
        "reaching this branch means a caller bypassed that type at runtime).",
    );
  }

  const run = deps.audit.getRunById(runId);
  if (!run) {
    throw new AuditReadError(`resumeRun: no workflow_runs row for runId ${runId}`);
  }
  if (run.langgraphThreadId !== threadId) {
    throw new RunThreadMismatchError(runId, run.langgraphThreadId, threadId);
  }

  // R5-B1 (see errors.ts's ResumeDecisionDomainMismatchError doc comment):
  // `resume`'s decision must belong to the domain the run's *currently
  // pending* gate actually expects — checked here, still before anything is
  // written or the graph is touched, same "fail loud, zero writes" posture
  // as the RunThreadMismatchError check just above.
  if (!resumeDecisionsFor(run.currentState).includes(resume.decision)) {
    throw new ResumeDecisionDomainMismatchError(runId, run.currentState, resume.decision);
  }

  const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer, schemaMaxAttempts: deps.schemaMaxAttempts }), deps.checkpointer);
  const cfg = { configurable: { thread_id: threadId } };
  const command = new Command<GateResumeValue | EscalationResumeValue, Record<string, unknown>, RealGraphNode>({ resume });

  // Review Round-1 D1 rework (see file header): rebuild each node's counter
  // from what's actually on disk for this run, merged with whatever the
  // caller supplied, instead of trusting the caller-supplied value alone.
  const dbStepCounters = rebuildStepCounters(deps.audit, runId);
  const effectiveStepCounters = mergeStepCounters(dbStepCounters, stepCounters);

  // Issue #29 PRD §9.1 decision 1 — same optional-events posture as
  // `startRun()`; no `run_started` here (a resume isn't a new run). Note
  // this deliberately sits *after* every pre-flight validation guard above
  // (the `decidedBy` type check / `RunThreadMismatchError` /
  // `ResumeDecisionDomainMismatchError`) — none of those represent an
  // in-flight execution failure worth a `run_failed` event (PRD §9.5), so
  // there is nothing event-related to emit for them; the emitter is only
  // needed once this function is actually about to touch the graph.
  const emitter = deps.events ?? new LoopEventEmitter();

  const result = await runStreamAndPersist(compiled, command, cfg, deps.audit, runId, decidedBy, effectiveStepCounters, emitter);
  return { runId, threadId, interrupt: result.interrupt, done: result.done, stepCounters: result.stepCounters };
}

/**
 * Thin wrapper over `AuditStore.listRunsByStatus` — gives a future A5 CLI a
 * ready-made entry point for "what can I resume right now" without this
 * increment building any list/interactive command around it (PRD §2
 * non-goal / §5 runner.ts: "this isn't something this increment's tests
 * need to cover as a focus")).
 */
export function getResumableRuns(deps: { audit: AuditStore }, status: "running" | "escalated"): WorkflowRun[] {
  return deps.audit.listRunsByStatus(status);
}

/**
 * Read-only reconstruction of a paused run's current pending-gate payload,
 * for a caller (A5's CLI, `src/cli/main.ts`'s `resume <runId>` command) that
 * has no in-memory `RunHandle` to read it from — e.g. a fresh process
 * resuming a run `startRun()`/`resumeRun()` returned a handle for in a
 * *previous* process (A5 PRD §3 point 2 / §5). Does nothing
 * `runStreamAndPersist`'s internal `computeRunProgress()` doesn't already do
 * (a `compiled.getState(cfg)` read) — exposed here as a public,
 * side-effect-free entry point instead of duplicated in `src/cli/`, keeping
 * "only runner.ts constructs a compiled graph + reads/writes AuditStore"
 * true for this layer too (A5 PRD §5's explicit constraint: this is the
 * *only* file outside `src/cli/` that PRD touches).
 *
 * **Zero new writes** — this function never calls any
 * `audit.insert*`/`updateRunProgress`; it only reads `AuditStore` (via
 * `getRunById`) and the checkpoint (via `compiled.getState`), matching its
 * "read-only" contract. A caller with a `runId` that doesn't exist at all
 * gets `AuditReadError`, mirroring every other `runId`-taking function in
 * this file (`resumeRun`'s own `getRunById` check, just above).
 */
export async function getPendingInterrupt(
  deps: StartRunDeps,
  runId: number,
): Promise<{ runId: number; threadId: string; interrupt?: RunHandle["interrupt"]; done: boolean }> {
  const run = deps.audit.getRunById(runId);
  if (!run) {
    throw new AuditReadError(`getPendingInterrupt: no workflow_runs row for runId ${runId}`);
  }

  const compiled = compileLoopGraph(buildLoopGraph({ router: deps.router, composer: deps.composer, schemaMaxAttempts: deps.schemaMaxAttempts }), deps.checkpointer);
  const cfg = { configurable: { thread_id: run.langgraphThreadId } };
  const progress = await computeRunProgress(compiled, cfg);

  return { runId, threadId: run.langgraphThreadId, interrupt: progress.interrupt, done: progress.done };
}
