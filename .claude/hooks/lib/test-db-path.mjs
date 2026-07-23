// test-db-path.mjs — issue #88 B9 单元测试：db-path.mjs。
//
// 覆盖 PRD §6.5："env 设了 → 优先用 env（即便本地 json 也存在，env 优先）；env 未设 + 本地 json
// 存在合法 → 用 json 值；两者都无 → null；本地 json 是坏 JSON → 不抛错，返回 null"。
//
// 跑法：node .claude/hooks/lib/test-db-path.mjs（零依赖）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveIdentityDbPath } from "./db-path.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-dbpath-"));
const originalEnv = process.env.AELOOP_BRAIN_IDENTITY_DB;

function setLocalConfig(content) {
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "brain.local.json"), content);
}

try {
  // ① 两者都无 → null
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, null, "两个配置源都缺失应返回 null");
  }

  // ② env 未设 + 本地 json 合法 → 用 json 值
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    setLocalConfig(JSON.stringify({ identityDbPath: "/absolute/path/from/local/json.db" }));
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, "/absolute/path/from/local/json.db", "应从本地 json 读到 dbPath");
  }

  // ③ env 设了 → 优先用 env（即便本地 json 也存在）
  {
    process.env.AELOOP_BRAIN_IDENTITY_DB = "/absolute/path/from/env.db";
    const result = resolveIdentityDbPath({ cwd: dir }); // 本地 json 仍是上一步写的那份，未清
    assert.equal(result, "/absolute/path/from/env.db", "env 存在时应优先于本地 json");
  }

  // ④ 本地 json 是坏 JSON → 不抛错，返回 null
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    setLocalConfig("{ this is not valid json");
    assert.doesNotThrow(() => resolveIdentityDbPath({ cwd: dir }), "坏 JSON 不该抛错");
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, null, "坏 JSON 应视为未配置，返回 null");
  }

  // ⑤ 本地 json 合法但缺 identityDbPath 字段 → null（不是抛错，也不是返回 undefined）
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    setLocalConfig(JSON.stringify({ someOtherField: 1 }));
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, null, "字段缺失应视为未配置，返回 null");
  }

  console.log("PASS: test-db-path.mjs (issue #88 B9 — env 优先 + 本地 json fallback + 坏输入不抛错)");
} finally {
  if (originalEnv === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
  else process.env.AELOOP_BRAIN_IDENTITY_DB = originalEnv;
  rmSync(dir, { recursive: true, force: true });
}
