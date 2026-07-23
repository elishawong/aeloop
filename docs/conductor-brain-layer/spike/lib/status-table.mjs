// status-table.mjs — 共享的"在途任务状态表"查询 + 渲染，两个消费方共用同一份实现，不各建一套：
//   - SessionStart 醒来开场白的"现在在途"表格段（render-greeting.mjs）
//   - 按需查询 skill（.claude/skills/status-table/SKILL.md → print-status-table.mjs）
//
// 设计权威：DESIGN.md §2.2（外层醒来 loop）+ 军师 2026-07-22 追加指令（两处必须复用同一套
// 查询/渲染，不得分叉出两套不同的图标映射或不同的 confirmed-only 判定）。
//
// 红线（不可绕过）：只把 confidenceState === "confirmed" 的 active_task memory 当"在途事实"
// 渲染进表——unconfirmed 的候选绝不出现在这张表里（那是 greeting-data.mjs "待你决策" 段的职责，
// 不是这个模块的）。这是本增量要修的、Verity 那套 markdown persistence 版本没做到的地方（军师原话：
// "这正是比 Verity 强的地方——它会把假在途当真报"）。
//
// 约定（Phase1，net-new，写进 ../../BRAIN.md）：
//   - type: "active_task"，confidenceState === "confirmed"，未打 "archived" tag → 一行。
//   - 状态来自 tag "status:<value>"，取值 in-progress|done|todo|blocked|pending-decision，
//     缺省 tag 时默认 "in-progress"（一条被写入的 active_task，默认假设"正在进行"）。
//   - 模型来自 tag "model:<name>"；没有就是 "—"，绝不猜。
//
// 红线（Zorro/Codex 跨模型复审 blocker 1，2026-07-22）："没打 status tag" 和 "打了 status tag
// 但值不认识（拼错/新值）" 是两件不同的事，绝不能混着都兜回 🟡 进行中——后者是往在途事实表里
// 静默塞进一个假状态。resolveStatus() 把这两种情况分开处理：前者才走默认值，后者原样带出
// 那个不认识的字符串、显式打上"❓ 未知状态"标记，绝不复用任何一个已知图标。
//
// 红线（Zorro/Codex 跨模型复审第 3 轮 must-fix，2026-07-23，round1 就在的老 bug）：
// renderStatusTable() 每个单元格必须过 sanitizeText()（./sanitize.mjs）——task/model/
// statusLabel 三列都是身份库数据，未转义直接插值会让一条真实 memory 在渲染出的表格里凭空
// "分裂"成多行（换行符）或"撕裂"成假的额外列（`|`），详见 sanitize.mjs 头注释。

import { sanitizeText } from "./sanitize.mjs";

/** 图标映射固定死——两个消费方都从这里导入，不允许各自发明变体。 */
export const STATUS_EMOJI = Object.freeze({
  "in-progress": "🟡 进行中",
  done: "✅ done",
  todo: "⬜ 待做",
  blocked: "🔴 阻塞或等决策",
  "pending-decision": "🔴 阻塞或等决策",
});

const DEFAULT_STATUS_KEY = "in-progress";

function tagValue(tags, prefix) {
  const hit = tags.find((tag) => tag.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

/**
 * 区分"没打 status tag"（合法，默认 in-progress）和"打了 status tag 但值不在
 * STATUS_EMOJI 里"（不合法数据，绝不能静默冒充 in-progress——那是往在途事实表注入假事实）。
 *
 * 2026-07-23 Zorro/Codex 跨模型复审 must-fix 1：`STATUS_EMOJI[raw]` 是沿原型链查找的真值
 * 判断——`raw` 来自身份库里的 tag 字符串，是**外部/不可信输入**，`status:toString`/
 * `status:constructor`/`status:__proto__`/`status:valueOf`/`status:hasOwnProperty` 这类值会
 * 命中 `Object.prototype` 上的内置方法/`__proto__` 存取器，被当成"真值"直接渲染进"在途"事实表
 * （吐出 `function toString() { [native code] }` 这类东西），完全破坏"未识别值必须显式标 ❓"这
 * 条不变式。改用 `Object.hasOwn()`（只查自身属性，不走原型链）——`STATUS_EMOJI` 虽然
 * `Object.freeze` 过，但 freeze 不隔离原型链查找，这里必须显式用 `hasOwn` 而不是真值判断。
 *
 * @param {string[]} tags
 * @returns {{ statusKey: string, statusLabel: string }}
 */
function resolveStatus(tags) {
  const raw = tagValue(tags, "status:");
  if (raw === null) {
    return { statusKey: DEFAULT_STATUS_KEY, statusLabel: STATUS_EMOJI[DEFAULT_STATUS_KEY] };
  }
  if (Object.hasOwn(STATUS_EMOJI, raw)) {
    return { statusKey: raw, statusLabel: STATUS_EMOJI[raw] };
  }
  // 打了 tag，但值不认识（拼错/新值/typo，或者是本次复审实测踩过的 `toString`/`__proto__`/
  // `constructor` 这类原型链攻击面）——原样带出这个值，明确标"未知"，不复用任何已知图标
  // （尤其不能是 🟡，那会被读成"确认在进行中"），也绝不渲染 STATUS_EMOJI 原型链上找到的东西。
  return { statusKey: raw, statusLabel: `❓ 未知状态（status:${raw}）` };
}

/** 按 updatedAt 降序；同一时间戳时 id 大（后写入）的排前面，行为确定不依赖 sort 稳定性巧合。 */
function byRecencyDesc(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return b.id - a.id;
}

/**
 * @param {import("../../../../dist/context/store.js").MemoryStore} store
 * @returns {Array<{id: number, task: string, statusKey: string, statusLabel: string, model: string, project: string|null, updatedAt: string}>}
 */
export function collectStatusRows(store) {
  return store
    .listMemories()
    .filter(
      (memory) =>
        memory.type === "active_task" &&
        memory.confidenceState === "confirmed" &&
        !memory.tags.includes("archived"),
    )
    .map((memory) => {
      const { statusKey, statusLabel } = resolveStatus(memory.tags);
      const model = tagValue(memory.tags, "model:") ?? "—";
      // issue #93 B4：`project:<owner>/<repo>` tag（`scripts/seed-brain-identity.mjs` B3 起写入）
      // ——没有这个 tag 的历史遗留数据（B3 上线前已存在的旧 active_task）→ `null`，渲染层
      // （greeting-data.mjs）必须显式标"未分组"，不能静默丢弃/也不能误判进任何一个项目分组
      // （延续 resolveStatus() "未知值必须显式标 ❓，不能静默兜底"的红线精神，见文件头注释）。
      const project = tagValue(memory.tags, "project:");
      return {
        id: memory.id,
        task: memory.title,
        statusKey,
        statusLabel,
        model,
        project,
        updatedAt: memory.updatedAt,
      };
    })
    .sort(byRecencyDesc);
}

/**
 * @param {ReturnType<typeof collectStatusRows>} rows
 * @returns {string}
 */
export function renderStatusTable(rows) {
  if (rows.length === 0) return "当前没有在途任务。";
  const header = "| 任务 | 状态 | 选用模型 |\n| --- | --- | --- |";
  // 三列全部过 sanitizeText()——task 是 memory.title，statusLabel 在"未知状态"分支里带着
  // 原始 tag 值，model 是 tag 原样值，三个都是身份库数据，不是受信任常量（must-fix 见上）。
  const body = rows
    .map(
      (row) => `| ${sanitizeText(row.task)} | ${sanitizeText(row.statusLabel)} | ${sanitizeText(row.model)} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}
