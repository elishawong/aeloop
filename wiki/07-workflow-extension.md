# 7. Workflow 扩展

## 7.1 当前 MVP

当前最成熟的 workflow 是：

```text
coder → G1 → tester → (reject → G2 → coder)* → G3
```

它针对代码生成和测试复核，但引擎不应该永远绑定“程序员流程”。

## 7.2 可扩展方向

未来可以定义：

- research：检索 → 来源核验 → 摘要 → 人工确认。
- PRD：需求拆解 → 冲突检查 → 验收标准 → 评审。
- design review：Figma/设计输入 → 约束检查 → 实现建议。
- incident：事实收集 → 时间线 → 根因候选 → 复盘确认。
- release：候选构建 → 测试 → 风险审查 → 人工发布。

这些 workflow 都应该复用 Prompt、Context、Harness 和 Loop 的机制，而不是复制一套新的 Agent runtime。

## 7.3 当前已经预留的扩展点

| 扩展点 | 设计意图 |
| --- | --- |
| `WorkflowDefinition` | 用声明式定义节点、边、能力和 gate |
| `NodeSpec.role` | 角色名保持开放，不把角色写死为 coder/tester |
| provider registry | 新模型通过 adapter 注册，不改 Loop |
| persona/schema registry | 新角色绑定自己的 persona 和输出 schema |
| profile overlay | 同一 workflow 由 personal/company policy 参数化 |
| event projector | UI 和报表消费事件，不耦合执行节点 |

## 7.4 插件化的边界

第一阶段不应该急着做完整的 marketplace 或复杂 UI workflow builder。比较稳妥的顺序是：

1. 先有第二、第三个真实 workflow。
2. 验证它们能否只通过 definition、role、schema 和 adapter 接入。
3. 再把稳定的注册表抽成插件 API。
4. 最后建设可视化 workflow 编辑器。

这样可以避免先建一个很大的框架，却没有真实 workflow 证明抽象正确。

## 7.5 workflow 的安全要求

每个 workflow 都要显式声明：

- 输入 contract schema。
- 节点角色和 provider。
- 允许的工具。
- 哪些节点需要人工 gate。
- 失败和升级条件。
- 输出 evidence schema。
- 是否允许副作用。

默认应当是 fail-closed，而不是“定义缺少字段时自动放宽”。
