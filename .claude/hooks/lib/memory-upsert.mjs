// memory-upsert.mjs — 共享的 MemoryStore upsert helper（issue #93 B2/B3，
// docs/conductor-brain-multiproject/PRD.md §4.3 第4步 + §4.4）。
//
// 从 scripts/seed-brain-identity.mjs（issue #88 B8）已有的 findExisting()/upsertMemory() 原样抽出
// ——这两个函数本来就是通用的、不含 issue 特定逻辑，之前只是"恰好"和 issue 同步逻辑写在同一个
// 文件里。`scripts/onboard-project.mjs`（B2）需要同一套 upsert 语义写 `project_registry` 记录，
// 抽成共享库不重复实现一份，`seed-brain-identity.mjs` 同步改为调用这里而不是保留自己那份重复
// 代码（本次顺手做的小重构，不改变任何既有行为，`scripts/test-seed-brain-identity.mjs` 的全部
// 既有用例应该零改动继续通过）。
//
// `MemoryStore` 没有原生 upsert（`insertMemory()` 每次都新建一行，`src/context/store.ts:237`）；
// 这里实现的幂等策略、"title/tags 变了要删除重建，只有 content/confidence 变了才能用
// updateMemoryContent() 保留 id/createdAt 连续性"的取舍，逐字沿用 seed-brain-identity.mjs 原有
// 实现的既有说明，不重新论证。

/**
 * 找已有记录——两种匹配策略，调用方按数据本身的稳定性选：
 *   - `matchTag`：按一个稳定的 tag（如 `gh-issue:<n>`/`project:<owner>/<repo>`）匹配。适合
 *     "标题可能变但有一个稳定 key"的场景（issue 标题会改名，owner/repo 一般不变但也可能通过
 *     `--display-name` 之类换个显示名）。
 *   - `title`：`title` 本身就是稳定的固定字符串时用（如 `identity:name`/`constraint:<slug>`）。
 * @param {import("../../../dist/context/store.js").MemoryStore} store
 * @param {{type:string, title:string, matchTag?:string}} desired
 * @returns {object|null}
 */
export function findExisting(store, desired) {
  const all = store.listMemories();
  if (desired.matchTag) {
    return all.find((m) => m.type === desired.type && m.tags.includes(desired.matchTag)) ?? null;
  }
  return all.find((m) => m.type === desired.type && m.title === desired.title) ?? null;
}

/** @param {string[]} a @param {string[]} b */
export function tagsEqual(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * @param {import("../../../dist/context/store.js").MemoryStore} store
 * @param {{type:string, title:string, content:string, tags:string[], confidenceState:string, matchTag?:string}} desired
 * @param {{actor?: string}} [opts] `confirmedBy` 落库时的 actor 标签，默认 `"memory-upsert"`；
 *   调用方（`seed-brain-identity.mjs`/`onboard-project.mjs`）建议传自己的脚本名，方便审计时
 *   区分这条记录是被哪个脚本写入的（同一份共享 upsert 逻辑，不同调用方的写入痕迹仍可区分）。
 * @returns {{action:"inserted"|"unchanged"|"content-updated"|"replaced"}}
 */
export function upsertMemory(store, desired, opts = {}) {
  const actor = opts.actor ?? "memory-upsert";
  const existing = findExisting(store, desired);
  const insertPayload = {
    type: desired.type,
    title: desired.title,
    content: desired.content,
    tags: desired.tags,
    confidenceState: desired.confidenceState,
  };

  if (!existing) {
    store.insertMemory(insertPayload);
    return { action: "inserted" };
  }

  const titleChanged = existing.title !== desired.title;
  const contentChanged = existing.content !== desired.content;
  const tagsChanged = !tagsEqual(existing.tags, desired.tags);
  const confidenceChanged = existing.confidenceState !== desired.confidenceState;

  if (!titleChanged && !contentChanged && !tagsChanged && !confidenceChanged) {
    return { action: "unchanged" };
  }

  if (titleChanged || tagsChanged) {
    // MemoryStore 没有 updateMemoryTags()/改 title 的方法——title/tags 只能在 insert 时定，
    // 变了只能删了重建（见文件头"幂等性"说明）。
    store.deleteMemory(existing.id);
    store.insertMemory(insertPayload);
    return { action: "replaced" };
  }

  // 只有 content（和/或 confidence）变了，title/tags 没变：可以用 updateMemoryContent，保留原
  // id/createdAt 的连续性，比删除重建更好。
  const now = new Date().toISOString();
  if (contentChanged) {
    store.updateMemoryContent(existing.id, desired.content, now);
  }
  if (confidenceChanged) {
    store.updateMemoryConfidence(existing.id, {
      confidenceState: desired.confidenceState,
      confirmedAt: desired.confidenceState === "confirmed" ? now : null,
      confirmedBy: desired.confidenceState === "confirmed" ? actor : null,
      updatedAt: now,
    });
  }
  return { action: "content-updated" };
}
