// test-command-match.mjs — issue #88 B1（+ Pass 2 补齐 gh-pr-merge/git-merge-main + Pass 3(B5)
// 补齐 matchesEnvWrite/isProtectedEnvBasename）单元测试：command-match.mjs。
//
// 覆盖 PRD §6.1 的正例/反例矩阵 + fail-closed overdepth 回归 + gh-pr-merge/git-merge-main 正反例
// + .env 重定向/tee 写入正反例。
//
// 跑法：node .claude/hooks/lib/test-command-match.mjs（零依赖，不需要 pnpm build）。

import assert from "node:assert/strict";
import {
  matchesGitSubcommand,
  matchesForcePush,
  matchesRmDashRf,
  matchesGhPrMerge,
  matchesGitMergeMain,
  matchesEnvWrite,
  isProtectedEnvBasename,
  tokenizeSegments,
  resolveInvocationsFromCommand,
  resolveCommandInvocations,
} from "./command-match.mjs";

// ── 正例：应判定为 gated ─────────────────────────────────────────────────────
assert.equal(matchesGitSubcommand("git commit -m x", "commit"), true, "git commit -m x 应命中 commit");
assert.equal(matchesGitSubcommand("/usr/bin/git commit", "commit"), true, "绝对路径 git 应命中 commit");
assert.equal(matchesGitSubcommand('sh -c "git commit -m x"', "commit"), true, 'sh -c "git commit" 应命中 commit');
assert.equal(matchesGitSubcommand("sudo git push", "push"), true, "sudo 透明包装器应命中 push");
assert.equal(matchesGitSubcommand('\\git commit', "commit"), true, "反斜杠绕 alias 写法应命中 commit");
assert.equal(matchesGitSubcommand("git add . \n git commit -m x", "commit"), true, "换行分隔两行提交，第二行应命中 commit");

// ── 反例：不应误判 ───────────────────────────────────────────────────────────
assert.equal(matchesGitSubcommand("echo git commit", "commit"), false, "echo 参数里的 git commit 不该命中（git 不是被执行的命令）");
assert.equal(matchesGitSubcommand("# git commit", "commit"), false, "整行注释不该命中");
assert.equal(matchesGitSubcommand("git log --grep commit -- main", "commit"), false, "git log 的 --grep 参数值不该被当成子命令 commit");
assert.equal(matchesGitSubcommand('git commit # trailing comment', "commit"), true, "行内注释不该影响前面真命令的判定");

// ── force-push ───────────────────────────────────────────────────────────
assert.equal(matchesForcePush("git push --force"), true, "--force 应命中");
assert.equal(matchesForcePush("git push -f origin main"), true, "-f 应命中");
assert.equal(matchesForcePush("git push --force-with-lease"), false, "--force-with-lease 视为安全变体，不命中");
assert.equal(matchesForcePush("git push"), false, "无 force flag 不命中");
assert.equal(matchesForcePush("git push --force-with-lease=refs/heads/main"), false, "带值的 --force-with-lease= 同样视为安全");

// ── rm -rf ───────────────────────────────────────────────────────────────
assert.equal(matchesRmDashRf("rm -rf /some/path"), true, "-rf 单 token 应命中");
assert.equal(matchesRmDashRf("rm -fr /some/path"), true, "-fr 单 token 应命中");
assert.equal(matchesRmDashRf("rm -r -f /some/path"), true, "分开的 -r -f 应命中");
assert.equal(matchesRmDashRf("rm --recursive --force /some/path"), true, "长选项组合应命中");
assert.equal(matchesRmDashRf("rm -r /some/path"), false, "只有 -r 不该命中");
assert.equal(matchesRmDashRf("rm -f /some/file"), false, "只有 -f 不该命中");
assert.equal(matchesRmDashRf("rm /some/file"), false, "无 flag 不该命中");

// ── gh pr merge（issue #88 Pass 2 补齐） ───────────────────────────────────
assert.equal(matchesGhPrMerge("gh pr merge 5"), true, "gh pr merge 5 应命中");
assert.equal(matchesGhPrMerge("gh pr --repo owner/repo merge 5"), true, "--repo 插在 pr 和 merge 之间应仍命中");
assert.equal(matchesGhPrMerge("gh pr create --title 'please merge later'"), false, "字面量 merge 出现在别处（flag 值）不该误判");
assert.equal(matchesGhPrMerge("gh issue list"), false, "非 pr 子命令不该命中");
assert.equal(matchesGhPrMerge("gh pr view 5"), false, "pr 的子命令不是 merge 不该命中");

// ── git merge ... main（issue #88 Pass 2 补齐） ────────────────────────────
assert.equal(matchesGitMergeMain("git merge origin/main"), true, "git merge origin/main 应命中（main 是 / 分隔的最后一段）");
assert.equal(matchesGitMergeMain("git merge refs/heads/main"), true, "git merge refs/heads/main 应命中");
assert.equal(matchesGitMergeMain("git merge feature-branch"), false, "合并非 main 分支不该命中");
assert.equal(matchesGitMergeMain("git log --grep merge -- main"), false, "只读 git log，merge 只是 --grep 搜索词，不该误判");
assert.equal(matchesGitMergeMain("git merge --no-ff main"), true, "merge 与 main 之间插 flag 应仍命中");

// ── isProtectedEnvBasename（issue #88 Pass 3 B5 补齐） ─────────────────────
assert.equal(isProtectedEnvBasename(".env"), true, ".env 本身应命中");
assert.equal(isProtectedEnvBasename(".env.production"), true, ".env.<后缀> 应命中");
assert.equal(isProtectedEnvBasename("foo/.env"), true, "带目录前缀应只看 basename");
assert.equal(isProtectedEnvBasename(".env.example"), false, ".env.example 应排除");
assert.equal(isProtectedEnvBasename(".env.sample"), false, ".env.sample 应排除");
assert.equal(isProtectedEnvBasename(".env.template"), false, ".env.template 应排除");
assert.equal(isProtectedEnvBasename("environment.ts"), false, "不是 .env 开头的普通文件不该命中");
assert.equal(isProtectedEnvBasename(""), false, "空字符串不该抛错、应判 false");

// ── matchesEnvWrite（issue #88 Pass 3 B5 补齐） ────────────────────────────
assert.equal(matchesEnvWrite('echo "SECRET=x" > .env'), true, "> .env（带空格）应命中");
assert.equal(matchesEnvWrite('echo "SECRET=x" >> .env'), true, ">> .env（追加）应命中");
assert.equal(matchesEnvWrite('echo "SECRET=x" >.env'), true, "> 和目标粘连、操作符前有空格应命中");
assert.equal(matchesEnvWrite("echo x | tee .env"), true, "管道到 tee .env 应命中（两个 invocation 各自解析）");
assert.equal(matchesEnvWrite("echo x | tee -a .env"), true, "tee -a .env（跳过 tee 自己的 flag）应命中");
assert.equal(matchesEnvWrite('echo "SECRET=x" > .env.example'), false, "> .env.example 应排除（示例文件）");
assert.equal(matchesEnvWrite("cat .env"), false, "纯读取（.env 只是位置参数，不在重定向目标位置）不该命中");
assert.equal(matchesEnvWrite("git status"), false, "无关命令不该命中");
assert.equal(matchesEnvWrite('echo "x" > other-file.txt'), false, "重定向到无关文件不该命中");

// ── overdepth fail-closed 回归（源文件设计：解析不到底 = 保守判命中,不是放行）───────
//
// 用 COMMAND_WRAPPERS（"sudo"）逐层嵌套而不是 `sh -c "<字符串>"` 嵌套——后者需要每层用不同的
// 引号字符包裹，本 tokenizer 不处理转义序列（同源文件已知局限），超过 2 层引号嵌套就会因为
// 复用同一种引号字符而提前闭合、无法正确构造测试输入。"sudo" 是纯 token 级递归（不经过
// 字符串重新分词），可以无限嵌套不受引号限制，同样能触发 `resolveCommandInvocations` 的
// `depth+1` 递归路径，测的是同一段深度检查逻辑。
{
  const deeplyWrapped = "sudo ".repeat(12) + "rm -rf /some/path"; // 12 层 > MAX_COMMAND_DEPTH(8)
  assert.equal(matchesRmDashRf(deeplyWrapped), true, "深度超限应 fail-closed 判命中，不是因解析不到底而放行");
  const deeplyWrappedGit = "sudo ".repeat(12) + "echo not-actually-git"; // 内容本身不含 git，但深度超限应仍判命中
  assert.equal(matchesGitSubcommand(deeplyWrappedGit, "commit"), true, "同上，matchesGitSubcommand 同样 fail-closed（即便内容本身不是 git commit）");

  // 直接单元测试 resolveCommandInvocations 自身的深度检查（不经过字符串分词，最贴近源头）。
  const { _internal } = await import("./command-match.mjs");
  const overdepthResult = resolveCommandInvocations(["true"], 9); // depth=9 > 8，函数入口即应短路
  assert.equal(overdepthResult.length, 1);
  assert.equal(overdepthResult[0].cmd, _internal.OVERDEPTH, "depth>8 时应直接返回 OVERDEPTH 哨兵，不再解析 tokens 内容");
}

// ── tokenizeSegments / resolveInvocationsFromCommand 基础健全性 ─────────────
assert.deepEqual(tokenizeSegments(""), [], "空字符串应返回空段数组");
{
  const invocations = resolveInvocationsFromCommand("git status && git commit -m x");
  assert.equal(invocations.length, 2, "&& 分隔的两条命令应各自解析出一个 invocation");
  assert.equal(invocations[0].cmd, "git");
  assert.equal(invocations[1].cmd, "git");
}

console.log("PASS: test-command-match.mjs (issue #88 B1 — 正例/反例矩阵 + force-push + rm-rf + overdepth fail-closed)");
