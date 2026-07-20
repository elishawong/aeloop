# PROGRESS — 当前批次恢复点

> 📌 **「跑到一半关机还能继续」的单一事实来源。** 长任务/批次的实时状态停这。
> 🔁 **新会话/关机重开开场**:① 读本文件 → ② `git status` → ③ 从「进行中」那步接。
> 🧹 批次彻底完成 → **清空**(只留下面空模板),成果写进 `CHANGELOG.md`。
> 规则见 [docs/README.md §4](./README.md)。

---

## 当前批次
- **批次名**:A0+A1 引擎脚手架 + Context/Prompt 层(`docs/feature/a0-a1-engine-scaffold-context-prompt/PRD.md`,分支 `feature/issue-1-a0-a1-scaffold`)
- **进行中**:B0(scaffold,commit `c19dff3`)+ B1(profile loader,commit `948fd24`)已完成,已 push。**下一步:B2**(`src/context/types.ts` + `errors.ts` + `store.ts` 建表+FTS5+CRUD + `store.test.ts`),见该需求 `progress.md` 顶部 RESUME 指针。
- 详细批次日志见 `docs/feature/a0-a1-engine-scaffold-context-prompt/progress.md`(逐批做了什么 + 自检结果 + 决策记录);本文件只留一句指针,不重复内容。
- 上一批成果见 CHANGELOG.md
