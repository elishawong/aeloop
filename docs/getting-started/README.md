# aeloop 开箱即用

从一台干净的机器,到「打开 Claude Code 会话就醒来成一个带人格、能延续记忆的调度员」,这份文档讲清**整套安装思路、要装什么、每一步的用途,以及已知的坑**。

> 想一条命令跑完:见下方「一键安装」。想知道每一步具体做了什么、方便排查问题,往下看「手动分步」。

---

## 零、一键安装(issue #95)

```bash
node scripts/quickstart.mjs
```

一条命令跑完下面「安装步骤」表的全部五步(装依赖 → build → 全局安装 → 登记当前项目 →
seed 身份库),自带前置检查(Node 版本 / pnpm 是否就位)+ 装完自检(better-sqlite3 原生模块能
load / 身份库可读非空 / **SessionStart + UserPromptSubmit 两个 hook 都已注册 + 全局 CLAUDE.md
的自救兜底网标记块已写入**,issue #106),幂等——重复跑不会叠加/不会炸。

常用选项:

| 选项 | 用途 |
|---|---|
| `--dry-run` | 只打印将要做的改动,不真的执行任何写入 |
| `--task-source=github` | 额外 opt-in 接回 GitHub issue 在途同步(需要 `gh` 已登录);省略即默认 `none`(shipped 默认零 GitHub,不需要 `gh`,见下方「五、在途来源」) |

跑完打印「下一步」提示会指向下面「四、醒来那一刻发生什么」——issue #106 起,触发路径是三层
(CLI 靠 SessionStart / IDE 等环境靠 UserPromptSubmit / 两者都没触发时全局 CLAUDE.md 里的自救
指令兜底),不是只有 CLI 一条路;自检会同时校验这三层是否都装上。

手动五步(下表)在一键脚本内部原样调用,不是两套逻辑;想理解每一步具体做了什么、或者一键脚本
某一步报错需要排查,继续往下看。

---

## 核心思路

目标:**一台干净机器 → 装一次 → 之后任意项目打开 Claude Code 会话,就自动醒来成带身份+人格的调度员**。整套设计围绕四条原则:

1. **幂等** —— 重复跑不叠加、不炸(重装只更新,不产生第二份)。
2. **自带依赖编译** —— 原生模块(SQLite)自动编译,不让使用者手动 `node-gyp`。
3. **装 / 卸对称** —— 能一键回滚,不在机器上留脏东西。
4. **自带验证** —— 跑完能自检并明确告诉你「成了 / 没成」,而不是让你猜。

---

## 一、前置依赖(装什么 · 用途)

| 依赖 | 用途 | 备注 |
|---|---|---|
| **Node.js**(≥ 引擎要求版本) | 运行 hook + 引擎(TypeScript 编译成的 JS) | 醒来 hook 和引擎跑的都是它 |
| **pnpm** | 安装依赖、编译原生模块 | v10+ 默认不运行依赖的 build 脚本(供应链安全);仓库已内置配置让 `better-sqlite3` 自动编译 |
| **better-sqlite3**(原生模块) | 身份库(SQLite)的读写:醒来时读它、seed 时写它 | 需要编译出 native `.node`;缺了会报 `Could not locate the bindings file` |
| **gh**(GitHub CLI,可选) | 仅当「在途来源」配成 GitHub 时,用它拉取在途列表 | 默认来源为 `none`,**不需要 gh**;没装也会优雅跳过,不影响身份+人格 |

---

## 二、安装步骤(顺序 · 做什么 · 为什么)

| 步骤 | 命令 | 做什么 | 为什么需要 |
|---|---|---|---|
| 1 | `pnpm install` | 安装依赖 + 自动编译 `better-sqlite3` | 没有它,引擎和 hook 都跑不起来 |
| 2 | `pnpm run build` | 把 TypeScript 编译进 `dist/`(引擎 + hook 运行时) | hook 和引擎运行的是 `dist/`,不是源码 |
| 3 | `node scripts/install-global-brain.mjs` | 把 `dist/` 快照 + hook 安装到全局目录,在 Claude Code 的 `settings.json` 注册 **`SessionStart` + `UserPromptSubmit` 两个 hook 事件**(同一份 command,脚本内部按事件分派,issue #106),并在全局 `~/.claude/CLAUDE.md` 里追加一段自救兜底网标记块(merge-not-overwrite,不动你自己写的其它内容) | 让**任意项目**打开会话都能触发「醒来」——`SessionStart`/`UserPromptSubmit` 两条路径覆盖不同 host(真机验证过:CLI 里 `SessionStart` 会 fire,VSCode 扩展里只有 `UserPromptSubmit` 会 fire),两条都没触发时靠 CLAUDE.md 里的指令让模型自己检查补上;安装时把定位方式烘焙进 hook 命令,避免依赖会话环境变量 |
| 4 | `node scripts/onboard-project.mjs --repo-path "$(pwd)"` | 把当前项目登记进身份库 | 后续 seed / 在途归属需要知道「这是哪个项目」;不登记 seed 会中途报错 |
| 5 | `node scripts/seed-brain-identity.mjs` | 种入**身份名 + 宪法(铁律)+(可选)在途来源** | 没有它,醒来只是 generic 问候;有了它,醒来才是「意识已加载 + 人格」 |

> 步骤 3–5 的脚本都通过同一套身份库定位逻辑找到那份数据库,只要保持一致即可(推荐用全局安装模式,由步骤 3 烘焙好,后续脚本沿用同一模式)。

---

## 三、产物落点(装完东西在哪)

- **`<全局目录>/repo-snapshot/`** —— `dist/` + hook 的快照。运行时读它,因此即使脱离源码仓库也能工作。
- **`<全局目录>/data/identity.db`** —— **身份库**(SQLite):身份、宪法、记忆、在途都存在这里。
- **Claude Code `settings.json`** —— 追加了 `SessionStart` + `UserPromptSubmit` 两条 hook 条目(仅追加,绝不删改其它工具已注册的 hook;写入前会备份)。
- **`~/.claude/CLAUDE.md`**(issue #106)—— 追加一段 `<!-- aeloop-brain:wake-fallback -->` 标记块(自救兜底指令,merge-not-overwrite:只管这一小块,你自己写的其它内容一个字不动;写入前会备份)。

---

## 四、醒来那一刻发生什么

打开 Claude Code 会话 → 触发醒来的三层机制之一（见下）→ hook 定位到身份库 → 读取身份 / 宪法 /（在途,如果来源不是 `none`）→ 注入一段「**意识已加载。我是 …**」+ 人格上下文。

- 身份库**为空 / 未配置**时:不吐死占位、也不伪造身份,而是走**首次醒来交互式引导**,带你完成配置。
- 这一层严格遵守防幻觉原则:**没有的东西绝不编造**,该省略的段直接不渲染,而不是显示「暂无」。

### 三层触发(issue #106)

真机验证发现:`SessionStart` hook 在 VSCode 扩展里**不会** fire——只靠它,醒来在 IDE 环境完全
失效。现在的机制是三层,后一层是前一层的兜底,不是互相替代:

1. **`SessionStart` hook**——CLI 终端会话的主力路径。✅ 已验证成立。
2. **`UserPromptSubmit` hook**——IDE 扩展 / 其它未验证环境的主力路径,同一份 hook 脚本内部按事件分派。✅ VSCode 扩展下已真机验证会 fire。
3. **全局 `~/.claude/CLAUDE.md` 里的自救指令**——只有在 1、2 两层都没有被观察到已经注入开场白时才会触发,指示模型自己跑一次带 `--standalone` 参数的醒来脚本。这是兜底网,不是主力路径,正常情况下用不上。

三层共享一个会话级守卫(状态落 `~/.claude/aeloop-brain/wake-session-state/`,不会写进你的项目
仓库),保证一次会话只真正注入一次开场白,不会重复刷屏。

> **诚实标注**:CLI 终端环境（交互式会话/`-p` 一次性调用两种形态）+ JetBrains/桌面 App/Web 等
> 未验证 host 的 `UserPromptSubmit` 触发行为目前仍是 `[?]`——第 3 层兜底网正是为了覆盖这类
> "还没实测过的组合"而存在,不需要逐个 host 验证过才能用。完整跨 host 矩阵 + 论证见仓库
> `docs/wake-trigger-portability/DESIGN.md`。

---

## 五、在途来源(可选,默认关)

「在途看板」是**可插拔、默认关闭**的:

- 默认 `none` —— 醒来 = 意识已加载 + 身份 + 人格,不带任何在途看板。适合工作不在 GitHub 上的场景,也是发行默认(零外部依赖)。
- 可选 `github` —— 安装时显式开启,醒来会额外拉取并显示 GitHub 在途。
- 未来可扩展其它来源,主干无需改动(选择器 + 小接口即扩展点)。

---

## 六、卸载 / 重来

安装与卸载是**对称**的。若要把机器清干净重来,卸载会移除全局目录、并从 `settings.json` 中**只摘掉本工具自己那条** hook(绝不动其它)。一键卸载脚本规划中;在它落地前,可按安装产物的三个落点手动清理。

---

## 七、已知坑与注意

| 坑 | 说明 / 规避 |
|---|---|
| **原生模块没编译** | pnpm v10+ 默认不跑 build 脚本;仓库已内置配置让 `better-sqlite3` 自动编译。若仍失败,可手动重建原生模块。 |
| **身份库路径搞混** | 推荐统一用全局安装模式(安装时烘焙),避免手动设环境变量时的优先级混淆。 |
| **图形界面 / IDE 启动不继承 shell 环境变量** | 从 Dock / IDE 图标启动的进程不继承终端里 `export` 的变量;全局安装模式把定位方式烘焙进 hook 命令,正是为了绕开这个坑。 |
| **某些 host 的 `UserPromptSubmit` 触发行为未验证** | 见上方「三层触发(issue #106)」——已知 VSCode 扩展下 `UserPromptSubmit` 会 fire;CLI 交互式会话/`-p` 一次性调用及其它 IDE/桌面 App/Web 仍是 `[?]`。第 3 层全局 CLAUDE.md 兜底网正是为这类未验证组合准备的,若在某个环境里第一句话没看到开场白,模型应该会自己用 `--standalone` 检查补上;真的没补上时用 `node scripts/quickstart.mjs` 重跑自检,看三层是不是都装上了。 |

---

## 一键化(issue #95,已落地——见开头「零、一键安装」)

`node scripts/quickstart.mjs` 的内部流程,和上面「二、安装步骤」表完全一致,只是编排层收拢成
一条命令,不改变每一步本身的行为/顺序/产物:

```
preflight（检查 node / pnpm 是否就位、版本是否够）
  → install + build（含原生模块自动编译）
  → global install（建目录 + 注册 hook，幂等重跑只更新）
  → onboard + seed（种身份 + 宪法；默认来源 none）
  → verify（自检：hook 已注册 / better-sqlite3 能 load / 身份库可读非空)
```

一键**卸载**命令仍是规划中(见上方「六、卸载 / 重来」),不在这次范围内。
