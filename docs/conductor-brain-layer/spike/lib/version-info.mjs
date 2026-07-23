// version-info.mjs — issue #98 版本戳：醒来开场白读版本行的独立小 lib。
//
// 风格对齐 `.claude/hooks/lib/git-remote.mjs`：一个纯粹的、fail-soft 的辅助函数，不抛错，
// 拿不到就返回 `undefined`，调用方（`brain-wake-greeting.mjs`）据此决定"这次开场白要不要带
// 版本行"，绝不因为这一步失败拖累开场白其余部分。
//
// 为什么不直接 `import` `../../../../dist/shared/version-info.generated.js`（像 `wake.mjs` 那样
// 静态 import dist 下的文件）：这个模块本身会被 `brain-wake-greeting.mjs` **动态** import（和
// `wake.mjs`/`greeting-data.mjs`/`render-greeting.mjs` 同一惯例——那个 hook 的头注释解释过，
// 动态 import 是为了让"dist/ 还没 build"这类失败也能被 try/catch 接住，不在模块加载阶段就
// 直接崩溃），`resolveVersionLine()` 内部再对 `version-info.generated.js` 做第二层动态 import，
// 双重保险：即便 `version-info.mjs` 本身被成功 import 了，读版本文件这一步单独失败也不影响
// 调用方继续往下走。
//
// 全局安装（issue #93 `install-global-brain.mjs`）已经把这个文件列进 `COPY_ITEMS`——装完之后
// `<installDir>/repo-snapshot/docs/conductor-brain-layer/spike/lib/version-info.mjs` 存在，
// 且它内部对 `dist/shared/version-info.generated.js` 的相对路径引用（`repoRoot` 参数，由调用方
// 传入，本文件自己不猜路径）在新位置同样成立（目录骨架保留，见 `install-global-brain.mjs` 头
// 注释）。

import path from "node:path";

/**
 * @param {string} repoRoot 仓库根目录（真实源码仓库,或全局安装后的 `repo-snapshot/` 目录）——
 *   两种场景下 `dist/shared/version-info.generated.js` 都应该存在于 `<repoRoot>/dist/shared/`
 *   下（build 时刻固化,拷贝时保留相对路径骨架,见 issue #98 PRD §2.2/§3.4）。
 * @returns {Promise<string | undefined>} 格式化后的版本字符串（"aeloop 0.0.1+9d568ad[-dirty]"，
 *   和 CLI `--version`/`EvidenceBundle.engineVersion` 同一格式，见 `src/shared/version.ts`）；
 *   `dist/` 未构建 / 文件不存在 / 内容不是预期形状 → `undefined`（不是空字符串——让调用方能
 *   明确区分"这次没有版本行"和"版本行是空字符串"两种情况）。**绝不抛错**。
 */
export async function resolveVersionLine(repoRoot) {
  try {
    const versionModulePath = path.join(repoRoot, "dist", "shared", "version-info.generated.js");
    const mod = await import(versionModulePath);
    const info = mod.GENERATED_VERSION_INFO;
    // issue #98 Zorro 独立复审 #2：直接读生成产物里的 versionString 字段（由
    // scripts/generate-version.mjs 的 formatVersionString() 算过一次），不在这里自己再拼一遍
    // "+"/"-dirty"——这个文件是 .mjs，物理上不能 import src/shared/version.ts（那是 .ts），
    // 三处消费方（这里、src/shared/version.ts、install-global-brain.mjs）各自重建格式化逻辑
    // 曾经是本条 must-fix 的根因，现在统一读同一个已经算好的字符串字面量。
    if (!info || typeof info.versionString !== "string" || info.versionString.trim() === "") return undefined;
    return `aeloop ${info.versionString}`;
  } catch {
    return undefined; // dist/ 未构建、文件不存在、动态 import 失败 —— 一律 fail-soft，不抛错
  }
}
