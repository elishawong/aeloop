/**
 * `assembleProfileDeps()` — profile-neutral dependency-graph wiring,
 * centralizing the exact same
 * real-object graph `src/loop.e2e.test.ts` already builds by hand:
 * `loadProfile()` -> `MemoryStore`/`ContextInjector` -> `PromptComposer` ->
 * `buildAdapterRegistry()`/`ProviderRouter` -> `AuditStore`+checkpointer.
 *
 * **Profile selection is explicit and fail-closed**. The requested profile
 * from the real environment must match the profile requested by the caller;
 * a brain or CLI cannot silently switch overlays after startup.
 *
 * **Ordering note on the `subscription`-only guard** (legacy A5 behavior /
 * §10 acceptance: "`AI_AGENT_PROFILE=apikey aeloop start "..."` fails with a
 * clear, typed `UnsupportedProfileError` message"): the requested profile
 * *name* (from `env`) is checked **before** `loadProfile()` ever runs, not
 * only afterward against the loaded config's own `profile` field. This
 * matters concretely: `profiles/apikey/` is the company-internal overlay
 * (`.gitignore`-blocked, `profile/loader.ts`'s own header) and typically
 * doesn't even exist on a machine running this CLI, so a request for
 * `AI_AGENT_PROFILE=apikey` would otherwise surface as `ProfileNotFoundError`
 * (a "config.yaml missing" story) instead of the precise "this CLI doesn't
 * support that profile yet" story the acceptance criterion asks for. The
 * second check, after a successful load, is defense-in-depth for the
 * (harder to hit, but not impossible) case where `profiles/subscription/
 * config.yaml`'s own `profile:` field disagrees with the directory it was
 * loaded from — not the primary path this guard exists for.
 *
 * **`CliDeps` extends the PRD §6.5 sketch with `injector`/`memoryStore`** —
 * my necessary addition, not silently deviating: the PRD's own §6.7
 * describes `main.ts`'s `start` command calling `ContextInjector.inject(task)`,
 * but §6.5's literal `CliDeps` sketch (`StartRunDeps & {profileConfig}`)
 * has nowhere for a caller to get that injector instance from, and nothing
 * else in this file's wiring keeps a handle to the `MemoryStore` for tests/
 * `main.ts` to `close()` when a command finishes. Both are constructed here
 * either way (per §6.5's own prose description of the wiring) — exposing
 * them on the returned object is the minimal fix for an otherwise-unusable
 * gap between §6.5's interface sketch and §6.7's described usage.
 *
 * **`profilesRoot` is a second necessary addition, absent from the PRD §6.5
 * signature sketch** — without it, this function can only ever point at the
 * real, permanent `profiles/subscription/` directory (real `memory.db`/
 * `workflow.db` files, real `cmd: claude`/`cmd: codex` provider entries),
 * which is correct for production (`bin.ts`) but unusable for B8's hard
 * vertical slice, whose whole point is driving *real* `main.ts` dispatch
 * against *fixture* cli-bridge binaries (`fake-claude.fixture.mjs`/
 * `fake-codex.fixture.mjs`, same fixture-substitution boundary
 * `src/loop.e2e.test.ts` already established) without ever touching the
 * real `profiles/subscription/` directory on disk or spawning a real
 * `claude`/`codex` process. Optional, defaulted to `loadProfile()`'s own
 * package-relative default (via `undefined`, which JS/TS default parameters
 * treat identically to omission) — same "explicit injection point for
 * tests, never read by production callers" pattern `profile/loader.ts`'s
 * own `profilesRoot` parameter already establishes; this function only
 * threads it through, it doesn't reinterpret it.
 */
import path from "node:path";
import { loadProfile, type ProfileConfig } from "../profile/loader.js";
import { resolvePersonaRoot } from "../profile/personas-root.js";
import { MemoryStore } from "../context/store.js";
import { SystemConfig } from "../context/config.js";
import { StalenessEngine } from "../context/staleness.js";
import { ContextBudgetManager } from "../context/budget.js";
import { ContextInjector } from "../context/injector.js";
import { PromptComposer } from "../prompt/composer.js";
import { buildAdapterRegistry } from "../harness/config.js";
import { ProviderRouter } from "../harness/provider-router.js";
import { createSqliteCheckpointer } from "../loop/checkpoint.js";
import { AuditStore } from "../loop/audit-store.js";
import type { StartRunDeps } from "../loop/runner.js";
import { UnsupportedProfileError } from "./errors.js";

const SUBSCRIPTION_PROFILE = "subscription";

export interface CliDeps extends StartRunDeps {
  profileConfig: ProfileConfig;
  injector: ContextInjector;
  memoryStore: MemoryStore;
  /**
   * The real, on-disk directory this profile was loaded from — added for
   * `run-origin.ts` (P0-2, `docs/feature/a5-cli-tui/test-report.md`), which
   * needs somewhere to keep its `run-origins.json` sidecar (a sibling of
   * `memory.db`/`workflow.db`, same directory convention). Not part of the
   * PRD §6.5 sketch, same "necessary addition, not silent deviation"
   * posture as `injector`/`memoryStore` above.
   */
  profileDir: string;
}

/**
 * Assembles the real `subscription`-profile dependency graph. `env`
 * defaults to `process.env`; `profilesRoot` defaults to `loadProfile()`'s
 * own package-relative default. Both are explicit injection points for
 * tests, never read/overridden implicitly by production callers
 * (`bin.ts` calls this with zero arguments).
 */
export function assembleProfileDeps(
  profileName: string,
  env: NodeJS.ProcessEnv = process.env,
  profilesRoot?: string,
): CliDeps {
  if (profileName.trim() === "") throw new Error("profileName must be a non-empty string");
  const requestedProfile = env["AI_AGENT_PROFILE"] ?? profileName;
  if (requestedProfile !== profileName) {
    throw new UnsupportedProfileError(requestedProfile);
  }

  // Deployments can mount private profiles outside the source checkout (for
  // example a company `apikey` profile) without copying credentials into the
  // public repository. Tests and embedders may still pass an explicit root.
  const resolvedProfilesRoot = profilesRoot ?? env["AELOOP_PROFILES_ROOT"];
  const result = loadProfile(requestedProfile, resolvedProfilesRoot);
  if (!result.ok) {
    throw result.error;
  }
  if (result.config.profile !== profileName) {
    throw new UnsupportedProfileError(result.config.profile);
  }

  const { profileDir, config } = result;
  // Issue #42: `config.personas` (optional) points PromptComposer at an
  // external persona-set root instead of `<profileDir>/personas` — see
  // `../profile/personas-root.js` for the full contract and fail-closed
  // error cases (unsafe/missing `AELOOP_PERSONAS_ROOT` never silently
  // falls back to the legacy default once a profile opts in).
  const personasDir = resolvePersonaRoot(profileDir, config, env);
  const memoryDbPath = path.join(profileDir, "memory.db");
  const workflowDbPath = path.join(profileDir, "workflow.db");

  const memoryStore = new MemoryStore(memoryDbPath);
  // Everything from here down that can throw (buildAdapterRegistry() on a malformed
  // config.providers entry, createSqliteCheckpointer()/new AuditStore() on a bad workflowDbPath)
  // runs after memoryStore has already opened a real better-sqlite3 connection (Zorro R2
  // re-review "顺手修": that connection used to have no owner if any of these threw — this
  // function itself never returned a CliDeps for the caller's withDeps()/afterEach() to close,
  // so the handle leaked for the rest of the process's lifetime, one leak per failed
  // `aeloop`/test invocation). checkpointer's own db connection has the same problem one step
  // later, so it's tracked and closed here too if AuditStore's construction is what throws.
  let checkpointer: ReturnType<typeof createSqliteCheckpointer> | undefined;
  try {
    const systemConfig = new SystemConfig(memoryStore);
    const staleness = new StalenessEngine(systemConfig);
    const budgetManager = resolveContextBudgetManager(config);
    const injector = new ContextInjector(memoryStore, staleness, budgetManager);
    const composer = new PromptComposer(personasDir);

    const registry = buildAdapterRegistry(config);
    const router = new ProviderRouter(config.roles, registry);

    checkpointer = createSqliteCheckpointer(workflowDbPath);
    const audit = new AuditStore(workflowDbPath);

    return { router, composer, audit, checkpointer, profileConfig: config, injector, memoryStore, profileDir };
  } catch (err) {
    checkpointer?.db.close();
    memoryStore.close();
    throw err;
  }
}

/** Backward-compatible personal CLI entry point. */
export function assembleSubscriptionDeps(env: NodeJS.ProcessEnv = process.env, profilesRoot?: string): CliDeps {
  return assembleProfileDeps(SUBSCRIPTION_PROFILE, env, profilesRoot);
}

/**
 * The documented three-tier reject-threshold chain (PRD §2 non-goal #6 /
 * A4b PRD §9.2 Decision 2, unchanged and not extended by A5):
 * `profileConfig.workflow?.reject_threshold` -> `SystemConfig.
 * getDefaultRejectThreshold()` -> hardcoded `2`. Independently unit-testable
 * — takes both inputs explicitly rather than reaching into a `CliDeps`
 * object, so a test can exercise all three tiers without assembling a full
 * dependency graph.
 */
/**
 * Builds a `ContextBudgetManager` from `profileConfig.context.token_budget`
 * (issue #36 slice 1), or `undefined` when that key is absent/not a valid
 * positive integer — matching `ProfileConfig.context`'s own documented
 * "absent = today's unbounded behavior" contract (`profile/loader.ts`).
 * `ContextBudgetManager`'s own constructor already throws for a non-integer
 * or non-positive value; a malformed `token_budget` in `config.yaml` should
 * surface as a loud startup error, not silently fall back to "no budget",
 * so that validation is intentionally *not* re-guarded here.
 *
 * Independently unit-testable — takes the parsed config directly, same
 * "explicit inputs, no full `CliDeps` graph needed" shape as
 * `resolveRejectThreshold()` below.
 */
export function resolveContextBudgetManager(profileConfig: ProfileConfig): ContextBudgetManager | undefined {
  const tokenBudget = profileConfig.context?.token_budget;
  if (tokenBudget === undefined) return undefined;
  return new ContextBudgetManager(tokenBudget);
}

export function resolveRejectThreshold(profileConfig: ProfileConfig, systemConfig: SystemConfig): number {
  const fromProfile = profileConfig.workflow?.reject_threshold;
  if (typeof fromProfile === "number") return fromProfile;

  const fromSystemConfig = systemConfig.getDefaultRejectThreshold();
  if (fromSystemConfig !== null) return fromSystemConfig;

  return 2;
}
