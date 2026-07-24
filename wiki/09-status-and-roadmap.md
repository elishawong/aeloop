# 9. 当前状态与后续路线

## 9.1 当前可以相信的能力

基于当前 `origin/main` 的源码和测试，以下能力已经有明确实现基础：

- Prompt、Context、Harness、Loop 四层代码边界。
- profile loader 和外部 profile root。
- LiteLLM、Claude CLI、Codex CLI adapter 的抽象。
- provider router。
- schema validation 和有限重试。
- coder/tester Loop、gate、reject threshold、escalation。
- checkpoint、resume、events 和审计投影。
- TaskContract、RunPlan、company policy 验证。
- company candidate-only runner。
- personal/company brain 静态模板。
- usage evidence 的基础投影。
- 根目录 `conductor-work/ui` 的概念演示。

## 9.2 仍然要谨慎描述的能力

### Token 节省

Context budget 已经有实际接线基础，但 PromptDelta/cache 和跨重启 usage 持久化仍不能直接当成完整能力。必须通过同任务 baseline 对比，才能得出节省率。

### 实时 UI

当前 UI 更接近 fixture/demo。真实 conductor 事件流、外部 gate command 和持久化控制仍需继续接线。

### Brain 长期记忆

静态 brain 文件已经存在，但完整的“醒来、跨会话记忆、外层对话调度、证据回写”仍属于更外层的产品能力，不能误认为四层引擎已经全部提供。

### API 模式工具核验

LiteLLM direct API 可以记录 provider usage 和模型结果，但通常无法取得 CLI bridge 同等粒度的本地工具轨迹。证据强度必须分层。

## 9.3 推荐路线

![推荐路线](./diagrams/status-roadmap.svg)

图源：[status-roadmap.mmd](./diagrams/status-roadmap.mmd)。

优先级建议：

1. 先保证公司侧真实 run 能重复、可审计、可恢复。
2. 再补 usage/evidence 的跨重启持久化。
3. 把 UI 从 fixture 接到真实事件流。
4. 用 baseline 验证 token 优化，而不是凭设计宣称节省。
5. 用 research/PRD 等第二个 workflow 验证可扩展抽象。

## 9.4 判断一个功能是否真的完成

每项能力都要分成两条记录：

```text
设计完成：文档、接口和验收标准存在
代码完成：真实路径、测试和证据已经跑过
```

只有设计而没有真实运行证据时，应标记为“规划/部分实现”，不能当作已交付能力。
