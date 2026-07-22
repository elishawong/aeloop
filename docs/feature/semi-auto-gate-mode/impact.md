# Impact — #63 `workflow.gate_mode: "manual" | "semi-auto"`

> Cypher 完成后产出:这次改动**影响了什么** + 测试建议 + 带优先级的回归清单。Zorro 会拿它核对「有没有漏」。
>
> 这份文档覆盖两轮改动:R1(半自动门开关本体,Cypher 首轮实现,已跑 601 测试绿)+ R2(本轮,针对 Zorro/Codex 独立复审 FAIL 的 2 个 blocker + 1 个加固建议的返工)。R1 的改动未曾单独留痕(首轮完成后直接送审),故本文件把两轮合并记录,不假装 R1 有独立的历史版本。

- **关联 PRD**:`./PRD.md`
- **关联 issue**:[elishawong/aeloop#63](https://github.com/elishawong/aeloop/issues/63)
- **分支**:`feature/semi-auto-gate-mode`(worktree `aeloop-worktrees/gate-mode`,off `origin/main`)
- **最后更新**:2026-07-22

## 1. 改动摘要
新增 `workflow.gate_mode: "manual" | "semi-auto"` 配置开关(`profile/loader.ts` 校验,`cli/run-loop.ts` 唯一消费点),`"semi-auto"` 下 G1/G2 自动放行(记 `decided_by="system (semi-auto)"`),G3/Escalation 永远留人。本轮(R2)额外修:① `resolveRejectThreshold()` 补 fail-closed 数值校验(和兄弟函数 `resolveSchemaMaxAttempts()` 同款)② `run-loop.ts` 自动放行前加一道 DB 状态交叉核对的防御性断言 ③ 建这套文档链,消除代码里指向不存在 PRD 的悬空引用。

## 2. 受影响面
- **改动文件(生产代码)**:
  - `src/profile/loader.ts` —— `ProfileConfig.workflow.gate_mode` 字段 + `assertProfileConfigShape()` 的 fail-closed 校验(R1);本轮(R2)只改了该字段 doc comment 里的悬空引用措辞,零逻辑改动。
  - `src/cli/run-loop.ts` —— `AUTO_APPROVABLE_GATES`/`SEMI_AUTO_DECIDED_BY` 常量 + `runInteractiveLoop()` 的半自动分支(R1);本轮(R2)新增 `AUTO_APPROVABLE_DB_STATE` 映射 + 分支内的 gate-identity 断言(2 行)+ 顶部文件头注释/`AUTO_APPROVABLE_GATES` doc comment 的悬空引用修正。
  - `src/cli/assemble.ts` —— 本轮(R2)`resolveRejectThreshold()` 加 `Number.isInteger(fromProfile) && fromProfile >= 1` 守卫(和同文件 `resolveSchemaMaxAttempts()` 完全同款),不接受的值改为落到 tier 2/3,不再原样返回。
- **改动文件(测试)**:
  - `src/profile/__tests__/loader.test.ts` —— `gate_mode` 合法/非法值测试(R1)。
  - `src/cli/__tests__/run-loop.test.ts` —— 半自动 happy path / Escalation 仍留人 / `manual` 显式等价缺省(R1);本轮(R2)新增 1 条 gate-identity 断言触发测试(用独立 `better-sqlite3` 写连接伪造 DB 状态和 `interrupt.gate` 不一致)。
  - `src/cli/__tests__/assemble.test.ts` —— 本轮(R2)新增 `resolveRejectThreshold` 的 `it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` fail-closed 回归 + 1 条"仍接受合法正整数"的非过严回归。
- **新增文档**:`docs/feature/semi-auto-gate-mode/{PRD,impact,progress,test-report}.md`(本轮,补齐这个安全敏感特性此前完全缺失的文档链)。
- **改动文档**:`docs/DESIGN.md` —— `config.yaml` 示例块加 `workflow.gate_mode` 一行 + 一段新说明段落,链接回本 PRD(本轮)。
- **不受影响**:`src/loop/{graph,gates,escalation,runner}.ts`、`src/loop/audit-store.ts` schema —— 均零改动;`gate_mode` 完全在 `src/cli/` 层消费,`loop/` 层对这个开关的存在毫不知情(PRD §2 Goal 5 的既定设计,可用 `git diff --stat` 核实)。
- **跨项目波及**:无(aeloop 独立 repo)。

## 3. 测试建议
- **该重点测**:
  1. `resolveRejectThreshold()` 的 fail-closed 守卫是否真的堵死了 `NaN`/`Infinity` —— 建议独立确认 `loop/runner.ts:725` 的 `rejectCount >= rejectThreshold` 在一个刻意构造的 `.inf` `reject_threshold` 配置下,是否真的走到 tier 2/3 而非把 `Infinity` 传下去(本轮测试已覆盖该场景,建议 Zorro 独立复核一次)。
  2. gate-identity 断言是否真的挡住了"DB 状态与 interrupt.gate 不一致"这个理论不可达路径 —— `run-loop.test.ts` 新测试用第二条独立写连接直接改 `workflow_runs.current_state`,建议确认这条测试改坏断言代码后确实转红(变异自验,见 progress.md)。
  3. `gate_mode` 缺省/`"manual"`/非法值三种配置在 `assembleProfileDeps()` 真实装配路径下的行为 —— `loader.test.ts` 已覆盖 loader 层,建议额外确认 `assembleProfileDeps()`(`assemble.ts`)组装出的 `CliDeps.profileConfig` 把 `gate_mode` 原样透传,没有中途被吞。
- **边界 / 异常场景**:
  - `workflow.gate_mode: "SEMI-AUTO"`(大小写不匹配)/ `workflow.gate_mode: 1`(非字符串)—— 应触发 `ProfileConfigParseError`,不应被误判为合法值或静默忽略。
  - `workflow` 整个块缺失 vs `workflow: {}`(存在但空)—— 两种情况下 `gate_mode` 都应视为缺省 `"manual"`,行为一致。
  - 半自动模式下 G1 连续多轮 reject(未达 threshold)—— 每一轮 G1/G2 都应各自独立走自动放行分支,不应在第二轮起意外退化成人工模式。
- **不在本轮范围**(如实标注,非阻塞项):`resolveRejectThreshold()` 新增守卫的下限选择(`>= 1`,和 `workflow/coder-tester.ts:48`、`resolveSchemaMaxAttempts()` 两处既有先例保持一致)未额外验证"0 是否应该是合法的 reject_threshold"这个产品语义问题——沿用代码库既有共识(两处独立先例都用 `>= 1`),未重新论证。

## 4. 回归清单(带优先级)
| 优先级 | 回归项 | 为什么 |
|---|---|---|
| P0 | `pnpm test` 609/609 全绿,含本轮新增 8 条 | 本轮改动横跨 `assemble.ts`/`run-loop.ts` 两个已有生产文件,需确认零回归 |
| P0 | `workflow.gate_mode` 缺省/`"manual"` 时行为与改动前逐字节一致(prompter 调用次数、`decided_by` 值) | 这是 PRD §2 Goal 4 的核心承诺——不选择 opt-in 的 profile 必须零感知这个改动存在 |
| P0 | 半自动模式下 G3/Escalation 100% 仍走人工路径,任何输入都不能让它们进入 `AUTO_APPROVABLE_GATES` | 这是本功能唯一不可退让的安全边界(PRD §3),`AUTO_APPROVABLE_GATES` 是硬编码闭集,不吃配置 |
| P0 | `resolveRejectThreshold()` 对 `NaN`/`Infinity`/负数/0/小数全部 fail-closed 落到 tier 2/3,从不原样返回 | R2 blocker 2 的直接修复项,若回归会重新打开"reject_threshold 永远追不上"这个无人值守死循环风险 |
| P1 | gate-identity 断言在正常(无伪造)运行下从不误触发——`run-loop.test.ts` 现有的半自动 happy-path/Escalation 两条测试必须继续绿 | 新加的断言是纯防御层,不应影响任何真实场景下的正常自动放行 |
| P1 | `docs/DESIGN.md` 新增段落与代码实际行为(`AUTO_APPROVABLE_GATES = {G1,G2}`、`decided_by` 字面值)保持一致,不应各说各话 | 文档链是本轮的直接交付物之一,后续如果 `SEMI_AUTO_DECIDED_BY` 字面值改动容易忘记同步 DESIGN.md |
| P2 | `assertProfileConfigShape()` 的 `gate_mode` 校验对 `workflow` 块本身格式异常(如 `workflow` 是数组而非对象)时的行为 —— 现有 `isPlainObject(workflowSection)` 守卫应已覆盖,但未见专门测试用例 | 已知覆盖缺口,如实记录,`workflow` 字段的顶层类型本就未被这次改动强制约束(既有代码的既有姿势) |

## 5. 项目约束自查
- whoseorder:不适用(aeloop 是独立项目)。
- 占位符 / 假数据残留?无 —— 新文档全部基于真实 `gh issue view 63` 输出 + 真实代码路径,无 `<占位符>`。
- `git diff --stat` 核对:改动集中在 `src/profile/loader.ts`、`src/cli/{run-loop,assemble}.ts` 三个文件的生产代码 + 对应三个测试文件 + `docs/DESIGN.md` 一行示例+一段说明 + 本目录四份新文档 —— 符合 PRD 声明的"只改这三项 + 补文档链",未触碰 `src/loop/**`(可用 `git diff --stat -- src/loop` 核实为空)。
