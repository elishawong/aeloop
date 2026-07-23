// test-generate-version.mjs — issue #98 单元测试：generate-version.mjs。
//
// 风格对齐 test-install-global-brain.mjs：node:assert/strict + check(label, fn) + passCount。
// 每个用例用 mkdtempSync 建一个临时 "fake repo root"（放最小 package.json），永远不碰真实
// 仓库自己的 src/shared/version-info.generated.ts。
//
// 覆盖 PRD §6：有 git 时版本正确、脏树带标记、git 不可用时 fail-soft 到 "unknown-sha"、
// 生成文件内容可被下游 import。
//
// 跑法：node scripts/test-generate-version.mjs（零外部依赖，不需要真的 git 仓库/网络）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeVersionInfo,
  formatVersionString,
  generateVersionFile,
  renderGeneratedModule,
  resolveGitDirty,
  resolveGitShortSha,
} from "./generate-version.mjs";

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

function buildFakeRepoRoot(pkgVersion = "1.2.3") {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "generate-version-test-"));
  writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "fake-repo", version: pkgVersion }));
  return repoRoot;
}

/** 假 execImpl — 记录调用，按脚本预设返回值，从不真的 spawn。 */
function makeFakeExecImpl(responses) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push({ cmd, args });
    const key = args.join(" ");
    if (key in responses) {
      const r = responses[key];
      if (r instanceof Error) throw r;
      return r;
    }
    throw new Error(`unexpected exec call: ${cmd} ${key}`);
  };
  impl.calls = calls;
  return impl;
}

// ── resolveGitShortSha / resolveGitDirty：纯函数，注入假 execImpl，不需要真实 git ──────────

check("resolveGitShortSha: 正常 git 输出 → 原样 trim 返回", () => {
  const exec = makeFakeExecImpl({ "rev-parse --short HEAD": "abc1234\n" });
  assert.equal(resolveGitShortSha("/fake", exec), "abc1234");
});

check("resolveGitShortSha: execImpl 抛错（非 git 目录 / git 不存在）→ fail-soft 到 unknown-sha，不抛错", () => {
  const exec = makeFakeExecImpl({ "rev-parse --short HEAD": new Error("fatal: not a git repository") });
  assert.doesNotThrow(() => {
    assert.equal(resolveGitShortSha("/fake", exec), "unknown-sha");
  });
});

check("resolveGitShortSha: 空输出（理论边界情况）→ 同样落到 unknown-sha，不返回空字符串", () => {
  const exec = makeFakeExecImpl({ "rev-parse --short HEAD": "  \n" });
  assert.equal(resolveGitShortSha("/fake", exec), "unknown-sha");
});

check("resolveGitDirty: status --porcelain 有输出 → true", () => {
  const exec = makeFakeExecImpl({ "status --porcelain": " M src/foo.ts\n" });
  assert.equal(resolveGitDirty("/fake", exec), true);
});

check("resolveGitDirty: status --porcelain 空输出（干净树）→ false", () => {
  const exec = makeFakeExecImpl({ "status --porcelain": "" });
  assert.equal(resolveGitDirty("/fake", exec), false);
});

check("resolveGitDirty: execImpl 抛错（git 不可用）→ fail-soft 到 false（尽力而为，不是确认干净）", () => {
  const exec = makeFakeExecImpl({ "status --porcelain": new Error("fatal: not a git repository") });
  assert.doesNotThrow(() => {
    assert.equal(resolveGitDirty("/fake", exec), false);
  });
});

check("resolveGitShortSha 和 resolveGitDirty 各自独立 try/catch：一个抛错不连累另一个拿到正确值", () => {
  const exec = makeFakeExecImpl({
    "rev-parse --short HEAD": new Error("boom"),
    "status --porcelain": " M src/foo.ts\n",
  });
  assert.equal(resolveGitShortSha("/fake", exec), "unknown-sha");
  assert.equal(resolveGitDirty("/fake", exec), true, "第一次调用失败不应该影响第二次调用的返回值");
});

// ── formatVersionString：issue #98 Zorro 独立复审 #2 新增的唯一格式化真源 ──────────────────

check("formatVersionString: 干净树（gitDirty:false）→ 不带 -dirty 后缀", () => {
  assert.equal(formatVersionString({ packageVersion: "1.2.3", gitSha: "abc1234", gitDirty: false }), "1.2.3+abc1234");
});

check("formatVersionString: 脏树（gitDirty:true）→ 带 -dirty 后缀", () => {
  assert.equal(formatVersionString({ packageVersion: "1.2.3", gitSha: "abc1234", gitDirty: true }), "1.2.3+abc1234-dirty");
});

check("formatVersionString: gitSha:unknown-sha 照常拼接，不特殊处理", () => {
  assert.equal(formatVersionString({ packageVersion: "0.0.1", gitSha: "unknown-sha", gitDirty: false }), "0.0.1+unknown-sha");
});

// ── computeVersionInfo：读 package.json + 拼装完整信息对象 ──────────────────────────────

check("computeVersionInfo: 组合 packageVersion + gitSha + gitDirty + versionString + generatedAt", () => {
  const repoRoot = buildFakeRepoRoot("9.9.9");
  try {
    const exec = makeFakeExecImpl({ "rev-parse --short HEAD": "deadbee\n", "status --porcelain": "" });
    const info = computeVersionInfo({ repoRoot, execImpl: exec });
    assert.equal(info.packageVersion, "9.9.9");
    assert.equal(info.gitSha, "deadbee");
    assert.equal(info.gitDirty, false);
    // issue #98 Zorro R2 独立复审订正（此前这条注释过实）：下面这条断言只能证明
    // info.versionString 和 formatVersionString() 独立算出的值**相等**——它证不出
    // computeVersionInfo() 内部是不是真的调用了 formatVersionString()，还是恰好自己拼出了同一个
    // 值，两种情况这条断言都会通过，区分不了。真正把"内部确实调用了 formatVersionString()，不是
    // 独立重新实现格式化规则"这件事钉死的，是 generate-version.mjs 里 computeVersionInfo() 那行
    // 生产代码本身（`versionString: formatVersionString({ packageVersion, gitSha, gitDirty })`）
    // ——这条断言的实际作用是回归防护"这个字段的值算对了"，不是给"调用关系"提供证据。
    assert.equal(info.versionString, formatVersionString({ packageVersion: info.packageVersion, gitSha: info.gitSha, gitDirty: info.gitDirty }));
    assert.equal(info.versionString, "9.9.9+deadbee");
    assert.equal(typeof info.generatedAt, "string");
    assert.doesNotThrow(() => new Date(info.generatedAt).toISOString());
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

check("computeVersionInfo: package.json 缺 version 字段 → 抛错（不是 fail-soft 场景，这是真实配置错误）", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "generate-version-test-"));
  try {
    writeFileSync(path.join(repoRoot, "package.json"), JSON.stringify({ name: "no-version" }));
    assert.throws(() => computeVersionInfo({ repoRoot, execImpl: makeFakeExecImpl({}) }), /version/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

check("computeVersionInfo: 真实无 git 环境（临时目录没有 .git，也没有注入假 execImpl，走真实 execFileSync）→ fail-soft 到 unknown-sha，不抛错", () => {
  const repoRoot = buildFakeRepoRoot("0.0.1");
  try {
    // 不传 execImpl —— 用真实的 node:child_process.execFileSync 去跑真实的 "git" 命令，
    // 但 repoRoot 本身不是一个 git 仓库（且往上找也不该意外走到本仓库自己的 .git —— tmpdir()
    // 在系统临时目录下，和这个仓库的 worktree 树不在同一层级，git 不会向上穿越到不相关的仓库）。
    assert.doesNotThrow(() => {
      const info = computeVersionInfo({ repoRoot });
      assert.equal(info.gitSha, "unknown-sha");
      assert.equal(info.gitDirty, false);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── renderGeneratedModule / generateVersionFile：文件内容 + 落盘 ────────────────────────

check("renderGeneratedModule: 生成的 .ts 内容含 GENERATED 头注释 + 可解析的 JSON 字面量（含 versionString 字段）", () => {
  const info = {
    packageVersion: "1.0.0",
    gitSha: "abc1234",
    gitDirty: true,
    versionString: "1.0.0+abc1234-dirty",
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  const rendered = renderGeneratedModule(info);
  assert.match(rendered, /^\/\/ GENERATED by scripts\/generate-version\.mjs/);
  assert.match(rendered, /export const GENERATED_VERSION_INFO: GeneratedVersionInfo = /);
  assert.ok(rendered.includes('"packageVersion": "1.0.0"'));
  assert.ok(rendered.includes('"gitSha": "abc1234"'));
  assert.ok(rendered.includes('"gitDirty": true'));
  assert.ok(rendered.includes('"versionString": "1.0.0+abc1234-dirty"'));
});

check("generateVersionFile: 落盘到 outFile，内容和 computeVersionInfo 一致", () => {
  const repoRoot = buildFakeRepoRoot("2.3.4");
  try {
    const exec = makeFakeExecImpl({ "rev-parse --short HEAD": "cafefee\n", "status --porcelain": "" });
    const outFile = path.join(repoRoot, "out", "version-info.generated.ts");
    const { outFile: returnedOutFile, info } = generateVersionFile({ repoRoot, outFile, execImpl: exec });
    assert.equal(returnedOutFile, outFile);
    const written = readFileSync(outFile, "utf8");
    assert.ok(written.includes('"packageVersion": "2.3.4"'));
    assert.ok(written.includes('"gitSha": "cafefee"'));
    assert.ok(written.includes('"versionString": "2.3.4+cafefee"'));
    assert.equal(info.packageVersion, "2.3.4");
    assert.equal(info.versionString, "2.3.4+cafefee");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

check("generateVersionFile: outFile 所在目录不存在时自动创建（mkdirSync recursive）", () => {
  const repoRoot = buildFakeRepoRoot("0.1.0");
  try {
    const exec = makeFakeExecImpl({ "rev-parse --short HEAD": "1111111\n", "status --porcelain": "" });
    const outFile = path.join(repoRoot, "nested", "dir", "version-info.generated.ts");
    generateVersionFile({ repoRoot, outFile, execImpl: exec });
    assert.doesNotThrow(() => readFileSync(outFile, "utf8"));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── 端到端：真实的、当前这份 aeloop 仓库自己的 generate-version.mjs 输出（不注入假 execImpl）──

check("端到端：真跑一次针对本仓库自身（DEFAULT_REPO_ROOT）的 computeVersionInfo，产出真实的 packageVersion + 真实 gitSha", () => {
  const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const info = computeVersionInfo({ repoRoot });
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(info.packageVersion, pkg.version);
  // 本仓库自己确实是一个真实 git 仓库（这份测试文件本身就在其中），gitSha 应该真的解析出来，
  // 不是 fail-soft 的 unknown-sha —— 和真实 `git rev-parse --short HEAD` 的输出比对。
  const realSha = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(info.gitSha, realSha);
});

console.log(`PASS: test-generate-version.mjs (${passCount} assertions groups, issue #98)`);
