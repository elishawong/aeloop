/**
 * `errors.ts` unit tests. `UnhandledGateDecisionError`'s instance-type
 * behavior is already covered end-to-end through the real compiled graph
 * (`graph.test.ts`'s "G2 receiving a non-'approved' decision..." test) —
 * this file locks the *message text itself*, which that test doesn't
 * assert on.
 *
 * Zorro Round-3 R3-1 (`docs/feature/a4b-loop/test-report.md`, R4-1
 * rework): the thrown message used to say `"...which A4a has no routing
 * target for (A4b will add one — see ...)"` — accurate in A4a's own
 * increment, but false once A4b actually shipped: A4b built the
 * Escalation subtree and *deliberately* left G2's `"rejected"` case
 * unrouted (PRD §2 non-goal #2, unchanged by A4b), so "A4b will add one"
 * misdescribes a permanent, intentional fail-loud guard as a temporary
 * gap. This test pins the message to not regress back to that stale,
 * now-false claim.
 */
import { describe, expect, it } from "vitest";
import { UnhandledGateDecisionError } from "../errors.js";

describe("UnhandledGateDecisionError message text", () => {
  it("does not claim A4b will add a routing target — that decision is permanent, not a future increment's TODO", () => {
    const err = new UnhandledGateDecisionError("G2_SEND_TO_FIX", "rejected");

    expect(err.message).not.toMatch(/A4b will add/i);
    expect(err.message).not.toMatch(/until A4b/i);
    expect(err.message).not.toMatch(/A4a has no routing target/i);
  });

  it("carries the gate/decision that triggered it and identifies itself by name", () => {
    const err = new UnhandledGateDecisionError("G2_SEND_TO_FIX", "rejected");

    expect(err.name).toBe("UnhandledGateDecisionError");
    expect(err.gate).toBe("G2_SEND_TO_FIX");
    expect(err.decision).toBe("rejected");
    expect(err.message).toContain("G2_SEND_TO_FIX");
    expect(err.message).toContain("rejected");
  });
});
