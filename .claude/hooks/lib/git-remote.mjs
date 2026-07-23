// git-remote.mjs — 目标仓库判定共享库（issue #88 B1，plan.md §B1）。
//
// 精确移植 ai-agent 仓库 `_engine/gh.mjs:147-163` 的 `getOriginOwnerRepo()`（只读引用该文件核对过
// 实现，不复制文件本身、不 import 跨仓路径 —— aeloop 与 ai-agent 是两个独立仓库，见
// `docs/feature/conductor-brain-turnkey/impact.md` §2"跨项目波及：无"）。新增 `resolveToplevel()`
// 是本包自己的需要（PRD §4.1）：`brain-commit-gate.mjs`/`brain-red-line-guard.mjs` 都要反复判定
// "这次 Bash 调用的 cwd 属于哪个 git 仓库"，抽成共享函数不各写各的。
//
// 零依赖、不联网、不调 AI（同全仓 hook 惯例）。

import { execFileSync } from "node:child_process";

/**
 * 从一个本地 repo 路径读它的 origin remote URL，解析出真实 owner/repo。
 * 支持 SSH（git@github.com:owner/repo.git）与 HTTPS（https://github.com/owner/repo(.git)?）两种形式。
 * 用 execFileSync（不走 shell）传参数数组 —— 逐字对齐 `gh.mjs:147-163` 的实现，不是凭印象重写。
 * @param {string} repoPath 本地 git 仓库路径
 * @returns {{ok:true, owner:string, repo:string} | {ok:false}} 解析失败（非 git / 无 origin / URL 认不出）→ ok:false
 */
export function getOriginOwnerRepo(repoPath) {
  let url;
  try {
    url = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"], // 忽略 stderr（非 git 目录 / 无 origin 时 git 会报错，这里静默 → 走 catch）
    }).trim();
  } catch {
    return { ok: false }; // 非 git 目录 / 没配 origin remote → 无法取得
  }
  // SSH: git@github.com:owner/repo.git  |  HTTPS: https://github.com/owner/repo(.git)?
  const sshMatch = /^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  const httpsMatch = /^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  const m = sshMatch || httpsMatch;
  if (!m) return { ok: false }; // 认不出的 remote URL 形式（如别的 host 特殊写法）→ 无法解析
  return { ok: true, owner: m[1], repo: m[2] };
}

/**
 * 给定一个 cwd，解析它所属 git 仓库的 toplevel 绝对路径。非 git 目录 → null（fail-open，
 * 供各 hook 的"判定不出目标 → allow"分支使用，同 `_engine/session-lock.mjs` 的 `resolveToplevel`
 * 惯例）。
 * @param {string} cwd
 * @returns {string|null}
 */
export function resolveToplevel(cwd) {
  try {
    return (
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * owner/repo 单段合法性（精确移植 `gh.mjs:124` 的 `OWNER_REPO_SEGMENT`）：必须以字母数字开头，
 * 后随字母数字/`.`/`_`/`-`，拒占位符（`<owner>`）/空白/斜杠。供 `brain-lock.mjs` 的 issue ref
 * 校验复用，不重新发明一条更松的正则。
 * @type {RegExp}
 */
export const OWNER_REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
