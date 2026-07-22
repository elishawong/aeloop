#!/usr/bin/env node
// print-status-table.mjs — 按需查询 skill（../../.claude/skills/status-table/SKILL.md）的
// 确定性 CLI 入口。只往 stdout 打印 status-table.mjs 渲染出的那张表（或空表时的
// "当前没有在途任务。"）——不打印别的任何东西，模型可以把 stdout 原样当成回复内容用，
// 不需要自己从一堆日志里挑出真正的表格文本。
//
// 跑法：AELOOP_BRAIN_IDENTITY_DB=<身份库路径> node docs/conductor-brain-layer/spike/print-status-table.mjs
// 前置：pnpm run build（本文件经 lib/status-table.mjs → wake.mjs 间接依赖 dist/context/store.js）。
//
// 这是一个普通 CLI 脚本，不是 Claude Code hook——env 缺失/db 打不开时直接非零退出 + 一行
// stderr 说明，不用像 hook 那样"绝不阻断"（hook 的红线是"别搞坏用户的会话"，这里没有会话
// 要保护，失败就应该让调用方看见失败，而不是安静吞掉变成一张假的空表）。

import { openIdentityStore } from "./lib/wake.mjs";
import { collectStatusRows, renderStatusTable } from "./lib/status-table.mjs";

const dbPath = process.env.AELOOP_BRAIN_IDENTITY_DB;
if (!dbPath) {
  console.error("print-status-table.mjs: AELOOP_BRAIN_IDENTITY_DB 未设置，见 WAKE-GREETING-RUNBOOK.md。");
  process.exit(1);
}

let store;
try {
  store = openIdentityStore(dbPath);
  const rows = collectStatusRows(store);
  console.log(renderStatusTable(rows));
} catch (err) {
  console.error(
    `print-status-table.mjs: 读身份库失败（dbPath=${dbPath}）：${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
} finally {
  if (store) store.close();
}
