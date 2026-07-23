// test-brain-red-line-guard.mjs — issue #88 B5（+ Zorro/Codex 2026-07-23 复审第一轮
// finding-1/3/4 + 第二轮 finding-1残留/2/3 修复回归）单元测试：brain-red-line-guard.mjs。
//
// 真实 spawn 这个 hook（同 demo-wake-greeting.mjs 技术），覆盖 PRD §6.2 全场景 + 符号链接逃逸
// 验证 + `--` 选项终止符回归（第一轮 finding-1）+ fail-open→fail-closed 回归（第一轮
// finding-3/4，只在"已命中 rm -rf 但目标 realpath 判不出安全"这一段收紧）+ 单独 `-` operand
// 回归（第二轮 finding-1 残留）+ 模块初始化绝不崩溃回归（第二轮 finding-2，最严重的一条）+
// 同命令连坐误伤回归（第二轮 finding-3）——这是本批"判据边界是命门"的核心测试，不是锦上添花。
//
// 跑法：node .claude/hooks/test-brain-red-line-guard.mjs（零依赖，需要 git CLI + 文件系统符号
// 链接支持）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "brain-red-line-guard.mjs");
const REPO_ROOT = join(HERE, "..", "..");

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
    stdout = err.stdout ?? "";
    status = err.status ?? -1;
  }
  return { stdout, status };
}

function parseDenyOrAllow(stdout) {
  if (!stdout || !stdout.trim()) return { decision: "allow" };
  const parsed = JSON.parse(stdout);
  return { decision: parsed?.hookSpecificOutput?.permissionDecision ?? "unknown", raw: parsed };
}

// 独立临时 git 仓库 + tmpdir 内的独立 scratch 目录，二者都自己清理，不碰真实仓库任何文件
// （test-hygiene，同 Pass 3 对 test-brain-isolation-guard.mjs 的既定修法）。
const TEST_REPO = mkdtempSync(join(tmpdir(), "brain-test-redline-repo-"));
execFileSync("git", ["init", "-q", TEST_REPO]);
const SCRATCH = mkdtempSync(join(tmpdir(), "brain-test-redline-scratch-"));

try {
  // ══ rm -rf 场景 ═══════════════════════════════════════════════════════════

  // ── ① tmpdir 内、真实存在的目标 → allow ──────────────────────────────────
  {
    const target = join(SCRATCH, "existing-dir");
    mkdirSync(target, { recursive: true });
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${target}` }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "tmpdir 内真实存在的目标应 allow");
  }

  // ── ② tmpdir 内、尚不存在的目标（幂等清理脚本常见写法）→ allow ─────────────
  {
    const target = join(SCRATCH, "does", "not", "exist", "yet");
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${target}` }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "tmpdir 内尚不存在的目标应 allow（逐级向上找存在的祖先）");
  }

  // ── ③ 仓库内路径（不在白名单）→ deny ────────────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf src" }, cwd: REPO_ROOT });
    const result = parseDenyOrAllow(out.stdout);
    assert.equal(result.decision, "deny", "rm -rf src（仓库内，非白名单）应 deny");
    assert.equal(result.raw.hookSpecificOutput.hookEventName, "PreToolUse");
  }

  // ── ④ 逃逸尝试：/tmp/../etc（字面量 .. 逃出白名单）→ deny ──────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf /tmp/../etc" }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "/tmp/../etc 逃逸尝试应 deny（path.resolve 词法归一化后不在白名单）");
  }

  // ── ⑤ 逃逸尝试：相对路径 ../../etc（从 tmpdir 内用 cwd 相对路径逃逸）→ deny ──
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf ../../../etc" }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "相对路径 ../../../etc 逃出 tmpdir 应 deny");
  }

  // ── ⑥ 【核心】符号链接逃逸：tmpdir 内的软链接指向 tmpdir 外的真实目录 → deny ──
  //     这是 Zorro 明确要求验证的场景——纯字符串前缀匹配会被这个绕过，本 hook 用
  //     realpathSync 解析符号链接后再判定，见 brain-red-line-guard.mjs 头注释整段论证。
  {
    const symlinkPath = join(SCRATCH, "escape-link");
    symlinkSync(REPO_ROOT, symlinkPath, "dir"); // 软链接指向仓库根（真实存在，但明确在 tmpdir 外）
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${symlinkPath}` }, cwd: SCRATCH });
    const result = parseDenyOrAllow(out.stdout);
    assert.equal(result.decision, "deny", "tmpdir 内指向 tmpdir 外的符号链接应被 realpath 解析后识别为逃逸，deny");
    unlinkSync(symlinkPath); // 只删链接本身（unlinkSync 不会跟随符号链接），不影响它指向的 REPO_ROOT
  }

  // ── ⑦ 反例：tmpdir 内的符号链接指向 tmpdir 内的另一处（合法，不该被误伤）→ allow ─
  {
    const realTarget = join(SCRATCH, "real-subdir");
    mkdirSync(realTarget, { recursive: true });
    const symlinkPath = join(SCRATCH, "internal-link");
    symlinkSync(realTarget, symlinkPath, "dir");
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${symlinkPath}` }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "tmpdir 内部的符号链接（指向 tmpdir 内）不该被误伤");
  }

  // ══ finding-1 回归：`--` 选项终止符（Zorro/Codex 2026-07-23 复审抓到的真 bug）══════════════

  // ── ⑧ rm -rf -- -victim（白名单外，文件名本身以 - 开头）→ deny ──────────────
  //     旧实现会把 "-victim" 也当 flag 跳过，extractRmTargets 返回空数组 → 没有目标可检查 →
  //     误放行；修复后 "--" 之后的 token 一律当目标，不再看是否以 "-" 开头。
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf -- -victim" }, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "rm -rf -- -victim（仓库内，白名单外）应 deny（finding-1 回归）");
  }

  // ── ⑨ rm -rf -- /tmp/ok（白名单内，"--" 之后的正常路径）→ allow ────────────
  {
    const target = join(SCRATCH, "dash-marker-ok");
    mkdirSync(target, { recursive: true });
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf -- ${target}` }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "rm -rf -- <白名单内路径> 应 allow（-- 后的合法路径不该被误伤）");
  }

  // ══ finding-3/4 回归：fail-open → fail-closed（Zorro/Codex 2026-07-23 复审，operator 拍板）══

  // ── ⑩【核心】命中 rm -rf，目标 realpath 抛 ELOOP（构造真实符号链接环路）→ deny ──
  //     这是本轮"判不出安全就必须 deny"新收紧的分支——旧版本 safeRealpath 统一 catch 成 null，
  //     会把这种"判不出到底指向哪"的情况和"合法地不存在"混为一谈，静默走 allow。
  {
    const linkA = join(SCRATCH, "loop-a");
    const linkB = join(SCRATCH, "loop-b");
    symlinkSync(linkB, linkA);
    symlinkSync(linkA, linkB); // linkA <-> linkB 互相指向，realpathSync 会抛 ELOOP
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${linkA}` }, cwd: SCRATCH });
    const result = parseDenyOrAllow(out.stdout);
    assert.equal(result.decision, "deny", "realpath 遇到 ELOOP（判不出安全）应 fail-closed deny，不是静默 allow");
    unlinkSync(linkA);
    unlinkSync(linkB);
  }

  // ── ⑪ 回归：目标真正"尚不存在"（ENOENT，不是 ELOOP/EACCES）时，walk-up 逻辑不受影响，
  //     仍然 allow——确认新的 fail-closed 没有连带误伤这条本来就该合法放行的路径 ──────
  {
    const target = join(SCRATCH, "genuinely", "does", "not", "exist");
    const out = runHook({ tool_name: "Bash", tool_input: { command: `rm -rf ${target}` }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "ENOENT（真的不存在）应仍 allow，fail-closed 不该扩大到这条");
  }

  // ══ 第二轮复验 finding-1 残留：单独的 "-" 是合法 rm 文件名 operand，不是 flag ═══════════

  {
    // cwd = REPO_ROOT，"-" 解析后目标是 ${REPO_ROOT}/-（仓库内一个字面量名叫 "-" 的文件），
    // 白名单外，预期 deny——如果 "-" 被误当 flag 漏判，会因为"没有目标可检查"而误 allow。
    const out = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf -" }, cwd: REPO_ROOT });
    assert.equal(
      parseDenyOrAllow(out.stdout).decision,
      "deny",
      'rm -rf - （仓库内，"-" 是合法文件名 operand 而非 flag）应 deny，不该被漏判成"没有目标"',
    );
  }

  // ══ 第二轮复验 finding-2【最严重，模块加载崩溃】：TMPDIR_REAL 初始化绝不能抛 ═══════════
  //
  // TMPDIR_REAL 在模块顶层同步执行（不在 main() 的 try/catch 里）。构造一个真实的符号链接环路、
  // 把 TMPDIR 环境变量指过去，验证 hook 进程本身不会 crash（exit 非预期值），而是安全降级继续
  // 正常工作——这是本轮修复前的真实 bug：整个 guard 进程直接挂掉，deny JSON 都吐不出来。

  {
    const loopA = join(SCRATCH, "tmpdir-loop-a");
    const loopB = join(SCRATCH, "tmpdir-loop-b");
    symlinkSync(loopB, loopA);
    symlinkSync(loopA, loopB); // loopA <-> loopB 互指，任何 realpathSync(loopA) 都会抛 ELOOP

    // ① 即便 TMPDIR 本身坏掉，处理一个完全无关的命令也不该崩溃——证明模块加载没有整体挂掉。
    const out1 = runHook({ tool_name: "Bash", tool_input: { command: "git status" } }, { TMPDIR: loopA });
    assert.equal(out1.status, 0, "TMPDIR 本身是符号链接环路时，guard 处理无关命令不该崩溃退出（finding-2 核心回归）");
    assert.equal(parseDenyOrAllow(out1.stdout).decision, "allow", "无关命令即便在坏 TMPDIR 下也应正常 allow");

    // ② 命中 rm -rf 的场景下，同样不该崩溃——TMPDIR_REAL 退化为词法路径后，白名单比对失败方向
    //    应该是"更保守"（deny），而不是进程直接死掉、连 deny JSON 都吐不出来。
    const out2 = runHook({ tool_name: "Bash", tool_input: { command: "rm -rf /some/random/path" } }, { TMPDIR: loopA });
    assert.equal(out2.status, 0, "坏 TMPDIR 下处理 rm -rf 命令也不该崩溃退出");
    assert.equal(
      parseDenyOrAllow(out2.stdout).decision,
      "deny",
      "坏 TMPDIR 退化成词法路径后，一个不相关的绝对路径目标应判定不在（退化的）白名单内，deny（过度拦截方向，安全）",
    );

    unlinkSync(loopA);
    unlinkSync(loopB);
  }

  // ══ 第二轮复验 finding-3：同一条复合命令里，普通 rm 不该被前面的 rm -rf "连坐" ═══════════
  //
  // 这是本轮最核心的误伤修复——之前的实现只要整条命令里*有任一* rm -rf，就会把该命令里*所有*
  // rm invocation（不管带不带 -rf）都拉进白名单检查，导致 `rm -rf <安全> && rm <仓库内文件>`
  // 被误 deny，即便那个普通 rm 单独跑根本不会被拦（判据自相矛盾）。

  {
    const safeTarget = join(SCRATCH, "safe-for-connation-test");
    mkdirSync(safeTarget, { recursive: true });
    // 第二个命令是普通 rm（无 -r/-f），目标是仓库内的一个不存在文件——如果被误连坐检查白名单，
    // 会因为不在 tmpdir 白名单内而被 deny；修复后它根本不该进入 rm-rf 的白名单检查这条路径。
    const cmd = `rm -rf ${safeTarget} && rm ./stale.log`;
    const out = runHook({ tool_name: "Bash", tool_input: { command: cmd }, cwd: REPO_ROOT });
    assert.equal(
      parseDenyOrAllow(out.stdout).decision,
      "allow",
      "rm -rf <白名单内> && rm <普通文件>（无 -rf）不该因为同命令连坐被误 deny（finding-3 回归）",
    );
  }

  // ── 反例：确认修复没有反向削弱判据——复合命令里两段都是真 rm -rf 时，白名单外那段仍应 deny ──
  {
    const safeTarget = join(SCRATCH, "safe-for-connation-test-2");
    mkdirSync(safeTarget, { recursive: true });
    const cmd = `rm -rf ${safeTarget} && rm -rf src`; // 第二段是真正的 rm -rf，目标在白名单外
    const out = runHook({ tool_name: "Bash", tool_input: { command: cmd }, cwd: REPO_ROOT });
    assert.equal(
      parseDenyOrAllow(out.stdout).decision,
      "deny",
      "两段都是真 rm -rf 时，白名单外那一段仍应独立被 deny——finding-3 的修复是精确到 invocation 粒度，不是把整个判据关掉",
    );
  }

  // ══ force-push 场景 ═══════════════════════════════════════════════════════

  // ── ⑧ git push --force → deny ───────────────────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git push --force" }, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "git push --force 应 deny");
  }

  // ── ⑨ git push --force-with-lease → allow ───────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "git push --force-with-lease" }, cwd: REPO_ROOT });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "git push --force-with-lease 应 allow（更安全的变体）");
  }

  // ══ .env 场景（Bash） ═════════════════════════════════════════════════════

  // ── ⑩ Bash 重定向写 .env → deny ─────────────────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: 'echo "SECRET=x" > .env' }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "echo > .env 应 deny");
  }

  // ── ⑪ Bash 重定向写 .env.example → allow ────────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: 'echo "KEY=val" > .env.example' }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "echo > .env.example 应 allow（示例文件）");
  }

  // ══ .env 场景（Edit/Write） ═══════════════════════════════════════════════

  // ── ⑫ Edit 工具目标 .env → deny ─────────────────────────────────────────
  {
    const out = runHook({ tool_name: "Edit", tool_input: { file_path: join(SCRATCH, ".env") } });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "deny", "Edit 工具目标 .env 应 deny");
  }

  // ── ⑬ Write 工具目标 .env.example → allow ───────────────────────────────
  {
    const out = runHook({ tool_name: "Write", tool_input: { file_path: join(SCRATCH, ".env.example") } });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "Write 工具目标 .env.example 应 allow");
  }

  // ══ fail-open 场景 ═══════════════════════════════════════════════════════

  // ── ⑭ 非 Bash/Edit/Write 工具 → allow ───────────────────────────────────
  {
    const out = runHook({ tool_name: "Read", tool_input: { file_path: join(SCRATCH, ".env") } });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "非 Bash/Edit/Write 工具应 allow（不在本 guard 管辖范围）");
  }

  // ── ⑮ 无关的 Bash 命令（不命中任何红线判据）→ allow ─────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "无关命令应 allow");
  }

  // ── ⑯ 无 command 字段 → allow（fail-open） ──────────────────────────────
  {
    const out = runHook({ tool_name: "Bash", tool_input: {}, cwd: SCRATCH });
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "缺 command 字段应 fail-open allow");
  }

  // ══ kill-switch ═══════════════════════════════════════════════════════════

  // ── ⑰ kill-switch → 恒 allow（即便命中红线判据） ────────────────────────
  {
    const out = runHook(
      { tool_name: "Bash", tool_input: { command: "rm -rf src" }, cwd: REPO_ROOT },
      { AELOOP_BRAIN_SKIP_REDLINE_GUARD: "1" },
    );
    assert.equal(parseDenyOrAllow(out.stdout).decision, "allow", "kill-switch 打开时应恒 allow");
  }

  console.log(
    "PASS: test-brain-red-line-guard.mjs (issue #88 B5 — 真实 spawn 验证 rm-rf 白名单/符号链接逃逸/force-push/.env 全场景)",
  );
} finally {
  rmSync(TEST_REPO, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
}
