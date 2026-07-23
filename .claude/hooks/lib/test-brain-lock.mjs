// test-brain-lock.mjs — issue #88 B2（+ Pass 2 B6 补的 touchHeartbeat/listAllLocks）单元测试：
// brain-lock.mjs。
//
// 覆盖 PRD §6.1："authorizeCommit()→立即 hasValidCommitAuthorization() true；
// consumeCommitAuthorization() 消费一次后再调用返回 {consumed:false, reason:'invalid'}；
// now 缺失/NaN → 判无效；未来时间戳超出容差 → 判无效（BUG-7 两条回归）"，
// 以及 bindIssue/findOwnLock 的格式校验 + 读写往返 + touchHeartbeat/listAllLocks（供 B6 用）。
//
// 跑法：node .claude/hooks/lib/test-brain-lock.mjs（零依赖，纯文件系统 I/O）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hasValidCommitAuthorization,
  authorizeCommit,
  consumeCommitAuthorization,
  bindIssue,
  findOwnLock,
  touchHeartbeat,
  listAllLocks,
  sanitizeKey,
  lockPath,
  locksDir,
} from "./brain-lock.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-lock-"));
execFileSync("git", ["init", "-q", dir]); // findOwnLock/authorizeCommit 本身不要求真 git 仓库，
// 但保持和真实调用场景一致（toplevel 通常来自 resolveToplevel）。

try {
  // ── hasValidCommitAuthorization 五条判据（纯函数，精确复刻源文件） ──────────
  {
    const now = Date.now();
    // ① 缺/坏 now → 无效
    assert.equal(hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now).toISOString() }, {}), false, "缺 now 应无效");
    assert.equal(
      hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now).toISOString() }, { now: NaN }),
      false,
      "NaN now 应无效",
    );
    // ② commitAuthorizedAt 缺失 → 无效
    assert.equal(hasValidCommitAuthorization({}, { now }), false, "从未授权应无效");
    // ③ 已消费 → 无效
    assert.equal(
      hasValidCommitAuthorization(
        { commitAuthorizedAt: new Date(now).toISOString(), commitAuthorizationConsumedAt: new Date(now).toISOString() },
        { now },
      ),
      false,
      "已消费应无效",
    );
    // ④ BUG-7：未来时间戳超出容差 → 无效
    assert.equal(
      hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now + 60_000).toISOString() }, { now }),
      false,
      "未来 60s 的时间戳（超出 5s 容差）应无效",
    );
    // 未来时间戳在容差内 → 有效（正常时钟抖动不该被拒）
    assert.equal(
      hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now + 2_000).toISOString() }, { now }),
      true,
      "未来 2s（容差内）应仍有效",
    );
    // ⑤ 超龄 → 无效
    assert.equal(
      hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now - 700_000).toISOString() }, { now }),
      false,
      "超过 10 分钟应无效",
    );
    // 正常有效
    assert.equal(
      hasValidCommitAuthorization({ commitAuthorizedAt: new Date(now - 1_000).toISOString() }, { now }),
      true,
      "1 秒前授权、未消费、未超龄应有效",
    );
  }

  // ── authorizeCommit → consumeCommitAuthorization 往返（一次性令牌） ──────────
  {
    const sessionId = "test-session-1";
    authorizeCommit(dir, sessionId, { pid: 111 });
    const result1 = consumeCommitAuthorization(dir, sessionId, { pid: 111 });
    assert.deepEqual(result1, { consumed: true }, "首次消费应成功");
    const result2 = consumeCommitAuthorization(dir, sessionId, { pid: 111 });
    assert.deepEqual(result2, { consumed: false, reason: "invalid" }, "二次消费应失败（一次性、不滚动）");
  }

  // ── 从未授权的 session 消费 → no-lock ──────────
  {
    const result = consumeCommitAuthorization(dir, "never-authorized-session", { pid: 222 });
    assert.deepEqual(result, { consumed: false, reason: "no-lock" }, "从未授权过应返回 no-lock");
  }

  // ── finding-4b 回归：消费时写盘失败 → fail-closed 返回 write-failed，不是让异常冒泡 ──────
  // 制造一个真实的写失败场景：先正常授权（锁文件已存在、有效），再把锁文件本身 chmod 成只读，
  // 让随后的 consumeCommitAuthorization 内部的 writeFileSync 真的抛错（不是 mock，是真实 I/O 失败）。
  {
    const sessionId = "test-session-writefail";
    authorizeCommit(dir, sessionId, { pid: 444 });
    const lockFilePath = lockPath(dir, sessionId);
    const fs = await import("node:fs");
    fs.chmodSync(lockFilePath, 0o444); // 只读，之后的写入应该失败（非 root 用户下）
    try {
      let threw = false;
      let result;
      try {
        result = consumeCommitAuthorization(dir, sessionId, { pid: 444 });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "写失败不该让异常冒泡出这个函数（fail-closed 是靠返回值表达，不是靠抛错）");
      assert.deepEqual(result, { consumed: false, reason: "write-failed" }, "写失败应返回 write-failed，不是静默当成功");
    } finally {
      fs.chmodSync(lockFilePath, 0o644); // 恢复可写，避免影响后续清理
    }
  }

  // ── bindIssue 格式校验 + findOwnLock 读回 ──────────
  {
    const sessionId = "test-session-2";
    const bad = bindIssue(dir, sessionId, "<owner>/<repo>#88", { pid: 333 });
    assert.equal(bad.ok, false, "占位符格式应被拒绝");

    const bad2 = bindIssue(dir, sessionId, "not-a-valid-ref", { pid: 333 });
    assert.equal(bad2.ok, false, "非 owner/repo#n 形式应被拒绝");

    const good = bindIssue(dir, sessionId, "elishawong/aeloop#88", { pid: 333 });
    assert.equal(good.ok, true, "合法格式应绑定成功");

    const lock = findOwnLock(dir, { sessionId, pid: 333 });
    assert.ok(lock, "findOwnLock 应读到刚绑定的锁");
    assert.equal(lock.issue, "elishawong/aeloop#88", "issue 字段应归一化为小写并原样写入");
  }

  // ── findOwnLock：sessionId 精确匹配，不退回按 pid 试探（同源文件设计） ──────────
  {
    const result = findOwnLock(dir, { sessionId: "some-other-session-never-bound", pid: 333 });
    assert.equal(result, null, "sessionId 不匹配时不该退回按 pid 试探（即便 pid 恰好相同）");
  }

  // ── sanitizeKey / lockPath / locksDir 路径 helper 健全性 ──────────
  {
    assert.equal(sanitizeKey("../../etc/passwd"), ".._.._etc_passwd", "路径分隔符应被清洗");
    assert.equal(lockPath(dir, "abc").startsWith(locksDir(dir)), true, "lockPath 应落在 locksDir 内");
  }

  // ── touchHeartbeat / listAllLocks（issue #88 Pass 2 B6 补充） ──────────
  {
    const sessionA = "t-heartbeat-a";
    const sessionB = "t-heartbeat-b";
    touchHeartbeat(dir, sessionA, { pid: 501 });
    touchHeartbeat(dir, sessionB, { pid: 502 });

    const all = listAllLocks(dir);
    const foundA = all.find((l) => l.sessionId === sessionA);
    const foundB = all.find((l) => l.sessionId === sessionB);
    assert.ok(foundA, "listAllLocks 应包含刚 touch 过的 session A");
    assert.ok(foundB, "listAllLocks 应包含刚 touch 过的 session B");
    assert.equal(typeof foundA.heartbeatAt, "string", "heartbeatAt 应是字符串时间戳");

    // 二次 touch 应刷新 heartbeatAt，不是重新建一把不相关的锁（issue 字段等其它内容应保留）。
    bindIssue(dir, sessionA, "elishawong/aeloop#88", { pid: 501 });
    const before = findOwnLock(dir, { sessionId: sessionA, pid: 501 });
    touchHeartbeat(dir, sessionA, { pid: 501, now: Date.now() + 1000 });
    const after = findOwnLock(dir, { sessionId: sessionA, pid: 501 });
    assert.equal(after.issue, before.issue, "touchHeartbeat 不该丢失已有的 issue 字段");
    assert.notEqual(after.heartbeatAt, before.heartbeatAt, "touchHeartbeat 应刷新 heartbeatAt");
  }

  console.log("PASS: test-brain-lock.mjs (issue #88 B2+B6 — 五条时效判据 + 一次性令牌往返 + bindIssue/findOwnLock + touchHeartbeat/listAllLocks)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
