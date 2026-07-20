# PROGRESS — 当前批次恢复点

> 📌 **「跑到一半关机还能继续」的单一事实来源。** 长任务/批次的实时状态停这。
> 🔁 **新会话/关机重开开场**:① 读本文件 → ② `git status` → ③ 从「进行中」那步接。
> 🧹 批次彻底完成 → **清空**(只留下面空模板),成果写进 `CHANGELOG.md`。
> 规则见 [docs/README.md §4](./README.md)。

---

## 当前批次
- **批次名**: (无进行中 Cypher 批次 —— A2 Harness 层 B0-B7 全部完成并已 commit/push,分支 `feature/issue-6-a2-harness`:B0-B5(`2830f68`及之前)、B6(垂直切片 `src/harness.e2e.test.ts`)+ B7(本文档回写)均在 `1de735e`。**Zorro round-1 返工**(`c3523d4`)已完成:修 3 blocker(`litellm-adapter.ts` response.text() 纳入 try/catch、`extractModel()` 空串守卫、`schema-validator.test.ts` 守门测试拧紧)+ 指挥官已批的 🟡(`config.ts` provider 条目类型化校验,新增 `InvalidProviderConfigError`)。**Zorro round-2** 判 FAIL:生产码 4 处修复本身都对,但 blocker-1 的回归测试是假绿(变异测试实锤——撤掉生产码修复该测试仍绿,未真正命中 body-read 分支)。**round-3**(`ffabeeb`,已 commit/push)修复该测试(收紧到确实命中 body-read catch,变异验证已过)+ 补 P2(`extractModel` 空白字符串用例、本节措辞订正)。**Zorro round-3 复审已完成**:安全属性达标(假绿实锤已修、生产码零改动、171 绿),唯一 blocker 是 round-3 引入的 `setTimeout(res.socket?.destroy(), 50)` 非确定性时序赌注——B1 测试赌 50ms 内客户端能收到 headers,高负载 CI 下可能提前触发,把失败甩进请求级 catch 而非 body-read catch,产生偶发假红(只会假红、不会假绿,但 flaky 守门测试会被 mute 掉、等于守门失效)。**round-4(本轮)** 把该 `setTimeout` 换成确定性 happens-before 握手:测试内临时包裹 `globalThis.fetch`,在真实 `fetch()` resolve(= 客户端已收到 headers)之后才 destroy 服务端 socket,不再靠计时器猜时序;body-read 断言、变异验证均重新过一遍,生产码 `litellm-adapter.ts` 仍零 diff(`git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` 为空)。已 stage,待指挥官批准后 commit/push、走 Zorro round-4 复审,详见该需求 `docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`)
- 上一批成果见 CHANGELOG.md
