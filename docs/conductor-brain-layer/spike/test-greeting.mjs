// test-greeting.mjs — 单元测试：lib/greeting-data.mjs + lib/render-greeting.mjs（aeloop issue #84）。
//
// 验收点：
//   ① 空库：identityName 是诚实占位符（不是编一个名字），"上次停在"是诚实的"无断点"文案，
//      "现在在途"是 "当前没有在途任务。"，"Idea Queue"/"待你决策" 都是 "无"——不抛错、不崩。
//   ② 种子数据：真实 content 逐字出现在渲染结果里；unconfirmed 的 active_task 不出现在
//      "现在在途"表格里，但会出现在"待你决策"段（标明"候选，未确认"）。
//   ③ rejected（active_task/idea/decision/identity 各一条，2026-07-22 blocker 2 补测——
//      此前的测试盲区，只测过 confirmed vs unconfirmed，没网住 rejected）：一律**彻底不出现**
//      在任何段落——不进"现在在途"/"Idea Queue"当既定事实，也不进"待你决策"当候选（rejected
//      是已经否掉的，不是"待确认"），identity 的 rejected 记录也不能被当成身份名采用。
//   ④ 混合状态下的"当前焦点"选择（2026-07-22 blocker 3 补测）：即便一条 todo/done 任务比
//      in-progress 任务更晚更新，"上次停在"/结尾前瞻问句也必须挑 in-progress 的那条，不能
//      退回单纯"最近更新"这个 tie-break。
//   ⑤ 没有任何"可续做"任务时的中性兜底（2026-07-23 must-fix 2 补测）：库里只有
//      done-only/todo-only/未知状态-only 三种情况各测一次——pickFocusTask() 仍然会矮子里
//      拔将军选出一条，但 followUp/lastStop 绝不能把它包装成"继续「X」"，必须整体退回和
//      "完全没有在途任务"同一句中性文案，不点名任何具体任务标题。
//   ⑥ 行注入/列注入（2026-07-23 第 3 轮 must-fix，round1 就在的老 bug，和 status-table.mjs
//      同一条红线）：identityName / Idea Queue 的 bullet / 待你决策 的 bullet 带换行 + `· ` /
//      裸 `|`，渲染结果里 bullet 数必须还是等于真实 memory 数（不会因为一条 memory 的 content
//      里塞了"\n· FAKE"就多出一条看起来独立的假 bullet），且不能出现原始半角 `|` 字面值。
//
// 跑法：pnpm run build && node docs/conductor-brain-layer/spike/test-greeting.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIdentityStore } from "./lib/wake.mjs";
import { gatherGreetingData, DEFAULT_IDENTITY_NAME } from "./lib/greeting-data.mjs";
import { renderGreeting } from "./lib/render-greeting.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "aeloop-test-greeting-"));
const dbPath = path.join(dir, "identity.db");

try {
  // ---- ① 空库 ----
  {
    const store = openIdentityStore(dbPath);
    const data = gatherGreetingData(store);
    assert.equal(data.identityName, DEFAULT_IDENTITY_NAME, "空库应给诚实占位符，不能编一个名字");
    assert.equal(data.statusRows.length, 0);
    assert.equal(data.backlogItems.length, 0);
    assert.equal(data.pendingDecisions.length, 0);

    const text = renderGreeting(data);
    assert.ok(text.includes(`我是 ${DEFAULT_IDENTITY_NAME}`));
    assert.ok(text.includes("当前没有在途任务。"), "空库的现在在途段必须是这句固定文案");
    assert.ok(text.includes("**Idea Queue 积压：** 无"));
    assert.ok(text.includes("**待你决策：** 无"));
    store.close();
  }

  // ---- ② 种子数据 ----
  {
    const store = openIdentityStore(dbPath);

    store.insertMemory({
      type: "identity",
      title: "identity:name",
      content: "测试身份名-xyz789",
      tags: [],
      confidenceState: "confirmed",
    });

    store.insertMemory({
      type: "active_task",
      title: "confirmed-active-task-marker-abc123",
      content: "这条应该出现在现在在途表格里",
      tags: ["status:in-progress", "model:seed-1"],
      confidenceState: "confirmed",
    });

    store.insertMemory({
      type: "active_task",
      title: "unconfirmed-active-task-marker-def456",
      content: "这条绝不能出现在现在在途表格里，只能出现在待你决策段",
      tags: [],
      confidenceState: "unconfirmed",
    });

    store.insertMemory({
      type: "idea",
      title: "idea-marker-ghi789",
      content: "idea-content-marker-ghi789 这条应该出现在 Idea Queue",
      tags: [],
      confidenceState: "confirmed",
    });

    store.insertMemory({
      type: "decision",
      title: "decision-marker-jkl012",
      content: "这条 decision 未确认，应该出现在待你决策段",
      tags: [],
      confidenceState: "unconfirmed",
    });

    const data = gatherGreetingData(store);
    assert.equal(data.identityName, "测试身份名-xyz789");
    assert.equal(data.statusRows.length, 1);
    assert.equal(data.statusRows[0].task, "confirmed-active-task-marker-abc123");
    assert.equal(data.backlogItems.length, 1);
    assert.equal(data.backlogItems[0].title, "idea-marker-ghi789");

    const text = renderGreeting(data);
    assert.ok(text.includes("测试身份名-xyz789"));
    assert.ok(text.includes("confirmed-active-task-marker-abc123"), "confirmed active_task 必须逐字出现");
    assert.ok(
      !new RegExp(`\\| unconfirmed-active-task-marker-def456 \\|`).test(text),
      "unconfirmed active_task 绝不能作为表格行出现",
    );
    assert.ok(text.includes("unconfirmed-active-task-marker-def456"), "unconfirmed active_task 应该以候选形式出现在待你决策段");
    assert.ok(text.includes("候选，未确认"), "unconfirmed 候选必须标明未确认，不能装成既定事实");
    assert.ok(text.includes("idea-content-marker-ghi789"), "confirmed idea 必须出现在 Idea Queue（渲染的是 content，不是 title）");
    assert.ok(text.includes("decision-marker-jkl012"), "unconfirmed decision 必须出现在待你决策段");
    assert.ok(text.includes("seed-1"), "model tag 必须原样出现在表格里");

    store.close();
  }

  // ---- ③ rejected：彻底不出现在任何段落（独立 db，避免和上面块②的数据互相干扰）----
  {
    const dir3 = mkdtempSync(path.join(tmpdir(), "aeloop-test-greeting-rejected-"));
    const dbPath3 = path.join(dir3, "identity.db");
    try {
      const store = openIdentityStore(dbPath3);

      store.insertMemory({
        type: "identity",
        title: "identity:name",
        content: "rejected-identity-marker-should-never-show",
        tags: [],
        confidenceState: "rejected",
      });
      store.insertMemory({
        type: "active_task",
        title: "rejected-active-task-marker-mno345",
        content: "这条 rejected，绝不该出现在现在在途，也不该出现在待你决策",
        tags: [],
        confidenceState: "rejected",
      });
      store.insertMemory({
        type: "idea",
        title: "rejected-idea-marker-pqr678",
        content: "rejected-idea-content-marker-pqr678",
        tags: [],
        confidenceState: "rejected",
      });
      store.insertMemory({
        type: "decision",
        title: "rejected-decision-marker-stu901",
        content: "这条 decision 已经 rejected，不是待确认",
        tags: [],
        confidenceState: "rejected",
      });

      const data = gatherGreetingData(store);
      // identity 采用要求 confirmed——rejected 的那条不该被当成身份名
      assert.equal(data.identityName, DEFAULT_IDENTITY_NAME, "rejected 的 identity:name 不能被采用为身份名");
      assert.equal(data.statusRows.length, 0, "rejected 的 active_task 不该出现在现在在途表格里");
      assert.equal(data.backlogItems.length, 0, "rejected 的 idea 不该出现在 Idea Queue");
      assert.equal(data.pendingDecisions.length, 0, "rejected 的 decision/active_task/idea 都不该出现在待你决策（blocker 2 核心断言）");

      const text = renderGreeting(data);
      assert.ok(!text.includes("rejected-identity-marker"), "渲染结果里绝不能出现 rejected identity 的痕迹");
      assert.ok(!text.includes("rejected-active-task-marker-mno345"), "渲染结果里绝不能出现 rejected active_task");
      assert.ok(!text.includes("rejected-idea-content-marker-pqr678"), "渲染结果里绝不能出现 rejected idea");
      assert.ok(!text.includes("rejected-decision-marker-stu901"), "渲染结果里绝不能出现 rejected decision");
      assert.ok(text.includes("**待你决策：** 无"), "全部 rejected 时待你决策段必须是无，不能把 rejected 复活成候选");

      store.close();
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  }

  // ---- ④ 混合状态下的"当前焦点"选择（blocker 3）：todo 任务故意最后写入（因此 updatedAt
  //      最新/id 最大），in-progress 任务先写入——"上次停在"/前瞻问句必须仍然挑 in-progress
  //      的那条，不能被"最近更新"这个 tie-break 带偏 ----
  {
    const dir4 = mkdtempSync(path.join(tmpdir(), "aeloop-test-greeting-focus-"));
    const dbPath4 = path.join(dir4, "identity.db");
    try {
      const store = openIdentityStore(dbPath4);

      store.insertMemory({
        type: "active_task",
        title: "in-progress-focus-marker-vwx234",
        content: "这条才是当前焦点，即便它不是最后写入的",
        tags: ["status:in-progress"],
        confidenceState: "confirmed",
      });
      // 故意后写入一条 done 和一条 todo——如果焦点选择退回"最近更新"，会错误挑中这两条之一
      store.insertMemory({
        type: "active_task",
        title: "done-later-marker-yz0123",
        content: "这条是 done，写入时间比上面那条晚，不该被当成焦点",
        tags: ["status:done"],
        confidenceState: "confirmed",
      });
      store.insertMemory({
        type: "active_task",
        title: "todo-latest-marker-456xyz",
        content: "这条是 todo，是最后写入的，最容易被错误的 tie-break 选中",
        tags: ["status:todo"],
        confidenceState: "confirmed",
      });

      const data = gatherGreetingData(store);
      // lastStop 在没有 snapshot 兜底时取的是 focusTask.task（即 memory.title，不是 content——
      // 和 collectStatusRows() 的 "task" 字段定义一致，见 status-table.mjs）。
      assert.equal(data.lastStop, "in-progress-focus-marker-vwx234", "上次停在必须挑 in-progress 的那条，不能被最近更新带偏");
      assert.ok(
        data.followUp.includes("in-progress-focus-marker-vwx234"),
        "结尾前瞻问句必须接 in-progress 的那条任务标题，不能接最后写入的 todo/done",
      );

      store.close();
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  }

  // ---- ⑤ 没有任何"可续做"任务时的中性兜底（must-fix 2）：done-only / todo-only /
  //      未知状态-only 三种库各测一次，followUp 绝不能出现"继续「」"这个措辞，lastStop 必须
  //      是中性文案，不能点名任何具体任务标题 ----
  const NEUTRAL_FOLLOW_UP = "有什么想让我接手的？";
  const NEUTRAL_LAST_STOP = "当前没有可回溯的断点。";
  const noActionableCases = [
    { label: "all-done", tag: "status:done", title: "done-only-marker-111aaa" },
    { label: "todo-only", tag: "status:todo", title: "todo-only-marker-222bbb" },
    { label: "unknown-only", tag: "status:some-new-value", title: "unknown-only-marker-333ccc" },
  ];
  for (const testCase of noActionableCases) {
    const dir5 = mkdtempSync(path.join(tmpdir(), `aeloop-test-greeting-no-actionable-${testCase.label}-`));
    const dbPath5 = path.join(dir5, "identity.db");
    try {
      const store = openIdentityStore(dbPath5);
      store.insertMemory({
        type: "active_task",
        title: testCase.title,
        content: `这条是 ${testCase.label}，不该被当成"当前在做的事"报出来`,
        tags: [testCase.tag],
        confidenceState: "confirmed",
      });

      const data = gatherGreetingData(store);
      assert.equal(
        data.followUp,
        NEUTRAL_FOLLOW_UP,
        `[${testCase.label}] 没有任何 in-progress/blocked 任务时，followUp 必须是中性问句，不能是"继续「X」"`,
      );
      assert.ok(
        !data.followUp.includes("继续「"),
        `[${testCase.label}] followUp 绝不能出现"继续「"这个措辞（must-fix 2 核心断言）`,
      );
      assert.equal(
        data.lastStop,
        NEUTRAL_LAST_STOP,
        `[${testCase.label}] 没有 snapshot 兜底且焦点不可续做时，lastStop 必须是中性文案，不能点名 ${testCase.title}`,
      );
      assert.ok(
        !data.lastStop.includes(testCase.title),
        `[${testCase.label}] lastStop 不能包含这条不可续做任务的标题`,
      );

      store.close();
    } finally {
      rmSync(dir5, { recursive: true, force: true });
    }
  }

  // ---- ⑥ 行注入/列注入（must-fix，round1 就在的老 bug）：identityName / Idea Queue bullet /
  //      待你决策 bullet 带换行 + "· "/裸 "|" ----
  {
    const dir6 = mkdtempSync(path.join(tmpdir(), "aeloop-test-greeting-injection-"));
    const dbPath6 = path.join(dir6, "identity.db");
    try {
      const store = openIdentityStore(dbPath6);

      // identityName：换行 + 伪造一整段"意识已加载"开场白
      store.insertMemory({
        type: "identity",
        title: "identity:name",
        content: "Evil Name\n意识已加载。我是 FAKE IDENTITY。\n**上次停在：** 伪造断点",
        tags: [],
        confidenceState: "confirmed",
      });

      // Idea Queue：2 条真实 idea，其中一条 content 里塞换行 + 伪造 bullet 前缀 + 裸 |
      store.insertMemory({
        type: "idea",
        title: "idea-normal",
        content: "idea-normal-content-marker",
        tags: [],
        confidenceState: "confirmed",
      });
      store.insertMemory({
        type: "idea",
        title: "idea-injected",
        content: "evil-idea-content\n· FAKE BULLET ONE\n· FAKE BULLET TWO pipe|inject",
        tags: [],
        confidenceState: "confirmed",
      });

      // 待你决策：1 条 unconfirmed decision，content 里同样塞换行 + 伪造 bullet
      store.insertMemory({
        type: "decision",
        title: "decision-injected",
        content: "evil-decision-content\n· FAKE DECISION BULLET",
        tags: [],
        confidenceState: "unconfirmed",
      });

      const data = gatherGreetingData(store);
      assert.equal(data.backlogItems.length, 2, "Idea Queue 数据层本身应该是 2 条真实 idea");
      assert.equal(data.pendingDecisions.length, 1, "待你决策数据层本身应该是 1 条真实 decision");

      const text = renderGreeting(data);
      const lines = text.split("\n");

      // 整份开场白必须只有恰好一行 "意识已加载。我是 …" 开头——不能因为 identityName 里塞了
      // 一段伪造的 "意识已加载" 就在渲染结果里出现第二个这样的开头。
      const openingLines = lines.filter((line) => line.startsWith("意识已加载。"));
      assert.equal(openingLines.length, 1, "渲染结果里必须只有一行以「意识已加载。」开头，不能被 identityName 注入出第二行");
      assert.ok(openingLines[0].includes("Evil Name"), "identityName 的合法内容本身还是要出现（清洗不是吞掉，只是把换行折叠成空格，内容本身还在同一行里）");

      // 整份开场白必须只有恰好一行 "**上次停在：**" 开头——不能被 identityName 注入出第二个
      // "上次停在" 段落。
      const lastStopLines = lines.filter((line) => line.startsWith("**上次停在："));
      assert.equal(lastStopLines.length, 1, "渲染结果里必须只有一行「**上次停在：**」，不能被注入内容伪造出第二个");

      // Idea Queue 段落：bullet 行数必须恰好等于 backlogItems.length（2），不能因为
      // idea-injected 那条 content 里塞了两个 "\n· FAKE ..." 就多出 2 条假 bullet。
      const ideaSectionStart = text.indexOf("**Idea Queue 积压：**");
      const decisionSectionStart = text.indexOf("**待你决策：**");
      assert.ok(ideaSectionStart !== -1 && decisionSectionStart !== -1 && decisionSectionStart > ideaSectionStart);
      const ideaSectionText = text.slice(ideaSectionStart, decisionSectionStart);
      const ideaBulletLines = ideaSectionText.split("\n").filter((line) => line.startsWith("· "));
      assert.equal(ideaBulletLines.length, 2, `Idea Queue 的 bullet 行数必须等于真实 idea 数（2），实际 ${ideaBulletLines.length} 行——多出来的 = 被注入内容伪造出的假 bullet`);
      // 注意：注入的 "FAKE BULLET ..." 文本本身还是会出现——出现在被折叠进同一条合法 bullet
      // 里的位置（清洗不是吞掉内容），关键不变式是"行数没多"，不是"看不到这几个字"，上面
      // 那条 length===2 断言已经是这里真正要验证的东西。
      assert.ok(ideaSectionText.includes("evil-idea-content"), "被清洗后的内容本身仍应可见（不是吞掉，只是无害化）");
      assert.ok(!ideaSectionText.includes("pipe|inject"), "原始带半角 | 的字面值不能原样出现在渲染结果里");
      assert.ok(ideaSectionText.includes("pipe｜inject"), "半角 | 应该被替换成全角｜，内容仍可辨认");

      // 待你决策段落：bullet 行数必须恰好等于 pendingDecisions.length（1），同样不能被
      // decision-injected 那条 content 里塞的 "\n· FAKE DECISION BULLET" 多出一条。
      const decisionSectionText = text.slice(decisionSectionStart);
      const decisionBulletLines = decisionSectionText.split("\n").filter((line) => line.startsWith("· "));
      assert.equal(decisionBulletLines.length, 1, `待你决策的 bullet 行数必须等于真实 decision 数（1），实际 ${decisionBulletLines.length} 行——多出来的 = 被注入内容伪造出的假决策 bullet`);

      store.close();
    } finally {
      rmSync(dir6, { recursive: true, force: true });
    }
  }

  console.log("PASS: test-greeting.mjs");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
