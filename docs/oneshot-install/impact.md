# Impact — 一键安装 CLI(issue #95)

## 改了什么

新增(不改任何已有文件的逻辑):
- `scripts/quickstart.mjs` —— 一键安装编排脚本。
- `scripts/test-quickstart.mjs` —— 对应单测。
- `docs/oneshot-install/{PRD.md,progress.md,impact.md}` —— 文档留痕。

修改(仅新增内容,未删改既有段落的含义):
- `docs/getting-started/README.md` —— 顶部加「零、一键安装」小节;「四、醒来那一刻发生什么」
  末尾加 #106 IDE caveat;「一键化(规划中)」改写成「一键化(已落地)」,指回新脚本。
- `README.md`(仓库根)—— 「快速开始」改名成「快速开始(引擎自身的开发者 quickstart)」并加
  说明区分;新增「安装(开箱即用)」小节指向 `docs/getting-started/`。
- `package.json` —— `scripts` 段加一条 `"quickstart": "node scripts/quickstart.mjs"`。

**零侵入确认**:`install-global-brain.mjs`/`onboard-project.mjs`/`seed-brain-identity.mjs`/
`db-path.mjs`/`task-source.mjs` 一行未改(只 `import` 它们已导出的函数)。`src/**` 一行未改
(`git diff --stat -- src/` 为空)。

## 影响范围

- **新增的一条执行路径**(`node scripts/quickstart.mjs`),不影响任何既有命令的行为——
  `pnpm install`/`pnpm run build`/`pnpm test`/`node scripts/install-global-brain.mjs`/
  `node scripts/onboard-project.mjs`/`node scripts/seed-brain-identity.mjs` 单独跑的行为
  和 issue #95 之前完全一致(本次没有修改这几个文件)。
- **文档改动**面向新用户的第一入口(README/getting-started),不影响任何代码路径。
- 真实副作用**只发生在跑 `quickstart.mjs` 且不带 `--dry-run` 时**:会真的执行 `pnpm install`/
  `pnpm run build`(修改本地 `node_modules`/`dist`,和手动跑这两条命令的副作用完全一致)、真的
  调用 `installGlobalBrain()`(写 `~/.claude/aeloop-brain/` + 合并 `~/.claude/settings.json`,
  这条写入逻辑本身没有被本次改动触碰,继承的是它自己已有的原子写入/备份保证)、真的调用
  `onboardProject()`/seed 的 `main()`(写全局身份库)。

## 已知的、不在本次范围内的观察(如实标注,不是本次要修的 bug)

1. **`aeloop-brain` 快照的 `package.json` 缺 `"type": "module"`**:真实端到端跑的时候,
   动态 `import()` 快照里的 `dist/context/store.js` 会打印一条 Node 的
   `MODULE_TYPELESS_PACKAGE_JSON` **警告**(不是错误,不影响功能——安装/自检都是 exit 0)。这是
   `install-global-brain.mjs` 自己生成快照 `package.json` 的既有行为(只含
   `{name, private, dependencies}`,不含 `"type"` 字段),不是本次新增代码引入的问题,而且
   `install-global-brain.mjs` 是本次范围内**明确不能碰**的文件(已过 Zorro 多轮复审)。如果要修,
   需要单独开一个 issue 改 `install-global-brain.mjs` 自己生成 `package.json` 那一段。
2. **在 aeloop 仓库自身内测试的一个潜在混淆点**:aeloop 仓库自己已经提交了一份项目级
   `.claude/settings.json`(dogfood 用,`AELOOP_BRAIN_IDENTITY_DB`/`.claude/brain.local.json`
   路径,不带 `AELOOP_BRAIN_GLOBAL_MODE=1`),和一键脚本装的**全局**级 `~/.claude/settings.json`
   hook 是两条独立的 SessionStart 注册。如果有人在 aeloop 仓库自己的目录里开一个新会话验证
   "装完到底醒不醒",项目级 hook(如果本地没配 `.claude/brain.local.json`)会走"未配置"引导态,
   和全局 hook 的"意识已加载"正常态可能会一起触发,容易让人误以为哪一条坏了。这是 aeloop 仓库
   已有的 dogfood 配置 + 本次新增的全局安装能力叠加出来的组合现象,不是本次改动引入的新 bug,
   也不在 issue #95 的范围内解决(需要的话是另一个"要不要把 dogfood 配置也切成一次性/可关闭"
   的独立讨论)。**验证建议**:装完想确认效果,在**另一个**项目目录里开新会话验证,而不是在
   aeloop 仓库自身里。

## 测试建议(给 Zorro / 指挥官验收用)

| 优先级 | 检查项 |
|---|---|
| P0 | `node scripts/quickstart.mjs --target=<临时目录>` 真跑一次,exit 0,自检三项全 OK |
| P0 | 同一个 `--target` 再跑一次,exit 0,`settings.json` 里 `SessionStart` 条目仍是 1 条(不重复) |
| P0 | `git diff --stat -- src/` 为空 |
| P1 | `node scripts/test-quickstart.mjs` 全部 `PASS`(12 条 assertion 组) |
| P1 | `pnpm install && pnpm build && pnpm test` 全绿(58 文件 634 测试) |
| P1 | `node scripts/quickstart.mjs --dry-run`(对真实 `$HOME`)不产生任何真实写入(已人工验证:
     跑前后 `~/.claude/aeloop-brain` 不存在、`~/.claude/settings.json` 不含 `aeloop-brain`) |
| P2 | `node scripts/quickstart.mjs --help` / 传一个不认识的参数 → 明确报错 exit 1,不是裸堆栈 |
| P2 | `node scripts/quickstart.mjs --task-source=github`(需要 `gh` 已登录 + 目标仓库有 GitHub
     origin)——本次未做真实网络端到端(不依赖网络的单测已覆盖透传逻辑,见 `test-quickstart.mjs`
     「--task-source=github 透传到两处」) |
