# PRD — aeloop 开源化:全仓中译英 + 内部治理文件剥离

> 骨架来源:`docs/feature/a4b-loop/PRD.md`(结构/措辞风格逐字沿用,针对本任务"翻译 + 清理"的性质做了调整——这份 PRD 不是新功能开发,所以批次按目录/文件类型拆分,不按代码模块拆分)。
> 防幻觉:`[?]` = 我未验证 / 需指挥官确认;不编造接口/版本/字数。这份 PRD 里的每一个数字(文件数、中文字符数、品牌名出现次数)都来自对这个 worktree 里真实文件实际跑 `rg`/`wc` 得出的结果,不是照抄 issue 原文里(可能已过期)的数字;凡是和 issue #17 原文有出入的地方,§1 逐条列出差异——不悄悄沿用旧数字。

- **项目**:aeloop(`elishawong/aeloop`,私有仓库,即将开源)
- **分支**:`feature/issue-17-opensource`(已经从最新的 `origin/main` `0343111` 切出一个独立 worktree:`/Users/elishawong/code/github/elishawong/aeloop-worktrees/issue-17-opensource`)
- **优先级**:P1
- **状态**:等指挥官确认(**只有 PRD——还没有任何文件被真正翻译/删除**)
- **最后更新**:2026-07-21
- **关联 issue**:[elishawong/aeloop#17](https://github.com/elishawong/aeloop/issues/17)(范围权威,2026-07-21 指挥官已定盘)
- **前置条件**:A4b(#13)已经合并进 main(PR#20,commit `0343111`)——依赖已清除,可以开工。
- **设计权威**:aeloop#17 原文(范围/验收标准的唯一来源)+ 这份 PRD §1 对真实仓库现状的核实

---

## 0. 这份 PRD 是什么 / 不是什么

- **是什么**:把 #17 已经定盘的范围,变成一份可执行、按批次拆分的任务清单,并对照真实仓库现状重新核实 #17 原文里的数字/文件清单,记录任何差异。
- **不是什么**:不重新头脑风暴范围(#17 已经和指挥官定盘);这一步不做任何真正的翻译/删除(见指令第 4 条)。
- 这项任务本质上是"机械翻译 + 清理 + 少量编辑判断",不是功能开发,所以批次按**目录/文件类型**拆分,不按代码模块拆分——这样能让每个批次的改动面窄、`git diff` 好审、`pnpm test` 能频繁跑起来验证零逻辑漂移。

---

## 1. 真实仓库现状核实(对照 #17 原文,记录差异)

### 1.1 核实方法

在这个 worktree 里(`origin/main` HEAD `0343111`,包含 A4b 合并之后新增的 `audit-store.ts`/`runner.ts`/`escalation.ts` 等文件),实际跑了以下命令,`ripgrep 15.1.0`:

```
rg -Pl '[\p{Han}]' <path>     # find files containing Chinese characters
rg -o -P '[\p{Han}]' <path> | wc -l   # count total Chinese characters (not "word count" — it's a code-point count, matching the same ballpark as a human "~XXX characters" estimate)
rg -io 'helix|verity|cypher|zorro' <path> | wc -l   # brand-name occurrence count (case-insensitive, substring match)
```

### 1.2 结果表

| 项目 | #17 原文描述 | 实测结果 | 差异 |
|---|---|---|---|
| src/ 中含中文注释的文件数 | "约 40 个文件" | **43 个文件**(含 6 个 `.e2e.test.ts`/`.test.ts` 测试文件正文里的注释、2 个 `.mjs` fixture) | 大致相符,略高;#17 的"约 40"是估算,实测 43,在合理误差内 |
| src/ 总中文字符数 | "约 860 字" | **874 个中文字符** | 大致相符(A4b 合并对 `audit-store.ts`/`runner.ts`/`escalation.ts`/`gates.ts` 的改动带来的新中文注释,相比 #17 写作时依据的旧估算净增很少,说明 A4a→A4b 期间大部分新增代码的注释已经是英文,只有零星几处还嵌着中文——见 §1.3) |
| docs/feature/* 总中文字符数 | "约 4.7 万字" | **62,712 个中文字符** | **明显偏高,超出约 33%**。原因:#17 的数字是在 A4b 合并**之前**估算的;A4b 新增了两份完整文档,`docs/feature/a4b-loop/PRD.md` + `test-report.md`(A4b 构建 + 两轮 Zorro 复审的完整记录),体量不小。批次 B 的工作量按实测数字规划,不按 #17 的旧数字。 |
| docs/{ROADMAP,PROGRESS,BACKLOG,README}.md | 没有单独给出字数 | **合计 1,846 个中文字符** | 无比较基线,记录作补充 |
| docs/DESIGN.md | 没有单独给出字数(属于批次 G 新增的范围) | **3,181 个中文字符** | 无比较基线,记录作补充 |
| CLAUDE.md(待删除) | 没有给出字数 | 847 个中文字符,直接 `git rm` 即可,不涉及翻译工作量 | — |
| CHANGELOG.md(待重写) | 没有给出字数 | 807 个中文字符,这是一次**完全重写**,不是翻译——工作量不按字符数衡量 | — |
| `pnpm test` 基线 | 没提具体数字(CHANGELOG 的 A4b 条目写"276 个测试全绿") | **实测:34 个测试文件,300 个测试,全绿**(`pnpm test`/`pnpm lint`/`pnpm build` 目前都是干净的) | CHANGELOG 的"276"是 A4b build 收尾那一刻的数字,和当前 HEAD 不同(不影响这份 PRD——基线记录直接用实测的 300,不用 CHANGELOG 的旧数字) |
| 全仓品牌名(`helix\|verity\|cypher\|zorro`)出现次数 | 没给总数(只描述"去掉别名") | **共 466 次**(不含 node_modules/dist),拆分:docs/feature/* 242、src/ 126(其中 Zorro 118、Verity 7、Helix 1)、docs/DESIGN.md 40、CLAUDE.md 7(随批次 D 整体删除)、其余(CHANGELOG.md/README.md/docs/ROADMAP.md 等)51 | **这是和 #17 原文框定差异最大的一项**,细节见 §1.4——#17 对"去掉品牌名"的描述聚焦在 profile 别名这一层,但实测最大的品牌名来源根本不在 profile 上——而是散落在代码注释/文档里大量的"Zorro 第 N 轮复审引用" |

### 1.3 src/ 里残留中文的性质(不是"翻译漏了",而是嵌入式引用)

`CLAUDE.md` §4(即将删除,但反映了一条既有惯例)已经规定"代码注释用英文;面向指挥官的文档可以用中文"。核实发现 src/ 里那 874 个中文字符**不是大段中文注释**,而是集中在两类:

1. **逐字引用 `docs/DESIGN.md` 的中文原句**——比如 `src/prompt/personas.ts:9` 和 `src/prompt/schema-registry.ts` 都逐字引用了 DESIGN §1.7 的一句中文("persona/schema 按角色名从 registry 动态查找,而不是像 Verity 那样写死一个 {coder,tester} Record"),用来说明"这行代码对应设计文档的哪一句"。
2. **散落在其它英文文档注释里的零星中文短语**(比如 `context/config.ts`/`harness/errors.ts` 等)。

**批次顺序上的影响**:对于第一类(逐字引用 DESIGN.md),如果 src/ 先翻(批次 A)、DESIGN.md 后翻(批次 G),两边的翻译可能不一致,产生一个新问题——"代码注释说的和英文版设计文档对不上"。**建议:批次 G(DESIGN.md 的英文版)应该在批次 A 之前完成,或者至少和批次 A 同一批完成这些互相引用之处的术语对齐**——具体见 §3 批次 A 的任务说明。

### 1.4 品牌名(Helix/Verity/Cypher/Zorro)残留的真实性质(#17 原文框定在这里还需要多一层编辑规则)

#17 原文第 6 项把"去掉品牌名"框定为"profile 已经用通用名了;Helix/Verity 只是品牌别名,所以直接去掉别名就够了"。实测发现:

- **profile 配置文件本身已经很干净**——`profiles/subscription/config.yaml` 和 `profiles/subscription/personas/{coder,tester}.md` 里出现 "Helix"/"Verity" 的次数是**零**(CHANGELOG 的记录显示,profile 在 A3 阶段就已经从 `helix`/`verity` 改名成了 `subscription`/`apikey`)。`profiles/apikey/` 已经被 `.gitignore` 排除,不在公开仓库里。**#17 第 6 项描述的那个具体动作——"profile 别名清理"——实际上已经做完了;profile 文件本身不需要再动。**
- **品牌名残留的真正大头是代码注释里的"复审引用"和设计文档里的"产品对比"**,不是 profile 命名:
  - **`Zorro`(src/ 里 118 次)**:几乎全部是**复审溯源引用**,形如 `// Zorro Round-1 D1 rework (docs/feature/a4b-loop/test-report.md): ...`——在解释"这段代码为什么这么写"时,精确指向是哪一轮复审发现的问题;这是真实的工程可追溯性文档,不是产品营销。集中在 `src/loop/runner.ts`(18)、`src/loop/audit-store.ts`(11)、`src/harness/adapters/{claude,codex}-cli-adapter.ts`(合计 9)等文件里。
  - **`Verity`(src/ 里 7 次 + docs/DESIGN.md 里 40 次)**:指的是一个内部姊妹项目(一个 aeloop 设计所借鉴的"已验证过"的前身实现),例如"Verity 上线的 M2/M3 层各自单测全绿,但从来没有真正接起来跑通过"——这类引用**解释了一个设计决策的来龙去脉**(为什么 aeloop 需要补上 Verity 没覆盖到的某个缺口),同样是真实的文档价值,不是营销词。
  - **`Helix`(src/ 里 1 次)**:一处,`src/loop/audit-store.ts:26`,"Portability(Helix 2026-07-21 dispatch note, ai-agent#127)"。
  - **`Cypher`**:src/ 里 0 命中(只出现在 docs/feature/* 的历史记录和即将删除的 CLAUDE.md 里)。
- **额外发现:跨仓 issue 引用**(`ai-agent#NNN`)——全仓 9 次(src/ 1、docs/DESIGN.md 2、CHANGELOG.md 1、docs/feature/* 5),指向私有仓库 `elishawong/ai-agent` 里的 issue;公开读者点进去会碰到 404。这类引用和品牌名属于同一类"内部工作流泄漏"——#17 验收标准里的 `rg -i 'helix|verity|cypher|zorro'` 扫描本身抓不到 `ai-agent#`,但性质相同,所以建议一并处理(并入批次 F,细节见 §3)。
- `docs/ROADMAP.md`/`docs/DESIGN.md` 里还有 `issue #2`/`issue #13` 这类**同仓 issue 引用**(指向 aeloop 自己的仓库,不是 ai-agent)——开源之后这些链接本身是可解析的(假设那些 issue 也是公开的),**不算泄漏,不需要处理**,原样保留。

**结论**:#17 的验收标准"`rg -i 'helix|verity|cypher|zorro'` 零命中(或者,逐条列出任何刻意保留之处的理由)"——面对 466 次命中、其中 242 次活在被"原样保留"的历史文档(docs/feature/*)里——涉及一个需要指挥官确认的编辑判断。见 §4 的命名替换规则。

---

## 2. 总体验收标准(逐字照抄 #17 原文,一条不漏)

- [ ] `rg -Pl '[\p{Han}]'` 全仓零命中(排除 `node_modules/`、`dist/`、`pnpm-lock.yaml`;白名单 `*.zh-CN.md`)。
- [ ] `rg -i 'helix|verity|cypher|zorro'` 全仓零命中(排除 `node_modules/`、`dist/`),**或者**命中只留在 `docs/feature/**` 下的历史记录文档里——这份 PRD 的 §4 提议把这一类当成**一份书面的整体豁免**处理(不逐条列出全部 242 行),需要指挥官在批次 F 之前对这个理解签字确认(见 §4/§7 待定事项)。
- [ ] `README.md` / `README.zh-CN.md` / `docs/DESIGN.md` / `docs/DESIGN.zh-CN.md` 四份文件都存在且内容对齐(英文为准)。
- [ ] `pnpm test` 全绿——实测基线是**34 个测试文件,300 个测试**;执行过程中每个批次结束时都必须还是这个数字(测试数量本身不该变——翻译/删文件不改变测试内容)。
- [ ] 没有 `CLAUDE.md` / `.claude/` 内部 skill 残留。
- [ ] `git diff` 审阅:除了注释/文档/被删除的治理文件之外,**没有逻辑代码改动**(`pnpm build`/`pnpm lint` 也必须保持干净——两者目前基线都是干净的)。

---

## 3. 批次拆分

> 每个批次都可独立验证、独立提交审查;按依赖关系推荐的执行顺序见 §6——批次编号顺序不代表执行顺序。

### 批次 A —— 把 src/ 里内嵌的中文注释翻成英文(零逻辑改动)

- **范围**:43 个含中文字符的 `src/` 文件(含 `.ts`/`.test.ts`/`.e2e.test.ts`/`.mjs`),按目录进一步拆成 4 个可独立提交的子批次:
  - A1 `context/`(6 个文件:`config.ts`/`errors.ts`/`injector.ts`/`staleness.ts`/`store.ts` + `context-prompt.e2e.test.ts`)
  - A2 `harness/`(13 个文件:`errors.ts`/`provider-router.ts`/`schema-validator.ts`/`tool-exec-verifier.ts`/`types.ts`/`adapters/{claude-cli,codex-cli,litellm}-adapter.ts` + 对应的 `__tests__/*` + 2 个 `.mjs` fixture + `harness-cli.e2e.test.ts`/`harness.e2e.test.ts`)
  - A3 `loop/`(14 个文件:`audit-store.ts`/`errors.ts`/`gates.ts`/`graph.ts`/`nodes/{coder,tester}.ts`/`runner.ts`/`types.ts`/`workflow-def.ts` + 对应的 `__tests__/*` + 2 个 `.mjs` fixture + `loop.e2e.test.ts`)
  - A4 `prompt/` + `profile/`(6 个文件:`composer.ts`/`personas.ts`/`schema-registry.ts`/`schema.ts`/`loader.ts` + 对应测试)
- **怎么改**:逐字定位中文,原地翻成英文,**不改一行逻辑代码,不改任何字符串字面量的运行时语义**(如果一段中文字符串实际上是运行时会被比较/断言的值,而不是注释,动手前必须单独确认——预期不会存在这种情况,但每个文件改完后都要审一遍 diff,确认所有改动都落在注释/JSDoc 里)。
- **特殊处理**:A4 里那两处(`prompt/personas.ts`、`prompt/schema-registry.ts`)逐字引用 `docs/DESIGN.md` §1.7 中文原句的地方,翻译时要用**和批次 G 的 DESIGN.md 英文版对同一句话相同的翻译**,保持代码注释和设计文档的术语一致(依赖关系见 §6)。
- **验收**:
  - `rg -Pl '[\p{Han}]' src/` 零命中。
  - `pnpm test` 依然 34/300 全绿(每个子批次跑一次)。
  - `pnpm lint`(`tsc --noEmit`)干净。
  - 人工过一遍 `git diff`,确认每个 hunk 只碰注释/JSDoc/字符串常量里的说明性文字,不碰可执行逻辑。
- **风险**:如果 JSDoc 里有被 TypeDoc/其它工具解析的特殊语法(这个仓库目前没有迹象,但翻译时留意),确保翻译不会破坏 Markdown 代码围栏分隔符。

### 批次 B —— 把 docs/feature/* 的内部文档整体翻成英文(内容原样保留)

- **范围**:5 个 feature 目录,10 个 `.md` 文件,实测总计 62,712 个中文字符(**比 #17 原文约 4.7 万的估算高约 33%**;工作量按这个数字规划):
  - `a0-a1-engine-scaffold-context-prompt/{PRD.md, progress.md}`
  - `a2-harness-provider-router-litellm-adapter/{PRD.md, test-report.md}`
  - `a3-cli-bridge/{PRD.md, spike-findings.md}`
  - `a4a-loop/{PRD.md, spike-findings.md, test-report.md}`(还有一个 `a4a-loop/spike/` 子目录——核实时要确认里面是否含文本内容;按任务指令,这个子目录本轮不在翻译范围内,只是留意别漏掉)
  - `a4b-loop/{PRD.md, test-report.md}`
- **怎么改**:内容/结构/技术判断**原样保留**,只做语言翻译——包括其中大量的 `Zorro Round-N`/`Helix`/`Verity`/`ai-agent#NNN` 引用——**这一批不对这些引用做品牌名替换**,理由见 §4(这些文件是历史记录,不是面向用户的产品文档)。
- **建议执行方式**:5 个 feature 目录互相独立——可以扇出 5 个 agent 并行翻(#17 的"执行方式"一节已经建议这么做),每个目录一个子批次,独立验收。
- **验收**:
  - `rg -Pl '[\p{Han}]' docs/feature/` 零命中。
  - 抽查:随机挑 2-3 段技术细节段落(比如 A4b test-report.md 里某次 Zorro 复审发现的具体 bug 描述),核实翻译没有丢失/扭曲原意(Zorro 的防幻觉门标准:复审必须能追溯回源文本——"看起来翻得对"不算数)。
  - 不碰代码,`pnpm test` 不需要重跑(但按 §6 的建议,整个批次结束时统一跑一次,确认没有不小心删掉代码引用)。

### 批次 C —— 把 docs/{ROADMAP,PROGRESS,BACKLOG,README}.md 翻成英文

- **范围**:`docs/ROADMAP.md`(607 字)、`docs/PROGRESS.md`(167 字)、`docs/BACKLOG.md`(66 字)、`docs/README.md`(198 字),合计 1,846 个中文字符。
- **怎么改**:翻成英文,**同时**处理这几份文件里出现的品牌名/跨仓引用(见 §4 的替换规则)——这一批不属于"原样保留"的历史记录,是持续维护的活文档,所以品牌名清理适用。
- **验收**:`rg -Pl '[\p{Han}]' docs/ROADMAP.md docs/PROGRESS.md docs/BACKLOG.md docs/README.md` 零命中;这四个文件上 `rg -i 'helix|verity|cypher|zorro'` 零命中。

### 批次 D —— 治理文件剥离

- **范围**:
  - 删除 `CLAUDE.md`(847 个中文字符,直接 `git rm`,不翻译)
  - 删除 `.claude/skills/`(两个文件,`aigit/SKILL.md` 和 `run/SKILL.md`,`git rm -r`)
  - `CHANGELOG.md`:退役现有的 807 字中文版本,**重写**(不是翻译)成一份通用的开源 changelog——Keep a Changelog 风格,剥掉所有 Helix/Cypher/Zorro/`issue #NN`/`ai-agent#NNN` 引用,只保留对外有意义的"做了什么"这一层(粒度比如"A4b:阈值升级 + 审计持久化 + 跨进程 checkpoint 续跑上线,300 个测试通过",不含内部复审轮次细节)
  - 新增 `CONTRIBUTING.md`(替代 `CLAUDE.md` 里对贡献者有用的部分:技术栈表、目录结构、测试/构建命令、PR 期望——**不包括**"军师/Cypher/Zorro"这类内部工作流角色分工描述、`/aigit`/`/spec` 内部 skill 引用、或 `ai-agent` 跨仓引用)
- **验收**:
  - `test -f CLAUDE.md` 应该失败(文件不存在)。
  - `find .claude -type f` 应该为空 / `.claude` 目录不存在。
  - `CONTRIBUTING.md` 存在且不含品牌名/内部工作流描述。
  - `CHANGELOG.md` 重写之后,`rg -i 'helix|verity|cypher|zorro|ai-agent#|issue #'`(公开仓库里的内部 issue 号引用同样清理掉)零命中。

### 批次 E —— 把 .gitignore 的注释翻成英文

- **范围**:`.gitignore`(359 字节,5 个中文注释块:`# runtime state...`、`# pipeline runtime state...`、`# company overlay never enters this repo...`、`# environment`、`# misc`)。
- **怎么改**:把注释翻成英文,**规则本身保持不变**(`profiles/apikey/`、`.helix/`、`*.db` 等排除规则原样保留,只翻译说明性注释)。
- **验收**:`rg -Pl '[\p{Han}]' .gitignore` 零命中;用 `git status` 确认排除规则的生效范围没有变(用 `git check-ignore` 抽查几个已知路径,比如 `profiles/apikey/foo`、`.helix/bar` 应该依然被忽略)。

### 批次 F —— 去掉品牌名(全仓扫描 + 替换,覆盖前面所有批次的产物)

- **范围**:批次 A/C/D/E/G 产出的全部文件 + `docs/DESIGN.md`(40 次)+ 批次 A-E 漏掉的任何角落,**明确排除 `docs/feature/**`**(批次 B 的历史记录,理由见 §4)。
- **怎么改**:按 §4 的替换规则表逐类处理——这不是简单的"Helix"→"某某"字符串替换——每一类引用需要不同的处理方式(复审溯源引用 vs. 产品对比引用 vs. profile 描述 vs. 跨仓 issue 链接)。
- **验收**:
  - `rg -i 'helix|verity|cypher|zorro' --glob '!docs/feature'`(排除 node_modules/dist)零命中。
  - `rg 'ai-agent#'` 零命中(全仓,包括 docs/feature——这一项是例外:即便在历史文档里,也建议清理掉跨仓死链接或改写成纯文本描述,不留可点击但 404 的引用;如果指挥官决定 docs/feature 应该完全不动,这一项就收窄成"只在 docs/feature 之外零命中"——两种理解见 §7 待定事项)。
  - 最后统一跑一次 `pnpm test`,确认 34/300 全绿(如果品牌名替换不小心命中了某个字符串字面量,测试会先炸)。

### 批次 G —— 维护 README + DESIGN 的中英双版本

- **范围**:
  - `README.md`(英文,目前已经是英文,但内容**过期**——写的是"Status: Pre-spec... project scaffold only",而实际上 A0-A4b 全部完成、300 个测试全绿。批次 G 需要一次**实质性的内容更新**,不能只是"反正已经是英文了不用动")+ 新增 `README.zh-CN.md`(中文版,内容对齐)
  - `docs/DESIGN.md`(3,181 个中文字符,翻成英文 + 品牌名清理,英文为准)+ 新增 `docs/DESIGN.zh-CN.md`(中文版,内容对齐,同样过一遍品牌名清理规则)
- **怎么改**:
  - README.md 先做一次内容修正(反映真实的当前状态,去掉指向 `CLAUDE.md` 的死链接,改指向 `CONTRIBUTING.md`),然后再产出 zh-CN 镜像版。
  - 翻译 DESIGN.md 成英文时同时应用 §4 的替换规则(这是当前持续维护的设计权威文档,不是历史记录——品牌名清理适用);英文版定稿后再产出 zh-CN 镜像版,两个版本内容对齐(不允许各自独立起草导致漂移)。
- **验收**:
  - 四个文件都存在:`test -f README.md README.zh-CN.md docs/DESIGN.md docs/DESIGN.zh-CN.md`。
  - `rg -Pl '[\p{Han}]' README.md docs/DESIGN.md` 零命中(英文版必须干净;`*.zh-CN.md` 在白名单里,允许中文)。
  - 这四个文件上 `rg -i 'helix|verity|cypher|zorro'` 零命中。
  - 人工抽查:逐段对比中英文版本同一节的内容,确认没有遗漏/没有各自独立漂移的内容(标题数、代码块数这类机械检查能帮上忙,比如 `grep -c '^#' README.md README.zh-CN.md` 应该相等)。
  - README.md 不再链接到已删除的 `CLAUDE.md`。

---

## 4. 品牌名替换规则表(批次 F 的执行依据)

| 引用类型 | 出现位置 | 处理规则 | 示例 |
|---|---|---|---|
| **`Zorro Round-N ...` 复审溯源引用** | src/ 代码注释(118 次)、docs/DESIGN.md(部分) | 去掉人格代号,保留轮次编号 + 原始文档引用路径,改成中性措辞 `Review Round-N` | `Zorro Round-1 D1 rework (docs/feature/a4b-loop/test-report.md)` → `Review Round-1 D1 rework (docs/feature/a4b-loop/test-report.md)` |
| **`Verity` 姊妹项目对比引用** | src/(7 次)、docs/DESIGN.md(40 次,含 Helix) | 换成中性描述性短语,不点名具体的内部项目;同一文件内措辞保持一致 | `Verity's M2/M3 shipped layers that...` → `a prior internal implementation's M2/M3 layers that...`;`avoid a hardcoded Record like Verity did` → `avoid a hardcoded Record like an earlier internal implementation did` |
| **`Helix` dispatch-note 引用** | src/loop/audit-store.ts:26(1 次) | 去掉人格代号和跨仓引用,只保留技术理由本身 | `(Helix 2026-07-21 dispatch note, ai-agent#127)` → 按上下文改写成一条纯技术脚注,不留内部组织引用 |
| **`ai-agent#NNN` 跨仓死链接** | 9 次(src/ 1、DESIGN.md 2、CHANGELOG.md 1、docs/feature/* 5) | 在批次 A/C/D/G 的范围内(即 docs/feature/* 之外)整体去掉或改写成不可点击的纯文本说明;docs/feature/* 范围留给 §7 的待定事项决定 | — |
| **profile 品牌别名描述** | README.md、docs/DESIGN.md("Helix(running the subscription profile)"这类措辞) | 去掉人格代号,只保留 profile 名 + 中性描述;直接采用 #17 原文措辞 | `Helix (running the subscription profile)` → `personal subscription profile`;`Verity (running the apikey profile)` → `company API / LiteLLM profile` |
| **`docs/feature/**` 内部的全部品牌名(242 次)** | 批次 B 的范围 | **不替换——原样保留并翻译**——这是构建/复审活动的真实历史记录,内容包括"谁在哪一轮复审里发现了什么问题";用化名替换或删除会扭曲历史记录、丢失可追溯性(当读者想深挖某个技术决策的来龙去脉时,这些文档是唯一的一手记录)。对应 #17 验收标准里的"或者,逐条列出任何刻意保留之处的理由"——**这份 PRD 提议用"对 `docs/feature/**` 整体豁免 + 这一行表格作为书面理由"来满足这条**,而不是逐条列出全部 242 行。这是一个需要指挥官在批次 F 执行前签字确认的编辑判断(§7)。 |
| **同仓 issue 引用(`issue #2`/`issue #13`)** | docs/ROADMAP.md、docs/DESIGN.md | 原样保留——指向 aeloop 自己的仓库,开源后正常可解析,不算内部工作流泄漏 | — |

---

## 5. 范围外发现(不在 #17 范围内,供指挥官参考——这份 PRD 不擅自把这些并入强制批次)

- **`package.json` 的 `"private": true` + `"license": "UNLICENSED"`**:和"开源化"这个目标字面上矛盾(一个私有、无 license 的包没法被外部安装/引用)。#17 原文没提这一项;这份 PRD 不擅自扩大范围把它加成强制批次,但如实记录:如果指挥官想在这一轮一并处理,需要额外决定一个开源 license 类型(MIT/Apache-2.0 等)并加一个顶层 `LICENSE` 文件——这是指挥官/军师要做的产品判断,不是翻译任务能代为决定的。
- **目前不存在顶层 `LICENSE` 文件**——同上,是它的一个下游后果。

---

## 6. 建议执行顺序(依赖关系——不代表构建阶段必须严格顺序执行,但标出谁依赖谁)

1. **批次 D(治理文件剥离)+ 批次 E(.gitignore)**——互相独立,改动面小,可以先做;这也直接把 CLAUDE.md 的 7 处品牌名从"待处理清单"里拿掉(删除即解决,不需要翻译)。
2. **批次 G 的 DESIGN.md 英文定稿**——建议在批次 A 之前完成(至少完成 `personas.ts`/`schema-registry.ts` 逐字引用的那句 §1.7),避免批次 A 和批次 G 各自独立翻出两个不一致的英文版本(见 §1.3)。
3. **批次 A(src/)**——4 个子批次(A1-A4)可以并行跑,A4 依赖上一步 DESIGN.md §1.7 的翻译。
4. **批次 C(docs/ROADMAP 等)+ 批次 G 剩余部分(README 内容刷新 + 双语镜像)**——可以和批次 A 并行,不冲突(不同文件)。
5. **批次 B(docs/feature/*)**——完全独立,可以随时并行跑,5 个子目录互相独立,建议扇出。
6. **批次 F(全仓品牌名去除扫描)**——放在最后,在 A/C/D/E/G 全部完成、内容已经是英文之后,做一次全仓 `rg` 扫描 + 最终替换——这比散落在翻译过程各处处理更不容易漏掉。**批次 F 执行前,需要指挥官对 §4 表格最后一行(docs/feature/* 的整体豁免)签字确认**,否则批次 F 的验收标准是模糊的(零命中 vs. 排除 docs/feature 后零命中——两种理解给出不同的验收结果)。
7. 每一步结束时统一跑一次 `pnpm test && pnpm lint && pnpm build`,保持 34/300 全绿 + 两个命令都干净。

---

## 7. 待指挥官确认事项(不阻塞审这份 PRD 本身,但阻塞批次 F / 批次 B 部分收尾)

1. **docs/feature/* 内 242 处品牌名的豁免怎么处理**(§4 最后一行):采用这份 PRD 提议的"整体豁免 + 一份书面理由",还是要求逐条替换成中性措辞(这会改变批次 B 的工作量和性质,从"纯翻译"变成"翻译 + 改写历史记录",有扭曲的风险)?
2. **docs/feature/* 内的 `ai-agent#NNN` 跨仓引用怎么处理**(9 次里有 5 次在这个目录):跟着 docs/feature 的整体豁免一起保留,还是即便在历史记录里也要去掉这些可点击但 404 的跨仓链接?
3. **§5 提到的 `package.json` license/private 字段**:这一轮一并决定,还是明确排除在这个 issue 范围外,留给指挥官以后单独决定?

建议指挥官读完这份 PRD 之后,一次性对这三项给出裁决——不需要为此单开会;如果指挥官倾向"就按 PRD 提议的默认方案走",直接说"批准"就够了,PRD §4/§6 的默认方案就算确认。

---

## 8. 流程缺口披露:这一轮跳过了 Zorro 独立复审(指挥官明确豁免)

指挥官在 2026-07-21 批准 §1/§4/§7 的三个默认方案之后,军师提出这一轮的 14+1 个批次(D/E/C/B1-B5/G-DESIGN/A1-A5/G-remainder/F)**全部由 Cypher 角色的 agent 执行,没有走 Zorro 独立复审**——按头号门禁"Cypher 做完 → Zorro PASS → 指挥官批 → 才能 commit",这本该是硬性前置步骤。军师给出两个选项(① 先走 Zorro 的 `/verify`,② 指挥官明确豁免,参照 A4b R6 的先例),**指挥官选了②,明确豁免这一轮的 Zorro 独立复审**。

**如实记录,不隐瞒**:
- 这一轮的改动本质上是机械翻译 + 品牌名清理 + 治理文件删除/重写,不是新功能代码;但语义漂移的真实风险依然存在(至少真实抓到过一次:批次 B2 曾经把角色头衔"军师"("the strategist"的中文源词)误翻成了专有名词"Helix",事后自我纠正;批次 F 专门做了第二遍扫描检查这类残留)。
- 整个验收流程(CJK 扫描 / 品牌名扫描 / `pnpm test`/`lint`/`build`)是 Cypher 自己执行 + Cypher 自己复核的——**这不构成"生产者≠审查者"规则(铁律 4)意义上的独立复审**。
- 如果以后在什么地方发现翻译失真 / 品牌名清理误伤 / CHANGELOG 重写事实性不准,这一节是排查嫌疑的第一站。
- commit/push 依然需要指挥官**当时**每次重新确认(这次 Zorro 豁免不顺带授予默认的 commit 授权——两者是两道独立的门)。
</content>
