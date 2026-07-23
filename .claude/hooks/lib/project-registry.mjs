// project-registry.mjs — 共享的"目标项目是否已注册"判定（issue #93 B3/B5，
// docs/conductor-brain-multiproject/PRD.md §4.4/§4.6）。
//
// `scripts/seed-brain-identity.mjs`（B3）和 `scripts/dispatch-brain-task.mjs`（B5）都需要同一条
// 判据："这个 owner/repo 有没有对应的 project_registry 记录"——抽成共享函数，不各写一份（同
// `memory-upsert.mjs` 的抽取理由）。

/**
 * @param {string} owner
 * @param {string} repo
 * @returns {string} `project:<owner>/<repo>` 形式的 tag。
 */
export function projectTagFor(owner, repo) {
  return `project:${owner}/${repo}`;
}

/**
 * @param {import("../../../dist/context/store.js").MemoryStore} store
 * @param {string} projectTag `project:<owner>/<repo>` 形式（用 `projectTagFor()` 生成）。
 * @returns {boolean}
 */
export function isProjectRegistered(store, projectTag) {
  return store.listMemories().some((m) => m.type === "project_registry" && m.tags.includes(projectTag));
}

/**
 * 未注册时抛错（`err.code = "PROJECT_NOT_ONBOARDED"`），已注册时无返回值（正常 return）——
 * 调用方（`main()`/`dispatchBrainTask()`）直接 `assertProjectRegistered(...)` 一行，不需要
 * 自己写 `if (!ok) throw`。
 * @param {import("../../../dist/context/store.js").MemoryStore} store
 * @param {string} owner
 * @param {string} repo
 * @param {{ callerHint?: string }} [opts] `callerHint` 拼进错误消息里的"请先跑 XXX"提示，
 *   不同调用方（seed 脚本 vs dispatch 脚本）想给出的下一步动作提示相同（都是先 onboard），
 *   所以其实两边目前会传同一句提示，这个参数只是留给未来万一想细分措辞的扩展点。
 */
export function assertProjectRegistered(store, owner, repo, opts = {}) {
  const projectTag = projectTagFor(owner, repo);
  if (isProjectRegistered(store, projectTag)) return;
  const hint = opts.callerHint ?? "请先跑 `node scripts/onboard-project.mjs --repo-path <path>` 注册该项目。";
  const err = new Error(`目标项目 ${owner}/${repo} 尚未注册（找不到 tags 含 "${projectTag}" 的 project_registry 记录）。${hint}`);
  err.code = "PROJECT_NOT_ONBOARDED";
  throw err;
}
