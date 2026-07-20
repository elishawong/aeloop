/**
 * `CodexCliAdapter` tests (A3 PRD §5/§6). Every test here points `cmd` at
 * `fixtures/fake-codex.fixture.mjs` — a real, controlled child process the
 * adapter really `spawn()`s and really parses the real stdout of — never
 * at the real `codex` binary (A3 PRD §2 non-goals: no real CLI in the
 * automated test suite). `cli-exec.test.ts` already covers the generic
 * spawn/timeout/kill machinery with an injected fake spawn; this file's
 * job is proving CodexCliAdapter correctly parses what a real child
 * process prints, so it deliberately does NOT inject `spawnImpl` — that
 * would test a re-implementation of the parser against itself, not the
 * real spawn→parse path.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AdapterInvokeError } from "../../errors.js";
import { CodexCliAdapter } from "../codex-cli-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "fake-codex.fixture.mjs");
const NONEXISTENT_BINARY = "/nonexistent/path/definitely-not-a-real-binary-xyz";
const ENV_KEY = "FAKE_CODEX_SCENARIO";

/**
 * The fixture reads its scenario from `FAKE_CODEX_SCENARIO` (inherited via
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

describe("CodexCliAdapter", () => {
  it('has kind "cli-bridge" and carries the given id', () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    expect(adapter.kind).toBe("cli-bridge");
    expect(adapter.id).toBe("codex-cli");
  });

  it("toolTrace() is an empty array before any invoke() has been made", () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    expect(adapter.toolTrace()).toEqual([]);
  });

  it("① tool-call scenario: toolTrace() has one shell record and content is the LAST agent_message (spike §1.4's mid-turn-correction lesson)", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    const result = await withScenario("with-tools", () => adapter.invoke({ role: "coder", prompt: "list files" }));

    expect(result.content).toContain('`fileB.txt` says: "hello world spike file B"');
    expect(result.provider).toBe("codex-cli");
    expect(result.model).toBe("unknown"); // ⑥ — codex --json carries no model field (PRD §9.3)

    const trace = adapter.toolTrace();
    expect(trace).toHaveLength(1);
    expect(trace[0]?.toolName).toBe("shell");
    expect(trace[0]?.succeeded).toBe(true);
    expect(trace[0]?.sequenceIndex).toBe(0);
    expect(trace[0]?.raw).toMatchObject({ type: "command_execution", exit_code: 0 });
  });

  it("② negative control (no tool calls): toolTrace() is empty, content is the plain-text answer", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    const result = await withScenario("no-tools", () => adapter.invoke({ role: "coder", prompt: "just say hello" }));

    expect(result.content).toBe("Hello!");
    expect(adapter.toolTrace()).toEqual([]);
  });

  it('③ toolExecChecked is "fail" when the response claims tool_execution but the trace is empty — the core 声称≠行为 path, exercised at the real adapter layer', async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    const result = await withScenario("claims-no-trace", () =>
      adapter.invoke({ role: "coder", prompt: "irrelevant" }),
    );

    expect(result.toolExecChecked).toBe("fail");
    expect(adapter.toolTrace()).toEqual([]);
  });

  it("④a a non-zero exit is wrapped as AdapterInvokeError, never a raw/uncaught error", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    await expect(withScenario("error", () => adapter.invoke({ role: "coder", prompt: "x" }))).rejects.toBeInstanceOf(
      AdapterInvokeError,
    );
  });

  it("④b a binary that can't be spawned at all (not on PATH) is wrapped as AdapterInvokeError", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: NONEXISTENT_BINARY });

    await expect(adapter.invoke({ role: "coder", prompt: "x" })).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("a turn that never emits an agent_message is wrapped as AdapterInvokeError, not returned as silent empty content", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    await expect(
      withScenario("no-agent-message", () => adapter.invoke({ role: "coder", prompt: "x" })),
    ).rejects.toBeInstanceOf(AdapterInvokeError);
  });

  it("⑤ checkAvailability() really spawns --version and reports available:true on exit 0 (not a config-presence check)", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: FIXTURE });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(true);
    expect(result.checkedAt).toBeTruthy();
  });

  it("checkAvailability() reports available:false with a reason for a binary that isn't runnable", async () => {
    const adapter = new CodexCliAdapter("codex-cli", { cmd: NONEXISTENT_BINARY });

    const result = await adapter.checkAvailability();

    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
