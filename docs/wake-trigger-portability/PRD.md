# PRD — 醒来触发跨 host 可移植性 + 三层优雅降级（issue #106）

- **项目**: aeloop
- **分支**: `feature/issue-106-wake-ide-hook`
- **优先级**: P1
- **设计权威**: `docs/wake-trigger-portability/DESIGN.md`（指挥官已确认，2026-07-24——架构/跨 host
  矩阵/共享守卫/全局 CLAUDE.md 合并机制的完整论证都在那份文档，本 PRD 不重复论证，只列怎么落地
  + 逐文件任务 + 批次 + 验收）
- **状态**: 待指挥官确认开工（DESIGN 已确认，PRD 待过目）
- **最后更新**: 2026-07-24

---

## 1. 问题 / 用户 / 方案

- **要解决的问题**：整套醒来机制（#84/#88/#93/#96）目前只靠 `SessionStart` hook 触发，真机验证
  该 hook 在 VSCode 扩展里不 fire——醒来+人格加载在指挥官主力 IDE 环境完全失效，模型会脑补身份，
  绕过防幻觉红线（#106 原始诊断）。
- **给谁用**：所有跑 aeloop conductor-brain 层的用户（个人版 Helix 场景 + 企业版场景，#103），
  尤其是主力在 IDE（不是纯终端）里工作的用户。
- **一句话方案**：把触发点从"赌 SessionStart 一个事件"升级成三层（SessionStart + UserPromptSubmit
  + CLAUDE.md 自觉兜底网），靠一个跨 host 共享的会话级守卫保证不重复注入，DESIGN 已把架构/守卫/
  全局安装扩展全部定盘。

## 2. 目标 / 非目标

**目标**：
- CLI 环境继续靠 `SessionStart`（Layer1，现状不变）。
- IDE/未知 host 环境新增 `UserPromptSubmit`（Layer2）作为主力触发路径。
- 两层硬机制都未被观察到已注入时，CLAAUDE.md 指令驱动模型自己跑 `--standalone` 兜底（Layer3），
  落点是全局 `~/.claude/CLAUDE.md`，不是项目级。
- 三层共享同一个 `session_id`-keyed（Layer1/2 可靠共享）/尽力而为（Layer3）的守卫，保证一次会话
  只真正注入一次开场白。
- `install-global-brain.mjs` 同步扩展：新注册 UserPromptSubmit hook + 新管理全局 `CLAUDE.md`
  的 `wake-fallback` 标记块，两者都是 merge-not-overwrite，绝不覆盖用户已有内容。

**非目标（明确不做，抄 DESIGN §8，不重复论证，只落地清单）**：
- 不重新设计开场白内容本身（#96 三态渲染/防幻觉红线一个字不动）。
- 不做"CLAUDE.md 软路径当主力"——已被 Layer1/2 硬机制覆盖的场景不退化。
- 不删除现有 Layer1（SessionStart）注册。
- 不补齐 JetBrains/桌面 App/Web 真机验证（非阻塞，Layer3 已覆盖不确定性）。
- 不引入新并发锁基础设施（不移植 `brain-lock.mjs` 心跳续期，一次性 `O_EXCL` claim 够用）。
- 不把 Layer3 自救指令写进 aeloop 项目自己的 `/CLAUDE.md`（落点固定全局，项目级最多描述性一句）。
- 不实现 #105（uninstall-global-brain）本身——只确保新增的 `wake-fallback` 标记块可被未来的
  卸载逻辑识别摘除，不留坑。
- 不在本次批次里做 Layer3 触发严格度以外的产品化提示（不主动告知用户"在软路径兜底"，§7 第4点）。

## 3. 用户故事

- 作为一个在 VSCode 扩展里工作的 operator，我想让 aeloop 在每次会话开始（或至少第一句话回复前）
  真的用身份库数据"醒来"，而不是模型脑补一段假的开场白，以便我能信任这套记忆系统真的在生效。
- 作为一个刚跑完 `install-global-brain.mjs` 的新用户，我想在任意项目（不只 aeloop 自己）都自动
  获得这套三层醒来保护，而不用逐项目手动配置。
- 作为 aeloop 的维护者，我想有一份可复现的真机证据（CLI 上 UserPromptSubmit 是否 fire），而不是
  永远停留在"假定成立"。

## 4. 数据模型（如涉及）

不涉及 `src/context/store.ts` 的 SQLite schema——本需求全部落在 hook 触发层/安装器层，不碰身份库
本身的数据模型。新增的是**文件系统状态**（不是数据库记录）：

- `~/.claude/aeloop-brain/wake-session-state/<sanitized-key>.json`——会话级 claim 记录，
  schema：`{ schemaVersion: 1, sessionId: string|null, pid: number, source: "SessionStart"|"UserPromptSubmit"|"standalone", claimedAt: string(ISO) }`
  （**订正，Zorro R1 复审 🟡 finding**：字段名是 `source`，不是本文档草稿阶段写的
  `claimedBy`——实现签名为准，见下方 §5.1 表格，本条已同步改正）。
- `~/.claude/CLAUDE.md` 内新增的 `<!-- aeloop-brain:wake-fallback -->` … `<!-- /aeloop-brain:wake-fallback -->`
  标记块（纯文本，不是结构化数据）。

## 5. 逐文件任务清单

### 5.1 新建文件

| 文件 | 改动 | 依赖 |
|---|---|---|
| `.claude/hooks/lib/wake-session-guard.mjs`（**新建**） | 导出 `claim({sessionId, pid, source}, {homeDir, now})`（**订正，Zorro R1 复审 🟡 finding**：实际签名是两个独立参数对象——第一个是身份信息 `{sessionId,pid,source}`，第二个是选项 `{homeDir,now}`，本文档草稿阶段写的 `claim(toplevelIrrelevant, {sessionId,pid,source})` 单参数形状不准确，已按实现改正；语义不变：状态落 homedir，不吃 toplevel 参数——这是和 `brain-lock.mjs` 的关键差异，DESIGN §1.5/§3.2 已论证）、`sweepStale({homeDir,now,maxAgeMs=48h})`、`guardStateDir(homeDir)`、`guardStatePath({sessionId,pid},{homeDir})`。`claim()` 内部：① 先 `sweepStale()`（opportunistic，异常吞掉不影响主流程）② 在**同一个** try/catch 里计算路径（`guardStateDir`/`guardStatePath`）+ `mkdirSync(dir,{recursive:true})` + `writeFileSync(path, JSON.stringify(record), {flag:"wx"})`——成功返回 `{claimed:true}`；`EEXIST` 返回 `{claimed:false, reason:"already-claimed"}`；其它任何异常（含路径校验失败）返回 `{claimed:false, reason:"error"}`（fail-open，调用方按"未 claim"处理，即允许输出——DESIGN §3.2"失败模式"）。**Zorro R1 复审 blocker B1 订正**：`guardStateDir(homeDir)` 新增非绝对路径 fail-closed 校验（`path.isAbsolute()`），非绝对路径直接 `throw`，`claim()`/`sweepStale()` 各自 catch 住转成安全默认值——不允许相对 `homeDir` 静默把状态落进 cwd（可能是目标第三方项目仓库）。**订正（build 阶段发现，见 DESIGN §3.2"订正"一节）**：不 `import` `brain-lock.mjs` 的 `sanitizeKey()`/`resolveSessionId()`——那会在全局安装场景下 `MODULE_NOT_FOUND`（`brain-lock.mjs` 没进 `COPY_ITEMS`）。改为本文件独立维护同名的两份实现，行为对拍由测试守住。头注释写清楚：为什么不复用 `brain-lock.mjs` 整体（DESIGN §1.5 的引用）、为什么状态落 homedir 不落 cwd/toplevel。 | 无 |
| `.claude/hooks/lib/test-wake-session-guard.mjs`（**新建**） | 单测：① 首次 `claim()` 成功 ② 同 key 重复 `claim()` 返回 `already-claimed`，不覆盖已有文件内容 ③ 不同 `sessionId` 互不影响（各自能 claim 成功）④ `sweepStale()` 真实创建一个 `mtime` 超过 48h 的假文件（用 `utimesSync` 改 mtime），验证被清掉；一个 23h 的不被清掉 ⑤ 状态文件路径断言在 `homedir/.claude/aeloop-brain/wake-session-state/` 下，**不在任何 `cwd`/`toplevel` 相关路径下**（用一个和 `homeDir` 不同的假 `cwd` 调用，断言路径不受 `cwd` 影响——这是 DESIGN §1.5 红线的直接回归测试）⑥ 读写异常（比如把目标目录路径指向一个不可写的假路径）时 `claim()` 返回 `{claimed:false, reason:"error"}` 而不抛出异常（fail-open 断言）⑦ `resolveSessionId()`/`sanitizeKey()` 和 `brain-lock.mjs` 的同名函数**行为对拍一致**（不是同一个引用——本文件独立实现，见上方订正）。 | wake-session-guard.mjs |

### 5.2 修改文件

| 文件 | 改动 | 依赖 |
|---|---|---|
| `.claude/hooks/brain-wake-greeting.mjs`（**修改**） | ① `main()` 解析 stdin 时新增读 `input.hook_event_name`（`"SessionStart"`/`"UserPromptSubmit"`，缺失时按 `undefined` 处理不报错）和 `input.session_id`。② 新增 CLI flag 检测：`process.argv.includes("--standalone")` → 跳过 `readFileSync(0)`，`cwd = process.cwd()`，`sessionId = resolveSessionId()`（`wake-session-guard.mjs` 导出的独立实现），`hookEventName = undefined`（标记 standalone 模式）。③ 三态判断（A/B/C）原有分支逻辑内容**零改动**——只重构外层：每条分支不再各自直接调用 `emitAdditionalContext()`，改成把 `{kind, text}` 存起来，`main()` 末尾统一调用一个新的内部函数 `claimAndEmit({kind, text, hookEventName, sessionId, standalone})`（DESIGN §3.3 第4点建议的收口方式）。④ `claimAndEmit()` 内部：先调用 `wake-session-guard.mjs` 的 `claim()`；**订正（Zorro R1 复审 blocker B2，最重的一条）**：判断输出与否不能只看 `result.claimed`，必须看 `result.reason`——只有 `reason === "already-claimed"` 才抑制输出，`claimed:true` 和 `reason:"error"`（guard 自身 I/O 故障）都视为"应该输出"（用已经算好的 `text`）。若 `standalone` 为真则打印纯文本 `text`（不包 JSON），否则 `emitAdditionalContext(text, hookEventName ?? "SessionStart")`（`emitAdditionalContext` 签名新增 `hookEventName` 参数，替换掉现有硬编码的 `"SessionStart"` 字符串）；确认 `reason === "already-claimed"` 时 → `standalone` 模式打印一句极简纯文本"本会话已经醒来过，跳过"，非 standalone 模式什么都不输出（延续现有"安静"惯例）。（草稿阶段原文只写"claimed:false → 抑制"，没有区分 `reason`，是 B2 blocker 的根因，已订正）⑤ 头注释同步更新：说明现在支持 `SessionStart`/`UserPromptSubmit`/`--standalone` 三种驱动方式，指回 `docs/wake-trigger-portability/DESIGN.md`（不重复论证，只留指针，同 `#96` 那次头注释同步的先例）。⑥ **绝不阻断红线延续**：新增的 guard 调用/`--standalone` 分支同样在现有 `main().catch()` 兜底范围内，任何异常仍然吞掉、`exit 0`。 | wake-session-guard.mjs |
| `.claude/settings.json`（**修改**） | 新增 `hooks.UserPromptSubmit`（扁平数组，**不带 `matcher` 包装**，DESIGN §1.2 已确认结构差异）：`[{"type":"command","command":"node \"${CLAUDE_PROJECT_DIR}/.claude/hooks/brain-wake-greeting.mjs\""}]`——和现有 `SessionStart` 条目用同一个命令字符串（同一个脚本，内部按 `hook_event_name` 分派）。`$comment` 字段同步更新：现在有 SessionStart+UserPromptSubmit 双触发 + 全局兜底网，指回 DESIGN。 | brain-wake-greeting.mjs 落地后 |
| `docs/conductor-brain-layer/spike/test-hook-greeting.mjs`（**修改**） | 新增端到端用例（真实 `spawnSync` 调用 hook，同现有用例手法）：⑪ `hook_event_name:"UserPromptSubmit"` 的 stdin payload → 输出 `hookSpecificOutput.hookEventName === "UserPromptSubmit"`（不是硬编码的 `"SessionStart"`）；⑫ `--standalone` flag、无 stdin（或空 stdin）→ 输出是纯文本（不是 JSON），且内容含开场白/引导脚本的关键字（同状态 A/B/C 各自的现有关键字断言）；⑬ 同一个 `sessionId` 连续两次调用（第一次 `SessionStart`，第二次 `UserPromptSubmit`）→ 第二次输出为空（guard 生效）；⑭ `--standalone` 在 guard 已被 claim 的情况下调用 → 输出"本会话已经醒来过"这句话。⑮ 每个新增/沿用的用例结束后清理各自用的 `wake-session-state` 临时目录（用一个每次测试独立的假 `HOME`/state 目录注入，不污染真实 `~/.claude/`——需要 `wake-session-guard.mjs` 的 `homeDir` 参数可被测试注入，同 `install-global-brain.mjs` 的 `opts.homeDir` 测试注入惯例）。既有 ①-⑩ 用例**不改变断言内容**，只需要确认它们在新的"guard 默认存在"前提下仍然全绿（每个既有用例各自用独立的 `sessionId`/`homeDir`，互不冲突即可，不需要重写）。 | brain-wake-greeting.mjs、wake-session-guard.mjs |
| `scripts/install-global-brain.mjs`（**修改**） | ① `COPY_ITEMS` 新增一条：`{ src: path.join(".claude","hooks","lib","wake-session-guard.mjs"), type: "file" }`。② `installPaths()` 新增返回字段 `globalClaudeMdPath: path.join(homeDir, ".claude", "CLAUDE.md")`。③ `resolveSettingsWriteTarget()` 泛化改名为 `resolveWriteTarget(path)`（不针对具体文件名，DESIGN §3.5 第5点——纯重命名+参数泛化，逻辑不变，`settings.json` 调用点同步改名调用，不改变任何既有行为/测试断言）。④ 新增纯函数 `mergeClaudeMdWithWakeFallback(existingContent, blockBody)`（DESIGN §3.5 完整语义：起止标记各恰好 1 个且顺序正确→原地替换；都为 0→追加；**其它任何组合（缺一半 / 任一标记重复出现 2 次及以上 / 顺序颠倒）→ fail-closed 抛错**——**订正（Zorro R1 复审 blocker B3）**：草稿阶段只写"只有一个标记存在→fail-closed"，没覆盖"标记重复"这类同样畸形但两种标记都不缺的状态，初版实现用 `indexOf()` 只取第一个标记位置，会把重复标记之间的真实用户内容当成"标记块内部"删掉，已改用计数校验堵上；`existingContent` 为 `null`→按空串处理），标记常量 `WAKE_FALLBACK_MARKER_START = "<!-- aeloop-brain:wake-fallback -->"`/`WAKE_FALLBACK_MARKER_END = "<!-- /aeloop-brain:wake-fallback -->"` 导出。⑤ 新增 `buildWakeFallbackBlockBody(hookEntryPath)`——生成 DESIGN §3.4 草案文案（用真实 `hookEntryPath` 替换其中的固定路径占位）。⑥ `installGlobalBrain()` 主流程：`hookCommand` 生成逻辑扩展成同时准备好 UserPromptSubmit 要用的 command 字符串（DESIGN 附录第2点：可能和 SessionStart 用同一个字符串，视 `mergeSettingsWithBrainHook()` 扩展后的实际调用签名而定）；`mergeSettingsWithBrainHook()` 调用点扩展成同时处理 `hooks.UserPromptSubmit`（见下一行）；新增一段读 `globalClaudeMdPath` 现有内容 → `mergeClaudeMdWithWakeFallback()` → `changed` 时走 `resolveWriteTarget()` + 原子写 + 备份（复用同一套软链/mode/temp-rename 逻辑，不重新实现）；`dryRun`/CLI 回显文案新增 CLAUDE.md 那一行。⑦ **验证可用**（`assertStagingUsable()`）不需要新增校验项——`wake-session-guard.mjs` 是普通 `.mjs` 文件,已经被"hook 入口文件存在性"这类既有校验模式覆盖,不需要单独加一条特化校验。 | wake-session-guard.mjs（COPY_ITEMS 目标） |
| `scripts/install-global-brain.mjs`（**修改**，`mergeSettingsWithBrainHook()`） | 新增处理 `hooks.UserPromptSubmit` 的平行分支（**扁平数组，不是 `{matcher,hooks:[...]}`**，DESIGN §1.2/附录第3点已确认结构差异，不能照抄 `SessionStart` 分支）：结构校验（非数组→fail-closed 抛错，同 `SessionStart` 分支的既有取向）；用 `AELOOP_BRAIN_MARKER` 子串在数组元素里找"是不是本工具装的"那一个（`hookIdx = arr.findIndex(h => typeof h?.command === "string" && h.command.includes(AELOOP_BRAIN_MARKER))`）；找到且 command 相同→no-op；找到但不同→原地替换该元素；没找到→追加新元素到数组末尾。返回值结构和现有 `{settings, changed}` 保持一致，`changed` 综合 SessionStart 和 UserPromptSubmit 两部分的变更（任一变了就是 `true`）。 | 无新依赖，纯逻辑扩展 |
| `scripts/test-install-global-brain.mjs`（**修改**） | 新增测试组：① `mergeSettingsWithBrainHook()` 在既有 `SessionStart`-only settings 基础上首次运行 → 新增 `UserPromptSubmit` 扁平数组条目，`SessionStart` 条目原样不动（deep-equal 断言）；② 重装（两个事件的 command 都已存在且相同）→ `changed:false` 真幂等；③ command 变化（比如 `--task-source` flag 变了）→ 两个事件下的条目都原地替换，不新增重复条目；④ `hooks.UserPromptSubmit` 存在但不是数组（畸形结构）→ fail-closed 抛错，原文件未被触碰；⑤ `mergeClaudeMdWithWakeFallback()` 各状态全覆盖（起止各恰好 1 个/都为 0/只一个/`null` 首装，**加 Zorro R1 blocker B3 后新增：重复起始标记/重复结束标记/两个完整标记块，均 fail-closed**）；⑥ 幂等：相同 `blockBody` 连续两次调用第二次 `changed:false`；⑦ 标记块外的用户内容逐字节不变（构造一个带用户自己内容 + 标记块的既有文件，替换后断言标记块外内容 `deep-equal` 原始值）；⑧ `resolveWriteTarget()` 改名后既有软链/悬空软链/mode 保留/首装场景的测试组**全部保留断言内容，只改调用的函数名**——证明泛化重构没有引入行为回归；⑨ 端到端 `installGlobalBrain()`（用临时 `--target`）验证真实写出的 `~/.claude/CLAUDE.md`（临时 homeDir 下）含 `wake-fallback` 标记块 + 备份文件产生。 | install-global-brain.mjs |
| `scripts/test-install-global-brain-onboarding-e2e.mjs`（**修改，视情况**） | 若现有 E2E 用真实 `spawnSync` 验证过 SessionStart 路径产出真实引导文本，补一组同构的 UserPromptSubmit 路径 E2E（真装到临时 `--target`，从无关项目 cwd + 空全局库，`hook_event_name:"UserPromptSubmit"` 真实 spawn 换入后的 hook，断言产出真实引导文本，非 `MODULE_NOT_FOUND`）——复刻 #96 那次"删掉 COPY_ITEMS 那一条→这个测试真的会失败"的可信度标准。 | install-global-brain.mjs |
| `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`（**修改**） | 新增一小节"三层触发（issue #106）"：简述 SessionStart/UserPromptSubmit/`--standalone` 三条路径 + 全局 CLAUDE.md 的 `wake-fallback` 标记块，指回 DESIGN，不重复展开。原有"让'你好'→开场白 真的跑起来"一节里任何暗示"只有 SessionStart"的措辞同步订正。 | 全部实现落地后 |
| `docs/conductor-brain-layer/BRAIN.md`（**修改**） | "醒来"一节补一句：触发路径现在有 SessionStart/UserPromptSubmit 两条硬机制 + CLAUDE.md 自觉兜底网，指回 DESIGN/RUNBOOK，不展开细节（这份文档是整段注入进上下文的宪法正文，保持简洁）。 | 同上 |
| `CLAUDE.md`（aeloop 项目根，**修改**） | "醒来"一节做**纯描述性**更新：提一句"触发路径现在有 `SessionStart`（CLI）/`UserPromptSubmit`（IDE）两条，具体机制见 `.claude/hooks/brain-wake-greeting.mjs` + DESIGN"。**明确不加 Layer3 的 `--standalone` 自救指令文本**（DESIGN §3.4/§8 已定：那段指令的落点固定是全局 `~/.claude/CLAUDE.md`，由 `install-global-brain.mjs` 管理，项目级文件不重复）。 | 同上 |
| `CHANGELOG.md`（**修改**） | `[Unreleased]` 新增一条，日期 2026-07-24，简述三层触发 + 全局 CLAUDE.md 合并机制。 | 全部落地后 |

### 5.3 本需求文档（本目录）

| 文件 | 说明 |
|---|---|
| `docs/wake-trigger-portability/DESIGN.md` | 已完成，指挥官已确认 |
| `docs/wake-trigger-portability/PRD.md` | 本文件 |
| `docs/wake-trigger-portability/progress.md`（**新建**） | build 阶段边做边写，含 CLI UserPromptSubmit 探针的真实结论 |
| `docs/wake-trigger-portability/impact.md`（**新建**） | 全部批次完成后产出 |

---

## 6. 批次拆解（按依赖排序）

| Batch | 内容 | 规模 | 依赖 |
|---|---|---|---|
| B1 | `wake-session-guard.mjs` + 单测 | S | 无 |
| B2 | `brain-wake-greeting.mjs` 改造（event 分派 + `--standalone` + guard 插入 + claimAndEmit 收口） | M | B1 |
| B3 | `.claude/settings.json` 注册 UserPromptSubmit + `$comment` 更新 | S | B2 |
| B4 | `test-hook-greeting.mjs` 新增 ⑪-⑮ 用例 + 回归既有 ①-⑩ | M | B2, B3 |
| B5 | `install-global-brain.mjs` 扩展（COPY_ITEMS/UserPromptSubmit 合并/`resolveWriteTarget` 泛化/`mergeClaudeMdWithWakeFallback`/主流程接入/CLI 回显） | L | B1, B2 |
| B6 | `test-install-global-brain.mjs` 新增测试组 + `test-install-global-brain-onboarding-e2e.mjs` 视情况扩展 | M | B5 |
| B7 | 文档同步（RUNBOOK/BRAIN.md/项目根 CLAUDE.md/CHANGELOG） | S | B2-B6（描述要基于最终实现） |
| B8 | CLI 上 UserPromptSubmit 真机探针验证（§7.1），结论记 progress.md，非阻塞其它批次 | S | B3（settings.json 已注册才能真机测） |
| B9 | 收尾：`pnpm run build` + `pnpm test` + 全部既有/新增 `test-*.mjs` 脚本 + lint 全绿，`progress.md` 完整化，产出 `impact.md` | S | 全部之前批次 |

**执行顺序理由**：B1（守卫）是 B2/B5 的公共依赖，最先做；B2（脚本改造）是 B3/B4/B5 的前提；
B3/B4 可以和 B5/B6 并行（触发注册和安装器扩展是两条相对独立的线，但都吃 B2 的产出）；B7 文档同步
放在功能大体落地之后，避免文档描述和实现细节反复对不上；B8（真机探针）依赖 settings.json 已经
注册好 UserPromptSubmit，可以和 B7 并行；B9 是全批次收口。

**分支策略**：单分支 `feature/issue-106-wake-ide-hook`（延续当前 worktree 分支），一批一批提交
（每个 batch 完成后本地自检 + 更新 `progress.md`，不在批次内部再拆子分支——DESIGN 本身不涉及
拆多个独立可发布单元，批次是"依赖顺序"不是"发布边界"）。

---

## 7. 可测验收标准（可勾选）

- [ ] `node .claude/hooks/lib/test-wake-session-guard.mjs` 全部 PASS（含"状态只落 homedir、不受
      `cwd` 影响"的回归断言——DESIGN §1.5 红线的直接测试）。
- [ ] `node docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 全部 PASS（既有 ①-⑩ + 新增
      ⑪-⑮）。
- [ ] `node scripts/test-install-global-brain.mjs` 全部 PASS（含 `mergeSettingsWithBrainHook()`
      UserPromptSubmit 分支的首装/幂等/变更/畸形结构四态，`mergeClaudeMdWithWakeFallback()` 的
      四态 + 幂等 + "标记块外内容逐字节不变"，`resolveWriteTarget()` 泛化后既有软链/悬空软链/
      mode 保留断言全部保留）。
- [ ] `node scripts/test-install-global-brain-onboarding-e2e.mjs` 全部 PASS（含新增的
      UserPromptSubmit 路径 E2E，若纳入本批次范围）。
- [ ] 全部既有 `test-*.mjs`/`.claude/hooks/**/test-*.mjs`/`scripts/test-*.mjs`（#96 PRD §4 列出的
      那份清单）继续全部 PASS——零回归的字面证明，逐个手跑核实，不是假设"没碰到就没事"。
- [ ] `pnpm run build` 成功，`pnpm test`（vitest，`src/**`）全绿。
- [ ] `pnpm lint`（`tsc --noEmit`）干净，零错误。
- [ ] 端到端自验（真实运行，不只是 mock）：
  - [ ] 用真实 stdin payload（`hook_event_name:"SessionStart"`）手动跑 hook，产出正常开场白，
        `hookSpecificOutput.hookEventName === "SessionStart"`。
  - [ ] 同一 `sessionId`，紧接着用 `hook_event_name:"UserPromptSubmit"` 的 payload 再跑一次 →
        无输出（guard 生效）。
  - [ ] 全新 `sessionId`，直接用 `hook_event_name:"UserPromptSubmit"` 的 payload 跑（模拟纯 IDE
        场景，SessionStart 从未 fire）→ 正常产出开场白，`hookSpecificOutput.hookEventName ===
        "UserPromptSubmit"`。
  - [ ] `--standalone` flag、guard 未 claim → 纯文本输出（非 JSON），内容含开场白/引导脚本关键字。
  - [ ] `--standalone` flag、guard 已 claim（复用上面某次已 claim 的 sessionId）→ 输出"本会话
        已经醒来过"。
- [ ] `installGlobalBrain({ target: <临时目录> })` 真实跑一次，验证：
  - [ ] `~/.claude/settings.json`（临时 homeDir 下）同时含 SessionStart + UserPromptSubmit 两条
        本工具条目。
  - [ ] `~/.claude/CLAUDE.md`（临时 homeDir 下）含 `<!-- aeloop-brain:wake-fallback -->` 标记块，
        块内含正确的 `hookEntryPath`。
  - [ ] 用一个预先手写、含用户自己内容的 `CLAUDE.md` 作为起点重跑安装 → 用户自己的内容逐字节
        保留，标记块正确插入/更新，产生 `.bak-<timestamp>` 备份文件。
  - [ ] 重跑（幂等）→ `settingsChanged`/CLAUDE.md `changed` 均为 `false`，不产生新的 `.bak` 文件。
- [ ] CLI 上 UserPromptSubmit 是否 fire 的真机探针结论已记入 `progress.md`（证实或证伪均可，
      §7 第1点，非阻塞其余验收标准）。
- [ ] `grep` 确认 aeloop 项目根 `CLAUDE.md` **不含** `--standalone` 这个具体调用文案（反向断言：
      Layer3 自救指令文本没有被误放进项目级文件）。
- [ ] 文档同步：`WAKE-GREETING-RUNBOOK.md`/`BRAIN.md`/项目根 `CLAUDE.md`/`CHANGELOG.md` 不再
      包含"仅 SessionStart"这类现在不准确的措辞。

---

## 8. 依赖 / 风险

**依赖**：
- 依赖 #96（`onboarding-greeting.mjs` 三态判断）、#98（版本戳）、#103（`install-global-brain.mjs`
  的 `mergeSettingsWithBrainHook`/`AELOOP_BRAIN_MARKER` 幂等基础设施）已落地——三者均已 CLOSED/
  已在主干，本需求在其基础上扩展，不重新实现。

**风险**（DESIGN §5 Trade-off 已详细论证，这里只列对 build 阶段有直接影响的）：
- **守卫 claim 时机错误的回归风险**：如果实现时不小心把 claim 提到"三态判断计算完成"之前，
  会导致异常路径下这个会话永久拿不到开场白（比"没有守卫"更差）——B2 的 code review/自测必须
  明确验证这一点，B4 的测试用例要包含"三态判断内部抛出异常时 guard 不应该被 claim"这类场景
  （**补充测试点，PRD §5.2 `test-hook-greeting.mjs` 那行原描述的 ⑪-⑮ 未显式列出，build 阶段
  需要额外补一条，记入 progress.md**）。
- **`resolveWriteTarget()` 泛化重构的回归风险**：这是本批次里对现有、已经过 5 轮 Zorro 复审
  硬化过的代码做改动风险最高的一步（DESIGN §3.5）——必须保证泛化前后行为完全一致，B6 的测试
  策略是"改函数名、不改断言内容"，任何一个既有断言失败都要当作真实回归处理，不能因为"这是重构
  不是新功能"就降低标准。
- **CLI 探针验证（B8）可能受限于本环境**：Cypher 目前运行在一个 subagent 沙箱里，没有一个真正
  独立的、交互式的 Claude Code CLI 会话可以随时打开——B8 会尝试用 `claude -p "<prompt>"` 一次性
  模式在 aeloop 仓库 cwd 下跑一次，配合探针 hook 检查 `/tmp` 标记文件是否被写入；如果这个方法
  本身因为环境限制跑不通（比如非交互模式不触发 UserPromptSubmit，或权限/认证问题），如实记录
  "本环境未能验证，需要指挥官在真实终端里补验"，不假装验证过了。

## 9. 项目约束检查

- **aeloop 项目隔离**：本需求只碰 aeloop 仓库自己的文件（hooks/scripts/docs/CLAUDE.md），不跨读
  /不跨改其它项目。✅
- **commit/push 门禁**：本批次全程不 commit（指挥官已明确"全程不 commit，build+自测跑完报我，
  送 Zorro 审，PASS 才 commit"）。✅ 会话锁的一次性 commit 授权令牌不会被使用。
- **写代码前先绑 issue**：本会话已绑定 `elishawong/aeloop#106`（`.helix/session-locks/` 已确认）。✅
- **红线复核**（指挥官原话，逐条对应本 PRD 的落地点）：
  - 守卫状态只落 homedir，绝不进目标项目仓库 → §5.1 `wake-session-guard.mjs` 设计 + 单测 ⑤ 直接
    回归这条。
  - 全局 CLAUDE.md 只 merge 不 overwrite → §5.2 `mergeClaudeMdWithWakeFallback()` + 测试 ⑤⑥⑦。
  - #96 三态防幻觉红线一字不动 → §5.2 `brain-wake-greeting.mjs` 改造条目明确"三态判断逻辑内容
    零改动，只重构外层"。
  - 开发溯源注释保留、用户可见层零内部字眼（同 #103）→ 新增代码延续现有头注释密度/风格（引用
    issue 号、写清楚为什么这么做/为什么不那么做），错误信息面向开发者不面向终端用户（本项目
    是 CLI/hook 工具，"终端用户"即 operator 本人，`[brain-wake-greeting]` 这类前缀是给模型读的
    路由标记，不是最终产品 UI 文案，延续现状不算违反这条）。
- **whoseorder 零侵入 / 跨项目契约**：不适用（本需求不涉及 whoseorder/whosehere）。
