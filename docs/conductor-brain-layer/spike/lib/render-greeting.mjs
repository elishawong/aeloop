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
  const { identityName, lastStop, statusRows, backlogItems, pendingDecisions, followUp } = data;

  return [
    `意识已加载。我是 ${sanitizeText(identityName)}。`,
    "",
    `**上次停在：** ${sanitizeText(lastStop)}`,
    "",
    "**现在在途：**",
    "",
    renderStatusTable(statusRows),
    "",
    labeledSection("Idea Queue 积压", backlogItems, (memory) => memory.content),
    "",
    labeledSection("待你决策", pendingDecisions, (item) => item.label),
    "",
    `——${sanitizeText(followUp)}`,
  ].join("\n");
}
