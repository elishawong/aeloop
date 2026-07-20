---
name: run
description: 启动 / 跑起 aeloop,用来看一个改动真的 work。当被要求 run/start aeloop、或要确认改动在真实运行里生效(不只编译过)时用。
---

# /run — 跑起 aeloop

让 aeloop 真的跑起来验证改动。**静态读码 / 编译过抓不到运行时问题(尤其真实模型调用 + 跨进程 checkpoint),所以改了就真机看一眼。**

> ⚠️ 当前状态:src/ 引擎尚未建(项目自带层刚接入)。以下命令是 A0 脚手架落地后的目标形态;A0 前只有 docs。

## 前置
- 包管理器:npm。没装依赖先 `npm install`。
- 环境:复制 `.env.example` → 按 profile 填。
  - **helix profile**:无需 apikey,走本机 `claude` / `codex` CLI 登录态。
  - **verity profile**:填 `LITELLM_BASE_URL` / `LITELLM_TOKEN`。

## 跑(默认)
```sh
npm install
AI_AGENT_PROFILE=helix npm run dev        # 或 verity
```

## 验证清单(改了什么看什么)
- 引擎能起、选对 profile、加载对 overlay(config/personas/记忆 db)。
- coder→G1→tester→(打回)→G2→G3 三门**真的卡住等输入**(不是自动通过)。
- 打回达阈值**强制升级**、不给 G2(硬分支不可绕)。
- `approvals` / `structured_claims` 审计表**发生即写**。
- cli-bridge profile 下 `tool_execution` 声称与真实工具调用**核对上**。

## 类型 / 构建 / 测试门
```sh
npm run typecheck   # 必须 PASS(strict + noUncheckedIndexedAccess)
npm run test        # vitest 全绿
npm run build       # 部署前能过
```

## 排错
- LiteLLM 模型「列表可见但调用 400」(如 deepseek):`checkAvailability()` 必须真实探活,别只查 `/v1/models`。
- 单 SQLite 文件下 SqliteSaver 自建表与 memories 表共存:同一 connString、不同表,互不冲突。

> 报「跑通了」前**真在运行环境里验过**,不只编译。
