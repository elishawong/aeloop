# A3 CLI-Bridge Pre-work Spike — Real-World Findings (issue #10)

> **Reconnaissance, not adapter code.** Goal: answer, with real command output, "can `ToolExecVerifier`
> actually verify tool calls," providing evidence for the PRD rather than assumption.
>
> Test environment: `codex-cli 0.144.1` (`/opt/homebrew/bin/codex`), `claude 2.1.215 (Claude Code)`
> (`~/.nvm/.../bin/claude`), macOS, test directory
> `/private/tmp/.../scratchpad/spike-testdir` (containing `fileA.txt`/`fileB.txt`, one line of text each).
> Every command below was actually run in this session; the output samples are pasted verbatim
> (not fabricated/not recalled from memory).

## One-line conclusion (up front)

- **Both CLIs can produce a parseable tool trace** — but only with the right flags: codex needs `--json`,
  claude needs `--output-format stream-json --verbose`. Under default/other flag combinations,
  the tool trace is either unstructured (codex plain-text mode) or entirely unavailable (claude `--output-format json`).
- **Recommended v1 verification granularity: existence/subset matching of "claimed tool ⊆ actually invoked tool"**,
  not deep field-by-field matching of command content — rationale below in "ToolExecVerifier evidence-source recommendation."
- **Neither CLI has a built-in timeout flag** — `ToolExecVerifier`/the adapter must implement its own wall-clock timeout
  (`spawn` + `setTimeout` + `SIGKILL`), which can directly mirror the already-validated pattern in `codex-client.mjs`.

---

## 1. `codex exec` real-world testing

### 1.1 Command-line shape

Referencing `scripts/openai/codex-client.mjs` (`buildExecArgs`), the base shape:

```
codex exec --sandbox read-only --skip-git-repo-check "<prompt>"
```

`--skip-git-repo-check` was added for this spike (the test directory isn't a git repo); the production
adapter, running inside a real repo, presumably won't need it. `codex-client.mjs` itself does not add
`--json` (it treats codex's entire output as an opaque "answer" string, relying instead on **file/git hash
snapshots taken before and after execution** to indirectly verify "was anything touched," rather than parsing
codex's own emitted tool-call records — this is one important finding of this spike, see §3 below).

### 1.2 Default (plain-text) mode — has a tool trace, but unstructured

Command:
```
codex exec --sandbox read-only --skip-git-repo-check \
  "List the files in the current directory, then read the contents of fileA.txt and tell me what it says."
```

Real output (stdout+stderr merged, excerpted; full text available in the spike execution record):
```
OpenAI Codex v0.144.1
--------
workdir: .../spike-testdir
model: gpt-5.6-sol
...
codex
I'll inspect the current directory and read `fileA.txt`.
exec
/bin/zsh -lc "pwd && rg --files -g '*' -0 | xargs -0 -n1 printf '%s\\n' && sed -n '1,240p' fileA.txt" in .../spike-testdir
 succeeded in 0ms:
.../spike-testdir
fileA.txt
fileB.txt
hello world spike file A

codex
Files in the current directory:
- `fileA.txt`
- `fileB.txt`
`fileA.txt` says: "hello world spike file A"
tokens used
14,042
```

**Conclusion**: plain-text mode **does** print the actual shell commands executed (the `exec` block +
full command line + `succeeded in Xms:` + command output), the tool trace objectively exists and is
visible. But this is free-format text meant for a human reader (paragraph order, wording may vary across
versions); reliably parsing it by machine would require writing fragile regexes — not recommended as the
primary evidence source for `ToolExecVerifier`.

### 1.3 `--json` mode — structured JSONL, recommended

Command:
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>"
```

**stdout is pure line-by-line JSON** (noise such as "Reading additional input from stdin...",
`rmcp::transport::worker` MCP auth errors all go to **stderr**, separation confirmed — see §1.5),
real sample:

```json
{"type":"thread.started","thread_id":"019f7eec-21a0-7773-97a0-d856c70ba65f"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll inspect the current directory and read `fileB.txt`."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"pwd && rg --files -g '*' -0 | sort -z | xargs -0 -n1 printf '%s\\\\n' && sed -n '1,240p' fileB.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"...\"","aggregated_output":".../spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file B\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Files in the current directory:\n\n- `fileA.txt`\n- `fileB.txt`\n\n`fileB.txt` says: \"hello world spike file B\""}}
{"type":"turn.completed","usage":{"input_tokens":34509,"cached_input_tokens":26112,"output_tokens":189,"reasoning_output_tokens":0}}
```

**Extractable fields** (line-by-line `JSON.parse`):
- `item.type === "command_execution"` → **this is the tool trace**: `command` (the actual shell
  command string that ran), `exit_code`, `status` (`in_progress`/`completed`), `aggregated_output`
  (the command's actual output). `item.started` and `item.completed` come in pairs (matching `id`),
  only `completed` events carry `exit_code`.
- `item.type === "agent_message"` → the model's text utterances (may appear multiple times; the last
  `agent_message` is generally the final answer, aligned with the last `item.completed` before
  `turn.completed`).
- `turn.completed.usage` → token usage.

**No-tool-call control group** (prompt: "Just say hello, do not use any tools."):
```json
{"type":"thread.started","thread_id":"019f7eec-7614-7af1-926f-0913fc9f6c86"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello!"}}
{"type":"turn.completed","usage":{"input_tokens":17125,"cached_input_tokens":9984,"output_tokens":6,"reasoning_output_tokens":0}}
```
Confirmed: **when there is no tool call, the event stream contains zero `command_execution`-type
items at all** — "whether a `command_execution` item is present" is itself a clean existence signal,
no extra inference needed.

### 1.4 Getting structured output + tool trace simultaneously (`--output-schema`)

This is the test closest to `ToolExecVerifier`'s real use case: requiring the model to emit structured
JSON per a schema (one of whose fields self-reports `tools_used`), while also using `--json` to capture
the event stream, comparing "what the model claims" against "what the event stream actually recorded
as invoked."

Command (⚠️ pitfall encountered, see §1.6):
```
codex exec --json --sandbox read-only --skip-git-repo-check \
  --output-schema schema.json \
  "List the files in the current directory and read fileA.txt. Respond with a JSON object \
   matching the schema: summary of what you found, and tools_used listing which tool types \
   you invoked (e.g. shell)." < /dev/null
```

Real output (excerpted, 6 lines of JSONL in full):
```json
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"summary\":\"I'll inspect the current directory and read fileA.txt, then return only the requested JSON fields.\",\"tools_used\":[]}"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"pwd && rg --files -g '*' && sed -n '1,200p' fileA.txt\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \"...\"","aggregated_output":".../spike-testdir\nfileA.txt\nfileB.txt\nhello world spike file A\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\"summary\":\"The current directory contains fileA.txt and fileB.txt. fileA.txt contains: \\\"hello world spike file A\\\".\",\"tools_used\":[\"shell\"]}"}}
```

**This piece of evidence is highly critical, directly influencing `ToolExecVerifier`'s design**:
- The model emitted a first-draft `agent_message` (`item_0`) **before** actually executing the tool,
  with `tools_used:[]` in it — this is its self-description of what it's planning to do, not the final answer.
- Only after actually executing `command_execution` (`item_1`) does the **last** `agent_message`
  (`item_2`, the last item before `turn.completed`) become the authoritative final structured
  output, with `tools_used:["shell"]` **matching** `item_1`'s real execution.
- **Inference**: `ToolExecVerifier` cannot just grab "any structured-output claim" — it must recognize
  that the **last** `agent_message` (i.e., the last item before `turn.completed`) is the
  **authoritative claim**, and when verifying it must check for `command_execution` events that occurred
  **before** that claim (temporal precedence, not "appeared anywhere in the document counts") —
  otherwise an in-between state like "claimed no tool use first, then actually used one later" would be
  misjudged. This is also exactly what "claim ≠ behavior" detection is really meant to guard against:
  the model could very well misreport `tools_used` in its final structured output (over-report,
  under-report, mix up which tool), and `ToolExecVerifier`'s value lies precisely in cross-checking
  against the `command_execution` event stream rather than taking the model's word for it.

### 1.5 stdout/stderr separation verification

Command (explicit separation, not `2>&1`):
```
codex exec --json --sandbox read-only --skip-git-repo-check "<prompt>" \
  > stdout.txt 2> stderr.txt
```
Result: **stdout is pure JSONL (parseable line-by-line with `JSON.parse`, no contamination)**; stderr contains:
```
Reading additional input from stdin...
2026-07-20T09:47:13.498720Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(...resource_metadata="https://mcp.vercel.com/.well-known/oauth-protected-resource"...)
```
(This particular MCP auth error is noise caused by a Vercel MCP server hooked up in this machine's
local codex config, unrelated to this spike, but it does confirm one thing: **the adapter must collect
stdout/stderr separately, not merge them the way `codex-client.mjs` does** (`out + '\n' + err`) —
merging would mix non-JSON noise into what should be a line-by-line `JSON.parse`-able stream. This
differs from `codex-client.mjs`'s current implementation under `--json` mode, and is new handling logic
that A3 needs to add — it cannot be copied as-is.)

### 1.6 Pitfalls encountered

- **Not explicitly closing stdin causes a hang**: the first time the `--output-schema` test was run
  without `< /dev/null`, it timed out immediately (120s with no output at all, stderr stuck at
  "Reading additional input from stdin..."). Adding `< /dev/null` fixed it right away (completed in
  ~15s). This confirms the pitfall recorded in `codex-client.mjs`'s header comment on security invariant
  ⑥ (`child.stdin.end()` must be called immediately) — **this spike's plain command-line testing also hit
  the exact same pitfall independently, it's a reproducible real problem, not a coincidence**.
- `--skip-git-repo-check` is only needed because the test directory isn't a git repo; the production
  adapter should be running inside a real repo and shouldn't need it.

### 1.7 Final text output / success determination

- **Getting the final text**: `-o/--output-last-message <FILE>` writes the last message straight to a
  file; real sample (prompt "Just say hello, do not use any tools."): the file's content was `Hello!`
  — this is the cleanest way, no need to re-parse it out of the JSONL. It can also be taken from the
  last `agent_message`-type item's `text` field in the `--json` stream (see the §1.4 analysis).
- **Determining non-interactive success/failure**: the process exit code (`0` for success); in `--json`
  mode you can also check whether the `turn.completed` event appeared (its presence means this turn wrapped up normally).
- **Timeout**: **no built-in flag** (neither `codex exec --help` nor `codex --help` has a `--timeout`-type
  option), the adapter must `spawn` + wall-clock `setTimeout` + `SIGKILL` itself, directly mirroring the
  already-validated pattern in `codex-client.mjs`'s `runCodexReview` (including the "close `stdin`
  immediately" part, see §1.6 — this spike independently reproduced the same pitfall).
- **checkAvailability**: `codex --version` → measured `codex-cli 0.144.1`, exit code `0`. Recommend
  mirroring `codex-client.mjs`'s `resolveCodexBinary` (manually replicating PATH lookup to get an
  absolute path, rather than letting `spawn('codex',...)` do implicit lookup) + validating the path
  doesn't resolve to an untrusted location — `codex-client.mjs` has already hit this pitfall and written
  the fix; A3 should directly reuse/mirror this piece of logic rather than redesigning it.

---

## 2. `claude` CLI real-world testing

### 2.1 `--output-format json` (single result) — no tool trace

Command:
```
claude -p "List the files in the current directory and read fileA.txt, tell me what it says." \
  --output-format json --allowedTools "Bash,Read" --permission-mode bypassPermissions < /dev/null
```

Real output (single-line JSON, key fields excerpted):
```json
{"type":"result","subtype":"success","is_error":false,"num_turns":3,
 "result":"The directory contains two files: `fileA.txt` and `fileB.txt`.\n\n`fileA.txt` says: **\"hello world spike file A\"**",
 "session_id":"da8c5f11-...","total_cost_usd":0.0976,
 "usage":{...},"permission_denials":[],"terminal_reason":"completed"}
```

**Conclusion**: `--output-format json` only gives the final text (the `result` field) + usage/cost
metadata + `num_turns` (hints at how many turns happened, but **doesn't reveal what was done each
turn**) + `permission_denials` (an empty array, showing this field structurally exists and could
carry "which tool calls were denied" information, but **in this mode you cannot get the answer to
the core question of "which tools were actually invoked."** **This mode is useless for
`ToolExecVerifier`.**

### 2.2 `--output-format stream-json --verbose` — has a complete tool trace, recommended

Command (`--verbose` is strictly required, see the §2.4 pitfall):
```
claude -p "List the files in the current directory and read fileB.txt, tell me what it says." \
  --output-format stream-json --verbose \
  --allowedTools "Bash,Read" --permission-mode bypassPermissions < /dev/null
```

Real output (JSONL, 17 lines, key lines excerpted):
```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01TF9wjf6yW3W4RvcYoSMZSM","name":"Bash","input":{"command":"ls -la","description":"List files in current directory"},"caller":{"type":"direct"}}]},...}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01TF9wjf6yW3W4RvcYoSMZSM","type":"tool_result","content":"total 16\n...\nfileA.txt\nfileB.txt","is_error":false}]}},"tool_use_result":{"stdout":"...","stderr":"","interrupted":false,...}}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01VWt8Hpo7EG7cuVatU3ZoaZ","name":"Read","input":{"file_path":".../fileB.txt"},"caller":{"type":"direct"}}]},...}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_01VWt8Hpo7EG7cuVatU3ZoaZ","type":"tool_result","content":"1\thello world spike file B\n2\t"}]},"tool_use_result":{"type":"text","file":{"filePath":".../fileB.txt","content":"hello world spike file B\n",...}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`."}]},...}
{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"fileB.txt (25 bytes) contains: `hello world spike file B`\n\nThe directory has two files: `fileA.txt` and `fileB.txt`.",...}
```

**Extractable fields** (line-by-line `JSON.parse`):
- `type==="assistant"` with `message.content[].type==="tool_use"` → **this is the tool trace**:
  `name` (the tool name, e.g. `Bash`/`Read` — **more fine-grained than codex's `command_execution`**,
  able to distinguish specific tools rather than just "ran a shell command"), `input` (that tool's
  specific call parameters), `id` (used to pair with the result).
- `type==="user"` with `message.content[].type==="tool_result"` → the corresponding result,
  `tool_use_id` pairs with the `id` above, `is_error` marks success/failure, `content`/`tool_use_result`
  carry the actual output.
- `type==="result"` (the last line) → summary: `result` (final text, same source/format as
  `--output-format json`'s `result` field), `num_turns`, `permission_denials`, `total_cost_usd`.

More fine-grained than codex's `command_execution` (which only knows "a shell command ran"): claude's
`tool_use` directly gives the **tool name** (`Bash`/`Read`/`Edit`/...), which is more friendly for
verification scenarios that need to match "claimed to have invoked tool X" by tool type/name.

### 2.3 No-tool-call control group + permission-denial scenario

- **Prompt explicitly requiring "no tool use allowed"** (using `--disallowedTools Bash`, letting the
  model discover on its own that the tool isn't in the available list): the measured result was the
  model stating in its final text "I don't have the Bash tool, I can use Glob instead,"
  **`permission_denials` was still an empty array** — indicating that `--disallowedTools` removes the
  tool from the model's visible tool list at the "tool definition stage" itself; the model simply never
  attempts to call it, and no "attempted but denied" denial record is produced. **Conclusion**: this
  spike was unable to reproduce a stable trigger for the `permission_denials` field (no method was
  found within 2-3 attempts, marked `[?]`, left for later), though the field structurally exists — if
  `ToolExecVerifier` wants to use it, further testing is needed to confirm under what conditions it
  becomes non-empty.

### 2.4 Pitfalls encountered

- **`--output-format stream-json` must be paired with `--verbose`**: measured that omitting it fails
  immediately with an error (exit 1) —
  ```
  Error: When using --print, --output-format=stream-json requires --verbose
  ```
  This is a hard validation built into the claude CLI itself, not a configuration issue with this spike;
  the adapter must always include `--verbose`.
- **Default permission behavior is environment-dependent, not to be trusted**: on this machine, tool
  calls succeed even without `--allowedTools`/`--permission-mode` (because this machine's `settings.json`
  already pre-authorizes common Bash commands), but this is **local machine state**, not portable CLI
  default behavior — on a clean machine/CI environment this would very likely hang waiting for
  permission approval in non-interactive mode (no TTY available to approve = hang, logically the same
  class of "non-interactive mode must explicitly declare, cannot rely on interactive-session defaults"
  problem as codex's stdin-blocking issue). **The adapter must explicitly pass
  `--permission-mode bypassPermissions` (or an equivalent explicit full `--allowedTools` set), and cannot
  rely on whatever permission state the calling environment happens to have** — this is the single
  recommendation this spike considers to have the biggest impact on the PRD.

### 2.5 Final text output / success determination / checkAvailability

- **Getting the final text**: both modes use the `result` field (`--output-format json`'s top-level
  `result`; `stream-json`'s last line, `type:"result"`'s `result` field), the same parsing logic can be reused.
- **Determining success/failure**: the `type:"result"` line's `subtype` (`"success"` vs. otherwise) +
  the `is_error` boolean + the process exit code.
- **Timeout**: same as codex, **no built-in flag**, the adapter must implement its own wall-clock
  timeout (mirroring `codex-client.mjs`'s pattern, including explicit `stdin.end()`).
- **checkAvailability**: `claude --version` → measured `2.1.215 (Claude Code)`, exit code `0`.

---

## 3. `ToolExecVerifier` evidence-source recommendation (this spike's core deliverable)

### 3.1 Evidence source for each CLI

| | codex | claude |
|---|---|---|
| Flag needed | `--json` | `--output-format stream-json --verbose` |
| Tool-trace event type | `item.completed` where `item.type==="command_execution"` | `assistant` msg's `content[].type==="tool_use"` + corresponding `user` msg's `tool_result` |
| Granularity | Only knows "a shell command ran" (the `command` field is the full shell command line, doesn't distinguish "which underlying tool" — codex represents Read/List/Write all as shell commands) | Precise down to the tool name (`Bash`/`Read`/`Edit`/...) + specific input parameters |
| When no tool call occurs | Event stream has zero `command_execution` items at all (verified via the real control-group test) | Event stream has zero `tool_use` content blocks at all (not individually tested, but structurally the same reasoning, `[?]` — no dedicated control group was run) |
| Execution-result visibility | `aggregated_output` + `exit_code` | `tool_result.content` + `is_error` |

**Both CLIs can produce a parseable tool trace, there was no case of "some CLI simply cannot give one
at all"** — the worst-case branch named in DESIGN §8, "if some CLI, upon real-world testing, turns out
to be genuinely incapable of producing a parseable tool trace," **did not occur** — `ToolExecVerifier`
has a real, usable evidence source on both adapters.

### 3.2 Recommended v1 verification granularity

**Recommendation: existence/subset matching of "claimed tool type ⊆ tool types that appear in the
actual invocation record"**, not deep field-by-field matching (not comparing whether the specific
command text/parameters fully match what was claimed). Rationale:

1. **codex's granularity ceiling is just "did a shell run or not," it can't get down to "which specific
   logical tool was invoked"** — if the verification standard were set finer than the evidence codex can
   actually provide (e.g. requiring "the tool name in the claim must match verbatim against some specific
   field in the codex trace"), the codex adapter would be inherently incapable of meeting it, artificially
   making the verification baseline inconsistent between the two CLIs. Subset/existence matching is the
   greatest common denominator both CLIs can satisfy.
2. **Temporal precedence is mandatory** (see the §1.4 analysis) — verification cannot just look at
   "whether some kind of tool call appeared anywhere in the entire event stream before or after the
   claim"; it must confirm that the `command_execution`/`tool_use` event occurred **before** the final
   structured claim (the last `agent_message` / the last assistant message) — this guards precisely
   against the in-between state actually observed in §1.4, "the model said it didn't use a tool first,
   then actually used one later," being misjudged as "really didn't."
3. **v1 does not recommend "parameter-level" matching** (e.g. claiming "read fileA.txt" and then going
   to check whether `tool_use.input.file_path` or the `command_execution.command` string actually
   contains `fileA.txt`) — this granularity is in theory supported by both CLIs (claude's
   `input.file_path` is very clean; for codex you'd have to regex it out of the shell command-line
   string, fragile), but whether it's worth doing in v1 is worth the strategist/commander weighing
   further — doing it lets you catch finer-grained hallucinations like "claimed to have read X but
   actually read Y"; not doing it means v1 can only catch the coarser class of hallucination, "claimed to
   have used a tool but never invoked any tool at all." This spike's position: **v1 should ship with
   existence/subset matching first, parameter-level matching left as a v2 enhancement** — the benefit
   being that both adapters' `toolTrace()` implementations stay roughly matched in complexity, and v1
   isn't tempted to over-design the verifier logic around claude's richer, cleaner fields just because
   its data happens to be cleaner, which would force the codex side's implementation to either come up
   short or branch off separately.

### 3.3 Mapping recommendation for `InvokeResult.toolExecChecked`

`src/harness/types.ts` already defines `toolExecChecked?: "pass" | "fail" | "na"`. Recommendation:
- `"na"`: for `kind === "direct-api"` adapters (litellm) — A2's current state, no trace to verify against.
- `"pass"`: for `kind === "cli-bridge"` where the declared tool ⊆ the set of tool types that appeared,
  temporally preceding, in the trace.
- `"fail"`: for `kind === "cli-bridge"` where a tool was claimed to have been invoked, but the trace
  shows no invocation record of that type of tool before the claim was produced (i.e. "claim ≠ behavior").
- **`ToolCallRecord` (currently the placeholder `{[key:string]:unknown}` in `types.ts`) is recommended
  to standardize on at least these cross-CLI common fields**: `toolName` (codex side always fills in
  `"shell"`, claude side fills in the actual `tool_use.name`), `raw` (the original item/tool_use object,
  kept for debugging as a safety net), `sequenceIndex` (its position in the event stream's order, used
  for the "temporal precedence" judgment). The concrete schema is left to be decided at the PRD/build
  stage, this is only a directional recommendation.

---

## 4. What can / cannot be mirrored from `codex-client.mjs`

**Can be mirrored directly (A3 should reuse this same already-validated set of patterns, no need to hit the same pitfalls again)**:
- Wall-clock timeout: `spawn` + `setTimeout` + `SIGKILL`, and must **immediately call
  `child.stdin.end()`** (codex blocks on non-TTY stdin — this spike independently reproduced the exact
  same pitfall in plain command-line testing, §1.6).
- `resolveCodexBinary` (manually replicating PATH lookup to get an absolute path, rather than letting
  `spawn` do implicit lookup on a bare string) + untrusted-location validation — this is a security
  hardening measure unrelated to the tool trace, but there's no reason for A3's `CodexCliAdapter` to
  reinvent it — just reuse/mirror it directly.
- The regex-extraction approach behind `extractCliVersion`/`extractModel` (codex's plain-text header
  block format hasn't changed; the real output in this spike measured the `model: gpt-5.6-sol`/
  `OpenAI Codex v0.144.1` lines in a format consistent with what `codex-client.mjs`'s existing regexes
  already assume).

**Cannot be mirrored / parts A3 needs to add (things `codex-client.mjs` doesn't do, because its use case doesn't need them)**:
- **`codex-client.mjs` doesn't parse the `--json` event stream at all** — it doesn't even add the
  `--json` flag — it treats codex's entire plain-text output as an opaque string, relying instead on
  an "out-of-band" approach of **git HEAD + tracked-file content hash snapshots taken before and after
  execution** to indirectly verify "was any unauthorized change made." This is a design specific to the
  review-only use case (see that file's header comment, security invariant ③), and is a completely
  different thing from what A3 needs to do — "parse the tool trace, cross-check claimed vs. actual
  invocations" — **this logic cannot be copied as-is**, `ToolExecVerifier` has to write its own JSONL
  parser from scratch.
- `codex-client.mjs` handles stdout+stderr as **merged** (`out + '\n' + err`) — A3 must collect them
  **separately** (§1.5 already confirmed: in `--json` mode, stderr noise mixing into stdout pollutes
  the JSONL parsing).
- The claude side has no corresponding reference at all (`codex-client.mjs` only serves codex);
  `ClaudeCliAdapter`'s combination of `--allowedTools`/`--permission-mode bypassPermissions`/`--verbose`
  is newly validated by this spike — the PRD needs to state clearly that these are hardcoded mandatory
  defaults, not optional parameters (§2.4).

---

## 5. Open points for the PRD / for the strategist to rule on

1. **Whether to do parameter-level matching in v1** (§3.2 point 3) — recommend not doing it, leave for
   v2, but this is a product judgment call, not a technical one — flagged here for the
   strategist/commander to rule on.
2. **The trigger condition for the `permission_denials` field has not been reproduced through testing**
   (§2.3) — if the PRD wants to use this field as a signal for "a tool call was denied," dedicated
   further testing time is needed; this spike didn't have budget to get to the bottom of it, marked `[?]`.
3. **The claude-side "no tool call" control group was not run independently** (§3.1 table footnote) —
   structurally it should reason the same way as codex (no `tool_use` block), but it wasn't verified with
   a dedicated "no tool use allowed" prompt the way codex was — if the PRD considers this boundary
   important, recommend adding a unit test/integration test to lock it down in the first batch of the
   build phase, don't assume it.
4. **[Supplemental test done during PRD-writing phase, new finding] codex `--json`'s JSONL event stream
   has no `model` field at all** — while writing the PRD, a re-check via `grep -o '"model"'` was done
   against all `--json` samples already captured by this spike (`codex-json-stdout.txt`/
   `codex-schema-stdout.txt`), zero matches. §1.3/§1.7's original text only verified that plain-text mode
   can extract `model` via regex from the banner (the `model: gpt-5.6-sol` line), without specifically
   checking whether `--json` mode also carries this field — this was an oversight in the original spike,
   not a newly run command, just a re-review of an already-captured sample. Conclusion: `--json` mode
   provides no model information; the PRD (`docs/feature/a3-cli-bridge/PRD.md` §5/§9.3) has already
   settled on a countermeasure — `CodexCliAdapter` hardcodes `model: "unknown"` (mirroring
   `codex-client.mjs`'s own existing `buildAttestation` fallback convention), which does not violate
   `InvokeResult`'s hard constraint that "provider/model must be a non-empty string" — it's just an
   honest acknowledgment that the specific version string isn't obtainable.
