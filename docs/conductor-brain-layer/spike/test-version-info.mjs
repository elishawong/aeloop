// test-version-info.mjs — issue #98 单元测试：lib/version-info.mjs 的 resolveVersionLine()，
// 外加跨 .mjs/.ts 边界的四面版本一致性钉子测试（Zorro 独立复审 #2 要求）。
//
// 覆盖：dist/ 已构建（真实场景,真跑一次） / dist/ 缺失(fail-soft, undefined, 不抛错) /
// version-info.generated.js 存在但内容不是预期形状(fail-soft) / versionString 原样透传（不再
// 自己拼 -dirty 后缀）/ **跨 .mjs+.ts 边界，把 wake-greeting/CLI/EvidenceBundle/生成产物四个
// 面的版本串钉在一起，逐字节相同**（此前没有任何测试锁死"四面一致"这条不变量,只是分别测每个
// 面各自内部行为对不对）。
//
// 跑法：pnpm run build && node docs/conductor-brain-layer/spike/test-version-info.mjs
// （需要先 build，第一组用例 + 一致性钉子用例都要读真实 dist/ 产物,含真 spawn 一次
// `dist/cli/bin.js --version`）。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVersionLine } from "./lib/version-info.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_REPO_ROOT = path.join(HERE, "..", "..", "..");

let passCount = 0;
async function check(label, fn) {
  await fn();
  passCount += 1;
  console.log(`  ok - ${label}`);
}

function buildFakeRepoWithGeneratedVersion(info) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "version-info-test-"));
  const dir = path.join(repoRoot, "dist", "shared");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "version-info.generated.js"),
    `export const GENERATED_VERSION_INFO = ${JSON.stringify(info)};\n`,
  );
  return repoRoot;
}

await check("真实场景：本仓库自己 build 出的 dist/shared/version-info.generated.js 能被正确读出、格式化", async () => {
  const line = await resolveVersionLine(REAL_REPO_ROOT);
  assert.ok(line, "本仓库已经 build 过（跑本测试的前置步骤），version-info.generated.js 应该存在");
  assert.match(line, /^aeloop \S+\+\S+/, `格式应为 "aeloop <version>+<sha>[-dirty]"，实际："${line}"`);
});

await check(
  "issue #98 Zorro 独立复审 #2：跨 .mjs/.ts 边界一致性钉子 —— .mjs 的 resolveVersionLine()、编译后 " +
    "dist/shared/version.js 导出的 .ts VERSION_STRING、真实生成产物 GENERATED_VERSION_INFO.versionString、" +
    "以及一个真实构造出的 EvidenceBundle.engineVersion，四者必须逐字节相同（不是巧合相等——三处消费方" +
    "现在都读同一个生成的 versionString 字段，这条测试把这个不变量钉死，而不是分别测四处各自内部一致）",
  async () => {
    const line = await resolveVersionLine(REAL_REPO_ROOT);

    // 编译后的 .ts 消费方（src/shared/version.ts → dist/shared/version.js）——这个 .mjs 测试
    // 文件物理上不能 import 那个 .ts 源文件，但可以 import 它编译出的 .js 产物，这正是"跨 .mjs/
    // .ts 边界"这句话字面意义上的验证：两个不同语言世界读的是不是同一个值。
    const { VERSION_STRING } = await import(path.join(REAL_REPO_ROOT, "dist", "shared", "version.js"));

    // 生成产物本身（scripts/generate-version.mjs 的输出，三处消费方共同的单一事实源）。
    const { GENERATED_VERSION_INFO } = await import(
      path.join(REAL_REPO_ROOT, "dist", "shared", "version-info.generated.js")
    );

    // EvidenceBundle 面（src/evidence/bundle.ts → dist/evidence/bundle.js）——真实构造一个
    // bundle,不 mock。
    const { EvidenceBundleBuilder } = await import(path.join(REAL_REPO_ROOT, "dist", "evidence", "bundle.js"));
    const bundle = new EvidenceBundleBuilder({ runId: 1 }).build();

    assert.equal(line, `aeloop ${VERSION_STRING}`, "wake-greeting 版本行应该恰好是 \"aeloop \" + VERSION_STRING，不多不少");
    assert.equal(VERSION_STRING, GENERATED_VERSION_INFO.versionString, ".ts 消费方读到的 VERSION_STRING 必须和生成产物的 versionString 字段逐字节相同");
    assert.equal(bundle.engineVersion, VERSION_STRING, "EvidenceBundle.engineVersion 必须和 CLI/wake-greeting 用的同一个 VERSION_STRING 完全一致");
    assert.equal(bundle.engineVersion, GENERATED_VERSION_INFO.versionString, "EvidenceBundle 面同样直接对得上生成产物的 versionString，不是独立算出来的巧合值");

    // CLI 面——真 spawn 编译产物 dist/cli/bin.js --version（不是 mock，四个面里唯一一个必须
    // 起子进程才能拿到输出的面）。
    const cliOutput = execFileSync("node", [path.join(REAL_REPO_ROOT, "dist", "cli", "bin.js"), "--version"], {
      encoding: "utf8",
    }).trim();
    assert.equal(cliOutput, `aeloop ${VERSION_STRING}`, "CLI --version 输出必须和其它三个面用的同一个 VERSION_STRING 完全一致");
  },
);

await check("dist/ 整个不存在（未 build）→ fail-soft 返回 undefined，不抛错", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "version-info-test-nodist-"));
  try {
    await assert.doesNotReject(async () => {
      const line = await resolveVersionLine(repoRoot);
      assert.equal(line, undefined);
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

await check("version-info.generated.js 存在但内容形状不对（缺 versionString）→ fail-soft 返回 undefined", async () => {
  // issue #98 Zorro 复审 #2 之后，resolveVersionLine() 读的是 versionString 字段本身（不再自己
  // 拼 packageVersion+gitSha[-dirty]）——这条用例改成缺 versionString（哪怕 packageVersion/gitSha
  // 都在，没有 versionString 就该 fail-soft）。
  const repoRoot = buildFakeRepoWithGeneratedVersion({ packageVersion: "1.0.0", gitSha: "abc1234", gitDirty: false });
  try {
    const line = await resolveVersionLine(repoRoot);
    assert.equal(line, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

await check("version-info.generated.js 的 versionString 是空字符串 → fail-soft 返回 undefined，不是 \"aeloop \"", async () => {
  const repoRoot = buildFakeRepoWithGeneratedVersion({ packageVersion: "1.0.0", gitSha: "abc1234", gitDirty: false, versionString: "" });
  try {
    const line = await resolveVersionLine(repoRoot);
    assert.equal(line, undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

await check("versionString 字段原样透传（不再自己拼 -dirty 后缀——issue #98 Zorro 复审 #2，单一格式化真源在 generate-version.mjs）", async () => {
  const repoRoot = buildFakeRepoWithGeneratedVersion({
    packageVersion: "1.2.3",
    gitSha: "abc1234",
    gitDirty: true,
    versionString: "1.2.3+abc1234-dirty",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  try {
    const line = await resolveVersionLine(repoRoot);
    assert.equal(line, "aeloop 1.2.3+abc1234-dirty", "resolveVersionLine() 只应该在前面加 \"aeloop \" 前缀，versionString 本身原样透传");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

await check("versionString 不带 -dirty 后缀时同样原样透传", async () => {
  const repoRoot = buildFakeRepoWithGeneratedVersion({
    packageVersion: "1.2.3",
    gitSha: "abc1234",
    gitDirty: false,
    versionString: "1.2.3+abc1234",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  try {
    const line = await resolveVersionLine(repoRoot);
    assert.equal(line, "aeloop 1.2.3+abc1234");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

await check("versionString 里的 unknown-sha（生成时拿不到 git）→ 照常透传，不特殊处理成 undefined", async () => {
  const repoRoot = buildFakeRepoWithGeneratedVersion({
    packageVersion: "0.0.1",
    gitSha: "unknown-sha",
    gitDirty: false,
    versionString: "0.0.1+unknown-sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  try {
    const line = await resolveVersionLine(repoRoot);
    assert.equal(line, "aeloop 0.0.1+unknown-sha");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

console.log(`PASS: test-version-info.mjs (${passCount} assertions groups, issue #98)`);
