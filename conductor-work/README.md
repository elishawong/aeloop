# Conductor Work

`conductor-work` 是面向公司的产品入口层。它加载公司 brain、读取带版本号的
`TaskContract`,再让确定性的 Conductor 层去选一个已注册的 Aeloop workflow。

这一层不包含任何凭证、仓库数据或公司 PRD。这些都留在部署方的私有 profile
root 和源系统里。

## 无凭证的 plan 演示

```bash
pnpm run build
node scripts/conductor-work.mjs plan ./contract.json
```

## 仅候选执行

公司 runner 现在可以启动一次受治理的候选 run。它从不批准任何 human gate,
也从不做任何 Git 写操作、commit、push、pull request 或 merge。

```bash
export AI_AGENT_PROFILE=apikey
export AELOOP_PROFILES_ROOT="$PWD/profiles"
pnpm run build
node scripts/conductor-work.mjs run ./examples/company-a6-readonly.contract.json --profile apikey --json --events ./company-run.events.jsonl
```

JSON 结果里包含带版本号的 `RunPlan`、当前的 run handle,以及一份公司安全版
`EvidenceBundle`。可选的 JSONL 文件包含观测到的 `LoopEvent` 轨迹。结果里带
`run.interrupt` 表示正在等待外部的人工决定;不会被自动批准。
