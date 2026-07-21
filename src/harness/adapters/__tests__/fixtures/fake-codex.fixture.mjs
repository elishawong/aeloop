#!/usr/bin/env node
// fake-codex.fixture.mjs — a controlled stand-in for the real `codex`
// binary (never spawned in production, never a real `codex exec` call).
// Originally used ONLY by codex-cli-adapter.test.ts; as of A4a it is also
// spawned by src/loop.e2e.test.ts (the "tester-pass" scenario below, PRD
// §5's B5 vertical slice — see the "A4a addition" note further down for
// why). A3 PRD §5/§6's "real but controlled" test strategy: CodexCliAdapter
// really `spawn()`s this file as a real child process and really parses its
// real stdout — the only thing replaced is "the actual codex binary",
// mirroring how A2's LiteLLMAdapter tests spin up a real local `node:http`
// server instead of mocking `fetch`.
//
// Plain `.mjs`, not `.ts` — deliberately outside both `tsc` (tsconfig.json
// only includes `src/**/*.ts`) and vitest's test discovery (`vitest.config.ts`
// only includes `src/**/*.test.ts`), so it never leaks into the compiled
// package or gets mistaken for a test file.
//
// Scenario selected via FAKE_CODEX_SCENARIO env var (set by the test before
// spawning), OR via `--version` as the first arg (mirrors how
// `checkAvailability()` really invokes codex). Two of the scenarios below
// (`with-tools`, `no-tools`) print JSONL copied verbatim (same event
// types/fields/values, reconstructed as JS objects rather than hand-escaped
// strings to avoid transcription bugs) from spike-findings.md §1.3's real
// `codex exec --json` captures (issue #10's spike) — not invented. The rest
// (`claims-no-trace`, `claims-with-trace`, `error`, `no-agent-message`,
// `final-text-non-string`, `null-line-then-hello`) are constructed: the
// spike never ran a schema-shaped prompt (with or without tool use),
// captured a non-zero exit, or produced a malformed agent_message/JSONL
// line, so there is no verbatim sample for those — needed to exercise
// ToolExecVerifier's "fail"/"pass" paths, AdapterInvokeError's non-zero-exit
// path, and (Zorro A3 round-1 B1/Y2) the "don't silently fall back to an
// earlier answer" and "don't crash on a non-object JSONL line" regressions,
// at the adapter (and, for `claims-with-trace`, the full
// harness-cli.e2e.test.ts B6 slice) level, built with the same real event
// *shape* as the verbatim samples — `claims-with-trace` specifically
// combines `with-tools`' real command_execution pair with
// `claims-no-trace`'s CoderOutput-shaped final text, so it's the one
// scenario that's simultaneously "schema-valid" and "trace non-empty"
// (needed for B6's "pass" assertion; A3 PRD §5/§6's B6 task description).
//
// **A4a addition**: `tester-pass` (added for `src/loop.e2e.test.ts`'s B5
// vertical slice, PRD §5's "如果没有完全匹配的,按 A3 B3/B4 已经建立的
// 模式各自新增一个,不复制整份新文件"). Every prior scenario here emits
// `CoderOutput`-shaped JSON (`{diff, claims[], confidence}`) because A3's
// own tests only ever routed `codex-cli` to the `coder` role; A4a's
// vertical slice binds `codex-cli` to the `tester` role instead (DESIGN
// §7's real `profiles/subscription/config.yaml` binding), so it needs a
// scenario whose final agent_message is `TesterOutput`-shaped
// (`{verdict, issues[], claims[], confidence}`) instead — constructed, no
// verbatim spike capture exists for a tester-shaped response either.
//
// **Zorro A3 round-1 minor Y4**: every branch sets `process.exitCode`
// instead of calling `process.exit()` — `process.exit()` called
// immediately after an async `stdout.write()` can truncate output that
// hasn't finished flushing through the pipe yet (Node's docs explicitly
// warn about this); `process.exitCode` lets the script finish normally and
// Node drains stdio before actually exiting. No branch in this file calls
// `process.exit()` anymore, including `--version`/`error`/`default` — the
// whole script is now one `if/else` + `switch` with no early-exit calls,
// so setting `exitCode` and falling through to the end of the script is
// always safe.

const args = process.argv.slice(2);

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

if (args[0] === "--version") {
  // Real version string from the spike's environment (spike-findings.md §1).
  process.stdout.write("codex-cli 0.144.1\n");
  process.exitCode = 0;
} else {
  const scenario = process.env.FAKE_CODEX_SCENARIO ?? "with-tools";

  switch (scenario) {
  case "with-tools": {
    // Verbatim (as data) from spike-findings.md §1.3 — the `fileB.txt`
    // capture, prompt: "List the files in the current directory, then read
    // fileB.txt and tell me what it says."
    emit({ type: "thread.started", thread_id: "019f7eec-21a0-7773-97a0-d856c70ba65f" });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "I'll inspect the current directory and read `fileB.txt`." },
    });
    const command =
      "/bin/zsh -lc \"pwd && rg --files -g '*' -0 | sort -z | xargs -0 -n1 printf '%s\\\\n' && sed -n '1,240p' fileB.txt\"";
    emit({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "command_execution",
        command,
        aggregated_output:
          "/private/tmp/.../scratchpad/spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file B\n",
        exit_code: 0,
        status: "completed",
      },
    });
    emit({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "agent_message",
        text: 'Files in the current directory:\n\n- `fileA.txt`\n- `fileB.txt`\n\n`fileB.txt` says: "hello world spike file B"',
      },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 34509, cached_input_tokens: 26112, output_tokens: 189, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "no-tools": {
    // Verbatim (as data) from spike-findings.md §1.3 — the negative
    // control, prompt: "Just say hello, do not use any tools."
    emit({ type: "thread.started", thread_id: "019f7eec-7614-7af1-926f-0913fc9f6c86" });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello!" } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 17125, cached_input_tokens: 9984, output_tokens: 6, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "claims-no-trace": {
    // Constructed (not a verbatim spike capture — spike never ran a
    // schema-shaped prompt without tool use): a final agent_message whose
    // text is a CoderOutput-shaped JSON string (src/prompt/schema.ts)
    // claiming `verifiedBy: "tool_execution"`, with NO command_execution
    // events anywhere in the stream — exercises checkToolExecution()'s
    // "declared but trace empty -> fail" path at the real adapter layer.
    const claimedContent = JSON.stringify({
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [
        {
          claimText: "the tests were run and passed",
          confidence: "verified",
          sourceRef: "test output",
          verifiedBy: "tool_execution",
        },
      ],
      confidence: "verified",
    });
    emit({ type: "thread.started", thread_id: "fixture-claims-no-trace" });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: claimedContent } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "claims-with-trace": {
    // Constructed (see file header) — combines a real command_execution
    // pair (same shape as "with-tools") with a final agent_message whose
    // text is CoderOutput-shaped JSON claiming `verifiedBy: "tool_execution"`
    // — the one scenario where checkToolExecution() should resolve to
    // "pass" (claim asserted AND trace non-empty). Used by
    // harness-cli.e2e.test.ts (B6) to exercise the full pass path
    // end-to-end, not just at the adapter unit-test layer.
    const claimedContent = JSON.stringify({
      diff: "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      claims: [
        {
          claimText: "the tests were run and passed",
          confidence: "verified",
          sourceRef: "test output",
          verifiedBy: "tool_execution",
        },
      ],
      confidence: "verified",
    });
    const command = "/bin/zsh -lc \"pwd && pnpm test\"";
    emit({ type: "thread.started", thread_id: "fixture-claims-with-trace" });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "I'll run the tests to verify the change." },
    });
    emit({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command, aggregated_output: "", exit_code: null, status: "in_progress" },
    });
    emit({
      type: "item.completed",
      item: { id: "item_1", type: "command_execution", command, aggregated_output: "9 passed\n", exit_code: 0, status: "completed" },
    });
    emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: claimedContent } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "tester-pass": {
    // Constructed (A4a addition, see file header) — a final agent_message
    // whose text is TesterOutput-shaped JSON with `verdict: "pass"`, used
    // by `src/loop.e2e.test.ts`'s B5 happy-path vertical slice (tester
    // role bound to codex-cli, per the real config.yaml's DESIGN §7
    // binding). No command_execution events — this scenario isn't
    // exercising ToolExecVerifier, just proving the tester role's real
    // cli-bridge round trip produces a schema-valid TesterOutput.
    const testerContent = JSON.stringify({
      verdict: "pass",
      issues: [],
      claims: [
        { claimText: "the diff compiles and the described change is present", confidence: "verified", sourceRef: "diff review" },
      ],
      confidence: "verified",
    });
    emit({ type: "thread.started", thread_id: "fixture-tester-pass" });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: testerContent } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "error": {
    // Constructed non-zero-exit scenario (spike never captured a real
    // codex failure) — exercises AdapterInvokeError's non-zero-exit path.
    process.stderr.write("codex: fatal: something broke\n");
    process.exitCode = 1;
    break;
  }

  case "no-agent-message": {
    // Constructed anomalous-output scenario: a turn that never produces
    // any agent_message at all — exercises the "content === undefined"
    // AdapterInvokeError path.
    emit({ type: "thread.started", thread_id: "fixture-no-agent-message" });
    emit({ type: "turn.started" });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "final-text-non-string": {
    // Constructed (Zorro A3 round-1 blocker B1's regression fixture): an
    // early, valid-looking agent_message, followed by the TRUE final
    // agent_message whose `.text` is an object, not a string. Before the
    // B1 fix, `extractLastAgentMessageText` only updated its "last seen"
    // tracker when `.text` was already a string, so this exact shape made
    // the adapter silently return the EARLY message's text instead of
    // throwing — reintroducing the "trust a mid-turn answer that got
    // corrected later" hallucination spike-findings.md §1.4 exists to
    // prevent. Correct behavior: throw AdapterInvokeError, never fall back.
    emit({ type: "thread.started", thread_id: "fixture-final-text-non-string" });
    emit({ type: "turn.started" });
    emit({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: "This is an early, valid-looking answer that must NOT be returned.",
      },
    });
    emit({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: { unexpected: "an object, not a string" } },
    });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  case "null-line-then-hello": {
    // Constructed (Zorro A3 round-1 minor Y2's regression fixture): a raw
    // `null` JSONL line (valid JSON, not an object) mixed in among
    // otherwise-valid lines. Before the Y2 fix, `parseJsonlEvents` accepted
    // any value `JSON.parse` could produce, so this `null` line became an
    // "event" with no `.type` property — every downstream `event.type`
    // read (`null.type`) threw a raw, uncaught `TypeError`, escaping the
    // "adapters only ever throw AdapterInvokeError" contract. Correct
    // behavior: the null line is silently skipped, the rest of the stream
    // parses normally, content is the real final answer.
    process.stdout.write("null\n");
    emit({ type: "thread.started", thread_id: "fixture-null-line" });
    emit({ type: "turn.started" });
    emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello despite the null line!" } });
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    process.exitCode = 0;
    break;
  }

  default: {
    process.stderr.write(`fake-codex.fixture.mjs: unknown FAKE_CODEX_SCENARIO "${scenario}"\n`);
    process.exitCode = 1;
  }
  }
}
