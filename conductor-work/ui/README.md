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
