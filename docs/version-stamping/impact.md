# impact — issue #98 版本戳

## 影响范围

**新增文件**(不影响任何既有行为,纯新增):
- `scripts/generate-version.mjs` / `scripts/test-generate-version.mjs`
- `src/shared/version.ts` / `src/shared/__tests__/version.test.ts`
- `src/shared/version-info.generated.ts`(生成产物,不进 git)
- `docs/conductor-brain-layer/spike/lib/version-info.mjs` /
  `docs/conductor-brain-layer/spike/test-version-info.mjs`
- `docs/version-stamping/PRD.md` / `progress.md` / `impact.md`(本文件)

**改动文件**(逐一说明为什么改动是安全的,不破坏既有契约):
- `package.json`:`build`/`lint`/`test`/`test:watch` 四个 script 前置一个新命令。**影响**:
  任何调用这四个 npm script 的地方(本仓库自己的 CI/无 CI,人工跑)都会多花约几十毫秒跑
  `generate-version.mjs`,新增一次 git 子进程调用(`rev-parse`/`status --porcelain`)。**无
  破坏性**:不改变这四个命令本身的产出契约,只是前置了一步。
- `.gitignore`:新增一行忽略 `src/shared/version-info.generated.ts`。**无破坏性**,纯新增
  规则。
- `src/cli/main.ts`:新增 `--version`/`-v` 分支 + `HELP_TEXT` 追加一行 + `unknownOption`
  白名单扩大。**订正(issue #98 Zorro 复审 #4,此前这条和下面「无破坏性」的措辞自相矛盾)**:
  准确的说法是——`start`/`resume`/`list`/未知命令这几条既有**分发/exit code 行为**不变;
  但 `--help` 的**输出文本本身确实变了**(多一行 `aeloop --version, -v` + 标题行末尾附加版本号
  `(0.0.1+9d568ad-dirty)` 这类内容),不是"逐字节不变"——任何脚本化解析 `--help` 输出的下游
  消费者(目前仓库内无此类消费者,已 grep 确认)可能受影响。**另**:Zorro 独立复审抓到一个真
  blocker 并已修复——`unknownOption` 检测此前排在 `--version`/`--help` 两个 early-return
  **之后**,导致 `--version --bogus`/`--bogus --version`/`-vx`/`--help --bogus` 这类命令行
  被静默吞掉、exit 0(应报错 exit 1);已把该检测挪到两个 early-return **之前**,补 4 条对应
  回归用例(`main.test.ts`)。
- `src/evidence/bundle.ts`:`EvidenceBundle` 接口新增必填字段 `engineVersion`。**影响**:任何
  下游对 `EvidenceBundle` 做 TypeScript 结构化赋值(不是通过 `EvidenceBundleBuilder.build()`
  构造)的代码会编译失败——已审计确认全仓库唯一真实构造点就是 `build()` 本身(PRD §3.3 已
  记录审计结论),`conductor-work/app.ts`/`loop/audit-store.ts` 都只是类型引用,不受影响。
  **无破坏性**(对运行时行为):新增字段不影响任何既有读取路径。
- `docs/conductor-brain-layer/spike/lib/render-greeting.mjs`:`renderGreeting()` 新增
  `versionLine` 可选参数。**无破坏性**:未传该字段时输出逐字节不变(已用回归测试验证)。
- `.claude/hooks/brain-wake-greeting.mjs`:新增 `REPO_ROOT` 常量 + 版本行解析(独立
  try/catch)。**无破坏性**:解析失败时开场白其余部分不受影响(已用测试验证);新增一次
  `dist/shared/version-info.generated.js` 动态 import 尝试,失败也不抛错。
- `scripts/install-global-brain.mjs`:`COPY_ITEMS` 新增一条 + 安装尾声新增版本读取/回显逻辑。
  **无破坏性**:`COPY_ITEMS` 新增项只是让全局安装多拷贝一个文件;版本读取逻辑全程 fail-soft,
  读不到时退化成占位符字符串,不影响安装本身成功与否(已用测试验证:fixture 场景下确实读不到
  时不抛错,57 组既有 + 新增断言全绿)。

**跨项目波及**:无。本次改动完全限于 `elishawong/aeloop` 仓库内部,不涉及 whoseorder/
whosehere 等其它项目;全局安装产物只影响操作者自己机器上 `~/.claude/aeloop-brain/`,不改变
`~/.claude/settings.json` 现有的合并逻辑本身(只是被拷贝的文件清单多了一项)。

## 测试建议(回归清单,P0/P1/P2)

**P0(必须验证,直接影响 issue #98 验收标准)**:
- 真跑 `pnpm test` 全绿(634/634,Round 2 修复后),真跑 `pnpm run build`/`pnpm run lint` 全绿。
- 全新 clone / `git clean -fdx` 场景下(删掉 `src/shared/version-info.generated.ts`)直接
  `pnpm test` 也能通过——验证 script 接线真的生效,不是只在文档里写了。
- **(Round 2 blocker 回归)** `node dist/cli/bin.js --version --bogus` / `--bogus --version` /
  `-vx` / `--help --bogus` 四种命令行都必须报 `unrecognized option` + exit 1,不能被静默吞掉
  成一次干净的 `--version`/`--help` 输出(`unknownOption` 检测必须在 early-return 之前跑)。
- `node dist/cli/bin.js --version` 输出的版本号和 `EvidenceBundle.engineVersion`、
  `brain-wake-greeting.mjs` 的版本行三者**完全一致**(跨面一致性,验收核心)。
- 真跑一次 `install-global-brain.mjs --target=<临时目录>`(非 dry-run,不碰真实
  `~/.claude/`),确认 `repo-snapshot/` 下没有 `.git`,独立 spawn 该目录下的
  `brain-wake-greeting.mjs` 依然能读出正确版本(证明运行时不现算 git,而是读 build 时刻
  固化的产物)。

**P1(建议验证,覆盖 fail-soft 边界)**:
- 无 `.git` 环境下跑 `generate-version.mjs`,确认 `gitSha === "unknown-sha"`、不抛错、
  `pnpm run build` 仍能产出可用的 `dist/`。
- **订正(issue #98 Zorro 复审 #3,此前这条描述不准确)**:`dist/` 未构建时跑
  `brain-wake-greeting.mjs`,确认开场白其余部分正常输出,只是缺版本行——此前这里写"已由
  `test-version-info.mjs` 覆盖"是不准确的:那个测试只覆盖 `resolveVersionLine()` 这一个函数
  自己的返回值(dist 缺失 → `undefined`),从没有真实 spawn 过 `brain-wake-greeting.mjs` 的
  `main()`,没验证过它自己那层独立 try/catch + `if (versionLine) data = {...}` 条件渲染路径。
  **已补齐(不再是待办)**:`docs/conductor-brain-layer/spike/test-hook-greeting.mjs` 新增⑦段,
  真实把本仓库 `dist/shared/version-info.generated.js` 临时改名挪走、真 spawn hook,断言
  exit 0 + 无版本行 + 开场白其余部分(身份行/结尾问句)完整,`finally` 块无条件把文件挪回。

**P2(锦上添花)**:
- `install-global-brain.mjs` 安装尾声的"已安装版本"回显文案人工过一遍,确认可读性。
- `--help` 输出改动(多一行 `--version, -v`)确认和 README.md 的既有描述没有冲突(已人工
  核对,README 未逐字复述 `--help` 全文,无需同步)。
