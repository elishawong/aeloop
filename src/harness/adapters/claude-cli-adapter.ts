/**
 * `ClaudeCliAdapter` — the `kind: "cli-bridge"` `ModelAdapter` implementation
 * that shells out to `claude -p ... --output-format stream-json --verbose`
 * (A3 PRD §5, docs/feature/a3-cli-bridge/PRD.md). Spike-verified
 * (spike-findings.md §2.2): stream-json gives a clean JSONL event stream
 * with `assistant`/`tool_use` blocks paired to `user`/`tool_result` blocks
 * (by `id`/`tool_use_id`) as the real tool-call trace, and the **last**
 * `type:"result"` line's `.result` field as the final answer.
 *
 * Two flags are non-negotiable, both spike-verified footguns
 * (spike-findings.md §2.4):
 *   - `--verbose` is *required* alongside `--output-format stream-json`
 *     under `-p` — omitting it makes the CLI itself hard-error before
 *     producing any output at all.
 *   - `--permission-mode bypassPermissions` is required for portable
 *     non-interactive behavior — without it, whether tool calls succeed
 *     depends on whatever permission state happens to already be
 *     configured in the calling environment, which can silently hang
 *     waiting for an approval that will never come non-interactively.
 *
 * `--allowedTools "Bash,Read,Grep,Glob"` is a fixed, read-only-equivalent
 * tool allowlist (mirrors codex's `--sandbox read-only` posture) — a
 * coder's product is a diff *string* (`CoderOutput.diff`), not direct file
 * mutation via the CLI itself (PRD §2 non-goals). **Honest limitation**
 * (PRD §5): this is claude's *permission* layer, not an OS-level sandbox
 * like codex's `--sandbox` — `Bash` being "allowed" doesn't mean it's
 * jailed to read-only actions, only that the model isn't blocked from
 * invoking it.
 */
import { AdapterInvokeError } from "../errors.js";
import { spawnWithTimeout } from "../cli-exec.js";
import { checkToolExecution } from "../tool-exec-verifier.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter, ToolCallRecord } from "../types.js";

/** Same constant as `CodexCliAdapter` — mirrors `codex-client.mjs`'s own default, no known need yet to vary per role/provider (PRD §9.2). */
const DEFAULT_TIMEOUT_MS = 600_000;

/** `checkAvailability()` is a lightweight `--version` probe, not a real invoke. */
const AVAILABILITY_TIMEOUT_MS = 10_000;

/** Read-only-equivalent tool allowlist (see file header). */
const ALLOWED_TOOLS = "Bash,Read,Grep,Glob";

export interface ClaudeCliAdapterConfig {
  /** Binary name/path handed straight to `spawn` — defaults to `"claude"` (resolved via `PATH`, same as any other bare command). */
  cmd?: string;
}

/** One `stream-json` JSONL line's shape, as much of it as this file reads. `[key: string]: unknown` lets a whole content block be stored verbatim in `ToolCallRecord.raw` without a second cast. */
interface ClaudeJsonlEvent {
  type?: unknown;
  subtype?: unknown;
  model?: unknown;
  message?: { content?: unknown; [key: string]: unknown };
  result?: unknown;
  is_error?: unknown;
  [key: string]: unknown;
}

export class ClaudeCliAdapter implements ModelAdapter {
  readonly kind = "cli-bridge" as const;
  private readonly cmd: string;

  /**
   * Most recent `invoke()` call's trace — reset to `[]` at the start of
   * every `invoke()`, read back by `toolTrace()`. **Known limitation**
   * (PRD §5, same as `CodexCliAdapter`): shared, mutable state on the
   * adapter instance — concurrent `invoke()` calls on the *same* instance
   * would race on it. v1 doesn't handle that; aeloop's coder→tester loop
   * calls adapters sequentially, not concurrently.
   */
  private lastTrace: ToolCallRecord[] = [];

  constructor(
    readonly id: string,
    config: ClaudeCliAdapterConfig = {},
  ) {
    this.cmd = config.cmd || "claude";
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.lastTrace = [];

    const result = await spawnWithTimeout(
      this.cmd,
      [
        "-p",
        req.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        ALLOWED_TOOLS,
      ],
      { timeoutMs: DEFAULT_TIMEOUT_MS },
    );

    if (result.spawnError !== null) {
      throw new AdapterInvokeError(`ClaudeCliAdapter "${this.id}" could not spawn "${this.cmd}"`, {
        cause: new Error(result.spawnError),
      });
    }
    if (result.timedOut) {
      throw new AdapterInvokeError(`ClaudeCliAdapter "${this.id}" timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    }
    if (result.exitCode !== 0) {
      throw new AdapterInvokeError(
        `ClaudeCliAdapter "${this.id}" exited with code ${String(result.exitCode)}` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : ""),
      );
    }

    const events = parseJsonlEvents(result.stdout);
    const trace = extractTrace(events);
    this.lastTrace = trace;

    const resultEvent = extractLastResultEvent(events);
    if (resultEvent === undefined) {
      throw new AdapterInvokeError(`ClaudeCliAdapter "${this.id}" produced no "result" event in its stream-json output`);
    }
    if (resultEvent.subtype !== "success" || resultEvent.is_error === true) {
      throw new AdapterInvokeError(
        `ClaudeCliAdapter "${this.id}" reported failure (subtype=${String(resultEvent.subtype)}, is_error=${String(resultEvent.is_error)})`,
      );
    }
    if (typeof resultEvent.result !== "string") {
      throw new AdapterInvokeError(`ClaudeCliAdapter "${this.id}"'s "result" event had no string "result" field`);
    }
    const content = resultEvent.result;

    return {
      content,
      provider: this.id,
      // From the stream's `system`/`subtype:"init"` event, present at the
      // very start of every stream (even tool-free ones) — spike-verified
      // more reliable than digging through individual assistant messages.
      // Falls back to "unknown" (never invented) when absent, same
      // honesty posture as CodexCliAdapter's model field (PRD §5).
      model: extractModel(events) ?? "unknown",
      toolExecChecked: checkToolExecution(content, trace),
    };
  }

  /**
   * Real `<cmd> --version` probe, exit code 0 → available (DESIGN §8.5
   * "deepseek 列表可见≠可调用" lesson, same posture as `CodexCliAdapter`/
   * `LiteLLMAdapter`).
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

/** Tolerant line-by-line JSONL parse — a line that doesn't parse is skipped, not fatal. */
function parseJsonlEvents(stdout: string): ClaudeJsonlEvent[] {
  const events: ClaudeJsonlEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ClaudeJsonlEvent);
    } catch {
      continue;
    }
  }
  return events;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pairs every `assistant`/`tool_use` content block with its matching
 * `user`/`tool_result` block (by `id`/`tool_use_id`), in `tool_use`
 * emission order — that order is `sequenceIndex` (spike-findings.md §1.4's
 * "trace before the final claim" ordering requirement, same reasoning as
 * `CodexCliAdapter`). A `tool_use` with no matching `tool_result` (e.g. the
 * turn ended mid-call) gets `succeeded: undefined` rather than a guessed
 * boolean.
 */
function extractTrace(events: ClaudeJsonlEvent[]): ToolCallRecord[] {
  const toolUses: Array<{ id: string; name: string; block: Record<string, unknown> }> = [];
  const toolResultsById = new Map<string, Record<string, unknown>>();

  for (const event of events) {
    const blocks = Array.isArray(event.message?.content) ? (event.message.content as unknown[]) : [];

    if (event.type === "assistant") {
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block["type"] === "tool_use" && typeof block["id"] === "string" && typeof block["name"] === "string") {
          toolUses.push({ id: block["id"], name: block["name"], block });
        }
      }
    } else if (event.type === "user") {
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
          toolResultsById.set(block["tool_use_id"], block);
        }
      }
    }
  }

  return toolUses.map((toolUse, index) => {
    const toolResult = toolResultsById.get(toolUse.id);
    return {
      toolName: toolUse.name,
      sequenceIndex: index,
      succeeded: toolResult ? toolResult["is_error"] === false : undefined,
      raw: toolResult ? { tool_use: toolUse.block, tool_result: toolResult } : { tool_use: toolUse.block },
    };
  });
}

/** The **last** `type:"result"` line — that's the whole turn's authoritative outcome (only one is ever expected per invoke, but "last" is the same defensive posture as codex's "last agent_message"). `undefined` when the stream never had one. */
function extractLastResultEvent(events: ClaudeJsonlEvent[]): ClaudeJsonlEvent | undefined {
  let last: ClaudeJsonlEvent | undefined;
  for (const event of events) {
    if (event.type === "result") last = event;
  }
  return last;
}

/** `type:"system"`/`subtype:"init"` event's `.model` field — present at the very start of every stream, even a tool-free one. */
function extractModel(events: ClaudeJsonlEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string" && event.model.trim().length > 0) {
      return event.model;
    }
  }
  return undefined;
}
