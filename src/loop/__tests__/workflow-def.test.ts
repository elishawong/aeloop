/**
 * `CODER_TESTER_LOOP_DEFINITION.nodes` and `LOOP_NODES`'s values must stay
 * in lockstep (PRD §5 "workflow-def.test.ts") — this is the only automated
 * check tying the two together (see workflow-def.ts's file header: there is
 * no runtime link between the documentation object and `graph.ts`'s real
 * `addNode` calls, so this test is what would catch someone adding a
 * ninth `LOOP_NODES` entry without updating the definition, or vice versa).
 *
 * A4b (docs/feature/a4b-loop/PRD.md §4.1/§5) grows this from A4a's six
 * nodes/three gate types to eight nodes/four gate types — `escalation`/
 * `cancel` + `ESCALATION_ACK`.
 */
import { describe, expect, it } from "vitest";
import { CODER_TESTER_LOOP_DEFINITION, GATE_TYPES, LOOP_NODES } from "../workflow-def.js";

describe("CODER_TESTER_LOOP_DEFINITION", () => {
  it("lists exactly the same node names as LOOP_NODES's values", () => {
    expect(new Set(CODER_TESTER_LOOP_DEFINITION.nodes)).toEqual(new Set(Object.values(LOOP_NODES)));
  });

  it("LOOP_NODES has the eight real A4b nodes, no more, no less", () => {
    expect(Object.keys(LOOP_NODES).sort()).toEqual(["apply", "cancel", "draft", "escalation", "g1", "g2", "g3", "review"]);
  });

  it("GATE_TYPES has all four A4b gate types, including ESCALATION_ACK", () => {
    expect(Object.values(GATE_TYPES).sort()).toEqual([
      "ESCALATION_ACK",
      "G1_SEND_TO_TESTER",
      "G2_SEND_TO_FIX",
      "G3_FINAL_MERGE",
    ]);
  });
});
