# test-report —— A2 Harness(Provider Router + LiteLLMAdapter)

> 一份如实的审计记录,记录 Zorro 复审循环(round-1 → round-2 → round-3 → round-4)的真实结果,不是 impact/test-plan 的替代品(指挥官已经裁定这项需求只需要这一份文档)。

## 范围

A2 Harness 层增量(PRD `docs/feature/a2-harness-provider-router-litellm-adapter/PRD.md`):`ProviderRouter` + `AdapterRegistry`(路由核心)、`LiteLLMAdapter`(`direct-api` adapter)、`SchemaValidator`、`harness/config.ts`、`src/harness.e2e.test.ts` 纵切测试,分支 `feature/issue-6-a2-harness`。

最终提交(本轮修复之前):`c3523d4`(`fix(harness): Zorro round-1 rework — 3 blockers + config validation`)。

## Zorro round-1 —— 判定 FAIL

3 个 blocker + 1 个 🟡:
1. `litellm-adapter.ts`:网络读取 `response.text()` 没有包在 try/catch 里——如果读 body 失败,一个裸的 `TypeError` 会逃逸出去,破坏 `errors.ts`「adapter 只抛 `AdapterInvokeError`」这条契约。
2. `extractModel()` 对空字符串 `"model": ""` 没有防护,导致 `InvokeResult.model === ""` 成为可能,违反了 `types.ts` 里的非空不变式。
3. `schema-validator.test.ts` 的守护测试不够严密(细节见 round-1 复审记录)。
4. 🟡:`config.ts` 的 provider 条目缺少带类型的校验(指挥官已批准加一个 `InvalidProviderConfigError`)。

codex `gpt-5.6-sol` 二签:`raw_output_sha256=bb869a1b58177cf83bf322903b00e789a752ef0575732c5421ccbf6e8e0f0eb8`

## 返工(`c3523d4`)

- Blocker 1:在 `litellm-adapter.ts:148-156` 里,把 `response.text()` 单独包进一个 try/catch,捕获后抛出 `AdapterInvokeError`(message 包含 `failed to read response body`)。
- Blocker 2:新增 `extractModel()`,校验 `parsed.model` 是非空字符串(`.trim().length > 0`);`invoke()` 用 `extractModel(parsed) ?? model` 回落到配置里的 model。
- Blocker 3:收紧了 `schema-validator.test.ts` 守护测试的断言。
- 🟡:在 `config.ts` 里加了 `InvalidProviderConfigError`,对 `ProfileConfig.providers[id]` 做带类型的校验。

## Zorro round-2 —— 判定 FAIL

4 处生产代码修复经核实**全部正确**——round-2 没有推翻任何一处生产代码改动。问题完全出在测试上:

- **Blocker-1 的回归测试是假绿**(`litellm-adapter.test.ts:157-179`,标题带「Zorro round-1 blocker 1」)。Zorro 做了变异测试:把 `litellm-adapter.ts:148-156` 的 body-read try/catch 还原回裸的 `const rawBody = await response.text();`,测试**依然 5/5 全绿**——守护价值为零。
- 根因:测试用的假服务器通过 `res.write(partial) → res.socket.destroy()` 同步截断连接,而且这发生在 `fetch()` 拿到 `Response` *之前*(也就是 headers 到达之前)——所以错误落进了 `litellm-adapter.ts:117-131` 的**请求级** catch(它同样抛 `AdapterInvokeError`,同样能通过 `toBeInstanceOf(AdapterInvokeError)` 断言),根本没走到 blocker-1 真正修复的**body-read** catch(:148-156)。断言只检查了 `toBeInstanceOf(AdapterInvokeError)` / `not.toBeInstanceOf(TypeError)`,而两个 catch 分支都产出 `AdapterInvokeError`,没法区分到底命中了哪一个——所以还原 body-read 修复后测试依然通过。

codex `gpt-5.6-sol` 二签:`raw_output_sha256=1ccd7fbe6367f3f2bca8e2eb40d7b4bfb3037d04bc39c378dc5018c130fa2576`

## round-3(本轮)—— 修复

### B1-TEST(blocker)

- **没有动生产代码**(round-2 已经确认 4 处生产代码修复都是对的)。
- 重做了 `litellm-adapter.test.ts` 里那个测试用的假服务器:`res.writeHead(200, {...Content-Length: 10000})` → `res.flushHeaders()`(确保 headers 立刻推上线,不被后续 `write()` 调用缓冲住)→ `res.write(partial)` → `setTimeout(() => res.socket?.destroy(), 50)`(给客户端一个真实的时间窗口接收 headers,让 `fetch()` 的 `Response` 先 resolve,之后才把 body 流从中间切断)。
- 把断言从笼统的 `toBeInstanceOf(AdapterInvokeError)` 收紧到专门钉死 body-read 路径:`error.message` 包含 `"failed to read response body"`(:153 行的文本),`error.cause` 是一个 `TypeError`(undici 对 body-read 失败的原始错误类型)。
- **变异验证**:临时把 `litellm-adapter.ts:148-156` 的 body-read try/catch 还原回裸的 `const rawBody = await response.text();`,测试**变红**(`AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError`,在 `toBeInstanceOf(AdapterInvokeError)` 那一行就失败了,根本没走到新加的 `error.message`/`error.cause` 断言)——证明这个测试现在真的能守护 body-read 修复。验证完后把生产代码还原回原状(`git diff` 确认 `litellm-adapter.ts` 相对 `c3523d4` 无改动)。

### P2(顺带)

- `litellm-adapter.test.ts`:给 blocker-2 的 `extractModel` 测试新增一个用例,`"model": "   "`(纯空白)值,断言 `result.model` 会回落到配置里的 model,且 ≠ `"   "`(此前只覆盖了 `""`)。
- `docs/PROGRESS.md:11`:措辞修正以反映真实状态——B0-B7 已全部提交/推送(`1de735e`、`c3523d4`),不再是「待 commit/push」;加了一条关于 round-2 FAIL + round-3 返工的说明。

## 回归

- `pnpm test`:171 通过(round-2 时的 170 + P2 新增 1 个)。
- `pnpm exec tsc --noEmit`:干净,exit 0。
- `pnpm exec tsc -p tsconfig.build.json`:干净,exit 0。
- lint(`package.json` 的 `"lint": "tsc --noEmit"`,和上面同一条命令):干净。

## Zorro round-3 —— 判定 FAIL(单个 blocker,安全属性已满足)

codex `gpt-5.6-sol` 二签:`raw_output_sha256=c9cb2402448c43b362b08c05ccd325529e9addd6ce83aefdaa4ba27eba82e41d`

- **安全属性已满足**:round-2 发现的假绿问题已经被真正修复,生产代码 `litellm-adapter.ts` 相对 `c3523d4` 零改动,`pnpm test` 171 全绿。
- **唯一的 blocker**:round-3 为修复假绿引入的 `setTimeout(() => res.socket?.destroy(), 50)` 是一个不确定的时间赌注——B1 测试赌的是 50ms 内客户端一定已经收到 headers、`fetch()` 的 `Response` 一定已经 resolve;在负载较重的 CI 下,这个定时器可能在 `fetch()` resolve **之前**就触发,连接断得太早会把失败灌进 `litellm-adapter.ts:117-131` 的请求级 catch,而不是 body-read catch(:148-156),导致「`error.message` 包含 `"failed to read response body"`」这条断言失败——**间歇性假红**。这只会假红,不会假绿(不是安全漏洞),但一个 flaky 的守护测试往后大概率会被人/机制静音掉,那实际上等于废掉了 blocker-1 的守护——判定 FAIL,要求改成确定性方案。

## round-4(本轮)—— 去掉定时器,改成确定性握手

### B1-TEST(blocker)

- **没有动生产代码**(`litellm-adapter.ts` 相对 `ffabeeb` 零 diff,`git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` 是空的)。
- 去掉了 `setTimeout(50)` 这个时间赌注,改成在测试内临时包装全局 `fetch`(`LiteLLMAdapter.invoke()` 内部调用的是裸的 `fetch(url, ...)`,走的是 `globalThis.fetch`,所以包装它就能直接拦截):

  ```ts
  let serverSocket: import("node:net").Socket | undefined;

  activeServer = await startFakeServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "10000" });
    res.flushHeaders();
    res.write('{"model":"gpt-4o-mini","choices":[{"message":{"content":"partial');
    serverSocket = res.socket ?? undefined;
    // Deliberately not destroying here — leave it to the wrapped fetch below to act only once it has the Response.
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const res = await originalFetch(...args);
    // originalFetch() resolving is itself the event of "the client has already received the headers" —
    // the same event the old 50ms timer was trying to approximate, now made a mechanical guarantee instead.
    serverSocket?.destroy();
    return res;
  }) as typeof fetch;
  ```

  在 `finally` 块里恢复 `globalThis.fetch = originalFetch`,避免污染其他测试。
- 原理:Node/undici 的 `fetch()` Promise 在收到状态行 + headers 后就会 resolve(body 还没读完)——这正是旧的 `setTimeout(50)` 想要近似的那个时间点。round-4 不再「赌大概率 50ms 内会发生」,而是真的等这个事件发生之后才销毁 socket,把「headers 已到达 → 才断开连接」变成一个 happens-before 关系,不再是概率。`Content-Length: 10000` 依然远大于实际写入的字节数,保证 destroy 那一刻 `response.text()` 还在等更多字节,body-read 失败路径因此被机械地命中。
- 断言不变:`error.message` 包含 `"failed to read response body"`,`error.cause instanceof TypeError`。

### 变异验证(round-4 重做)

临时把 `litellm-adapter.ts:148-156` 的 body-read try/catch 还原回裸的 `const rawBody: string = await response.text();`,跑了 `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts`:

- 结果:**1 个失败 / 13 个通过**,失败的正好就是这个 body-read 守护测试,报出 `AssertionError: expected TypeError: terminated to be an instance of AdapterInvokeError`(先在 `toBeInstanceOf(AdapterInvokeError)` 那一行失败,意味着拿到的是一个裸 `TypeError`——也就是说,还原修复之后,错误确实原样从 body-read 路径逃逸出去了,测试如实抓住了它)。
- 验证完后把 `litellm-adapter.ts` 还原回原状,确认 `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts` 是空的。

### 稳定性验证(针对 round-3 那个 blocker 本身)

- `pnpm exec vitest run src/harness/adapters/litellm-adapter.test.ts` 连续跑了 15 次:15/15 全绿(每次都是 14 个测试通过),不再残留任何定时器,理论上不应该 flaky——实际跑下来也确实没有 flaky。
- `pnpm exec vitest run`(完整套件)又跑了 5 次:每次都是 171/171 全绿。

## 回归(round-4)

- `pnpm test`:171 通过。
- `pnpm exec tsc --noEmit`:干净,exit 0。
- `pnpm exec tsc -p tsconfig.build.json`:干净,exit 0。
- `git diff ffabeeb -- src/harness/adapters/litellm-adapter.ts`:空的(生产代码零改动)。

## 状态

**已暂存,等指挥官批准 commit/push,然后交给 Zorro 做 round-4 复审。**
