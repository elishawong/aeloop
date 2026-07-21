# Aeloop / Conductor / Conductor Work 重构 Roadmap

> 目标：在不破坏现有 Aeloop coder/tester 能力的前提下，逐步形成三个可解耦的产品层次：Aeloop 执行内核、Conductor 编排层、Conductor Work 公司产品层。
>
> 当前基线：PR #34 已合并到 `main`。后续工作在 `refactor/conductor-work-mvp` 分支进行。

## 1. 三层边界

```text
Company Brain / Personal Brain
        ↓ TaskContract + Brain decision
Conductor
        ↓ Workflow selection + policy decision
Aeloop
        ↓ model calls / context / checkpoints / gates / evidence
Workspace
```

### Aeloop：执行内核

负责“如何可靠执行”，不负责公司或个人产品对话：

- Prompt / Context / Harness / Loop 四层运行时；
- Workflow Plugin 与 Registry；
- Coder、Tester、Research 等工作流的执行；
- checkpoint、resume、人工 gate、事件流和审计；
- 模型调用、结构化输出和工具证据；
- 不自动 commit、push、PR、merge。

### Conductor：确定性编排层

负责“选择什么、是否允许执行”：

- Brain 输出的 `TaskContract` 校验；
- Brain 与 Workflow 的匹配；
- Workflow 选择与版本锁定；
- 安全策略检查；
- gate 决策、停止、升级等控制命令的确定性解析；
- 不保存个人或公司长期记忆；不把对话提示写死在 Aeloop。

### Conductor Work：公司产品层

负责“公司用户如何使用”：

- 公司 Brain（Verity 的产品化实现）；
- PRD / Figma / GitLab / 公司规范输入；
- 公司 profile 和 LiteLLM 配置；
- 公司安全策略、依赖 allowlist、workspace policy；
- 任务台、审批界面、EvidenceBundle 展示；
- 不把公司 PRD、凭据、仓库内容放进公共 Aeloop 仓库。

私人 Brain（Helix 的改版）与 Conductor Work 平行，复用 Conductor/Aeloop 协议，但拥有独立 prompt、记忆和 profile。

## 2. 阶段路线

### Phase 0：基线与发布（已完成）

- [x] issue-29-events：事件流、监听器隔离、事件顺序和回归测试；
- [x] rebase 到最新 main；
- [x] PR #34 合并；
- [x] Node 24 build、lint、全量测试通过。

### Phase 1：Aeloop 内核解耦（基础重构，已完成/进行中）

- [x] Workflow Manifest / Plugin / Registry；
- [x] `coder-tester-loop` 适配为首个 Workflow Plugin；
- [x] profile-neutral dependency assembly；
- [x] `AELOOP_PROFILES_ROOT`，支持公司私有 profile 外置；
- [x] TaskContract 结构校验和 prompt 注入；
- [x] fail-closed execution policy 检查；
- [~] `conductor-work` MVP 的 brain manifest / contract loader / plan 入口；
- [ ] 将 evidence、token、cost、tool trace 统一纳入 `EvidenceBundle`；
- [ ] 为 Workflow Plugin 增加版本兼容、输入输出 schema 和 capability 声明；
- [ ] 将 runtime API 与 CLI 解耦，CLI 只作为一个 consumer。

完成标准：Aeloop 可以在没有 Brain 对话层的情况下，接收一个合法 `TaskContract` 并可靠执行、暂停、恢复和审计。

### Phase 2：Conductor 编排层

- [x] Brain → TaskContract → Workflow 的确定性 Orchestrator；
- [x] Brain kind 与 Contract brain 的匹配检查；
- [x] Workflow 选择和 manifest 锁定；
- [x] policy violation 的统一结果模型；
- [ ] `RunRequest` / `RunPlan` / `GateCommand` 稳定协议；
- [ ] `start / resume / stop / approve / reject / escalate` 命令解析器；
- [ ] 将人工命令与模型输出完全分离；
- [ ] 编排层事件订阅和 EvidenceBundle 聚合；
- [ ] 支持 workflow dry-run 和审批前静态检查。

完成标准：Conductor 可以在不调用模型的情况下，验证请求、选定 workflow、检查 policy，并生成可审计的执行计划。

### Phase 3：Conductor Work 公司 MVP

- [x] company brain manifest 和安全 prompt 模板；
- [x] credential-free company planning demo；
- [~] `conductor-work plan <contract.json>` 入口；
- [ ] 从公司 PRD 生成 TaskContract（先要求结构化输入，后接 Brain）；
- [ ] 读取 Figma / GitLab / repository rules 的 snapshot hash；
- [ ] 公司 profile 通过 `AELOOP_PROFILES_ROOT` 注入；
- [ ] 公司允许路径、依赖、命令、网络和 Git policy；
- [ ] 只生成本地候选变更，不自动 commit/push/PR/merge；
- [ ] 公司 demo：PRD → Contract → Coder/Tester → Gate → EvidenceBundle；
- [ ] 接入真实公司 profile，完成 A6 apikey 端到端验收。

完成标准：公司用户可以用批准的 PRD 和公司 profile 跑通一次真实任务，结果包含审批记录、需求覆盖、测试证据、变更范围和未证明项。

### Phase 4：Personal Brain / Helix 改版

- [ ] 将 Helix prompt/context/harness/loop 对话能力适配到同一 `TaskContract` 协议；
- [ ] 私人记忆与公司记忆完全分离；
- [ ] 订阅 profile 复用 Aeloop CLI bridge；
- [ ] 支持自由 PRD brainstorming，但进入执行前必须冻结 Contract；
- [ ] 私人 Brain 可以拥有更高自由度，但不能绕过 Aeloop 的执行审计。

完成标准：私人 Brain 与公司 Brain 使用同一执行协议，但 prompt、记忆、profile、policy 和产品交互完全可替换。

### Phase 5：Workflow 扩展

按真实需求逐个增加，不先建设通用 DSL：

1. `coder-tester`；
2. `research-synthesis`；
3. `prd-authoring`；
4. `design-compliance`；
5. `release-readiness`。

当至少有 2～3 个真实 Workflow 后，再评估 YAML/JSON DSL 和类似 ruflo 的可视化自定义流程。

## 3. 代码目录目标

```text
src/                         # Aeloop engine
  prompt/
  context/
  harness/
  loop/
  workflow/

src/conductor/                # deterministic orchestration protocol
  contract.ts
  orchestrator.ts
  policy.ts
  run-request.ts              # Phase 2
  commands.ts                 # Phase 2

src/conductor-work/           # company product adapter
  brain-loader.ts
  contract-loader.ts
  app.ts
  main.ts
  sources/                     # PRD/Figma/GitLab adapters, later
  evidence/                    # EvidenceBundle aggregation, later

brains/                       # replaceable, non-secret brain assets
  personal/
  company/

profiles/                     # public examples only
  subscription/

private profiles/              # deployment-owned, outside public checkout
  apikey/
```

## 4. 分支与 PR 策略

- `main`：只接收经过验证的增量；
- `refactor/conductor-work-mvp`：当前 Phase 1/3 实现；
- 后续按 Phase 拆分 PR，不把 A6、公司 UI、私人 Brain 混进同一个 PR；
- 每个 PR 必须包含 build、lint、测试和明确的未完成项；
- 公司真实 profile 验收单独执行，不把凭据或公司数据提交到仓库。

## 5. 当前暂停点

当前 `conductor-work` MVP 已有代码但尚未形成新的 PR。下一步顺序为：

1. 修复并验证 `conductor-work` manifest loader、contract loader、plan CLI；
2. 提交 Phase 1/3 MVP PR；
3. 再实现 Phase 2 的 `RunRequest` / `GateCommand` 协议；
4. 明天接入真实公司 profile 执行 A6。
