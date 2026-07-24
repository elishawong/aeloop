# RUNBOOK — 醒来开场白 + 按需状态表（aeloop issue #84）

> 本文档只讲"怎么在一台机器上把这两个功能跑起来"，不重复设计论证——设计权威见 `DESIGN.md`
> §2.2/§3/§7，宪法/约定见 `BRAIN.md`。

## 交付了什么

1. **SessionStart 醒来开场白**：Claude Code 会话一启动，自动从 aeloop 身份 `MemoryStore` 组一份
   "意识已加载…" 延续式开场白，注入上下文，模型对用户第一句话先原样吐出这段开场白。
2. **按需状态表 skill**：会话进行到一半，用户问"现在在途待办有什么"，模型跑一个确定性 CLI
   拿到同一份"现在在途"表格，原样转述。
3. 两者共用同一份查询/渲染代码（`docs/conductor-brain-layer/spike/lib/status-table.mjs`），
   不会出现"开场白说的和按需查的对不上"的分叉。

## 诚实边界（先读这条，别对着这套东西预期它没做到的事）

- **Phase1：换了数据源，没有换运行时**——这套东西仍然是 Claude Code CLI 的 `SessionStart` hook
  机制，不是 aeloop 自己的独立运行时（详见 `BRAIN.md` §5、`DESIGN.md` §7）。
- **不含派工闭环**——这次只做"醒来出开场白"和"按需查状态表"，不含"意图 → TaskContract →
  aeloop 执行 → 证据折回身份库"这条链（那是 issue #80 spike 已经手动验证过、但没接进这个 hook
  里的另一件事）。
- **不验证"会话本身用的是哪个模型"**——`AELOOP_BRAIN_IDENTITY_DB`/hook/skill 这套东西模型无关，
  怎么让 Claude Code CLI 实际调用 seed/deepseek 是另一个独立的、这次没有验证的技术问题
  （DESIGN §7.2 标的 `[?]`）。

## 前置

- Node ≥ 24（`package.json` `engines.node`）。
- 在仓库根跑过一次 `pnpm install && pnpm run build`（生成 `dist/`——`lib/wake.mjs` 等脚本都是从
  `dist/context/store.js` 之类的构建产物导入类型/类的，不是从 `src/` 直接导入）。

## 配置身份库

1. 选一个 dbPath，**建议绝对路径**（避免 hook 运行时的 cwd 和你手动跑 CLI 脚本时的 cwd 不一致，
   导致相对路径解析到两个不同的文件）。任何 `*.db`/`*.db-journal`/`*.db-wal` 已经在仓库
   `.gitignore` 里，放哪都不会被 git 追踪。示例：

   ```bash
   mkdir -p .brain-data
   export AELOOP_BRAIN_IDENTITY_DB="$(pwd)/.brain-data/identity.db"
   ```

2. （可选）显式覆盖身份显示名——不改身份库也能先跑通：

   ```bash
   export AELOOP_BRAIN_IDENTITY_NAME="随便取一个名字"
   ```

   长期推荐做法是往身份库里写一条 `type:"identity", title:"identity:name"` 的 memory（约定见
   `BRAIN.md` §4），不是长期依赖这个环境变量。

3. 往身份库里塞几条种子记录（`active_task`/`idea`/`decision`/`snapshot`/`identity`，字段约定见
   `BRAIN.md` §4）。最快的办法是照抄
   `docs/conductor-brain-layer/spike/demo-wake-greeting.mjs` 步骤1那段 `store.insertMemory(...)`
   调用，或者直接跑这个 demo 脚本（它会在系统临时目录建一个一次性身份库，跑完自动清理，不会
   碰你自己配的那个 dbPath）。

   如果想直接往**你自己配置的** dbPath 写种子数据，用一段等价的 node 脚本：

   ```bash
   node -e '
   import("./docs/conductor-brain-layer/spike/lib/wake.mjs").then(({ openIdentityStore }) => {
     const store = openIdentityStore(process.env.AELOOP_BRAIN_IDENTITY_DB);
     store.insertMemory({
       type: "active_task",
       title: "示例任务",
       content: "描述一下这个任务在做什么。",
       tags: ["status:in-progress", "model:deepseek-v3"],
       confidenceState: "confirmed",
     });
     store.close();
     console.log("已写入一条 active_task。");
   });
   '
   ```

   **推荐做法（issue #88 B8）**：手写 `insertMemory` 只是备选，日常更快的是跑一键 seed 脚本
   `node scripts/seed-brain-identity.mjs`——自动种下身份/宪法约束/真实 GitHub issue 在途状态三类
   数据。**前置条件（issue #93 B3，issue #96 实测踩到、此前本文档未记录）**：如果 dbPath 所在的
   会话 cwd 是一个带 origin remote 的 git 项目，seed 脚本会要求这个项目先被
   `node scripts/onboard-project.mjs --repo-path <项目根目录绝对路径>` 注册过（写一条
   `project_registry` 记录），否则会在"issue 同步"这一步报"目标项目尚未注册"并以非零 exit code
   中止——**这一步之前的身份/宪法约束数据仍然会被写入**，只有 issue 同步这部分被挡住。先跑一次
   `onboard-project.mjs`，再重跑 seed 即可。

## shell profile 正确姿势（issue #88 B9 新增）

上面"配置身份库"第1步的 `export AELOOP_BRAIN_IDENTITY_DB=...` 只在**当前终端 session** 里生效——
关掉这个终端窗口/开一个新终端标签页，这个变量就没了。要让它对以后打开的所有终端持久生效，
写进 shell 的 profile 文件：

```bash
# zsh（macOS 默认 shell，`echo $SHELL` 确认）
echo 'export AELOOP_BRAIN_IDENTITY_DB="/absolute/path/to/your/identity.db"' >> ~/.zshrc

# bash
echo 'export AELOOP_BRAIN_IDENTITY_DB="/absolute/path/to/your/identity.db"' >> ~/.bashrc
```

**改完要开一个新终端窗口，或者在已经开着的终端里手动 `source ~/.zshrc`（或 `~/.bashrc`）**——
已经开着的终端不会自动重新读这个文件，这是 shell 本身的行为，不是配置错了。

## IDE 启动读不到 env 的坑（issue #88 B9 新增）

macOS 上从 Dock / Spotlight / IDE 图形界面启动的进程**不继承** shell profile 里 export 的
环境变量——这是 macOS 本身的进程继承模型决定的，只有从终端里敲命令启动的进程（包括从终端
里打开的 Claude Code CLI）才会读到 `.zshrc`/`.bashrc` 里 export 的变量。如果你的 Claude Code
是从 IDE（如某些编辑器内置的终端面板本身没问题，但 IDE 的"图形界面启动"某个外部工具时会有
这个坑）或者 Dock 图标启动的，即便 `.zshrc` 里配好了 `AELOOP_BRAIN_IDENTITY_DB`，那个会话
也可能读不到。两条修法：

1. **推荐（更稳）**：`launchctl setenv AELOOP_BRAIN_IDENTITY_DB "/absolute/path/to/your/identity.db"`
   ——对 macOS 上所有图形界面启动的进程一次性生效。**诚实标注局限**：这不是"跑一次永久生效"——
   重启电脑后 launchctl 的这份 setenv 会失效，需要重新跑一次（可以写进一个开机自启脚本，
   本 RUNBOOK 不展开如何配置那一层）。
2. **备选（issue #88 B9 新增的机制化 fallback，比纯文档提醒更可靠）**：把
   `.claude/brain.local.json.example` 复制成 `.claude/brain.local.json`（已在 `.gitignore` 里，
   不会被提交），填入 `identityDbPath` 字段：

   ```bash
   cp .claude/brain.local.json.example .claude/brain.local.json
   # 编辑 .claude/brain.local.json，把 identityDbPath 换成你自己的绝对路径
   ```

   `brain-wake-greeting.mjs` 会在 `AELOOP_BRAIN_IDENTITY_DB` 环境变量读不到时，自动 fallback 读
   这份本地配置文件（`.claude/hooks/lib/db-path.mjs` 的 `resolveIdentityDbPath()`）——即便 IDE
   启动的进程读不到 shell profile，只要这份文件存在，hook 依然能找到 dbPath，不需要每次都排查
   "这个会话是不是从图形界面启动的"。

## 排查清单（issue #88 B9 新增）

- `echo $AELOOP_BRAIN_IDENTITY_DB` 在当前终端里是空的 → 没 export，或者开了新终端没 `source`
  对应的 profile 文件（见上方"shell profile 正确姿势"）。
- 终端里能读到这个变量，但 Claude Code 会话里开场白没出现 → 检查这个会话是不是从 IDE/图形
  界面启动的（见上方"IDE 启动读不到 env 的坑"），排查时可以先用 `.claude/brain.local.json`
  fallback 绕开这个问题，确认是不是这条路径的坑。
- 两个配置源（env / `.claude/brain.local.json`）都配了，仍然没有开场白 → 跑
  `node docs/conductor-brain-layer/spike/demo-wake-greeting.mjs`（"本机验证"一节，见下）本机
  排除，区分"hook 本身没触发"和"触发了但数据是空的"两种可能——前者通常是 `.claude/settings.json`
  没生效或 Claude Code 版本问题，后者是身份库里确实没有种子数据（回到"配置身份库"第3步）。

## 让"你好" → 开场白 真的跑起来

`.claude/settings.json` 已经把 `SessionStart` **和** `UserPromptSubmit`（issue #106）都接到
`.claude/hooks/brain-wake-greeting.mjs`（`SessionStart` 用 `matcher: "startup|resume|clear"`，
`UserPromptSubmit` 不支持 matcher，扁平注册）——只要在这个仓库（或包含它的目录）里开一个 Claude
Code 会话，且 `AELOOP_BRAIN_IDENTITY_DB` 在会话启动前已经在环境变量里（比如写进 shell 的
profile，或者用支持传环境变量启动的方式打开会话），两个事件里**至少一个**会自动触发这个 hook
——具体哪个触发取决于 host（**真机验证**：CLI 里 `SessionStart` 会 fire；VSCode 扩展里
`SessionStart` **不会** fire，但 `UserPromptSubmit` 会 fire）。三层触发架构 + 跨 host 可移植性
矩阵的完整论证见下方"三层触发（issue #106）"一节。

**issue #96 起不再是"安静跳过"**：`AELOOP_BRAIN_IDENTITY_DB` 没设置、或者已经设置但身份库是空的
（还没跑过种子脚本）时，hook 会注入一段首次引导脚本，带用户走一遍问答式配置——不会报错、不影响
会话正常启动，但也不再彻底沉默。完整设计权威见 `docs/first-wake-onboarding/DESIGN.md`；已有真实
数据的会话（`listMemories().length >= 1`）行为完全不变。

## 三层触发（issue #106）

`SessionStart`/`UserPromptSubmit` 都没有被观察到已经注入过开场白时（已知场景：某个未验证的
host，两条硬机制都不 fire），还有第三层——全局 `~/.claude/CLAUDE.md` 里由
`install-global-brain.mjs` 管理的 `wake-fallback` 标记块（`<!-- aeloop-brain:wake-fallback -->`
… `<!-- /aeloop-brain:wake-fallback -->`），指示模型在对用户第一条实质回复前，若没见过注入，就
自己跑一次 `node <hookEntryPath> --standalone`（跳过 stdin，`cwd`/`session_id` 各自兜底解析）。
三层共享同一个会话级守卫（`.claude/hooks/lib/wake-session-guard.mjs`，状态落
`~/.claude/aeloop-brain/wake-session-state/`，绝不落进目标项目仓库），保证一次会话只真正注入
一次。完整架构/跨 host 矩阵/守卫设计：`docs/wake-trigger-portability/DESIGN.md`；实现细节/批次
拆分：`docs/wake-trigger-portability/PRD.md`。**这段 Layer3 自救指令只装在全局 CLAUDE.md 里，
不在这份仓库自己的 `/CLAUDE.md` 里**——本地开发本仓库时 Layer1/Layer2 已经通过这份
`.claude/settings.json` 直接注册好了。

## 首次醒来引导（issue #96）

如果这是第一次在这台机器/这个 checkout 上开 Claude Code、身份库还没配置好，不需要先读完这整份
RUNBOOK——`brain-wake-greeting.mjs` 会自己检测到"未配置"或"已配置但空"这两种状态，注入一段引导
脚本，模型会用问答的方式带你走完配置（不是逐字念一段固定文案）。这份 RUNBOOK 仍然是**权威参考**
（引导脚本本身会指回这里的具体章节，比如"IDE 启动读不到 env 的坑"），但不要求你先看完它才能开始。

设计权威（三态怎么判定、为什么不新建一个独立的 `aeloop init` CLI、和 `AI_AGENT_PROFILE` 的边界
怎么划）：`docs/first-wake-onboarding/DESIGN.md`；实现细节/批次拆分：
`docs/first-wake-onboarding/PRD.md`。

## 让"现在在途待办有什么" → 状态表 真的跑起来

`.claude/skills/status-table/SKILL.md` 已经就位——同一个 Claude Code 会话里，问"现在在途待办有
什么"/"现在做到哪了"/"状态怎么样"这类问题，模型会按这个 skill 的指示跑
`node docs/conductor-brain-layer/spike/print-status-table.mjs` 并原样转述 stdout。

## 本机验证（不依赖真的开一个 Claude Code 会话）

```bash
pnpm run build
node docs/conductor-brain-layer/spike/demo-wake-greeting.mjs
```

这个脚本会：① 建一个临时身份库塞种子数据（含至少一条故意标成 `unconfirmed` 的 active_task，
用来验证它不会被渲染进"现在在途"）；② 真的 `spawn` `.claude/hooks/brain-wake-greeting.mjs`，
喂它 Claude Code 会给的那种 stdin payload，解析它吐出的 `SessionStart` `additionalContext`
JSON；③ 再跑一次 `print-status-table.mjs`，逐字比对两处"现在在途"表格是否一致。三步全部
`PASS` 才算过。真实跑一次的完整输出见下方"本机 demo 真实输出存档"。

## 项目自身约束

- `.claude/settings.json`/`.claude/skills/`/`.claude/hooks/` 是独立生效的 Claude Code 配置，不依赖
  `CLAUDE.md` 存在——这条设计约束本身仍然成立。**这句话原本还断言"aeloop 仓库本身没有
  `CLAUDE.md`"，issue #96 复查时发现这句已经不准确**：仓库根确实存在 `CLAUDE.md`（`git log
  --follow -- CLAUDE.md` 可查，从项目最初 scaffolding 起就有），修正为如实描述，不再重复这条
  过期断言。
- 不改动 `src/**` 任何一行——延续 `docs/conductor-brain-layer/spike/` 既有先例（纯侦察/驱动脚本，
  不参与 `pnpm run build`/`pnpm test`，从 `dist/` 构建产物导入）。
