---
feature: conductor-brain-turnkey
status: in_progress   # not_started / in_progress / blocked / done
last_updated: 2026-07-23
---

# Progress — conductor-brain turnkey 落地包（issue #88）

> 边写边更。每批做完追加一条：做了什么 + 本地自检结果（`node .claude/hooks/test-*.mjs` 等）+ 可追源的证据。**改完即写回。**

> **▶ 下一步（RESUME 指针）**：全部 9 个批次 + Zorro Pass1/2 FAIL 修复轮 + Zorro/Codex B5 两轮复验 FAIL 修复轮均已完成并已 commit（`4e0e005`）。**2026-07-23 operator 拍板追加"成本透明"人格条款**（👁，见下方独立记录）——已同步进 `BRAIN.md` §1.6 + `CLAUDE.md` + `scripts/seed-brain-identity.mjs` 的 `CONSTITUTION_CONSTRAINTS`（6→7 条），self-check 全绿。**未 commit**（本轮改动，operator 说了攒着一起走门，不是本次单独提交）。

- **关联 PRD / Plan**：`./PRD.md` · `./plan.md`
- **方案权威**：`docs/conductor-brain-layer/TURNKEY-DESIGN.md`（operator 已确认）

## 批次进度

### B1 — 共享库：`git-remote.mjs` + `command-match.mjs`
- 状态：完成
- 做了什么：新建 `.claude/hooks/lib/git-remote.mjs`（精确移植 `_engine/gh.mjs:147-163` 的 `getOriginOwnerRepo` + 新增 `resolveToplevel`/导出 `OWNER_REPO_SEGMENT`）+ `.claude/hooks/lib/command-match.mjs`（移植 `_engine/commit-gate-match.mjs` 的 token 化命令位置解析方法论：`tokenizeSegments`/`resolveCommandInvocations` 结构逐条对齐源文件，新增整合入口 `resolveInvocationsFromCommand` + 业务判据 `matchesGitSubcommand`/`matchesForcePush`/`matchesRmDashRf`）。
- 改了哪些文件：`.claude/hooks/lib/git-remote.mjs`（新）、`.claude/hooks/lib/test-git-remote.mjs`（新）、`.claude/hooks/lib/command-match.mjs`（新）、`.claude/hooks/lib/test-command-match.mjs`（新）。
- 本地自检：`node .claude/hooks/lib/test-git-remote.mjs` PASS（SSH/HTTPS 解析 + 非 git 目录 fail-open + OWNER_REPO_SEGMENT）；`node .claude/hooks/lib/test-command-match.mjs` PASS（正例/反例矩阵 + force-push + rm-rf + overdepth fail-closed 回归）。
- 备注 / 与 plan.md 假设不符之处（已在文件头注释标出，不是凭印象硬套）：① `resolveCommandInvocations` 的真实源签名是"接收单个命令段的 token 数组"，不是 plan.md 写的 `(cmdString)`——已按源文件真实签名移植，另加 `resolveInvocationsFromCommand(cmd: string)` 作为 hook 实际需要的字符串级整合入口。② `matchesGitSubcommand`/`matchesForcePush`/`matchesRmDashRf` 改成接收原始命令字符串（而非单个 `inv`），因为一条命令可能含多个 `;`/`&&` 分隔的 invocation，单 invocation 签名不便 hook 直接用。③ 本文件**不含** gh-pr-merge / git-merge-main 检测（`GH_FLAGS_WITH_SEPARATE_VALUE`/`isGhPrMergeInv`/`isGitMergeMainInv` 未移植）——plan.md §B1 的 Do 清单本身只列了 4 个导出，但 PRD §4.2 描述 B3 `brain-commit-gate.mjs` 的判据里提到过 gh pr merge，这是一个需要 B3 落地时回头处理的衔接缺口，未替 B3 拍板。

### B2 — 共享库：`brain-lock.mjs`
- 状态：完成
- 做了什么：新建 `.claude/hooks/lib/brain-lock.mjs`（精简版一次性授权令牌 + issue 绑定）：`hasValidCommitAuthorization` 精确复刻 `_engine/session-lock.mjs:518-527` 五条判据（含 BUG-7 两条：缺/坏 now 判无效、未来时间戳超容差判无效）；`authorizeCommit`/`consumeCommitAuthorization`/`bindIssue`/`findOwnLock` + CLI（`authorize-commit`/`bind-issue --issue=`/`show`）。
- 改了哪些文件：`.claude/hooks/lib/brain-lock.mjs`（新）、`.claude/hooks/lib/test-brain-lock.mjs`（新）。
- 本地自检：`node .claude/hooks/lib/test-brain-lock.mjs` PASS（五条时效判据 + 一次性令牌往返 + bindIssue 格式校验/findOwnLock 身份判定）；额外手动跑通 CLI 三个子命令（`authorize-commit`→`show`→`bind-issue`）端到端确认。
- 备注 / 与 plan.md 假设不符之处：**明确裁剪**（DESIGN §3.b 已预先声明方向，本批落实，不是擅自决定）——不移植 `withRmwLock`/`file-lock.mjs` 的完整并发竞态基础设施（用简单读-改-写代替，Phase1 单会话场景规模不对等，已知局限写在文件头）；不移植 `classifyLock`/`detectActiveSessions`（那是 B6 的职责）；不移植 `verifyIssueOwnerMatchesRepo`（`bindIssue` 只做格式校验，不做 owner 一致性校验）。这些都是 PRD/plan 已经写明的裁剪，不是本批新发现的偏差。

### B9 — env fallback：`db-path.mjs` + `brain-wake-greeting.mjs` 编辑 + runbook 扩写
- 状态：完成
- 做了什么：新建 `.claude/hooks/lib/db-path.mjs`（`resolveIdentityDbPath()`：env 优先 → `.claude/brain.local.json` fallback → null，不抛错）；编辑 `.claude/hooks/brain-wake-greeting.mjs`（唯一逻辑改动：`process.env.AELOOP_BRAIN_IDENTITY_DB` 直读 → `resolveIdentityDbPath()`，加一行 import + 一行调用，其余未动）；新建 `.claude/brain.local.json.example`；`.gitignore` 追加 `.claude/brain.local.json`/`.claude/brain-locks/`；`WAKE-GREETING-RUNBOOK.md` 新增"shell profile 正确姿势"/"IDE 启动读不到 env 的坑"/"排查清单"三节。
- 改了哪些文件：`.claude/hooks/lib/db-path.mjs`（新）、`.claude/hooks/lib/test-db-path.mjs`（新）、`.claude/hooks/brain-wake-greeting.mjs`（改，2 行）、`.claude/brain.local.json.example`（新）、`.gitignore`（改，追加 2 行）、`docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`（改，新增 3 节）。
- 本地自检：`node .claude/hooks/lib/test-db-path.mjs` PASS（env 优先 + fallback + 坏 JSON 不抛错 + 字段缺失当未配置）；`git check-ignore .claude/brain.local.json .claude/brain-locks/x.json` 两条都命中；**回归验证** #84 既有"env 未设→安静跳过"行为：`pnpm install && pnpm run build`（本 worktree 是全新 worktree，无 node_modules/dist，先补齐）后，① 真实 spawn `brain-wake-greeting.mjs`（无 env、无本地 json）→ stdout 为空、exit 0，quiet-skip 未被破坏；② 真实 spawn `docs/conductor-brain-layer/spike/demo-wake-greeting.mjs`（env 设置为它自己的临时库）端到端仍 PASS（一致性自检 `===` 通过）；③ 额外验证 fallback 正路径：造一个临时身份库 + `.claude/brain.local.json` 指向它、不设 env，真实 spawn hook 得到正确渲染的开场白（"我是 Fallback Test Brain"），证明 fallback 不只是单元测试层面对，集成链路也真的通。回归 + fallback 两条链路都是**真实 spawn 进程**验证，不是绕开 hook 直接调函数。
- 备注 / 与 plan.md 假设不符之处：`brain-wake-greeting.mjs` 头部的"配置"说明小节仍写着 `AELOOP_BRAIN_IDENTITY_DB`"必需"，与新增的 fallback 行为不完全一致——Pass 1 汇报时已如实标出留给后续收尾；**Pass 2 已顺手处理**（operator 指令明确要求），改成准确描述"env 优先 / `.claude/brain.local.json` fallback 二选一，两者都没有才安静跳过"，见下方"Pass 2 衔接项"记录。

### Pass 2 衔接项（operator 指令，顺带处理 Pass 1 标出的两个缺口）
- **gh-pr-merge / git-merge-main 缺口**：补在 `.claude/hooks/lib/command-match.mjs`（不是内联进 B3 hook）——新增 `matchesGhPrMerge`/`matchesGitMergeMain` + 依赖的 `firstSubcommandWithIndex`/`GH_FLAGS_WITH_SEPARATE_VALUE`/`mainWordPattern`，逐条对齐源文件 `_engine/commit-gate-match.mjs` 对应部分。理由（判断哪层干净）：这两个判据本质上和已有的 `matchesForcePush`/`matchesRmDashRf` 是同一类"基于命令位置的业务判据"，属于命令解析层职责，不是 hook 的业务逻辑；补在共享库里，未来 B5（`brain-red-line-guard.mjs`）如果也需要类似判据可以直接复用，不会出现同一段命令解析逻辑在多个 hook 文件里各写一份。`test-command-match.mjs` 补了对应正反例（`gh pr merge`/`gh pr --repo x merge`/字面量 merge 误判防护/`git merge origin\|refs/heads/main`/`git log --grep merge` 防误判）。
- **`brain-wake-greeting.mjs` 头注释缺口**：已改成准确描述 env/fallback 二选一关系，不再写"必需"。

### B7 — 宪法文档：`CLAUDE.md` + `BRAIN.md` 扩写
- 状态：完成
- 做了什么：新建根 `CLAUDE.md`（精简的、面向模型的行为指令：我是谁/人格/铁律/醒来/项目隔离，结尾指向 `BRAIN.md`）；`BRAIN.md` 插入 §1.5（人格）/§1.6（铁律，🔒/👁 两档）于"我是谁"和"醒来协议"之间，§4 表格追加"宪法约束（铁律）"一行。**issue-gate 那条铁律的措辞**（`CLAUDE.md` 和 `BRAIN.md` §1.6 两处）：`.claude/hooks/brain-issue-gate.mjs` 默认档位（未设 `AELOOP_BRAIN_ISSUE_GATE=enforce`）恒放行，不检查任何 issue 绑定；只有显式 `enforce` 才真的要求先绑 issue——第一次写就写对，B4 完成后已回头核对一致（见下方 B4 记录）。
- 改了哪些文件：`CLAUDE.md`（新，aeloop 根）、`docs/conductor-brain-layer/BRAIN.md`（改，只新增，`git diff` 已核对现有 5 节原文零改动）。
- 本地自检：人工读审（`git diff docs/conductor-brain-layer/BRAIN.md` 只有新增行；`CLAUDE.md` 三点齐全且未包含"不写"清单里的三样）——文档类改动本身没有自动化断言，跨批交叉核对见下方 B4 记录。

### B3 — `brain-commit-gate.mjs`
- 状态：完成
- 做了什么：逐条移植 `session-commit-gate.mjs:136-199` 判定顺序（kill-switch → 读 stdin → 非 Bash → 非 gated 模式 → 目标非本仓库 → 消费令牌），gated 模式覆盖完整四种（`git commit`/`git push`/`gh pr merge`/`git merge...main`，衔接了 Pass 1 标出的 gh-pr-merge 缺口，见上方"Pass 2 衔接项"）。
- 改了哪些文件：`.claude/hooks/brain-commit-gate.mjs`（新）、`.claude/hooks/test-brain-commit-gate.mjs`（新）、`.claude/settings.json`（改，追加 `PreToolUse`/`Bash` 一条）。
- 本地自检：`node .claude/hooks/test-brain-commit-gate.mjs` PASS——**真实 spawn 进程**验证（同 `demo-wake-greeting.mjs` 技术，不是读代码看逻辑）9 个场景：非 Bash→allow；非 gated 命令→allow；`git commit` 无授权→**deny**（真实核对 `permissionDecision:"deny"` JSON）；先 `authorizeCommit()` 再 commit→allow，同一令牌第二次用→**deny**（一次性、不滚动）；`git push --force` 无授权→deny；`gh pr merge` 无授权→deny；`git merge origin/main` 无授权→deny；非本仓库（`/tmp`）→allow（fail-open）；kill-switch→allow。
- 备注 / 与 plan.md 不符之处：无新发现（判定顺序、fail-open 边界均按 plan.md/PRD 描述落地）。

### B4 — `brain-issue-gate.mjs`
- 状态：完成
- 做了什么：判定链**第一条**就是档位开关（`process.env.AELOOP_BRAIN_ISSUE_GATE !== "enforce"` → 恒 allow，不看任何其它条件），`enforce` 模式下才走 kill-switch/非 Edit\|Write/非 git 目录/`findOwnLock` 判定——不移植 Helix 的 `HELIX_ROLE` 白名单（aeloop 无角色框架，用档位开关取代）。
- 改了哪些文件：`.claude/hooks/brain-issue-gate.mjs`（新）、`.claude/hooks/test-brain-issue-gate.mjs`（新）、`.claude/settings.json`（改，追加 `PreToolUse`/`Edit|Write` 一条）。
- 本地自检：`node .claude/hooks/test-brain-issue-gate.mjs` PASS——**真实 spawn** 6 个场景：默认档 + 无绑定→**allow**；env 设了但不是 "enforce"（如误写 "true"）→仍 allow（防"哪怕设了 env 但值不对"这类边界误判）；`enforce` + 无绑定→**deny**；`enforce` + `bindIssue()` 后→allow；`enforce` + kill-switch→allow；`enforce` + 非 Edit/Write→allow。两态（默认/enforce）都覆盖，符合硬要求。
- **B7 措辞交叉核对**（plan.md §B7 第3条要求）：回头核对 `CLAUDE.md`/`BRAIN.md` §1.6 里"无 issue 不动手"那句话——两处写的都是"默认档位（未设 `AELOOP_BRAIN_ISSUE_GATE=enforce`）恒放行"，与 `brain-issue-gate.mjs` 实际判定链第一条`process.env.AELOOP_BRAIN_ISSUE_GATE !== "enforce"` 完全一致，**核对通过，无需改**。

### B6 — `brain-isolation-guard.mjs`
- 状态：完成
- 做了什么：SessionStart 告警 hook，warn-only（正确延续 Helix 现有语义，不夸大成 deny，同 Pass 1 §1 已纠正的分类）：刷新自己心跳（`brain-lock.mjs` 新增的 `touchHeartbeat`）→ 扫本 worktree 全部锁（`listAllLocks`，同样是本批新增）→ 有"新鲜"（5 分钟内）且不是自己的锁 → `additionalContext` 警告；始终 `exitCode = 0`。
- 改了哪些文件：`.claude/hooks/brain-isolation-guard.mjs`（新）、`.claude/hooks/test-brain-isolation-guard.mjs`（新）、`.claude/hooks/lib/brain-lock.mjs`（改，新增 `touchHeartbeat`/`listAllLocks` 两个导出）、`.claude/hooks/lib/test-brain-lock.mjs`（改，补对应测试）、`.claude/settings.json`（改，`SessionStart` 现有 matcher 下追加一条，和 `brain-wake-greeting.mjs` 同级并列）。
- 本地自检：`node .claude/hooks/test-brain-isolation-guard.mjs` PASS——**真实 spawn** 4 个场景：单会话（无其它锁）→无警告、exit 0；构造一把新鲜的别人的锁→**警告文本出现在 additionalContext**、仍 exit 0；别人的锁心跳已过期（10 分钟前，超过 5 分钟阈值）→不告警；kill-switch→无输出。`node .claude/hooks/lib/test-brain-lock.mjs` 重跑仍 PASS（新增的 `touchHeartbeat`/`listAllLocks` 未破坏既有测试）。
- **诚实标注一个真实局限**（已写进 `brain-lock.mjs`/`brain-isolation-guard.mjs` 头注释，不是隐藏）：本包没有移植 Helix 的 `session-heartbeat.mjs`（持续在 `UserPromptSubmit`/`Stop`/每次 `PreToolUse` 续期心跳）——PRD/plan 的文件列表本身就没有列出这个文件，只在 SessionStart 那一刻 touch 一次心跳。这意味着检测能力弱于 Helix 版本：主要覆盖"两个会话几乎同时启动"的情形，对"A 早就开着、B 才启动"这种更常见的隔离场景，A 的心跳可能早已"过期"而不会被 B 判成活会话。这是 Pass 2 范围内的真实局限，不是新引入的 bug——补齐需要新增一个持续心跳 hook，不在本次批次范围。

### B5 — `brain-red-line-guard.mjs`（⚠️ 从零设计，最需要 Zorro 重点盯）
- 状态：完成（自测全绿，等 Zorro 独立重点复审判据本身）
- **判据设计（rm-rf 白名单逃逸怎么防，Zorro 明确要求想清楚）**：
  1. `path.resolve(cwd, arg)` 做词法归一化——已经处理了字面量 `..`（`/tmp/../etc` → `/etc`）。
  2. **符号链接**：`path.resolve` 不跟踪符号链接，纯字符串前缀匹配挡不住"白名单目录内放一个指向白名单外的软链接"这种绕过。用 `realpathSync` 解析真实物理路径；目标可能尚不存在（`rm -rf` 对不存在路径合法，幂等清理脚本常见），逐级向上找最近一个**真实存在**的祖先目录做 realpath，再把不存在的那段原样拼回去（找不到任何存在祖先时退化用词法路径，无害——全树不存在删不出东西）。
  3. **白名单前缀本身也做同样的 realpath 归一化**——已用真实 `mkdtempSync`+`realpathSync` 核实：macOS 上 `os.tmpdir()`（`/var/folders/...`）本身就是指向 `/private/var/folders/...` 的符号链接；如果只 realpath 目标、不 realpath 白名单前缀，会把所有合法 tmpdir 操作误判成"不在白名单"（方向安全但错误）。两侧统一坐标系后才比对前缀。
  4. **白名单范围**：Phase1 严格只有 `os.tmpdir()` 一项，未自作主张加别的目录（如 `out/` 之类）——过窄比过宽安全，红线宁可误伤不可放过。
  5. `.env` 判据（`isProtectedEnvBasename`/`matchesEnvWrite`，加进 `command-match.mjs`，纯新增不改动已 Zorro PASS 的既有函数）：basename 匹配 `.env`/`.env.*`，排除 `.env.example`/`.env.sample`/`.env.template`；Bash 侧扫 `>`/`>>` 重定向目标 + `tee` 参数，Edit/Write 侧直接判 `file_path` basename——两条路径共用同一份 `isProtectedEnvBasename`，不会"Bash 挡了、Edit/Write 没挡"。
  6. force-push：直接复用 B1 已有的 `matchesForcePush`，零新逻辑。
- 改了哪些文件：`.claude/hooks/brain-red-line-guard.mjs`（新）、`.claude/hooks/test-brain-red-line-guard.mjs`（新，17 个真 spawn 场景）、`.claude/hooks/lib/command-match.mjs`（改，新增 `isProtectedEnvBasename`/`matchesEnvWrite` 两个纯新增导出，不改动任何已有函数——B1 既有 6 个导出零改动，重跑 `test-command-match.mjs` 确认无回归）、`.claude/hooks/lib/test-command-match.mjs`（改，补新增两个函数的单测）、`.claude/settings.json`（改，追加 2 条：`PreToolUse`/`Bash` + `PreToolUse`/`Edit|Write`，同一 command 指向 `brain-red-line-guard.mjs`）、`docs/conductor-brain-layer/BRAIN.md`/`CLAUDE.md`（改，red-line 那条措辞从"一律拒绝"/"真拦截"改成准确描述"养成习惯的软门，不是防攻击的安全边界"，附已知局限要点，对齐 Zorro 上一轮对 commit-gate 措辞的同款要求）。
- **本地自检（真实 spawn，PRD §6.2 全场景 + Zorro 明确要求的符号链接逃逸验证）**：`node .claude/hooks/test-brain-red-line-guard.mjs` PASS，17 个场景：① tmpdir 内真实存在目标→**allow**；② tmpdir 内尚不存在目标（逐级向上找祖先）→**allow**；③ `rm -rf src`（仓库内，非白名单）→**deny**；④ `rm -rf /tmp/../etc`（字面量 `..` 逃逸）→**deny**；⑤ 相对路径 `../../../etc` 逃出 tmpdir →**deny**；⑥【核心】tmpdir 内符号链接指向 tmpdir 外真实目录（REPO_ROOT）→**deny**（realpath 解析后识别逃逸）；⑦ 反例：tmpdir 内符号链接指向 tmpdir 内→**allow**（确认没有误伤合法用法）；⑧ `git push --force`→deny；⑨ `git push --force-with-lease`→allow；⑩ Bash 写 `.env`→deny；⑪ Bash 写 `.env.example`→allow；⑫ Edit 写 `.env`→deny；⑬ Write 写 `.env.example`→allow；⑭ 非 Bash/Edit/Write 工具→allow（fail-open）；⑮ 无关命令→allow；⑯ 缺 command 字段→allow（fail-open）；⑰ kill-switch→恒 allow。`node .claude/hooks/lib/test-command-match.mjs`（含新增 `isProtectedEnvBasename`/`matchesEnvWrite` 单测）+ 全部既有 7 个 test-*.mjs 重跑绿；`pnpm run build` + 619 个既有 vitest 测试绿；`src/**` 零改动（`git diff --stat -- src/` 确认）。
- **头注释披露的已知局限**（如实标注，未过度声称）：① 命令混淆（变量拼接/`eval`/`$()` 子 shell）绕得过；② `.env` 保护只挡 Bash 重定向/`tee`/Edit\|Write 三条路径，挡不住"写一个不叫这个名字的脚本、脚本内部再写 `.env`"这种间接写；③ `.env` 重定向检测本身还有一条更窄的缝——操作符和前一个词**没有任何空白粘连**的写法（`cmd>.env`）不会被识别（改这条要触及 B1 已 Zorro PASS 的 `tokenizeSegments` 核心解析器，本批不动它）；④ cwd 相关局限同 `brain-commit-gate.mjs`——rm-rf 白名单判定用的是 hook 收到的静态 `input.cwd`，不跟踪命令执行时动态 `cd` 造成的 cwd 变化。
- **BRAIN.md 措辞改了**：`BRAIN.md` §1.6 + `CLAUDE.md` 的 red-line 那条，均从"一律拒绝"/"真拦截"改成"这是养成习惯的软门，不是防攻击的安全边界"+ 具体列出命令混淆/`.env` 间接写两条局限，措辞与 hook 头注释、`TURNKEY-DESIGN.md` 保持一致。

### B8 — `scripts/seed-brain-identity.mjs`
- 状态：完成（自测全绿 + 真实端到端验证过，等 Zorro 复审）
- **做了什么**：新建 `scripts/seed-brain-identity.mjs`，把去品牌宪法（身份 + `BRAIN.md` §1.6 的 6 条铁律）+ 当前真实 GitHub issue 在途状态，种进 aeloop 身份 `MemoryStore`（dbPath 经 `db-path.mjs` 的 `resolveIdentityDbPath()` 解析，和 `brain-wake-greeting.mjs` 读的是同一个库）。三类数据：① `type:"identity", title:"identity:name"` 一条（内容"你的 AI 调度员"）；② `CONSTITUTION_CONSTRAINTS` 常量数组，6 条 `type:"constraint"`（4 🔒+2 👁，逐条誊写自 `BRAIN.md` §1.6，标注了和源文档会漂移这条已知代价）；③ 从 `fetchOpenIssues`（可注入，默认真跑 `gh issue list --state all --json number,title,labels,state --limit 1000`）读出的每个 issue，映射成 `type:"active_task"`。
- **status→active_task 映射**（DESIGN §3.c 映射表 + 本轮新增的 closed 直判）：`status:awaiting-commander→status:pending-decision`、`status:awaiting-zorro→status:blocked`、`status:in-progress`/`status:prd-draft→status:in-progress`、无 label→`status:todo`；**`state==="CLOSED"` 直接判定 `["status:done","archived"]`**（不是靠"这次没出现在 open 列表里"推断——比 plan.md 原始设计更直接，读 issue 自己的 state 字段）。**一个 issue 同时挂多个 `status:*` label 时**（真实数据会发生，本仓库 issue #88 自己就同时挂着 `status:prd-draft`+`status:in-progress`）：按优先级取最新阶段那个（`awaiting-commander > awaiting-zorro > in-progress > prd-draft`），这是本文件的具体判断，不是照抄哪份已有文档，已在代码注释里如实标注。
- **幂等 upsert 的一处真实设计修正（超出 plan.md 原始描述，属于写码时发现的正确性问题）**：`MemoryStore` 没有 `updateMemoryTags()`/改 `title` 的方法（只有 `updateMemoryContent`/`updateMemoryConfidence`），tags 或 title 变化只能删除重建；**active_task 的匹配键改成按稳定的 `gh-issue:<n>` tag 匹配，不按 `title` 匹配**——如果按 title 匹配，issue 改标题（常见操作）会导致旧记录变孤儿、插入一条重复的新记录；`identity`/`constraint` 两类因为 `title` 是本文件自己硬编码的固定字符串（不会像 issue 标题那样外部变化），按 title 匹配仍然安全。这个区分在 `findExisting()` 的头注释里写清楚了。
- **绝不碰密钥**：脚本不读取/不写入任何 API key、`profiles/apikey/`（已 gitignore 的 company overlay）内容——只种身份名/宪法文本/issue 标题与状态；`grep` 确认全文件唯一出现"API key"字样的地方是头注释自己声明"不碰"这句话本身。
- **改了哪些文件**：`scripts/seed-brain-identity.mjs`（新）、`scripts/test-seed-brain-identity.mjs`（新）。复用现有 `MemoryStore` API（`insertMemory`/`listMemories`/`updateMemoryContent`/`updateMemoryConfidence`/`deleteMemory`）+ `db-path.mjs`/`git-remote.mjs`，**没有新增/改动任何存储层代码**（`src/context/**` 零改动，`git diff --stat -- src/` 确认）。
- **本地自检**：`node scripts/test-seed-brain-identity.mjs` PASS，7 个场景：① 无 DB 路径 → 显式 `throw`（`err.code === "NO_IDENTITY_DB_PATH"`），不是静默跳过；② 首次运行：身份 inserted + 6 条宪法约束全部 inserted + 全部 5 种 status 映射（`in-progress`/`prd-draft`/`awaiting-zorro`/`awaiting-commander`/无 label）+ closed→archived 逐条断言正确；③ **幂等**：完全相同输入二次运行，`listMemories()` 前后逐条比对（id/title/content/tags/updatedAt 全部字段）完全相等，证明零写入，不只是"重跑不报错"这种弱幂等；④ issue 改标题（号不变）→ `replaced`，且不产生孤儿/重复行，按 `gh-issue:<n>` tag 精确匹配到同一条；⑤ issue 状态从 open 变 closed → `replaced`，正确带上 `archived`；⑥ 多 `status:*` label 优先级（两个真实组合都测了）；⑦ 无 origin remote → `skippedIssueSync` 设置、且 `fetchOpenIssues` 根本不被调用（不浪费一次不会被用到的调用）。**额外做了真实端到端验证**（plan.md §B8 self-check 要求）：用真实 `gh`（已登录）+ 真实 aeloop 仓库跑了一次（throwaway DB，不碰真实身份库），真实拉到 45 个 issue（含本 epic 自己 #88，正确识别多 label 优先级选中 `status:in-progress`；#86 正确识别 CLOSED→archived），随后真实 spawn `brain-wake-greeting.mjs` 读这个种好的库，**开场白真的输出"意识已加载。我是 你的 AI 调度员。"+ 真实"上次停在"指向 #88**——这是本 epic 从 #84 起就想达成、但一直没做到的"开箱即真身份"闭环，第一次真的跑通。全部 9 个 test-*.mjs 重跑 PASS，`pnpm run build` + 619 个既有 vitest 测试全绿。

### Zorro/Codex B5 第二轮复验 FAIL 修复轮（第一轮修复本身引入的 2 个新 bug + 1 条残留，2026-07-23）
- 状态：完成
- **背景**：上一轮（finding-1/2/3/4/5）主体修对了（`--` 状态机 + fail-closed 危险检测，Zorro/Codex 已复现确认），但那轮 fix 本身引入 2 个新 bug + 留了 1 条残留，这轮逐条修完：
- 🔴 **finding-2（最严重，模块加载崩溃，已修）**：`TMPDIR_REAL = safeRealpath(tmpdir()) ?? tmpdir();` 在**模块加载时**同步执行，在 `main()` 的 fail-open try/catch **之外**。上一轮把 `safeRealpath()` 契约改成"非 ENOENT 错误就抛"，但只更新了 `handleBash()` 里那一个调用点的 try/catch，漏了这个模块级初始化调用点——`?? tmpdir()` 只兜 `null`（ENOENT 情形），兜不住 `throw`。真实验证过：坏 `TMPDIR`（符号链接环路）下这一行会直接抛出未捕获异常，**整个模块 crash（exit 1）**，guard 连 deny JSON 都吐不出来，红线判断根本没跑到——比"判不出就 allow"更糟。**修法**：新增专属的 `realpathOrLexicalNeverThrow()`（不复用 `safeRealpath`，两者契约刻意不同），任何错误（不止 ENOENT）都退回词法路径，绝不抛。用它替换 `TMPDIR_REAL` 的初始化。**用一个独立脚本复现过修复前的真实崩溃**（构造符号链接环路 + 模拟旧的 `safeRealpath` 契约，`node -e` 直接跑，真实抛出 `ELOOP` 未捕获、exit 1），验证方向和复现结果与 Zorro/Codex 报告一致，不是臆测。
- 🔴 **finding-3（第二轮，误伤 false-positive，已修——注意编号和第一轮的"finding-3/4"是两件不同的事，已在代码注释里用"第一轮"/"第二轮"消歧）**：循环里 `if (inv.cmd !== "rm") continue;` 只要**同命令里任一** invocation 命中 `matchesRmDashRf(cmd)`（外层入口的廉价预筛选），就会把该命令里**所有** `rm` invocation 都拉进白名单检查，不管这个具体 `rm` 自己带没带 `-rf`。实测 `rm -rf <安全tmp> && rm ./stale.log` 会把普通的 `rm ./stale.log` 也误 deny——判据自相矛盾（单独跑 `rm ./stale.log` 不拦，跟在 `rm -rf` 后面就拦）。**修法**：新增 `invocationIsRmDashRf(inv)`，循环内对每个 `rm` invocation 独立重新确认它自己是否真的带 `-r`+`-f`，不是就跳过。判据逐字复制 `command-match.mjs:297-317` `matchesRmDashRf` 内部对单 invocation 的逻辑（不是调用它——那个函数的粒度是"一条命令字符串有没有任一命中"，不返回是哪一个；约束要求本轮不碰 `command-match.mjs`，复制这一小段比为了单次粒度需求扩大共享库接口更克制，代码注释里写明了"两处必须同步改"这条维护风险）。
- 🟡 **finding-1 残留（低危害，已修）**：`extractRmTargets` 的 `!a.startsWith("-")` 仍会把单独的 `-`（rm 把它当合法文件名 operand，不是 flag/stdin 标记，GNU/BSD 一致）误判成 flag 跳过——`rm -rf -` 会被漏判成"没有目标"从而放行。补了 `a === "-"` 的特例，视为目标。
- **改了哪些文件（严格限定范围）**：只有 `.claude/hooks/brain-red-line-guard.mjs`（改，新增 `realpathOrLexicalNeverThrow`/`invocationIsRmDashRf` + 三处逻辑修正）+ `.claude/hooks/test-brain-red-line-guard.mjs`（改，补 finding-2 崩溃回归 + finding-3(第二轮) 连坐/反例回归 + finding-1 残留回归）。**`command-match.mjs`、`BRAIN.md`/`CLAUDE.md`、其它三个 hook、`settings.json` 本轮零改动**——这轮修复不影响已发布的用户可见行为承诺（都是内部正确性修复，不是新增/收紧对外声称的能力边界），判断不需要同步文档。`git diff --stat` 确认只有 2 个文件改动。
- **本地自检**：全部 8 个 test-*.mjs 重跑 PASS（`test-brain-red-line-guard.mjs` 新增 finding-2 崩溃回归——真实构造符号链接环路 + 覆盖 `TMPDIR` 环境变量真实 spawn 子进程，确认 exit code 正常、不崩溃；finding-3(第二轮) 连坐修复 + 反例（确认两段都真 rm -rf 时白名单外那段仍独立 deny，没有把判据整个关掉）；finding-1 残留 `rm -rf -` 回归）；`pnpm run build` + 619 个既有 vitest 测试全绿；`git diff --stat -- src/` 确认零改动；`/tmp` 下测试产生的临时符号链接环路/目录已手动清理，无残留。

### Zorro/Codex B5 复审 FAIL 修复轮（真 bug + fail-open→fail-closed 精确收紧 + 诚实披露，2026-07-23）
- 状态：完成
- **背景**：Zorro 复审 B5 判据本身，Codex 跨模型独立视角抓到两条能放行危险命令的真实缺口（finding-1 真 bug、finding-3/4 fail-open 方向反了），外加一条必须诚实披露的根本局限（finding-2 TOCTOU）和一处举例订正（finding-5）。operator 批了一次修完，精确限定范围，不许过度 fail-closed。
- **finding-1（真 bug，`brain-red-line-guard.mjs` 的 `extractRmTargets`）**：旧实现 `args.filter(a => !a.startsWith("-"))` 不认 POSIX `--` 选项终止符，`rm -rf -- -victim` 里 `-victim` 会被误当 flag 跳过 → `extractRmTargets` 返回空数组 → 没有目标可检查 → **误放行**一个真实指向白名单外的删除。**修法**：改成状态机——扫到第一个字面量 `--` token 后，其余 token 一律当目标（不再检查是否以 `-` 开头），`--` 之前判据不变。加测试：`rm -rf -- -victim`（仓库内，白名单外）→ deny；`rm -rf -- <tmpdir 内路径>`（"--" 后的合法路径）→ allow（确认没有连带误伤）。
- **finding-3+4（fail-open → fail-closed，operator 拍板，精确限定范围）**：
  - **判定分支**（`brain-red-line-guard.mjs` `handleBash()` 的 rm-rf 判定循环内，`resolveRealOrLexical(lexical)` 的 try/catch）：`safeRealpath()` 改成区分 `ENOENT`（路径不存在，合法状态，返回 `null` 交给既有 walk-up 逻辑）vs **其它任何错误**（`EACCES`/`ELOOP` 等，抛出带 `REALPATH_UNRESOLVABLE` 标记的错误）；调用点捕获这个标记 → `deny()`。**范围严格限定**在"已经确认命中 `rm -rf`（`matchesRmDashRf(cmd)` 为真 + `inv.cmd === "rm"`）、且某个具体目标 `realpath` 判不出安全"这一段——不命中任何破坏模式的命令、guard 自身其它异常（stdin/JSON 解析失败等）仍然 fail-open，写进了代码注释里明确的"分界线"说明，不是含糊带过。
  - 加测试：构造真实符号链接环路（`linkA <-> linkB` 互指，`realpathSync` 真抛 `ELOOP`，不是 mock）→ deny；回归确认真正"尚不存在"的目标（`ENOENT`）仍然 allow，新的 fail-closed 没有连带误伤这条本来就该放行的路径。
- **finding-2（TOCTOU，诚实披露，不强行修）**：头注释"已知局限"新增第⑤条——同一条复合命令里先造符号链接（或其它方式改文件系统）再 `rm`（如 `ln -s /etc box/x && rm -rf box/x/foo`），guard 判断时看到的文件系统状态和命令真正执行时不是同一份快照，能把删除重定向到白名单外。这是 check-before-execute 模式的根本局限，和"命令混淆"是两个不同性质的问题（前者"看懂了但快照过期"，后者"看不懂命令在说什么"），不在本轮修复范围，如实记入。
- **finding-5（举例订正，机制没错）**：头注释原来举例说"`rm -rf /tmp/evil-link` 会跟随符号链接删除目标"——这是说反了 `rm` 的真实语义：`rm` 对参数**最后一段（叶子）**是符号链接时，标准行为是删除链接本身，不跟随；真正的风险是符号链接出现在路径**中间段**（如 `rm -rf /tmp/evil-dir/child`，`evil-dir` 是链接）。订正了措辞，`realpathSync()` 解析整条路径链（不只是最后一段）这个机制设计本身是对的，不需要改代码，只改了举例说明。
- **顺手修的一处旧遗留**：头注释里一处引用了不存在的函数名 `resolveForWhitelistCheck()`（实际函数是 `resolveRealOrLexical`，属于本文件更早前留下的悬空引用），顺手订正，不是本轮 Zorro 新提的 finding。
- **改了哪些文件**：`.claude/hooks/brain-red-line-guard.mjs`（新增 `REALPATH_UNRESOLVABLE` 标记 + `safeRealpath`/`resolveRealOrLexical`/`extractRmTargets` 三处逻辑改动 + 头注释新增 finding-2/5 + 订正 finding-5 举例 + 修正 fail-open 汇总段落）、`.claude/hooks/test-brain-red-line-guard.mjs`（补 4 个新场景：`-- ` 正反例 ×2 + ELOOP fail-closed + ENOENT 回归）、`CLAUDE.md`/`BRAIN.md`（red-line 那条措辞补"更拦了一点"+ TOCTOU 披露，保持和 hook 头注释一致，没有因为"更拦了"就写成过度声称）。**`command-match.mjs` 的 B1 六个原始导出 + Pass 3 新增的 `isProtectedEnvBasename`/`matchesEnvWrite` 本轮零改动**（`git diff` 确认这轮只碰了 4 个文件），`brain-commit-gate.mjs`/`brain-issue-gate.mjs`/`brain-isolation-guard.mjs`（其它三个 hook 本体）零改动。
- **本地自检**：全部 8 个 test-*.mjs 重跑 PASS（含 `test-brain-red-line-guard.mjs` 新增的 4 场景）；`pnpm run build` + 619 个既有 vitest 测试全绿；`git diff --stat -- src/` 确认零改动；`git status` 确认无临时文件/符号链接测试残留（测试用 `unlinkSync` 显式清理环路符号链接，不依赖进程退出自动清理）。

### Zorro Pass1+2 复审 FAIL 修复轮（纯文档 + test-hygiene，2026-07-23，不动 gate 判定逻辑）
- 状态：完成
- **背景**：Zorro 复审 Pass1+2 结论"机制逻辑全过（真 spawn 22 例 + 跨仓 parity 证明忠实移植生产基线），FAIL 是窄口径、纯文档诚实"——不动任何 gate 逻辑，只补披露/软化措辞，外加两个非阻断的顺带项。
- **必改1：finding-3 绕过披露补齐**（`brain-commit-gate.mjs` 移植时漏了源文件 `session-commit-gate.mjs:57-61` 已经记入风险清单的一条真实绕过路径——只用 cwd 判目标仓库，不解析命令文本里的 `-C`/`--git-dir=`，从仓库外用 `cd 目标仓库 && git commit`/`git -C 目标仓库 commit`/`gh -R owner/aeloop pr merge` 可以绕开）：
  - `.claude/hooks/brain-commit-gate.mjs` 头注释"已知局限"段补第②条，逐字对应源文件语义，不夸大不缩小。**纯注释改动**，`git diff` 已核对零逻辑改动。
  - `TURNKEY-DESIGN.md` §5 commit-gate 行从"只写变量拼接/eval"补成两条完整披露。
- **必改2：摘要措辞软化**（`CLAUDE.md`/`BRAIN.md` §1.6 commit-gate 那条从"会被拒绝"/"一律拒绝"改成准确描述"在 cwd 命中本仓库时拦截；从仓库外定位或命令混淆可绕过——养成习惯的软门，不是安全边界"，避免读者以为 `cd 仓库 && commit` 也被守着）：两处均已改，措辞与 `brain-commit-gate.mjs` 头注释/`TURNKEY-DESIGN.md` §5 保持一致。
- **顺带3：test-hygiene**——`test-brain-isolation-guard.mjs` 此前直接读写真实仓库自己的 `.claude/brain-locks/`（非 hermetic，并发/真实会话同时跑会 flaky）。改成每次跑建一个独立临时 git 仓库（`git init` 真实建仓库，因为 `resolveToplevel()` 靠 `git rev-parse --show-toplevel` 判定，糊弄不了非 git 目录），全程只读写这个临时仓库自己的锁目录，跑完整体删除，和真实仓库完全隔离。改写过程中发现一个自己引入的测试 bug（4 个测试块共用同一临时仓库、未在块间清锁，导致后面的块被前面块留下的"新鲜"锁污染）——加了 `clearAllLocks()` helper 在每块开头清空，修完重跑 PASS。
- **顺带4b：finding 4b（令牌消费写失败 → 可重放）——选择"一行（级别）fail-closed 修复"，不是只写文档**：`brain-lock.mjs` 的 `consumeCommitAuthorization()` 原来的写盘调用 `writeLockFile(file, updated)` 不在 try/catch 里——如果写失败（磁盘满/权限），异常会冒泡到 `brain-commit-gate.mjs` 的外层 `catch { allow() }`，导致这次操作被放行、但令牌本身没有真正标记为已消费，等于在这个窄条件下"一次性令牌"被悄悄复用了一次。判断：这个修复足够小、足够干净（把一行写调用包进 try/catch，失败时返回 `{consumed:false, reason:"write-failed"}` 而不是让异常冒泡），选择直接做掉而不是只在文档里承认这个张力——调用方因此走的是既有的 `deny(...)` 分支，不会落进"guard 自身异常→allow"的兜底路径。范围严格限定在这一个函数内部的这一步写入，没有改变 hook 层面"guard 自身其它异常仍然 fail-open"的整体设计，也没有碰任何 `brain-commit-gate.mjs`/`brain-issue-gate.mjs` 的判定链代码。取舍本身 + 为什么选择这条路径，写进了函数上方的 JSDoc（不只是 commit message 里一句话）。补了真实 I/O 失败的回归测试（chmod 锁文件只读，逼真实 `writeFileSync` 抛错，不是 mock）。
- **finding 5（issue-gate 收任意 truthy `lock.issue`）：跳过**，遵照 operator 指令——P3、默认关闭门（`enforce` 模式才生效），不顺手做格式校验，不碰 `brain-issue-gate.mjs`/`brain-lock.mjs` 的 `bindIssue`/校验逻辑。
- **本地自检**：全部 7 个 test-*.mjs 重跑 PASS（`test-git-remote`/`test-command-match`/`test-brain-lock`(含新的 write-failed 回归)/`test-db-path`/`test-brain-commit-gate`/`test-brain-issue-gate`/`test-brain-isolation-guard`(hermetic 重写后)）；`pnpm run build` + 619 个既有 vitest 测试全绿；`git diff --stat` 核对本轮只碰了 7 个文件（`brain-commit-gate.mjs`、`brain-lock.mjs`、`test-brain-lock.mjs`、`test-brain-isolation-guard.mjs`、`CLAUDE.md`、`BRAIN.md`、`TURNKEY-DESIGN.md`），`brain-issue-gate.mjs`/`brain-isolation-guard.mjs`（hook 本体）本轮零改动，确认没有碰任何 gate 判定逻辑（除已授权的 4b 一处）。

### 成本透明人格条款追加（operator 拍板，2026-07-23，B8 已 commit 之后的小 follow-up）
- 状态：完成
- **背景**：operator 拍板给人格加一条"成本透明"（👁 soft，不是硬机制门）——原本这条特意没混进 B8（等 operator 单独定），本次单独追加。
- **改了什么**：`docs/conductor-brain-layer/BRAIN.md` §1.6 追加第 7 条 👁（"成本透明"，措辞按 operator 给的原文，含关键护栏"不擅自为省成本牺牲复审/验证的完整性"）；`CLAUDE.md` 铁律段同步追加同一条（措辞一致）；`scripts/seed-brain-identity.mjs` 的 `CONSTITUTION_CONSTRAINTS` 追加第 7 条 `slug:"cost-transparency", hardness:"soft"`，内容誊写自新加的 §1.6 条目，保持"种进身份库的宪法和 BRAIN.md 不漂移"这条既有原则（6 条=4🔒+2👁 → 7 条=4🔒+3👁）。`scripts/test-seed-brain-identity.mjs` **不需要改**——原有的 `assert.equal(result.constraints.length, CONSTITUTION_CONSTRAINTS.length, ...)` 断言本来就是动态读常量数组长度，不是硬编码 6，自动适配成 7，重跑确认。
- **本地自检**：全部 9 个 test-*.mjs 重跑 PASS；`pnpm run build` + 619 个既有 vitest 全绿；`git diff --stat` 确认本轮只碰了 3 个文件（`BRAIN.md`/`CLAUDE.md`/`seed-brain-identity.mjs`），`src/**`、其它 hook、共享库、`settings.json`、`brain-red-line-guard.mjs` 零改动。额外用真实 `gh`（throwaway DB）重新端到端跑了一次 seed 脚本，确认第 7 条约束（`constraint:cost-transparency`，`tags:["hardness:soft"]`）真的落进了库里。

## 决策记录（可追源）
- 2026-07-23：operator 确认 DESIGN §4 人格加载方案 = (iii)，§7 issue-gate 范围 = opt-in/env 开关默认收窄——已焊进 `docs/conductor-brain-layer/TURNKEY-DESIGN.md`（见该文件 §4/§6/§7 变更标注），并据此写出本 PRD/plan。理由见 `TURNKEY-DESIGN.md` 对应章节，不在此重复。
- 2026-07-23：PRD 阶段核实"unconfirmed constraint memory → 待你决策段"这条闭环今天就是通的（`wake.mjs:44-61` + `greeting-data.mjs:167-170`），因此本次改动**不需要碰** `docs/conductor-brain-layer/spike/lib/{wake,greeting-data,render-greeting,status-table,sanitize}.mjs`——见 `TURNKEY-DESIGN.md` §4 新增段落 + `PRD.md` §3。
