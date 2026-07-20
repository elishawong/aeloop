import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isContainedRealpath, isSinglePathSegment } from "./safe-path.js";

const tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("isSinglePathSegment", () => {
  it("accepts an ordinary name", () => {
    expect(isSinglePathSegment("coder")).toBe(true);
    expect(isSinglePathSegment("helix")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isSinglePathSegment("")).toBe(false);
  });

  it('rejects "." and ".."', () => {
    expect(isSinglePathSegment(".")).toBe(false);
    expect(isSinglePathSegment("..")).toBe(false);
  });

  it("rejects a name containing a forward-slash traversal segment", () => {
    expect(isSinglePathSegment("../../../CLAUDE")).toBe(false);
    expect(isSinglePathSegment("a/b")).toBe(false);
  });

  it("rejects a name containing a backslash", () => {
    expect(isSinglePathSegment("..\\..\\secrets")).toBe(false);
    expect(isSinglePathSegment("a\\b")).toBe(false);
  });

  it("rejects an absolute path", () => {
    expect(isSinglePathSegment("/etc/passwd")).toBe(false);
  });

  it('does not treat a literal "..%2F"-style string as traversal (no URL-decoding happens here, so it is inert)', () => {
    // Not itself dangerous (no real ".." path component, no separator) —
    // included to document that URL-encoded traversal strings are safe
    // *at this layer* because nothing here decodes them.
    expect(isSinglePathSegment("..%2F..%2Fsecrets")).toBe(true);
  });
});

describe("isContainedRealpath", () => {
  it("returns true for a candidate that is a real file directly inside root", () => {
    const root = makeTmpDir("aeloop-safe-path-root-");
    const file = path.join(root, "a.md");
    writeFileSync(file, "hi", "utf-8");

    expect(isContainedRealpath(root, file)).toBe(true);
  });

  it("returns false for a candidate that escapes root via a symlink", () => {
    const root = makeTmpDir("aeloop-safe-path-root-");
    const secretDir = makeTmpDir("aeloop-safe-path-secret-");
    const secretFile = path.join(secretDir, "secret.md");
    writeFileSync(secretFile, "TOP SECRET", "utf-8");
    const linkPath = path.join(root, "leaked.md");
    symlinkSync(secretFile, linkPath);

    expect(isContainedRealpath(root, linkPath)).toBe(false);
  });

  it("returns true when root does not exist yet (nothing to escape through)", () => {
    const root = path.join(os.tmpdir(), "aeloop-safe-path-does-not-exist");
    const candidate = path.join(root, "a.md");

    expect(isContainedRealpath(root, candidate)).toBe(true);
  });

  it("returns true when the candidate file does not exist (existence is a separate check)", () => {
    const root = makeTmpDir("aeloop-safe-path-root-");
    const candidate = path.join(root, "does-not-exist.md");

    expect(isContainedRealpath(root, candidate)).toBe(true);
  });
});
