// test-quickstart.mjs — issue #95 单元测试：quickstart.mjs。
//
// 沿用仓库既有 `test-*.mjs` 风格（`node:assert/strict`，不进 vitest——`vitest.config.ts` 的
// `include` 只扫 `src/**/*.test.ts`，见 `docs/oneshot-install/PRD.md` §3.1）。
//
// 🔒 安全约束（同 test-install-global-brain.mjs 先例）：本文件全程用注入的假 `execImpl`/
// `installGlobalBrainImpl`/`onboardProjectImpl`/`seedBrainIdentityImpl`，**不真的跑 pnpm/网络**，
// 不碰真实 `~/.claude/`——`verifyInstall()` 相关用例用 `mkdtempSync` 建一份最小 fixture
// （fake settings.json + fake `<snapshot>/dist/context/store.js`），不依赖真的跑过一次安装。
//
// 端到端（真的跑一次 `node scripts/quickstart.mjs --target=<临时目录>`，真实 pnpm/build/原生
// 模块）不在本文件——那类验证是 issue #95 交付前的一次性人工自测（见 `docs/oneshot-install/
// progress.md`），不适合每次跑单测都重复一次 `pnpm install`/`pnpm run build` 的完整耗时。
//
// 跑法：node scripts/test-quickstart.mjs。措辞精确一点（Zorro 建议级，2026-07-24）：本文件不需要
// **网络/pnpm/npm** 真的可用（这几步的 `execImpl` 全程被注入的假实现替换），但**不是**零系统依赖
// ——末尾 `verifyBetterSqlite3Loads` 那条用例故意对这个 worktree 自己真实的 `node_modules/
// better-sqlite3` 做一次真实加载校验（前提：本机已经 `pnpm install` 过，正常开发流程下总是成立）。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkNodeVersion,
  checkPnpmAvailable,
  runQuickstart,
  verifyBetterSqlite3Loads,
  verifyInstall,
} from "./quickstart.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

// ── checkNodeVersion ────────────────────────────────────────────────────────

{
  assert.doesNotThrow(() => checkNodeVersion({ repoRoot: REPO_ROOT, nodeVersion: "v24.1.0" }));
  console.log("ok - checkNodeVersion：满足 engines.node（>=24）不抛错");
}
{
  assert.throws(() => checkNodeVersion({ repoRoot: REPO_ROOT, nodeVersion: "v18.19.0" }), /Node 版本过低/);
  console.log("ok - checkNodeVersion：低于 engines.node 要求（v18 < 24）抛错，且报错信息带具体版本号");
}

// ── checkPnpmAvailable ──────────────────────────────────────────────────────

{
  const fakeExecImpl = () => "9.12.3\n";
  assert.doesNotThrow(() => checkPnpmAvailable({ execImpl: fakeExecImpl }));
  console.log("ok - checkPnpmAvailable：execImpl 正常返回时不抛错");
}
{
  const fakeExecImpl = () => {
    const err = new Error("spawn pnpm ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  assert.throws(() => checkPnpmAvailable({ execImpl: fakeExecImpl }), /未检测到 pnpm/);
  console.log("ok - checkPnpmAvailable：execImpl 抛 ENOENT 时报「未检测到 pnpm」，不是原始 ENOENT 堆栈直接抛出");
}

// ── runQuickstart：--dry-run 不触发任何 side-effecting execImpl 调用 ─────────

{
  const execCalls = [];
  const fakeExecImpl = (cmd, args) => {
    execCalls.push([cmd, args]);
    if (cmd === "pnpm" && args[0] === "--version") return "9.12.3\n";
    return "";
  };
  const fakeInstallGlobalBrain = (opts) => {
    assert.equal(opts.dryRun, true, "dry-run 时必须把 dryRun:true 透传给 installGlobalBrain");
    return {
      dryRun: true,
      snapshotDir: "/fake/snapshot",
      dataDir: "/fake/data",
      settingsPath: "/fake/settings.json",
      hookCommand: "node /fake/hook.mjs",
      settingsChanged: true,
    };
  };
  let onboardCalled = false;
  let seedCalled = false;
  const result = await runQuickstart({
    dryRun: true,
    homeDir: "/fake/home",
    execImpl: fakeExecImpl,
    log: () => {},
    installGlobalBrainImpl: fakeInstallGlobalBrain,
    onboardProjectImpl: async () => {
      onboardCalled = true;
      return { owner: "x", repo: "y", projectKey: "x/y", action: "inserted" };
    },
    seedBrainIdentityImpl: async () => {
      seedCalled = true;
      return { identity: { action: "inserted" }, constraints: [], issues: [] };
    },
  });
  assert.equal(result.dryRun, true);
  // --dry-run 唯一允许的 execImpl 调用是 preflight 的 `pnpm --version`（只读，不产生任何写入）——
  // 不该出现 `pnpm install`/`pnpm run build`。
  const sideEffecting = execCalls.filter(([cmd, args]) => !(cmd === "pnpm" && args[0] === "--version"));
  assert.deepEqual(sideEffecting, [], `--dry-run 不该触发任何 side-effecting execImpl 调用，实际记录到：${JSON.stringify(sideEffecting)}`);
  assert.equal(onboardCalled, false, "--dry-run 不该调用 onboard-project");
  assert.equal(seedCalled, false, "--dry-run 不该调用 seed-brain-identity");
  console.log("ok - runQuickstart --dry-run：只读 preflight 之外零 side-effecting 调用，onboard/seed 都不触发");
}

// ── runQuickstart：正常路径按序调用五步 + 环境变量在 finally 里被还原 ────────

{
  const priorIdentityDb = process.env.AELOOP_BRAIN_IDENTITY_DB;
  const priorGlobalMode = process.env.AELOOP_BRAIN_GLOBAL_MODE;
  const priorTaskSource = process.env.AELOOP_BRAIN_TASK_SOURCE;
  // 模拟"这台机器上，跑 quickstart 之前，宿主进程已经因为别的原因设了这几个变量"——用来证明
  // 恢复逻辑还原的是"调用前的值"，不是无脑 delete。
  process.env.AELOOP_BRAIN_IDENTITY_DB = "/pre-existing/should-be-restored.db";

  const callOrder = [];
  const execCalls = [];
  const fakeExecImpl = (cmd, args) => {
    execCalls.push([cmd, args]);
    return "9.12.3\n";
  };
  const fakeVerifyBetterSqlite3 = () => {
    callOrder.push("verifyBetterSqlite3Loads");
  };

  let identityDbDuringOnboard;
  let globalModeDuringOnboard;

  const result = await runQuickstart({
    homeDir: "/fake/home",
    repoPath: "/fake/repo",
    execImpl: fakeExecImpl,
    log: () => {},
    verifyBetterSqlite3LoadsImpl: fakeVerifyBetterSqlite3,
    installGlobalBrainImpl: (opts) => {
      callOrder.push("installGlobalBrain");
      assert.equal(opts.homeDir, "/fake/home");
      return {
        dryRun: false,
        snapshotDir: "/fake/home/.claude/aeloop-brain/repo-snapshot",
        dataDir: "/fake/home/.claude/aeloop-brain/data",
        settingsPath: "/fake/home/.claude/settings.json",
        hookCommand: "node /fake/hook.mjs",
        settingsChanged: true,
        installedVersion: "0.0.1+abcdef",
      };
    },
    onboardProjectImpl: async ({ repoPath }) => {
      callOrder.push("onboardProject");
      assert.equal(repoPath, "/fake/repo");
      identityDbDuringOnboard = process.env.AELOOP_BRAIN_IDENTITY_DB;
      globalModeDuringOnboard = process.env.AELOOP_BRAIN_GLOBAL_MODE;
      return { owner: "elishawong", repo: "aeloop", projectKey: "elishawong/aeloop", action: "inserted" };
    },
    seedBrainIdentityImpl: async () => {
      callOrder.push("seedBrainIdentity");
      return { identity: { action: "inserted" }, constraints: [{ slug: "commit-gate" }], issues: [] };
    },
    verifyInstallImpl: async () => {
      callOrder.push("verifyInstall");
      return { hookRegistered: true, betterSqlite3Loads: true, identityDbReadable: true, memoryCount: 8, errors: [], ok: true };
    },
  });

  assert.deepEqual(callOrder, ["verifyBetterSqlite3Loads", "installGlobalBrain", "onboardProject", "seedBrainIdentity", "verifyInstall"]);
  assert.equal(result.dryRun, false);
  assert.equal(result.verify.ok, true);

  // 第 4/5 步执行期间，process.env 确实被设成"落到第 3 步装的那份全局库"（PRD §3.2 的核心机制）。
  assert.equal(identityDbDuringOnboard, "/fake/home/.claude/aeloop-brain/data/identity.db");
  assert.equal(globalModeDuringOnboard, "1");

  // 跑完之后，环境变量被还原成调用前的值（不是被清空、也不是残留成 quickstart 设的值）。
  assert.equal(process.env.AELOOP_BRAIN_IDENTITY_DB, "/pre-existing/should-be-restored.db");
  assert.equal(process.env.AELOOP_BRAIN_GLOBAL_MODE, priorGlobalMode);
  assert.equal(process.env.AELOOP_BRAIN_TASK_SOURCE, priorTaskSource);

  // 还原成调用前的原始状态（清理这条用例自己引入的模拟值），不影响后续用例。
  if (priorIdentityDb === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
  else process.env.AELOOP_BRAIN_IDENTITY_DB = priorIdentityDb;

  console.log("ok - runQuickstart 正常路径：五步按序调用，第 4/5 步期间 env 指向第 3 步装的那份库，跑完 env 被还原成调用前的值");
}

// ── runQuickstart：--task-source=github 透传到两处 ──────────────────────────

{
  let installGlobalBrainTaskSource;
  let taskSourceEnvDuringSeed;

  await runQuickstart({
    homeDir: "/fake/home",
    repoPath: "/fake/repo",
    taskSource: "github",
    execImpl: () => "9.12.3\n",
    log: () => {},
    verifyBetterSqlite3LoadsImpl: () => {},
    installGlobalBrainImpl: (opts) => {
      installGlobalBrainTaskSource = opts.taskSource;
      return {
        dryRun: false,
        snapshotDir: "/fake/home/.claude/aeloop-brain/repo-snapshot",
        dataDir: "/fake/home/.claude/aeloop-brain/data",
        settingsPath: "/fake/home/.claude/settings.json",
        hookCommand: "AELOOP_BRAIN_TASK_SOURCE=github node /fake/hook.mjs",
        settingsChanged: true,
      };
    },
    onboardProjectImpl: async () => ({ owner: "elishawong", repo: "aeloop", projectKey: "elishawong/aeloop", action: "unchanged" }),
    seedBrainIdentityImpl: async () => {
      taskSourceEnvDuringSeed = process.env.AELOOP_BRAIN_TASK_SOURCE;
      return { identity: { action: "unchanged" }, constraints: [], issues: [] };
    },
    verifyInstallImpl: async () => ({ hookRegistered: true, betterSqlite3Loads: true, identityDbReadable: true, memoryCount: 1, errors: [], ok: true }),
  });

  assert.equal(installGlobalBrainTaskSource, "github", "installGlobalBrain 必须收到 taskSource: 'github'");
  assert.equal(taskSourceEnvDuringSeed, "github", "seed 执行期间 process.env.AELOOP_BRAIN_TASK_SOURCE 必须是 'github'");
  console.log("ok - runQuickstart --task-source=github：透传给 installGlobalBrain 的 opts + seed 执行期间的环境变量两处都命中");
}

{
  await assert.rejects(
    () =>
      runQuickstart({
        homeDir: "/fake/home",
        taskSource: "bogus",
        execImpl: () => "9.12.3\n",
        log: () => {},
      }),
    /taskSource 只接受 "github"/,
  );
  console.log('ok - runQuickstart：taskSource 不是 "github"/undefined 时 fail-closed 拒绝，不静默忽略');
}

// ── B1 回归（Zorro/Codex 复审 blocker，2026-07-24）：省略 --task-source 时，即便宿主 shell 已经
// ambient export 过 AELOOP_BRAIN_TASK_SOURCE=github（quickstart 自己没设，但初版也没清），
// seed 执行期间也必须看不到它——resolveTaskSource() 优先级 env > GLOBAL_MODE，不清掉的话会
// 原样透传，物理击穿 issue #103「省略 flag 时 shipped 默认零 GitHub」这条保证。 ────────────

{
  const priorAmbientTaskSource = process.env.AELOOP_BRAIN_TASK_SOURCE;
  process.env.AELOOP_BRAIN_TASK_SOURCE = "github"; // 模拟宿主 shell 里已经 export 过（quickstart 自己没设）
  let taskSourceEnvDuringSeed = "(seed 没被调用到)";
  try {
    await runQuickstart({
      homeDir: "/fake/home",
      repoPath: "/fake/repo",
      // 注意：不传 taskSource —— 就是"省略 --task-source flag"这个场景本身。
      execImpl: () => "9.12.3\n",
      log: () => {},
      verifyBetterSqlite3LoadsImpl: () => {},
      installGlobalBrainImpl: () => ({
        dryRun: false,
        snapshotDir: "/fake/snap",
        dataDir: "/fake/data",
        settingsPath: "/fake/settings.json",
        hookCommand: "node /fake/hook.mjs",
        settingsChanged: true,
      }),
      onboardProjectImpl: async () => ({ owner: "e", repo: "r", projectKey: "e/r", action: "inserted" }),
      seedBrainIdentityImpl: async () => {
        taskSourceEnvDuringSeed = process.env.AELOOP_BRAIN_TASK_SOURCE;
        return { identity: { action: "inserted" }, constraints: [], issues: [] };
      },
      verifyInstallImpl: async () => ({ hookRegistered: true, betterSqlite3Loads: true, identityDbReadable: true, memoryCount: 1, errors: [], ok: true }),
    });

    assert.equal(
      taskSourceEnvDuringSeed,
      undefined,
      "issue #103「shipped 默认零 GitHub」：省略 --task-source 时，即便宿主 shell 已经 ambient export 过 " +
        `AELOOP_BRAIN_TASK_SOURCE=github，seed 执行期间也必须看不到它（必须被显式清空），实际看到：${JSON.stringify(taskSourceEnvDuringSeed)}`,
    );
    // 只在 runQuickstart 执行窗口内清空——跑完要把 ambient 值还原回调用前的状态，不是永久抹掉。
    assert.equal(process.env.AELOOP_BRAIN_TASK_SOURCE, "github", "跑完之后 ambient 值应该被还原成调用前的 'github'，不是被永久清掉");
    console.log(
      "ok - runQuickstart（B1 blocker 回归）：省略 --task-source 时，即便 ambient env 已经是 github，" +
        "seed 执行期间也会被显式清空，跑完再还原成调用前的 ambient 值",
    );
  } finally {
    if (priorAmbientTaskSource === undefined) delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    else process.env.AELOOP_BRAIN_TASK_SOURCE = priorAmbientTaskSource;
  }
}

// ── runQuickstart：自检不通过时抛错（不能装完还报成功）────────────────────────

{
  await assert.rejects(
    () =>
      runQuickstart({
        homeDir: "/fake/home",
        repoPath: "/fake/repo",
        execImpl: () => "9.12.3\n",
        log: () => {},
        verifyBetterSqlite3LoadsImpl: () => {},
        installGlobalBrainImpl: () => ({
          dryRun: false,
          snapshotDir: "/fake/snap",
          dataDir: "/fake/data",
          settingsPath: "/fake/settings.json",
          hookCommand: "node /fake/hook.mjs",
          settingsChanged: true,
        }),
        onboardProjectImpl: async () => ({ owner: "e", repo: "r", projectKey: "e/r", action: "inserted" }),
        seedBrainIdentityImpl: async () => ({ identity: { action: "inserted" }, constraints: [], issues: [] }),
        verifyInstallImpl: async () => ({
          hookRegistered: true,
          betterSqlite3Loads: false,
          identityDbReadable: false,
          memoryCount: 0,
          errors: ["better-sqlite3 原生模块加载失败：模拟故障"],
          ok: false,
        }),
      }),
    /自检未全部通过/,
  );
  console.log("ok - runQuickstart：verifyInstall 返回 ok:false 时整体抛错退出（不能装完还报成功）");
}

// ── verifyInstall：用最小 fixture（假 settings.json + 假 <snapshot>/dist/context/store.js）───

{
  const fakeHome = mkdtempSync(path.join(tmpdir(), "aeloop-test-quickstart-verify-home-"));
  try {
    const { installPaths, AELOOP_BRAIN_MARKER } = await import("./install-global-brain.mjs");
    const { snapshotDir, settingsPath, hookEntryPath } = installPaths(fakeHome);

    // settings.json：一条含 AELOOP_BRAIN_MARKER 的 SessionStart 条目。
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: `node "${hookEntryPath}"` }] }] },
      }),
    );
    assert.ok(readFileSync(settingsPath, "utf8").includes(AELOOP_BRAIN_MARKER), "fixture 自检：写入的 command 真的含 AELOOP_BRAIN_MARKER");

    // hookEntryPath 本身也要真实存在——Zorro 建议级修复后，hookRegistered 不只看 settings.json
    // 里的 command 字符串，还要 existsSync(hookEntryPath) 为真（见 verifyInstall() 头注释）。
    mkdirSync(path.dirname(hookEntryPath), { recursive: true });
    writeFileSync(hookEntryPath, "// fixture stub，verifyInstall 只 existsSync 不会真的执行它");

    // 假 store.js：最小 MemoryStore stub，listMemories() 返回 2 条固定记录。
    const storeDir = path.join(snapshotDir, "dist", "context");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      path.join(storeDir, "store.js"),
      `export class MemoryStore {
        constructor(dbPath) { this.dbPath = dbPath; }
        listMemories() { return [{ id: 1 }, { id: 2 }]; }
        close() {}
      }`,
    );

    const result = await verifyInstall({ homeDir: fakeHome });
    assert.equal(result.hookRegistered, true);
    assert.equal(result.betterSqlite3Loads, true);
    assert.equal(result.identityDbReadable, true);
    assert.equal(result.memoryCount, 2);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    console.log("ok - verifyInstall：hook 已注册 + 能 import 快照里的 store.js + 身份库可读非空 → ok:true");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

{
  // settings.json 不存在 / 快照不存在 → 明确报错，ok:false（不是静默当成功）。
  const fakeHome = mkdtempSync(path.join(tmpdir(), "aeloop-test-quickstart-verify-empty-home-"));
  try {
    const result = await verifyInstall({ homeDir: fakeHome });
    assert.equal(result.ok, false);
    assert.equal(result.hookRegistered, false);
    assert.equal(result.betterSqlite3Loads, false);
    assert.ok(result.errors.length >= 2, "两类失败（settings.json 缺失 + 快照缺失）都应该分别记一条 error");
    console.log("ok - verifyInstall：什么都没装过的空 homeDir → ok:false，且报出具体缺了什么");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

// ── verifyBetterSqlite3Loads：对这个 worktree 自己真实跑一次（本来就该有可用的原生模块）───

{
  assert.doesNotThrow(
    () => verifyBetterSqlite3Loads({ repoRoot: REPO_ROOT }),
    "这个 worktree 自己的 node_modules/better-sqlite3 应该是可用的（前提：已经 pnpm install 过）",
  );
  console.log("ok - verifyBetterSqlite3Loads：对本 worktree 真实 node_modules 校验通过（不是假的，真的 new Database(':memory:')）");
}

// ── B2 回归（Zorro/Codex 复审 blocker，2026-07-24）：CLI 入口守卫在路径含空格时不能静默失效 ──
//
// 根因：`import.meta.url === \`file://${process.argv[1]}\`` ——`import.meta.url` 是百分号编码
// （空格变 `%20`），`\`file://${process.argv[1]}\`` 是把原始字符串直接拼进去（字面空格，不编码），
// 路径含空格时两边永远不相等，守卫恒为 false，整个 CLI 主体（包括 `--help`）静默不执行、进程
// 直接以 exit 0 结束——不是"抛错"，是"看起来什么都没发生"，比抛错更隐蔽。改用 `pathToFileURL()`
// 之后两边走同一套编码规则，恢复正确触发。
//
// 真实验证方式：不能只测字符串比较逻辑本身（那样测的是"我以为它该怎么比"，不是"Node 真实环境下
// import.meta.url 到底长什么样"）——必须真的把 quickstart.mjs 连同它静态 import 的几个本地文件
// （下面 filesToCopy 列的都是模块顶层 `import`，不含任何 node_modules/dist 依赖——已核实
// install-global-brain.mjs/onboard-project.mjs/seed-brain-identity.mjs 和它们各自 import 的
// .claude/hooks/lib/*.mjs 顶层只 import node 内置模块 + 彼此），复制到一个路径**本身**含空格的
// 临时目录，真实 spawn 一个子进程跑 `--help`（只读、无副作用，不需要真的装过 pnpm/build）。

{
  const spacedRoot = mkdtempSync(path.join(tmpdir(), "aeloop quickstart cli guard "));
  try {
    assert.ok(spacedRoot.includes(" "), "fixture 自检：临时目录路径本身必须真的含空格，不然这条回归测不到东西");

    const filesToCopy = [
      path.join("scripts", "quickstart.mjs"),
      path.join("scripts", "install-global-brain.mjs"),
      path.join("scripts", "onboard-project.mjs"),
      path.join("scripts", "seed-brain-identity.mjs"),
      path.join(".claude", "hooks", "lib", "git-remote.mjs"),
      path.join(".claude", "hooks", "lib", "memory-upsert.mjs"),
      path.join(".claude", "hooks", "lib", "project-registry.mjs"),
      path.join(".claude", "hooks", "lib", "task-source.mjs"),
      path.join(".claude", "hooks", "lib", "db-path.mjs"),
    ];
    for (const rel of filesToCopy) {
      const src = path.join(REPO_ROOT, rel);
      const dest = path.join(spacedRoot, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest);
    }

    const entry = path.join(spacedRoot, "scripts", "quickstart.mjs");
    const proc = spawnSync(process.execPath, [entry, "--help"], { encoding: "utf8" });
    assert.equal(
      proc.status,
      0,
      `带空格路径下 \`node quickstart.mjs --help\` 应该 exit 0，实际 status=${proc.status}，stderr=${proc.stderr}`,
    );
    assert.ok(
      proc.stdout.includes("用法：node scripts/quickstart.mjs"),
      "CLI 入口守卫必须在含空格路径下正确触发（不能静默 no-op 变成什么都没打印就 exit 0）——" +
        `实际 stdout：${JSON.stringify(proc.stdout)}，stderr：${JSON.stringify(proc.stderr)}`,
    );
    console.log("ok - CLI 入口守卫（B2 blocker 回归）：路径含空格时 --help 仍然正确触发，不会静默 no-op");
  } finally {
    rmSync(spacedRoot, { recursive: true, force: true });
  }
}

// ── B3 回归（Zorro/Codex 复审 blocker，2026-07-24）：`node -e`/REPL 等 `process.argv[1]` 缺失的
// 场景下，`import("./quickstart.mjs")` 本身不能抛错 ──────────────────────────────────────
//
// 根因：B2 的修法在模块顶层无条件 `realpathSync(process.argv[1])`——本文件通篇导出可复用的纯
// 函数（本测试文件自己就是靠 `import` 它们跑的），契约是"能被当模块 import，不只能当 CLI 跑"。
// `node --input-type=module -e "import('...')"` 这种场景下 `process.argv[1]` 是 `undefined`，
// `realpathSync(undefined)` 直接抛 `ENOENT`，顶层抛错会让整个 `import` 失败，连导出的函数都拿
// 不到——这是 B2 修法意外引入的回归（R1 前的旧写法 `file://${argv[1]}` 在 `argv[1]` 是
// `undefined` 时只是拼出一个不会相等的字符串，不抛错）。用真实 `spawnSync` 跑
// `node --input-type=module -e "import(...)"`（不是单测 mock `process.argv`——mock 测的是"我以为
// 顶层代码怎么跑"，不是"Node 真实用这种方式 import 一个模块时 argv[1] 到底是什么"）。

{
  const entry = path.join(REPO_ROOT, "scripts", "quickstart.mjs");
  const entryUrl = pathToFileURL(entry).href;
  const proc = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(entryUrl)}).then(m => { if (typeof m.runQuickstart !== "function") throw new Error("runQuickstart 没有被正确导出"); console.log("IMPORT_OK"); }).catch(e => { console.error("IMPORT_FAILED: " + e.message); process.exit(1); });`],
    { encoding: "utf8" },
  );
  assert.equal(
    proc.status,
    0,
    `process.argv[1] 缺失（node -e 场景）时 import quickstart.mjs 不该抛错，实际 status=${proc.status}，` +
      `stdout=${JSON.stringify(proc.stdout)}，stderr=${JSON.stringify(proc.stderr)}`,
  );
  assert.ok(
    proc.stdout.includes("IMPORT_OK"),
    `import 应该成功且拿到 runQuickstart 导出，实际 stdout=${JSON.stringify(proc.stdout)}，stderr=${JSON.stringify(proc.stderr)}`,
  );
  console.log("ok - CLI 入口守卫（B3 blocker 回归）：process.argv[1] 缺失（node -e/REPL 场景）时 import 不抛错，导出正常可用");
}

console.log("PASS: test-quickstart.mjs（issue #95 一键安装编排 + 自检）");
