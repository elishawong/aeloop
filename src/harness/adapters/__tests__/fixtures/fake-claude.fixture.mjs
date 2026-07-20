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
// "关键行节选" only quoted the tool_use/tool_result/result lines, not the
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

const args = process.argv.slice(2);

if (args[0] === "--version") {
  // Real version string from the spike's environment (spike-findings.md §2.5).
  process.stdout.write("2.1.215 (Claude Code)\n");
  process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
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
    process.exit(0);
    break;
  }

  case "error": {
    // CONSTRUCTED non-zero-exit scenario.
    process.stderr.write("claude: fatal: something broke\n");
    process.exit(1);
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
    process.exit(0);
    break;
  }

  case "no-result-event": {
    // CONSTRUCTED anomalous-output scenario: a stream that never produces
    // a "result" event at all.
    emit(initEvent("claude-sonnet-5"));
    emit({ type: "assistant", message: { content: [{ type: "text", text: "..." }] } });
    process.exit(0);
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
    process.exit(0);
    break;
  }

  default: {
    process.stderr.write(`fake-claude.fixture.mjs: unknown FAKE_CLAUDE_SCENARIO "${scenario}"\n`);
    process.exit(1);
  }
}
