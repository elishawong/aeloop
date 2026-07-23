// test-brain-isolation-guard.mjs — issue #88 B6 单元测试：brain-isolation-guard.mjs。
//
// 真实 spawn 这个 hook（同 demo-wake-greeting.mjs 技术），覆盖 PRD §6.2：
//   单会话场景 → 无警告文本；构造第二把新鲜锁 → 警告文本出现在 additionalContext；
//   无论哪种情况 exit code 恒 0（不阻断，回归检查）。
//
// test-hygiene（Zorro 2026-07-23 复审标出，非阻断项，本次顺带处理）：此前版本直接读写**真实
// 仓库自己**的 `.claude/brain-locks/`（用 `REPO_ROOT` 当 toplevel）——不是 hermetic：如果这个
// 目录同时有其它真实会话在跑（或多个测试并发跑），会互相读到对方写的锁文件，产生 flaky 结果。
// 改成每次跑都建一个**独立的临时 git 仓库**（`git init` 真实建仓库，因为 `resolveToplevel()`
// 靠 `git rev-parse --show-toplevel` 判定，不能用一个不是 git 仓库的临时目录糊弄过去），全程
// 只读写这个临时仓库自己的 `.claude/brain-locks/`，和真实仓库的锁目录完全隔离，跑完整体删除。
//
// 跑法：node .claude/hooks/test-brain-isolation-guard.mjs（零依赖，需要 git CLI）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "brain-isolation-guard.mjs");
const LOCK_LIB = join(HERE, "lib", "brain-lock.mjs");

// 独立临时 git 仓库，全程隔离于真实仓库的 `.claude/brain-locks/`（test-hygiene 修复）。
const TEST_REPO = mkdtempSync(join(tmpdir(), "brain-test-isolation-guard-"));
execFileSync("git", ["init", "-q", TEST_REPO]);

// 每个测试块之间清空锁目录——即便现在全部隔离在独立临时仓库里，4 个块共用同一个 TEST_REPO，
// 前一块留下的"新鲜"锁不清掉会污染后一块的"新鲜度"断言（同一个仓库、同一批锁文件）。
function clearAllLocks() {
  rmSync(join(TEST_REPO, ".claude", "brain-locks"), { recursive: true, force: true });
}

function runHook(payload, envOverrides = {}) {
  let stdout;
  let status = 0;
  try {
    stdout = execFileSync("node", [HOOK_PATH], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, ...envOverrides },
    });
  } catch (err) {
    // execFileSync 在非零退出码时抛错——本 hook 设计上应该恒 exit 0，这里如实记录状态供断言，
    // 而不是让测试因为"抛了异常"就笼统失败（那样反而测不出"是不是真的恒 0"这件事本身）。
    stdout = err.stdout ?? "";
    status = err.status ?? -1;
  }
  return { stdout, status };
}

try {
  // ── ① 单会话场景（自己 touch 心跳，没有其它活会话）→ 无警告文本，exit 0 ──────
  {
    clearAllLocks();
    const { stdout, status } = runHook({ session_id: "t-iso-solo", cwd: TEST_REPO });
    assert.equal(status, 0, "单会话场景应 exit 0");
    assert.equal(stdout.trim(), "", "单会话场景不该输出任何 additionalContext（安静，不刷屏）");
  }

  // ── ② 构造一把"新鲜"的别的会话锁，再跑 hook → 应出现警告文本，且仍 exit 0 ──────
  {
    clearAllLocks();
    const { touchHeartbeat } = await import(LOCK_LIB);
    touchHeartbeat(TEST_REPO, "t-iso-other-fresh", { pid: 88001 }); // 制造一把"刚刚活跃"的别人的锁

    const { stdout, status } = runHook({ session_id: "t-iso-self", cwd: TEST_REPO });
    assert.equal(status, 0, "检测到别的活会话时也应 exit 0（只警告不阻断）");
    assert.ok(stdout.trim().length > 0, "应该有 additionalContext 输出");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /worktree 隔离提醒/, "警告文案应包含隔离提醒关键词");
  }

  // ── ③ 别人的锁心跳已经"过期"（超过新鲜度阈值）→ 不该被当活会话告警 ──────────
  {
    clearAllLocks();
    const { touchHeartbeat } = await import(LOCK_LIB);
    // 心跳时间戳设成 10 分钟前（超过 5 分钟新鲜度阈值）。
    touchHeartbeat(TEST_REPO, "t-iso-other-stale", { pid: 88002, now: Date.now() - 10 * 60 * 1000 });

    const { stdout, status } = runHook({ session_id: "t-iso-self2", cwd: TEST_REPO });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "", "过期心跳不该被当活会话告警");
  }

  // ── ④ kill-switch → 恒无输出、exit 0 ────────────────────────────────────
  {
    clearAllLocks();
    const { touchHeartbeat } = await import(LOCK_LIB);
    touchHeartbeat(TEST_REPO, "t-iso-other-for-killswitch", { pid: 88003 });

    const { stdout, status } = runHook(
      { session_id: "t-iso-killswitch", cwd: TEST_REPO },
      { AELOOP_BRAIN_SKIP_ISOLATION_GUARD: "1" },
    );
    assert.equal(status, 0);
    assert.equal(stdout.trim(), "", "kill-switch 打开时即便有活会话也不该输出警告");
  }

  console.log("PASS: test-brain-isolation-guard.mjs (issue #88 B6 — 真实 spawn 验证 warn-only + 恒 exit 0，hermetic 临时仓库)");
} finally {
  rmSync(TEST_REPO, { recursive: true, force: true });
}
