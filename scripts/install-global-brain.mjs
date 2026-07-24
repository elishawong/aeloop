#!/usr/bin/env node
/**
 * install-global-brain.mjs — 全局安装脚本（issue #93 B0，docs/conductor-brain-multiproject/PRD.md
 * §4.1/plan.md §B0）。
 *
 * ⚠️ 高风险文件（PRD §7 已标注）：这是本批次唯一会真的修改用户主目录文件（`~/.claude/settings.json`）
 * 的脚本——写错合并逻辑会波及用户机器上**所有**项目的 Claude Code 会话，不只是 aeloop/whoseorder。
 *
 * 🔒 安全硬约束（指挥官 2026-07-23 明确要求，违反 = 真伤用户机器）：
 *   - 本文件默认目标是真实 `os.homedir()`，但**每一处**都通过 `opts.homeDir`/CLI `--target=<dir>`
 *     可覆盖——自动化测试（`test-install-global-brain.mjs`）永远传一个临时目录，绝不触碰真实
 *     `~/.claude/`。生产调用（人工手跑，不进 CI）才会用真实 homedir。
 *   - `~/.claude/settings.json` 的合并逻辑（`mergeSettingsWithBrainHook`）是纯函数、可独立单测：
 *     只追加一条本工具自己的 SessionStart hook 条目，**绝不**删除/覆盖任何已有条目（含其它工具
 *     注册的 hooks，见 DESIGN §1.1 本机已验证真实存在第三方 hook 的实测证据）。写回前先备份一份
 *     `settings.json.bak-<timestamp>`。
 *   - 幂等：已存在完全相同 `command` 字符串的条目 → 跳过，不重复追加。
 *
 * 目录骨架保留（PRD §3.2b 的具体机制，不是"改写路径"）：拷贝时**保留源码相对目录深度**
 * （`docs/conductor-brain-layer/spike/lib/*.mjs` 相对 `dist/` 的层级关系原样保留在
 * `<installDir>/repo-snapshot/` 下），因此 `brain-wake-greeting.mjs`/`wake.mjs` 等文件内部的
 * `path.join(HERE, "..", "..", ...)` 相对路径逻辑在新位置**原样成立，零代码改动**。
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, "..");

/** 拷贝清单——保留相对路径骨架，逐条列出（不是整目录 `.claude/hooks/`——那会带上三个明确
 * 不全局化的写侧防护 hook，见 DESIGN §3/PRD §0 不做清单）。 */
export const COPY_ITEMS = [
  { src: "dist", type: "dir" },
  { src: path.join(".claude", "hooks", "brain-wake-greeting.mjs"), type: "file" },
  { src: path.join(".claude", "hooks", "lib", "db-path.mjs"), type: "file" },
  { src: path.join(".claude", "hooks", "lib", "git-remote.mjs"), type: "file" },
  // issue #103：brain-wake-greeting.mjs 动态 import 这个 lib 来解析 AELOOP_BRAIN_TASK_SOURCE——
  // 同 #96/#98 已经踩过两次的"新库没进 COPY_ITEMS = 全局模式下 MODULE_NOT_FOUND"这条坑，这里
  // 第三次点名防止再漏（docs/enterprise-board-toggle/DESIGN.md §3）。
  { src: path.join(".claude", "hooks", "lib", "task-source.mjs"), type: "file" },
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "wake.mjs"), type: "file" },
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "greeting-data.mjs"), type: "file" },
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "render-greeting.mjs"), type: "file" },
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "status-table.mjs"), type: "file" },
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "sanitize.mjs"), type: "file" },
  // issue #98：brain-wake-greeting.mjs 动态 import 这个 lib 来读版本行——不在这份清单里的话，
  // 装完之后会是 MODULE_NOT_FOUND（这一步本身有 try/catch 兜底不会阻断开场白，但版本行会永远
  // 缺失，等同于没做）。
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "version-info.mjs"), type: "file" },
  // issue #96（Zorro/Codex 跨模型二签 FAIL 后补齐）：brain-wake-greeting.mjs 状态 A/B（未配置/
  // 空库）动态 import 这个 lib 来产出首次引导正文——和上面 version-info.mjs 是同一类坑，但这次
  // 后果更重：version-info 缺失只丢一行诊断信息，不影响开场白其余部分；onboarding-greeting.mjs
  // 缺失会导致 import() 直接 MODULE_NOT_FOUND，被 main().catch() 吞掉，stdout 完全空——**正好
  // 变回 #96 本身要堵的"沉默=模型脑补假开场白"那个洞**，而且是在全局模式首次在新机器上跑（dbPath
  // 恒非 null，首次必然命中状态 B）这个 #96 最该生效的场景下失效。
  { src: path.join("docs", "conductor-brain-layer", "spike", "lib", "onboarding-greeting.mjs"), type: "file" },
  // issue #106：brain-wake-greeting.mjs 动态 import 这个 lib 来做三层共享守卫的 claim——同
  // #96/#98/#103 已经踩过三次的"新库没进 COPY_ITEMS = 全局模式下 MODULE_NOT_FOUND"这条坑，这里
  // 第四次点名防止再漏（DESIGN.md §附 第1点）。
  { src: path.join(".claude", "hooks", "lib", "wake-session-guard.mjs"), type: "file" },
];

/** @param {string} [homeDir] */
export function installPaths(homeDir = os.homedir()) {
  const installDir = path.join(homeDir, ".claude", "aeloop-brain");
  const snapshotDir = path.join(installDir, "repo-snapshot");
  const dataDir = path.join(installDir, "data");
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const hookEntryPath = path.join(snapshotDir, ".claude", "hooks", "brain-wake-greeting.mjs");
  // issue #106：全局 CLAUDE.md 的 wake-fallback 标记块落点（DESIGN.md §3.5）——和 settingsPath
  // 同级（`~/.claude/` 下的两个平级文件），不新建目录。
  const globalClaudeMdPath = path.join(homeDir, ".claude", "CLAUDE.md");
  return { installDir, snapshotDir, dataDir, settingsPath, hookEntryPath, globalClaudeMdPath };
}

/**
 * 严格的"这是一个可以安全展开/合并的 plain object"判断。JS 的陷阱：`typeof [] === "object"`
 * 也是 `true`——如果只用 `typeof x === "object"` 判断，一个数组会被当成"可以 `{...x}` 展开的
 * 对象"，`{...[1,2,3]}` 会把数组索引当 key 静默展开成 `{0:1,1:2,2:3}`，原始的数组语义/内容就
 * 这样被悄悄丢弃了——这正是 Zorro 2026-07-23 复审抓到的具体 bug 根源（`hooks` 字段是数组时）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * issue #103：`installGlobalBrain()`/`parseArgs()` 共用的 `taskSource` 校验——值域目前只有
 * `"github"`（省略/`undefined` 合法，代表不 opt-in）。
 *
 * 🔒 Zorro 复审 🟡 finding 后补齐（2026-07-24）：初版只有 CLI 的 `parseArgs()` 做了这条
 * fail-closed 校验，直接调 `installGlobalBrain({taskSource:"bogus"})`（编程调用，绕过 CLI）
 * 会静默降级成默认 `hookCommand`（不含 `AELOOP_BRAIN_TASK_SOURCE`），不报错——降级方向本身是
 * 安全的（`resolveTaskSource()` 对未知值同样 fail-closed 到 `"none"`），所以不是数据安全 blocker，
 * 但 API 和 CLI 两个入口的校验口径不一致，容易让人以为"JSDoc 类型就是运行时防线"。抽成一个
 * 共享函数，两处都调用，口径统一。
 * @param {unknown} value
 * @returns {asserts value is undefined | "github"}
 */
function assertValidTaskSourceOpt(value) {
  if (value !== undefined && value !== "github") {
    throw new Error(`taskSource 只接受 "github" 或省略（代表不 opt-in），收到不认识的值："${value}"`);
  }
}

/**
 * issue #103 ④：识别"这条 SessionStart hook 是不是本工具装的"的标记子串——真实生成的
 * `hookCommand` 恒含 `installPaths().hookEntryPath`（`<homeDir>/.claude/aeloop-brain/repo-
 * snapshot/...`）。和 issue #105（uninstall-global-brain，按 command 含这同一个子串匹配摘除）
 * 共用同一个值，两边判据对称——这里导出常量而不是让 #105 各自写一份字面量，保证漂移不了。
 *
 * 🔒 Zorro 复审 FAIL 后订正（2026-07-24，独立 Codex `gpt-5.6-sol` 交叉核实过的 blocker）：
 * 初版这里用裸 `"aeloop-brain"`（不带路径分隔符）——Zorro 真实复现了这个判据的误伤面：一个和
 * 本工具完全无关的第三方 hook，只要 command 字符串里**恰好**出现这几个字符（哪怕只是一个不相关
 * 程序的路径片段，比如 `/opt/vendor/aeloop-brain-observer/hook.mjs`），就会被
 * `mergeSettingsWithBrainHook()` 误判成"这是我们自己装的旧条目"，原地**覆盖掉**那条第三方 hook
 * 的 command——这是本次 #103 改动新引入的回归（基线用的是 `command === hookCommand` 精确全串
 * 匹配，物理上不可能误伤），爆炸半径是静默改写用户真实 `~/.claude/settings.json` 里别人的条目，
 * 判定为数据丢失级 blocker。改用一段带路径分隔符、只有真实由 `installPaths()` 生成的
 * `hookEntryPath` 才会天然包含的高特异性片段（`/.claude/aeloop-brain/repo-snapshot/`）——一个
 * 巧合含"aeloop-brain"六个字母的无关 command 极不可能同时恰好带上这整段路径结构，把碰撞面从
 * "任何含这几个字的命令"收窄到"确实装在 `~/.claude/aeloop-brain/repo-snapshot/` 下的本工具
 * 条目"。#105 落地 uninstall 时必须复用这个常量，不能各写一份裸子串。
 */
export const AELOOP_BRAIN_MARKER = "/.claude/aeloop-brain/repo-snapshot/";

/**
 * `SessionStart` 分支——`{matcher, hooks:[{type,command}]}` 结构，本工具的条目在其中某个 entry
 * 的 `.hooks` 数组里。抽成独立函数（issue #106），供 `mergeSettingsWithBrainHook()` 和
 * `hooks.UserPromptSubmit` 那条平行分支（`mergeUserPromptSubmitEntries()`，下方）各自独立处理
 * ——两种事件的 settings.json 结构本身不同（有无 `matcher` 包装），不能共用同一段合并逻辑。
 * @param {object} hooks 已经浅拷贝过的 `settings.hooks`
 * @param {string} hookCommand
 * @returns {{sessionStart: object[], changed: boolean}}
 */
function mergeSessionStartEntries(hooks, hookCommand) {
  if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
    throw new Error(
      `既有 settings.json 的 "hooks.SessionStart" 字段不是一个数组（实际是"${typeof hooks.SessionStart}"）` +
        "——拒绝继续，不盲目归一化/覆盖（fail-closed）。原文件未被触碰，请人工检查后再重试。",
    );
  }
  const sessionStart = hooks.SessionStart ? [...hooks.SessionStart] : [];

  // issue #103 ④（指挥官已确认）：幂等判据从"command 字符串完全相同"改成"command 含
  // AELOOP_BRAIN_MARKER 子串"——`--task-source=github` 这个新 CLI flag 会让重装时生成的
  // `hookCommand` 字符串本身发生变化（多/少 `AELOOP_BRAIN_TASK_SOURCE=github` 这一段），如果
  // 还按"完全相同才算重复"判断，重装换 flag 会被误判成"没装过"，在 settings.json 里追加第二条
  // aeloop 的 SessionStart 条目，两条都跑，行为不可预测。改成按标记子串识别"这是本工具管理的
  // 那一条"，找到就原地替换 command（不管新旧 command 字符串具体差在哪），找不到才追加——和
  // issue #105（uninstall-global-brain，按 command 含 "aeloop-brain" 匹配摘除）用同一个标记
  // 子串，两边判据对称，不是本文件独有的一套逻辑。
  //
  // 命中口径：遍历每个 SessionStart 条目自己的 hooks 数组，找 command 含标记的那一个具体 hook
  // 对象（不是整个 entry）——定位到具体 hook 再替换，不误伤同一个 entry 里理论上可能混有的别的
  // 工具的 hook（虽然本文件自己写的 entry 目前只会有单个 hook，但判据本身不依赖这个假设）。
  // 只处理第一条命中的：多条命中是一个已知的、本次修复要防止"以后再发生"的异常态（这条修复上线
  // 前如果一台机器已经因为老逻辑攒出了两条重复条目，这里不会自动去重合并成一条，只保证从此以后
  // 不再新增——自动合并已存在的重复条目不在本次改动范围内，如实标注，不是没考虑到）。
  let matchedEntryIndex = -1;
  let matchedHookIndex = -1;
  for (let i = 0; i < sessionStart.length; i++) {
    const entry = sessionStart[i];
    if (!Array.isArray(entry?.hooks)) continue;
    const hookIdx = entry.hooks.findIndex((h) => typeof h?.command === "string" && h.command.includes(AELOOP_BRAIN_MARKER));
    if (hookIdx !== -1) {
      matchedEntryIndex = i;
      matchedHookIndex = hookIdx;
      break;
    }
  }

  if (matchedEntryIndex === -1) {
    // 首装：原样保留既有条目，新增一条。
    const newEntry = {
      matcher: "startup|resume|clear",
      hooks: [{ type: "command", command: hookCommand }],
    };
    return { sessionStart: [...sessionStart, newEntry], changed: true };
  }

  // 找到已有的本工具条目——command 字符串完全相同 → 真幂等 no-op；不同（哪怕只是 flag 差异）
  // → 原地替换这一个 hook 对象的 command，不新增 entry、不动同一 entry 里其它 hook 对象、
  // 不动其它 entry。
  const matchedEntry = sessionStart[matchedEntryIndex];
  const matchedHook = matchedEntry.hooks[matchedHookIndex];
  if (matchedHook.command === hookCommand) {
    return { sessionStart, changed: false };
  }

  const updatedHooks = [...matchedEntry.hooks];
  updatedHooks[matchedHookIndex] = { ...matchedHook, command: hookCommand };
  const updatedEntry = { ...matchedEntry, hooks: updatedHooks };
  const updatedSessionStart = [...sessionStart];
  updatedSessionStart[matchedEntryIndex] = updatedEntry;

  return { sessionStart: updatedSessionStart, changed: true };
}

/**
 * `UserPromptSubmit` 分支（issue #106，DESIGN §1.2/附录第3点）——**扁平数组，元素直接是
 * `{type, command}` hook 对象，没有 `SessionStart` 那种 `{matcher, hooks:[...]}` 包装层**
 * （官方文档确认 `UserPromptSubmit` 不支持 `matcher`）。判据/幂等/替换逻辑和
 * `mergeSessionStartEntries()` 同构（同一个 `AELOOP_BRAIN_MARKER` 子串识别"是不是本工具装的"），
 * 但因为少一层 `.hooks` 嵌套，不能直接复用那个函数，独立实现一份。
 * @param {object} hooks 已经浅拷贝过的 `settings.hooks`
 * @param {string} hookCommand
 * @returns {{userPromptSubmit: object[], changed: boolean}}
 */
function mergeUserPromptSubmitEntries(hooks, hookCommand) {
  if (hooks.UserPromptSubmit !== undefined && !Array.isArray(hooks.UserPromptSubmit)) {
    throw new Error(
      `既有 settings.json 的 "hooks.UserPromptSubmit" 字段不是一个数组（实际是"${typeof hooks.UserPromptSubmit}"）` +
        "——拒绝继续，不盲目归一化/覆盖（fail-closed）。原文件未被触碰，请人工检查后再重试。",
    );
  }
  const userPromptSubmit = hooks.UserPromptSubmit ? [...hooks.UserPromptSubmit] : [];

  let matchedIndex = -1;
  for (let i = 0; i < userPromptSubmit.length; i++) {
    const h = userPromptSubmit[i];
    if (typeof h?.command === "string" && h.command.includes(AELOOP_BRAIN_MARKER)) {
      matchedIndex = i;
      break;
    }
  }

  if (matchedIndex === -1) {
    const newHook = { type: "command", command: hookCommand };
    return { userPromptSubmit: [...userPromptSubmit, newHook], changed: true };
  }

  const matchedHook = userPromptSubmit[matchedIndex];
  if (matchedHook.command === hookCommand) {
    return { userPromptSubmit, changed: false };
  }

  const updated = [...userPromptSubmit];
  updated[matchedIndex] = { ...matchedHook, command: hookCommand };
  return { userPromptSubmit: updated, changed: true };
}

/**
 * 纯函数——给定既有 `settings.json` 内容（已 parse 的对象，或 `null`/`undefined` 表示文件不存在）
 * 和本工具要注册的 hook 命令字符串，返回合并后的新对象 + 是否发生了改动。绝不修改入参对象本身
 * （每一层都浅拷贝），供单测直接对"原有条目是否逐字节保留"做 deep-equal 断言。
 *
 * issue #106：同时管理 `hooks.SessionStart`（CLI 环境）和 `hooks.UserPromptSubmit`（IDE/未知
 * host 环境）两个事件——两者用**同一个** `hookCommand`（同一个脚本文件，内部按 stdin 的
 * `hook_event_name` 分派，见 `docs/wake-trigger-portability/DESIGN.md` §3.3/附录第2点），委托
 * 给 `mergeSessionStartEntries()`/`mergeUserPromptSubmitEntries()` 两个独立函数各自处理（结构
 * 不同，不能共用逻辑），`changed` 是两者的逻辑或——任一个需要写入，整体就报告 `changed:true`。
 *
 * 🔒 Zorro must-fix（2026-07-23）：对"语法合法但结构不认识"的畸形 JSON，本函数**fail-closed
 * 抛错**，不静默归一化/丢内容——此前的实现对三个层级都有同一类缺陷：`existingSettings`/
 * `settings.hooks` 是数组（而不是 plain object）时，`typeof x === "object"` 判断为真，
 * `{...x}` 会把数组内容静默展开/丢弃（见上面 `isPlainObject()` 的注释）；`hooks.SessionStart`/
 * `hooks.UserPromptSubmit` 存在但不是数组（比如是个对象/字符串）时，`Array.isArray(...) ?
 * [...x] : []` 会静默把它替换成空数组，原始值直接丢失。这是往用户**真实**
 * `~/.claude/settings.json` 写文件的工具（B0 是本批次唯一会真的修改用户主目录文件的批次），
 * "看不懂的结构就拒绝"必须和"JSON 语法本身就是坏的"走同一条 fail-closed 路径——本函数抛出的
 * 错误会在 `installGlobalBrain()` 里于任何实际写入（包括 build/拷贝快照/`npm install`）发生
 * **之前**就中止整个安装，原文件不会被触碰，不需要额外的 `.bak`（因为压根没写）。
 * @param {object|null|undefined} existingSettings
 * @param {string} hookCommand
 * @returns {{settings: object, changed: boolean}}
 */
export function mergeSettingsWithBrainHook(existingSettings, hookCommand) {
  if (existingSettings != null && !isPlainObject(existingSettings)) {
    throw new Error(
      `既有 settings.json 顶层不是一个对象（实际是${Array.isArray(existingSettings) ? "数组" : `"${typeof existingSettings}"`}）` +
        "——拒绝继续，不盲目归一化/覆盖（fail-closed）。这可能是格式已经损坏，或是本工具不认识的新结构；" +
        "原文件未被触碰，请人工检查后再重试。",
    );
  }
  const settings = existingSettings ? { ...existingSettings } : {};

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    throw new Error(
      `既有 settings.json 的 "hooks" 字段不是一个对象（实际是${Array.isArray(settings.hooks) ? "数组" : `"${typeof settings.hooks}"`}）` +
        "——拒绝继续，不盲目归一化/覆盖（fail-closed）。原文件未被触碰，请人工检查后再重试。",
    );
  }
  const hooks = settings.hooks ? { ...settings.hooks } : {};

  const sessionStartResult = mergeSessionStartEntries(hooks, hookCommand);
  const userPromptSubmitResult = mergeUserPromptSubmitEntries(hooks, hookCommand);
  const changed = sessionStartResult.changed || userPromptSubmitResult.changed;

  return {
    settings: {
      ...settings,
      hooks: { ...hooks, SessionStart: sessionStartResult.sessionStart, UserPromptSubmit: userPromptSubmitResult.userPromptSubmit },
    },
    changed,
  };
}

// ── issue #106：全局 ~/.claude/CLAUDE.md 的 wake-fallback 标记块（DESIGN.md §3.4/§3.5） ──────
//
// Layer3（模型自己跑 `--standalone` 的自救兜底网）的指令文本落点是全局 `~/.claude/CLAUDE.md`，
// 不是 aeloop 项目自己的 `/CLAUDE.md`——理由（指挥官 2026-07-24 确认）：项目级文件每接入一个
// 新项目都要重新配一遍，"兜底网"的名字就名不副实了；#93 全局安装的卖点就是"装一次，全项目
// 生效"，Layer3 必须和 Layer1/Layer2（本来就是全局 settings.json 里注册的 hook，天然跨项目）
// 享有同等待遇。

/**
 * 标记块起止行——和 `AELOOP_BRAIN_MARKER`（settings.json 场景）同一个定位：一段高特异性、正常
 * 用户手写文档几乎不可能巧合撞上的标记，用来在任意既有 `CLAUDE.md` 文本里可靠定位"这是不是本
 * 工具管理的那一块"。#105（uninstall-global-brain，当前 OPEN 未实现）落地对称摘除时必须复用
 * 这两个常量，不能各写一份字面量（同 `AELOOP_BRAIN_MARKER` 头注释里对 #105 的既有要求）。
 */
export const WAKE_FALLBACK_MARKER_START = "<!-- aeloop-brain:wake-fallback -->";
export const WAKE_FALLBACK_MARKER_END = "<!-- /aeloop-brain:wake-fallback -->";

/**
 * 生成要塞进标记块里的正文——DESIGN.md §3.4 草案文案，用真实 `hookEntryPath` 替换其中的固定
 * 路径。纯函数，不读写任何文件。
 * @param {string} hookEntryPath 真实的 `installPaths().hookEntryPath`（全局安装路径）
 * @returns {string}
 */
export function buildWakeFallbackBlockBody(hookEntryPath) {
  return (
    "## 醒来（issue #106 全局兜底网，由 install-global-brain.mjs 管理，请勿手动编辑本标记块）\n\n" +
    "每次会话启动，`brain-wake-greeting.mjs` 会尝试通过 `SessionStart`（CLI 环境）或 " +
    "`UserPromptSubmit`（IDE/未知 host 环境）hook 注入一份延续式开场白——这是硬机制，两条路径" +
    "至少一条会在已验证的 host 上生效，你对“要不要执行”没有选择权。**只有在你对用户的第一条" +
    "实质性回复之前，确认自己完全没有看到过任何以 `[brain-wake-greeting]` 开头的注入内容时**" +
    "（说明这个 host 上两条硬机制都没有 fire——已知的未验证场景），才需要自己主动跑一次：\n\n" +
    `\`node "${hookEntryPath}" --standalone\`\n\n` +
    "并按它的输出行事——这条自救路径只检查一次（对话的第一条实质回复之前），不是每条回复都重新" +
    "检查。如果输出说“本会话已经醒来过”，说明其实某条硬机制已经生效过，正常处理用户的请求即可，" +
    "不要再重复一遍开场白。这段自救指令不会主动告诉用户“这是软路径兜底”——默默做，不额外提示。"
  );
}

/** 统计 `needle` 在 `haystack` 里出现的次数（不重叠计数）——`mergeClaudeMdWithWakeFallback()`
 * 的 B3 修复要用它精确判断"起止标记是不是各恰好一个"，不能只用 `indexOf() !== -1` 判断"存在"
 * （那样量测不出"存在几个"，见下方函数头注释）。 */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 纯函数——给定既有 `~/.claude/CLAUDE.md` 内容（字符串，或 `null`/`undefined` 表示文件不存在）
 * 和本工具要写入的标记块正文，返回合并后的新内容 + 是否发生了改动。**红线（指挥官原话）**：
 * 用户自己的 `CLAUDE.md` 内容神圣不可动——本工具只能追加/原地更新自己那一小块，绝不整文件
 * 覆盖、绝不触碰用户自己写的任何一行（DESIGN.md §3.5）。
 *
 * 语义（DESIGN.md §3.5 已完整论证；🔒 **Zorro R1 blocker B3 订正，2026-07-24，独立 Codex 复现
 * 坐实**：初版判定只用 `indexOf()` 各取"第一个"标记的位置，**没有校验标记数量**——如果既有内容
 * 里恰好出现两个起始标记 + 一个结束标记（比如用户不小心手动复制粘贴过一次，或安装脚本以外的
 * 方式追加过），`indexOf()` 会静默取到第一个起始标记和唯一的结束标记，把两个起始标记**之间的
 * 用户内容当成"标记块内部"整个删掉替换掉**——这正是本函数存在的理由（"用户内容神圣不可动"）
 * 被自己的实现破坏,且原本的规则 3（只对"缺一半"fail-closed）没有覆盖"标记数量不对但两种标记
 * 都不缺"这个同样畸形的状态,是一个真实的不一致：单侧缺失 fail-closed,单侧过量却不 fail-closed）：
 *   1. 起始标记和结束标记都**恰好各出现 1 次**、且结束标记在起始标记之后 → 原地替换标记块
 *      之间（含标记行本身）的内容；标记块外的所有内容逐字节保留。替换前后内容完全相同 →
 *      `changed:false`（真幂等 no-op）。
 *   2. 起始标记和结束标记**都出现 0 次**（含 `existingContent` 为 `null`/空串，首装场景）→
 *      追加到文件末尾（若原内容非空且不以换行结尾，先补一个换行再追加，不和用户最后一行文字
 *      粘连）；原有内容原样保留在前面，一个字不动。
 *   3. **除以上两种之外的任何组合**（只有一个标记存在缺另一半 / 任一标记出现 2 次及以上 /
 *      恰好各一个但结束标记出现在起始标记之前）→ **fail-closed 拒绝写入，抛出错误**——不盲目
 *      猜测标记块边界该在哪，猜错的后果是删掉用户自己写的真实内容，比拒绝安装更危险（同
 *      `mergeSettingsWithBrainHook()` 对畸形结构的既有 fail-closed 取向）。
 * @param {string|null|undefined} existingContent
 * @param {string} blockBody `buildWakeFallbackBlockBody()` 的产出
 * @returns {{content: string, changed: boolean}}
 */
export function mergeClaudeMdWithWakeFallback(existingContent, blockBody) {
  const content = existingContent ?? "";
  const newBlock = `${WAKE_FALLBACK_MARKER_START}\n${blockBody}\n${WAKE_FALLBACK_MARKER_END}`;

  const startCount = countOccurrences(content, WAKE_FALLBACK_MARKER_START);
  const endCount = countOccurrences(content, WAKE_FALLBACK_MARKER_END);

  if (startCount === 0 && endCount === 0) {
    // 规则 2：都不存在 → 追加。
    if (content === "") {
      return { content: newBlock, changed: true };
    }
    const separator = content.endsWith("\n") ? "\n" : "\n\n";
    const merged = `${content}${separator}${newBlock}`;
    return { content: merged, changed: true };
  }

  if (startCount !== 1 || endCount !== 1) {
    // 规则 3（B3 修复）：数量不是"恰好各一个"——覆盖"缺一半"（0/1、1/0）和"标记重复"
    // （2+/任意、任意/2+）两类畸形状态，统一 fail-closed，不猜测边界。
    throw new Error(
      `既有 CLAUDE.md 里 wake-fallback 标记块的起止标记数量异常（起始标记 ${startCount} 个，结束标记 ` +
        `${endCount} 个，正常应该各恰好 1 个）——拒绝继续，不盲目猜测标记块边界该在哪（fail-closed）。` +
        "这可能是文件被手工编辑过、或被安装脚本以外的方式重复写入；原文件未被触碰，请人工检查后再重试。",
    );
  }

  const startIdx = content.indexOf(WAKE_FALLBACK_MARKER_START);
  const endIdx = content.indexOf(WAKE_FALLBACK_MARKER_END);

  if (endIdx < startIdx) {
    throw new Error("既有 CLAUDE.md 里 wake-fallback 标记块的结束标记出现在起始标记之前——拒绝继续（fail-closed），原文件未被触碰，请人工检查后再重试。");
  }

  // 规则 1：两个标记各恰好一个、顺序正确 → 原地替换标记块之间（含标记行本身）的内容。
  const endOfEndMarker = endIdx + WAKE_FALLBACK_MARKER_END.length;
  const before = content.slice(0, startIdx);
  const after = content.slice(endOfEndMarker);
  const merged = `${before}${newBlock}${after}`;

  if (merged === content) {
    return { content, changed: false };
  }
  return { content: merged, changed: true };
}

function defaultExecImpl(cmd, args, options) {
  return execFileSync(cmd, args, { encoding: "utf8", ...options });
}

/**
 * 🔒 Zorro must-fix（2026-07-23）"验证可用"的具体落点——在原子 rename 换入之前，确认 staging
 * 目录里几个关键产物真的存在，不是"build/npm install 跑完没抛异常就当数"。只检查存在性/非空，
 * 不检查内部具体文件结构（避免和 aeloop 内部目录布局过度耦合，`COPY_ITEMS` 增删字段不需要跟着
 * 改这里）。校验失败时抛出的错误信息里带上具体缺了什么，方便排查。
 * @param {string} dir
 */
function assertStagingUsable(dir) {
  const hookEntry = path.join(dir, ".claude", "hooks", "brain-wake-greeting.mjs");
  if (!existsSync(hookEntry)) {
    throw new Error(`新快照校验失败：缺少 hook 入口文件 ${hookEntry}——拒绝换入，旧快照保持不变`);
  }
  const distDir = path.join(dir, "dist");
  if (!existsSync(distDir) || readdirSync(distDir).length === 0) {
    throw new Error(`新快照校验失败：${distDir} 缺失或为空（build 产物没有正确落地）——拒绝换入，旧快照保持不变`);
  }
  const betterSqlite3Dir = path.join(dir, "node_modules", "better-sqlite3");
  if (!existsSync(betterSqlite3Dir)) {
    throw new Error(`新快照校验失败：${betterSqlite3Dir} 不存在（npm install 没有成功产出原生依赖）——拒绝换入，旧快照保持不变`);
  }
}

/**
 * 🔒 Zorro must-fix（2026-07-23，第4轮）：某个用户主目录下的目标文件的"有效写入目标"解析——
 * 这是本文件第5次在同一处写逻辑上被挑出边界（损坏 JSON → 非原子写 → mode 丢失/软链被换掉），
 * 这次一次性把 metadata/边界预判完，不再一条条打地鼠：
 *
 *   - **软链（write-through）**：`filePath` 本身是软链时，绝不能直接 `renameSync` 换掉它——
 *     那会把软链换成一个普通文件，孤立掉软链原本指向的真身（典型场景：操作者把
 *     `~/.claude/settings.json`/`~/.claude/CLAUDE.md` 软链到自己的 dotfiles 仓库，`rename`
 *     覆盖软链会让 dotfiles 仓库那份"失联"，magit/git status 也不会再反映这次改动）。正确做法
 *     是**解析真身路径，在真身所在目录做 temp+rename**——软链本身完全不被触碰，仍然指向同一个
 *     路径，只是那个路径底下的内容被原子地换成了新内容。
 *   - **悬空软链**：`filePath` 是软链但指向的路径不存在（`realpathSync` 解析失败）——
 *     fail-closed 明确拒绝，不猜测操作者的意图（有 write-through 硬阻碍：不知道该往哪创建
 *     真身、以什么 mode 创建，猜错比拒绝更危险）。
 *   - **首装 vs 重装**：`filePath`（或它指向的真身）压根不存在时（`lstatSync` 直接
 *     `ENOENT`）→ 首装场景，`existedBefore: false`，调用方不会尝试读取/保留一个不存在的
 *     mode，新文件的 mode 完全交给进程当前 umask 决定，不额外 chmod 成任何"我们觉得对"的值。
 *
 * issue #106：这段逻辑原名 `resolveSettingsWriteTarget()`，只服务 `settings.json`——本次
 * 泛化改名为 `resolveWriteTarget()`（不针对具体文件名的通用 helper），供 `settings.json` 和
 * `~/.claude/CLAUDE.md`（DESIGN.md §3.5 的 `wake-fallback` 标记块）两条写入路径共用，不重新
 * 发明一套逻辑去踩一遍同样的坑（软链/mode/EXDEV，已经用真实 blocker 换来的教训）。纯重命名 +
 * 参数泛化，逻辑本身零改动——不影响 `settings.json` 既有调用点的任何行为。
 * @param {string} filePath
 * @returns {{ writeTargetPath: string, existedBefore: boolean }}
 */
function resolveWriteTarget(filePath) {
  let lstat;
  try {
    lstat = lstatSync(filePath);
  } catch (err) {
    // 🔒 Zorro finding 12（2026-07-23 第5轮）：只有 ENOENT（真的什么都没有，首装场景）才该走
    // 这条"当成首装"的分支——此前是不分错误类型的 blanket catch，会把权限不足（EACCES）、
    // 路径过长、坏文件描述符等其它真实故障也一并静默吞掉当成"文件不存在"，掩盖真实问题。
    if (err.code !== "ENOENT") throw err;
    return { writeTargetPath: filePath, existedBefore: false };
  }

  if (!lstat.isSymbolicLink()) {
    return { writeTargetPath: filePath, existedBefore: true };
  }

  let realTarget;
  try {
    realTarget = realpathSync(filePath);
  } catch (err) {
    throw new Error(
      `${filePath} 是一个软链，但解析真实路径失败（很可能是悬空软链，` +
        `指向的文件不存在）：${err.message}——拒绝继续（fail-closed，不猜测该往哪创建真身/用什么 ` +
        "mode，宁可拒绝也不冒险写错地方）。",
    );
  }
  return { writeTargetPath: realTarget, existedBefore: true };
}

/**
 * @param {{
 *   repoRoot?: string,
 *   homeDir?: string,
 *   dryRun?: boolean,
 *   execImpl?: (cmd: string, args: string[], options: object) => string,
 *   renameImpl?: (src: string, dest: string) => void,
 *   taskSource?: "github",
 * }} [opts] `renameImpl` 默认是真实 `node:fs` 的 `renameSync`——测试可以注入一个只对特定 `dest`
 *   失败的假实现，既用来验证"换入失败时旧内容/旧快照原封不动"，也顺带证明了实现真的走
 *   temp-file+rename 这条路径（如果实现退化成裸 `writeFileSync` 直接覆写，注入的 `renameImpl`
 *   根本不会被调用，这个失败注入也就不会有任何效果——见 `test-install-global-brain.mjs`
 *   "🔒 must-fix（settings.json 原子写）"那组用例的头注释）。`taskSource`（issue #103）：
 *   省略时（shipped 默认）`hookCommand` 不带 `AELOOP_BRAIN_TASK_SOURCE`，全局模式下
 *   `resolveTaskSource()` 落到默认值 `"none"`——个人版 Helix 想 opt-in GitHub 在途来源，装机
 *   时显式传 `taskSource: "github"`（CLI `--task-source=github`），和 `AELOOP_BRAIN_GLOBAL_
 *   MODE=1` 同一个"烘焙进 hookCommand 字符串"机制，不受 IDE 不继承 shell profile export 的
 *   已知坑影响（DESIGN §8）。值域目前只有 `"github"`（唯一的真实 adapter，不接受 `"none"`——
 *   省略即 `"none"`，不需要一个显式传"none"的等价写法）。
 * @returns {{
 *   dryRun: boolean,
 *   snapshotDir: string,
 *   dataDir: string,
 *   settingsPath: string,
 *   hookCommand: string,
 *   settingsChanged: boolean,
 * }}
 */
export function installGlobalBrain(opts = {}) {
  const {
    repoRoot = REPO_ROOT,
    homeDir = os.homedir(),
    dryRun = false,
    execImpl = defaultExecImpl,
    renameImpl = renameSync,
    taskSource,
  } = opts;
  assertValidTaskSourceOpt(taskSource); // fail-closed 早退——即便是编程调用（绕过 CLI）也不静默降级

  const { installDir, snapshotDir, dataDir, settingsPath, hookEntryPath, globalClaudeMdPath } = installPaths(homeDir);
  // issue #106：SessionStart 和 UserPromptSubmit 用同一个 hookCommand（同一个脚本文件，内部按
  // stdin 的 hook_event_name 分派，见 DESIGN.md §3.3/附录第2点）——不需要为 UserPromptSubmit
  // 单独生成一条不同的命令字符串。
  const hookCommand =
    taskSource === "github"
      ? `AELOOP_BRAIN_GLOBAL_MODE=1 AELOOP_BRAIN_TASK_SOURCE=github node "${hookEntryPath}"`
      : `AELOOP_BRAIN_GLOBAL_MODE=1 node "${hookEntryPath}"`;

  // 读既有 settings.json（不存在 → null，视为 {}）——即便 dry-run 也读（只读不算副作用），
  // 用于打印"将要做的改动"摘要。
  let existingSettings = null;
  if (existsSync(settingsPath)) {
    try {
      existingSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (err) {
      throw new Error(`既有 ${settingsPath} 不是合法 JSON，拒绝继续（不盲目覆盖坏文件）：${err.message}`);
    }
  }
  const { settings: mergedSettings, changed: settingsChanged } = mergeSettingsWithBrainHook(
    existingSettings,
    hookCommand,
  );

  // issue #106：全局 CLAUDE.md 的 wake-fallback 标记块——同 settings.json 一样，即便 dry-run 也
  // 读（只读不算副作用），纯文本文件不存在 JSON 解析失败这种问题，读不到就当空串处理
  // （`mergeClaudeMdWithWakeFallback()` 内部对 `null` 的处理和空串等价）。
  let existingClaudeMdContent = null;
  if (existsSync(globalClaudeMdPath)) {
    existingClaudeMdContent = readFileSync(globalClaudeMdPath, "utf8");
  }
  const wakeFallbackBlockBody = buildWakeFallbackBlockBody(hookEntryPath);
  const { content: mergedClaudeMdContent, changed: claudeMdChanged } = mergeClaudeMdWithWakeFallback(
    existingClaudeMdContent,
    wakeFallbackBlockBody,
  );

  // 🔒 Zorro finding 14（2026-07-23 第5轮）：settings 写入目标解析（含悬空软链 fail-closed
  // 校验，见 resolveWriteTarget() 头注释）挪到这里——build/快照换入**之前**——而不是留到最后
  // 写 settings.json 那一步才做。原来的顺序会导致"软链解析失败"这种一开始就能判定的错误，要等
  // build 完、快照都换入完成之后才报出来，前面这些实质性改动已经落地，不是真正的整体
  // fail-closed。只有 `settingsChanged`/`claudeMdChanged` 时才解析/校验各自的目标——这次运行
  // 如果本来就不需要碰某个文件（已经幂等跳过），不该因为一个这次用不到的悬空软链而挡住整个安装。
  const settingsWriteTarget = settingsChanged ? resolveWriteTarget(settingsPath) : null;
  const claudeMdWriteTarget = claudeMdChanged ? resolveWriteTarget(globalClaudeMdPath) : null;

  if (dryRun) {
    return {
      dryRun: true,
      snapshotDir,
      dataDir,
      settingsPath,
      hookCommand,
      settingsChanged,
      globalClaudeMdPath,
      claudeMdChanged,
    };
  }

  // ① build（可注入，测试用假实现，不真的跑 pnpm）
  execImpl("pnpm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });

  // ②③ 🔒 Zorro must-fix（2026-07-23）：重装必须原子，不能"先删旧快照再建新的"——中途任何一步
  // （拷贝/npm install）失败，旧快照已经被删了，而 settings.json 里已注册的 hook 命令还指向它，
  // 留下一个残缺快照（`brain-wake-greeting.mjs` 是 fail-open 设计，dist 缺失时会静默 no-op，
  // 后果有界，但这仍然是往用户真实 `~/.claude/` 写东西的工具，该做到原子）。修法：先把新内容
  // staging 到一个临时目录，构建/npm install 全部在 staging 目录里做完、验证过确实可用之后，
  // 再用文件系统 rename（POSIX 同一文件系统下对目录是原子操作）换入——任何一步失败，旧快照
  // 全程未被触碰，直接清理掉 staging 目录，不留中间态。
  const stagingDir = `${snapshotDir}.staging`;
  rmSync(stagingDir, { recursive: true, force: true }); // 清掉上次可能残留的失败 staging；不影响活跃的 snapshotDir
  mkdirSync(stagingDir, { recursive: true });
  try {
    for (const item of COPY_ITEMS) {
      const src = path.join(repoRoot, item.src);
      const dest = path.join(stagingDir, item.src);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: item.type === "dir" });
    }

    // snapshot 自己的精简 package.json（只含 better-sqlite3，不拷贝 aeloop 自己整份
    // node_modules——那是 pnpm 内容寻址 store 的符号链接结构，直接拷贝到别处大概率断链）
    const repoPackageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const betterSqlite3Version = repoPackageJson.dependencies?.["better-sqlite3"];
    if (!betterSqlite3Version) {
      throw new Error("repoRoot 的 package.json 里找不到 dependencies['better-sqlite3']，拒绝继续");
    }
    writeFileSync(
      path.join(stagingDir, "package.json"),
      JSON.stringify(
        { name: "aeloop-brain-runtime", private: true, dependencies: { "better-sqlite3": betterSqlite3Version } },
        null,
        2,
      ),
    );
    execImpl("npm", ["install", "--omit=dev"], { cwd: stagingDir, stdio: "ignore" });

    // 验证可用——不是"跑完没抛错就当数"，而是显式确认几个关键产物真的在（Zorro"验证可用"
    // 的具体要求）：hook 入口文件、build 产物目录非空、原生依赖已安装。只检查存在性/非空，
    // 不检查内部具体结构（不过度耦合 aeloop 自己的内部目录布局，COPY_ITEMS 变了也不用跟着改）。
    assertStagingUsable(stagingDir);
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true }); // 失败清理 staging，旧快照全程未被碰
    throw err;
  }

  // 原子换入：旧快照先挪到一边（rename，不是复制/删除），新快照挪进最终位置（rename），成功后
  // 才清掉旧的；任何一步 rename 失败都尝试把旧快照挪回原位，不让用户卡在"什么都没有"的中间态。
  const hadOldSnapshot = existsSync(snapshotDir);
  const oldSnapshotDir = `${snapshotDir}.old-${Date.now()}`;
  if (hadOldSnapshot) {
    renameImpl(snapshotDir, oldSnapshotDir);
  }
  try {
    renameImpl(stagingDir, snapshotDir);
  } catch (err) {
    if (hadOldSnapshot) {
      try {
        renameImpl(oldSnapshotDir, snapshotDir); // 尽力回滚，恢复旧快照
      } catch {
        /* 回滚也失败——如实抛出原始错误，不掩盖，见下 */
      }
    }
    throw err;
  }
  if (hadOldSnapshot) {
    rmSync(oldSnapshotDir, { recursive: true, force: true }); // 清理旧快照；此时新快照已生效，
    // 这一步失败只留垃圾目录，不影响正确性，不需要额外处理
  }

  // ④ 身份库数据目录（不预先 touch db 文件——better-sqlite3 首次 open 会自动创建）
  mkdirSync(dataDir, { recursive: true });

  // issue #98：安装完成后回显"装的是哪个版本"——读的是**刚换入的这份 snapshotDir**（新快照
  // 已经生效，见上方原子换入），不是当前运行这个安装脚本的仓库自己的 dist/：两者理论上应该
  // 一致（都出自同一次 `pnpm run build`），但如果哪天这两个目录不巧不同步，读 snapshotDir 才
  // 是"真实装进去的那份"，不是"打算装的那份"。用正则从生成的 .js 文件文本里提取 JSON 字面量
  // ——不用动态 `import()`（那会让 `installGlobalBrain()` 整个函数变成 async，波及
  // `test-install-global-brain.mjs` 里几十处 `assert.throws(() => installGlobalBrain(...))` 的
  // "同步抛错"断言，得不偿失；这里只是读一份已知格式的生成产物，不需要真的执行它）。fail-soft：
  // 读不出来（理论上不该发生，因为 assertStagingUsable() 已经在换入前确认过 dist/ 非空——但
  // 版本文件本身内容不对/被自定义 execImpl 的假 build 跳过时仍可能读不到）不阻断安装本身，只是
  // 回显文案变成占位符。
  //
  // issue #98 Zorro 独立复审 #2：直接读生成产物里的 `versionString` 字段（`scripts/
  // generate-version.mjs` 的 `formatVersionString()` 已经算过一次），不在这里自己再拼一遍
  // "+"/"-dirty"——本文件、`src/shared/version.ts`、`docs/conductor-brain-layer/spike/lib/
  // version-info.mjs` 三处此前各自重建格式化规则,现在统一读同一个已经算好的字符串字面量。
  let installedVersion = "(无法读取版本信息)";
  try {
    const versionModulePath = path.join(snapshotDir, "dist", "shared", "version-info.generated.js");
    const versionModuleSource = readFileSync(versionModulePath, "utf8");
    const match = /GENERATED_VERSION_INFO\s*=\s*(\{[\s\S]*?\});/.exec(versionModuleSource);
    const info = match ? JSON.parse(match[1]) : null;
    if (info && typeof info.versionString === "string" && info.versionString.trim() !== "") {
      installedVersion = info.versionString;
    }
  } catch {
    /* fail-soft，见上方注释 —— 不阻断安装 */
  }

  // ⑤ 合并写入 settings.json（先备份，即便本次没有实质改动也不额外写入——幂等，见下 changed 判据）
  //
  // 🔒 Zorro 第3-5轮多次复审收口（2026-07-23）：这是全批次唯一真的写用户 `~/.claude/settings.json`
  // 的地方——裸 `writeFileSync()` 不是原子操作，写入被打断（磁盘满/进程被杀）可能留下一个
  // 截断的 JSON 文件（注意措辞：这里防的是"读者观察到半写/截断内容"，POSIX `rename()` 对同一
  // 文件系统内的目标是原子的，观察者永远只能看到"旧内容完整"或"新内容完整"之一；这**不是**
  // "防掉电"级别的持久化保证——真正扛得住掉电的持久化需要 `fsync`，本文件不做，Zorro 已判定这是
  // 过度工程，超出片①范围）。单纯 temp+rename 本身又会静默丢 metadata（真实复现过的两条
  // 回归）：① 把用户已有文件的权限位（如 `0600`）静默放宽成新建文件的默认 `0644`；②
  // `settingsPath` 是软链时（比如指向操作者自己的 dotfiles 仓库）把软链本身换成一个普通文件，
  // 孤立掉软链原本指向的真身。`resolveWriteTarget()`（已在函数开头 `settingsChanged`
  // 判定后、`dryRun`/build/快照换入**之前**调用过一次，见上方"Zorro finding 14"说明，这里直接
  // 复用那次的结果，不重复 `lstatSync`）统一处理软链/首装两条分支。
  if (settingsChanged) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });

    const { writeTargetPath, existedBefore } = settingsWriteTarget;

    if (existsSync(settingsPath)) {
      const backupPath = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      // 🔒 Zorro 幻觉门 must-fix（2026-07-23 第5轮）：Node `cpSync()` 的默认行为是
      // `dereference: false`（**不**跟随软链）——`settingsPath` 是软链时，不加这个选项，
      // `cpSync` 复制的是软链本身（又生成一个指向同一真身的软链），不是真身的内容快照。
      // write-through 把真身更新之后，这份".bak"解析出来的会是**新内容**，不是回滚要用的
      // 旧内容——备份形同虚设。（此前这里的注释写"cpSync 默认跟随软链，行为已经正确，不用
      // 改"——这条断言和 Node 官方文档记载的实际默认行为正相反，是一处需要订正的具体错误，
      // 不只是"漏做"。）
      //
      // 修法**不是**简单加 `{ dereference: true }`——实测（本机 Node v24.1.0）发现 `cpSync()`
      // 在 `src` 参数本身是软链时传 `dereference: true` 会抛 `ERR_FS_EISDIR`（"cannot copy a
      // directory"），即便软链指向的明明是个普通文件（`statSync().isFile()` 为真）——这是
      // `cpSync` 自己在软链源 + dereference 组合下的一个实现细节坑，不是本文件的逻辑错误。
      // 更直接、也更不依赖这个坑会不会被修的做法：直接把**已经解析好的真实路径**
      // （`writeTargetPath`，`resolveWriteTarget()` 早算出来的）当 `cpSync` 的 `src`
      // ——这时 `src` 本身就不是软链了，不需要 `dereference` 选项，也就绕开了这个坑。
      cpSync(writeTargetPath, backupPath);
    }

    // 保留原 mode（回归①的具体修法）——只有"重装/write-through 到已存在的真身"才有一个"原 mode"
    // 可保留；首装没有 mode 可读，交给默认 umask，不自作主张。
    const priorMode = existedBefore ? statSync(writeTargetPath).mode & 0o777 : null;

    // temp 文件建在有效写入目标的同一目录（回归②+EXDEV 的共同修法，见 resolveWriteTarget()
    // 头注释）；文件名额外拼一段随机后缀，配合 pid+timestamp 把"同一毫秒内、同一进程意外重入"
    // 这种极端小概率的 temp 命名冲突也一并堵掉（成本几乎为零，一次性做完不留隐患）。
    const settingsTempPath = path.join(
      path.dirname(writeTargetPath),
      `${path.basename(writeTargetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    // 🔒 Zorro finding 9（2026-07-23 第5轮）：`writeFileSync()` 本身也要在 try 保护范围内——
    // 此前它在 try 块之外，写入失败（比如磁盘满，temp 文件已经被 open/部分写入但没能写完）
    // 不会走清理分支，留下一个残缺的 temp 文件。现在整段（写临时文件→可能 chmod→rename）
    // 共用同一个 try/catch，任何一步失败都会清理 temp、不留垃圾。
    try {
      writeFileSync(settingsTempPath, JSON.stringify(mergedSettings, null, 2));
      if (priorMode !== null) {
        chmodSync(settingsTempPath, priorMode);
      }
      renameImpl(settingsTempPath, writeTargetPath);
    } catch (err) {
      rmSync(settingsTempPath, { force: true }); // 换入失败——清掉临时文件（不管失败发生在写入/
      // chmod/rename 哪一步），不留垃圾；live 文件完全没被碰过（rename 从未发生或没有产生效果，
      // 不存在半写状态）。
      throw err;
    }
  }

  // ⑥（issue #106）合并写入全局 CLAUDE.md 的 wake-fallback 标记块——**结构上刻意照抄上面 ⑤ 那
  // 段刚验证过的模式**（软链 write-through/悬空软链 fail-closed/mode 保留/`cpSync` 的
  // `dereference` 陷阱/temp+rename 原子写/`.bak-<timestamp>` 备份），不抽成和 ⑤ 共用的函数——
  // 这是本批次一处刻意的风险控制取舍：抽公共 helper 需要改动 ⑤ 那段已经通过 5 轮 Zorro 复审
  // 硬化过的代码，本批次选择"复制一份结构相同、已验证正确的模式，针对 CLAUDE.md 场景重新写"，
  // 不触碰 ⑤ 一行——用可控的小段代码重复换取零风险碰坏已经稳定的 settings.json 写入路径。
  // `mergedSettings`→`mergedClaudeMdContent`、JSON.stringify→纯文本写入是这段和 ⑤ 唯一的
  // 本质差异。
  if (claudeMdChanged) {
    mkdirSync(path.dirname(globalClaudeMdPath), { recursive: true });

    const { writeTargetPath, existedBefore } = claudeMdWriteTarget;

    if (existsSync(globalClaudeMdPath)) {
      const backupPath = `${globalClaudeMdPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      cpSync(writeTargetPath, backupPath); // 见 ⑤ 段注释：writeTargetPath 已经是解析过软链的真实
      // 路径，不需要 { dereference: true }（那个组合在 cpSync 源是软链时会抛 ERR_FS_EISDIR）。
    }

    const priorMode = existedBefore ? statSync(writeTargetPath).mode & 0o777 : null;

    const claudeMdTempPath = path.join(
      path.dirname(writeTargetPath),
      `${path.basename(writeTargetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      writeFileSync(claudeMdTempPath, mergedClaudeMdContent);
      if (priorMode !== null) {
        chmodSync(claudeMdTempPath, priorMode);
      }
      renameImpl(claudeMdTempPath, writeTargetPath);
    } catch (err) {
      rmSync(claudeMdTempPath, { force: true });
      throw err;
    }
  }

  return {
    dryRun: false,
    snapshotDir,
    dataDir,
    settingsPath,
    hookCommand,
    settingsChanged,
    globalClaudeMdPath,
    claudeMdChanged,
    installedVersion,
  };
}

function parseArgs(argv) {
  const opts = { dryRun: false, target: undefined, taskSource: undefined };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--target=")) opts.target = arg.slice("--target=".length);
    else if (arg.startsWith("--task-source=")) {
      const value = arg.slice("--task-source=".length);
      // 值域只有 "github"（issue #103——见 installGlobalBrain() 头注释"taskSource"一节）；
      // 其它任何值（含拼错的）fail-closed 拒绝整个安装，而不是静默当没传——这是往用户真实
      // ~/.claude/settings.json 写东西的工具，"看不懂的输入就拒绝"和 mergeSettingsWithBrainHook()
      // 对畸形 settings.json 的既有 fail-closed 取向一致，不因为这是命令行参数就降低标准。
      // 复用 `assertValidTaskSourceOpt()`（同 `installGlobalBrain()` 内部用的那个）而不是各写
      // 一份判断——CLI 和编程调用两个入口口径必须一致（Zorro 复审 🟡 finding，2026-07-24）。
      try {
        assertValidTaskSourceOpt(value);
      } catch {
        throw new Error(`--task-source 只接受 "github"（省略即默认 "none"），收到不认识的值："${value}"`);
      }
      opts.taskSource = value;
    }
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dryRun, target, taskSource } = parseArgs(process.argv.slice(2));
  const result = installGlobalBrain({ dryRun, homeDir: target, taskSource });
  if (result.dryRun) {
    console.log("[install-global-brain] --dry-run，未写入任何文件。将要做的改动：");
  } else {
    console.log("[install-global-brain] 安装完成：");
  }
  console.log(`  snapshotDir: ${result.snapshotDir}`);
  console.log(`  dataDir: ${result.dataDir}`);
  console.log(`  settingsPath: ${result.settingsPath}`);
  console.log(`  hookCommand: ${result.hookCommand}`);
  console.log(`  settings.json ${result.settingsChanged ? "将/已新增或更新 SessionStart + UserPromptSubmit 两条 hook 条目" : "已包含两条本工具条目（幂等跳过）"}`);
  // issue #106：全局 CLAUDE.md 的 wake-fallback 标记块（Layer3 自救兜底网指令），对齐上面
  // settings.json 那一行的信息密度。
  console.log(`  globalClaudeMdPath: ${result.globalClaudeMdPath}`);
  console.log(`  CLAUDE.md ${result.claudeMdChanged ? "将/已新增或更新 wake-fallback 标记块" : "已包含该标记块（幂等跳过）"}`);
  // issue #98：dry-run 不真的 build/拷贝，没有产出可读的版本信息，只在真实安装完成后回显。
  if (!result.dryRun) console.log(`  已安装版本: ${result.installedVersion}`);
}
