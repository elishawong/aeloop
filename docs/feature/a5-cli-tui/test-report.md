# A5 CLI/TUI — 独立复审报告(Zorro + Codex 二签)

> aeloop issue #22 · 分支 `feature/issue-22-a5-cli-tui`
> 审查者:Zorro(独立于 Cypher 生产者)+ Codex `gpt-5.6-sol` 跨模型二签(read-only sandbox,真实执行,attestation 记 `raw_output_sha256`)。
> 记录规则:每轮不覆盖前轮历史,追加新章节。R1/R2 由 Zorro 以文本形式交回,Helix 落盘(Zorro 受 harness 约束不能写 report `.md` 文件)。

---

## Round 1 — FAIL

### Codex 二签 attestation

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T08:59:28.662Z",
  "completed_at": "2026-07-21T09:08:08.032Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop-worktrees/issue-22-a5-cli-tui",
  "review_scope": "aeloop A5 CLI/TUI retry lean",
  "git_commit": "c8d02891cc6dd8dfdc0436087a899d68e3ff2596",
  "diff_base": "c8d0289",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "0bd240d17d935d96750a7b006863ad77773573f3f30f340a79798e16737f9a62",
  "independent_review_completed": true,
  "fallback_used": false
}
```

> 注:第一次 Codex(全量 prompt)超时;精简 prompt 重跑,第二次成功 —— 一次成功的独立审查,非两次超时兜底。

### 审查结论:FAIL

Codex 抓到几处 Zorro read-only 初审低估的真问题,尤其"批准前 coder 已能改仓库"直接戳穿 PRD §0 核心安全前提。Zorro 逐条核实 load-bearing 事实全部属实,verdict 如实转达。

### 🔴 必须改(blocker)

**P0-1 · [PRD §0 + `src/harness/adapters/claude-cli-adapter.ts:85` + `profiles/subscription/personas/coder.md:3`] 批准前 coder 已能改工作区。**
coder persona 明写 "implement the requested change directly in the target codebase",adapter 用 `--permission-mode bypassPermissions` + 允许 `Bash` 启动 coder。Bash 能 `sed -i`/重定向/`git apply` 直接写盘 —— 所以 G1 渲染之前工作区可能已被改。PRD §0 声称 "coder 的 `--allowedTools Bash,Read,Grep,Glob` 是 read-only 白名单(no Write/Edit)" 是**事实错误**:Bash 不是只读,bypassPermissions 放开了门。`applyNode()` 空壳只保证"引擎不 apply diff",挡不住 coder 自己写。A5 是第一个真人入口,第一次把"没批就改仓库"暴露给真实用户。
→ 修复(OS 级只读沙箱 coder)大概率超出 `src/cli/` 范围,需指挥官做范围裁决;但 PRD §0 的错误结论 A5 必须订正。

**P0-2 · [`src/loop/audit-store.ts` schema + `src/harness/cli-exec.ts:178` + `assemble.ts` workflow.db] 跨进程 resume 可能作用到错的仓库。**
workflow_runs 不存 repo path/cwd;adapter 只传 `{timeoutMs}`、不传 cwd → 子进程继承 `process.cwd()`;workflow.db 是 profile 全局。场景:repo A 起 run → 在 repo B 跑 `aeloop resume <id>` → A 的图状态恢复,但 coder/tester 检视/改的是 B。`list` 也不标识项目。
→ 修复(每 run 持久化 canonical cwd 并显式传给每个 adapter)触及 audit schema + harness,超出 `src/cli/`,需指挥官范围裁决;A5 至少要在 `list`/`resume` 记录并显示 run 来源目录 + 换目录 resume 时告警。

**P1-3 · [`src/cli/main.ts:33` `MainOverrides.env`] profile "no bypass path" 被测试 seam 破坏。**
生产 `bin.ts` 安全(不传 override),但导出的 `main()` 收 `MainOverrides.env`,程序化调用可在真实 env=apikey 时传 `env:{subscription}` 绕过。`profilesRoot`/`prompter` 是合理 seam,`env` 不必要(B8 可以 scope `process.env`)。
→ A5 范围内,删掉 env override。

**P1-4 · [`src/cli/diff-render.ts:30` + `src/cli/gate-view.ts:17` + `main.ts` list] 未过滤的模型文本当原始终端控制序列直接打印。**
diff/issue/task 文本只上 chalk 颜色,不清洗 ANSI/OSC/光标控制符。模型可注入清屏、光标移动、伪造提示文本,破坏人类门的完整性 —— 而可信的人类复审正是 A5 的全部意义。
→ A5 范围内,渲染前清洗控制符(保留 `\n`/`\t`)再上色。

**P1-5 · [`src/cli.e2e.test.ts:140`] A5 头号验收项(全新进程 resume)没有垂直测试。**
B8 两个用例都只 `main(["start", ...])`,从不 `main(["resume", ...])`、不经真实 assembly 重建 pending gate、不在 pause/resume 间换进程/依赖实例。`main.test.ts` 的 resume 用例把 `getPendingInterrupt`/`runInteractiveLoop` 全 mock 了。PRD §10 明写 "SIGINT→fresh process `aeloop resume`→跑通" 是核心验收 —— 它可以坏掉而 B8 仍绿。
→ A5 范围内,B8 补一条 resume 垂直切片。

### 🟡 假绿 / 建议改(Codex 报出 + Zorro 复核属实)

- **G2 choices 假绿**:`run-loop.test.ts:301` 标题"choices are exactly approved/escalate"但只断言 select 被调用;`FakePrompter.select` 丢弃 `_choices`(`prompter.ts:77`)。加第三个 rejected 选项不会让它转红。真正的保护在 `select<"approved"|"escalate">` 类型 + runner `G2_RESUME_DECISIONS` 域守卫 —— 但请补一条直接断言 choices 数组的测试。
- **`getPendingInterrupt()` "writes nothing" 覆盖不全**:测试只比对 `workflow_runs`/`approvals`/`structured_claims`,漏了 `step_markers` 和 LangGraph `checkpoints`/`writes` 表。实现本身零写入(只 `getRunById`+`getState`),但测试挡不住所有禁写路径 —— 扩宽前后快照。
- **tier-3 阈值测试根本没到 tier 3(且暴露死代码)**:`SystemConfig.get()` 回退到 `DEFAULTS["default_reject_threshold"]="2"`(`config.ts:12`),`getDefaultRejectThreshold()` 空库返回 2 不是 null → `resolveRejectThreshold` 永远在 tier 2 命中,`return 2` 的 tier-3 分支是不可达死代码,`assemble.test.ts:130` 的"tier 3"实际测的是 tier 2。→ 要么让测试真到 tier 3(存非数字值使返回 null),要么删死分支。
- **B8 seed 的 memory 与 task 无关且从不断言到达子进程**:把真实注入换成 `{memories:[]}` 也能保持绿。→ 断言注入的 context 真流到了 fixture 子进程。

### 🟡 其它(Codex 附带,Zorro 认可)

- `parseArgs({strict:false})`:静默忽略未知 `--flag` 和多余 positional。
- `--help` 走 default 分支当"unrecognized command"报错退出,但 PRD/README 引用了 CLI help。
- `printFinalSummary` 打印 "completed — applied.",但没有任何 Apply-stage 落盘发生(叠加 P0-1 更误导)。
- `withDeps()` 只 close `audit`/`memoryStore`,不 close checkpointer(`createSqliteCheckpointer` 返回的 `SqliteSaver` 底层 better-sqlite3 连接每次命令泄漏)。

### ✅ 检查过且 OK(Zorro 独立复核)

- **G2 严格二选一**:生产代码正确(`run-loop.ts:90` 类型钉死 `approved|escalate`;`gates.ts:162` `routeAfterG2` rejected 抛 `UnhandledGateDecisionError`)。仅其回归测试假绿。
- **`getPendingInterrupt()` 只读**:实现只 `getRunById`+`getState`,零写入 —— 亲跑变异确认(`done: true` 硬编码 → 2 测试转红;已还原)。
- **无 coder diff 落盘 in `src/cli/`**:grep 确认唯一 `fs.write` 是测试 fixture config;`applyNode` 未碰。
- **B8 是真垂直切片**(非假集成):真 `main()`、真依赖图、真 fixture 子进程、读真实落盘行 —— 只是只覆盖 start 路径(见 P1-5)。
- **B6 G1/G3 渲染分派互换**:亲跑变异(renderGate 交换 → `run-loop.test.ts` happy-path 转红;已还原)—— Cypher 补的 `[G1]`/`[G3]` 断言确实能稳定抓到。
- **build / lint / 368 测试**:独立跑 3 次,全绿(Codex 只读沙箱跑不了 vitest,368 由 Zorro 核实)。
- **CliDeps `injector`/`memoryStore` + `profilesRoot`**:合理(非后门,`bin.ts` 不传;guard 独立于 profilesRoot)—— Codex 同判。唯一不合理的是 `env` override(P1-3)。

### 七道门(R1)
需求贴合 [✗] · 影响范围 [✗] · 占位符拒收 [✓] · 危险代码 [✗] · 幻觉核查 [✗](PRD §0 结论与真实 adapter 代码矛盾) · 文档齐套 [✓ 但 §0 须订正] · 文档同步(大设计级)[N.A.]

---

## Round 2 — FAIL

Cypher 完成一轮返工(P0-1 文档订正、P0-2 run-origin sidecar、P1-3 删 env seam、P1-4 sanitize-terminal、P1-5 跨进程 resume e2e、4 处假绿测试 + 小项)。Zorro + Codex 二签复审。

### Codex 二签 attestation

```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T10:18:43.742Z",
  "completed_at": "2026-07-21T10:26:29.144Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/ai-agent",
  "review_scope": "aeloop A5 CLI/TUI round-2 rework: P0-1 docs, P0-2 run-origin, P1-3 env seam removal, P1-4 sanitize-terminal, P1-5 cross-process resume e2e",
  "git_commit": "90ab583f7786976bfaa953544f0d3f97bdd4ca8c",
  "diff_base": "working tree vs main c8d0289 (uncommitted)",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "9871a63dbc13200151ba041cbef4235fc8e5764addbef218d6f676fb23d78f57",
  "independent_review_completed": true,
  "fallback_used": false
}
```

### 审查结论:FAIL

方向对、大部分做到位(P1-3、P1-5 干净,sanitize 安全属性成立,测试真绿),但 **P0-2 兜底代码本身有一个真实崩溃 bug**,加上文档齐套缺口,不能放行。返工量很小(集中一个文件)。

### 🔴 必须改(blocker)

**B1 — [`src/cli/run-origin.ts:66-85` + `src/cli/main.ts:142`/`186`] P0-2 兜底代码自身崩溃,违反它自己声明的 fail-open 契约。**
`readRunOrigins()` 只校验顶层是「非 null 非数组的对象」,然后整个对象 `as RunOriginsFile` 盲转,不校验每个 per-run 条目。于是一个**合法 JSON 但条目损坏**的 sidecar(`{"1": null}`)会让 `getRunOrigin()` 返回 `null`;`main.ts:142`(runResume)的 `origin !== undefined && origin.cwd` 里 `null !== undefined` 为真 → 求值 `null.cwd` → **`TypeError: Cannot read properties of null (reading 'cwd')`**。runList 的 `main.ts:186` 同理。Zorro 直接复现(非仅信 Codex):
```
A getRunOrigin({1:null}) => null
   A CRASH in main.ts:142-equiv => TypeError Cannot read properties of null (reading 'cwd')
```
run-origin.ts 文件头白纸黑字承诺「degrades to 'no origin recorded'…callers print no warning rather than treating that as an error…it never throws」—— 代码没兑现。命令被 `main()` catch 住但整条 resume/list 就地 exit 1 中止。`run-origin.test.ts` 对 per-entry 损坏零覆盖(只测了整文件非 JSON / 数组)。这是本轮新增的 P0-2 缓解代码,正在审查范围内。
**修**:`getRunOrigin`(或 `readRunOrigins`)对每个条目做形状校验(非对象 / 缺 `cwd` 字符串 / null → 降级 `undefined`);补 `{"1": null}` 与 `{"1": "str"}` 两条测试。字符串条目(`{"2":"x"}`)不崩但会拿 `undefined` cwd 去 warn/渲染,一并收口。

**B2 — [`docs/feature/a5-cli-tui/test-report.md` 不存在] 文档齐套门(第6门)不过:悬空引用。**
`test-report.md` 被 ~10+ 处源码文件头 + `PRD.md §0` + `progress.md:79` 当作真实存在的路径引用,但磁盘上从未落盘。Zorro 受 harness 约束不写 report 文件 —— 需在 commit 前把 R1+R2 的 test-report.md 落到该路径,否则所有引用悬空(触第6门 + attestation lint 找不到证据文件)。非 Cypher 代码缺陷,是流程产物缺口,但必须在 commit 前解决。
**[本文件即 B2 的落盘产物,Helix 于 R2 后补齐 R1+R2 章节。]**

### 🟡 建议改(应与 B1 同轮、同文件一起处理)

- **P0-1 源码头与 §0 自相矛盾** — [`src/harness/adapters/claude-cli-adapter.ts:21-24, 41`] 文件头仍以「`read-only-equivalent` tool allowlist / a coder's product is a diff string, **not direct file mutation via the CLI itself**」为主述,正是 PRD §0 已「struck as factually wrong」的说法(尽管 line 24-28 有「Honest limitation」补丁式反悔)。PRD §0 和知识库两处已订正且属实(逐字对过真实代码:`bypassPermissions`+`Bash` 在 :85,persona「implement…directly in the target codebase」在 coder.md:3-4 —— 都真),但源文件头还在唱反调。**指挥官已裁决(2026-07-21):这轮一并订正头注释**(纯注释、零行为变更)。
- **P1-4 有一条未清洗的终端渲染路径** — [`main.ts:162` / `183-188`] `runList` 清洗了 `task` 却把 sidecar 的 `cwd` 原样打印;[`run-origin.ts:114`] `describeCwdMismatch` 也未清洗 origin/current cwd。严重度低于模型可控文本(cwd 源自 `process.cwd()`,是操作者选的目录名,非模型可控 —— P1-4 声明的威胁模型技术上已满足),但从纵深一致性看,凡打到终端的文本都该走 `stripControlSequences`。建议渲染 cwd 时也清洗,和 B1 同文件一起改。
- **sanitize 注释过度声称** — [`sanitize-terminal.ts:34`] `OTHER_ESCAPE_SEQUENCE` 注释举例「ESC c (RIS)、ESC 7/8」,但正则 `[@-Z\^_]` **不匹配** `c`(0x63)/`7`/`8`;这些序列只靠末尾 `RAW_CONTROL_CHARS` 剥掉 ESC/C1 字节而中和,残留可见字符(如 `cRESET`、`31mtext`)。**安全属性验过成立**(9/9 样本无 control 幸存),只是残留 cosmetic 垃圾字符 + 注释不准,非终端控制绕过。改注释即可。
- **assemble.ts 错误路径连接泄漏** — [`assemble.ts:109`] `MemoryStore` 在 `buildAdapterRegistry`/`createSqliteCheckpointer`(可抛)之前打开;若后者抛错,`withDeps` 的 finally 只清理成功返回的 deps → 已开连接泄漏。仅错误路径、进程通常随即退出,极小。

### ✅ 检查过且 OK(Zorro 独立复核)

- **P1-3 env seam 删除**:VERIFIED。`MainOverrides` 只剩 `profilesRoot`/`prompter`;`withDeps` 无条件用真实 `process.env`(`main.ts:89-93`);`bin.ts` 零 overrides;`main()` 无任何路径能让 `assembleSubscriptionDeps` 看到伪造的 `AI_AGENT_PROFILE`。无绕过。
- **P1-5 跨进程 resume e2e**:VERIFIED,真实非 mock。两次独立 `main()` 调用、各自 `FakePrompter`、仅共享磁盘 `profilesRoot`;进程2 走真实 `getPendingInterrupt()`;磁盘 ground-truth 断言 G1 只 1 条、G3 只 1 条(证明没重放 G1)。Codex 提醒它是「同一 OS 进程内两次调用,非真子进程隔离」—— 但这是文档化的合法测试缝(直接 import `main()`,非重建 shim),非隐藏 mock。
- **sanitize 安全属性**:VERIFIED。喂了 SGR/清屏/光标/OSC-BEL/OSC-ST/RIS/C1-CSI/DCS/混合样本,`\n`/`\t` 保留,且无任何 C0/C1/ESC/DEL 字节存活。
- **run-origin fail-open(整文件级)**:VERIFIED。缺失文件静默、损坏 JSON/数组警告后返 `{}` 不抛、损坏后 `recordRunOrigin` 能恢复、不可写目录警告后不抛。(**只有 per-entry 级损坏崩** = B1。)
- **407/407 测试、build、lint**:独立重跑确认(未沿用旧数字),全绿。
- **diff 范围**:与 Cypher 自述一致 —— 仅 `src/cli/` 新层、`runner.ts`(+`getPendingInterrupt`)、fake-claude fixture(+prompt capture)、docs;无超范围的 tracked 源码改动。
- **占位符 / 危险代码**:无 TODO/stub/假数据;无删库/密钥/注入/越权。

### 七道门(R2)
需求贴合 [✗ — P0-2 缓解崩溃,不满足自身 fail-open 契约] · 影响范围 [✗ — P1-4 漏了 cwd 渲染面] · 占位符拒收 [✓] · 危险代码 [✓] · 幻觉核查 [✓ 代码可追源;Cypher「run-origin 永不崩」自述被 B1 证伪,归入需求贴合] · 文档齐套 [✗ — test-report.md 悬空] · 文档同步(大设计级)[N.A.]

### 📚 知识库(核对,不维护)
触及已索引模块 [是 — `ClaudeCliAdapter`、`runner.ts`、新增 8 个 `src/cli/` 条目] · 对照 `CHARTS/knowledge/aeloop.md` 是否仍准 [✓ — `ClaudeCliAdapter` 的 P0-1 订正逐字属实,`last-verified: 2026-07-21` 当前] · 库漂移 [N.A. — 未发现;唯一不一致是源文件头 vs §0,属代码注释范畴,见 🟡 P0-1]

### 返工清单(交 Cypher,预计一轮、集中一处)
1. **[必须]** `run-origin.ts`:`getRunOrigin`/`readRunOrigins` 逐条目形状校验,非对象/缺 `cwd`/null → 降级 `undefined`;补 `{"1":null}`、`{"1":"str"}` 两条回归测试。(B1)
2. **[必须]** 落盘 `docs/feature/a5-cli-tui/test-report.md`(R1 历史 + R2 章节),消除全部悬空引用。(B2)**[Helix 已落盘本文件]**
3. **[指挥官已批]** `claude-cli-adapter.ts` 头注释(:21-24, :41)与 §0 对齐(纯注释)。
4. **[建议]** 渲染 cwd 前 `stripControlSequences`(`main.ts` list + `describeCwdMismatch`);`sanitize-terminal.ts:34` 注释订正;`assemble.ts` 错误路径清理。

改完 Zorro 再审一轮到 PASS + CI 绿,再交指挥官批。**未 commit/push,门禁在指挥官手上。**

---

## Round 3 — FAIL

Cypher 完成 R2 返工(B1 run-origin 形状守卫、P0-1 头注释订正、P1-4 补漏两处 cwd 清洗、sanitize 注释订正、assemble 错误路径泄漏修复)。Zorro + Codex 二签复审。

### Codex 二签 attestation
```json
{
  "provider": "openai",
  "execution": "codex-cli",
  "cli_version": "0.144.1",
  "model": "gpt-5.6-sol",
  "codex_binary_path": "/opt/homebrew/Caskroom/codex/0.144.1/codex-aarch64-apple-darwin",
  "started_at": "2026-07-21T10:59:52.190Z",
  "completed_at": "2026-07-21T11:03:45.845Z",
  "working_directory": "/Users/elishawong/code/github/elishawong/aeloop-worktrees/issue-22-a5-cli-tui",
  "review_scope": "A5 CLI/TUI R3: B1 run-origin guard + P0-1 adapter comment + P1-4 sanitize + sanitize-terminal comment + assemble.ts error path",
  "git_commit": "c8d02891cc6dd8dfdc0436087a899d68e3ff2596",
  "diff_base": "HEAD",
  "sandbox": "read-only",
  "exit_code": 0,
  "raw_output_sha256": "90114ebe0d31e0dbfa5c84c559a397a3b48fd94952c096a00a4c5691d87b9726",
  "independent_review_completed": true,
  "fallback_used": false
}
```
证据文件核验:`.helix/zorro-raw-output/90114ebe0d31e0dbfa5c84c559a397a3b48fd94952c096a00a4c5691d87b9726.txt`(worktree repoRoot),sha 与 attestation 一致;codex 二进制解析到可信 Homebrew Cask 安装路径(非 repo/tmp)。

### 审查结论:FAIL
B1(本轮核心崩溃 bug)已彻底修复并三重独立验证通过。但 Codex 二签在本轮复审范围内的 P1-4 项独立报出一处真实残留:`runList` 的不匹配横幅打印未清洗的 `currentCwd`,与其自身声明的「所有打印字符串一律清洗、无例外」不变量、及 B11 自述的「P1-4 清洗已补齐」相矛盾。据此 FAIL,交一处一行返工。

### 🔴 必须改(blocker)
- **[`src/cli/main.ts:201`] P1-4 清洗遗漏(Codex 独立报出,Zorro 复核属实)** — `runList` 在 `anyMismatch` 时打印的横幅把原始 `currentCwd`(= `process.cwd()`,`main.ts:181`)直接插值进去,未过 `stripControlSequences`。对照:平行的 resume 路径 `describeCwdMismatch()`(`run-origin.ts:155-156`)对**同一个** `currentCwd` 值做了清洗;`runList` 表格单元格(`main.ts:193`)也清洗了 origin cwd——唯独这条横幅漏了。可证伪的不对称:同一值在 resume 警告里清洗、在 list 横幅里裸打。
  - **为什么算 blocker**:① P1-4 是本轮明确列入复核的范围;② B11/知识库自述称「`describeCwdMismatch()`/`runList` 补齐 P1-4 清洗遗漏」但 `runList` 仍留一条裸打印路径,自述完整性不成立;③ 违反该改动自己写在代码里的立项理由(`main.ts:188-192` 注释「every string this file prints goes through the same sanitizer, no exceptions」);④ 既有 P1-4 回归测试只断言表格单元格,不覆盖横幅路径。
  - **严重度(诚实标注):低。** `currentCwd` 是操作者自己的工作目录,非模型/网络可控数据;实际安全暴露约等于零,需操作者自己创建含 ANSI 字节的目录名并 cd 进去才可能触发。但它是范围内、可证伪、且自述已修的真实缺口。
  - **建议**:`main.ts:201` 把 `currentCwd` 换成 `stripControlSequences(currentCwd)`;补一条断言 list 不匹配横幅被清洗的测试;同步知识库 `aeloop.md:167` 表述。预计 R4 一行改动 + 一条测试即绿。

### ✅ 检查过且 OK(Zorro 独立复核)
- **B1 核心修复(本轮重点,三重独立验证)**:`isValidRunOrigin()`(`run-origin.ts:128-132`)形状守卫覆盖完整——用构建产物 `dist/` 亲手喂 12 种损坏形状(`null`/裸字符串/数字/布尔/数组/缺 `cwd`/缺 `recordedAt`/`cwd` 非字符串/`recordedAt` 非字符串/空对象)全部安全降级为 `undefined`,合法条目正确回读;两处消费者守卫(`main.ts:142` resume / `:185` list)对全部 12 种形状零崩溃。**变异证明守卫承重**:改回裸 `return entry`,`{"1":null}` 立即复现 R2 的 `TypeError`。全仓 `getRunOrigin` 消费者仅 `main.ts:140/184` 两处,均充分守卫。main.test.ts 有真端到端回归。
- **P0-1(注释订正,三方一致)**:`git diff` 确认纯注释改动,`ALLOWED_TOOLS` 常量值一字未动,零行为变更;文件头 + 常量注释、PRD §0、知识库 `ClaudeCliAdapter` 条目三方现已一致准确(Bash+bypassPermissions ≠ 只读)。
- **sanitize-terminal.ts:34 注释订正**:准确。
- **P1-4 已清洗到位的部分**:`describeCwdMismatch`(origin cwd + currentCwd 双清洗)与 `runList` 表格单元格 origin cwd 清洗——喂含 `\x1B[2J` + OSC 序列的 cwd,输出无残留。(唯一遗漏是上方 blocker 的横幅路径。)
- **assemble.ts 错误路径**:catch 中 `checkpointer?.db.close()` + `memoryStore.close()`,无泄漏、无双关。
- **测试/构建/lint**:独立重跑 `pnpm test` = **419/419 passed(44 files)**;`pnpm build`/`pnpm lint` exit 0。
- **改动范围**:`git diff --stat` 与自述一致;`test-report.md` 为未跟踪文件、含 R1+R2、Cypher 未动;`runner.ts` +36 为 A5 `getPendingInterrupt` 支撑代码,非超范围。

### 七道门(R3)
需求贴合 [✗ — P1-4 横幅残留] · 影响范围 [✓] · 占位符拒收 [✓] · 危险代码 [✓] · 幻觉核查 [✗ — 自述「P1-4 清洗已补齐」与代码不符,严重度低但属实] · 文档齐套 [✓] · 文档同步(大设计级)[N.A.]

### 📚 知识库(核对,不维护)
触及已索引模块 [是] · 对照 `aeloop.md` [✓ 大体准,`ClaudeCliAdapter` P0-1 订正三方一致] · 漂移 [部分 — `aeloop.md:167`「runList 补齐 P1-4」因横幅残留略不准,随 R4 返工同步即可]

### 返工清单(交 Cypher,预计 R4 一行 + 一测即绿)
1. `src/cli/main.ts:201` — 横幅里 `${currentCwd}` 改为 `${stripControlSequences(currentCwd)}`(或抽已清洗局部量)。
2. `src/cli/__tests__/main.test.ts` — 补一条:list 不匹配横幅文本不含 ESC 字节(断言需 scope 到横幅内容或先剥 chalk)。
3. `CHARTS/knowledge/aeloop.md:167` — 同步「runList P1-4 清洗已补齐」表述。
