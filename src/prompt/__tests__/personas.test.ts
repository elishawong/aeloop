import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../../profile/loader.js";
import { InvalidRoleNameError, loadPersona, PersonaNotFoundError, resolvePersonaPath } from "../personas.js";

const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

const tmpDirs: string[] = [];
function makeTmpPersonasDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aeloop-personas-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadPersona — real committed subscription personas", () => {
  it("loads the coder persona by role name", () => {
    const text = loadPersona("coder", SUBSCRIPTION_PERSONAS_DIR);
    expect(text).toContain("Coder");
    expect(text).toContain("CoderOutput");
  });

  it("loads the tester persona by role name", () => {
    const text = loadPersona("tester", SUBSCRIPTION_PERSONAS_DIR);
    expect(text).toContain("Tester");
    expect(text).toContain("TesterOutput");
  });
});

describe("loadPersona — dynamic-by-name, not hardcoded", () => {
  it("loads an arbitrary new role's persona purely by dropping a <role>.md file, no code change needed", () => {
    const dir = makeTmpPersonasDir();
    writeFileSync(path.join(dir, "reviewer.md"), "# Reviewer\n\nBe thorough.\n", "utf-8");

    const text = loadPersona("reviewer", dir);

    expect(text).toContain("Be thorough.");
  });
});

describe("loadPersona — missing persona file (required path per PRD §8)", () => {
  it("throws a typed PersonaNotFoundError, not a raw ENOENT", () => {
    const dir = makeTmpPersonasDir();

    let thrown: unknown;
    try {
      loadPersona("ghost-role", dir);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PersonaNotFoundError);
    expect((thrown as PersonaNotFoundError).role).toBe("ghost-role");
    expect((thrown as PersonaNotFoundError).personaPath).toBe(resolvePersonaPath("ghost-role", dir));
  });

  it("also throws when the personas directory itself doesn't exist at all", () => {
    const dir = path.join(os.tmpdir(), "aeloop-personas-does-not-exist-at-all");

    expect(() => loadPersona("coder", dir)).toThrow(PersonaNotFoundError);
  });
});

describe("resolvePersonaPath", () => {
  it("joins personasDir and '<role>.md'", () => {
    expect(resolvePersonaPath("coder", "/x/personas")).toBe(path.join("/x/personas", "coder.md"));
  });
});

describe("loadPersona — path traversal is blocked (Zorro review, feature/issue-1-a0-a1-scaffold)", () => {
  it("real repro: a '../../../CLAUDE'-style role no longer leaks the repo's own CLAUDE.md", () => {
    // Before the fix, this exact call returned the repo root CLAUDE.md's
    // content — `path.join` happily collapsed the ".." segments and
    // `existsSync`/`readFileSync` followed the resulting path with no
    // containment check.
    let thrown: unknown;
    try {
      loadPersona("../../../CLAUDE", SUBSCRIPTION_PERSONAS_DIR);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidRoleNameError);
    expect((thrown as InvalidRoleNameError).role).toBe("../../../CLAUDE");
  });

  it("rejects a role name with a deeper traversal chain reaching outside the repo", () => {
    expect(() => loadPersona("../../../../../../etc/passwd", SUBSCRIPTION_PERSONAS_DIR)).toThrow(InvalidRoleNameError);
  });

  it("rejects an absolute path as a role name", () => {
    expect(() => loadPersona("/etc/passwd", SUBSCRIPTION_PERSONAS_DIR)).toThrow(InvalidRoleNameError);
  });

  it("rejects a role name containing a backslash traversal sequence", () => {
    expect(() => loadPersona("..\\..\\secrets", SUBSCRIPTION_PERSONAS_DIR)).toThrow(InvalidRoleNameError);
  });

  it("rejects a bare '..' role name", () => {
    expect(() => loadPersona("..", SUBSCRIPTION_PERSONAS_DIR)).toThrow(InvalidRoleNameError);
  });

  it("an inert '..%2F'-style string (no URL-decoding happens here) is not treated as traversal — just an ordinary missing-file lookup", () => {
    // Nothing in loadPersona decodes %2F, so this never becomes a real ".."
    // path component; it's simply a role name that has no matching file.
    expect(() => loadPersona("..%2F..%2Fsecrets", SUBSCRIPTION_PERSONAS_DIR)).toThrow(PersonaNotFoundError);
  });

  it("blocks a symlinked persona file that resolves outside personasDir (symlink escape)", () => {
    const dir = makeTmpPersonasDir();
    const secretDir = mkdtempSync(path.join(os.tmpdir(), "aeloop-personas-secret-"));
    tmpDirs.push(secretDir);
    const secretFile = path.join(secretDir, "secret.md");
    writeFileSync(secretFile, "TOP SECRET", "utf-8");
    symlinkSync(secretFile, path.join(dir, "leaked.md"));

    let thrown: unknown;
    try {
      loadPersona("leaked", dir);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidRoleNameError);
  });
});
