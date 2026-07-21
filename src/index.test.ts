import { describe, expect, it } from "vitest";
import * as aeloop from "./index.js";

/**
 * Asserts the root barrel re-exports the intentional public API surface.
 * Not exhaustive — just enough runtime coverage to catch a broken/missing
 * re-export path in src/index.ts without duplicating the full test suite.
 */
describe("root barrel (src/index.ts)", () => {
  it("exports the loop runner surface", () => {
    expect(typeof aeloop.startRun).toBe("function");
    expect(typeof aeloop.resumeRun).toBe("function");
    expect(typeof aeloop.getResumableRuns).toBe("function");
    expect(typeof aeloop.getPendingInterrupt).toBe("function");
  });

  it("exports the audit store and checkpointer", () => {
    expect(typeof aeloop.AuditStore).toBe("function");
    expect(typeof aeloop.createSqliteCheckpointer).toBe("function");
  });

  it("exports loop events", () => {
    expect(typeof aeloop.LoopEventEmitter).toBe("function");
  });

  it("exports the harness surface", () => {
    expect(typeof aeloop.ProviderRouter).toBe("function");
    expect(typeof aeloop.AdapterRegistry).toBe("function");
    expect(typeof aeloop.buildAdapterRegistry).toBe("function");
  });

  it("exports harness errors", () => {
    expect(typeof aeloop.AdapterInvokeError).toBe("function");
    expect(typeof aeloop.RoleNotBoundError).toBe("function");
    expect(typeof aeloop.AdapterNotRegisteredError).toBe("function");
    expect(typeof aeloop.InvalidProviderConfigError).toBe("function");
    expect(typeof aeloop.SchemaValidationError).toBe("function");
  });

  it("exports loop errors", () => {
    expect(typeof aeloop.UnhandledGateDecisionError).toBe("function");
    expect(typeof aeloop.AuditReadError).toBe("function");
    expect(typeof aeloop.RunThreadMismatchError).toBe("function");
    expect(typeof aeloop.ResumeDecisionDomainMismatchError).toBe("function");
  });
});
