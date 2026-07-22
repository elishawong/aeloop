#!/usr/bin/env node
/**
 * A6 双 Profile 真实验收 —— 正式跑前的配置自查(preflight)
 * =========================================================
 *
 * 目的:在公司电脑正式跑 A6(scripts/conductor-work.mjs)**之前**,一条命令
 * 把「配错一个字就白跑一次」的坑挡在前面。公司电脑跑真模型的机会有限、每次
 * 失败要拍照来回排查,所以先跑这个自查、全绿再跑真的。
 *
 * 用法:
 *   AI_AGENT_PROFILE=apikey AELOOP_PROFILES_ROOT=~/.aeloop-company \
 *     node scripts/a6-preflight.mjs [--check-net]
 *
 *   --check-net  额外对每个 base_url 打一次 LiteLLM 的免鉴权 liveliness 探针
 *                (${base_url}/health/liveliness),确认端点真的通。需要网络。
 *
 * 退出码:有任何 [FAIL] → 1;只有 [WARN]/[ OK ] → 0。绿了才跑真 A6。
 *
 * 检查项刻意分两类,和引擎行为严格对齐(preflight 报错 = 真跑也会出问题,
 * 不制造假警报):
 *   A. loader/harness **真会校验**的(profile/providers/roles 形状、kind、
 *      base_url 字符串)—— 这些错真跑时会抛 ProfileConfigParseError /
 *      InvalidProviderConfigError。
 *   B. loader/harness **故意不查、但最坑**的四类(源码实测):
 *      1) ${ENV_VAR} 没设 → substituteEnvPlaceholders 把字面量原样下传 → fetch 失败
 *      2) api_style 拼错 → extractApiStyle 静默退回 "openai" → 打错端点
 *      3) coder / tester 用同一模型 → 「独立复核」卖点失效,A6 失去意义
 *      4) base_url 不通 → 要 --check-net 才主动探
 *
 * 本脚本只**读** config,绝不打印 api_key 值(只查存在性/形状)。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { load as loadYaml } from "js-yaml";

const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const CHECK_NET = process.argv.includes("--check-net");

let fails = 0;
let warns = 0;
const ok = (m) => console.log(`  [ OK ]  ${m}`);
const warn = (m) => {
  warns++;
  console.log(`  [WARN]  ${m}`);
};
const fail = (m) => {
  fails++;
  console.log(`  [FAIL]  ${m}`);
};
const section = (t) => console.log(`\n${t}`);

/** 把开头的 ~ 展开成 home(shell 有时不替换,尤其带引号/脚本里)。 */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 复刻 loader.substituteEnvPlaceholders:${VAR} → env;未设则**保留字面量**。 */
function substituteEnv(value) {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER, (match, name) =>
      process.env[name] !== undefined ? process.env[name] : match,
    );
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnv(v);
    return out;
  }
  return value;
}

/** 收集一棵已替换过的 config 里**残留**的 ${VAR}(= 没解析成功的占位符)。 */
function collectUnresolved(value, acc = new Set()) {
  if (typeof value === "string") {
    for (const m of value.matchAll(ENV_PLACEHOLDER)) acc.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectUnresolved(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectUnresolved(v, acc);
  }
  return acc;
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksPlaceholder(s) {
  return /^(<|xxx|your|todo|changeme|\.\.\.)/i.test(s) || s.includes("<") || s.includes("...");
}

console.log("A6 preflight —— 正式跑前配置自查\n================================");

// ── 1. Node 版本 ────────────────────────────────────────────────
section("1. 运行环境");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 24) ok(`Node ${process.versions.node}`);
else warn(`Node ${process.versions.node} —— runbook 要求 Node 24(23 引擎只 warning,但请用 24 保稳)`);

// ── 2. AI_AGENT_PROFILE ─────────────────────────────────────────
const profile = process.env.AI_AGENT_PROFILE || "apikey";
if (!process.env.AI_AGENT_PROFILE)
  warn(`未设 AI_AGENT_PROFILE —— 引擎会默认 "subscription";A6 需要 =apikey(本自查按 apikey 继续)`);
else ok(`AI_AGENT_PROFILE=${profile}`);

// ── 3. AELOOP_PROFILES_ROOT 与目录布局 ──────────────────────────
section("2. Profile 目录布局(最常见的坑)");
const rawRoot = process.env.AELOOP_PROFILES_ROOT;
let configPath = null;
if (!rawRoot) {
  fail("未设 AELOOP_PROFILES_ROOT —— profile 靠它从仓库外挂载,必须设");
} else {
  const root = path.resolve(expandHome(rawRoot));
  const expected = path.join(root, profile, "config.yaml");
  if (existsSync(expected)) {
    ok(`找到 ${expected}`);
    configPath = expected;
  } else if (path.basename(root) === profile && existsSync(path.join(root, "config.yaml"))) {
    // 头号 footgun:指到了 <profile>/ 本身而非它的父目录
    fail(
      `AELOOP_PROFILES_ROOT 指到了 "${profile}/" 本身;它必须指向 "${profile}/" 的**父目录**。` +
        ` 现在:${root} → 改成:${path.dirname(root)}`,
    );
  } else if (!existsSync(root)) {
    fail(`AELOOP_PROFILES_ROOT 指向的目录不存在:${root}`);
  } else {
    fail(`在 ${expected} 找不到 config.yaml(核对目录结构 <root>/${profile}/config.yaml)`);
  }
}

// ── 4. 解析 + 语义校验 ──────────────────────────────────────────
if (configPath) {
  section("3. config.yaml 解析与字段");
  let parsed;
  try {
    parsed = loadYaml(readFileSync(configPath, "utf8"));
  } catch (e) {
    fail(`config.yaml 解析失败(YAML 语法错):${e.message}`);
  }

  if (parsed !== undefined) {
    const config = substituteEnv(parsed);

    // 4a. 未解析的 ${ENV_VAR}(loader 会原样下传 → fetch 失败)
    const unresolved = [...collectUnresolved(config)];
    if (unresolved.length)
      fail(
        `有未解析的占位符 \${${unresolved.join("}, ${")}} —— 这些环境变量当前没设。` +
          ` 引擎会把字面量原样发出去导致请求失败。用 \`node --env-file=.env ...\` 或先 export。`,
      );
    else ok("无未解析的 ${ENV_VAR} 占位符");

    // 4b. loader 级形状(profile/providers/roles)
    if (!isPlainObject(config)) {
      fail("config 根不是一个映射(mapping)");
    } else {
      if (typeof config.profile !== "string") fail('缺 string 字段 "profile"(loader 会抛 ProfileConfigParseError)');
      else if (config.profile !== profile)
        warn(`config 内 profile: "${config.profile}" 与 AI_AGENT_PROFILE=${profile} 不一致(语义可疑)`);
      else ok(`profile: ${config.profile}`);

      if (!isPlainObject(config.providers)) fail('缺 mapping 字段 "providers"');
      if (!isPlainObject(config.roles)) fail('缺 mapping 字段 "roles"');

      // 4c. roles.coder / roles.tester → provider 解析
      if (isPlainObject(config.roles) && isPlainObject(config.providers)) {
        section("4. 角色 → provider 绑定");
        const providerModels = {};
        for (const role of ["coder", "tester"]) {
          const binding = config.roles[role];
          if (!isPlainObject(binding) || typeof binding.provider !== "string") {
            fail(`roles.${role} 缺失或没有 string "provider" 字段(A6 需要 coder + tester 两个角色)`);
            continue;
          }
          const pid = binding.provider;
          const prov = config.providers[pid];
          if (!isPlainObject(prov)) {
            fail(`roles.${role}.provider = "${pid}",但 providers.${pid} 未定义`);
            continue;
          }
          ok(`roles.${role} → providers.${pid}`);

          // provider 级(harness assertValidProviderConfig 真会查的)
          if (typeof prov.kind !== "string") {
            fail(`providers.${pid} 缺 "kind" 字段(harness 会抛 InvalidProviderConfigError)`);
          } else if (prov.kind !== "cli-bridge" && prov.kind !== "direct-api") {
            fail(`providers.${pid}.kind = "${prov.kind}" 非法(只认 cli-bridge / direct-api;拼错会被 harness 拦)`);
          } else if (prov.kind === "cli-bridge") {
            warn(`providers.${pid}.kind = cli-bridge —— 那是订阅侧;apikey/A6 应为 direct-api`);
          } else {
            ok(`providers.${pid}.kind = direct-api`);
          }

          if (prov.kind === "direct-api" || prov.kind === undefined) {
            if (typeof prov.base_url !== "string" || prov.base_url.trim() === "")
              fail(`providers.${pid}.base_url 缺失或非非空字符串(direct-api 必需)`);
            else ok(`providers.${pid}.base_url 已配置`);

            if (typeof prov.api_key !== "string" || prov.api_key.trim() === "")
              fail(`providers.${pid}.api_key 缺失或为空(会得到 Bearer undefined / 401)`);
            else if (looksPlaceholder(prov.api_key))
              warn(`providers.${pid}.api_key 看起来还是占位符(未填真 key?)`);
            else ok(`providers.${pid}.api_key 已填(值不打印)`);

            const model = typeof prov.model === "string" ? prov.model : undefined;
            if (!model) fail(`providers.${pid}.model 缺失或非字符串`);
            else {
              ok(`providers.${pid}.model = ${model}`);
              providerModels[role] = model;
            }

            // api_style:拼错会被**静默**当 openai → 可能打错端点
            if (prov.api_style === undefined)
              warn(`providers.${pid} 未设 api_style —— 引擎默认 "openai"(打 /chat/completions);Claude 类模型要显式写 anthropic`);
            else if (prov.api_style !== "openai" && prov.api_style !== "anthropic")
              fail(
                `providers.${pid}.api_style = "${prov.api_style}" 非法 —— 引擎会**静默**退回 "openai" 并打 /chat/completions,` +
                  ` 若该模型其实是 anthropic 风格就会失败。只能写 openai 或 anthropic。`,
              );
            else {
              const ep = prov.api_style === "anthropic" ? "/v1/messages" : "/chat/completions";
              ok(`providers.${pid}.api_style = ${prov.api_style} → 打 ${ep}`);
            }
          }
        }

        // 4d. coder ≠ tester 模型(独立复核的核心卖点)
        if (providerModels.coder && providerModels.tester) {
          if (providerModels.coder === providerModels.tester)
            warn(
              `⚠️ coder 和 tester 都是同一模型 "${providerModels.coder}" —— A6 的意义(不同模型独立复核)会失效,` +
                ` 强烈建议换成两个不同模型再跑。`,
            );
          else ok(`coder(${providerModels.coder})≠ tester(${providerModels.tester})—— 独立复核成立`);
        }
      }

      // 4e. workflow.reject_threshold(半自动升级到人的安全网依赖它)
      if (isPlainObject(config.workflow) && config.workflow.reject_threshold !== undefined) {
        const rt = config.workflow.reject_threshold;
        if (!(typeof rt === "number" && Number.isInteger(rt) && rt >= 1))
          warn(`workflow.reject_threshold = ${JSON.stringify(rt)} 非正整数 —— 引擎会忽略它退回默认`);
        else ok(`workflow.reject_threshold = ${rt}`);
      }
    }

    // ── 5. (可选)base_url 网络可达性 ──────────────────────────
    if (CHECK_NET && isPlainObject(config.providers)) {
      section("5. base_url 可达性探针(--check-net)");
      const bases = new Set();
      for (const p of Object.values(config.providers))
        if (isPlainObject(p) && typeof p.base_url === "string" && p.base_url.trim()) bases.add(p.base_url.replace(/\/+$/, ""));
      if (!bases.size) warn("没有可探的 base_url");
      for (const base of bases) {
        const url = `${base}/health/liveliness`;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
          if (res.ok) ok(`${url} → ${res.status}(端点在线)`);
          else warn(`${url} → ${res.status}(有响应但非 2xx;端点通,细节看返回)`);
        } catch (e) {
          fail(`${url} 不可达:${e.name === "AbortError" ? "5s 超时" : e.message}(确认公司网络/端点)`);
        }
      }
    } else if (!CHECK_NET) {
      section("5. base_url 可达性");
      console.log("  (跳过;加 --check-net 主动探 ${base_url}/health/liveliness)");
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────
console.log("\n================================");
console.log(`结果:${fails} FAIL / ${warns} WARN`);
if (fails > 0) {
  console.log("❌ 有 FAIL —— 先按上面修好,别急着跑真 A6(会白费一次)。");
  process.exit(1);
} else if (warns > 0) {
  console.log("🟡 无 FAIL,但有 WARN —— 逐条确认是有意为之再跑。");
  process.exit(0);
} else {
  console.log("✅ 全绿 —— 可以跑真 A6 了(scripts/conductor-work.mjs)。");
  process.exit(0);
}
