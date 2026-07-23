// db-path.mjs — 身份库 dbPath 解析 + fallback（issue #88 B9，plan.md §B9；issue #93 B1 新增全局模式，
// docs/conductor-brain-multiproject/PRD.md §3.2c/§4.2）。
//
// DESIGN.md §3.d 的机制化 fallback：`AELOOP_BRAIN_IDENTITY_DB` 环境变量优先；IDE/图形界面启动的
// 进程不继承 shell profile 的 export（macOS 本身的行为，不是 aeloop/Claude Code 的 bug），读不到
// env 时退化读项目根 `.claude/brain.local.json`（gitignore，每个 operator 自己机器上的本地配置）
// 的 `identityDbPath` 字段。供 `brain-wake-greeting.mjs`（#84 既有文件，本批唯一逻辑改动）和
// `scripts/seed-brain-identity.mjs`（B8）共用，不各写一份。
//
// issue #93 B1 新增：`AELOOP_BRAIN_GLOBAL_MODE=1` 时，跳过上面这条"项目本地 fallback"分支，直接
// 返回一个固定的全局默认路径（`~/.claude/aeloop-brain/data/identity.db`）——这是全局安装的
// wake-greeting hook（`scripts/install-global-brain.mjs`，B0）在 `~/.claude/settings.json` 里注册
// 命令时唯一会设置的环境变量，aeloop 自己项目内提交的 `.claude/settings.json`（dogfood 用法）
// **不设**它，两边共用同一份代码，靠这个环境变量走向两条完全独立、互不影响的路径。
//
// 物理保证（不是"读了但优先级更低"）：`AELOOP_BRAIN_GLOBAL_MODE === "1"` 命中时函数在该分支
// 直接 `return`，下面读 `<cwd>/.claude/brain.local.json` 的代码根本不会被执行——全局装的 hook
// 因此不可能读到任何被 onboard 的第三方项目自己的 `.claude/brain.local.json`（即便那个文件真的
// 存在），这是 docs/conductor-brain-multiproject/DESIGN.md §1.1 方案 B 否决理由的直接代码落点。

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 全局默认身份库路径——`scripts/install-global-brain.mjs`（B0）负责创建这个文件所在的目录、
 * `MemoryStore`/`better-sqlite3` 会在文件本身不存在时自动创建 db 文件，本模块不预先 touch 它。
 * 导出这个函数（而非导出一个在 import 时就固定死的常量）是因为 `os.homedir()` 在测试里需要
 * 被注入覆盖（见 `resolveIdentityDbPath` 的 `opts.homeDir`），一个 import 时就求值的常量做不到。
 * @param {string} [homeDir] 供测试注入；生产调用不传，缺省 `os.homedir()`。
 * @returns {string}
 */
export function globalDefaultDbPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".claude", "aeloop-brain", "data", "identity.db");
}

/**
 * @param {{cwd?: string, homeDir?: string}} [opts] 供测试注入；生产调用不传，缺省
 *   `process.cwd()`/`os.homedir()`。
 * @returns {string|null} 解析出的 dbPath；全局模式下必有值（见下）；非全局模式下两个配置源都
 *   没有 → null（不抛错，#84/#88 既有行为，字节级不变）。
 */
export function resolveIdentityDbPath(opts = {}) {
  const envValue = process.env.AELOOP_BRAIN_IDENTITY_DB;
  if (envValue) return envValue; // 优先——即便本地 json/全局模式也生效，env 永远最高优先级

  if (process.env.AELOOP_BRAIN_GLOBAL_MODE === "1") {
    // 全局模式：直接返回固定路径，函数到此为止——不读、不拼、不碰任何 `<cwd>/...` 路径，
    // 物理上不存在"全局装的 hook 读到目标项目本地配置"这条代码路径。
    return globalDefaultDbPath(opts.homeDir);
  }

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
