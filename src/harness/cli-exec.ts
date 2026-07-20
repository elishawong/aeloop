/**
 * `spawnWithTimeout` — the CLI-agnostic subprocess execution primitive both
 * `CodexCliAdapter` and `ClaudeCliAdapter` (A3, docs/feature/a3-cli-bridge/
 * PRD.md §5) build on top of. Knows nothing about codex/claude argv shapes
 * or JSONL parsing — just "run a command, reliably get its output back,
 * never hang".
 *
 * Mirrors the parts of `scripts/openai/codex-client.mjs`'s `runCodexReview`
 * that are genuinely CLI-agnostic and already hard-won there:
 *   - wall-clock timeout + `SIGKILL`, never hangs;
 *   - **immediately** closing stdin (`child.stdin.end()`) — `codex exec`
 *     blocks reading a non-TTY stdin otherwise (spike-findings.md §1.6,
 *     independently reproduced in a raw command-line test, not just a
 *     theoretical risk); done defensively for `claude -p` too;
 *   - a byte cap on collected output, guarding against an unbounded memory
 *     blow-up on a runaway/misbehaving child process.
 *
 * Deliberately does **not** port `codex-client.mjs`'s git-HEAD / tracked-
 * file content-hash integrity checks, or its "reject an untrusted binary
 * path" check (that file's safety invariant ⑤). Those defend one specific,
 * high-stakes trust boundary — Zorro's independent-review evidence chain,
 * where a forged `codex` binary could fool a human into approving bad code
 * — that A3's ordinary coder/tester adapters don't have a direct analog
 * for. Flagged as an open question for confirmation in A3 PRD §2 (non-
 * goals) / §9.1, not silently dropped.
 *
 * Crucially, **stdout and stderr are kept separate** in the result — never
 * merged (`out + '\n' + err`) the way `codex-client.mjs` does. That merge
 * is safe there because it treats the whole thing as one opaque human-
 * readable string; A3's adapters need to `JSON.parse` each stdout line as
 * JSONL, and stderr carries real non-JSON noise (codex's "Reading
 * additional input from stdin..." banner, MCP transport errors) that would
 * corrupt that parse if merged in (spike-findings.md §1.5, verified with a
 * real stdout/stderr-separated capture).
 */

import { spawn } from "node:child_process";

/**
 * 32MB cap, applied **independently per stream** (stdout gets its own
 * 32MB budget, stderr gets its own separate 32MB budget — not a combined
 * 32MB across both) — mirrors `codex-client.mjs`'s `MAX_OUTPUT_BYTES`,
 * guards against an unbounded memory blow-up on a runaway child. Exported
 * so `cli-exec.test.ts` can assert against the real cap value directly
 * (Zorro round-1 minor Y3's regression test) instead of duplicating the
 * magic number and risking drift.
 */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Appends `chunk` via `append`, but truncates it to whatever budget
 * remains under `MAX_OUTPUT_BYTES` rather than ever letting the running
 * total cross the cap — returns the new running byte total. **Zorro
 * round-1 minor Y3**: the previous logic only checked "is the running
 * total already under the cap?" *before* deciding whether to append a
 * chunk whole; once under the cap by even one byte, an entire chunk
 * (however large) was appended unconditionally, so a stream could end up
 * well past 32MB in practice (e.g. 31MB collected + one 10MB chunk → 41MB
 * appended, cap never actually enforced past the first check). This
 * enforces the cap as a true ceiling on the accumulated byte budget: the
 * collected byte total for a given stream never exceeds `MAX_OUTPUT_BYTES`,
 * no matter how the data arrives chunked.
 *
 * Truncation happens on a byte boundary (via `Buffer`, not a raw string
 * slice, since JS string indices are UTF-16 code units, not bytes) — a
 * multi-byte UTF-8 character split mid-sequence at the truncation point
 * decodes lossy (Node's default replacement-character behavior for an
 * incomplete UTF-8 tail), not a crash. (Because the incomplete tail
 * decodes to U+FFFD, the *decoded string* can re-encode to at most ~2
 * bytes over the cap — negligible against a 32MB ceiling; the collected
 * byte budget above is what stays strictly bounded.) That's an acceptable,
 * honestly-documented simplification for a safety cap whose job is "never
 * blow up memory", not "byte-perfect preservation of the last few
 * characters before truncation".
 */
function appendWithinBudget(chunk: string, append: (s: string) => void, bytesSoFar: number): number {
  if (bytesSoFar >= MAX_OUTPUT_BYTES) return bytesSoFar; // already at/over cap — drop entirely
  const chunkBytes = Buffer.byteLength(chunk);
  const remaining = MAX_OUTPUT_BYTES - bytesSoFar;
  if (chunkBytes <= remaining) {
    append(chunk);
    return bytesSoFar + chunkBytes;
  }
  const truncated = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
  append(truncated);
  return MAX_OUTPUT_BYTES; // budget now fully consumed — every later chunk is dropped entirely
}

/**
 * The minimal shape `spawnWithTimeout` needs from a spawned child process —
 * deliberately narrower than Node's full `ChildProcess` type, so a test's
 * fake child (a plain `EventEmitter` with a couple of extra properties,
 * mirroring `codex-client.test.mjs`'s `mockSpawn`/`makeFakeChild` pattern)
 * can satisfy this interface without implementing dozens of unused
 * `ChildProcess` members.
 */
export interface MinimalSpawnedProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnImpl = (
  cmd: string,
  args: string[],
  options: { cwd: string | undefined; stdio: Array<"pipe"> },
) => MinimalSpawnedProcess;

function defaultSpawnImpl(
  cmd: string,
  args: string[],
  options: { cwd: string | undefined; stdio: Array<"pipe"> },
): MinimalSpawnedProcess {
  return spawn(cmd, args, options) as unknown as MinimalSpawnedProcess;
}

export interface SpawnWithTimeoutOptions {
  /** Wall-clock timeout in milliseconds. Required — there is no "wait forever" mode (neither `codex`/`claude` has a built-in timeout flag, PRD §5; this is the only backstop). */
  timeoutMs: number;
  /** Working directory for the child process. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Injection point for tests (mirrors `codex-client.mjs`'s `spawnImpl`
   * pattern) — a fake `spawn` returning a `MinimalSpawnedProcess`-shaped
   * fake child, so timeout/kill/stdin-close mechanics are testable without
   * a real subprocess. Defaults to `node:child_process`'s real `spawn`.
   */
  spawnImpl?: SpawnImpl;
}

export interface SpawnWithTimeoutResult {
  /** Process exit code, or `null` when the process never produced one (killed by signal, or never actually started — see `spawnError`). */
  exitCode: number | null;
  /** Signal that terminated the process (e.g. `"SIGKILL"` on timeout), or `null` if it exited normally / never started. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** `true` when the wall-clock timeout fired and the process was `SIGKILL`ed before it produced a `close` event on its own. */
  timedOut: boolean;
  /**
   * Set when the child process itself could never be spawned/run (e.g. the
   * binary isn't on `PATH` — Node's `ENOENT` `error` event) — distinct
   * from "the process ran and exited non-zero". `null` when spawning
   * succeeded, regardless of the eventual exit code.
   */
  spawnError: string | null;
}

export function spawnWithTimeout(
  cmd: string,
  args: string[],
  opts: SpawnWithTimeoutOptions,
): Promise<SpawnWithTimeoutResult> {
  const spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (partial: Omit<SpawnWithTimeoutResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...partial, stdout, stderr });
    };

    let child: MinimalSpawnedProcess;
    try {
      child = spawnImpl(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      finish({ exitCode: null, signal: null, timedOut: false, spawnError: describeSpawnError(e) });
      return;
    }

    // Never hang: explicit wall-clock timer, SIGKILL on fire. `unref()` so
    // this timer alone never keeps the host process alive.
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited — ignore */
      }
      finish({ exitCode: null, signal: "SIGKILL", timedOut: true, spawnError: null });
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }

    child.on("error", (e) => {
      finish({ exitCode: null, signal: null, timedOut: false, spawnError: describeSpawnError(e) });
    });

    if (child.stdout) {
      collectStream(child.stdout, (s) => {
        stdoutBytes = appendWithinBudget(s, (piece) => (stdout += piece), stdoutBytes);
      });
    }
    if (child.stderr) {
      collectStream(child.stderr, (s) => {
        stderrBytes = appendWithinBudget(s, (piece) => (stderr += piece), stderrBytes);
      });
    }

    // Critical: give stdin EOF immediately. `codex exec` blocks reading a
    // non-TTY stdin otherwise, hanging forever (spike-findings.md §1.6,
    // reproduced independently, not theoretical) — done for `claude -p`
    // too, defensively, since it reads stdin under some flag combinations.
    if (child.stdin) {
      try {
        (child.stdin as { end: () => void }).end();
      } catch {
        /* already closed — ignore */
      }
    }

    child.on("close", (code, signal) => {
      if (timedOut) return; // the timeout branch already resolved this promise
      finish({ exitCode: code, signal, timedOut: false, spawnError: null });
    });
  });
}

/** `setEncoding` isn't on `NodeJS.ReadableStream`'s base type, but both real Node streams and this file's test doubles provide it — narrow locally rather than widening the exported interface. */
function collectStream(stream: NodeJS.ReadableStream, onChunk: (s: string) => void): void {
  const withEncoding = stream as { setEncoding?: (enc: string) => void };
  withEncoding.setEncoding?.("utf8");
  stream.on("data", (d: unknown) => onChunk(String(d)));
}

function describeSpawnError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
