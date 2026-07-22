// B2 单元测试 —— PRD §3 批次 B2 验收点 / §4 AC2，用手写合成 EvidenceBundle（不依赖真实 run）：
//   ① 一条 source:"model-reported" 的证据（无论 passed 是 true 还是 false），处理后对应
//      memory 的 confidenceState 绝不是 "confirmed"
//   ② 一条 source:"verified", passed:true 的证据，处理后对应 memory confidenceState==="confirmed"
//   ③（附加，AC2 反过来那一半）source 缺省（absent=verified）且 passed:true 同样会被 confirm；
//      source:"verified" 但 passed:false 不会被 confirm（confirm 的必要条件是 passed===true 且
//      不是 model-reported，不是"只要 verified 就无脑 confirm"）
//   ④ 机械状态记录（active_task，基于 evidenceBundle.status）无论 evidence[] 内容如何都会被 confirm
//
// 跑法：node docs/conductor-brain-layer/spike/test-three-state-gate.mjs（要求先 pnpm run build）

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIdentityStore } from "./lib/wake.mjs";
import { applyThreeStateGate } from "./lib/three-state-gate.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-spike-gate-"));
const dbPath = path.join(dir, "identity.db");
const store = openIdentityStore(dbPath);

try {
  /** @type {import("../../../dist/evidence/bundle.js").EvidenceBundle} */
  const bundle = {
    schemaVersion: "1",
    runId: 999,
    contractId: "brain-spike-test-contract",
    status: "completed",
    requirements: [],
    claims: [],
    evidence: [
      { id: "ev-model-true", kind: "artifact", title: "model claims no change, passed=true", ref: "evidence://x/1", passed: true, source: "model-reported" },
      { id: "ev-model-false", kind: "artifact", title: "model claims failed, passed=false", ref: "evidence://x/2", passed: false, source: "model-reported" },
      { id: "ev-verified-true", kind: "test", title: "independent test ran and passed", ref: "evidence://x/3", passed: true, source: "verified" },
      { id: "ev-absent-true", kind: "tool", title: "tool ran, source field absent (=verified)", ref: "evidence://x/4", passed: true },
      { id: "ev-verified-false", kind: "test", title: "independent test ran and FAILED", ref: "evidence://x/5", passed: false, source: "verified" },
    ],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, retryTokens: 0, estimated: false },
    usageRecords: [],
    eventTypes: [],
    unprovenItems: [],
    omittedContext: [],
  };

  const results = applyThreeStateGate(bundle, store, { actor: "test-actor" });

  function resultFor(evidenceId) {
    const r = results.find((x) => x.evidenceId === evidenceId);
    assert.ok(r, `results 里应有 evidenceId=${evidenceId} 的条目`);
    return r;
  }
  function memoryFor(evidenceId) {
    const r = resultFor(evidenceId);
    const m = store.getMemoryById(r.memoryId);
    assert.ok(m, `memory ${r.memoryId} 应存在`);
    return m;
  }

  // ① model-reported，无论 passed 真假，绝不 confirmed
  assert.equal(resultFor("ev-model-true").confirmed, false, "model-reported + passed:true 不该被 confirm");
  assert.equal(memoryFor("ev-model-true").confidenceState, "unconfirmed");
  assert.equal(resultFor("ev-model-false").confirmed, false, "model-reported + passed:false 不该被 confirm");
  assert.equal(memoryFor("ev-model-false").confidenceState, "unconfirmed");

  // ② verified + passed:true → confirmed
  assert.equal(resultFor("ev-verified-true").confirmed, true);
  assert.equal(memoryFor("ev-verified-true").confidenceState, "confirmed");

  // ③ source 缺省（absent=verified）+ passed:true → 同样 confirmed
  assert.equal(resultFor("ev-absent-true").confirmed, true);
  assert.equal(memoryFor("ev-absent-true").confidenceState, "confirmed");

  // ③b verified 但 passed:false → 不 confirm（verified 不是"无脑通过"的意思）
  assert.equal(resultFor("ev-verified-false").confirmed, false);
  assert.equal(memoryFor("ev-verified-false").confidenceState, "unconfirmed");

  // ④ 机械状态记录（active_task）无论 evidence[] 内容如何都会被 confirm
  const statusResult = results.find((x) => x.evidenceId === null);
  assert.ok(statusResult, "应有一条机械状态记录");
  assert.equal(statusResult.confirmed, true);
  const statusMemory = store.getMemoryById(statusResult.memoryId);
  assert.equal(statusMemory.confidenceState, "confirmed");
  assert.equal(statusMemory.content.includes("brain-spike-test-contract"), true);

  // 反过来那一半（AC2）：全库扫一遍，任何 confirmed 的 memory，若能溯源到某条 evidence，
  // 该 evidence 的 source 必须不是 "model-reported"
  const allMemories = store.listMemories();
  const modelReportedEvidenceIds = new Set(["ev-model-true", "ev-model-false"]);
  for (const memory of allMemories) {
    if (memory.confidenceState !== "confirmed") continue;
    const traceableToModelReported = [...modelReportedEvidenceIds].some((id) => memory.title.includes(`evidence:${id}`));
    assert.equal(traceableToModelReported, false, `confirmed memory ${memory.id} (${memory.title}) 不该溯源到 model-reported 证据`);
  }

  console.log("PASS: test-three-state-gate.mjs (B2 — model-reported 绝不 confirm / verified+passed=true 才 confirm / 机械状态通道独立)");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
