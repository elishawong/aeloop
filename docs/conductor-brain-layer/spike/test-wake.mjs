// B0 单元测试 —— PRD §3 批次 B0 验收点：
//   ① 空库调用 wake() 不抛错、返回空数组
//   ② 手动 insertMemory 一条后，关闭当前 MemoryStore 实例、new MemoryStore(同 dbPath)
//      开一个新实例再调 wake()，能读到刚写入的那条（磁盘持久化，不是进程内对象缓存的假象）
//
// 跑法：node docs/conductor-brain-layer/spike/test-wake.mjs（要求先 pnpm run build 生成 dist/）

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openIdentityStore, wake } from "./lib/wake.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-spike-wake-"));
const dbPath = path.join(dir, "identity.db");

try {
  // ① 空库调用 wake() 不抛错、返回空数组
  {
    const store = openIdentityStore(dbPath);
    const result = wake(store);
    assert.deepEqual(result.continuedThreads, [], "空库 continuedThreads 应为 []");
    assert.deepEqual(result.pendingDecisions, [], "空库 pendingDecisions 应为 []");
    assert.equal(typeof result.openingSummary, "string", "openingSummary 应为字符串");
    store.close();
  }

  // ② 跨实例磁盘持久化：instance A 写入 -> close -> instance B（同 dbPath）读到
  let insertedId;
  {
    const storeA = openIdentityStore(dbPath);
    const memory = storeA.insertMemory({
      type: "active_task",
      title: "brain-spike-wake-test marker",
      content: "brain-spike-wake-test-marker-xyz123 persisted across instances",
      tags: ["test"],
    });
    insertedId = memory.id;
    storeA.close(); // 显式关闭，逼真实磁盘往返而非进程内对象引用
  }

  {
    const storeB = openIdentityStore(dbPath); // 全新实例，同 dbPath
    const result = wake(storeB, "brain-spike-wake-test-marker-xyz123");
    const found = result.continuedThreads.find((m) => m.id === insertedId);
    assert.ok(found, "wake() 从全新实例读到了上一实例写入的 memory —— 证明磁盘持久化，不是进程内对象缓存的假象");
    assert.equal(found.content.includes("xyz123"), true);
    storeB.close();
  }

  console.log("PASS: test-wake.mjs (B0 — 空库不抛错 + 跨实例磁盘持久化验证)");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
