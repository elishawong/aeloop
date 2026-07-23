# Plan — aeloop: conductor-brain turnkey 落地包（issue #88）

> Companion to `PRD.md`。批次定义/依赖关系见 PRD §5，本文件只展开每批具体"怎么做"+ self-check 命令。建议执行顺序（单线程 build）：**B1 → B2 → B9 → B7 → B3 → B4 → B6 → B5 → B8**（B9 提前是因为 B8 依赖它的 `db-path.mjs`；B5 放在四个 hook 最后，避免和其他三个挤同一轮 Zorro 复审；B8 放最后因为依赖最多）。所有批次落在同一分支 `design/issue-88-conductor-brain-turnkey`。

---

## B1 — 共享库：`git-remote.mjs` + `command-match.mjs` [S]

**依赖**：无。

**文件**：
- `.claude/hooks/lib/git-remote.mjs`（新）
- `.claude/hooks/lib/test-git-remote.mjs`（新）
- `.claude/hooks/lib/command-match.mjs`（新）
- `.claude/hooks/lib/test-command-match.mjs`（新）

**Do**：
1. `git-remote.mjs`：移植 `_engine/gh.mjs:147-163`（ai-agent 仓库，只读引用不复制文件）的 `getOriginOwnerRepo(repoPath)` 实现（SSH/HTTPS 双正则，`execFileSync('git',['-C',repoPath,'remote','get-url','origin'],{stdio:['ignore','pipe','ignore']})`，catch → `{ok:false}`）。新增 `resolveToplevel(cwd)`：`execFileSync('git',['-C',cwd,'rev-parse','--show-toplevel'],...)`，catch → `null`。
2. `command-match.mjs`：移植 `_engine/commit-gate-match.mjs` 的命令位置解析方法论（PRD §4.1 已写明范围——跳过 env 赋值/shell 控制前缀 → 取命令词 → `sh -c`/`bash -c` 递归 → 透明包装器递归）。导出 `resolveCommandInvocations(cmdString)`、`matchesGitSubcommand(inv, subcommand)`、`matchesForcePush(inv)`、`matchesRmDashRf(inv)`。
3. 测试（`node:assert/strict`，同 `docs/conductor-brain-layer/spike/test-wake.mjs` 惯例，非 vitest）：
   - `test-git-remote.mjs`：临时目录建假 git repo（`execFileSync('git',['init',...])` + `git remote add origin <url>`），分别测 SSH/HTTPS 两种 URL 形式；非 git 目录 → `{ok:false}`。
   - `test-command-match.mjs`：PRD §6.1 列出的全部正例/反例逐条断言。

**Self-check**：`node .claude/hooks/lib/test-git-remote.mjs && node .claude/hooks/lib/test-command-match.mjs`（各自脚本内部 `assert` 失败即非零退出）。

---

## B2 — 共享库：`brain-lock.mjs` [S]

**依赖**：无（与 B1 无交叉引用）。

**文件**：
- `.claude/hooks/lib/brain-lock.mjs`（新）
- `.claude/hooks/lib/test-brain-lock.mjs`（新）

**Do**：
1. 存储层：`locksDir(toplevel) = path.join(toplevel, '.claude', 'brain-locks')`；`lockPath(toplevel, sessionKey)`；`sessionKey(sessionId, pid)` — 有 `sessionId` 用它（sanitize 掉 `/`），否则用 `pid`。
2. `resolveSessionId()`：`process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.AELOOP_BRAIN_SESSION_ID || null`。
3. `hasValidCommitAuthorization(lock, {now, maxAgeMs=600000})`：精确复刻 `_engine/session-lock.mjs:518-527` 五条判据（PRD §4.1 已列全，含 BUG-7 两条）。
4. `authorizeCommit(toplevel, sessionId, opts)`/`consumeCommitAuthorization(toplevel, sessionId, opts)`：读-改-写（`mkdirSync(dir,{recursive:true})` + `readFileSync`/`writeFileSync`，**不移植** `withRmwLock` 的完整并发竞态基础设施——PRD §4.1 已标注这条裁剪）。
5. `bindIssue(toplevel, sessionId, issueRef)`：正则 `/^[\w.-]+\/[\w.-]+#\d+$/` 校验，不匹配 → `{ok:false, reason:'bad-format'}`；写入 `lock.issue`。
6. `findOwnLock(toplevel, {sessionId, pid})`：读 `lockPath`，不存在 → `null`。
7. CLI（`import.meta.url === \`file://${process.argv[1]}\`` 时跑）：`authorize-commit`（调用 `resolveToplevel(process.cwd())` + `resolveSessionId()` + `authorizeCommit`，打印结果）、`bind-issue --issue=...`、`show`。
8. 测试：`authorizeCommit`→立即校验有效；`consume`一次后再校验 `{consumed:false}`；`now` 缺失/NaN → 无效；未来时间戳超容差 → 无效；`bindIssue` 格式错误 → `{ok:false}`，格式对 → 写入后 `findOwnLock` 读到。

**Self-check**：`node .claude/hooks/lib/test-brain-lock.mjs`。

---

## B9 — env fallback：`db-path.mjs` + `brain-wake-greeting.mjs` 编辑 + runbook 扩写 [S]

**依赖**：无（提前于 B8，因为 B8 需要 `db-path.mjs`）。

**文件**：
- `.claude/hooks/lib/db-path.mjs`（新）
- `.claude/hooks/lib/test-db-path.mjs`（新）
- `.claude/hooks/brain-wake-greeting.mjs`（编辑，#84 既有文件）
- `.claude/brain.local.json.example`（新）
- `.gitignore`（编辑）
- `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`（编辑）

**Do**：
1. `db-path.mjs`：`export function resolveIdentityDbPath({cwd = process.cwd()} = {})`：① `process.env.AELOOP_BRAIN_IDENTITY_DB` 非空 → 直接返回；② 否则读 `path.join(cwd, '.claude', 'brain.local.json')`，`JSON.parse`，取 `.identityDbPath` 字段（读不到/解析失败/字段缺失 → 继续走③，不抛错）；③ 都没有 → `null`。
2. `brain-wake-greeting.mjs`：`const dbPath = process.env.AELOOP_BRAIN_IDENTITY_DB;` 一行改成 `import { resolveIdentityDbPath } from ...; const dbPath = resolveIdentityDbPath();`——**只改这一行 + 新增一行 import**，其余不动（PRD §4.4 已限定改动范围）。
3. `.claude/brain.local.json.example`：`{"identityDbPath": "/absolute/path/to/your/identity.db"}` + 顶部注释行说明复制成 `.claude/brain.local.json`。
4. `.gitignore` 追加两行：`.claude/brain.local.json`、`.claude/brain-locks/`。
5. `WAKE-GREETING-RUNBOOK.md` 追加三节（PRD §4.3 已给内容方向）："shell profile 正确姿势"、"IDE 启动读不到 env 的坑"（`launchctl setenv` + `.claude/brain.local.json` 两条修法）、"排查清单"。
6. 测试（`test-db-path.mjs`）：env 设了 → 优先用 env（即便本地 json 也存在，env 优先）；env 未设 + 本地 json 存在合法 → 用 json 值；两者都无 → `null`；本地 json 是坏 JSON → 不抛错，返回 `null`。

**Self-check**：`node .claude/hooks/lib/test-db-path.mjs`；`git check-ignore .claude/brain.local.json .claude/brain-locks/anything.json`（两条都应命中）；手动跑一次 `AELOOP_BRAIN_IDENTITY_DB= node docs/conductor-brain-layer/spike/demo-wake-greeting.mjs` 确认 #84 既有"安静跳过"行为在改动后依然成立（回归）。

---

## B7 — 宪法文档：`CLAUDE.md` + `BRAIN.md` 扩写 [S]

**依赖**：无。

**文件**：
- `CLAUDE.md`（新，aeloop 根）
- `docs/conductor-brain-layer/BRAIN.md`（编辑）

**Do**：
1. `BRAIN.md` 在现有"我是谁"和"醒来协议"之间插入 §1.5（人格：直接精准/有主见/不奉承，明确不写 Helix 的生存使命/双档位/companion）+ §1.6（铁律，🔒/👁 两档，**issue-gate 那条必须写"默认不生效，`enforce` 才生效"**——不能等 B4 做完才补这句话，这里第一次写就要写对）。§4"身份库记录约定"表格追加 constraint 那一行（PRD §4.3 已给精确内容）。
2. `CLAUDE.md`：`BRAIN.md` §1+§1.5+§1.6 的精简版，面向模型的行为指令措辞（不是设计论证），结尾指向 `BRAIN.md`。
3. **B4 完成后必须回头核对**（PRD §7 风险已标注）：`CLAUDE.md` 里"无 issue 不动手"那句话的措辞是否和 `brain-issue-gate.mjs` 实际的默认档位行为一致。

**Self-check**：`git diff docs/conductor-brain-layer/BRAIN.md` 人工核对现有 5 节零改动，只有新增；`CLAUDE.md` 人工读一遍确认三点齐全（身份/人格/铁律）且未包含"不写"清单里的三样。

---

## B3 — `brain-commit-gate.mjs` [S]

**依赖**：B1、B2。

**文件**：
- `.claude/hooks/brain-commit-gate.mjs`（新）
- `.claude/hooks/test-brain-commit-gate.mjs`（新）
- `.claude/settings.json`（编辑，追加 1 条 `PreToolUse`/`Bash`）

**Do**：
1. 逐条移植 `session-commit-gate.mjs:136-199` 的判定顺序（PRD §4.2 已列全）：kill-switch → 读 stdin → 非 Bash → 非 gated 命令（`command-match.mjs`）→ 非本仓库（`git-remote.mjs`）→ `brain-lock.mjs` 消费令牌 → allow/deny。deny 输出 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`。
2. `.claude/settings.json` 的 `hooks.PreToolUse` 数组追加一个 `{matcher:"Bash", hooks:[{type:"command", command:"node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/brain-commit-gate.mjs\""}]}` 条目（同现有条目风格，独立一条不合并进已有 Bash 条目，同 Helix 的做法：多个 hook 可以共享同一个 matcher 各自独立条目）。
3. 测试（PRD §6.2 已给全部场景）：用 `execFileSync("node", [HOOK_PATH], {input: JSON.stringify(stdinPayload), encoding:"utf8"})`（同 `demo-wake-greeting.mjs:121-125` 的真实 spawn 技术）逐条验证。

**Self-check**：`node .claude/hooks/test-brain-commit-gate.mjs`。

---

## B4 — `brain-issue-gate.mjs` [S]

**依赖**：B2（不需要 B1）。

**文件**：
- `.claude/hooks/brain-issue-gate.mjs`（新）
- `.claude/hooks/test-brain-issue-gate.mjs`（新）
- `.claude/settings.json`（编辑，追加 1 条 `PreToolUse`/`Edit|Write`）

**Do**：
1. **判定链第一条**：`process.env.AELOOP_BRAIN_ISSUE_GATE !== 'enforce'` → allow（不看任何其他条件，DESIGN §3.b/§7 operator 决议，这是和 Helix 原版最大的行为差异，必须在最前面）。
2. `enforce` 模式下才继续：kill-switch → 非 Edit/Write → 非 git 目录 → `brain-lock.mjs` 的 `findOwnLock` 无合法 issue → deny（提示 `bind-issue` 命令）；有 → allow。
3. `.claude/settings.json` 追加 `{matcher:"Edit|Write", hooks:[{type:"command", command:"node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/brain-issue-gate.mjs\""}]}`。
4. 测试：默认档（不设 env）+ 无绑定 issue → allow；`enforce` + 无绑定 → deny；`enforce` + `bind-issue` 后 → allow；`AELOOP_BRAIN_SKIP_ISSUE_GATE=1`（`enforce` 模式下）→ allow。

**Self-check**：`node .claude/hooks/test-brain-issue-gate.mjs`。

---

## B6 — `brain-isolation-guard.mjs` [S]

**依赖**：B2（读 `brain-lock.mjs` 的心跳字段）。

**文件**：
- `.claude/hooks/brain-isolation-guard.mjs`（新）
- `.claude/hooks/test-brain-isolation-guard.mjs`（新）
- `.claude/settings.json`（编辑，`SessionStart` 现有 `startup|resume|clear` matcher 下追加一条 hook 命令，同 `brain-wake-greeting.mjs` 挂在同一个 matcher）

**Do**：
1. 结构性移植 `session-isolation-guard.mjs`：本 worktree 内扫描 `.claude/brain-locks/*.json`，判定"新鲜"（心跳时间戳在阈值内，如 5 分钟）且不是自己这把锁的 → 拼一段警告文案，`additionalContext` 注入；始终 `process.exitCode = 0`。
2. `.claude/settings.json` 的 `SessionStart` matcher `"startup|resume|clear"` 的 `hooks` 数组追加一条命令（和现有 `brain-wake-greeting.mjs` 那条同级并列，不新建 matcher 条目）。
3. 测试：单会话（无其他锁）→ 无警告文本；构造第二把新鲜锁 → 警告文本出现在 `additionalContext`；无论哪种情况 exit code 恒 0。

**Self-check**：`node .claude/hooks/test-brain-isolation-guard.mjs`。

---

## B5 — `brain-red-line-guard.mjs`（⚠️ 从零设计，最需要 Zorro 重点盯）[M]

**依赖**：B1（命令解析）。

**文件**：
- `.claude/hooks/brain-red-line-guard.mjs`（新）
- `.claude/hooks/test-brain-red-line-guard.mjs`（新）
- `.claude/settings.json`（编辑，追加 2 条：`PreToolUse`/`Bash` + `PreToolUse`/`Edit|Write`，同一个 `command` 指向同一个文件）

**Do**：
1. Bash 分支（`input.tool_name === "Bash"`）：
   - `command-match.mjs` 的 `matchesRmDashRf(inv)` 命中 → 取该调用里所有非 flag 参数，逐个 `path.resolve(cwd, arg)`，若**任一**不在白名单前缀（Phase1 仅 `os.tmpdir()`）内 → deny。
   - `matchesForcePush(inv)` 命中 → deny。
   - 命令含 `>`/`>>` 重定向或 `tee` 且目标 basename 匹配 `/^\.env(\..+)?$/` 且不在 `['.env.example','.env.sample','.env.template']` → deny。
2. Edit/Write 分支（`input.tool_name` 是 `Edit`/`Write`）：`input.tool_input.file_path` 的 basename 同上规则 → deny。
3. 两分支都 fail-open：判不出/不命中/异常 → allow。kill-switch `AELOOP_BRAIN_SKIP_REDLINE_GUARD=1`。
4. 文件头注释写清楚已知局限（PRD §4.2/§7 已列：命令混淆绕不过、`.env` 只挡三条路径）。
5. `.claude/settings.json` 追加两条 hook 注册（各自独立 matcher 条目）。
6. 测试（PRD §6.2 全部场景）：`rm -rf <tmpdir 内>` allow；`rm -rf src` deny；`git push --force` deny；`git push --force-with-lease` allow；Bash 写 `.env`/`.env.example` 各自 deny/allow；Edit/Write 写 `.env`/`.env.example` 各自 deny/allow。

**Self-check**：`node .claude/hooks/test-brain-red-line-guard.mjs`。**这一批建议单独跑一轮 Zorro 复审**（不与 B3/B4/B6 合并送审），因为判据本身是新设计，需要更多注意力核对边界/误伤，而不是核对"移植得对不对"。

---

## B8 — `scripts/seed-brain-identity.mjs` [M]

**依赖**：B7（constraint 内容需 `BRAIN.md` §1.6 定稿）、B9（`db-path.mjs`）。

**文件**：
- `scripts/seed-brain-identity.mjs`（新）
- `scripts/test-seed-brain-identity.mjs`（新）

**Do**：
1. `CONSTITUTION_CONSTRAINTS`：从 `BRAIN.md` §1.6 手动誊写（PRD §4.4 已标注两者会漂移，这是接受的代价，脚本头注释写清楚）。
2. `async function main({ fetchOpenIssues = defaultFetchOpenIssues } = {})`：① `resolveIdentityDbPath()`（复用 B9 的 `db-path.mjs`）无结果 → 打印提示退出；② 打开 `MemoryStore`；③ upsert constraint（按 `title` 匹配，内容变化才 `updateMemoryContent`）；④ `const {owner, repo} = getOriginOwnerRepo(process.cwd())`；⑤ `const issues = await fetchOpenIssues({owner, repo})`；⑥ 按 DESIGN §3.c 映射表转换 + 按 `gh-issue:<n>` tag upsert；⑦ 库里有 tag 但这次未出现在 `issues` 里的 → 补 `archived` tag。
3. `defaultFetchOpenIssues({owner, repo})`：真实 `execFileSync('gh', ['issue','list','--repo',`${owner}/${repo}`,'--state','open','--json','number,title,labels'])` + `JSON.parse`。
4. 测试：注入假 `fetchOpenIssues`，覆盖 DESIGN §3.c 全部 5 种映射；二次运行零调用验证（spy `store.updateMemoryContent`/`insertMemory` 调用次数）；issue 消失 → `archived` tag。

**Self-check**：`node scripts/test-seed-brain-identity.mjs`；真实环境手动跑一次 `node scripts/seed-brain-identity.mjs`（需要真实 `AELOOP_BRAIN_IDENTITY_DB` + `gh` 已登录）确认端到端可用，输出结果人工过一眼。

---

## Definition of Done（全部批次）

- PRD §6 全部 acceptance criteria 打勾。
- 每个 `.claude/hooks/test-*.mjs`/`scripts/test-*.mjs` 独立运行全绿。
- `pnpm build && pnpm test`（现有 `src/**` 测试套件）保持全绿——本次改动不触碰 `src/**`，这是回归项不是新增项。
- `.claude/settings.json` 最终态含 4 个新 hook 注册（3 PreToolUse deny 类 matcher 条目 + 1 SessionStart），`git diff` 人工核对未误删任何既有条目。
- `progress.md`/`impact.md` 按 Helix 基础工作流写完，再交 Zorro。
