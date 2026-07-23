// test-onboard-project.mjs — issue #93 B2 单元测试：onboard-project.mjs。
//
// 🔒 核心断言（指挥官 2026-07-23 明确要求）：onboard 前后，对目标 fixture 目录跑
// `git status --porcelain` 输出字节级相同——这是 epic #93 第一原则"目标 repo 零 brain 文件"的
// 自动化落地。**本文件只对可丢弃的临时 fixture git repo 跑，绝不碰真实 whoseorder 仓库**（真实
// whoseorder 验证是 B5 的人工 self-check，两者分开，见 PRD §4.3）。
//
// 跑法：node scripts/test-onboard-project.mjs（需要先 pnpm run build 生成 dist/，需要 git CLI）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onboardProject } from "./onboard-project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function gitStatusPorcelain(repoDir) {
  return git(repoDir, ["-C", repoDir, "status", "--porcelain"]);
}

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-onboard-"));
const dbDir = mkdtempSync(path.join(tmpdir(), "brain-test-onboard-db-"));
const dbPath = path.join(dbDir, "identity.db");
const originalEnv = process.env.AELOOP_BRAIN_IDENTITY_DB;

function withDb(fn) {
  process.env.AELOOP_BRAIN_IDENTITY_DB = dbPath;
  return fn();
}

async function main() {
  const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));

  // ── fixture: 一个真实、可丢弃的 git repo（不是真实 whoseorder） ──────────────────────────
  const repoDir = path.join(dir, "fixture-repo");
  git(dir, ["init", "-q", repoDir]);
  git(repoDir, ["-C", repoDir, "remote", "add", "origin", "git@github.com:someorg/some-fixture-repo.git"]);
  // 一个已提交的文件 + 干净工作区（模拟真实项目"未改动"状态）——避免 fixture 本身天然带着未
  // 追踪文件，让"前后 status 相同"这条断言从一开始就有意义（不是"两次都脏所以碰巧相同"）。
  const fs = await import("node:fs");
  fs.writeFileSync(path.join(repoDir, "README.md"), "fixture\n");
  git(repoDir, ["-C", repoDir, "add", "README.md"]);
  git(repoDir, ["-C", repoDir, "-c", "user.email=test@test.local", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

  const beforeStatus = gitStatusPorcelain(repoDir);
  assert.equal(beforeStatus, "", "fixture repo 初始应是干净工作区（前置条件）");

  let passCount = 0;
  function check(label, fn) {
    fn();
    passCount += 1;
    console.log(`  ok - ${label}`);
  }

  await withDb(async () => {
    // ① 首次 onboard → project_registry 正确插入
    const result1 = await onboardProject({ repoPath: repoDir, displayName: "fixture display name" });
    check("首次 onboard → owner/repo 正确解析 + action=inserted", () => {
      assert.equal(result1.owner, "someorg");
      assert.equal(result1.repo, "some-fixture-repo");
      assert.equal(result1.projectKey, "someorg/some-fixture-repo");
      assert.equal(result1.action, "inserted");
    });

    check("project_registry 记录内容正确", () => {
      const store = new MemoryStore(dbPath);
      try {
        const all = store.listMemories();
        const rec = all.find((m) => m.type === "project_registry");
        assert.ok(rec, "应存在一条 project_registry 记录");
        assert.equal(rec.title, "project:someorg/some-fixture-repo");
        assert.equal(rec.content, "fixture display name");
        assert.deepEqual(rec.tags, ["project:someorg/some-fixture-repo"]);
        assert.equal(rec.confidenceState, "confirmed");
      } finally {
        store.close();
      }
    });

    // ② 二次 onboard（内容不变）→ unchanged，零额外写入
    const result2 = await onboardProject({ repoPath: repoDir, displayName: "fixture display name" });
    check("二次 onboard（内容不变）→ unchanged", () => {
      assert.equal(result2.action, "unchanged");
      const store = new MemoryStore(dbPath);
      try {
        const count = store.listMemories().filter((m) => m.type === "project_registry").length;
        assert.equal(count, 1, "不应产生第二条记录");
      } finally {
        store.close();
      }
    });

    // ③ 🔒 核心断言：onboard 前后，fixture 目录 git status --porcelain 字节级相同
    const afterStatus = gitStatusPorcelain(repoDir);
    check("🔒 onboard 全程未接触 fixture 目录——git status --porcelain 前后字节级相同", () => {
      assert.equal(afterStatus, beforeStatus, "onboard 不应在目标项目留下任何痕迹");
      assert.equal(afterStatus, "", "且应该仍然是干净工作区");
    });
  });

  // ④ 非 git 目录 → 明确报错，身份库零写入
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    const freshDbDir = mkdtempSync(path.join(tmpdir(), "brain-test-onboard-freshdb-"));
    const freshDbPath = path.join(freshDbDir, "identity.db");
    process.env.AELOOP_BRAIN_IDENTITY_DB = freshDbPath;
    const notGitDir = mkdtempSync(path.join(tmpdir(), "brain-test-onboard-notgit-"));
    try {
      await assert.rejects(
        () => onboardProject({ repoPath: notGitDir }),
        /无法从.*判定 owner\/repo/,
        "非 git 目录应明确报错",
      );
      check("非 git 目录 → 报错 + 身份库零写入（db 文件都不应该被创建）", () => {
        assert.equal(fs.existsSync(freshDbPath), false, "不该因为报错路径而意外创建 db 文件");
      });
    } finally {
      rmSync(notGitDir, { recursive: true, force: true });
      rmSync(freshDbDir, { recursive: true, force: true });
    }
  }

  // ⑤ 身份库路径未配置 → 明确报错
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    await assert.rejects(
      () => onboardProject({ repoPath: repoDir }, { resolveDbPath: () => null }),
      /找不到身份库 dbPath/,
      "dbPath 未配置应明确报错",
    );
    console.log("  ok - dbPath 未配置 → 明确报错");
    passCount += 1;
  }

  console.log(`PASS: test-onboard-project.mjs (${passCount} assertions groups, issue #93 B2)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalEnv === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    else process.env.AELOOP_BRAIN_IDENTITY_DB = originalEnv;
    rmSync(dir, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });
