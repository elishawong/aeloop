/**
 * `prompter.ts` unit tests (PRD §6.4 / §8 B3). Two halves:
 * - `InquirerPrompter` really delegates to `@inquirer/prompts`' real
 *   `confirm`/`select`/`input` with the right arguments (mocked here, since
 *   a real interactive prompt needs a real TTY — this proves the wiring,
 *   not the library's own behavior, which PRD §4 already verified against
 *   its published docs).
 * - `FakePrompter` — the scripted stand-in every other batch's tests (and
 *   B8's hard vertical slice) depend on — really consumes its per-kind
 *   queues FIFO, records every call, and throws
 *   `FakePrompterExhaustedError` when a script runs out.
 */
import { describe, expect, it, vi } from "vitest";

const confirmMock = vi.fn();
const selectMock = vi.fn();
const inputMock = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  confirm: (...args: unknown[]) => confirmMock(...args),
  select: (...args: unknown[]) => selectMock(...args),
  input: (...args: unknown[]) => inputMock(...args),
}));

const { InquirerPrompter, FakePrompter, FakePrompterExhaustedError } = await import("../prompter.js");

describe("InquirerPrompter", () => {
  it("confirm() delegates to @inquirer/prompts' confirm({message}) and returns its result", async () => {
    confirmMock.mockResolvedValueOnce(true);
    const prompter = new InquirerPrompter();
    const answer = await prompter.confirm("approve?");
    expect(confirmMock).toHaveBeenCalledWith({ message: "approve?" });
    expect(answer).toBe(true);
  });

  it("select() delegates to @inquirer/prompts' select({message, choices}) and returns its result", async () => {
    selectMock.mockResolvedValueOnce("escalate");
    const prompter = new InquirerPrompter();
    const choices = [
      { name: "Approve", value: "approved" as const },
      { name: "Escalate", value: "escalate" as const },
    ];
    const answer = await prompter.select("what next?", choices);
    expect(selectMock).toHaveBeenCalledWith({ message: "what next?", choices });
    expect(answer).toBe("escalate");
  });

  it("input() delegates to @inquirer/prompts' input({message}) and returns its result", async () => {
    inputMock.mockResolvedValueOnce("looks good to me");
    const prompter = new InquirerPrompter();
    const answer = await prompter.input("reason (optional):");
    expect(inputMock).toHaveBeenCalledWith({ message: "reason (optional):" });
    expect(answer).toBe("looks good to me");
  });
});

describe("FakePrompter", () => {
  it("confirm() consumes its scripted queue FIFO and records each call's message", async () => {
    const prompter = new FakePrompter({ confirm: [true, false] });
    expect(await prompter.confirm("first?")).toBe(true);
    expect(await prompter.confirm("second?")).toBe(false);
    expect(prompter.calls).toEqual([
      { kind: "confirm", message: "first?" },
      { kind: "confirm", message: "second?" },
    ]);
  });

  it("select() consumes its own independent queue, not confirm's", async () => {
    const prompter = new FakePrompter({ confirm: [true], select: ["revise", "force_pass"] });
    expect(await prompter.select("choose", [])).toBe("revise");
    expect(await prompter.confirm("q")).toBe(true);
    expect(await prompter.select("choose again", [])).toBe("force_pass");
  });

  it("input() consumes its own independent queue", async () => {
    const prompter = new FakePrompter({ input: ["a reason"] });
    expect(await prompter.input("why?")).toBe("a reason");
  });

  it("empty string is a legal input() answer (no required validation)", async () => {
    const prompter = new FakePrompter({ input: [""] });
    expect(await prompter.input("why?")).toBe("");
  });

  it("throws FakePrompterExhaustedError when a kind's script runs out", async () => {
    const prompter = new FakePrompter({ confirm: [true] });
    await prompter.confirm("q1");
    await expect(prompter.confirm("q2")).rejects.toBeInstanceOf(FakePrompterExhaustedError);
  });

  it("throws FakePrompterExhaustedError for select/input with no script at all", async () => {
    const prompter = new FakePrompter();
    await expect(prompter.select("q", [])).rejects.toBeInstanceOf(FakePrompterExhaustedError);
    await expect(prompter.input("q")).rejects.toBeInstanceOf(FakePrompterExhaustedError);
    await expect(prompter.confirm("q")).rejects.toBeInstanceOf(FakePrompterExhaustedError);
  });
});
