/**
 * `run-origin.ts` unit tests — A5 re-review P0-2 (`docs/feature/a5-cli-tui/
 * test-report.md`). Real filesystem, real temp `profileDir` per test (same
 * "own tmpDir, cleaned in afterEach" posture every other suite in this
 * repo's `src/cli/__tests__/` already uses) — this file's whole point is a
 * JSON sidecar on real disk, so a fake/in-memory fs would test nothing real.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCwdMismatch, getRunOrigin, recordRunOrigin } from "../run-origin.js";

let tmpDir = "";

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  vi.restoreAllMocks();
});

function makeProfileDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-run-origin-"));
  return tmpDir;
}

describe("recordRunOrigin / getRunOrigin", () => {
  it("round-trips: what's recorded is what's read back", () => {
    const profileDir = makeProfileDir();
    recordRunOrigin(profileDir, 7, "/repos/aeloop", "2026-07-21T00:00:00.000Z");
    expect(getRunOrigin(profileDir, 7)).toEqual({ cwd: "/repos/aeloop", recordedAt: "2026-07-21T00:00:00.000Z" });
  });

  it("returns undefined for a runId that was never recorded (no sidecar file at all yet)", () => {
    const profileDir = makeProfileDir();
    expect(getRunOrigin(profileDir, 999)).toBeUndefined();
  });

  it("returns undefined for a runId that was never recorded, even when the sidecar already holds other runs' origins", () => {
    const profileDir = makeProfileDir();
    recordRunOrigin(profileDir, 1, "/repos/one");
    expect(getRunOrigin(profileDir, 2)).toBeUndefined();
  });

  it("tracks multiple runs' origins independently — recording a new one doesn't clobber an existing one", () => {
    const profileDir = makeProfileDir();
    recordRunOrigin(profileDir, 1, "/repos/one", "2026-07-21T00:00:00.000Z");
    recordRunOrigin(profileDir, 2, "/repos/two", "2026-07-21T01:00:00.000Z");
    expect(getRunOrigin(profileDir, 1)).toEqual({ cwd: "/repos/one", recordedAt: "2026-07-21T00:00:00.000Z" });
    expect(getRunOrigin(profileDir, 2)).toEqual({ cwd: "/repos/two", recordedAt: "2026-07-21T01:00:00.000Z" });
  });

  it("re-recording the same runId overwrites its previous origin", () => {
    const profileDir = makeProfileDir();
    recordRunOrigin(profileDir, 1, "/repos/old", "2026-07-21T00:00:00.000Z");
    recordRunOrigin(profileDir, 1, "/repos/new", "2026-07-21T02:00:00.000Z");
    expect(getRunOrigin(profileDir, 1)).toEqual({ cwd: "/repos/new", recordedAt: "2026-07-21T02:00:00.000Z" });
  });

  it("a corrupt (non-JSON) sidecar file degrades to 'no origin recorded' rather than throwing, and warns once to stderr", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), "{ not valid json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => getRunOrigin(profileDir, 1)).not.toThrow();
    expect(getRunOrigin(profileDir, 1)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("not valid JSON");
  });

  it("a sidecar file holding a JSON array (not an object) degrades to 'no origin recorded' rather than throwing", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), "[1, 2, 3]");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(getRunOrigin(profileDir, 1)).toBeUndefined();
  });

  it("recordRunOrigin does not throw when the target directory doesn't exist — warns to stderr instead (best-effort, non-fatal metadata)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nonExistentDir = path.join(os.tmpdir(), "aeloop-run-origin-does-not-exist-" + Date.now());

    expect(() => recordRunOrigin(nonExistentDir, 1, "/repos/aeloop")).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("could not record run origin");
  });

  /**
   * B1 regression (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md`): before the
   * `isValidRunOrigin()` fix, this sidecar shape made `getRunOrigin()` return the raw `null` value
   * straight from `JSON.parse` (the whole file parses to a valid object — `{"1": null}` — so
   * `readRunOrigins()`'s own "not an object" guard never triggers; only the *per-entry* value is
   * bad). Callers in `main.ts` (`runResume`/`runList`) only guard `origin !== undefined` before
   * reading `origin.cwd`, and `null !== undefined` is true, so `null.cwd` threw a real `TypeError`
   * that crashed the entire `resume`/`list` command — confirmed reproduced by Zorro/Codex
   * `gpt-5.6-sol` before this fix. `getRunOrigin()` must degrade this to `undefined`, the same as
   * a missing/corrupt sidecar.
   */
  it("a per-run entry that is JSON null (not a missing key — the sidecar object itself has {\"<runId>\": null}) degrades to undefined rather than being returned as-is (B1: this used to crash callers that only check `origin !== undefined` before reading `.cwd`)", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), JSON.stringify({ "1": null }));

    expect(getRunOrigin(profileDir, 1)).toBeUndefined();
  });

  it("a per-run entry that is a bare string (not an object with cwd/recordedAt) degrades to undefined rather than being returned as-is (B1)", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), JSON.stringify({ "1": "not-an-object" }));

    expect(getRunOrigin(profileDir, 1)).toBeUndefined();
  });

  it("a per-run entry that is an object missing `cwd` degrades to undefined rather than being returned with cwd: undefined (B1)", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), JSON.stringify({ "2": { recordedAt: "2026-07-21T00:00:00.000Z" } }));

    expect(getRunOrigin(profileDir, 2)).toBeUndefined();
  });

  it("a per-run entry that is an object missing `recordedAt` degrades to undefined (B1)", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(path.join(profileDir, "run-origins.json"), JSON.stringify({ "3": { cwd: "/repos/aeloop" } }));

    expect(getRunOrigin(profileDir, 3)).toBeUndefined();
  });

  it("does not corrupt sibling entries in the same sidecar — a malformed entry for one runId still lets a well-formed entry for another runId read back correctly (B1)", () => {
    const profileDir = makeProfileDir();
    fs.writeFileSync(
      path.join(profileDir, "run-origins.json"),
      JSON.stringify({ "1": null, "2": { cwd: "/repos/good", recordedAt: "2026-07-21T00:00:00.000Z" } }),
    );

    expect(getRunOrigin(profileDir, 1)).toBeUndefined();
    expect(getRunOrigin(profileDir, 2)).toEqual({ cwd: "/repos/good", recordedAt: "2026-07-21T00:00:00.000Z" });
  });
});

describe("describeCwdMismatch", () => {
  it("names the run, the recorded origin, and the current cwd", () => {
    const message = describeCwdMismatch(42, { cwd: "/repos/aeloop", recordedAt: "2026-07-21T00:00:00.000Z" }, "/repos/other-project");
    expect(message).toContain("#42");
    expect(message).toContain("/repos/aeloop");
    expect(message).toContain("/repos/other-project");
  });

  // P1-4 (docs/feature/a5-cli-tui/test-report.md): this file's own header now documents that
  // both cwds are run through stripControlSequences() before interpolation — consistency with
  // every other string this CLI prints to the real terminal, even though cwd isn't model-
  // controlled text.
  it("strips control sequences from both the recorded origin cwd and the current cwd", () => {
    const ESC = "\x1B";
    const message = describeCwdMismatch(
      1,
      { cwd: `/repos/${ESC}[2Jaeloop`, recordedAt: "2026-07-21T00:00:00.000Z" },
      `/repos/other${ESC}[Hproject`,
    );
    expect(message).not.toContain(ESC);
    expect(message).toContain("/repos/aeloop");
    expect(message).toContain("/repos/otherproject");
  });
});
