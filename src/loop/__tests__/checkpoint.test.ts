/**
 * `checkpoint.ts` — the "non-closure-state resume" test (PRD §5/§6 B4,
 * §8's acceptance criterion, spike-findings.md Q4). **Real** `graph.ts`
 * (`buildLoopGraph()`/`compileLoopGraph()`, not a toy graph — this is the
 * layer-3 boundary from PRD §5's testing strategy) driven by a
 * hand-written `FakeAdapter` per role (no real subprocess/network, same
 * spirit as `nodes/__tests__/coder.test.ts`'s `FakeAdapter`), plus a
 * **real** `SqliteSaver` pointed at a real temp file.
 *
 * Two phases, same on-disk db path + `thread_id`, but every object from
 * phase 1 (`checkpointer`, compiled graph) goes out of scope before phase
 * 2 constructs brand-new ones — proving resume is driven by what's on
 * disk, not by anything still alive in this process's memory
 * (spike-findings.md Q4's cross-process proof, adapted to a same-process,
 * two-phase form per PRD §9.1's explicit reasoning for why that
 * substitution is sound here: A4a's own regression surface is "did
 * `checkpoint.ts`/`graph.ts` accidentally introduce an in-process
 * singleton/cache", not "does LangGraph's checkpoint mechanism work at
 * all" — the latter is spike Q4's already-settled question).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "@langchain/langgraph";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProfileDir } from "../../profile/loader.js";
import { PromptComposer } from "../../prompt/composer.js";
import { AdapterRegistry } from "../../harness/adapter-registry.js";
import { ProviderRouter } from "../../harness/provider-router.js";
import type { AvailabilityResult, InvokeRequest, InvokeResult, ModelAdapter } from "../../harness/types.js";
import type { CoderOutput, TesterOutput } from "../../prompt/schema.js";
import { buildLoopGraph, compileLoopGraph, type LoopGraphDeps } from "../graph.js";
import { createSqliteCheckpointer } from "../checkpoint.js";
import type { GateResumeValue, LoopNodeName, LoopStateType } from "../types.js";

const NOW = "2026-07-21T00:00:00.000Z";
const SUBSCRIPTION_PERSONAS_DIR = path.join(resolveProfileDir("subscription"), "personas");

class FakeCoderAdapter implements ModelAdapter {
  readonly id = "fake-coder";
  readonly kind = "direct-api" as const;

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const payload: CoderOutput = {
      status: "changed",
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [],
      confidence: "verified",
    };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

class FakeTesterAdapter implements ModelAdapter {
  readonly id = "fake-tester";
  readonly kind = "direct-api" as const;

  async checkAvailability(): Promise<AvailabilityResult> {
    return { available: true, checkedAt: NOW };
  }

  async invoke(_req: InvokeRequest): Promise<InvokeResult> {
    const payload: TesterOutput = { verdict: "pass", issues: [], claims: [], confidence: "verified" };
    return { content: JSON.stringify(payload), provider: this.id, model: "fake-model-v1" };
  }
}

/** A fresh `{router, composer}` each call — phase 1 and phase 2 each build their own, never sharing an instance (reinforces "nothing carried over except what's on disk"). */
function buildDeps(): LoopGraphDeps {
  const registry = new AdapterRegistry();
  registry.register(new FakeCoderAdapter());
  registry.register(new FakeTesterAdapter());
  const router = new ProviderRouter({ coder: { provider: "fake-coder" }, tester: { provider: "fake-tester" } }, registry);
  const composer = new PromptComposer(SUBSCRIPTION_PERSONAS_DIR);
  return { router, composer };
}

function initialState(): LoopStateType {
  return {
    task: "checkpoint two-phase resume: add a function",
    feedback: undefined,
    injectedContext: { memories: [] },
    coderOutput: undefined,
    coderResult: undefined,
    testerOutput: undefined,
    testerResult: undefined,
    rejectCount: 0,
    g1Decision: undefined,
    g2Decision: undefined,
    g3Decision: undefined,
    gateLog: [],
    applied: false,
    rejectThreshold: 2,
    escalationDecision: undefined,
    cancelled: false,
    noChange: false,
  };
}

/** `buildLoopGraph()`'s real compiled node union — every real `LOOP_NODES` value plus `"__start__"`, minus `"__end__"` (not a valid `Command.goto` target — see gates.test.ts's `resumeCommand` doc for why). */
type RealGraphNode = Exclude<LoopNodeName, "__end__">;

function resumeCommand(resume: GateResumeValue) {
  return new Command<GateResumeValue, Record<string, unknown>, RealGraphNode>({ resume });
}

describe("createSqliteCheckpointer — resume from a brand-new instance, not a live closure", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  it("phase 2's freshly constructed checkpointer + compiled graph reads phase 1's pending interrupt and resumes to completion, using only the on-disk sqlite file + thread_id", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aeloop-loop-"));
    const dbPath = path.join(tmpDir, "checkpoint.sqlite");
    const threadId = "checkpoint-two-phase";
    const cfg = { configurable: { thread_id: threadId } };

    let phase1PendingPayload: unknown;

    // ---- Phase 1: pause at G1, then let every phase-1 object fall out of scope. ----
    {
      const checkpointer1 = createSqliteCheckpointer(dbPath);
      const compiled1 = compileLoopGraph(buildLoopGraph(buildDeps()), checkpointer1);

      await compiled1.invoke(initialState(), cfg);
      const snapshot1 = await compiled1.getState(cfg);
      expect(snapshot1.next).toEqual(["g1"]);

      phase1PendingPayload = snapshot1.tasks[0]?.interrupts[0]?.value;
      expect(phase1PendingPayload).toMatchObject({ gate: "G1_SEND_TO_TESTER" });
      // No reference to checkpointer1/compiled1 escapes this block.
    }

    // Real disk file, not :memory: — the point of this test.
    expect(fs.existsSync(dbPath)).toBe(true);

    // ---- Phase 2: brand-new checkpointer + compiled graph, same db path + thread_id. ----
    const checkpointer2 = createSqliteCheckpointer(dbPath);
    const compiled2 = compileLoopGraph(buildLoopGraph(buildDeps()), checkpointer2);

    const snapshot2 = await compiled2.getState(cfg);
    expect(snapshot2.next).toEqual(["g1"]);
    expect(snapshot2.tasks[0]?.interrupts[0]?.value).toEqual(phase1PendingPayload);

    // Resume to completion using only phase-2 instances: G1 approve -> review(pass, FakeAdapter) -> g3 interrupt -> G3 approve -> apply -> END.
    await compiled2.invoke(resumeCommand({ decision: "approved" }), cfg);

    const midway = await compiled2.getState(cfg);
    expect(midway.next).toEqual(["g3"]);

    const final = await compiled2.invoke(resumeCommand({ decision: "approved" }), cfg);
    expect(final.applied).toBe(true);
    expect(final.g1Decision).toBe("approved");
    expect(final.g3Decision).toBe("approved");
    expect(final.coderResult?.provider).toBe("fake-coder");
    expect(final.testerResult?.provider).toBe("fake-tester");
  });
});
