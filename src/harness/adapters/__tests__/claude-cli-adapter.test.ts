/**
 * `ClaudeCliAdapter` tests (A3 PRD §5/§6). Every test here points `cmd` at
 * `fixtures/fake-claude.fixture.mjs` — a real, controlled child process the
 * adapter really `spawn()`s and really parses the real stdout of — never
 * at the real `claude` binary (A3 PRD §2 non-goals: no real CLI in the
 * automated test suite). Structurally mirrors `codex-cli-adapter.test.ts`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterInvokeError } from "../../errors.js";
import { ClaudeCliAdapter } from "../claude-cli-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-claude.fixture.mjs");
const NONEXISTENT_BINARY = "/nonexistent/path/definitely-not-a-real-binary-xyz";
const ENV_KEY = "FAKE_CLAUDE_SCENARIO";

/**
 * The fixture reads its scenario from `FAKE_CLAUDE_SCENARIO` (inherited via
 * `spawnWithTimeout`'s default `spawn` behavior of passing through
 * `process.env`). Always restored after each use so it can't leak into
 * other test files sharing this worker process.
 */
function withScenario<T>(scenario: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = scenario;
  return fn().finally(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });
}

describe("ClaudeCliAdapter", () => {
  it('has kind "cli-bridge" and carries the given id', () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    expect(adapter.kind).toBe("cli-bridge");
    expect(adapter.id).toBe("claude-cli");
  });

  it("toolTrace() is an empty array before any invoke() has been made", () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    expect(adapter.toolTrace()).toEqual([]);
  });

  it("① tool-call scenario: toolTrace() extracts Bash then Read, in the correct order, paired with their results", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("with-tools", () => adapter.invoke({ role: "coder", prompt: "list files" }));

    expect(result.content).toContain("fileB.txt (25 bytes) contains: `hello world spike file B`");
    expect(result.provider).toBe("claude-cli");

    const trace = adapter.toolTrace();
    expect(trace).toHaveLength(2);
    expect(trace[0]?.toolName).toBe("Bash");
    expect(trace[0]?.sequenceIndex).toBe(0);
    expect(trace[0]?.succeeded).toBe(true);
    expect(trace[1]?.toolName).toBe("Read");
    expect(trace[1]?.sequenceIndex).toBe(1);
  });

  it("② negative control (no tool calls) — spike never independently ran this (spike-findings.md §3.1); this test closes that gap (PRD §0 decision 3): toolTrace() is empty", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("no-tools", () => adapter.invoke({ role: "coder", prompt: "just say hello" }));

    expect(result.content).toBe("Hello!");
    expect(adapter.toolTrace()).toEqual([]);
  });

  it('③ toolExecChecked is "fail" when the response claims tool_execution but the trace is empty — mirrors the codex-side test, real adapter layer', async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("claims-no-trace", () =>
      adapter.invoke({ role: "coder", prompt: "irrelevant" }),
    );

    expect(result.toolExecChecked).toBe("fail");
    expect(adapter.toolTrace()).toEqual([]);
  });

  it("④ model is extracted from the system/init event's .model field, not invented", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("with-tools", () => adapter.invoke({ role: "coder", prompt: "list files" }));

    expect(result.model).toBe("claude-sonnet-5");
  });

  it("model falls back to \"unknown\" (never invented) when the stream has no system/init event", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("no-init-event", () => adapter.invoke({ role: "coder", prompt: "hi" }));

    expect(result.model).toBe("unknown");
  });

  it("⑤ checkAvailability() really spawns --version and reports available:true on exit 0", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(true);
    expect(result.checkedAt).toBeTruthy();
  });

  it("checkAvailability() reports available:false with a reason for a binary that isn't runnable", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: NONEXISTENT_BINARY });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("⑥a a non-zero exit is wrapped as AdapterInvokeError, never a raw/uncaught error", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    await expect(withScenario("error", () => adapter.invoke({ role: "coder", prompt: "x" }))).rejects.toBeInstanceOf(
      AdapterInvokeError,
    );
  });

  it("⑥b a binary that can't be spawned at all (not on PATH) is wrapped as AdapterInvokeError", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: NONEXISTENT_BINARY });

    await expect(adapter.invoke({ role: "coder", prompt: "x" })).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("a result event that reports failure (subtype/is_error), even with exit code 0, is wrapped as AdapterInvokeError", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    await expect(
      withScenario("result-error", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("a stream that never emits a result event is wrapped as AdapterInvokeError, not returned as silent empty content", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    await expect(
      withScenario("no-result-event", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  // Zorro A3 round-1 regression tests (blocker B2, minor Y1, minor Y2).

  it('B2 regression: an adapter constructed with an empty provider id throws AdapterInvokeError on invoke(), never returns provider:""', async () => {
    const adapter = new ClaudeCliAdapter("", { cmd: FIXTURE });

    await expect(
      withScenario("with-tools", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("B2 regression: an adapter constructed with a whitespace-only provider id is treated the same as empty", async () => {
    const adapter = new ClaudeCliAdapter("   ", { cmd: FIXTURE });

    await expect(
      withScenario("with-tools", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it('Y1 regression: a "result" event with subtype:"success" but a missing (not false) is_error field is treated as failure, not success by omission', async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    await expect(
      withScenario("result-is-error-missing", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("Y2 regression: a raw non-object JSONL line (e.g. a bare `null`) mixed into otherwise-valid output is skipped, not a crash escaping the AdapterInvokeError contract", async () => {
    const adapter = new ClaudeCliAdapter("claude-cli", { cmd: FIXTURE });

    const result = await withScenario("null-line-then-hello", () =>
      adapter.invoke({ role: "coder", prompt: "x" }),
    );

    expect(result.content).toBe("Hello despite the null line!");
  });
});
