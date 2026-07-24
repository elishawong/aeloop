#!/usr/bin/env node
/**
 * seed-brain-identity.mjs — 一键 seed 脚本（issue #88 B8；issue #103 起，第 3 类种子数据默认关）。
 *
 * 把去品牌化公司宪法（身份/铁律）+（可选 opt-in）当前真实 GitHub issue 在途状态，种进 aeloop
 * 身份 `MemoryStore`——目的是让开箱后 `.claude/hooks/brain-wake-greeting.mjs` 的醒来开场白能读出
 * 真身份（"我是你的 AI 调度员"），而不是"(身份名未在身份库配置)"这种 generic 状态（DESIGN 权威：
 * `docs/conductor-brain-layer/TURNKEY-DESIGN.md` §3.c；铁律内容对齐
 * `docs/conductor-brain-layer/BRAIN.md` §1.6）。
 *
 * ── 三类种子数据（第 3 类默认不跑，见下方"issue #103：在途任务来源 gate"） ──────────────
 *   1. **身份**：`type:"identity", title:"identity:name"` 一条，内容 = "你的 AI 调度员"
 *      （issue #88 body 定盘的自我介绍角色化身份，不用人名）。
 *   2. **宪法约束**：`CONSTITUTION_CONSTRAINTS`（下方常量数组）——`type:"constraint"`，每条
 *      `title:"constraint:<slug>"`，`tags:["hardness:hard"|"hardness:soft"]`，逐条誊写自
 *      `BRAIN.md` §1.6 的七条铁律（4 条 🔒 + 3 条 👁，2026-07-23 operator 拍板新增"成本
 *      透明"一条 👁，见下方数组第 7 条）。
 *   3. **在途任务**（仅 `AELOOP_BRAIN_TASK_SOURCE=github` 时才会跑）：从 `gh issue list`
 *      （真实调用或注入的 stub）读出的每个 issue，映射成 `type:"active_task"`，见下方
 *      "issue → active_task 映射"整段。shipped 默认（未 opt-in）这一步整个跳过，不反查 owner/
 *      repo、不检查项目注册、不调 `gh` 二进制。
 *
 * ⚠️ **CONSTITUTION_CONSTRAINTS 和 `BRAIN.md` §1.6 是同一份铁律的两份独立表示，会漂移**
 * （`TURNKEY-DESIGN.md` §3.c 已经标注过这个代价，不是本文件新引入的问题）：`BRAIN.md` 改了
 * 铁律，这个数组不会自动跟着改，需要人工同步。不做自动解析 `BRAIN.md` 生成这个数组（Phase1
 * 不做 Markdown 解析器，成本不对，`TURNKEY-DESIGN.md` §3.c 已经拍板）。
 *
 * ── issue #103：在途任务来源 gate（seed 解耦 gh） ───────────────────────────────
 * `main()` 的"3. 在途 issue"这一整步现在挂在 `resolveTaskSource()`（`.claude/hooks/lib/
 * task-source.mjs`）后面——`taskSource !== "github"`（shipped 默认 "none"）时**整个途③物理
 * 跳过**：不反查 origin owner/repo、不检查目标项目是否已注册、不调 `gh` 二进制。不是只包一层
 * try/catch 容忍 gh 调用失败（那是 #96 已经做过的更窄修复）——这次连"为了将来调 gh 而做的前置
 * 检查"也不做，见 `docs/enterprise-board-toggle/DESIGN.md` §6。字段 `skippedTaskSync`
 * （此前叫 `skippedIssueSync`，issue #103 改名——"issue"是 GitHub 特定词汇，渗进了本该通用的
 * 字段名，值域现在不只是"gh 相关跳过原因"）在两种情况下都会被设置：taskSource 未 opt-in（本条）
 * 和 taskSource=github 但反查/调用失败（下方既有逻辑，改名未改行为）。
 *
 * ── issue → active_task 映射（只在 taskSource==="github" 时会被用到） ──────────────
 *   - **issue 已关闭（`state === "CLOSED"`）** → `tags: ["status:done", "archived", "gh-issue:<n>"]`
 *     ——`archived` tag 是 `status-table.mjs`（`collectStatusRows`）已有的既定约定："打
 *     archived tag 的 active_task 完全不出现在'现在在途'表里"，本文件不新发明这条约定，只是
 *     调用它；额外带 `status:done` 是为了让这条记录自己的数据完整（万一将来有人手动摘掉
 *     archived tag，状态字段本身仍然准确），不依赖它被渲染。
 *   - **issue 是 OPEN**：按 `status:*` label 映射成 `active_task` 的 `status:` tag（约定见
 *     `BRAIN.md` §4 已有的"任务状态"行）：
 *       | GitHub label            | active_task 的 status: tag |
 *       |--------------------------|------------------------------|
 *       | `status:awaiting-commander` | `status:pending-decision` |
 *       | `status:awaiting-zorro`     | `status:blocked`          |
 *       | `status:in-progress`        | `status:in-progress`      |
 *       | `status:prd-draft`          | `status:in-progress`（草拟本身是在推进，不是空转） |
 *       | （无 `status:*` label）     | `status:todo`             |
 *   - **一个 issue 同时挂多个 `status:*` label 时怎么选**（真实数据里会发生——比如同一个 issue
 *     在推进过程中忘了摘掉旧标签，实测本仓库 issue #88 自己就同时挂着 `status:prd-draft` 和
 *     `status:in-progress`）：按上表从上到下的优先级取第一个命中的（`awaiting-commander` >
 *     `awaiting-zorro` > `in-progress` > `prd-draft`）——越靠后的阶段代表越"新"的进度，旧阶段
 *     的标签没清掉更可能是疏忽，不是真状态；这是本文件的一个具体判断，不是照抄哪份已有文档，
 *     如实标注。
 *
 * ── 幂等性 ────────────────────────────────────────────────────────────────────
 * `MemoryStore` 没有 upsert（`insertMemory()` 每次都新建一行），本文件自己实现幂等：按
 * `(type, title)` 匹配已有记录，内容/tags 都没变 → 跳过（零写入）；只有 `content` 变了 →
 * `updateMemoryContent()`；**`tags` 变了（含新增 `archived`/状态切换）→ 删除旧行、插入新行**
 * ——这是 `MemoryStore` API 的一个真实约束（`src/context/store.ts` 没有
 * `updateMemoryTags()`，只有 `updateMemoryContent()`/`updateMemoryConfidence()`），不是本文件
 * 绕过设计；`insertMemory(input, now)` 的 `now` 显式传入，重建时会得到新的 `createdAt`——
 * 这意味着"tags 变化"这种更新会丢失原记录的创建时间连续性，是这个约束下的已知代价，本文件不
 * 假装规避它。种子脚本插入的记录本身没有走三态确认流程（不是人工确认产生的），预期不会有
 * `memory_confirmations` 关联行，删除重建对这类记录是安全的。
 *
 * ── 绝不碰密钥 ────────────────────────────────────────────────────────────────
 * 本文件不读取、不写入任何 API key / `profiles/apikey/`（company overlay，已 gitignore）内容
 * ——只种身份名 / 宪法文本 / issue 标题与状态，不碰任何模型凭证。`fetchOpenIssues` 的默认实现
 * 只调 `gh issue list`（读 GitHub issue 元数据，不涉及任何模型 API），不读环境变量里的
 * 任何 `*_API_KEY`/`*_TOKEN` 之类的东西。
 *
 * 跑法：
 *   `node scripts/seed-brain-identity.mjs`（需要 `AELOOP_BRAIN_IDENTITY_DB` 或
 *   `.claude/brain.local.json` 已配置——见 `.claude/hooks/lib/db-path.mjs`；在 aeloop 仓库内跑，
 *   且先 `pnpm run build` 生成 `dist/`）。shipped 默认不需要 `gh`；想接回 GitHub issue 同步，
 *   加 `AELOOP_BRAIN_TASK_SOURCE=github` 前缀（这时才需要 `gh` 已登录），见
 *   `.claude/hooks/lib/task-source.mjs` + `docs/enterprise-board-toggle/DESIGN.md`。
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertMemory } from "../.claude/hooks/lib/memory-upsert.mjs";
import { assertProjectRegistered, projectTagFor } from "../.claude/hooks/lib/project-registry.mjs";
import { resolveTaskSource } from "../.claude/hooks/lib/task-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

// ── 1. 身份种子 ────────────────────────────────────────────────────────────

const IDENTITY_NAME_TITLE = "identity:name";
const IDENTITY_NAME_CONTENT = "你的 AI 调度员";

// ── 2. 宪法约束种子（誊写自 BRAIN.md §1.6，会漂移，见文件头说明） ──────────────

/** @type {{slug:string, hardness:"hard"|"soft", content:string}[]} */
export const CONSTITUTION_CONSTRAINTS = [
  {
    slug: "commit-gate",
    hardness: "hard",
    content:
      "commit/push 未经 operator 明确同意不执行——由 .claude/hooks/brain-commit-gate.mjs 拦截（PreToolUse deny）：" +
      "Bash 调用当时的 cwd 命中本仓库、命令命中 git commit/git push/gh pr merge/git merge...main 类模式，" +
      "且没有一次性授权令牌（node .claude/hooks/lib/brain-lock.mjs authorize-commit）时拒绝。" +
      "这是养成习惯的软门，不是防攻击的安全边界：判定只看 Bash 调用当时的 cwd，不解析命令文本里的 -C/--git-dir=，" +
      "从仓库外用 cd 本仓库路径 && git commit 把目标重定向回本仓库，这道门看不到、会放行；命令混淆（变量拼接/eval）同样绕得过。",
  },
  {
    slug: "issue-gate",
    hardness: "hard",
    content:
      "写代码前先绑 issue——但这条默认不生效：.claude/hooks/brain-issue-gate.mjs（PreToolUse/Edit|Write deny hook）" +
      "默认档位（未设 AELOOP_BRAIN_ISSUE_GATE 环境变量，或设了但不是 enforce）恒放行，不检查任何 issue 绑定" +
      "——aeloop 是单 operator 场景，逐次强制绑 issue 对日常/探索性小改动是纯摩擦。只有显式设置 " +
      "AELOOP_BRAIN_ISSUE_GATE=enforce（治理演示模式）才会真的检查是否已绑定 " +
      "（node .claude/hooks/lib/brain-lock.mjs bind-issue --issue=owner/repo#n），未绑定则拒绝。" +
      "机制能力做满（真 deny），但默认档位是关的，不要理解成默认就在拦。",
  },
  {
    slug: "red-line-guard",
    hardness: "hard",
    content:
      "rm -rf/写 .env/force-push 硬拦——.claude/hooks/brain-red-line-guard.mjs（PreToolUse deny hook，" +
      "Bash + Edit|Write 两个 matcher，issue #88 B5 从零设计）：Bash 里 rm -rf 的目标路径（经符号链接解析后）" +
      "不在白名单内（Phase1 仅 os.tmpdir()）、git push --force（不含 --force-with-lease）、Bash 重定向/tee " +
      "写入 .env/.env.*（示例文件除外），以及 Edit/Write 工具直接写 .env/.env.*，会被拦截；已确认命中 rm -rf " +
      "但目标路径判不出安不安全时也会拒绝（宁可误伤不放过）。这是养成习惯的软门，不是防攻击的安全边界：命令混淆、" +
      ".env 间接写法、同一条复合命令里先造符号链接再删除（TOCTOU）都绕得过——检查和真正执行之间总有这道缝，机制上解不掉。",
  },
  {
    slug: "anti-hallucination",
    hardness: "hard",
    content:
      "防幻觉（数据层机制）：只有 confidenceState === \"confirmed\" 的身份库记录才能被当成既定事实渲染进开场白——" +
      "unconfirmed 的候选只出现在'待你决策'段，标明是候选；rejected 的彻底不出现在任何段落。" +
      "机制在渲染层（BRAIN.md §3 已有的红线），不是靠模型自觉。",
  },
  {
    slug: "producer-not-reviewer",
    hardness: "soft",
    content:
      "生产者≠审查者：aeloop 今天没有 Helix 那种'Cypher 写、Zorro 独立审'的角色框架，这条暂时只能是流程约定，" +
      "不是代码级隔离——如果未来引入多 agent 编排，需要重新设计怎么机制化。",
  },
  {
    slug: "postmortem",
    hardness: "soft",
    content:
      "犯错即复盘：postmortem 是 MemoryType 12 类之一，可以记录复盘条目，但'复盘后怎么修改宪法'这条闭环今天" +
      "没有自动化，靠人工。",
  },
  {
    slug: "cost-transparency",
    hardness: "soft",
    content:
      "成本透明：预计要进入高开销段（多轮返工/深调研扇出/派多个 agent）前，先向操作者说明量级并等确认；" +
      "事后如实报实际开销。不擅自为省成本牺牲复审/验证的完整性。这条是透明习惯，不是硬机制门，没有对应的" +
      "代码级拦截，完全靠自觉遵守；最后一句是关键护栏，把它和'省 token'这个价值观明确切开——省成本不能" +
      "成为跳过复审、缩水验证覆盖面的理由。",
  },
];

// ── 3. issue → active_task 映射规则 ─────────────────────────────────────────

// 优先级从高到低——同一 issue 同时挂多个 status:* label 时，取排在前面的那个（越靠后的工作流
// 阶段代表越"新"的进度，旧阶段标签没清掉更可能是疏忽）。见文件头"issue → active_task 映射"。
const STATUS_LABEL_PRECEDENCE = ["status:awaiting-commander", "status:awaiting-zorro", "status:in-progress", "status:prd-draft"];

const STATUS_LABEL_TO_TAG = Object.freeze({
  "status:awaiting-commander": "status:pending-decision",
  "status:awaiting-zorro": "status:blocked",
  "status:in-progress": "status:in-progress",
  "status:prd-draft": "status:in-progress",
});

/**
 * @param {{number:number, title:string, state:string, labels:{name:string}[]}} issue
 * @param {string} [projectTag] issue #93 B3 新增：`project:<owner>/<repo>` 形式的 tag，追加到
 *   返回数组末尾——供 `docs/conductor-brain-layer/spike/lib/status-table.mjs`（B4）按项目分组。
 *   可选（不传时行为等同 issue #88 原版，供尚未迁移调用点/旧测试过渡期使用），但 `main()` 自己
 *   的调用点（见下）总是传入这个参数，生产路径下永远带 project tag。
 * @returns {string[]} active_task 的 tags
 */
export function resolveActiveTaskTags(issue, projectTag) {
  const ghIssueTag = `gh-issue:${issue.number}`;
  const base = (() => {
    if (issue.state === "CLOSED") {
      return ["status:done", "archived", ghIssueTag];
    }
    const labelNames = new Set((issue.labels ?? []).map((l) => l.name));
    const matched = STATUS_LABEL_PRECEDENCE.find((candidate) => labelNames.has(candidate));
    const statusTag = matched ? STATUS_LABEL_TO_TAG[matched] : "status:todo";
    return [statusTag, ghIssueTag];
  })();
  return projectTag ? [...base, projectTag] : base;
}

// ── gh 拉取（可注入，默认真跑 gh CLI；命名沿用 plan.md §B8 既定的 fetchOpenIssues，虽然实际
// 拉的是 --state all——见下方 defaultFetchOpenIssues 头注释，为什么需要拉 CLOSED 的） ─────────

/**
 * 默认实现：真实调 `gh issue list`。**拉 `--state all`，不是 `--state open`**——这是对
 * plan.md §B8 原始设计（"issue 消失于 open 列表 → 打 archived"）的一处具体收紧：本轮 operator
 * 要求"closed issue 打 archived tag"，直接读 issue 自己的 `state` 字段比"这次没出现在 open
 * 列表里"更直接、更不依赖"上次跑到哪些 issue"这种隐式状态，`--limit 1000` 避免 `gh` 默认
 * 30 条截断（真实项目 issue 数可能超过默认值）。
 * @param {{owner:string, repo:string}} args
 * @returns {Promise<{number:number, title:string, state:string, labels:{name:string}[]}[]>}
 */
async function defaultFetchOpenIssues({ owner, repo }) {
  const raw = execFileSync(
    "gh",
    ["issue", "list", "--repo", `${owner}/${repo}`, "--state", "all", "--json", "number,title,labels,state", "--limit", "1000"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

// ── upsert helpers ───────────────────────────────────────────────────────────
// issue #93 B3：`findExisting()`/`tagsEqual()`/`upsertMemory()` 原样抽到
// `.claude/hooks/lib/memory-upsert.mjs`（这三个函数本来就不含 issue 特定逻辑，`scripts/
// onboard-project.mjs` 需要同一套 upsert 语义写 `project_registry` 记录，不重复实现一份）。
// 本文件改为 import 那份共享实现，行为字节级不变（`test-seed-brain-identity.mjs` 现有用例应
// 零改动继续通过）——见文件头 import。

// ── main ──────────────────────────────────────────────────────────────────

/**
 * @param {{fetchOpenIssues?: typeof defaultFetchOpenIssues, cwd?: string, taskSource?: "none"|"github"}} [opts]
 *   `taskSource` 省略时走 `resolveTaskSource({ cwd })`（真实 env/`.claude/brain.local.json` 解析，
 *   issue #103）；测试可以直接注入具体值，不依赖真实环境变量/文件系统，同 `fetchOpenIssues` 的
 *   既有注入模式。
 * @returns {Promise<{identity: object, constraints: object[], issues: object[], skippedTaskSync?: string}>}
 */
export async function main(opts = {}) {
  const { fetchOpenIssues = defaultFetchOpenIssues, cwd = REPO_ROOT } = opts;
  const taskSource = opts.taskSource ?? resolveTaskSource({ cwd });

  const { resolveIdentityDbPath } = await import(path.join(REPO_ROOT, ".claude", "hooks", "lib", "db-path.mjs"));
  const dbPath = resolveIdentityDbPath({ cwd });
  if (!dbPath) {
    const message =
      "[seed-brain-identity] 找不到身份库 dbPath——AELOOP_BRAIN_IDENTITY_DB 环境变量未设置，" +
      ".claude/brain.local.json 也不存在/没有合法的 identityDbPath 字段。" +
      "配置方式见 docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md。已中止，未写入任何数据。";
    const err = new Error(message);
    err.code = "NO_IDENTITY_DB_PATH";
    throw err;
  }

  const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));
  const store = new MemoryStore(dbPath);

  const result = { identity: null, constraints: [], issues: [] };

  try {
    // 1. 身份。
    result.identity = {
      title: IDENTITY_NAME_TITLE,
      ...upsertMemory(
        store,
        {
          type: "identity",
          title: IDENTITY_NAME_TITLE,
          content: IDENTITY_NAME_CONTENT,
          tags: [],
          confidenceState: "confirmed",
        },
        { actor: "seed-brain-identity" },
      ),
    };

    // 2. 宪法约束。
    for (const constraint of CONSTITUTION_CONSTRAINTS) {
      const title = `constraint:${constraint.slug}`;
      const outcome = upsertMemory(
        store,
        {
          type: "constraint",
          title,
          content: constraint.content,
          tags: [`hardness:${constraint.hardness}`],
          confidenceState: "confirmed",
        },
        { actor: "seed-brain-identity" },
      );
      result.constraints.push({ slug: constraint.slug, title, ...outcome });
    }

    // 3. 在途任务来源（issue #103：taskSource !== "github" 时整个途③物理跳过——不反查
    //    owner/repo、不检查项目注册、不调 gh，见文件头注释"issue #103：在途任务来源 gate"）。
    if (taskSource !== "github") {
      result.skippedTaskSync =
        '未配置在途任务来源（AELOOP_BRAIN_TASK_SOURCE 未设为 "github"），按设计跳过——' +
        "身份 + 宪法约束已正常写入，不受影响。";
    } else {
      // owner/repo 判不出时明确跳过，不静默假装同步过。
      const { getOriginOwnerRepo } = await import(path.join(REPO_ROOT, ".claude", "hooks", "lib", "git-remote.mjs"));
      const origin = getOriginOwnerRepo(cwd);
      if (!origin.ok) {
        result.skippedTaskSync = "无法从 cwd 判定 owner/repo（非 git 目录 / 无 origin remote），跳过 issue 同步。";
      } else {
        const projectTag = projectTagFor(origin.owner, origin.repo);

        // issue #93 B3：目标项目必须先被 `scripts/onboard-project.mjs` 注册（存在对应
        // `project_registry` 记录），否则明确报错、不进入 issue 同步循环——不静默写入孤儿
        // `project:*` tag（PRD §4.4）。注意：这条检查只挡住途③的 issue 同步，不影响途①②已经
        // 写完的身份/宪法约束（PRD §4.4 明确"在这一步 return/throw，不进入 issue 同步循环"）。
        // 判据本身抽到 `.claude/hooks/lib/project-registry.mjs`（issue #93 B5 顺手抽出，供
        // `scripts/dispatch-brain-task.mjs` 复用同一份，不各写一份，PRD §4.6 已定的共享方式）。
        assertProjectRegistered(store, origin.owner, origin.repo);

        // issue #96（Zorro/Codex 跨模型二签 2026-07-23 FAIL 后补齐，🟡 项1）：`fetchOpenIssues()`
        // 调用点此前没有任何错误处理——`gh` CLI 缺失（ENOENT）/未登录/网络失败等，会让整个
        // `main()` 抛错冒泡到顶层 `.catch()`，进程以非零 exit code 中止。真实后果比看起来更糟：
        // 途①②（身份+宪法约束）此时已经写进 store 了，只是途③（issue 同步）失败——一个"部分
        // 成功但报错退出"的状态，容易被误读成"整个 seed 都没生效"。改成优雅降级：只包这一个调用
        // 点（不改 `assertProjectRegistered()` 等其它任何错误路径的语义——项目未注册仍然是真实
        // 应该中止的错误，继续抛错，这是本次改动明确限定的范围），失败时记 `skippedTaskSync`、
        // `issues` 退化成空数组，`main()` 正常返回、进程 exit 0——身份/宪法已经种下这个事实不该
        // 被一个和它无关的 issue 同步失败连累成"看起来整体失败了"。
        let issues;
        try {
          issues = await fetchOpenIssues({ owner: origin.owner, repo: origin.repo });
        } catch (err) {
          result.skippedTaskSync =
            `gh CLI 不可用（未安装/未登录/调用失败），已跳过 issue 在途同步——身份 + 宪法约束已正常` +
            `写入，不受影响。原始错误：${err?.message ?? String(err)}`;
          issues = [];
        }
        for (const issue of issues) {
          const tags = resolveActiveTaskTags(issue, projectTag);
          const outcome = upsertMemory(
            store,
            {
              type: "active_task",
              title: issue.title,
              content: `#${issue.number}`,
              tags,
              confidenceState: "confirmed",
              matchTag: `gh-issue:${issue.number}`, // 按稳定的 issue 号匹配，不按会变的标题（见 memory-upsert.mjs 头注释）
            },
            { actor: "seed-brain-identity" },
          );
          result.issues.push({ number: issue.number, tags, ...outcome });
        }
      }
    }
  } finally {
    store.close();
  }

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      const summarize = (list) => {
        const counts = { inserted: 0, unchanged: 0, "content-updated": 0, replaced: 0 };
        for (const item of list) counts[item.action] = (counts[item.action] ?? 0) + 1;
        return counts;
      };
      console.log("[seed-brain-identity] 身份：", result.identity.action);
      console.log("[seed-brain-identity] 宪法约束：", summarize(result.constraints), `（共 ${result.constraints.length} 条）`);
      if (result.skippedTaskSync) {
        console.log(`[seed-brain-identity] 在途任务同步已跳过：${result.skippedTaskSync}`);
      } else {
        console.log("[seed-brain-identity] 在途任务：", summarize(result.issues), `（共 ${result.issues.length} 条）`);
      }
    })
    .catch((err) => {
      console.error(err.message ?? String(err));
      process.exitCode = 1;
    });
}
