# Test report — #63 `workflow.gate_mode: "manual" | "semi-auto"`

> Round 1 是在这个 Cypher 会话之外由 Zorro(+ Codex 跨模型二签)审的——我(Cypher)没有直接见证那次复审;下面 §1 是我根据这一轮任务简报里转述给我的发现做的如实转述,不是逐字记录(我手上没有原始报告文件——`docs/feature/semi-auto-gate-mode/` 下和仓库里任何其他地方都不存在;这实际上是这个目录下的第一份文档)。§2 往后是这一轮(R2)自己的工作,是我亲自跑过、亲自验证过的,可以当第一手事实来陈述。

---

## Round 1 —— Zorro + Codex 独立复审:FAIL

**结论**:FAIL —— 2 个 blocker,1 个强烈加固建议。

### Blocker 1 —— 一个安全敏感功能零文档,悬空的"per the PRD"引用
`src/cli/run-loop.ts:141` 和 `src/profile/loader.ts` 的 `gate_mode` 文档注释,在说明 G3/Escalation 始终保持人工这个安全不变量时都引用了"per the PRD's explicit requirement",但仓库里 issue #63 根本没有任何 PRD(这一轮之前 `docs/feature/` 下压根没有 `semi-auto-gate-mode/` 这个目录)。对一个从四个审批 gate 里移除两个人工审核的功能来说,一条无法验证、指向不存在的设计文档的引用是幻觉风险的红旗,不是外观上的小瑕疵——读者没法确认这个安全边界是不是真的经过设计和评审,只能看到一句代码注释里的断言。

### Blocker 2 —— `reject_threshold` 把 `NaN`/`Infinity` 当合法值接受
`src/cli/assemble.ts:210-218` 的 `resolveRejectThreshold()` 之前返回值前只检查了 `typeof fromProfile === "number"`——没有 `Number.isInteger`/有限性守卫,不像它的兄弟函数 `resolveSchemaMaxAttempts()`(同一个文件,约 243 行)已经有一个了。一个 YAML 的 `.nan`/`.inf` tag 会被解析成真正的 JS `NaN`/`Infinity`(两者的 `typeof` 都是 `"number"`)。后果:`src/loop/runner.ts:725` 的 `rejectCount >= rejectThreshold` 升级检查在一个 `NaN`/`Infinity` 阈值面前永远不可能求值为 `true`——在 `workflow.gate_mode: "semi-auto"` 下,这就意味着一个无人看管、无边界的自动批准循环,永远到不了 Escalation 见到人,而这正是 semi-auto 设计所依赖的那道后盾。

### 强烈建议(按必做处理,这一轮已完成)—— gate 身份断言
`src/cli/run-loop.ts:199-206` 的 semi-auto 分支仅凭 `interrupt.gate` 就决定要不要自动批准,然后无条件发出一个通用的 `{decision:"approved"}`。建议:在自动批准之前先断言这条 run 真实的、DB 持久化的待处理 gate 确实在 `{G1, G2}` 里,这样即便 `interrupt.gate` 和 DB 状态哪天真的对不上,系统也是 fail closed,而不是可能自动批准了 G3。

---

## Round 2(这一轮)—— 修复与自我验证

### 修复 1(blocker 1):文档 + 清理悬空引用
- 已创建 `docs/feature/semi-auto-gate-mode/{PRD,impact,progress,test-report}.md`(本文件包含在内)。
- `src/cli/run-loop.ts`:把文件头段落(原来在 21-34 行)和 `AUTO_APPROVABLE_GATES` 的文档注释(原来在 140-148 行,包含 Zorro 在第 141 行标出的那句悬空引用)都改成引用 `docs/feature/semi-auto-gate-mode/PRD.md`,而不是不加限定的"the PRD"。
- `src/profile/loader.ts`:把 `gate_mode` 字段的文档注释也改成引用同一个 PRD 路径(这个文件本身没有 Zorro 报告里引用的那句悬空引用的字面文本,但对一条 fail-closed、安全相关的校验分支完全没有任何文档指针——出于同样的理由补上)。
- `docs/DESIGN.md` §7(`config.yaml` 示例块,同一个位置已经记录了 `workflow.reject_threshold`):在示例里加了 `workflow.gate_mode: manual`,外加一段新的说明 semi-auto 安全边界的文字,链回这份 PRD。
- **验证**:`grep -rn "per the PRD\|the PRD's" src/` —— 剩下的命中全是既有的、跟这次无关的、指向其他真实 PRD 的合法引用(A2 的 `harness/provider-router.ts`、A4a 的 `loop/graph.ts`、A4a 的 `loop/__tests__/gates.test.ts` ×2)——没有一处错误地指向 issue #63 现在真实存在的 PRD.md,也没有一处是悬空的。

### 修复 2(blocker 2):`resolveRejectThreshold()` 的 fail-closed 守卫
- `src/cli/assemble.ts`:给第一层检查加上了 `Number.isInteger(fromProfile) && fromProfile >= 1`,原样照抄自兄弟函数 `resolveSchemaMaxAttempts()` 自己的守卫(同一文件)——不是新模式。一个非法的第一层值现在会落到既有三层链的第二层/第三层,和这个函数本来对非数字值就有的 fallback 设计一致(已有一个测试证明字符串值就是这么落下去的)。
- 新测试(`src/cli/__tests__/assemble.test.ts`):
  - `it.each([NaN, +Infinity, -Infinity, 0, -1, 1.5])` —— 全部落到第二层(`SystemConfig` 配置的默认值),没有一个被原样返回。6 个测试。
  - 一个回归测试确认一个真正合法的 `reject_threshold: 1` 在第一层仍然被接受(防止这次修复矫枉过正)。1 个测试。
- **变异自验证**(这一轮亲自跑过、亲眼见证过,不是仅仅断言):临时把守卫改回修复前的 `typeof fromProfile === "number"` 检查,不带整数/有限性/正数约束,重跑 `assemble.test.ts`——6 个新的 `it.each` 用例正如预期全部失败(每个格式错误的值都被原样返回,而不是落到配置好的第二层值 `7`),文件里其他 36 个测试不受影响。把守卫改回来——文件里全部 42 个测试再次全绿。

### 修复 3(加固项):gate 身份断言
- `src/cli/run-loop.ts`:新增了 `AUTO_APPROVABLE_DB_STATE: Record<string, string>`(把 `AUTO_APPROVABLE_GATES` 里每个 `GateType` 映射到对应的 `LOOP_NODES`),并在 semi-auto 分支里加了一个 2 行断言——`if (deps.audit.getRunById(current.runId)?.currentState !== AUTO_APPROVABLE_DB_STATE[interrupt.gate]) throw ...`——在构造自动批准 resume 值之前执行。
- **为什么这补的是一个真实缺口,不是走个形式**:`resumeRun()` 既有的 domain 检查(`resumeDecisionsFor(run.currentState).includes(resume.decision)`,`loop/runner.ts:1078-1079`)抓不住 G1/G2 和 G3 混淆的情况,因为 `"approved"` 对 G1 和 G3 的 domain(`["approved","rejected"]`)来说都合法。如果 `interrupt.gate` 和 `workflow_runs.current_state` 真的对不上,光靠这道既有检查是拦不住一次自动批准打到 G3 的。
- 新测试(`src/cli/__tests__/run-loop.test.ts`,`"refuses to auto-approve when workflow_runs.current_state disagrees with interrupt.gate"`):先跑一个真实的 run 到它的 G1 interrupt,再对同一个 SQLite 文件开一个第二个、独立的 `better-sqlite3` 写连接(和这个代码库里 `loop/__tests__/runner.test.ts` 已经在用的读侧 DB 断言技巧一样),直接把 `workflow_runs.current_state` `UPDATE` 成 `'g3'`,强行制造出 `interrupt.gate` 本身没法表达的不一致。断言 `runInteractiveLoop()` 会拒绝并报一个 gate-identity-mismatch 错误,`Prompter` 一次都没被问过(0 次调用)。
- **变异自验证**(这一轮亲自跑过、亲眼见证过):临时删掉那 3 行断言,重跑 `run-loop.test.ts`——新测试正如预期失败(`runInteractiveLoop()` 顺利 resolve 而不是拒绝——自动批准在状态不一致的情况下照样通过了),文件里其他 11 个测试不受影响。把断言恢复回来——文件里全部 12 个测试再次全绿。

### 最终数字(这次会话里,按这个确切顺序跑的)
```
pnpm lint   → clean (tsc --noEmit, 0 errors)
pnpm build  → clean (tsc -p tsconfig.build.json, 0 errors)
pnpm test   → 609/609 passed, 57 test files (baseline 601 + 8 new: assemble.test.ts +7, run-loop.test.ts +1)
```

### 改动范围自查
`git diff --stat`(完整,只算这次会话的改动):`docs/DESIGN.md`(+3)、`src/cli/__tests__/assemble.test.ts`(+47)、`src/cli/__tests__/run-loop.test.ts`(+182,含这一轮新加的部分)、`src/cli/assemble.ts`(+25/-1)、`src/cli/run-loop.ts`(+79)、`src/profile/__tests__/loader.test.ts`(+59,R1)、`src/profile/loader.ts`(+40,R1)——外加 `docs/feature/semi-auto-gate-mode/` 下 4 个新文件。`git diff --stat -- src/loop` 是空的——两轮都没动过 `src/loop/**` 下的任何生产代码,跟 PRD 里写明的范围一致。

### 尚未完成的事
- 这一轮修复(R2)的 Zorro 复审——还没跑。
- 指挥官批准 → commit/push——还没做(按既有门禁,Cypher 不 commit/push)。

### 我注意到但不在 Zorro 原始要求里的事(已标出,除了记一笔没做别的处理)
- issue #63 正文里为一个"auto-until-threshold"模型引用了"Design doc §5.2"。我在 `docs/DESIGN.md` 里哪儿都没找到 `§5.2`(那份文件根本没有 `###` 级子章节——每个标题都是 `##`)。这对本 PRD 不是 load-bearing 的(issue 自己的"What"/"Constraints" 两节讲得很清楚),但按防幻觉政策在 `PRD.md` §1 里标成了 `[?]`,而不是悄悄当成已验证处理。
- `docs/ROADMAP.md`/`docs/PROGRESS.md`/`CHANGELOG.md`/`README.md` 目前都还没有 issue #63 的条目(不像 A5 的 B9 文档收尾批次)。这一轮范围之外(Helix 的任务简报把这一轮的范围划定为正好那 2 个 blocker + 1 个加固要求 + 文档链接修复),在这里记一笔,免得被悄悄忘掉。
