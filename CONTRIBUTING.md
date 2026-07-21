# Contributing to aeloop

Thanks for your interest in contributing. This document covers the
technical basics you need to get a change up and reviewed.

## Tech stack

| Area | What's used |
|---|---|
| Language / runtime | TypeScript on Node.js (`>=24`, see `engines` in `package.json`) |
| Package manager | pnpm (see `pnpm-lock.yaml`) |
| Data layer | SQLite (`better-sqlite3`) + FTS5 |
| Validation | [zod](https://zod.dev) — output schemas, validated directly with `safeParse` |
| Orchestration | [`@langchain/langgraph`](https://www.npmjs.com/package/@langchain/langgraph) + `@langchain/langgraph-checkpoint-sqlite` (`SqliteSaver`) |
| Config | `js-yaml`, with `${ENV}` placeholder substitution |
| Testing | [vitest](https://vitest.dev) |
| Type checking | `tsc --noEmit` (used as the lint step) |

## Project layout

```
aeloop/
├── docs/            design doc, roadmap, backlog, progress notes
├── src/
│   ├── prompt/      output schemas, persona loading, prompt composition
│   ├── context/      SQLite+FTS5 memory store, staleness tracking, confirm/correct/reject
│   ├── harness/     provider routing, adapter registry, LiteLLM + CLI-bridge adapters
│   ├── loop/        graph-based coder/tester state machine, gates, audit persistence
│   ├── profile/     profile config loading
│   └── shared/      cross-cutting types/utilities
└── profiles/        overlay configs (per-deployment persona + provider wiring)
```

The layers nest: `Prompt ⊂ Context ⊂ Harness ⊂ Loop`, plus a profile
overlay on top. Higher layers may depend on lower ones; lower layers never
import from higher ones (e.g. `prompt/` and `context/` never import from
`harness/` or `loop/`). See [`docs/DESIGN.md`](./docs/DESIGN.md) for the
full design.

## Setup

```sh
pnpm install
```

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Compiles `src/` with `tsc -p tsconfig.build.json` |
| `pnpm test` | Runs the full test suite once (vitest) |
| `pnpm test:watch` | Runs tests in watch mode |
| `pnpm lint` | Type-checks the whole project (`tsc --noEmit`) |

## Before opening a PR

- `pnpm test`, `pnpm lint`, and `pnpm build` must all pass cleanly.
- Keep diffs focused — one logical change per PR. Avoid mixing refactors
  with behavioral changes.
- Match the style and conventions of the surrounding code (naming,
  comment density, error-handling patterns).
- Code comments should be in English.
- Engine code (`src/`) must stay model-agnostic: don't hardcode a specific
  provider, model name, or vendor-specific syntax. Provider/model selection
  is configured per role through the profile/adapter layer.
- Don't add cross-layer imports that violate the dependency direction
  above (`prompt`/`context` must not import `harness`/`loop`).

## Reporting issues

Please open a GitHub issue with a clear description of the problem or
proposal, and, for bugs, steps to reproduce.
