import { describe, expect, it } from "vitest";
import { ClaimSchema, CoderOutput, TesterOutput } from "../schema.js";

describe("ClaimSchema", () => {
  it("accepts a minimal valid claim (only the required fields)", () => {
    const result = ClaimSchema.safeParse({
      claimText: "the endpoint returns 404 for an unknown id",
      confidence: "verified",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full valid claim with optional fields set", () => {
    const result = ClaimSchema.safeParse({
      claimText: "the endpoint returns 404 for an unknown id",
      confidence: "verified",
      sourceRef: "src/routes/user.test.ts:42",
      verifiedBy: "tool_execution",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing claimText", () => {
    const result = ClaimSchema.safeParse({ confidence: "verified" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty claimText (min length 1)", () => {
    const result = ClaimSchema.safeParse({ claimText: "", confidence: "verified" });
    expect(result.success).toBe(false);
  });

  it("rejects a confidence value outside the closed enum", () => {
    const result = ClaimSchema.safeParse({ claimText: "x", confidence: "pretty sure" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing confidence", () => {
    const result = ClaimSchema.safeParse({ claimText: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty sourceRef when present (min length 1)", () => {
    const result = ClaimSchema.safeParse({ claimText: "x", confidence: "verified", sourceRef: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a verifiedBy value outside the closed enum", () => {
    const result = ClaimSchema.safeParse({
      claimText: "x",
      confidence: "verified",
      verifiedBy: "vibes",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a claim with toolsUsed declared alongside verifiedBy: tool_execution", () => {
    const result = ClaimSchema.safeParse({
      claimText: "the endpoint returns 404 for an unknown id",
      confidence: "verified",
      verifiedBy: "tool_execution",
      toolsUsed: ["Read", "Bash"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a claim without toolsUsed (legacy v1 shape stays valid)", () => {
    const result = ClaimSchema.safeParse({
      claimText: "x",
      confidence: "verified",
      verifiedBy: "tool_execution",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty toolsUsed array (min length 1)", () => {
    const result = ClaimSchema.safeParse({
      claimText: "x",
      confidence: "verified",
      verifiedBy: "tool_execution",
      toolsUsed: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a toolsUsed array containing an empty string", () => {
    const result = ClaimSchema.safeParse({
      claimText: "x",
      confidence: "verified",
      verifiedBy: "tool_execution",
      toolsUsed: ["Read", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects toolsUsed that isn't an array of strings", () => {
    const result = ClaimSchema.safeParse({
      claimText: "x",
      confidence: "verified",
      verifiedBy: "tool_execution",
      toolsUsed: "Read",
    });
    expect(result.success).toBe(false);
  });
});

describe("CoderOutput", () => {
  const validClaim = { claimText: "x", confidence: "verified" as const };

  it("accepts a valid payload", () => {
    const result = CoderOutput.safeParse({
      diff: "--- a/foo.ts\n+++ b/foo.ts\n",
      claims: [validClaim],
      confidence: "inferred",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty claims array", () => {
    const result = CoderOutput.safeParse({
      diff: "--- a/foo.ts\n+++ b/foo.ts\n",
      claims: [],
      confidence: "inferred",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty diff", () => {
    const result = CoderOutput.safeParse({ diff: "", claims: [], confidence: "inferred" });
    expect(result.success).toBe(false);
  });

  it("rejects a claims array containing an invalid claim", () => {
    const result = CoderOutput.safeParse({
      diff: "--- a/foo.ts\n+++ b/foo.ts\n",
      claims: [{ claimText: "x", confidence: "not-a-real-level" }],
      confidence: "inferred",
    });
    expect(result.success).toBe(false);
  });

  it("rejects claims that isn't an array", () => {
    const result = CoderOutput.safeParse({
      diff: "--- a/foo.ts\n+++ b/foo.ts\n",
      claims: "not an array",
      confidence: "inferred",
    });
    expect(result.success).toBe(false);
  });
});

describe("TesterOutput", () => {
  const validClaim = { claimText: "x", confidence: "verified" as const };

  it("accepts a valid 'pass' payload", () => {
    const result = TesterOutput.safeParse({
      verdict: "pass",
      issues: [],
      claims: [validClaim],
      confidence: "verified",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid 'reject' payload with issues", () => {
    const result = TesterOutput.safeParse({
      verdict: "reject",
      issues: ["off-by-one in the pagination cursor"],
      claims: [validClaim],
      confidence: "verified",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a verdict outside {pass, reject}", () => {
    const result = TesterOutput.safeParse({
      verdict: "looks_fine",
      issues: [],
      claims: [],
      confidence: "verified",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string issue (issues must be non-empty strings)", () => {
    const result = TesterOutput.safeParse({
      verdict: "reject",
      issues: [""],
      claims: [],
      confidence: "verified",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing verdict", () => {
    const result = TesterOutput.safeParse({ issues: [], claims: [], confidence: "verified" });
    expect(result.success).toBe(false);
  });
});
