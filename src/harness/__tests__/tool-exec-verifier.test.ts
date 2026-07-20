import { describe, expect, it } from "vitest";
import { checkToolExecution } from "../tool-exec-verifier.js";
import type { ToolCallRecord } from "../types.js";

/** A minimal real tool-call record, shape-compatible with what either adapter produces. */
function fakeToolCallRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolName: "shell",
    sequenceIndex: 0,
    succeeded: true,
    raw: { type: "command_execution" },
    ...overrides,
  };
}

/** Builds a `CoderOutput`/`TesterOutput`-shaped JSON string with the given `claims`, matching `src/prompt/schema.ts`'s `ClaimSchema`. */
function contentWithClaims(claims: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    diff: "--- a/x\n+++ b/x\n",
    claims,
    confidence: "verified",
  });
}

describe("checkToolExecution", () => {
  it('returns "pass" when a claim asserts tool_execution and the trace is non-empty (the honest happy path)', () => {
    const content = contentWithClaims([
      { claimText: "the file was actually read", confidence: "verified", verifiedBy: "tool_execution" },
    ]);
    const trace = [fakeToolCallRecord()];

    expect(checkToolExecution(content, trace)).toBe("pass");
  });

  it('returns "fail" when a claim asserts tool_execution but the trace is empty — the core "声称≠行为" hallucination this verifier exists to catch', () => {
    const content = contentWithClaims([
      { claimText: "I definitely ran the tests", confidence: "verified", verifiedBy: "tool_execution" },
    ]);

    expect(checkToolExecution(content, [])).toBe("fail");
  });

  it('returns "na" when no claim asserts tool_execution, even if the trace happens to be non-empty', () => {
    const content = contentWithClaims([
      { claimText: "this is just my opinion", confidence: "inferred" },
      { claimText: "a human checked this one", confidence: "verified", verifiedBy: "human" },
      { claimText: "not sure about this", confidence: "unconfirmed", verifiedBy: "unverified" },
    ]);
    // Trace is non-empty (some unrelated tool call happened during this
    // invoke), but since nothing *claims* tool_execution there's nothing
    // to check — must not be misread as "pass".
    const trace = [fakeToolCallRecord()];

    expect(checkToolExecution(content, trace)).toBe("na");
  });

  it('returns "na" when content is not valid JSON at all', () => {
    expect(checkToolExecution("not json { at all", [])).toBe("na");
    expect(checkToolExecution("not json { at all", [fakeToolCallRecord()])).toBe("na");
  });

  it('returns "na" when content is valid JSON but has no claims array', () => {
    expect(checkToolExecution(JSON.stringify({ diff: "x", confidence: "verified" }), [])).toBe("na");
  });

  it('returns "na" when claims is present but empty', () => {
    expect(checkToolExecution(contentWithClaims([]), [fakeToolCallRecord()])).toBe("na");
  });

  it('returns "na" when content is valid JSON but not an object (e.g. a bare array or string)', () => {
    expect(checkToolExecution(JSON.stringify(["not", "an", "object"]), [])).toBe("na");
    expect(checkToolExecution(JSON.stringify("just a string"), [])).toBe("na");
    expect(checkToolExecution(JSON.stringify(null), [])).toBe("na");
  });

  it('returns "pass" when only one of several claims asserts tool_execution and the trace backs it', () => {
    const content = contentWithClaims([
      { claimText: "opinion only", confidence: "inferred" },
      { claimText: "checked via tool_execution", confidence: "verified", verifiedBy: "tool_execution" },
    ]);

    expect(checkToolExecution(content, [fakeToolCallRecord()])).toBe("pass");
  });

  it("never throws on malformed claim entries inside an otherwise-valid claims array", () => {
    const content = JSON.stringify({
      diff: "x",
      claims: [null, 42, "a string, not an object", { noVerifiedByField: true }],
      confidence: "verified",
    });

    expect(() => checkToolExecution(content, [])).not.toThrow();
    expect(checkToolExecution(content, [])).toBe("na");
  });
});
