# Aeloop / Conductor / Conductor Work 完整重构 Checklist

> 这是跨项目的唯一执行清单。所有实现、测试、PR 和公司 demo 都必须回到这里记录。
>
> 状态：`[x]` 已完成并验证；`[~]` 设计完成或实现中；`[ ]` 未开始；`[!]` 需要外部条件。
>
> 更新日期：2026-07-22（issue #47 已修复并随 PR #49 合并；issue #48 已修复并随 PR #50 合并；issue #51 已完成并随 PR #52 合并；PR #56 已合并，修复 conductor-work 未把完整 TaskContract 注入 coder/tester prompt 的缺口；PR #57 已合并，修复 provider usage 未从已完成 coder/tester 事件投影进 usageRecords/EvidenceBundle 的缺口，使 model-reported 的 no_change evidence fail-closed 并标记来源，多模型聚合结果不再有歧义）

## 0. 方案基线与边界

- [x] 明确三项可解耦产品：Aeloop、Conductor Personal、Conductor Work。
- [x] 明确 Aeloop 是执行内核，不拥有私人或公司长期记忆。
- [x] 明确 Conductor 是通用、确定性的编排层，不拥有业务 Brain。
- [x] 明确 Personal Brain 与 Company Brain 是两个可替换实现，不能共享记忆、profile 或 policy 数据。
- [x] 明确 Brain 负责理解、规划和生成 `TaskContract`；Aeloop 负责受控执行和证据记录。
- [x] 明确公司侧禁止自动 commit、push、PR、merge。
- [x] 明确私人侧可以拥有更高自由度，但仍必须通过 Contract、Policy、Gate 和 Evidence。
- [x] 明确所有执行必须可暂停、恢复、审计和解释。
- [ ] 为每个公共协议建立版本兼容策略和迁移策略（审计发现 RunPlan/Workflow/Evidence/Event 版本目前多为标签，跟踪 issue #37；PR #44 已合并到 `main`（commit `131cb49ff8afd00bbe7c8ccfbab1cfe648e29c93`）完成文档层审计，未加运行时校验器，因目前不存在真实的 RunPlan 持久化/reload 边界；协议兼容实现项仍待完成）。
- [ ] 为“设计完成”和“代码完成”分别定义验收记录，避免只勾设计不验实现。

方案文档：

- [Aeloop / Personal 完整方案](./optional/conductor-personal/SOLUTION-DESIGN.zh-CN.md)
- [Company Work 方案](./architecture/conductor-work/SOLUTION-DESIGN.zh-CN.md)
- [四层与三目标设计](./architecture/AEOLOOP-LAYER-DESIGN.zh-CN.md)
- [Token 优化设计](./architecture/TOKEN-OPTIMIZATION-PLAN.zh-CN.md)

## 1. 当前基线与发布状态

- [x] A5 完成。
- [x] issue-29-events 完成并合并到 `main`。
- [x] PR #34 基础边界重构完成并合并到 `main`。
- [x] Workflow Manifest / Plugin / Registry 已存在。
- [x] TaskContract 校验、Contract prompt 注入和 fail-closed policy 已存在。
- [x] 外部 profile root（`AELOOP_PROFILES_ROOT`）已支持。
- [x] `refactor/conductor-work-mvp` 环境修复完成，PR #35 已合并到 `main`（merge commit `4eae71e5c15ba5d9b782916e65fff147a64cfbc1`；安全 issue #31 仍按原裁决暂缓）。
- [x] issue #47（`no_change` 终态、只读/已满足 run 不再进入 G1 gate）已随 PR #49 合并到 `main`。
- [~] issue #48（LiteLLM adapter 在 `InvokeResult` 上保留 provider token usage/cache 字段与 latency）已随 PR #50 合并到 `main`；串联到 runner/事件系统/`EvidenceBundle` 仍是后续待办。
- [x] issue #51（`conductor-work run <contract.json> --profile <profile>` 校验 Company Brain/TaskContract，启动 candidate-only aeloop run，返回 pending gate 且不自动 approve，并可输出 EvidenceBundle 与 JSONL LoopEvents；公司 no-commit/no-push/no-PR/no-merge policy 保持不变）已随 PR #52 合并到 `main`（merge commit `c05dcba7228f6cf1439eb76b4b58f1ca022099a2`）。
- [x] PR #56（`fix: inject company contract into run prompts`）已合并到 `main`（merge commit `0f55baa81eae559c536a5a2b9fc9c21efe17eeaa`）：`conductor-work` 现在把完整校验通过的 `TaskContract`（含 requirements、acceptance criteria、policy）渲染进 coder/tester prompt；新增可复用的 `examples/company-a6-readonly.contract.json`；同步更新了 company runner 文档（`conductor-work/README.md`）。修复的是第一次 company-run 验证中发现的 prompt/context 缺口。
- [x] PR #57 已合并到 `main`：provider usage 现在从已完成的 coder/tester 事件投影进 `usageRecords` 与 `EvidenceBundle`；model-reported 的 `no_change` evidence 按 fail-closed 处理并标记来源为 `model-reported`；多模型聚合结果不再有歧义。issue #48「串联到 runner/事件系统/EvidenceBundle」的下游待办至此完成；node × role × provider × model × attempt 粒度的 retry-attempt 核算（issue #58）与 usage_records 落库/持久化（issue #59）仍未完成。
- [~] `conductor-work/ui` 已有可视化 mock demo，尚未接入真实事件流。
- [!] A6 真实公司 profile 验收等待 Node 24 环境和公司 profile。
- [ ] A6 通过后记录真实模型、profile、耗时、token、成本和 EvidenceBundle。

## 2. Aeloop：公共协议层

### 2.1 输入协议

- [ ] `TaskContract` 稳定化：目标、需求、验收、风险、来源快照、policy、brain 标识。
- [ ] `ContextPack` 稳定化：任务上下文、来源、优先级、时间、新鲜度、token 预算。
- [ ] `RunPolicy` 稳定化：路径、命令、依赖、网络、Git、审批和人工介入规则。
- [ ] `RunRequest` 稳定化：contract、workflow、profile、workspace、预算和恢复信息。
- [ ] 所有输入执行 schema 校验，失败时 fail-closed，不进入模型调用。
- [ ] 所有输入记录 schema version 和 source snapshot hash。

### 2.2 输出协议

- [ ] `RunPlan` 稳定化：workflow、版本、capabilities、policy decision、预算分配。
- [ ] `LoopEvent` 稳定化：run、step、node、gate、tool、model、failure、completion 事件。
- [ ] `GateRequest` 稳定化：gate 类型、问题、允许决策、证据要求和超时行为。
- [ ] `EvidenceBundle` 稳定化：需求覆盖、claim、evidence、测试、工具轨迹、变更范围、未证明项。
- [ ] `RunResult` 稳定化：状态、产物、证据、token/cost usage、待人工决策。
- [ ] 事件顺序、重复事件、未知事件和失败事件有明确兼容规则。
- [x] A5 caller 的 reject threshold 按 `profile.workflow.reject_threshold → system_config → 2` 解析并注入 `startRun`，已由 Helix 复核且有三层及 malformed-value 测试。

## 3. Aeloop：Prompt 层（防幻觉、连贯、节省 token）

- [~] 把 system、contract、context、tool、output schema 分成可缓存的稳定区和动态区：issue #40 设计契约（PromptSnapshot/PromptDelta/provider-session）已随 PR #41 合并到 `main`（commit `cf8c82a`），设计完成，运行时 delta/cache 尚未启用。
- [ ] 稳定前缀使用 profile/workflow/version hash，支持 prompt cache。
- [ ] 动态区只注入本轮 delta，不重复发送整个历史。
- [ ] 每个任务要求模型区分 `fact`、`inference`、`unknown`、`decision`。
- [ ] 每个高风险 claim 必须携带 source/evidence reference，缺证据只能标记 unknown。
- [ ] 将 Contract 原文、验收条件和禁止范围放在模型可见的固定区。
- [ ] 将未满足的 requirement、未证明项和 policy warning 放在每轮固定位置。
- [ ] 提供统一的“不可确定时停止并请求 gate”指令，禁止猜测补全。
- [ ] Prompt delta builder 能按 step 生成最小变更提示。
- [ ] Prompt 压缩不得删除 Contract、Policy、Gate 状态和未完成 requirement。
- [ ] 建立 prompt snapshot hash，便于复现和审计。
- [ ] 测试：无证据断言、被拒 memory、过期 context、scope drift、错误工具结果均不能变成 confirmed fact。

## 4. Aeloop：Context 层（上下文连续性）

- [ ] 区分 Brain continuity（长期记忆）与 Run continuity（单次执行状态）。
- [ ] `ContextProvider` 只读取允许的 source，拒绝越权来源。
- [ ] 为每条 context item 记录 source、hash、created_at、freshness、confidence、status。
- [ ] rejected memory 永不注入；unconfirmed/stale memory 必须带显式 warning。
- [ ] Context snapshot 在每个关键 step/gate 保存，可跨进程恢复。
- [ ] 建立 context priority：Contract > Policy > current gate > verified evidence > confirmed memory > unconfirmed memory > general knowledge。
- [ ] 建立 context budget manager：按优先级、相关性、新鲜度和 token 预算召回。
- [ ] 对重复内容去重，对长文档先摘要再按需展开。
- [ ] 新一轮只发送 snapshot delta、pending gate、changed evidence 和未完成 requirements。
- [ ] 失败恢复时从 snapshot 重建上下文，不依赖进程内存。
- [ ] 记录 context selection、压缩、丢弃和恢复原因。
- [ ] 测试：跨轮连续性、跨进程 resume、context 过期、拒绝 memory 过滤和 token 上限。

## 5. Aeloop：Harness 层（可信执行与成本控制）

- [x] Profile-neutral dependency assembly。
- [x] 外置 profile root 支持。
- [x] 外部隔离角色-人设集（issue #42，PR #43，已合并到 `main`，commit `873adb3e`）：可选配置 `personas: <name>` + `AELOOP_PERSONAS_ROOT` 用于解析外部 coder/tester persona 文件，保留 `<profileDir>/personas` 旧路径兼容，且对不安全/缺失/symlink 逃逸的 root 一律 fail-closed。**明确这不是 Conductor 的 `brains/company` 或 `brains/personal`**——那两者仍是 Brain 层资产，与本项 Harness 层 persona 文件解析机制无关。
- [ ] 统一 ModelProvider/CLI bridge/LiteLLM adapter 接口。
- [x] LiteLLM adapter 在 `InvokeResult` 上保留 provider token usage/cache 字段与 latency：issue #48 已随 PR #50 合并到 `main`。**仅完成 adapter 层保留**；将这些字段串联到 runner、事件系统和 `EvidenceBundle` 仍是后续待办，尚未完成。
- [x] PR #57 已合并到 `main`，完成上述下游串联：provider usage 从已完成的 coder/tester 事件投影进 `usageRecords` 与 `EvidenceBundle`；model-reported 的 `no_change` evidence 按 fail-closed 处理并标记来源为 `model-reported`；多模型聚合结果不再有歧义。node × role × provider × model × attempt 粒度的 retry-attempt 核算仍待完成（issue #58）。
- [ ] Provider 能返回结构化 output、model、usage、latency、cache hit 和 failure reason。
- [x] 结构化输出 schema 不通过时禁止继续执行，进入 retry/escalation：issue #45（fix: harden coder fix-forward schema retries）已随 PR #46 合并到 `main`。G2 coder 输出 prompt 现在明确要求一份完整的 `CoderOutput` JSON、且 diff 字段不能为空；schema 校验的重试次数可通过 profile 配置 `harness.schema_max_attempts` 调整，语义是「模型调用总尝试次数」，默认值 2。**明确这与 `workflow.reject_threshold`（tester 拒绝后的升级阈值，见 2.2 节）是两个独立配置项，互不覆盖**。
- [ ] Tool execution 记录 command、args、workspace、result、exit code、duration、evidence。
- [x] ToolExecVerifier v2：`Claim.toolsUsed` 与实际 trace 做工具集合子集校验；旧 claim 保留存在性兼容路径，Codex 诚实保留 `shell` 粒度。
- [ ] Workspace allowlist、forbidden path 和 network policy 在工具执行前检查。
- [ ] 默认拒绝写入远程 Git；公司 profile 永久关闭 commit/push/PR/merge。
- [ ] `TokenBudget` 在模型调用前做 preflight，预算不足时缩小 context 或请求 gate。
- [ ] `TokenUsage` 支持真实 provider usage，缺失时使用明确标注的 estimate。
- [ ] 实现 prompt cache、context cache、tool result cache 的 key/hash 和失效策略。
- [ ] retry 使用独立 retry budget，禁止无限重复相同 prompt。
- [ ] model routing 按任务风险、复杂度、剩余预算和失败次数选择档位。
- [ ] 不把 provider credential、公司配置或私有 profile 写入公共仓库日志。
- [ ] 测试：schema invalid、provider timeout、预算不足、工具越权、网络越权和 credential 泄漏。

## 6. Aeloop：Loop 层（可靠流程与证据闭环）

- [x] Loop event observability 已合并。
- [x] `no_change` 作为终态完成状态：issue #47 已随 PR #49 合并到 `main`。只读 / 已满足（无需改动）的 run 不再进入 G1 gate，而是直接以 `no_change` 终态完成。
- [ ] 将每个 workflow node、gate、tool 和 model call 映射到可恢复 checkpoint。
- [ ] 支持 `start / pause / resume / stop / approve / reject / escalate`。
- [ ] Gate 决策只能来自人工或明确的外部控制命令，不能由模型输出伪造。
- [ ] 需求覆盖矩阵在 coder/tester 前后都更新。
- [ ] Claim → Evidence → Decision 链完整保存。
- [ ] Tester 不能只返回 pass/fail，必须返回测试命令、结果和覆盖的 requirements。
- [ ] 变更超出 allowlist 或出现未证明 claim 时自动暂停。
- [ ] retry 达到上限后 escalation，不得静默继续。
- [ ] 每次 resume 从持久化 checkpoint 和 event log 重建，不依赖内存 handle。
- [ ] 并发、重复 resume、过期 gate decision 和错误 run/thread 绑定均 fail-closed。
- [ ] 统一聚合事件、claims、tool traces、token usage 为 EvidenceBundle。
- [ ] 支持 dry-run：只生成 RunPlan，不调用模型、不写 workspace。
- [ ] 测试：成功、拒绝、回滚、升级、取消、崩溃恢复、重复事件和部分写入事务。

## 7. Aeloop：数据库与审计

- [ ] `workflow_runs`：状态、contract、workflow、policy、budget、workspace、时间。
- [ ] `run_steps`：node、attempt、status、checkpoint、输入输出 hash。
- [ ] `run_events`：顺序号、事件类型、payload hash、timestamp、actor。
- [ ] `approvals`：gate、decision、decided_by、reason、evidence_refs。
- [ ] `context_snapshots` / `context_items`：快照、来源、选择原因、token 数。
- [ ] `claims` / `evidence_items` / `claim_evidence`：声明、证据和支持关系。
- [ ] `tool_executions`：工具调用及 workspace/policy 结果。
- [ ] `artifacts`：测试报告、diff、日志和导出文件。
- [ ] `usage_records`：input/output/cache tokens、估算标记、成本、模型、重试。PR #57 已完成把 provider usage 从已完成的 coder/tester 事件投影进 `usage_records` 的路径；表结构落库、schema 迁移与长期持久化仍待完成，跟踪 issue #59。
- [ ] 所有跨表写入按 run/step 事务处理，失败时不产生半条审计记录。
- [ ] 数据库迁移、索引、保留周期和脱敏策略形成文档。

## 8. Conductor：通用编排层

- [x] 独立 package/repo 结构和 public API：根 barrel 已暴露有意的 loop/harness 公共面，并通过 `src/index.test.ts` 导入测试。
- [ ] `Brain` 接口：只输出 decision/contract，不直接执行工具。
- [ ] `Orchestrator`：验证 Contract、匹配 Brain、锁定 workflow/version/capabilities。
- [ ] `RunPlan`：输出所有允许动作、禁止动作、预算和 gate。
- [ ] `WorkflowRegistry` 支持版本、输入输出 schema、capability 和兼容性检查。
- [ ] `PolicyEvaluator` 以 fail-closed 方式返回可解释 violation。
- [ ] `CommandParser` 与模型输出分离，支持人工命令和外部 API 命令。
- [ ] 支持 `preflight / start / resume / approve / reject / stop / escalate / dry-run`。
- [ ] Conductor 不保存个人或公司长期 memory，只保存运行编排状态。
- [ ] Conductor event adapter 能聚合 Aeloop 事件为 EvidenceBundle。
- [ ] 提供 Aeloop adapter，保持旧 CLI 可用。
- [ ] 单元测试、schema 测试、policy negative tests、adapter contract tests 完整。

## 9. Conductor Personal：私人 Brain

- [x] 建立 Personal Brain contract adapter 骨架，保留独立 Brain 身份。
- [ ] 将 Helix 重构为易懂的个人产品名。
- [ ] Personal Brain 的 prompt、memory、profile 和 policy 独立存储。
- [ ] 支持私人订阅模型（Claude/GPT 等）和个人 GitHub workflow。
- [ ] 支持需求头脑风暴、研究、PRD 草拟和任务拆解。
- [ ] Brainstorm 阶段允许探索；进入执行前必须生成并冻结 `TaskContract`。
- [ ] Contract freeze 后禁止静默增加功能或改变验收条件。
- [ ] 私人 memory 经过确认、来源和新鲜度管理，不把聊天全文永久塞入 prompt。
- [ ] 私人 workflow 可使用 GitHub post-processing，但必须经过独立授权 gate。
- [ ] 私人侧同样记录 claim/evidence/usage，不因自由度高而取消审计。
- [ ] 私人与公司仓库、profile、memory、日志和导出物有物理/逻辑隔离。
- [ ] Personal Brain 通过 Conductor/Aeloop 公共协议运行，不在 Aeloop 内硬编码。
- [ ] 建立 Helix 旧 prompt/context/harness/loop 到新 Brain 接口的迁移测试。

## 10. Conductor Work：公司 Brain 与产品层

- [x] Company brain manifest / system prompt 模板。
- [x] Credential-free company planning demo。
- [x] `conductor-work plan <contract.json>` MVP。
- [x] `conductor-work run <contract.json> --profile <profile>` 已完成（issue #51，PR #52，merge commit `c05dcba7228f6cf1439eb76b4b58f1ca022099a2`）：校验 Company Brain/TaskContract，启动 candidate-only aeloop run，返回 pending gate 且不自动 approve，可输出 EvidenceBundle 与 JSONL LoopEvents；公司 no-commit/no-push/no-PR/no-merge policy 保持不变。
- [x] `conductor-work` 把完整校验通过的 `TaskContract`（requirements、acceptance criteria、policy）渲染进 coder/tester prompt（PR #56，merge commit `0f55baa81eae559c536a5a2b9fc9c21efe17eeaa`），并新增可复用的 `examples/company-a6-readonly.contract.json` 示例合同、更新 `conductor-work/README.md` 中的公司运行文档。
- [ ] Company Brain（可继续使用内部名称/中性名称）的接口和版本化配置。
- [ ] PRD loader：结构化输入、snapshot、hash、版本和必需字段。
- [ ] Figma loader：snapshot/hash、组件和设计约束引用。
- [ ] GitLab/repository loader：只读分支、权限、规则和路径约束。
- [ ] 公司 profile 从 `AELOOP_PROFILES_ROOT` 注入，不把凭据提交仓库。
- [ ] LiteLLM model routing、allowlist、timeout、成本上限和 fallback policy。
- [ ] 公司依赖 allowlist、命令 allowlist、路径 allowlist、网络 deny-by-default。
- [ ] 明确“只能实现 PRD 功能，不增删功能”的 Contract/Policy 检查。
- [ ] 禁止自动 commit、push、PR、merge；即使模型要求也必须拒绝。
- [ ] 公司任务台显示 RunPlan、当前 gate、需求覆盖、证据、token/cost 和未证明项。
- [~] 可视化 UI mock：任务、状态、timeline、requirements、evidence、policy、token savings。
- [x] Company Work 版本化 RunPlan（budget/capabilities/policy）和 CLI `--json` 输出。
- [~] UI 已通过 `/api/state` 接入真实 `EvidenceEventProjector`/`EvidenceBundle`（当前输入仍是无凭据 fixture，尚未接 live LoopEvent stream）。
- [ ] 公司审批操作只产生外部控制命令，不让 UI 直接修改运行数据库。
- [ ] 完成 PRD → Contract → coder/tester → gates → EvidenceBundle 的垂直 slice。
- [!] 在 Node 24 + 公司 profile 下完成真实 A6 端到端验收（PR #56 已提供可复用的 `examples/company-a6-readonly.contract.json` 只读示例合同，但真实 Node 24 环境下的端到端验收仍未执行/验证，本项继续保持未完成）。
- [ ] 输出公司领导可看的 demo 报告，不包含个人 Brain、私人 memory 或凭据。

## 11. Workflow 插件化

- [x] `coder-tester-loop` 作为首个 workflow。
- [x] workflow manifest 声明并校验 id、version、capabilities、input/output schema、risk class。
- [ ] coder 节点：只实现 Contract allowlist 内的目标。
- [ ] tester 节点：执行允许测试并生成可验证 evidence。
- [ ] `research-synthesis`：来源快照、事实/推断分离、引用完整性。
- [ ] `prd-authoring`：需求结构化、冲突检测、验收标准和 Contract freeze。
- [ ] `design-compliance`：Figma/设计约束与代码变更对照。
- [ ] `release-readiness`：测试、变更、依赖、风险和人工审批汇总。
- [ ] 至少 2～3 个真实 workflow 后再评估 YAML/JSON DSL。
- [ ] DSL 必须只描述 workflow，不允许绕过 Aeloop policy、budget 或 evidence。
- [ ] 后续允许产品、研究等角色使用，但共享同一可靠执行协议。

## 12. Token Budget Plane 验收

- [ ] 每个 Run 创建总 `TokenBudget`：input、output、cache、retry、cost、deadline。
- [ ] Conductor 按 node 分配 budget，不能由单个 agent 无限消耗。
- [~] Context 层按 priority/rank/size 做召回和压缩：PR #38、#39 已合并，完成 issue #36 slice 1/2/3；预算接入、omission 投影到 RunStartedEvent/EvidenceBundle，并持久化到 `context_omissions`；PromptDelta/provider cache 仍待后续 slice。
- [~] Prompt 层使用稳定 prefix、cache 和 delta：issue #40 的 snapshot/provider capability 设计已随 PR #41 合并到 `main`（commit `cf8c82a`），实现待后续 slice。
- [~] Harness 层记录真实 usage、cache hit、估算和 provider cost：issue #48（PR #50）已在 LiteLLM adapter 的 `InvokeResult` 上保留 provider token usage/cache 字段和 latency；串联到 runner、事件系统和 `EvidenceBundle` 仍待后续 slice。PR #57 已合并到 `main`，完成该串联：provider usage 现在从已完成的 coder/tester 事件投影进 `usageRecords` 与 `EvidenceBundle`；model-reported 的 `no_change` evidence 按 fail-closed 处理并标记来源为 `model-reported`；多模型聚合结果不再有歧义。node × role × provider × model × attempt 粒度的 retry-attempt 核算与 retry waste 拆分仍未完成，跟踪 issue #58。
- [ ] 每个 workflow run 必须产出细粒度 token 核算记录，按 node × role × provider × model × attempt 逐条拆分，不能只有 run 级汇总。（跟踪 issue #58）
- [ ] 每条核算记录必须包含 input tokens、output tokens、total tokens、cache tokens（读/写分开）。
- [ ] 每条核算记录必须包含 retry waste（因重试/失败尝试而产生、未计入最终产出的 token 消耗），并与成功 attempt 的 token 分开统计。（跟踪 issue #58）
- [ ] 每条核算记录必须带 source 标记，明确区分「provider 真实上报的 usage」与「本地/规则估算」，不得混用且不标注来源。PR #57 已为 model-reported 的 `no_change` evidence 增加显式 `model-reported` 来源标记；其余 usage_records 路径的来源区分与落库仍待验证补全（issue #58、issue #59）。
- [x] 只读 / 无改动的 run（未产生任何 diff）也必须照常产出 usage 与 completion 证据，不得因为没有代码改动就跳过核算，也不得为了凑数据而编造不存在的 diff：issue #47（PR #49）已确立 `no_change` 终态、使只读/已满足 run 不再进入 G1 gate；`no_change` run 上的 usage/completion 证据核算仍待验证补全。PR #57 已合并到 `main`：model-reported 的 `no_change` evidence 现在按 fail-closed 处理并显式标记来源为 `model-reported`，`no_change` run 上的 usage/completion 证据核算缺口已修复。
- [ ] Loop 层在 retry/escalation/gate 前检查剩余预算。
- [ ] 预算不足时按“缩小 context → 降低重试 → 升级人工”顺序处理。
- [ ] 绝不通过截断 Contract、Policy、pending gate 或关键 evidence 来省 token。
- [ ] 建立 baseline：相同任务的原始历史注入 token 与优化后 token。
- [ ] 记录每个 workflow 的 token/run、cache hit、retry waste、cost/task、完成率。
- [ ] 以至少 10 个真实任务验证 token 降幅和成功率没有下降。

## 13. 防幻觉与可信度验收

- [ ] 未引用来源的外部事实标记为 unknown，而不是 confirmed。
- [ ] 被拒绝或过期 context 不得进入最终决策提示。
- [ ] 每项 requirement 都有 pass/fail/unproven 状态。
- [ ] 每个 claim 能反查到 source snapshot、tool result 或测试 evidence。
- [ ] 代码变更超出 Contract scope 时自动暂停。
- [ ] 测试通过但没有覆盖 requirement 时不能宣称完成。
- [ ] 模型无法确定时请求 gate，不使用“看起来应该可以”的推断替代证据。
- [ ] EvidenceBundle 能明确列出已证明、未证明、冲突和待人工确认内容。
- [ ] 使用故意错误的 PRD、过期 Figma、伪造测试结果做 negative test。

## 14. 安全、隐私与开源拆分

- [ ] 公共 Aeloop 仓库只包含通用运行时、示例 profile、schema、测试和脱敏文档。
- [ ] Personal Brain 独立目录/仓库，私人 memory 和 token 不进公共仓库。
- [ ] Company Brain 独立目录/仓库或受控部署目录，公司数据不进公共仓库。
- [ ] 公司本地拉取公共仓库后可删除 personal docs，不影响 Aeloop/Company Work 构建。
- [ ] 个人、公司 profile 通过外部 root 或 deployment secret 注入。
- [ ] 日志、事件和 EvidenceBundle 默认脱敏。
- [ ] 依赖、命令、路径、网络和 Git policy 在代码和测试中双重校验。
- [ ] 贡献指南、许可证、security policy、release policy 和版本兼容说明齐全。
- [ ] 不把公司 PRD、Figma、GitLab 内容复制到 issue、PR、公共 artifact 或示例。

## 15. Demo、测试与质量门禁

- [x] `pnpm demo:company` 可生成 credential-free 的 Company RunPlan（环境修复后重新验证）。
- [~] 可视化 company demo 可以启动并展示 mock workflow 状态。
- [~] 可视化 demo 已消费真实 `EvidenceEventProjector`/`EvidenceBundle` 输出；事件输入仍是 fixture，live stream 待后续接入。
- [ ] 每个 phase 都有最小垂直 slice，而不是只完成类型和目录。
- [x] Node 24 build 通过。
- [x] Node 24 lint/typecheck 通过。
- [x] Node 24 全量 unit/integration/e2e 测试通过（56 files / 502 tests）。
- [~] 最新本地 Node 23.10 测试基线：PR #49 为 57 files / 580 tests 通过，PR #50 为 57 files / 584 tests 通过，PR #56 为 57 files / 591 tests 通过（Node 23.10.0 上出现既有的 package engine 版本警告）；仓库声明 `engines.node >=24`，公司真实 A6 验收仍要求 Node 24，尚未在 Node 24 上重跑确认。
- [ ] 修复当前 Node 23/24 `better-sqlite3` ABI 不匹配，并在正确 runtime 重跑测试。
- [ ] 运行 schema migration、cross-process resume、workspace policy 和 security negative tests。
- [ ] PR 必须列出测试命令、未完成项、风险和回滚方式。
- [ ] 公司 demo 必须证明“没有自动远程 Git 写入”。

## 16. 里程碑与执行顺序

### P0：当前 PR 前置修复

- [ ] 使用 Node 24 重建依赖并确认 `build/lint/test`。
- [ ] 检查 `conductor-work` MVP 代码、Roadmap 和测试范围。
- [ ] 提交 `conductor-work` plan MVP PR，不包含真实公司凭据和 A6 结果。

### P1：Aeloop 公共协议与证据

- [ ] A7 Public Contracts & Events。
- [ ] A8 Trusted Workspace & EvidenceBundle。
- [ ] A9 Context Continuity & Token Budget Plane。

### P2：编排与产品

- [ ] A10 Workflow Plugin Runtime。
- [ ] A11 Conductor Personal MVP。
- [ ] A12 Conductor Work MVP。
- [ ] A6 在核心协议和安全边界稳定后执行真实双 profile 验证。

### P3：扩展与开源

- [ ] A13 第二个 workflow 和真实跨领域任务。
- [ ] A14 开源 hardening、文档、许可证、脱敏和 release automation。
- [ ] 评估是否拆为 Aeloop、Conductor、Personal Brain、Company Work 多仓库/多 package。

## 17. 当前执行游标

当前只推进以下一项，完成后再移动游标：

- `[~] 当前：PR #35、#38、#39、#41、#43、#44、#46、#49、#50、#52、#56 已合并（PR #35 merge commit `4eae71e5c15ba5d9b782916e65fff147a64cfbc1`）；issue #36 slice 1/2/3 完成，issue #40 设计契约（PromptSnapshot/PromptDelta/provider-session）已完成（PR #41，commit `cf8c82a`），issue #42 外部隔离角色-人设集已完成并合并（PR #43，commit `873adb3e`），issue #37 前置条件已文档化（PR #44，commit `131cb49ff8afd00bbe7c8ccfbab1cfe648e29c93`，仅文档层审计，未加运行时校验器，issue #37 协议兼容实现仍未完成），issue #45 harness schema retry 已修复（PR #46），issue #47 `no_change` 终态、只读/已满足 run 不再进入 G1 gate 已完成（PR #49），issue #48 LiteLLM adapter 保留 provider token usage/cache 字段与 latency 已完成（PR #50，串联到 runner/事件系统/EvidenceBundle 仍待后续），issue #51 `conductor-work run <contract.json> --profile <profile>` 已完成（PR #52，merge commit `c05dcba7228f6cf1439eb76b4b58f1ca022099a2`）：校验 Company Brain/TaskContract、启动 candidate-only aeloop run、返回 pending gate 且不自动 approve、可输出 EvidenceBundle 与 JSONL LoopEvents，公司 no-commit/no-push/no-PR/no-merge policy 保持不变；PR #56（merge commit `0f55baa81eae559c536a5a2b9fc9c21efe17eeaa`）修复了 conductor-work 未把完整 TaskContract（requirements、acceptance criteria、policy）注入 coder/tester prompt 的缺口，并新增可复用的 `examples/company-a6-readonly.contract.json` 只读示例合同、更新了 company runner 文档；最新本地 Node 23.10 全量测试：PR #49 为 57 files / 580 tests 通过，PR #50 为 57 files / 584 tests 通过，PR #56 为 57 files / 591 tests 通过（仓库声明 `engines.node >=24`，公司真实 A6 仍要求 Node 24，尚未在 Node 24 上重跑）。安全 issue #31、运行时 PromptDelta/provider cache、issue #37 协议兼容实现、issue #48 后续串联、真实 Node 24 公司 profile A6 验收均留待后续（A6 未完成，`examples/company-a6-readonly.contract.json` 只是提供了可复用示例合同，尚未在 Node 24 环境下跑通端到端验收）。PR #57 已合并到 `main`：provider usage 现在从已完成的 coder/tester 事件投影进 `usageRecords` 与 `EvidenceBundle`，model-reported 的 `no_change` evidence 按 fail-closed 处理并标记来源为 `model-reported`，多模型聚合结果不再有歧义，issue #48 下游串联至此完成；node × role × provider × model × attempt 粒度的 retry-attempt 核算（issue #58）、usage_records 落库/迁移/长期持久化（issue #59）、live UI event stream、外部 GateCommand 通道与真实 Node 24 公司 profile A6 验收仍未完成。`

下一步顺序：

1. ~~推进公司垂直 slice：把 provider usage/latency 从 `InvokeResult` 串联到 runner 的 `LoopEvent` 和 `EvidenceBundle`~~（已随 PR #57 完成：provider usage 现在从已完成的 coder/tester 事件投影进 usageRecords/EvidenceBundle，model-reported 的 no_change evidence fail-closed 并标记来源，多模型聚合结果不再有歧义）；
2. 按 node × role × provider × model × attempt 逐条拆分 token 核算记录并统计 retry waste（issue #58）；
3. 补齐 usage_records 的落库、schema 迁移与长期持久化（issue #59）；
4. 继续由 Helix 执行下一批，并由外层独立复核；
5. 再进入真实公司 profile/A6 和更多 workflow。

相关目录：

- [Conductor](./conductor/README.md)
- [Conductor Work](./conductor-work/README.md)
- [Conductor Work UI](./conductor-work/ui/README.md)
