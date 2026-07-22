import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SchemaValidationError } from "../errors.js";
import { SchemaValidator } from "../schema-validator.js";
import type { InvokeRequest, InvokeResult } from "../types.js";

const TestSchema = z.object({ ok: z.boolean(), note: z.string().min(1) });

function resultWith(content: string): InvokeResult {
  return { content, provider: "fake", model: "fake-model" };
}

const baseRequest: InvokeRequest = { role: "coder", prompt: "produce the thing" };

describe("SchemaValidator — first attempt succeeds", () => {
  it("returns typed data with attempts: 1 and calls invoke exactly once", async () => {
    const calls: InvokeRequest[] = [];
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      return resultWith(JSON.stringify({ ok: true, note: "fine" }));
    };

    const validator = new SchemaValidator();
    const outcome = await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    expect(outcome.attempts).toBe(1);
    expect(outcome.data).toEqual({ ok: true, note: "fine" });
    expect(outcome.result.provider).toBe("fake");
    expect(calls).toHaveLength(1);
  });
});

describe("SchemaValidator — first attempt fails schema, second succeeds (PRD §8.5#3, verbatim acceptance test)", () => {
  it("retries once, feeding the first failure into the second invoke's prompt", async () => {
    const calls: InvokeRequest[] = [];
    let call = 0;
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      call += 1;
      if (call === 1) {
        // Schema mismatch: "ok" is a string, not a boolean; "note" missing.
        return resultWith(JSON.stringify({ ok: "not-a-boolean" }));
      }
      return resultWith(JSON.stringify({ ok: true, note: "corrected" }));
    };

    const validator = new SchemaValidator();
    const outcome = await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    expect(outcome.attempts).toBe(2);
    expect(outcome.data).toEqual({ ok: true, note: "corrected" });
    expect(calls).toHaveLength(2);

    const [firstReq, secondReq] = calls;
    expect(firstReq?.prompt).toBe(baseRequest.prompt);
    // The literal acceptance condition (PRD §8.5#3): second prompt !=
    // first prompt, and contains the first attempt's error information.
    expect(secondReq?.prompt).not.toBe(firstReq?.prompt);
    expect(secondReq?.prompt.startsWith(baseRequest.prompt)).toBe(true);
    // Review Round-1 blocker 3: a bare `toContain("ok")` here is a weak
    // assertion — "ok" is itself a schema field name, so almost any
    // hardcoded retry-prompt suffix (even one that never actually echoes
    // `firstOutcome.error` back) would coincidentally satisfy it. Assert
    // instead on `schema-validator.ts`'s own error-formatting literal
    // ("response did not match schema", `tryValidate()` line 110 —
    // mirrors the parse-error branch's `toContain("valid JSON")` pattern
    // below), plus the "note" field name, which only appears here because
    // it came from the real zod issue path for the *missing* field (it
    // isn't the original prompt, the schema's own field name being
    // exercised, or any other test string).
    expect(secondReq?.prompt).toContain("response did not match schema");
    expect(secondReq?.prompt).toContain("note");
  });
});

describe("SchemaValidator — both attempts fail schema validation", () => {
  it("throws SchemaValidationError carrying both attempts' content + error detail, never returns null/undefined", async () => {
    let call = 0;
    const invoke = async (): Promise<InvokeResult> => {
      call += 1;
      return resultWith(JSON.stringify({ ok: "still-not-a-boolean", attempt: call }));
    };

    const validator = new SchemaValidator();

    await expect(
      validator.validate({ schema: TestSchema, request: baseRequest, invoke }),
    ).rejects.toBeInstanceOf(SchemaValidationError);

    // Re-run to inspect the thrown error's payload directly.
    call = 0;
    let thrown: unknown;
    try {
      await validator.validate({ schema: TestSchema, request: baseRequest, invoke });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    const error = thrown as SchemaValidationError;
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts[0]?.content).toContain("still-not-a-boolean");
    expect(error.attempts[1]?.content).toContain("still-not-a-boolean");
    expect(error.attempts[0]?.error.length).toBeGreaterThan(0);
    expect(error.attempts[1]?.error.length).toBeGreaterThan(0);
  });
});

describe("SchemaValidator — retry prompt full-output requirement (issue #45 regression)", () => {
  it("retry prompt explicitly demands a single, complete JSON object with no prose/partial content", async () => {
    const calls: InvokeRequest[] = [];
    let call = 0;
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      call += 1;
      if (call === 1) {
        return resultWith(JSON.stringify({ ok: "not-a-boolean" }));
      }
      return resultWith(JSON.stringify({ ok: true, note: "corrected" }));
    };

    const validator = new SchemaValidator();
    await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    const retryPrompt = calls[1]?.prompt ?? "";
    expect(retryPrompt).toContain("single, complete JSON object");
    expect(retryPrompt).toContain("no prose wrapper");
    expect(retryPrompt).toContain("no partial or truncated fields");
  });

  it("still fail-closed throws SchemaValidationError when the model repeats a prose-only, non-JSON response on both attempts (does not weaken validation)", async () => {
    const invoke = async (): Promise<InvokeResult> =>
      resultWith("Sure, here is a description of the fix I made, in prose, without any JSON.");

    const validator = new SchemaValidator();

    await expect(
      validator.validate({ schema: TestSchema, request: baseRequest, invoke }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it("still fail-closed throws SchemaValidationError when the model repeats a truncated/partial JSON snippet on both attempts", async () => {
    const invoke = async (): Promise<InvokeResult> => resultWith('{"ok": true, "note": "partial fix, see rest below...');

    const validator = new SchemaValidator();

    await expect(
      validator.validate({ schema: TestSchema, request: baseRequest, invoke }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

describe("SchemaValidator — first response body is not valid JSON (not a schema mismatch, a parse error)", () => {
  it("takes the same retry path as a schema mismatch, not a separate code path", async () => {
    const calls: InvokeRequest[] = [];
    let call = 0;
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      call += 1;
      if (call === 1) {
        return resultWith("not json at all {{{");
      }
      return resultWith(JSON.stringify({ ok: true, note: "recovered" }));
    };

    const validator = new SchemaValidator();
    const outcome = await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    expect(outcome.attempts).toBe(2);
    expect(outcome.data).toEqual({ ok: true, note: "recovered" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).not.toBe(calls[0]?.prompt);
    expect(calls[1]?.prompt).toContain("valid JSON");
  });
});

describe("SchemaValidator — configurable maxAttempts (issue #45 follow-up)", () => {
  it("default construction (no maxAttempts passed) still behaves as exactly 2 total attempts, same as before this option existed", async () => {
    const calls: InvokeRequest[] = [];
    let call = 0;
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      call += 1;
      if (call < 2) {
        return resultWith(JSON.stringify({ ok: "not-a-boolean" }));
      }
      return resultWith(JSON.stringify({ ok: true, note: "recovered on attempt 2" }));
    };

    const validator = new SchemaValidator();
    const outcome = await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    expect(outcome.attempts).toBe(2);
    expect(calls).toHaveLength(2);

    // And a validator that never succeeds still stops at exactly 2 attempts.
    let neverSucceedsCallCount = 0;
    const alwaysFailing = new SchemaValidator();
    await expect(
      alwaysFailing.validate({
        schema: TestSchema,
        request: baseRequest,
        invoke: async () => {
          neverSucceedsCallCount += 1;
          return resultWith(JSON.stringify({ ok: "still-not-a-boolean" }));
        },
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    expect(neverSucceedsCallCount).toBe(2);
  });

  it("maxAttempts: 3 succeeds on the third attempt, having called invoke exactly 3 times with a growing retry prompt", async () => {
    const calls: InvokeRequest[] = [];
    let call = 0;
    const invoke = async (req: InvokeRequest): Promise<InvokeResult> => {
      calls.push(req);
      call += 1;
      if (call < 3) {
        return resultWith(JSON.stringify({ ok: "not-a-boolean", attempt: call }));
      }
      return resultWith(JSON.stringify({ ok: true, note: "recovered on attempt 3" }));
    };

    const validator = new SchemaValidator({ maxAttempts: 3 });
    const outcome = await validator.validate({ schema: TestSchema, request: baseRequest, invoke });

    expect(outcome.attempts).toBe(3);
    expect(outcome.data).toEqual({ ok: true, note: "recovered on attempt 3" });
    expect(calls).toHaveLength(3);
    // Each retry prompt is strictly longer than the last, carrying forward
    // every prior failure description (not just the original prompt +
    // most-recent failure).
    expect(calls[1]?.prompt).not.toBe(calls[0]?.prompt);
    expect(calls[2]?.prompt).not.toBe(calls[1]?.prompt);
    expect(calls[2]?.prompt.length).toBeGreaterThan(calls[1]?.prompt.length ?? 0);
  });

  it("maxAttempts: 3, all 3 attempts fail — throws SchemaValidationError carrying all 3 attempts' content/error, still fail-closed (issue #45)", async () => {
    let call = 0;
    const invoke = async (): Promise<InvokeResult> => {
      call += 1;
      return resultWith(JSON.stringify({ ok: "not-a-boolean", attempt: call }));
    };

    const validator = new SchemaValidator({ maxAttempts: 3 });

    let thrown: unknown;
    try {
      await validator.validate({ schema: TestSchema, request: baseRequest, invoke });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    const error = thrown as SchemaValidationError;
    expect(error.attempts).toHaveLength(3);
    expect(call).toBe(3);
    for (const attempt of error.attempts) {
      expect(attempt.content).toContain("not-a-boolean");
      expect(attempt.error.length).toBeGreaterThan(0);
    }
  });

  it("malformed maxAttempts (0, negative, non-integer) fails closed to the default of 2, never throws and never allows more attempts", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      let call = 0;
      const invoke = async (): Promise<InvokeResult> => {
        call += 1;
        return resultWith(JSON.stringify({ ok: "not-a-boolean" }));
      };

      const validator = new SchemaValidator({ maxAttempts: bad });
      await expect(
        validator.validate({ schema: TestSchema, request: baseRequest, invoke }),
      ).rejects.toBeInstanceOf(SchemaValidationError);
      expect(call).toBe(2);
    }
  });
});
