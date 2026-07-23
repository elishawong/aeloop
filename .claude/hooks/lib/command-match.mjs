// command-match.mjs — 命令位置解析共享库（issue #88 B1，plan.md §B1）。
//
// 移植 ai-agent 仓库 `_engine/commit-gate-match.mjs` 的**方法论**（token 化 + 命令位置解析，
// 而非正则堆叠 / "任意位置找 git"）—— DESIGN.md §1 已核实这块 Helix 自己也没有 aeloop 直接能用的
// 判据蓝本，只能抄方法论，不是抄代码。`tokenizeSegments`/`resolveCommandInvocations` 两个核心函数
// 的结构逐条对齐源文件（跳过 env 赋值/shell 控制前缀 → 取命令词 → `sh -c` 递归 → 透明包装器递归 →
// overdepth 一律保守判"命中"，fail-closed），裁剪范围见下方"精简范围"。
//
// ⚠️ plan.md §B1 原始措辞是"导出 resolveCommandInvocations(cmdString)"——与源文件实际签名不符
//   （核实中发现，如实标注）：`_engine/commit-gate-match.mjs:229` 的 `resolveCommandInvocations`
//   接收的是**单个命令段的 token 数组**（`tokens: string[]`），不是原始命令字符串；源文件里"喂一条
//   完整命令字符串进去"的组合是 `tokenizeSegments(cmd).flatMap((seg) => resolveCommandInvocations(seg))`
//   （见源文件 `commandMatchesGatedPattern`）。本文件忠实移植了源文件的真实签名（`resolveCommandInvocations`
//   吃 token 数组），另外新增一个 plan.md 没有列出、但 hook 调用方（拿到的是原始 command 字符串）
//   实际需要的整合入口 `resolveInvocationsFromCommand(cmd: string)`——这是对 plan.md 记录不精确处
//   的必要修正，不是擅自扩大范围（下游 `matchesGitSubcommand`/`matchesForcePush`/`matchesRmDashRf`
//   三个 plan.md 列出的导出函数，都基于这个整合入口实现，接收原始命令字符串，这样 hook 才能直接调用）。
//
// 精简范围（相对源文件的裁剪，DESIGN §3.b 已预先声明的方向，这里落实）：
//   - 【issue #88 Pass 2 补齐，2026-07-23】B1 当初交底的缺口——`matchesGhPrMerge`/
//     `matchesGitMergeMain` 未移植——已在本轮补上（`GH_FLAGS_WITH_SEPARATE_VALUE`/
//     `firstSubcommandWithIndex`/`mainWordPattern` 一并移植，逐条对齐源文件对应部分）。
//     补在**本文件**而不是内联进 `brain-commit-gate.mjs`（B3）——理由：这两个判据本质上和已有
//     的 `matchesForcePush`/`matchesRmDashRf` 是同一类"基于命令位置的业务判据"，属于命令解析层
//     的职责，不是 hook 的业务逻辑；hook（B3）不该重新实现一遍 token 化/命令位置解析，只该组合
//     调用这些判据函数——这样未来 B5（`brain-red-line-guard.mjs`）如果也需要类似判据，同样从这
//     里取，不会出现"同一段命令解析逻辑在两个 hook 文件里各写一份"的重复。
//   - 不移植 Helix 那些已知过拦历史修复的**全部**回归用例（`git "commit"`/`--no-optional-locks`
//     等）——本文件保留能通过这些用例的**结构**（token 化 + 命令位置解析本身就不会误判这些），
//     但不逐条抄录 Helix 的测试注释历史，B1 自己的测试矩阵见 `test-command-match.mjs`。
//
// 仍是软门（已知局限，同源文件的诚实标注惯例，不重复整段论证）：不处理变量拼接/`eval`/反引号/
// `$()` 子 shell；不是完整 shell 语法分析器；`.gitconfig` alias 展开后的真实命令看不见；包装器
// flag 解析是 best-effort。

import { basename } from "node:path";

// git 全局 flag（吃下一个独立 token 当值）。移植自源文件 `GIT_FLAGS_WITH_SEPARATE_VALUE`。
const GIT_FLAGS_WITH_SEPARATE_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

// gh 的 --repo/-R 同理：`gh pr --repo owner/repo merge 5` 里 --repo 后面独立一个 token 是它的值，
// 需要额外跳过，才能让"pr 的下一个实词"正确落在 "merge" 上而不是 "owner/repo"。移植自源文件
// `GH_FLAGS_WITH_SEPARATE_VALUE`（issue #88 Pass 2 补齐）。
const GH_FLAGS_WITH_SEPARATE_VALUE = new Set(["--repo", "-R"]);

// 命令词若是这些 shell，其 `-c "<字符串>"` 里才是真正执行的命令（递归解析）。
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);

// "透明包装器"：命令词是它们时，真正被执行的命令是跳过包装器自己的 flag 之后的下一个命令。
const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "nice", "nohup", "time", "stdbuf", "setsid", "ionice", "command", "exec", "builtin",
]);

// 包装器里"吃一个独立后续 token 当值"的常见 flag（best-effort）。
const WRAPPER_FLAGS_WITH_SEPARATE_VALUE = new Set([
  "-u", "-g", "-U", "-p", "-r", "-t", "-h", "-C", "--chdir", "-S", "--block-signal", "--default-signal", "--ignore-signal", "-n",
]);

// shell 控制结构关键字/前缀：命令段以它们打头时，真正被执行的命令在其后面。
const SHELL_CONTROL_PREFIXES = new Set(["!", "if", "then", "else", "elif", "while", "until", "do", "done", "fi", "{", "}", "(", ")"]);

// 命令位置递归深度上限（病态嵌套/包装器套娃）。
const MAX_COMMAND_DEPTH = 8;

// 到递归上限 = 解析不到底 = 无法判定 = 保守判"命中"（fail-closed），不是 `[]`（fail-open）。
const OVERDEPTH = Symbol("brain-red-line:overdepth");
const OVERDEPTH_INVOCATION = { cmd: OVERDEPTH, args: [] };

/**
 * 把命令字符串切成"段"（按未加引号的 `&`/`|`/`;`/换行切分），每段再切成 token 数组。
 * 逐条对齐源文件 `tokenizeSegments`（引号透明、`#` 词首行内注释、换行与 `;` 同级切段）。
 * @param {string} cmd
 * @returns {string[][]}
 */
export function tokenizeSegments(cmd) {
  const segments = [];
  let currentTokens = [];
  let currentToken = "";
  let quote = null;
  let hasToken = false;
  let inComment = false;

  function flushToken() {
    if (hasToken) {
      currentTokens.push(currentToken);
      currentToken = "";
      hasToken = false;
    }
  }
  function flushSegment() {
    flushToken();
    segments.push(currentTokens);
    currentTokens = [];
  }

  const s = String(cmd ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inComment) {
      if (ch === "\n" || ch === "\r") {
        inComment = false;
        flushSegment();
      }
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        currentToken += ch;
        hasToken = true;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "#" && !hasToken) {
      inComment = true;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === "&" || ch === "|" || ch === ";") {
      flushSegment();
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    currentToken += ch;
    hasToken = true;
  }
  flushSegment();
  return segments.filter((seg) => seg.length > 0);
}

function isEnvAssignment(token) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function normalizeCommandWord(token) {
  const noBackslash = token.replace(/\\/g, "");
  return basename(noBackslash).toLowerCase();
}

function shellCommandString(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "-c" || /^-[a-z]*c[a-z]*$/i.test(t)) {
      return i + 1 < args.length ? args[i + 1] : null;
    }
  }
  return null;
}

/**
 * 解析一个命令段（token 数组）真正执行的命令，返回 `{cmd, args}[]`。
 * ⚠️ 接收单段 token 数组，不是原始命令字符串——逐字对齐源文件签名（见文件头说明）。
 * @param {string[]} tokens 单个命令段（已按 &/|/;/换行切好）
 * @param {number} [depth]
 * @returns {{cmd:string, args:string[]}[]}
 */
export function resolveCommandInvocations(tokens, depth = 0) {
  if (depth > MAX_COMMAND_DEPTH) return [OVERDEPTH_INVOCATION];
  let i = 0;
  while (i < tokens.length && (isEnvAssignment(tokens[i]) || SHELL_CONTROL_PREFIXES.has(tokens[i]))) i++;
  if (i >= tokens.length) return [];

  const cmd = normalizeCommandWord(tokens[i]);
  const rest = tokens.slice(i + 1);

  if (SHELLS.has(cmd)) {
    const inner = shellCommandString(rest);
    if (inner === null) return [];
    return tokenizeSegments(inner).flatMap((seg) => resolveCommandInvocations(seg, depth + 1));
  }

  if (COMMAND_WRAPPERS.has(cmd)) {
    if (cmd === "command") {
      for (const t of rest) {
        if (!t.startsWith("-")) break;
        if (/^-[vV]+$/.test(t)) return [];
      }
    }
    let j = 0;
    while (j < rest.length && (rest[j].startsWith("-") || isEnvAssignment(rest[j]))) {
      if (WRAPPER_FLAGS_WITH_SEPARATE_VALUE.has(rest[j]) && !rest[j].includes("=")) j += 2;
      else j += 1;
    }
    if (j >= rest.length) return [];
    return resolveCommandInvocations(rest.slice(j), depth + 1);
  }

  return [{ cmd, args: rest }];
}

/**
 * 整合入口（本文件新增，不在源文件里，见文件头"⚠️ plan.md 措辞与源文件不符"说明）：
 * 接收一条**原始命令字符串**，切段 + 逐段解析命令位置，返回全部 invocation。
 * @param {string} cmd
 * @returns {{cmd:string, args:string[]}[]}
 */
export function resolveInvocationsFromCommand(cmd) {
  if (typeof cmd !== "string" || !cmd) return [];
  return tokenizeSegments(cmd).flatMap((seg) => resolveCommandInvocations(seg));
}

/**
 * 从 `args` 里跳过 flag 类 token，返回第一个"实词"token 的小写形式；没有实词 → null。
 * @param {string[]} args
 * @param {Set<string>} flagsWithValue
 * @returns {string|null}
 */
export function firstSubcommand(args, flagsWithValue) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (!t.startsWith("-")) return t.toLowerCase();
    const bareFlag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (flagsWithValue.has(bareFlag) && !t.includes("=")) i += 2;
    else i += 1;
  }
  return null;
}

/**
 * 同 `firstSubcommand`，但额外返回该实词在 `args` 里的下标（供 `matchesGhPrMerge` 需要"pr 之后
 * 继续找 merge"这种链式子命令定位）。移植自源文件 `firstSubcommandWithIndex`（issue #88 Pass 2）。
 * @param {string[]} args
 * @param {Set<string>} flagsWithValue
 * @returns {{sub:string|null, idx:number}}
 */
export function firstSubcommandWithIndex(args, flagsWithValue) {
  let i = 0;
  while (i < args.length) {
    const t = args[i];
    if (!t.startsWith("-")) return { sub: t.toLowerCase(), idx: i };
    const bareFlag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (flagsWithValue.has(bareFlag) && !t.includes("=")) i += 2;
    else i += 1;
  }
  return { sub: null, idx: -1 };
}

// `main` 在单个 token 内的"整词"匹配（不是要求整个 token 精确等于 "main"）——沿用源文件
// `mainWordPattern` 语义：真实合并目标常写成 `origin/main`/`refs/heads/main`，"main"是被 `/`
// 分隔的最后一段而非独立 token，单词边界在 `/`（非单词字符）处天然成立。
const mainWordPattern = /\bmain\b/i;

/**
 * 一条命令字符串里，是否有任一 invocation 是 `git <subcommand>`（如 "commit"/"push"）。
 * plan.md §B1 列出的导出之一——原始设计签名是 `(inv, subcommand)`（单个已解析 invocation），
 * 但 hook 调用方拿到的是原始命令字符串，一条字符串可能含多个 `;`/`&&` 分隔的 invocation，
 * 单 invocation 签名不便直接用——改成接收原始命令字符串，内部遍历全部 invocation（同源文件
 * `commandMatchesGatedPattern` 的 `.some(...)` 惯例，不是新发明的模式）。
 * @param {string} cmd
 * @param {string} subcommand 小写，如 "commit"
 * @returns {boolean}
 */
export function matchesGitSubcommand(cmd, subcommand) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true; // 解析不到底，保守判命中
    return inv.cmd === "git" && firstSubcommand(inv.args, GIT_FLAGS_WITH_SEPARATE_VALUE) === subcommand;
  });
}

/**
 * 一条命令字符串里，是否有 `git push` 且含 `--force`/`-f`、不含 `--force-with-lease`
 * （含即视为安全变体，不判定为强推——PRD §4.2 已标注这是明确接受的简化，不精确复刻 git 本身
 * "最后一个 flag 生效"的语义）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function matchesForcePush(cmd) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true;
    if (inv.cmd !== "git") return false;
    if (firstSubcommand(inv.args, GIT_FLAGS_WITH_SEPARATE_VALUE) !== "push") return false;
    const hasForceWithLease = inv.args.some((a) => a === "--force-with-lease" || a.startsWith("--force-with-lease="));
    if (hasForceWithLease) return false;
    return inv.args.some((a) => a === "--force" || a === "-f");
  });
}

/**
 * 一条命令字符串里，是否有 `rm` 且参数组合等价于 `-r`+`-f`（单 token `-rf`/`-fr`，或分开的
 * `-r`/`-f`，含长选项 `--recursive`/`--force` 任意组合）。**只判定"是不是 rm -rf 形态"，
 * 不判定目标路径是否在白名单内**——白名单判定是 `brain-red-line-guard.mjs`（B5）的职责，
 * 不属于本共享库（本文件是纯命令解析库，不该知道"哪些路径算安全"这种业务判断）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function matchesRmDashRf(cmd) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true;
    if (inv.cmd !== "rm") return false;
    let hasR = false;
    let hasF = false;
    for (const a of inv.args) {
      if (!a.startsWith("-") || a === "-" || a === "--") continue;
      if (a === "--recursive") hasR = true;
      else if (a === "--force") hasF = true;
      else if (a.startsWith("--")) continue; // 其它长选项，不参与 -r/-f 判定
      else {
        // 短选项束，如 -rf/-fr/-r/-f/-rvf 等：逐字符判定是否含 r/f。
        if (a.includes("r")) hasR = true;
        if (a.includes("f")) hasF = true;
      }
    }
    return hasR && hasF;
  });
}

/**
 * 一条命令字符串里，是否有任一 invocation 是 `gh pr merge`（命令位置是 gh，子命令 pr，pr 的
 * 子命令 merge；允许各自的 flag 插在中间，如 `gh pr --repo owner/repo merge 5`）。但不会因为
 * 命令里某处恰好出现字面量 "merge" 就误判（`gh pr create --title please merge later`：pr 之后
 * 第一个实词是 create，到此为止）。移植自源文件 `isGhPrMergeInv`（issue #88 Pass 2，补齐 Pass 1
 * 交底的缺口，供 B3 `brain-commit-gate.mjs` 覆盖 PRD §4.2 声明的完整模式集）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function matchesGhPrMerge(cmd) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true;
    if (inv.cmd !== "gh") return false;
    const { sub: ghSub, idx: prIdx } = firstSubcommandWithIndex(inv.args, GH_FLAGS_WITH_SEPARATE_VALUE);
    if (ghSub !== "pr") return false;
    return firstSubcommand(inv.args.slice(prIdx + 1), GH_FLAGS_WITH_SEPARATE_VALUE) === "merge";
  });
}

/**
 * 一条命令字符串里，是否有任一 invocation 是 `git merge ... main`（命令位置是 git，**第一个
 * 子命令**是 merge，且 merge 之后某个 token 里出现整词 main）。要求 merge 是真正的子命令（而
 * 不是"merge 字样出现在别处"），修掉 `git log --grep merge -- main`（只读 log，merge 只是搜索
 * 词）被误判的情形。移植自源文件 `isGitMergeMainInv`（issue #88 Pass 2）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function matchesGitMergeMain(cmd) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true;
    if (inv.cmd !== "git") return false;
    const { sub, idx } = firstSubcommandWithIndex(inv.args, GIT_FLAGS_WITH_SEPARATE_VALUE);
    if (sub !== "merge") return false;
    return inv.args.slice(idx + 1).some((t) => mainWordPattern.test(t));
  });
}

// `.env`/`.env.*` basename 保护（issue #88 B5，`brain-red-line-guard.mjs` 用）。示例/模板文件
// 明确排除——这些是约定俗成的"给别人抄"的文件，不含真实密钥，红线不该拦它们。
const ENV_BASENAME_PATTERN = /^\.env(\..+)?$/;
const ENV_ALLOWED_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * 一个文件路径的 basename 是不是"受保护的 .env 文件"（`.env`/`.env.*`，示例/模板文件除外）。
 * 纯路径字符串判断，不碰文件系统——供 `matchesEnvWrite`（Bash 重定向场景）和
 * `brain-red-line-guard.mjs` 的 Edit/Write 分支（直接对 `tool_input.file_path` 判断）共用，
 * 两条路径用同一份判据，不会出现"Bash 挡了、Edit/Write 没挡"这种不一致。
 * @param {string} target 文件路径（可能带目录前缀，只看 basename）
 * @returns {boolean}
 */
export function isProtectedEnvBasename(target) {
  if (typeof target !== "string" || !target) return false;
  const base = basename(target);
  if (!ENV_BASENAME_PATTERN.test(base)) return false;
  return !ENV_ALLOWED_EXAMPLES.has(base);
}

/**
 * 从一个 invocation 的 `args` 里提取所有"重定向目标"（`>`/`>>` 后面的文件名）。处理两种写法：
 * ① 操作符和目标各自独立成 token（`cmd > file`/`cmd >> file`，中间有空白）；② 操作符和目标
 * 粘连成一个 token 但操作符在**词首**（`cmd >file`，`>` 前有空白、后没有）。**已知局限**（如实
 * 标注，不是本函数试图掩盖的东西）：操作符和**前一个词**没有空白粘连的写法（`cmd>file`，`>`
 * 两侧都没有空白）不会被识别成重定向——本文件的 `tokenizeSegments` 不是完整 shell 词法分析器，
 * 只把 `&`/`|`/`;`/换行当"即便没有空白也要切"的操作符，`>`/`>>` 没有被赋予同等地位（改这条会
 * 触及 `tokenizeSegments` 本身——B1 已经过 Zorro 复审的核心解析器，本批（B5）不动它，见头注释
 * "已知局限"整体说明）。
 * @param {string[]} args
 * @returns {string[]}
 */
function extractRedirectionTargets(args) {
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === ">" || t === ">>") {
      if (i + 1 < args.length) targets.push(args[i + 1]);
      continue;
    }
    const glued = /^>>?(.+)$/.exec(t);
    if (glued) targets.push(glued[1]);
  }
  return targets;
}

/**
 * 一条命令字符串里，是否有任一 invocation 通过 Bash 重定向（`>`/`>>`）或 `tee` 写入一个
 * "受保护的 .env 文件"（`isProtectedEnvBasename`）。这是**写入判定**，不是"提到这个文件名就拦"
 * ——`cat .env`（纯读取，`.env` 只是一个普通位置参数）不会命中，只有 `.env` 出现在重定向目标
 * 位置、或作为 `tee` 的目标参数时才命中。已知局限见 `extractRedirectionTargets` 头注释 +
 * `brain-red-line-guard.mjs` 头注释整体的"已知局限"段（如"间接写"：模型可以写一个不叫这个
 * 名字的脚本文件去写 `.env`，本函数看不到）。
 * @param {string} cmd
 * @returns {boolean}
 */
export function matchesEnvWrite(cmd) {
  const invocations = resolveInvocationsFromCommand(cmd);
  return invocations.some((inv) => {
    if (inv.cmd === OVERDEPTH) return true;
    for (const target of extractRedirectionTargets(inv.args)) {
      if (isProtectedEnvBasename(target)) return true;
    }
    if (inv.cmd === "tee") {
      for (const a of inv.args) {
        if (a.startsWith("-")) continue; // 跳过 tee 自己的 flag（如 -a 追加模式）
        if (isProtectedEnvBasename(a)) return true;
      }
    }
    return false;
  });
}

// 测试可见（对齐 file-lock._params / verify-knowledge._internal 惯例）。
export const _internal = {
  GIT_FLAGS_WITH_SEPARATE_VALUE,
  GH_FLAGS_WITH_SEPARATE_VALUE,
  SHELLS,
  COMMAND_WRAPPERS,
  WRAPPER_FLAGS_WITH_SEPARATE_VALUE,
  SHELL_CONTROL_PREFIXES,
  OVERDEPTH,
};
