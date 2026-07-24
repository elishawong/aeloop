# 8. 公司运行与安全边界

## 8.1 公司侧的目标

公司 profile 的目标不是最大化自动化自由度，而是在严格 PRD、公司模型网关和安全规则下，稳定地产生可审查的候选结果。

```text
公司 Brain
  ↓
严格 TaskContract
  ↓
Conductor policy check
  ↓
Aeloop candidate run
  ↓
EvidenceBundle + events
  ↓
人工决定是否在公司流程中继续
```

## 8.2 公司侧默认禁止项

执行策略应明确禁止：

- 自动 `git commit`。
- 自动 `git push`。
- 自动创建或更新 Pull Request。
- 自动 merge。
- 未声明的依赖安装。
- 未授权的网络访问。
- 访问允许路径之外的文件。
- 把凭证、客户数据或仓库机密写进日志和证据。

公司 runner 可以运行候选 workflow，但不能自动批准 human gate，也不能把“模型说完成”当成授权。

## 8.3 公司 API profile

公司侧通常使用 LiteLLM 或内部 API provider：

```text
coder  → company provider A
tester → company provider B
```

coder 和 tester 应保持独立视角。API 模式通常不能像 CLI bridge 那样获得完整本地工具轨迹，因此工具核验能力可能弱于个人订阅 profile；这必须在 evidence source 中诚实标注。

## 8.4 公司 A6 只读验证的含义

A6 smoke test 的目标是验证一条真实端到端路径，而不是证明所有公司生产场景已经完成：

1. profile 能加载。
2. provider URL 和凭证能被正确解析。
3. company brain 能生成合法 contract。
4. Conductor 能生成 RunPlan。
5. coder/tester 能完成候选运行。
6. policy 能阻止 Git 写操作。
7. gate、events、evidence 和 usage 能被输出。

如果任务没有代码变更，应正确进入 `no_change` 终态，而不是因为无 diff 被误判为失败。

## 8.5 UI 的真实边界

`conductor-work/ui` 是公司概念演示和观测界面。当前 README 明确说明它仍处于 fixture 阶段：

- 页面可以展示事件时间线、gate、evidence 和 token 信息。
- 当前 human-gate 按钮只改变本地页面状态。
- 真实运行事件流和持久化外部 gate 仍需后续接线。

因此演示 UI 不能被描述成已经接入生产运行控制面板。
