import { readFileSync } from "node:fs";
import { assertValidTaskContract } from "../conductor/contract.js";
import type { TaskContract } from "../conductor/types.js";

export function loadTaskContract(filePath: string): TaskContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw new Error(`failed to read task contract ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  assertValidTaskContract(parsed);
  return parsed;
}
