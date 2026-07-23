# Issue #102 — pnpm fresh install 不编译 better-sqlite3 native binding:留痕

quick-fix,轻量留痕(七道门第6门)。分支 `feature/issue-102-pnpm-build`,改动仅
`package.json`(+3 行)与新增 `pnpm-workspace.yaml`,不涉及运行时代码。

## 1. 问题

fresh clone + `pnpm install` 后跑 `node scripts/seed-brain-identity.mjs` 报
`Could not locate the bindings file`(better-sqlite3 的 native `.node` 未编译)。
公司电脑实战踩到(2026-07-23)。

## 2. 根因(订正版——务必用这版,别复述旧版)

**pnpm v10.0.0 起**默认阻断依赖的 lifecycle build 脚本(供应链安全策略):
既不在 `onlyBuiltDependencies`(v9/v10)白名单、也不在 `allowBuilds`(v11+)许可表里的包,
`install` 阶段的 `preinstall`/`install`/`postinstall` 脚本一律被跳过并打印
`Ignored build scripts: <pkg>` 警告(v10)或直接报
`[ERR_PNPM_IGNORED_BUILDS]` 中断安装(v11)。better-sqlite3 靠 `install` 脚本跑
`prebuild-install || node-gyp rebuild --release` 编译 native `.node`,脚本被跳过 →
native binding 缺失 → 运行时 `bindings.js` 找不到文件。

> ⚠️ **此前 issue body 曾写「pnpm v9+ 默认不运行依赖 build 脚本」,是错的,已订正**:
> 实测 **pnpm v9.15.9 / v9.12.3(本仓当前默认安装版本)默认仍会编译**,不受影响;
> 阻断行为从 **v10.0.0** 才开始生效。aeloop 未 pin `packageManager`,本地/CI 实际用哪个
> 大版本取决于环境,因此三个大版本(v9/v10/v11)都要覆盖,不能只按 issue 原文的
> "v9+" 假设去修。

## 3. 修法(两个文件,合起来覆盖 v9/v10/v11)

**`package.json`**(覆盖 v9——本来就不需要,但字段无害;覆盖 v10——生效):
```json
"pnpm": {
  "onlyBuiltDependencies": ["better-sqlite3"]
}
```

**`pnpm-workspace.yaml`**(新增,覆盖 v11——`onlyBuiltDependencies` 在 v11 被移除,
package.json 里的这个字段会被静默忽略并打印 `[WARN] The "pnpm" field in package.json
is no longer read by pnpm`,不是报错,但也不会编译):
```yaml
packages:
  - "."

allowBuilds:
  better-sqlite3: true
```

- `packages: ["."]` 是必需的,不是装饰:实测 pnpm v9 只要检测到 `pnpm-workspace.yaml`
  存在,就要求 `packages` 字段非空,否则直接 `ERROR packages field missing or empty`
  中断安装——即使 `allowBuilds` 这个键本身对 v9 完全是无意义的未知字段。`packages: ["."]`
  等价于"这个 workspace 只有根包自己",是非 monorepo 仓库单纯为了塞配置项而放
  `pnpm-workspace.yaml` 的标准写法,不会把 aeloop 变成真正的多包 workspace(没有
  `workspace:` 协议依赖、没有递归命令依赖这个语义)。v10/v11 对 `packages` 字段是否存在
  不敏感,加了也不影响其行为。
- **`allowBuilds` 语义(pnpm.io/settings 已核)**:`better-sqlite3: true` 是"包名
  matcher → 布尔"的信任映射,匹配**该包名解析到的任意版本**,不是锁定某个具体版本号
  持续生效的许可(例如 pnpm 官方文档示例里 `nx@21.6.4 || 21.6.5: true` 才是版本区间
  级别的 matcher 写法;裸包名 `better-sqlite3: true` 是"这个包名下任何版本我都信任"的
  粗粒度形式)。`better-sqlite3` 升级到新的 semver 版本时这条规则依旧生效,不需要跟着改。

## 4. 验证证据

**方法**:两两对照(改动前 package.json / 改动后两文件都在),每个 pnpm 大版本用
`npx pnpm@<major>` 触发、各自独立 `--store-dir`(scratchpad 下的一次性目录,和真实
`~/.local/share/pnpm/store` 完全隔离),避免 store 里已缓存的"side effects"污染判断;
每轮验证结束后清空对应 scratch 目录,全程未修改真实仓库 `node_modules`。

| pnpm 版本 | fix 前(无 `pnpm-workspace.yaml`,原始 package.json) | fix 后(两文件都在) |
|---|---|---|
| v9.15.9 / v9.12.3(本仓默认) | native `.node` 正常编译(LOADS OK)——v9 本就不阻断 | 同样 LOADS OK;**若只加 `allowBuilds` 不加 `packages`,v9 会 `ERROR packages field missing or empty` 直接装不上**,加了 `packages: ["."]` 后恢复 LOADS OK |
| v10.34.5 | `Ignored build scripts: better-sqlite3@12.11.1` 警告,无 `.node`(LOAD FAILED,对应本 issue 报的原始 bug) | 干净安装,`.node` 生成(LOADS OK) |
| v11.17.0 | `[ERR_PNPM_IGNORED_BUILDS]` 安装直接失败(LOAD FAILED) | 干净安装,`.node` 生成(LOADS OK) |

真实 worktree(本地实际安装的 pnpm 9.12.3)在两文件都落地后跑过一次真·fresh
install(`rm -rf node_modules && pnpm install`):`better_sqlite3.node` 编译产物
落在 `node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/build/Release/`;
functional smoke test(`new Database(':memory:')` + 建表/插入/查询)在 v10/v11 两个
隔离目录里都跑通;`pnpm test` 在真实 worktree 跑到 **58 个测试文件、634 条用例全绿**。

## 5. 未解 / 待补

- **公司电脑实战踩坑那台机器的精确 pnpm 版本号未记录**——只能从"fresh install 静默跳过
  编译"这个现象反推是 **v10 或以上**(v9 不会复现这个现象),具体是 10.x 还是 11.x
  待补,标 `[?]`,不编。
- **`packageManager` 要不要 pin(`package.json` 加 `"packageManager": "pnpm@x.y.z"`
  钉死版本)是待定取舍,本次未实现**:利在于根治"本地/CI 用哪个大版本全凭当下环境
  决定"这个漂移源;弊在于团队被锁定到手动升版本才能拿到 pnpm 新版的安全/性能修复,
  且如果 pin 在 v11 以下,仓库会继续依赖已在上游被标记移除的
  `package.json pnpm.onlyBuiltDependencies` 字段。留给军师/指挥官定,本次不擅自加。
