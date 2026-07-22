# A6 双 Profile 真实验收 —— 操作 Runbook(指挥官在公司电脑执行)

> 目的:用**真实模型**跑一次 aeloop 的 governed coder/tester 闭环,产出一份**真的 EvidenceBundle**,当作 pitch 的铁证——证明"多模型独立复核 + 证据链"不是 fixture,是真跑通的。
>
> 两条路,都真打模型:**路 A** 用只读契约(`examples/company-a6-readonly.contract.json`,不写盘/不碰 git,零风险快证);**路 B** 用 `aeloop start` 给一个具体编码任务,走完整 coder→独立 tester→修复→过门闭环(引擎当前无写盘步骤,G3 也不真改文件,同样安全)。路 B 是最强铁证。
>
> 分工:军师(Helix)把 main 备好;**指挥官在公司电脑拉 main、按下面步骤跑、拍照回传结果**。

---

## 0. 前置(公司电脑,一次性)

- **Node 24**(仓库 `engines.node >=24`;Node 23 只有 engine warning,但请用 24 保稳)。
- `pnpm`、`git`、能访问公司 LiteLLM 端点。
- 拉最新 main:
  ```bash
  git clone <aeloop repo>        # 或 git pull
  cd aeloop
  pnpm install
  pnpm run build
  ```
- 快速自检(可选,证明基线绿):`pnpm test` → 应 **57 files / 594 tests 全绿**。

---

## 1. 造一份公司 apikey profile(**不进仓库**,放私有目录)

profile 靠 `AELOOP_PROFILES_ROOT` 从**仓库外**挂载,凭据永不进 git。在一个私有目录(如 `~/.aeloop-company/`)下建:

```
~/.aeloop-company/apikey/config.yaml
```

内容(**已按真实 adapter 接口核对**,`kind: direct-api` → LiteLLMAdapter):

```yaml
profile: apikey

providers:
  litellm-coder:
    kind: direct-api
    base_url: <公司 LiteLLM 端点，如 https://litellm.内网/ >
    api_key: <公司 key>
    model: <coder 模型，如 claude-...>
    api_style: anthropic        # anthropic | openai，按该模型走的接口风格

  litellm-tester:
    kind: direct-api
    base_url: <同上或不同端点>
    api_key: <公司 key>
    model: <tester 模型——务必和 coder 用不同模型，如 gpt-...>
    api_style: openai

roles:
  coder:
    provider: litellm-coder
  tester:
    provider: litellm-tester

workflow:
  reject_threshold: 2
```

要点:
- **coder ≠ tester 用不同模型** —— 这正是"独立复核"的核心,pitch 的卖点。
- `base_url` 尾斜杠有没有都行(adapter 会规整);请求路径**按 `api_style` 走**:`openai` → `${base_url}/chat/completions`;`anthropic` → `${base_url}/v1/messages`。所以 `api_style` 要和该模型真实接口对上,写错会 404。
- **凭据两种放法(已核实 loader 行为)**:
  1. **明文写进文件**(最省事,该文件在仓库外 + `.gitignore` 保护)。
  2. **用 env 占位符** `api_key: ${LITELLM_API_KEY}` —— loader 的 `substituteEnvPlaceholders` **会**把 `${ENV_VAR}` 从 `process.env` 展开,但**它不会自动读 `.env` 文件**。所以要用占位符,跑命令时必须让变量真在环境里:要么 `export LITELLM_API_KEY=...`,要么用 `node --env-file=.env ...` 显式加载(见 §2 命令)。⚠️ 之前踩过:`.env` 里写了值但没 `--env-file`,`${LITELLM_BASE_URL}` 字面量原样打进 fetch → adapter 报错。
- ⚠️ **`AELOOP_PROFILES_ROOT` 指的是 `apikey/` 的父目录,不是 `apikey/` 本身**。上面结构里 root = `~/.aeloop-company`(里面才是 `apikey/config.yaml`)。指成 `~/.aeloop-company/apikey` 会 `ProfileNotFoundError`(踩过)。

---

## 1.5 正式跑前先自查(preflight,强烈建议)

公司电脑跑真模型的机会有限、每次失败要拍照来回排查。正式跑之前先跑这一条,把「配错一个字就白跑一次」的坑挡在前面——**它只读 config、不打模型、不碰仓库、不打印 key**:

```bash
AI_AGENT_PROFILE=apikey AELOOP_PROFILES_ROOT=~/.aeloop-company \
  node scripts/a6-preflight.mjs --check-net
```

它会用**和引擎完全一致的规则**核这些(preflight 报错 = 真跑也会出问题,不制造假警报):
- 目录布局:`AELOOP_PROFILES_ROOT` 是不是指到了 `apikey/` 本身(头号坑,会直接告诉你改成父目录)。
- `config.yaml` 能不能解析、`profile`/`providers`/`roles` 形状对不对(这些真跑时会抛 `ProfileConfigParseError`)。
- 每个 provider 的 `kind`(拼错的 `direct-apu` 会被拦)、`base_url`、`api_key`(空/占位符)、`model`。
- **`${ENV_VAR}` 有没有没解析的**(没 `--env-file`/没 export 时字面量会原样打进 fetch → 失败)。
- **`api_style` 有没有拼错**(引擎对非法值会**静默**退回 `openai` 打 `/chat/completions`,拼错的 anthropic 模型会静默失败——这个坑肉眼很难发现)。
- **coder ≠ tester 是不是真用了不同模型**(同模型 → A6「独立复核」卖点失效)。
- `--check-net`:对每个 `base_url` 打一次 LiteLLM 免鉴权探针 `${base_url}/health/liveliness`,确认端点真通(不需要有效 key)。

**读法**:
- `✅ 全绿` → 放心跑 §2 的真 A6。
- `🟡 有 WARN` → 逐条确认是有意为之(如你就是想测同模型)再跑。
- `❌ 有 FAIL`(退出码 1)→ 先按提示修好,别急着跑真的。

**📸 若某条 FAIL 看不懂,拍这段自查输出发军师。**

---

## 2. 跑真实验收 —— 两条路,都是真打模型

> ⚠️ **先理解一个关键区别(你实测会撞到)**:
> - **路 A `conductor-work run` = candidate-only**:coder 出候选变更 → **停在 G1 等人批**就返回。**tester 只在 G1 批准后才跑** —— 所以这条路单独跑,证据里**看不到 "独立 tester 抓 bug" 那出戏**,它证的是「真打到模型 + 出证据链 + fail-closed 停在人工门」。零风险、git 不变,适合当**安全快证**。
> - **路 B `aeloop start` = 全闭环**:交互式过 G1/G2/G3,coder→独立 tester→(抓到 bug)→coder 修→过门。这才是**最强 pitch 铁证**(Run #25 就是这么产的:coder 写 `split('')`,独立 tester 用 `😀a` 抓到 surrogate-pair 拆错,coder 改 `Array.from` 修复,G3 通过)。
>
> 两条都跑,故事最完整:A 证安全边界,B 证独立复核真发生。

### 路 A — candidate-only 只读快证(零风险)

```bash
mkdir -p out
AI_AGENT_PROFILE=apikey AELOOP_PROFILES_ROOT=~/.aeloop-company \
  node --env-file=.env \
  scripts/conductor-work.mjs run examples/company-a6-readonly.contract.json \
  --profile apikey \
  --events out/a6-apikey.events.jsonl \
  --json > out/a6-apikey.result.json
echo "EXIT=$?"
```
> `--env-file=.env` 只在你用了 env 占位符(§1 放法2)时需要;明文放 key 就不用。`.env` 放你私有目录、别进 git。

**预期:**
- 命令退出码 `0`。
- `out/a6-apikey.result.json` 里有 `{ plan, run, evidence, policy: "candidate-only; git writes disabled" }`。
- `evidence`(EvidenceBundle)里能看到:每条 requirement 的 verified/failed/not_proven 状态、claim→evidence、provider usage(input/output token)。
- `out/a6-apikey.events.jsonl` 是一行行的真实 LoopEvent(模型开始/完成、gate、验证)。
- **git 状态不变**(只读契约,`git status` 应干净)。
- ⚠️ 若 coder 觉得任务太含糊,可能直接出 `no_change` 终态(只读契约描述太泛时会这样)——这不算失败,是 fail-closed 正常行为;要看完整闭环走**路 B**。

### 路 B — 全闭环铁证(pitch 主素材,Run #25 同款)

给一个**具体、可测**的编码任务(不是含糊的巡检),走交互式全闭环:

```bash
AI_AGENT_PROFILE=apikey AELOOP_PROFILES_ROOT=~/.aeloop-company \
  node --env-file=.env dist/cli/bin.js start \
  "Write a reverseString(s: string): string that reverses by Unicode code points (so '😀a' → 'a😀', not mojibake). Include the function only."
```
> 命令核对过:`aeloop start` 的任务是**位置参数**(要整体加引号),不是 `--task`;`dist/cli/bin.js` 在 `pnpm run build` 后生成。
> 引擎**尚无写盘步骤**,G3 approve 不会真改你仓库的文件 —— 安全,适合当场演示。
> 到 G1/G2/G3 会停下等你键入决策(approve/reject)。半自动门开关落地后(见 #63,正在审)可让 G1/G2 自动放行、只在 G3 停;当前先手动过门。

**预期看到:** coder 产候选 → G1 你批 → **独立 tester 跑** → 若抓到 bug 走 G2 → coder 修 → G3 → 完成。终态 EvidenceBundle 里 `usage.models` 数组含**两个不同模型名** = 独立复核的铁证。

**📸 请拍照/回传给军师(两条路都拍):**
1. 终端里 `EXIT=0`(路 A)/ 走到 "completed" 那几行(路 B)。
2. `out/a6-apikey.result.json` 里的 `evidence` 段(可 `cat out/a6-apikey.result.json | python3 -m json.tool | less` 看)。
3. `out/a6-apikey.events.jsonl` 前 ~15 行 / 路 B 里 tester 抓 bug 那几屏。
4. `git status`(证明没碰仓库)。

---

## 3.(可选)订阅侧对照

若这台机器装了 `claude` + `codex` CLI 并已登录,可用内建 subscription profile 再跑一次做对照(仓库自带 `profiles/subscription/`):

```bash
node scripts/conductor-work.mjs run examples/company-a6-readonly.contract.json \
  --profile subscription --events out/a6-sub.events.jsonl --json > out/a6-sub.result.json
```

两份 EvidenceBundle 并排 = "同一契约、两条模型路径、都独立复核到证据" —— pitch 的完整故事。

---

## 4. 安全边界(这次跑保证做到)

- 契约 `policy`:`allowedPaths: []`、`allowGitWrite: false`、`reviewerReadOnly: true`、禁 commit/push/PR/merge。
- 只读任务 → 不产生 diff、不碰仓库、不触发 git 写。
- 凭据只在仓库外的私有 profile,不进 git、不进日志。
- **A6 未跑通前,任何材料不得声称 "A6 已完成"**;跑通并回传证据后,军师据实更新状态。

---

## 5. 常见卡点

| 现象 | 多半原因 | 处理 |
|---|---|---|
| `ProfileNotFoundError` | `AELOOP_PROFILES_ROOT` **指到了 `apikey/` 本身**(多套了一层) | root 要指 `apikey/` 的**父目录**(如 `~/.aeloop-company`,里面才是 `apikey/config.yaml`) |
| `UnsupportedProfileError` | `config.yaml` 里 `profile:` 字段 ≠ `apikey` | 核对文件内 `profile: apikey` |
| 请求里出现字面量 `${LITELLM_...}` / adapter 报错 | 用了 env 占位符但**没加载环境变量** | 命令加 `node --env-file=.env`,或 `export` 那些变量;或直接明文放 key |
| 404 / 接口不对 | `api_style` 和模型真实接口不匹配 | anthropic 模型用 `api_style: anthropic`(打 `/v1/messages`),openai 用 `openai`(打 `/chat/completions`) |
| `Bearer undefined` / 401 | `api_key` 空或错 | 核对 key |
| 连接超时 | `base_url` 不通 / 需内网 | 确认公司网络 + 端点 |
| engine warning(Node 版本) | Node < 24 | 换 Node 24 |
| 测试跑出一堆 fail | shell 里 `export` 过 `AI_AGENT_PROFILE`/`AELOOP_PROFILES_ROOT`,污染了测试进程 | 跑测试前 `unset` 它们,或 `env -u AI_AGENT_PROFILE -u AELOOP_PROFILES_ROOT pnpm test` |

有任何一步的输出不符预期,拍照发军师,我来判。
