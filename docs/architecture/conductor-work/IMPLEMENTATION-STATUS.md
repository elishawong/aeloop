# Conductor Work 实现状态

本文档记录架构设计的第一个实现切片。它被刻意和 brain prompt、部署 profile
分开,好让公司 checkout 能移除个人素材而不动 Aeloop 引擎本身。

## 已在 `refactor/conductor-foundation` 实现

- `src/workflow/`:带版本号的 workflow manifest、插件契约、一个内存 registry,
  以及内置的 `coder-tester-loop` adapter。
- `src/conductor/`:确定性的 `TaskContract` 校验。引擎不会去问模型"这个
  contract 结构上安不安全"。
- `src/conductor/orchestrator.ts`:确定性的 brain-to-workflow 选择;这是
  orchestrator 边界,不是另一个模型 persona,也不是 LangGraph 节点。
- 内置 workflow 会校验一个可选的 `TaskContract`,把它的 requirements、
  scope、evidence policy 和禁止改动渲染进 Coder 和 Tester 看到的执行上下文。
  仅传旧式 task 的调用方依然受支持。
- `evaluateExecutionPolicy()` 提供一个纯函数、fail-closed 的检查,覆盖观测到
  的路径、命令、依赖、网络使用、Git 写操作和 reviewer 写操作。
- `brains/personal/` 和 `brains/company/`:可替换的 prompt/manifest 模板。
  它们是产品层资产,不是运行时依赖。
- `assembleProfileDeps()`:profile-中立的依赖装配。既有的 subscription CLI
  路径仍作为兼容包装保留可用。

## 刻意暂不实现

- 模型驱动的 brain 对话。
- 远程插件市场或动态代码加载。
- 自动的 Git commit、push、pull request 或 merge 操作。
- 声明式 workflow DSL。TypeScript 插件是更安全的第一步;等真实跑出两三个
  workflow 之后再考虑加声明式 workflow。

## 公司演示边界

公司 checkout 提供自己的 profile 目录(比如现有的 `apikey`/LiteLLM 配置)
和公司 brain 素材。公开引擎只要求 profile 满足既有的 `config.yaml` 契约。
本仓库不应包含任何公司凭证、PRD、仓库内容或记忆数据库。

需要把配置放在公开 checkout 之外时,把 `AELOOP_PROFILES_ROOT` 指向私有的
profile root。

跑无凭证的架构演示:

```bash
pnpm run demo:company
```

它会校验一份公司 contract 并确定性地选出内置 workflow;刻意不调用模型,
也不访问任何仓库。
