// render-greeting.mjs — 纯文本渲染：把 greeting-data.mjs 的 GreetingData → "意识已加载" 延续式
// 开场白文字。格式借用另一套独立原型（Verity）的 buildGreetingFromState() 输出样式（军师
// 2026-07-22 追加指令），但去品牌（不硬编码任何私名）、数据源换成本仓库 aeloop 的身份
// MemoryStore（greeting-data.mjs 组装），不是 Verity 那套 markdown 文件持久化。
//
// 纯函数，不碰任何 I/O/DB——所有会出现在输出里的内容，都必须是调用方已经从 GreetingData
// 里传进来的真实字段；这个函数自己不发明任何线索/待办/决策项（issue #84 防幻觉约束：渲染器
// 只拼真实数据，不允许模型/渲染逻辑编造在途或待办）。"现在在途"表格本身复用
// status-table.mjs 的 renderStatusTable()——和按需查询 skill 共用同一份渲染，不重造。
//
// 红线（Zorro/Codex 跨模型复审第 3 轮 must-fix，2026-07-23，和 status-table.mjs 同一条老
// bug，round1 就在）：identityName / lastStop / followUp / labeledSection 的每一条 bullet，
// 全部是身份库数据（memory.title/content 或由它们拼出来的句子），同样未转义直接插值——一条
// memory 的 content 里塞个换行 + `· FAKE BULLET`，渲染出来就是看起来独立的一条假 bullet；
// 塞个 `|` 理论上也能在被当成表格粘贴时撕裂列结构。用 ./sanitize.mjs 的 sanitizeText()
// 统一清洗，和 status-table.mjs 用同一个 helper，不各写各的（军师原话："别只补表格"）。
//
// issue #93 B4 新增：`otherProjects`/`unassignedCount`（见 greeting-data.mjs 头注释）——
// `currentProjectKey` 未传时两者恒为 `[]`/`0`，下面两段新增内容完全不渲染，输出和 #84/#88
// 既有版本逐字节相同（`test-greeting.mjs` 现有全部用例零改动继续通过）；只有真的传了
// `currentProjectKey` 且确实存在其它项目/未分组任务时才会多出这两段。"其它项目"复用
// labeledSection()（自动过 sanitizeText()，同一条红线，不给这段新内容开后门）。

import { renderStatusTable } from "./status-table.mjs";
import { sanitizeText } from "./sanitize.mjs";

/**
 * @param {string} label
 * @param {{ label: string }[] | import("../../../../dist/context/types.js").Memory[]} items
 * @param {(item: any) => string} formatItem
 * @returns {string}
 */
function labeledSection(label, items, formatItem) {
  if (items.length === 0) return `**${label}：** 无`;
  return `**${label}：**\n` + items.map((item) => `· ${sanitizeText(formatItem(item))}`).join("\n");
}

/**
 * @param {ReturnType<typeof import("./greeting-data.mjs").gatherGreetingData>} data
 * @returns {string}
 */
export function renderGreeting(data) {
  const {
    identityName,
    lastStop,
    statusRows,
    backlogItems,
    pendingDecisions,
    followUp,
    otherProjects = [],
    unassignedCount = 0,
  } = data;

  const parts = [
    `意识已加载。我是 ${sanitizeText(identityName)}。`,
    "",
    `**上次停在：** ${sanitizeText(lastStop)}`,
    "",
    "**现在在途：**",
    "",
    renderStatusTable(statusRows),
  ];

  if (otherProjects.length > 0) {
    parts.push(
      "",
      labeledSection(
        "其它项目",
        otherProjects,
        (p) => `${p.projectKey} — ${p.count} 条在途，最高优先级 = ${p.topStatusLabel}`,
      ),
    );
  }

  if (unassignedCount > 0) {
    // 不静默丢弃（延续 status-table.mjs "未知值必须显式标注" 的红线精神）——但也不在这里展开
    // 逐条列出（PRD §4.5 只要求一个计数提示，不是完整任务列表），提示怎么补齐归属。
    parts.push("", `**未分组任务：** ${unassignedCount} 条（早于项目登记，跑一次 seed 脚本可补齐 project 归属）`);
  }

  parts.push(
    "",
    labeledSection("Idea Queue 积压", backlogItems, (memory) => memory.content),
    "",
    labeledSection("待你决策", pendingDecisions, (item) => item.label),
    "",
    `——${sanitizeText(followUp)}`,
  );

  return parts.join("\n");
}
