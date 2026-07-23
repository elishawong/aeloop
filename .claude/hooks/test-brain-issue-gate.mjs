// test-brain-issue-gate.mjs — issue #88 B4 单元测试：brain-issue-gate.mjs。
//
// 真实 spawn 这个 hook（同 demo-wake-greeting.mjs 技术），断言两态行为（PRD §6.2）：
//   ① 默认档（不设 AELOOP_BRAIN_ISSUE_GATE）+ 无绑定 issue → allow
//   ② AELOOP_BRAIN_ISSUE_GATE=enforce + 无绑定 → deny
//   ③ AELOOP_BRAIN_ISSUE_GATE=enforce + bind-issue 后 → allow
//
// 跑法：node .claude/hooks/test-brain-issue-gate.mjs（零依赖）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "brain-issue-gate.mjs");
const REPO_ROOT = join(HERE, "..", "..");
const LOCK_LIB = join(HERE, "lib", "brain-lock.mjs");
const TARGET_FILE = join(REPO_ROOT, "some-file.ts"); // 不需要真实存在——hook 只用它的 dirname 判 repo

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

function cleanupSession(sessionId) {
  try {
    rmSync(join(REPO_ROOT, ".claude", "brain-locks", `${sessionId}.json`), { force: true });
  } catch {
    /* ignore */
  }
}

try {
  // ── ① 默认档（不设 env）+ 无绑定 issue → allow ──────────────────────────
  {
    const sessionId = "t-default-noissue";
    cleanupSession(sessionId);
    const out = runHook({ tool_name: "Edit", tool_input: { file_path: TARGET_FILE }, session_id: sessionId, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out).decision, "allow", "默认档（不设 env）无绑定 issue 应 allow");
    cleanupSession(sessionId);
  }

  // ── ② 默认档 + env 设了但不是 "enforce"（如误写 "true"/"1"）→ 仍应 allow ────
  {
    const sessionId = "t-default-wrongvalue";
    cleanupSession(sessionId);
    const out = runHook(
      { tool_name: "Edit", tool_input: { file_path: TARGET_FILE }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_ISSUE_GATE: "true" },
    );
    assert.equal(parseDenyOrAllow(out).decision, "allow", '非 "enforce" 的任何值都不该触发检查');
    cleanupSession(sessionId);
  }

  // ── ③ enforce 模式 + 无绑定 → deny ──────────────────────────────────────
  {
    const sessionId = "t-enforce-noissue";
    cleanupSession(sessionId);
    const out = runHook(
      { tool_name: "Edit", tool_input: { file_path: TARGET_FILE }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_ISSUE_GATE: "enforce" },
    );
    const result = parseDenyOrAllow(out);
    assert.equal(result.decision, "deny", "enforce 模式下无绑定 issue 应 deny");
    assert.equal(result.raw.hookSpecificOutput.hookEventName, "PreToolUse");
    cleanupSession(sessionId);
  }

  // ── ④ enforce 模式 + bind-issue 后 → allow ──────────────────────────────
  {
    const sessionId = "t-enforce-bound";
    cleanupSession(sessionId);
    const { bindIssue } = await import(LOCK_LIB);
    const bindResult = bindIssue(REPO_ROOT, sessionId, "elishawong/aeloop#88", { pid: 99002 });
    assert.equal(bindResult.ok, true, "测试前置：bindIssue 本身应成功");

    const out = runHook(
      { tool_name: "Edit", tool_input: { file_path: TARGET_FILE }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_ISSUE_GATE: "enforce" },
    );
    assert.equal(parseDenyOrAllow(out).decision, "allow", "enforce 模式下已绑定 issue 应 allow");
    cleanupSession(sessionId);
  }

  // ── ⑤ enforce 模式 + kill-switch → allow（即便无绑定） ──────────────────
  {
    const sessionId = "t-enforce-killswitch";
    cleanupSession(sessionId);
    const out = runHook(
      { tool_name: "Edit", tool_input: { file_path: TARGET_FILE }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_ISSUE_GATE: "enforce", AELOOP_BRAIN_SKIP_ISSUE_GATE: "1" },
    );
    assert.equal(parseDenyOrAllow(out).decision, "allow", "enforce 模式下 kill-switch 应仍能救");
    cleanupSession(sessionId);
  }

  // ── ⑥ 非 Edit/Write 工具（enforce 模式下）→ allow ───────────────────────
  {
    const sessionId = "t-enforce-nonedit";
    cleanupSession(sessionId);
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "echo hi" }, session_id: sessionId, cwd: REPO_ROOT },
      { AELOOP_BRAIN_ISSUE_GATE: "enforce" },
    );
    assert.equal(parseDenyOrAllow(out).decision, "allow", "enforce 模式下非 Edit/Write 工具应 allow");
    cleanupSession(sessionId);
  }

  console.log("PASS: test-brain-issue-gate.mjs (issue #88 B4 — 真实 spawn 验证两态：默认恒 allow / enforce 真 deny)");
} finally {
  ["t-default-noissue", "t-default-wrongvalue", "t-enforce-noissue", "t-enforce-bound", "t-enforce-killswitch", "t-enforce-nonedit"].forEach(
    cleanupSession,
  );
}
