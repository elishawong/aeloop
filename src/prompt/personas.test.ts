import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../profile/loader.js";
import { loadPersona, PersonaNotFoundError, resolvePersonaPath } from "./personas.js";

const HELIX_PERSONAS_DIR = path.join(resolveProfileDir("helix"), "personas");

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

describe("loadPersona — real committed helix personas", () => {
  it("loads the coder persona by role name", () => {
    const text = loadPersona("coder", HELIX_PERSONAS_DIR);
    expect(text).toContain("Coder");
    expect(text).toContain("CoderOutput");
  });

  it("loads the tester persona by role name", () => {
    const text = loadPersona("tester", HELIX_PERSONAS_DIR);
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
