/**
 * `CodexCliAdapter` — the `kind: "cli-bridge"` `ModelAdapter` implementation
 * that shells out to `codex exec --json` (A3 PRD §5, docs/feature/
 * a3-cli-bridge/PRD.md). Spike-verified (spike-findings.md §1.3/§1.4):
 * `--json` gives a clean JSONL event stream on stdout (noise like the
 * "Reading additional input from stdin..." banner and MCP transport errors
 * land on stderr instead — `spawnWithTimeout` keeps them separate, this
 * file never merges them either), with `item.completed`/
 * `item.type==="command_execution"` events as the real tool-call trace and
 * the **last** `item.completed`/`item.type==="agent_message"` as the final
 * answer (not any earlier one — spike-findings.md §1.4 found codex can
 * self-correct mid-turn, e.g. an early `agent_message` claiming
 * `tools_used:[]` before it has actually run anything, with the true
 * answer only landing in the last one).
 *
 * Does **not** pass `--skip-git-repo-check` (spike-only flag, needed there
 * because the test directory wasn't a git repo; production always runs
 * inside a real repo) and does **not** pass `-m`/`--model` (v1 uses
 * whatever model the `codex` CLI itself is already configured to use, PRD
 * §2 non-goals).
 */
import { AdapterInvokeError } from "../errors.js";
import { spawnWithTimeout } from "../cli-exec.js";
import { checkToolExecution } from "../tool-exec-verifier.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter, ToolCallRecord } from "../types.js";

/**
 * Mirrors `scripts/openai/codex-client.mjs`'s own default (`DEFAULT_TIMEOUT_SEC
 * = 600`) — review prompts run long there; aeloop's coder/tester prompts
 * carry full context injections too, similar order of magnitude. Hardcoded
 * v1 constant, not a `config.yaml` knob (PRD §9.2 — no known need yet to
 * vary this per role/provider).
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** `checkAvailability()` is a lightweight `--version` probe, not a real invoke — a short timeout is enough and keeps a hung/misconfigured binary from blocking availability checks for minutes. */
const AVAILABILITY_TIMEOUT_MS = 10_000;

export interface CodexCliAdapterConfig {
  /** Binary name/path handed straight to `spawn` — defaults to `"codex"` (resolved via `PATH`, same as any other bare command). */
  cmd?: string;
}

/** One `--json` JSONL line's shape, as much of it as this file reads. `[key: string]: unknown` lets a whole event/item be stored verbatim as `ToolCallRecord.raw` without a second cast. */
interface CodexJsonlItem {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  command?: unknown;
  aggregated_output?: unknown;
  exit_code?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface CodexJsonlEvent {
  type?: unknown;
  item?: CodexJsonlItem;
  [key: string]: unknown;
}

export class CodexCliAdapter implements ModelAdapter {
  readonly kind = "cli-bridge" as const;
  private readonly cmd: string;

  /**
   * Most recent `invoke()` call's trace — reset to `[]` at the start of
   * every `invoke()`, read back by `toolTrace()`. **Known limitation**
   * (PRD §5): this is shared, mutable state on the adapter instance;
   * concurrent `invoke()` calls on the *same* instance would race on it.
   * v1 doesn't handle that — aeloop's coder→tester loop calls adapters
   * sequentially, not concurrently, so this isn't exercised in practice
   * today. If that changes, the trace belongs on `InvokeResult` itself,
   * not behind a stateful query method — that's an interface-level change
   * out of A3's scope.
   */
  private lastTrace: ToolCallRecord[] = [];

  constructor(
    readonly id: string,
    config: CodexCliAdapterConfig = {},
  ) {
    this.cmd = config.cmd || "codex";
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.lastTrace = [];

    const result = await spawnWithTimeout(this.cmd, ["exec", "--json", "--sandbox", "read-only", req.prompt], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });

    if (result.spawnError !== null) {
      throw new AdapterInvokeError(`CodexCliAdapter "${this.id}" could not spawn "${this.cmd}"`, {
        cause: new Error(result.spawnError),
      });
    }
    if (result.timedOut) {
      throw new AdapterInvokeError(`CodexCliAdapter "${this.id}" timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    if (result.exitCode !== 0) {
      throw new AdapterInvokeError(
        `CodexCliAdapter "${this.id}" exited with code ${String(result.exitCode)}` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
      );
    }

    const events = parseJsonlEvents(result.stdout);
    const trace = extractTrace(events);
    this.lastTrace = trace;

    const content = extractLastAgentMessageText(events);
    if (content === undefined) {
      throw new AdapterInvokeError(`CodexCliAdapter "${this.id}" produced no agent_message in its --json output`);
    }

    return {
      content,
      provider: this.id,
      // `codex exec --json`'s JSONL stream never carries a `model` field —
      // verified by re-grepping every `--json` sample the spike captured,
      // zero hits (`model: ...` only appears in the plain-text banner,
      // which `--json` mode doesn't print). Mirrors `codex-client.mjs`'s
      // own `model ?? 'unknown'` fallback convention. PRD §9.3.
      model: "unknown",
      toolExecChecked: checkToolExecution(content, trace),
    };
  }

  /**
   * Real `<cmd> --version` probe, exit code 0 → available — not a check
   * that `cmd` is merely configured (DESIGN §8.5 "deepseek 列表可见≠可调用"
   * lesson, same posture `LiteLLMAdapter.checkAvailability()` already
   * takes for the direct-api side).
   */
  async checkAvailability(): Promise<AvailabilityResult> {
    const checkedAt = new Date().toISOString();
    const result = await spawnWithTimeout(this.cmd, ["--version"], { timeoutMs: AVAILABILITY_TIMEOUT_MS });

    if (result.spawnError !== null) {
      return { available: false, reason: `"${this.cmd}" not runnable: ${result.spawnError}`, checkedAt };
    }
    if (result.timedOut) {
      return { available: false, reason: `"${this.cmd} --version" timed out`, checkedAt };
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        reason: `"${this.cmd} --version" exited with code ${String(result.exitCode)}`,
        checkedAt,
      };
    }
    return { available: true, checkedAt };
  }

  toolTrace(): ToolCallRecord[] {
    return this.lastTrace;
  }
}

/** Tolerant line-by-line JSONL parse — a line that doesn't parse is skipped, not fatal (mirrors `ToolExecVerifier`'s own "don't throw on malformed input" posture; codex's own banner/warnings have a small chance of leaking a non-JSON line into stdout). */
function parseJsonlEvents(stdout: string): CodexJsonlEvent[] {
  const events: CodexJsonlEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexJsonlEvent);
    } catch {
      continue;
    }
  }
  return events;
}

/** All `item.completed`/`command_execution` events, in stream order, mapped to the uniform `ToolCallRecord` shape (`types.ts`). */
function extractTrace(events: CodexJsonlEvent[]): ToolCallRecord[] {
  const trace: ToolCallRecord[] = [];
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (!item || item.type !== "command_execution") continue;
    trace.push({
      toolName: "shell",
      sequenceIndex: trace.length,
      succeeded: item.exit_code === 0,
      raw: item,
    });
  }
  return trace;
}

/** The **last** `item.completed`/`agent_message` event's `text` — not the first, per spike-findings.md §1.4's mid-turn self-correction finding. `undefined` when the stream never had one (an anomalous/empty response). */
function extractLastAgentMessageText(events: CodexJsonlEvent[]): string | undefined {
  let last: string | undefined;
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (!item || item.type !== "agent_message") continue;
    if (typeof item.text === "string") last = item.text;
  }
  return last;
}
