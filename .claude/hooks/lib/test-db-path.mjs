// test-db-path.mjs — issue #88 B9 单元测试：db-path.mjs（issue #93 B1 新增全局模式用例）。
//
// 覆盖 PRD(#88) §6.5："env 设了 → 优先用 env（即便本地 json 也存在，env 优先）；env 未设 + 本地
// json 存在合法 → 用 json 值；两者都无 → null；本地 json 是坏 JSON → 不抛错，返回 null"。
// 覆盖 docs/conductor-brain-multiproject/PRD.md §6.2："AELOOP_BRAIN_GLOBAL_MODE=1 → 返回全局默认
// 路径且不碰 cwd；env 仍最高优先级；未设该变量时全部既有用例零回归"。
//
// 跑法：node .claude/hooks/lib/test-db-path.mjs（零依赖）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globalDefaultDbPath, resolveIdentityDbPath } from "./db-path.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-dbpath-"));
const originalEnv = process.env.AELOOP_BRAIN_IDENTITY_DB;
const originalGlobalMode = process.env.AELOOP_BRAIN_GLOBAL_MODE;

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

  // ⑥（issue #93 B1）全局模式 + 未设 env db path + cwd 指向一个不存在的目录 → 仍正确返回全局
  //    默认路径，不抛错——证明第②步之后确实不再碰 cwd（DESIGN §1.1 方案 B 否决理由的代码落点）。
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
    const bogusCwd = path.join(dir, "does-not-exist-at-all");
    const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-dbpath-home-"));
    try {
      assert.doesNotThrow(
        () => resolveIdentityDbPath({ cwd: bogusCwd, homeDir }),
        "全局模式下不存在的 cwd 不该导致抛错",
      );
      const result = resolveIdentityDbPath({ cwd: bogusCwd, homeDir });
      assert.equal(result, globalDefaultDbPath(homeDir), "全局模式应返回全局默认路径");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }

  // ⑦（issue #93 B1）全局模式 + cwd 指向一个存在且有合法 brain.local.json 的目录 → 仍返回全局
  //    默认路径（不是 local json 里的值）——证明全局模式下 local json 分支被完全跳过，不是
  //    "读了但优先级更低"。
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
    setLocalConfig(JSON.stringify({ identityDbPath: "/should/never/be/returned.db" }));
    const homeDir = mkdtempSync(path.join(tmpdir(), "brain-test-dbpath-home-"));
    try {
      const result = resolveIdentityDbPath({ cwd: dir, homeDir });
      assert.equal(
        result,
        globalDefaultDbPath(homeDir),
        "全局模式下即便 cwd 有合法 brain.local.json 也不该被读取/使用",
      );
      assert.notEqual(result, "/should/never/be/returned.db");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }

  // ⑧（issue #93 B1）全局模式 + 同时设了 env db path → env 仍最高优先级。
  {
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
    process.env.AELOOP_BRAIN_IDENTITY_DB = "/absolute/path/from/env.db";
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, "/absolute/path/from/env.db", "全局模式下 env 仍应优先于全局默认路径");
  }

  // ⑨（issue #93 B1）未设 AELOOP_BRAIN_GLOBAL_MODE（含显式设为其它值）→ 现有行为字节级不变
  //    （回归——①-⑤ 已经在 AELOOP_BRAIN_GLOBAL_MODE 未设的前提下跑过一遍并全部通过，这里再显式
  //    验证"设成非 '1' 的值"不会被误判成全局模式，同样应该走项目本地 fallback 分支）。
  {
    delete process.env.AELOOP_BRAIN_IDENTITY_DB;
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "0";
    setLocalConfig(JSON.stringify({ identityDbPath: "/absolute/path/from/local/json.db" }));
    const result = resolveIdentityDbPath({ cwd: dir });
    assert.equal(result, "/absolute/path/from/local/json.db", "非 '1' 的值不应触发全局模式");
  }

  console.log(
    "PASS: test-db-path.mjs (issue #88 B9 — env 优先 + 本地 json fallback + 坏输入不抛错；" +
      "issue #93 B1 — 全局模式物理隔离 + env 优先级不变 + 非全局模式零回归)",
  );
} finally {
  if (originalEnv === undefined) delete process.env.AELOOP_BRAIN_IDENTITY_DB;
  else process.env.AELOOP_BRAIN_IDENTITY_DB = originalEnv;
  if (originalGlobalMode === undefined) delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
  else process.env.AELOOP_BRAIN_GLOBAL_MODE = originalGlobalMode;
  rmSync(dir, { recursive: true, force: true });
}
