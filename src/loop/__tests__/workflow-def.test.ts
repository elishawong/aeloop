/**
 * `CODER_TESTER_LOOP_DEFINITION.nodes` and `LOOP_NODES`'s values must stay
 * in lockstep (PRD §5 "workflow-def.test.ts") — this is the only automated
 * check tying the two together (see workflow-def.ts's file header: there is
 * no runtime link between the documentation object and `graph.ts`'s real
 * `addNode` calls, so this test is what would catch someone adding a
 * seventh `LOOP_NODES` entry without updating the definition, or vice versa).
 */
import { describe, expect, it } from "vitest";
import { CODER_TESTER_LOOP_DEFINITION, GATE_TYPES, LOOP_NODES } from "../workflow-def.js";

describe("CODER_TESTER_LOOP_DEFINITION", () => {
  it("lists exactly the same node names as LOOP_NODES's values", () => {
    expect(new Set(CODER_TESTER_LOOP_DEFINITION.nodes)).toEqual(new Set(Object.values(LOOP_NODES)));
  });

  it("LOOP_NODES has the six real A4a nodes, no more, no less", () => {
    expect(Object.keys(LOOP_NODES).sort()).toEqual(["apply", "draft", "g1", "g2", "g3", "review"]);
  });

  it("GATE_TYPES has exactly the A4a three, not the A4b-only ESCALATION_ACK", () => {
    expect(Object.values(GATE_TYPES).sort()).toEqual(["G1_SEND_TO_TESTER", "G2_SEND_TO_FIX", "G3_FINAL_MERGE"]);
  });
});
