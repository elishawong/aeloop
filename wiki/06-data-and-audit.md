# 6. 数据、事件与审计

## 6.1 为什么需要事件和证据

最终的一段自然语言总结不够审计。系统需要保留“发生过什么”的事件轨迹，再从事件投影出面向人的 EvidenceBundle。

![事件、证据与 token 记录](./diagrams/data-and-audit.svg)

图源：[data-and-audit.mmd](./diagrams/data-and-audit.mmd)。

## 6.2 主要数据对象

| 对象 | 作用 | 生命周期 |
| --- | --- | --- |
| `workflow_runs` | 一次 run 的身份、profile、状态和版本 | 长期审计 |
| `steps` | 每个节点的开始、结束、状态和错误 | 一次 run |
| `events` | gate、node、tool、usage 等事件 | append-only |
| `approvals` | G1/G2/G3 的人工决定 | 长期审计 |
| `context_items` | 记忆、来源、确认状态、新鲜度 | profile 级 |
| `claims` | coder/tester 产出的结构化结论 | 一次 run |
| `evidence` | 结论的来源和验证状态 | 一次 run |
| `claim_evidence` | claim 与 evidence 的关联 | 一次 run |
| `tool_executions` | 工具调用和核验结果 | 一次 run |
| `artifacts` | diff、测试报告、sanitized 输出 | 一次 run |
| `usage_records` | provider/model/input/output/cache/retry token | 一次调用或节点 |

## 6.3 证据的可信度分层

```text
verified
  由独立工具、测试、轨迹或确定性检查支持

model-reported
  只有模型自报，尚未得到独立机制支持

rejected / omitted
  被 tester、policy 或 context freshness 排除
```

`model-reported` 不能直接升级为“已确认”。Brain 的三态确认也必须尊重这个来源字段。

## 6.4 Token 记录和节省目标

Aeloop 记录每个 provider/model 调用的 usage，目标是回答：

- 哪个 workflow 最耗 token？
- coder 和 tester 各自占多少？
- 重试产生多少浪费？
- Context budget 截断了多少内容？
- PromptDelta/cache 是否真正减少了输入量？

目前可以把 usage 记录当成测量基础，但不能直接宣称“已经节省了多少 token”。需要用相同任务建立 baseline，再比较：

```text
节省率 = (baseline input tokens - aeloop input tokens) / baseline input tokens
```

后续必须同时记录质量指标，例如拒绝率、修复成功率、人工介入次数和回归结果，避免为了省 token 而牺牲可信度。

## 6.5 持久化边界

checkpoint 解决“从哪里继续运行”；audit/event store 解决“发生过什么”；memory store 解决“以后应该记得什么”。三者不能混为一个大 transcript：

```text
checkpoint  ≠  长期记忆
EvidenceBundle  ≠  全量对话历史
usage record  ≠  模型输出正文
```
