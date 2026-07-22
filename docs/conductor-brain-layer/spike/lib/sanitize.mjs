// sanitize.mjs — 共享的渲染层清洗 helper。两个渲染器（status-table.mjs 的
// renderStatusTable()、render-greeting.mjs 的 renderGreeting()）都用同一个 sanitizeText()，
// 不各写各的，避免以后又漏一处。
//
// 红线（2026-07-23 Zorro/Codex 跨模型复审第 3 轮 must-fix，round1 就在的老 bug）：任何最终
// 会被拼进渲染文本里的值（memory.title/content、status/model tag 的原始值……）都是**身份库
// 里的数据，不是受信任的常量**——一条 active_task 的 `model` tag 里塞
// `\n| FORGED TASK | 🟡 进行中 | evil-model`，如果原样插值，渲染出的 markdown 表格会多出一整
// 行看起来和真实数据行没有区别的伪造行；`pipe|title|hack` 这类值即便不带换行，也能把一行
// 拆成假的列。这正中"渲染器只报真实 confirmed 在途，不能被数据本身伪造出多余的行"这条本层
// 立身红线——不是"好看不好看"的问题，是"输出的行数/列数是否等于真实 memory 数"这条不变式
// 被破坏了。
//
// 策略（替换，不是拒收；也不是反斜杠转义——见下方为什么）：
//   1. 把任何 CR/LF（`\r\n`/`\r`/`\n`）折叠成一个空格——这是最关键的一步：markdown 表格的
//      "一行"和开场白 bullet 列表的"一条"，边界都是**真实换行符**决定的；一个值里没有真实
//      换行符，它无论内容是什么都只能待在它原本所在的那一行/那一条里，物理上不可能另起一行
//      伪装成新的表格行或新的 bullet。
//   2. 把半角 `|`（U+007C）替换成全角 `｜`（U+FF5C FULLWIDTH VERTICAL LINE），**不是**转义成
//      `\|`——反斜杠转义只在"读的人/解析器认识 markdown 转义规则"这个前提下才生效，字符串本身
//      仍然含有一个真实的 U+007C，任何按字面 `|` 字符切分/计数列数的下游逻辑（包括这份增量
//      自己的单元测试）照样会被那个字符骗到。换成一个完全不同的 code point，"这个字符串里还有
//      几个真实半角 `|`"这条结构不变式就能被机械验证，不依赖任何一方"正确理解转义规则"。
// 两条规则对表格单元格和开场白的行内文本（bullet/identityName/lastStop/followUp……）统一
// 生效——不区分"这是不是表格"，因为换行本身在 bullet 列表里一样能伪造出"看起来独立的一条"。

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeText(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return str.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "｜");
}
