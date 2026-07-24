#!/usr/bin/env node
/**
 * wake-session-guard.mjs — 醒来触发三层共享守卫（issue #106，DESIGN §3.2 完整论证，本文件只
 * 落地）。
 *
 * 职责：给 `brain-wake-greeting.mjs` 的三条驱动路径（`SessionStart` hook / `UserPromptSubmit`
 * hook / `--standalone` 模型自救调用）提供"这个会话是否已经真正注入过一次开场白"的判定——保证
 * 三层里只有第一个成功的负责输出，其余安静让路（DESIGN §3.1.1 时序图）。
 *
 * **为什么不是 `.claude/hooks/lib/brain-lock.mjs`（DESIGN §1.5 已论证，这里复述结论不复述论证）**：
 * `brain-lock.mjs` 的锁文件落在 `<toplevel>/.claude/brain-locks/`——**目标项目自己的 git 仓库
 * 内**。这套模式服务的是 aeloop 自己开发时的 dogfood 场景（worktree 隔离告警/commit 授权/issue
 * 绑定），从未进入 `install-global-brain.mjs` 的 `COPY_ITEMS`，没打算被复制到"装到任意第三方
 * 项目里跑"的全局安装场景。本文件的守卫状态**必须落在 homedir 下，绝不落进目标项目仓库**——
 * 否则全局安装后，第一次在任意用户项目里开会话，就会往那个跟本工具毫无关系的第三方仓库里悄悄
 * 建一个未追踪的目录（和 #103"合并 settings.json 时误伤第三方 hook 条目"同一类教训，风险对象从
 * "别人的 hook 条目"换成"别人仓库的文件树"）。
 *
 * **不 import `brain-lock.mjs`**（build 阶段订正，见下方 `sanitizeKey`/`resolveSessionId` 定义
 * 处的完整理由）：`brain-lock.mjs` 本身没有进 `install-global-brain.mjs` 的 `COPY_ITEMS`（上一段
 * 已经论证过），本文件如果 `import` 它会在全局安装场景下 `MODULE_NOT_FOUND`。`sanitizeKey()`
 * （把 key 清成安全文件名）/`resolveSessionId()`（`CLAUDE_CODE_SESSION_ID`/`CLAUDE_SESSION_ID`/
 * `AELOOP_BRAIN_SESSION_ID` 依次尝试）在本文件里各自维护一份独立实现，行为对拍由
 * `test-wake-session-guard.mjs` 守住。
 *
 * 状态文件位置：`<homeDir>/.claude/aeloop-brain/wake-session-state/<key>.json`——和
 * `install-global-brain.mjs` 的 `~/.claude/aeloop-brain/data/`（身份库数据目录）同一层级，风格
 * 一致。**本地开发（在 aeloop 自己仓库里跑，非全局安装）也用同一套 homedir 路径，不做"项目内 vs
 * 全局"两套实现**——这个状态本来就该是"这一个 Claude Code 会话"的属性，不是"这一个项目"的属性。
 *
 * Claim 原子性：`writeFileSync(path, ..., { flag: "wx" })`（排他创建）——SessionStart 和会话内
 * 第一次 UserPromptSubmit 理论上可能在极短时间窗口内先后触发，用文件系统的 `O_EXCL` 语义（谁先
 * 创建成功谁赢，后来者拿到 `EEXIST`）比"先读后写"的竞态判断更可靠，不需要额外的锁文件或重试
 * 逻辑。
 *
 * ⚠️ **调用方（`brain-wake-greeting.mjs`）必须遵守的时机纪律（DESIGN §3.2"Claim 时机"）**：
 * `claim()` 必须在"开场白/引导文案已经完整计算出来"之后、真正要往 stdout 写之前才调用，**不能**
 * 在开始计算之前调用。如果 claim 先行、随后开场白渲染逻辑抛出未预期异常，guard 已经被标记"已
 * 声明"，会导致这个会话在任何一层都再也拿不到开场白——比"没有守卫"更差（没有守卫时至少还能
 * 重试）。本文件自己不负责执行这条纪律（它只是一个 claim 原语），调用方必须遵守，本文件头注释
 * 在这里再强调一次，避免被后来的调用点漏看。
 *
 * 失败模式——fail-open：任何读写异常（权限/磁盘/损坏状态）都不抛出，`claim()` 返回
 * `{claimed:false, reason:"error"}`，调用方按"未 claim"处理（允许输出）。理由：guard 失效的
 * 代价是"这次开场白可能重复注入一次"，比"guard 自己的 bug 导致连一次都注入不出来"轻得多——和
 * 全仓 hook"绝不阻断"的既有红线取向一致。
 *
 * 陈旧清理：`claim()` 内部每次都会 opportunistic 调一次 `sweepStale()`，删除 `mtime` 超过 48
 * 小时（`DEFAULT_STALE_MS`，指挥官 2026-07-24 确认定值，DESIGN §7 第2点）的旧状态文件——不建
 * 独立 cron/定时任务，顺手做，避免目录无限增长；扫描/删除本身的异常同样吞掉，不影响 claim 主
 * 流程。
 */

import { lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join } from "node:path";

// ⚠️ **本文件自己维护 `sanitizeKey`/`resolveSessionId` 这两份实现，不 `import` `brain-lock.mjs`
// 的同名导出**——这是 build 阶段（issue #106）发现并订正的一处真实设计修正，不是 DESIGN.md
// 定稿时的原意：DESIGN §3.2 原文写"复用 brain-lock.mjs 已经写好的两个纯函数"，但
// `brain-lock.mjs` 本身**从未**进入 `install-global-brain.mjs` 的 `COPY_ITEMS`（§1.5 已经论证
// 过这条：那是 aeloop 自己开发时的 dogfood 锁文件机制，从设计上就没打算被复制到全局安装场景）。
// 如果本文件 `import` 它，会在全局安装快照里踩到和 #96/#98/#103 同一类"新依赖没进 COPY_ITEMS →
// 全局模式 MODULE_NOT_FOUND"的坑——而且恰好是在这个守卫真正要保护的场景（全局安装、任意第三方
// 项目）里失效，讽刺意味最强的那种回归。修法：`sanitizeKey`/`resolveSessionId` 都是完全自包含
// 的纯函数（前者只做字符串替换，后者只读三个 env var，都不依赖 `brain-lock.mjs` 其余的锁文件
// I/O 逻辑），在这里各自维护一份~10 行的独立实现，比让本文件的可部署性去耦合到
// `brain-lock.mjs` 的 COPY_ITEMS 排除清单更安全。两边行为必须保持一致——
// `test-wake-session-guard.mjs` 有一条行为对拍测试（不是引用相等测试）守住这条。
export function sanitizeKey(key) {
  return String(key).replace(/[^A-Za-z0-9._-]/g, "_");
}

export function resolveSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || process.env.AELOOP_BRAIN_SESSION_ID || null;
}

export const DEFAULT_STALE_MS = 48 * 60 * 60 * 1000; // 48 小时（DESIGN §7 第2点，指挥官确认定值）

/**
 * 给定 homeDir，返回守卫状态目录的绝对路径。
 *
 * 🔒 Zorro R1 blocker B1（2026-07-24，独立 Codex 复现坐实）：**`homeDir` 必须是绝对路径**——
 * 此前这里没做任何校验，`join()` 对相对路径（比如误配置的 `HOME=.`，或调用方手误传了个相对
 * 路径）会静默拼出一个"相对 cwd"的路径，`claim()`/`sweepStale()` 后续的 `mkdirSync`/
 * `writeFileSync`/`readdirSync` 就会真的往**当前工作目录**（全局安装场景下大概率是目标第三方
 * 项目仓库！）里写/读——这正好撞上本文件头注释"状态必须落在 homedir 下，绝不落进目标项目仓库"
 * 这条红线本身。不是"理论风险"：`os.homedir()` 在 POSIX 上就是读 `$HOME`，一个配错的 `$HOME`
 * （相对路径）会让这条红线在没有任何报错的情况下被静默破坏。
 *
 * 修法：非绝对路径 → 直接 `throw`（不是返回一个"将就凑合"的路径）。调用方（`claim()`/
 * `sweepStale()`）必须把这个 `throw` 当成"这次操作失败"处理——`claim()` 走 fail-open 语义
 * （不写盘，允许调用方照常输出，见 `claim()` 头注释和 B2 相关订正）；`sweepStale()` 本身承诺
 * "绝不抛出"，所以它内部会 catch 住这个 throw，静默跳过清理，不向上传播。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function guardStateDir(homeDir = os.homedir()) {
  if (typeof homeDir !== "string" || !isAbsolute(homeDir)) {
    throw new Error(
      `wake-session-guard: homeDir 必须是绝对路径，收到 ${JSON.stringify(homeDir)}——拒绝把守卫状态` +
        "落进一个可能相对当前工作目录（大概率是目标第三方项目仓库）的路径，fail-closed。",
    );
  }
  return join(homeDir, ".claude", "aeloop-brain", "wake-session-state");
}

/** 从 sessionId（优先）或 pid（回退）算出这一把 claim 用哪个身份 key。同 `brain-lock.mjs` 的
 * `identityKey()`（未导出的私有函数）同一等价逻辑，独立维护一份——理由同上（本文件不耦合
 * `brain-lock.mjs` 的部署面）。 */
function identityKey({ sessionId, pid }) {
  return sessionId != null && sessionId !== "" ? sessionId : pid;
}

/** 给定身份信息 + homeDir，返回该会话守卫状态文件的绝对路径。 */
export function guardStatePath({ sessionId, pid } = {}, { homeDir = os.homedir() } = {}) {
  return join(guardStateDir(homeDir), `${sanitizeKey(identityKey({ sessionId, pid }))}.json`);
}

/**
 * Opportunistic 陈旧清理——删除 `wake-session-state/` 目录下 `mtime` 超过 `maxAgeMs` 的文件。
 * 任何异常（目录不存在/权限问题/单个文件删除失败）都静默吞掉，不影响调用方，不抛出。
 * @param {{homeDir?:string, now?:number, maxAgeMs?:number}} [opts]
 */
export function sweepStale({ homeDir = os.homedir(), now = Date.now(), maxAgeMs = DEFAULT_STALE_MS } = {}) {
  let dir;
  try {
    dir = guardStateDir(homeDir); // 非绝对 homeDir 会在这里 throw（B1）——sweepStale 自己承诺
    // "绝不抛出"，所以这里必须 catch 住，不能让 guardStateDir() 的校验错误穿透出去。
  } catch {
    return;
  }
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return; // 目录还没建 / 读不出 = 没有需要清理的
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filePath = join(dir, name);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) unlinkSync(filePath);
    } catch {
      /* 单个文件的 stat/unlink 失败不影响其它文件的清理，也不影响调用方 */
    }
  }
}

/**
 * 尝试声明"这个会话的开场白由我负责输出"。原子操作（`O_EXCL` 排他创建）——谁先成功谁负责输出。
 *
 * ⚠️ **调用方必须在开场白文案已经算完之后才调用这个函数**（见本文件头注释"Claim 时机"）。
 *
 * @param {{sessionId?:string|null, pid?:number, source: "SessionStart"|"UserPromptSubmit"|"standalone"}} identity
 * @param {{homeDir?:string, now?:number}} [opts]
 * @returns {{claimed:true} | {claimed:false, reason:"already-claimed"|"error"}}
 */
export function claim({ sessionId, pid, source }, { homeDir = os.homedir(), now = Date.now() } = {}) {
  // Opportunistic 陈旧清理——异常吞掉，不影响本次 claim 主流程。
  try {
    sweepStale({ homeDir, now });
  } catch {
    /* 见 sweepStale 自身的 fail-open 承诺，这里是双重保险 */
  }

  const record = {
    schemaVersion: 1,
    sessionId: sessionId ?? null,
    pid: pid ?? process.pid,
    source,
    claimedAt: new Date(now).toISOString(),
  };
  // 🔒 Zorro R1 blocker B1（2026-07-24）：路径计算（`guardStateDir`/`guardStatePath`，会对非
  // 绝对 `homeDir` 抛错）必须和实际写盘（`mkdirSync`/`writeFileSync`）在**同一个外层** try/catch
  // 里——此前 `guardStatePath()` 在 try 块之外单独调用，`homeDir` 校验失败时会直接从 `claim()`
  // 抛出、不经过下面的 catch，调用方（`brain-wake-greeting.mjs`）没有为这种"claim() 自己抛异常"
  // 的情况做防护，会被 `main().catch()` 那层更粗的兜底吞掉、直接吞掉整段已经算好的开场白——和
  // guard 头注释"任何读写异常都不抛出"的承诺矛盾。
  //
  // 🔒 Zorro R2 blocker N1（2026-07-24，独立 Codex 复现坐实，B2 只修了一半）：`already-claimed`
  // 这个判定**只能来自 `writeFileSync(...,{flag:"wx"})` 的 `EEXIST`**（排他创建真的撞见另一个
  // 会话已经写好的 claim 文件），**不能来自 `mkdirSync` 阶段的任何异常**——`mkdirSync(dir,
  // {recursive:true})` 在 `dir` 这个路径本身已经被一个**普通文件**占据时（不是目录），同样会抛
  // `EEXIST`（已实测确认：`mkdir '<path>'` → `EEXIST: file already exists`）——这是一种腐坏
  // 状态（谁在这个路径放了个文件？磁盘/权限问题？），不是"claim 竞争"，如果和 `writeFileSync`
  // 的 `EEXIST` 用同一个 catch 混着判，会被误判成 `already-claimed` → 调用方以为"别的路径已经
  // 负责输出过"→ 抑制输出 → 回到 B2 本来要防的那个症状（hook 吞开场白/standalone 谎报"已经醒来
  // 过"），只是触发条件从"guard 自身 I/O 故障"换成了"状态目录路径被文件腐坏占据"，同一类问题。
  //
  // 修法：`mkdirSync` 和 `writeFileSync` 各自独立的 try/catch——`mkdirSync` 阶段的**任何**异常
  // （含 `EEXIST`）都直接判 `reason:"error"`（fail-open，允许输出）；只有进入了
  // `writeFileSync(...,{flag:"wx"})` 这一步之后拿到的 `EEXIST`，才是真正的"claim 竞争"，判
  // `reason:"already-claimed"`。
  try {
    const dir = guardStateDir(homeDir);
    const file = guardStatePath({ sessionId, pid }, { homeDir });

    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // mkdir 阶段的任何异常（含 EEXIST——路径被文件腐坏占据）都不是"claim 竞争"，统一按
      // guard 自身故障处理：不写盘、不阻断，允许调用方照常输出。
      return { claimed: false, reason: "error" };
    }

    try {
      writeFileSync(file, JSON.stringify(record, null, 2), { flag: "wx" });
      return { claimed: true };
    } catch (err) {
      if (err && err.code === "EEXIST") {
        // 🔒 Zorro R3 blocker N3（2026-07-24，Zorro + 独立 Codex 双模型复现坐实——B2→N1→N3 同一
        // 根因第三次发作）：`writeFileSync(...,{flag:"wx"})`（`O_CREAT|O_EXCL`）在目标路径已经
        // 是**目录 / 软链（含悬空软链）/ 任意垃圾文件**时，同样先抛 `EEXIST`（早于 `EISDIR`）——
        // 这些都是腐坏态（谁在这个精确的 claim 文件路径放了个目录/软链？），不是"claim 竞争"，
        // 但此前的实现无条件把这里的 `EEXIST` 当 `already-claimed`，会被误判成"别的路径已经
        // 负责输出过"，抑制输出，回到 B2 本来要防的那个症状——只是腐坏态从"mkdir 阶段"（N1）
        // 换到了"最终这一个 claim 文件路径本身"（N3），同一类问题的第三个子类。
        //
        // 指挥官指定的根因级修法（不再逐个枚举腐坏态子类）：**不默认 EEXIST = already-claimed**，
        // 改成正向断言——`lstatSync(file)`（**不跟随软链**，这是 load-bearing 的关键决定：
        // `statSync` 会跟随软链，对一个"软链指向目录/软链指向普通文件"的场景都会报出**目标**的
        // stat 而不是软链本身，会把腐坏态误判成合法态；`lstatSync` 报的是这个路径本身是什么，
        // 不看它指向哪——`test-wake-session-guard.mjs` 有一条"软链→普通文件"用例专门锁住这个
        // 决定：那种场景下 `statSync().isFile()` 是 `true`、`lstatSync().isFile()` 是
        // `false`，如果有人不小心把 `lstatSync` 改回 `statSync`，那条测试会红）。是软链（含
        // 悬空软链，`lstatSync` 不跟随所以不会因为目标不存在而抛错）、是目录、或者 `lstatSync`
        // 本身失败（极端竞态：两次系统调用之间文件被删掉/换掉），一律 `reason:"error"`
        // （fail-open，允许调用方照常输出）。
        //
        // ⚠️ **如实标注这条判断的真实边界，不过度断言**（🟡 指挥官 2026-07-24 复核要求订正
        // 措辞——此前这里写"`isFile()` 为真 = 真正的普通文件 = 合法的旧 claim 记录"，这是一句
        // 过度断言：本函数**只判断这个路径是不是一个普通文件，不校验文件内容**——`isFile()` 为
        // 真就走 `already-claimed` 去重路径，是"按去重契约信任已存在的普通文件"，不是"验证过
        // 这确实是一份合法 claim 记录"。这条去重契约理论上存在一个未被消灭的残留角落：这个
        // 精确的、per-session（`session_id`/UUID 量级）claim 路径上出现一个**空的/垃圾内容的
        // 普通文件**（不是目录、不是软链，是真的普通文件，但内容不是本文件自己写的那种
        // JSON）——**实践中不可达**：唯一已知的自伤路径是 `writeFileSync(...,{flag:"wx"})`
        // 在"内核建好 inode"和"内容真正写完"之间那个亚微秒级窗口被 `SIGKILL` 打断，留下一个空
        // 文件；这个窗口小到指挥官/Zorro/Codex 三方复审都认定"根因已到，继续为这个子类打补丁是
        // 净负——常见并发路径下反而会引入新竞态"（2026-07-24 定盘，不做）。这条残留角落触发时
        // 的最坏后果：这一次调用被误判成 `already-claimed`、漏播一次开场白，`exit 0`，不阻断、
        // 不崩溃——是一条**接受的 fail-open 边界**，和 DESIGN.md §5"Layer3 的 pid 兜底在跨 Bash
        // 调用场景下可能撞车"那条已经写明的局限同一个等级，不是掩盖，是明确记录一个已知的、
        // 概率级、后果有界的残留角落。
        //
        // 这次修法一次性关掉了**可枚举、可复现**的整族腐坏态（目录/软链→目录/悬空软链/软链→
        // 普通文件），同时不破坏 by-design 的合法去重——已经过 Zorro + 独立 Codex 双模型实测
        // 复现验证的分支（合法旧 claim 文件 → already-claimed；四种可复现腐坏态 → error）。
        let isRealFile = false;
        try {
          isRealFile = lstatSync(file).isFile();
        } catch {
          // lstat 本身失败（比如两次系统调用之间文件被并发删除的极端竞态）——同样不是一份
          // 可信的"已存在的合法 claim 文件"，fail-open。
          isRealFile = false;
        }
        if (isRealFile) return { claimed: false, reason: "already-claimed" };
        return { claimed: false, reason: "error" };
      }
      return { claimed: false, reason: "error" };
    }
  } catch {
    // guardStateDir()/guardStatePath() 本身抛出（B1：非绝对 homeDir 校验失败）——同样是 fail-open：
    // 不写盘、不阻断，允许调用方照常输出。
    return { claimed: false, reason: "error" };
  }
}
