# aeloop — Doc System

> 📌 Index + rules for the doc system. Read this first before starting work. Same discipline throughout: **single source of truth, delete once done, full history lives in git.**

## 0. Golden Rules (locked in)
1. **Each doc answers exactly one question, and there's only one truth for it.** Don't keep two copies.
2. **Docs follow the code they describe.** Design authority for the engine lives in this repo at `docs/DESIGN.md`; upstream strategic rationale lives in a private internal repo — link to it, don't duplicate it here.
3. **Progress is interruptible and resumable.** Long-running task state lives in `PROGRESS.md`.
4. **Anti-bloat.** Boards/progress docs only keep what's unfinished; done items move to `CHANGELOG.md` (recent) + `git log` (full history).

## 1. Doc Map
| Doc | Location | Answers | Retirement rule |
|---|---|---|---|
| **Design authority** | `docs/DESIGN.md` | What the engine looks like (four layers / DB / file layout / milestones) | Updated when direction changes; authoritative source in this repo |
| Strategic rationale | (lives in a private internal repo) | Why it was built this way (upstream planning decision) | Not in this repo — linked externally, not duplicated here |
| Overall progress board | `docs/ROADMAP.md` | Where things stand now / the full picture | Completed items **keep their checkmark**; includes the idea-insertion rule |
| In-progress board | `docs/BACKLOG.md` | What's being worked on / up next | Only keeps unfinished items, deleted once done |
| Resume point | `docs/PROGRESS.md` | Where a run stopped mid-way and how to resume it | Cleared once the batch is done |
| Changelog | `CHANGELOG.md` | What was recently completed | Last ~15 entries / 90 days |
| Full history | `git log` / `git blame` | Who changed what, when, and why | Comes with git, not hand-copied |

## 2. In-progress Backlog Rules
The queue = this repo's GitHub Issues + the `docs/BACKLOG.md` mirror. Labels: `idea`/`quick-fix`/`P0-2`/`status:*`. `gh ... --repo elishawong/aeloop`. Ideas not yet approved by the commander don't go on the board; once done, delete from the mirror + close the Issue.

## 3. Maintenance Triggers (every time)
1. Every time something substantive is completed → delete that item from BACKLOG + add a CHANGELOG line + close the Issue.
2. Before committing, confirm this has already been written back.
3. At the end of a session/task, proactively report "docs updated / no update needed."
4. If a batch stops partway through → write PROGRESS (see §4).

## 4. "Stop halfway, resume later" (resume)
Progress always lives on disk, never relies on session memory. Update `docs/PROGRESS.md` before every batch wrap-up/interruption.
**New session / restart opening move: read PROGRESS → `git status` → resume from "in progress."** Once a batch is done → clear PROGRESS, write CHANGELOG.
