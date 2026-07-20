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
    // Zorro round-1 blocker 3: a bare `toContain("ok")` here is a weak
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
    expect(error.attempts[0].content).toContain("still-not-a-boolean");
    expect(error.attempts[1].content).toContain("still-not-a-boolean");
    expect(error.attempts[0].error.length).toBeGreaterThan(0);
    expect(error.attempts[1].error.length).toBeGreaterThan(0);
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
