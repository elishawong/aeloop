// test-task-source.mjs — issue #103 单元测试：task-source.mjs。
//
// 覆盖 docs/enterprise-board-toggle/DESIGN.md §3/§11："默认 none；env 最高优先级；全局模式跳过
// brain.local.json fallback；非法值 fail-closed 到 none，不是 fail-open 到 github"。
//
// 跑法：node .claude/hooks/lib/test-task-source.mjs（零依赖）。

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_TASK_SOURCE, VALID_TASK_SOURCES, resolveTaskSource } from "./task-source.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "brain-test-tasksource-"));
const originalEnv = process.env.AELOOP_BRAIN_TASK_SOURCE;
const originalGlobalMode = process.env.AELOOP_BRAIN_GLOBAL_MODE;

function setLocalConfig(content) {
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(path.join(claudeDir, "brain.local.json"), content);
}

try {
  // ① 值域/默认值常量本身。
  assert.deepEqual(VALID_TASK_SOURCES, ["none", "github"]);
  assert.equal(DEFAULT_TASK_SOURCE, "none");

  // ② 两个配置源都无 → 默认 "none"（shipped 零 GitHub，issue #103 的核心决策）。
  {
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "none", "什么都没配时应默认 none");
  }

  // ③ env 未设 + 本地 json 合法（taskSource:"github"） → 用 json 值。
  {
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    setLocalConfig(JSON.stringify({ taskSource: "github" }));
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "github", "应从本地 json 读到 taskSource");
  }

  // ④ env 设了 → 优先用 env（即便本地 json 也存在且值不同）。
  {
    process.env.AELOOP_BRAIN_TASK_SOURCE = "none";
    const result = resolveTaskSource({ cwd: dir }); // 本地 json 仍是上一步写的 github
    assert.equal(result, "none", "env 存在时应优先于本地 json");
  }

  // ⑤ env 设了非法值 → fail-closed 到 "none"，不是 fail-open 到 "github"。
  {
    process.env.AELOOP_BRAIN_TASK_SOURCE = "githb"; // 拼错
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "none", "非法 env 值必须 fail-closed 到 none，不能意外打开 github 路径");
  }

  // ⑥ 本地 json 是坏 JSON → 不抛错，回落默认值。
  {
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    setLocalConfig("{ this is not valid json");
    assert.doesNotThrow(() => resolveTaskSource({ cwd: dir }), "坏 JSON 不该抛错");
    assert.equal(resolveTaskSource({ cwd: dir }), "none", "坏 JSON 应视为未配置，回落默认值");
  }

  // ⑦ 本地 json 合法但字段缺失/非法值 → 默认值（不是抛错，也不是 undefined）。
  {
    setLocalConfig(JSON.stringify({ someOtherField: 1 }));
    assert.equal(resolveTaskSource({ cwd: dir }), "none", "字段缺失应视为未配置");
    setLocalConfig(JSON.stringify({ taskSource: "not-a-real-source" }));
    assert.equal(resolveTaskSource({ cwd: dir }), "none", "本地 json 里的非法值同样 fail-closed 到 none");
  }

  // ⑧ 全局模式：即便 cwd 有合法 brain.local.json（taskSource:"github"），也不该被读取——
  //    物理上跳过这条 fallback，不是"读了但优先级更低"（同 db-path.mjs 全局分支的既有保证）。
  {
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
    setLocalConfig(JSON.stringify({ taskSource: "github" }));
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "none", "全局模式下不该读取 cwd 的 brain.local.json，应回落默认值");
  }

  // ⑨ 全局模式 + 同时设了 env → env 仍最高优先级（个人版 Helix opt-in 走这条路径，DESIGN §8）。
  {
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
    process.env.AELOOP_BRAIN_TASK_SOURCE = "github";
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "github", "全局模式下 env 仍应优先于全局默认值");
  }

  // ⑩ 未设 AELOOP_BRAIN_GLOBAL_MODE（含显式设为其它值）→ 非全局模式 fallback 分支照常生效。
  {
    delete process.env.AELOOP_BRAIN_TASK_SOURCE;
    process.env.AELOOP_BRAIN_GLOBAL_MODE = "0";
    setLocalConfig(JSON.stringify({ taskSource: "github" }));
    const result = resolveTaskSource({ cwd: dir });
    assert.equal(result, "github", "非 '1' 的值不应触发全局模式，本地 json fallback 应照常生效");
  }

  console.log(
    "PASS: test-task-source.mjs (issue #103 — 默认 none + env 最高优先级 + 全局模式跳过本地 json + " +
      "非法值 fail-closed 到 none，不 fail-open 到 github)",
  );
} finally {
  if (originalEnv === undefined) delete process.env.AELOOP_BRAIN_TASK_SOURCE;
  else process.env.AELOOP_BRAIN_TASK_SOURCE = originalEnv;
  if (originalGlobalMode === undefined) delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
  else process.env.AELOOP_BRAIN_GLOBAL_MODE = originalGlobalMode;
  rmSync(dir, { recursive: true, force: true });
}
