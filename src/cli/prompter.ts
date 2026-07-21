/**
 * `Prompter` — the interface `run-loop.ts`/`main.ts` ask a human decision
 * through, and the seam that makes both unit-testable without a real
 * terminal (PRD §6.4). Production code only ever constructs
 * `InquirerPrompter` (thin wrapper over `@inquirer/prompts`' `confirm`/
 * `select`/`input`, verified against that library's own published API —
 * PRD §9's judgment-call sourcing). Tests (and B8's hard vertical slice)
 * use `FakePrompter`, a scripted stand-in — the same "explicit fake behind
 * an interface" pattern this codebase already uses for `ModelAdapter`/
 * `FakeAdapter` throughout `src/loop/__tests__/`.
 */
import { confirm, input, select } from "@inquirer/prompts";

export interface Prompter {
  confirm(message: string): Promise<boolean>;
  select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T>;
  /** Free-text reason; empty string is a legal answer (no `required` validation). */
  input(message: string): Promise<string>;
}

export class InquirerPrompter implements Prompter {
  async confirm(message: string): Promise<boolean> {
    return confirm({ message });
  }

  async select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T> {
    return select<T>({ message, choices });
  }

  async input(message: string): Promise<string> {
    return input({ message });
  }
}

/**
 * Errors thrown when a `FakePrompter`'s scripted answers run out — this is
 * a test-authoring bug (the script didn't anticipate how many prompts the
 * run would actually make), not a runtime condition production code needs
 * to handle, so it's a plain `Error`, not one of `src/cli/errors.ts`'s
 * typed CLI errors.
 */
export class FakePrompterExhaustedError extends Error {
  constructor(kind: "confirm" | "select" | "input") {
    super(`FakePrompter: ran out of scripted "${kind}" answers`);
    this.name = "FakePrompterExhaustedError";
  }
}

/**
 * Scripted `Prompter` for tests. Each answer kind has its own independent
 * queue (`confirm`/`select`/`input` calls don't share one ordering — a test
 * scripts exactly the sequence of decisions it expects for whichever gate
 * shape it's driving), consumed FIFO. Every call is recorded in `calls` so
 * a test can assert on the exact `message` text a prompt was shown, not
 * just the answer it got back. `select()` calls also record the `choices`
 * array's `value`s it was asked with (Zorro re-review "🟡" item 1,
 * `docs/feature/a5-cli-tui/test-report.md`) — before this fix, `_choices`
 * was silently discarded, so no test could actually assert on *which*
 * choices a given `select()` call was constructed with, only that
 * `select()` was called at all.
 */
export class FakePrompter implements Prompter {
  readonly calls: Array<{ kind: "confirm" | "select" | "input"; message: string; choices?: string[] }> = [];

  private readonly confirmAnswers: boolean[];
  private readonly selectAnswers: string[];
  private readonly inputAnswers: string[];

  constructor(script: { confirm?: boolean[]; select?: string[]; input?: string[] } = {}) {
    this.confirmAnswers = [...(script.confirm ?? [])];
    this.selectAnswers = [...(script.select ?? [])];
    this.inputAnswers = [...(script.input ?? [])];
  }

  async confirm(message: string): Promise<boolean> {
    this.calls.push({ kind: "confirm", message });
    const next = this.confirmAnswers.shift();
    if (next === undefined) throw new FakePrompterExhaustedError("confirm");
    return next;
  }

  async select<T extends string>(message: string, choices: { name: string; value: T }[]): Promise<T> {
    this.calls.push({ kind: "select", message, choices: choices.map((c) => c.value) });
    const next = this.selectAnswers.shift();
    if (next === undefined) throw new FakePrompterExhaustedError("select");
    return next as T;
  }

  async input(message: string): Promise<string> {
    this.calls.push({ kind: "input", message });
    const next = this.inputAnswers.shift();
    if (next === undefined) throw new FakePrompterExhaustedError("input");
    return next;
  }
}
