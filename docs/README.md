# aeloop — 文档体系 (Doc System)

> 📌 文档体系索引 + 规则。开工先读。沿用 Helix 纪律:**单一事实来源、完成即删、历史归 git**。

## 0. 黄金法则(焊死)
1. **每份文档只回答一个问题,只有一份真相。** 别存两份。
2. **文档跟着它描述的代码走。** 引擎设计权威在本仓 `docs/DESIGN.md`;Helix 侧战略判断在 ai-agent,这里链接过去不复制。
3. **进度可中断、可恢复。** 长任务状态落 `PROGRESS.md`。
4. **防膨胀。** 看板/进度只留未完成;做完归 `CHANGELOG.md`(最近)+ `git log`(完整)。

## 1. 文档地图
| 文档 | 位置 | 回答 | 淘汰规则 |
|---|---|---|---|
| **设计权威** | `docs/DESIGN.md` | 引擎做成什么样(四层/DB/文件结构/里程碑) | 方向变则更;本仓权威源 |
| 战略判断 | `ai-agent/docs/verity-port/UNIFIED-ARCHITECTURE-JUDGMENT.md` | 为什么这么建(Helix 侧决策) | 不在本仓,链接过去 |
| 总进度看板 | `docs/ROADMAP.md` | 现在到哪了 / 全貌 | 已完成**保留勾选**;含 idea 插入规则 |
| 在途看板 | `docs/BACKLOG.md` | 现在/接下来做什么 | 只留未完成,做完即删 |
| 恢复点 | `docs/PROGRESS.md` | 跑到一半停哪、从哪续 | 批次完则清 |
| 变更日志 | `CHANGELOG.md` | 最近做完了什么 | 最近 ~15 条/90 天 |
| 完整历史 | `git log` / `git blame` | 谁何时改了什么、为什么 | git 自带,不手抄 |

## 2. 在途 backlog 规则
队列 = 本 repo GitHub Issues + `docs/BACKLOG.md` 镜像。label:`idea`/`quick-fix`/`P0-2`/`status:*`。`gh ... --repo elishawong/aeloop`。idea 未过指挥官不进看板;做完从镜像删 + 关 Issue。

## 3. 维护触发点(每次都做)
1. 每完成一件实质事项 → BACKLOG 删那条 + CHANGELOG 加行 + 关 Issue。
2. commit 前(`/aigit`)确认已回写。
3. 会话/任务收尾主动报「doc 已更 / 无需更」。
4. 批次跑到一半要停 → 写 PROGRESS(见 §4)。

## 4. 「跑到一半关机还能继续」(resume)
进度永远落磁盘,不靠会话记忆。每批结束/中断前更 `docs/PROGRESS.md`。
**新会话/关机重开开场:读 PROGRESS → `git status` → 从「进行中」续。** 批次完 → 清 PROGRESS、写 CHANGELOG。
