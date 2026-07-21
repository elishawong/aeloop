# aeloop

**Model-agnostic, governance-first coder/tester engine.**

Four nested layers — **Prompt ⊂ Context ⊂ Harness ⊂ Loop** — plus a profile
overlay, so one engine powers two profiles: a **personal subscription
profile** (claude-cli / codex-cli, CLI bridge) and a **company API /
LiteLLM profile** (LiteLLM proxy) — corresponding to the `subscription` and
`apikey` overlays, respectively. Neither is a submodule; both are *profiles*
on aeloop.

## Why

- **Anti-hallucination by mechanism**, not by asking the model to be honest: structured-output schema forces every claim to expose its confidence + source; an independent tester (a *different* model) reviews the coder; on the CLI-bridge path, tool-execution is verified against what the model *claims* it did.
- **Human-gated loop**: Coder → G1 → Tester → reject-threshold → escalation → G3 final sign-off. Every write is gated.
- **Model-agnostic**: any provider per role via adapters — LiteLLM (`direct-api`) or claude/codex CLI (`cli-bridge`).

## Status

A0 through A5 are complete: all four engine layers (Prompt, Context,
Harness, Loop) are implemented, plus the profile/overlay mechanism and a
real, installable CLI (`aeloop start`/`resume`/`list`) driving the engine
against the `subscription` profile. **368 tests passing**; `pnpm lint`
(`tsc --noEmit`) and `pnpm build` are both clean. Remaining milestone is
**A6 (dual-profile acceptance run)** — see [`docs/ROADMAP.md`](./docs/ROADMAP.md)
for the full milestone-by-milestone breakdown.

## Getting started

```sh
pnpm install
cp .env.example .env   # set AI_AGENT_PROFILE and, for the apikey profile, LITELLM_BASE_URL/LITELLM_TOKEN
pnpm test
pnpm build
```

Drive one Loop run through the real, interactive CLI (`subscription`
profile only — see `docs/ROADMAP.md`'s A5 entry for the `apikey` profile's
status):

```sh
node dist/cli/bin.js start "<task description>"
# ...renders each gate's diff/issues, prompts for a decision (G1/G3
# approve-or-reject, G2 approve-or-escalate, Escalation revise/
# force-pass/abandon)...
node dist/cli/bin.js list             # see paused/escalated runs
node dist/cli/bin.js resume <runId>   # continue one, even in a new process
```

## Documentation

- [`docs/DESIGN.md`](./docs/DESIGN.md) — full design: architecture, sequence diagrams, DB schema, file structure, milestones.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — milestone-by-milestone progress.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — tech stack, project layout, commands, PR expectations.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
