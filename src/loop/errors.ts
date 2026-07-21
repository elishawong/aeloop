/**
 * Typed errors for the Loop layer (src/loop/*), mirroring the Harness
 * layer's `harness/errors.ts` convention (typed classes, never a raw
 * generic `Error` for a condition callers need to distinguish).
 */

import type { GateType } from "./types.js";

/**
 * `routeAfterG2` (gates.ts) received a `state.g2Decision` other than
 * `"approved"` — most notably `"rejected"`, which DESIGN §4's G2 gate has
 * no drawn edge for (its only two out-edges are "批准→Fix" and "主动升级→
 * Esc"). A4a made an explicit, documented decision that G2 only ever
 * handles `"approved"` (PRD §2 non-goal #2). A4b has since built the
 * Escalation subtree (`src/loop/escalation.ts`) and wired the "主动升级→
 * Esc" edge for `"escalate"` — but that addition deliberately left
 * `"rejected"` alone: it is not a gap waiting on some future increment,
 * it is a permanent, intentional fail-loud guard for a case DESIGN itself
 * draws no route for (gates.ts's `routeAfterG2` doc comment: "unchanged by
 * A4b"). Thrown instead of silently routing `"rejected"` to some invented
 * node, or falling through to a default that isn't actually correct per
 * DESIGN.
 */
export class UnhandledGateDecisionError extends Error {
  readonly gate: GateType;
  readonly decision: string;

  constructor(gate: GateType, decision: string) {
    super(
      `Gate "${gate}" received decision "${decision}", which has no routing target — ` +
        `DESIGN §4's G2 gate draws no edge for this case, and A4a's explicit, permanent ` +
        `decision (unchanged by A4b) is to fail loud here rather than invent one ` +
        `(see docs/feature/a4a-loop/PRD.md §2 non-goal #2).`,
    );
    this.name = "UnhandledGateDecisionError";
    this.gate = gate;
    this.decision = decision;
  }
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * `AuditStore`'s read methods (`getRunById`/`getRunByThreadId`) failed —
 * mirrors `context/errors.ts`'s `RecallError` convention (A4b PRD §5
 * "errors.ts": "读失败必须可见,不能悄悄退化成空结果/undefined"). Write
 * methods (`insertRun`/`insertClaim`/`insertApproval`/`updateRunProgress`)
 * deliberately let `better-sqlite3`'s own `SqliteError` propagate
 * unwrapped instead — same split `MemoryStore` already established
 * (read-wrapped, write-unwrapped).
 */
export class AuditReadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause !== undefined ? `${message}: ${describeCause(cause)}` : message, { cause });
    this.name = "AuditReadError";
  }
}

/**
 * `runner.ts`'s `resumeRun(deps, runId, threadId, ...)` received a
 * `runId`/`threadId` pair that don't belong to the same `workflow_runs`
 * row — Zorro Round-1 B2 (`docs/feature/a4b-loop/test-report.md`):
 * `resumeRun` used to advance the graph at `threadId` while attributing
 * *every* claim/approval/`workflow_runs` write to the independently-passed
 * `runId`, with zero check that the two actually referred to the same run.
 * A caller that accidentally paired run A's `runId` with run B's
 * `threadId` would silently advance B's graph while writing B's
 * approvals/claims/reject_count into A's audit trail — the exact kind of
 * silent cross-run corruption a "governance/audit-first" product cannot
 * tolerate. Thrown instead of ever reaching a single `audit.insert*` call
 * (fail loud, before any write, not a best-effort partial write).
 */
export class RunThreadMismatchError extends Error {
  readonly runId: number;
  readonly expectedThreadId: string;
  readonly actualThreadId: string;

  constructor(runId: number, expectedThreadId: string, actualThreadId: string) {
    super(
      `resumeRun: runId ${runId} belongs to threadId "${expectedThreadId}", but was called with ` +
        `threadId "${actualThreadId}" — refusing to advance one run's graph while attributing audit ` +
        `writes to a different run's id (docs/feature/a4b-loop/test-report.md B2).`,
    );
    this.name = "RunThreadMismatchError";
    this.runId = runId;
    this.expectedThreadId = expectedThreadId;
    this.actualThreadId = actualThreadId;
  }
}

/**
 * `runner.ts`'s `resumeRun(deps, runId, threadId, resume, ...)` received a
 * `resume` value whose *decision domain* doesn't match the gate the run is
 * actually paused at — Zorro Round-4 R5-B1
 * (`docs/feature/a4b-loop/test-report.md`): `resume`'s parameter type,
 * `GateResumeValue | EscalationResumeValue`, is an **undiscriminated**
 * union — nothing in TypeScript stops a caller from handing a
 * `{decision: "force_pass"}` (a legal `EscalationResumeValue`, no cast
 * required) to a run actually paused at **G1**, which only ever expects a
 * `GateResumeValue` (`"approved" | "rejected" | "escalate"`). Before this
 * guard existed, that mismatch would first insert an illegitimate
 * `approvals` row (recording an Escalation-domain decision under the G1
 * `gate_type`), *then* fail loud once `routeAfterG1` hit its own
 * `default: throw` for the unrecognized `g1Decision` — leaving a split
 * state behind: the LangGraph checkpoint had already advanced past G1
 * (`next=[]`) while `workflow_runs` still read `status=running,
 * current_state=g1`, plus a spurious audit row neither state agreed with.
 * Same defect class as Round-1 B2's `RunThreadMismatchError` (a caller
 * handed an input the system should never accept, and the old code only
 * discovered that *after* writing something) — checked here, before
 * `resumeRun` touches the graph or writes a single row, so a domain
 * mismatch now fails loud with zero writes instead.
 *
 * **Zorro Round-5 R6-B1 rework** (`docs/feature/a4b-loop/test-report.md`):
 * the guard's *first* version (above) closed the cross-domain case but its
 * thrown message claimed "G1/G2/G3 gates only accept GateResumeValue's
 * approved/rejected/escalate" — which was never actually true of any of the
 * three: `routeAfterG1`/`routeAfterG3` (`gates.ts`) only ever accept
 * `approved`/`rejected` (their `default` branch throws on `escalate`, which
 * only `routeAfterG2`'s own edge produces), and `routeAfterG2` only ever
 * accepts `approved`/`escalate` (`rejected` hits `UnhandledGateDecisionError`,
 * PRD §2 non-goal #2). That inaccurate message was shipped in production
 * error text while `runner.ts`'s `resumeDecisionsFor()` *itself* still
 * lumped all three gates into that same wrong shared domain — the message
 * wasn't just imprecise, it accurately described the very bug R6-B1 fixes.
 * Both are now precise per-gate.
 */
export class ResumeDecisionDomainMismatchError extends Error {
  readonly runId: number;
  readonly pendingGate: string;
  readonly decision: string;

  constructor(runId: number, pendingGate: string, decision: string) {
    super(
      `resumeRun: run ${runId} is paused at "${pendingGate}" and cannot accept a resume decision of ` +
        `"${decision}" — that decision belongs to a different resume-value domain than the one "${pendingGate}" ` +
        `actually expects (G1 and G3 accept only GateResumeValue's approved/rejected; G2 accepts only ` +
        `GateResumeValue's approved/escalate — never rejected, PRD §2 non-goal #2; the escalation gate accepts ` +
        `only EscalationResumeValue's revise/force_pass/abandon). Refusing to advance the graph or write an ` +
        `approvals row for a decision that doesn't match the gate it's being applied to ` +
        `(docs/feature/a4b-loop/test-report.md R6-B1).`,
    );
    this.name = "ResumeDecisionDomainMismatchError";
    this.runId = runId;
    this.pendingGate = pendingGate;
    this.decision = decision;
  }
}
