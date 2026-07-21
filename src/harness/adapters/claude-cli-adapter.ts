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
 * **`--allowedTools "Bash,Read,Grep,Glob"` is NOT a read-only allowlist —
 * correction (2026-07-21, Zorro + Codex `gpt-5.6-sol` independent
 * re-review, `docs/feature/a5-cli-tui/test-report.md` P0-1, tracked at
 * [elishawong/aeloop#31](https://github.com/elishawong/aeloop/issues/31),
 * PRD §0 has the full account)**: an earlier version of this comment
 * claimed this was "a fixed, read-only-equivalent tool allowlist (mirrors
 * codex's `--sandbox read-only` posture)". That was factually wrong and has
 * been struck. This class starts the coder with `--permission-mode
 * bypassPermissions`, and `Bash` is not a read-only tool — `sed -i`, shell
 * redirection, and `git apply` can all write to disk through it; `Read`/
 * `Grep`/`Glob` being read-only doesn't make the *allowlist* read-only when
 * `Bash` is also in it. Concretely: the coder role can already have written
 * real changes to the target repository before a human ever sees an A5 G1
 * gate's rendered diff and approves it — `applyNode()`'s empty-shell
 * implementation (`graph.ts`, DESIGN §4's "Apply" state, downgraded per A4a
 * PRD §0/§2) only guarantees the *engine* never applies `CoderOutput.diff`
 * itself; it does nothing to stop the coder from having already mutated the
 * filesystem directly via `Bash` during its own invocation. This is a
 * known, currently-unfixed limitation of this adapter (tracked at
 * aeloop#31) — the fix, when it lands, belongs in this file's
 * permission/tool configuration, not in `applyNode()` or A5's `src/cli/`
 * layer.
 */
import { AdapterInvokeError } from "../errors.js";
import { spawnWithTimeout } from "../cli-exec.js";
import { checkToolExecution } from "../tool-exec-verifier.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter, ToolCallRecord } from "../types.js";

/** Same constant as `CodexCliAdapter` — mirrors `codex-client.mjs`'s own default, no known need yet to vary per role/provider (PRD §9.2). */
const DEFAULT_TIMEOUT_MS = 600_000;

/** `checkAvailability()` is a lightweight `--version` probe, not a real invoke. */
const AVAILABILITY_TIMEOUT_MS = 10_000;

/** Tool allowlist — includes `Bash`, so NOT read-only (see file header's P0-1 correction, aeloop#31). */
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
    const providerId = this.requireProviderId();

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
    // Review Round-1 minor Y1: require is_error === false explicitly, not
    // merely "!== true" — the previous check let a missing/null/non-boolean
    // is_error field sail through as "success" (only a literal `true`
    // tripped it), which is the wrong default for a field whose entire
    // purpose is signaling failure. A response that never says is_error at
    // all should not be trusted as success by omission.
    if (resultEvent.subtype !== "success" || resultEvent.is_error !== false) {
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
      provider: providerId,
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
   * "deepseek listed ≠ callable" lesson, same posture as `CodexCliAdapter`/
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

  /**
   * `id` is typed as a non-optional `string` in the constructor, so this is
   * belt-and-suspenders rather than a case that should ever trip in
   * practice (`config.ts` always passes the provider's own map key as
   * `id`) — but `InvokeResult.provider` carries the same non-empty
   * invariant as `.model` (`types.ts:72`), so it gets the same runtime
   * guard rather than trusting the type alone (mirrors
   * `LiteLLMAdapter.requireProviderId()`, A2's Review Round-1 blocker 2 —
   * this adapter didn't inherit that fix, A3's Review Round-1 blocker B2).
   */
  private requireProviderId(): string {
    if (typeof this.id !== "string" || this.id.trim().length === 0) {
      throw new AdapterInvokeError("ClaudeCliAdapter constructed with an empty/missing provider id");
    }
    return this.id;
  }
}

/**
 * Tolerant line-by-line JSONL parse — a line that doesn't parse, or that
 * parses to something other than a plain object (e.g. `"null"`, a bare
 * number/string, or an array), is skipped, not fatal. **Review Round-1
 * minor Y2**: `JSON.parse` alone accepts any valid JSON value, not just
 * objects — a stray `null`/scalar/array line used to sail through as a
 * "ClaudeJsonlEvent" with no `.type` property, and every downstream read
 * of `event.type`/`event.message` would throw a raw `TypeError` on it
 * (e.g. `null.type`), escaping the `AdapterInvokeError`-only contract this
 * file otherwise holds. Filtering to plain objects here means every event
 * this function returns is at least safe to read `.type` off of.
 */
function parseJsonlEvents(stdout: string): ClaudeJsonlEvent[] {
  const events: ClaudeJsonlEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    events.push(parsed as ClaudeJsonlEvent);
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
