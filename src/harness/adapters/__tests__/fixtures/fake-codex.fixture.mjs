#!/usr/bin/env node
// fake-codex.fixture.mjs — a controlled stand-in for the real `codex`
// binary, used ONLY by codex-cli-adapter.test.ts (never spawned in
// production, never a real `codex exec` call). A3 PRD §5/§6's "real but
// controlled" test strategy: CodexCliAdapter really `spawn()`s this file
// as a real child process and really parses its real stdout — the only
// thing replaced is "the actual codex binary", mirroring how A2's
// LiteLLMAdapter tests spin up a real local `node:http` server instead of
// mocking `fetch`.
//
// Plain `.mjs`, not `.ts` — deliberately outside both `tsc` (tsconfig.json
// only includes `src/**/*.ts`) and vitest's test discovery (`vitest.config.ts`
// only includes `src/**/*.test.ts`), so it never leaks into the compiled
// package or gets mistaken for a test file.
//
// Scenario selected via FAKE_CODEX_SCENARIO env var (set by the test before
// spawning), OR via `--version` as the first arg (mirrors how
// `checkAvailability()` really invokes codex). Two of the four scenarios
// below (`with-tools`, `no-tools`) print JSONL copied verbatim (same event
// types/fields/values, reconstructed as JS objects rather than hand-escaped
// strings to avoid transcription bugs) from spike-findings.md §1.3's real
// `codex exec --json` captures (issue #10's spike) — not invented. The
// other two (`claims-no-trace`, `error`) are constructed: the spike never
// ran a schema-shaped prompt without tool use, or captured a non-zero exit,
// so there is no verbatim sample for those — needed to exercise
// ToolExecVerifier's "fail" path and AdapterInvokeError's non-zero-exit
// path at the adapter level, built with the same real event *shape* as the
// verbatim samples.

const args = process.argv.slice(2);

if (args[0] === "--version") {
  // Real version string from the spike's environment (spike-findings.md §1).
  process.stdout.write("codex-cli 0.144.1\n");
  process.exit(0);
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

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
    process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
    break;
  }

  case "error": {
    // Constructed non-zero-exit scenario (spike never captured a real
    // codex failure) — exercises AdapterInvokeError's non-zero-exit path.
    process.stderr.write("codex: fatal: something broke\n");
    process.exit(1);
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
    process.exit(0);
    break;
  }

  default: {
    process.stderr.write(`fake-codex.fixture.mjs: unknown FAKE_CODEX_SCENARIO "${scenario}"\n`);
    process.exit(1);
  }
}
