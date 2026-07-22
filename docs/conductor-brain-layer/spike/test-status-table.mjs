// test-status-table.mjs — 单元测试：lib/status-table.mjs（aeloop issue #84）。
//
// 验收点：
//   ① confirmed active_task → 出现在表格里；unconfirmed → 绝不出现（防幻觉红线的机械证明）。
//   ② status tag 缺省 → 默认 in-progress（🟡 进行中）；显式 tag → 对应图标，包括
//      blocked/pending-decision 都映射到同一个 🔴 阻塞或等决策 图标。
//   ③ model tag 缺省 → "—"，不猜；显式 tag → 原样取。
//   ④ archived tag → 即便 confirmed 也不出现。
//   ⑤ 空表 → renderStatusTable 返回 "当前没有在途任务。"，不是只有表头的空表格。
//   ⑥ rejected active_task → 绝不出现在表格里（2026-07-22 blocker 2 补测，此前只测了
//      unconfirmed，没网住 rejected 也会被某些代码路径复活的可能）。
//   ⑦ 畸形/未识别的 status tag 值（拼错/新值）→ 必须显式标"❓ 未知状态"，statusKey 原样带出
//      那个值，绝不静默冒充 🟡 进行中（2026-07-22 blocker 1 补测）。区分"没打 tag"（走②的
//      默认值）和"打了但不认识"（这里）两种不同路径。
//   ⑧ status tag 值撞上 JS 内建/原型链名字（toString/constructor/__proto__/valueOf/
//      hasOwnProperty）→ 同样必须走 ❓ 未知状态分支，绝不能把 `Object.prototype` 上的内置
//      方法/存取器当"真值"渲染进表格（2026-07-23 must-fix 1 补测——Zorro/Codex 实跑复现过
//      旧代码在这几个值上吐出 `function toString() { [native code] }` 这类东西）。
//   ⑨ 行注入/列注入（2026-07-23 第 3 轮 must-fix，round1 就在的老 bug）：model/task/status
//      字段带 `\n| FORGED TASK | ... |` → 渲染结果的可见数据行数必须等于真实 confirmed
//      active_task 数，绝不能凭空多出一行"FORGED TASK"；带裸 `|` → 不能把一行撕裂成额外的列
//      （用"这一行里还剩几个真实半角 `|`"这个机械可数的不变式验证，不是靠肉眼看像不像表格）。
//
// 跑法：pnpm run build && node docs/conductor-brain-layer/spike/test-status-table.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIdentityStore } from "./lib/wake.mjs";
import { collectStatusRows, renderStatusTable, STATUS_EMOJI } from "./lib/status-table.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "aeloop-test-status-table-"));
const dbPath = path.join(dir, "identity.db");

try {
  const store = openIdentityStore(dbPath);

  // ① confirmed vs unconfirmed
  const confirmedTask = store.insertMemory({
    type: "active_task",
    title: "confirmed task",
    content: "should show",
    tags: [],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "unconfirmed task",
    content: "should NOT show",
    tags: [],
    confidenceState: "unconfirmed",
  });

  // ⑥ rejected — 同样绝不能出现（此前的测试盲区：只测过 unconfirmed，没测 rejected）
  store.insertMemory({
    type: "active_task",
    title: "rejected task",
    content: "should NOT show either",
    tags: [],
    confidenceState: "rejected",
  });

  // ② status tag 显式值，覆盖所有取值（含 blocked/pending-decision 共用同一图标）
  store.insertMemory({
    type: "active_task",
    title: "done task",
    content: "d",
    tags: ["status:done"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "todo task",
    content: "t",
    tags: ["status:todo"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "blocked task",
    content: "b",
    tags: ["status:blocked"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "pending-decision task",
    content: "p",
    tags: ["status:pending-decision"],
    confidenceState: "confirmed",
  });

  // ③ model tag
  store.insertMemory({
    type: "active_task",
    title: "with model",
    content: "m",
    tags: ["model:deepseek-v3"],
    confidenceState: "confirmed",
  });

  // ④ archived — 即便 confirmed 也不该出现
  store.insertMemory({
    type: "active_task",
    title: "archived task",
    content: "a",
    tags: ["archived"],
    confidenceState: "confirmed",
  });

  // ⑦ 畸形/未识别的 status tag 值——拼错（in_progress 下划线）和纯新词（wip）各一条
  store.insertMemory({
    type: "active_task",
    title: "typo status task",
    content: "typo",
    tags: ["status:in_progress"],
    confidenceState: "confirmed",
  });
  store.insertMemory({
    type: "active_task",
    title: "unknown status task",
    content: "unknown",
    tags: ["status:wip"],
    confidenceState: "confirmed",
  });

  // ⑧ JS 内建/原型链名字撞车——must-fix 1 的核心复现用例
  const PROTOTYPE_ATTACK_VALUES = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty"];
  for (const value of PROTOTYPE_ATTACK_VALUES) {
    store.insertMemory({
      type: "active_task",
      title: `prototype-attack-${value}`,
      content: `status tag 值是 ${value}`,
      tags: [`status:${value}`],
      confidenceState: "confirmed",
    });
  }

  const rows = collectStatusRows(store);
  const byTitle = Object.fromEntries(rows.map((r) => [r.task, r]));

  assert.ok(byTitle["confirmed task"], "confirmed active_task 必须出现在表格里");
  assert.equal(byTitle["unconfirmed task"], undefined, "unconfirmed active_task 绝不能出现在表格里（防幻觉红线）");
  assert.equal(byTitle["rejected task"], undefined, "rejected active_task 绝不能出现在表格里（blocker 2 补测）");
  assert.equal(byTitle["archived task"], undefined, "archived 的 active_task 不应出现");

  assert.equal(byTitle["confirmed task"].statusLabel, STATUS_EMOJI["in-progress"], "缺省 status tag 应默认 in-progress");
  assert.equal(byTitle["done task"].statusLabel, STATUS_EMOJI["done"]);
  assert.equal(byTitle["todo task"].statusLabel, STATUS_EMOJI["todo"]);
  assert.equal(byTitle["blocked task"].statusLabel, STATUS_EMOJI["blocked"]);
  assert.equal(byTitle["pending-decision task"].statusLabel, STATUS_EMOJI["pending-decision"]);
  assert.equal(byTitle["blocked task"].statusLabel, byTitle["pending-decision task"].statusLabel, "blocked 和 pending-decision 必须共用同一个 🔴 图标");

  assert.equal(byTitle["confirmed task"].model, "—", "没有 model tag 时必须是 —，不能猜");
  assert.equal(byTitle["with model"].model, "deepseek-v3");

  // ⑦ 畸形/未识别 status 值——绝不能等于任何一个已知图标（尤其不能是 🟡 进行中），
  // statusKey 必须原样带出那个不认识的值，statusLabel 必须显式标"未知"。
  const knownLabels = new Set(Object.values(STATUS_EMOJI));
  assert.equal(byTitle["typo status task"].statusKey, "in_progress", "statusKey 必须原样带出拼错的值，不能悄悄纠正/丢弃");
  assert.ok(!knownLabels.has(byTitle["typo status task"].statusLabel), "拼错的 status 值绝不能映射到任何一个已知图标");
  assert.ok(byTitle["typo status task"].statusLabel.startsWith("❓"), "未识别的 status 值必须显式标未知，不能是别的图标");
  assert.notEqual(
    byTitle["typo status task"].statusLabel,
    STATUS_EMOJI["in-progress"],
    "拼错的 status 值绝不能被静默冒充成 🟡 进行中",
  );

  assert.equal(byTitle["unknown status task"].statusKey, "wip");
  assert.ok(!knownLabels.has(byTitle["unknown status task"].statusLabel));
  assert.ok(byTitle["unknown status task"].statusLabel.includes("wip"), "未知状态标签应该带上原始值方便排查");

  // ⑧ JS 内建/原型链名字——每一个都必须走 ❓ 未知状态分支，statusKey 是原始字符串（不是函数/
  // 存取器返回值），statusLabel 是我们自己拼的字符串（不含 "[native code]"/"function "这类
  // 说明它被当成一个真实函数/对象渲染出来的痕迹）。
  for (const value of PROTOTYPE_ATTACK_VALUES) {
    const row = byTitle[`prototype-attack-${value}`];
    assert.ok(row, `prototype-attack-${value} 这一行应该存在（active_task/confirmed，不该被过滤掉）`);
    assert.equal(typeof row.statusKey, "string", `statusKey 必须是字符串，不能是 ${value} 解析出的函数/对象`);
    assert.equal(row.statusKey, value, `statusKey 必须原样是 "${value}" 这个字符串本身`);
    assert.equal(typeof row.statusLabel, "string");
    assert.ok(row.statusLabel.startsWith("❓"), `status:${value} 必须走未知状态分支，不能被原型链查找蒙混过关`);
    assert.ok(!knownLabels.has(row.statusLabel), `status:${value} 绝不能等于任何一个已知图标`);
    assert.ok(
      !row.statusLabel.includes("[native code]") && !row.statusLabel.includes("function"),
      `status:${value} 的渲染结果里不能出现原生函数的字符串形式（说明原型链查找被当"真值"渲染了）`,
    );
  }

  // ⑤ 渲染：非空表格
  const rendered = renderStatusTable(rows);
  assert.ok(rendered.startsWith("| 任务 | 状态 | 选用模型 |"), "非空表格必须以固定表头开头");
  assert.ok(!rendered.includes("unconfirmed task"), "渲染结果里绝不能出现 unconfirmed 的标题文本");
  assert.ok(!rendered.includes("rejected task"), "渲染结果里绝不能出现 rejected 的标题文本");

  // ⑤ 渲染：空表格
  const emptyRendered = renderStatusTable([]);
  assert.equal(emptyRendered, "当前没有在途任务。", "空表必须是这句固定文案，不是只有表头的空表格");

  store.close();

  // ⑨ 行注入/列注入——独立的库，保持行数断言干净可算
  {
    const dir9 = mkdtempSync(path.join(tmpdir(), "aeloop-test-status-table-injection-"));
    const dbPath9 = path.join(dir9, "identity.db");
    try {
      const store9 = openIdentityStore(dbPath9);

      // 真实的一条：model tag 里塞一整条伪造表格行（换行 + 三列）
      store9.insertMemory({
        type: "active_task",
        title: "real task one",
        content: "legit",
        tags: ["status:in-progress", "model:evil\n| FORGED TASK | 🟡 进行中 | evil-model |"],
        confidenceState: "confirmed",
      });

      // 真实的第二条：title 里塞裸 | 试图撕裂列结构（不带换行，纯列注入）
      store9.insertMemory({
        type: "active_task",
        title: "pipe|title|hack",
        content: "legit two",
        tags: ["status:todo"],
        confidenceState: "confirmed",
      });

      const rows9 = collectStatusRows(store9);
      assert.equal(rows9.length, 2, "collectStatusRows 本身的行数必须等于真实 memory 数（2 条）");

      const rendered9 = renderStatusTable(rows9);
      const lines9 = rendered9.split("\n");

      // 行数不变式：表头 1 行 + 分隔线 1 行 + 真实数据 2 行 = 4 行，不多不少
      assert.equal(lines9.length, 4, `渲染结果必须恰好 4 行（表头+分隔线+2 条真实数据），实际 ${lines9.length} 行——多出来的行 = 被伪造出的假行`);

      // 不能有任何一行是伪造出来的独立 "FORGED TASK" 行
      assert.ok(
        !lines9.some((line) => line.startsWith("| FORGED") || line.trim() === "| FORGED TASK | 🟡 进行中 | evil-model |"),
        "渲染结果里不能出现被注入内容伪造出的独立表格行",
      );

      // 每一条数据行（跳过表头 + 分隔线）都必须恰好是 3 列 = 4 个真实半角 | 分隔符，
      // 不多不少——不管单元格内容里塞了多少个 |，注入的都必须变成全角 ｜，不再计入这个数。
      const dataLines9 = lines9.slice(2);
      assert.equal(dataLines9.length, 2);
      for (const line of dataLines9) {
        const pipeCount = (line.match(/\|/g) || []).length;
        assert.equal(pipeCount, 4, `每条数据行必须恰好 4 个真实 "|"（3 列的分隔符），实际 ${pipeCount} 个，说明列结构被注入内容撕裂了：${line}`);
      }

      // 注入的换行必须已经被折叠——渲染结果里不能出现两个连续的真实换行紧跟 "FORGED" 这种
      // 独立成行的痕迹；换一种说法：原始注入串里的 "\n" 不能在渲染结果里以真实换行符形式存在。
      assert.ok(!rendered9.includes("evil\n"), "model 字段里的换行必须被折叠，不能在渲染结果里保留成真实换行");

      // pipe|title|hack 这条：渲染结果里应该还能看到内容本身（没有被吞掉，只是结构上无害化），
      // 只是里面的 | 已经变成全角 ｜。
      assert.ok(rendered9.includes("pipe｜title｜hack"), "被清洗后的内容应该用全角｜替换原始半角|，内容本身仍可见（不是拒收/吞掉）");
      assert.ok(!rendered9.includes("pipe|title|hack"), "原始带半角 | 的字面值不能原样出现在渲染结果里");

      store9.close();
    } finally {
      rmSync(dir9, { recursive: true, force: true });
    }
  }

  console.log("PASS: test-status-table.mjs");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
