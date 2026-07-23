// test-brain-commit-gate.mjs — issue #88 B3 单元测试：brain-commit-gate.mjs。
//
// 真实 spawn 这个 hook（同 demo-wake-greeting.mjs 的技术：execFileSync("node",[HOOK],
// {input: JSON.stringify(payload)})），喂真实 stdin payload，断言 deny 输出的
// permissionDecision:"deny" JSON——不是读代码看逻辑。覆盖 PRD §6.2。
//
// 跑法：node .claude/hooks/test-brain-commit-gate.mjs（零依赖，不需要 pnpm build——commit-gate
// 本身不碰 MemoryStore/dist）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "brain-commit-gate.mjs");
const REPO_ROOT = join(HERE, "..", "..");
const LOCK_LIB = join(HERE, "lib", "brain-lock.mjs");

function runHook(payload, envOverrides = {}) {
  const stdout = execFileSync("node", [HOOK_PATH], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
  return stdout;
}

function parseDenyOrAllow(stdout) {
  if (!stdout || !stdout.trim()) return { decision: "allow" };
  const parsed = JSON.parse(stdout);
  return { decision: parsed?.hookSpecificOutput?.permissionDecision ?? "unknown", raw: parsed };
}

// 清理测试可能残留的锁文件（同一 sessionId 复用要注意状态干净）。
function cleanupSession(sessionId) {
  try {
    rmSync(join(REPO_ROOT, ".claude", "brain-locks", `${sessionId}.json`), { force: true });
  } catch {
    /* ignore */
  }
}

try {
  // ── ① 非 Bash → allow ──────────────────────────────────────────────────
  {
    const out = runHook({ tool_name: "Edit", tool_input: {}, session_id: "t-nonbash", cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "allow", "非 Bash 工具应 allow");
  }

  // ── ② 非 gated 命令 → allow ─────────────────────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git status" }, session_id: "t-nogate", cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "allow", "非 gated 命令（git status）应 allow");
  }

  // ── ③ gated 命令（git commit），无授权，目标是本仓库 → deny ─────────────────
  {
    const sessionId = "t-commit-noauth";
    cleanupSession(sessionId);
    const out = runHook({ tool_name: "Bash", tool_input: { command: 'git commit -m "x"' }, session_id: sessionId, cwd: REPO_ROOT });
    const result = parseDenyOrAllow(out);
    assert.equal(result.decision, "deny", "无授权时 git commit 应 deny");
    assert.equal(result.raw.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(typeof result.raw.hookSpecificOutput.permissionDecisionReason, "string");
    cleanupSession(sessionId);
  }

  // ── ④ 先授权（真实调 brain-lock.mjs 的 authorizeCommit），再 commit → allow；
  //     消费后再试一次 → deny（一次性、不滚动） ────────────────────────────────
  {
    const sessionId = "t-commit-authorized";
    cleanupSession(sessionId);
    const { authorizeCommit } = await import(LOCK_LIB);
    authorizeCommit(REPO_ROOT, sessionId, { pid: 99001 });

    const out1 = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out1).decision, "allow", "已授权时 git commit 应 allow");

    const out2 = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out2).decision, "deny", "同一令牌用过一次后，第二次 commit 应 deny（一次性、不滚动）");
    cleanupSession(sessionId);
  }

  // ── ⑤ git push --force 命中 gated（force-push 也是 git push 的一种，本身走 matchesGitSubcommand
  //     "push" 分支，不需要单独判 force）→ 无授权应 deny ────────────────────────
  {
    const sessionId = "t-push-noauth";
    cleanupSession(sessionId);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git push --force" }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "deny", "无授权时 git push --force 应 deny");
    cleanupSession(sessionId);
  }

  // ── ⑥ gh pr merge 命中 gated（issue #88 Pass 2 补齐）→ 无授权应 deny ─────────
  {
    const sessionId = "t-ghmerge-noauth";
    cleanupSession(sessionId);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 5" }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "deny", "无授权时 gh pr merge 应 deny");
    cleanupSession(sessionId);
  }

  // ── ⑦ git merge origin/main 命中 gated（issue #88 Pass 2 补齐）→ 无授权应 deny ─
  {
    const sessionId = "t-mergemain-noauth";
    cleanupSession(sessionId);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git merge origin/main" }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "deny", "无授权时 git merge origin/main 应 deny");
    cleanupSession(sessionId);
  }

  // ── ⑧ 非本仓库 cwd → allow（fail-open，范围明确不覆盖别的仓库） ────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m x" }, session_id: "t-otherrepo", cwd: "/tmp" });
    assert.equal(parseDenyOrAllow(out).decision, "allow", "/tmp 不是 git 仓库，应 fail-open allow");
  }

  // ── ⑨ kill-switch → allow ──────────────────────────────────────────────
  {
    const sessionId = "t-killswitch";
    cleanupSession(sessionId);
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "git commit -m x" }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_SKIP_COMMIT_GATE: "1" },
    );
    assert.equal(parseDenyOrAllow(out).decision, "allow", "kill-switch 打开时应恒 allow");
    cleanupSession(sessionId);
  }

  console.log("PASS: test-brain-commit-gate.mjs (issue #88 B3 — 真实 spawn 验证 deny/allow，含 gh-pr-merge/merge-main)");
} finally {
  // 兜底清理，避免测试残留污染下一次跑。
  ["t-nonbash", "t-nogate", "t-commit-noauth", "t-commit-authorized", "t-push-noauth", "t-ghmerge-noauth", "t-mergemain-noauth", "t-otherrepo", "t-killswitch"].forEach(
    cleanupSession,
  );
}
