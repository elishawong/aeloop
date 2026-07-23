# Plan — aeloop: conductor-brain 多项目地基（issue #93，片①）

> Companion to `PRD.md`。批次定义/依赖关系见 PRD §5，本文件只展开每批具体"怎么做"+ self-check 命令。建议执行顺序：**{B0, B1} 并行 → B2 → B3 → B4 → B5**（B5 收尾，依赖全部）。所有批次落在同一分支 `design/issue-93-multiproject-brain`。

---

## B0 — 全局安装脚本 [L] ⚠️ 高风险

**依赖**：无。

**文件**：
- `scripts/install-global-brain.mjs`（新）
- `scripts/test-install-global-brain.mjs`（新）

**Do**：
1. 常量：`INSTALL_DIR = path.join(os.homedir(), ".claude", "aeloop-brain")`、`SNAPSHOT_DIR = path.join(INSTALL_DIR, "repo-snapshot")`、`DATA_DIR = path.join(INSTALL_DIR, "data")`。全部依赖注入（`homeDir` 参数默认 `os.homedir()`，测试传临时目录）。
2. `execFileSync("pnpm", ["run", "build"], {cwd: REPO_ROOT})`（`execImpl` 可注入，测试用假实现）。
3. `rmSync(SNAPSHOT_DIR, {recursive:true, force:true})` 后重建，逐条拷贝（保留相对目录骨架，`fs.cpSync(src, dest, {recursive:true})`）：
   - `dist/` → `SNAPSHOT_DIR/dist/`
   - `.claude/hooks/brain-wake-greeting.mjs` → `SNAPSHOT_DIR/.claude/hooks/brain-wake-greeting.mjs`
   - `.claude/hooks/lib/db-path.mjs` → `SNAPSHOT_DIR/.claude/hooks/lib/db-path.mjs`
   - `.claude/hooks/lib/git-remote.mjs` → `SNAPSHOT_DIR/.claude/hooks/lib/git-remote.mjs`
   - `docs/conductor-brain-layer/spike/lib/{wake,greeting-data,render-greeting,status-table,sanitize}.mjs` → `SNAPSHOT_DIR/docs/conductor-brain-layer/spike/lib/*.mjs`
4. 读 aeloop 自己 `package.json` 的 `dependencies["better-sqlite3"]` 版本号（不手打），写 `SNAPSHOT_DIR/package.json`：`{"name":"aeloop-brain-runtime","private":true,"dependencies":{"better-sqlite3":"<版本号>"}}`；`execFileSync("npm", ["install", "--omit=dev"], {cwd: SNAPSHOT_DIR})`（`execImpl` 可注入）。
5. `mkdirSync(DATA_DIR, {recursive:true})`。
6. 读 `path.join(homeDir, ".claude", "settings.json")`（不存在 → `{}`）；写备份 `settings.json.bak-<ISO时间戳去掉冒号>`；确保 `hooks.SessionStart` 是数组；`snapshotHookPath = path.join(SNAPSHOT_DIR, ".claude", "hooks", "brain-wake-greeting.mjs")`；`command = \`AELOOP_BRAIN_GLOBAL_MODE=1 node "${snapshotHookPath}"\``；若数组里已存在一个 hook 的 `command` 字段**精确等于**这个字符串 → 跳过（幂等）；否则 `push({matcher:"startup|resume|clear", hooks:[{type:"command", command}]})`；`writeFileSync` 写回（`JSON.stringify(config, null, 2)`）。
7. `--dry-run`：跑完①-⑥ 的**计算**部分，打印将要做的改动摘要，`return` 之前不调用任何 `fs.writeFileSync`/`fs.cpSync`/`execFileSync`（用一个 `dryRun` 布尔贯穿所有写操作前的分支）。
8. 测试：
   - 用临时目录当 `homeDir`，`execImpl`/`fs` 操作全部走真实文件系统（临时目录本身是真实的，只是不是用户真的 `~`）——`execFileSync("pnpm",...)`/`execFileSync("npm",...)` 用可注入假实现（不真的跑 build/install，验证调用参数）。
   - 首次安装 → `SNAPSHOT_DIR` 下预期文件树存在（用 fixture 的假 `dist/`/hook 文件模拟真实 aeloop checkout 结构，不依赖真的跑 `pnpm run build`）。
   - 已有 `~/.claude/settings.json`（fixture 内容含一条无关的 `SessionStart` hook）→ 安装后该条目原样保留（deep-equal 断言），仅追加一条新的。
   - 二次运行 → `hooks.SessionStart` 数组长度不变（幂等）。
   - `--dry-run` → 断言 `SNAPSHOT_DIR`/`DATA_DIR` 均未被创建，`settings.json` 内容未变。

**Self-check**：`node scripts/test-install-global-brain.mjs`；**人工**（不进自动化 CI）：在一台干净测试机或用真实 `~/.claude/settings.json` 先手动备份一份后，真跑一次 `node scripts/install-global-brain.mjs`，人工核对 `~/.claude/settings.json` 的 diff 只有新增、`~/.claude/aeloop-brain/repo-snapshot/` 目录树完整、`node ~/.claude/aeloop-brain/repo-snapshot/.claude/hooks/brain-wake-greeting.mjs < /dev/null` 能不报错跑完（无身份库配置时安静退出，回归 #84 既有行为）。

---

## B1 — `db-path.mjs` 全局模式 [S]

**依赖**：无（可与 B0 并行；B0 安装出的 snapshot 跑的就是这份代码，逻辑上建议先合并再跑 B0 的人工 self-check，但两者的自动化测试互不阻塞）。

**文件**：
- `.claude/hooks/lib/db-path.mjs`（编辑）
- `.claude/hooks/lib/test-db-path.mjs`（编辑）

**Do**：
1. 新增导出常量 `GLOBAL_DEFAULT_DB_PATH = path.join(os.homedir(), ".claude", "aeloop-brain", "data", "identity.db")`（供 B0 测试/文档引用同一个真源，不各自拼接）。
2. `resolveIdentityDbPath({cwd = process.cwd()} = {})` 判定顺序改为：① `process.env.AELOOP_BRAIN_IDENTITY_DB` 非空 → 直接返回（不变）；② `process.env.AELOOP_BRAIN_GLOBAL_MODE === "1"` → 返回 `GLOBAL_DEFAULT_DB_PATH`，**函数在此分支直接 return，不执行下面读 `<cwd>/.claude/brain.local.json` 的代码**（物理保证，不是"读了但忽略结果"）；③（原有逻辑，字节级不变）读 `<cwd>/.claude/brain.local.json`；④ 都没有 → `null`。
3. 测试新增：
   - `AELOOP_BRAIN_GLOBAL_MODE=1`，无 env db path，`cwd` 指向一个**不存在**的目录 → 仍正确返回 `GLOBAL_DEFAULT_DB_PATH`，不抛错（证明第②步之后确实不再碰 `cwd`）。
   - 同上但 `cwd` 指向一个**存在且有合法 `brain.local.json`** 的目录 → 仍返回 `GLOBAL_DEFAULT_DB_PATH`（不是 local json 里的值，证明全局模式下 local json 分支被完全跳过，不是"读了但优先级更低"）。
   - `AELOOP_BRAIN_GLOBAL_MODE=1` + 同时设了 `AELOOP_BRAIN_IDENTITY_DB=/tmp/x.db` → 返回 `/tmp/x.db`（env 仍最高优先级）。
   - 未设 `AELOOP_BRAIN_GLOBAL_MODE`（含显式设为其它值如 `"0"`/`""`）→ 已有全部用例原样通过，零回归。

**Self-check**：`node .claude/hooks/lib/test-db-path.mjs`。

---

## B2 — `onboard-project.mjs` [S]

**依赖**：B1。

**文件**：
- `scripts/onboard-project.mjs`（新）
- `scripts/test-onboard-project.mjs`（新）

**Do**：
1. CLI 参数解析：`--repo-path <path>`（必需）、`--display-name <name>`（可选）。
2. `resolveIdentityDbPath()`（B1）无结果 → 打印提示，`process.exitCode = 1`，不继续。
3. `getOriginOwnerRepo(repoPath)`（`.claude/hooks/lib/git-remote.mjs`，已有函数，直接复用不改）→ `{ok:false}` → 打印提示，`process.exitCode = 1`，身份库零写入（**在打开 `MemoryStore` 之前**就要失败，不能先开库再发现算不出 owner/repo）。
4. 打开 `MemoryStore(dbPath)`，upsert（复用 `seed-brain-identity.mjs` 已有的 `findExisting`/`upsertMemory` 模式，抽成共享函数 `.claude/hooks/lib/memory-upsert.mjs`（新，微型共享库，`seed-brain-identity.mjs` 同步改为调用它而不是保留自己那份重复实现——**这是本批次顺手做的一个小重构，不新增行为，只消除两处即将同时存在的重复 upsert 逻辑**）：`type:"project_registry"`, `title: \`project:${owner}/${repo}\``, `content: displayName ?? \`${owner}/${repo}\``, `tags: [\`project:${owner}/${repo}\`]`, `confidenceState:"confirmed"`，按 `title` 匹配。
5. 打印结果（`inserted`/`unchanged`/`content-updated`）+ `store.close()`。
6. 测试：临时目录建假 git repo（`execFileSync('git',['init',...])` + `git remote add origin <SSH或HTTPS url>` + `execFileSync('git',['-C',dir,'config','user.email','test@test'])`/`user.name` 视 CI 环境是否需要）；用临时身份库 `.db` 文件（不碰真实全局默认路径，`AELOOP_BRAIN_IDENTITY_DB` 显式指向临时文件）；断言：首次 upsert 正确；二次 `unchanged`；**onboard 前后对 fixture 目录 `git status --porcelain`（`execFileSync('git',['-C',dir,'status','--porcelain'])`）输出完全相同**；非 git 目录/无 origin → 报错退出码非零 + `store.listMemories()` 长度为 0。

**Self-check**：`node scripts/test-onboard-project.mjs`。

---

## B3 — `seed-brain-identity.mjs` 多项目扩展 [S/M]

**依赖**：B2。

**文件**：
- `scripts/seed-brain-identity.mjs`（编辑）
- `scripts/test-seed-brain-identity.mjs`（编辑）
- `.claude/hooks/lib/memory-upsert.mjs`（新，见 B2 第4步——若 B2 已经抽出这个共享库，本批次直接复用；若排期上 B3 先于 B2 完成这个重构，则本批次负责抽出，B2 改为复用，两批次谁先做谁负责抽取，另一批次改为纯复用，写代码时以实际先完成的批次为准，PRD 不强行指定谁先）

**Do**：
1. `resolveActiveTaskTags(issue)` 签名扩展为 `resolveActiveTaskTags(issue, projectTag)`，两个既有分支（`CLOSED`/`OPEN`）返回数组末尾追加 `projectTag`。
2. `main()` 新增：在 issue 同步循环之前，`const projectTag = \`project:${origin.owner}/${origin.repo}\`;` 紧接着 `const registered = store.listMemories().some((m) => m.type === "project_registry" && m.tags.includes(projectTag));` → `!registered` → 抛错（`err.code = "PROJECT_NOT_ONBOARDED"`），消息里带 `onboard-project.mjs --repo-path <path>` 的提示，**在这一步 return/throw，不进入 issue 同步循环**。
3. `resolveActiveTaskTags(issue, projectTag)` 调用点更新（原来的调用点加第二参数）。
4. 测试新增：目标项目未注册（临时身份库无对应 `project_registry`）→ `main()` reject/throw，`result.issues` 未产生（或函数根本没跑到那一步）；目标项目已注册 → 注入假 `fetchOpenIssues` 覆盖既有 5 种映射场景，逐条断言 `tags` 数组末尾含正确的 `project:*`；二次运行（内容不变，含新的 `project:*` tag 在内）→ 仍然真幂等（`updateMemoryContent`/`insertMemory` 零调用）。

**Self-check**：`node scripts/test-seed-brain-identity.mjs`。

---

## B4 — 项目分组渲染 [M]

**依赖**：B3。

**文件**：
- `.claude/hooks/brain-wake-greeting.mjs`（编辑）
- `docs/conductor-brain-layer/spike/lib/status-table.mjs`（编辑）
- `docs/conductor-brain-layer/spike/lib/greeting-data.mjs`（编辑）
- `docs/conductor-brain-layer/spike/lib/render-greeting.mjs`（编辑）
- `docs/conductor-brain-layer/spike/test-status-table.mjs`（编辑）
- `docs/conductor-brain-layer/spike/test-greeting.mjs`（编辑）
- `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（编辑）

**Do**：
1. `status-table.mjs` 的 `collectStatusRows()`：`map()` 回调新增一行 `const project = tagValue(memory.tags, "project:");`（复用已有 `tagValue` helper），返回对象新增 `project` 字段（`string | null`）。
2. `greeting-data.mjs`：
   - `gatherGreetingData(store, opts = {})` 的 `opts` 新增 `currentProjectKey?: string | null`。
   - `statusRows` 分组：`const grouped = new Map(); for (const row of statusRows) { const key = row.project ?? "__unassigned__"; ... }`（用一个不会和真实 `owner/repo` 撞车的 sentinel key 表示"未分组"，不是 `null` 直接当 Map key——JS `Map` 支持 `null` 当 key，但用字符串 sentinel 更方便后续序列化/测试断言，选型细节留实现时定）。
   - `pickFocusTask()` 调用范围收窄：只在 `currentProjectKey` 对应的分组内选（`opts.currentProjectKey` 为 `null`/未命中任何分组 → 沿用今天"从全部 statusRows 里选"的行为，保证单项目场景/`currentProjectKey` 解析失败时的向后兼容）。
   - 其它分组（非当前项目）各自算摘要：`{projectKey, count: rows.length, topStatus: STATUS_EMOJI[最高优先级 statusKey]}`。
   - 返回值新增 `otherProjects: Array<{projectKey, count, topStatusLabel}>` 和 `unassignedCount`（未分组任务数，若 >0 需要在渲染层出现）。
3. `render-greeting.mjs`：
   - 新增一段"其它项目"摘要列表（`otherProjects` 非空时渲染，每行过 `sanitizeText()`）。
   - 未分组任务非零时追加一行提示（不隐藏，明确标注，呼应 DESIGN §2 的红线精神）。
   - 当前项目的表格渲染逻辑不变（复用现有 `renderStatusTable()`，只是现在传入的 `statusRows` 是已经按 `currentProjectKey` 过滤过的子集）。
4. `brain-wake-greeting.mjs`：
   - `main()` 里 `readFileSync(0, "utf8")` 的结果**改为解析**：`let cwd = null; try { const input = JSON.parse(raw); cwd = typeof input.cwd === "string" ? input.cwd : null; } catch {}`。
   - `let currentProjectKey = null; if (cwd) { const origin = getOriginOwnerRepo(cwd); if (origin.ok) currentProjectKey = \`${origin.owner}/${origin.repo}\`; }`（新增 `import { getOriginOwnerRepo } from "./lib/git-remote.mjs";`）。
   - 调用 `gatherGreetingData(store, { currentProjectKey })`（原来的调用没传这个参数，新增）。
5. 测试：三份既有测试文件各自新增"混合 ≥2 项目 tag 的 fixture db"用例（用 `insertMemory` 直接构造测试数据，不依赖真实 `seed-brain-identity.mjs`/`onboard-project.mjs` 跑一遍，单测层面独立可控）；`test-hook-greeting.mjs` 新增"stdin 含 `cwd`、`cwd` 对应一个已知 origin 的临时 git repo fixture"用例，验证 `currentProjectKey` 被正确解析并影响渲染。

**Self-check**：`node docs/conductor-brain-layer/spike/test-status-table.mjs && node docs/conductor-brain-layer/spike/test-greeting.mjs && node docs/conductor-brain-layer/spike/test-hook-greeting.mjs && node docs/conductor-brain-layer/spike/test-wake.mjs`（最后一个是回归——`wake.mjs` 本身不改，但共用同一个身份库/依赖链，跑一遍确认没有连带破坏）。

---

## B5 — 真实第二项目 vertical-slice：`whoseworks/whoseorder` [L] ⚠️ 高风险

**依赖**：B0 + B1 + B2 + B3 + B4 全部完成。

**文件**：
- `docs/conductor-brain-multiproject/spike/README.md`（新，占位说明，标注这是本批次 dispatch 的安全区，不放任何真实业务代码）
- `scripts/dispatch-brain-task.mjs`（新）
- `scripts/test-dispatch-brain-task.mjs`（新）
- `.claude/hooks/lib/memory-upsert.mjs`（复用 B2/B3 已抽出的共享库，本批次不重复实现 `assertProjectRegistered`，从 B3 抽成 `scripts/lib/project-registry.mjs` 共享给 B5 复用——若 B3 实现时未预先抽出，本批次负责抽出并回填 B3 的调用点）

**Do**：
1. `dispatch-brain-task.mjs` CLI：`node scripts/dispatch-brain-task.mjs --project <owner/repo> "<intent 文本>"`。
2. `assertProjectRegistered(store, projectKey)`（复用/抽出）→ 未注册 → 报错退出，**在这一步之后才允许**任何 `assembleProfileDeps`/`ConductorWorkApp` 调用（测试要能验证这个顺序，用 spy 断言未注册路径下这些函数零调用）。
3. `translateIntent()`（`docs/conductor-brain-layer/spike/lib/translator.mjs`，复用，新增一个可选 `projectContext?: string` 参数，拼进 `objective` 文本前缀，`policy.allowedPaths` **保持**指向 `docs/conductor-brain-multiproject/spike/**`，不因为传入了 `--project whoseworks/whoseorder` 就改指向 whoseorder 路径——这是 §3.2 范围决定的代码落点，写测试时要断言这一点，防止未来有人"顺手"把它接上）。
4. 库调模式：`assembleProfileDeps("subscription", process.env)` → `ConductorWorkApp.planRun/startRun/resumeRun`（G1/G2 自动放行、G3/Escalation 停）→ `projectEvents()`。复用 `run-spike.mjs` 已验证的调用序列，不重新发明。
5. 三态门（`docs/conductor-brain-layer/spike/lib/three-state-gate.mjs`，复用）→ upsert 一条 memory（`type` 视 evidence 内容定 `active_task` 或 `postmortem`，`tags` 含 `project:<owner>/<repo>`）。
6. 测试（自动化部分，mock 掉真实 LLM 调用）：未注册项目 → 报错，`assembleProfileDeps`/`ConductorWorkApp` 零调用；`translateIntent` 产出的 contract 的 `policy.allowedPaths` 不含目标项目路径（防回归断言）。
7. **人工 self-check（不进 CI，真实 LLM 调用 + 真实第三方仓库）**：
   ```bash
   # 1. before 快照
   git -C /Users/elishawong/code/github/whoseworks/whoseorder status --porcelain > /tmp/whoseorder-before.txt

   # 2. onboard
   node scripts/onboard-project.mjs --repo-path /Users/elishawong/code/github/whoseworks/whoseorder --display-name whoseorder

   # 3. 回归：aeloop 自己重新 seed 一次，确认多项目共存不破坏既有单项目行为
   AELOOP_BRAIN_IDENTITY_DB=<你的身份库路径> node scripts/seed-brain-identity.mjs

   # 4. 派工（真实 LLM 调用，需要本机已认证的 claude/codex CLI，同 run-spike.mjs 前置条件）
   node scripts/dispatch-brain-task.mjs --project whoseworks/whoseorder \
     "冒烟验证：写一个纯函数 reverseString(s)，用输入 'whoseorder-brain-check' 自证正确，不需要读写任何文件"

   # 5. 验证分组开场白（新进程，模拟 SessionStart，stdin 传 whoseorder 路径当 cwd）
   echo '{"cwd":"/Users/elishawong/code/github/whoseworks/whoseorder"}' | \
     AELOOP_BRAIN_GLOBAL_MODE=1 node ~/.claude/aeloop-brain/repo-snapshot/.claude/hooks/brain-wake-greeting.mjs

   # 6. after 快照，必须与 before 字节级相同
   git -C /Users/elishawong/code/github/whoseworks/whoseorder status --porcelain > /tmp/whoseorder-after.txt
   diff /tmp/whoseorder-before.txt /tmp/whoseorder-after.txt && echo "PASS: whoseorder 零污染" || echo "FAIL"
   ```

**Self-check**：`node scripts/test-dispatch-brain-task.mjs`（自动化部分）+ 上述人工六步（记录实际输出，附进 `progress.md`，不是"跑过就好"，要把 diff 命令的真实退出码/输出贴进交付记录）。

---

## Definition of Done（全部批次）

- PRD §6 全部 acceptance criteria 打勾。
- 每个 `test-*.mjs` 独立运行全绿（B0/B5 的人工 self-check 部分额外记录真实执行结果，不能只勾选不留痕）。
- `pnpm build && pnpm test`（现有 `src/**` 测试套件）保持全绿——本批次不触碰 `src/**`，这是回归项不是新增项（§3.1/§8 已定的范围边界）。
- `~/.claude/settings.json` 最终态含 1 个新 SessionStart hook 条目，`git diff`/人工 diff 核对未误删任何既有条目（B0 特有的核对项）。
- whoseorder 工作区在 B5 全流程前后 `git status --porcelain` 字节级相同（B5 特有的核对项，必须留存 diff 命令的真实输出）。
- `progress.md`/`impact.md` 按 Helix 基础工作流写完，再交 Zorro。
