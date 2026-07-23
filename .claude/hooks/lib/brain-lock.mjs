#!/usr/bin/env node
/**
 * brain-lock.mjs — 精简版会话锁 + 一次性 commit/push 授权令牌（issue #88 B2，plan.md §B2）。
 *
 * 精简移植 ai-agent 仓库 `_engine/session-lock.mjs` 的两块能力：① commit/push 一次性授权令牌
 * （`hasValidCommitAuthorization`/`authorizeCommit`/`consumeCommitAuthorization`，供 B3
 * `brain-commit-gate.mjs` 消费）；② issue 绑定记录（`bindIssue`/`findOwnLock`，供 B4
 * `brain-issue-gate.mjs` 消费）。`hasValidCommitAuthorization` 的五条判据**精确复刻**源文件
 * `_engine/session-lock.mjs:518-527`，含 BUG-7 的两条防御性检查（缺/坏 `now` → 无效；未来
 * 时间戳超出时钟漂移容差 → 无效）——这两条是 Helix 真实复审修出来的安全洞，精简移植不弱化它们。
 *
 * ⚠️ 明确裁剪范围（DESIGN.md §3.b 已预先声明方向，这里落实，不是本文件擅自决定）：
 *   - **不移植** `withRmwLock`/`file-lock.mjs` 的完整并发竞态测试基础设施——源文件那套是为了
 *     解决"心跳续期"与"gate 消费"两个独立 node 子进程真并发读改写同一把锁文件的 lost-update
 *     竞态（源文件头注释 2026 年那段详细记录）。aeloop Phase1 是单 operator/单会话场景，本文件
 *     用简单的"读 JSON → 改 → 写 JSON"（`mkdirSync(dir,{recursive:true})` + `writeFileSync`），
 *     不加互斥锁文件。**已知局限**：如果未来 aeloop 真的长出多进程并发写同一把锁的场景（比如
 *     心跳续期 hook 和 gate 消费 hook 恰好同时跑），这里存在和源文件同类的 lost-update 风险，
 *     没有被本文件解决——留给那时候按需补齐，不提前建。
 *   - **不移植** `classifyLock`/`detectActiveSessions`（worktree 隔离的多锁分类判定）——那是
 *     B6 `brain-isolation-guard.mjs` 的职责范围，本文件只提供 `heartbeatAt` 字段给它读，不越权
 *     实现判定逻辑本身。
 *   - **不移植** `gh.mjs` 的 `verifyIssueOwnerMatchesRepo`（issue owner 与当前仓库一致性校验）
 *     ——`bindIssue` 只做格式校验（`git-remote.mjs` 的 `OWNER_REPO_SEGMENT` + `#\d+`），不做
 *     "owner 是否真的匹配这个仓库"这层更复杂的校验（Phase1 单 operator 场景，写错 owner 的代价
 *     远低于 ai-agent 那种多项目环境，DESIGN §3.b 已接受这个简化）。
 *
 * 存储：`.claude/brain-locks/<sessionKey>.json`（gitignore，见 B9 `.gitignore` 追加）。
 * `sessionKey` = sanitize 后的 sessionId（优先）或 pid（回退，同源文件 `identityKey` 惯例）。
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const LOCKS_SUBDIR = join(".claude", "brain-locks");
const COMMIT_AUTH_MAX_AGE_MS = 10 * 60 * 1000; // 10 分钟，同源文件 COMMIT_AUTH_MAX_AGE_MS 量级理由
const CLOCK_DRIFT_TOLERANCE_MS = 5_000; // 同源文件 CLOCK_DRIFT_TOLERANCE_MS，吸收正常时钟抖动

// ── 路径 helper ──────────────────────────────────────────────────────────

/** 给定 worktree toplevel，返回它的锁目录绝对路径。 */
export function locksDir(toplevel) {
  return join(toplevel, LOCKS_SUBDIR);
}

/** 把会话 key 清成安全文件名（去掉路径分隔符等）。精确移植 `session-lock.mjs:116-118`。 */
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 给定 worktree toplevel + 会话 key（优先 sessionId，缺省回退 pid），返回该会话锁文件路径。 */
export function lockPath(toplevel, key) {
  return join(locksDir(toplevel), `${sanitizeKey(key)}.json`);
}

/** 从写锁入参算出身份 key：有 sessionId 用它，否则回退 pid。同源文件 `identityKey`。 */
function identityKey({ sessionId, pid }) {
  return sessionId != null && sessionId !== "" ? sessionId : pid;
}

/**
 * 会话身份来源（去品牌：`HELIX_SESSION_ID` → `AELOOP_BRAIN_SESSION_ID`；`CLAUDE_CODE_SESSION_ID`/
 * `CLAUDE_SESSION_ID` 是 Claude Code 自己的环境变量，跨项目通用，不改名）。
 * @returns {string|null}
 */
export function resolveSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.AELOOP_BRAIN_SESSION_ID || null;
}

// ── 纯函数：一次性授权令牌有效性判定 ─────────────────────────────────────────

/**
 * 纯函数：判断一把锁当前是否持有"有效且未消费"的 commit/push 授权令牌。
 * **精确复刻** `_engine/session-lock.mjs:518-527` 的五条判据（含 BUG-7 两条）：
 *   ① 缺/坏 `now`（非数字/NaN）→ 无效（"无法判断"不等于"无限期有效"）。
 *   ② `commitAuthorizedAt` 缺失（从未授权/旧锁无此字段）→ 无效。
 *   ③ 已消费过（`commitAuthorizationConsumedAt` 有值）→ 无效（一次性用尽）。
 *   ④ 未来时间戳超出时钟漂移容差 → 无效（防伪造/系统时钟错乱）。
 *   ⑤ 超龄（`now - authorizedAt > maxAgeMs`）→ 无效。
 * @param {{commitAuthorizedAt?:string|null, commitAuthorizationConsumedAt?:string|null}} lock
 * @param {{now:number, maxAgeMs?:number}} ctx `now` 必传且必须是合法数字
 * @returns {boolean}
 */
export function hasValidCommitAuthorization(lock, { now, maxAgeMs = COMMIT_AUTH_MAX_AGE_MS } = {}) {
  if (typeof now !== "number" || Number.isNaN(now)) return false; // ① 缺/坏 now → 无法判断 = 无效
  const authorizedAtRaw = lock?.commitAuthorizedAt;
  if (!authorizedAtRaw) return false; // ② 从未授权 / 旧锁无此字段 → 无效
  const t = Date.parse(authorizedAtRaw);
  if (Number.isNaN(t)) return false; // 坏时间戳 = 不可信 = 无效
  if (lock?.commitAuthorizationConsumedAt) return false; // ③ 已消费过 → 无效
  if (t > now + CLOCK_DRIFT_TOLERANCE_MS) return false; // ④ 未来时间戳（超出容差）不可信 → 无效
  if (now - t > maxAgeMs) return false; // ⑤ 超龄 → 无效
  return true;
}

// ── IO 薄壳：读写锁文件（简化版读-改-写，见文件头"明确裁剪范围"） ──────────────

function readLockFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // 不存在 / 坏 JSON → 当没有锁
  }
}

function writeLockFile(file, lock) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(lock, null, 2));
}

/** 构造一把最小骨架锁（`buildLock` 的精简版，无 branch/role/worktree 等 Helix 多角色字段）。 */
function buildMinimalLock({ pid, host, sessionId, nowISO }) {
  return {
    schemaVersion: 1,
    pid,
    host,
    sessionId: sessionId ?? null,
    heartbeatAt: nowISO,
    issue: null,
    commitAuthorizedAt: null,
    commitAuthorizationConsumedAt: null,
  };
}

/**
 * 从一批锁里找出"我自己"这把（同源文件 `findOwnLock` 的身份判定：传了非空 sessionId 只按
 * sessionId 精确匹配，找不到就 null，不退回按 pid 试探——防误认成自己从而误放行）。
 * @param {string} toplevel
 * @param {{sessionId?:string|null, pid?:number}} self
 * @returns {object|null}
 */
export function findOwnLock(toplevel, { sessionId, pid } = {}) {
  const file = lockPath(toplevel, identityKey({ sessionId, pid }));
  return readLockFile(file);
}

/**
 * 刷新（或首次创建）本会话锁的 `heartbeatAt`（issue #88 B6，供 `brain-isolation-guard.mjs` 用）。
 *
 * ⚠️ 诚实标注一个真实局限（不是隐藏）：本包**没有**移植 Helix 的 `session-heartbeat.mjs`
 * （挂在 `UserPromptSubmit`/`Stop`/每次 `PreToolUse` 上持续续期心跳）——PRD §4/plan.md §B6 的
 * Do 清单本身就没有列出这个文件，只要求"SessionStart 告警"。这意味着**本会话的心跳只在
 * SessionStart 那一刻被刷新一次**，之后整个会话期间不会再续期——如果两个会话的 SessionStart
 * 时刻恰好落在同一个新鲜度窗口内，隔离告警能生效；但如果 A 会话早就开着（心跳早已"过期"），
 * B 会话才 SessionStart，B 不会把 A 判成"活会话"（A 的心跳按本机制的新鲜度阈值早就"过期"了，
 * 即便 A 事实上还在跑）。这比 Helix 的持续心跳弱，是本批次范围内的真实局限，不是实现 bug——
 * 如果要补齐，需要新增一个类似 `session-heartbeat.mjs` 的 hook，这不在 Pass 2 的批次范围内，
 * 留给需要时再补（不提前建）。
 * @param {string} toplevel
 * @param {string|null} sessionId
 * @param {{pid?:number, host?:string, now?:number}} [opts]
 * @returns {string} 写出的锁文件路径
 */
export function touchHeartbeat(toplevel, sessionId, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const now = opts.now ?? Date.now();
  const nowISO = new Date(now).toISOString();
  const file = lockPath(toplevel, identityKey({ sessionId, pid }));
  const prev = readLockFile(file);
  const lock = prev ? { ...prev, heartbeatAt: nowISO } : buildMinimalLock({ pid, host, sessionId, nowISO });
  writeLockFile(file, lock);
  return file;
}

/**
 * 列出本 worktree 全部锁（issue #88 B6，供 `brain-isolation-guard.mjs` 扫描用）。坏锁/读不出的
 * 静默跳过，绝不抛——guard 永不阻断（同源文件 `readSessionLocks` 惯例）。
 * @param {string} toplevel
 * @returns {object[]}
 */
export function listAllLocks(toplevel) {
  const dir = locksDir(toplevel);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录还没建 / 读不出 = 没有锁
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const lock = readLockFile(join(dir, name));
    if (lock) out.push(lock);
  }
  return out;
}

/**
 * 写一次性 commit/push 授权令牌（IO 壳）。
 * @param {string} toplevel
 * @param {string|null} sessionId
 * @param {{pid?:number, host?:string, now?:number}} [opts]
 * @returns {string} 写出的锁文件路径
 */
export function authorizeCommit(toplevel, sessionId, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const now = opts.now ?? Date.now();
  const nowISO = new Date(now).toISOString();
  const file = lockPath(toplevel, identityKey({ sessionId, pid }));
  const prev = readLockFile(file);
  const lock = prev
    ? { ...prev, commitAuthorizedAt: nowISO, commitAuthorizationConsumedAt: null, heartbeatAt: nowISO }
    : { ...buildMinimalLock({ pid, host, sessionId, nowISO }), commitAuthorizedAt: nowISO, commitAuthorizationConsumedAt: null };
  writeLockFile(file, lock);
  return file;
}

/**
 * 消费本会话锁的 commit/push 授权令牌（IO 壳）。有效性判定完全委托 `hasValidCommitAuthorization`。
 * @param {string} toplevel
 * @param {string|null} sessionId
 * @param {{pid?:number, now?:number, maxAgeMs?:number}} [opts]
 * @returns {{consumed:true} | {consumed:false, reason:"no-lock"|"invalid"|"write-failed"}}
 *
 * ⚠️ finding-4b（Zorro 2026-07-23 复审）——一个值得写清楚的取舍，不是隐藏的 bug：
 *   本包所有 hook 都遵循"guard 自身任何异常都不阻断"的惯例（`brain-commit-gate.mjs` 的
 *   `main()` 外层 `catch { allow(); }`）——这条惯例本身是对的：guard 自己的 bug 不该拖累正常
 *   操作。但它和"消费令牌"这个动作放在一起会出现一条真实的张力：如果这个函数**判定有效之后**、
 *   **真正把"已消费"写回磁盘之前**，写入本身失败了（磁盘满/权限问题等），若让异常直接抛出去，
 *   会被 `brain-commit-gate.mjs` 的外层 catch 接住 → `allow()`。这一次操作被放行是对的（guard
 *   不该因为自己的 I/O 故障而拦住一次已经验证过有效的授权），**但令牌本身没有被真正标记为
 *   已消费**——如果同一个令牌在它的有效期窗口内被第二次读到，`hasValidCommitAuthorization`
 *   仍然会判它"有效"（因为 `commitAuthorizationConsumedAt` 从未真正写成功），等于"一次性令牌"
 *   在这一种窄条件下被悄悄复用了一次，不是真正的一次性。
 *
 *   **选择：本函数内部把这次写入包在 try/catch 里，写失败时返回 `{consumed:false,
 *   reason:"write-failed"}` 而不是让异常冒泡**——调用方（`brain-commit-gate.mjs`）收到的是
 *   一个正常的"未消费"结果，走的是既有的 `deny(...)` 分支，不会落进外层那个"guard 自身异常→
 *   allow"的兜底路径。也就是说：**消费动作本身，对"写失败"这一种具体失败模式，是 fail-closed
 *   的**（宁可这一次操作被 deny，也不让令牌在没有真正消费掉的情况下被当成"已经处理过"）——
 *   这是本函数与"guard 整体 fail-open"惯例刻意不同的一处，范围只限于这一个函数内部的这一步
 *   写入，不改变 hook 层面"guard 自身其它异常仍然 fail-open"的整体设计。
 */
export function consumeCommitAuthorization(toplevel, sessionId, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? COMMIT_AUTH_MAX_AGE_MS;
  const file = lockPath(toplevel, identityKey({ sessionId, pid }));
  const lock = readLockFile(file);
  if (!lock) return { consumed: false, reason: "no-lock" };
  if (!hasValidCommitAuthorization(lock, { now, maxAgeMs })) return { consumed: false, reason: "invalid" };
  const updated = { ...lock, commitAuthorizationConsumedAt: new Date(now).toISOString() };
  try {
    writeLockFile(file, updated);
  } catch {
    return { consumed: false, reason: "write-failed" }; // finding-4b：写失败也不让令牌"看起来还没消费"
  }
  return { consumed: true };
}

/**
 * 绑定 issue（格式校验，不做 owner 一致性校验——见文件头"明确裁剪范围"）。
 * @param {string} toplevel
 * @param {string|null} sessionId
 * @param {string} issueRef 形如 "owner/repo#123"
 * @param {{pid?:number, host?:string, now?:number}} [opts]
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function bindIssue(toplevel, sessionId, issueRef, opts = {}) {
  const m = /^([^/]+)\/([^/]+)#(\d+)$/.exec(String(issueRef || "").trim());
  if (!m) return { ok: false, reason: "bad-format" };
  const [, owner, repo] = m;
  const OWNER_REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // 同 git-remote.mjs 导出的同名正则，避免循环 import
  if (!OWNER_REPO_SEGMENT.test(owner) || !OWNER_REPO_SEGMENT.test(repo)) return { ok: false, reason: "bad-format" };

  const pid = opts.pid ?? process.pid;
  const host = opts.host ?? hostname();
  const now = opts.now ?? Date.now();
  const nowISO = new Date(now).toISOString();
  const file = lockPath(toplevel, identityKey({ sessionId, pid }));
  const prev = readLockFile(file);
  const normalizedIssue = `${owner}/${repo}#${m[3]}`.toLowerCase();
  const lock = prev
    ? { ...prev, issue: normalizedIssue, heartbeatAt: nowISO }
    : { ...buildMinimalLock({ pid, host, sessionId, nowISO }), issue: normalizedIssue };
  writeLockFile(file, lock);
  return { ok: true };
}

// ── CLI（供人手动跑，同 Helix `bind`/`show`/`authorize-commit` 惯例） ─────────
//
// node .claude/hooks/lib/brain-lock.mjs authorize-commit
// node .claude/hooks/lib/brain-lock.mjs bind-issue --issue=owner/repo#n
// node .claude/hooks/lib/brain-lock.mjs show

function resolveToplevelForCli() {
  // 避免引入对 git-remote.mjs 的强依赖（保持本文件可独立单测/独立 import），CLI 场景才需要
  // 真的判定 toplevel，用一次性 execFileSync（不复用 git-remote.mjs 的 resolveToplevel 也可以，
  // 但为了不重复实现同一段逻辑，这里直接复用）。
  return import("./git-remote.mjs").then((m) => m.resolveToplevel(process.cwd()));
}

async function runCli() {
  const [, , sub, ...rest] = process.argv;
  const toplevel = await resolveToplevelForCli();
  if (!toplevel) {
    console.error("brain-lock: 当前目录不在 git 仓库内，无法定位锁目录。");
    process.exitCode = 1;
    return;
  }
  const sessionId = resolveSessionId();

  if (sub === "authorize-commit") {
    const file = authorizeCommit(toplevel, sessionId, { pid: process.pid });
    console.log(`已写入一次性 commit/push 授权令牌 → ${file}（有效期 10 分钟，消费一次即失效）`);
    return;
  }

  if (sub === "bind-issue") {
    const issueArg = rest.find((a) => a.startsWith("--issue="));
    const issue = issueArg ? issueArg.slice("--issue=".length) : null;
    if (!issue) {
      console.error("用法：node .claude/hooks/lib/brain-lock.mjs bind-issue --issue=owner/repo#n");
      process.exitCode = 1;
      return;
    }
    const result = bindIssue(toplevel, sessionId, issue, { pid: process.pid });
    if (!result.ok) {
      console.error(`绑定失败：${result.reason}（issue 格式应为 owner/repo#n）`);
      process.exitCode = 1;
      return;
    }
    console.log(`已绑定 issue=${issue}`);
    return;
  }

  if (sub === "show") {
    const lock = findOwnLock(toplevel, { sessionId, pid: process.pid });
    console.log(lock ? JSON.stringify(lock, null, 2) : "（本会话尚无锁文件）");
    return;
  }

  console.error("用法：authorize-commit | bind-issue --issue=owner/repo#n | show");
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli();
}
