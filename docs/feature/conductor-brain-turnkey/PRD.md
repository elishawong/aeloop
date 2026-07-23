# PRD — aeloop: conductor-brain turnkey 落地包（issue #88）

> 防幻觉：`[?]` = 未核实 / 需 operator 确认；不编接口/参数/版本号。本 PRD 对现有代码的每条引用，均来自对 `docs/conductor-brain-layer/{DESIGN.md,BRAIN.md,WAKE-GREETING-RUNBOOK.md}`、`.claude/hooks/brain-wake-greeting.mjs`、`docs/conductor-brain-layer/spike/lib/*.mjs`、`src/context/{types,store,injector}.ts`、`src/evidence/bundle.ts`、`.claude/settings.json`（aeloop）、以及 ai-agent 仓库 `.claude/hooks/{session-commit-gate,session-issue-gate,session-isolation-guard}.mjs`/`_engine/{session-lock,commit-gate-match,gh}.mjs` 的直接阅读，不凭记忆。**方案权威是 `docs/conductor-brain-layer/TURNKEY-DESIGN.md`（operator 已确认，2026-07-23）——本 PRD 不重复其架构论证/核实结果，只把已定案的方案翻译成逐文件任务清单 + 可执行批次。**

- **项目**: aeloop（`elishawong/aeloop`）
- **分支**: `design/issue-88-conductor-brain-turnkey`（延续 DESIGN 所在分支，build 阶段是否 rename 为 `feature/issue-88-...` 由 operator/军师决定，本 PRD 不预设）
- **优先级**: P1（issue #88 label）
- **状态**: 待 operator 确认（DESIGN 已确认，PRD 待确认后进 `/build`）
- **最后更新**: 2026-07-23
- **关联 issue**: [elishawong/aeloop#88](https://github.com/elishawong/aeloop/issues/88)
- **方案权威**: `docs/conductor-brain-layer/TURNKEY-DESIGN.md`（operator 已确认两处开放决策：§4 人格加载 = 方案(iii)；§7 issue-gate 范围 = opt-in/env 开关，默认收窄）

---

## 0. Scope

**In scope**：DESIGN §3 定义的 4 块交付物的**逐文件落地**——① 去品牌宪法（`CLAUDE.md` 新建 + `BRAIN.md` 扩写）；② 4 个强制 hook（`brain-commit-gate`/`brain-issue-gate`/`brain-red-line-guard`/`brain-isolation-guard`）+ 2 个共享库（`command-match.mjs`/`git-remote.mjs`）+ 1 个精简会话锁库（`brain-lock.mjs`）；③ 一键 seed 脚本（`scripts/seed-brain-identity.mjs`）；④ env setup 文档扩写 + dbPath fallback 机制（`.claude/brain.local.json`）。

**Out of scope**（对齐 DESIGN §8 明确不做清单，不重复论证）：多角色编排框架；`CLAUDE.md`/身份库 constraint memory 自动同步；overlay 打包 CLI；"意图→TaskContract→执行→折回"闭环；`src/context/**`/`src/**` 任何改动；命令混淆绕过的根治；hook 延迟量化。

---

## 1. Problem / Users / Solution

**要解决的问题**：DESIGN §0/§1 已核实——#84 交付的醒来开场白 hook 本身是干净的，但整套东西缺"人格加载"和"红线机制"两块，operator 在公司电脑实测时看到的是通用助手，不是"有铁律、说真话、红线被拦住"的公司大脑。TURNKEY-DESIGN.md 已经把方案定完（含 operator 两处拍板），本 PRD 的职责是把方案变成可以直接 `/build` 的逐文件任务。

**谁需要**：operator 本人（aeloop 是单 operator 场景，DESIGN §6/§7 已确认）——日常开发时红线机制默认低摩擦，pitch/演示时能一键切到"治理真拦"模式。

**一句话方案**：新增 4 个 PreToolUse/SessionStart hook（3 个真 deny + 1 个 warn-only）+ 3 个共享库 + 1 个 seed 脚本 + 1 个新 `CLAUDE.md` + 对 `BRAIN.md`/`WAKE-GREETING-RUNBOOK.md`/`brain-wake-greeting.mjs` 的定点扩写，全部遵循 #84 已有的"渲染器拼数据、hook 只做驱动壳、绝不阻断非目标场景"的既有惯例。

---

## 2. Goals / Non-goals

**Goals**：
- `CLAUDE.md`（新，aeloop 根）：Claude Code 原生加载，承载静态身份/人格/铁律（DESIGN §4 方案(iii) 的静态半边）。
- `BRAIN.md` 新增 §1.5（人格）/§1.6（铁律）两节，不改动现有 §1-§5 一字。
- 4 个 hook 全部具备**真 PreToolUse deny 能力**（不是 warn 假装），逐个有自动化"真的 deny"验证（对齐 DESIGN §9 spike 步骤5/6）。
- `brain-issue-gate.mjs` 默认档位（未设 `AELOOP_BRAIN_ISSUE_GATE` 或非 `enforce`）**恒 allow**，`enforce` 档真 deny——两态都要有测试覆盖（operator 决议，DESIGN §3.b/§7）。
- `scripts/seed-brain-identity.mjs` 幂等：宪法约束按 `title` upsert，`gh issue list` 拉到的在途任务按 `gh-issue:<n>` tag upsert，消失的 issue 打 `archived` 不删除（DESIGN §3.c）。
- `AELOOP_BRAIN_IDENTITY_DB` 未配置时读 `.claude/brain.local.json` 兜底（DESIGN §3.d 方案），解决 IDE 启动不继承 shell profile 的坑。

**Non-goals**（对齐 DESIGN §8，逐条不重复论证）：不做多角色框架；不做 `CLAUDE.md`↔身份库自动同步；不做 overlay 打包 CLI；不碰 `src/context/**`/`src/**`；不量化 hook 延迟；不做命令混淆的根治；`greeting-data.mjs` 的 constraint label 措辞优化列为**可选 P2**（DESIGN §4(iii) 已核实这不是打通闭环的必要条件，见 §5 任务清单最后一条）。

---

## 3. 关键设计核实（承接 DESIGN，PRD 阶段追加的具体化，不改变 DESIGN 结论）

DESIGN §4(iii) 已经核实一个直接影响任务量的事实，在这里重申因为它决定了 §5 任务清单的边界：**"unconfirmed 的 constraint memory 出现在待你决策段"这条管线今天就是通的**（`wake.mjs:44-61` 的 `pendingDecisions` + `greeting-data.mjs:167-170` 的合并逻辑），本 PRD **不需要改** `brain-wake-greeting.mjs`/`greeting-data.mjs`/`wake.mjs`/`render-greeting.mjs` 来打通这条闭环。`brain-wake-greeting.mjs` 唯一需要改的地方是 §3.d 的 dbPath fallback（和"人格加载"这条闭环本身无关，是另一个独立的配置健壮性问题）。

新增的三个共享库（`command-match.mjs`/`git-remote.mjs`/`brain-lock.mjs`）是"精简移植"，不是"完整搬运"——具体裁剪范围见 §5 对应文件条目，裁剪理由已在 DESIGN §3.b 写明（aeloop 是单 operator/单会话场景，不需要 Helix 那套多角色/多 worktree 并发探测）。

---

## 4. Per-file Task List

### 4.1 共享库（无业务判据，纯基础设施）

**`.claude/hooks/lib/git-remote.mjs`（新文件）**
- 移植 `_engine/gh.mjs:147-163`（ai-agent 仓库）的 `getOriginOwnerRepo(repoPath)`：`execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], ...)` → 用同款 SSH（`^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$`）/HTTPS（`^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$`）双正则解析 owner/repo。**不移植** `verifyIssueOwnerMatchesRepo`（`gh.mjs:165-194`）——本包不需要"校验用户手写的 owner 是否匹配仓库"这个更复杂的场景，`brain-lock.mjs` 自己的 issue ref 校验是一个独立的、更简单的格式正则（见下）。
- 导出：`getOriginOwnerRepo(repoPath): {ok:true, owner, repo} | {ok:false}`、`resolveToplevel(cwd): string|null`（`git -C cwd rev-parse --show-toplevel`，供各 hook 判定目标仓库复用，同 Helix 三个 hook 里反复出现的同一段逻辑，抽成共享函数不各写各的）。

**`.claude/hooks/lib/command-match.mjs`（新文件）**
- 移植 `_engine/commit-gate-match.mjs`（ai-agent 仓库）的方法论（**不是照抄代码**，DESIGN §1 已核实这块无蓝本可抄，只能抄方法论）：token 化 + 命令位置解析（跳过环境变量赋值/shell 控制前缀 → 取命令词 basename → 若是 `sh -c`/`bash -c` 递归解析字符串参数 → 若是透明包装器（`sudo`/`env`/`nice`/`command`/`exec`）跳过 flag 递归解析真实命令）。
- 导出：`resolveCommandInvocations(cmdString): {cmd, args}[]`（按 `&`/`|`/`;`/换行切段后，每段解析出真正被执行的命令）、`matchesGitSubcommand(invocation, subcommand): boolean`（如 `matchesGitSubcommand(inv, "commit")`）、`matchesForcePush(invocation): boolean`（`git push` 且含 `--force`/`-f`、不含 `--force-with-lease`（含即视为安全变体，不判定为强推——已知简化，DESIGN §6 白名单维护成本条目下追加记录：不精确复刻 git 本身"最后一个 flag 生效"的语义，这是本 PRD 明确接受的简化，不在验收范围内苛求）、`matchesRmDashRf(invocation): boolean`（命令是 `rm` 且参数组合等价于 `-r`+`-f`：单 token `-rf`/`-fr`，或分开的 `-r`/`-f`（含长选项 `--recursive`/`--force` 任意组合））。
- **不移植**：Helix 版本里"过度拦截误判"那几条历史修复（`git "commit"` 加引号、`--no-optional-locks` 等 flag 变体）作为**已知局限直接标注**，不逐条复刻其全部边界修复历史——本文件从 Helix 现有实现的**当前状态**（已修完那些 bug 的版本）移植方法论，不重演它的修复史，但功能上等价（即：新文件要通过和 Helix 现版本同一批已知正例/反例用例，见 §6 acceptance）。

**`.claude/hooks/lib/brain-lock.mjs`（新文件，精简移植 `_engine/session-lock.mjs`）**
- 存储：`.claude/brain-locks/<sessionKey>.json`（gitignore，见 §4.4），`sessionKey` = `sessionId`（有则用，sanitize 掉路径分隔符）或退化用 `pid`（同 Helix `identityKey` 惯例，但**不做**多进程/多 worktree 并发探测——单文件读写不加 `withRmwLock` 那套完整的并发竞态测试基础设施，Phase1 单会话场景规模不对等，这是明确接受的裁剪，写进 DESIGN §6 已有的白名单维护成本讨论旁边，不新开一条）。
- 字段：`{sessionId, pid, issue: string|null, commitAuthorizedAt: string|null, commitAuthorizationConsumedAt: string|null}`。
- 导出（精确复刻 Helix 对应函数的判定逻辑，不弱化）：
  - `resolveSessionId(): string|null` — `process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.AELOOP_BRAIN_SESSION_ID || null`（第三个变量名去品牌，从 `HELIX_SESSION_ID` 改成 `AELOOP_BRAIN_SESSION_ID`，其余两个是 Claude Code 自己的环境变量，跨项目通用不改名）。
  - `hasValidCommitAuthorization(lock, {now, maxAgeMs}): boolean` — 精确复刻 `session-lock.mjs:518-527` 的判据（缺/坏 `now` → false；`commitAuthorizedAt` 缺失 → false；已消费 → false；未来时间戳超出时钟漂移容差 → false；超龄 → false），**含 BUG-7 的两条防御性检查**（缺 now、未来时间戳）——这是 Helix 自己真实复审修出来的两个安全洞，精简移植不能把这两条也精简掉。
  - `authorizeCommit(toplevel, sessionId, opts): string`（写路径）、`consumeCommitAuthorization(toplevel, sessionId, opts): {consumed:boolean, reason?}`（同 Helix 语义，一次性令牌）。
  - `bindIssue(toplevel, sessionId, issueRef): {ok:boolean, reason?}` — 校验 `issueRef` 匹配 `/^[\w.-]+\/[\w.-]+#\d+$/`（自包含正则，**不移植** `gh.mjs` 的 owner 一致性校验——Phase1 单 operator 场景，写错 owner 的代价远低于 ai-agent 那种多项目环境，接受这个简化）。
  - `findOwnLock(toplevel, {sessionId, pid}): lock|null`。
  - CLI：`node .claude/hooks/lib/brain-lock.mjs authorize-commit`、`bind-issue --issue=<owner>/<repo>#<n>`、`show`（同 Helix `bind`/`show` 惯例，供人手动跑）。

### 4.2 四个 hook

**`.claude/hooks/brain-commit-gate.mjs`（新文件）**
- Matcher: `PreToolUse` / `Bash`。逻辑：`kill-switch AELOOP_BRAIN_SKIP_COMMIT_GATE=1` → allow；非 Bash → allow；`command-match.mjs` 判不命中 `git commit`/`git push`（含 force-push 变体，判据复用同一份 `matchesForcePush`/`matchesGitSubcommand`）/`gh pr merge` → allow；`git-remote.mjs` 判目标不是本仓库 → allow；`brain-lock.mjs` 消费令牌成功 → allow；否则 deny，提示 `node .claude/hooks/lib/brain-lock.mjs authorize-commit`。**逐条移植 `session-commit-gate.mjs:136-199` 的判定顺序**，不改变顺序（fail-open 边界的正确性依赖判定顺序，不能重排）。

**`.claude/hooks/brain-issue-gate.mjs`（新文件）**
- Matcher: `PreToolUse` / `Edit|Write`。逻辑：**第一条判据就是档位开关**——`process.env.AELOOP_BRAIN_ISSUE_GATE !== 'enforce'` → 恒 allow（DESIGN §3.b/§7 operator 已确认的默认收窄，这是和 Helix 版本**最大的行为差异**，必须是判定链的第一条，不是最后一条兜底）；`enforce` 模式下才继续走：`kill-switch AELOOP_BRAIN_SKIP_ISSUE_GATE=1` → allow；非 Edit/Write → allow；非 git 目录 → allow；`brain-lock.mjs` 的 `findOwnLock` 找到合法 `issue` 字段 → allow；否则 deny，提示 `bind-issue` 命令。
- **不移植** `session-issue-gate.mjs` 的 `HELIX_ROLE` 白名单机制（`GATED_ROLES = {cypher, zorro}`）——aeloop 没有角色框架，DESIGN §3.b/§6 已确认改用二态档位开关代替角色白名单。

**`.claude/hooks/brain-red-line-guard.mjs`（新文件，从零设计）**
- Matcher: **两个条目**——`PreToolUse`/`Bash` 和 `PreToolUse`/`Edit|Write`（同一文件，靠 `input.tool_name` 分支）。
- Bash 分支：`command-match.mjs` 的 `matchesRmDashRf(inv)` 命中 → 检查该 `rm` 调用里所有非 flag 参数（候选路径），`path.resolve(cwd, arg)` 是否落在白名单前缀内（Phase1 白名单仅 `os.tmpdir()` 一项，保守起步，DESIGN §6 已标注这个白名单需要随实际使用场景增补）——**任一**路径参数不在白名单 → deny。`matchesForcePush(inv)` 命中 → deny。命令是重定向（`>`/`>>`）或 `tee` 写入、目标路径 basename 匹配 `/^\.env(\..+)?$/` 且不在 example 白名单（`.env.example`/`.env.sample`/`.env.template`）→ deny。
- Edit/Write 分支：`tool_input.file_path` 的 basename 匹配上述 `.env` 正则且不在 example 白名单 → deny。
- 均为 fail-open：任何一步判不出（非目标命令/目标是白名单内/异常）→ allow。kill-switch `AELOOP_BRAIN_SKIP_REDLINE_GUARD=1`。
- **诚实标注（写进文件头注释，不是只写在 PRD 里）**：这是 DESIGN §1/§5 已经核实的"无蓝本可抄，从零设计判据"的一批，命令混淆（变量拼接/`eval`）绕不过，这是 Claude Code hook 纯文本匹配的天花板，不是本文件能解决的问题。

**`.claude/hooks/brain-isolation-guard.mjs`（新文件，移植 warn-only 语义）**
- Matcher: `SessionStart`。逻辑：结构性移植 `session-isolation-guard.mjs`——检测本 worktree 内是否存在其他"活"锁（`brain-lock.mjs` 锁文件里加一个 `heartbeatAt` 字段，本 hook 判定新鲜度阈值），有则 `additionalContext` 注入警告文案，**全程 exit 0，不阻断**（DESIGN §1 已纠正 issue body 的分类，本文件正确保留 warn-only 定位，不夸大成 deny）。kill-switch `AELOOP_BRAIN_SKIP_ISOLATION_GUARD=1`。

### 4.3 宪法文档

**`CLAUDE.md`（新文件，aeloop 根目录）**
- 内容 = `BRAIN.md` §1（我是谁）+ 新 §1.5（人格）+ 新 §1.6（铁律精简版）的去品牌宪法正文精简版，面向模型的行为指令，结尾一行"完整设计见 `docs/conductor-brain-layer/BRAIN.md`"。**不包含**"生存使命"“双档位"“companion 记忆"（DESIGN §3.a 已确认去掉）。铁律部分**必须准确反映 §4.2 各 hook 的默认档位**——尤其"无 issue 不动手"这条，措辞要写清楚"默认不生效，`AELOOP_BRAIN_ISSUE_GATE=enforce` 时才生效"，不能写得像默认就在拦（DESIGN §5 表格已明确要求这条如实标注）。

**`docs/conductor-brain-layer/BRAIN.md`（编辑，只新增两节，不改现有内容）**
- 插入 §1.5（人格）/§1.6（铁律）于现有"我是谁"和"醒来协议"之间（DESIGN §3.a 已给出精确文字方向）。
- 现有 §4"身份库记录约定"表格追加一行（宪法约束怎么进身份库，DESIGN §3.a 已给出精确表格）。
- **验收锚点**：`git diff` 现有 5 节（我是谁/醒来协议/防幻觉铁律/身份库记录约定/Phase1 诚实边界）里，原有段落文字零改动，只有新增行/新增节。

**`docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`（编辑，只新增章节）**
- 新增"shell profile 正确姿势"（写进 `.zshrc`/`.bashrc` 的具体命令 + `source` 提醒）、"IDE 启动读不到 env 的坑"（`launchctl setenv` + `.claude/brain.local.json` fallback 两条修法）、"排查清单"三小节（DESIGN §3.d 已给出精确内容）。

### 4.4 seed 脚本 + env fallback

**`scripts/seed-brain-identity.mjs`（新文件）**
- `CONSTITUTION_CONSTRAINTS` 常量数组：每条 `{slug, content, hardness: "hard"|"soft"}`，内容是 `BRAIN.md` §1.6 铁律清单的机器可读镜像（DESIGN §3.c 已标注两者会漂移，需人工同步，本文件头注释写清楚这条已知代价）。
- 主流程：① 读 `AELOOP_BRAIN_IDENTITY_DB`（或 `.claude/brain.local.json` fallback，复用 §4.4 下方的 dbPath 解析逻辑，抽成共享函数供 `brain-wake-greeting.mjs`/本脚本共用，见下）；② 打开 `MemoryStore`；③ upsert `CONSTITUTION_CONSTRAINTS`（按 `title: "constraint:<slug>"` 匹配，内容变化则 `updateMemoryContent`，否则跳过）；④ `gh issue list --repo <owner>/<repo> --state open --json number,title,labels`（`owner/repo` 来自 `git-remote.mjs` 的 `getOriginOwnerRepo`）→ 按 DESIGN §3.c 映射表转 `active_task`，按 `gh-issue:<n>` tag 匹配 upsert；⑤ 库里有 `gh-issue:<n>` tag 但这次没拉到的 → 打 `archived` tag，不删除。
- **可测试性设计**：`gh issue list` 的调用抽成一个可注入参数 `fetchOpenIssues: () => Promise<{number,title,labels}[]>`，默认值是真的 `execFileSync('gh', [...])`，测试传入假数据——不需要真实网络/`gh` CLI 才能跑单测（这是本文件必须满足的设计要求，不是可选项，否则 CI/本机测试会依赖外部网络状态，不可复现）。

**`.claude/hooks/lib/db-path.mjs`（新文件，小共享库）**
- 导出 `resolveIdentityDbPath(): string|null` — `AELOOP_BRAIN_IDENTITY_DB` 优先；缺失则读项目根 `.claude/brain.local.json` 的 `identityDbPath` 字段（`JSON.parse(readFileSync(...))`，读不到/解析失败 → null，不抛错）；两者都没有 → null。**这是 DESIGN §3.d 的机制化 fallback**，供 `brain-wake-greeting.mjs`（编辑）和 `scripts/seed-brain-identity.mjs`（新）共用，不各写一份。

**`.claude/hooks/brain-wake-greeting.mjs`（编辑，#84 既有文件）**
- 唯一改动：`const dbPath = process.env.AELOOP_BRAIN_IDENTITY_DB;` → `const dbPath = await resolveIdentityDbPath();`（新增 import `db-path.mjs`）。**不改**其余任何一行——`emitAdditionalContext`/渲染调用链/绝不阻断惯例全部原样保留。

**`.claude/brain.local.json.example`（新文件，模板）**
- `{"identityDbPath": "/absolute/path/to/your/identity.db"}` + 一行注释说明"复制成 `.claude/brain.local.json`（已 gitignore）"。

**`.gitignore`（编辑）**
- 追加 `.claude/brain.local.json`、`.claude/brain-locks/`（DESIGN §3.d + §4.1 brain-lock.mjs 存储目录，均不进 git）。

### 4.5 `.claude/settings.json`（编辑）

新增 4 个 hook 注册条目（B3-B6 各自负责自己那条，避免一个 PR 里堆四条同时改导致 diff 难审）：
```jsonc
// PreToolUse 追加 3 条（matcher: "Bash" ×2 + "Edit|Write" ×1，分别对应 commit-gate/red-line-guard(bash分支)/issue-gate；
// red-line-guard 同时也要在 "Edit|Write" matcher 下再挂一条，用同一个文件、两个 matcher 条目，同 §4.2 已说明）
// SessionStart 追加 1 条（brain-isolation-guard.mjs，和已有的 brain-wake-greeting.mjs 同一个 matcher "startup|resume|clear" 下追加）
```
（具体 JSON 内容见 `plan.md` 各批次"Do"步骤，此处只列变更点，不重复写完整 JSON 两遍）

### 4.6 可选 / P2（不阻塞验收）

**`docs/conductor-brain-layer/spike/lib/greeting-data.mjs`（可选编辑）**
- `pendingDecisions` 的 label 组装对 `memory.type === "constraint"` 换一个更可读的措辞（如 `候选修宪：${content}` 而非通用的 `[constraint] title — content`）。**不是必需**——DESIGN §4(iii) 已核实通用格式今天就能正确工作，这纯粹是可读性打磨，可以整个跳过不影响任何验收标准。

---

## 5. 批次拆解（[S/M/L] + 依赖关系）

| 批次 | 规模 | 范围 | 依赖 | 备注 |
|---|---|---|---|---|
| **B1** | S | `git-remote.mjs` + `command-match.mjs` + 各自测试 | 无 | 纯函数库，可最先做，也可与 B7 并行 |
| **B2** | S | `brain-lock.mjs` + 测试 | 无（不依赖 B1） | 与 B1 可并行 |
| **B3** | S | `brain-commit-gate.mjs` + 测试 + settings.json 注册（1条 PreToolUse/Bash） | B1, B2 | |
| **B4** | S | `brain-issue-gate.mjs` + 测试 + settings.json 注册（1条 PreToolUse/Edit\|Write） | B2（不需要 B1，issue-gate 不做命令解析） | 含 opt-in/enforce 两态验证 |
| **B5** | **M** | `brain-red-line-guard.mjs` + 测试 + settings.json 注册（2条：PreToolUse/Bash + PreToolUse/Edit\|Write） | B1（不需要 B2） | **⚠️ 从零设计判据，Zorro 重点批**（见 §7 风险） |
| **B6** | S | `brain-isolation-guard.mjs` + 测试 + settings.json 注册（1条 SessionStart） | B2（读 brain-lock 的心跳字段） | |
| **B7** | S | `CLAUDE.md`（新）+ `BRAIN.md` §1.5/§1.6 扩写 | 无 | 纯文档，可与 B1/B2 并行 |
| **B8** | **M** | `scripts/seed-brain-identity.mjs` + 测试 | B7（constraint 清单内容需 `BRAIN.md` §1.6 已定稿）、`db-path.mjs`（B9 产出，或提前到 B8 里一并做，见下方排期建议） | 幂等 + 可注入 fetcher 的测试设计是本批重点 |
| **B9** | S | `db-path.mjs` + `brain-wake-greeting.mjs` dbPath fallback 编辑 + `.claude/brain.local.json.example` + `.gitignore` 编辑 + `WAKE-GREETING-RUNBOOK.md` 扩写 + 测试 | 无 | 建议提到 B8 之前做（B8 依赖它的 `db-path.mjs`），下方顺序按此排 |

**建议执行顺序**（把 B9 提前，因为 B8 依赖它）：`{B1, B2, B7, B9}` 可四批并行（互相无依赖）→ `{B3, B4, B6}` 三批并行（各自依赖 B1/B2 的子集，互相不依赖）→ `B5` 单独（依赖 B1，规模较大，建议独立一轮不与其他批次挤在同一次 Zorro 复审）→ `B8`（依赖 B7 + B9）。**单线程按顺序 build 的话**，建议顺序：B1 → B2 → B9 → B7 → B3 → B4 → B6 → B5 → B8（把最需要独立复审带宽的 B5 放在四个 hook 里最后，避免和 B3/B4/B6 的复审挤在同一轮；B8 放最后因为它依赖最多）。

可选 B10（P2，见 §4.6）：不计入批次总数，可整批跳过。

---

## 6. Testable Acceptance Criteria

### 6.1 共享库（B1/B2）
- [ ] `git-remote.mjs`：SSH 形式（`git@github.com:owner/repo.git`）与 HTTPS 形式（`https://github.com/owner/repo`）均正确解析出 `{owner, repo}`；非 git 目录/无 origin → `{ok:false}`。
- [ ] `command-match.mjs`：下列**正例**（应判定为 gated）全部命中——`git commit -m x`、`/usr/bin/git commit`、`sh -c "git commit"`、`sudo git push`、`git push --force`、`rm -rf /some/path`；下列**反例**（不应命中）全部不误判——`echo git commit`、`# git commit`、`git log --grep merge -- main`、`git push --force-with-lease`、`rm -r` 不带 `-f`。
- [ ] `brain-lock.mjs`：`authorizeCommit()`→立即 `hasValidCommitAuthorization()` true；`consumeCommitAuthorization()` 消费一次后再调用返回 `{consumed:false, reason:'invalid'}`（或等价语义）；`now` 缺失/NaN → 判无效；未来时间戳超出容差 → 判无效（BUG-7 两条回归）。

### 6.2 四个 hook（对齐 DESIGN §9 spike 步骤5/6，逐个"真的 deny"而非 warn）
- [ ] `brain-commit-gate.mjs`：spawn 真实文件（同 `demo-wake-greeting.mjs:121-125` 的 `execFileSync("node", [HOOK_PATH], {input: stdinJSON, ...})` 技术），无授权时 `git commit` 命令 → stdout JSON 含 `permissionDecision:"deny"`；先跑 `authorize-commit` 再同一 session 发起 → allow（无输出，exit 0）；`AELOOP_BRAIN_SKIP_COMMIT_GATE=1` → 始终 allow。
- [ ] `brain-issue-gate.mjs`：**两态都要测**——① 默认（未设 env 或非 `enforce`）：无绑定 issue 时 Edit/Write 仍 allow；② `AELOOP_BRAIN_ISSUE_GATE=enforce`：无绑定 → deny，`bind-issue` 后 → allow。
- [ ] `brain-red-line-guard.mjs`：`rm -rf <os.tmpdir() 内路径>` → allow；`rm -rf src`（仓库内非白名单路径）→ deny；`git push --force` → deny；`git push --force-with-lease` → allow；Bash 重定向写 `.env` → deny，写 `.env.example` → allow；Edit/Write 工具 `file_path` 命中 `.env` → deny，命中 `.env.example` → allow。
- [ ] `brain-isolation-guard.mjs`：单会话场景 → 无警告注入；模拟第二把新鲜锁存在 → 警告文案出现在 `additionalContext`，但 hook 始终 exit 0（不阻断，回归检查）。

### 6.3 宪法文档（B7）
- [ ] `CLAUDE.md` 存在于 aeloop 根，含身份/人格/铁律三节，末尾指向 `BRAIN.md`（人工/Zorro 读审，非自动化断言）。
- [ ] `git diff docs/conductor-brain-layer/BRAIN.md` 只包含新增行，现有 5 节原文字节级不变。

### 6.4 seed 脚本（B8）
- [ ] 全新身份库首次运行：`CONSTITUTION_CONSTRAINTS` 全部写入为 `confirmed`/`type:"constraint"`；注入假 `fetchOpenIssues()` 返回覆盖 DESIGN §3.c 映射表全部 4 种 label + 无 label 情形，验证 5 种映射结果逐条正确。
- [ ] 二次运行（内容不变）：spy `updateMemoryContent`/`insertMemory` 均**零调用**（真幂等，不是"重跑不报错"这种弱幂等）。
- [ ] 内容变化的重跑：只有变化的那条触发 `updateMemoryContent`，未变的不动。
- [ ] 某 issue 从假数据里消失：对应 memory 被打 `archived` tag，`title`/`content` 不被删除。

### 6.5 env fallback（B9）
- [ ] `AELOOP_BRAIN_IDENTITY_DB` 未设、`.claude/brain.local.json` 存在且合法 → `brain-wake-greeting.mjs` 用该路径正常渲染开场白。
- [ ] 两者都不存在 → hook 保持 #84 既有的"安静跳过"行为（回归检查，不能因为新加了 fallback 分支而意外改变这条既有行为）。
- [ ] `.gitignore` 命中 `.claude/brain.local.json`/`.claude/brain-locks/`（`git check-ignore` 验证）。

### 6.6 诚实边界（DESIGN §5 硬/软划线表在验收层面的体现，**必须写清楚不设的验收项**）
- **不设**"防幻觉输出习惯被硬拦"的验收项——DESIGN §5 已标注这条结构性做不到机制化（模型自然语言输出里是否编造，没有对应 hook），本 PRD 不假装能验证它。
- **不设**"生产者≠审查者被硬拦"的验收项——aeloop 今天没有多角色框架（DESIGN §3.b/§5 已明确不预设），这条只能靠 Cypher→Zorro 的流程约定落实，不是代码级验证对象。
- 这两条的"验收"止于 §6.3 的 `CLAUDE.md`/`BRAIN.md` 文本审查（措辞是否如实写了"这两条是👁不是🔒"），不延伸到任何自动化断言。

---

## 7. Dependencies / Risks / Open Questions

- **风险最高的一批是 B5（`brain-red-line-guard.mjs`）**：DESIGN §1 已核实 Helix 自己都没有这类 hook 的先例，判据（`rm -rf` 白名单、force-push 检测、`.env` 写入检测）全部是本次新设计，没有"照抄已验证代码"这条安全网可用——Zorro 复审这一批时应该把主要精力放在"判据本身有没有漏洞/误伤"，而不是"移植得像不像"（B3/B4/B6 更适合后一种审法）。
- **B8 的可测试性是设计要求不是可选项**：`fetchOpenIssues` 必须可注入，否则测试会依赖真实网络/`gh` CLI 状态，不可复现——这条在 build 阶段如果偷懒直接硬编码 `execFileSync('gh', ...)` 会导致测试脆弱，Zorro 复审时应该专门检查这一点。
- **`command-match.mjs`/`brain-lock.mjs` 是"精简移植"，不是"完整移植"**——§4.1 已经逐条列出裁掉了什么（owner 一致性校验、`withRmwLock` 并发竞态基础设施、Helix 历史修复的全部边界用例）。这是本 PRD 明确接受的裁剪，Zorro 复审时不应该以"和 Helix 版本不完全一样"为由判 FAIL，应该以"§6.1 列出的正反例矩阵是否全部通过"为准。
- **`.env` 检测的已知局限**：只挡 Bash 重定向/`tee`/Edit\|Write 工具三条路径，挡不住模型通过一个自定义脚本间接写 `.env`（DESIGN §5 已标注）——这是设计阶段就承认的局限，不是 build 阶段的 bug。
- **`brain-issue-gate.mjs` 默认关闭这条，`CLAUDE.md`/`BRAIN.md` 措辞必须准确**——如果文档写得像"无 issue 不动手"默认就在生效，会和实际行为脱节，构成本 PRD 自己的"幻觉源头"，B7/B4 两批完成后需要交叉核对措辞（建议 B4 完成后回头检查 B7 产出的 `CLAUDE.md` 那一句话是否准确）。

**Build 阶段 token 成本预期（军师/operator 需要有预期，不是隐藏成本）**：四个 hook 各自都需要 Zorro 独立跑一遍"真的 deny"验证（spawn 真实进程、构造 stdin、断言 stdout/exit code），这是这次 build 里最烧 token 的部分——不是"读代码看看逻辑对不对"就能过，是要真实执行验证。B5（红线判据从零设计）预计需要额外一到两轮返工（白名单/正则边界案例通常第一轮写不全）。

---

## 8. Project Constraint Checklist

- **whoseorder 零侵入 / `/wo-module`？**：N/A——aeloop 不是 whoseorder。
- **跨项目契约（whoseorder↔whosehere）？**：N/A。
- **aeloop 项目内约束**：不碰 `src/context/**`/`src/**` 任何一行（延续 #84 spike 先例，`WAKE-GREETING-RUNBOOK.md` 已有的"项目自身约束"承诺，本次全部新文件落在 `.claude/hooks/`、`scripts/`、`docs/conductor-brain-layer/`、根目录 `CLAUDE.md`）；不引入新 npm 依赖（`command-match.mjs`/`git-remote.mjs`/`brain-lock.mjs` 全部零依赖，同全仓 hook 惯例）。
- **`.mjs` 不在 tsc 覆盖内**（`vitest.config.ts` 的 `include: ["src/**/*.test.ts"]` 已核实不含 `.claude/hooks/**`/`scripts/**`）——保障靠 §6 列出的独立 `assert`/`node:assert/strict` 脚本（同 `docs/conductor-brain-layer/spike/test-*.mjs` 既有约定），不依赖 vitest/tsc 兜底。
- **占位符/假数据残留**：无——所有新文件的 kill-switch/env 变量名均为最终命名（`AELOOP_BRAIN_*` 前缀，对齐既有 `AELOOP_BRAIN_IDENTITY_DB`/`AELOOP_BRAIN_IDENTITY_NAME` 命名惯例）。
