# Changelog — aeloop

> 📌 给人读的「最近做完了什么」摘要。完整、不可篡改的历史以 `git log` 为准。
> 📏 **防膨胀**:只留**最近约 15 条 / 90 天**;超出的删(git 里都在)。最新在上。
> ✍️ **写法**:`- **日期** — 一句话摘要`;细节进 `<details>` 折叠块。

---

- **2026-07-20** — A2 Harness 层 build 完成:ProviderRouter(角色→provider 纯查找,零 I/O)/AdapterRegistry/LiteLLMAdapter(direct-api,HTTP 错误码+尾斜线归一化+缺key+非法JSON+真实探活全覆盖)/SchemaValidator(重试并把错误喂回 prompt)+ 硬性垂直切片(真实 Context→Prompt→Harness 全链路接通,唯一替身 FakeAdapter),165 测试绿(B0-B5 共 164 + B6 垂直切片 1)。
- **2026-07-20** — A0+A1 引擎 build 完成:脚手架 + Context(store/FTS5/staleness/confirmation事务/injector滤rejected)+ Prompt(zod schema/动态persona/composer)+ Context→Prompt 垂直切片,96 测试绿。
- **2026-07-20** — DESIGN 补 §8.5「Verity M2/M3 洞 → aeloop 必修清单」:8 项 PRD 硬验收(ProviderRouter 真做 / ContextInjector 接线 / 重试喂回错误 / InvokeResult 带 provider·model / JSON.parse 包错 / HTTP 错误覆盖 / 事务+补缺列 / rejected 过滤)+ 每里程碑「垂直切片必接通」纪律。依据 Verity M2/M3 对抗式审查。
- **2026-07-20** — 项目接入 Helix:铺项目自带层(CLAUDE / docs 体系 / aigit·run skills / .gitignore)+ 落设计权威 `docs/DESIGN.md`。src/ 引擎代码待 `/spec`→build 起(里程碑 A0-A6)。
