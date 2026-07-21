import { createHash } from "node:crypto";
import { estimateTokens } from "../context/budget.js";

export interface PromptSnapshot {
  readonly stable: string;
  readonly dynamic: Readonly<Record<string, string>>;
}

export interface PromptDelta {
  readonly changed: Readonly<Record<string, string>>;
  readonly removed: readonly string[];
  readonly estimatedTokens: number;
  readonly snapshotHash: string;
}

/** Build the smallest dynamic prompt update while keeping the stable prefix
 * outside the delta so providers can cache it. */
export function buildPromptDelta(previous: PromptSnapshot | undefined, current: PromptSnapshot): PromptDelta {
  const changed: Record<string, string> = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(current.dynamic)) {
    if (previous?.dynamic[key] !== value) changed[key] = value;
  }
  for (const key of Object.keys(previous?.dynamic ?? {})) {
    if (!(key in current.dynamic)) removed.push(key);
  }
  const canonical = `${current.stable}\n${Object.keys(current.dynamic).sort().map((key) => `${key}=${current.dynamic[key]}`).join("\n")}`;
  return { changed, removed, estimatedTokens: Object.values(changed).reduce((sum, value) => sum + estimateTokens(value), 0), snapshotHash: createHash("sha256").update(canonical).digest("hex") };
}
