/**
 * `gate-view.ts` unit tests (PRD §6.3 / §8 B2). Pure `GatePayload -> string`
 * — no TTY/prompt library involved. Real `GatePayload` shapes, matching
 * what `gates.ts`/`escalation.ts` actually build (src/loop/types.ts).
 */
import { describe, expect, it } from "vitest";
import { renderEscalation, renderG1, renderG2, renderG3 } from "../gate-view.js";
import type { GatePayload } from "../../loop/types.js";

const GREEN = "[32m";
const RED = "[31m";
const BG_YELLOW = "[43m";

const g1Payload: GatePayload = {
  gate: "G1_SEND_TO_TESTER",
  question: "approve sending this diff to the tester?",
  diffRef: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
};

const g2Payload: GatePayload = {
  gate: "G2_SEND_TO_FIX",
  question: "approve sending the tester's findings back to the coder for a fix?",
  issues: ["the reversed string is missing the last character", "no test for empty input"],
};

const g3Payload: GatePayload = {
  gate: "G3_FINAL_MERGE",
  question: "final sign-off: apply this diff?",
  diffRef: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
};

const escalationPayload: GatePayload = {
  gate: "ESCALATION_ACK",
  question: "reject_count reached the threshold — revise / force-pass / abandon?",
  diffRef: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
  issues: ["the reversed string is missing the last character"],
};

describe("renderG1", () => {
  it("renders the question and the colorized diff", () => {
    const out = renderG1(g1Payload);
    expect(out).toContain(g1Payload.question);
    expect(out).toContain(GREEN); // +new
    expect(out).toContain(RED); // -old
  });

  it("omits the diff section entirely when diffRef is absent (payload built before any coderOutput exists)", () => {
    const out = renderG1({ gate: "G1_SEND_TO_TESTER", question: "q" });
    expect(out).not.toContain(GREEN);
    expect(out).not.toContain(RED);
    expect(out).toContain("q");
  });

  it("strips a real terminal control sequence embedded in the question (P1-4, test-report.md) — a model can't smuggle a clear-screen payload into the one text every gate renders", () => {
    const ESC = "\x1B";
    const out = renderG1({ gate: "G1_SEND_TO_TESTER", question: `real question${ESC}[2Jfake injected text` });
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).toContain("real question");
    expect(out).toContain("fake injected text"); // text survives — only the control bytes are stripped
  });
});

describe("renderG2", () => {
  it("renders the question and a bulleted issues list", () => {
    const out = renderG2(g2Payload);
    expect(out).toContain(g2Payload.question);
    for (const issue of g2Payload.issues ?? []) {
      expect(out).toContain(issue);
    }
  });

  it("does not render a diff section — G2 has no diffRef in its real payload shape", () => {
    const out = renderG2(g2Payload);
    expect(out).not.toContain(GREEN);
    expect(out).not.toContain(RED);
  });

  it("strips a real terminal control sequence embedded in an issue string (P1-4, test-report.md)", () => {
    const ESC = "\x1B";
    const out = renderG2({ gate: "G2_SEND_TO_FIX", question: "q", issues: [`real issue${ESC}[2Jfake injected line`] });
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).toContain("real issue");
    expect(out).toContain("fake injected line");
  });
});

describe("renderG3", () => {
  it("renders the question and the colorized diff, same shape as G1", () => {
    const out = renderG3(g3Payload);
    expect(out).toContain(g3Payload.question);
    expect(out).toContain(GREEN);
    expect(out).toContain(RED);
  });
});

describe("renderEscalation", () => {
  it("is structurally distinguishable from an ordinary gate — wrapped in the bold-on-yellow-background banner, not just a different color", () => {
    const out = renderEscalation(escalationPayload);
    expect(out).toContain(BG_YELLOW);
    expect(out).toContain("ESCALATION");
  });

  it("renders the question, the tester's issues, and the diff — everything a human needs to decide revise/force_pass/abandon", () => {
    const out = renderEscalation(escalationPayload);
    expect(out).toContain(escalationPayload.question);
    for (const issue of escalationPayload.issues ?? []) {
      expect(out).toContain(issue);
    }
    expect(out).toContain(GREEN); // +new from the diff
    expect(out).toContain(RED); // -old from the diff
  });

  it("differs structurally from renderG1's output for an equivalent question+diff — not merely a different foreground color reused from G1", () => {
    const g1Like = renderG1({ gate: "G1_SEND_TO_TESTER", question: escalationPayload.question, diffRef: escalationPayload.diffRef });
    const escalationOut = renderEscalation({ gate: "ESCALATION_ACK", question: escalationPayload.question, diffRef: escalationPayload.diffRef });
    expect(escalationOut).not.toBe(g1Like);
    expect(escalationOut).toContain(BG_YELLOW);
    expect(g1Like).not.toContain(BG_YELLOW);
  });
});
