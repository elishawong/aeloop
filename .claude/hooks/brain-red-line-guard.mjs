#!/usr/bin/env node
/**
 * brain-red-line-guard.mjs — PreToolUse(Bash + Edit|Write) deny hook：`rm -rf`/`.env`/
 * force-push 硬拦（issue #88 B5，从零设计——DESIGN.md §1 已核实 Helix 自己也没有这类 hook 的
 * 先例，判据全部是本文件新设计，没有"照抄已验证代码"这条安全网可用，Zorro 应重点核对判据本身
 * 的正确性/边界，而不是"移植得像不像"）。
 *
 * 两个 matcher 条目指向同一个文件，靠 `input.tool_name` 分支：
 *   - `PreToolUse`/`Bash`：`rm -rf` 白名单外目标 / force-push（不含 `--force-with-lease`）/
 *     `.env` 重定向或 `tee` 写入 → deny。
 *   - `PreToolUse`/`Edit|Write`：`tool_input.file_path` 命中受保护的 `.env` basename → deny。
 *
 * ── rm -rf 白名单判定：符号链接/`..`/相对路径逃逸怎么防（Zorro 明确要求想清楚并写下取舍）──
 *
 * 只做 `path.resolve(cwd, arg)`（字符串层面的词法解析）**不够**：`path.resolve` 会正确处理
 * 参数字符串里字面出现的 `..`（比如 `/tmp/../etc` 会被词法归一化成 `/etc`，这一步 `path.resolve`
 * 本身就做到了，不需要额外代码），但它**不会跟踪符号链接**——纯字符串前缀匹配挡不住这个。
 *
 * ⚠️ finding-5（Zorro/Codex 2026-07-23 复审，举例订正，机制本身没错）：这里之前举的例子说反了
 * `rm` 的实际语义，订正如下——**真正的风险不在"rm -rf 的参数本身就是一个符号链接"这种情况**：
 * `rm` 对一个作为**最后一段（叶子）**的符号链接参数，标准语义是删除链接本身，不会跟随它去删
 * 链接指向的目标（比如 `rm -rf /tmp/evil-link`，`evil-link -> /etc`，`rm` 删掉的是这个链接
 * 文件本身，`/etc` 毫发无损——这是 GNU/BSD `rm` 的共同行为，不是本文件的假设）。**真正危险的
 * 是符号链接出现在路径的中间段**：比如 `rm -rf /tmp/evil-dir/child`，如果 `evil-dir` 是一个
 * 指向 `/etc` 的符号链接，`rm` 为了定位 `child` 必须**穿过** `evil-dir` 这一层，实际操作发生
 * 在 `evil-dir` 真正指向的目录（`/etc`）里面，删的是 `/etc/child`，而不是字面上看起来的
 * "`/tmp` 目录下的某个东西"。`fs.realpathSync()` 解析的是**整条路径链上所有层级**的符号链接
 * （不只是最后一段），所以本文件的机制对这两种情况处理是一致的——但了解"真正的攻击面在中间
 * 段而不是叶子段"有助于理解为什么"解析整条路径链"而不是"只检查最后一段是不是链接"才是正确
 * 设计，这是订正举例后想强调的点。
 *
 * 本文件的做法：`resolveRealOrLexical()` 先 `path.resolve(cwd, arg)` 做词法归一化，再尝试
 * `fs.realpathSync()` 把路径链上的**所有**符号链接（包括中间目录）都解析成真实物理路径；用这个
 * **真实路径**去和白名单前缀比对，而不是词法路径。**目标路径本身可能还不存在**（`rm -rf` 对一个
 * 不存在的路径是合法的空操作，常见于幂等清理脚本）——`realpathSync` 对不存在的路径会抛
 * `ENOENT`，这种情况下本文件**逐级往上找最近一个真实存在的祖先目录**，对那个祖先目录做
 * `realpathSync`（解析掉它链上的符号链接），再把原本"不存在的那一段"路径原样拼回去。如果连
 * 文件系统根目录都找不到任何存在的祖先（极端情况，实际不会发生），退化用纯词法路径兜底
 * （这个退化场景本身即无害——对一棵完全不存在的路径树 `rm -rf` 删不出任何东西）。
 *
 * **白名单本身（`os.tmpdir()`）也要做同样的 realpath 归一化**，不只是目标路径——这是一个容易
 * 漏掉、本文件专门核实过的细节：macOS 上 `os.tmpdir()` 典型返回 `/var/folders/...`，但这本身
 * 就是一个指向 `/private/var/folders/...` 的符号链接（已用真实 `mkdtempSync`+`realpathSync`
 * 核实过，不是猜测）。如果白名单前缀只用词法值 `/var/folders/...`、目标路径却用 realpath 解析
 * 成 `/private/var/folders/...`，两者永远对不上前缀，会把**所有**合法的 tmpdir 内操作都误判成
 * "不在白名单"——方向上是"过度拦截"而不是"漏拦"，属于安全但错误的实现，本文件在白名单前缀
 * 那一侧也做了同样的 realpath 归一化，确保比较的是同一个坐标系。
 *
 * **白名单范围本身**：Phase1 只有 `os.tmpdir()` 一项（PRD/plan.md 已定，不自作主张加别的目录——
 * 白名单过窄比过宽安全，红线宁可误伤不可放过）。
 *
 * ── 已知局限（如实标注，不夸大机制——同 `brain-commit-gate.mjs` 的诚实标注惯例）──────────
 *   ① 命令混淆（变量拼接/`eval`/`$()` 子 shell）绕得过——`command-match.mjs` 头注释已详细论证，
 *      这是 Claude Code hook 纯文本模式匹配的天花板，本文件不假装能解决。
 *   ② `.env` 保护**只挡两条路径**：Bash 里的重定向（`>`/`>>`）/`tee` 写入，以及 Edit/Write
 *      工具直接对 `.env`/`.env.*` 路径的写入——挡不住**间接写**：模型可以写一个不叫这个名字的
 *      脚本文件（比如一个 `.mjs`），脚本内部用 `fs.writeFileSync('.env', ...)`，这个脚本文件
 *      本身的写入（`Write` 工具，目标是脚本文件本身）不会触发本 guard，之后脚本被执行时才真正
 *      写 `.env`——那次写入发生在 Node 进程内部，不经过 Bash 重定向语法，也不是 Edit/Write 工具
 *      调用，本文件看不到。
 *   ③ `.env` 重定向检测本身还有一条更窄的缝：操作符和前一个词**没有任何空白粘连**的写法
 *      （`cmd>.env`，`>` 两侧都没有空格）不会被识别——`command-match.mjs` 的 `tokenizeSegments`
 *      不是完整 shell 词法分析器，`>`/`>>` 没有被赋予和 `&`/`|`/`;` 同等的"即便无空白也要切"
 *      地位；改这条会触及 B1 已经过 Zorro 复审的核心解析器，本批不动它，详见
 *      `command-match.mjs` 的 `extractRedirectionTargets` 头注释。
 *   ④ **cwd 相关局限，同 `brain-commit-gate.mjs`**：Bash 分支的 `rm -rf` 白名单判定用的是
 *      这次 Bash 调用的 `cwd`（解析 `path.resolve(cwd, arg)` 里的相对路径参数），如果命令本身
 *      用绝对路径（大多数危险的 `rm -rf` 场景确实是绝对路径），cwd 影响很小；但如果目标写成
 *      相对路径、且 cwd 本身被命令用 `cd`/子 shell 间接改变过，本文件不会跟踪那种运行时才发生
 *      的 cwd 变化——只看 hook 收到的 `input.cwd` 这一个静态值。
 *   ⑤ **TOCTOU（check-before-execute 的根本局限，Zorro/Codex 2026-07-23 复审 finding-2，
 *      不是命令混淆，必须诚实披露，本文件不假装能解决）**：本 guard 在命令**执行前**、纯按
 *      命令文本**此刻的文件系统状态**解析路径判断安全；如果同一条复合命令先用别的手段改变了
 *      文件系统（比如先建一个符号链接），紧接着才 `rm`，命令真正执行时的文件系统状态和本
 *      guard 判断那一刻已经不是同一份快照。举例：`ln -s /etc box/x && rm -rf box/x/foo`——
 *      本 guard 判断 `rm -rf box/x/foo` 这个目标时，`box/x` 这一步的符号链接可能还没有被
 *      `ln -s` 真正建出来（取决于 Claude Code 判断时机和 shell 实际执行顺序的关系），
 *      `resolveRealOrLexical()` 走到 `box/x` 这一段大概率遇到 `ENOENT`（还不存在）、按"合法
 *      的尚不存在路径"逐级向上找存在的祖先——如果祖先在白名单内就判定"安全、allow"；但命令
 *      真正被 Bash 执行时，`ln -s` 先落地、`box` 目录下已经多了一个指向 `/etc` 的 `x`，
 *      `rm -rf box/x/foo` 实际删除的是 `/etc/foo`，已经不在白名单里了。**这是"先检查、后
 *      执行"（check-then-act）模式与生俱来的根本局限**——任何只解析命令文本做判断、不是在
 *      实际执行删除动作那一刻做校验的方案都有这道缝，本文件的机制（不管白名单判定写得多严谨）
 *      都盖不住这一类；这和"命令混淆"是两个不同性质的局限（命令混淆是"看不懂这条命令在说
 *      什么"，TOCTOU 是"看懂了，但判断时的文件系统状态和真正执行时不是同一份快照"）——不在
 *      本批修复范围内，如实记入已知局限。
 *
 * fail-open/fail-closed 边界（第一轮复审 finding-3/4，operator 2026-07-23 拍板收紧，见下方
 * 代码里唯一的 fail-closed 判定点标注——⚠️ 第二轮复验另有一个也叫"finding-3"的、性质完全不同
 * 的问题（"是否连坐"的误判粒度，见 `invocationIsRmDashRf` 头注释），两者编号撞了但不是同一件
 * 事，本文件用"第一轮"/"第二轮"区分）：**已经确认命中破坏模式（`rm -rf`/force-push/`.env` 写入其中之一）
 * 之后，如果判不出具体目标是否安全（目前只有"rm -rf 的某个目标路径 realpath 遇到非 ENOENT
 * 错误"这一种情况），deny，不能像别处一样静默 allow**——红线场景"宁可误伤不可放过"。**这条
 * 收紧不扩大到其它任何地方**：还没确认命中破坏模式（比如 `matchesRmDashRf(cmd)` 本身就是
 * false）、guard 自身的其它异常（stdin 读不到/JSON 解析失败/import 失败等）、命令解析深度
 * 之外的其它"看不懂"场景，仍然 fail-open——allow，不然会把一堆和红线毫无关系的正常操作也
 * 误伤，把整个 guard 变成"一出错就卡住会话"，这不是红线拦截该有的样子。kill-switch
 * `AELOOP_BRAIN_SKIP_REDLINE_GUARD=1` 全程有效，包括新收紧的这个 fail-closed 分支。
 *
 * 输出（PreToolUse deny）：stdout 打 JSON
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 */

import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

/**
 * 标记一个"realpath 判不出安全"的错误——finding-3/4（Zorro/Codex 2026-07-23 复审，operator
 * 拍板改成 fail-closed，见下方 `resolveRealOrLexical`/调用点的完整说明）。用一个专属属性标记，
 * 而不是让调用方去猜"这个 catch 到的 error 是不是那种情况"。
 */
const REALPATH_UNRESOLVABLE = Symbol("brain-red-line:realpath-unresolvable");

/**
 * realpath 一个路径，区分两种失败原因（finding-3 之前的版本把所有错误都当"不存在"处理，是一个
 * 真实的判断漏洞——见下方）：
 *   - **`ENOENT`**（路径就是不存在）→ 返回 `null`，这是合法状态（`rm -rf` 对不存在路径本来就是
 *     无操作，常见于幂等清理脚本），调用方据此逐级往上找存在的祖先目录继续判断。
 *   - **其它任何错误**（`EACCES` 权限拒绝、`ELOOP` 符号链接环路等）→ **不再当"不存在"处理**，
 *     抛出一个带 `REALPATH_UNRESOLVABLE` 标记的错误。旧版本这里统一 `catch { return null; }`，
 *     会把"我们判断不了这条路径到底指向哪里"和"这条路径压根不存在"混为一谈，两者都走同一条
 *     "逐级向上找祖先"的宽松路径——但"判断不了"不等于"合法地不存在"，红线场景下这个混淆是一个
 *     真实的漏洞（finding-3/4）：判断不出安全边界，不该被当成安全处理。
 * @param {string} p
 * @returns {string|null}
 * @throws 非 ENOENT 错误时抛出，`err[REALPATH_UNRESOLVABLE] === true`
 */
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    const marker = new Error(`realpath 无法判定"${p}"：${err?.code ?? "未知错误"}`);
    marker[REALPATH_UNRESOLVABLE] = true;
    marker.code = err?.code;
    throw marker;
  }
}

/**
 * 把 `path.resolve(cwd, arg)` 得到的词法路径，尽力解析成真实物理路径（跟随符号链接）。目标
 * 本身可能不存在（`rm -rf` 对不存在路径合法）——逐级往上找最近一个真实存在的祖先目录，解析
 * 它的 realpath，再把中间"不存在的那段"原样拼回去。详见文件头"rm -rf 白名单判定"整段论证。
 *
 * ⚠️ 本函数**不吞** `safeRealpath` 抛出的 `REALPATH_UNRESOLVABLE` 错误——故意让它继续往上冒泡，
 * 调用方（`handleBash` 的 rm-rf 判定循环）必须显式接住并 `deny()`，不能落进这个函数自己的
 * "找不到祖先就退化用词法路径"分支（那条分支只处理"整条路径链上全都是 ENOENT"这一种情况，
 * 不该覆盖"某一步遇到了判不出原因的错误"这另一种情况——两者的正确应对完全相反：前者安全
 * （删不出东西），后者必须保守拒绝）。
 * @param {string} lexicalPath
 * @returns {string} 尽力而为的真实路径（找不到任何存在的祖先时退化为词法路径本身）
 * @throws 若中途遇到非 ENOENT 错误，见 `safeRealpath`
 */
function resolveRealOrLexical(lexicalPath) {
  let current = lexicalPath;
  let suffix = "";
  // 上限保护：文件系统深度不可能无限，纯粹防御性，不代表预期会走到这么多次。
  for (let i = 0; i < 1024; i++) {
    const real = safeRealpath(current); // 非 ENOENT 错误会在这里直接抛出，不被本函数接住
    if (real !== null) {
      return suffix ? path.join(real, suffix) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return lexicalPath; // 到达文件系统根、全程只遇到过 ENOENT —— 退化用词法路径（无害：全树都不存在）
    }
    suffix = suffix ? path.join(path.basename(current), suffix) : path.basename(current);
    current = parent;
  }
  return lexicalPath;
}

/**
 * ⚠️ finding-2（Zorro/Codex 2026-07-23 第二轮复验，最严重的一条，已修）：白名单前缀
 * （`TMPDIR_REAL`，下方）的初始化在**模块加载时**执行，在 `main()` 的 fail-open try/catch
 * **之外**——本轮把 `safeRealpath()` 的契约改成"非 ENOENT 错误就抛"（finding-3/4 那次改动），
 * 但只更新了 `handleBash()` 里那一个调用点的 try/catch，漏了这里：如果 `tmpdir()` 本身解析
 * 出问题（比如坏的 `TMPDIR` 环境变量指向一个符号链接环路），`safeRealpath(tmpdir())` 会抛出
 * `REALPATH_UNRESOLVABLE` 错误，而这行代码在模块顶层同步执行、没有任何 try/catch 包裹，
 * 整个模块直接 crash（进程非零退出）——**guard 连"吐一个 deny JSON"的机会都没有**，红线判断
 * 根本没跑到，比"判不出就 allow"更糟：不是"放行了一次没查清楚的命令"，是"guard 整个死了"。
 *
 * **改法**：白名单前缀的初始化必须有自己专属的、绝不抛的 realpath 包装
 * （`realpathOrLexicalNeverThrow`），不能复用 `safeRealpath()`（那个函数的"非 ENOENT 就抛"
 * 契约是专门为 `handleBash()` 循环内部的 fail-closed 判定设计的，那里有 try/catch 接住；这里
 * 没有，也不该有——模块初始化阶段必须对任何错误都绝不抛，退化到词法路径是唯一安全的方向：
 * 如果因为这里退化导致目标 realpath 和这个词法前缀凑巧对不上，方向是"误判成不在白名单"，
 * deny 一个可能原本安全的操作，而不是反过来放行一个不安全的——过度拦截，不是漏拦）。
 * @param {string} p
 * @returns {string} 成功则真实路径，任何错误（含非 ENOENT）都退回词法路径本身，绝不抛
 */
function realpathOrLexicalNeverThrow(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// 白名单前缀本身也要 realpath 归一化 —— 见文件头"白名单本身也要做同样的 realpath 归一化"整段
// 论证（macOS 上 os.tmpdir() 本身是指向 /private/var/folders/... 的符号链接）。只算一次。
// ⚠️ 用 realpathOrLexicalNeverThrow，不是 safeRealpath ——见上方 finding-2 说明，这行在模块
// 加载时同步执行、不在任何 try/catch 里，绝不能抛。
const TMPDIR_REAL = realpathOrLexicalNeverThrow(tmpdir());

/** 目标路径是否落在白名单内（目前只有 os.tmpdir()，Phase1 范围，不自作主张扩大）。 */
function isWithinWhitelist(realTarget) {
  return realTarget === TMPDIR_REAL || realTarget.startsWith(TMPDIR_REAL + path.sep);
}

/**
 * 从一个 `rm -rf` invocation 的 args 里取出所有候选目标路径。
 *
 * ⚠️ finding-1（Zorro/Codex 2026-07-23 复审，真 bug，已修）：此前的实现对所有以 `-` 开头的
 * token 一律当 flag 跳过——这会漏判 `rm -rf -- -victim` 这种真实存在的合法写法：`--` 是 POSIX
 * "选项终止符"，出现之后的所有 token（不管是不是 `-` 开头）都是文件名，不再是 flag。旧实现会
 * 把 `-victim` 也当成"看起来像 flag"跳过，导致 `extractRmTargets` 返回空数组，本函数的调用方
 * （`handleBash`）因此一个目标路径都不检查，直接判定"没有目标需要验证"，**放行**了一个真实指向
 * 白名单外的 `rm -rf -- -victim`（`-victim` 本身可以是任意路径，比如 `-rf` 之外还能构造出
 * 危险文件名）。
 *
 * **修法**：一旦扫到第一个字面量 `--` token，其后所有 token 一律当目标（不再检查是否以 `-`
 * 开头）；`--` token 本身不算目标，只算"分界标记"。`--` 之前的 token，判据不变（`-` 开头当
 * flag 跳过）。
 *
 * ⚠️ finding-1 残留（Zorro/Codex 2026-07-23 第二轮复验，已修）：`--` 之前，单独的 `-`
 * （不是 `--`，就是一个字符的 `-`）也会被 `!a.startsWith("-")` 误当 flag 跳过——但 `rm`
 * （GNU/BSD 一致）把单独的 `-` 当成一个合法的（虽然罕见）文件名 operand，不是特殊 flag、
 * 不是 stdin 标记。`rm -rf -`（删除当前目录下字面量名叫 `-` 的文件/目录）在旧实现下会被
 * `extractRmTargets` 漏判成"没有目标"，从而放行。补上这个特例。
 * @param {string[]} args
 * @returns {string[]}
 */
function extractRmTargets(args) {
  const targets = [];
  let sawDoubleDash = false;
  for (const a of args) {
    if (sawDoubleDash) {
      targets.push(a); // -- 之后，一律当目标，不再看是否以 - 开头
      continue;
    }
    if (a === "--") {
      sawDoubleDash = true; // 分界标记本身不算目标
      continue;
    }
    if (a === "-") {
      targets.push(a); // finding-1 残留：单独的 "-" 是合法文件名 operand，不是 flag
      continue;
    }
    if (!a.startsWith("-")) targets.push(a);
  }
  return targets;
}

/**
 * 判断"这一个具体的 invocation"自己是不是真正的 `rm -rf`（含 `-r` 且 `-f` 等价组合）。
 *
 * ⚠️ finding-3（Zorro/Codex 2026-07-23 第二轮复验，误伤 bug，已修）：修复前的循环只判断
 * `inv.cmd !== "rm"`，没有重新确认这个具体 `rm` invocation 自己是否真的带了 `-r`+`-f`——只要
 * **同一条复合命令里的任一** invocation 命中了 `matchesRmDashRf(cmd)`（外层入口判断，扫全部
 * invocation），循环就会把该命令里**所有** `rm` invocation（不管带不带 `-rf`）都一并拉进白名单
 * 检查。实测 `rm -rf <安全tmp> && rm ./stale.log` 会把那个普通的 `rm ./stale.log`（根本不在
 * "递归+强制删除"这个红线范围内）也当成需要白名单验证的目标，因为它前面恰好有一个真正的
 * `rm -rf` 同命令连坐——单独跑 `rm ./stale.log` 不会被拦，跟在 `rm -rf` 后面跑就被拦，判据自相
 * 矛盾。
 *
 * **修法**：循环内对每个 `cmd === "rm"` 的 invocation，用本函数重新独立确认它自己是否真的是
 * `-r`+`-f`，不是的就跳过（不检查白名单，交给 handleBash 末尾的默认 allow）。外层
 * `matchesRmDashRf(cmd)` 仍然保留、不动——它的职责只是"这条命令值不值得进这个 if 块看一眼"的
 * 廉价预筛选，真正"这个具体 invocation 算不算 rm -rf"的判定权在这里，粒度对了才不会连坐。
 *
 * 本函数的判据**逐字复制** `command-match.mjs:297-317` `matchesRmDashRf` 内部对单个 invocation
 * 的判据（不是调用它——那个函数只回答"一条命令字符串里有没有任一 invocation 命中"，不返回是
 * 哪一个，本文件需要的是"这一个具体 invocation 自己算不算"这个更细的粒度，共享库没有暴露到这
 * 个粒度的导出）。约束要求本轮改动不碰 `command-match.mjs`（已经 Zorro PASS 的共享库，改动会
 * 扩大这轮复审的范围），复制这一小段判据比为了一次性的粒度需求去改共享库接口更克制——但两处
 * 判据必须保持逐字一致，否则会出现"这条命令算不算 rm -rf"在两个地方给出不同答案的新自相矛盾，
 * 这是复制这段代码时最主要的风险，写在这里提醒未来维护者：改一处要同步改另一处。
 * @param {{cmd:string, args:string[]}} inv
 * @returns {boolean}
 */
function invocationIsRmDashRf(inv) {
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
}

async function handleBash(input) {
  const cmd = input?.tool_input?.command;
  if (typeof cmd !== "string" || !cmd) allow();

  const { matchesRmDashRf, matchesForcePush, matchesEnvWrite, resolveInvocationsFromCommand, _internal } = await import(
    "./lib/command-match.mjs"
  );

  // ① rm -rf 白名单判定。matchesRmDashRf(cmd) 只是"值不值得进这个 if 块"的廉价预筛选（同一条
  // 复合命令里任一 invocation 命中即为 true）；真正"这个具体 invocation 算不算 rm -rf"由循环内
  // 的 invocationIsRmDashRf(inv) 逐个重新确认，见该函数头注释 finding-3 完整说明。
  if (matchesRmDashRf(cmd)) {
    const cwd = input.cwd || process.cwd();
    const invocations = resolveInvocationsFromCommand(cmd);
    for (const inv of invocations) {
      if (inv.cmd === _internal.OVERDEPTH) {
        deny("命令解析深度超限（可能是嵌套包装器/子 shell），无法判定是否安全，保守拒绝（fail-closed）。");
      }
      if (!invocationIsRmDashRf(inv)) continue; // finding-3：逐个重新确认，不因同命令里别处有 rm -rf 就连坐
      const targets = extractRmTargets(inv.args);
      for (const target of targets) {
        const lexical = path.resolve(cwd, target);
        // finding-3/4（Zorro/Codex 2026-07-23 复审，operator 拍板）：**这是本文件唯一的
        // fail-closed 判定点**——已经确认命中 rm -rf 破坏模式（外层 `matchesRmDashRf(cmd)` +
        // `inv.cmd === "rm"` 两道确认），此刻只是"这个具体目标到底安不安全"判不出来（realpath
        // 遇到非 ENOENT 错误，比如 EACCES 权限拒绝、ELOOP 符号链接环路）——红线哲学"宁可误伤
        // 不可放过"要求这种"判不出安全"的情况必须 deny，不能像别处的异常一样静默 allow。
        // 注意范围：只有这一段（已确认是 rm -rf、且目标路径解析异常）是 fail-closed；本文件
        // 其它所有分支（不命中任何破坏模式、guard 自身其它异常、命令解析不出是不是 rm 等）
        // 仍然 fail-open，见 `main()` 的外层 catch 和文件头"两分支均 fail-open"——fail-closed
        // 不能扩大到"guard 自己出了任何问题就一律 deny"，那会误伤大量正常操作、brick 会话。
        let real;
        try {
          real = resolveRealOrLexical(lexical);
        } catch (err) {
          if (err && err[REALPATH_UNRESOLVABLE]) {
            deny(
              `rm -rf 的目标路径"${target}"解析时出现意外错误（${err.code ?? "未知"}），无法确认是否在白名单内` +
                "——已命中 rm -rf 红线模式，判不出安全边界时保守拒绝（fail-closed）。" +
                "这是 issue #88 turnkey 公司大脑包的红线拦截。若确属误伤，临时设 " +
                "AELOOP_BRAIN_SKIP_REDLINE_GUARD=1 再跑。",
            );
          }
          throw err; // 非本文件自己抛出的标记错误——不应该发生，交给外层 catch 按既有 fail-open 惯例处理
        }
        if (!isWithinWhitelist(real)) {
          deny(
            `rm -rf 的目标路径"${target}"（解析后：${real}）不在白名单内（Phase1 白名单仅 ${TMPDIR_REAL}）。` +
              "这是 issue #88 turnkey 公司大脑包的红线拦截（rm -rf 硬拦）。若确属误伤，临时设 " +
              "AELOOP_BRAIN_SKIP_REDLINE_GUARD=1 再跑。",
          );
        }
      }
    }
  }

  // ② force-push（不含 --force-with-lease）。
  if (matchesForcePush(cmd)) {
    deny(
      "命令命中 git push --force（不含 --force-with-lease）—— issue #88 turnkey 公司大脑包的红线拦截。" +
        "若确实需要强推，用 --force-with-lease（更安全的变体）；若确属误伤，临时设 " +
        "AELOOP_BRAIN_SKIP_REDLINE_GUARD=1 再跑。",
    );
  }

  // ③ .env 重定向/tee 写入。
  if (matchesEnvWrite(cmd)) {
    deny(
      "命令通过 Bash 重定向或 tee 写入一个受保护的 .env 文件 —— issue #88 turnkey 公司大脑包的红线拦截。" +
        "若目标确实是示例/模板文件（.env.example/.env.sample/.env.template），检查文件名是否写对；" +
        "若确属误伤，临时设 AELOOP_BRAIN_SKIP_REDLINE_GUARD=1 再跑。",
    );
  }

  allow();
}

async function handleEditWrite(input) {
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== "string" || !filePath) allow();

  const { isProtectedEnvBasename } = await import("./lib/command-match.mjs");
  if (isProtectedEnvBasename(filePath)) {
    deny(
      `Edit/Write 工具的目标文件"${filePath}"是受保护的 .env 文件 —— issue #88 turnkey 公司大脑包的` +
        "红线拦截。若目标确实是示例/模板文件（.env.example/.env.sample/.env.template），检查文件名是否" +
        "写对；若确属误伤，临时设 AELOOP_BRAIN_SKIP_REDLINE_GUARD=1 再跑。",
    );
  }
  allow();
}

async function main() {
  try {
    if (process.env.AELOOP_BRAIN_SKIP_REDLINE_GUARD === "1") allow();

    let raw = "";
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      allow();
    }
    let input = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      allow();
    }

    if (input.tool_name === "Bash") {
      await handleBash(input);
    } else if (input.tool_name === "Edit" || input.tool_name === "Write") {
      await handleEditWrite(input);
    } else {
      allow();
    }
  } catch {
    // fail-open：guard 自身任何异常都不阻断。
    allow();
  }
}

main();
