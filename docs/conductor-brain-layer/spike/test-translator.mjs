// B1 单元测试 —— PRD §3 批次 B1 验收点：
//   ① 任意非空 rawIntent 产出的 contract 都能过 assertValidTaskContract()
//   ② brain 字段恒为 "company"
//   ③ 空字符串 rawIntent 走一条明确拒绝路径（fail-closed，不产出非法 contract）
//
// 跑法：node docs/conductor-brain-layer/spike/test-translator.mjs（要求先 pnpm run build）

import assert from "node:assert/strict";
import { translateIntent } from "./lib/translator.mjs";
import { assertValidTaskContract } from "../../../dist/conductor/contract.js";

// ① + ② 任意非空 rawIntent 产出的 contract 都能过校验，brain 恒 company
for (const intent of ["do X", "帮我把这个功能实现一下", "  spaced intent  "]) {
  const contract = translateIntent(intent);
  assertValidTaskContract(contract); // 不抛即通过
  assert.equal(contract.brain, "company", `brain 必须恒为 company，intent="${intent}"`);
  assert.equal(contract.riskLevel, "low");
  assert.equal(contract.requirements.length, 1);
}

// contractId 可自定义（B4 会传 opts.contractId 用于可追源）
{
  const contract = translateIntent("custom id test", { contractId: "brain-spike-fixed-id-001" });
  assert.equal(contract.contractId, "brain-spike-fixed-id-001");
}

// ③ 空字符串 / 纯空白 rawIntent 走明确拒绝路径（fail-closed）
assert.throws(() => translateIntent(""), TypeError, "空字符串应抛 TypeError");
assert.throws(() => translateIntent("   "), TypeError, "纯空白字符串应抛 TypeError");
assert.throws(() => translateIntent(undefined), TypeError, "undefined 应抛 TypeError");

console.log("PASS: test-translator.mjs (B1 — 合法产出过校验 + brain 恒 company + 空意图 fail-closed)");
