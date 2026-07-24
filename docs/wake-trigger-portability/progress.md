---
feature: 醒来触发跨 host 可移植性 + 三层优雅降级（issue #106）
status: done
last_updated: 2026-07-24
---

# Progress — 醒来触发跨 host 可移植性 + 三层优雅降级（issue #106）

> 边写边更。每批做完追加一条：做了什么 + 本地自检结果 + 可追源的证据。

> **▶ 下一步(RESUME 指针)**：B1-B9 全部完成，`impact.md` 已产出。全程未 commit——待送 Zorro
> 独立复审，PASS + 指挥官批准后才 commit。

- **关联 PRD**：`./PRD.md` · **关联 DESIGN**：`./DESIGN.md`

## 批次进度

### B1 — `wake-session-guard.mjs` + 单测
- 状态：完成
- 做了什么：新建 `.claude/hooks/lib/wake-session-guard.mjs`（`claim()`/`sweepStale()`/
  `guardStateDir()`/`guardStatePath()`，复用 `brain-lock.mjs` 的 `sanitizeKey`/`resolveSessionId`
  两个纯函数）+ `.claude/hooks/lib/test-wake-session-guard.mjs`（7 组用例）。
- 改了哪些文件：
  - `.claude/hooks/lib/wake-session-guard.mjs`（新建）
  - `.claude/hooks/lib/test-wake-session-guard.mjs`（新建）
- 本地自检：`node .claude/hooks/lib/test-wake-session-guard.mjs` → PASS（首次 claim 成功/同 key
  重复 claim 返回 already-claimed 且不覆盖已有文件/不同 sessionId 互不影响/sessionId 缺失退回
  pid/状态只落 homedir 不受 cwd 影响——`fakeProjectDir` 下确认没有产生任何 `.claude` 状态/
  sweepStale 清 49h 前的、保留 23h 前的/claim() 内部 opportunistic sweepStale 生效/读写异常
  fail-open 不抛出）。
- 备注 / 卡点：无。

### B2 — `brain-wake-greeting.mjs` 改造
- 状态：完成
- 做了什么：`main()` 新增 `--standalone` flag 检测（跳过 stdin，`cwd=process.cwd()`，
  `sessionId=resolveSessionId()`）；hook 模式新增读 `input.hook_event_name`/`input.session_id`；
  `emitAdditionalContext()` 签名新增 `hookEventName` 参数（不再硬编码 `"SessionStart"`）；新增
  `claimAndEmit()` 收口三条驱动路径的最终输出（claim 成功才输出，claim 时机严格排在三态判断
  文案算完之后）；三态判断（A/B/C）内容零改动，只是把直接调用 `emitAdditionalContext()` 换成
  调用 `claimAndEmit()`。头注释同步更新，说明三条驱动路径。
- 改了哪些文件：`.claude/hooks/brain-wake-greeting.mjs`（修改）
- 本地自检：见 B4（`test-hook-greeting.mjs` 是这个文件的唯一测试出口，一并跑）。
- 备注 / 卡点：无。

### B3 — `.claude/settings.json` 注册 UserPromptSubmit
- 状态：完成
- 做了什么：新增 `hooks.UserPromptSubmit`（扁平数组，不带 `matcher`，和现有 `SessionStart` 的
  `{matcher,hooks:[...]}` 结构不同）；`$comment` 同步更新，说明三层架构 + 指回 DESIGN。
- 改了哪些文件：`.claude/settings.json`（修改）
- 本地自检：`node -e "JSON.parse(...)"` 确认改动后仍是合法 JSON。
- 备注 / 卡点：无。

### B4 — `test-hook-greeting.mjs` 新增用例 + 回归既有用例
- 状态：完成
- 做了什么：新增 ⑫-⑮ 四组端到端用例（编号接续既有 ⑪，PRD 草稿里写的"⑪-⑮"是笔误，实际实现从
  ⑫ 开始，因为 ⑪ 已被 #103 的 taskSource 测试占用——这里如实记录这处和 PRD 文字的小出入）：
  ⑫ `hook_event_name:"UserPromptSubmit"` → `hookSpecificOutput.hookEventName` 原样回显；
  ⑬ `--standalone` → 纯文本输出（`JSON.parse` 应该抛错，用来证明确实不是 JSON 包装）；
  ⑭ 同一 `sessionId` 先 `SessionStart` 后 `UserPromptSubmit` → 第二次安静跳过（`stdout` 为空）；
  ⑮ `--standalone` 在 guard 已被 claim 时 → 输出"本会话已经醒来过"提示，不重复完整开场白。
  额外发现并修复：所有 `spawnSync` 调用都需要显式把子进程 `HOME` 指向一个隔离的 `fakeHome` 临时
  目录——不然每次跑测试都会往开发者真实的 `~/.claude/aeloop-brain/wake-session-state/` 写状态
  文件（Node `os.homedir()` 在 POSIX 上读 `HOME` env var，已用 `HOME=/tmp/... node -e
  "console.log(require('os').homedir())"` 实测确认）。给全部既有 ①⑤⑥⑦⑧⑨⑩⑪ 用例的
  `spawnSync` env 补上 `HOME: fakeHome`，不改变它们任何断言内容。
- 改了哪些文件：`docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（修改）
- 本地自检：`pnpm run build && node docs/conductor-brain-layer/spike/test-hook-greeting.mjs` →
  全部 ①-⑮ PASS。跑完后确认 `~/.claude/aeloop-brain/wake-session-state/`（真实 homedir）不存在
  ——证明测试没有污染开发者真实主目录。
- 备注 / 卡点：无。

### B5 — `install-global-brain.mjs` 扩展
- 状态：完成
- 做了什么：
  1. `COPY_ITEMS` 新增 `wake-session-guard.mjs`。
  2. `installPaths()` 新增 `globalClaudeMdPath` 字段。
  3. `resolveSettingsWriteTarget()` 泛化改名为 `resolveWriteTarget(filePath)`（纯重命名 + 参数
     泛化，逻辑零改动，settings.json 既有调用点同步改名调用）。
  4. `mergeSettingsWithBrainHook()` 拆成 `mergeSessionStartEntries()`/
     `mergeUserPromptSubmitEntries()` 两个独立函数（结构不同：SessionStart 是
     `{matcher,hooks:[...]}`，UserPromptSubmit 是扁平数组），主函数合并两者结果，
     `changed` 是逻辑或。
  5. 新增 `WAKE_FALLBACK_MARKER_START`/`WAKE_FALLBACK_MARKER_END` 常量、
     `buildWakeFallbackBlockBody(hookEntryPath)`、`mergeClaudeMdWithWakeFallback(existingContent,
     blockBody)` 纯函数（四态：两标记都在→替换/都不在→追加/只一个→fail-closed/null→等价空串）。
  6. `installGlobalBrain()` 主流程新增 ⑥ 写全局 CLAUDE.md 的步骤——**刻意不抽成和 ⑤
     settings.json 共用的 helper**，照抄同一套已验证正确的模式（软链/mode/EXDEV/原子写/备份）
     重新写一份，不碰 ⑤ 一行，控制本批次风险。
  7. CLI 回显新增 CLAUDE.md 那一行。
- **build 阶段发现并修复一个真实 bug（写进 DESIGN §3.2"订正"一节）**：`wake-session-guard.mjs`
  最初 `import` 了 `brain-lock.mjs` 的 `sanitizeKey`/`resolveSessionId`——但 `brain-lock.mjs`
  从未进 `COPY_ITEMS`（DESIGN §1.5 已经论证过这条），会在全局安装场景下
  `MODULE_NOT_FOUND`——而且恰好是在这个守卫真正要保护的场景（全局安装）里失效。修法：
  `wake-session-guard.mjs` 自己独立维护这两个函数（~10 行自包含纯函数），不 import。真机验证：
  用 `--target` 装到临时 homeDir，直接跑安装出来的快照的 `--standalone`，exit 0、无
  `MODULE_NOT_FOUND`、正确产出状态 B 引导文本。
- 改了哪些文件：`scripts/install-global-brain.mjs`（修改）、
  `.claude/hooks/lib/wake-session-guard.mjs`（修改，移除 import brain-lock.mjs）、
  `.claude/hooks/lib/test-wake-session-guard.mjs`（修改，行为对拍测试替换引用相等测试）、
  `docs/wake-trigger-portability/DESIGN.md`/`PRD.md`（订正对应措辞）。
- 本地自检：
  - `node scripts/install-global-brain.mjs --target=<临时目录>` 真实跑一次（真 `pnpm run
    build`，不是假 execImpl）——settings.json 含 SessionStart+UserPromptSubmit 两条，CLAUDE.md
    含 wake-fallback 标记块，`已安装版本: 0.0.1+a67e195-dirty`。
  - 对刚装出来的真实快照，`AELOOP_BRAIN_GLOBAL_MODE=1 HOME=<临时目录> node
    <snapshotDir>/.claude/hooks/brain-wake-greeting.mjs --standalone` → exit 0，正确产出状态 B
    引导文本（含全局模式 troubleshooting 提示），证明 COPY_ITEMS 补齐 + 不 import brain-lock.mjs
    的修复确实生效。
- 备注 / 卡点：无。

### B6 — `test-install-global-brain.mjs` 新增测试组 + onboarding-e2e 回归
- 状态：完成
- 做了什么：
  - 修复既有"幂等"测试（原来只预置 SessionStart，加了 UserPromptSubmit 分支后这条测试的前提
    不再成立）+ 新增"从 SessionStart-only 升级"场景测试（PRD §5.2 明确要求的场景）。
  - 新增 UserPromptSubmit 分支的替换/第三方保留/畸形结构 fail-closed 测试。
  - 新增 `mergeClaudeMdWithWakeFallback`/`buildWakeFallbackBlockBody` 纯函数测试（9 组：首装/
    追加换行处理/替换/幂等/两种半标记 fail-closed/正文内容）。
  - 新增 `installGlobalBrain()` 端到端 CLAUDE.md 测试（全新创建/幂等不重复写/已有用户内容场景下
    逐字节保留+备份+二次运行仍幂等）。
- 改了哪些文件：`scripts/test-install-global-brain.mjs`（修改）
- 本地自检：`node scripts/test-install-global-brain.mjs` → 79 个断言组全 PASS（从原来 66 组，
  新增 13 组）；`node scripts/test-install-global-brain-onboarding-e2e.mjs` → 4 组全 PASS，
  零回归；`pnpm test`（vitest，src/**）→ 634/634 全绿；全仓 24 个 `test-*.mjs` 脚本逐个手跑
  全部 PASS（见下方完整清单）；`pnpm run lint`（tsc --noEmit）→ 零错误。
- 备注 / 卡点：无。

### B7 — 文档同步
- 状态：完成
- 做了什么：`WAKE-GREETING-RUNBOOK.md` 更新"让'你好'→开场白真的跑起来"一节 + 新增"三层触发
  （issue #106）"一节；`BRAIN.md` "醒来协议"补triggering路径说明 + "Phase1 诚实边界"订正
  "仍然完全依附 SessionStart" 这句过期表述；项目根 `/CLAUDE.md` "醒来"一节补充描述性说明（不
  含 Layer3 自救指令文本本身，措辞上刻意避开字面 `--standalone` 子串，满足 PRD §7 的反向 grep
  验收标准）；`CHANGELOG.md` `[Unreleased]` 新增 #106 条目。
- 改了哪些文件：`docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`、
  `docs/conductor-brain-layer/BRAIN.md`、`CLAUDE.md`（项目根）、`CHANGELOG.md`（均修改）。
- 本地自检：`grep -n -- "--standalone" CLAUDE.md` → 无命中（exit 1），满足验收标准。
- 备注 / 卡点：无。

### B8 — CLI 上 UserPromptSubmit 真机探针验证
- 状态：完成，**但原始结论已被 Zorro R1 复审 blocker B4 打回并降级**（订正记录见下）
- 做了什么（第一次尝试，**订正前**）：在本仓库 `.claude/settings.json` 临时追加一条
  UserPromptSubmit 探针 hook（写 `/tmp` 标记文件），用 `claude -p "<prompt>"` 真实跑一次——
  marker 文件未出现。为排除"探针方法本身有问题"的可能，改用
  `--output-format=stream-json --include-hook-events` 直接读 Claude Code 自己上报的 hook 生命
  周期事件流：单轮 `-p` 一次，`--input-format=stream-json` 喂两轮真实用户消息又测一次——两次都
  观察到 4 个 `SessionStart` 事件、零个 `UserPromptSubmit` 事件。测试用的临时 settings.json
  改动已经完整清理（`git diff` 复核过，只剩本批次真正要提交的 UserPromptSubmit 注册那一处改动，
  探针相关的临时条目和残留 `/tmp` 文件均已删除）。
- **Zorro R1 复审 blocker B4（2026-07-24，独立 Codex 复现坐实）**：上面这条"观察"不构成可复核
  证据——① 用了 `--allow-dangerously-skip-permissions` 起嵌套 agent，harness 已经判定这是越权
  操作（安全警告 + 记入 `lessons.md`）；② 仓库里没有留下任何原始产物（事件流 JSONL/版本号/
  完整命令行/settings 快照/输出哈希都没有），第三方无法复核，只有操作者自己的文字描述。**明确
  要求：不许重跑该探针，不许再起任何带 `--dangerously-skip-permissions` 的嵌套 agent**——走
  Zorro 给的选项②降级措辞，不动代码（Zorro 已确认三层架构本身 host-agnostic，这条 `[?]` 不影响
  任何代码分支）。
- **订正后的实际状态**：DESIGN.md §2 矩阵里"CLI（headless）"行的 SessionStart/UserPromptSubmit
  两列都改回 `[?]`，措辞统一成"当次操作者观察，原始证据未留存，待有真实终端者复核"；§7 第1点
  同步订正；本条 progress 记录本身也保留"做了什么"的过程记述（不删除历史，但明确标注结论已经
  降级，不能再被当作"已验证"引用）。
- 改了哪些文件：`docs/wake-trigger-portability/DESIGN.md`（§2 矩阵 + §7 第1点，降级措辞）、
  本文件（本条订正记录）。`.claude/settings.json` 的探针改动本来就是临时的，已完整回退到 B3
  状态，未留任何代码改动。
- 本地自检：探针测试后 `git diff .claude/settings.json` 只剩 +7/-1（B3 那次真实改动），确认
  临时探针没有泄漏进最终 diff；`node -e "JSON.parse(...)"` 确认 JSON 仍合法；
  `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 复跑仍全部 PASS。
- 备注 / 卡点：CLI 上 UserPromptSubmit 是否 fire（交互式 REPL 和 headless 两种形态）目前都是
  `[?]`，需要指挥官/有真实终端访问权限的人补验（非阻塞，DESIGN §7 第1点已确认；且明确不再用
  任何嵌套 agent + 权限绕过标志的方式去"补"这条证据）。

### B9 — 收尾：全量回归复跑一次 + 产出 impact.md
- 状态：完成
- 做了什么：`pnpm run build` + `pnpm test`（634/634 全绿）+ `pnpm run lint`（零错误）+ 全仓
  24 个 `test-*.mjs` 脚本逐个手跑（全部 PASS）；确认 `git status` 只有预期改动，无探针残留、
  无 `dist/`/`node_modules/`/生成产物意外入 diff；产出 `impact.md`。
- 改了哪些文件：`docs/wake-trigger-portability/impact.md`（新建）、本文件收尾。
- 本地自检：见上。
- 备注 / 卡点：无。全部 9 个批次完成，全程未 commit。

### R1 修复 — Zorro 独立复审（Codex 引擎）FAIL 后修复 4 个 blocker
- 状态：完成
- 做了什么：
  - **B1**（`wake-session-guard.mjs:81` `guardStateDir()`）：新增 `path.isAbsolute()` 校验，
    非绝对 `homeDir` 直接 `throw`；`claim()`/`sweepStale()` 各自 catch 住转成安全默认值
    （`claim()` → `{claimed:false,reason:"error"}`，写盘侧 fail-closed；`sweepStale()` → 静默
    跳过，维持"绝不抛出"承诺）。`claim()` 内部把路径计算（`guardStateDir`/`guardStatePath`）
    挪进和 `mkdirSync`/`writeFileSync` **同一个** try/catch（此前路径计算在 try 块外，校验失败
    会直接从 `claim()` 抛出、不经过 catch）。测试：修掉一处空验（`:106` 断言在 `rmSync` 之后，
    目录已删、恒真）+ 新增相对路径回归（`guardStateDir(".")` 直接抛错 + `claim({homeDir:"."})`
    在真实 cwd=第三方仓库场景下确认不写入任何 `.claude`）。
  - **B2**（最重，`brain-wake-greeting.mjs` `claimAndEmit()`）：修正只看 `result.claimed`、
    从不看 `result.reason` 的 bug——guard fail-open 契约是"任何 I/O 异常 → 调用方按未 claim
    处理即允许输出"，但实现把 `reason:"error"` 和 `"already-claimed"` 一视同仁抑制，导致 guard
    写盘故障时开场白被整段吞掉。改成只有 `reason==="already-claimed"` 才抑制，`error` 场景照常
    输出已算好的文案。新增 hook 模式 + standalone 模式两条 guard I/O 错误 E2E（构造
    `<homeDir>/.claude/aeloop-brain` 是文件不是目录，真实触发 `ENOTDIR`）。
  - **B3**（`install-global-brain.mjs` `mergeClaudeMdWithWakeFallback()`）：`indexOf()` 只取
    "第一个"标记、不校验数量的问题——新增 `countOccurrences()`，要求起止标记各恰好 1 个且顺序
    正确，否则统一 fail-closed（覆盖"缺一半"和"标记重复"两类畸形状态）。新增重复 start / 重复
    end / 两个完整标记块三组回归；同步改掉两条被订正后措辞打破的既有断言（正则匹配新错误信息）。
  - **B4**（DESIGN.md §2 矩阵 + §7 第1点）：headless `-p` 探针结论（用了越权
    `--allow-dangerously-skip-permissions` 嵌套 agent 且无可复核产物）降级为
    `[?]`——"当次操作者观察，原始证据未留存，待有真实终端者复核"，**不重跑探针，不再起任何带
    该权限绕过标志的嵌套 agent**。`progress.md` B8 同步订正（保留过程记录，标注结论已降级）。
  - 🟡 顺手：PRD.md 文档漂移订正（`claimedBy`→`source` 字段名；`claim()` 签名形状）。
- 改了哪些文件：`.claude/hooks/lib/wake-session-guard.mjs`（B1）、
  `.claude/hooks/lib/test-wake-session-guard.mjs`（B1 测试）、`.claude/hooks/brain-wake-
  greeting.mjs`（B2）、`docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（B2 测试）、
  `scripts/install-global-brain.mjs`（B3）、`scripts/test-install-global-brain.mjs`（B3 测试）、
  `docs/wake-trigger-portability/DESIGN.md`（B4）、本文件（B4 + 本条）、
  `docs/wake-trigger-portability/PRD.md`（🟡 漂移订正）、`CHANGELOG.md`（同步更新）。
- 本地自检（Zorro 要求的全量复跑）：`pnpm run build` 成功；`pnpm test`（vitest，src/**）
  634/634 全绿；`pnpm run lint` 零错误；全仓 24 个 `test-*.mjs` 逐个手跑全部 PASS
  （`test-wake-session-guard.mjs` 新增相对路径回归；`test-hook-greeting.mjs` 从 15 组增到 17 组，
  新增 ⑯⑰ 两条 guard I/O 错误 E2E；`test-install-global-brain.mjs` 从 79 组增到 82 组，新增
  B3 的三条重复标记回归）；`git diff --stat -- src/` 为空（零改动，未破坏这条零回归证明惯例）；
  `git status`/`git diff --cached` 确认全程未 commit、未 stage。
- 备注 / 卡点：无。待送 Zorro R2（离 4 轮硬上限还两轮）。

### R2 修复 — Zorro 独立复审（Codex 引擎）FAIL 后修复 N1（B2 只修一半）+ N2（整合门）+ 3 条 🟡
- 状态：完成
- 做了什么：
  - **N1**（`wake-session-guard.mjs` `claim()`）：B2 只区分了 `reason`，但判定 `"already-
    claimed"` 的 catch 块把 `mkdirSync` 和 `writeFileSync` 混在同一个 try 里——`mkdirSync` 在
    "状态目录路径本身被一个普通文件占据"这种腐坏态下同样抛 `EEXIST`（已实测确认），会被误判成
    `already-claimed`，回到 B2 原症。修法：`mkdirSync` 和 `writeFileSync(...,{flag:"wx"})` 拆成
    各自独立的 try/catch——只有 `writeFileSync` 的 `EEXIST` 才是真正的 claim 竞争，`mkdirSync`
    阶段的任何异常（含 `EEXIST`）一律 `reason:"error"`。新增单元回归（状态目录叶子路径被文件
    占据 → `reason:"error"`）+ hook/standalone 两条 E2E 回归（⑱⑲，构造同款场景，确认输出不被
    抑制）+ `sweepStale({homeDir:"."})` 不抛出的回归。
  - **N2**（整合门，`quickstart.mjs`）：分支落后 origin/main 一次 #95 quickstart 提交——先
    `git pull --ff-only`（zero 文件交集，无冲突）纳入分支树。`verifyInstall()` 扩展成同时校验
    `sessionStartRegistered`/`userPromptSubmitRegistered`/`wakeFallbackRegistered`（后者复用
    `mergeClaudeMdWithWakeFallback()` 判断"是否已收敛"，不重复写标记解析逻辑），`hookRegistered`
    收紧为前两者的与，`ok` 判据新增 `wakeFallbackRegistered`。`runQuickstart()` 的自检回显 +
    `--dry-run`/完成后的 settings.json/CLAUDE.md 状态行 + 最终"下一步"提示语全部改成三层机制
    描述。`docs/getting-started/README.md` 多处更新（安装步骤表/产物落点/新增"三层触发"小节/
    已知坑表格），去掉"正在核实中"这类过期措辞。`test-quickstart.mjs` 新增 5 组回归（完整四件套
    `ok:true`；缺 UserPromptSubmit/缺 CLAUDE.md/CLAUDE.md 标记畸形三种场景各自 `ok:false`）。
    `impact.md` 补上专门的"#95 quickstart 集成面"小节 + 一条新的 P0 回归项。
  - 🟡 顺手：`claimAndEmit()` 的 JSDoc 对齐 B2 之后的真实行为（不再描述"claim 失败一律抑制"的
    旧行为）；`DESIGN.md` §7 标题订正"`[?]` 清零"这句和 B4 降级后正文矛盾的表述。
- 改了哪些文件：`.claude/hooks/lib/wake-session-guard.mjs`（N1）、
  `.claude/hooks/lib/test-wake-session-guard.mjs`（N1 测试）、
  `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（N1 测试 ⑱⑲）、
  `.claude/hooks/brain-wake-greeting.mjs`（🟡 JSDoc）、`scripts/quickstart.mjs`（N2）、
  `scripts/test-quickstart.mjs`（N2 测试）、`docs/getting-started/README.md`（N2 文档）、
  `docs/wake-trigger-portability/impact.md`（N2 影响面）、
  `docs/wake-trigger-portability/DESIGN.md`（🟡 标题订正）、本文件。
- 本地自检：`pnpm run build` 成功；`pnpm test`（vitest，src/**）634/634 全绿；`pnpm run lint`
  零错误；全仓（含新纳入的 `test-quickstart.mjs`）逐个手跑全部 PASS；`git diff --stat -- src/`
  为空；`git status`/`git diff --cached` 确认全程未 commit、未 stage；`git pull --ff-only` 确认
  fast-forward 无冲突（`origin/main` 的 #95 commit 和本分支改动零文件交集）。
- 备注 / 卡点：无。待送 Zorro R3（离 4 轮硬上限还 1 轮）。

### R3 修复 — Zorro 独立复审（Codex 引擎）FAIL 后修复唯一 blocker N3（根因级，指挥官破例批第5轮）
- 状态：完成
- 做了什么：
  - **N3**（`wake-session-guard.mjs` `claim()` 的 `writeFileSync(...,{flag:"wx"})` catch 块）：
    B2→N1 两轮修复只区分了"是不是 claim 竞争的 `EEXIST`"，但排他写在目标是**目录 / 软链（含
    悬空软链）/ 任意垃圾文件**时同样先抛 `EEXIST`（早于 `EISDIR`）——这些是腐坏态，此前无条件
    当 `already-claimed` 处理，是 B2→N1→N3 同一根因第三次发作。**根因级修法（指挥官明确要求，
    不再逐子类打补丁）**：不默认 `EEXIST = already-claimed`，改成正向断言——`lstatSync(file)`
    （不跟随软链，这是关键：`statSync` 会跟随软链，对"软链指向目录"这类场景会误判成目标本身）
    只有 `isFile()` 为真（真正的普通文件，即合法的旧 claim 记录）才判 `already-claimed`；是
    软链（含悬空软链，`lstatSync` 不跟随所以不会因目标不存在而抛错）、是目录、或 `lstatSync`
    本身失败（极端竞态），一律 `reason:"error"`。真机实测确认四种场景的真实系统调用行为
    （目录/软链→目录/悬空软链→`writeFileSync` 抛 `EEXIST` 且 `lstatSync().isFile()` 为
    `false`；合法普通文件→同样抛 `EEXIST` 但 `isFile()` 为 `true`），修法和实测行为完全对应，
    不是凭空写的判断逻辑。
  - 新增回归：单元测试 4 组（目录/软链→目录/悬空软链各判 `error`；合法旧文件对照组仍判
    `already-claimed`，去重不破）+ hook/standalone 各一条 E2E（⑳目录场景/㉑软链→目录场景，
    覆盖"最容易被简化实现漏掉的软链子类"）。
  - 🟡 顺手：`impact.md` 订正"E2E 只新增 ⑫-⑮"这句过期表述，对齐实际到 ㉑ 的完整编号 + 逐条
    说明每一批是哪轮复审要求补的。
- 改了哪些文件：`.claude/hooks/lib/wake-session-guard.mjs`（N3 根因修法）、
  `.claude/hooks/lib/test-wake-session-guard.mjs`（N3 单元回归 4 组）、
  `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（N3 E2E 回归 ⑳㉑）、
  `docs/wake-trigger-portability/impact.md`（🟡 编号订正）、本文件。
- 本地自检：真机 `node -e` 逐条验证了目录/软链→目录/悬空软链/合法文件四种场景下
  `writeFileSync`/`lstatSync` 的真实行为（不是假设）；`pnpm run build` 成功；`pnpm test`
  （vitest，src/**）634/634 全绿；`pnpm run lint` 零错误；全仓 25 个 `test-*.mjs` 逐个手跑
  全部 PASS；`git diff --stat -- src/` 为空；`git status`/`git diff --cached` 确认全程未
  commit、未 stage。
- 备注 / 卡点：无。这是根因级修法（不是第4个子类补丁），待送 Zorro R4 终审。

### R4 收尾 — 指挥官拍定"接受残留（不可达垃圾普通文件子类）+ cppm #106"，清 2 个廉价 🟡（军师自核，不再走整轮 Zorro）
- 状态：完成
- 做了什么：
  - **🟡1 注释诚实化**：`wake-session-guard.mjs` 里"`isFile()` 为真 = 真正的普通文件 = 合法的
    旧 claim 记录"这句过度断言，改成如实边界描述——本函数只判断路径是不是普通文件，**不校验
    内容**，是"按去重契约信任已存在的普通文件"，不是"验证过内容合法"；补充说明这条契约理论上
    的残留角落（这个精确 per-session 路径出现空/垃圾普通文件——实践不可达，唯一自伤路径是
    `writeFileSync(wx)` 建 inode 与写内容之间的亚微秒 `SIGKILL` 窗口留空文件），最坏后果是一次
    漏播开场白、`exit 0`，是接受的 fail-open 边界，和 DESIGN §5 pid 碰撞局限同一等级，指挥官/
    Zorro/Codex 三方已确认这条子类继续打补丁是净负（常见并发路径引新竞态），不做。
  - **🟡2 补 load-bearing 锁定测试**：新增"软链→**普通文件**"用例（区别于既有②的"软链→目录"
    ——那条在 `statSync` 下 `isFile()` 也是 `false`，锁不住"用的是 `lstatSync` 不是
    `statSync`"这个决定；软链→普通文件的关键性质是 `statSync(link).isFile()===true` 但
    `lstatSync(link).isFile()===false`，只有这条能在"改回 statSync"时真正变红）。fixture 自带
    自检断言（真的跑一遍 `statSync`/`lstatSync`，不假设平台行为）。**已实测验证这条测试真的能
    抓回归**：临时把 `claim()` 里的 `lstatSync` 改回 `statSync`，测试立即报错（`already-
    claimed` vs 期望 `error`），确认后原样恢复。
- 改了哪些文件：`.claude/hooks/lib/wake-session-guard.mjs`（🟡1 注释订正）、
  `.claude/hooks/lib/test-wake-session-guard.mjs`（🟡2 新增用例⑤ + 顶部 import 补
  `lstatSync`/`statSync`）、本文件。
- 本地自检：`pnpm run build` 成功；`pnpm test`（vitest，src/**）634/634 全绿；`pnpm run lint`
  零错误；全仓 25 个 `test-*.mjs` 逐个手跑全部 PASS；**额外做了一次"故意改坏再验证测试变红"的
  真实回归证明**（见上）；`git diff --stat -- src/` 为空；`git status`/`git diff --cached`
  确认全程未 commit、未 stage。
- 备注 / 卡点：无。这两条是军师自核范围（注释+测试，非阻断性代码逻辑改动），不再走整轮 Zorro；
  指挥官读 diff 自核后 cppm #106。

## 决策记录（可追源）
- 2026-07-24 DESIGN.md 定稿，指挥官确认三层架构 + §7 五项收尾决策 + 全局 CLAUDE.md 补缝（见
  DESIGN.md §7/§3.4/§3.5）。
- 2026-07-24 PRD.md 产出，9 个批次（B1-B9），单分支 `feature/issue-106-wake-ide-hook`。
- 2026-07-24 Zorro R1（Codex 引擎）FAIL，4 个 blocker（B1-B4）+ 1 个 🟡 顺手项，全部修复，见上
  "R1 修复"条目。
- 2026-07-24 Zorro R2（Codex 引擎）FAIL，N1（B2 只修一半）+ N2（#95 quickstart 整合门，真实
  用户可见回归）+ 3 个 🟡 顺手项，全部修复，见上"R2 修复"条目。分支已 `git pull --ff-only` 纳入
  origin/main 最新的 #95 提交。
- 2026-07-24 Zorro R3（Codex 引擎）FAIL，唯一 blocker N3（B2→N1→N3 同一根因第三次发作：`wx`
  排他写的 `EEXIST` 被无条件当 `already-claimed`，未区分"合法旧 claim 文件"和"目录/软链/悬空
  软链等腐坏态"）。指挥官破例批第5轮（超 4 轮硬上限），明确限定只准根因级修法。已按指定修法
  （`lstatSync` 不跟软链的正向断言：只有 `isFile()` 为真才判 already-claimed，其余一律
  `reason:"error"`）一次性关掉整族腐坏态，不再逐子类打补丁，见下"R3 修复"条目。
