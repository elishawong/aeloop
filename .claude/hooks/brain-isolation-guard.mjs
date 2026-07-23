#!/usr/bin/env node
/**
 * brain-isolation-guard.mjs — SessionStart 告警 hook：worktree 隔离（issue #88 B6）。
 *
 * ⚠️ warn-only，不是 deny——正确移植 Helix `session-isolation-guard.mjs` 的实际语义（该文件自己
 * 头注释原话"v1 只告警不硬拦"）。DESIGN.md §1 已经纠正 issue #88 body 把"worktree 隔离"归进
 * "能硬机制化"一类的分类误判——Helix 自己这个机制本来就是 SessionStart additionalContext 警告
 * 注入，不是 PreToolUse deny，本文件如实延续这个定位，不夸大成硬拦。
 *
 * 做的事：
 *   1) 刷新本会话自己的心跳（`brain-lock.mjs` 的 `touchHeartbeat`）。
 *   2) 扫本 worktree 的 `.claude/brain-locks/*.json`，找出"新鲜"（心跳在阈值内）且不是自己
 *      这把的锁 → 拼一段警告文案，SessionStart additionalContext 注入。
 *   3) 始终 `process.exitCode = 0`，绝不阻断会话（同全仓 hook 惯例）。
 *
 * ⚠️ 诚实标注一个真实局限（`brain-lock.mjs` 的 `touchHeartbeat` 头注释已经写过，这里重申一次
 * 因为直接影响本 hook 的实际检测能力）：本包**没有**移植 Helix 的 `session-heartbeat.mjs`
 * （持续在 `UserPromptSubmit`/`Stop`/每次 `PreToolUse` 续期心跳），只有 SessionStart 那一刻会
 * touch 一次心跳。这意味着"新鲜"的判定窗口，实际上主要覆盖"两个会话几乎同时启动"这种情形，
 * 对"A 会话已经开了很久、B 会话现在才启动"这种更常见的隔离场景，检测能力比 Helix 版本弱
 * （A 的心跳早已过期，B 不会把它判成"活会话"）——这是本批次范围内的真实局限，不是 bug，需要
 * 补齐时应该新增一个持续心跳 hook，不在 Pass 2 范围内。
 *
 * 输出（SessionStart additionalContext，不是 deny）：stdout 打 JSON
 *   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}
 *   或者无任何检测结果时——不输出任何东西（同 #84 `brain-wake-greeting.mjs` 的"没有就安静"惯例，
 *   避免每次开会话都刷一段没有信息量的"一切正常"文案）。
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE)); // .claude/hooks -> .claude -> repo root

const STALE_MS = 5 * 60 * 1000; // "新鲜"阈值：5 分钟，同 plan.md §B6 建议量级

function emitAdditionalContext(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }),
  );
}

async function main() {
  try {
    if (process.env.AELOOP_BRAIN_SKIP_ISOLATION_GUARD === "1") return;

    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      /* 没有 stdin 也无所谓 */
    }
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      /* 解析不了也无所谓，用默认值继续 */
    }

    const { resolveToplevel } = await import("./lib/git-remote.mjs");
    const cwd = input.cwd || REPO_ROOT;
    const toplevel = resolveToplevel(cwd) || REPO_ROOT;

    const { resolveSessionId, touchHeartbeat, listAllLocks } = await import("./lib/brain-lock.mjs");
    const sessionId = input.session_id || resolveSessionId();
    const pid = process.pid;

    // 刷新自己这把锁的心跳（不阻断——异常吞掉，不影响下面的扫描）。
    try {
      touchHeartbeat(toplevel, sessionId, { pid });
    } catch {
      /* ignore */
    }

    const now = Date.now();
    const locks = listAllLocks(toplevel);
    const others = locks.filter((lock) => {
      const isSelf = sessionId != null && sessionId !== "" ? lock.sessionId === sessionId : lock.pid === pid;
      if (isSelf) return false;
      const t = Date.parse(lock?.heartbeatAt ?? "");
      if (Number.isNaN(t)) return false; // 没有/坏心跳 = 不可信 = 当僵尸，不告警
      return now - t <= STALE_MS; // "新鲜"才算活会话
    });

    if (others.length === 0) return; // 没有别的活会话 = 安静，不刷屏

    const warning =
      `【worktree 隔离提醒（issue #88 B6，只警告不硬拦）】检测到本 worktree（${toplevel}）内还有 ` +
      `${others.length} 个其它活会话（心跳在 ${STALE_MS / 1000}s 内）。多个会话共用同一个物理工作区 ` +
      `容易互相踩脚（checkout/clean/stash 互相冲突）——建议用 \`git worktree add\` 为并发工作建立` +
      `独立工作区。这只是提醒，不会阻止你继续操作。`;
    emitAdditionalContext(warning);
  } catch {
    /* 绝不阻断：任何失败都吞掉 */
  }
}

main()
  .catch(() => {})
  .finally(() => {
    process.exitCode = 0;
  });
