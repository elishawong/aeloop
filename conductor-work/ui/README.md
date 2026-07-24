# Conductor Work 可视化演示

面向公司工作流的零依赖本地 UI。展示的是必须让公司用户看得见的概念:
LoopEvent 时间线、human gate、需求覆盖度、EvidenceBundle、policy 状态、
token 节省量。

```bash
node conductor-work/ui/server.mjs
```

打开 `http://127.0.0.1:4173`。

## 数据从哪来(演示 fixture 阶段,不是生产环境)

这是一个**演示 fixture 阶段**,不接任何真实运行中的 conductor。`server.mjs`
在模块作用域里硬编码了一个小型、类型合法的 `LoopEvent[]` 数组
(形状来自 `src/loop/events.ts`),进程启动时喂它跑一遍真实的
`EvidenceEventProjector` / `EvidenceBundleBuilder` / `TokenBudgetLedger`
这几个类(`src/evidence/bundle.ts`,编译产物在 `dist/evidence/bundle.js`)。
`GET /api/state` 返回的 JSON 因此是从那份 fixture 算出来的真实 projector
*输出*——不是手写出来、装成那个样子的对象。

先在仓库根跑 `pnpm run build`,确保 `dist/evidence/bundle.js` 存在。如果不
存在(全新 checkout、还没 build 过),`server.mjs` 会捕获缺模块的错误,
改为提供一份标注清楚的静态兜底快照(JSON 里 `source: "static-fallback"`),
让页面照样能渲染——但那份兜底数据是手写的,不是 projector 输出。
`/api/state` 响应里的 `source: "projector"` 会告诉你现在看到的是哪一种。

**还处于演示阶段/尚未接线的部分**:*事件流本身*。未来的迭代应该把
`server.mjs` 里的 `FIXTURE_EVENTS` 换成真实 conductor run 发出的真实
`LoopEvent` 流(`runner.ts` 的 `LoopEventEmitter`,或者等真实的
`brains/company` + `TaskContract` + workflow registry 端到端接通之后用
`ConductorWorkApp.projectEvents()`)——换这个 adapter 不应该需要改动
`index.html` 的结构,因为 `app.js` 已经能渲染 `/api/state` 返回的任意形状。

human-gate 按钮(`Approve`/`Reject`)只会本地改变这个页面显示的内容——
不会把决定发给任何持久化的 run。

本文件里除此之外的内容都是文档,不是 UI 文案——`index.html`/`app.js`
里已有的中文 UI 标签保持原样不动。

## 多 workflow 总览看板(issue #2 batch 1,真实数据源,不是 fixture)

页面顶部新增的"多 Workflow 总览"表格接的是**真实数据**,不是上面这套 `/api/state` fixture——
两条数据管线完全独立。

`GET /api/runs` 读取:

- **哪个 profile 的 `workflow.db`**:`CONDUCTOR_WORK_PROFILE` env 优先,其次
  `AI_AGENT_PROFILE`(引擎既有的 profile 选择 env,`src/profile/loader.ts`),都没有时缺省
  `"subscription"`。**profile 目录解析复用引擎自己的 `loadProfile()`**(`src/profile/loader.ts`,
  `assembleProfileDeps()` 内部调的同一个函数,Zorro R1 blocker B3)——不是简单拼
  `profiles/<profile>/`:优先级依次是显式传入(本页没有用到这个入口)→ **`AELOOP_PROFILES_ROOT`
  env**(外置 profile 场景,比如公司凭证目录在仓库外)→ `loadProfile()` 自己的包内相对默认值
  (即仓库内 `profiles/<profile>/`)。对应文件是 `<该 profile 的目录>/workflow.db`(`AuditStore`
  用的既有 SQLite 文件,`aeloop start`/`aeloop resume`/`aeloop list` CLI 读写的同一份)。
  `loadProfile()` 内置的 `isSinglePathSegment()`/`isContainedRealpath()` 检查同时把
  `CONDUCTOR_WORK_PROFILE` 的路径穿越校验也管了(比如传 `"../../../etc"` 会被拒绝,返回诚实的
  降级状态,不会越权读取仓库外任意路径)。
- 只调用 `AuditStore.listRunsByStatus("running"|"escalated")` + `listStepRefsByRun()`,**全程
  只读**,从不调用任何 `insert*`/`update*` 方法(candidate-only 红线的一部分,docs/conductor-mvp/
  DESIGN.md §3.3)。`workflow.db` 文件不存在时,本页**不会**隐式创建它(`fs.existsSync()` 先判断,
  绕开 `better-sqlite3` "打开不存在的文件会自动建空 schema" 这个副作用),直接走降级路径。

`source` 字段告诉你现在看到的是哪一种:

- `"live"`:真实 `AuditStore` 数据,`rows[]` 每一行对应 `workflow_runs` 表里一条 `running`/
  `escalated` 的记录。
- `"static-fallback"`:`workflow.db` 不存在(还没有任何 run 用这个 profile 跑过)或 `dist/`
  未 build——`rows` 是空数组,`message` 字段给出具体原因,不假装有数据。

前端(`app.js`)每 2-3 秒轮询一次 `/api/runs`(不是 WebSocket/SSE——DESIGN §3.4 方案 A 的既有
决定:`WorkflowRun.currentState` 已经是持久化、跨进程可读的字段,轮询足够近实时,不需要新的事件
传输基础设施)。

**batch 1 明确止步于"总览"**:每行只有阶段标签(`phaseLabel`,`src/conductor-work/board.ts` 的
`phaseLabelFor()` 映射)、loop 次数、`coderRoundCompleted`(布尔徽标,列头显示"Coder 完成轮次")、
任务摘要、更新时间——不支持点开某一行看完整时间线/完整 diff/完整证据,那是后续 batch
(DESIGN §3.6)。`coderRoundCompleted`(原名 `hasCandidateDiff`,Zorro R1 yellow①改名)是一个
**近似判据**(coder 是否至少完整跑完一轮,不是"存在一条已决策的 `Approval.diffRef`"——
`AuditStore` 今天没有公开的按 run 查 `Approval` 行的方法,batch 1 刻意不新增核心引擎方法)——
且**不等于"有 diff 可看"**:coder 判定"不需要改动"(`no_change`)时这个字段同样是 `true`(那一轮
确实跑完了,只是没有产生 diff),这正是原名 `hasCandidateDiff` 被判定为误导性、需要改名的原因。
具体语义见 `board.ts` 的 `coderRoundCompletedFromStepRefs()` 文档注释。
