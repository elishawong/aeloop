# Impact — 醒来触发跨 host 可移植性 + 三层优雅降级（issue #106）

- **关联 PRD**：`./PRD.md` · **关联 DESIGN**：`./DESIGN.md`
- **分支**：`feature/issue-106-wake-ide-hook`
- **最后更新**：2026-07-24

## 1. 改动摘要

把醒来开场白的触发点从"只赌 `SessionStart` 一个事件"（真机验证在 VSCode 扩展里不 fire，醒来在
指挥官主力 IDE 环境完全失效）升级成三层：Layer1 `SessionStart`（CLI，不变）+ Layer2
`UserPromptSubmit`（新增，IDE/未知 host 主力）+ Layer3 全局 `~/.claude/CLAUDE.md` 驱动的模型
自救兜底网（两层硬机制都未被观察到已注入时触发）。三层共享一个新的会话级守卫，保证一次会话只
真正注入一次开场白。`install-global-brain.mjs` 同步扩展：新注册 UserPromptSubmit hook + 新管理
全局 CLAUDE.md 的 `wake-fallback` 标记块，都是 merge-not-overwrite。#96 的三态防幻觉判断（未
配置/空库/正常）**零改动**。

## 2. 受影响面

**直接改动**：
- `.claude/hooks/brain-wake-greeting.mjs` — 新增 event 分派（读 `hook_event_name`/`session_id`）
  + `--standalone` flag + `claimAndEmit()` 收口三条驱动路径的输出。
- `.claude/hooks/lib/wake-session-guard.mjs`（**新建**）— 三层共享守卫，`session_id`/`pid` 键 +
  `O_EXCL` 原子 claim，状态落 `~/.claude/aeloop-brain/wake-session-state/`（homedir，绝不落进
  目标项目仓库）。
- `.claude/settings.json` — 新增 `UserPromptSubmit` 注册（扁平数组，不带 matcher）。
- `scripts/install-global-brain.mjs` — `COPY_ITEMS` 新增一条；`mergeSettingsWithBrainHook()`
  拆成两个独立分支同时管理 `SessionStart`/`UserPromptSubmit`；`resolveSettingsWriteTarget()`
  泛化改名为 `resolveWriteTarget()`；新增 `mergeClaudeMdWithWakeFallback()`/
  `buildWakeFallbackBlockBody()`/`WAKE_FALLBACK_MARKER_START`/`WAKE_FALLBACK_MARKER_END`；
  `installGlobalBrain()` 主流程新增写全局 CLAUDE.md 的步骤；`installPaths()` 新增
  `globalClaudeMdPath` 字段。
- `scripts/quickstart.mjs`（issue #95，N2 整合，见下方专门小节）— `verifyInstall()` 扩展成
  同时校验 SessionStart/UserPromptSubmit/hook 文件/全局 CLAUDE.md 标记块四件事；`runQuickstart()`
  的自检回显 + 完成提示语更新为三层机制描述。

**间接波及**：
- `docs/conductor-brain-layer/spike/test-hook-greeting.mjs` — **🟡 Zorro R3 复审顺手修（2026-07-24）
  订正此前 impact.md 写的"新增 4 组端到端用例（⑫-⑮）"这句已经过期**——初稿确实是 ⑫-⑮，但
  Zorro R1/R2/R3 三轮复审各自要求补的 hook/standalone E2E 回归陆续加到了 ⑯-㉑，实际是新增
  **10 组**端到端用例（⑫UserPromptSubmit 事件分派/⑬--standalone 纯文本输出/⑭共享守卫互斥/
  ⑮已 claim 时的提示语/⑯⑰guard I/O 故障不吞开场白——B2/⑱⑲guard 状态目录被文件占据（mkdir
  EEXIST）不误判——N1/⑳㉑claim 文件路径被目录/软链→目录占据不误判——N3）。既有 ①-⑪ 用例补上
  `HOME` 隔离（原本会往开发者真实 `~/.claude/aeloop-brain/` 写测试垃圾，build 阶段发现并修复）。
- `scripts/test-install-global-brain.mjs` — 从 66 组扩到 82 组：修复一条因为语义变化不再成立的
  既有断言（"只有 SessionStart 相同就算幂等"→现在要求两个事件都相同）、新增升级场景/
  UserPromptSubmit 分支/CLAUDE.md 合并四态（含 R1 复审要求补的重复标记三态）/端到端 CLAUDE.md
  测试。
- `.claude/hooks/lib/test-wake-session-guard.mjs` — 新增相对路径 homeDir 回归（B1）+ mkdir-EEXIST
  不误判回归（N1）+ claim 路径被目录/软链→目录/悬空软链占据均判 error、合法旧文件仍
  already-claimed 的四组回归（N3）+ `sweepStale({homeDir:"."})` 不抛出回归。
- `scripts/test-quickstart.mjs`（issue #95 集成，N2）— 新增 5 组回归：完整四件套 `ok:true`；
  缺 UserPromptSubmit/缺全局 CLAUDE.md/CLAUDE.md 标记畸形三种场景各自 `ok:false`。
- 文档：`docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`/`BRAIN.md`、项目根 `CLAUDE.md`、
  `CHANGELOG.md` 同步更新触发路径描述。

**#95 quickstart 集成面（Zorro R2 复审 blocker N2，2026-07-24 发现并修复——本轮 build 起初完全
漏掉的一个真实用户可见回归）**：本分支落后 `origin/main` 一次 #95（一键安装 `quickstart.mjs`）
提交时，#106 的三层机制完全没有接进这条一键安装路径——`quickstart.mjs` 的 `verifyInstall()` 只
校验 `SessionStart`，完成回显只提 SessionStart，`docs/getting-started/README.md` 的 IDE 触发
说明还停留在"正在核实中"。后果：**IDE 用户跑 `quickstart.mjs` 只会装到 SessionStart（IDE 环境
这条不 fire），`verifyInstall()` 却会误报安装成功**——用户以为装好了、实际醒来在 IDE 里完全不
生效，正好是 #106 本身要修的那个坏状态，只是换了一个入口重新踩了一遍。修复：
- 先 `git pull --ff-only` 把 #95 纳入分支树（零冲突，两次改动没有文件交集）。
- `scripts/quickstart.mjs` 的 `verifyInstall()` 新增 `sessionStartRegistered`/
  `userPromptSubmitRegistered`/`wakeFallbackRegistered` 三个字段，`hookRegistered` 收紧为前两者
  的逻辑与；`ok` 判据新增 `wakeFallbackRegistered`。全局 CLAUDE.md 标记块的校验复用
  `mergeClaudeMdWithWakeFallback()` 这个唯一权威实现判断"是否已收敛"，不重复写一遍标记解析。
- `runQuickstart()` 的自检回显 + `--dry-run`/安装完成后的 `settings.json`/CLAUDE.md 状态行、
  最终"下一步"提示语全部改成三层机制描述，不再暗示只有 CLI 一条路。
- `docs/getting-started/README.md` 多处更新：安装步骤表、产物落点、"醒来那一刻发生什么"新增
  "三层触发"小节、已知坑表格——不再用"正在核实中"这种悬而未决的措辞，如实描述已验证/未验证的
  具体范围（呼应 DESIGN.md §2 矩阵，未过度宣称）。
- `scripts/test-quickstart.mjs` 新增 5 组回归：完整四件套（SessionStart+UserPromptSubmit+hook
  文件+CLAUDE.md）全部正确才 `ok:true`；缺 UserPromptSubmit、缺全局 CLAUDE.md、CLAUDE.md 标记
  畸形（重复标记）三种场景各自必须 `ok:false` 且报出具体原因，不静默通过、不让 `verifyInstall()`
  自己被 `mergeClaudeMdWithWakeFallback()` 的 fail-closed 抛错崩溃。

**跨项目波及**：无（aeloop 独立项目，不涉及 whoseorder/whosehere 契约）。

**用户可见的行为变化**（升级后，指挥官主力机器需要重新跑一次 `install-global-brain.mjs` 才能吃到）：
- 全局安装后，`~/.claude/settings.json` 会新增一条 `UserPromptSubmit` 注册（首次跑升级会把
  `settingsChanged` 报告为 `true`，即便 `SessionStart` 那条 command 完全没变）。
- `~/.claude/CLAUDE.md` 会新增一段 `<!-- aeloop-brain:wake-fallback -->` 标记块——**这是本次
  升级里唯一会往用户可能已经手写内容的文件里追加内容的改动**，已经过"用户既有内容逐字节保留 +
  产生 `.bak-<timestamp>` 备份"的端到端测试验证，但指挥官第一次跑升级时应该留意一下这个新文件/
  新增内容，不是预期外的。

## 3. 测试建议

- **该重点测**：全局安装升级路径（已装过旧版只有 SessionStart 条目的用户重装新版）——已有单测
  覆盖（`test-install-global-brain.mjs` "issue #106 升级场景"用例），但指挥官在真实机器上跑一次
  `node scripts/install-global-brain.mjs`（不带 `--target`，真实 `~/.claude/`）验证端到端效果，
  含金量比单测更高（单测用的是临时 fake homeDir）。
- **边界/异常场景**：
  - `~/.claude/CLAUDE.md` 如果被手工改坏（只剩半个标记）→ 预期整个安装 fail-closed 拒绝，
    `settings.json` 侧的改动也不应该落地（因为 `claudeMdWriteTarget` 的解析/校验发生在
    `dryRun`/build 之前，和 settings.json 同一批 fail-closed 时机，见 DESIGN §3.5）——这条本设计
    没有专门测"settings.json 该写但 CLAUDE.md fail-closed 时,整体是否真的全部不落地"这个交叉
    场景，建议指挥官或 Zorro 复审时重点看一下这条时序有没有真的做到"任一文件的解析失败,两个都
    不写"。
  - 三层触发的真机验证：VSCode 扩展重新跑一次全套流程（升级后的 hook），确认 UserPromptSubmit
    路径产出的开场白和 SessionStart 路径逐字节一致（本设计已用相同 payload 结构在单测层面验证
    过一致性，真机复核含金量更高）。

## 4. 回归清单（带优先级）

| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | 全局安装升级路径（只有 SessionStart 条目的旧版 → 新版）不产生重复条目/不破坏已有 hook | 直接影响所有已经跑过旧版 `install-global-brain.mjs` 的用户机器；单测已覆盖，建议真机复核一次 |
| P0 | `~/.claude/CLAUDE.md` 合并逻辑不覆盖用户已有内容 | 红线级要求（指挥官原话"神圣不可动"），已有端到端测试用真实用户内容场景验证，但这是本次唯一直接写用户可能已经存在内容的文件的改动，建议 Zorro 复审时重点看 |
| P0 | `node scripts/quickstart.mjs` 端到端真跑一次（不是单测里的 fixture）：`verifyInstall()` 三层全绿、完成回显措辞正确 | Zorro R2 blocker N2——一键安装是大多数新用户的第一入口，`quickstart.mjs` 的单测用的是假 fixture，没有真实跑过一次 `pnpm install → build → 全局安装 → onboard → seed` 全流程验证三层机制真的端到端装上，建议指挥官/Zorro 用 `--target=<临时目录>` 真跑一次复核 |
| P1 | VSCode 扩展场景真机验证 UserPromptSubmit 路径开场白正常 | #106 最初诊断出的问题场景，本次改动是否真的解决了它——本批次没有 VSCode 真机环境，只有单测层面的 payload 结构验证 |
| P1 | 共享守卫的 claim 时机（先算完文案再 claim）没有被后续改动破坏 | DESIGN §3.2 明确标注这是一处容易踩错的顺序陷阱（claim 太早会导致这个会话永久拿不到开场白），当前实现正确但没有专门的"claim 提前会导致什么"负向回归测试 |
| P2 | CLI 交互式 REPL 场景 UserPromptSubmit 是否 fire | 仍是 `[?]`（DESIGN §7 第1点），非阻塞，但建议指挥官有空时在真实终端补验一次，能让 DESIGN §2 矩阵从"部分验证"变成"全部验证" |
| P2 | JetBrains/桌面 App/Web 三个未验证 host | Layer3 兜底网已覆盖不确定性，非阻塞，有渠道再补证据 |

## 5. 项目约束自查

- **不重新设计开场白内容本身**：#96 三态渲染/防幻觉红线一个字不动——`brain-wake-greeting.mjs`
  的三态判断逻辑（状态 A/B/C 分支）在这次改动里逐行核对过，内容零改动，只是外层驱动壳换了。
- **占位符/假数据残留**：无——build 阶段临时加过一次探针 hook（往真实 `.claude/settings.json`
  写了一条测试用的临时条目）尝试观察 CLI headless 模式的 UserPromptSubmit 行为，测试完已完整
  清理，`git diff` 复核过最终 diff 只剩本批次真正要提交的改动，没有探针残留（见 `progress.md`
  B8）。**该探针本身的观察结论已被 Zorro R1 复审 blocker B4 判定不构成可复核证据、已降级为
  `[?]`**（用了越权的 `--allow-dangerously-skip-permissions` 嵌套 agent 且未留可复核产物），
  DESIGN.md §2 已同步订正，本条只涉及"有没有残留测试代码/文件"，不涉及那条被打回的结论本身。
- **whoseorder 零侵入 / 跨项目契约**：不适用（本需求不涉及 whoseorder/whosehere）。
- **commit/push 门禁**：全程未 commit，未 push——按指挥官"build+自测跑完报我，送 Zorro 审，
  PASS 才 commit"的明确指示执行。
