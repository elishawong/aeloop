# PRD — aeloop: conductor-brain 多项目地基（issue #93，片①）

> 防幻觉：`[?]` = 未核实 / 需指挥官确认；不编接口/参数/版本号。本 PRD 对现有代码的每条引用均来自直接阅读（`src/harness/{cli-exec,adapters/claude-cli-adapter,adapters/codex-cli-adapter,config}.ts`、`src/conductor-work/app.ts`、`src/loop/runner.ts`、`src/cli/assemble.ts`、`src/profile/loader.ts`、`.claude/hooks/{brain-wake-greeting,lib/db-path,lib/git-remote}.mjs`、`docs/conductor-brain-layer/spike/lib/*.mjs`、`scripts/seed-brain-identity.mjs`），不凭记忆。**方案权威是 `docs/conductor-brain-multiproject/DESIGN.md`（指挥官已确认，2026-07-23）——本 PRD 不重复其方案对比/核实结果，只把已定案的方案翻译成逐文件任务清单 + 可执行批次**；PRD 阶段新增的核实（尤其 §3 的 cwd 透传判定）在 DESIGN 结论之外发现的具体差异，本文档如实标注，不是推翻 DESIGN。

- **项目**: aeloop（`elishawong/aeloop`）
- **分支**: `design/issue-93-multiproject-brain`（延续 DESIGN 所在分支，build 阶段是否 rename 由指挥官/军师决定，本 PRD 不预设）
- **优先级**: P1（issue #93 label）
- **状态**: 待指挥官确认（DESIGN 已确认，PRD 待确认后进 `/build`）
- **最后更新**: 2026-07-23
- **关联 issue**: [elishawong/aeloop#93](https://github.com/elishawong/aeloop/issues/93)
- **方案权威**: `docs/conductor-brain-multiproject/DESIGN.md`（§1.1 全局安装/§1.2 打包 dist/§1.3 project-scope tag/§1.4 纯中心注册，均已确认）

---

## 0. Scope

**In scope**：DESIGN §4 定义的片①批次拆解（B0-B5）的**逐文件落地**——① 全局安装脚本（新增，含原生依赖打包 + `~/.claude/settings.json` 合并写入）；② `db-path.mjs` 新增全局模式；③ `onboard-project.mjs`（新，纯中心注册）；④ `seed-brain-identity.mjs` 多项目扩展（`project:*` tag）；⑤ `status-table.mjs`/`greeting-data.mjs`/`render-greeting.mjs`/`brain-wake-greeting.mjs` 项目分组渲染；⑥ 真实第二项目（`whoseworks/whoseorder`）vertical-slice 验证（onboard → 分组醒来 → 调引擎出候选+证据，全程零文件落地/零真实改动）。

**Out of scope**（对齐 DESIGN §3 明确不做清单，不重复论证）：片②落盘/apply；换 Claude Code 壳；把 `brain-commit-gate.mjs`/`brain-issue-gate.mjs`/`brain-red-line-guard.mjs` 三个写侧防护 hook 全局化；overlay 打包 CLI；发布 aeloop 到 npm；改 `MemoryType`/`Memory` schema；`owner/repo` 改名自动迁移；**本 PRD 追加一条 out-of-scope（§3 判定的直接结果）：不把 coder/tester 的实际工具执行（`Bash`/`Read`/`Grep` 子进程）指向 whoseorder 的真实目录**——理由见 §3，这不是"做不到"而是"片①不需要、且指向真实第三方仓库会撞上 `aeloop#31` 未修复的写权限风险"。

---

## 1. Problem / Users / Solution

**要解决的问题**：DESIGN §0 已核实——issue #75/#84/#88 已经把"单项目大脑"做完，但 100% 绑定在 aeloop 自己的 checkout 里，换到任何其它项目目录打开 Claude Code，这套东西完全不会触发。#93 要把它变成"装一次、N 个项目都能醒"。

**谁需要**：指挥官——pitch 需要"一个大脑管全公司项目"这个产品形态本身可演示，今天做不到跨项目醒来。

**一句话方案**：新增一个全局安装脚本把 build 产物+必要 hook/lib 打包到 `~/.claude/aeloop-brain/`，用一个新增的显式开关（`AELOOP_BRAIN_GLOBAL_MODE`）让全局装的 wake-greeting hook 物理上不可能读写任何目标项目自己的文件；project-scope 靠 `project_registry` 类型 + `project:<owner>/<repo>` tag（已有 schema 槽位，DESIGN §1.3）；onboard 是一次只读 `git remote get-url` + 一次身份库写入，物理上不接触目标项目工作区一个字节。

---

## 2. Goals / Non-goals

**Goals**：
- `scripts/install-global-brain.mjs`（新）：一条命令把当前 aeloop 源码 build 出的 `dist/` + 必要的 hook/lib 文件 + `better-sqlite3` 原生依赖，安装到 `~/.claude/aeloop-brain/repo-snapshot/`；**JSON 层面合并**写入 `~/.claude/settings.json`（不覆盖用户已有的其它全局 hook——本机已验证真实存在第三方 hook，见 DESIGN §1.1）；幂等可安全重跑。
- `.claude/hooks/lib/db-path.mjs`（编辑）：新增 `AELOOP_BRAIN_GLOBAL_MODE=1` 时的解析分支——**跳过**项目本地 `<cwd>/.claude/brain.local.json` 这一层 fallback，直接落到一个固定的全局默认路径；未设该环境变量时（今天所有既有调用点）行为**字节级不变**。
- `scripts/onboard-project.mjs`（新）：`node scripts/onboard-project.mjs --repo-path <path> [--display-name <name>]`，只读 `git remote get-url origin`，upsert 一条 `project_registry` memory；自动化验收断言"目标目录 `git status --porcelain` 运行前后字节级相同"。
- `scripts/seed-brain-identity.mjs`（编辑）：每条 `active_task` 新增 `project:<owner>/<repo>` tag；目标项目未被 `onboard-project.mjs` 注册时给出明确报错，不静默写孤儿 tag。
- `docs/conductor-brain-layer/spike/lib/{status-table,greeting-data,render-greeting}.mjs` + `.claude/hooks/brain-wake-greeting.mjs`（编辑）：开场白按项目分组——当前项目（由 SessionStart stdin 的 `cwd` 反查 `git remote` 得到）完整展示，其它已 onboard 项目一行摘要；至少 2 个真实项目验证聚合。
- **真实第二项目验证**（`whoseworks/whoseorder`，owner 已用 `git remote -v` 核实，不是默认联想的 `whose-holdings`）：onboard → 醒来看到按项目分组的开场白 → 会话内调起 aeloop 对该项目一个良性合成任务跑通 → 产出候选 + `EvidenceBundle` → 三态门折回身份库 → 再醒来看到延续；全程 `whoseorder` 工作区 `git status --porcelain` 字节级不变。

**Non-goals**（对齐 DESIGN §3，逐条不重复论证）：不落盘/不 apply；不换壳；不把三个写侧防护 hook 全局化；不做 overlay 打包 CLI；不发 npm；不改 schema；不做 owner/repo 改名自动迁移；不解决 `settings.json` 多 scope hooks 合并语义的 `[?]`；**不把 coder/tester 的工具执行 cwd 指向 whoseorder**（§3 判定，见下）。

---

## 3. 关键设计核实（PRD 阶段的头号活——DESIGN §4 B5 标注的 `[?]` 在此了结）

### 3.1 判定结论：cwd 今天**没有**从 `ConductorWorkApp`/`ProfileConfig` 透传到 cli-bridge 的 `spawnImpl`——需要新增管线才能做到，**片①选择不做**

**追踪路径（逐层读过源码，不是转述）**：

1. `ConductorWorkApp.runCandidate(contractPath, profile, deps, options)`（`src/conductor-work/app.ts:64-87`）→ `startRun(deps, input)`（`src/loop/runner.ts`），`deps: StartRunDeps` 的字段是 `router`/`composer`/`audit`/`checkpointer`/`events?`/`schemaMaxAttempts?`（`runner.ts:101-130`，逐字段读过）——**没有 `cwd`/`repoRoot`/`workdir` 字段**。`input`（`StartRunInput`）只有 `task`/`profile`/`workflowDefId`/`injectedContext`/`rejectThreshold`——同样没有。
2. `deps.router`（`ProviderRouter`）是在 `assembleProfileDeps()`（`src/cli/assemble.ts:97-174`）里用 `buildAdapterRegistry(config)`（`config: ProfileConfig`，来自 profile 的 YAML/JSON 配置文件）构造的——`ProfileConfig`（`src/profile/loader.ts:28-58`，逐字段读过 `profile`/`providers`/`roles`/`workflow`/`context`）**没有任何 `cwd` 相关字段**，`RoleBinding`（`loader.ts:23-26`）是 `{provider: string, [key: string]: unknown}`，理论上可以塞任意 provider 专属配置，但今天两个 cli-bridge adapter 的配置接口没有声明会读这个字段。
3. `ClaudeCliAdapterConfig`（`src/harness/adapters/claude-cli-adapter.ts`，读过完整接口）只有 `cmd?: string` 一个字段；`CodexCliAdapterConfig`（`codex-cli-adapter.ts`）同样只有 `cmd?: string`。**两者都没有 `cwd` 字段可配置**。
4. `ClaudeCliAdapter.invoke()` 调 `spawnWithTimeout(this.cmd, [...], { timeoutMs: DEFAULT_TIMEOUT_MS })`（`claude-cli-adapter.ts:99-113`）——**没有传 `cwd` 选项**；`CodexCliAdapter.invoke()` 同样只传 `{ timeoutMs }`（`codex-cli-adapter.ts:90-92`）。
5. `spawnWithTimeout()`（`src/harness/cli-exec.ts:109-178`）的 `SpawnWithTimeoutOptions.cwd?: string`（头注释原话"Working directory for the child process. Defaults to `process.cwd()`"）**在底层确实支持配置**——DESIGN §4 B5 引用的这一条证据是真的，但它只是"最底层的水管支持这个参数"，**没有任何一层把这根水管接到调用方能设置的入口**。

**结论**：DESIGN §4 B5 提的两种可能里，真相是**"需要新增透传管线"**，不是"今天就能透传"——要让 coder/tester 的实际 `Bash`/`Read`/`Grep` 工具执行指向 `whoseorder` 的真实目录，至少要新增：`ClaudeCliAdapterConfig`/`CodexCliAdapterConfig` 加 `cwd?: string`字段 → `buildAdapterRegistry()`（`src/harness/config.ts`）读取并透传 → 两个 `invoke()` 方法把它传进 `spawnWithTimeout()`；**而且 `cwd` 天然是"这一次 run 针对哪个项目"这种 per-run 值，不是 profile 级静态配置**——`ProfileConfig` 今天的设计假设"一个 profile 对应一套固定的 provider/role 绑定"，把 per-run 的 `cwd` 塞进 profile 级配置在语义上就是错位的，正确的做法应该是让它成为 `StartRunDeps`/`StartRunInput` 的一个新字段、沿 `runner.ts` 一路往下传，**这是 `src/loop/**`/`src/harness/**`/`src/conductor-work/**` 多个文件的改动，不是"加一个字段"这么轻**。

### 3.2 判定结果的直接后果：片①不做 3.1 描述的新增管线，B5 走"Level 1"范围（合成任务，不碰 whoseorder 真实文件）

给这条新增管线做完整设计/实现是一次独立规模的工作，且**片① DESIGN §3 已经明确排除"落盘"/"真改目标项目文件"**——而"把工具执行 cwd 指向真实第三方仓库"这件事，即便只读，也直接撞上一个已知、未修复、有 issue 追踪的真实风险：`ClaudeCliAdapter` 用 `--permission-mode bypassPermissions` + `Bash` 在 `ALLOWED_TOOLS` 里（`claude-cli-adapter.ts` 文件头 2026-07-21 Zorro/Codex 复审记录的 P0-1，追踪于 `elishawong/aeloop#31`）——**coder 角色今天已经能在人工看到 G1 门之前，通过 Bash 真的写盘**，这是该文件头注释自己承认的"known, currently-unfixed limitation"。把这个 adapter 的 cwd 指向一个真实客户项目（哪怕只是想读），是在一个**已知有真实写风险的机制**上加大真实资产的暴露面——不是这次该冒的险。`CodexCliAdapter` 用 `--sandbox read-only`（`codex-cli-adapter.ts:90`）本身更安全，但选哪个 adapter 由 profile 的 `roles`/`providers` 绑定决定，不是本 PRD 能在片①里重新设计的范围。

**因此 B5 的范围收窄为（指挥官消息里"仿 reverseString 那种良性小任务"的具体落实）**：
- TaskContract 的 `objective`/`requirements` 文本**提及**目标项目（如"以下任务与项目 whoseworks/whoseorder 相关，作为大脑多项目调度链路的冒烟验证：……"），证明"这个 dispatch 是为哪个项目发起的"这层语义在**契约层面**成立。
- coder/tester 的实际工具执行**仍然按今天现有行为**运行——`cwd` = 发起 dispatch 的 Node 进程自己的 `process.cwd()`（即 aeloop checkout 内，和 #75 spike 今天的行为完全一致，本 PRD 不改这个行为）,`policy.allowedPaths` 沿用一个**新的、专属本次验证的安全区**（`docs/conductor-brain-multiproject/spike/**`，独立于 #75 的 `docs/conductor-brain-layer/spike/**`，避免两次验证的审计痕迹混在一起），而不是指向 whoseorder。
- 任务本身选一个**自证、不需要读写任何真实文件**的合成任务（如"写一个纯函数 `reverseString(s)`，用给定输入自证正确，不需要落盘、不需要读任何仓库文件"）——工具执行 cwd 在哪里对任务结果没有影响，这正是为什么合成任务是唯一在片①范围内、又能诚实兑现"零风险接触 whoseorder"这条约束的任务形状。
- "对该项目跑通"这句话的兑现点在**身份库**：产出的 `EvidenceBundle` 经三态门折回一条 `active_task`/`postmortem` memory，打 `project:whoseworks/whoseorder` tag，再醒来时出现在该项目分组下——这是 DESIGN §1.3/§1.4 已经定型的、纯身份库层面的"项目关联"，不依赖引擎真的进过 whoseorder 的目录。
- **`whoseorder` 全程唯一被触碰的动作 = 一次只读 `git remote get-url origin`**（B2 的 `onboard-project.mjs`），`git status --porcelain` 前后自动化断言字节级相同（§6 acceptance）。

这是一个**保守但完整满足 epic 验收标准字面表述的范围决定**——"从会话内调起 aeloop 对该项目一个真任务跑通 → 候选+EvidenceBundle"在这个设计下依然完整发生（真任务、真引擎调用、真候选、真 EvidenceBundle、真三态门），唯一收窄的是"引擎的文件工具是否真的进过 whoseorder 目录"，而这条本来就不是片①要交付的东西（片②的"落盘"才需要）。**给指挥官的选择权**：如果指挥官希望片①就要"工具真的进 whoseorder 目录读文件（仍然只读、不写）"，那需要追加 §3.1 描述的新增管线（`cwd` 从 profile 级挪到 run 级 + 三个 `src/**` 文件改动 + 优先切到 `CodexCliAdapter` 的 read-only sandbox 而非 `ClaudeCliAdapter`），工作量/风险显著更高，本 PRD 建议不做，除非指挥官明确要更高保真度的演示。`[?]` 这条待指挥官确认，若确认要做，需要回军师那里重开一轮范围讨论,不在本批次 B0-B5 里现场加。

### 3.2b `AELOOP_BRAIN_GLOBAL_MODE` + 目录骨架保留 = B1 不需要碰 `brain-wake-greeting.mjs` 的路径逻辑（对 DESIGN §1.2/§4 B1 的一处修正）

DESIGN §4 B1 曾预期"`brain-wake-greeting.mjs` 的相对路径写法需要为全局变体改造"。PRD 阶段发现一个更省改动的做法：**安装脚本按原样保留 `.claude/hooks/brain-wake-greeting.mjs` 相对 `docs/conductor-brain-layer/spike/lib/` 的目录深度关系**（都拷进 `~/.claude/aeloop-brain/repo-snapshot/` 下同构的子路径），`brain-wake-greeting.mjs:50` 的 `path.join(HERE, "..", "..", "docs", "conductor-brain-layer", "spike", "lib")` 这行代码在新位置下**原样成立、不需要改一个字符**。真正需要改的只有 dbPath 解析——见 §3.2c。

### 3.2c dbPath 全局模式的具体机制

`.claude/hooks/lib/db-path.mjs` 新增一层判定，**在**现有 env 优先判定之后、项目本地 fallback 判定之前：

```
resolveIdentityDbPath({cwd = process.cwd()} = {}):
  1. AELOOP_BRAIN_IDENTITY_DB 存在 → 直接返回（不变，最高优先级）
  2. process.env.AELOOP_BRAIN_GLOBAL_MODE === "1" → 返回固定全局默认路径
     （不读任何 <cwd>/... 路径，物理上不可能碰目标项目）
  3.（原有逻辑，未设 AELOOP_BRAIN_GLOBAL_MODE 时行为字节级不变）
     读 <cwd>/.claude/brain.local.json 的 identityDbPath 字段
  4. 都没有 → null
```

`AELOOP_BRAIN_GLOBAL_MODE=1` **只在**安装脚本写入 `~/.claude/settings.json` 的 hook 命令行里设置（`AELOOP_BRAIN_GLOBAL_MODE=1 node "<snapshot 绝对路径>/.claude/hooks/brain-wake-greeting.mjs"`），aeloop 自己项目提交的 `.claude/settings.json`（今天的 dogfood 用法）**不设**这个变量——两边用同一份 `db-path.mjs`/`brain-wake-greeting.mjs` 代码，但通过环境变量走向完全不同、互不影响的两条路径，这是本 PRD 用来物理保证"全局装的 hook 绝不读目标项目任何文件"的具体机制，不是文档承诺。

**全局默认路径**：`path.join(os.homedir(), ".claude", "aeloop-brain", "data", "identity.db")`（B0 安装脚本创建 `data/` 目录，`MemoryStore`/`better-sqlite3` 会在文件不存在时自动创建 db 文件，不需要预先 touch 一个空文件）。

### 3.3 分组渲染需要 `brain-wake-greeting.mjs` 读 stdin 的 `cwd`（今天没读，B4 要新增，不是 B1 的活）

今天 `brain-wake-greeting.mjs` 的 `main()` 会 `readFileSync(0, "utf8")` 排空 stdin，但**不解析**里面的 JSON（注释原话"这个 hook 目前不需要读它"）——B4 要"当前项目分组置顶"，必须解析 stdin 拿到 `cwd`，反查 `getOriginOwnerRepo(cwd)`（`.claude/hooks/lib/git-remote.mjs`，B0 需要额外把这个文件也拷进安装目录，DESIGN §5 依据清单已列出这个文件但之前没在 B0 的拷贝清单里点名，本 PRD 补上）算出当前项目的 `owner/repo`，传给 `gatherGreetingData(store, {cwd, currentProjectKey})`。这是一处对 DESIGN §4 B1/B4 批次边界的具体化：**cwd 解析属于 B4，不是 B1**——B1 只管 dbPath，两者是同一个文件里的两处独立改动，互不依赖，可以分开审。

---

## 4. Per-file Task List

### 4.1 B0 — 全局安装脚本（⚠️ 高风险，Zorro 重点审）

**`scripts/install-global-brain.mjs`（新文件）**
- 步骤：① `execFileSync("pnpm", ["run", "build"], {cwd: REPO_ROOT})`（保证 `dist/` 是最新的）；② 计算 `INSTALL_DIR = path.join(os.homedir(), ".claude", "aeloop-brain")`，`SNAPSHOT_DIR = path.join(INSTALL_DIR, "repo-snapshot")`；③ **保留相对目录骨架**拷贝以下路径到 `SNAPSHOT_DIR` 下同构位置：`dist/**`、`.claude/hooks/brain-wake-greeting.mjs`、`.claude/hooks/lib/db-path.mjs`、`.claude/hooks/lib/git-remote.mjs`、`docs/conductor-brain-layer/spike/lib/{wake,greeting-data,render-greeting,status-table,sanitize}.mjs`（`rmSync(dest, {recursive:true, force:true})` 先清空旧快照再整体重拷，保证幂等更新不留旧文件残留）；④ 在 `SNAPSHOT_DIR` 写一份**新的、精简的** `package.json`（`{"name":"aeloop-brain-runtime","private":true,"dependencies":{"better-sqlite3":"<与 aeloop 自己 package.json 里的版本号一致，读取后原样写入，不手打>"}}`）+ `execFileSync("npm", ["install", "--omit=dev"], {cwd: SNAPSHOT_DIR})`（对当前平台做一次真实原生编译/下载预编译二进制，不尝试手工拷贝 aeloop 自己 pnpm store 里的 `node_modules`——那是内容寻址/符号链接结构，直接拷贝到别处大概率断链）；⑤ `mkdirSync(path.join(INSTALL_DIR, "data"), {recursive:true})`；⑥ 读 `~/.claude/settings.json`（不存在则视为 `{}`），**JSON 层面合并**：确保 `hooks.SessionStart` 是数组，若已存在一个 `command` 精确等于本次要写入的绝对路径的条目则跳过（幂等，不重复插入），否则追加 `{matcher: "startup|resume|clear", hooks: [{type:"command", command: \`AELOOP_BRAIN_GLOBAL_MODE=1 node "${snapshotHookPath}"\`}]}`；**绝不**删除/覆盖 `hooks` 下任何已有的其它条目（包括其它 matcher、其它 event、非本工具写入的条目）；写回前**备份**一份 `~/.claude/settings.json.bak-<timestamp>`（防止合并逻辑本身有 bug 时不可恢复，这是本批次风险最高的一步，必须有回退手段）。
- CLI：`node scripts/install-global-brain.mjs [--dry-run]`（`--dry-run` 打印将要做的改动，不实际写文件/不跑 `npm install`，供人工先过一眼再真跑）。

**`scripts/test-install-global-brain.mjs`（新文件）**
- 用临时目录模拟 `os.homedir()`（依赖注入，不碰真实 `~/.claude/`）：验证首次安装产出预期文件树；二次运行幂等（`~/.claude/settings.json` 里的 hook 条目不重复累加）；已有其它 hook 条目的 `settings.json` 合并后原有条目原样保留（byte-for-byte 断言）；`--dry-run` 不产生任何文件系统副作用。
- **不**在自动化测试里真的跑 `pnpm run build`/`npm install`（太慢、依赖网络/平台）——这两步用可注入的 `execImpl` 假实现覆盖，只验证"调用参数对不对"，真实端到端安装留给人工 self-check（见 plan.md）。

### 4.2 B1 — `db-path.mjs` 全局模式

**`.claude/hooks/lib/db-path.mjs`（编辑）**
- 新增 §3.2c 描述的判定分支 + 全局默认路径常量导出（`GLOBAL_DEFAULT_DB_PATH`，供 B0 安装脚本和测试复用同一个真源，不各写一份路径拼接逻辑）。

**`.claude/hooks/lib/test-db-path.mjs`（编辑，已有文件）**
- 新增用例：`AELOOP_BRAIN_GLOBAL_MODE=1` 且未设 `AELOOP_BRAIN_IDENTITY_DB` → 返回全局默认路径，且**不**触碰任何 `<cwd>/.claude/brain.local.json`（用一个不存在该文件的临时 cwd 断言不抛错、不因为文件不存在而走到项目本地分支）；`AELOOP_BRAIN_GLOBAL_MODE=1` 但同时设了 `AELOOP_BRAIN_IDENTITY_DB` → env 仍然优先（全局模式不改变 env 的最高优先级）；未设 `AELOOP_BRAIN_GLOBAL_MODE`（今天所有既有用例）→ 行为**字节级不变**（回归断言，复用已有测试用例原样通过）。

### 4.3 B2 — `onboard-project.mjs`

**`scripts/onboard-project.mjs`（新文件）**
- `node scripts/onboard-project.mjs --repo-path <path> [--display-name <name>]`：① `resolveIdentityDbPath()`（复用 B1，未配置 → 明确报错退出，不静默）；② `getOriginOwnerRepo(repoPath)`（`.claude/hooks/lib/git-remote.mjs`，**只读**，`execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], ...)`，从不 `chdir`/`cd`）；解析失败（非 git 目录/无 origin）→ 明确报错，不写任何东西；③ upsert `project_registry` memory：`type:"project_registry"`, `title: "project:<owner>/<repo>"`, `content: displayName ?? \`${owner}/${repo}\`` , `tags: ["project:<owner>/<repo>"]`, `confidenceState:"confirmed"`（同 `seed-brain-identity.mjs` 已有的 upsert 模式：按 `title` 匹配已有记录，内容变了才 `updateMemoryContent`，没变跳过）。
- 输出：打印 `owner/repo` + upsert 结果（`inserted`/`unchanged`/`content-updated`）。

**`scripts/test-onboard-project.mjs`（新文件）**
- 用临时目录建假 git repo（`execFileSync('git', ['init', ...])` + `git remote add origin <url>`）作为"目标项目"fixture（**不用真实 whoseorder 仓库跑自动化测试**——自动化测试只用可丢弃的临时 fixture，真实 whoseorder 验证是 B5 的人工 self-check，两者分开，不让 CI 依赖一个真实外部项目的存在）：① 首次 onboard → `project_registry` 插入且内容正确；② 二次 onboard（内容不变）→ `unchanged`（真幂等）；③ **核心断言**：onboard 前后，对该 fixture 目录跑 `git status --porcelain` 输出字节级相同；④ 非 git 目录 / 无 origin → 明确报错，退出码非零，且身份库零写入（用 `store.listMemories()` 长度对比）。

### 4.4 B3 — `seed-brain-identity.mjs` 多项目扩展

**`scripts/seed-brain-identity.mjs`（编辑）**
- `resolveActiveTaskTags(issue, projectTag)` 签名扩展（新增第二参数），返回值追加 `projectTag`（如 `project:<owner>/<repo>`，由 `main()` 里已经算出的 `getOriginOwnerRepo(cwd)` 结果拼出，复用而非重新计算）。
- `main()` 新增前置检查：在同步 issue 之前，先 `store.listMemories()` 找 `type:"project_registry"` 且 `tags` 含 `project:<owner>/<repo>` 的记录——找不到 → 明确报错（"目标项目未注册，请先跑 `onboard-project.mjs --repo-path <path>`"），**不**静默继续写入孤儿 tag 的 `active_task`（DESIGN §2 Trade-off 已标注的孤儿 tag 风险，本批次用一个前置检查直接堵掉，而不是留给渲染层兜底）。
- `resolveActiveTaskTags` 现有的两个既存分支（`CLOSED` → `["status:done","archived","gh-issue:<n>"]`；`OPEN` → `[statusTag, ghIssueTag]`）均追加 `projectTag` 到返回数组末尾（`["status:done","archived","gh-issue:<n>","project:<owner>/<repo>"]` 等）。

**`scripts/test-seed-brain-identity.mjs`（编辑，已有文件）**
- 新增用例：目标项目未注册（无 `project_registry`）→ `main()` 抛错/返回明确失败标记，零写入；目标项目已注册 → 每条 `active_task` 的 `tags` 含正确的 `project:*`；二次运行仍然真幂等（复用已有的"零调用"断言模式，追加验证 `project:*` tag 不会导致误判"内容变了"从而不必要地删除重建）。

### 4.5 B4 — 项目分组渲染

**`.claude/hooks/brain-wake-greeting.mjs`（编辑）**
- `main()` 里已有的 `readFileSync(0, "utf8")` 排空逻辑，改为**解析** stdin JSON 拿到 `cwd`（解析失败/无 `cwd` 字段 → 视为"当前项目未知"，不报错，走"无当前项目"的兜底渲染路径，不是抛异常——延续本文件"绝不阻断"的既有惯例）；新增 `import { getOriginOwnerRepo } from "./lib/git-remote.mjs"`；调 `getOriginOwnerRepo(cwd)` 算出 `currentProjectKey`（解析失败同样兜底为未知，不报错）；传给 `gatherGreetingData(store, {cwd, currentProjectKey})`。

**`docs/conductor-brain-layer/spike/lib/status-table.mjs`（编辑）**
- `collectStatusRows()` 返回值新增 `project` 字段：从 `memory.tags` 里找 `project:` 前缀的 tag（复用已有的 `tagValue(tags, prefix)` helper），没有 → `project: null`（渲染层显式标"未分组"，不是静默丢弃，延续 `resolveStatus()` 对未知状态"必须显式标 ❓不能静默兜底"的红线精神——见 DESIGN §2 Trade-off）。

**`docs/conductor-brain-layer/spike/lib/greeting-data.mjs`（编辑）**
- `gatherGreetingData(store, opts)` 的 `opts` 新增 `currentProjectKey?: string | null`；`statusRows` 按 `project` 字段分组（`Map<projectKey|null, rows[]>`）；`pickFocusTask()` 的调用范围收窄为**仅当前项目**（`currentProjectKey` 命中的分组）——"上次停在"/结尾"继续「X」"只应该指当前项目的焦点，不是跨项目里随便挑一条（延续 DESIGN §1.3 建议方向）；其它项目分组各自算一个"摘要行"（`N 条在途，最高优先级 = <emoji>`，复用 `FOCUS_PRIORITY`/`STATUS_EMOJI` 现有常量，不新造一套映射）。

**`docs/conductor-brain-layer/spike/lib/render-greeting.mjs`（编辑）**
- 渲染结构调整为"当前项目完整表格（复用 `renderStatusTable()`）+ 其它已 onboard 项目一行摘要列表 + 未分组任务（如有）单独一段，明确标注'未分组'"；新增文本全部继续过 `sanitizeText()`（红线不变，`project_registry` 的 `content`/`title` 都是身份库数据，不是受信任常量）。

**测试**（编辑已有文件）：`docs/conductor-brain-layer/spike/test-status-table.mjs`、`docs/conductor-brain-layer/spike/test-greeting.mjs`、`docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 均新增"≥2 个项目 tag 混合在同一 db"的用例，验证分组正确、当前项目置顶、其它项目摘要、未分组任务不丢失只是标注（对应 epic 验收标准"开场白按项目分组显示各项目在途，≥2 项目验证聚合"）。

### 4.6 B5 — 真实第二项目 vertical-slice（`whoseworks/whoseorder`，⚠️ 高风险，Zorro 重点审）

**`docs/conductor-brain-multiproject/spike/`（新目录，仅含一个占位/说明文件，供 §3.2 描述的 `policy.allowedPaths` 指向一个独立于 #75 spike 的安全区）**

**`scripts/dispatch-brain-task.mjs`（新文件）**
- `node scripts/dispatch-brain-task.mjs --project owner/repo "<intent 文本>"`：① 校验 `--project` 对应的 `project_registry` 已注册（复用 B3 的同款前置检查逻辑，抽成共享函数 `assertProjectRegistered(store, projectKey)`，B3/B5 两处调用同一份，不各写一份）；② 组一个 `TaskContract`（复用/扩展 `docs/conductor-brain-layer/spike/lib/translator.mjs` 的 `translateIntent()`，新增可选参数把 `--project` 的值拼进 `objective` 文本前缀，`policy.allowedPaths` 固定指向本批次的 `docs/conductor-brain-multiproject/spike/**` 安全区，**不**指向目标项目路径——§3.2 已定的范围决定）；③ 走**库调模式**（同 `run-spike.mjs` 已验证的路径：`assembleProfileDeps("subscription", ...)` → `ConductorWorkApp.planRun/startRun/resumeRun`（G1/G2 自动放行，G3/Escalation 恒停）→ `projectEvents()` 得 `EvidenceBundle`）；④ 三态门（复用 `docs/conductor-brain-layer/spike/lib/three-state-gate.mjs`）把 `EvidenceBundle` 折成一条 `active_task` 或 `postmortem` memory，`tags` 含 `project:<owner>/<repo>`。

**测试/验证（人工 self-check，非 CI 自动跑——涉及真实 subscription profile 凭证 + 真实 LLM 调用，同 `run-spike.mjs` 现有惯例）**：
1. `git -C /Users/elishawong/code/github/whoseworks/whoseorder status --porcelain` → 记录为"before"快照。
2. `node scripts/onboard-project.mjs --repo-path /Users/elishawong/code/github/whoseworks/whoseorder --display-name whoseorder`。
3. `node scripts/seed-brain-identity.mjs`（针对 aeloop 自己，回归验证 §4.5 分组逻辑不因新项目注册而破坏既有单项目行为）。
4. `node scripts/dispatch-brain-task.mjs --project whoseworks/whoseorder "冒烟验证：写一个纯函数 reverseString(s)，用输入 'whoseorder-brain-check' 自证正确，不需要读写任何文件"`。
5. 全新进程 `node docs/conductor-brain-layer/spike/demo-wake-greeting.mjs`（或等价的 wake 驱动）验证：开场白里出现 `whoseorder` 分组，且能看到刚写回的候选相关记录。
6. `git -C /Users/elishawong/code/github/whoseworks/whoseorder status --porcelain` → 记录为"after"快照，**与步骤1的输出字节级比对，必须相同**。

---

## 5. 批次拆解（[S/M/L] + 依赖关系）

| 批次 | 规模 | 范围 | 依赖 | 备注 |
|---|---|---|---|---|
| **B0** | **L** | `install-global-brain.mjs` + 测试；`~/.claude/settings.json` 合并写入 + 备份 | 无 | **⚠️ 高风险，Zorro 重点审**——唯一会真的写用户主目录文件的批次，合并逻辑写错会破坏用户已有的其它全局 hook |
| **B1** | S | `db-path.mjs` 全局模式 + 测试 | 无（与 B0 无代码依赖，但 B0 安装出的 snapshot 里跑的就是这份代码，逻辑先后建议 B1 先于/同时于 B0） | |
| **B2** | S | `onboard-project.mjs` + 测试 | B1（复用 `resolveIdentityDbPath`） | |
| **B3** | S/M | `seed-brain-identity.mjs` 多项目扩展 + 测试 | B2（前置检查依赖 `project_registry` 已存在） | |
| **B4** | **M** | `status-table.mjs`/`greeting-data.mjs`/`render-greeting.mjs`/`brain-wake-greeting.mjs` 分组渲染 + 测试 | B3（需要真实 `project:*` tag 数据验证分组） | 需要 ≥2 个项目的 fixture 数据 |
| **B5** | **L** | `dispatch-brain-task.mjs` + 真实 whoseorder vertical-slice（人工 self-check） | B0 + B1 + B2 + B3 + B4 全部完成 | **⚠️ 高风险，Zorro 重点审**——唯一真的调用真实 LLM + 涉及真实第三方仓库（whoseorder）的批次，即便是只读也要重点核对 §3.2 的范围边界有没有被实现悄悄突破 |

**建议执行顺序**：`{B0, B1}` 可并行（互相无代码依赖）→ `B2`（依赖 B1）→ `B3`（依赖 B2）→ `B4`（依赖 B3）→ `B5`（依赖全部，收尾）。**不建议**并行做 B4/B5——B5 的人工 self-check 需要 B4 的分组渲染已经能正确工作，才能在步骤5里验证"开场白里出现 whoseorder 分组"这条断言。

---

## 6. Testable Acceptance Criteria

### 6.1 B0
- [ ] 全新 `~/.claude/settings.json`（不存在时）→ 安装后正确创建、含唯一一条 SessionStart hook 条目。
- [ ] 已有其它 hook 条目的 `~/.claude/settings.json` → 安装后原有条目**逐字节不变**，仅新增本工具的条目。
- [ ] 二次运行（幂等）→ hook 条目不重复累加（数组长度不变）。
- [ ] `--dry-run` → 不产生任何文件系统写入（用临时 `os.homedir()` fixture 断言目录树没有被创建）。
- [ ] 安装产出的 `repo-snapshot/` 目录树包含预期的全部文件（`dist/**` 存在、`.claude/hooks/brain-wake-greeting.mjs` 存在、`docs/conductor-brain-layer/spike/lib/*.mjs` 五个文件全部存在）。

### 6.2 B1
- [ ] `AELOOP_BRAIN_GLOBAL_MODE=1` + 未设 env db path → 返回全局默认路径，且过程中不发起任何 `<cwd>/.claude/brain.local.json` 的文件系统读取（可用 mock `readFileSync` 断言零调用，或用一个刻意指向不存在目录的 `cwd` 验证不抛错/不受影响）。
- [ ] `AELOOP_BRAIN_GLOBAL_MODE=1` + 同时设了 `AELOOP_BRAIN_IDENTITY_DB` → env 值优先。
- [ ] 未设 `AELOOP_BRAIN_GLOBAL_MODE`（回归）→ 所有既有 `test-db-path.mjs` 用例原样通过，零改动。

### 6.3 B2
- [ ] 首次 onboard 一个 fixture git repo → `project_registry` memory 正确插入（`title`/`tags` 格式正确）。
- [ ] 二次 onboard（内容不变）→ `unchanged`，零额外写入。
- [ ] **onboard 前后，目标 fixture 目录 `git status --porcelain` 输出字节级相同**（epic 验收标准"目标 repo 零 brain 文件物理验证"的自动化落地）。
- [ ] 非 git 目录/无 origin → 明确报错，身份库零写入。

### 6.4 B3
- [ ] 目标项目未注册 → 明确报错，零写入（不产生孤儿 `project:*` tag）。
- [ ] 目标项目已注册 → 全部 `active_task` 的 `tags` 含正确的 `project:<owner>/<repo>`。
- [ ] 二次运行真幂等（复用 B8/#88 既有的零调用断言模式）。

### 6.5 B4（对应 epic 验收标准"开场白按项目分组显示各项目在途，≥2 项目验证聚合"）
- [ ] 单一 db 内同时存在 ≥2 个项目的 `project:*` tag 数据 → 渲染出的开场白正确分组，当前项目（由传入的 `currentProjectKey` 决定）完整表格置顶，其它项目一行摘要。
- [ ] 无 `project:*` tag 的历史遗留数据（如 B3 上线前已存在的旧 `active_task`）→ 显式标"未分组"，不静默丢弃、不误判进任何一个项目分组。
- [ ] `currentProjectKey` 解析失败（stdin 没有 `cwd` 或 `git remote` 判不出）→ 兜底渲染路径生效，不抛错、不阻断会话（回归"绝不阻断"红线）。
- [ ] 渲染输出的每一段新增文本仍然经过 `sanitizeText()`（用一条含 `\n`/`|` 的恶意 `project_registry.content` 验证不会伪造出额外的表格行/bullet，回归 2026-07-23 复审确立的红线）。

### 6.6 B5（人工 self-check + 以下自动化断言）
- [ ] `dispatch-brain-task.mjs` 对未注册项目 → 明确报错，不发起任何真实 LLM 调用（用 mock 断言 `ConductorWorkApp`/`assembleProfileDeps` 零调用）。
- [ ] （人工）真实跑通 §4.6 六步验证流程，产出候选 + `EvidenceBundle`，三态门折回后再醒来能看到延续。
- [ ] （人工，核心断言）whoseorder 工作区 `git status --porcelain` 在整个 B5 流程前后**字节级相同**。
- [ ] （人工）开场白渲染出的 `whoseorder` 分组内容与刚写回的记录一致，不是编造的。

### 6.7 诚实边界（延续 #88 PRD 的既有惯例，必须写清楚不设的验收项）
- **不设**"coder/tester 工具执行 cwd 指向 whoseorder"的验收项——§3.2 已经明确这是片①范围外的决定，不是遗漏。
- **不设**"三个写侧防护 hook 在 whoseorder 里生效"的验收项——DESIGN §3 明确排除，B0-B5 都不注册这三个 hook 到全局 `settings.json`。
- **不设**"`settings.json` 多 scope 合并语义"的验收项——DESIGN §1.1 已标 `[?]`，本 PRD 范围内不解决。

---

## 7. Dependencies / Risks / Open Questions

- **B0 是本批次唯一会真的修改用户主目录文件的批次**——合并写入 `~/.claude/settings.json` 的逻辑如果有 bug（比如把已有条目误判为"和本次要写的一样"从而跳过，或者相反误删已有条目），影响面是用户机器上**所有**项目的 Claude Code 会话，不只是 aeloop/whoseorder——这是全公司 Zorro 复审里少有的"影响面超出被改动仓库本身"的批次,建议复审时额外用一个真实但可恢复的 `~/.claude/settings.json` 副本做一次端到端演练（不是只看单元测试),而不是只读代码判断逻辑对不对。
- **B5 是本批次唯一真的调用真实 LLM + 涉及真实第三方仓库的批次**——即便设计上是纯只读（一次 `git remote get-url` + 全程 cwd 不指向 whoseorder），复审时应重点核对"实现是否真的没有任何代码路径会把 cwd/文件操作指向 whoseorder"，而不是信任 PRD 文字描述——这条本身就是防止"设计意图正确但实现悄悄漂移"的复审重点。
- **§3.1 判定结论如果指挥官希望片①就要更高保真度**（工具真的进 whoseorder 目录只读），需要追加一次独立范围讨论（回军师）——本 PRD 明确建议先按 Level 1（合成任务）交付，理由是新增管线的工作量/风险（`src/harness/**`/`src/conductor-work/**` 多文件改动 + `aeloop#31` 风险敞口）超出片①"地基"定位。
- **B4 依赖真实（或 fixture）≥2 项目数据才能验证聚合**——如果 B5 因为任何原因推迟/取消，B4 的"≥2 项目"验收标准仍然可以用两个 fixture 项目（不需要真的是 whoseorder）在单测层面满足,不阻塞 B4 独立验收。
- **`aeloop#31`（`ClaudeCliAdapter` bypassPermissions 已知写权限风险）是本 PRD 发现但明确不修的既有问题**——§3.2 的范围决定绕开了它，不是修复了它,如果未来要做§3.1 描述的高保真度管线，这个 issue 是前置阻塞项,需要在那时候的范围讨论里重新面对。

**Build 阶段 token 成本预期**：B0/B5 是两个高风险批次,预计各自需要额外一到两轮返工（B0 的 JSON 合并逻辑边界案例、B5 的真实 LLM 调用+人工验证流程通常第一轮走不完整）；B5 的人工 self-check 步骤涉及真实 subscription profile 的 LLM 调用，产生真实 token 消耗（量级同 `run-spike.mjs` 已有先例，非零但单次可控）。

---

## 8. Project Constraint Checklist

- **whoseorder 零侵入？**：适用——B5 是本 PRD 唯一接触 whoseorder 的批次，且被严格限定为**一次只读 `git remote get-url origin`**（`onboard-project.mjs`），工具执行 cwd 全程不指向 whoseorder（§3.2 已定），自动化 + 人工双重断言"`git status --porcelain` 字节级不变"。不走 `/wo-module`（那是 whoseorder 自己仓库内改代码的流程，本 PRD 不改 whoseorder 一行代码，不适用）。
- **跨项目契约（whoseorder↔whosehere）？**：N/A——本 PRD 不涉及 whoseorder/whosehere 之间的任何接口。
- **aeloop 项目内约束**：不碰 `src/**` 任何一行（§3.1 判定的直接结果——本 PRD 明确选择不做需要改 `src/harness/**`/`src/conductor-work/**` 的 cwd 透传管线，因此片①全部改动落在 `.claude/hooks/`、`scripts/`、`docs/conductor-brain-layer/spike/lib/`、`docs/conductor-brain-multiproject/`，延续 #84/#88 已有的"不碰 `src/context/**`/`src/**`"惯例，范围更进一步扩大到不碰 `src/**` 任何目录）；不引入新 npm 依赖到 aeloop 自己的 `package.json`（`better-sqlite3` 在 B0 安装脚本里只写进**全局安装目录自己的**`package.json`，不改 aeloop 仓库的依赖清单）。
- **`.mjs` 不在 tsc/vitest 覆盖内**（延续 #88 PRD §8 已核实的结论）——保障靠本 PRD §6 列出的独立 `node:assert/strict` 脚本。
- **占位符/假数据残留**：无——所有新文件的 env 变量名（`AELOOP_BRAIN_GLOBAL_MODE`）延续既有 `AELOOP_BRAIN_*` 命名惯例；B5 使用的目标 owner/repo（`whoseworks/whoseorder`）已用 `git remote -v` 实测核实，不是默认联想的字符串。
