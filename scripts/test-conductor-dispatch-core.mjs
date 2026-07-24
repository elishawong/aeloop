// test-conductor-dispatch-core.mjs — issue #2 batch 0 单元测试：conductor-dispatch-core.mjs
// （§7.3 方案 B 抽出的共享派发核心，不要求项目注册）。
//
// 覆盖点（对应 docs/conductor-mvp/PRD.md §6.1 batch 0 验收标准，含 Zorro R1 深水区补测）：
//   - 合法 rawIntent → 产出的 contract 100% 过 assertValidTaskContract()。
//   - 空/纯空白 rawIntent → fail-closed（translateIntent 自己的既有行为，透传不变）。
//   - opts.allowedPaths/objectivePrefix 正确透传进产出的 contract。
//   - opts.contractDir 生效（自定义落盘目录）。
//   - ①-⑤ 号断言组只验证到"组装 contract 为止"（同 test-dispatch-brain-task.mjs 的既有惯例：
//     assembleDeps 注入到"组好 contract 后立即抛错"，不真的跑 startRun/resumeRun）。
//   - ⑥-⑨ 号断言组（Zorro R1 深水区回归，2026-07-24 新增）**真实驱动 startRun/resumeRun**——
//     用 fake coder/tester adapter（不调真实 LLM/网络）走完三条完整路径：G1→G2→G3 停止、
//     Escalation 停止、no_change 终态；`AUTO_APPROVE_GATE_NAMES`/`isAutoApproveGate()` 内容 +
//     冻结性断言。**Zorro R3 yellow④订正**：这段头注释此前仍整体声称"真实 startRun/resumeRun/
//     三态门这条链路不真的跑"，和文件后半（⑥-⑨号）的真实覆盖范围不符，已更新——真实 LLM 调用
//     本身仍然没有被自动化（fake adapter 不是真实模型），这一点没变，变的只是"链路走没走完整"
//     这条描述。
//
// 跑法：node scripts/test-conductor-dispatch-core.mjs（需要先 pnpm run build 生成 dist/）。

import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConductorDispatch, REPO_ROOT, DEFAULT_CONTRACT_DIR, AUTO_APPROVE_GATE_NAMES, isAutoApproveGate } from "./lib/conductor-dispatch-core.mjs";

const NOW = "2026-07-24T00:00:00.000Z";

/**
 * Zorro R1 blocker/yellow③ — 深水区回归：G1/G2 之外，之前完全没有测过"共享核心真的驱动
 * startRun/resumeRun 走一整条 draft→g1→review→g2→…→G3/Escalation"这条链路，只测到
 * "assembleDeps 被调用那一刻为止"。这里复用 `src/loop/__tests__/runner.test.ts` 已经建立的
 * FakeCoderAdapter/FakeTesterAdapter 模式（不 import 那个测试文件里的私有类——它们没有导出，
 * 也不该导出给一个 scripts/ 测试用——原地重建同一形状，两边独立维护，如果哪天行为分叉，两边的
 * 测试各自会先报警，不会互相掩盖）。
 */
class FakeCoderAdapter {
  id = "fake-coder";
  kind = "direct-api";
  calls = 0;
  async checkAvailability() {
    return { available: true, checkedAt: NOW };
  }
  async invoke() {
    this.calls += 1;
    const payload = {
      status: "changed",
      diff: `--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+round${this.calls}\n`,
      claims: [
        { claimText: "the change compiles", confidence: "verified", sourceRef: "tsc" },
        { claimText: "matches the requested behavior", confidence: "inferred" },
      ],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-coder-model-v1" };
  }
}

class FakeTesterAdapter {
  id = "fake-tester";
  kind = "direct-api";
  calls = 0;
  constructor(verdicts) {
    this.verdicts = verdicts;
  }
  async checkAvailability() {
    return { available: true, checkedAt: NOW };
  }
  async invoke() {
    const verdict = this.verdicts[Math.min(this.calls, this.verdicts.length - 1)] ?? "pass";
    this.calls += 1;
    const payload = {
      verdict,
      issues: verdict === "reject" ? ["found a real problem"] : [],
      claims: [{ claimText: "ran the tests", confidence: "verified", sourceRef: "test output", verifiedBy: "tool_execution" }],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-tester-model-v1" };
  }
}

class NoChangeCoderAdapter {
  id = "fake-coder";
  kind = "direct-api";
  calls = 0;
  async checkAvailability() {
    return { available: true, checkedAt: NOW };
  }
  async invoke() {
    this.calls += 1;
    const payload = {
      status: "no_change",
      reason: "the requested behavior was already implemented",
      evidence: "read src/example.ts and confirmed the function already exists",
      claims: [],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-coder-model-v1" };
  }
}

/**
 * 组装一份完整、真实的 fake `CliDeps`（`src/cli/assemble.ts` 的 `assembleProfileDeps()` 返回
 * 形状），驱动共享核心真正跑一次 startRun/resumeRun——不是"跑到 assembleDeps 就抛错停下"那种
 * 浅层验证。`personasDir` 复用真实的 subscription profile 自带的 personas（coder.md/tester.md
 * 本来就是 profile-neutral 的文本，不涉及任何凭证）。
 */
async function buildFakeAssembleDeps(dbDir, coder, tester) {
  const {
    AdapterRegistry,
    ProviderRouter,
    PromptComposer,
    AuditStore,
    createSqliteCheckpointer,
    MemoryStore,
    SystemConfig,
    StalenessEngine,
    ContextInjector,
    resolveProfileDir,
  } = await import(path.join(REPO_ROOT, "dist", "index.js"));

  const registry = new AdapterRegistry();
  registry.register(coder);
  registry.register(tester);
  const router = new ProviderRouter({ coder: { provider: coder.id }, tester: { provider: tester.id } }, registry);
  const personasDir = path.join(resolveProfileDir("subscription"), "personas");
  const composer = new PromptComposer(personasDir);

  const workflowDbPath = path.join(dbDir, "workflow.db");
  const memoryDbPath = path.join(dbDir, "memory.db");
  const audit = new AuditStore(workflowDbPath);
  const checkpointer = createSqliteCheckpointer(workflowDbPath);
  const memoryStore = new MemoryStore(memoryDbPath);
  const systemConfig = new SystemConfig(memoryStore);
  const staleness = new StalenessEngine(systemConfig);
  const injector = new ContextInjector(memoryStore, staleness);

  return async () => ({
    router,
    composer,
    audit,
    checkpointer,
    profileConfig: { profile: "subscription" },
    injector,
    memoryStore,
    profileDir: resolveProfileDir("subscription"),
  });
}

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

async function main() {
  const { MemoryStore } = await import(path.join(REPO_ROOT, "dist", "context", "store.js"));
  const { assertValidTaskContract } = await import(path.join(REPO_ROOT, "dist", "conductor", "contract.js"));

  const dbDir = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-db-"));
  const dbPath = path.join(dbDir, "identity.db");
  const store = new MemoryStore(dbPath);

  const scratchContractDir = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-contracts-"));

  try {
    // ── ① 合法 rawIntent → 走到 assembleDeps 这一步（说明 translateIntent + 落盘都成功了），
    //    产出的 contract 100% 过 assertValidTaskContract() ─────────────────────────────────
    {
      let assembleCalled = false;
      let capturedProfileName = null;
      await assert.rejects(
        () =>
          runConductorDispatch(
            "写一个 reverseString(s) 冒烟验证",
            { store, assembleDeps: async (profileName) => {
              assembleCalled = true;
              capturedProfileName = profileName;
              throw new Error("intentional stop — test only verifies contract construction");
            } },
            { contractDir: scratchContractDir },
          ),
        (err) => {
          assert.match(err.message, /intentional stop/);
          return true;
        },
        "合法意图应该走到 assembleDeps 这一步才抛错",
      );
      check("合法 rawIntent → 走到 assembleDeps（说明 translateIntent + 落盘成功）", () => {
        assert.equal(assembleCalled, true);
      });
      check("assembleDeps 收到的 profileName 缺省是 \"subscription\"（同既有 run-spike.mjs/dispatch-brain-task.mjs 默认）", () => {
        assert.equal(capturedProfileName, "subscription");
      });
    }

    // ── ② contract 文件确实落盘到自定义 contractDir，且过 assertValidTaskContract() ──────────
    {
      const files = fs.readdirSync(scratchContractDir).filter((f) => f.endsWith(".json"));
      check("contract JSON 写到了自定义 contractDir（不是默认 DEFAULT_CONTRACT_DIR）", () => {
        assert.equal(files.length, 1, `期望恰好 1 个 contract 文件，实际 ${files.length} 个`);
      });
      const contract = JSON.parse(fs.readFileSync(path.join(scratchContractDir, files[0]), "utf8"));
      check("落盘的 contract 100% 过 assertValidTaskContract()", () => {
        assertValidTaskContract(contract); // 不抛即通过
      });
      check("brain 恒为 \"company\"（translateIntent() 既有行为，透传不变）", () => {
        assert.equal(contract.brain, "company");
      });
    }

    // ── ③ opts.allowedPaths/objectivePrefix 正确透传 ─────────────────────────────────────
    {
      const customDir = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-passthrough-"));
      try {
        await assert.rejects(
          () =>
            runConductorDispatch(
              "自定义透传验证",
              { store, assembleDeps: async () => { throw new Error("intentional stop passthrough"); } },
              {
                contractDir: customDir,
                allowedPaths: ["docs/conductor-mvp/spike-passthrough-check/**"],
                objectivePrefix: "PASSTHROUGH-CHECK-PREFIX",
              },
            ),
          () => true,
        );
        const files = fs.readdirSync(customDir).filter((f) => f.endsWith(".json"));
        const contract = JSON.parse(fs.readFileSync(path.join(customDir, files[0]), "utf8"));
        check("opts.allowedPaths 正确透传进 contract.policy.allowedPaths", () => {
          assert.deepEqual(contract.policy.allowedPaths, ["docs/conductor-mvp/spike-passthrough-check/**"]);
        });
        check("opts.objectivePrefix 正确透传进 contract.objective", () => {
          assert.ok(contract.objective.startsWith("PASSTHROUGH-CHECK-PREFIX"));
        });
      } finally {
        rmSync(customDir, { recursive: true, force: true });
      }
    }

    // ── ④ 空/纯空白 rawIntent → fail-closed，assembleDeps 零调用（translateIntent 自己的既有
    //    行为，透传不变——不是本文件重新实现的逻辑，这里只验证"共享核心没有绕开这条既有红线"） ──
    {
      for (const badIntent of ["", "   ", undefined]) {
        let assembleCalled = false;
        await assert.rejects(
          () =>
            runConductorDispatch(
              badIntent,
              { store, assembleDeps: async () => { assembleCalled = true; throw new Error("unreachable"); } },
              { contractDir: scratchContractDir },
            ),
          TypeError,
          `rawIntent=${JSON.stringify(badIntent)} 应该 fail-closed 抛 TypeError`,
        );
        check(`rawIntent=${JSON.stringify(badIntent)} → fail-closed，assembleDeps 零调用`, () => {
          assert.equal(assembleCalled, false);
        });
      }
    }

    // ── ⑤ DEFAULT_CONTRACT_DIR 是 #2 自己的独立安全区，不等于 #75/#80/#93 已有的两个安全区 ────
    check("DEFAULT_CONTRACT_DIR 是 docs/conductor-mvp/runs（独立于既有安全区，不混审计痕迹）", () => {
      assert.equal(DEFAULT_CONTRACT_DIR, path.join(REPO_ROOT, "docs", "conductor-mvp", "runs"));
    });

    // ── ⑥ 🔒 红线：AUTO_APPROVE_GATE_NAMES/isAutoApproveGate() 只认 G1/G2，G3/Escalation 永不
    //    出现（Zorro R1 yellow③ + Zorro R2 blocker RB1——R1 阶段曾直接导出可变 Set，
    //    `.add("G3_FINAL_MERGE")` 之类的调用能真的污染它、削弱"G3 恒人工"这条红线；现在只导出
    //    冻结快照 + 判定函数，这里顺便验证"快照真的冻结了"，不是名义上的只读） ─────────────
    check("AUTO_APPROVE_GATE_NAMES 恒等于 [G1_SEND_TO_TESTER, G2_SEND_TO_FIX]——不多不少", () => {
      assert.deepEqual([...AUTO_APPROVE_GATE_NAMES].sort(), ["G1_SEND_TO_TESTER", "G2_SEND_TO_FIX"]);
    });
    check("isAutoApproveGate() 对 G1/G2 返回 true，对 G3/Escalation 返回 false", () => {
      assert.equal(isAutoApproveGate("G1_SEND_TO_TESTER"), true);
      assert.equal(isAutoApproveGate("G2_SEND_TO_FIX"), true);
      assert.equal(isAutoApproveGate("G3_FINAL_MERGE"), false, "G3 绝不能被判定为自动放行");
      assert.equal(isAutoApproveGate("ESCALATION_ACK"), false, "Escalation 绝不能被判定为自动放行");
    });
    check("🔒 AUTO_APPROVE_GATE_NAMES 是真冻结的数组——.push() 在严格模式下真的抛错，不是名义上的只读", () => {
      assert.ok(Object.isFrozen(AUTO_APPROVE_GATE_NAMES), "导出的快照必须是 Object.freeze() 过的");
      assert.throws(
        () => AUTO_APPROVE_GATE_NAMES.push("G3_FINAL_MERGE"),
        TypeError,
        "冻结数组上调用 .push() 必须真的抛 TypeError（本文件顶部是 ESM 模块，默认严格模式）",
      );
      // 即便有人绕过 push() 直接尝试污染这份导出快照，也不该影响内部真正驱动自动批循环的状态——
      // 用 isAutoApproveGate() 复查一遍，证明"外部拿到的这份数据"和"内部真正用来判断的逻辑"没有
      // 共享可变状态。
      assert.equal(isAutoApproveGate("G3_FINAL_MERGE"), false);
    });

    // ── ⑦ 深水区：真实驱动 startRun/resumeRun 走 draft→G1(自动)→review→G2(自动，因为第1轮被
    //    拒)→draft→G1(自动)→review→G3——停在 G3 前，不自动批。验证 pendingGate/done/runId/
    //    threadId 这几个新增返回字段真的对，不只是"类型层面存在" ─────────────────────────
    {
      const dbDir7 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-fullloop-"));
      const contractDir7 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-fullloop-contracts-"));
      const store7 = new MemoryStore(path.join(dbDir7, "identity.db"));
      try {
        const coder = new FakeCoderAdapter();
        const tester = new FakeTesterAdapter(["reject", "pass"]); // 第1轮拒、第2轮过 → G2 → draft#2 → G3
        const assembleDeps = await buildFakeAssembleDeps(dbDir7, coder, tester);

        const result = await runConductorDispatch("real full-loop smoke test", { store: store7, assembleDeps }, { contractDir: contractDir7 });

        check("真实全链路：runError 为 null（没有意外抛错）", () => {
          assert.equal(result.runError, null, result.runError?.message);
        });
        check("真实全链路：停在 G3 前，不自动批（G3 恒人工，红线）", () => {
          assert.equal(result.pendingGate?.gate, "G3_FINAL_MERGE");
        });
        check("真实全链路：pendingGate.diff 是真实的候选 diff 文本（Zorro R1 blocker B5），不是空/占位", () => {
          assert.ok(typeof result.pendingGate.diffRef === "string" && result.pendingGate.diffRef.includes("round2"), `实际 diffRef=${JSON.stringify(result.pendingGate?.diffRef)}`);
        });
        check("真实全链路：done=false（还没到终态）", () => {
          assert.equal(result.done, false);
        });
        check("真实全链路：runId/threadId 都是真实值（不是 null）", () => {
          assert.ok(typeof result.runId === "number" && result.runId > 0);
          assert.ok(typeof result.threadId === "string" && result.threadId.length > 0);
        });
        check("真实全链路：coder 真的被调用了 2 次（第1轮被拒→第2轮修正，不是只跑了1轮）", () => {
          assert.equal(coder.calls, 2);
        });
        check("真实全链路：tester 真的被调用了 2 次（对应 coder 的 2 轮）", () => {
          assert.equal(tester.calls, 2);
        });
      } finally {
        store7.close();
        rmSync(dbDir7, { recursive: true, force: true });
        rmSync(contractDir7, { recursive: true, force: true });
      }
    }

    // ── ⑧ 深水区：Escalation——tester 持续 reject 超过 rejectThreshold（共享核心硬编码 2）→
    //    停在 ESCALATION_ACK 前，不是 G3 ────────────────────────────────────────────────
    {
      const dbDir8 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-escalation-"));
      const contractDir8 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-escalation-contracts-"));
      const store8 = new MemoryStore(path.join(dbDir8, "identity.db"));
      try {
        const coder = new FakeCoderAdapter();
        const tester = new FakeTesterAdapter(["reject", "reject", "reject", "reject"]); // 持续拒，触发升级
        const assembleDeps = await buildFakeAssembleDeps(dbDir8, coder, tester);

        const result = await runConductorDispatch("escalation smoke test", { store: store8, assembleDeps }, { contractDir: contractDir8 });

        check("Escalation：runError 为 null", () => {
          assert.equal(result.runError, null, result.runError?.message);
        });
        check("Escalation：停在 ESCALATION_ACK 前，不是 G3（持续 reject 触发升级）", () => {
          assert.equal(result.pendingGate?.gate, "ESCALATION_ACK");
        });
        check("Escalation：done=false（等待人工介入，不是终态）", () => {
          assert.equal(result.done, false);
        });
      } finally {
        store8.close();
        rmSync(dbDir8, { recursive: true, force: true });
        rmSync(contractDir8, { recursive: true, force: true });
      }
    }

    // ── ⑨ 深水区：no_change 终态——coder 判定不需要改动 → done=true，pendingGate=null ──────────
    {
      const dbDir9 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-nochange-"));
      const contractDir9 = mkdtempSync(path.join(tmpdir(), "conductor-dispatch-core-test-nochange-contracts-"));
      const store9 = new MemoryStore(path.join(dbDir9, "identity.db"));
      try {
        const coder = new NoChangeCoderAdapter();
        const tester = new FakeTesterAdapter(["pass"]); // 不会真的被调用（no_change 直接终态）
        const assembleDeps = await buildFakeAssembleDeps(dbDir9, coder, tester);

        const result = await runConductorDispatch("no-change smoke test", { store: store9, assembleDeps }, { contractDir: contractDir9 });

        check("no_change：runError 为 null", () => {
          assert.equal(result.runError, null, result.runError?.message);
        });
        check("no_change：done=true（真实终态）", () => {
          assert.equal(result.done, true);
        });
        check("no_change：pendingGate=null（没有卡在任何 gate 前）", () => {
          assert.equal(result.pendingGate, null);
        });
        check("no_change：tester 从未被调用（no_change 直接路由到终态，不经过 review）", () => {
          assert.equal(tester.calls, 0);
        });
      } finally {
        store9.close();
        rmSync(dbDir9, { recursive: true, force: true });
        rmSync(contractDir9, { recursive: true, force: true });
      }
    }

    console.log(`PASS: test-conductor-dispatch-core.mjs (${passCount} assertions groups, issue #2 batch 0 + Zorro R1 深水区回归)`);
  } finally {
    store.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(scratchContractDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("test-conductor-dispatch-core.mjs 未捕获异常：");
  console.error(err);
  process.exitCode = 1;
});
