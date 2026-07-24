// test-wake-session-guard.mjs — issue #106 单元测试：wake-session-guard.mjs。
//
// 覆盖 DESIGN.md §3.2/PRD.md §5.1："首次 claim 成功；同 key 重复 claim 返回 already-claimed 且
// 不覆盖已有文件；不同 sessionId 互不影响；sweepStale 清超龄不清未超龄；状态只落 homedir、不受
// cwd 影响（DESIGN §1.5 红线的直接回归）；读写异常时 fail-open；sanitizeKey/resolveSessionId 和
// brain-lock.mjs 的同名函数行为对拍一致（build 阶段订正：本文件不 import brain-lock.mjs——那个
// 文件没有进 install-global-brain.mjs 的 COPY_ITEMS，import 会在全局安装场景下 MODULE_NOT_FOUND，
// 见 wake-session-guard.mjs 头注释——所以这里测的是"两份独立实现行为一致"，不是"同一个函数引用"）"。
//
// 跑法：node .claude/hooks/lib/test-wake-session-guard.mjs（零依赖，纯文件系统 I/O）。

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claim,
  sweepStale,
  guardStateDir,
  guardStatePath,
  sanitizeKey,
  resolveSessionId,
  DEFAULT_STALE_MS,
} from "./wake-session-guard.mjs";
import * as brainLock from "./brain-lock.mjs";

const homeDir = mkdtempSync(path.join(tmpdir(), "wake-guard-test-home-"));

try {
  // ── sanitizeKey / resolveSessionId：独立实现，但行为必须和 brain-lock.mjs 的同名函数一致
  //    （不是同一个函数引用——两文件刻意不共享 import，理由见 wake-session-guard.mjs 头注释）。
  {
    assert.notStrictEqual(sanitizeKey, brainLock.sanitizeKey, "sanitizeKey 应是独立实现（不 import brain-lock.mjs，避免全局安装场景 MODULE_NOT_FOUND）");
    const sanitizeSamples = ["../../etc/passwd", "session-abc-123", "with spaces", "unicode:测试", ""];
    for (const sample of sanitizeSamples) {
      assert.equal(sanitizeKey(sample), brainLock.sanitizeKey(sample), `sanitizeKey("${sample}") 应和 brain-lock.mjs 的实现行为一致`);
    }

    const envKeys = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "AELOOP_BRAIN_SESSION_ID"];
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    try {
      for (const k of envKeys) delete process.env[k];
      assert.equal(resolveSessionId(), null, "三个 env var 都没有时应返回 null");
      assert.equal(resolveSessionId(), brainLock.resolveSessionId(), "无 env var 时两份实现行为应一致");
      process.env.AELOOP_BRAIN_SESSION_ID = "test-resolve-session-id";
      assert.equal(resolveSessionId(), "test-resolve-session-id");
      assert.equal(resolveSessionId(), brainLock.resolveSessionId(), "设置 AELOOP_BRAIN_SESSION_ID 后两份实现行为应一致");
    } finally {
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  }

  // ── 首次 claim 成功 ──────────
  {
    const result = claim({ sessionId: "session-A", pid: 111, source: "SessionStart" }, { homeDir });
    assert.deepEqual(result, { claimed: true }, "首次 claim 应成功");
    const file = guardStatePath({ sessionId: "session-A", pid: 111 }, { homeDir });
    const record = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(record.sessionId, "session-A");
    assert.equal(record.source, "SessionStart");
    assert.equal(typeof record.claimedAt, "string");
  }

  // ── 同 key 重复 claim → already-claimed，不覆盖已有文件内容 ──────────
  {
    const before = readFileSync(guardStatePath({ sessionId: "session-A", pid: 111 }, { homeDir }), "utf8");
    const result = claim({ sessionId: "session-A", pid: 999, source: "UserPromptSubmit" }, { homeDir });
    assert.deepEqual(result, { claimed: false, reason: "already-claimed" }, "重复 claim 应返回 already-claimed");
    const after = readFileSync(guardStatePath({ sessionId: "session-A", pid: 111 }, { homeDir }), "utf8");
    assert.equal(after, before, "重复 claim 不应覆盖已有的 claim 文件内容（O_EXCL 语义）");
  }

  // ── 不同 sessionId 互不影响，各自能 claim 成功 ──────────
  {
    const resultB = claim({ sessionId: "session-B", pid: 222, source: "UserPromptSubmit" }, { homeDir });
    assert.deepEqual(resultB, { claimed: true }, "不同 sessionId 应各自能 claim 成功");
    const resultC = claim({ sessionId: "session-C", pid: 333, source: "standalone" }, { homeDir });
    assert.deepEqual(resultC, { claimed: true }, "第三个不同 sessionId 也应各自能 claim 成功");
  }

  // ── sessionId 缺失时退回 pid ──────────
  {
    const result1 = claim({ pid: 4001, source: "standalone" }, { homeDir });
    assert.deepEqual(result1, { claimed: true }, "无 sessionId 时首次按 pid claim 应成功");
    const result2 = claim({ pid: 4001, source: "standalone" }, { homeDir });
    assert.deepEqual(result2, { claimed: false, reason: "already-claimed" }, "同 pid 重复 claim 应 already-claimed");
  }

  // ── 状态只落 homedir，不受 cwd 影响（DESIGN §1.5 红线的直接回归） ──────────
  {
    const originalCwd = process.cwd();
    const fakeProjectDir = mkdtempSync(path.join(tmpdir(), "wake-guard-test-fake-project-"));
    try {
      process.chdir(fakeProjectDir);
      const result = claim({ sessionId: "session-cwd-check", pid: 555, source: "SessionStart" }, { homeDir });
      assert.deepEqual(result, { claimed: true }, "切换 cwd 后 claim 仍应正常工作");
      // 🔒 Zorro R1 blocker B1 复审发现（2026-07-24）：这条断言此前被错放在下面的 finally 块
      // *之后*——`rmSync(fakeProjectDir, ...)` 先把整个目录删掉，再断言"目录里没有 .claude"，
      // 目录本身都不存在了，断言恒为真，是一次空验（vacuous check），从没有真的验证过任何东西。
      // 现在挪到 `rmSync` **之前**（还在 try 块内、目录还活着的时候）才是真的在验证。
      assert.equal(existsSync(path.join(fakeProjectDir, ".claude")), false, "不应在目标项目目录下产生任何 .claude 状态");
    } finally {
      process.chdir(originalCwd);
      rmSync(fakeProjectDir, { recursive: true, force: true });
    }
    // 断言：状态文件确实落在 homeDir 下预期路径。
    assert.equal(
      guardStatePath({ sessionId: "session-cwd-check", pid: 555 }, { homeDir }),
      path.join(guardStateDir(homeDir), `${sanitizeKey("session-cwd-check")}.json`),
      "状态文件路径应完全由 homeDir 决定，与 cwd 无关",
    );
  }

  // ── B1（Zorro R1 blocker，2026-07-24，独立 Codex 复现坐实）：相对路径 homeDir 必须 fail-closed
  //    ——不能把守卫状态落进 cwd（大概率是目标第三方项目仓库）里 ──────────
  {
    assert.throws(() => guardStateDir("."), /homeDir 必须是绝对路径/, "guardStateDir() 对非绝对路径必须直接抛错");
    assert.throws(() => guardStateDir("relative/path"), /homeDir 必须是绝对路径/, "相对路径（不带 './' 前缀）同样必须拒绝");
    assert.throws(() => guardStateDir(""), /homeDir 必须是绝对路径/, "空字符串同样必须拒绝");

    const originalCwd = process.cwd();
    const fakeProjectDir2 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-fake-project-relhome-"));
    try {
      process.chdir(fakeProjectDir2);
      // 复现 Zorro 的攻击场景：homeDir 被误配置成相对路径（比如 `HOME=.`），cwd 恰好是目标
      // 第三方项目仓库——claim() 必须 fail-closed（不写盘），返回 {claimed:false, reason:"error"}
      // （B2 修复后，调用方会把这个 reason 当"允许输出"处理，但这里只测 guard 自己的行为：
      // 绝不能真的往 fakeProjectDir2 里写任何东西）。
      const result = claim({ sessionId: "session-relative-home", pid: 888, source: "SessionStart" }, { homeDir: "." });
      assert.deepEqual(result, { claimed: false, reason: "error" }, "相对路径 homeDir 必须 fail-closed 返回 error，不能假装 claim 成功");
      assert.equal(existsSync(path.join(fakeProjectDir2, ".claude")), false, "相对路径 homeDir 绝不能在 cwd（目标项目仓库）里写出任何 .claude 状态——这是 B1 要堵的红线破坏场景");
    } finally {
      process.chdir(originalCwd);
      rmSync(fakeProjectDir2, { recursive: true, force: true });
    }
  }

  // ── sweepStale：清超龄（>48h），不清未超龄（<48h） ──────────
  {
    const now = Date.now();
    const staleResult = claim({ sessionId: "session-stale", pid: 666, source: "SessionStart" }, { homeDir, now });
    assert.deepEqual(staleResult, { claimed: true });
    const freshResult = claim({ sessionId: "session-fresh", pid: 777, source: "SessionStart" }, { homeDir, now });
    assert.deepEqual(freshResult, { claimed: true });

    const staleFile = guardStatePath({ sessionId: "session-stale", pid: 666 }, { homeDir });
    const freshFile = guardStatePath({ sessionId: "session-fresh", pid: 777 }, { homeDir });
    // 把 stale 文件的 mtime 改到 49 小时前，fresh 文件改到 23 小时前。
    const past49h = new Date(now - 49 * 60 * 60 * 1000);
    const past23h = new Date(now - 23 * 60 * 60 * 1000);
    utimesSync(staleFile, past49h, past49h);
    utimesSync(freshFile, past23h, past23h);

    sweepStale({ homeDir, now, maxAgeMs: DEFAULT_STALE_MS });

    assert.equal(existsSync(staleFile), false, "超过 48h 的状态文件应被清理");
    assert.equal(existsSync(freshFile), true, "未超过 48h 的状态文件不应被清理");
  }

  // ── claim() 内部也会 opportunistic sweepStale（不需要调用方单独调用） ──────────
  {
    const now = Date.now();
    const oldResult = claim({ sessionId: "session-old-2", pid: 888, source: "SessionStart" }, { homeDir, now });
    assert.deepEqual(oldResult, { claimed: true });
    const oldFile = guardStatePath({ sessionId: "session-old-2", pid: 888 }, { homeDir });
    const past50h = new Date(now - 50 * 60 * 60 * 1000);
    utimesSync(oldFile, past50h, past50h);

    // 触发一次全新的 claim（不同 session），其内部的 opportunistic sweepStale 应该顺带清掉上面这条。
    claim({ sessionId: "session-trigger-sweep", pid: 999, source: "SessionStart" }, { homeDir, now: now + 1000 });

    assert.equal(existsSync(oldFile), false, "claim() 内部的 opportunistic sweepStale 应该清掉超龄文件");
  }

  // ── 读写异常时 fail-open：claim() 不抛出，返回 {claimed:false, reason:"error"} ──────────
  {
    // 构造一个不可写的守卫状态目录的父目录（把 homeDir 下 .claude/aeloop-brain 建成一个文件而不是
    // 目录，mkdirSync(recursive) 会失败）。
    const brokenHome = mkdtempSync(path.join(tmpdir(), "wake-guard-test-broken-home-"));
    mkdirSync(path.join(brokenHome, ".claude"), { recursive: true });
    writeFileSync(path.join(brokenHome, ".claude", "aeloop-brain"), "this is a file, not a directory");
    try {
      let threw = false;
      let result;
      try {
        result = claim({ sessionId: "session-broken", pid: 1010, source: "SessionStart" }, { homeDir: brokenHome });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, "claim() 遇到读写异常不应抛出（fail-open）");
      assert.deepEqual(result, { claimed: false, reason: "error" }, "读写异常时应返回 {claimed:false, reason:'error'}");
    } finally {
      rmSync(brokenHome, { recursive: true, force: true });
    }
  }

  // ── N1（Zorro R2 blocker，2026-07-24，独立 Codex 复现坐实，B2 只修了一半）：mkdirSync 阶段的
  //    EEXIST（状态目录路径本身被一个普通文件占据——腐坏态，不是 claim 竞争）绝不能被误判成
  //    already-claimed ──────────
  {
    // 和上面"读写异常时 fail-open"那条的区别：上面占的是**父目录**（`.claude/aeloop-brain`），
    // 触发的是 ENOTDIR；这里占的是 `guardStateDir()` 的**返回值本身**（`wake-session-state`
    // 这个叶子路径），已实测确认 `mkdirSync(recursive:true)` 在这种情况下抛的是 `EEXIST`
    // （"EEXIST: file already exists, mkdir '<path>'"）——和 `writeFileSync(...,{flag:'wx'})`
    // 真正的 claim 竞争会抛的错误码完全相同，这正是 N1 要堵的混淆点。
    const homeDirLeafOccupied = mkdtempSync(path.join(tmpdir(), "wake-guard-test-leafexist-home-"));
    mkdirSync(path.join(homeDirLeafOccupied, ".claude", "aeloop-brain"), { recursive: true });
    writeFileSync(
      path.join(homeDirLeafOccupied, ".claude", "aeloop-brain", "wake-session-state"),
      "这是一个文件，占据了 guardStateDir() 本该是目录的那个路径——mkdirSync 会抛 EEXIST，不是 claim 竞争",
    );
    try {
      const result = claim({ sessionId: "session-leaf-occupied", pid: 2020, source: "SessionStart" }, { homeDir: homeDirLeafOccupied });
      assert.deepEqual(
        result,
        { claimed: false, reason: "error" },
        `状态目录路径被文件占据（mkdir EEXIST）必须判 reason:"error"，不能误判成 already-claimed，实际返回 ${JSON.stringify(result)}`,
      );
    } finally {
      rmSync(homeDirLeafOccupied, { recursive: true, force: true });
    }
  }

  // ── N3（Zorro R3 blocker，2026-07-24，Zorro + 独立 Codex 双模型复现坐实，B2→N1→N3 同一根因
  //    第三次发作）：exact claim 文件路径本身（不是父目录/状态目录，是 guardStatePath() 精确算
  //    出来的那个叶子路径）被 目录 / 软链→目录 / 悬空软链 占据时，writeFileSync(...,{flag:"wx"})
  //    同样先抛 EEXIST——必须判 reason:"error"，不能被无条件当成 already-claimed。合法的旧
  //    claim 普通文件必须继续保留 already-claimed 判定（by-design 去重不能破）。──────────
  {
    const sessionIdBase = "session-n3-claimpath-occupied";

    // ① claim 文件路径本身是一个目录（不是文件）。
    {
      const homeDir1 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-dir-"));
      try {
        const claimPath = guardStatePath({ sessionId: `${sessionIdBase}-dir` }, { homeDir: homeDir1 });
        mkdirSync(claimPath, { recursive: true }); // claim 文件路径本身建成一个目录
        const result = claim({ sessionId: `${sessionIdBase}-dir`, pid: 3001, source: "SessionStart" }, { homeDir: homeDir1 });
        assert.deepEqual(
          result,
          { claimed: false, reason: "error" },
          `claim 文件路径被目录占据必须判 reason:"error"，不能误判成 already-claimed，实际返回 ${JSON.stringify(result)}`,
        );
      } finally {
        rmSync(homeDir1, { recursive: true, force: true });
      }
    }

    // ② claim 文件路径本身是一个指向目录的软链。
    {
      const homeDir2 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-symlinkdir-"));
      try {
        const claimPath = guardStatePath({ sessionId: `${sessionIdBase}-symlinkdir` }, { homeDir: homeDir2 });
        const realDir = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-symlinkdir-target-"));
        mkdirSync(path.dirname(claimPath), { recursive: true });
        symlinkSync(realDir, claimPath); // claim 文件路径本身是一个指向真实目录的软链
        try {
          const result = claim({ sessionId: `${sessionIdBase}-symlinkdir`, pid: 3002, source: "SessionStart" }, { homeDir: homeDir2 });
          assert.deepEqual(
            result,
            { claimed: false, reason: "error" },
            `claim 文件路径被"指向目录的软链"占据必须判 reason:"error"（statSync 会跟随软链误判成目录本身，必须用 lstatSync 不跟随），实际返回 ${JSON.stringify(result)}`,
          );
        } finally {
          rmSync(realDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(homeDir2, { recursive: true, force: true });
      }
    }

    // ③ claim 文件路径本身是一个悬空软链（指向不存在的路径）。
    {
      const homeDir3 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-danglingsymlink-"));
      try {
        const claimPath = guardStatePath({ sessionId: `${sessionIdBase}-dangling` }, { homeDir: homeDir3 });
        mkdirSync(path.dirname(claimPath), { recursive: true });
        symlinkSync(path.join(homeDir3, "this-target-does-not-exist"), claimPath); // 悬空软链
        const result = claim({ sessionId: `${sessionIdBase}-dangling`, pid: 3003, source: "SessionStart" }, { homeDir: homeDir3 });
        assert.deepEqual(
          result,
          { claimed: false, reason: "error" },
          `claim 文件路径被悬空软链占据必须判 reason:"error"，不能误判成 already-claimed，实际返回 ${JSON.stringify(result)}`,
        );
      } finally {
        rmSync(homeDir3, { recursive: true, force: true });
      }
    }

    // ④ 对照组：合法的旧 claim 普通文件——by-design 去重必须保留，不能被 N3 的修法误伤。
    {
      const homeDir4 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-legitfile-"));
      try {
        const first = claim({ sessionId: `${sessionIdBase}-legit`, pid: 3004, source: "SessionStart" }, { homeDir: homeDir4 });
        assert.deepEqual(first, { claimed: true }, "首次 claim（真实写出一个合法的普通文件）应该成功");
        const second = claim({ sessionId: `${sessionIdBase}-legit`, pid: 3005, source: "UserPromptSubmit" }, { homeDir: homeDir4 });
        assert.deepEqual(
          second,
          { claimed: false, reason: "already-claimed" },
          "合法的旧 claim 普通文件必须继续判 already-claimed——N3 的修法不能破坏 by-design 去重",
        );
      } finally {
        rmSync(homeDir4, { recursive: true, force: true });
      }
    }

    // ⑤（🟡 指挥官 2026-07-24 复核要求，load-bearing 锁定测试）claim 文件路径本身是一个"指向
    // 真实普通文件"的软链——这条和上面 ② 的"软链→目录"关键区别：软链→目录在 statSync 下
    // isFile() 也是 false，靠那条用例锁不住"用的是 lstatSync 不是 statSync"这个决定（把
    // lstatSync 误改回 statSync，② 照样绿）。这里用软链→**普通文件**：statSync(link).isFile()
    // 是 true（跟随软链，报的是目标文件的类型），lstatSync(link).isFile() 是 false（不跟随，
    // 报的是软链自己的类型）——已用 node -e 真机实测确认这个差异。claim() 必须返回
    // reason:"error"（不是 already-claimed），这条断言只有代码真的用 lstatSync 才会通过；一旦
    // 被改回 statSync，这条用例会失败（变红），是专门锁住这个实现细节的回归。
    {
      const homeDir5 = mkdtempSync(path.join(tmpdir(), "wake-guard-test-n3-symlinktofile-"));
      try {
        const claimPath5 = guardStatePath({ sessionId: `${sessionIdBase}-symlinktofile` }, { homeDir: homeDir5 });
        mkdirSync(path.dirname(claimPath5), { recursive: true });
        const realFile5 = path.join(homeDir5, "real-target-file.json");
        writeFileSync(realFile5, JSON.stringify({ note: "真实的普通文件，不是本文件自己写的 claim 记录格式，但 isFile() 为真" }));
        symlinkSync(realFile5, claimPath5); // claim 文件路径本身是一个指向真实普通文件的软链

        // fixture 自检：确认这台机器上 statSync/lstatSync 对这个软链的行为和文件头注释描述的
        // 一致——不假设，真的测一遍，避免这条用例本身建立在一个错误的平台假设上。
        assert.equal(statSync(claimPath5).isFile(), true, "fixture 自检：statSync（跟随软链）应该看到目标是个文件");
        assert.equal(lstatSync(claimPath5).isFile(), false, "fixture 自检：lstatSync（不跟随软链）应该看到这个路径本身是软链，不是文件");

        const result = claim({ sessionId: `${sessionIdBase}-symlinktofile`, pid: 3006, source: "SessionStart" }, { homeDir: homeDir5 });
        assert.deepEqual(
          result,
          { claimed: false, reason: "error" },
          `claim 文件路径被"指向普通文件的软链"占据必须判 reason:"error"（证明 claim() 用的是 lstatSync 不跟随软链，不是 statSync），实际返回 ${JSON.stringify(result)}`,
        );
      } finally {
        rmSync(homeDir5, { recursive: true, force: true });
      }
    }
  }

  // ── sweepStale({homeDir:"."}) 不抛出（B1/B4 顺手补的边界：sweepStale 自己的"绝不抛出"承诺
  //    在 homeDir 校验失败这条新路径上也要成立，不能只在 claim() 层面测过） ──────────
  {
    let threw = false;
    try {
      sweepStale({ homeDir: "." });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "sweepStale({homeDir:'.'}) 不应抛出——guardStateDir() 的非绝对路径校验失败必须被 sweepStale 自己 catch 住，维持它自己的'绝不抛出'承诺");
  }

  console.log(
    "PASS: test-wake-session-guard.mjs (issue #106 — claim 首次成功/重复 already-claimed/O_EXCL 语义/状态只落 homedir/sweepStale 48h/fail-open/sanitizeKey+resolveSessionId 复用/N1 mkdir-EEXIST 不误判/sweepStale 相对路径不抛出/N3 claim 路径被目录-软链目录-悬空软链-软链→普通文件占据均判 error(软链→普通文件锁定 lstat 不是 stat)，合法旧文件仍 already-claimed)",
  );
} finally {
  rmSync(homeDir, { recursive: true, force: true });
}
