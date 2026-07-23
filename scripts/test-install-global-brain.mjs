// test-install-global-brain.mjs — issue #93 B0 单元测试：install-global-brain.mjs。
//
// 🔒 安全硬约束（指挥官 2026-07-23）：本文件**绝不**触碰真实 `os.homedir()`/真实 `~/.claude/`——
// 每个用例都用 `mkdtempSync` 建一个临时 "fake home" 目录传给 `homeDir`，用另一个临时目录当
// "fake repo root"（放最小 fixture 文件，不真的跑 `pnpm run build`——`execImpl` 全程替换成假实现）。
//
// 覆盖 PRD §6.1：
//   - 全新 settings.json（不存在）→ 正确创建，含唯一一条 hook 条目。
//   - 已有其它 hook 条目的 settings.json → 安装后原有条目逐字节不变，仅新增本工具条目。
//   - 二次运行（幂等）→ hook 条目不重复累加。
//   - --dry-run → 不产生任何文件系统写入。
//   - 安装产出的 repo-snapshot/ 目录树包含预期的全部文件。
//
// 跑法：node scripts/test-install-global-brain.mjs（零外部依赖，不需要网络/pnpm/npm 真的可用）。

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COPY_ITEMS,
  installGlobalBrain,
  installPaths,
  mergeSettingsWithBrainHook,
} from "./install-global-brain.mjs";

function buildFakeRepoRoot() {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "brain-test-fakerepo-"));
  // 最小 fixture：COPY_ITEMS 里每一项都要存在，否则 cpSync 会抛错——内容是假的（不是真实
  // aeloop 源码），因为本测试只验证"安装脚本的拷贝/合并逻辑对不对"，不验证被拷贝文件本身的
  // 业务逻辑（那些各自有自己的 test-*.mjs，见 B1/B4）。
  for (const item of COPY_ITEMS) {
    const srcPath = path.join(repoRoot, item.src);
    if (item.type === "dir") {
      mkdirSync(srcPath, { recursive: true });
      writeFileSync(path.join(srcPath, "placeholder.js"), "// fixture placeholder\n");
    } else {
      mkdirSync(path.dirname(srcPath), { recursive: true });
      writeFileSync(srcPath, `// fixture: ${item.src}\n`);
    }
  }
  writeFileSync(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ name: "aeloop", dependencies: { "better-sqlite3": "^12.11.1" } }, null, 2),
  );
  return repoRoot;
}

/** 假 execImpl——记录调用参数，不真的 spawn 任何进程；`npm install` 调用时顺手在 cwd 建一个
 * 假 node_modules，让"安装产出目录树完整"的断言不需要真的装原生依赖也能过。 */
function makeFakeExecImpl() {
  const calls = [];
  const impl = (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options?.cwd });
    if (cmd === "npm" && args[0] === "install") {
      mkdirSync(path.join(options.cwd, "node_modules", "better-sqlite3"), { recursive: true });
      writeFileSync(path.join(options.cwd, "node_modules", "better-sqlite3", "fixture.js"), "// fake native module\n");
    }
    return "";
  };
  impl.calls = calls;
  return impl;
}

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

// ── mergeSettingsWithBrainHook：纯函数，独立测（不涉及文件系统） ────────────────────────

check("mergeSettingsWithBrainHook: 全新（null）设置 → 新建唯一条目", () => {
  const { settings, changed } = mergeSettingsWithBrainHook(null, "node hook.mjs");
  assert.equal(changed, true);
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "node hook.mjs");
});

check("mergeSettingsWithBrainHook: 已有其它 hook 条目 → 原样保留 + 新增一条（不覆盖）", () => {
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash third-party.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "some-other-tool.mjs" }] }],
    },
  };
  const existingSnapshot = JSON.parse(JSON.stringify(existing)); // 深拷贝，验证入参本身没被就地改动
  const { settings, changed } = mergeSettingsWithBrainHook(existing, "node hook.mjs");
  assert.deepEqual(existing, existingSnapshot, "入参对象不该被就地修改");
  assert.equal(changed, true);
  assert.deepEqual(settings.permissions, existing.permissions, "无关字段原样保留");
  assert.deepEqual(
    settings.hooks.PreToolUse,
    existing.hooks.PreToolUse,
    "既有 PreToolUse 条目必须逐字节保留，不能被本工具误删",
  );
  assert.equal(settings.hooks.SessionStart.length, 2, "第三方 SessionStart 条目保留 + 新增本工具一条");
  assert.deepEqual(settings.hooks.SessionStart[0], existing.hooks.SessionStart[0], "第三方条目原样在前");
  assert.equal(settings.hooks.SessionStart[1].hooks[0].command, "node hook.mjs");
});

check("mergeSettingsWithBrainHook: 幂等——已存在完全相同 command → 不重复追加", () => {
  const existing = {
    hooks: { SessionStart: [{ matcher: "startup|resume|clear", hooks: [{ type: "command", command: "node hook.mjs" }] }] },
  };
  const { settings, changed } = mergeSettingsWithBrainHook(existing, "node hook.mjs");
  assert.equal(changed, false);
  assert.equal(settings.hooks.SessionStart.length, 1);
});

// ── mergeSettingsWithBrainHook：🔒 Zorro must-fix（2026-07-23）——语法合法但结构畸形的
//    settings.json 必须 fail-closed 抛错，不静默归一化/丢内容 ─────────────────────────────

check("mergeSettingsWithBrainHook: 顶层是数组（不是 plain object）→ fail-closed 抛错", () => {
  assert.throws(
    () => mergeSettingsWithBrainHook([1, 2, 3], "node hook.mjs"),
    /顶层不是一个对象.*数组/,
    "顶层是数组时必须拒绝，不能被 {...[1,2,3]} 静默展开成 {0:1,1:2,2:3}",
  );
});

check('mergeSettingsWithBrainHook: "hooks" 字段是数组（不是 plain object）→ fail-closed 抛错', () => {
  const existing = { hooks: ["not", "an", "object"] };
  assert.throws(
    () => mergeSettingsWithBrainHook(existing, "node hook.mjs"),
    /"hooks".*不是一个对象.*数组/,
    'hooks 是数组时必须拒绝，不能被 {...["not","an","object"]} 静默展开丢内容',
  );
});

check('mergeSettingsWithBrainHook: "hooks.SessionStart" 存在但不是数组 → fail-closed 抛错（对象/字符串两种畸形值各测一次）', () => {
  assert.throws(
    () => mergeSettingsWithBrainHook({ hooks: { SessionStart: { legacy: "shape" } } }, "node hook.mjs"),
    /"hooks\.SessionStart".*不是一个数组/,
    "SessionStart 是对象时必须拒绝，不能被 Array.isArray(...) ? [...x] : [] 静默替换成 []",
  );
  assert.throws(
    () => mergeSettingsWithBrainHook({ hooks: { SessionStart: "not-an-array" } }, "node hook.mjs"),
    /"hooks\.SessionStart".*不是一个数组/,
    "SessionStart 是字符串时同样必须拒绝",
  );
});

check("mergeSettingsWithBrainHook: 合法但 hooks/SessionStart 缺失（首次安装的正常场景）→ 不受上面几条 fail-closed 检查影响", () => {
  // 回归：上面新增的三条 fail-closed 检查用的是 `!== undefined` 才检查形状，不能误伤
  // "这个字段压根不存在"这个完全合法的场景（比如一个只有 permissions 字段、还没配过任何 hooks
  // 的 settings.json）。
  const { settings, changed } = mergeSettingsWithBrainHook({ permissions: { allow: [] } }, "node hook.mjs");
  assert.equal(changed, true);
  assert.deepEqual(settings.permissions, { allow: [] });
  assert.equal(settings.hooks.SessionStart.length, 1);
});

// ── installGlobalBrain：端到端（临时 fake repoRoot + 临时 fake homeDir） ───────────────────

{
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-"));
  try {
    const execImpl = makeFakeExecImpl();
    const result = installGlobalBrain({ repoRoot, homeDir, execImpl });

    check("installGlobalBrain: 全新安装 → build 只跑一次", () => {
      const buildCalls = execImpl.calls.filter((c) => c.cmd === "pnpm");
      assert.equal(buildCalls.length, 1);
      assert.deepEqual(buildCalls[0].args, ["run", "build"]);
    });

    check("installGlobalBrain: repo-snapshot 目录树包含全部预期文件", () => {
      for (const item of COPY_ITEMS) {
        const dest = path.join(result.snapshotDir, item.src);
        assert.ok(existsSync(dest), `缺少 ${dest}`);
      }
      assert.ok(existsSync(path.join(result.snapshotDir, "node_modules", "better-sqlite3")), "better-sqlite3 应已安装");
    });

    check("installGlobalBrain: 相对目录骨架保留（wake.mjs 到 dist 的相对深度不变）", () => {
      const wakeMjsPath = path.join(
        result.snapshotDir,
        "docs",
        "conductor-brain-layer",
        "spike",
        "lib",
        "wake.mjs",
      );
      const distPath = path.join(result.snapshotDir, "dist");
      // wake.mjs 源码里的 "../../../../dist" 应该从它的新位置正确解到 distPath——
      // 用 path.resolve 复算一遍验证骨架深度确实保留。
      const resolved = path.resolve(path.dirname(wakeMjsPath), "..", "..", "..", "..", "dist");
      assert.equal(resolved, distPath);
    });

    check("installGlobalBrain: data 目录已创建", () => {
      assert.ok(existsSync(result.dataDir));
    });

    check("installGlobalBrain: settings.json 全新创建，含唯一一条 hook", () => {
      const written = JSON.parse(readFileSync(result.settingsPath, "utf8"));
      assert.equal(written.hooks.SessionStart.length, 1);
      assert.equal(written.hooks.SessionStart[0].hooks[0].command, result.hookCommand);
      assert.ok(result.hookCommand.includes("AELOOP_BRAIN_GLOBAL_MODE=1"));
      assert.ok(result.hookCommand.includes(installPaths(homeDir).hookEntryPath));
    });

    check("installGlobalBrain: 二次运行 → 幂等，hook 条目不重复累加", () => {
      const execImpl2 = makeFakeExecImpl();
      const result2 = installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl2 });
      assert.equal(result2.settingsChanged, false);
      const written = JSON.parse(readFileSync(result2.settingsPath, "utf8"));
      assert.equal(written.hooks.SessionStart.length, 1, "二次安装后仍只有一条本工具的 hook 条目");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── 已有其它 hook 的真实 settings.json → 安装后原有条目逐字节不变（端到端，非纯函数单测） ──

{
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const preExisting = {
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash /some/third-party/hook.sh" }] }],
      },
      statusLine: { type: "command", command: "~/statusline.sh" },
    };
    writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify(preExisting, null, 2));

    const execImpl = makeFakeExecImpl();
    const result = installGlobalBrain({ repoRoot, homeDir, execImpl });

    check("installGlobalBrain: 端到端——已有第三方 hook 的真实 settings.json 安装后原样保留", () => {
      const written = JSON.parse(readFileSync(result.settingsPath, "utf8"));
      assert.deepEqual(written.statusLine, preExisting.statusLine, "无关字段原样保留");
      assert.equal(written.hooks.SessionStart.length, 2);
      assert.deepEqual(written.hooks.SessionStart[0], preExisting.hooks.SessionStart[0], "第三方条目逐字节不变");
    });

    check("installGlobalBrain: 备份文件已生成", () => {
      const dirEntries = readdirSync(claudeDir);
      const hasBackup = dirEntries.some((name) => name.startsWith("settings.json.bak-"));
      assert.ok(hasBackup, "应该生成一份 settings.json.bak-<timestamp> 备份");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── 🔒 Zorro must-fix（2026-07-23）：畸形但合法的 settings.json → installGlobalBrain() 整体
//    拒绝（fail-closed，报错退出），原文件字节级不变，且不产生任何新文件/新目录（build/拷贝/
//    npm install 都不会被触发——mergeSettingsWithBrainHook() 的检查发生在任何写入之前，见该
//    函数头注释）——端到端验证，不只是纯函数单测。 ──────────────────────────────────────────

for (const malformedCase of [
  { label: "顶层是数组", content: JSON.stringify([1, 2, 3]) },
  { label: "hooks 字段是数组", content: JSON.stringify({ hooks: ["not", "an", "object"] }) },
  { label: "hooks.SessionStart 是对象（非数组遗留值）", content: JSON.stringify({ hooks: { SessionStart: { legacy: true } } }) },
]) {
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-malformed-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    writeFileSync(settingsPath, malformedCase.content);

    const execImpl = makeFakeExecImpl();

    check(`installGlobalBrain: 端到端 fail-closed——[${malformedCase.label}] 整体拒绝，不静默改`, () => {
      assert.throws(() => installGlobalBrain({ repoRoot, homeDir, execImpl }), Error);
    });

    check(`installGlobalBrain: [${malformedCase.label}] 原 settings.json 字节级不变（未被触碰）`, () => {
      assert.equal(readFileSync(settingsPath, "utf8"), malformedCase.content);
    });

    check(`installGlobalBrain: [${malformedCase.label}] build/npm install 均未被触发（拒绝发生在任何写入之前）`, () => {
      assert.equal(execImpl.calls.length, 0, "fail-closed 应该在第一次 execImpl 调用之前就中止");
    });

    check(`installGlobalBrain: [${malformedCase.label}] 不产生 snapshot/data 目录、不产生 .bak`, () => {
      const snapshotDir = path.join(homeDir, ".claude", "aeloop-brain", "repo-snapshot");
      const dataDir = path.join(homeDir, ".claude", "aeloop-brain", "data");
      assert.equal(existsSync(snapshotDir), false);
      assert.equal(existsSync(dataDir), false);
      const dirEntries = readdirSync(claudeDir);
      assert.ok(!dirEntries.some((name) => name.startsWith("settings.json.bak-")), "不该生成 .bak——压根没有写入发生，不需要备份");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── --dry-run：不产生任何文件系统写入 ──────────────────────────────────────────────────────

{
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-dryrun-"));
  try {
    const execImpl = makeFakeExecImpl();
    const result = installGlobalBrain({ repoRoot, homeDir, dryRun: true, execImpl });

    check("installGlobalBrain: --dry-run 不调用 execImpl（不跑 build/install）", () => {
      assert.equal(execImpl.calls.length, 0);
    });

    check("installGlobalBrain: --dry-run 不创建 snapshotDir/dataDir/settings.json", () => {
      assert.equal(existsSync(result.snapshotDir), false);
      assert.equal(existsSync(result.dataDir), false);
      assert.equal(existsSync(result.settingsPath), false);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── 🔒 Zorro must-fix（2026-07-23，第2轮）：重装必须原子——中途失败（npm install 报错 / 拷贝
//    源文件缺失）时旧快照必须完好保留，不能"先删旧的再建新的"导致残缺快照悬在那，settings.json
//    里已注册的 hook 命令还指向它。 ──────────────────────────────────────────────────────

{
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-atomicreinstall-"));
  try {
    // 首次安装成功，产出一份"v1"快照。
    const execImpl1 = makeFakeExecImpl();
    const result1 = installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl1 });
    const hookEntryPath = path.join(result1.snapshotDir, ".claude", "hooks", "brain-wake-greeting.mjs");
    const betterSqlite3Path = path.join(result1.snapshotDir, "node_modules", "better-sqlite3");
    const v1Content = readFileSync(hookEntryPath, "utf8");
    assert.ok(existsSync(betterSqlite3Path), "前置条件：v1 快照应该已经装好 better-sqlite3");

    // 第二次安装：npm install 这一步故意失败（模拟真实场景——网络抖动/磁盘满/依赖解析失败）。
    const execImpl2 = (cmd, args, options) => {
      if (cmd === "npm" && args[0] === "install") {
        throw new Error("simulated npm install failure (disk full / network flake / etc.)");
      }
      return "";
    };

    check("installGlobalBrain: 重装中途（npm install）失败 → 整体抛错", () => {
      assert.throws(() => installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl2 }), /simulated npm install failure/);
    });

    check("installGlobalBrain: 重装失败后，旧快照（v1）原封不动——目录还在、关键文件内容字节级不变", () => {
      assert.ok(existsSync(result1.snapshotDir), "旧快照目录应该还在");
      assert.equal(readFileSync(hookEntryPath, "utf8"), v1Content, "旧快照的 hook 入口文件内容不该被改动");
    });

    // 🔒 关键判别性断言——只比对 hook 文件内容不足以区分"真的原子"和"先删了再重建到一半"：
    // 如果 repoRoot 的 fixture 内容在两次安装之间没变，"先删后建"重新拷贝出来的 hook 文件内容
    // 会碰巧和 v1 一样（fixture 没变，拷贝结果自然一样），看起来像是"没被动过"，但实际上旧的
    // node_modules（npm install 产出，不在 COPY_ITEMS 拷贝范围内）已经被 rmSync 连锅端掉、
    // 新的 npm install 又失败了，真实后果是 node_modules/better-sqlite3 彻底消失——这才是"先删
    // 后建"和"staging+原子 rename"两种实现在这个失败场景下唯一的可观测差异，必须显式断言它。
    check("🔒 关键判别性断言：重装失败后 node_modules/better-sqlite3 必须依然存在（不是被 rmSync 连锅端掉后又没装回来）", () => {
      assert.ok(
        existsSync(betterSqlite3Path),
        "如果这条断言失败，说明实现是「先 rmSync 旧快照再拷贝/npm install」——旧快照的 node_modules 已经被删除，" +
          "npm install 又失败了，用户的全局 hook 会指向一个连原生依赖都没有的残缺快照",
      );
    });

    check("installGlobalBrain: 重装失败后，不留 .staging/.old- 残留目录（清理干净，不留垃圾）", () => {
      const installDir = path.dirname(result1.snapshotDir);
      const entries = readdirSync(installDir);
      const leftovers = entries.filter((name) => name.includes(".staging") || name.includes(".old-"));
      assert.deepEqual(leftovers, [], `不该有残留目录，实际发现：${JSON.stringify(leftovers)}`);
    });

    // 第三次安装：这次真的成功（execImpl 恢复正常），确认失败一次之后系统仍然能正常重装，
    // 不会因为上一次失败就把自己卡死。
    const execImpl3 = makeFakeExecImpl();
    const result3 = installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl3 });
    check("installGlobalBrain: 失败一次之后，重新安装依然能成功（没有被上次失败卡死）", () => {
      assert.ok(existsSync(result3.snapshotDir));
      assert.ok(existsSync(path.join(result3.snapshotDir, "node_modules", "better-sqlite3")));
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // 变体：失败发生在拷贝阶段（源文件缺失），不是 npm install 阶段——同一条原子性保证应该
  // 同样适用（try/catch 包裹的是"拷贝 + npm install"整段，不是只包了 npm install 那一半）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-atomicreinstall-copyfail-"));
  try {
    const execImpl1 = makeFakeExecImpl();
    const result1 = installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl1 });
    const hookEntryPath = path.join(result1.snapshotDir, ".claude", "hooks", "brain-wake-greeting.mjs");
    const v1Content = readFileSync(hookEntryPath, "utf8");

    // 模拟"这次 aeloop checkout 缺了一个 COPY_ITEMS 里列出的源文件"——删掉 git-remote.mjs 的
    // fixture 源文件，触发 cpSync() 在拷贝阶段抛错。
    rmSync(path.join(repoRoot, ".claude", "hooks", "lib", "git-remote.mjs"), { force: true });

    const execImpl2 = makeFakeExecImpl();
    check("installGlobalBrain: 重装中途（拷贝阶段，源文件缺失）失败 → 整体抛错", () => {
      assert.throws(() => installGlobalBrain({ repoRoot, homeDir, execImpl: execImpl2 }));
    });

    check("installGlobalBrain: 拷贝阶段失败后，旧快照同样原封不动", () => {
      assert.ok(existsSync(result1.snapshotDir));
      assert.equal(readFileSync(hookEntryPath, "utf8"), v1Content);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── 🔒 Zorro must-fix（2026-07-23，第3轮）：settings.json 必须走 temp-file + 原子 rename，
//    不能是裸 writeFileSync() 就地覆写——这是全批次唯一真的写用户 ~/.claude/settings.json 的
//    地方，写入被打断（掉电/磁盘满/进程被杀）不能留下截断/损坏的文件，波及面是用户整个
//    Claude Code，不只是 brain 自己。 ──────────────────────────────────────────────────────

{
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-settingsatomic-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const preExistingContent = JSON.stringify({ statusLine: { type: "command", command: "~/statusline.sh" } }, null, 2);
    writeFileSync(settingsPath, preExistingContent);

    // 注入的 renameImpl：对"目标是 settings.json 本身"的那一次 rename 调用故意失败，其它
    // 调用（快照换入那几次）原样透传给真实 renameSync——只精确狙击 settings.json 这一步。
    const { renameSync: realRenameSync } = await import("node:fs");
    let settingsRenameCallCount = 0;
    const renameImpl = (src, dest) => {
      if (dest === settingsPath) {
        settingsRenameCallCount += 1;
        throw new Error("simulated rename failure at the settings.json swap-in step");
      }
      return realRenameSync(src, dest);
    };

    const execImpl = makeFakeExecImpl();

    check("installGlobalBrain: settings.json 换入失败（renameImpl 注入）→ 整体抛错", () => {
      assert.throws(
        () => installGlobalBrain({ repoRoot, homeDir, execImpl, renameImpl }),
        /simulated rename failure at the settings\.json swap-in step/,
      );
    });

    check("🔒 关键判别性断言：settings.json 换入失败时确实调用过 renameImpl（证明走的是 temp+rename，不是裸 writeFileSync 就地覆写）", () => {
      // 如果实现退化成 `writeFileSync(settingsPath, ...)` 直接覆写，这里注入的 renameImpl 永远
      // 不会被以 settingsPath 为 dest 调用——这条断言本身就是"确实在用 rename 换入"的直接证据，
      // 不是间接推断。
      assert.equal(settingsRenameCallCount, 1, "renameImpl 应该恰好被以 settingsPath 为目标调用一次");
    });

    check("🔒 must-fix（settings.json 原子写）：换入失败后，live settings.json 内容字节级不变（不是半写/截断状态）", () => {
      assert.equal(
        readFileSync(settingsPath, "utf8"),
        preExistingContent,
        "live 文件必须还是换入前的原始内容——temp+rename 失败时，rename 要么整体没发生要么目标不变，不存在中间态",
      );
    });

    check("installGlobalBrain: settings.json 换入失败后，不留 .tmp- 临时文件残留", () => {
      const entries = readdirSync(claudeDir);
      const leftoverTmp = entries.filter((name) => name.startsWith("settings.json.tmp-"));
      assert.deepEqual(leftoverTmp, [], `不该留下临时文件，实际发现：${JSON.stringify(leftoverTmp)}`);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // 正常成功路径下，同样验证不留 .tmp- 残留（rename 成功后临时文件名本身就"变成"了目标文件，
  // 不是额外产生一个需要清理的副本）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-settingsatomic-success-"));
  try {
    const execImpl = makeFakeExecImpl();
    const result = installGlobalBrain({ repoRoot, homeDir, execImpl });
    check("installGlobalBrain: 成功安装后，settings.json 目录里没有 .tmp- 残留文件", () => {
      const claudeDir = path.dirname(result.settingsPath);
      const entries = readdirSync(claudeDir);
      const leftoverTmp = entries.filter((name) => name.startsWith("settings.json.tmp-"));
      assert.deepEqual(leftoverTmp, []);
      assert.ok(existsSync(result.settingsPath), "settings.json 本身应该存在");
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── 🔒 Zorro must-fix（2026-07-23，第4轮）：settings.json 写入硬化——一次性覆盖 mode 保留 /
//    软链 write-through / 悬空软链 fail-closed / EXDEV 规避，不再一条条打地鼠。 ────────────

{
  // ① mode 保留：重装前 settings.json 是 0600，重装后必须仍是 0600（不能被 temp+rename 静默
  //    放宽成新建文件的默认 umask mode，如 0644——这是 Zorro 复现过的具体回归①）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-mode-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "x" } }, null, 2));
    chmodSync(settingsPath, 0o600);
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600, "前置条件：settings.json 应该已经是 0600");

    const execImpl = makeFakeExecImpl();
    installGlobalBrain({ repoRoot, homeDir, execImpl });

    check("🔒 must-fix（mode 保留）：重装后 settings.json 权限位必须仍是 0600，不能被静默放宽", () => {
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // ② 首装默认 mode：settings.json 原本不存在时，新文件的 mode 应该完全交给进程当前 umask
  //    决定——和"直接 writeFileSync 一个全新文件"产出的 mode 一致，不能被我们的代码额外
  //    chmod 成任何特定值（这条断言不硬编码具体 umask 数值，跨机器/跨 CI 环境可移植）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-firstinstall-mode-"));
  try {
    const execImpl = makeFakeExecImpl();
    const result = installGlobalBrain({ repoRoot, homeDir, execImpl });

    // 基线：同一进程、同一时刻，直接 writeFileSync 一个全新文件，产出的 mode 就是当前 umask
    // 决定的默认值——用它作对照，不猜测/硬编码具体数字。
    const baselinePath = path.join(homeDir, "baseline-new-file-for-mode-comparison.txt");
    writeFileSync(baselinePath, "x");
    const baselineMode = statSync(baselinePath).mode & 0o777;

    check("🔒 must-fix（首装默认 mode）：首装产出的 settings.json mode 和普通 writeFileSync 新文件一致（默认 umask，未被额外 chmod）", () => {
      assert.equal(statSync(result.settingsPath).mode & 0o777, baselineMode);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // ③ 软链 write-through：settings.json 是一个指向"dotfiles 仓库"里某个文件的软链——重装后
  //    ①软链本身必须还是软链（不能被换成普通文件，那会孤立 dotfiles 仓库那份真身）；
  //    ②软链指向的路径不变；③真身内容确实被更新成新的 merged settings；④真身原有 mode
  //    保留（软链场景下 mode 保留同样适用，不因为多了一层间接就被放过）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-symlink-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");

    const dotfilesDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-dotfiles-repo-"));
    const realSettingsPath = path.join(dotfilesDir, "claude-settings.json");
    writeFileSync(
      realSettingsPath,
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "bash dotfiles-hook.sh" }] }] } }, null, 2),
    );
    chmodSync(realSettingsPath, 0o600);
    symlinkSync(realSettingsPath, settingsPath);
    assert.ok(lstatSync(settingsPath).isSymbolicLink(), "前置条件：settingsPath 应该是软链");
    const originalRealContent = readFileSync(realSettingsPath, "utf8"); // 装之前的真身内容，
    // 用来验证 .bak 是这份"旧"内容的快照，不是装完之后的新内容。

    const execImpl = makeFakeExecImpl();
    installGlobalBrain({ repoRoot, homeDir, execImpl });

    check("🔒 must-fix（软链 write-through）：安装后 settingsPath 仍然是软链（没有被换成普通文件）", () => {
      assert.ok(lstatSync(settingsPath).isSymbolicLink(), "回归②：软链被 rename 换成普通文件，dotfiles 仓库那份真身会失联");
    });

    check("🔒 must-fix（软链 write-through）：软链仍然指向原来的真身路径", () => {
      assert.equal(readlinkSync(settingsPath), realSettingsPath);
    });

    check("🔒 must-fix（软链 write-through）：真身内容已经被更新成新的 merged settings（含新增的 hook 条目）", () => {
      const written = JSON.parse(readFileSync(realSettingsPath, "utf8"));
      assert.equal(written.hooks.SessionStart.length, 2, "应该保留 dotfiles 里原有的第三方 hook + 新增本工具一条");
      assert.deepEqual(written.hooks.SessionStart[0], {
        matcher: "",
        hooks: [{ type: "command", command: "bash dotfiles-hook.sh" }],
      });
    });

    check("🔒 must-fix（软链 write-through + mode 保留）：真身文件的 mode 仍然是 0600", () => {
      assert.equal(statSync(realSettingsPath).mode & 0o777, 0o600);
    });

    check("通过软链读取（跟随软链）也能看到更新后的内容——软链本身作为读取入口没有失效", () => {
      const viaSymlink = JSON.parse(readFileSync(settingsPath, "utf8"));
      assert.equal(viaSymlink.hooks.SessionStart.length, 2);
    });

    // 🔒 幻觉门 must-fix（2026-07-23 第5轮）：.bak 必须是"装之前"的真实内容快照——不是软链
    // （Node cpSync 默认 dereference:false 会把 .bak 也做成一个指向同一真身的软链，那样的话
    // 真身被 write-through 更新后，.bak 解析出来的就是新内容，不是回滚要用的旧内容，备份形同
    // 虚设），也不是装完之后的新内容。
    check("🔒 must-fix（.bak 快照，软链场景）：.bak 存在、不是软链、内容是装之前的旧内容（不是更新后的新内容）", () => {
      const entries = readdirSync(claudeDir);
      const backupName = entries.find((name) => name.startsWith("settings.json.bak-"));
      assert.ok(backupName, "应该生成一份 .bak 备份");
      const backupPath = path.join(claudeDir, backupName);
      assert.equal(lstatSync(backupPath).isSymbolicLink(), false, ".bak 必须是一份真实文件内容的快照，不能是又一个指向真身的软链");
      const backupContent = readFileSync(backupPath, "utf8");
      assert.equal(backupContent, originalRealContent, ".bak 的内容必须是装之前的旧内容——回滚时靠的就是这份快照");
      assert.notEqual(
        JSON.parse(backupContent).hooks?.SessionStart?.length,
        2,
        ".bak 不能是装完之后的新内容（新内容会有 2 条 SessionStart，旧内容只有 1 条）",
      );
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // ④ 悬空软链：settings.json 是软链，但指向的文件不存在——fail-closed 明确拒绝，不猜测意图
  //    创建一个新真身（PRD/Zorro 要求"评估 write-through 有硬阻碍时退而求其次 fail-closed"，
  //    悬空软链就是这种硬阻碍：不知道该用什么 mode/该不该真的在那创建文件）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-dangling-symlink-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");
    const nonExistentTarget = path.join(homeDir, "this-file-does-not-exist.json");
    symlinkSync(nonExistentTarget, settingsPath);

    const execImpl = makeFakeExecImpl();

    check("🔒 must-fix（悬空软链）：安装拒绝，明确报错（不是静默创建一个新文件替换软链）", () => {
      assert.throws(() => installGlobalBrain({ repoRoot, homeDir, execImpl }), /悬空软链|解析真实路径失败/);
    });

    check("悬空软链场景下，settingsPath 本身仍然是（悬空的）软链，没有被静默替换成普通文件", () => {
      assert.ok(lstatSync(settingsPath).isSymbolicLink());
    });

    // 🔒 Zorro finding 14（2026-07-23 第5轮）：这条校验现在挪到了 build/快照换入**之前**——
    // 悬空软链应该在真正做任何实质性改动之前就被拦下，不是等 build 完、快照都换完了才报错。
    check("🔒 must-fix（早验证，finding 14）：悬空软链拦下时，build 从未被调用过（execImpl 零调用）", () => {
      assert.equal(execImpl.calls.length, 0, "settings 目标校验应该在 build 之前就失败，build 不该被触发");
    });

    check("🔒 must-fix（早验证，finding 14）：悬空软链拦下时，不产生 snapshot/data 目录（没有任何材料性改动落地）", () => {
      const { snapshotDir, dataDir } = installPaths(homeDir);
      assert.equal(existsSync(snapshotDir), false);
      assert.equal(existsSync(dataDir), false);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

{
  // ⑤ EXDEV 规避：temp 文件必须和"有效写入目标"同一目录——用软链指向另一个目录（模拟软链
  //    指向别的挂载点/磁盘的场景），通过注入的 renameImpl 捕获实际的 rename 调用参数，断言
  //    src 和 dest 的 dirname 相同（这是避免跨设备 rename 失败的实际机制，不是间接推断）。
  const repoRoot = buildFakeRepoRoot();
  const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-exdev-"));
  try {
    const claudeDir = path.join(homeDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, "settings.json");

    const otherDir = mkdtempSync(path.join(tmpdir(), "brain-test-fakehome-exdev-otherdir-"));
    const realSettingsPath = path.join(otherDir, "real-settings.json");
    writeFileSync(realSettingsPath, JSON.stringify({}, null, 2));
    symlinkSync(realSettingsPath, settingsPath);

    const { renameSync: realRenameSync } = await import("node:fs");
    const capturedRenameCalls = [];
    const renameImpl = (src, dest) => {
      capturedRenameCalls.push({ src, dest });
      return realRenameSync(src, dest);
    };

    const execImpl = makeFakeExecImpl();
    installGlobalBrain({ repoRoot, homeDir, execImpl, renameImpl });

    check("🔒 must-fix（EXDEV 规避）：settings.json 的 temp+rename 调用里，src 和 dest 在同一目录", () => {
      // 按 basename 找（不按原始字符串路径找）——macOS 上 os.tmpdir() 的路径（/var/folders/...）
      // 和它的 realpath（/private/var/folders/...）字符串形式不同但指向同一个真实位置，
      // resolveSettingsWriteTarget() 内部用的是 realpathSync() 的结果，这里跟着用同一套
      // 规范化方式比较，不做字符串层面的假设。
      const settingsRenameCall = capturedRenameCalls.find(
        (c) => path.basename(c.dest) === path.basename(realSettingsPath),
      );
      assert.ok(settingsRenameCall, "应该有一次以真身文件名为 dest basename 的 rename 调用（软链 write-through）");
      assert.equal(
        path.dirname(settingsRenameCall.src),
        path.dirname(settingsRenameCall.dest),
        "temp 文件必须和最终目标同一目录，否则 rename 可能跨文件系统失败（EXDEV）",
      );
      // 双重确认：目标目录（规范化后）确实就是软链真身所在的 otherDir，不是别的什么目录碰巧
      // 也有同名文件。
      assert.equal(realpathSync(path.dirname(settingsRenameCall.dest)), realpathSync(otherDir));
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

console.log(`PASS: test-install-global-brain.mjs (${passCount} assertions groups, issue #93 B0)`);
