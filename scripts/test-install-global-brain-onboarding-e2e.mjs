// test-install-global-brain-onboarding-e2e.mjs — 真实端到端测试（Zorro/Codex 跨模型二签
// 2026-07-23 FAIL blocker 1 要求补齐）：install-global-brain.mjs 的 COPY_ITEMS 漏拷
// onboarding-greeting.mjs，导致全局模式下"首次空库"这个 issue #96 最该生效的场景，实际会因为
// `import()` MODULE_NOT_FOUND 被 `main().catch()` 静默吞掉，stdout 完全空——正好变回 #96 本身
// 要堵的"沉默=模型脑补假开场白"那个洞。
//
// 和 `test-install-global-brain.mjs` 的关键区别（不是重复，是互补）：那份文件**绝不**用真实
// `repoRoot` 内容（永远是最小 fixture，测的是"拷贝/合并机制对不对"，见该文件头注释），本文件
// **故意用这个 worktree 自己的真实 `repoRoot`**（真实 dist/、真实 onboarding-greeting.mjs 等
// spike/lib 文件）——因为这次要验证的不是"文件复制机制"，是"复制完之后，真的从一个无关项目
// cwd 真实 spawn 那个被复制出来的 hook 进程，它是否真的能产出引导文本，而不是 MODULE_NOT_FOUND
// 静默失败"。仍然**绝不**触碰真实 `os.homedir()`——`installGlobalBrain()` 的 `homeDir` 和 spawn
// 子进程时的 `HOME` 环境变量全程指向本测试自己建的临时目录（下面"为什么要覆盖 HOME"一节详细
// 解释这条容易踩空的坑）。
//
// 为什么要覆盖 HOME（不只是传 `homeDir` 给 installGlobalBrain()）：`resolveIdentityDbPath()`
// 的全局模式分支调用 `globalDefaultDbPath(opts.homeDir)`，而 `brain-wake-greeting.mjs` 调用
// `resolveIdentityDbPath()` 时**不传任何 opts**（`const dbPath = resolveIdentityDbPath();`）——
// 也就是说真实 spawn 出来的 hook 子进程，`globalDefaultDbPath()` 会退回它自己的默认参数
// `os.homedir()`，而 Node 的 `os.homedir()` 在 POSIX 上读的是**子进程自己环境变量里的 `HOME`**，
// 不是父进程调 `installGlobalBrain({homeDir})` 时传的那个 JS 对象参数（子进程完全看不到父进程的
// JS 调用栈，只看得到它自己的 env）。如果只把 `homeDir` 传给 `installGlobalBrain()` 而不在
// `spawnSync` 时同步覆盖子进程的 `HOME`，子进程的 `os.homedir()` 会解析到测试机器的真实主目录，
// 悄悄违反"绝不触碰真实 ~/.claude/"这条安全硬约束，而且会读到/写到一个和本测试临时安装目录
// 完全不相关的地方，断言会失真。
//
// 为什么 `npm install` 这一步不真的跑：这个测试环境的网络可用性不可控，真实 `npm install` 拉取
// `better-sqlite3` 的 prebuilt 二进制会引入不必要的 flaky 依赖。本测试改用一个自定义 `execImpl`
// ——命中 `npm install` 时，直接把**这个 worktree 自己已经验证能正常工作的**
// `node_modules/better-sqlite3`（含真实编译好的 native binding，`pnpm rebuild better-sqlite3`
// 产出）原样拷进 staging 目录——效果上等价于"npm install 成功产出一份能用的 better-sqlite3"，
// 且不依赖网络。这不削弱本测试的真实性：本测试要验证的是"COPY_ITEMS 拷全了之后 hook 子进程能
// 不能正确 import() 到 onboarding-greeting.mjs"，不是"npm 包管理器本身工作正常"（那是 npm 自己
// 的职责，不是 aeloop 这次改动要覆盖的范围）。`pnpm run build` 这一步则**真的跑**（不 stub）——
// 这个 worktree 本来就要保持 `dist/` 新鲜，多跑一次零副作用，真实产出的 `dist/` 更贴近生产场景。
//
// 跑法：pnpm run build && node scripts/test-install-global-brain-onboarding-e2e.mjs
// （需要本机 `node_modules/better-sqlite3` 已经有真实可用的 native binding——正常开发流程下
// `pnpm install` 之后应该已经有；如果没有，先跑 `pnpm rebuild better-sqlite3`，issue #102）。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobalBrain, installPaths } from "./install-global-brain.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

/**
 * 自定义 execImpl：`pnpm run build` 真的跑（保持 dist/ 新鲜）；`npm install` 改成拷贝这个
 * worktree 自己已经验证能用的 better-sqlite3（不依赖网络，见文件头注释）。
 */
function e2eExecImpl(cmd, args, options) {
  if (cmd === "npm" && args[0] === "install") {
    const src = path.join(REPO_ROOT, "node_modules", "better-sqlite3");
    if (!existsSync(src)) {
      throw new Error(
        `${src} 不存在——本测试需要这个 worktree 自己先有一份能用的 better-sqlite3（正常 pnpm install ` +
          "之后应该有；如果没有，先跑 `pnpm rebuild better-sqlite3`，issue #102）。",
      );
    }
    const destNodeModules = path.join(options.cwd, "node_modules");
    mkdirSync(destNodeModules, { recursive: true });
    cpSync(src, path.join(destNodeModules, "better-sqlite3"), { recursive: true });
    return "";
  }
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

const tempHome = mkdtempSync(path.join(tmpdir(), "aeloop-test-global-e2e-home-"));
const unrelatedCwd = mkdtempSync(path.join(tmpdir(), "aeloop-test-global-e2e-unrelated-cwd-"));

try {
  // ① 真实安装到临时 --target（等价于 `node scripts/install-global-brain.mjs --target=<tempHome>`，
  //    这里直接调 installGlobalBrain() 而不是 spawn CLI，纯粹是为了直接拿到 result.hookEntryPath/
  //    snapshotDir 这些返回值，行为等价，CLI 只是给 result 包了一层 console.log）。
  const result = installGlobalBrain({ repoRoot: REPO_ROOT, homeDir: tempHome, execImpl: e2eExecImpl });
  assert.equal(result.dryRun, false);
  // `installGlobalBrain()` 的返回值不含 hookEntryPath（只有 snapshotDir/dataDir/settingsPath/
  // hookCommand 等）——`installPaths(homeDir)` 是算这条路径的唯一权威来源，两处调用（安装脚本
  // 自己内部、这里）传同一个 homeDir 会算出同一个值，不重新拼字符串。
  const { hookEntryPath } = installPaths(tempHome);
  assert.ok(existsSync(hookEntryPath), `安装后 hook 入口文件应该真实存在：${hookEntryPath}`);
  console.log("PASS: test-install-global-brain-onboarding-e2e.mjs（① 真实安装到临时 --target 完成）");

  // ② 回归防线本身：onboarding-greeting.mjs 必须真的出现在换入后的 snapshot 里（COPY_ITEMS 漏
  //    掉它是 blocker 1 的根因，这条断言直接锁死"以后又被漏掉"这个风险）。
  const copiedOnboardingLib = path.join(
    result.snapshotDir,
    "docs",
    "conductor-brain-layer",
    "spike",
    "lib",
    "onboarding-greeting.mjs",
  );
  assert.ok(existsSync(copiedOnboardingLib), `COPY_ITEMS 必须包含 onboarding-greeting.mjs，快照里应该能找到它：${copiedOnboardingLib}`);
  console.log("PASS: test-install-global-brain-onboarding-e2e.mjs（② onboarding-greeting.mjs 真的出现在换入后的快照里）");

  // ③ 核心断言：从一个无关项目 cwd、带着一个全新（未 seed）的全局身份库，真实 spawn 换入后的
  //    hook 子进程——必须产出引导文本（不是 MODULE_NOT_FOUND 被吞掉后的空 stdout）。
  //    `HOME` 覆盖成 tempHome 的原因见文件头注释——不这样做，子进程的 os.homedir() 会解析到
  //    这台测试机器的真实主目录，读到/写到不相关的地方，也悄悄违反"绝不碰真实 ~/.claude/"。
  const stdinPayload = JSON.stringify({ session_id: "test-global-e2e", cwd: unrelatedCwd });
  const proc = spawnSync("node", [hookEntryPath], {
    input: stdinPayload,
    encoding: "utf8",
    cwd: unrelatedCwd,
    env: { ...process.env, HOME: tempHome, AELOOP_BRAIN_GLOBAL_MODE: "1" },
  });

  assert.equal(proc.status, 0, `hook 子进程必须 exit 0（绝不阻断），实际 status=${proc.status}，stderr=${proc.stderr}`);
  assert.ok(
    !/MODULE_NOT_FOUND|Cannot find module/i.test(proc.stderr),
    `hook 子进程的 stderr 不该出现模块找不到的错误——这正是 blocker 1 修复前的真实失败模式，stderr=${proc.stderr}`,
  );

  let hookOutput;
  try {
    hookOutput = JSON.parse(proc.stdout);
  } catch (err) {
    throw new Error(
      `hook stdout 应该是合法 JSON（说明真的产出了引导文本，不是 MODULE_NOT_FOUND 被 main().catch() 吞掉后的空 stdout）；` +
        `解析失败：${err.message}\nraw stdout: "${proc.stdout}"\nstderr: "${proc.stderr}"`,
    );
  }
  const additionalContext = hookOutput?.hookSpecificOutput?.additionalContext;
  assert.equal(typeof additionalContext, "string", "全局模式下首次空库必须注入引导脚本，stdout 不能是空的");
  assert.ok(additionalContext.length > 0, "引导脚本正文不能是空字符串");
  assert.ok(!additionalContext.includes("意识已加载"), "首次空库的引导不能出现'意识已加载'——没有真实数据支撑");
  assert.ok(additionalContext.includes("git clone"), "全局模式下的引导应该提示需要一份真实 aeloop checkout（运行时快照不含管理脚本）");
  assert.ok(
    additionalContext.includes("AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/seed-brain-identity.mjs"),
    "全局模式下 seed 命令必须带 AELOOP_BRAIN_GLOBAL_MODE=1 前缀",
  );

  console.log(
    "PASS: test-install-global-brain-onboarding-e2e.mjs（③ 全局模式 + 无关 cwd + 空库真实 spawn 换入后的 hook，" +
      "产出真实引导文本，不是 MODULE_NOT_FOUND 静默失败——issue #96 blocker 1 核心回归证明）",
  );
} finally {
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(unrelatedCwd, { recursive: true, force: true });
}
