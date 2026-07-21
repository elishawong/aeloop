#!/usr/bin/env node
// fake-claude.fixture.mjs — a controlled stand-in for the real `claude`
// binary, used ONLY by claude-cli-adapter.test.ts (never spawned in
// production, never a real `claude -p` call). Same "real but controlled"
// strategy as fake-codex.fixture.mjs: ClaudeCliAdapter really `spawn()`s
// this file and really parses its real stdout.
//
// Plain `.mjs`, outside both `tsc` and vitest's test discovery (same
// reasoning as fake-codex.fixture.mjs's header).
//
// Scenario selected via FAKE_CLAUDE_SCENARIO env var, or `--version` as the
// first arg (mirrors how checkAvailability() really invokes claude).
//
// `with-tools` is copied (as data — reconstructed as JS objects, not
// hand-escaped strings) from spike-findings.md §2.2's real
// `claude -p ... --output-format stream-json --verbose` capture, PLUS a
// leading `system`/`subtype:"init"` event — that event type IS real (it's
// how ClaudeCliAdapter extracts `model`) but spike-findings.md's §2.2
// "key lines excerpted" only quoted the tool_use/tool_result/result lines, not the
// init line verbatim; the model value used here ("claude-sonnet-5") and
// permissionMode ("bypassPermissions") are the real values observed
// earlier in the same spike session, not invented.
//
// `no-tools` is CONSTRUCTED, not a verbatim spike capture — spike-findings.md
// §3.1 explicitly flagged that claude's negative control was never
// independently run (only inferred by symmetry with codex's verified one).
// This fixture scenario, and the test that uses it, is what closes that
// gap per A3 PRD §0 decision 3.
//
// `claims-no-trace` and `result-error` are also constructed (same reasoning
// as fake-codex.fixture.mjs's equivalents) — needed to exercise
// ToolExecVerifier's "fail" path and the "result event reports failure"
// path at the adapter level; spike never ran either scenario.
//
// `result-is-error-missing` and `null-line-then-hello` are A3's Review
// Round-1 regression fixtures (minor Y1/Y2) — see their case bodies below
// for what each one guards against.
//
// **A3's Review Round-1 minor Y4**: every branch sets `process.exitCode`
// instead of calling `process.exit()` (which can truncate an async
// `stdout.write()` that hasn't finished flushing through the pipe yet).
// No branch in this file calls `process.exit()` — the whole script is one
// `if/else` + `switch` with no early-exit calls, so setting `exitCode` and
// falling through to the end is always safe.
//
// **A5 re-review addition (P1-4's "🟡" item 4, `docs/feature/a5-cli-tui/
// test-report.md`)**: when `FAKE_CLAUDE_PROMPT_CAPTURE_FILE` is set, this
// fixture appends the real `-p <prompt>` text it received to that file,
// opt-in and additive only — every existing scenario/test that doesn't set
// this env var behaves exactly as before. This exists so
// `src/cli.e2e.test.ts` (B8) can assert the *content* PromptComposer/
// ContextInjector actually assembled (e.g. a seeded memory) really reached
// the coder subprocess's real argv, not just that some prompt was sent.
import fs from "node:fs";

const args = process.argv.slice(2);

const promptCaptureFile = process.env.FAKE_CLAUDE_PROMPT_CAPTURE_FILE;
if (promptCaptureFile && args[0] === "-p" && typeof args[1] === "string") {
  fs.appendFileSync(promptCaptureFile, args[1] + "\n---FAKE_CLAUDE_PROMPT_BOUNDARY---\n");
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

function initEvent(model) {
  return {
    type: "system",
    subtype: "init",
    session_id: "fixture-session",
    model,
    permissionMode: "bypassPermissions",
  };
}

if (args[0] === "--version") {
  // Real version string from the spike's environment (spike-findings.md §2.5).
  process.stdout.write("2.1.215 (Claude Code)\n");
  process.exitCode = 0;
} else {
  const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "with-tools";

  switch (scenario) {
  case "with-tools": {
    // Reconstructed as data from spike-findings.md §2.2's real capture,
    // prompt: "List the files in the current directory and read fileB.txt,
    // tell me what it says."
    emit(initEvent("claude-sonnet-5"));
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_01TF9wjf6yW3W4RvcYoSMZSM",
            name: "Bash",
            input: { command: "ls -la", description: "List files in current directory" },
            caller: { type: "direct" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        content: [
          {
            tool_use_id: "toolu_01TF9wjf6yW3W4RvcYoSMZSM",
            type: "tool_result",
            content: "total 16\ndrwxr-xr-x ...\nfileA.txt\nfileB.txt",
            is_error: false,
          },
        ],
      },
      tool_use_result: { stdout: "total 16\n...\nfileA.txt\nfileB.txt", stderr: "", interrupted: false },
    });
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_01VWt8Hpo7EG7cuVatU3ZoaZ",
            name: "Read",
            input: { file_path: "/private/tmp/.../spike-testdir/fileB.txt" },
            caller: { type: "direct" },
          },
        ],
      },
    });
    emit({
      type: "user",
      message: {
        content: [{ tool_use_id: "toolu_01VWt8Hpo7EG7cuVatU3ZoaZ", type: "tool_result", content: "1\thello world spike file B\n2\t" }],
      },
      tool_use_result: {
        type: "text",
        file: { filePath: "/private/tmp/.../spike-testdir/fileB.txt", content: "hello world spike file B\n" },
      },
    });
    emit({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: "fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`.",
          },
        ],
      },
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 3,
      result:
        "fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`.",
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  case "no-tools": {
    // CONSTRUCTED — spike never independently ran claude's negative
    // control (spike-findings.md §3.1). This scenario/test closes that gap
    // (A3 PRD §0 decision 3).
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Hello!" }] } });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "Hello!",
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  case "claims-no-trace": {
    // CONSTRUCTED (same reasoning as fake-codex.fixture.mjs's equivalent
    // scenario): a final result whose text is CoderOutput-shaped JSON
    // claiming verifiedBy:"tool_execution", with NO tool_use anywhere in
    // the stream — exercises checkToolExecution()'s "fail" path at the
    // real adapter layer.
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
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: claimedContent }] } });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: claimedContent,
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  case "error": {
    // CONSTRUCTED non-zero-exit scenario.
    process.stderr.write("claude: fatal: something broke\n");
    process.exitCode = 1;
    break;
  }

  case "result-error": {
    // CONSTRUCTED: process exits 0, but the "result" event itself reports
    // failure — exercises the subtype/is_error check that's independent
    // of the process exit code. Exact subtype string is NOT spike-verified
    // (spike never triggered a real claude failure); "error_during_execution"
    // is a plausible placeholder, not a claim about real claude's exact
    // vocabulary.
    emit(initEvent("claude-sonnet-5"));
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
      result: "",
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  case "no-result-event": {
    // CONSTRUCTED anomalous-output scenario: a stream that never produces
    // a "result" event at all.
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: "..." }] } });
    process.exitCode = 0;
    break;
  }

  case "no-init-event": {
    // CONSTRUCTED: a stream with a valid result but no system/init event —
    // exercises the model:"unknown" fallback path.
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Hi." }] } });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "Hi.",
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  case "result-is-error-missing": {
    // Constructed (A3's Review Round-1 minor Y1's regression fixture):
    // subtype:"success", but the "result" event has no `is_error` field
    // at all (omitted, not `false`). Before the Y1 fix, the check was
    // `subtype !== "success" || is_error === true` — only a literal
    // `true` tripped it, so a missing `is_error` sailed through as
    // "success" by default. Correct behavior (`is_error !== false`):
    // treat "didn't explicitly say it succeeded" as failure, not success
    // by omission — throw AdapterInvokeError.
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: "ambiguous" }] } });
    emit({
      type: "result",
      subtype: "success",
      num_turns: 1,
      result: "ambiguous",
      session_id: "fixture-session",
      permission_denials: [],
      // is_error deliberately omitted
    });
    process.exitCode = 0;
    break;
  }

  case "null-line-then-hello": {
    // Constructed (A3's Review Round-1 minor Y2's regression fixture): a raw
    // `null` JSONL line (valid JSON, not an object) mixed in among
    // otherwise-valid lines. Before the Y2 fix, `parseJsonlEvents`
    // accepted any value `JSON.parse` could produce, so this `null` line
    // became an "event" with no `.type` property — every downstream
    // `event.type`/`event.message` read (`null.type`) threw a raw,
    // uncaught `TypeError`, escaping the "adapters only ever throw
    // AdapterInvokeError" contract. Correct behavior: the null line is
    // silently skipped, the rest of the stream parses normally.
    process.stdout.write("null\n");
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: "Hello despite the null line!" }] } });
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      result: "Hello despite the null line!",
      session_id: "fixture-session",
      permission_denials: [],
    });
    process.exitCode = 0;
    break;
  }

  default: {
    process.stderr.write(`fake-claude.fixture.mjs: unknown FAKE_CLAUDE_SCENARIO "${scenario}"\n`);
    process.exitCode = 1;
  }
  }
}
