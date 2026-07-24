// test-seed-brain-identity.mjs — issue #88 B8 单元测试：seed-brain-identity.mjs（issue #93 B3
// 新增：目标项目必须先注册 + project:* tag 传播的用例）。
//
// 覆盖 plan.md §B8："注入假 fetchOpenIssues，覆盖 DESIGN §3.c 全部 5 种映射；二次运行零调用
// 验证；issue 消失 → archived tag"，加上本轮 operator 明确要求的：closed issue 直接判定
// archived（不是靠"消失"推断）、无 DB 路径明确报错、多 status label 优先级、issue 改标题的
// 幂等匹配（按 gh-issue tag，不按 title）。
// 覆盖 docs/conductor-brain-multiproject/PRD.md §6.4："目标项目未注册 → 明确报错，零写入；
// 目标项目已注册 → 全部 active_task 的 tags 含正确的 project:<owner>/<repo>；二次运行真幂等"。
//
// 跑法：node scripts/test-seed-brain-identity.mjs（需要先 pnpm run build 生成 dist/，需要
// git CLI；不需要真实网络/gh 登录——fetchOpenIssues 全程用注入的 stub，不调真实 gh）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const { main, CONSTITUTION_CONSTRAINTS, resolveActiveTaskTags } = await import("./seed-brain-identity.mjs");
const { upsertMemory } = await import("../.claude/hooks/lib/memory-upsert.mjs");
const { MemoryStore } = await import(join(REPO_ROOT, "dist", "context", "store.js"));

// 独立临时 git 仓库（带假 origin，供 getOriginOwnerRepo 用）+ 独立临时身份库，全程不碰真实
// 仓库/真实身份库（test-hygiene，同 B5/B6 既定修法）。
const TEST_REPO = mkdtempSync(join(tmpdir(), "brain-test-seed-repo-"));
execFileSync("git", ["init", "-q", TEST_REPO]);
execFileSync("git", ["-C", TEST_REPO, "remote", "add", "origin", "git@github.com:testowner/testrepo.git"]);
const TEST_PROJECT_TAG = "project:testowner/testrepo";

const DB_DIR = mkdtempSync(join(tmpdir(), "brain-test-seed-db-"));
const DB_PATH = join(DB_DIR, "identity.db");

const ORIGINAL_ENV_DB = process.env.AELOOP_BRAIN_IDENTITY_DB;

function stubIssues() {
  // 覆盖全部 5 种 status 映射 + closed。number 故意不连续，验证不依赖顺序假设。
  return [
    { number: 10, title: "issue in-progress", state: "OPEN", labels: [{ name: "status:in-progress" }] },
    { number: 20, title: "issue prd-draft", state: "OPEN", labels: [{ name: "status:prd-draft" }] },
    { number: 30, title: "issue awaiting-zorro", state: "OPEN", labels: [{ name: "status:awaiting-zorro" }] },
    { number: 40, title: "issue awaiting-commander", state: "OPEN", labels: [{ name: "status:awaiting-commander" }] },
    { number: 50, title: "issue no status label", state: "OPEN", labels: [{ name: "enhancement" }] },
    { number: 60, title: "issue closed", state: "CLOSED", labels: [{ name: "status:in-progress" }] },
  ];
}

function readAll() {
  const store = new MemoryStore(DB_PATH);
  const all = store.listMemories();
  store.close();
  return all;
}

function findByGhIssueTag(all, n) {
  return all.find((m) => m.type === "active_task" && m.tags.includes(`gh-issue:${n}`)) ?? null;
}

try {
  // ── ① 无 DB 路径 → 明确报错退出，不静默 ──────────────────────────────────
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    await assert.rejects(
      () => main({ cwd: TEST_REPO, fetchOpenIssues: async () => [] }),
      (err) => {
        assert.equal(err.code, "NO_IDENTITY_DB_PATH");
        assert.match(err.message, /找不到身份库/);
        return true;
      },
      "无 DB 路径应显式抛错退出，不是静默跳过",
    );
  }

  process.env.AELOOP_BRAIN_IDENTITY_DB = DB_PATH;

  // ── ②a（issue #93 B3）目标项目尚未注册 → main() 明确报错，issue 同步零写入
  //     （身份/宪法约束仍正常写入，不受影响——见 PRD §4.4"这条检查只挡 issue 同步"）。
  {
    await assert.rejects(
      () => main({ cwd: TEST_REPO, fetchOpenIssues: async () => stubIssues(), taskSource: "github" }),
      (err) => {
        assert.equal(err.code, "PROJECT_NOT_ONBOARDED");
        assert.match(err.message, /尚未注册/);
        assert.match(err.message, /onboard-project\.mjs/);
        return true;
      },
      "目标项目未注册时应明确报错，不静默写入孤儿 project:* tag",
    );
    const all = readAll();
    assert.equal(
      all.filter((m) => m.type === "active_task").length,
      0,
      "未注册时不该产生任何 active_task 记录",
    );
    // 身份/宪法约束应该已经正常写入（这条检查只挡途③ issue 同步，不影响途①②）。
    assert.ok(all.some((m) => m.type === "identity"), "身份应已正常写入，不受 issue 同步被挡影响");
  }

  // ── 注册目标项目（issue #93 B2 onboard-project.mjs 的同款语义，直接用共享 upsertMemory
  //     构造，不额外起子进程调 CLI——本文件测的是 seed 脚本，onboard 本身有自己的
  //     test-onboard-project.mjs） ──────────────────────────────────────────────
  {
    const store = new MemoryStore(DB_PATH);
    try {
      upsertMemory(
        store,
        {
          type: "project_registry",
          title: TEST_PROJECT_TAG,
          content: "testowner/testrepo",
          tags: [TEST_PROJECT_TAG],
          confidenceState: "confirmed",
        },
        { actor: "test-fixture" },
      );
    } finally {
      store.close();
    }
  }

  // ── ② 首次运行（已注册）：身份 + 全部宪法约束 + 全部 5 种 status 映射 + closed→archived
  //     + 每条 active_task 都带正确的 project:<owner>/<repo> tag ──────────────────
  {
    const result = await main({ cwd: TEST_REPO, fetchOpenIssues: async () => stubIssues(), taskSource: "github" });

    assert.equal(result.identity.action, "unchanged", "身份在②a 已经写过，这里应 unchanged");
    assert.ok(
      result.constraints.every((c) => c.action === "unchanged"),
      "宪法约束在②a 已经写过，这里应 unchanged",
    );
    assert.equal(result.issues.length, 6, "应处理全部 6 条 stub issue");
    assert.ok(!result.skippedTaskSync, "有合法 origin 时不该跳过 issue 同步");

    const all = readAll();

    // 身份。
    const identity = all.find((m) => m.type === "identity" && m.title === "identity:name");
    assert.ok(identity, "应写入 identity:name 记录");
    assert.equal(identity.content, "你的 AI 调度员");
    assert.equal(identity.confidenceState, "confirmed");

    // 宪法约束——每条都应存在，hardness tag 齐全。
    for (const c of CONSTITUTION_CONSTRAINTS) {
      const memory = all.find((m) => m.type === "constraint" && m.title === `constraint:${c.slug}`);
      assert.ok(memory, `constraint:${c.slug} 应存在`);
      assert.ok(memory.tags.includes(`hardness:${c.hardness}`), `constraint:${c.slug} 应带 hardness:${c.hardness} tag`);
      assert.equal(memory.confidenceState, "confirmed");
    }

    // 5 种 status 映射（DESIGN §3.c 映射表）——issue #93 B3：每条都追加了 project:* tag。
    assert.deepEqual(findByGhIssueTag(all, 10).tags.sort(), ["gh-issue:10", "status:in-progress", TEST_PROJECT_TAG].sort(), "status:in-progress 应映射为 status:in-progress + project tag");
    assert.deepEqual(findByGhIssueTag(all, 20).tags.sort(), ["gh-issue:20", "status:in-progress", TEST_PROJECT_TAG].sort(), "status:prd-draft 应映射为 status:in-progress + project tag");
    assert.deepEqual(findByGhIssueTag(all, 30).tags.sort(), ["gh-issue:30", "status:blocked", TEST_PROJECT_TAG].sort(), "status:awaiting-zorro 应映射为 status:blocked + project tag");
    assert.deepEqual(findByGhIssueTag(all, 40).tags.sort(), ["gh-issue:40", "status:pending-decision", TEST_PROJECT_TAG].sort(), "status:awaiting-commander 应映射为 status:pending-decision + project tag");
    assert.deepEqual(findByGhIssueTag(all, 50).tags.sort(), ["gh-issue:50", "status:todo", TEST_PROJECT_TAG].sort(), "无 status:* label 应映射为 status:todo + project tag");

    // closed → archived（直接判 state，不是"消失"推断）+ project tag。
    const closedMemory = findByGhIssueTag(all, 60);
    assert.deepEqual(closedMemory.tags.sort(), ["archived", "gh-issue:60", "status:done", TEST_PROJECT_TAG].sort(), "closed issue 应打 archived + status:done + project tag");
  }

  // ── ③ 幂等：完全相同输入二次运行 → 零写入（DB 状态逐条比对不变） ──────────────
  {
    const before = readAll()
      .map((m) => ({ id: m.id, type: m.type, title: m.title, content: m.content, tags: [...m.tags].sort(), updatedAt: m.updatedAt }))
      .sort((a, b) => a.id - b.id);

    const result = await main({ cwd: TEST_REPO, fetchOpenIssues: async () => stubIssues(), taskSource: "github" });

    assert.equal(result.identity.action, "unchanged", "二次运行身份应 unchanged");
    assert.ok(
      result.constraints.every((c) => c.action === "unchanged"),
      "二次运行全部宪法约束应 unchanged",
    );
    assert.ok(
      result.issues.every((i) => i.action === "unchanged"),
      "二次运行全部 issue 应 unchanged",
    );

    const after = readAll()
      .map((m) => ({ id: m.id, type: m.type, title: m.title, content: m.content, tags: [...m.tags].sort(), updatedAt: m.updatedAt }))
      .sort((a, b) => a.id - b.id);

    assert.deepEqual(after, before, "完全相同输入二次运行后，DB 状态应逐字节不变（同 id、同 updatedAt、无新增/删除行）");
  }

  // ── ④ 内容变化（issue 标题改了，issue 号不变）→ content-updated 或 replaced，
  //     按 gh-issue tag 匹配而不是按 title 匹配，不产生孤儿/重复行 ────────────────
  {
    const beforeCount = readAll().length;
    const renamed = stubIssues();
    renamed[0] = { ...renamed[0], title: "issue in-progress（改过标题）" }; // #10 标题变了，号不变

    const result = await main({ cwd: TEST_REPO, fetchOpenIssues: async () => renamed, taskSource: "github" });
    const outcome10 = result.issues.find((i) => i.number === 10);
    assert.equal(outcome10.action, "replaced", "title 变化需要删除重建（title 也没有对应的 update 方法）");

    const all = readAll();
    const afterCount = all.length;
    assert.equal(afterCount, beforeCount, "改标题不该产生孤儿/重复行——总记录数应不变");
    const memory10 = findByGhIssueTag(all, 10);
    assert.equal(memory10.title, "issue in-progress（改过标题）", "记录的 title 应更新成新标题");
    assert.equal(all.filter((m) => m.tags.includes("gh-issue:10")).length, 1, "不该有第二条挂着 gh-issue:10 的记录");
  }

  // ── ⑤ 状态变化（issue 从 in-progress 变成 closed）→ tags 变化，replaced，仍按
  //     gh-issue tag 精确匹配到同一条 ─────────────────────────────────────────
  {
    const beforeCount = readAll().length;
    const nowClosed = stubIssues();
    nowClosed[0] = { ...nowClosed[0], state: "CLOSED" }; // #10 关闭了

    const result = await main({ cwd: TEST_REPO, fetchOpenIssues: async () => nowClosed, taskSource: "github" });
    const outcome10 = result.issues.find((i) => i.number === 10);
    assert.equal(outcome10.action, "replaced", "状态变化（tags 变化）应触发 replaced");

    const all = readAll();
    assert.equal(all.length, beforeCount, "状态变化不该产生额外行");
    const memory10 = findByGhIssueTag(all, 10);
    assert.ok(memory10.tags.includes("archived"), "变成 closed 后应带上 archived tag");
  }

  // ── ⑥ 多个 status:* label 同时存在 → 取优先级最高的（awaiting-commander 系列） ──
  {
    const multiLabelIssue = {
      number: 999,
      title: "multi-label issue",
      state: "OPEN",
      labels: [{ name: "status:prd-draft" }, { name: "status:in-progress" }],
    };
    const tags = resolveActiveTaskTags(multiLabelIssue);
    assert.ok(tags.includes("status:in-progress"), "status:in-progress 优先级高于 status:prd-draft，应命中前者");

    const multiLabelIssue2 = {
      number: 998,
      title: "multi-label issue 2",
      state: "OPEN",
      labels: [{ name: "status:awaiting-commander" }, { name: "status:in-progress" }],
    };
    const tags2 = resolveActiveTaskTags(multiLabelIssue2);
    assert.ok(tags2.includes("status:pending-decision"), "status:awaiting-commander 优先级最高，应命中它而不是 in-progress");
  }

  // ── ⑦ 无 origin remote（非 git 目录或无 origin）→ skippedTaskSync，不假装同步过，
  //     且 fetchOpenIssues 根本不该被调用（不该浪费一次不会被用到的调用） ────────────
  {
    const bareDir = mkdtempSync(join(tmpdir(), "brain-test-seed-bare-"));
    execFileSync("git", ["init", "-q", bareDir]); // 没有 origin remote
    let fetchCalled = false;
    const result = await main({
      cwd: bareDir,
      fetchOpenIssues: async () => {
        fetchCalled = true;
        return [];
      },
      taskSource: "github",
    });
    assert.ok(result.skippedTaskSync, "无 origin remote 时应设置 skippedTaskSync，不假装同步过");
    assert.equal(fetchCalled, false, "无 origin remote 时不该调用 fetchOpenIssues");
    rmSync(bareDir, { recursive: true, force: true });
  }

  // ── ⑧（issue #96，Zorro/Codex 跨模型二签 2026-07-23 FAIL 后补齐，🟡 项1）：`gh` CLI 不可用
  //     （缺失/未登录/调用失败）时，`fetchOpenIssues()` 抛错——此前会让整个 main() 拒绝、进程以
  //     非零 exit code 中止（哪怕身份+宪法约束途①②已经写完）。现在应该优雅降级：main() 正常
  //     resolve，`skippedTaskSync` 记下原因，`issues` 退化成空数组，不影响已经写完的身份/
  //     宪法约束 ────────────────────────────────────────────────────────────────
  {
    const simulatedGhError = new Error("spawnSync gh ENOENT"); // 真实 gh 缺失时 execFileSync 抛的错误形状
    simulatedGhError.code = "ENOENT";

    const result = await main({
      cwd: TEST_REPO,
      fetchOpenIssues: async () => {
        throw simulatedGhError;
      },
      taskSource: "github",
    });

    assert.ok(result.skippedTaskSync, "gh 调用失败时应设置 skippedTaskSync，不该让 main() 整体拒绝");
    assert.match(result.skippedTaskSync, /gh CLI 不可用/, "skippedTaskSync 措辞应说明是 gh 不可用，不是别的原因");
    assert.match(result.skippedTaskSync, /ENOENT/, "skippedTaskSync 应带上原始错误信息，方便排查");
    assert.deepEqual(result.issues, [], "gh 调用失败时 issues 应退化成空数组，不是抛出未捕获异常");
    assert.equal(result.identity.action, "unchanged", "gh 失败不该影响已经写完的身份记录");
    assert.ok(
      result.constraints.every((c) => c.action === "unchanged"),
      "gh 失败不该影响已经写完的宪法约束",
    );

    // 双重确认：DB 里身份/宪法约束记录确实还在，不是"结果对象说没受影响，但库其实被清空了"这种
    // 表里不一。
    const all = readAll();
    assert.ok(all.some((m) => m.type === "identity"), "gh 失败后身份记录应仍然存在于库里");
    assert.equal(
      all.filter((m) => m.type === "constraint").length,
      CONSTITUTION_CONSTRAINTS.length,
      "gh 失败后全部宪法约束记录应仍然存在于库里",
    );
  }

  // ── ⑨（issue #103）taskSource !== "github" → 整个途③物理跳过：不反查 owner/repo、不检查
  //     项目注册、fetchOpenIssues 根本不该被调用——即便目标是一个"未注册"的仓库（②a 用的同一个
  //     TEST_REPO，此时其实已经在②a之后注册过了，所以额外验证一个从未注册、也没有 origin
  //     remote 的全新 bare repo，证明 taskSource:"none" 时这些前置检查压根不会被触发，不是
  //     "触发了但恰好通过"） ──────────────────────────────────────────────────────
  {
    const bareDir9 = mkdtempSync(join(tmpdir(), "brain-test-seed-tasksource-none-"));
    // 故意不 git init——taskSource:"none" 时不该反查 origin，这个目录甚至不是 git 仓库也该
    // 正常跑完（如果实现漏掉了 gate，getOriginOwnerRepo() 会在这里真的报错/返回 not-ok，
    // 暴露出"其实还是走到了 origin 反查这一步"）。
    let fetchCalled9 = false;
    const result9 = await main({
      cwd: bareDir9,
      fetchOpenIssues: async () => {
        fetchCalled9 = true;
        return stubIssues();
      },
      taskSource: "none",
    });
    assert.ok(result9.skippedTaskSync, "taskSource:none 时应设置 skippedTaskSync");
    assert.match(result9.skippedTaskSync, /未配置在途任务来源/, "skippedTaskSync 措辞应说明是未配置来源，不是别的原因（比如 gh 失败/无 origin）");
    assert.equal(fetchCalled9, false, "taskSource:none 时 fetchOpenIssues 根本不该被调用");
    assert.deepEqual(result9.issues, [], "taskSource:none 时 issues 应是空数组");
    assert.ok(result9.identity, "taskSource:none 时身份仍应正常写入，途①②不受影响");
    assert.equal(result9.constraints.length, CONSTITUTION_CONSTRAINTS.length, "taskSource:none 时宪法约束仍应正常写入");
    rmSync(bareDir9, { recursive: true, force: true });
  }

  // ── ⑩（issue #103）省略 taskSource（不传 opts.taskSource）→ 应等同 resolveTaskSource() 的
  //     真实解析结果——测试进程没有设置 AELOOP_BRAIN_TASK_SOURCE，且 TEST_REPO 没有
  //     `.claude/brain.local.json`，所以应该落到默认值 "none"，行为和显式传 "none" 一致 ──────
  {
    const originalTaskSourceEnv = process.env.AELOOP_BRAIN_TASK_SOURCE;
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    try {
      let fetchCalled10 = false;
      const result10 = await main({
        cwd: TEST_REPO,
        fetchOpenIssues: async () => {
          fetchCalled10 = true;
          return stubIssues();
        },
        // 不传 taskSource——依赖 main() 内部 resolveTaskSource({ cwd }) 的真实解析。
      });
      assert.ok(result10.skippedTaskSync, "省略 taskSource 时应默认落到 none 分支，设置 skippedTaskSync");
      assert.equal(fetchCalled10, false, "省略 taskSource 时不该调用 fetchOpenIssues（默认 none）");
    } finally {
      if (originalTaskSourceEnv === undefined) delete process.env.AELOOP_BRAIN_TASK_SOURCE;
      else process.env.AELOOP_BRAIN_TASK_SOURCE = originalTaskSourceEnv;
    }
  }

  console.log("PASS: test-seed-brain-identity.mjs (issue #88 B8 — 幂等 upsert + 5种status映射 + closed→archived + 无DB路径报错 + 改标题不产生孤儿 + 多label优先级 + 无origin跳过 + issue #96 gh失败优雅降级 + issue #103 taskSource gate：none 时整个途③物理跳过 + 省略时默认 none)");
} finally {
  if (ORIGINAL_ENV_DB === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
  else process.env.AELOOP_BRAIN_IDENTITY_DB = ORIGINAL_ENV_DB;
  rmSync(TEST_REPO, { recursive: true, force: true });
  rmSync(DB_DIR, { recursive: true, force: true });
}
