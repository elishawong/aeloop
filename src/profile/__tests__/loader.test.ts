import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfile, substituteEnvPlaceholders } from "../loader.js";
import { InvalidProfileNameError, ProfileConfigParseError, ProfileNotFoundError } from "../errors.js";

/** Directories created per-test under the OS tmp dir, cleaned up after each. */
const tmpDirs: string[] = [];

function makeTmpProfilesRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aeloop-profile-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["AELOOP_TEST_ENV_VAR"];
});

describe("loadProfile — subscription (real committed profile)", () => {
  it("parses profiles/subscription/config.yaml into a usable ProfileConfig", () => {
    const result = loadProfile("subscription");

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS
    expect(result.profile).toBe("subscription");
    expect(result.config.profile).toBe("subscription");
    expect(result.config.providers["claude-cli"]).toEqual({
      kind: "cli-bridge",
      cmd: "claude",
    });
    expect(result.config.providers["codex-cli"]).toEqual({
      kind: "cli-bridge",
      cmd: "codex",
    });
    expect(result.config.roles["coder"]).toEqual({ provider: "claude-cli" });
    expect(result.config.roles["tester"]).toEqual({ provider: "codex-cli" });
    expect(result.config.workflow?.reject_threshold).toBe(2);
  });

  it("defaults to the subscription profile when AI_AGENT_PROFILE is unset", () => {
    const original = process.env["AI_AGENT_PROFILE"];
    delete process.env["AI_AGENT_PROFILE"];
    try {
      const result = loadProfile();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profile).toBe("subscription");
    } finally {
      if (original !== undefined) process.env["AI_AGENT_PROFILE"] = original;
    }
  });
});

describe("loadProfile — missing profile dir (generic, not just apikey)", () => {
  it("returns { ok: false } for any profile with no config.yaml on disk", () => {
    const profilesRoot = makeTmpProfilesRoot();
    // deliberately don't create anything under profilesRoot/ghost

    const result = loadProfile("ghost", profilesRoot);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ProfileNotFoundError);
  });
});

describe("loadProfile — malformed config.yaml (must not throw a bare/raw error)", () => {
  it("throws a typed ProfileConfigParseError on invalid YAML syntax", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      "profile: subscription\n  providers: [this is: not, valid: yaml\n",
      "utf-8",
    );

    let thrown: unknown;
    try {
      loadProfile("broken", profilesRoot);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ProfileConfigParseError);
    expect(thrown).not.toBeUndefined();
    // must not be a raw js-yaml exception leaking through
    expect((thrown as Error).name).toBe("ProfileConfigParseError");
  });

  it("throws a typed ProfileConfigParseError when the YAML root isn't a mapping", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "scalar-root");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "just a plain string\n", "utf-8");

    expect(() => loadProfile("scalar-root", profilesRoot)).toThrow(
      ProfileConfigParseError,
    );
  });
});

describe("loadProfile — ${ENV} placeholder substitution", () => {
  it("substitutes a set env var into a string value", () => {
    process.env["AELOOP_TEST_ENV_VAR"] = "resolved-value";
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "envsub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      [
        "profile: envsub",
        "providers:",
        "  litellm:",
        "    kind: direct-api",
        "    base_url: ${AELOOP_TEST_ENV_VAR}",
        "roles:",
        "  coder:",
        "    provider: litellm",
      ].join("\n"),
      "utf-8",
    );

    const result = loadProfile("envsub", profilesRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers["litellm"]?.["base_url"]).toBe("resolved-value");
  });

  it("leaves the placeholder untouched when the env var is not set", () => {
    delete process.env["AELOOP_TEST_ENV_VAR"];
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "envunset");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      [
        "profile: envunset",
        "providers:",
        "  litellm:",
        "    kind: direct-api",
        "    base_url: ${AELOOP_TEST_ENV_VAR}",
        "roles:",
        "  coder:",
        "    provider: litellm",
      ].join("\n"),
      "utf-8",
    );

    const result = loadProfile("envunset", profilesRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.providers["litellm"]?.["base_url"]).toBe(
      "${AELOOP_TEST_ENV_VAR}",
    );
  });
});

describe("loadProfile — minimal required-field validation before returning ok:true (review suggestion)", () => {
  it("throws ProfileConfigParseError when 'profile' is missing", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "no-profile-field");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "providers: {}\nroles: {}\n", "utf-8");

    expect(() => loadProfile("no-profile-field", profilesRoot)).toThrow(ProfileConfigParseError);
  });

  it("throws ProfileConfigParseError when 'providers' is missing", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "no-providers");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "profile: no-providers\nroles: {}\n", "utf-8");

    expect(() => loadProfile("no-providers", profilesRoot)).toThrow(ProfileConfigParseError);
  });

  it("throws ProfileConfigParseError when 'roles' is missing", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "no-roles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.yaml"), "profile: no-roles\nproviders: {}\n", "utf-8");

    expect(() => loadProfile("no-roles", profilesRoot)).toThrow(ProfileConfigParseError);
  });

  it("throws ProfileConfigParseError when 'providers' is present but not a mapping", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const dir = path.join(profilesRoot, "providers-wrong-type");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "config.yaml"),
      "profile: providers-wrong-type\nproviders: not-a-mapping\nroles: {}\n",
      "utf-8",
    );

    expect(() => loadProfile("providers-wrong-type", profilesRoot)).toThrow(ProfileConfigParseError);
  });

  it("still accepts the real committed subscription profile (sanity check the validation isn't overly strict)", () => {
    const result = loadProfile("subscription");
    expect(result.ok).toBe(true);
  });
});

describe("loadProfile — path traversal is blocked (review, feature/issue-1-a0-a1-scaffold)", () => {
  it("real repro: a '../../../CLAUDE'-style profile name no longer leaks the repo's own CLAUDE.md directory", () => {
    // Before the fix, `path.join(profilesRoot, profile)` collapsed the ".."
    // segments with no containment check, so a traversal profile name
    // resolved to a directory (and file) outside `profiles/`.
    let thrown: unknown;
    try {
      loadProfile("../../../CLAUDE");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidProfileNameError);
    expect((thrown as InvalidProfileNameError).profile).toBe("../../../CLAUDE");
  });

  it("rejects a profile name with a deeper traversal chain reaching outside the repo", () => {
    expect(() => loadProfile("../../../../../../etc")).toThrow(InvalidProfileNameError);
  });

  it("rejects an absolute path as a profile name", () => {
    expect(() => loadProfile("/etc")).toThrow(InvalidProfileNameError);
  });

  it("rejects a profile name containing a backslash traversal sequence", () => {
    expect(() => loadProfile("..\\..\\secrets")).toThrow(InvalidProfileNameError);
  });

  it("rejects a bare '..' profile name", () => {
    expect(() => loadProfile("..")).toThrow(InvalidProfileNameError);
  });

  it("an inert '..%2F'-style string (no URL-decoding happens here) is not treated as traversal — just an ordinary missing-profile lookup", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const result = loadProfile("..%2F..%2Fsecrets", profilesRoot);
    expect(result.ok).toBe(false);
  });

  it("blocks a symlinked profile directory that resolves outside profilesRoot (symlink escape)", () => {
    const profilesRoot = makeTmpProfilesRoot();
    const secretRoot = mkdtempSync(path.join(os.tmpdir(), "aeloop-profile-secret-"));
    tmpDirs.push(secretRoot);
    writeFileSync(path.join(secretRoot, "config.yaml"), "profile: leaked\nproviders: {}\nroles: {}\n", "utf-8");
    symlinkSync(secretRoot, path.join(profilesRoot, "leaked"));

    let thrown: unknown;
    try {
      loadProfile("leaked", profilesRoot);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidProfileNameError);
  });
});

describe("substituteEnvPlaceholders (unit)", () => {
  it("recurses through nested objects and arrays", () => {
    process.env["AELOOP_TEST_ENV_VAR"] = "x";
    const input = {
      a: "${AELOOP_TEST_ENV_VAR}",
      b: ["${AELOOP_TEST_ENV_VAR}", "plain"],
      c: { d: "${AELOOP_TEST_ENV_VAR}" },
      e: 42,
      f: null,
    };

    const result = substituteEnvPlaceholders(input);

    expect(result).toEqual({
      a: "x",
      b: ["x", "plain"],
      c: { d: "x" },
      e: 42,
      f: null,
    });
  });
});
