/**
 * Role → output-schema registry, kept **outside** `composer.ts` (review,
 * feature/issue-1-a0-a1-scaffold): the prior implementation defined
 * `OUTPUT_SCHEMAS = { coder: CoderOutput, tester: TesterOutput }` as a
 * private constant inside `composer.ts` itself — that's the exact "hardcoded
 * {coder,tester}" shape DESIGN §1.7 calls out for *personas* ("persona/schema
 * is looked up dynamically by role name via the registry, instead of the
 * hardcoded `{coder,tester}` Record a prior internal implementation used —
 * adding a role doesn't require touching the composer"), just repeated one
 * layer over for schemas. Registering a new role's schema now means building a
 * `SchemaRegistry` object at the call site (e.g. `{
 * ...DEFAULT_OUTPUT_SCHEMAS, reviewer: ReviewerOutput }`) and passing it
 * into `PromptComposer`'s constructor — never editing this file or
 * `composer.ts`.
 *
 * A registry entry is `z.ZodType | null`, not just `z.ZodType | undefined`
 * (absent key): `null` is an *explicit* "this role deliberately has no
 * structured output schema" registration (e.g. a free-text "reviewer"
 * role), distinct from "this role was never registered at all" (a missing
 * key). `PromptComposer.compose()` throws `SchemaNotRegisteredError` for
 * the latter — an unregistered role is very likely a caller mistake (a new
 * role added to `personas/` whose schema wiring was simply forgotten), and
 * the previous silent-omit behavior is exactly what let that mistake pass
 * unnoticed (PRD §5 / review: "unknown roles silently drop the contract").
 */
import type { z } from "zod";
import { CoderOutput, TesterOutput } from "./schema.js";

export type SchemaRegistry = Readonly<Record<string, z.ZodType | null>>;

/** Default registry for the two roles this increment ships personas for. */
export const DEFAULT_OUTPUT_SCHEMAS: SchemaRegistry = {
  coder: CoderOutput,
  tester: TesterOutput,
};

/**
 * `role` has no entry at all in the `SchemaRegistry` passed to
 * `PromptComposer` — not even an explicit `null` opt-out. Thrown by
 * `compose()` instead of silently omitting the "Output Schema" section, so
 * an unwired role fails loudly instead of quietly shipping a prompt with
 * no structured-output contract.
 */
export class SchemaNotRegisteredError extends Error {
  readonly role: string;

  constructor(role: string) {
    super(
      `No output-schema registry entry for role "${role}": register it in the ` +
        `SchemaRegistry passed to PromptComposer — with a zod schema, or ` +
        `\`null\` to explicitly opt this role out of a structured-output section.`,
    );
    this.name = "SchemaNotRegisteredError";
    this.role = role;
  }
}
