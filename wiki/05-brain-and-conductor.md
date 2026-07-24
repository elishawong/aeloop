# 5. Brain 与 Conductor

## 5.1 Brain 是什么

Brain 是面向人的产品层。它负责把模糊的人类意图转换成 Aeloop 可以验证的任务契约，并在多次会话之间维持身份、决定和待办线索。

个人和公司可以有两副不同的 brain：

| 维度 | Personal brain | Company brain |
| --- | --- | --- |
| 目标 | 灵活协作、头脑风暴、个人项目 | 严格遵守 PRD、policy 和安全边界 |
| 模型 | 订阅 CLI profile | 公司 LiteLLM/API profile |
| 记忆 | 个人决定、项目背景 | 公司允许保存的状态和审计摘要 |
| 输出 | 允许更自由的探索 | 必须形成 versioned TaskContract |
| Git | 可由人工选择更高自由度 | 默认禁止自动写 Git |

仓库中的 `brains/personal` 和 `brains/company` 是安全的静态模板：manifest 描述 brain 身份和默认 workflow，system prompt 描述默认行为。它们不应该放凭证、客户数据或仓库机密。

## 5.2 Conductor 是什么

Conductor 是 Brain 和 Aeloop 之间的确定性边界。它不是另一个“自由发挥的大模型”，而是执行计划和策略的编译器。

它负责：

1. 加载并校验 `TaskContract`。
2. 验证 brain、workflow 和 contract schema 版本。
3. 检查 policy、允许路径和允许操作。
4. 选择已经注册的 workflow。
5. 固定本次运行的 budget 和版本快照。
6. 启动 Aeloop，并把结果转换为产品层可读的状态。

## 5.3 TaskContract 是关键防线

TaskContract 把“模型理解的需求”变成“引擎可以检查的边界”。它应至少包含：

```text
contractId
schemaVersion
objective
requirements[]
  ├── id
  ├── text
  ├── sourceRef
  └── acceptanceCriteria[]
riskLevel
policy
sourceSnapshots
brain
createdAt
```

确定性 validator 可以检查字段、版本、policy 和结构，但不能替代模型完成自然语言需求拆解。因此要把两者分开：

```text
模型负责理解和提出 contract
代码负责验证 contract 能否被接受
```

## 5.4 Brain 不应直接调用执行工具

正确边界：

```text
Brain → TaskContract → Conductor → Aeloop → EvidenceBundle
```

不推荐：

```text
Brain → 直接 shell / Git / API 写入
```

这样可以让个人 brain 和公司 brain 共享执行引擎，同时让公司 policy 在唯一入口生效。

## 5.5 身份记忆和运行证据分开

Brain 的长期身份记忆与 Aeloop 单次运行的 EvidenceBundle 不是同一类数据：

- identity memory：我是谁、长期约束、已确认决定、当前项目。
- run evidence：这次运行做了什么、用了什么模型、哪些 gate 通过。

只有经过确认和筛选的运行结论，才应该被提炼回 brain memory；不能把整个 EvidenceBundle 原样塞进长期记忆。
