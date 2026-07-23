# Changelog

本项目所有值得记录的变更都记在这份文件里。格式遵循
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/);本项目暂未遵循
语义化版本号(见 `package.json` 里的 `version`)。

## [Unreleased]

- **2026-07-23** — 首次醒来身份库为空时走交互式引导(#96):`brain-wake-greeting.mjs`
  新增两条状态检测——身份库未配置、或已配置但一条记忆都没有(`listMemories().length
  === 0`)——命中时不再彻底沉默/渲染诚实占位符开场白,改为注入一段引导脚本
  (`docs/conductor-brain-layer/spike/lib/onboarding-greeting.mjs`),带用户走一遍问答式
  配置(env/`brain.local.json` 二选一、IDE 不继承 env 的 `launchctl setenv` 坑、
  `pnpm run build`、`node scripts/seed-brain-identity.mjs`);实测过程中额外发现并记录了
  两个此前未文档化的真实坑——seed 脚本对未注册项目会以非零 exit code 中止(需要先跑
  `scripts/onboard-project.mjs`)、`better-sqlite3` native binding 未编译(#102,独立跟进,
  本次只带 troubleshooting 提示不修复)。引导脚本本身不插值任何身份库/环境变量原始值,
  延续 2026-07-23 早些时候 dbPath 诊断行"根上拿掉"同一条注入安全选择。已有真实数据的
  会话代码路径未改动(`test-hook-greeting.mjs` ①⑤⑥⑦⑩ 覆盖关键子串断言)。`src/**` 零改动,
  `pnpm test` 634 个测试全绿,`pnpm lint` 干净。
  **Zorro/Codex 跨模型二签(gpt-5.6-sol,真跑 exit0)首轮判 FAIL 后修复**:①
  `scripts/install-global-brain.mjs` 的 `COPY_ITEMS` 补上遗漏的
  `onboarding-greeting.mjs`(此前全局安装会让"首次空库"这个 #96 最该生效的场景在
  `import()` 阶段 MODULE_NOT_FOUND、被 fail-soft 吞掉、stdout 静默为空——正好变回 #96
  要堵的洞),新增真实端到端测试
  `scripts/test-install-global-brain-onboarding-e2e.mjs`(真装到临时 `--target`、从无关
  项目 cwd + 空全局库真实 spawn 换入后的 hook,已验证过删掉那条 `COPY_ITEMS` 确实会让
  这个测试失败);② 引导正文新增全局模式感知(`opts.globalMode`)——全局模式下
  `~/.claude/aeloop-brain/repo-snapshot/` 运行时快照不含管理脚本,正文相应提示需要一份
  真实 aeloop checkout + `AELOOP_BRAIN_GLOBAL_MODE=1` 前缀;③ `CLAUDE.md`"醒来"段补齐
  A/B 状态的三态分流(此前只补了 `BRAIN.md`,常驻上下文的 `CLAUDE.md` 遗漏导致"先原样
  复述"和引导指令互相矛盾);④ `scripts/seed-brain-identity.mjs` 的 `fetchOpenIssues()`
  调用点加 try/catch 优雅降级——`gh` 缺失/未登录/调用失败时不再让整个 seed 以非零 exit
  code 中止,记 `skippedIssueSync`、继续正常返回,身份/宪法约束不受影响,引导文案同步
  改成准确描述这个真实行为;⑤ 补齐 `brain-wake-greeting.mjs` 状态 B 分支的 store 关闭
  对称性(`listMemories()` 抛错时也保证 `store.close()`);⑥ 订正 `PRD.md`/`impact.md`
  里和实现不一致或过度声明的措辞。

- **2026-07-22** — 半自动 gate 模式(`workflow.gate_mode: "manual" | "semi-auto"`,
  #63):`semi-auto` 会以 `decidedBy = "system (semi-auto)"` 自动批准
  G1/G2(coder→tester、tester→fix),而 G3(最终 apply)和 Escalation 仍保持
  人工。默认的 `manual` 逐字节保持原有行为不变。内含一个 fail-closed 的
  `reject_threshold` 兜底(格式错误的值会回落到默认值,让升级给人工的安全网
  无法被悄悄关掉)以及一个守护自动批准路径的 gate-identity 断言。
- **2026-07-21** — A5 CLI/TUI:一个真实的、可安装的 `aeloop` 命令
  (`start`/`resume`/`list`),端到端驱动 Loop 引擎跑 `subscription`
  profile——chalk 上色的 diff 渲染(`diff-render.ts`)和 gate 视图
  (`gate-view.ts`,含一个结构上明显不同的 Escalation banner)、一个
  `Prompter` 抽象(真实终端用 `InquirerPrompter`,测试用 `FakePrompter`),
  让交互式 loop(`run-loop.ts`)不需要真实 TTY 也能测、subscription profile
  真实的依赖图装配(`assemble.ts`)、argv 解析 + 分发 + 一个已写明文档的、
  永久性的"模型调用期间按 Ctrl+C"限制(`main.ts`/`bin.ts`),以及一处很小、
  纯新增的 `runner.ts` 导出(`getPendingInterrupt()`),让全新的 CLI 进程能
  只读地重建一个暂停 run 的待处理 gate,供 `aeloop resume` 使用。硬核纵切
  覆盖了 happy path 和阈值升级路径,都是走真实的 `main()` 分发、真实的
  cli-bridge fixture 子进程,加一个可编排脚本的 `FakePrompter`。368 个测试
  通过。
- **2026-07-21** — Loop 编排,第二阶段:阈值升级的硬分支(`escalation.ts`)、
  审计持久化(`audit-store.ts` 里的 `workflow_runs` / `structured_claims` /
  `approvals` 三张表)、一个 `runner.ts` 编排层(`startRun()` / `resumeRun()`),
  以及跨进程 checkpoint 续跑(两个独立进程,续跑纯靠 `dbPath` + `runId`
  驱动)。300 个测试通过。
- **2026-07-21** — Loop 编排,第一阶段:基于 graph 的 coder/tester 状态机
  (`graph.ts`),带 G1/G2/G3 批准 gate(`gates.ts`)、SQLite 支撑的
  checkpoint(`checkpoint.ts`),以及一次真实的端到端纵切,覆盖
  context → prompt → harness → graph → gate 的 interrupt/resume。254 个
  测试通过。
- **2026-07-20** — CLI bridge 层:Claude CLI 和 Codex CLI adapter,真实进程
  spawn + JSONL 流解析,一个能抓到"声称执行了但实际没执行"的工具调用的
  tool-execution 校验器,以及一个共享的 spawn/timeout/stdin 原语
  (`cli-exec.ts`)。内部 profile 标识符改名为按凭证模型命名
  (`subscription` / `apikey`)。228 个测试通过。
- **2026-07-20** — Harness 层:provider 路由、一个 adapter registry、一个
  direct-API 的 LiteLLM adapter,以及带失败重试的 schema 校验,重试时会把
  校验错误喂回 prompt 里。165 个测试通过。
- **2026-07-20** — 引擎脚手架,外加 Context 层(SQLite+FTS5 记忆存储、
  staleness 追踪、一个事务性的 confirm/correct/reject 流程、被拒绝记忆的
  过滤)和 Prompt 层(zod 校验的输出 schema、动态 persona 加载、prompt
  composer),含一次真实的 context → prompt 纵切。96 个测试通过。
