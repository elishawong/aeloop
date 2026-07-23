// db-path.mjs — 身份库 dbPath 解析 + fallback（issue #88 B9，plan.md §B9）。
//
// DESIGN.md §3.d 的机制化 fallback：`AELOOP_BRAIN_IDENTITY_DB` 环境变量优先；IDE/图形界面启动的
// 进程不继承 shell profile 的 export（macOS 本身的行为，不是 aeloop/Claude Code 的 bug），读不到
// env 时退化读项目根 `.claude/brain.local.json`（gitignore，每个 operator 自己机器上的本地配置）
// 的 `identityDbPath` 字段。供 `brain-wake-greeting.mjs`（#84 既有文件，本批唯一逻辑改动）和
// `scripts/seed-brain-identity.mjs`（B8）共用，不各写一份。

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * @param {{cwd?: string}} [opts] 供测试注入；生产调用不传，缺省 process.cwd()。
 * @returns {string|null} 解析出的 dbPath；两个配置源都没有 → null（不抛错）。
 */
export function resolveIdentityDbPath(opts = {}) {
  const envValue = process.env.AELOOP_BRAIN_IDENTITY_DB;
  if (envValue) return envValue; // 优先——即便本地 json 也存在，env 优先（明确的优先级顺序）

  const cwd = opts.cwd ?? process.cwd();
  const localConfigPath = path.join(cwd, ".claude", "brain.local.json");
  try {
    const raw = readFileSync(localConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.identityDbPath === "string" && parsed.identityDbPath) {
      return parsed.identityDbPath;
    }
    return null; // 文件存在但字段缺失/类型不对 → 当没配置，不抛错
  } catch {
    return null; // 文件不存在 / 坏 JSON → 当没配置，不抛错（#84 既有的"安静跳过"哲学延续）
  }
}
