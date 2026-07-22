# Token 节省设计（Aeloop / Conductor / Conductor Work）

## 结论

Token 节省不是第五个业务层，而是一条横切的 **Token Budget Plane**：

```text
Conductor：定义本次任务预算与停止规则
        ↓
Aeloop Context：控制送进模型的上下文大小
        ↓
Aeloop Prompt：稳定模板、增量 prompt、避免重复说明
        ↓
Aeloop Harness：模型路由、缓存、max tokens、用量统计
        ↓
Aeloop Loop：限制重试、只传 diff/evidence，不传完整历史
        ↓
Evidence：记录实际消耗，反馈下一次预算
```

## 1. 各层负责什么

| 位置 | Token 节省机制 | 责任归属 |
|---|---|---|
| Context | core memory 全量加载；其余 memory 用 FTS/关键词召回；去重、压缩、stale/rejected 过滤；每个 role 独立 context budget | Aeloop Context |
| Prompt | system/persona 稳定化；schema 只保留必要字段；反馈使用 delta；不重复注入完整历史 | Aeloop Prompt |
| Harness | 按任务复杂度选模型；`max_output_tokens`；prompt cache；估算 input/output；retry 使用更短 prompt | Aeloop Harness |
| Loop | coder→tester 只传 task contract、diff、claims、evidence；不传 chain-of-thought；重试次数和 escalation threshold 硬限制 | Aeloop Loop |
| Conductor | 为 Run、Workflow、Role 分配预算；预算不足时停止/压缩/升级，不让模型无限循环 | Conductor |
| Conductor Work | 公司按 PRD 风险、模型和审批阶段配置预算；把预算纳入公司 policy | 公司产品层 |
| Evidence | 记录 input/output/retry/cache/token/cost；用于预算校准，不直接增加 prompt | Aeloop/Conductor |

## 2. 核心协议

```ts
interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxRetries: number;
  reserveForEscalation: number;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  retry: number;
  estimated: boolean;
}
```

规则：

1. Conductor 在创建 Run 时冻结 `TokenBudget`，不能被模型修改。
2. Harness 每次调用前做 input budget preflight，调用后写入 `TokenUsage`。
3. Context 超预算时按优先级压缩：`requirement > constraint > decision > active_task > recall`。
4. 预算不足时按顺序执行：压缩 context → 降低输出上限 → 使用便宜模型 → 停止并升级。
5. `maxRetries` 和 `reserveForEscalation` 必须硬限制，不能由 prompt 放宽。

## 3. 预期收益

- 减少上下文重复：每轮只传 delta、diff 和结构化 evidence；
- 减少无效召回：rejected/stale memory 不进入正常 prompt；
- 减少昂贵模型调用：简单分类、格式修复和摘要使用低成本模型；
- 减少失败重试：schema validation 与 policy preflight 在模型调用前发现问题；
- 防止 token runaway：每个 Run 有总预算和 retry 上限；
- 能量化优化：用量和成本进入 EvidenceBundle，而不是凭感觉估算。

## 4. 实施顺序

- [ ] `TokenBudget` / `TokenUsage` 类型和 Run snapshot
- [ ] Context budget manager（压缩、去重、优先级）
- [ ] Harness usage adapter（真实 usage + fallback estimate）
- [ ] Prompt delta builder
- [ ] Loop retry / escalation budget guard
- [ ] Conductor `RunPlan` 预算分配
- [ ] Conductor Work 公司预算 policy
- [ ] EvidenceBundle token/cost report
- [ ] 用真实 subscription/company runs 校准默认值

