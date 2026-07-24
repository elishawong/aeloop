// task-source.mjs — 在途任务来源选择器（issue #103，docs/enterprise-board-toggle/DESIGN.md §3）。
//
// 供 `.claude/hooks/brain-wake-greeting.mjs`（渲染侧，决定要不要渲染"现在在途"/"Idea Queue"/
// 任务候选）和 `scripts/seed-brain-identity.mjs`（seed 侧，决定要不要调 gh）两处共用同一份判定，
// 不各写一份——同 `git-remote.mjs`/`project-registry.mjs` 已有的"hooks/lib 下的共享小文件，两个
// 目录各自 import"惯例。
//
// 值域只有两个：`"none"`（默认，shipped 零 GitHub）| `"github"`（唯一的真实 adapter，见
// `scripts/seed-brain-identity.mjs` 的 `defaultFetchOpenIssues()`/`resolveActiveTaskTags()`）。
// 命名刻意不叫"profile"——本仓库已经有一个含义完全不同的 `AI_AGENT_PROFILE`
// （`src/profile/loader.ts`，管 Layer2 引擎的模型/凭证来源），两个"profile"概念混在一起会造成
// 真实的认知事故（DESIGN §2）。也不做成完整的动态插件注册系统——今天只有 1 个真实来源，`(c)
// 选择器字符串 + 固定小接口` 是指挥官已确认的成比例设计（DESIGN §2 trade-off 表），加 adapter #2
// 时改这一个文件的值域 + 调用方的 if/switch 分支即可，不预定命名空间（YAGNI，指挥官 2026-07-24
// 已拍）。
//
// precedence 照抄 `db-path.mjs` 的既有先例（同一套心智模型，不发明新范式）：
//   ① env（`AELOOP_BRAIN_TASK_SOURCE`）最高优先级——终端启动可用，受 IDE 不继承 shell profile
//      export 的已知坑影响（`db-path.mjs` 头注释同一条坑）；全局装机时可以烘焙进 hookCommand
//      字符串（`scripts/install-global-brain.mjs` 的 `--task-source=github`），不受这个坑影响，
//      是全局模式下唯一真正健壮的持久化 opt-in 路径（DESIGN §8）。
//   ② 全局模式（`AELOOP_BRAIN_GLOBAL_MODE=1`）下，跳过 `<cwd>/.claude/brain.local.json`
//      fallback，直接落到默认值——同 `resolveIdentityDbPath()` 的既有理由：全局装的 hook 不该
//      读到"当前被触发所在的、可能完全无关的第三方项目"自己的本地配置。
//   ③ 非全局模式下，读 `<cwd>/.claude/brain.local.json` 的 `taskSource` 字段。
//   ④ 都没有 → 默认 `"none"`。
//
// 防幻觉/fail-closed（DESIGN §11 最后一行）：env 值不是 `"none"`/`"github"` 中任何一个（拼错/
// 历史遗留值）→ 兜底 `"none"`，不是 fail-open 到 `"github"`——一个拼错的 env 值不该意外打开一条
// 会调外部 CLI 的路径。`.claude/brain.local.json` 的 `taskSource` 字段同理：不合法值当没配置，
// 不抛错（同 `resolveIdentityDbPath()` "坏输入不抛错，当没配置"的既有哲学）。本模块是纯函数
// （不打印任何诊断），诊断信息的落点交给调用方（同 `db-path.mjs` 自己也不打印任何东西的既有风格）。

import { readFileSync } from "node:fs";
import path from "node:path";

/** 值域固定死——两个消费方都从这里导入，不允许各自发明变体（同 status-table.mjs 的 STATUS_EMOJI 先例）。 */
export const VALID_TASK_SOURCES = Object.freeze(["none", "github"]);

export const DEFAULT_TASK_SOURCE = "none";

/**
 * @param {unknown} value
 * @returns {value is "none" | "github"}
 */
function isValidTaskSource(value) {
  return typeof value === "string" && VALID_TASK_SOURCES.includes(value);
}

/**
 * @param {{ cwd?: string }} [opts] 供测试注入；生产调用不传，缺省 `process.cwd()`。
 * @returns {"none" | "github"}
 */
export function resolveTaskSource(opts = {}) {
  const envValue = process.env.AELOOP_BRAIN_TASK_SOURCE;
  if (envValue !== undefined) {
    // env 设了但不是合法值 → fail-closed 到默认值，不是 fail-open 到 "github"（见文件头注释）。
    return isValidTaskSource(envValue) ? envValue : DEFAULT_TASK_SOURCE;
  }

  if (process.env.AELOOP_BRAIN_GLOBAL_MODE === "1") return DEFAULT_TASK_SOURCE;
  // 全局模式：不读、不拼、不碰任何 `<cwd>/...` 路径——物理上不存在"全局装的 hook 读到目标项目
  // 本地配置"这条代码路径（同 db-path.mjs 全局分支的既有保证）。

  const cwd = opts.cwd ?? process.cwd();
  const localConfigPath = path.join(cwd, ".claude", "brain.local.json");
  try {
    const raw = readFileSync(localConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && isValidTaskSource(parsed.taskSource)) return parsed.taskSource;
    return DEFAULT_TASK_SOURCE; // 文件存在但字段缺失/类型不对/值非法 → 当没配置，不抛错
  } catch {
    return DEFAULT_TASK_SOURCE; // 文件不存在 / 坏 JSON → 当没配置，不抛错
  }
}
