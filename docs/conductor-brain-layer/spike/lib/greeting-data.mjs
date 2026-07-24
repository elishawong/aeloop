// greeting-data.mjs — 组装 render-greeting.mjs 要渲染的完整数据（GreetingData）。
//
// 设计权威：docs/conductor-brain-layer/DESIGN.md §2.2（外层醒来 loop）+ aeloop issue #84 +
// 军师 2026-07-22 两条追加指令（借用 Verity buildGreetingFromState() 的输出格式；只渲染
// confirmed 的 memory 当事实，不把 unconfirmed 当真报）。
//
// 为什么不是直接把 wake() 的 WakeResult 传给渲染器：wake()（./wake.mjs）的 continuedThreads
// 只覆盖 CORE_MEMORY_TYPES 等价集合（identity/constraint/decision）全量 + FTS5 命中的并集——
// active_task/idea 不在这个集合里（wake.mjs 头注释原话），所以一次没有 queryHint 的"刚醒来"
// 调用，wake() 天然看不到"现在在途"/"Idea Queue"要展示的东西。本文件在 wake() 之外，
// 对 identity store 再做两次直接的、类型范围查询（status-table.mjs 的 collectStatusRows +
// 本文件自己的 idea 查询），把这两块补齐——这是本增量对 DESIGN §2.2 WakeResult 接口草案的
// 一个具体扩展，不是绕开它。
//
// 红线（军师 2026-07-22 追加指令，和 status-table.mjs 同一条）：
//   只有 confidenceState === "confirmed" 的 memory 才会被当成"已发生的事实"渲染进
//   "现在在途"表格 / "Idea Queue 积压" / 身份名 / "上次停在"。unconfirmed 的 active_task/idea
//   绝不假装是既定事实——它们只会作为"候选，未确认"出现在"待你决策"段，摆明是待确认状态，
//   不是被悄悄当真报了。这正是要和 Verity 那套 markdown persistence（无 confidence gate，
//   什么都当真报）拉开的地方。
//
// issue #103（在途来源可插拔，默认关，docs/enterprise-board-toggle/DESIGN.md §4）：`opts.taskSource`
// 新增——`"github"` 时行为和今天完全一致；省略或任何非 `"github"` 的值（含 `"none"`）时，
// `statusRows`/`otherProjects`/`unassignedCount`/`backlogItems` 强制为空、`pendingDecisions` 里的
// 任务/idea 候选（`unconfirmedActiveTasks`/`unconfirmedIdeas`）不计算——**不是查出来再丢弃，是
// 压根不查**（`collectStatusRows(store)` 整个不调用），纵深防御：万一渲染层某个分支漏了
// `taskSource` 判断，数据层至少不会意外递出任何"任务看板"数据。**这打破了本文件其它可选参数
// （如 `currentProjectKey`）"省略=行为字节级不变"的一贯惯例**——这是刻意的默认值翻转（指挥官
// 2026-07-24 已确认：shipped 默认零 GitHub 是本需求要的行为变更，不是需要掩盖的破坏性改动），
// 如实标注在这里，不假装它和既有惯例吻合。
//
// **`pendingDecisions` 拆两类，是本次改动对"待你决策"最关键的一处收口**（DESIGN §1/§4/§12①，
// 指挥官已确认这个拆分）：`wakeResult.pendingDecisions`（identity/constraint/decision 的
// 候选修宪，`wake.mjs` 产出，从不碰 gh，对应 `docs/conductor-brain-layer/TURNKEY-DESIGN.md` §4(iii)
// 已定盘的"人格真正加载"通路）**不受 `taskSource` 影响，始终计算**；只有
// `unconfirmedActiveTasks`/`unconfirmedIdeas`（任务/idea 候选，间接依赖 seed 的 gh 同步）随
// `taskSource` 一起收窄。字面砍掉整个"待你决策"会连带废掉一条和 GitHub 毫无关系、已经拍板的机制，
// 本文件不做这个连带动作。
//
// 2026-07-22 Zorro/Codex 跨模型复审补丁（blocker 2 + blocker 3，同一批修复）：
//   - blocker 2：ConfidenceState 是三态（unconfirmed|confirmed|rejected，src/context/types.ts:33）。
//     "候选，未确认"这个桶只应该装 unconfirmed 的——rejected 是操作者已经明确否掉的，不是"还没
//     确认"，绝不能被当成候选复活进"待你决策"。下面 unconfirmedActiveTasks/unconfirmedIdeas
//     显式只筛 confidenceState === "unconfirmed"（不是 "!== confirmed"）。
//   - blocker 3："上次停在"/结尾"继续「X」" 不能只挑 statusRows 里最近更新的一条——那条可能是
//     ✅ done 或 ⬜ 待做，把这种任务当"当前焦点"报出来会误导操作者去"继续"一个其实没在推进的
//     任务（demo 实测中招过）。pickFocusTask() 显式按优先级选：in-progress > blocked/
//     pending-decision > todo/done/未知状态，同一优先级内部再按最近更新排序——不再退回单纯的
//     "最近更新"这个 tie-break。

import { wake } from "./wake.mjs";
import { collectStatusRows } from "./status-table.mjs";

const IDENTITY_NAME_TITLE = "identity:name";
export const DEFAULT_IDENTITY_NAME = '(身份名未在身份库配置 —— 见 BRAIN.md "identity:name" 约定)';

function byRecencyDesc(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return b.id - a.id;
}

function mostRecentConfirmed(memories, type) {
  const hits = memories
    .filter((memory) => memory.type === type && memory.confidenceState === "confirmed")
    .sort(byRecencyDesc);
  return hits[0] ?? null;
}

/**
 * "当前焦点"优先级（blocker 3）：数字越小越优先。in-progress 最该被当成"我正在做的事"；
 * blocked/pending-decision 次之（还悬在那，比 todo/done 更需要被提到）；todo/done/任何
 * resolveStatus() 认不出的"未知状态"（status-table.mjs 的 ❓ 未知状态）排最后——宁可选一个
 * 不太确定的兜底，也不假装某个未知状态就是"正在进行"。
 */
const FOCUS_PRIORITY = Object.freeze({
  "in-progress": 0,
  blocked: 1,
  "pending-decision": 1,
  todo: 2,
  done: 2,
});
const UNKNOWN_FOCUS_PRIORITY = 3;

// must-fix 2（2026-07-23 复审）：一个"当前焦点"只有落在这个优先级以内（in-progress=0 或
// blocked/pending-decision=1）才算"可续做的事"，配得上"上次停在"/"继续「X」"这种措辞。
// todo/done/未知状态（优先级 2、3）即便被 pickFocusTask() 选出来当"矮子里拔将军"，也不能被
// 报成"当前在做的事"——那时应该整体退回和"没有任何在途任务"同一句中性文案。
const ACTIONABLE_FOCUS_PRIORITY_MAX = 1;

// 2026-07-23 Zorro/Codex 跨模型复审 must-fix 1（同一条原型链隐患，status-table.mjs 之外的
// 第二处）：`FOCUS_PRIORITY[statusKey] ?? UNKNOWN_FOCUS_PRIORITY` 沿原型链查找——`statusKey`
// 来自 collectStatusRows() 透传的 tag 值，同样是不可信输入，`status:toString` 这类值会让
// `FOCUS_PRIORITY["toString"]` 拿到 `Object.prototype.toString`（不是 undefined，`??` 不会
// 触发兜底），把一个函数当"优先级数字"参与比较。改用 `Object.hasOwn()` 只查自身属性。
function focusPriority(statusKey) {
  return Object.hasOwn(FOCUS_PRIORITY, statusKey) ? FOCUS_PRIORITY[statusKey] : UNKNOWN_FOCUS_PRIORITY;
}

/**
 * 从 collectStatusRows() 的结果里选一个"当前焦点"——不是简单的"最近更新那条"（blocker 3：
 * 那条可能是 done/todo），而是按 focusPriority 分层，同层内部保留 statusRows 已有的
 * 按最近更新排序（status-table.mjs 的 byRecencyDesc）。
 *
 * @param {ReturnType<typeof collectStatusRows>} statusRows
 * @returns {ReturnType<typeof collectStatusRows>[number] | null}
 */
function pickFocusTask(statusRows) {
  if (statusRows.length === 0) return null;
  let best = statusRows[0];
  let bestPriority = focusPriority(best.statusKey);
  for (const row of statusRows) {
    const priority = focusPriority(row.statusKey);
    if (priority < bestPriority) {
      best = row;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * issue #93 B4：其它已 onboard 项目的一行摘要——"最高优先级"复用 pickFocusTask() 的同一套
 * FOCUS_PRIORITY 分层（in-progress > blocked/pending-decision > todo/done > 未知状态），不是
 * 重新发明一套映射；这里不做"是否可续做"（ACTIONABLE_FOCUS_PRIORITY_MAX）的门控——那道门控
 * 是"该不该说'继续「X」'"这个措辞层面的约束，摘要只是如实报"这个项目里优先级最高的状态是什么"，
 * 不涉及"继续"这个动词，不需要同一层约束。
 * @param {string} projectKey
 * @param {ReturnType<typeof collectStatusRows>} rows
 * @returns {{ projectKey: string, count: number, topStatusLabel: string }}
 */
function summarizeOtherProject(projectKey, rows) {
  const top = pickFocusTask(rows);
  return { projectKey, count: rows.length, topStatusLabel: top ? top.statusLabel : "—" };
}

/**
 * @param {import("../../../../dist/context/store.js").MemoryStore} store
 * @param {{ queryHint?: string, currentProjectKey?: string|null, taskSource?: "none"|"github" }} [opts]
 *   `currentProjectKey`（issue #93 B4 新增，`owner/repo` 形式，通常由 `brain-wake-greeting.mjs`
 *   从 SessionStart stdin 的 `cwd` 反查 `getOriginOwnerRepo()` 算出）——**省略或传 `null`/
 *   `undefined` 时行为字节级不变**（今天所有既有调用点都是这样调的）：`statusRows` 仍是全部
 *   confirmed active_task（不分组），`otherProjects` 恒为 `[]`，`unassignedCount` 恒为 `0`——
 *   这是刻意的向后兼容设计，不是"忘了处理未知项目"的疏漏；只有传入非空 `currentProjectKey` 才会
 *   真的按 `project:*` tag 分组渲染（DESIGN §1.3/PRD §4.5）。`taskSource`（issue #103 新增）——
 *   **`"github"` 时行为和加这个参数之前逐字节相同；省略/`undefined`/任何其它值时默认按 `"none"`
 *   处理**（`statusRows`/`otherProjects`/`unassignedCount`/`backlogItems` 强制为空，
 *   `pendingDecisions` 只保留身份/宪法候选），这是本次改动刻意翻转的默认值，不是向后兼容——
 *   见本文件头注释 + `docs/enterprise-board-toggle/DESIGN.md` §4/§11。
 * @returns {{
 *   identityName: string,
 *   lastStop: string,
 *   statusRows: ReturnType<typeof collectStatusRows>,
 *   otherProjects: Array<{ projectKey: string, count: number, topStatusLabel: string }>,
 *   unassignedCount: number,
 *   backlogItems: import("../../../../dist/context/types.js").Memory[],
 *   pendingDecisions: Array<{ label: string }>,
 *   followUp: string,
 *   openingSummary: string,
 *   taskSource: "none"|"github",
 * }}
 */
export function gatherGreetingData(store, opts = {}) {
  const wakeResult = wake(store, opts.queryHint);
  const all = store.listMemories();

  // issue #103：归一化成两值枚举——只有精确等于 "github" 才算板块开启，任何其它值（含
  // undefined/"none"/拼错的值）一律当 "none" 处理。fail-closed，和 task-source.mjs 的
  // resolveTaskSource() 同一条红线，这里是第二道纵深防御（调用方即便没走 resolveTaskSource()
  // 也不会意外开启板块）。
  const taskSource = opts.taskSource === "github" ? "github" : "none";
  const boardEnabled = taskSource === "github";

  // ---- 身份名：identity 类型 + 固定 title 约定 + 必须 confirmed ----
  const identityMemory = all.find(
    (memory) =>
      memory.type === "identity" &&
      memory.title === IDENTITY_NAME_TITLE &&
      memory.confidenceState === "confirmed",
  );
  const identityName = identityMemory ? identityMemory.content : DEFAULT_IDENTITY_NAME;

  // ---- 现在在途：复用 status-table.mjs，两个消费方同一份实现 ----
  // issue #103：taskSource !== "github" 时压根不查（不是查出来再丢弃）——下面 currentProjectKey
  // 分组逻辑基于 allStatusRows 计算，allStatusRows 为空时 statusRows/otherProjects/
  // unassignedCount 自然全部收窄为空，不需要在每个分支各自重复判断 boardEnabled。
  const allStatusRows = boardEnabled ? collectStatusRows(store) : [];
  const currentProjectKey = opts.currentProjectKey ?? null;

  /** @type {ReturnType<typeof collectStatusRows>} */
  let statusRows;
  /** @type {Array<{ projectKey: string, count: number, topStatusLabel: string }>} */
  let otherProjects;
  let unassignedCount;

  if (!currentProjectKey) {
    // 向后兼容路径（见函数头注释）：不分组，statusRows = 全部行，其它两个字段恒空。
    statusRows = allStatusRows;
    otherProjects = [];
    unassignedCount = 0;
  } else {
    statusRows = allStatusRows.filter((row) => row.project === currentProjectKey);
    unassignedCount = allStatusRows.filter((row) => row.project === null).length;

    const byOtherProject = new Map();
    for (const row of allStatusRows) {
      if (row.project === null || row.project === currentProjectKey) continue;
      if (!byOtherProject.has(row.project)) byOtherProject.set(row.project, []);
      byOtherProject.get(row.project).push(row);
    }
    otherProjects = [...byOtherProject.entries()]
      .map(([projectKey, rows]) => summarizeOtherProject(projectKey, rows))
      .sort((a, b) => a.projectKey.localeCompare(b.projectKey)); // 确定性排序，不依赖 Map 迭代顺序的偶然性
  }

  // ---- 上次停在：优先 snapshot 类型（confirmed），否则退到"现在在途"（仅当前项目，见上）
  //      里的当前焦点（pickFocusTask，不是单纯"最近更新"——blocker 3）。
  //
  //      2026-07-23 Zorro/Codex 跨模型复审 must-fix 2：pickFocusTask() 在 statusRows 非空时
  //      必返一条——如果全部任务都是 done/todo/未知状态（没有任何 in-progress/blocked/
  //      pending-decision），选出来的那条本身就不是"当前真的在做的事"，把它当"上次停在"/结尾
  //      "继续「X」"报出来是误导（全 done → "继续「已经做完的事」"；todo-only/unknown-only 同理）。
  //      只有 focusTask 的优先级落在"可续做"区间（in-progress=0 或 blocked/pending-decision=1，
  //      即 focusPriority <= ACTIONABLE_FOCUS_PRIORITY_MAX）才采用它；否则退回和"完全没有在途
  //      任务"同一句中性文案，不点名任何具体任务。 ----
  const snapshotMemory = mostRecentConfirmed(all, "snapshot");
  const focusTask = pickFocusTask(statusRows);
  const focusIsActionable = focusTask !== null && focusPriority(focusTask.statusKey) <= ACTIONABLE_FOCUS_PRIORITY_MAX;
  const lastStop = snapshotMemory
    ? snapshotMemory.content
    : focusIsActionable
      ? focusTask.task
      : "当前没有可回溯的断点。";

  // ---- Idea Queue 积压：idea 类型，confirmed，未打 "done" tag ----
  // issue #103：同 statusRows，taskSource !== "github" 时压根不查，不是查出来再丢弃。
  const backlogItems = boardEnabled
    ? all
        .filter(
          (memory) => memory.type === "idea" && memory.confidenceState === "confirmed" && !memory.tags.includes("done"),
        )
        .sort(byRecencyDesc)
    : [];

  // ---- 待你决策：wake() 的 pendingDecisions（identity/constraint/decision 里未确认的，从不碰
  //      gh，**不受 taskSource 影响，始终计算**——见本文件头注释"拆两类"）∪ unconfirmed 的
  //      active_task/idea 候选（不能进"现在在途"/"Idea Queue"当既定事实，只能在这里露面，标明
  //      是"候选，未确认"；这部分随 taskSource 一起收窄，taskSource !== "github" 时不计算）。
  //      显式只筛 "unconfirmed"——rejected 彻底排除在外（blocker 2：rejected 是已经否掉的，
  //      不是待确认候选）。 ----
  const unconfirmedActiveTasks = boardEnabled
    ? all.filter((memory) => memory.type === "active_task" && memory.confidenceState === "unconfirmed")
    : [];
  const unconfirmedIdeas = boardEnabled
    ? all.filter((memory) => memory.type === "idea" && memory.confidenceState === "unconfirmed")
    : [];

  const pendingDecisions = [
    ...wakeResult.pendingDecisions.map((memory) => ({
      label: `[${memory.type}] ${memory.title} — ${memory.content}`,
    })),
    ...unconfirmedActiveTasks.map((memory) => ({
      label: `[active_task 候选，未确认] ${memory.title} — ${memory.content}`,
    })),
    ...unconfirmedIdeas.map((memory) => ({
      label: `[idea 候选，未确认] ${memory.title} — ${memory.content}`,
    })),
  ];

  // 同一道 must-fix 2 门控：只有 focusIsActionable 才说"继续「X」"，否则复用
  // "没有任何在途任务"那句中性问句——不点名一个 done/todo/未知状态的任务当成"继续"的对象。
  const followUp = focusIsActionable ? `继续「${focusTask.task}」，还是有新的？` : "有什么想让我接手的？";

  return {
    identityName,
    lastStop,
    statusRows,
    otherProjects,
    unassignedCount,
    backlogItems,
    pendingDecisions,
    followUp,
    openingSummary: wakeResult.openingSummary,
    taskSource,
  };
}
