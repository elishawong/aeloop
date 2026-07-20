/**
 * `spawnWithTimeout` tests (A3 PRD §5/§6) — all use an injected fake child
 * process (`makeFakeChild`/`mockSpawn`, mirroring `codex-client.test.mjs`'s
 * `makeFakeChild`/`mockSpawn` pattern), never a real subprocess. That keeps
 * this file fast/deterministic and, per PRD §5's testing-strategy note,
 * this is the one file in A3 that's allowed to fake `spawn` itself — the
 * two adapters' own tests instead point `cmd` at a real (but controlled)
 * fixture script (see `adapters/__tests__/`), because their job is proving
 * "we correctly parse what a real child process prints", not "the generic
 * timeout/kill machinery works".
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnWithTimeout, type MinimalSpawnedProcess, type SpawnImpl } from "../cli-exec.js";

interface FakeChild {
  emitter: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdinEnded: boolean;
  killed: boolean;
  killedWith: NodeJS.Signals | number | undefined;
}

function makeFakeChild(): { child: MinimalSpawnedProcess; fake: FakeChild } {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const fake: FakeChild = { emitter, stdout, stderr, stdinEnded: false, killed: false, killedWith: undefined };

  const child = {
    stdout,
    stderr,
    stdin: {
      end: () => {
        fake.stdinEnded = true;
      },
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
    },
    kill(signal?: NodeJS.Signals | number) {
      fake.killed = true;
      fake.killedWith = signal;
      return true;
    },
  } as unknown as MinimalSpawnedProcess;

  // `setEncoding` isn't part of `EventEmitter` — `spawnWithTimeout`'s
  // `collectStream` helper calls it optionally (`?.()`), so a plain
  // `EventEmitter` without it is a valid fake too; leaving it absent here
  // (rather than stubbing it) exercises that "optional" path for real.

  return { child, fake };
}

/** Mirrors `codex-client.test.mjs`'s `mockSpawn`: records the last spawn call, lets the test drive the fake child's events via `fake`. */
function mockSpawn(onSpawn: (args: { cmd: string; args: string[]; child: MinimalSpawnedProcess; fake: FakeChild }) => void): {
  spawnImpl: SpawnImpl;
  callCount: () => number;
} {
  let callCount = 0;
  const spawnImpl: SpawnImpl = (cmd, args) => {
    const { child, fake } = makeFakeChild();
    callCount += 1;
    setImmediate(() => onSpawn({ cmd, args, child, fake }));
    return child;
  };
  return { spawnImpl, callCount: () => callCount };
}

describe("spawnWithTimeout", () => {
  it("resolves with exitCode 0 and full stdout on a normal successful exit", async () => {
    const { spawnImpl } = mockSpawn(({ child, fake }) => {
      fake.stdout.emit("data", "hello ");
      fake.stdout.emit("data", "world");
      fake.emitter.emit("close", 0, null);
    });

    const result = await spawnWithTimeout("fake-cmd", ["arg1"], { timeoutMs: 5000, spawnImpl });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("hello world");
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeNull();
  });

  it("resolves with the real non-zero exit code and captured stderr", async () => {
    const { spawnImpl } = mockSpawn(({ fake }) => {
      fake.stderr.emit("data", "boom");
      fake.emitter.emit("close", 3, null);
    });

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 5000, spawnImpl });

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom");
    expect(result.timedOut).toBe(false);
  });

  it("SIGKILLs the child and resolves timedOut:true when the wall-clock timeout fires before a close event", async () => {
    const { spawnImpl } = mockSpawn(() => {
      /* deliberately never emits "close" — simulates a hung process */
    });

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 20, spawnImpl });

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.exitCode).toBeNull();
  });

  it("actually calls child.kill(\"SIGKILL\") on timeout, not just reports it in the result", async () => {
    let capturedFake: FakeChild | undefined;
    const { spawnImpl } = mockSpawn(({ fake }) => {
      capturedFake = fake;
      /* deliberately never emits "close" — simulates a hung process */
    });

    await spawnWithTimeout("fake-cmd", [], { timeoutMs: 20, spawnImpl });

    expect(capturedFake?.killed).toBe(true);
    expect(capturedFake?.killedWith).toBe("SIGKILL");
  });

  it("a close event arriving after the timeout already fired is ignored (no double-resolve)", async () => {
    const { spawnImpl } = mockSpawn(({ fake }) => {
      setTimeout(() => {
        // Fires well after the 20ms timeout below — must be a no-op.
        fake.emitter.emit("close", 0, null);
      }, 60);
    });

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 20, spawnImpl });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("closes stdin immediately, before any output arrives", async () => {
    let stdinEndedBeforeData = false;
    const { spawnImpl } = mockSpawn(({ fake }) => {
      // By the time the spawn callback runs (next tick), spawnWithTimeout
      // has already synchronously called child.stdin.end() — verified
      // before emitting any data/close.
      stdinEndedBeforeData = fake.stdinEnded;
      fake.emitter.emit("close", 0, null);
    });

    await spawnWithTimeout("fake-cmd", [], { timeoutMs: 5000, spawnImpl });

    expect(stdinEndedBeforeData).toBe(true);
  });

  it("collects stdout and stderr into separate fields, never merged", async () => {
    const { spawnImpl } = mockSpawn(({ fake }) => {
      fake.stdout.emit("data", '{"type":"real json line"}\n');
      fake.stderr.emit("data", "noise: not json at all\n");
      fake.emitter.emit("close", 0, null);
    });

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 5000, spawnImpl });

    expect(result.stdout).toBe('{"type":"real json line"}\n');
    expect(result.stderr).toBe("noise: not json at all\n");
    expect(result.stdout).not.toContain("noise");
    expect(result.stderr).not.toContain("real json line");
  });

  it("reports a spawn-time error (e.g. ENOENT-equivalent) via spawnError, distinct from a real exit code", async () => {
    const { spawnImpl } = mockSpawn(({ fake }) => {
      fake.emitter.emit("error", new Error("spawn fake-cmd ENOENT"));
    });

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 5000, spawnImpl });

    expect(result.spawnError).toContain("ENOENT");
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it("catches a spawnImpl that throws synchronously and reports it via spawnError", async () => {
    const throwingSpawnImpl: SpawnImpl = () => {
      throw new Error("boom: could not spawn at all");
    };

    const result = await spawnWithTimeout("fake-cmd", [], { timeoutMs: 5000, spawnImpl: throwingSpawnImpl });

    expect(result.spawnError).toContain("boom");
    expect(result.exitCode).toBeNull();
  });
});
