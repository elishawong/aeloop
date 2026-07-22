---
name: status-table
description: 按需查一眼"现在在途"状态表——固定 | 任务 | 状态 | 选用模型 | 三列，图标固定映射，只报 confirmed 的事实。当被问「在途待办有什么」「现在做到哪」「状态怎么样」这类问题时用。
metadata:
  project: aeloop
  source: internal
---

# status-table — 按需查询"在途任务状态表"（aeloop issue #84 追加）

## 什么时候用

用户问类似这些问题时触发：
- "在途待办有什么？"
- "现在做到哪了？"
- "状态怎么样？"

不是"醒来时自动报"（那是 SessionStart hook `brain-wake-greeting.mjs` 的职责，见
`docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`）——这个 skill 是**被动、按需**触发的，
会话进行到一半、用户随口问一句"现在什么情况"时用。

## 数据源 = aeloop 身份 MemoryStore（不是任何 markdown 文件）

这张表和醒来开场白的"现在在途"段**读同一份数据、跑同一份渲染代码**（`docs/conductor-brain-layer/spike/lib/status-table.mjs`
的 `collectStatusRows()`/`renderStatusTable()`），不是分别维护的两套东西——数据源是
`AELOOP_BRAIN_IDENTITY_DB` 指向的 aeloop 身份 `MemoryStore`（`type: "active_task"` 的 memory），
**不读任何 `state/*.md` 之类的文件**（那是另一套独立原型 Verity 的做法，本仓库没有对应文件，
也不打算引入）。

## 怎么做

1. 运行：

   ```
   node docs/conductor-brain-layer/spike/print-status-table.mjs
   ```

   前置：`pnpm run build`（一次即可，生成 `dist/`）+ 已设置环境变量 `AELOOP_BRAIN_IDENTITY_DB`
   （身份库路径，见 `docs/conductor-brain-layer/WAKE-GREETING-RUNBOOK.md`）。

2. 把这条命令的 **stdout 原样**当成回复里的表格内容——不重新排序、不改写措辞、不额外补行、
   不删掉任何一行。这是一个确定性渲染出的结果，不是需要你再加工的原始素材。

3. 如果命令失败（非零退出 / stderr 有内容，通常是 env 没设置或身份库打不开）：如实告诉用户
   "身份库还没接好，看不到在途状态"，**不要**编一张空表或猜一个状态出来顶上。

## 固定表格格式（不可自创变体）

```
| 任务 | 状态 | 选用模型 |
| --- | --- | --- |
| <task 名称> | <状态图标+文字> | <模型名 或 —> |
```

**图标固定映射**（`lib/status-table.mjs` 的 `STATUS_EMOJI`，两个消费方共用同一份常量，
不得自己发明新图标或新状态词）：

| 图标 | 含义 |
|---|---|
| ✅ done | 已完成 |
| 🟡 进行中 | active_task 正常推进中（也是缺省状态：**没打** `status:` tag 的 active_task 默认按这个算） |
| ⬜ 待做 | 排了但还没开始 |
| 🔴 阻塞或等决策 | 卡住了，或者在等一个决策 |
| ❓ 未知状态（status:\<value\>） | **打了** `status:` tag，但值不是以上四种任何一个（拼错/新值）——原样带出那个值，绝不因为"看起来大概率是在推进"就冒充成 🟡（2026-07-22 blocker 1 定盘：区分"没打 tag"和"打了但不认识"） |

"选用模型"列：这条任务的 memory 上如果有 `model:<name>` tag 就填那个名字，**没有就填 `—`，
绝不猜一个模型名上去**。

**三节都空 → 输出一句"当前没有在途任务。"，不出空表**——这也是 `renderStatusTable()` 本身的
行为（`rows.length === 0` 时直接返回这句话，不是返回一个只有表头没有表体的 markdown 表格）。

## 红线（和醒来开场白同一条防幻觉原则，不可绕过）

**只列 `confidenceState === "confirmed"` 的 active_task memory，绝不把 `unconfirmed`（还没确认）
或 `rejected`（已经否掉）的当成既定事实列进这张表**——`collectStatusRows()` 本身在查询层就已经
过滤掉了这两种非 confirmed 的记录，所以只要你老老实实转述 `print-status-table.mjs` 的 stdout，
这条红线是自动满足的；但如果你决定不跑这个命令、自己凭对话记忆现拼一张表，这条红线就完全靠你
自己遵守了——**不要那么做，永远跑上面那条命令拿真实数据**。

## 禁止行为（四条，逐条对应军师指令）

1. **不得**把表格省成一段纯文字描述（"在做 A、B 还没开始"这种）——固定用 markdown 表格。
2. **不得**发明新的状态图标/文字变体（比如自己造一个"⏸️ 暂停"）——只能用上面那四种。
3. **不得**把 Idea Queue（`type: "idea"` 的 memory）混进这张表——那是另一个独立的段落
   （见 `render-greeting.mjs` 里的 "Idea Queue 积压"），这个 skill 只管 active_task 状态表。
4. **不得**在没有任何在途任务时硬造一张只有表头的空表——按上面"三节都空"那条规则，直接说
   "当前没有在途任务。"。
