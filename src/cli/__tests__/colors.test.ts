/**
 * `colors.ts` theming-helper unit tests (PRD §6.2 / §8 B1). Real ANSI
 * substrings, same posture as `diff-render.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { danger, escalationBanner, heading, ok, warn } from "../colors.js";

const CYAN = "[36m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const BOLD = "[1m";
const BG_YELLOW = "[43m";

describe("colors", () => {
  it("heading() is bold + cyan", () => {
    const out = heading("G1: approve?");
    expect(out).toContain(BOLD);
    expect(out).toContain(CYAN);
    expect(out).toContain("G1: approve?");
  });

  it("ok() is green", () => {
    expect(ok("approved")).toContain(GREEN);
  });

  it("warn() is yellow", () => {
    expect(warn("careful")).toContain(YELLOW);
  });

  it("danger() is red", () => {
    expect(danger("rejected")).toContain(RED);
  });

  it("escalationBanner() is structurally distinct — bold-on-yellow-background framing, not merely a foreground color", () => {
    const out = escalationBanner("reject_count reached the threshold");
    expect(out).toContain(BG_YELLOW);
    expect(out).toContain(BOLD);
    expect(out).toContain("ESCALATION");
    expect(out).toContain("reject_count reached the threshold");
    // Structurally different from ok()/warn()/danger() — those are single-line, foreground-only.
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("escalationBanner()'s frame lines are distinct from ok()/warn()/danger()'s plain foreground coloring", () => {
    const banner = escalationBanner("x");
    const plain = danger("x");
    expect(banner).not.toBe(plain);
    expect(banner).toContain(BG_YELLOW);
    expect(plain).not.toContain(BG_YELLOW);
  });
});
