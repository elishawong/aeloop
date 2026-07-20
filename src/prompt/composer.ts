/**
 * `PromptComposer` — the piece that actually builds "a well-formed prompt"
 * (docs/DESIGN.md §1.5's Prompt-layer row: "← Context 的记忆;→ 一个
 * well-formed prompt"). Takes a role name, an already-injected/filtered
 * context (`ContextInjector`'s output, B5), and a task description, and
 * produces the final prompt string: persona text + (when this role has one)
 * an output-schema description + the injected memories + the task.
 *
 * Dependency direction (PRD §10 constraint, verified by `grep` after
 * writing this file): only *type-only* imports from `../context/injector.js`
 * for the injector's output shape (`ContextInjectionResult`/`InjectedMemory`/
 * `InjectionWarning`) — never `MemoryStore`, `StalenessEngine`, or the
 * `ContextInjector` class itself. This module has no idea *how* those
 * memories were fetched or filtered, only what shape they arrive in.
 *
 * `rejected` memories are never handled here — by the time a
 * `ContextInjectionResult` reaches this module, `ContextInjector` (B5) has
 * already dropped every `confidence_state === "rejected"` memory (PRD §5:
 * "rejected 已被上游滤掉,不需要 composer 重复过滤"). This module trusts
 * that contract and renders whatever it's handed, whole — see
 * `composer.test.ts`'s "does not re-filter" case for what that means in
 * practice: even a hand-built injection result smuggling in a
 * `confidenceState: "rejected"` memory still gets rendered, because
 * filtering-by-confidence is simply not this layer's job.
 */
import { z } from "zod";
import type { ContextInjectionResult, InjectedMemory, InjectionWarning } from "../context/injector.js";
import type { Role } from "../shared/types.js";
import { loadPersona } from "./personas.js";
import { CoderOutput, TesterOutput } from "./schema.js";

/**
 * Role → output-schema lookup, DESIGN §1.7's "按角色名动态查 registry"
 * applied to schemas the same way `personas.ts` applies it to persona
 * files: a plain keyed lookup, never an `if (role === "coder")` branch.
 * Unlike personas (one `.md` file per role, discovered from disk), there is
 * no per-role schema *file* convention in this increment — B6 defines a
 * fixed, small set of named schemas — so the registry lives here as a plain
 * object rather than a filesystem scan. A role with no entry here (a future
 * role this increment doesn't know about) isn't an error: `compose()`
 * simply omits the "Output Schema" section for it rather than throwing,
 * which keeps "add a role" from requiring an edit to this file's error
 * handling — only an addition to this map when that new role does need
 * structured-output validation.
 */
const OUTPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  coder: CoderOutput,
  tester: TesterOutput,
};

export class PromptComposer {
  /**
   * `personasDir` is an explicit parameter (typically
   * `path.join(profileLoadResult.profileDir, "personas")`), matching the
   * same "explicit path in, no implicit profile coupling" shape used by
   * `context/store.ts` (explicit `dbPath`) and `profile/loader.ts`
   * (explicit `profilesRoot`) — this module doesn't know about
   * `profile/loader.ts` at all.
   */
  constructor(private readonly personasDir: string) {}

  compose(role: Role, context: ContextInjectionResult, task: string): string {
    const persona = loadPersona(role, this.personasDir).trim();

    const sections: string[] = [`# Persona\n\n${persona}`];

    const schema = OUTPUT_SCHEMAS[role];
    if (schema) {
      const jsonSchema = z.toJSONSchema(schema);
      sections.push(
        `# Output Schema\n\nRespond with JSON matching this schema:\n\n${JSON.stringify(jsonSchema, null, 2)}`,
      );
    }

    sections.push(`# Context\n\n${formatMemories(context.memories)}`);
    sections.push(`# Task\n\n${task}`);

    return sections.join("\n\n---\n\n");
  }
}

function formatMemories(memories: InjectedMemory[]): string {
  if (memories.length === 0) return "(no memories injected)";
  return memories.map(formatMemory).join("\n\n");
}

function formatMemory(entry: InjectedMemory): string {
  const label = warningLabel(entry.warning);
  const header = label ? `- [${label}] ${entry.memory.title}` : `- ${entry.memory.title}`;
  return `${header}\n  ${entry.memory.content}`;
}

/**
 * Renders the injector's `InjectionWarning` ("stale" | "unconfirmed" | null)
 * as visible prompt text — this is what makes stale/unconfirmed memories
 * "kept but flagged" (PRD §5) actually observable in the final prompt,
 * rather than just an internal field nothing downstream ever surfaces.
 */
function warningLabel(warning: InjectionWarning): string | null {
  return warning === null ? null : `warning: ${warning}`;
}
