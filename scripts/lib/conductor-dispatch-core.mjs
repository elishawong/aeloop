// conductor-dispatch-core.mjs — 共享派发核心（issue #2 batch 0,§7.3 方案 B）。
//
// 从 `scripts/dispatch-brain-task.mjs`(issue #93 B5,已过 Zorro+Codex 两轮 must-fix)抽出的
// "翻译 → 库调驱动 aeloop 执行(自动批 G1/G2,停 G3/Escalation 前) → EvidenceBundle → 三态门折回"
// 这段核心逻辑——不要求项目注册,不含 `--project` 语义,不含 cwd 互斥锁/chdir(那两样是
// `dispatch-brain-task.mjs` 多项目场景特有的并发保护,留在那个文件里,不下沉到这里;调用方若需要
// 同款保护,自己在调用这个函数之前/外层做,见 `dispatch-conductor-task.mjs` 的用法)。
//
// 设计权威:docs/conductor-mvp/DESIGN.md §7.3(方案对比)+ §4.2(派发胶水层职责)。
//
// 调用模式:和 `run-spike.mjs`/`dispatch-brain-task.mjs` 完全同一套(assembleProfileDeps +
// startRun/resumeRun,库调模式,不走 `conductor-work.mjs` 子进程——那条路径今天必然停在 G1、没有
// resume 命令,这个判断已经在 spike-PRD §0.2 论证过,这里不重新论证)。
//
// **调用方职责边界(必须由调用方保证,这个函数自己不做)**:
//   - `ctx.store` 必须是一个已经 open 的 `MemoryStore` 实例,调用方负责它的开关生命周期
//     (这个函数只读写它,不 open/close 它——和 `dispatch-brain-task.mjs` 原有的单一 store 生命周期
//     保持一致,不新增第二次 open 同一个 sqlite 文件)。
//   - 如果调用方需要"工具执行 cwd 必须钉死在某个目录、不能继承调用方 `process.cwd()`"这条保护
//     (`dispatch-brain-task.mjs` 的 Zorro must-fix 就是这条),调用方自己在调这个函数前后做
//     chdir——这个函数内部不 chdir,是不是需要这条保护取决于调用方的使用场景(#2 的
//     `dispatch-conductor-task.mjs` 同样需要,见该文件自己的实现)。

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `scripts/lib/` → 仓库根(往上两级),和 `dispatch-brain-task.mjs`/`run-spike.mjs` 的
 *  `REPO_ROOT` 计算约定一致(往上数到仓库根),只是起点目录深一层。 */
export const REPO_ROOT = path.join(HERE, "..", "..");

/** 未显式传 `opts.contractDir` 时,TaskContract JSON 写去哪——#2 自己的安全区,独立于
 *  #75/#80(`docs/conductor-brain-layer/spike/**`)和 #93(`docs/conductor-brain-multiproject/
 *  spike/**`)已有的两个安全区,避免三次验证的审计痕迹混在一起(同 #93 B5 头注释的既有理由)。 */
export const DEFAULT_CONTRACT_DIR = path.join(REPO_ROOT, "docs", "conductor-mvp", "runs");

/**
 * 自动放行的 gate 集合——红线：只含 G1/G2，G3/Escalation **恒人工**，永不出现在这个集合里
 * （candidate-only 既有 posture,同 `run-spike.mjs`/`dispatch-brain-task.mjs` 的既有决定，
 * 不是本文件新引入的判断）。
 *
 * **模块私有,不导出这个 `Set` 本身**（Zorro R2 blocker RB1，2026-07-24 硬化回退修复）：
 * R1 阶段曾经把这个 `Set` 直接 `export`,理由是"供测试断言其内容"——但 `const` 只锁定绑定本身
 * 不可重新赋值,锁不住 `Set` 实例的可变方法。任何 `import` 到这个 `Set` 的调用方都能真的执行
 * `AUTO_APPROVE_GATES.add("G3_FINAL_MERGE")`/`.add("ESCALATION_ACK")`——一旦被（哪怕是无意）
 * 这样调用,下面 `runConductorDispatch()` 里的自动批循环会真的自动批准 G3/Escalation,直接
 * 击穿"G3/Escalation 恒人工"这条不可弱化的红线。修法：这个 `Set` 保持模块私有（不 `export`），
 * 对外只暴露两样只读接口——① `isAutoApproveGate(gate)` 判定函数（自动批循环自己也改用它，见
 * 下方，不再直接引用 `AUTO_APPROVE_GATES_INTERNAL`）；② `AUTO_APPROVE_GATE_NAMES`
 * `Object.freeze()` 过的数组快照（`Object.freeze()` 在严格模式下会让 `.push()`/索引赋值真的
 * 抛错,不是像 `const Set` 那样只是"看起来不可变"）。测试改断言这两个只读接口的行为，不再持有
 * 一个可能被其它测试/调用方意外污染的 live `Set` 引用。
 */
const AUTO_APPROVE_GATES_INTERNAL = new Set(["G1_SEND_TO_TESTER", "G2_SEND_TO_FIX"]);

/** 只读快照——`Object.freeze()` 过，`.push()`/索引赋值在严格模式下会真的抛错，不是名义上的只读。 */
export const AUTO_APPROVE_GATE_NAMES = Object.freeze([...AUTO_APPROVE_GATES_INTERNAL]);

/** 判定函数——自动批循环(下方)和测试都用这一个函数,不直接触达内部可变 `Set`。 */
export function isAutoApproveGate(gate) {
  return AUTO_APPROVE_GATES_INTERNAL.has(gate);
}

/**
 * @typedef {object} ConductorDispatchContext
 * @property {import("../../dist/context/store.js").MemoryStore} store 调用方已经 open 的身份库实例
 *   (三态门折回目标)——生命周期由调用方管理,这个函数不 open/close 它。
 * @property {(profileName: string, env: NodeJS.ProcessEnv) => Promise<any>} [assembleDeps]
 *   可注入(测试用),缺省时用真实 `assembleProfileDeps()`。
 */

/**
 * @typedef {object} ConductorDispatchOptions
 * @property {string[]} [allowedPaths] 透传给 `translateIntent()`——缺省用 translator 自己的默认值
 *   (`docs/conductor-brain-layer/spike/**`)。
 * @property {string} [objectivePrefix] 透传给 `translateIntent()`。
 * @property {string} [contractDir] TaskContract JSON 落盘目录,缺省 `DEFAULT_CONTRACT_DIR`。
 * @property {string} [profile] 传给 `assembleDeps()` 的 profile 名,缺省 `"subscription"`
 *   (同 `run-spike.mjs`/`dispatch-brain-task.mjs` 的既有默认)。
 * @property {string} [decidedByLabel] 自动批 G1/G2 时记进 `approvals.decided_by` 的字符串,
 *   缺省一个通用标签;调用方可以传更具体的标签方便审计溯源。
 */

/**
 * 共享核心:意图 → TaskContract → aeloop 执行(自动批 G1/G2,停 G3/Escalation 前)→
 * EvidenceBundle → 三态门折回。不含项目注册校验、不含 cwd 保护(见文件头"调用方职责边界")。
 *
 * @param {string} rawIntent
 * @param {ConductorDispatchContext} ctx
 * @param {ConductorDispatchOptions} [opts]
 * @returns {Promise<{
 *   contract: import("../../dist/conductor/types.js").TaskContract,
 *   contractPath: string,
 *   evidenceBundle: import("../../dist/evidence/bundle.js").EvidenceBundle,
 *   gateResults: Array<{evidenceId: string|null, memoryId: number, source: string, confirmed: boolean}>,
 *   runError: Error|null,
 * }>}
 */
export async function runConductorDispatch(rawIntent, ctx, opts = {}) {
  const { translateIntent } = await import(
    path.join(REPO_ROOT, "docs", "conductor-brain-layer", "spike", "lib", "translator.mjs")
  );
  const contract = translateIntent(rawIntent, {
    allowedPaths: opts.allowedPaths,
    objectivePrefix: opts.objectivePrefix,
  });

  const contractDir = opts.contractDir ?? DEFAULT_CONTRACT_DIR;
  fs.mkdirSync(contractDir, { recursive: true });
  const contractPath = path.join(contractDir, `${contract.contractId}.json`);
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));

  const {
    ConductorWorkApp,
    companyBrainDirectory,
    WorkflowRegistry,
    coderTesterWorkflow,
    renderTaskContract,
    startRun,
    resumeRun,
    LoopEventEmitter,
  } = await import(path.join(REPO_ROOT, "dist", "index.js"));

  const workflows = new WorkflowRegistry();
  workflows.register(coderTesterWorkflow);
  const app = new ConductorWorkApp({ brainDirectory: companyBrainDirectory(REPO_ROOT), workflows });
  const plan = app.planRun(contractPath);

  const profileName = opts.profile ?? "subscription";
  const assembleDeps =
    ctx.assembleDeps ??
    (async (profileNameArg, env) => {
      const { assembleProfileDeps } = await import(path.join(REPO_ROOT, "dist", "cli", "assemble.js"));
      return assembleProfileDeps(profileNameArg, env, undefined);
    });

  const cliDeps = await assembleDeps(profileName, process.env);
  const capturedEvents = [];
  const emitter = new LoopEventEmitter();
  emitter.on((event) => capturedEvents.push(event));
  const decidedBy = opts.decidedByLabel ?? "conductor-dispatch-core (auto, not a human decision)";

  let runError = null;
  // `handle` declared outside the try block (unlike the original
  // dispatch-brain-task.mjs, which never returned it) — batch 1's
  // dispatch-conductor-task.mjs (the conversational entry point) needs to know
  // whether the run stopped at a human gate (G3/Escalation) or reached a
  // terminal state (apply/cancel/no_change), so the reply to the user can say
  // "candidate ready, pending G3" instead of staying silent about it.
  let handle = null;
  try {
    const task = renderTaskContract(plan.contract.objective, plan.contract);
    const injectedContext = cliDeps.injector.inject(plan.contract.objective);

    handle = await startRun(
      { ...cliDeps, events: emitter },
      {
        task,
        profile: cliDeps.profileConfig.profile,
        workflowDefId: plan.workflow.id,
        injectedContext,
        rejectThreshold: 2,
      },
    );
    while (handle.interrupt && isAutoApproveGate(handle.interrupt.gate) && !handle.done) {
      handle = await resumeRun(
        { ...cliDeps, events: emitter },
        handle.runId,
        handle.threadId,
        { decision: "approved" },
        decidedBy,
        handle.stepCounters,
      );
    }
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  } finally {
    cliDeps.audit.close();
    cliDeps.memoryStore.close();
    if (cliDeps.checkpointer && typeof cliDeps.checkpointer.db?.close === "function") {
      cliDeps.checkpointer.db.close();
    }
  }

  const evidenceBundle = app.projectEvents(capturedEvents, contractPath);

  const { applyThreeStateGate } = await import(
    path.join(REPO_ROOT, "docs", "conductor-brain-layer", "spike", "lib", "three-state-gate.mjs")
  );
  const gateResults = applyThreeStateGate(evidenceBundle, ctx.store, { actor: decidedBy });

  return {
    contract,
    contractPath,
    evidenceBundle,
    gateResults,
    runError,
    runId: handle?.runId ?? null,
    threadId: handle?.threadId ?? null,
    // G3/Escalation 恒人工——batch 1 不擅自批（同 runCandidate() 自己的既有 posture:
    // "candidate-only; git writes disabled"）。`pendingGate` 非空时，调用方应该诚实告知用户
    // "候选已产出、正等待这个 gate"，不能假装闭环已经走完。
    // `diffRef`（Zorro R1 blocker B5）：`GatePayload.diffRef`（`src/loop/types.ts`）在 A4a 里
    // 始终内联持有 diff 文本本身（不是哈希/路径），这一刻（还没决策）是**唯一**能拿到"这一轮候选
    // 实际改了什么"的地方——一旦决策落地，这段文本会被持久化进 `approvals.diff_ref`，但那是"已
    // 决策"的历史记录，本函数返回的是"当前正卡在这里、还没决策"的这一次中断，两者不是同一件事
    // （DESIGN §3.2 记录的是"看板从 workflow.db 只读查询这条路径查不到 pending diff"，和这里
    // "同一次进程内 startRun/resumeRun 返回值里带的 diffRef"是两条不同路径，互不矛盾）。调用方
    // （dispatch-conductor-task.mjs）负责把这段文本裁剪到适合塞进一次对话回复的长度，本函数不做
    // 截断——截断策略是"展示给谁看"这一层的关注点，不属于这个引擎调用薄封装。
    pendingGate: handle?.interrupt
      ? { gate: handle.interrupt.gate, question: handle.interrupt.payload?.question ?? null, diffRef: handle.interrupt.payload?.diffRef ?? null }
      : null,
    done: handle?.done ?? false,
  };
}
