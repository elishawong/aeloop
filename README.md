# aeloop

**Model-agnostic, governance-first coder/tester engine.**

Four nested layers — **Prompt ⊂ Context ⊂ Harness ⊂ Loop** — plus a profile overlay, so one engine powers two faces: **Helix** (personal subscription, claude/codex CLI) and **Verity** (company LiteLLM proxy) — corresponding to the `subscription` and `apikey` profiles, respectively. Neither is a submodule; both are *profiles* on aeloop.

## Why

- **Anti-hallucination by mechanism**, not by asking the model to be honest: structured-output schema forces every claim to expose its confidence + source; an independent tester (a *different* model) reviews the coder; on the CLI-bridge path, tool-execution is verified against what the model *claims* it did.
- **Human-gated loop**: Coder → G1 → Tester → reject-threshold → escalation → G3 final sign-off. Every write is gated.
- **Model-agnostic**: any provider per role via adapters — LiteLLM (`direct-api`) or claude/codex CLI (`cli-bridge`).

## Status

Pre-spec. This repo currently holds project scaffolding only; the engine `src/` is built via the standard spec → build → independent-review flow.

See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full design, [`CLAUDE.md`](./CLAUDE.md) for repo conventions.
