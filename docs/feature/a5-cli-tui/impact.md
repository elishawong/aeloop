# Impact — A5 CLI/TUI

> Cypher 完成后产出:这次改动**影响了什么** + 测试建议 + 带优先级的回归清单。Zorro 会拿它核对「有没有漏」。
>
> **2026-07-21 追加(B10,Zorro 独立复审返工)**:本文件 §1-§5 是 B0-B9 首轮的原始记录,保留不改(可追源);这轮返工的影响面单独写在文末新增的 §6。
> **2026-07-21 再追加(B11,Zorro R2 独立复审返工)**:§6 是 B10(R1 返工)的记录,同样保留不改;这轮(R2)的影响面单独写在文末新增的 §7。

- **关联 PRD**:`./PRD.md`
- **分支**:`feature/issue-22-a5-cli-tui`(基于 main `c8d0289`)
- **最后更新**:2026-07-21

## 1. 改动摘要
新增 `src/cli/` 层——一个真实、可安装的 `aeloop` 命令(`start`/`resume`/`list`),驱动 A0-A4b 已建好的 Loop 引擎针对 subscription profile 跑起来,带 chalk 彩色 diff/门渲染 + `@inquirer/prompts` 交互提示 + Escalation 门的结构性视觉区分。`src/loop/runner.ts` 新增一个只读导出 `getPendingInterrupt()`,是这次唯一改动到 `src/cli/` 之外的文件。

## 2. 受影响面
- **直接改动(新文件)**:`src/cli/{colors,diff-render,gate-view,prompter,assemble,run-loop,main,bin,errors}.ts` + 对应 `__tests__/*.test.ts` + `src/cli.e2e.test.ts`(硬性垂直切片)。
- **直接改动(既有文件)**:
  - `src/loop/runner.ts` —— 新增 `getPendingInterrupt()` 导出,**不改动任何既有函数体**(`startRun`/`resumeRun`/`getResumableRuns`/`computeRunProgress` 等一字未动,只是新函数复用了已有的私有 `computeRunProgress()`)。
  - `src/loop/__tests__/runner.test.ts` —— 新增 5 条测试(`describe("getPendingInterrupt")`),既有测试用例逐字未改。
  - `package.json` —— 新增 `chalk`/`@inquirer/prompts` 两个生产依赖 + `bin.aeloop` 字段。
  - `pnpm-lock.yaml` —— 对应锁文件更新。
- **间接波及**:
  - 新增 `profiles/subscription/workflow.db` 这个永久文件路径约定(和既有 `memory.db` 并列,`AuditStore`+checkpointer 共享)——已在 `.gitignore` 的 `*.db` 规则覆盖范围内,不需要改 `.gitignore`。
  - `applyNode()`(`graph.ts`)、`CoderOutput.diff` 自报字符串、G2 二选一约束等既有 A0-A4b 行为**完全未改**——A5 只是渲染/门控这些既有产出,PRD §0/§2 明确非目标,已核实代码零改动。
- **跨项目波及**:无(aeloop 是独立 repo,这次改动不涉及 whoseorder/whosehere)。

## 3. 测试建议
- **该重点测**:
  1. `getPendingInterrupt()`(`runner.ts`)——这是唯一触碰既有生产代码路径的改动,建议重点核对它是否真的"零写入"、是否正确处理 runId 不存在/run 已终态两种边界。
  2. `run-loop.ts` 的门路由/decideForGate 逻辑——G2 是否真的严格二选一(approved/escalate,不给 rejected)、Escalation 是否真的三选一且 revise 才问理由。
  3. B8 硬性垂直切片(`src/cli.e2e.test.ts`)——建议独立跑一遍确认真的接了真 fixture 子进程而非假集成(`pnpm test -- src/cli.e2e.test.ts --reporter=verbose` 能看到真实 ANSI 输出,包括 escalation banner)。
  4. `assemble.ts` 的 `AI_AGENT_PROFILE=apikey` 拦截时机——建议确认是在 `loadProfile()` 之前拦的(抛 `UnsupportedProfileError`),不是加载失败后才抛 `ProfileNotFoundError`。
- **边界 / 异常场景**:
  - `aeloop resume <runId>` 对一个已经 `completed`/`cancelled` 的 run —— 应抛 `RunNotResumableError`,不应触发 `runInteractiveLoop`。
  - `aeloop start` 缺任务参数 / `aeloop resume` 非数字 runId —— 应在 assemble 依赖图组装之前就报错(`assembleSubscriptionDepsMock` 不应被调用,`main.test.ts` 已验证)。
  - SIGINT 处理:每次 `main()` 调用应装/卸监听器,不跨调用累积(`main.test.ts` 有断言)。
  - `renderDiff()`/`gate-view.ts` 面对不严格符合 unified-diff 格式的输入(`CoderOutput.diff` 是模型自报字符串)不应抛错。

## 4. 回归清单(带优先级)
| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | `pnpm test`(A0-A4b 既有 300 条用例)全绿,不因这次改动回退 | `runner.ts` 是这次唯一改动的既有生产文件,虽只新增导出,仍需确认零回归 |
| P0 | G2 门决策严格二选一(approved/escalate),`rejected` 触发 `UnhandledGateDecisionError`(A4a 起永久决定,A5 不应引入第三选项) | issue #22 原文把 G2 错写成三选一,PRD §0.1 已订正,回归测试应锁住订正后的真实契约 |
| P0 | `getPendingInterrupt()` 真的零写入(调用前后 `workflow_runs`/`approvals`/`structured_claims` 内容不变) | 这是唯一新增的 Loop 层导出,若意外写入会破坏 A4b 已建立的审计完整性保证 |
| P1 | B8 硬性垂直切片的两条用例(happy path / escalation path)在 CI 环境(非本机)下依然能真实 spawn fixture 子进程并通过 | fixture 脚本路径用 `import.meta.url` 相对定位,理论上环境无关,但子进程 spawn 类测试在不同 CI 沙箱下偶有权限/路径差异,值得独立确认一次 |
| P1 | `AI_AGENT_PROFILE=apikey` 场景清晰报错、不落任何 `profiles/apikey/*.db` | 非目标场景的防呆,PRD §10 明确验收点 |
| P2 | `pnpm build` 后 `dist/cli/bin.js` 的 shebang/可执行权限在 `npm link`/全局安装场景下真实可用 | 本轮只手动烟测了 `node dist/cli/bin.js`,未测试真正的全局符号链接安装路径 |
| P2 | 长任务描述(`aeloop start "<很长的任务文本>"`)在真实终端下的换行/渲染观感 | 不影响正确性,纯观感,PRD 未要求这轮特别验证 |

## 5. 项目约束自查
- whoseorder:不适用(aeloop 是独立项目,非 whoseorder vendor 代码)。
- 占位符 / 假数据残留?无——`renderDiff`/`gate-view.ts` 渲染的都是真实 `GatePayload` 字段,`main.ts` 的三条命令都走真实 `assembleSubscriptionDeps()`/`runner.ts` 导出,没有留 TODO/stub。
- `git diff --stat` 核对:除 `src/cli/**`(新)+ `src/cli.e2e.test.ts`(新)外,只改了 `src/loop/runner.ts`(+36 行,纯新增导出)+ `src/loop/__tests__/runner.test.ts`(+123 行,纯新增测试)+ `package.json`/`pnpm-lock.yaml`(依赖)+ 四份文档(B9 范围内)——符合 PRD §10 "No changes outside `src/cli/**` except the single, additive `runner.ts` export" 验收标准。

---

## 6. B10(Zorro 独立复审返工)的影响面

### 6.1 改动摘要
Zorro 独立复审(含 Codex `gpt-5.6-sol` 二签)判 FAIL,指挥官裁决后本轮做的改动:2 个文档订正(P0-1,不改代码)+ 1 个 A5 范围内轻量兜底新模块(P0-2,run-origin.ts)+ 1 个安全 seam 收紧(P1-3)+ 1 个新清洗模块 + 3 处接入点(P1-4)+ 1 条真实跨进程 e2e 测试(P1-5)+ 4 处假绿修复(🟡)+ 4 处小项(顺手修)。**这轮同样没有触碰 `src/loop/audit-store.ts` 的 schema**(指挥官明确范围裁决),`src/loop/runner.ts` 生产代码本身零改动(只有 `runner.test.ts` 的快照测试变宽)。

### 6.2 受影响面(本轮)
- **新文件**:`src/cli/run-origin.ts`、`src/cli/sanitize-terminal.ts`、`src/cli/__tests__/run-origin.test.ts`、`src/cli/__tests__/sanitize-terminal.test.ts`。
- **改动文件(生产代码)**:`src/cli/main.ts`(P0-2 布线 + P1-3 删 `env` + P1-4 list 列清洗 + 顺手修四项)、`src/cli/assemble.ts`(`CliDeps.profileDir` 字段)、`src/cli/diff-render.ts`(清洗接入)、`src/cli/gate-view.ts`(清洗接入)、`src/cli/run-loop.ts`(清洗接入 + `printFinalSummary` 措辞)、`src/cli/prompter.ts`(`FakePrompter.select()` 记录 choices)、`src/harness/adapters/__tests__/fixtures/fake-claude.fixture.mjs`(opt-in prompt capture,行为默认不变)。
- **改动文件(测试)**:`src/cli.e2e.test.ts`(env scope 化 + 新增跨进程 resume 测试 + memory 内容断言)、`src/cli/__tests__/{main,assemble,run-loop}.test.ts`、`src/loop/__tests__/runner.test.ts`(仅测试文件,widened 快照,生产代码零改动)。
- **文档**:`docs/feature/a5-cli-tui/PRD.md` §0(P0-1 订正)、`CHARTS/knowledge/aeloop.md`(ai-agent 仓,`ClaudeCliAdapter` 条目同一处订正)。
- **不受影响**:`src/loop/audit-store.ts`、`src/loop/graph.ts`、`src/loop/gates.ts`、`src/loop/escalation.ts`、`src/harness/adapters/claude-cli-adapter.ts` 生产代码本体——本轮范围裁决明确排除,均零改动(可用 `git diff --stat` 核实)。

### 6.3 测试建议(本轮新增)
1. **P0-2 的 origin 警告是不是真的"只警告不阻断"**——`aeloop resume` 在 cwd 不匹配时应该仍然正常推进到底,不应该因为警告而提前退出;建议独立跑一次 `aeloop resume <runId>` 从不同目录确认。
2. **P1-3 的安全收紧有没有引入误报**——正常场景下(`AI_AGENT_PROFILE` 未设置或设为 `subscription`)`aeloop` 命令应该完全不受影响;只有"调用方试图伪造 env"这个此前存在的旁路被关掉了。
3. **P1-4 清洗会不会误伤合法 diff/issue 文本**——`sanitize-terminal.ts` 只剥离控制字节,不改动可见字符(含 emoji/中文/URL 等),已有测试覆盖但建议 Zorro 额外过一遍是否有遗漏的合法 unicode 边界情况(比如某些 emoji 的零宽连接符是否被误伤——本轮测试未覆盖零宽字符场景,如实标注)。
4. **P1-5 的跨进程测试是否真的没有共享内存态**——建议 Zorro 复核 `src/cli.e2e.test.ts` 新测试里两次 `main()` 调用之间除了 `profilesRoot`(磁盘路径字符串)之外,是否真的没有任何 JS 对象引用被复用。

### 6.4 回归清单(本轮新增,带优先级)
| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | `pnpm test`(407/407)/`pnpm lint`/`pnpm build` 全绿,首轮 368 条既有用例零回归 | 本轮改动面横跨多个既有文件,需确认没有破坏 B0-B9 已锁定的行为 |
| P0 | `P1-3` 收紧后,`bin.ts` 生产路径(零 override)行为完全不变 | `bin.ts` 从未传 `env`,理论上不受影响,但需要独立确认没有隐式依赖 |
| P0 | `P1-4` 清洗接入后,正常(无恶意载荷)diff/issue/question 渲染输出与改动前逐字节一致(除去被清洗掉的控制字符外) | 清洗层是新加的过滤器,必须验证不误伤正常内容——`diff-render.test.ts`/`gate-view.test.ts` 原有断言全部原样保留通过即是证据 |
| P1 | `P0-2` 的 `run-origins.json` sidecar 在极端情况(profileDir 不可写、文件被手工删除、JSON 损坏)下均不应导致 `aeloop` 命令本身失败 | best-effort 设计,`run-origin.test.ts` 已覆盖但建议独立抽查 |
| P1 | `aeloop --help`/`-h`/裸命令的输出文本与 `README.md` "Getting started" 章节保持一致(不要文档和代码各说各话) | 顺手修新增的 help 输出目前手写,后续 README 若改动措辞容易和这里脱节,值得一条长期回归项 |
| P2 | `run-loop.ts`'s `decideForGate()` 对 `question` 的清洗(超出原清单范围,见 progress.md B10"发现的新问题")目前没有专门单测,只有间接覆盖 | 已知覆盖缺口,如实记录,不算本轮阻塞项(现状下 `question` 来源是硬编码字符串,不可达攻击面) |

---

## 7. B11(Zorro R2 独立复审返工)的影响面

### 7.1 改动摘要
R2 独立复审判 FAIL 的根因是 B1——`run-origin.ts` 的兜底代码本身有一个真实可复现的崩溃 bug,违反自己文件头承诺的"never throws"契约。本轮修了这一个真 bug + 4 项建议改动(1 处纯注释订正的头注释、1 处清洗补漏、1 处注释订正、1 处错误路径资源泄漏)。**没有新增生产模块**,全部是对 B10(R1)已有文件的修补,不涉及 `audit-store.ts` schema、不涉及 P0-1 的代码级修复(仍是文档订正,范围不变,只是把订正对象从 PRD/knowledge 扩展到 adapter 自己的头注释)。

### 7.2 受影响面(本轮)
- **改动文件(生产代码)**:`src/cli/run-origin.ts`(B1 核心修复:新增 `isValidRunOrigin()` + `getRunOrigin()` 接入它;P1-4 补漏:`describeCwdMismatch()` 清洗两个 cwd)、`src/cli/main.ts`(P1-4 补漏:`runList` 清洗展示用的 cwd)、`src/cli/sanitize-terminal.ts`(注释订正,零逻辑改动)、`src/harness/adapters/claude-cli-adapter.ts`(头注释 + `ALLOWED_TOOLS` 注释订正,零逻辑改动)、`src/cli/assemble.ts`(错误路径资源泄漏修复)。
- **改动文件(测试)**:`src/cli/__tests__/run-origin.test.ts`(+7)、`src/cli/__tests__/main.test.ts`(+4)、`src/cli/__tests__/sanitize-terminal.test.ts`(+1)、`src/cli/__tests__/assemble.test.ts`(+1)。
- **不受影响**:`src/loop/**` 全部(audit-store.ts/graph.ts/gates.ts/escalation.ts/runner.ts)、`src/cli/{colors,diff-render,gate-view,prompter,run-loop,bin,errors}.ts`、`src/cli.e2e.test.ts`——均零改动,可用 `git diff --stat` 核实。

### 7.3 测试建议(本轮新增)
1. **B1 修复的边界完整性**——`isValidRunOrigin()` 目前只检查 `cwd`/`recordedAt` 是字符串,不检查字符串是否非空/是否像一个真实路径;一个 `{"cwd":"","recordedAt":""}` 会被判定"合法"并原样展示为空字符串 cwd。当前判断:这仍然优于崩溃,且 sidecar 只由 `recordRunOrigin()` 自己写(不会写出空字符串),真实触发面很窄,本轮未额外加固,如实记录。
2. **assemble.ts 泄漏修复覆盖的三个失败点**——本轮的回归测试只覆盖了 `buildAdapterRegistry()` 抛错这一条路径(`memoryStore` 已开、`checkpointer` 未开时的分支);`createSqliteCheckpointer()`/`new AuditStore()` 抛错(此时 `checkpointer` 可能已开或未开)的两条路径靠代码走查确认逻辑对称覆盖(`checkpointer?.db.close()` 的可选链已经处理"还没赋值"的情况),但没有为这两条单独构造真实失败场景的测试用例,建议 Zorro 视情况要求补齐。
3. **头注释订正(claude-cli-adapter.ts/sanitize-terminal.ts)是纯文档改动**——建议 Zorro 用 `git diff` 直接确认这两个文件除注释外的可执行代码字节完全未变(尤其 `ALLOWED_TOOLS` 常量的值、`OTHER_ESCAPE_SEQUENCE` 正则本身),不需要重新审查行为。

### 7.4 回归清单(本轮新增,带优先级)
| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | `pnpm test`(419/419)/`pnpm lint`/`pnpm build` 全绿,R1 返工后既有 407 条用例零回归 | B1 是真实崩溃 bug 的修复,必须确认没有在修复过程中引入新的行为偏差 |
| P0 | B1 的两条 main.test.ts 端到端回归(`{"9":null}`/`{"1":null}` 分别对应 resume/list 的真实崩溃现场)在改前红改后绿的变异验证下成立 | 这是本轮唯一的真 P0,回归覆盖必须精确对应 Zorro/Codex 复现的那两处调用点,不能只在 `run-origin.test.ts` 单元层面覆盖 |
| P1 | `assemble.ts` 错误路径的 `memoryStore.close()`/`checkpointer?.db.close()` 不会在**成功**路径上被意外多调用一次(泄漏修复常见的反向 bug:成功时也关掉了不该关的连接) | `assemble.test.ts` 首个"assembles a real dependency graph"测试的 `afterEach` 里 `openDeps?.memoryStore.close()` 若在生产代码里已经被关过,`better-sqlite3` 的 `close()` 是否幂等值得独立确认一次 |
| P2 | `describeCwdMismatch()`/`runList` 的清洗改动不改变正常(无恶意载荷)cwd 路径的展示文本 | 防御纵深改动,`main.test.ts`/`run-origin.test.ts` 原有断言全部原样保留通过即是证据,但建议独立抽查一次真实终端输出的观感 |

