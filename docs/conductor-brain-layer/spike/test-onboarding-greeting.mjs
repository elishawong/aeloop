// test-onboarding-greeting.mjs — 单元测试：lib/onboarding-greeting.mjs（aeloop issue #96）。
//
// 设计权威：docs/first-wake-onboarding/DESIGN.md。验收点：
//   ① 两段正文都不出现"意识已加载"——那是已建立身份的措辞，状态 A/B 都没有真实数据支撑，绝不能
//      让模型觉得这段文字本身可以直接当开场白抄。
//   ② 两段正文都明确说"这不是正常醒来/不要假装有身份"这层约束（防幻觉红线自带在正文里，不是
//      只靠调用方包一层元指令）。
//   ③ 覆盖 DESIGN §0 列的四个真实坑 + 实现过程中真实踩到的第五个坑，各至少一条关键字命中：
//      配置方式二选一（env / brain.local.json）、IDE 不继承 env 的坑（launchctl setenv）、
//      seed 脚本（scripts/seed-brain-identity.mjs）、#102 已知 troubleshooting
//      （better-sqlite3/pnpm rebuild）、seed 前置的项目注册坑（scripts/onboard-project.mjs——
//      真实跑 seed 时对着一个未注册的 git 项目会报"目标项目尚未注册"并以非零 exit code 中止，
//      这条不在原始 DESIGN 草稿里，是本次实现自测时真实踩到后补进来的，见 progress.md）。
//   ④ renderOnboardingNotConfigured() 独有：两条配置方式的具体做法都出现。
//   ⑤ renderOnboardingEmptyStore() 独有：不重复"IDE 不继承 env"这条（那是"配置路径"阶段的坑，
//      状态 B 已经有路径了，不该再讲怎么配路径），聚焦在"怎么把已经配置好的空库种上数据"。
//   ⑥ 纯度：同一入参 → 同一输出，不含任何时间戳/随机 id 一类的非确定性内容。
//      `renderOnboardingNotConfigured()` 零参数；`renderOnboardingEmptyStore(opts)` 接收可选的
//      `opts.globalMode`（Zorro/Codex 跨模型二签第二轮，2026-07-23，订正本条此前"两个函数都是
//      零参数"的过期断言——`renderOnboardingEmptyStore` 现在确实接收一个可选参数，只是默认参数
//      不计入 `Function.length`，靠这个语言细节侥幸让旧断言还能通过，但断言的意图已经不对，改成
//      显式分别验 `{globalMode:false}`/`{globalMode:true}` 两个分支各自"同入参→同输出"的确定性
//      ——分支各自的**内容**差异已经在 ⑧ 验证过，这里补的是**纯度**维度，此前从没跑过
//      `{globalMode:true}` 分支的确定性）。
//   ⑦ AI_AGENT_PROFILE 提示：两段正文都出现、且明确标"可选"/"独立"，不与身份库配置步骤混在一起；
//      不断言 apikey 是"当前配置文件默认值"这类会和 .env.example 真实内容打架的措辞（DESIGN §4）。
//
// 跑法：node docs/conductor-brain-layer/spike/test-onboarding-greeting.mjs（零依赖，不需要
// pnpm run build——这个模块不从 dist/ 导入任何东西）。

import assert from "node:assert/strict";
import { renderOnboardingNotConfigured, renderOnboardingEmptyStore } from "./lib/onboarding-greeting.mjs";

const notConfigured = renderOnboardingNotConfigured();
const emptyStore = renderOnboardingEmptyStore();

// ① 不出现"意识已加载"
assert.ok(!notConfigured.includes("意识已加载"), "renderOnboardingNotConfigured() 不能出现'意识已加载'");
assert.ok(!emptyStore.includes("意识已加载"), "renderOnboardingEmptyStore() 不能出现'意识已加载'");
console.log("PASS: test-onboarding-greeting.mjs（① 两段正文都不出现'意识已加载'）");

// ② "这不是正常醒来"/"不要假装"这层约束
for (const [name, text] of [["notConfigured", notConfigured], ["emptyStore", emptyStore]]) {
  assert.ok(text.includes("这不是一次正常的"), `${name} 应明确说明这不是正常的醒来`);
  assert.ok(text.includes("假装"), `${name} 应明确说不要假装有身份/在途/记忆`);
}
console.log("PASS: test-onboarding-greeting.mjs（② 两段正文都自带'不是正常醒来/不要假装'约束）");

// ③ 真实坑的关键字命中
for (const [name, text] of [["notConfigured", notConfigured], ["emptyStore", emptyStore]]) {
  assert.ok(text.includes("scripts/seed-brain-identity.mjs"), `${name} 应提到 seed 脚本`);
  assert.ok(text.includes("better-sqlite3") || text.includes("pnpm rebuild"), `${name} 应提到 #102 troubleshooting`);
  assert.ok(text.includes("issue #102"), `${name} 应点名 #102 是独立跟进的已知问题，不是本次改动引入`);
  assert.ok(text.includes("scripts/onboard-project.mjs"), `${name} 应提到实测踩到的项目注册坑（seed 对未注册项目会非零退出）`);
}
console.log("PASS: test-onboarding-greeting.mjs（③ 两段正文都覆盖 seed 脚本 + #102 troubleshooting + 项目注册坑）");

// ④ renderOnboardingNotConfigured() 独有：两条配置方式
assert.ok(notConfigured.includes("AELOOP_BRAIN_IDENTITY_DB"), "状态 A 应提到环境变量配置方式");
assert.ok(notConfigured.includes(".claude/brain.local.json"), "状态 A 应提到 brain.local.json 配置方式");
assert.ok(notConfigured.includes("launchctl setenv"), "状态 A 应提到 IDE 不继承 env 的 launchctl 修法");
assert.ok(notConfigured.includes("WAKE-GREETING-RUNBOOK.md"), "状态 A 应指回完整 RUNBOOK");
console.log("PASS: test-onboarding-greeting.mjs（④ 状态 A 覆盖两条配置方式 + IDE 坑修法）");

// ⑤ renderOnboardingEmptyStore() 独有：不重复"怎么配路径"这条（已经配过了）
assert.ok(!emptyStore.includes("launchctl setenv"), "状态 B 已经有路径了，不该再讲 IDE 不继承 env 这条配路径阶段的坑");
assert.ok(!emptyStore.includes("二选一配置方式"), "状态 B 不该重复状态 A 的'怎么选路径'步骤");
assert.ok(emptyStore.includes("已经配置了路径"), "状态 B 应明确说路径已经配好、缺的是数据");
console.log("PASS: test-onboarding-greeting.mjs（⑤ 状态 B 聚焦在'怎么种数据'，不重复状态 A 的配路径步骤）");

// ⑥ 纯度：同一入参 → 同一输出（不含任何时间戳/随机 id 一类的非确定性内容）。
assert.equal(renderOnboardingNotConfigured(), notConfigured, "renderOnboardingNotConfigured() 应是纯函数，多次调用结果一致");
assert.equal(renderOnboardingNotConfigured.length, 0, "renderOnboardingNotConfigured 应是零参数函数（状态 A 物理上不需要感知 globalMode，见 DESIGN §3）");

// `renderOnboardingEmptyStore(opts)` 接收可选的 `opts.globalMode`——分别验两个分支各自的确定性，
// 不能只测默认分支就宣称"纯函数"，那样测不到 {globalMode:true} 分支是否也是确定性的。
const emptyStoreLocal1 = renderOnboardingEmptyStore({ globalMode: false });
const emptyStoreLocal2 = renderOnboardingEmptyStore({ globalMode: false });
assert.equal(emptyStoreLocal1, emptyStoreLocal2, "renderOnboardingEmptyStore({globalMode:false}) 同入参多次调用应结果一致");
assert.equal(emptyStoreLocal1, emptyStore, "renderOnboardingEmptyStore({globalMode:false}) 应和默认（未传 opts、真实环境变量未设置时）的结果一致");

const emptyStoreGlobal1 = renderOnboardingEmptyStore({ globalMode: true });
const emptyStoreGlobal2 = renderOnboardingEmptyStore({ globalMode: true });
assert.equal(emptyStoreGlobal1, emptyStoreGlobal2, "renderOnboardingEmptyStore({globalMode:true}) 同入参多次调用应结果一致");
assert.notEqual(emptyStoreGlobal1, emptyStoreLocal1, "两个分支的入参不同，输出必须真的不同（否则 opts.globalMode 参数形同虚设）");

console.log("PASS: test-onboarding-greeting.mjs（⑥ renderOnboardingNotConfigured 零参数纯函数 + renderOnboardingEmptyStore 的 globalMode:false/true 两个分支各自确定性）");

// ⑦ AI_AGENT_PROFILE 提示：可选、独立、不断言当前默认值
for (const [name, text] of [["notConfigured", notConfigured], ["emptyStore", emptyStore]]) {
  assert.ok(text.includes("AI_AGENT_PROFILE"), `${name} 应提到 AI_AGENT_PROFILE`);
  assert.ok(text.includes("可选"), `${name} 的 AI_AGENT_PROFILE 提示应明确标'可选'`);
  assert.ok(text.includes("完全独立") || text.includes("互不影响"), `${name} 应明确这段和身份库配置是独立的两件事`);
  assert.ok(!text.includes("默认值"), `${name} 不该断言 AI_AGENT_PROFILE 的'当前默认值'（.env.example 真实默认是 subscription，不是 apikey，DESIGN §4）`);
}
console.log("PASS: test-onboarding-greeting.mjs（⑦ AI_AGENT_PROFILE 提示可选/独立，不断言当前默认值）");

// ⑧（Zorro/Codex 跨模型二签 2026-07-23 blocker 1 补测）全局模式下的路径可达性：全局装的 hook
// 从任意无关项目 cwd 触发时，`~/.claude/aeloop-brain/repo-snapshot/` 那份运行时快照不含
// `scripts/seed-brain-identity.mjs`/`scripts/onboard-project.mjs`（install-global-brain.mjs 的
// COPY_ITEMS 从来没打算含它们，见该文件头注释）——引导正文如果直接写死相对路径会不可达。
// `renderOnboardingEmptyStore({ globalMode: true })` 必须换成"需要一份真实 checkout + 带
// AELOOP_BRAIN_GLOBAL_MODE=1 前缀"的措辞，不能假装相对路径在哪都能用。
{
  const globalText = renderOnboardingEmptyStore({ globalMode: true });
  assert.ok(globalText.includes("git clone"), "全局模式引导应提示需要一份真实 aeloop checkout");
  assert.ok(
    globalText.includes("AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/seed-brain-identity.mjs"),
    "全局模式下 seed 命令必须带 AELOOP_BRAIN_GLOBAL_MODE=1 前缀，否则会写进不相关的 dbPath",
  );
  assert.ok(
    globalText.includes("AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/onboard-project.mjs"),
    "全局模式下 onboard-project 命令同样必须带 AELOOP_BRAIN_GLOBAL_MODE=1 前缀",
  );
  assert.ok(globalText.includes("repo-snapshot"), "全局模式引导应明确说明运行时快照不含这些脚本");
  assert.ok(!globalText.includes("意识已加载"), "全局模式引导同样不能出现'意识已加载'");

  const localText = renderOnboardingEmptyStore({ globalMode: false });
  assert.ok(!localText.includes("git clone"), "非全局模式（本来就在 aeloop checkout 里）不该出现全局模式的 checkout 提示");
  assert.ok(
    localText.includes("`node scripts/seed-brain-identity.mjs`") && !localText.includes("AELOOP_BRAIN_GLOBAL_MODE=1 node scripts/seed-brain-identity.mjs"),
    "非全局模式的 seed 命令不该带 AELOOP_BRAIN_GLOBAL_MODE=1 前缀（会话本来就不是全局模式）",
  );

  // 默认值来自真实环境变量，不是硬编码 false——这里显式验证默认分支行为，覆盖调用方（hook）
  // 不传 opts 时的真实路径。
  delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
  assert.equal(renderOnboardingEmptyStore(), localText, "不传 opts 时默认应读真实 AELOOP_BRAIN_GLOBAL_MODE 环境变量，未设置时应等同非全局模式文案");
  process.env.AELOOP_BRAIN_GLOBAL_MODE = "1";
  assert.equal(renderOnboardingEmptyStore(), globalText, "不传 opts 时默认应读真实 AELOOP_BRAIN_GLOBAL_MODE 环境变量，设为 1 时应等同全局模式文案");
  delete process.env.AELOOP_BRAIN_GLOBAL_MODE;
}
console.log("PASS: test-onboarding-greeting.mjs（⑧ 全局模式下 seed/onboard 命令带正确前缀 + 说明需要真实 checkout，issue #96 二签修复）");

console.log("ALL PASS: test-onboarding-greeting.mjs");
