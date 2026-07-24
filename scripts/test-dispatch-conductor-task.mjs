// test-dispatch-conductor-task.mjs — issue #2 batch 1 单元测试：dispatch-conductor-task.mjs。
//
// 这个文件是纯 CLI 入口（没有 `import.meta.url` 库/CLI 双模式判断，`main()` 无条件执行），
// 不能像 `dispatch-brain-task.mjs`/`conductor-dispatch-core.mjs` 那样直接 import 函数注入 mock
// ——所以本文件用 `execFileSync` 真的把它当子进程跑，只测试两条不需要真实 LLM 调用的 fail-fast
// 路径（同 `main()` 里两处提前 return 的分支）：
//   ① 空/纯空白参数 → 用法错误，exit code 2，不发起任何身份库/LLM 调用。
//   ② 身份库 dbPath 未配置 → 明确的结构化错误 JSON，exit code 1，不发起任何 LLM 调用。
// 完整闭环（真的调用 assembleProfileDeps/startRun/resumeRun）是人工 self-check，同
// `run-spike.mjs`/`dispatch-brain-task.mjs` 的既有惯例，不在这里自动化。
//
// 跑法：node scripts/test-dispatch-conductor-task.mjs（需要先 pnpm run build 生成 dist/）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(HERE, "dispatch-conductor-task.mjs");

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

function runCli(args, env) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (err) {
    // execFileSync throws on non-zero exit — `err.status`/`err.stdout`/`err.stderr` carry the
    // real result, same pattern other scripts/test-*.mjs files in this repo don't yet use but is
    // the standard Node idiom for "assert on a CLI's non-zero exit".
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function main() {
  // ── ① 空参数 → 用法错误，exit code 2 ──────────────────────────────────────────────────
  {
    const result = runCli([]);
    check("空参数 → exit code 2（用法错误，不是崩溃）", () => {
      assert.equal(result.code, 2);
    });
    check("空参数 → stderr 包含用法提示", () => {
      assert.match(result.stderr, /用法/);
    });
  }

  // ── ② 纯空白参数同样触发用法错误（和 conductor-dispatch-core.mjs 的 fail-closed 语义一致，
  //    但这里测的是 CLI 层自己的 .trim() 检查，不是委托给 translateIntent() 的那一层） ──────
  {
    const result = runCli(["   "]);
    check('纯空白参数（"   "）→ exit code 2', () => {
      assert.equal(result.code, 2);
    });
  }

  // ── ③ 身份库 dbPath 未配置 → 结构化错误 JSON，exit code 1，不是空/纯空白参数那条路径 ──────
  {
    const result = runCli(["一个合法的意图文本"], {
      AELOOP_BRAIN_IDENTITY_DB: "",
      AELOOP_BRAIN_GLOBAL_MODE: "",
    });
    check("身份库未配置 → exit code 1", () => {
      assert.equal(result.code, 1);
    });
    check("身份库未配置 → stdout 是结构化 JSON，error 字段是 NO_IDENTITY_DB_PATH", () => {
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error, "NO_IDENTITY_DB_PATH");
    });
  }

  console.log(`PASS: test-dispatch-conductor-task.mjs (${passCount} assertions groups, issue #2 batch 1)`);
}

main();
