#!/usr/bin/env node
/**
 * dispatch-brain-task.mjs — 意图 → TaskContract → aeloop 执行 → EvidenceBundle → 三态门折回
 * （issue #93 B5，docs/conductor-brain-multiproject/PRD.md §4.6/plan.md §B5）。
 *
 * 🔒 Level 1 范围决定（PRD §3.2，指挥官 2026-07-23 已确认）：coder/tester 的实际工具执行
 * **不指向任何目标项目的真实目录**——`translateIntent()` 的 `allowedPaths` 固定指向本批次的
 * 安全区 `docs/conductor-brain-multiproject/spike/**`（DEFAULT_ALLOWED_PATHS 常量，下方），
 * `--project` 参数只影响：① 校验该项目是否已注册（`assertProjectRegistered`）；② 拼进
 * `objective` 文本前缀，让"这个 dispatch 是为哪个项目发起的"在契约文本层面成立；③ 折回身份库
 * 时给写入的 memory 打 `project:<owner>/<repo>` tag。**绝不**会因为传了 `--project` 就把
 * `allowedPaths` 指向那个项目——`test-dispatch-brain-task.mjs` 有专门的回归断言防止未来有人
 * "顺手"把这条线接上。
 *
 * 🔒 Zorro must-fix 第1轮（2026-07-23）：coder/tester 的实际工具执行（`spawnWithTimeout()`，
 * `src/harness/cli-exec.ts`）没有任何显式 cwd 参数可配置——`ClaudeCliAdapterConfig`/
 * `CodexCliAdapterConfig` 只有 `cmd?`（PRD §3.1 判定），两个 adapter 的 `invoke()` 都不传 `cwd`
 * 给 `spawnWithTimeout()`，所以子进程会继承 Node 进程自己的 `process.cwd()`。如果 operator 在
 * whoseorder 目录里跑这个脚本（`cd .../whoseorder && node .../dispatch-brain-task.mjs
 * --project ...`），tester（codex-cli，`--sandbox read-only`，但仍然是真的在那个 cwd 里执行工具
 * 调用）的 Bash 工具会真的在 whoseorder 目录里跑——这会破坏 Level 1"绝不碰第三方仓库"这条核心
 * 属性，且**不能靠 operator 记得"要在 aeloop 目录里跑"这种自觉来保证**，必须代码钉死。修法：
 * 一开始就把这个 Node 进程自己的 cwd 钉死到 `REPO_ROOT`（`process.chdir()`），退出前恢复调用方
 * 原来的 cwd。
 *
 * 🔒 Zorro must-fix 第2轮（2026-07-23，Codex 抓到）：`process.chdir()` 改的是**进程全局** cwd，
 * 而 `dispatchBrainTask()` 是 `async` 导出库函数——两个 overlapping 调用会互相踩：
 *   - 交错 A：调用②在调用①的 `chdir(REPO_ROOT)` 之后、`chdir(callerCwd)` 之前启动，②自己捕获的
 *     `callerCwd` 实际是①已经改过的 `REPO_ROOT`（不是②真正的调用方目录），①后来 `chdir` 回自己
 *     的 `callerCwd` 时，如果②还没跑完，②接下来的子进程调用就会落在①的 `callerCwd`（可能是第三
 *     方目录）里执行——**破坏"绝不碰第三方仓库"**，比第1轮修的问题更隐蔽。
 *   - 交错 B：最终 cwd 停在 `REPO_ROOT` 没被恢复成任何一个调用方原来的目录（全局状态泄漏）。
 * 修法（Zorro 建议的最便宜方案，匹配当前"库调、非高并发"的设计意图）：加一个 module 级 async
 * 互斥锁，把 `chdir → 真正的工作 → chdir 恢复` 这整段串行化——排队等待，不是拒绝并发；同一时刻
 * 最多只有一个 `dispatchBrainTask()` 调用处于这段临界区内，不可能出现上面两种交错。真正做事的
 * 逻辑挪进内部函数 `runDispatchBrainTask()`，导出的 `dispatchBrainTask()` 只是"排队后再跑"的薄
 * 包装——`test-dispatch-brain-task.mjs` 新增了两个 overlapping 调用（从不同"第三方"临时目录发起）
 * 的并发回归测试，断言两次的工具执行 cwd 都是 `REPO_ROOT`、结束后 `process.cwd()` 恢复正常。
 * 不走"改 `src/harness/**` 传 per-spawn cwd"那条路——超出片①范围，Zorro 已确认不用现在做。
 *
 * 🔧 issue #2 batch 0 重构（2026-07-24，docs/conductor-mvp/DESIGN.md §7.3 方案 B）：
 * "② 翻译意图 → ③ 真实 aeloop 执行（自动批 G1/G2，停 G3/Escalation 前）→ ④ EvidenceBundle →
 * ⑤ 三态门折回" 这段核心逻辑抽到 `scripts/lib/conductor-dispatch-core.mjs`（不要求项目注册），
 * 本文件现在只保留"多项目场景特有"的部分：① 项目注册校验（`assertProjectRegistered`）、
 * cwd 互斥锁/chdir 保护（上面两轮 must-fix 的成果，**没有下沉到共享核心**——那是这个多项目 CLI
 * 场景特有的并发保护，见 `conductor-dispatch-core.mjs` 头注释"调用方职责边界"）、⑥ 折回身份库时
 * 打 `project:<owner>/<repo>` tag 这条 project-link memory。**这是一次纯重构，不改变本文件的
 * 对外行为**——`scripts/test-dispatch-brain-task.mjs` 的既有断言（未注册项目报错/allowedPaths
 * 不含目标项目路径/cwd 钉死/并发互斥）全部原样适用，重构前后各跑过一遍确认零回归。issue #2
 * batch 1 的 `dispatch-conductor-task.mjs` 复用同一个共享核心，但不经过这里的项目注册语义。
 *
 * 调用模式：库调（同 `run-spike.mjs` 已验证的路径，assembleProfileDeps + startRun/resumeRun），
 * 不走 `conductor-work.mjs` 子进程（那条路径今天必然停在 G1、没有 resume 命令，`run-spike.mjs`
 * 头注释已经记录过这条判断，本文件延续同一个结论，不重新论证）。
 *
 * 用法：node scripts/dispatch-brain-task.mjs --project <owner>/<repo> "<intent 文本>"
 * 前置：本机已认证的 subscription profile（claude/codex CLI 在 PATH 且已登录），同
 * `run-spike.mjs`/`WAKE-GREETING-RUNBOOK.md` 已有前置条件。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveIdentityDbPath } from "../.claude/hooks/lib/db-path.mjs";
import { assertProjectRegistered, projectTagFor } from "../.claude/hooks/lib/project-registry.mjs";
import { runConductorDispatch } from "./lib/conductor-dispatch-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, "..");

/** B5 自己的安全区——独立于 #75/#80 的 docs/conductor-brain-layer/spike/**（README 见
 * docs/conductor-brain-multiproject/spike/README.md）。**不是**目标项目路径，任何情况下都不会
 * 被 `--project` 参数覆盖——见文件头"🔒 Level 1 范围决定"。 */
export const DEFAULT_ALLOWED_PATHS = ["docs/conductor-brain-multiproject/spike/**"];

/** TaskContract JSON 落盘目录——独立于 batch 0 抽取出的共享核心自己的默认值
 *  （`conductor-dispatch-core.mjs` 的 `DEFAULT_CONTRACT_DIR` 是 #2 自己的安全区，两者刻意不同，
 *  维持 #93 B5 既有的审计痕迹隔离，逐字节等于重构前本文件内联的旧路径）。 */
const CONTRACT_DIR = path.join(REPO_ROOT, "docs", "conductor-brain-multiproject", "spike");

// 🔒 module 级 async 互斥锁（见文件头"Zorro must-fix 第2轮"）——一条 promise 链，每次
// `withDispatchMutex(fn)` 把 `fn` 接到链尾：必须等前一个排队的调用（无论成功/失败）完全落地，
// 才轮到下一个开始。`chain` 变量的读写全部发生在同步代码里（没有 await 夹在中间），JS 单线程
// 保证这里不会有"两个调用同时读到同一个 chain 值"这种竞态——这正是这个模式能正确工作的前提。
let dispatchMutexChain = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withDispatchMutex(fn) {
  const settled = dispatchMutexChain.then(fn, fn);
  // 无论这次是成功还是失败，链条本身都要继续往下传（用一个恒 resolve 的 no-op 接住），否则一次
  // 失败会让链条永久卡在 rejected 状态，后面排队的调用全部再也跑不起来。
  dispatchMutexChain = settled.then(
    () => undefined,
    () => undefined,
  );
  return settled;
}

/**
 * @param {{ owner: string, repo: string, rawIntent: string }} args
 * @param {{
 *   resolveDbPath?: typeof resolveIdentityDbPath,
 *   openStore?: (dbPath: string) => Promise<import("../dist/context/store.js").MemoryStore>,
 *   assembleDeps?: (profileName: string, env: NodeJS.ProcessEnv) => Promise<any>,
 * }} [deps]
 * @returns {Promise<{
 *   contract: import("../dist/conductor/types.js").TaskContract,
 *   evidenceBundle: import("../dist/evidence/bundle.js").EvidenceBundle,
 *   gateResults: Array<{evidenceId: string|null, memoryId: number, source: string, confirmed: boolean}>,
 *   runError: Error|null,
 * }>}
 */
export function dispatchBrainTask(args, deps = {}) {
  // 排队而不是直接跑——见文件头"Zorro must-fix 第2轮"。整个 runDispatchBrainTask()（含
  // chdir→工作→chdir 恢复）跑在互斥锁临界区内，两次 overlapping 调用不可能交错。
  return withDispatchMutex(() => runDispatchBrainTask(args, deps));
}

async function runDispatchBrainTask(args, deps) {
  const { owner, repo, rawIntent } = args;
  const { resolveDbPath = resolveIdentityDbPath } = deps;

  // 🔒 见文件头"Zorro must-fix"说明——函数一开始就钉死 cwd，退出前恢复。
  const callerCwd = process.cwd();
  process.chdir(REPO_ROOT);

  try {
    const dbPath = resolveDbPath();
    if (!dbPath) {
      const err = new Error(
        "[dispatch-brain-task] 找不到身份库 dbPath——AELOOP_BRAIN_IDENTITY_DB / AELOOP_BRAIN_GLOBAL_MODE / " +
          ".claude/brain.local.json 均未配置。已中止，未发起任何 LLM 调用。",
      );
      err.code = "NO_IDENTITY_DB_PATH";
      throw err;
    }

    const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));
    const store = deps.openStore ? await deps.openStore(dbPath) : new MemoryStore(dbPath);

    try {
      // ① 前置检查：目标项目必须已注册——在这一步之后才允许任何 assembleProfileDeps/
      //    ConductorWorkApp 调用（PRD §4.6/plan.md §B5 步骤6 的测试要点）。
      assertProjectRegistered(store, owner, repo);
      const projectTag = projectTagFor(owner, repo);

      // ②-⑤ 翻译 → 真实 aeloop 执行（库调模式，G1/G2 自动放行、停在 G3 前）→ EvidenceBundle →
      //      三态门折回——委托给 batch 0 抽出的共享核心（不要求项目注册，本文件在这之上包一层
      //      多项目语义，见文件头"issue #2 batch 0 重构"）。
      const result = await runConductorDispatch(
        rawIntent,
        { store, assembleDeps: deps.assembleDeps },
        {
          allowedPaths: DEFAULT_ALLOWED_PATHS,
          objectivePrefix: `以下任务与项目 ${owner}/${repo} 相关，作为大脑多项目调度链路的冒烟验证：`,
          contractDir: CONTRACT_DIR,
          decidedByLabel: "dispatch-brain-task (auto, not a human decision)",
        },
      );

      // ⑥ 给三态门刚写入的记录再补一条项目关联——applyThreeStateGate()（#75/#80 的既有共享实现，
      //    本文件不改它）本身不知道"项目"这个多项目场景才有的概念，所以在共享核心返回之后，本文件
      //    单独再插入一条 active_task，明确标注属于哪个项目，不去 mutate 共享核心已经写好的记录。
      const projectLinkMemory = store.insertMemory({
        type: "active_task",
        title: `brain-dispatch-smoke-test:${result.contract.contractId}`,
        content: `冒烟验证任务，contractId=${result.contract.contractId}，intent="${rawIntent}"`,
        tags: ["status:done", "source:brain-dispatch-smoke-test", projectTag],
        confidenceState: "confirmed",
      });

      return {
        contract: result.contract,
        evidenceBundle: result.evidenceBundle,
        gateResults: result.gateResults,
        projectLinkMemoryId: projectLinkMemory.id,
        runError: result.runError,
      };
    } finally {
      store.close();
    }
  } finally {
    // 🔒 见文件头"Zorro must-fix"说明——无论成功/失败都恢复调用方原来的 cwd。
    process.chdir(callerCwd);
  }
}

function parseArgs(argv) {
  const args = { project: undefined, rawIntent: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") args.project = argv[++i];
    else if (arg.startsWith("--project=")) args.project = arg.slice("--project=".length);
    else rest.push(arg);
  }
  args.rawIntent = rest.join(" ");
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { project, rawIntent } = parseArgs(process.argv.slice(2));
  if (!project || !project.includes("/") || !rawIntent) {
    console.error('用法：node scripts/dispatch-brain-task.mjs --project <owner>/<repo> "<intent 文本>"');
    process.exitCode = 1;
  } else {
    const [owner, repo] = project.split("/");
    dispatchBrainTask({ owner, repo, rawIntent })
      .then((result) => {
        console.log(`[dispatch-brain-task] contractId=${result.contract.contractId}`);
        console.log(
          `[dispatch-brain-task] evidence[]=${result.evidenceBundle.evidence.length} 条，status=${result.evidenceBundle.status}`,
        );
        for (const r of result.gateResults) {
          console.log(
            `  三态门：evidenceId=${r.evidenceId ?? "(mechanical-status)"} source=${r.source} confirmed=${r.confirmed}`,
          );
        }
        console.log(`[dispatch-brain-task] 项目关联记录 memoryId=${result.projectLinkMemoryId}`);
        if (result.runError) {
          console.error(`[dispatch-brain-task] 真实 run 抛出异常（如实报告，不假装成功）：${result.runError.message}`);
          process.exitCode = 1;
        }
      })
      .catch((err) => {
        console.error(err.message ?? String(err));
        process.exitCode = 1;
      });
  }
}
