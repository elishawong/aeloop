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
 */
import { danger, ok } from "./colors.js";
import { renderEscalation, renderG1, renderG2, renderG3 } from "./gate-view.js";
import type { Prompter } from "./prompter.js";
import { stripControlSequences } from "./sanitize-terminal.js";
import type { CliDeps } from "./assemble.js";
import { resumeRun, type RunHandle } from "../loop/runner.js";
import { GATE_TYPES } from "../loop/workflow-def.js";
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

function printFinalSummary(deps: CliDeps, runId: number): void {
  const run = deps.audit.getRunById(runId);
  if (run?.status === "completed") {
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

  while (!current.done) {
    const interrupt = current.interrupt;
    if (interrupt === undefined) {
      throw new Error(`run-loop: handle for run #${current.runId} reports not done, but carries no pending interrupt`);
    }

    console.log(renderGate(interrupt.gate, interrupt.payload));
    const resumeValue = await decideForGate(prompter, interrupt.gate, interrupt.payload.question);
    current = await resumeRun(deps, current.runId, current.threadId, resumeValue, decidedBy, current.stepCounters);
  }

  printFinalSummary(deps, current.runId);
  return current;
}
