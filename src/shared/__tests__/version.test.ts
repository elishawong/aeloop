/**
 * `version.ts` unit tests (issue #98). `VERSION_STRING`/`VERSION_INFO` are computed once at
 * module load from whatever `scripts/generate-version.mjs` last wrote to
 * `./version-info.generated.ts` (regenerated before every `npm test`, see `package.json`) — this
 * file can't inject a fake generated module (it's a real build artifact, not a test seam), so it
 * asserts the *format* against the real, currently-generated values instead of a scripted fixture.
 * The fail-soft/git-unavailable branches themselves are covered by
 * `scripts/test-generate-version.mjs` (the actual git-reading logic lives there, not here).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION_INFO, VERSION_STRING } from "../version.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("VERSION_INFO / VERSION_STRING", () => {
  it("VERSION_INFO.packageVersion matches package.json's version field", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(VERSION_INFO.packageVersion).toBe(pkg.version);
  });

  it("VERSION_INFO.gitSha matches the real current git short SHA (this repo really is a git repo)", () => {
    const realSha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    expect(VERSION_INFO.gitSha).toBe(realSha);
    expect(VERSION_INFO.gitSha).not.toBe("unknown-sha");
  });

  it("VERSION_STRING is `<packageVersion>+<gitSha>`, optionally suffixed `-dirty`", () => {
    const expectedSuffix = VERSION_INFO.gitDirty ? "-dirty" : "";
    expect(VERSION_STRING).toBe(`${VERSION_INFO.packageVersion}+${VERSION_INFO.gitSha}${expectedSuffix}`);
  });

  it("VERSION_STRING never contains a literal 'undefined' or empty segment", () => {
    expect(VERSION_STRING).not.toContain("undefined");
    expect(VERSION_STRING.split("+")).toHaveLength(2);
    const [pkgVersion, shaAndDirty] = VERSION_STRING.split("+");
    expect(pkgVersion).not.toBe("");
    expect(shaAndDirty).not.toBe("");
  });

  it("gitDirty is a boolean (never undefined — always a definite true/false per the fail-soft contract)", () => {
    expect(typeof VERSION_INFO.gitDirty).toBe("boolean");
  });

  it("generatedAt is a valid ISO timestamp", () => {
    expect(() => new Date(VERSION_INFO.generatedAt).toISOString()).not.toThrow();
  });
});
