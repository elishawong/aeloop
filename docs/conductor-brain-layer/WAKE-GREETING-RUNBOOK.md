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

`.claude/settings.json` 已经把 `SessionStart` 接到 `.claude/hooks/brain-wake-greeting.mjs`
（`matcher: "startup|resume|clear"`）——只要在这个仓库（或包含它的目录）里开一个 Claude Code
会话，且 `AELOOP_BRAIN_IDENTITY_DB` 在会话启动前已经在环境变量里（比如写进
shell 的 profile，或者用支持传环境变量启动的方式打开会话），SessionStart 就会自动触发这个 hook。

安全默认：`AELOOP_BRAIN_IDENTITY_DB` 没设置时，hook 安静跳过（不注入任何东西、不报错、不影响
会话正常启动）——所以这份 `.claude/settings.json` 对没配身份库的普通会话是零副作用的。

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

- aeloop 仓库本身没有 `CLAUDE.md`（已核实，`find . -iname CLAUDE.md` 零匹配）——本增量没有新建
  一份，`.claude/settings.json`/`.claude/skills/`/`.claude/hooks/` 是独立生效的 Claude Code 配置，
  不依赖任何 `CLAUDE.md` 存在。
- 不改动 `src/**` 任何一行——延续 `docs/conductor-brain-layer/spike/` 既有先例（纯侦察/驱动脚本，
  不参与 `pnpm run build`/`pnpm test`，从 `dist/` 构建产物导入）。
