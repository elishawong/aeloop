/**
 * `runInteractiveLoop()` — the interactive start/resume orchestrator (PRD
 * §6.6). Shared by both `main.ts` subcommands: `start`'s initial handle
 * comes straight from `startRun()` (a real `RunHandle`); `resume`'s initial
 * handle comes from `runner.ts`'s new `getPendingInterrupt()` (§5), which
 * returns a same-shaped value minus `stepCounters` — `RunLoopHandle` below
 * is the common subset both can satisfy, normalized to a full `RunHandle`
 * on entry so the rest of this file only ever deals with one shape.
 *
 * Loop body: render whichever gate is pending (`gate-view.ts`), ask the
 * `Prompter` for a decision shaped for that specific gate (PRD §2 Goals —
 * G1/G3 `confirm()` approve/reject; G2 `select()` approved/escalate, never
 * a third "rejected" option, §0.1's correction; Escalation `select()`
 * revise/force_pass/abandon), then `resumeRun()` with that decision. Ends
 * with a final summary read from `AuditStore` — `RunHandle` itself carries
 * no `applied`/`cancelled` field (that's `workflow_runs.status`, not part
 * of what `resumeRun()` returns to its caller), so the summary is a real
 * post-loop `audit.getRunById()` read, not something inferred from the
 * handle alone.
 *
 * **Issue #63 — `workflow.gate_mode: "semi-auto"`** (full design/safety
 * boundary: `docs/feature/semi-auto-gate-mode/PRD.md`): this is the one
 * place in this codebase that branches on that toggle (`profile/loader.ts`'s
 * `ProfileConfig.workflow.gate_mode`, resolved once per call, default
 * `"manual"`). In `"semi-auto"`, `AUTO_APPROVABLE_GATES` (G1/G2 only — never
 * G3, never Escalation) skips the `Prompter` call entirely and resumes with
 * a synthetic `{decision:"approved"}`, recorded under `SEMI_AUTO_DECIDED_BY`
 * instead of the real human `decidedBy` this function was called with — see
 * that constant's own doc comment for why. The graph/gate nodes
 * (`loop/graph.ts`/`loop/gates.ts`) are completely unaware this toggle
 * exists: from `resumeRun()`'s point of view a semi-auto auto-approval is
 * indistinguishable from a human one except for which `decidedBy` string
 * lands in `approvals.decided_by`. `"manual"` (or `gate_mode` absent
 * entirely) takes the exact same code path this function always has —
 * byte-for-byte unchanged behavior for every profile that doesn't opt in.
 * A defensive gate-identity assertion in the loop body below (Zorro/Codex
 * independent-review hardening ask) double-checks `interrupt.gate` against
 * `workflow_runs.current_state` before ever auto-approving — see that
 * check's own inline comment.
 */
import { danger, ok } from "./colors.js";
import { renderEscalation, renderG1, renderG2, renderG3 } from "./gate-view.js";
import type { Prompter } from "./prompter.js";
import { stripControlSequences } from "./sanitize-terminal.js";
import type { CliDeps } from "./assemble.js";
import { resumeRun, type RunHandle } from "../loop/runner.js";
import { GATE_TYPES, LOOP_NODES } from "../loop/workflow-def.js";
import type { EscalationDecision, EscalationResumeValue, GateDecision, GatePayload, GateResumeValue, GateType } from "../loop/types.js";

/**
 * What both `start` (a real `RunHandle`) and `resume` (§5's
 * `getPendingInterrupt()` result — same shape minus `stepCounters`) can
 * hand this function. `stepCounters` optional here, defaulted to `{}` on
 * normalization — exactly the "brand-new process, nothing but runId/
 * threadId" case `runner.ts`'s D1 rework (`resumeRun`'s own doc comment)
 * already rebuilds correctly from disk.
 */
export interface RunLoopHandle {
  runId: number;
  threadId: string;
  interrupt?: RunHandle["interrupt"];
  done: boolean;
  stepCounters?: Record<string, number>;
}

function normalizeHandle(handle: RunLoopHandle): RunHandle {
  return {
    runId: handle.runId,
    threadId: handle.threadId,
    interrupt: handle.interrupt,
    done: handle.done,
    stepCounters: handle.stepCounters ?? {},
  };
}

function renderGate(gate: GateType, payload: GatePayload): string {
  switch (gate) {
    case GATE_TYPES.G1_SEND_TO_TESTER:
      return renderG1(payload);
    case GATE_TYPES.G2_SEND_TO_FIX:
      return renderG2(payload);
    case GATE_TYPES.G3_FINAL_MERGE:
      return renderG3(payload);
    case GATE_TYPES.ESCALATION_ACK:
      return renderEscalation(payload);
    default:
      // Defensive backstop, same posture as gates.ts's routeAfterG1/G3 `default: throw` — GateType is a
      // closed 4-value union (workflow-def.ts's GATE_TYPES), this is unreachable through real code.
      throw new Error(`run-loop: unrecognized gate "${gate as string}"`);
  }
}

/**
 * Asks the `Prompter` for a decision shaped for `gate` (PRD §2 Goals / §0.1):
 * - G1/G3: `confirm()` — approved/rejected, optional free-text reason on reject.
 * - G2: `select()` — approved (send back to coder for a fix) / escalate. Never "rejected"
 *   (§0.1's correction to issue #22's shorthand — `gates.ts`'s real `routeAfterG2` has no
 *   route for it, `UnhandledGateDecisionError`).
 * - Escalation: `select()` — revise/force_pass/abandon, optional free-text reason on revise.
 */
async function decideForGate(prompter: Prompter, gate: GateType, rawQuestion: string): Promise<GateResumeValue | EscalationResumeValue> {
  // Same control-sequence sanitization gate-view.ts's render*() functions apply before printing
  // the question as a heading (P1-4, 2026-07-21 Zorro re-review) — this is the *other* place the
  // gate's model-produced `question` text reaches a real terminal render (@inquirer/prompts'
  // confirm()/select() render `message` themselves), so it needs the same treatment or the fix
  // above only closes half the path.
  const question = stripControlSequences(rawQuestion);
  switch (gate) {
    case GATE_TYPES.G1_SEND_TO_TESTER:
    case GATE_TYPES.G3_FINAL_MERGE: {
      const approved = await prompter.confirm(question);
      const decision: GateDecision = approved ? "approved" : "rejected";
      if (decision === "approved") return { decision };
      const reasoningText = await prompter.input("Reason for rejecting (optional):");
      return reasoningText.length > 0 ? { decision, reasoningText } : { decision };
    }
    case GATE_TYPES.G2_SEND_TO_FIX: {
      const decision = await prompter.select<"approved" | "escalate">(question, [
        { name: "Approve — send back to the coder for a fix", value: "approved" },
        { name: "Escalate", value: "escalate" },
      ]);
      return { decision };
    }
    case GATE_TYPES.ESCALATION_ACK: {
      const decision = await prompter.select<EscalationDecision>(question, [
        { name: "Revise — send back to the coder", value: "revise" },
        { name: "Force pass — skip straight to G3", value: "force_pass" },
        { name: "Abandon — cancel this run", value: "abandon" },
      ]);
      if (decision !== "revise") return { decision };
      const reasoningText = await prompter.input("Reason for revising (optional):");
      return reasoningText.length > 0 ? { decision, reasoningText } : { decision };
    }
    default:
      // Same defensive backstop as renderGate() above — unreachable through real code.
      throw new Error(`run-loop: unrecognized gate "${gate as string}"`);
  }
}

/**
 * Issue #63: the two gates `workflow.gate_mode: "semi-auto"` (`profile/loader.ts`'s
 * `ProfileConfig.workflow.gate_mode`) auto-approves with no human prompt — G1
 * (send the coder's draft to the tester) and G2 (send the tester's findings
 * back to the coder for a fix). G3 (final apply) and `ESCALATION_ACK` are
 * deliberately **not** in this set — they stay human in every mode, per
 * `docs/feature/semi-auto-gate-mode/PRD.md`'s explicit safety-boundary
 * requirement (§2 Goals / §3 non-goals), so `runInteractiveLoop()`'s branch
 * below only ever skips the prompt for these two.
 */
const AUTO_APPROVABLE_GATES: ReadonlySet<GateType> = new Set([GATE_TYPES.G1_SEND_TO_TESTER, GATE_TYPES.G2_SEND_TO_FIX]);

/**
 * `interrupt.gate`'s counterpart in `workflow_runs.current_state`
 * (`loop/workflow-def.ts`'s `LOOP_NODES` — see `loop/runner.ts`'s
 * `resumeDecisionsFor()` for the same node-name convention) — used only by
 * the gate-identity assertion below, never as a general-purpose lookup.
 */
const AUTO_APPROVABLE_DB_STATE: Readonly<Record<string, string>> = {
  [GATE_TYPES.G1_SEND_TO_TESTER]: LOOP_NODES.g1,
  [GATE_TYPES.G2_SEND_TO_FIX]: LOOP_NODES.g2,
};

/**
 * The `decidedBy` recorded for a semi-auto gate's automatic approval —
 * deliberately never the real human's username (`main.ts`'s
 * `os.userInfo().username`, threaded into this function as its own
 * `decidedBy` parameter for every *human* decision in the same run).
 * `resumeRun()` stores `decidedBy` verbatim into `approvals.decided_by`
 * (`loop/audit-store.ts`) — this distinct string is how a later reader of
 * the audit trail tells a real human approval apart from a semi-auto system
 * approval for the exact same gate type, without needing a schema change to
 * add a boolean flag alongside it (requirement 2: "never fake it as a human
 * decision").
 */
const SEMI_AUTO_DECIDED_BY = "system (semi-auto)";

function printFinalSummary(deps: CliDeps, runId: number): void {
  const run = deps.audit.getRunById(runId);
  if (run?.status === "completed" && run.currentState === LOOP_NODES.noChange) {
    // Issue #47's other completed shape: the coder's own draft round decided
    // there was nothing to change (`coderOutput.status === "no_change"`), so
    // this run never went through G1/G2/G3 at all — `currentState` is
    // `"no_change"`, not `"apply"` (graph.ts's `draft -{no_change}-> noChange
    // -> END` path, runner.ts's own `currentState = LOOP_NODES.noChange`).
    // Saying "G3 approved" here would be actively wrong (no gate ever ran),
    // so this gets its own message rather than falling into the `"completed"`
    // branch below.
    console.log(ok(`Run #${runId} completed — no code change was needed, audit trail closed.`));
  } else if (run?.status === "completed") {
    // "applied" would be misleading here (Zorro re-review "顺手修" item, P0-1's real finding):
    // `applyNode()` is a no-op (graph.ts's `{applied:true}` audit-only marker, A4a's documented
    // downgrade), so completion means the audit trail/gate history is finished, not that any file
    // was actually written to disk as a *result* of this completion. (Separately, the coder may
    // already have written real changes via Bash before G1 ever ran — aeloop#31 — but that's not
    // what this message is claiming either way; it deliberately says nothing about disk state.)
    console.log(ok(`Run #${runId} completed — G3 approved, audit trail closed (no file-write step in this engine yet).`));
  } else {
    console.log(danger(`Run #${runId} ended — status "${run?.status ?? "unknown"}" (not completed).`));
  }
}

export async function runInteractiveLoop(deps: CliDeps, prompter: Prompter, handle: RunLoopHandle, decidedBy: string): Promise<RunHandle> {
  let current = normalizeHandle(handle);
  // Issue #63: read once per call, not once per gate — `gate_mode` is a
  // per-run/per-profile setting, not something that can change mid-loop.
  const gateMode = deps.profileConfig.workflow?.gate_mode ?? "manual";

  while (!current.done) {
    const interrupt = current.interrupt;
    if (interrupt === undefined) {
      throw new Error(`run-loop: handle for run #${current.runId} reports not done, but carries no pending interrupt`);
    }

    console.log(renderGate(interrupt.gate, interrupt.payload));

    if (gateMode === "semi-auto" && AUTO_APPROVABLE_GATES.has(interrupt.gate)) {
      // Defensive gate-identity assertion (Zorro/Codex independent review hardening ask): only
      // ever auto-approve if `workflow_runs.current_state` — read fresh, independently of
      // `interrupt.gate` — agrees this is really G1/G2, not G3/Escalation. Should be unreachable
      // through real code, but auto-approval is security-sensitive, so a disagreement fails
      // closed (throws) rather than trusting `interrupt.gate` alone.
      if (deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]) {
        throw new Error(`run-loop: gate-identity mismatch for run #${current.runId} (interrupt.gate="${interrupt.gate}") — refusing to auto-approve`);
      }
      // No prompter call for G1/G2 in semi-auto — this is the whole point of the toggle. Still
      // printed to the terminal (line above) so a human watching along sees what happened, plus an
      // explicit banner distinguishing this from an interactive approval.
      console.log(ok(`[semi-auto] auto-approved — ${interrupt.gate} (recorded as "${SEMI_AUTO_DECIDED_BY}", not a human decision)`));
      const resumeValue: GateResumeValue = { decision: "approved" };
      current = await resumeRun(deps, current.runId, current.threadId, resumeValue, SEMI_AUTO_DECIDED_BY, current.stepCounters);
      continue;
    }

    const resumeValue = await decideForGate(prompter, interrupt.gate, interrupt.payload.question);
    current = await resumeRun(deps, current.runId, current.threadId, resumeValue, decidedBy, current.stepCounters);
  }

  printFinalSummary(deps, current.runId);
  return current;
}
