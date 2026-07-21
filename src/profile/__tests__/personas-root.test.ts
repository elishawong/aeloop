/**
 * `resolvePersonaRoot()` unit tests (issue #42 acceptance: "subscription
 * profile behavior remains unchanged / a deployment can load persona
 * prompts from an external persona root / path traversal/symlink escape
 * is rejected / tests cover default, external root, missing role, and
 * isolation").
 *
 * No real credentials or company prompt content — every fixture below is a
 * throwaway temp directory with placeholder `.md` text.
 */
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePersonaRoot } from "../personas-root.js";
import {
  PersonaRootNotConfiguredError,
  PersonaRootNotFoundError,
  InvalidPersonaSetNameError,
} from "../errors.js";
import { loadPersona } from "../../prompt/personas.js";

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

describe("resolvePersonaRoot — legacy default (no personas field)", () => {
  it("returns <profileDir>/personas when config.personas is absent", () => {
    const profileDir = makeTmpDir("aeloop-personas-legacy-");

    const result = resolvePersonaRoot(profileDir, {});

    expect(result).toBe(path.join(profileDir, "personas"));
  });

  it("resolves personas from the legacy path end-to-end (loadPersona finds a real file there)", () => {
    const profileDir = makeTmpDir("aeloop-personas-legacy-e2e-");
    const personasDir = path.join(profileDir, "personas");
    mkdirSync(personasDir, { recursive: true });
    writeFileSync(path.join(personasDir, "coder.md"), "You are the coder.", "utf-8");

    const resolved = resolvePersonaRoot(profileDir, {});
    const persona = loadPersona("coder", resolved);

    expect(persona).toBe("You are the coder.");
  });
});

describe("resolvePersonaRoot — external persona root (opted-in profile scenario)", () => {
  it("resolves <AELOOP_PERSONAS_ROOT>/<personas>/personas when config.personas is set", () => {
    const profileDir = makeTmpDir("aeloop-personas-profile-");
    const personasRoot = makeTmpDir("aeloop-personas-root-");
    const externalPersonasDir = path.join(personasRoot, "company", "personas");
    mkdirSync(externalPersonasDir, { recursive: true });
    writeFileSync(path.join(externalPersonasDir, "coder.md"), "You are the company coder.", "utf-8");

    const result = resolvePersonaRoot(
      profileDir,
      { personas: "company" },
      { AELOOP_PERSONAS_ROOT: personasRoot },
    );

    expect(result).toBe(externalPersonasDir);
    expect(loadPersona("coder", result)).toBe("You are the company coder.");
  });

  it("throws PersonaRootNotConfiguredError when personas is set but AELOOP_PERSONAS_ROOT is not", () => {
    const profileDir = makeTmpDir("aeloop-personas-no-env-");

    expect(() => resolvePersonaRoot(profileDir, { personas: "company" }, {})).toThrow(
      PersonaRootNotConfiguredError,
    );
  });

  it("throws PersonaRootNotFoundError when AELOOP_PERSONAS_ROOT points at a nonexistent directory", () => {
    const profileDir = makeTmpDir("aeloop-personas-missing-root-");
    const ghostRoot = path.join(os.tmpdir(), "aeloop-personas-root-does-not-exist-42");

    expect(() =>
      resolvePersonaRoot(profileDir, { personas: "company" }, { AELOOP_PERSONAS_ROOT: ghostRoot }),
    ).toThrow(PersonaRootNotFoundError);
  });

  it("does not silently fall back to <profileDir>/personas when personas is set but misconfigured", () => {
    const profileDir = makeTmpDir("aeloop-personas-no-fallback-");
    const legacyPersonasDir = path.join(profileDir, "personas");
    mkdirSync(legacyPersonasDir, { recursive: true });
    writeFileSync(path.join(legacyPersonasDir, "coder.md"), "legacy content that must not leak", "utf-8");

    let thrown: unknown;
    try {
      resolvePersonaRoot(profileDir, { personas: "company" }, {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PersonaRootNotConfiguredError);
  });
});

describe("resolvePersonaRoot — missing role after resolving an external persona root", () => {
  it("loadPersona() throws PersonaNotFoundError for a role with no file under the resolved persona root", () => {
    const profileDir = makeTmpDir("aeloop-personas-missing-role-");
    const personasRoot = makeTmpDir("aeloop-personas-root-missing-role-");
    mkdirSync(path.join(personasRoot, "company", "personas"), { recursive: true });
    // deliberately no tester.md

    const resolved = resolvePersonaRoot(
      profileDir,
      { personas: "company" },
      { AELOOP_PERSONAS_ROOT: personasRoot },
    );

    expect(() => loadPersona("tester", resolved)).toThrow(/No persona file for role "tester"/);
  });
});

describe("resolvePersonaRoot — unsafe personas names (path traversal / symlink escape)", () => {
  it("rejects a personas name with a traversal sequence", () => {
    const profileDir = makeTmpDir("aeloop-personas-traversal-");
    const personasRoot = makeTmpDir("aeloop-personas-root-traversal-");

    let thrown: unknown;
    try {
      resolvePersonaRoot(profileDir, { personas: "../../../etc" }, { AELOOP_PERSONAS_ROOT: personasRoot });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidPersonaSetNameError);
  });

  it("rejects an absolute path as a personas name", () => {
    const profileDir = makeTmpDir("aeloop-personas-absolute-");
    const personasRoot = makeTmpDir("aeloop-personas-root-absolute-");

    expect(() =>
      resolvePersonaRoot(profileDir, { personas: "/etc" }, { AELOOP_PERSONAS_ROOT: personasRoot }),
    ).toThrow(InvalidPersonaSetNameError);
  });

  it("rejects a non-string personas value", () => {
    const profileDir = makeTmpDir("aeloop-personas-nonstring-");
    const personasRoot = makeTmpDir("aeloop-personas-root-nonstring-");

    expect(() =>
      resolvePersonaRoot(
        profileDir,
        { personas: 42 as unknown as string },
        { AELOOP_PERSONAS_ROOT: personasRoot },
      ),
    ).toThrow(InvalidPersonaSetNameError);
  });

  it("blocks a symlinked personas directory that resolves outside AELOOP_PERSONAS_ROOT (symlink escape)", () => {
    const profileDir = makeTmpDir("aeloop-personas-symlink-profile-");
    const personasRoot = makeTmpDir("aeloop-personas-root-symlink-");
    const secretRoot = makeTmpDir("aeloop-personas-secret-");
    writeFileSync(path.join(secretRoot, "leaked.md"), "should never be reachable", "utf-8");
    symlinkSync(secretRoot, path.join(personasRoot, "leaked"));

    let thrown: unknown;
    try {
      resolvePersonaRoot(profileDir, { personas: "leaked" }, { AELOOP_PERSONAS_ROOT: personasRoot });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InvalidPersonaSetNameError);
  });
});

describe("resolvePersonaRoot — profile isolation (different profiles resolve independently)", () => {
  it("two profiles with different personas configs resolve to distinct, non-overlapping persona roots", () => {
    const personasRoot = makeTmpDir("aeloop-personas-root-isolation-");
    const personalPersonas = path.join(personasRoot, "personal", "personas");
    const companyPersonas = path.join(personasRoot, "company", "personas");
    mkdirSync(personalPersonas, { recursive: true });
    mkdirSync(companyPersonas, { recursive: true });
    writeFileSync(path.join(personalPersonas, "coder.md"), "personal coder prompt", "utf-8");
    writeFileSync(path.join(companyPersonas, "coder.md"), "company coder prompt", "utf-8");

    const subscriptionProfileDir = makeTmpDir("aeloop-profile-subscription-");
    const apikeyProfileDir = makeTmpDir("aeloop-profile-apikey-");

    const subscriptionRoot = resolvePersonaRoot(subscriptionProfileDir, { personas: "personal" }, {
      AELOOP_PERSONAS_ROOT: personasRoot,
    });
    const apikeyRoot = resolvePersonaRoot(apikeyProfileDir, { personas: "company" }, {
      AELOOP_PERSONAS_ROOT: personasRoot,
    });

    expect(subscriptionRoot).not.toBe(apikeyRoot);
    expect(loadPersona("coder", subscriptionRoot)).toBe("personal coder prompt");
    expect(loadPersona("coder", apikeyRoot)).toBe("company coder prompt");
  });

  it("a profile without a personas field never sees another profile's external personas", () => {
    const personasRoot = makeTmpDir("aeloop-personas-root-isolation-2-");
    const companyPersonas = path.join(personasRoot, "company", "personas");
    mkdirSync(companyPersonas, { recursive: true });
    writeFileSync(path.join(companyPersonas, "coder.md"), "company coder prompt", "utf-8");

    const legacyProfileDir = makeTmpDir("aeloop-profile-legacy-");
    mkdirSync(path.join(legacyProfileDir, "personas"), { recursive: true });
    writeFileSync(path.join(legacyProfileDir, "personas", "coder.md"), "legacy coder prompt", "utf-8");

    const legacyRoot = resolvePersonaRoot(legacyProfileDir, {}, { AELOOP_PERSONAS_ROOT: personasRoot });

    expect(legacyRoot).toBe(path.join(legacyProfileDir, "personas"));
    expect(loadPersona("coder", legacyRoot)).toBe("legacy coder prompt");
  });
});
