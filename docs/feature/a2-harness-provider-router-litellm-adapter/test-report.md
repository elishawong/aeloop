# test-report — A2 Harness (Provider Router + LiteLLMAdapter)

> 诚实的审查留痕,记录 Zorro 复审循环(round-1 → round-2 → round-3 → round-4)的实际结果,不是 impact/test-plan 的替代品(指挥官已裁定本需求只补这一份)。

## 范围

A2 Harness 层增量(PRD `docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`):`ProviderRouter` + `AdapterRegistry`(路由核心)、`LiteLLMAdapter`(`direct-api` 适配器)、`SchemaValidator`、`harness/config.ts`、`src/harness.e2e.test.ts` 垂直切片,分支 `feature/issue-6-a2-harness`。

最终 commit(本轮修复前):`c3523d4`(`fix(harness): Zorro round-1 rework — 3 blockers + config validation`)。

## Zorro round-1 — 判 FAIL

3 个 blocker + 1 个 🟡:
1. `litellm-adapter.ts`:`response.text()` 网络读取未纳入 try/catch,body 读取失败时会以裸 `TypeError` 逃逸,破坏 `errors.ts` "adapter 只抛 `AdapterInvokeError`" 的契约。
2. `extractModel()` 对空字符串 `"model": ""` 无守卫,会让 `InvokeResult.model === ""`,违反 `types.ts` 的非空不变式。
3. `schema-validator.test.ts` 守门测试拧得不够紧(具体见 round-1 复审记录)。
4. 🟡:`config.ts` provider 条目缺类型化校验(指挥官已批,追加 `InvalidProviderConfigError`)。

codex `gpt-5.6-sol` 二签:`raw_output_sha256=bb869a1b58177cf83bf322903b00e789a752ef0575732c5421ccbf6e8e0f0eb8`

## 返工(`c3523d4`)

- blocker 1:`litellm-adapter.ts:148-156` 把 `response.text()` 包进独立 try/catch,捕获后抛 `AdapterInvokeError`(message 含 `failed to read response body`)。
- blocker 2:新增 `extractModel()`,对 `parsed.model` 做非空字符串校验(`.trim().length > 0`),`invoke()` 用 `extractModel(parsed) ?? model` 兜底到配置的 model。
- blocker 3:拧紧 `schema-validator.test.ts` 守门测试断言。
- 🟡:`config.ts` 新增 `InvalidProviderConfigError`,对 `ProfileConfig.providers[id]` 做类型化校验。

## Zorro round-2 — 判 FAIL

生产码 4 处修复本身经核实**都是对的**,round-2 未推翻任何一处生产码改动。唯一的问题在测试:

- **blocker-1 的回归测试是假绿**(`litellm-adapter.test.ts:157-179`,标题含 "Zorro round-1 blocker 1")。Zorro 做了变异测试(mutation testing):把 `litellm-adapter.ts:148-156` 的 body-read try/catch 撤掉、还原成裸 `const rawBody = await response.text();`,该测试**仍然 5/5 绿**——零守门价值。
- 病根:测试的假服务器用 `res.write(partial) → res.socket.destroy()` 同步截断连接,在 `fetch()` 拿到 `Response`(即 headers 到达)之前连接就已经断了,错误落进 `litellm-adapter.ts:117-131` 的 **request-level** catch(那里也抛 `AdapterInvokeError`,同样能通过 `toBeInstanceOf(AdapterInvokeError)` 断言),根本没走到 blocker-1 真正修的 **body-read** catch(:148-156)。断言只查 `toBeInstanceOf(AdapterInvokeError)` / `not.toBeInstanceOf(TypeError)`,两个 catch 分支产出的都是 `AdapterInvokeError`,分辨不出打中的是哪一个,所以撤掉 body-read 修复它照样绿。

codex `gpt-5.6-sol` 二签:`raw_output_sha256=1ccd7fbe6367f3f2bca8e2eb40d7b4bfb3037d04bc39c378dc5018c130fa2576`

## round-3(本轮)— 修复

### B1-TEST(blocker)

- **不动生产码**(round-2 已确认 4 处生产码修复都对)。
- 改造 `litellm-adapter.test.ts` 里那条测试的假服务器:`res.writeHead(200, {...Content-Length: 10000})` → `res.flushHeaders()`(确保 headers 立即推上线,不被后续 `write()` 缓冲)→ `res.write(partial)` → `setTimeout(() => res.socket?.destroy(), 50)`(给客户端真实的时间窗口收到 headers、让 `fetch()` 的 `Response` 先 resolve,之后才让 body 流中途断)。
- 断言从「泛泛的 `toBeInstanceOf(AdapterInvokeError)`」收紧到「专门锁定 body-read 路径」:`error.message` 含 `"failed to read response body"`(:153 的文案)、`error.cause` 是 `TypeError`(undici body-read 失败的原始错误类型)。
- **变异验证**:把 `litellm-adapter.ts:148-156` 的 body-read try/catch 临时还原成裸 `const rawBody = await response.text();`,该测试**转红**(`AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError`,命中新加的 `error.message`/`error.cause` 断言之前就先在 `toBeInstanceOf(AdapterInvokeError)` 这行失败)——证明测试现在真的在守 body-read 修复。验证完已把生产码改回原样(`git diff` 确认 `litellm-adapter.ts` 相对 `c3523d4` 无改动)。

### P2(顺带)

- `litellm-adapter.test.ts`:blocker-2 的 `extractModel` 测试补一个纯空白 `"model": "   "` 的用例,断言 `result.model` 落回配置的 model、且不等于 `"   "`(此前只覆盖 `""`)。
- `docs/PROGRESS.md:11`:措辞订正,反映实际状态——B0-B7 已全部 commit/push(`1de735e`、`c3523d4`),不再是「待 commit/push」;补上 round-2 FAIL + round-3 返工的说明。

## 回归

- `pnpm test`:171 passed(round-2 时 170 + P2 新增 1 条)。
- `pnpm exec tsc --noEmit`:干净,exit 0。
- `pnpm exec tsc -p tsconfig.build.json`:干净,exit 0。
- lint(`package.json` `"lint": "tsc --noEmit"`,与上面同一条):干净。

## Zorro round-3 — 判 FAIL(单一 blocker,安全属性已达标)

codex `gpt-5.6-sol` 二签:`raw_output_sha256=c9cb2402448c43b362b08c05ccd325529e9addd6ce83aefdaa4ba27eba82e41d`

- **安全属性达标**:round-2 的假绿实锤已修好、生产码 `litellm-adapter.ts` 相对 `c3523d4` 零改动、`pnpm test` 171 全绿。
- **唯一 blocker**:round-3 为修假绿引入的 `setTimeout(() => res.socket?.destroy(), 50)` 是非确定性时序赌注——B1 测试赌 50ms 内客户端一定已经收到 headers、`fetch()` 的 `Response` 已 resolve;高负载 CI 下这个 timer 可能在 `fetch()` resolve **之前**触发,连接过早断掉会把失败灌进 `litellm-adapter.ts:117-131` 的请求级 catch 而不是 body-read catch(:148-156),导致断言 `error.message` 含 `"failed to read response body"` 失败——**偶发假红**。只会假红、不会假绿(不构成安全漏洞),但 flaky 的守门测试会被后续人/agent mute 掉,等于让 blocker-1 的守门失效,判 FAIL 要求换成确定性方案。

## round-4(本轮)— 去 timer,改确定性握手

### B1-TEST(blocker)

- **不动生产码**(`litellm-adapter.ts` 相对 `ffabeeb` 零 diff,`git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` 为空)。
- 去掉 `setTimeout(50)` 时序赌注,改成测试内临时包裹全局 `fetch`(`LiteLLMAdapter.invoke()` 内部调用的就是裸 `fetch(url, ...)`,走 `globalThis.fetch`,包裹后能直接拦到):

  ```ts
  let serverSocket: import("node:net").Socket | undefined;

  activeServer = await startFakeServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
    res.flushHeaders();
    res.write('{"model":"gpt-4o-mini","choices":[{"message":{"content":"partial');
    serverSocket = res.socket ?? undefined;
    // 故意不在这里 destroy —— 交给下面包裹的 fetch 在拿到 Response 之后再动手。
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await originalFetch(...args);
    // originalFetch() resolve 这件事本身 = 客户端已经收到 headers,
    // 跟旧的 50ms 计时器想赌中的是同一个事件,现在换成机械保证。
    serverSocket?.destroy();
    return res;
  }) as typeof fetch;
  ```

  finally 块里恢复 `globalThis.fetch = originalFetch`,不污染其他测试。
- 原理:Node/undici 的 `fetch()` Promise 在收到状态行 + headers 时就 resolve(body 还没读完),这正是旧 `setTimeout(50)` 想近似的时间点——round-4 不再"赌 50ms 内大概率发生",而是直接等这个事件真的发生了再 destroy socket,把「headers 已到 → 之后才断连接」变成 happens-before 关系,不再是概率。`Content-Length: 10000` 仍远大于实际写入的字节数,保证 destroy 时 `response.text()` 还在等更多字节,body-read 失败路径机械命中。
- 断言不变:`error.message` 含 `"failed to read response body"`、`error.cause instanceof TypeError`。

### 变异验证(round-4 重做)

把 `litellm-adapter.ts:148-156` 的 body-read try/catch 临时还原成裸 `const rawBody: string = await response.text();`,跑 `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts`:

- 结果:**1 failed / 13 passed**,失败的正是这条 body-read 守门测试,报错 `AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError`(在 `toBeInstanceOf(AdapterInvokeError)` 这行就先失败,说明拿到的是裸 `TypeError`——即撤掉修复后错误确实从 body-read 路径原样逃逸出来了,测试如实抓到)。
- 验证完已把 `litellm-adapter.ts` 改回原样,确认 `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` 为空。

### 稳定性验证(针对 round-3 blocker 本身)

- `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts` 连续跑 15 次:15/15 全绿(14 tests passed 每次),不再有任何计时器,理论上不该 flake、实测也没 flake。
- `pnpm exec vitest run`(全量)另跑 5 次:171/171 全绿(每次)。

## 回归(round-4)

- `pnpm test`:171 passed。
- `pnpm exec tsc --noEmit`:干净,exit 0。
- `pnpm exec tsc -p tsconfig.build.json`:干净,exit 0。
- `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts`:空(生产码零改动)。

## 状态

**已 stage,待指挥官批准后 commit/push,交 Zorro round-4 复审。**
