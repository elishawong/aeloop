#!/usr/bin/env node
/**
 * quickstart.mjs — issue #95 一键安装：把 docs/getting-started/README.md 记录的手动五步
 * （pnpm install → pnpm run build → 全局安装 → onboard-project → seed 身份库）收拢成一条幂等命令。
 *
 * 选型（PRD `docs/oneshot-install/PRD.md` §3.1 已定盘的理由）：纯 node 脚本，零新增依赖，不是
 * `install.sh`——仓库 `scripts/` 下已有的编排脚本（`install-global-brain.mjs`/
 * `onboard-project.mjs`/`seed-brain-identity.mjs`）全部走同一套「导出纯函数 + 依赖注入 +
 * `if (import.meta.url === ...)` CLI 入口」风格，本文件直接 `import` 它们已导出的函数，不复制/
 * 重写任何一行它们的逻辑——本文件是纯编排层，零侵入。
 *
 * 五步怎么串起来（关键：dbPath 怎么让第 4/5 步找到第 3 步装的那份全局库，见 PRD §3.2）：
 *   - 第 3 步 `installGlobalBrain()` 把身份库固定装在 `globalDefaultDbPath(homeDir)`。
 *   - 第 4 步 `onboardProject()` / 第 5 步 seed 的 `main()` 各自默认的 dbPath 解析都遵循同一条
 *     优先级：环境变量 `AELOOP_BRAIN_IDENTITY_DB` 最高优先，其次才是 `AELOOP_BRAIN_GLOBAL_
 *     MODE=1`（那个分支直接调 `os.homedir()`，不接受注入）。seed 的 `main(opts)` 签名里**没有**
 *     `homeDir` 字段（已读源码确认）——只设 `AELOOP_BRAIN_GLOBAL_MODE=1` 在 `--target=<临时
 *     目录>` 自测场景下会解析到真实主目录，违反"绝不碰真实 ~/.claude/"的安全约束。本脚本因此
 *     **同时**设置两个环境变量：`AELOOP_BRAIN_GLOBAL_MODE=1`（让 `resolveTaskSource()` 在没
 *     显式 opt-in 时锁定默认值 "none"，不读任何 `<cwd>/.claude/brain.local.json`）+
 *     `AELOOP_BRAIN_IDENTITY_DB=<globalDefaultDbPath(homeDir)>`（不管 homeDir 是真实主目录还是
 *     自测用的临时目录，第 4/5 步都精确落到第 3 步装的那份库）。两者不冲突：`resolveIdentityDbPath()`
 *     先查 `AELOOP_BRAIN_IDENTITY_DB`，命中即返回。这两个环境变量只在 `runQuickstart()` 执行期间
 *     临时设置，`finally` 里恢复成调用前的值，不污染宿主进程。
 *   - 🔒 **Zorro/Codex 复审 blocker（B1，2026-07-24，已修）**：`resolveTaskSource()` 的优先级是
 *     env > `AELOOP_BRAIN_GLOBAL_MODE=1`——"锁定默认值 none"这句话初版只在 `taskSource ===
 *     "github"` 时赋值 `AELOOP_BRAIN_TASK_SOURCE`，省略 `--task-source` 时**没有清空**这个变量，
 *     宿主 shell 里如果 ambient 已经 export 过 `AELOOP_BRAIN_TASK_SOURCE=github`（本脚本没设、
 *     但也没清），会原样透传进 seed，命中优先级最高的 env 分支，物理击穿"省略 flag 时 shipped
 *     默认零 GitHub"这条保证（issue #103）。现在两个分支都处理：显式 opt-in 才设，否则显式
 *     `delete`，不依赖 ambient 环境"恰好没设过"这个不可控前提。
 *
 * 幂等性不是本文件自己发明的（PRD §3.4）：`installGlobalBrain()`/`onboardProject()`/seed 的
 * `main()` 三者本身都已经是幂等实现（原子换入 + 按标记子串识别重复 hook 条目 / `upsertMemory`
 * 按 `(type,title)`/`matchTag` 匹配已有记录）。本文件只是按顺序调用它们。
 *
 * 跑法：
 *   `node scripts/quickstart.mjs`                          正常安装（写入真实 ~/.claude/）
 *   `node scripts/quickstart.mjs --dry-run`                只打印将要做的改动，不真的执行
 *   `node scripts/quickstart.mjs --task-source=github`     额外 opt-in 接回 GitHub issue 同步
 *   `node scripts/quickstart.mjs --target=<dir>`           测试/高级用途：覆盖 homeDir，日常安装不用
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { installGlobalBrain, installPaths } from "./install-global-brain.mjs";
import { onboardProject } from "./onboard-project.mjs";
import { main as seedBrainIdentityMain } from "./seed-brain-identity.mjs";
import { globalDefaultDbPath } from "../.claude/hooks/lib/db-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, "..");

function defaultExecImpl(cmd, args, options) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

// ── 前置检查 ──────────────────────────────────────────────────────────────

/**
 * Node 版本检查——比对 `package.json` `engines.node`（今天是 `">=24"`）。只做粗粒度的 major
 * 版本比较（够用，`engines.node` 目前也只写了 major），解析不出 `engines.node` 格式（未来改成
 * 别的写法）时不拦，不是本脚本的职责去校验 `package.json` 本身写得对不对。
 * @param {{ repoRoot?: string, nodeVersion?: string }} [opts] `nodeVersion` 供测试注入
 *   （默认 `process.version`，如 `"v24.1.0"`）。
 */
export function checkNodeVersion(opts = {}) {
  const { repoRoot = REPO_ROOT, nodeVersion = process.version } = opts;
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const required = pkg.engines?.node;
  const match = /^>=\s*(\d+)/.exec(required ?? "");
  if (!match) return; // 解析不出就不拦（见头注释）
  const requiredMajor = Number(match[1]);
  const actualMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  if (Number.isNaN(actualMajor) || actualMajor < requiredMajor) {
    throw new Error(
      `Node 版本过低：当前 ${nodeVersion}，本项目要求 ${required}（package.json engines.node）。` +
        "请升级 Node 后重试（推荐用 nvm/fnm 管理版本）。",
    );
  }
}

/**
 * pnpm 是否在 PATH 上——`execImpl("pnpm", ["--version"], ...)` 抛错（典型 ENOENT）即视为不可用。
 * @param {{ execImpl?: typeof defaultExecImpl }} [opts]
 */
export function checkPnpmAvailable(opts = {}) {
  const { execImpl = defaultExecImpl } = opts;
  try {
    execImpl("pnpm", ["--version"], { stdio: "pipe" });
  } catch (err) {
    throw new Error(
      "未检测到 pnpm（PATH 上找不到，或调用失败：" +
        `${err.code ?? err.message}）。请先安装 pnpm（如 \`corepack enable pnpm\` 或 ` +
        "`npm install -g pnpm`）后重试。",
    );
  }
}

/**
 * better-sqlite3 原生模块能不能 load——`pnpm install` 之后立刻校验，早失败早诊断（issue #102：
 * pnpm v10+ 默认阻断依赖的 build 脚本，本仓库已经在 `package.json`/`pnpm-workspace.yaml` 里配
 * `onlyBuiltDependencies`/`allowBuilds` 让它自动编译；这条检查验证配置确实生效，不是假设它一定
 * 生效）。只开一个 `:memory:` 库、立刻关掉，不留任何文件。
 * @param {{ repoRoot?: string }} [opts]
 */
export function verifyBetterSqlite3Loads(opts = {}) {
  const { repoRoot = REPO_ROOT } = opts;
  const require = createRequire(import.meta.url);
  const modDir = path.join(repoRoot, "node_modules", "better-sqlite3");
  try {
    const Database = require(modDir);
    const db = new Database(":memory:");
    db.close();
  } catch (err) {
    throw new Error(
      "better-sqlite3 原生模块加载失败——常见原因是 pnpm v10+ 默认阻断依赖的 build 脚本，" +
        "原生 .node 文件没有被编译出来（见 docs/getting-started/README.md「已知坑与注意」/" +
        `issue #102）。原始错误：${err.message}`,
    );
  }
}

// ── 装完自检 ──────────────────────────────────────────────────────────────

/**
 * 装完自检——不读本地 `dist/`（那是给第 4/5 步用的开发态产物），而是动态 `import()` 换入后的
 * **快照**里的 `store.js`（用它自己目录下的 `node_modules/better-sqlite3`）去开真实装好的身份库、
 * 跑 `listMemories()`——这条路径和真实 `SessionStart` hook 运行时加载的代码/原生模块是同一份
 * （PRD §3.5）。同时检查 `settings.json` 里确实有一条 `SessionStart` 条目的 command 含**这次
 * homeDir 算出来的完整 `hookEntryPath`**（比泛化的 `AELOOP_BRAIN_MARKER` 更具体，见下方实现里
 * 的注释），且 `hookEntryPath` 本身是一个真实存在的文件（不是目录、不是只判断字符串匹配）。
 * @param {{ homeDir?: string }} [opts]
 * @returns {Promise<{hookRegistered: boolean, betterSqlite3Loads: boolean, identityDbReadable: boolean, memoryCount: number|null, errors: string[], ok: boolean}>}
 */
export async function verifyInstall(opts = {}) {
  const { homeDir = os.homedir() } = opts;
  const { snapshotDir, settingsPath, hookEntryPath } = installPaths(homeDir);
  const dbPath = globalDefaultDbPath(homeDir);

  const result = {
    hookRegistered: false,
    betterSqlite3Loads: false,
    identityDbReadable: false,
    memoryCount: /** @type {number|null} */ (null),
    errors: /** @type {string[]} */ ([]),
  };

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const sessionStart = settings?.hooks?.SessionStart ?? [];
    // Zorro 建议级修复（2026-07-24，第二轮补齐）：初版分别检查"command 含 AELOOP_BRAIN_MARKER
    // 这个泛化标记子串"和"hookEntryPath 存在"，两个条件互相独立——理论上会有条 command 含标记
    // 但指向别的路径（不是这次 homeDir 算出来的 hookEntryPath），而 hookEntryPath 本身又恰好因为
    // 别的原因存在（残留文件/目录），两个条件各自为真却对不上号，仍会被误判成"已注册"。改成直接
    // 匹配 command 是否包含**这次 homeDir 算出来的完整 hookEntryPath 字符串**（比泛化标记更具体，
    // `installGlobalBrain()` 生成的 hookCommand 恒会把这个精确路径拼进去，见该文件
    // `hookCommand = ... node "${hookEntryPath}"`）——"找到的这条 command"和"hookEntryPath 存在"
    // 才是同一件事的两个必要条件，不是两件互相独立、恰好都为真的事。
    const commandRegistered = sessionStart.some(
      (entry) =>
        Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === "string" && h.command.includes(hookEntryPath)),
    );
    // 还要求 hookEntryPath 是个**文件**，不是目录——`existsSync()` 对目录也返回 true，不做这条
    // 区分的话，一个同名残留目录也会被误判成"hook 文件已就位"。
    let hookEntryIsFile = false;
    try {
      hookEntryIsFile = statSync(hookEntryPath).isFile();
    } catch {
      hookEntryIsFile = false; // 不存在 / 无权限访问 —— 都当"不是可用的文件"
    }
    result.hookRegistered = commandRegistered && hookEntryIsFile;
    if (!commandRegistered) {
      result.errors.push(`${settingsPath} 里没找到指向 ${hookEntryPath} 的 SessionStart hook 条目`);
    } else if (!hookEntryIsFile) {
      result.errors.push(`settings.json 里登记的 hook 命令指向 ${hookEntryPath}，但这个路径不是一个可用的文件`);
    }
  } catch (err) {
    result.errors.push(`读取/解析 ${settingsPath} 失败：${err.message}`);
  }

  try {
    const storeModulePath = path.join(snapshotDir, "dist", "context", "store.js");
    if (!existsSync(storeModulePath)) {
      throw new Error(`快照里没有 ${storeModulePath}（安装可能没有换入成功）`);
    }
    const { MemoryStore } = await import(pathToFileURL(storeModulePath).href);
    const store = new MemoryStore(dbPath);
    result.betterSqlite3Loads = true;
    try {
      const memories = store.listMemories();
      result.identityDbReadable = true;
      result.memoryCount = memories.length;
      if (memories.length === 0) result.errors.push("身份库可读但没有任何记忆记录（seed 可能没跑成功）");
    } finally {
      store.close();
    }
  } catch (err) {
    result.errors.push(`身份库/原生模块自检失败：${err.message}`);
  }

  // Zorro 建议级修复（2026-07-24）：显式把 `errors.length === 0` 也纳入 `ok` 的判据——今天每条
  // `errors.push()` 恰好都伴随着某个具体 flag 被置 false（belt-and-suspenders 之前就已经蕴含
  // `ok:false`），但那是"细看每条分支都对齐"换来的隐式保证，不是这行判断式本身能看出来的；显式
  // 纳入之后，以后新增一条 error 分支忘了同步改某个 flag，也不会意外把 `ok` 算成 true。
  result.ok =
    result.hookRegistered &&
    result.betterSqlite3Loads &&
    result.identityDbReadable &&
    (result.memoryCount ?? 0) > 0 &&
    result.errors.length === 0;
  return result;
}

// ── 主编排 ────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   repoRoot?: string,
 *   homeDir?: string,
 *   repoPath?: string,
 *   taskSource?: "github",
 *   dryRun?: boolean,
 *   execImpl?: typeof defaultExecImpl,
 *   log?: (...args: unknown[]) => void,
 *   installGlobalBrainImpl?: typeof installGlobalBrain,
 *   onboardProjectImpl?: typeof onboardProject,
 *   seedBrainIdentityImpl?: typeof seedBrainIdentityMain,
 *   verifyBetterSqlite3LoadsImpl?: typeof verifyBetterSqlite3Loads,
 *   verifyInstallImpl?: typeof verifyInstall,
 * }} [opts] 全部依赖可注入——供 `test-quickstart.mjs` 不碰真实 pnpm/网络/`~/.claude/`。
 */
export async function runQuickstart(opts = {}) {
  const {
    repoRoot = REPO_ROOT,
    homeDir = os.homedir(),
    repoPath = repoRoot,
    taskSource,
    dryRun = false,
    execImpl = defaultExecImpl,
    log = console.log,
    installGlobalBrainImpl = installGlobalBrain,
    onboardProjectImpl = onboardProject,
    seedBrainIdentityImpl = seedBrainIdentityMain,
    verifyBetterSqlite3LoadsImpl = verifyBetterSqlite3Loads,
    verifyInstallImpl = verifyInstall,
  } = opts;

  if (taskSource !== undefined && taskSource !== "github") {
    throw new Error(`taskSource 只接受 "github" 或省略，收到不认识的值："${taskSource}"`);
  }

  log("== [0/5] 前置检查 ==");
  checkNodeVersion({ repoRoot });
  checkPnpmAvailable({ execImpl });
  log(`  Node ${process.version} / pnpm 可用 —— OK`);

  if (dryRun) {
    // 措辞精确一点（Zorro 建议级，2026-07-24）：上面的前置检查（Node 版本 / `pnpm --version`）
    // 已经真的跑过了——它们只读、无副作用，"不会真的执行"指的是下面 pnpm install/build/写
    // ~/.claude/ 这些有真实副作用的步骤，不是字面意义上"这次调用什么都没执行"。
    log("--dry-run：前置检查已完成（只读，无副作用）；以下有副作用的步骤不会真的执行，只打印计划。");
    const preview = installGlobalBrainImpl({ repoRoot, homeDir, dryRun: true, taskSource, execImpl });
    log("  将要执行：pnpm install → pnpm run build → 全局安装 → onboard-project → seed 身份库");
    log(`  全局安装目标：${preview.snapshotDir}`);
    log(`  settings.json：${preview.settingsPath}（${preview.settingsChanged ? "将新增/更新一条 SessionStart hook" : "已包含该条目，幂等跳过"}）`);
    log(`  身份库将落在：${globalDefaultDbPath(homeDir)}`);
    return { dryRun: true, preview };
  }

  log("== [1/5] pnpm install（含 better-sqlite3 原生编译，见 issue #102）==");
  execImpl("pnpm", ["install"], { cwd: repoRoot, stdio: "inherit" });
  verifyBetterSqlite3LoadsImpl({ repoRoot });
  log("  better-sqlite3 原生模块加载正常 —— OK");

  log("== [2/5] pnpm run build ==");
  execImpl("pnpm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  log("== [3/5] 全局安装（install-global-brain）==");
  const installResult = installGlobalBrainImpl({ repoRoot, homeDir, taskSource, execImpl });
  log(`  snapshotDir: ${installResult.snapshotDir}`);
  log(`  dataDir: ${installResult.dataDir}`);
  log(`  settings.json: ${installResult.settingsPath}（${installResult.settingsChanged ? "已新增/更新 SessionStart hook 条目" : "已包含该条目，幂等跳过"}）`);
  if (installResult.installedVersion) log(`  已安装版本: ${installResult.installedVersion}`);

  // 第 4/5 步共用的临时环境变量方案，见文件头注释——只在这两步执行期间生效，finally 恢复。
  const priorIdentityDb = process.env.AELOOP_BRAIN_IDENTITY_DB;
  const priorGlobalMode = process.env.AELOOP_BRAIN_GLOBAL_MODE;
  const priorTaskSource = process.env.AELOOP_BRAIN_TASK_SOURCE;
  process.env.AELOOP_BRAIN_IDENTITY_DB = globalDefaultDbPath(homeDir);
  process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
  // 🔒 Zorro/Codex 复审 blocker（B1，2026-07-24）：`resolveTaskSource()` 的优先级是
  // env(`AELOOP_BRAIN_TASK_SOURCE`) > `AELOOP_BRAIN_GLOBAL_MODE=1`——只在显式 `--task-source=
  // github` 时"设"这个变量，省略时不管，会让**宿主 shell 里已经 export 过的**
  // `AELOOP_BRAIN_TASK_SOURCE=github`（ambient，本脚本没设，但也没清）原样透传进 seed 的
  // `resolveTaskSource()`，命中优先级最高的 env 分支，物理上击穿"省略 --task-source 时
  // shipped 默认零 GitHub"这条本该由 GLOBAL_MODE 锁死的保证（issue #103）。必须显式清空，不能
  // 只在 opt-in 分支赋值——"锁定默认值"这句话要成立，两个分支都要处理，不是只处理其中一个。
  if (taskSource === "github") process.env.AELOOP_BRAIN_TASK_SOURCE = "github";
  else delete process.env.AELOOP_BRAIN_TASK_SOURCE;

  let onboardResult;
  let seedResult;
  try {
    log("== [4/5] onboard-project（把当前项目登记进 brain）==");
    onboardResult = await onboardProjectImpl({ repoPath });
    log(`  ${onboardResult.projectKey} — ${onboardResult.action}`);

    log("== [5/5] seed 身份库（身份 + 宪法 +（可选）在途）==");
    seedResult = await seedBrainIdentityImpl({ cwd: repoPath });
    log(`  身份：${seedResult.identity.action}`);
    log(`  宪法约束：共 ${seedResult.constraints.length} 条`);
    if (seedResult.skippedTaskSync) {
      log(`  在途任务同步已跳过：${seedResult.skippedTaskSync}`);
    } else {
      log(`  在途任务：共 ${seedResult.issues.length} 条`);
    }
  } finally {
    if (priorIdentityDb === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    else process.env.AELOOP_BRAIN_IDENTITY_DB = priorIdentityDb;
    if (priorGlobalMode === undefined) delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
    else process.env.AELOOP_BRAIN_GLOBAL_MODE = priorGlobalMode;
    if (priorTaskSource === undefined) delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    else process.env.AELOOP_BRAIN_TASK_SOURCE = priorTaskSource;
  }

  log("== 自检 ==");
  const verify = await verifyInstallImpl({ homeDir });
  log(`  hook 已注册: ${verify.hookRegistered ? "OK" : "FAIL"}`);
  log(`  better-sqlite3 能 load: ${verify.betterSqlite3Loads ? "OK" : "FAIL"}`);
  log(`  身份库可读（${verify.memoryCount ?? 0} 条记忆）: ${verify.identityDbReadable ? "OK" : "FAIL"}`);
  if (verify.errors.length > 0) {
    for (const e of verify.errors) log(`  ⚠ ${e}`);
  }
  if (!verify.ok) {
    throw new Error(`自检未全部通过，见上方 ⚠ 明细：${verify.errors.join("; ")}`);
  }

  log("");
  log("安装完成。下一步：开一个新的 Claude Code 终端 CLI 会话（在任意项目目录都可以），第一行");
  log("应该出现「意识已加载」。目前这条路径在 CLI 会话里已确认生效；IDE 扩展环境下 SessionStart");
  log("hook 的触发性正在核实中（aeloop#106），如果你在 IDE 里没看到开场白，先在纯终端 CLI 里确认");
  log("机制本身生效，不代表安装失败。");

  return { dryRun: false, installResult, onboardResult, seedResult, verify };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`用法：node scripts/quickstart.mjs [选项]

一条命令跑完 docs/getting-started/README.md 记录的手动五步（安装依赖 → build → 全局安装 →
登记当前项目 → seed 身份库），幂等、可重复跑。

选项：
  --dry-run              只打印将要做的改动，不真的执行任何写入
  --task-source=github   额外 opt-in 接回 GitHub issue 在途同步（需要 gh 已登录）；省略即默认
                          "none"（shipped 默认零 GitHub，不需要 gh）
  --target=<dir>         测试/高级用途：覆盖全局安装目标目录（默认真实 $HOME），日常安装不用
  --repo-path=<dir>      要登记进 brain 的项目路径（默认是这个脚本自己所在的仓库根）
  -h, --help             显示这条帮助
`);
}

function parseArgs(argv) {
  const opts = { dryRun: false, target: undefined, taskSource: undefined, repoPath: undefined };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--target=")) {
      const value = arg.slice("--target=".length);
      if (value.trim() === "") throw new Error("--target= 不能是空字符串（省略这个选项即用真实 $HOME）");
      opts.target = value;
    } else if (arg.startsWith("--repo-path=")) {
      const value = arg.slice("--repo-path=".length);
      if (value.trim() === "") throw new Error("--repo-path= 不能是空字符串（省略这个选项即用脚本自己所在的仓库根）");
      opts.repoPath = value;
    }
    else if (arg.startsWith("--task-source=")) {
      const value = arg.slice("--task-source=".length);
      if (value !== "github") {
        throw new Error(`--task-source 只接受 "github"（省略即默认 "none"），收到不认识的值："${value}"`);
      }
      opts.taskSource = value;
    } else {
      throw new Error(`不认识的参数："${arg}"（用 --help 看用法）`);
    }
  }
  return opts;
}

// 🔒 Zorro/Codex 复审 blocker（B2，2026-07-24）：`import.meta.url === \`file://${process.argv[1]}\``
// 在路径含空格（或其它需要 URL 编码的字符）时静默失效——`import.meta.url` 是百分号编码
// （空格变 `%20`），`\`file://${process.argv[1]}\`` 是把原始字符串直接拼进去（字面空格，不编码），
// 两边永远不相等，守卫恒为 false，`node scripts/quickstart.mjs` 在这种路径下会**静默 no-op、
// exit 0，什么都不做**——用户 clone 到带空格目录（macOS 很常见，如 iCloud Drive 同步目录/
// "My Projects"）时，这条"一键安装"命令看起来跑完了实际什么都没装，且不报任何错。
//
// 修复过程中用真实 spawn 的回归测试（`test-quickstart.mjs` 的 B2 用例）额外抓到第二个、同一行
// 代码上的独立根因，不是编码问题：Node 加载入口模块时，`import.meta.url` 是**经过 realpath 解析
// 的**（跟随符号链接），而 `process.argv[1]` 是调用时的**字面参数**（不解析符号链接）——macOS
// 上 `os.tmpdir()`/`/tmp` 本身就是指向 `/private/var/folders/...`/`/private/tmp` 的符号链接
// （systemwide，不是本仓库特有），单独套 `pathToFileURL()` 而不处理符号链接，在这类路径下守卫
// 依然会静默失效（实测复现：单独加 `pathToFileURL` 后，本地临时目录跑 `--help` 仍然 no-op）。
// 两个根因都要处理，用 `realpathSync()` 把 `process.argv[1]` 解析到和 `import.meta.url` 同一套
// 表示（先 realpath 拿到规范路径，再 `pathToFileURL` 编码），才是两边永远可比的完整修法。
// 仓库其它脚本（`install-global-brain.mjs` 等）沿用的还是旧写法，是已知的、范围外的问题，这里
// 不顺手改（军师另开 issue 统一扫，见 PR 讨论）。
//
// 🔒 Zorro/Codex 复审 blocker（B3，2026-07-24）：上面这个 realpath 修法本身引入了一个新回归——
// `realpathSync(process.argv[1])` 是无条件、模块顶层执行的。本文件通篇导出可复用的纯函数
// （`runQuickstart`/`verifyInstall`/…），契约上是"既能当 CLI 跑，也能被别的代码 `import`"（
// `test-quickstart.mjs` 自己就是这么用的）——但 `node -e "import('./scripts/quickstart.mjs')"`/
// REPL/部分 preload 场景下 `process.argv[1]` 是 `undefined`（或指向一个已被删除/合成的路径），
// `realpathSync(undefined)` 直接抛 `ENOENT`，**顶层抛错会让整个 `import` 失败**，连导出的函数都
// 拿不到——R1 修复前的旧写法（`file://${process.argv[1]}`）在 `argv[1]` 是 `undefined` 时只是
// 字符串拼接出一个不会相等的值，不抛错，这是这次改动意外收紧的行为，必须先判断 `argv[1]` 存在、
// 再包 try/catch 兜底任何 `realpathSync` 失败（不仅是 `undefined`，也包括指向一个不存在文件的
// 字符串），两种情况都视为"这不是 CLI 直接入口"，而不是让 import 本身失败。
//
// 🟡 已知边角（Zorro 复审顺带指出，非 blocker，知会不追）：跑 `node --preserve-symlinks-main` 时，
// Node 会保留入口模块**字面**的 symlink URL 不做 realpath 解析，这里仍然对 `process.argv[1]`
// 强制 `realpathSync`，两边可能对不上，导致这个冷门 flag 下 CLI 静默 no-op（不是抛错——上面的
// try/catch 把它降级成"当作非 CLI 入口"，不会重新引入 B3 那种 import 直接失败的问题）。
let isCliEntry = false;
if (process.argv[1]) {
  try {
    isCliEntry = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    isCliEntry = false; // argv[1] 指向一个 realpath 解析不出来的路径（不存在/坏符号链接等）——
    // 不是 CLI 直接入口，静默当 false，不让 import 本身失败。
  }
}
if (isCliEntry) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    args = null;
  }
  if (args?.help) {
    printHelp();
  } else if (args) {
    runQuickstart({ dryRun: args.dryRun, homeDir: args.target, taskSource: args.taskSource, repoPath: args.repoPath }).catch(
      (err) => {
        console.error(`[quickstart] 安装失败：${err.message ?? String(err)}`);
        process.exitCode = 1;
      },
    );
  }
}
