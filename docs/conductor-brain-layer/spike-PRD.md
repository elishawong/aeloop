# PRD — conductor-brain Phase1 vertical-slice spike（醒来→派工→折回→再醒来延续）

> 骨架来源：`ai-agent/OPS/_templates/feature/PRD.md`（结构）。防幻觉：`[?]` = 我没能独立核实的部分；不确定标「待操作者确认」，不编接口/字段/版本号。本 PRD 引用到的每一个类型/方法签名都逐条读过 aeloop 仓库当前源码（见各节末尾文件路径），不是转述 DESIGN.md 或凭记忆。

- **项目**：aeloop（`elishawong/aeloop`，private repo）
- **分支**：`feat/issue-brain-spike`（当前工作分支，基线 `origin/main` @ `750d12e`）
- **优先级**：P0（pitch demo 铁证）
- **状态**：待操作者确认
- **最后更新**：2026-07-22
- **关联 issue**：[elishawong/aeloop#80](https://github.com/elishawong/aeloop/issues/80)（本 PRD 覆盖的 spike）承接 [elishawong/aeloop#75](https://github.com/elishawong/aeloop/issues/75)（brain 层设计）
- **设计权威**：`docs/conductor-brain-layer/DESIGN.md` §2（三块胶水接口）/ §3（身份 DB scope）/ §10（spike 定义）/ §11（既有类型清单）——本 PRD 是 §10 的可执行拆解，**不推翻** DESIGN 已定盘的架构方向；本 PRD 新发现的、DESIGN 没有覆盖或和 DESIGN 字面描述有出入的地方，全部在 §0 单独列出，不悄悄改写 DESIGN 的结论。

---

## 0. 范围声明 + 4 项和 DESIGN 字面描述有出入的核实发现（必读，直接影响批次设计）

> 以下都是我逐条读 aeloop 当前源码后核实出来的，不是转述。DESIGN.md 本身在这些点上要么没细到这个粒度，要么用词（"复用今天已验证可用的路径"）在这次核实下需要澄清——不是 DESIGN 错了，是 DESIGN 写作时没有把这几个实现细节铺到这个深度。

### 0.1 `TaskContract.brain` 对这次 spike 不是"自由选择"，是硬约束 = `"company"`

DESIGN §2.1 把 `brain: "personal" | "company"` 标成"待决策"，但这只在**产品层面**成立——对这次 spike 要跑通的**具体代码路径**，`brain` 字段的取值被两处代码锁死成 `"company"`：

- `Orchestrator.plan()`（`src/conductor/orchestrator.ts:33`）：`if (request.brain.kind !== request.contract.brain) throw new BrainWorkflowMismatchError(...)`。
- `scripts/conductor-work.mjs` → `src/conductor-work/main.ts:27`：`new ConductorWorkApp({ brainDirectory: companyBrainDirectory(REPO_ROOT), ... })`，`companyBrainDirectory()`（`src/conductor-work/app.ts:90-92`）硬编码指向 `<repo>/brains/company/`，其 `manifest.yaml`（`brains/company/manifest.yaml`）的 `kind: company`。

也就是说：只要 spike 走 `conductor-work` 这条 CLI/库路径（DESIGN §10 步骤3 指定的路径），`contract.brain` 就**必须**是 `"company"`，不然第一步 `plan()`/`planRun()` 就会抛 `BrainWorkflowMismatchError`，连 G1 都到不了。这不是我替操作者拍板"选 company"，是"选别的这条路径今天直接跑不通"——见 §5 待决策项。

### 0.2 `conductor-work.mjs run <contract.json> --json`（DESIGN §10 步骤3 字面命令）今天必然停在 G1，且没有 resume 命令

- `ConductorWorkApp.runCandidate()`（`src/conductor-work/app.ts:64-87`）只调用**一次** `startRun()`。
- `startRun()`（`src/loop/runner.ts:887`）自己的头注释原话："drives the graph from a fresh `LoopState` to its first pause (**always G1**, per `graph.ts`'s topology — `draft -> g1` is an unconditional edge, so the very first `compiled.stream()` call always ends at G1's interrupt, never completes a gate decision itself)"。
- `scripts/conductor-work.mjs`/`src/conductor-work/main.ts` 的 `run(argv)` 只认 `plan`/`run` 两个子命令（`main.ts:19`），**没有 `resume`**。

结论：DESIGN §10 步骤3 那行字面命令，单独执行一次，**只能拿到一个卡在 G1 中断、`done:false` 的 `RunHandle`**，不会有 tester 跑过、不会有更完整的 `EvidenceBundle`。真正能自动跑完整闭环（`workflow.gate_mode: "semi-auto"`，issue #75 引用的 Run #25/#31 用的就是这个）的代码只在 `src/cli/run-loop.ts` 的 `runInteractiveLoop()`（被 `src/cli/main.ts` 的 `aeloop start`/`aeloop resume` 调用）——但那条路径吃的是**裸 task 字符串**（`runStart()`，`main.ts:107`：`await startRun(deps, { task, ... })`），完全绕开 `TaskContract`/`Orchestrator`，和 DESIGN §1.1 选定的"brain 出 TaskContract、只在边界喊话"不是同一条代码路径。

**建议（spike 默认，需操作者确认，见 §5）**：driver 脚本（B4）不字面照抄子进程 CLI 命令，改成库调模式（DESIGN §1.2 方案②，文档本身也承认"两种模式都保留"）：自己 `assembleProfileDeps()` + `startRun()`，若停在 `G1_SEND_TO_TESTER`/`G2_SEND_TO_FIX`，用 `resumeRun(deps, runId, threadId, {decision:"approved"}, "brain-spike-driver (auto, not a human decision)", stepCounters)` 自动放行（和 `run-loop.ts` 已经过 Zorro 审查的 semi-auto 分支是同一个 `resumeRun()` 调用，只是不经过它的 TTY prompter），**停在 G3/Escalation**（这两个"恒人工"，spike 不擅自批，和 `runCandidate()` 自己的注释"candidate-only; git writes disabled"posture 一致）。这是我写 PRD 时做的一个具体实现选择，不是 DESIGN 已拍板的内容。

### 0.3 生产代码路径里 `EvidenceBundle.evidence[]` 今天几乎总是空的

`EvidenceBundleBuilder.addEvidence()`（`src/evidence/bundle.ts:215`）在全代码库非测试文件里**只有一处调用点**——`recordEvent()` 内部的 `no_change` 分支（`bundle.ts:190-211`），且永远 `source: "model-reported"`。`.addClaim()`（`bundle.ts:221`）在非测试代码里**零调用点**（已用 `grep -rn "\.addClaim(" src --include="*.ts"` 排除 `__tests__`/`.test.ts` 核实）。

意味着：一次"coder 出 diff、正常走完（不触发 no_change）"的真实 run，`EvidenceBundle.evidence` 大概率是 `[]`，`claims` 也是 `[]`——不是三态门能同时看到 verified + model-reported 混合样本的丰富素材。三态门模块（B2）因此设计为**主要靠合成/单元测试固定证明"绝不把 model-reported 错误标 confirmed"这条规则本身成立**；真实 run 的 `EvidenceBundle` 只是"如果凑巧命中 no_change，处理是否正确"的一次额外印证，不是唯一证据来源。**这是 aeloop Layer2 自己既有的证据密度 gap，不是这次 spike 该修的东西**，但操作者应该知道，别预期真实 run 会自然产出丰富的 verified 证据用于展示。

### 0.4 spike 范围内的"醒来"不需要真的调模型

DESIGN §7.2 自己把"Claude Code CLI 壳里具体怎么接 seed/deepseek"标成 `[?]` 未验证。§10 步骤1/5 的字面描述（"从 identity db 的 FTS5 读记忆"）本身不要求模型调用；§2.1 也明确说"翻译质量不是 spike 要证明的，可以模板化"。基于这两点，**本 PRD 把"醒来"（②的一部分）和"翻译器"（①）都设计成纯确定性代码，不调用任何模型**——真正调模型的只有 §10 步骤3（aeloop 的 coder/tester，走已验证的 LiteLLM/cli-bridge adapter）。这是我对 §10 字面文本的一个解读选择，不是凭空回避 Phase1 的 `[?]`——把这条也列进 §5 待确认。

---

## 1. 目标 / 非目标

**目标**：让 §10 定义的五步闭环在 aeloop 当前代码上真的跑一次，产出两条可验证的证据：
1. 第 5 步的"再醒来"确实读到了第 4 步写回的 memory（不是"理论上应该能"）。
2. 全程没有把 `evidence[].source === "model-reported"` 的证据当 `confirmed` 写回 identity db。

**非目标（明确不做，抄 DESIGN §9）**：
- ❌ 不做 §2.3 向量层——Phase1 全程只用 FTS5。
- ❌ 不做性能/多轮鲁棒性验证——只跑一次闭环。
- ❌ 不做 gate-controller（"谁来点 G3 approve"）——driver 停在 G3 前，不擅自批。
- ❌ 不重新设计 Layer2 的 Token Budget Plane、不碰 `PromptDelta`。
- ❌ 不在这次 spike 里解决 §0.3 提到的"生产代码 `EvidenceBundle` 证据稀疏"这个 Layer2 既有 gap——只如实处理它给出的结果，不改 `src/evidence/bundle.ts`。
- ❌ 不做真正的 Phase1"Claude Code CLI 调 seed/deepseek"接线验证——那是 §7.2 标的独立 `[?]`，本 spike 用 §0.4 的解读绕开它，不代表已经验证过。

---

## 2. 逐文件任务清单

> 目录约定：仿照本仓库既有先例 `docs/feature/a4a-loop/spike/`（纯侦察脚本，不进 `src/`，不参与 `pnpm run build`）。所有脚本从 `dist/index.js`（`pnpm run build` 产物）导入真实类型/类，和 `scripts/demo-company.mjs`/`scripts/conductor-work.mjs` 同一套约定——不新建任何 `src/**` 文件，这次 spike 不改动引擎本身一行代码。

| 文件路径 | 职责 | 依赖的既有类型（逐条核实） |
|---|---|---|
| `docs/conductor-brain-layer/spike/lib/wake.mjs`（新建） | `openIdentityStore(dbPath)` 开一个独立于任何 Layer2 profile 的 `MemoryStore`；`wake(store, queryHint?)` 组装开场白：`store.listMemories()` 过滤 `CORE_MEMORY_TYPES` 等价集合（`identity`/`constraint`/`decision`）+ `store.searchMemories(queryHint)`，返回 `{openingSummary, continuedThreads, pendingDecisions}` | `MemoryStore`（`src/context/store.ts:80`，构造器 `new MemoryStore(dbPath: string)`）、`SystemConfig`（`src/context/config.ts:23`，`new SystemConfig(memoryStore)`）、`StalenessEngine`（`src/context/staleness.ts:14`，`new StalenessEngine(systemConfig)`）、`ContextInjector`（`src/context/injector.ts:154`，`new ContextInjector(memoryStore, staleness)`，`.inject(query?)` 返回 `ContextInjectionResult`）、`CORE_MEMORY_TYPES`（`injector.ts:95-99`，`Set(["identity","constraint","decision"])`） |
| `docs/conductor-brain-layer/spike/lib/translator.mjs`（新建） | `translateIntent(rawIntent, opts?)` → 模板化产出一个合法 `TaskContract`：`brain:"company"`（§0.1 硬约束）、`riskLevel:"low"`（硬编码，DESIGN §2.1 原话"翻译质量不是要证明的"）、单个 `Requirement`（`id:"REQ-001"`, `text` 取 `rawIntent`）、`policy` 抄 `scripts/demo-company.mjs` 里已验证能过校验的形状、`contractId` 用 `spike临时默认`（见 §5）、产出前必须过 `assertValidTaskContract()` | `TaskContract`/`Requirement`/`ExecutionPolicy`/`BrainKind`（`src/conductor/types.ts:8-38`，逐字段核对过）、`assertValidTaskContract`（`src/conductor/contract.ts:61-64`，`asserts contract is TaskContract`，抛 `InvalidTaskContractError`（`contract.ts:8`）带 `issues: ContractValidationIssue[]`） |
| `docs/conductor-brain-layer/spike/lib/three-state-gate.mjs`（新建） | `applyThreeStateGate(evidenceBundle, identityStore, opts)`：对 `evidence[]` 逐条判断 `item.source`——`"verified"` 或缺省（"absent = verified"，`bundle.ts:31-32` 注释原话）且 `passed===true` → `insertMemory(unconfirmed)` 后立即 `ConfirmationService.confirm(memoryId, actor)`；`"model-reported"` → 只 `insertMemory({confidenceState:"unconfirmed"})`，**绝不调用 `confirm()`**。另外无论 `evidence[]` 是否为空，都基于 `evidenceBundle.status`（机械字段，来自 `LoopEvent.type` 判断，非模型自称，`bundle.ts:161`）写一条 `active_task` 记录本轮状态并直接 `confirm()`（这条走"机械事实"通道，不受"model-reported 不能 confirm"这条规则约束——status 不是 `EvidenceItem.source` 意义上的"model-reported"证据） | `EvidenceBundle`/`EvidenceItem`/`EvidenceSource`（`src/evidence/bundle.ts:34-45,102-124`）、`MemoryStore.insertMemory`/`NewMemoryInput`（`store.ts:237-258`，`types.ts:53-61`）、`ConfirmationService.confirm`（`src/context/confirmation.ts:39-61`，`confirm(memoryId, actor, now?)`） |
| `docs/conductor-brain-layer/spike/run-spike.mjs`（新建） | 驱动脚本，串联 B0-B2 + 真实 aeloop 执行（见 §0.2 的库调模式选择），打印两行明确的 `PASS`/`FAIL`（对应 §10 两条验收标准） | `assembleProfileDeps`（`src/cli/assemble.ts:97-174`，`(profileName, env?, profilesRoot?) => CliDeps`）、`startRun`/`resumeRun`（`src/loop/runner.ts:887`/`:1050`）、`ConductorWorkApp`（`src/conductor-work/app.ts:27`，用它的 `plan()`/`projectEvents()`，不用 `runCandidate()`——理由见 §0.2） |
| `docs/conductor-brain-layer/spike/profiles-apikey.config.example.yaml`（新建） | **模板文件**，不含真实密钥，供操作者复制到 `profiles/apikey/config.yaml`（已 `.gitignore`，不进 git）填真实值 | `ProfileConfig`/`ProviderConfig`（`src/profile/loader.ts:15-27`）、`buildAdapterRegistry` 的 `direct-api` 分支（`src/harness/config.ts:161-171`，`LiteLLMAdapter` 需要 `base_url`/`api_key`/`model`/`api_style`） |

**不新建**：任何 `src/**` 文件、任何向量层代码（§0 已声明）、`brains/personal/` 或第三个 `BrainKind`（§0.1 已锁死走 company）。

---

## 3. 批次拆解

| 批次 | 规模 | 做什么 | 依赖 | 验收点 |
|---|---|---|---|---|
| **B0** | S | `lib/wake.mjs`：身份 DB 打开 + 醒来组装 | 无（第一批） | 空库调用 `wake()` 不抛错、返回空数组；手动 `insertMemory` 一条 `active_task` 后，**关闭当前 `MemoryStore` 实例、`new MemoryStore(同 dbPath)` 开一个新实例**再调 `wake()`，能读到刚写入的那条（证明是磁盘持久化，不是进程内对象缓存的假象） |
| **B1** | S | `lib/translator.mjs`：模板化翻译器 | 无（可与 B0 并行） | 任意非空 `rawIntent` 产出的 contract 都能过 `assertValidTaskContract()`；`brain` 字段恒为 `"company"`；空字符串 `rawIntent` 走一条明确拒绝路径（fail-closed，不产出非法 contract） |
| **B2** | S | `lib/three-state-gate.mjs`：三态确认门 | 无（可与 B0/B1 并行） | 单元测试用**手写合成 `EvidenceBundle`**（不依赖真实 run）验证：① 一条 `source:"model-reported"` 的证据，处理后对应 memory 的 `confidenceState` 绝不是 `"confirmed"`；② 一条 `source:"verified", passed:true` 的证据，处理后对应 memory `confidenceState==="confirmed"` |
| **B3** | S | `profiles-apikey.config.example.yaml` 模板 + 和操作者对齐 §5 的凭证前置项 | 无 | 操作者明确回复：本机配真实 deepseek/seed 凭证 / 退回 subscription 先跑机制 / 换到"公司电脑"跑——三选一，不由 Cypher 替选 |
| **B4** | M | `run-spike.mjs`：串联 B0+B1+B2，真实调用 `assembleProfileDeps`+`startRun`/`resumeRun`（§0.2 库调模式，G1/G2 自动放行、停在 G3 前），跑完后 `projectEvents()`→三态门→第二次 `wake()`，打印两行 PASS/FAIL | B0, B1, B2, B3 结果确定后 | 跑一次全链路不抛未捕获异常（明确标注的"预期失败路径"除外）；控制台输出的两行 PASS/FAIL 和 §4 的两条硬验收标准一一对应，人工可读可核 |
| **B5** | S | 用 B3 选定的真实 profile，实跑一次 `run-spike.mjs`，把完整 stdout 存档到 `docs/conductor-brain-layer/spike/RUN-LOG.md` | B4 | Zorro/操作者能从存档的真实运行记录里独立核对两条验收标准，不是听 Cypher 转述 |

---

## 4. 可测验收标准（勾选式，直接对应 DESIGN §10 的两条硬指标）

- [ ] **AC1（第5步真观察到延续）**：`run-spike.mjs` 第二次 `wake()`（基于**重新 `new MemoryStore(dbPath)` 打开的独立实例**，不是复用第一次那个 JS 对象）的 `continuedThreads`/`pendingDecisions` 中，存在至少一条 memory，其 `content`/`title` 可回溯到第一次 run 产出的 `contractId`/`runId`（例如包含该 `contractId` 字符串），且这条 memory 是第 4 步三态门写入的，不是 seed 数据。
- [ ] **AC2（全程未绕过三态门）**：检查 identity db（跑完后），**任何** `confidenceState === "confirmed"` 的 memory，若其来源可追溯到某条 `EvidenceItem`，该 `EvidenceItem.source` 必须不是 `"model-reported"`；反过来，**任何**来源是 `source:"model-reported"` 的 `EvidenceItem`，其对应写入的 memory 的 `confidenceState` 必须停留在 `"unconfirmed"`，绝不出现 `confidenceState==="confirmed"` 且溯源到 model-reported 证据的记录。B2 的合成单元测试独立验证这条规则本身；B5 的真实 run 存档作为（可能为空样本的）额外印证。
- [ ] **AC3（工程可行性，达成前两条的前提，非 §10 直接列出但必要）**：`translateIntent()` 产出的 contract 100% 通过 `assertValidTaskContract()`；`run-spike.mjs` 全链路跑完不抛未捕获异常。

---

## 5. 待决策项（spike 临时默认，我给出建议值，不替操作者拍板）

| 待决策项 | 建议默认值 | 为什么这么建议 | 谁来拍板 |
|---|---|---|---|
| `TaskContract.brain` | `"company"` | §0.1：不是偏好，是当前 `conductor-work` CLI/库路径唯一跑得通的值；DESIGN §2.1 那条"待决策"是产品层面的问题（这次 spike 不解决），本 PRD 只解决"这次代码怎么跑通" | 产品层面的问题仍待操作者/军师另开 issue 定；spike 执行层面这条建议直接采纳 |
| `contractId` 生成规则 | `` `brain-spike-${Date.now()}` `` | 简单、够 spike 用、不需要新依赖（不引入 uuid 库）；正式产品阶段需要更严谨的规则，不在这次范围 | 操作者确认 |
| `riskLevel` | 硬编码 `"low"` | DESIGN §2.1 原话："翻译质量不是 spike 要证明的" | 操作者确认（若想测更高风险路径的门禁行为，需要另外单独提） |
| 派工调用模式 | 库调模式（`assembleProfileDeps`+`startRun`/`resumeRun`，G1/G2 自动放行、停在 G3 前）而非字面照抄的子进程 CLI 一次性调用 | §0.2：字面命令今天必然停在 G1、没有 resume，单独调一次拿不到有意义的闭环证据 | **需要操作者明确确认**——这是本 PRD 对 DESIGN §10 步骤3 字面描述的一处偏离，影响面最大 |
| deepseek/seed 真实凭证来源 | 三选一：① 本机手动建 `profiles/apikey/config.yaml`（gitignored）② 退回 `profiles/subscription/`（claude-cli/codex-cli）先证明机制，模型替换标为待补跑 ③ 换到"公司电脑"跑 | `profiles/apikey/` 在这个 worktree 磁盘上核实过**不存在**（`.gitignore` 排除，Run #25/#31 是在"公司电脑"跑的，不是这台机器），Cypher 无法伪造真实凭证 | **必须操作者选**，Cypher 不能替选（涉及真实密钥） |

---

## 6. 依赖 / 风险

- **依赖**：`pnpm run build`（生成 `dist/`，脚本从 `dist/index.js` 导入）；一个能跑的 profile（见 §5 最后一项）。
- **风险**：见 §0 四条核实发现（brain 硬约束 / CLI 模式停在 G1 / 生产证据稀疏 / 醒来不调模型的解读选择）——已逐条列出建议应对，最大风险是 §0.2/§5 的"库调模式偏离 DESIGN 字面命令"，需要操作者明确点头，不是 Cypher 单方面决定后就动手实现。
- **次要风险**：`resumeRun()` 自动放行 G1/G2 时用的 `decidedBy` 字符串（`"brain-spike-driver (auto, not a human decision)"`）会写进 `approvals.decided_by`/audit 记录——这是真实的 audit 痕迹，不是无害的调试输出，跑完后这条 run 在 `profiles/<x>/workflow.db` 里是永久记录，若用的是真实公司 profile，需要操作者知情。

## 7. 项目约束检查

- aeloop 无 `CLAUDE.md`（已核实：`find . -iname CLAUDE.md` 在这个 worktree 里零匹配），项目自身文档权威是 `docs/DESIGN.md`/`docs/ROADMAP.md`；本 PRD 遵循 `docs/feature/<name>/PRD.md` 系列既有先例的文风（如 `docs/feature/a4a-loop/PRD.md`）。
- 不改动 `src/**` 任何一行——所有净新建代码在 `docs/conductor-brain-layer/spike/`，和既有 `docs/feature/a4a-loop/spike/` 先例同一约定（纯侦察/验证脚本，不参与 `pnpm run build`/`pnpm test`）。
- 不新建/不修改 `brains/**`（继续用现成的 `brains/company/`）。
- `profiles/apikey/` 涉密，本 PRD 只产出不含真实密钥的 `.example` 模板，真实凭证由操作者手动填、不进 git（`.gitignore` 已覆盖）。
