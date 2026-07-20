---
name: aigit
description: aeloop 仓库专用的 aigit —— 继承全局 aigit 骨架,额外在 commit 前提醒回写文档体系(CHANGELOG / BACKLOG / PROGRESS / ROADMAP)。当在 aeloop 仓库已 git add 好、想让 AI 写 commit message 时用。
---

# /aigit — aeloop 仓库版(继承全局 + 文档体系回写提醒)

> **继承全局 `/aigit`**(`~/.claude/skills/aigit/SKILL.md`):看 staged → 选 Conventional type →
> 写英文祈使句主题 ≤72 → 对齐仓库风格 → heredoc commit → **无 Claude 署名** → 默认不 push。
> 本仓库版 `name: aigit` 同名,在 aeloop 仓库内**覆盖**全局,只加下面的增量。

## 本仓库增量:commit 前回写文档体系
在写 message + commit 之前先检查(规则见 `docs/README.md`):
1. **CHANGELOG.md** — 实质改动?→ 顶部该有对应一行。没有 → 提醒补,确认后 `git add CHANGELOG.md`。
2. **BACKLOG.md** — 做完了在途待办?→ 从 `docs/BACKLOG.md` 删那条 + 关 Issue(`gh issue close --repo elishawong/aeloop`)。
3. **ROADMAP.md** — 里程碑推进?→ 对应项 `[ ]→[~]→[x]`;push 后把 `[~]` 改 `[x]`。
4. **PROGRESS.md** — 批次跑到一半的中间 commit?→ 确保 `docs/PROGRESS.md` 反映真实停点;批次完则清空。
5. 动了上述文档但没 staged → **暂停**提醒,确认后**仅** `git add` 这些文档(全局「绝不代 git add」铁律的唯一例外)。
