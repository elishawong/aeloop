# A6 双 Profile 真实验收 —— 操作 Runbook(指挥官在公司电脑执行)

> 目的:用**真实模型**跑一次 aeloop 的 governed coder/tester 闭环,产出一份**真的 EvidenceBundle**,当作 pitch 的铁证——证明"多模型独立复核 + 证据链"不是 fixture,是真跑通的。
>
> 用的是一份**只读**契约(`examples/company-a6-readonly.contract.json`):任务 = "巡检仓库、报告是否已实现、**不改任何文件**"。所以整个过程:不写盘、不碰 git、零风险。适合在公司电脑上安全地真跑。
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
- `base_url` 尾斜杠有没有都行(adapter 会规整);请求打到 `${base_url}/chat/completions`。
- `api_key` 写进文件的话,该文件在仓库外 + `.gitignore` 保护;**是否支持 env 变量替换 api_key 我还没核实([待确认]),先按明文放私有文件最稳。**

---

## 2. 跑公司侧真实验收(主铁证)

```bash
mkdir -p out
AI_AGENT_PROFILE=apikey AELOOP_PROFILES_ROOT=~/.aeloop-company \
  node scripts/conductor-work.mjs run examples/company-a6-readonly.contract.json \
  --profile apikey \
  --events out/a6-apikey.events.jsonl \
  --json > out/a6-apikey.result.json
echo "EXIT=$?"
```

**预期:**
- 命令退出码 `0`。
- `out/a6-apikey.result.json` 里有 `{ plan, run, evidence, policy: "candidate-only; git writes disabled" }`。
- `evidence`(EvidenceBundle)里能看到:每条 requirement 的 verified/failed/not_proven 状态、claim→evidence、provider usage(input/output token)。
- `out/a6-apikey.events.jsonl` 是一行行的真实 LoopEvent(模型开始/完成、gate、验证)。
- **git 状态不变**(只读契约,`git status` 应干净)。

**📸 请拍照/回传给军师:**
1. 终端里 `EXIT=0` 那几行。
2. `out/a6-apikey.result.json` 里的 `evidence` 段(可 `cat out/a6-apikey.result.json | python3 -m json.tool | less` 看)。
3. `out/a6-apikey.events.jsonl` 前 ~15 行。
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
| `UnsupportedProfileError` / `ProfileNotFoundError` | `AELOOP_PROFILES_ROOT` 没指对,或 `config.yaml` 里 `profile:` 字段 ≠ `apikey` | 核对目录结构 `<root>/apikey/config.yaml` + 文件内 `profile: apikey` |
| `Bearer undefined` / 401 | `api_key` 空或错 | 核对 key |
| 连接超时 | `base_url` 不通 / 需内网 | 确认公司网络 + 端点 |
| engine warning(Node 版本) | Node < 24 | 换 Node 24 |

有任何一步的输出不符预期,拍照发军师,我来判。
