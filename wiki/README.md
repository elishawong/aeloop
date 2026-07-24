# Aeloop 产品 Wiki

> 这是 Aeloop 的产品级说明入口。它解释系统解决什么问题、各层如何协作、一次任务如何运行，以及个人 profile 与公司 profile 的边界。

## 先看这几页

1. [产品总览](./01-product-overview.md)
2. [系统架构与边界](./02-architecture.md)
3. [一次任务如何运行](./03-run-lifecycle.md)
4. [四层引擎详解](./04-engine-layers.md)
5. [Brain 与 Conductor](./05-brain-and-conductor.md)
6. [数据、事件与审计](./06-data-and-audit.md)
7. [Workflow 扩展](./07-workflow-extension.md)
8. [公司运行与安全边界](./08-company-operation.md)
9. [当前状态与后续路线](./09-status-and-roadmap.md)

## Aeloop 是什么

Aeloop 是一个模型无关、以治理为核心的 AI Agent 执行引擎。它不把模型的一次回答直接当成最终结果，而是把需求编译成结构化任务，经过受限执行、独立复核、人工 gate 和审计后，才产生可以交付的候选结果。

核心关系可以记成：

```text
Brain 负责理解和规划
Conductor 负责验证和调度
Aeloop 负责受控执行和证据收集
人负责最终授权和发布
```

## 重要边界

- `brains/personal` 与 `brains/company` 是产品层的默认 brain 模板，不是凭证存储，也不是完整的长期记忆数据库。
- `conductor-work` 是公司侧产品入口，负责加载公司 brain、验证 `TaskContract` 并启动候选 run。
- Aeloop 引擎内部是四层嵌套：`Prompt ⊂ Context ⊂ Harness ⊂ Loop`。
- profile overlay 负责模型、persona、记忆库和策略差异；它不是第五个执行层。
- 公司模式默认不自动执行 `commit`、`push`、PR 或 `merge`。

## 文档约定

- “已实现”表示当前 `origin/main` 有代码和测试证据。
- “部分实现”表示有接口、测试或演示，但尚未接入完整生产路径。
- “规划中”表示设计已经预留，但不能当作当前能力。
- “证据”优先于模型自报；`model-reported` 不等于独立验证。
