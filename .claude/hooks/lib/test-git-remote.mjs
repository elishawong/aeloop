// test-git-remote.mjs — issue #88 B1 单元测试：git-remote.mjs。
//
// 覆盖 PRD §6.1："git-remote.mjs：SSH 形式与 HTTPS 形式均正确解析出 {owner, repo}；
// 非 git 目录/无 origin → {ok:false}"。
//
// 跑法：node .claude/hooks/lib/test-git-remote.mjs（零依赖，不需要 pnpm build，纯 node + git CLI）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getOriginOwnerRepo, resolveToplevel, OWNER_REPO_SEGMENT } from "./git-remote.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-git-remote-"));

try {
  // ① 非 git 目录 → {ok:false}
  {
    const notGitDir = mkdtempSync(path.join(tmpdir(), "brain-test-not-git-"));
    try {
      const result = getOriginOwnerRepo(notGitDir);
      assert.deepEqual(result, { ok: false }, "非 git 目录应返回 {ok:false}");
      assert.equal(resolveToplevel(notGitDir), null, "非 git 目录 resolveToplevel 应返回 null");
    } finally {
      rmSync(notGitDir, { recursive: true, force: true });
    }
  }

  // ② SSH 形式
  {
    const repoDir = path.join(dir, "ssh-repo");
    execFileSync("git", ["init", "-q", repoDir]);
    git(repoDir, ["-C", repoDir, "remote", "add", "origin", "git@github.com:elishawong/aeloop.git"]);
    const result = getOriginOwnerRepo(repoDir);
    assert.deepEqual(result, { ok: true, owner: "elishawong", repo: "aeloop" }, "SSH 形式应正确解析");
    const toplevel = resolveToplevel(repoDir);
    assert.equal(typeof toplevel, "string", "git 目录 resolveToplevel 应返回字符串");
  }

  // ③ HTTPS 形式（含 .git 后缀）
  {
    const repoDir = path.join(dir, "https-repo");
    execFileSync("git", ["init", "-q", repoDir]);
    git(repoDir, ["-C", repoDir, "remote", "add", "origin", "https://github.com/elishawong/aeloop.git"]);
    const result = getOriginOwnerRepo(repoDir);
    assert.deepEqual(result, { ok: true, owner: "elishawong", repo: "aeloop" }, "HTTPS 形式（含 .git）应正确解析");
  }

  // ④ HTTPS 形式（不含 .git 后缀）
  {
    const repoDir = path.join(dir, "https-nogit-repo");
    execFileSync("git", ["init", "-q", repoDir]);
    git(repoDir, ["-C", repoDir, "remote", "add", "origin", "https://github.com/elishawong/aeloop"]);
    const result = getOriginOwnerRepo(repoDir);
    assert.deepEqual(result, { ok: true, owner: "elishawong", repo: "aeloop" }, "HTTPS 形式（不含 .git）应正确解析");
  }

  // ⑤ git 目录但无 origin remote → {ok:false}
  {
    const repoDir = path.join(dir, "no-origin-repo");
    execFileSync("git", ["init", "-q", repoDir]);
    const result = getOriginOwnerRepo(repoDir);
    assert.deepEqual(result, { ok: false }, "无 origin remote 应返回 {ok:false}");
  }

  // ⑥ OWNER_REPO_SEGMENT 正则（供 brain-lock.mjs 复用）
  {
    assert.equal(OWNER_REPO_SEGMENT.test("elishawong"), true);
    assert.equal(OWNER_REPO_SEGMENT.test("ai-agent"), true);
    assert.equal(OWNER_REPO_SEGMENT.test("<owner>"), false, "占位符应被拒绝");
    assert.equal(OWNER_REPO_SEGMENT.test(".hidden"), false, "不能以非字母数字开头");
  }

  console.log("PASS: test-git-remote.mjs (issue #88 B1 — SSH/HTTPS 解析 + 非 git 目录 fail-open + OWNER_REPO_SEGMENT)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
