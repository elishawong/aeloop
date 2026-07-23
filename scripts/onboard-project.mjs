#!/usr/bin/env node
/**
 * onboard-project.mjs — 纯中心注册（issue #93 B2，docs/conductor-brain-multiproject/PRD.md
 * §4.3/§1.4，DESIGN §1.4 方案 A）。
 *
 * 🔒 对目标项目的**唯一**接触 = 一次只读 `git remote get-url origin`（经 `getOriginOwnerRepo()`，
 * `.claude/hooks/lib/git-remote.mjs`，`execFileSync('git', ['-C', repoPath, ...])`，从不 `chdir`/
 * `cd` 进目标项目、不读目标项目任何其它文件）——物理上不可能在目标项目工作区留下任何痕迹，
 * `git status --porcelain` 运行前后字节级相同（`test-onboard-project.mjs` 已自动化断言）。
 *
 * 用法：node scripts/onboard-project.mjs --repo-path <path> [--display-name <name>]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOriginOwnerRepo } from "../.claude/hooks/lib/git-remote.mjs";
import { upsertMemory } from "../.claude/hooks/lib/memory-upsert.mjs";
import { resolveIdentityDbPath } from "../.claude/hooks/lib/db-path.mjs";
import { projectTagFor } from "../.claude/hooks/lib/project-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

/**
 * @param {{repoPath: string, displayName?: string}} args
 * @param {{
 *   resolveDbPath?: typeof resolveIdentityDbPath,
 *   openStore?: (dbPath: string) => Promise<import("../dist/context/store.js").MemoryStore>,
 * }} [deps]
 * @returns {Promise<{owner: string, repo: string, projectKey: string, action: string}>}
 */
export async function onboardProject(args, deps = {}) {
  const { repoPath, displayName } = args;
  const { resolveDbPath = resolveIdentityDbPath } = deps;

  const dbPath = resolveDbPath();
  if (!dbPath) {
    const err = new Error(
      "[onboard-project] 找不到身份库 dbPath——AELOOP_BRAIN_IDENTITY_DB / AELOOP_BRAIN_GLOBAL_MODE / " +
        ".claude/brain.local.json 均未配置。已中止，未写入任何数据。",
    );
    err.code = "NO_IDENTITY_DB_PATH";
    throw err;
  }

  const origin = getOriginOwnerRepo(repoPath);
  if (!origin.ok) {
    const err = new Error(
      `[onboard-project] 无法从 "${repoPath}" 判定 owner/repo（非 git 目录 / 无 origin remote / URL 认不出）。` +
        "已中止，未打开身份库、未写入任何数据。",
    );
    err.code = "CANNOT_RESOLVE_OWNER_REPO";
    throw err;
  }
  const { owner, repo } = origin;
  const projectKey = `${owner}/${repo}`;
  const projectTag = projectTagFor(owner, repo);

  const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));
  const store = deps.openStore ? await deps.openStore(dbPath) : new MemoryStore(dbPath);
  try {
    const outcome = upsertMemory(
      store,
      {
        type: "project_registry",
        title: projectTag,
        content: displayName ?? projectKey,
        tags: [projectTag],
        confidenceState: "confirmed",
      },
      { actor: "onboard-project" },
    );
    return { owner, repo, projectKey, action: outcome.action };
  } finally {
    store.close();
  }
}

function parseArgs(argv) {
  const args = { repoPath: undefined, displayName: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo-path") args.repoPath = argv[++i];
    else if (arg.startsWith("--repo-path=")) args.repoPath = arg.slice("--repo-path=".length);
    else if (arg === "--display-name") args.displayName = argv[++i];
    else if (arg.startsWith("--display-name=")) args.displayName = arg.slice("--display-name=".length);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repoPath) {
    console.error("用法：node scripts/onboard-project.mjs --repo-path <path> [--display-name <name>]");
    process.exitCode = 1;
  } else {
    onboardProject(args)
      .then((result) => {
        console.log(`[onboard-project] ${result.projectKey} — ${result.action}`);
      })
      .catch((err) => {
        console.error(err.message ?? String(err));
        process.exitCode = 1;
      });
  }
}
