#!/usr/bin/env node
/**
 * brain-commit-gate.mjs — PreToolUse(Bash) deny hook：commit/push 审批门（issue #88 B3）。
 *
 * 逐条移植 ai-agent 仓库 `.claude/hooks/session-commit-gate.mjs:136-199` 的判定顺序（不改变
 * 顺序——fail-open 边界的正确性依赖判定顺序，不能重排，PRD §4.2 已声明）：
 *   1. kill-switch `AELOOP_BRAIN_SKIP_COMMIT_GATE=1` → allow。
 *   2. 读不到/解析不了 stdin → allow（fail-open）。
 *   3. `tool_name` 不是 Bash → allow。
 *   4. 命令不命中 gated 模式（`git commit`/`git push`/`gh pr merge`/`git merge...main`，
 *      issue #88 Pass 2 已在 `lib/command-match.mjs` 补齐完整模式集，对齐 PRD §4.2 声明）→ allow。
 *   5. 目标仓库判不出（非 git 目录）→ allow（fail-open）。
 *   6. 目标仓库和本 hook 自身所在仓库（aeloop）不一致 → allow（范围明确限于 aeloop 自身，同
 *      Helix 版本"不覆盖其它项目仓库"的既定范围）。
 *   7. 消费一次性授权令牌成功 → allow（令牌立即失效，下次需重新授权）；否则 → deny。
 *
 * 已知局限（如实标注，同源文件惯例——Zorro 2026-07-23 复审 finding-3：Pass 2 移植时漏了这条
 * 源文件本身已经记入风险清单的披露，本次补齐，语义与源文件一致，不夸大不缩小）：
 *   ① 只挡 Bash 里能被 token 化命令位置解析命中的命令，绕不过命令混淆（变量拼接/`eval`/`$()`
 *      子 shell）——是"养成习惯"的软门，不是滴水不漏的安全边界。`command-match.mjs` 头注释已
 *      详细论证为什么选 token 化 + 命令位置解析而不是正则堆叠。
 *   ② **只用 `cwd` 判定目标仓库，不解析命令文本里的 `-C <path>`/`--git-dir=` 参数**（精确对应
 *      源文件 `session-commit-gate.mjs:57-61` 的 finding-3，移植到 aeloop 时曾经漏披露，本次
 *      补齐）：
 *      - 若命令用 `-C` 把目标**重定向到别的仓库**、但 `cwd` 本身仍是 aeloop → 本 gate 会**过度
 *        拦截**（把一个实际目标是别处的命令也当 aeloop 场景要求授权）——方向偏保守/安全，不是
 *        绕过。
 *      - **反过来才是真正的绕过路径**：若 `cwd` 本身不是 aeloop（比如从别的项目 worktree 发起
 *        的会话），命令用 `cd /path/to/aeloop && git commit`、`git -C /path/to/aeloop commit`
 *        或 `gh -R owner/aeloop pr merge` 把目标重定向回 aeloop → 本 gate 因为 `cwd` toplevel
 *        判定不是 aeloop 而直接 allow，实际上绕开了门禁。**已知绕过路径，记入风险清单，不是
 *        本批要修的缺陷**——和 ai-agent 生产基线的 `session-commit-gate.mjs` 是同一条已接受的
 *        软门局限，本设计不追加任何超出源码基线的防护，也不应该被误读成"这批实现比源文件弱"。
 *
 * 输出（PreToolUse deny）：stdout 打 JSON
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function allow() {
  process.exit(0); // 放行 = 无输出、exit 0（不干预权限流程）。
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  try {
    // 1. kill-switch。
    if (process.env.AELOOP_BRAIN_SKIP_COMMIT_GATE === "1") allow();

    // 2. 读 stdin，读不到/解析不了 → allow（fail-open）。
    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      allow();
    }
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      allow();
    }

    // 3. 非 Bash → allow。
    if (input.tool_name !== "Bash") allow();
    const cmd = input?.tool_input?.command;
    if (typeof cmd !== "string" || !cmd) allow();

    // 4. 命令不命中 gated 模式 → allow。四种模式对齐 PRD §4.2（issue #88 Pass 2 补齐 gh-pr-merge/
    //    git-merge-main，见 lib/command-match.mjs 头注释）。
    const { matchesGitSubcommand, matchesGhPrMerge, matchesGitMergeMain } = await import("./lib/command-match.mjs");
    const isGated =
      matchesGitSubcommand(cmd, "commit") ||
      matchesGitSubcommand(cmd, "push") ||
      matchesGhPrMerge(cmd) ||
      matchesGitMergeMain(cmd);
    if (!isGated) allow();

    // 5/6. 目标仓库判定。
    const { getOriginOwnerRepo, resolveToplevel } = await import("./lib/git-remote.mjs");
    const cwd = input.cwd || process.cwd();
    const targetToplevel = resolveToplevel(cwd);
    if (!targetToplevel) allow(); // fail-open：非 git 目录判不出目标

    const selfOrigin = getOriginOwnerRepo(HERE);
    const targetOrigin = getOriginOwnerRepo(targetToplevel);
    if (!selfOrigin.ok || !targetOrigin.ok) allow(); // fail-open：任一方判不出 origin
    const sameRepo =
      selfOrigin.owner.toLowerCase() === targetOrigin.owner.toLowerCase() &&
      selfOrigin.repo.toLowerCase() === targetOrigin.repo.toLowerCase();
    if (!sameRepo) allow(); // 目标不是本仓库自身，范围明确不覆盖

    // 7. 消费一次性授权令牌。
    const { resolveSessionId, consumeCommitAuthorization } = await import("./lib/brain-lock.mjs");
    const sessionId = input.session_id || resolveSessionId();
    const result = consumeCommitAuthorization(targetToplevel, sessionId, { pid: process.pid });
    if (result.consumed) allow(); // 有效 → allow 并已立即消费（下一次需要重新授权）

    deny(
      "本次命令命中 commit/push/gh-pr-merge/merge-main 类模式，但本会话尚无有效的一次性授权令牌" +
        "（issue #88 turnkey 公司大脑包，commit/push 审批门）。须先得到 operator 在本轮对话里明确的" +
        '"可以"，再跑 `node .claude/hooks/lib/brain-lock.mjs authorize-commit` 获取一次性授权' +
        "（有效期内的第一次 commit/push/merge 会自动消费掉，第二次需要重新授权——一次性、不滚动）。" +
        "若确属误伤，临时设 AELOOP_BRAIN_SKIP_COMMIT_GATE=1 再跑。",
    );
  } catch {
    // fail-open：guard 自身任何异常都不阻断。
    allow();
  }
}

main();
