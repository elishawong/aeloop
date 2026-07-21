/**
 * `LoopEventEmitter` unit tests (issue #29,
 * `docs/feature/events-observability/PRD.md` §5/§8 — B1). Pure unit tests
 * against the emitter itself, no graph/runner involved — the
 * event-sequence-against-a-real-run assertions live in `runner.test.ts`
 * (B2), where `startRun`/`resumeRun` actually drive a compiled graph.
 */
import { describe, expect, it, vi } from "vitest";
import { LoopEventEmitter, type LoopEvent } from "../events.js";

function fakeEvent(overrides: Partial<LoopEvent> = {}): LoopEvent {
  return {
    type: "run_started",
    runId: 1,
    threadId: "thread-1",
    ts: "2026-07-21T00:00:00.000Z",
    task: "toy task",
    profile: "subscription",
    workflowDefId: "coder-tester-loop",
    rejectThreshold: 2,
    ...overrides,
  } as LoopEvent;
}

describe("LoopEventEmitter", () => {
  it("delivers an emitted event to every subscribed listener", () => {
    const emitter = new LoopEventEmitter();
    const receivedA: LoopEvent[] = [];
    const receivedB: LoopEvent[] = [];
    emitter.on((e) => {
      receivedA.push(e);
    });
    emitter.on((e) => {
      receivedB.push(e);
    });

    const event = fakeEvent();
    emitter.emit(event);

    expect(receivedA).toEqual([event]);
    expect(receivedB).toEqual([event]);
  });

  it("on()'s returned unsubscribe function stops further delivery to that listener only", () => {
    const emitter = new LoopEventEmitter();
    const receivedA: LoopEvent[] = [];
    const receivedB: LoopEvent[] = [];
    const unsubscribeA = emitter.on((e) => {
      receivedA.push(e);
    });
    emitter.on((e) => {
      receivedB.push(e);
    });

    unsubscribeA();
    emitter.emit(fakeEvent());

    expect(receivedA).toEqual([]);
    expect(receivedB).toHaveLength(1);
  });

  it("a synchronously-throwing listener does not stop a later listener from receiving the same event, and emit() itself does not throw", () => {
    const emitter = new LoopEventEmitter();
    const receivedB: LoopEvent[] = [];
    const reportSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitter.on(() => {
      throw new Error("listener A always throws");
    });
    emitter.on((e) => {
      receivedB.push(e);
    });

    expect(() => emitter.emit(fakeEvent())).not.toThrow();
    expect(receivedB).toHaveLength(1);
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatch(/listener threw for event "run_started"/);

    reportSpy.mockRestore();
  });

  it("a listener returning a rejected Promise does not cause emit() to throw synchronously, and the rejection is observed (not left unhandled)", async () => {
    const emitter = new LoopEventEmitter();
    const reportSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectionSettled: Promise<void> | undefined;

    emitter.on(() => {
      const p = Promise.reject(new Error("async listener rejects"));
      rejectionSettled = p.catch(() => undefined); // let the test await something, without re-throwing
      return p;
    });

    expect(() => emitter.emit(fakeEvent())).not.toThrow();

    // Give the microtask queue a turn so emit()'s internal .catch() has a chance to run.
    await rejectionSettled;
    await Promise.resolve();

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatch(/listener threw for event "run_started"/);

    reportSpy.mockRestore();
  });

  it("a listener returning undefined (a plain sync listener) is not treated as thenable and produces no reported error", () => {
    const emitter = new LoopEventEmitter();
    const reportSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitter.on(() => undefined);
    emitter.emit(fakeEvent());

    expect(reportSpy).not.toHaveBeenCalled();
    reportSpy.mockRestore();
  });

  it("emitting with zero listeners subscribed does not throw", () => {
    const emitter = new LoopEventEmitter();
    expect(() => emitter.emit(fakeEvent())).not.toThrow();
  });

  it("a listener returning a bare thenable (implements only .then, no .catch method) is still correctly isolated via Promise.resolve() wrapping — the real rejection reason is reported, not a TypeError from calling a nonexistent .catch() directly on the thenable (Zorro hardening)", async () => {
    const emitter = new LoopEventEmitter();
    const reportSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const bareThenable = {
      then(_onFulfilled: (v: void) => void, onRejected: (reason: unknown) => void) {
        onRejected(new Error("bare thenable rejects"));
      },
    };
    emitter.on(() => bareThenable as unknown as Promise<void>);

    expect(() => emitter.emit(fakeEvent())).not.toThrow();
    // `Promise.resolve(bareThenable)`'s adoption of a non-native thenable takes a few microtask hops
    // (queue the `thenable.then(...)` call, then the rejection callback, then the `.catch()` handler) —
    // a single `await Promise.resolve()` isn't reliably enough ticks. A macrotask boundary guarantees
    // every pending microtask (however many hops) has already flushed by the time it fires.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatch(/listener threw for event "run_started"/);
    // The real rejection reason made it through — not a TypeError about ".catch is not a function"
    // (which is what calling `.catch()` directly on this bare thenable, instead of
    // `Promise.resolve(thenable).catch()`, would have produced).
    expect(reportSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect((reportSpy.mock.calls[0]?.[1] as Error).message).toBe("bare thenable rejects");

    reportSpy.mockRestore();
  });
});
