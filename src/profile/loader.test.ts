import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProfile,
  resolveProfileDir,
  substituteEnvPlaceholders,
} from "./loader.js";
import { ProfileConfigParseError, ProfileNotFoundError } from "./errors.js";

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

describe("loadProfile — helix (real committed profile)", () => {
  it("parses profiles/helix/config.yaml into a usable ProfileConfig", () => {
    const result = loadProfile("helix");

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS
    expect(result.profile).toBe("helix");
    expect(result.config.profile).toBe("helix");
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

  it("defaults to the helix profile when AI_AGENT_PROFILE is unset", () => {
    const original = process.env["AI_AGENT_PROFILE"];
    delete process.env["AI_AGENT_PROFILE"];
    try {
      const result = loadProfile();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.profile).toBe("helix");
    } finally {
      if (original !== undefined) process.env["AI_AGENT_PROFILE"] = original;
    }
  });
});

describe("loadProfile — verity (must not exist in this repo)", () => {
  it("returns a typed not-found result, does not throw, does not fake an empty config", () => {
    const result = loadProfile("verity");

    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow for TS
    expect(result.error).toBeInstanceOf(ProfileNotFoundError);
    expect(result.error.profile).toBe("verity");
    expect(result.error.profileDir).toBe(resolveProfileDir("verity"));
  });
});

describe("loadProfile — missing profile dir (generic, not just verity)", () => {
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
      "profile: helix\n  providers: [this is: not, valid: yaml\n",
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
