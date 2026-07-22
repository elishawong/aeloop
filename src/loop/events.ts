/**
 * `LoopEvent` + `LoopEventEmitter` — the engine's public observability API
 * (issue #29, `docs/feature/events-observability/PRD.md` §4/§5 "events.ts").
 *
 * This file defines **only** the event vocabulary + the emitter class — it
 * has no dependency on `runner.ts`/`gates.ts`/`nodes/*.ts` and is imported
 * *by* `runner.ts`, never the other way around. All 11 event types are
 * emitted exclusively from `runner.ts` (PRD §2 non-goal: `gates.ts`/
 * `escalation.ts`/`nodes/coder.ts`/`nodes/tester.ts`/`audit-store.ts` never
 * import anything from this file — `grep -n "emit(\|LoopEvent"` across those
 * five files must stay empty, PRD §8).
 */

import type { EscalationDecision, GateDecision, GatePayload, GateType, LoopNodeName } from "./types.js";
import type { ProviderUsage, ToolExecChecked } from "../harness/types.js";
import type { Claim } from "../prompt/schema.js";

/** Fields every `LoopEvent` carries, regardless of `type` (PRD §4.0). */
interface LoopEventBase {
  /** `WorkflowRun.id` (`AuditStore`). */
  runId: number;
  /** LangGraph thread id for this run. */
  threadId: string;
  /** `new Date().toISOString()`, stamped by `runner.ts` at `emit()` time — reflects when the runner's own consumer loop processed the underlying chunk, not any deeper LangGraph-internal timestamp (PRD §4.4). */
  ts: string;
}

/** Real node names this event vocabulary ever names — every `LoopNodeName` except LangGraph's own `"__start__"`/`"__end__"` sentinels. */
export type RealLoopNodeName = Exclude<LoopNodeName, "__start__" | "__end__">;

/** PRD §4.2 row 1 — emitted once, in `startRun()`, right after `AuditStore.insertRun()` returns and before the graph is ever driven. */
export interface RunStartedEvent extends LoopEventBase {
  type: "run_started";
  task: string;
  profile: string;
  workflowDefId: string;
  rejectThreshold: number;
  /**
   * Issue #36 slice 2: a snapshot of `ContextInjectionResult["omitted"]`
   * (`src/context/injector.ts`'s `OmittedMemory[]`, re-shaped here so
   * `events.ts` doesn't take on a dependency on `src/context/*`) — present
   * only when `startRun()`'s `input.injectedContext.omitted` was itself
   * present and non-empty; `undefined` otherwise (same "absent means
   * nothing to report" convention `ContextInjectionResult.omitted` already
   * uses, kept for backward compatibility with subscribers/fixtures written
   * before this field existed).
   */
  contextOmitted?: readonly { id: number; type: string; title: string; reason: string }[];
}

/**
 * PRD §4.2 row 2 — a real pre-execution signal (spike-verified,
 * `docs/feature/events-observability/spike-node-start.md`), sourced from
 * `compiled.stream(..., {streamMode:["updates","tasks"]})`'s `"tasks"`-mode
 * create-shaped payload (`"input" in payload`). Fires for **all 8** real
 * node names uniformly — no gate-node exclusion (PRD §4.3 supersedes the
 * PRD rev. 1 scoping that excluded gate nodes).
 *
 * **Honest timing caveat** (PRD §4.4, spike §4): LangGraph's own engine
 * ordering really does "announce, then invoke" (`PregelLoop.tick()` emits
 * this fully before `PregelRunner.tick()` invokes the node) — but the
 * *external* `for await` consumer (`runner.ts`) can observe this event a
 * beat *after* the node's own synchronous prologue has already started
 * (ordinary JS microtask-scheduling on the consumer side, not a LangGraph
 * defect). For this codebase's real `draft`/`review` nodes (real async
 * network calls, hundreds of ms to seconds), that lag is negligible; for the
 * synchronous gate/apply/cancel nodes, `node_started` and `node_completed`
 * will typically be observed very close together in wall-clock time. This
 * is **not** a mathematically-provable "always strictly before the node's
 * very first line of code" guarantee — see the PRD section above for why.
 */
export interface NodeStartedEvent extends LoopEventBase {
  type: "node_started";
  node: RealLoopNodeName;
  /**
   * A **non-mutating preview** of what `nextStepRef()` will allocate for
   * this node's round once it completes (`previewStepRef()` in `runner.ts`,
   * PRD §9.4) — provably identical to the real value because this graph's
   * execution is strictly sequential per node (no two visits to the same
   * node name are ever in flight concurrently within one
   * `runStreamAndPersist()` call). `undefined` for `apply`/`cancel`, which
   * have no step-counter concept anywhere else in this codebase.
   */
  stepRef?: string;
}

/**
 * PRD §4.2 row 3 — completion-time signal (renamed from an earlier PRD
 * revision's `node_entered`; same semantics). Fires for all 8 real node
 * names, from `streamMode`'s `"updates"`-mode payload (the exact chunk
 * shape `runner.ts` already persists audit rows from).
 */
export interface NodeCompletedEvent extends LoopEventBase {
  type: "node_completed";
  node: RealLoopNodeName;
  /** The real, allocated `stepRef` for this round (same value `agent_completed`/`gate_decided` use) — `undefined` for `apply`/`cancel`. */
  stepRef?: string;
}

/** PRD §4.2 row 4 — only for `draft`/`review`, nested inside the same guard the existing `structured_claims` persistence already uses (`update.coderOutput && update.coderResult` / `update.testerOutput && update.testerResult`). */
export interface AgentCompletedEvent extends LoopEventBase {
  type: "agent_completed";
  node: "draft" | "review";
  actor: "coder" | "tester";
  claimCount: number;
  stepRef?: string;
  provider?: string;
  model?: string;
  usage?: ProviderUsage;
  latencyMs?: number;
  outcome?: "changed" | "no_change";
  noChangeReason?: string;
  noChangeEvidence?: string;
  /**
   * Issue #81 batch1 (`docs/evidence-wiring/SCOPING.md` 接点1): the same
   * `coderOutput.claims`/`testerOutput.claims` array `runner.ts` already had
   * in scope when it computed `claimCount` above — carried here as real
   * content, not just a count, so `EvidenceBundleBuilder` (batch2) has
   * something to project into `claims[]`/`evidence[]`. `claimCount` is kept
   * unchanged alongside this for backward compatibility with any existing
   * subscriber that only reads the count.
   */
  claims?: readonly Claim[];
  /**
   * Issue #81 batch1: the tester's per-round verdict
   * (`TesterOutput.verdict`, `src/prompt/schema.ts`) — only ever set on a
   * `review`/`actor:"tester"` event; a `draft`/`actor:"coder"` event never
   * carries this (a coder round has no verdict of its own, only the tester
   * that reviews it does).
   */
  verdict?: "pass" | "reject";
  /**
   * Issue #81 batch1: the independent, mechanized check result for this
   * round's underlying `InvokeResult` (`coderResult.toolExecChecked` /
   * `testerResult.toolExecChecked`, `src/harness/types.ts`) — `ToolExecVerifier`'s
   * verdict, **not** the model's own self-report (`Claim.verifiedBy` is the
   * model's self-report; this field is the independent check, batch2's
   * "verified" red line hinges on keeping the two separate). Absent
   * whenever the underlying adapter never set it (most non-CLI adapters,
   * e.g. `FakeAdapter`/`LiteLLMAdapter` in this codebase's own tests).
   */
  toolExecChecked?: ToolExecChecked;
}

/** PRD §4.2 row 5 — a gate has just paused the graph, awaiting a human decision. */
export interface GateRequestedEvent extends LoopEventBase {
  type: "gate_requested";
  gate: GateType;
  payload: GatePayload;
}

/** PRD §4.2 row 6 — a gate's decision has just been recorded (same `entries`/`decidedBy` the existing `approvals` row uses). */
export interface GateDecidedEvent extends LoopEventBase {
  type: "gate_decided";
  gate: GateType;
  decision: GateDecision | EscalationDecision;
  decidedBy: string;
}

/** PRD §4.2 row 7 — the tester rejected this round. */
export interface TesterRejectedEvent extends LoopEventBase {
  type: "tester_rejected";
  rejectCount: number;
  rejectThreshold: number;
}

/** PRD §4.2 row 8 — `rejectCount` just reached `rejectThreshold` this round (fires alongside `tester_rejected`, not instead of it). */
export interface EscalationTriggeredEvent extends LoopEventBase {
  type: "escalation_triggered";
  rejectCount: number;
}

/** PRD §4.2 row 9 — terminal: the run reached `apply`. */
export interface RunCompletedEvent extends LoopEventBase {
  type: "run_completed";
  currentState: string;
}

/** PRD §4.2 row 10 — terminal: the run reached `cancel` (an Escalation "abandon" decision). */
export interface RunCancelledEvent extends LoopEventBase {
  type: "run_cancelled";
  currentState: string;
}

/**
 * PRD §4.2 row 11 — a genuine failure *inside* `runStreamAndPersist()`'s own
 * execution (adapter unavailable, a DB constraint violation, etc.), **not**
 * `resumeRun()`'s pre-flight validation throws (`RunThreadMismatchError`/
 * `ResumeDecisionDomainMismatchError`/the `decidedBy` type guard, all of
 * which throw before `runStreamAndPersist()` is ever reached and represent
 * a rejected *request*, not a failed *execution step* — PRD §9.5). Emitted
 * immediately before the original error is rethrown unchanged.
 */
export interface RunFailedEvent extends LoopEventBase {
  type: "run_failed";
  reason: string;
}

/** The engine's full public event vocabulary (PRD §4.2 — 11 members). */
export type LoopEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | NodeCompletedEvent
  | AgentCompletedEvent
  | GateRequestedEvent
  | GateDecidedEvent
  | TesterRejectedEvent
  | EscalationTriggeredEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent;

/** A subscriber to `LoopEvent`s. May be sync (`void`) or async (`Promise<void>`) — either shape is isolated by `LoopEventEmitter.emit()` (PRD §9.3). */
export type LoopEventListener = (event: LoopEvent) => void | Promise<void>;

/**
 * Synchronous, exception-isolated pub/sub for `LoopEvent`s (PRD §5/§9.3).
 * `emit()` never throws and never awaits — a listener's failure (sync throw
 * or async rejection) is reported and swallowed, never propagated to the
 * loop that called `emit()`, and never affects `AuditStore` persistence
 * (which `runner.ts` always performs via its own, separate `audit.insertX`
 * calls, unconditionally of whether any listener is even attached).
 */
export class LoopEventEmitter {
  private readonly listeners = new Set<LoopEventListener>();

  /** Subscribe. Returns an unsubscribe function (same convention as a plain DOM/Node `EventEmitter.off`, just returned instead of requiring the caller to hold the original listener reference). */
  on(listener: LoopEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fire `event` to every current subscriber, synchronously, in
   * subscription order. Never throws: a listener that throws synchronously
   * is caught per-listener (later listeners still run); a listener that
   * returns a rejected `Promise` has that rejection caught via `.catch()`
   * (closes the gap a purely synchronous `try/catch` would miss for the
   * async-listener shape a real `EventProjector`-style subscriber will
   * realistically use — PRD §9.3's "beyond what the issue explicitly asked
   * for" addition).
   *
   * **`Promise.resolve(result)`, not a direct `.catch()` on `result`**
   * (Zorro hardening): a listener's return value only needs to be
   * *thenable* (`typeof result.then === "function"`) to be treated as
   * async here — it is not guaranteed to be a real `Promise` with its own
   * `.catch()` method (a bare/custom thenable, e.g. from an older
   * promise-library shim, can implement only `.then`). Calling `.catch()`
   * directly on such a value would throw `TypeError: result.catch is not a
   * function` — from *inside* `emit()`'s own isolation code, defeating the
   * whole point. `Promise.resolve(result)` wraps any thenable (or even a
   * plain non-thenable value, harmlessly) into a real native `Promise`,
   * guaranteeing `.catch()` exists no matter what the listener returned.
   */
  emit(event: LoopEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result !== undefined && typeof (result as Promise<void>).then === "function") {
          void Promise.resolve(result).catch((error: unknown) => {
            this.reportListenerError(event, error);
          });
        }
      } catch (error) {
        this.reportListenerError(event, error);
      }
    }
  }

  /**
   * Never rethrows — this is the isolation boundary (PRD §9.3). Not written
   * to `AuditStore` (new I/O/scope creep this PRD doesn't take on).
   * Wrapped in its own `try/catch` (Zorro hardening) so that "`emit()` never
   * throws" holds *literally*, even in the unlikely case `console.error`
   * itself throws (e.g. a test/host environment that replaces `console`
   * with something that does) — there is nothing further this method can
   * do at that point, so it silently gives up rather than let that
   * propagate out of `emit()`.
   */
  private reportListenerError(event: LoopEvent, error: unknown): void {
    try {
      console.error(`LoopEventEmitter: listener threw for event "${event.type}" (runId=${event.runId})`, error);
    } catch {
      // Nothing further to do — see doc comment above.
    }
  }
}
