// test-dispatch-brain-task.mjs — issue #93 B5 单元测试：dispatch-brain-task.mjs（自动化部分，
// 真实 LLM 调用/真实第三方仓库验证是 plan.md §B5 的人工 self-check，不在本文件范围内）。
//
// 覆盖 docs/conductor-brain-multiproject/PRD.md §6.6：
//   - 未注册项目 → 明确报错，不发起任何真实 LLM 调用（assembleDeps 零调用）。
//   - translateIntent 产出的 contract 的 policy.allowedPaths 不含目标项目路径（🔒 Level 1 范围
//     决定的回归断言——防止未来有人"顺手"把 allowedPaths 接到目标项目真实路径上）。
//
// 跑法：node scripts/test-dispatch-brain-task.mjs（需要先 pnpm run build 生成 dist/）。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchBrainTask, DEFAULT_ALLOWED_PATHS, REPO_ROOT } from "./dispatch-brain-task.mjs";
import { onboardProject } from "./onboard-project.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEST_REPO_ROOT = path.join(HERE, ".."); // 本文件自己 import translator.mjs 等要用，和上面
// import 进来的 dispatch-brain-task.mjs 自己的 REPO_ROOT 应该恒相等（同一个仓库），下面
// "🔒 cwd 钉死" 断言组会顺手验证这一点。

const dbDir = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-db-"));
const dbPath = path.join(dbDir, "identity.db");
const originalEnv = process.env.AELOOP_BRAIN_IDENTITY_DB;

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

async function main() {
  process.env.AELOOP_BRAIN_IDENTITY_DB = dbPath;

  // ── ① 未注册项目 → 明确报错，assembleDeps 零调用（不发起任何真实 LLM 调用） ──────────────
  {
    let assembleCalled = false;
    await assert.rejects(
      () =>
        dispatchBrainTask(
          { owner: "unregistered-owner", repo: "unregistered-repo", rawIntent: "do something" },
          {
            assembleDeps: async () => {
              assembleCalled = true;
              throw new Error("unreachable — should never be called for an unregistered project");
            },
          },
        ),
      (err) => {
        assert.equal(err.code, "PROJECT_NOT_ONBOARDED");
        assert.match(err.message, /尚未注册/);
        return true;
      },
      "未注册项目应明确报错",
    );
    check("未注册项目 → assembleDeps 零调用（不发起任何真实 LLM 调用）", () => {
      assert.equal(assembleCalled, false);
    });
  }

  // ── ② 已注册项目（fixture）：验证会走到"组装 TaskContract"这一步，且 allowedPaths 正确 ──
  //    （不真的跑 startRun/resumeRun——assembleDeps 注入到"组好 contract 后立即抛错"，
  //    只验证到组装 contract 为止的行为，真实 LLM 调用留给人工 self-check）。
  {
    const fs = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const fixtureRepoDir = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-fixture-repo-"));
    execFileSync("git", ["init", "-q", fixtureRepoDir]);
    execFileSync("git", ["-C", fixtureRepoDir, "remote", "add", "origin", "git@github.com:dispatchowner/dispatchrepo.git"]);

    try {
      await onboardProject({ repoPath: fixtureRepoDir });

      let capturedContract = null;
      let assembleCalled = false;
      await assert.rejects(
        () =>
          dispatchBrainTask(
            { owner: "dispatchowner", repo: "dispatchrepo", rawIntent: "写一个 reverseString(s) 冒烟验证" },
            {
              assembleDeps: async () => {
                assembleCalled = true;
                throw new Error("intentionally stop before real LLM call — test only verifies contract construction");
              },
            },
          ),
        () => true,
      );
      check("已注册项目 → 会走到 assembleDeps 这一步（说明前置检查通过）", () => {
        assert.equal(assembleCalled, true);
      });

      // 重新走一次翻译，独立验证 allowedPaths（不依赖上面那次因为 assembleDeps 抛错而中断的
      // 内部状态——直接调 dispatch-brain-task.mjs 用的同一份 translateIntent，逻辑上和
      // dispatchBrainTask() 内部第②步完全一致）。
      const { translateIntent } = await import(
        path.join(REPO_ROOT, "docs", "conductor-brain-layer", "spike", "lib", "translator.mjs")
      );
      const contract = translateIntent("写一个 reverseString(s) 冒烟验证", {
        allowedPaths: DEFAULT_ALLOWED_PATHS,
        objectivePrefix: "以下任务与项目 dispatchowner/dispatchrepo 相关，作为大脑多项目调度链路的冒烟验证：",
      });
      capturedContract = contract;

      check("🔒 allowedPaths 恒指向 B5 自己的安全区，绝不含目标项目真实路径", () => {
        assert.deepEqual(capturedContract.policy.allowedPaths, ["docs/conductor-brain-multiproject/spike/**"]);
        assert.ok(
          !capturedContract.policy.allowedPaths.some((p) => p.includes("dispatchowner") || p.includes("dispatchrepo")),
          "allowedPaths 不该包含任何目标项目相关字符串",
        );
        assert.ok(
          !capturedContract.policy.allowedPaths.some((p) => p.toLowerCase().includes("whoseorder")),
          "allowedPaths 不该包含 whoseorder（防止未来真的接了这条线还没人发现）",
        );
      });

      check("objective 文本提及目标项目（契约层面的项目关联，PRD §3.2）", () => {
        assert.ok(capturedContract.objective.includes("dispatchowner/dispatchrepo"));
      });
    } finally {
      rmSync(fixtureRepoDir, { recursive: true, force: true });
    }
  }

  // ── ③（Zorro 2026-07-23 must-fix）🔒 coder/tester 工具执行 cwd 必须钉死在 REPO_ROOT，不能
  //    继承调用方的 process.cwd()——故意让 process.cwd() 是别处（临时目录）再跑 dispatch，
  //    断言 assembleDeps 被调用那一刻 process.cwd() 已经是 REPO_ROOT（不是临时目录），且
  //    dispatchBrainTask() 结束后把调用方原来的 cwd 恢复回去（不泄漏全局副作用）。 ──────────
  {
    const { execFileSync } = await import("node:child_process");
    const fixtureRepoDir = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-cwdpin-repo-"));
    execFileSync("git", ["init", "-q", fixtureRepoDir]);
    execFileSync("git", ["-C", fixtureRepoDir, "remote", "add", "origin", "git@github.com:cwdpinowner/cwdpinrepo.git"]);

    const elsewhereDir = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-cwdpin-elsewhere-"));
    const cwdBeforeTest = process.cwd();

    try {
      await onboardProject({ repoPath: fixtureRepoDir });

      process.chdir(elsewhereDir);
      const cwdWhileElsewhere = process.cwd(); // Node 规范化后的路径（可能和 mkdtempSync 返回的
      // 字符串在 macOS 上因符号链接（/tmp -> /private/tmp）而形式不同——用 process.cwd() 自己
      // 的输出互相比较，不用 mkdtempSync 的原始返回值比较，避免这种符号链接normalization 的假阳性）。

      let observedCwdDuringAssembleDeps = null;
      await assert.rejects(
        () =>
          dispatchBrainTask(
            { owner: "cwdpinowner", repo: "cwdpinrepo", rawIntent: "cwd pin regression check" },
            {
              assembleDeps: async () => {
                observedCwdDuringAssembleDeps = process.cwd();
                throw new Error("intentional stop — test only verifies cwd at the point coder/tester construction begins");
              },
            },
          ),
        () => true,
      );

      check("🔒 must-fix：dispatch 内部把 cwd 钉死在 REPO_ROOT（不是调用方所在的临时目录）", () => {
        assert.equal(observedCwdDuringAssembleDeps, REPO_ROOT, "coder/tester 构造那一刻的 cwd 必须是 aeloop REPO_ROOT");
        assert.notEqual(observedCwdDuringAssembleDeps, cwdWhileElsewhere, "绝不能是调用方原来所在的临时目录");
      });

      check("dispatch 结束后应恢复调用方原来的 cwd（不泄漏全局副作用）", () => {
        assert.equal(process.cwd(), cwdWhileElsewhere, "dispatchBrainTask() 返回/抛出后，process.cwd() 应该恢复成调用它之前的值");
      });
    } finally {
      process.chdir(cwdBeforeTest);
      rmSync(fixtureRepoDir, { recursive: true, force: true });
      rmSync(elsewhereDir, { recursive: true, force: true });
    }
  }

  // ── ④（Zorro 2026-07-23 must-fix 第2轮，Codex 抓到并发竞态）🔒 两个 overlapping
  //    dispatchBrainTask() 调用（都从同一个"第三方"临时目录发起，不等第一个 resolve 就发起
  //    第二个）——断言①两次工具执行 cwd 都恰好是 REPO_ROOT（没有一次落到第三方目录）；
  //    ②全部结束后 process.cwd() 恢复成发起前的目录（没有全局状态泄漏/被交错破坏）。
  //    其中一个调用的 mock assembleDeps 里插入一段延迟，故意拉宽交错窗口——没有 module 级
  //    互斥锁的话，这条测试应该会（非确定性地）失败，证明这条测试真的网住了这个竞态，不是
  //    因为两次调用碰巧足够快、从没真正交错过。 ─────────────────────────────────────────
  {
    const { execFileSync } = await import("node:child_process");
    const fixtureRepoDirC = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-concurrent-repoC-"));
    execFileSync("git", ["init", "-q", fixtureRepoDirC]);
    execFileSync("git", ["-C", fixtureRepoDirC, "remote", "add", "origin", "git@github.com:concurrentownerC/concurrentrepoC.git"]);
    const fixtureRepoDirD = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-concurrent-repoD-"));
    execFileSync("git", ["init", "-q", fixtureRepoDirD]);
    execFileSync("git", ["-C", fixtureRepoDirD, "remote", "add", "origin", "git@github.com:concurrentownerD/concurrentrepoD.git"]);

    const thirdPartyDir = mkdtempSync(path.join(tmpdir(), "brain-test-dispatch-concurrent-thirdparty-"));
    const cwdBeforeConcurrentTest = process.cwd();

    try {
      await onboardProject({ repoPath: fixtureRepoDirC });
      await onboardProject({ repoPath: fixtureRepoDirD });

      // operator（模拟）当前就在这个"第三方"目录里，从这里同时发起两次 dispatch（不 await
      // 第一次就发起第二次——这正是会触发交错 bug 的调用形态）。
      process.chdir(thirdPartyDir);
      const cwdWhileInThirdParty = process.cwd();

      const observedCwds = [];
      const executionLog = []; // {call, phase:"start"|"end"} —— 直接、确定性地证明"两段临界区
      // 有没有真的交错"，不像单纯比对 cwd 值那样可能因为具体时序巧合而侥幸看起来正确（比如 D 碰巧
      // 把 cwd 复原到和 C 一样的值，掩盖了本该出现的交错）——见本测试块头部注释。
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const pC = dispatchBrainTask(
        { owner: "concurrentownerC", repo: "concurrentrepoC", rawIntent: "concurrent regression check C" },
        {
          assembleDeps: async () => {
            executionLog.push({ call: "C", phase: "start" });
            observedCwds.push({ call: "C", cwd: process.cwd() });
            await delay(30); // 拉宽窗口——没有互斥锁时，这段 delay 期间 D 有机会插进来搞破坏
            executionLog.push({ call: "C", phase: "end" });
            throw new Error("intentional stop C");
          },
        },
      );
      const pD = dispatchBrainTask(
        { owner: "concurrentownerD", repo: "concurrentrepoD", rawIntent: "concurrent regression check D" },
        {
          assembleDeps: async () => {
            executionLog.push({ call: "D", phase: "start" });
            observedCwds.push({ call: "D", cwd: process.cwd() });
            executionLog.push({ call: "D", phase: "end" });
            throw new Error("intentional stop D");
          },
        },
      );

      const results = await Promise.allSettled([pC, pD]);

      check("并发场景下两次 dispatch 都如预期抛出（intentional stop，不是被别的错误打断）", () => {
        assert.equal(results[0].status, "rejected");
        assert.equal(results[1].status, "rejected");
        assert.match(results[0].reason.message, /intentional stop C/);
        assert.match(results[1].reason.message, /intentional stop D/);
      });

      check("🔒 must-fix（并发）：两次工具执行的 cwd 都恰好是 REPO_ROOT，没有一次落到第三方目录", () => {
        assert.equal(observedCwds.length, 2, "两次 assembleDeps 都应该被调用到");
        for (const { call, cwd } of observedCwds) {
          assert.equal(cwd, REPO_ROOT, `调用 ${call} 的工具执行 cwd 必须是 REPO_ROOT`);
          assert.notEqual(cwd, cwdWhileInThirdParty, `调用 ${call} 绝不能落在第三方目录里执行`);
        }
      });

      check("🔒 must-fix（并发，直接证明零交错）：一次调用的 start/end 必须紧邻，不能被另一次调用的 start 插在中间", () => {
        assert.equal(executionLog.length, 4, "两次调用各产生一组 start/end，共 4 条日志");
        // 合法的两种顺序：C 的 start/end 紧邻在前 + D 紧邻在后，或者反过来——不允许任何"插队"
        // 形态（比如 [C-start, D-start, D-end, C-end] 这种就是交错，说明互斥锁没生效）。
        const sequences = [
          ["C:start", "C:end", "D:start", "D:end"],
          ["D:start", "D:end", "C:start", "C:end"],
        ];
        const actual = executionLog.map((e) => `${e.call}:${e.phase}`);
        const matchesAny = sequences.some((seq) => JSON.stringify(seq) === JSON.stringify(actual));
        assert.ok(
          matchesAny,
          `执行顺序必须是两条合法序列之一，实际是 ${JSON.stringify(actual)}——出现其它顺序说明两次调用的临界区发生了交错`,
        );
      });

      check("🔒 must-fix（并发）：全部结束后 process.cwd() 恢复成发起前的第三方目录（无泄漏、无交错破坏）", () => {
        assert.equal(process.cwd(), cwdWhileInThirdParty);
      });
    } finally {
      process.chdir(cwdBeforeConcurrentTest);
      rmSync(fixtureRepoDirC, { recursive: true, force: true });
      rmSync(fixtureRepoDirD, { recursive: true, force: true });
      rmSync(thirdPartyDir, { recursive: true, force: true });
    }
  }

  console.log(`PASS: test-dispatch-brain-task.mjs (${passCount} assertions groups, issue #93 B5 自动化部分)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (originalEnv === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    else process.env.AELOOP_BRAIN_IDENTITY_DB = originalEnv;
    rmSync(dbDir, { recursive: true, force: true });
  });
