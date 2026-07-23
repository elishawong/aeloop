#!/usr/bin/env node
/**
 * brain-issue-gate.mjs — PreToolUse(Edit|Write) deny hook：无 issue 不动手（issue #88 B4）。
 *
 * ⚠️ 判定链**第一条**（DESIGN.md §3.b/§7、operator 2026-07-23 已确认的开放决策，和 Helix 原版
 * `session-issue-gate.mjs` 最大的行为差异）：`process.env.AELOOP_BRAIN_ISSUE_GATE !== "enforce"`
 * → 恒 allow，不看任何其他条件（不检查工具类型、不检查 issue 绑定、不检查任何东西）。
 *   理由：aeloop 是单 operator 场景，operator 本人可信，没有 Helix 那种"防止某个角色（cypher/
 *   zorro）绕开流程"的多 agent 信任边界 rationale，逐次强制绑 issue 对日常/探索性小改动是纯
 *   摩擦。只有显式设置 `AELOOP_BRAIN_ISSUE_GATE=enforce`（治理演示模式，如 pitch 时展示"无
 *   issue 不动手"这条能力）才会真的检查。**能力做满（真 deny），但默认档位关闭**——
 *   `BRAIN.md`/`CLAUDE.md` 的铁律措辞已经写清楚这条边界，不能让文档读起来像默认就在拦。
 *
 * `enforce` 模式下的判定顺序（结构性移植 `session-issue-gate.mjs:76-153`，去掉 Helix 的
 * `HELIX_ROLE` 白名单——aeloop 没有角色框架，用上面的档位开关取代角色白名单，见 DESIGN §3.b/§6）：
 *   1. kill-switch `AELOOP_BRAIN_SKIP_ISSUE_GATE=1` → allow。
 *   2. 读不到/解析不了 stdin → allow（fail-open）。
 *   3. `tool_name` 不是 Edit/Write → allow。
 *   4. 目标不是 git 目录 → allow（fail-open）。
 *   5. `brain-lock.mjs` 的 `findOwnLock` 找到合法 issue 绑定 → allow；否则 → deny，提示
 *      `bind-issue` 命令。
 *
 * 已知局限（如实标注）：只挡 Edit/Write 工具，不挡 Bash 里 `cat >> file`/`sed -i` 之类绕过
 * 路径——这是一个"养成习惯"的软门，不是安全边界（同 Helix `session-issue-gate.mjs` 已知局限）。
 *
 * 输出（PreToolUse deny）：stdout 打 JSON
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

function allow() {
  process.exit(0);
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
    // ⚠️ 判定链第一条：默认档位（非 enforce）恒 allow，不看任何其他条件。
    if (process.env.AELOOP_BRAIN_ISSUE_GATE !== "enforce") allow();

    // 以下只在 enforce 模式下才会执行到。
    if (process.env.AELOOP_BRAIN_SKIP_ISSUE_GATE === "1") allow();

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

    if (input.tool_name !== "Edit" && input.tool_name !== "Write") allow();

    const { resolveToplevel } = await import("./lib/git-remote.mjs");
    const filePath = input?.tool_input?.file_path;
    const cwd = (filePath ? dirname(filePath) : null) || input.cwd || process.cwd();
    const toplevel = resolveToplevel(cwd);
    if (!toplevel) allow(); // fail-open：非 git 目录

    const { resolveSessionId, findOwnLock } = await import("./lib/brain-lock.mjs");
    const sessionId = input.session_id || resolveSessionId();
    const lock = findOwnLock(toplevel, { sessionId, pid: process.pid });
    if (lock?.issue) allow();

    deny(
      `AELOOP_BRAIN_ISSUE_GATE=enforce 模式下，写代码前须先绑 issue（issue #88 turnkey 公司大脑包）。` +
        "跑 `node .claude/hooks/lib/brain-lock.mjs bind-issue --issue=owner/repo#n` 绑定对应 issue。" +
        "若确属误伤，临时设 AELOOP_BRAIN_SKIP_ISSUE_GATE=1 再跑（或直接取消 enforce 档位）。",
    );
  } catch {
    // fail-open：guard 自身任何异常都不阻断。
    allow();
  }
}

main();
