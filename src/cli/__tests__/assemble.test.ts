/**
 * `assemble.ts` unit tests (PRD §6.5 / §8 B5). Uses a temp `profilesRoot`
 * (this function's own test-injection point, mirroring `profile/loader.ts`'s
 * `profilesRoot` parameter) rather than ever touching the real
 * `profiles/subscription/` directory — opening `MemoryStore`/`AuditStore`
 * against `memory.db`/`workflow.db` really creates on-disk SQLite files at
 * construction time (`better-sqlite3`'s `new Database(path)`), and this
 * suite must not leave stray files in the real project tree on every test
 * run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleProfileDeps,
  assembleSubscriptionDeps,
  resolveContextBudgetManager,
  resolveRejectThreshold,
  type CliDeps,
} from "../assemble.js";
import { UnsupportedProfileError } from "../errors.js";
import { InvalidProviderConfigError } from "../../harness/errors.js";
import { ProfileNotFoundError } from "../../profile/errors.js";
import { MemoryStore } from "../../context/store.js";
import { SystemConfig } from "../../context/config.js";
import { ContextBudgetManager } from "../../context/budget.js";
import type { ProfileConfig } from "../../profile/loader.js";

const VALID_CONFIG_YAML = `
profile: subscription

providers:
  claude-cli:
    kind: cli-bridge
    cmd: claude
  codex-cli:
    kind: cli-bridge
    cmd: codex

roles:
  coder:
    provider: claude-cli
  tester:
    provider: codex-cli

workflow:
  reject_threshold: 2
`;

let tmpDir = "";
let openDeps: CliDeps | undefined;

afterEach(() => {
  openDeps?.memoryStore.close();
  openDeps?.audit.close();
  openDeps = undefined;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

function makeProfilesRoot(profileName: string, configYaml: string = VALID_CONFIG_YAML): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-assemble-"));
  const profileDir = path.join(tmpDir, profileName);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, "config.yaml"), configYaml);
  return tmpDir;
}

describe("assembleSubscriptionDeps", () => {
  it("assembles a real dependency graph for the subscription profile — router/composer/audit/checkpointer/injector/memoryStore are all real, usable instances", () => {
    const profilesRoot = makeProfilesRoot("subscription");
    const deps = assembleSubscriptionDeps({ AI_AGENT_PROFILE: "subscription" }, profilesRoot);
    openDeps = deps;

    expect(deps.profileConfig.profile).toBe("subscription");
    expect(deps.router.route("coder")).toMatchObject({ id: "claude-cli", kind: "cli-bridge" });
    expect(deps.router.route("tester")).toMatchObject({ id: "codex-cli", kind: "cli-bridge" });
    expect(deps.injector.inject("some task")).toEqual({ memories: [] }); // real, empty MemoryStore — no memories to recall
    expect(deps.memoryStore).toBeInstanceOf(MemoryStore);
    // P0-2 (docs/feature/a5-cli-tui/test-report.md): profileDir is run-origin.ts's own necessary
    // addition to CliDeps (a sibling of memory.db/workflow.db's directory convention) — real,
    // pointing at the actual loaded profile directory, not a placeholder.
    expect(deps.profileDir).toBe(path.join(profilesRoot, "subscription"));
  });

  it("defaults to the subscription profile when AI_AGENT_PROFILE is unset in env", () => {
    const profilesRoot = makeProfilesRoot("subscription");
    const deps = assembleSubscriptionDeps({}, profilesRoot);
    openDeps = deps;
    expect(deps.profileConfig.profile).toBe("subscription");
  });

  it("throws UnsupportedProfileError for AI_AGENT_PROFILE=apikey, before ever attempting to load profiles/apikey (no ProfileNotFoundError)", () => {
    const profilesRoot = makeProfilesRoot("subscription"); // note: no "apikey" subdir exists here at all
    expect(() => assembleSubscriptionDeps({ AI_AGENT_PROFILE: "apikey" }, profilesRoot)).toThrow(UnsupportedProfileError);
    try {
      assembleSubscriptionDeps({ AI_AGENT_PROFILE: "apikey" }, profilesRoot);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedProfileError);
      expect((err as UnsupportedProfileError).profile).toBe("apikey");
      expect((err as Error).message).not.toMatch(/no config\.yaml/); // not ProfileNotFoundError's message shape
    }
  });

  it("throws UnsupportedProfileError for any other non-subscription AI_AGENT_PROFILE value", () => {
    const profilesRoot = makeProfilesRoot("subscription");
    expect(() => assembleSubscriptionDeps({ AI_AGENT_PROFILE: "bogus" }, profilesRoot)).toThrow(UnsupportedProfileError);
  });

  it("propagates ProfileNotFoundError untouched when the subscription profile itself has no config.yaml", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-assemble-missing-"));
    expect(() => assembleSubscriptionDeps({ AI_AGENT_PROFILE: "subscription" }, tmpDir)).toThrow(ProfileNotFoundError);
  });

  /**
   * "顺手修" regression (Zorro R2 re-review, `docs/feature/a5-cli-tui/test-report.md`): `memoryStore`
   * is constructed (a real `better-sqlite3` connection to `memory.db`) *before*
   * `buildAdapterRegistry()`/`createSqliteCheckpointer()`/`new AuditStore()` — any of which can
   * throw on a malformed `config.yaml`. Before this fix, a throw there left the already-open
   * `memoryStore` handle with no owner: this function never returns a `CliDeps` for a caller's
   * `withDeps()`/test `afterEach()` to `.close()`, so the connection leaked for the rest of the
   * process's lifetime. `assembleSubscriptionDeps()` itself must close what it already opened
   * before rethrowing.
   */
  it("closes the already-opened memoryStore before rethrowing when a later construction step throws (e.g. an invalid provider kind in config.yaml)", () => {
    const closeSpy = vi.spyOn(MemoryStore.prototype, "close");
    const invalidConfigYaml = `
profile: subscription

providers:
  bogus-provider:
    kind: not-a-real-kind

roles:
  coder:
    provider: bogus-provider
  tester:
    provider: bogus-provider
`;
    const profilesRoot = makeProfilesRoot("subscription", invalidConfigYaml);

    expect(() => assembleSubscriptionDeps({ AI_AGENT_PROFILE: "subscription" }, profilesRoot)).toThrow(InvalidProviderConfigError);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("assembleProfileDeps", () => {
  it("assembles a non-subscription profile without changing the engine wiring", () => {
    const companyConfig = `
profile: company

providers:
  company-litellm:
    kind: direct-api
    base_url: http://127.0.0.1:4000
    model: company-coder

roles:
  coder:
    provider: company-litellm
  tester:
    provider: company-litellm
`;
    const profilesRoot = makeProfilesRoot("company", companyConfig);
    const deps = assembleProfileDeps("company", { AI_AGENT_PROFILE: "company" }, profilesRoot);
    openDeps = deps;

    expect(deps.profileConfig.profile).toBe("company");
    expect(deps.router.route("coder")).toMatchObject({ id: "company-litellm", kind: "direct-api" });
    expect(deps.router.route("tester")).toMatchObject({ id: "company-litellm", kind: "direct-api" });
  });

  it("loads a private profile root from AELOOP_PROFILES_ROOT when no explicit root is passed", () => {
    const profilesRoot = makeProfilesRoot("company", `
profile: company
providers:
  company-litellm:
    kind: direct-api
    base_url: http://127.0.0.1:4000
roles:
  coder: { provider: company-litellm }
  tester: { provider: company-litellm }
`);
    const deps = assembleProfileDeps("company", { AI_AGENT_PROFILE: "company", AELOOP_PROFILES_ROOT: profilesRoot });
    openDeps = deps;
    expect(deps.profileConfig.profile).toBe("company");
  });
});

describe("resolveRejectThreshold", () => {
  it("tier 1: uses profileConfig.workflow.reject_threshold when set, ignoring system_config", () => {
    const store = new MemoryStore(":memory:");
    try {
      const systemConfig = new SystemConfig(store);
      systemConfig.set("default_reject_threshold", "5");
      const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {}, workflow: { reject_threshold: 3 } };
      expect(resolveRejectThreshold(profileConfig, systemConfig)).toBe(3);
    } finally {
      store.close();
    }
  });

  it("tier 2: falls back to SystemConfig.getDefaultRejectThreshold() when profileConfig.workflow.reject_threshold is absent", () => {
    const store = new MemoryStore(":memory:");
    try {
      const systemConfig = new SystemConfig(store);
      systemConfig.set("default_reject_threshold", "5");
      const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {} };
      expect(resolveRejectThreshold(profileConfig, systemConfig)).toBe(5);
    } finally {
      store.close();
    }
  });

  /**
   * Zorro re-review "🟡" item 3 (`docs/feature/a5-cli-tui/test-report.md`): this test used to
   * leave `default_reject_threshold` entirely unset in `system_config`, expecting that to reach
   * tier 3. It doesn't — `SystemConfig.get()`'s own `DEFAULTS["default_reject_threshold"] = "2"`
   * (`src/context/config.ts`) makes `getDefaultRejectThreshold()` return `2` (not `null`) whenever
   * the key was never written, so the old test was silently re-testing tier 2's own fallback path,
   * not tier 3 — `resolveRejectThreshold()`'s own hardcoded-`2` branch is genuinely reachable
   * (`getDefaultRejectThreshold(): number | null`'s own type signature says so), just not through
   * an *unset* key. The real way to reach it: `system_config` holds a value for the key that fails
   * to parse as a number — `parseConfiguredNumber()` returns `null` for that, which is a
   * legitimate, real-code path (a hand-edited or corrupted `system_config` row), not a
   * hypothetical. This is the design's intended defense-in-depth tier 3, kept (not deleted as dead
   * code) because it's reachable through a real, if unusual, input.
   */
  it("tier 3: falls back to the hardcoded 2 when profileConfig has no value AND the stored system_config value isn't a parseable number (getDefaultRejectThreshold() returns null, not merely 'unset')", () => {
    const store = new MemoryStore(":memory:");
    try {
      const systemConfig = new SystemConfig(store);
      systemConfig.set("default_reject_threshold", "not-a-number"); // a real, if unusual, stored value — not merely absent
      expect(systemConfig.getDefaultRejectThreshold()).toBeNull(); // sanity: this really is the null path, not tier 2's DEFAULTS fallback
      const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {} };
      expect(resolveRejectThreshold(profileConfig, systemConfig)).toBe(2);
    } finally {
      store.close();
    }
  });

});

describe("resolveContextBudgetManager (issue #36 slice 1)", () => {
  it("returns undefined when profileConfig.context is entirely absent (backward compatibility)", () => {
    const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {} };
    expect(resolveContextBudgetManager(profileConfig)).toBeUndefined();
  });

  it("returns undefined when profileConfig.context is present but token_budget is absent", () => {
    const profileConfig: ProfileConfig = { profile: "subscription", providers: {}, roles: {}, context: {} };
    expect(resolveContextBudgetManager(profileConfig)).toBeUndefined();
  });

  it("returns a ContextBudgetManager when profileConfig.context.token_budget is set", () => {
    const profileConfig: ProfileConfig = {
      profile: "subscription",
      providers: {},
      roles: {},
      context: { token_budget: 500 },
    };
    const manager = resolveContextBudgetManager(profileConfig);
    expect(manager).toBeInstanceOf(ContextBudgetManager);
  });

  it("propagates ContextBudgetManager's own validation error for an invalid token_budget (e.g. 0 or negative)", () => {
    const profileConfig: ProfileConfig = {
      profile: "subscription",
      providers: {},
      roles: {},
      context: { token_budget: 0 },
    };
    expect(() => resolveContextBudgetManager(profileConfig)).toThrow(TypeError);
  });
});

describe("assembleProfileDeps — context.token_budget wiring end-to-end (issue #36 slice 1)", () => {
  it("with no context.token_budget in config.yaml, the assembled injector behaves unbounded (backward compatibility)", () => {
    const profilesRoot = makeProfilesRoot("subscription"); // VALID_CONFIG_YAML has no `context:` key at all
    const deps = assembleSubscriptionDeps({ AI_AGENT_PROFILE: "subscription" }, profilesRoot);
    openDeps = deps;

    deps.memoryStore.insertMemory({ type: "identity", title: "Huge", content: "x".repeat(50_000) }, new Date().toISOString());
    const result = deps.injector.inject(undefined, new Date());

    expect(result.omitted).toBeUndefined();
    expect(result.memories).toHaveLength(1);
  });

  it("with context.token_budget set in config.yaml, the assembled injector enforces it and reports omissions", () => {
    const configWithBudget = `${VALID_CONFIG_YAML}
context:
  token_budget: 20
`;
    const profilesRoot = makeProfilesRoot("subscription", configWithBudget);
    const deps = assembleSubscriptionDeps({ AI_AGENT_PROFILE: "subscription" }, profilesRoot);
    openDeps = deps;

    const now = new Date().toISOString();
    deps.memoryStore.insertMemory({ type: "constraint", title: "Kept", content: "must stay" }, now);
    // "idea" is not a CORE_MEMORY_TYPES type, so a matching query is needed for it to reach the
    // budget stage at all (see the equivalent injector.test.ts comment for why).
    deps.memoryStore.insertMemory({ type: "idea", title: "Dropped", content: "gigantic ".repeat(80) }, now);

    const result = deps.injector.inject("gigantic", new Date());

    expect(result.memories.map((m) => m.memory.title)).toEqual(["Kept"]);
    expect(result.omitted?.map((o) => o.title)).toEqual(["Dropped"]);
  });
});

describe("resolveRejectThreshold", () => {
  it("a non-number profileConfig.workflow.reject_threshold (malformed YAML) falls through to tier 2, not treated as tier 1", () => {
    const store = new MemoryStore(":memory:");
    try {
      const systemConfig = new SystemConfig(store);
      systemConfig.set("default_reject_threshold", "7");
      const profileConfig: ProfileConfig = {
        profile: "subscription",
        providers: {},
        roles: {},
        workflow: { reject_threshold: "not-a-number" as unknown as number },
      };
      expect(resolveRejectThreshold(profileConfig, systemConfig)).toBe(7);
    } finally {
      store.close();
    }
  });
});
