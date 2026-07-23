# progress — issue #98 版本戳

## 状态：Round 1 实现完成 → Zorro 独立复审(Codex gpt-5.6-sol 二签)判 FAIL(1 blocker + 3 处
准确性/覆盖缺口) → Round 2 修复完成,全部自检通过,待 Zorro 复审收口

## Round 2(Zorro 复审返工)

- **🔴 blocker 修复**:`src/cli/main.ts` 的 `unknownOption` 检测此前排在 `values.version`/
  `values.help` 两个 early-return **之后**,导致 `--version --bogus`/`--bogus --version`/
  `-vx`/`--help --bogus` 全部被静默吞掉、exit0(应报错 exit1)。修法:把 `unknownOption` 检测
  挪到两个 early-return **之前**。补 4 条对应回归用例(`main.test.ts`)。真跑 `dist/cli/bin.js`
  复现 4 个原始场景全部改判正确(exit1 + 报错信息),控制组(`--version`/`--help`/`--bogus`
  各自单独跑)行为不变。
- **#2 单一格式化真源**:采纳军师建议的方案——`scripts/generate-version.mjs` 新增
  `formatVersionString()`,把**格式化好的完整 `versionString`** 字段也写进生成产物
  (`GeneratedVersionInfo` 新增该字段);`src/shared/version.ts`/`docs/conductor-brain-layer/
  spike/lib/version-info.mjs`/`scripts/install-global-brain.mjs` 三处消费方全部改成**读**
  这个字段,不再各自拼 `+`/`-dirty`。补一条**跨 `.mjs`+`.ts` 边界**的一致性钉子测试
  (`test-version-info.mjs`):真实 spawn `dist/cli/bin.js --version` + 动态 import 编译后的
  `dist/shared/version.js`(.ts 消费方)+ 动态 import `dist/shared/version-info.generated.js`
  (生成产物本身)+ 真构造一个 `EvidenceBundle`,四者断言逐字节相同。同时订正 `version.ts` 头
  注释此前"the one place every consumer imports from"的过度断言(`.mjs` 消费方物理上不能
  `import` `.ts` 文件,准确说法见新头注释)。
- **#3 hook 级 fail-soft 负向用例 + 订正不实注释**:`test-hook-greeting.mjs` 新增⑦段——真实
  把本仓库 `dist/shared/version-info.generated.js` 临时改名挪走、真 spawn hook,断言 exit 0 +
  无版本行 + 开场白其余部分完整,`finally` 无条件挪回文件。订正⑥段此前"fail-soft 已由
  `test-version-info.mjs` 覆盖"的不准确表述(那个测试只覆盖 `resolveVersionLine()` 返回值,
  没覆盖 hook `main()` 自己的 try/catch + 条件渲染路径),`impact.md` 同款措辞一并订正。
- **#4 `impact.md` 自相矛盾订正**:此前先说 `--help` 输出多一行/多版本号,又把它列进"行为逐
  字节不变"——改成:分发/exit code **行为**不变,`--help` **文本**确实变了(附带记录 blocker
  修复)。
- **知识库同步**:`CHARTS/knowledge/aeloop.md`(ai-agent 仓库,`elishawong/ai-agent#133` 跟踪)
  顶部 last-verified 从过期的 `c8d0289` 订正到当前基线 `9d568ad`;订正长期失实的"A5 是本机
  未提交分支、main 无 `src/cli/`"表述(`git merge-base --is-ancestor ee1f262 9d568ad` 已验证
  A5 早已合并);`main.ts + bin.ts` 条目新增 issue #98 的 `--version`/`-v` 变更记录(含 blocker
  复盘)。如实标注一个未在本次收口的已知覆盖缺口:#88/#93/#94 三个更新的合并特性尚未在这份
  知识库建索引,留作后续单独任务。

## 批次完成情况(Round 1,原批次结构未变,Round 2 是在同一批次内修复)

- [x] **B0 — 单一事实源**:`scripts/generate-version.mjs`（build 时刻固化,Round 2 新增
      `formatVersionString()`)+ `src/shared/version.ts`（格式化包装层,Round 2 起改为直接读
      `versionString`)+ `.gitignore` 新增一行 + `package.json` 的
      `build`/`lint`/`test`/`test:watch` 四个 script 前置 `node scripts/generate-version.mjs
      &&` + `scripts/test-generate-version.mjs`（17 组断言,Round 2 净增 3)+
      `src/shared/__tests__/version.test.ts`（vitest,6 条用例)。
- [x] **B1 — CLI**:`src/cli/main.ts` 新增 `--version`/`-v`(`KNOWN_OPTIONS`/`unknownOption`
      白名单/`HELP_TEXT`,Round 2 修复 unknownOption 检测顺序 blocker),
      `src/cli/__tests__/main.test.ts` 新增 8 条用例(Round 1 四条 + Round 2 blocker 回归
      四条)。真跑 `node dist/cli/bin.js` 复现并验证全部 blocker 场景。
- [x] **B2 — EvidenceBundle**:`src/evidence/bundle.ts` 新增必填字段
      `engineVersion: string`,`build()` 填入 `VERSION_STRING`。`bundle.test.ts` 新增
      1 条用例。真构造一次 bundle 验证和 CLI 输出完全一致。
- [x] **B3 — 醒来开场白**:新文件 `docs/conductor-brain-layer/spike/lib/version-info.mjs`
      (`resolveVersionLine()`,fail-soft,Round 2 改读 `versionString`)+ `render-greeting.mjs`
      新增 `versionLine` 可选字段渲染 + `brain-wake-greeting.mjs` 新增 `REPO_ROOT` 常量与独立
      try/catch 的版本行解析。`test-version-info.mjs`(8 组,Round 2 净增跨边界一致性钉子)、
      `test-greeting.mjs` 新增 4 条断言、`test-hook-greeting.mjs` 新增两个真实 spawn 的端到端
      用例(⑥正向 + ⑦Round 2 新增的 fail-soft 负向)。真跑 hook(带真实身份库)验证
      additionalContext 里出现版本行,以及 dist/ 缺失时的 fail-soft 路径。
- [x] **B4 — 全局安装**:`install-global-brain.mjs` 的 `COPY_ITEMS` 新增
      `version-info.mjs` 一条;`installGlobalBrain()` 末尾从**换入后的 snapshotDir**同步
      读取 `versionString` 字段(正则提取,不用动态 `import()`,避免把该函数变成 async 波及
      现有几十处 `assert.throws` 同步断言),CLI 输出新增"已安装版本"一行。`test-install-
      global-brain.mjs` 新增 3 条用例(fail-soft + 正常路径 x2,Round 2 更新 fixture 加
      `versionString` 字段),57 组断言全绿。真跑 `--target=<临时目录>`(非 dry-run)安装到
      临时目录,确认 `repo-snapshot/` 下没有 `.git`、`dist/shared/version-info.generated.js`
      存在且版本正确、`version-info.mjs` 已拷贝、独立 spawn 该目录下的 hook 依然能正确渲染
      版本行(证明运行时不现算 git)。

## 自检证据汇总(Round 2 收尾后)

- `pnpm test`(vitest,`src/**/*.test.ts`):**634/634 通过**(Round 1 是 630,Round 2 净增 4 条
  main.test.ts blocker 回归)。
- `pnpm run build` / `pnpm run lint`:全绿,零 tsc 错误。
- 全新 clone 场景(手动删除 `src/shared/version-info.generated.ts` 后直接 `pnpm test`,
  不预先手动生成):通过 —— 证明 `package.json` script 接线是真的接上了。
- 无 git 环境场景(`rsync` 出一份不带 `.git` 的仓库副本,跑
  `node scripts/generate-version.mjs --repo-root=<副本>`):`gitSha === "unknown-sha"`,
  不抛错。
- 独立 node 测试脚本(不进 vitest,风格对齐既有 `test-install-global-brain.mjs`):
  - `scripts/test-generate-version.mjs`:**17** 组断言通过(Round 2 净增 3:`formatVersionString`
    x3)。
  - `docs/conductor-brain-layer/spike/test-version-info.mjs`:**8** 组断言通过(Round 2 净增 2:
    跨 `.mjs`/`.ts` 边界一致性钉子 + versionString 空字符串 fail-soft)。
  - `scripts/test-install-global-brain.mjs`:57 组断言通过(含 Round 1 新增 3 条,Round 2 更新
    fixture 内容)。
  - `docs/conductor-brain-layer/spike/test-greeting.mjs`:通过(含新增 versionLine 用例)。
  - `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`:通过(⑥正向 + **⑦Round 2 新增
    的 hook 级 fail-soft 负向端到端用例**)。
  - `docs/conductor-brain-layer/spike/test-status-table.mjs` / `test-wake.mjs` /
    `test-three-state-gate.mjs` / `test-translator.mjs`:回归通过(未改动,复核零连带破坏)。
- 端到端真实验证:
  - `node dist/cli/bin.js --version` → `aeloop 0.0.1+9d568ad-dirty`。
  - `node dist/cli/bin.js --version --bogus` / `--bogus --version` / `-vx` / `--help --bogus`
    四个 Zorro 复现场景 → 均正确报 `unrecognized option` + exit1(Round 2 blocker 修复验证)。
  - 真构造 `EvidenceBundle` → `engineVersion: "0.0.1+9d568ad-dirty"`(和 CLI 输出完全
    一致)。
  - 真跑 `brain-wake-greeting.mjs`(有身份库)→ additionalContext 第二行
    `aeloop 0.0.1+9d568ad-dirty`。
  - 真跑 `install-global-brain.mjs --target=<临时目录>`(非 dry-run)→ 安装完成打印
    `已安装版本: 0.0.1+9d568ad-dirty`;`repo-snapshot/` 确认无 `.git`;独立 spawn 该
    目录下的 hook(`AELOOP_BRAIN_GLOBAL_MODE=1`)→ additionalContext 里同样出现
    `aeloop 0.0.1+9d568ad-dirty`——证明运行时读的是 build 时刻固化的产物,不是现算 git。

## 未提交

按指挥官安排,本批次只做到"实现 + 自检",不 commit/push——交给军师统一在门禁后处理。
