# Conductor Work implementation status

This document records the first implementation slice of the architecture
design. It is intentionally separate from brain prompts and deployment
profiles so a company checkout can remove personal material without changing
the Aeloop engine.

## Implemented in `refactor/conductor-foundation`

- `src/workflow/`: versioned workflow manifests, plugin contracts, an
  in-memory registry, and the built-in `coder-tester-loop` adapter.
- `src/conductor/`: deterministic `TaskContract` validation. The engine does
  not ask a model to decide whether a contract is structurally safe.
- `src/conductor/orchestrator.ts`: deterministic brain-to-workflow selection;
  this is the orchestrator boundary, not another model persona and not a
  LangGraph node.
- `brains/personal/` and `brains/company/`: replaceable prompt/manifest
  templates. They are product-layer assets, not runtime dependencies.
- `assembleProfileDeps()`: profile-neutral dependency assembly. The existing
  subscription CLI path remains available as a compatibility wrapper.

## Deliberately not implemented yet

- Model-backed brain conversations.
- A remote plugin marketplace or dynamic code loading.
- Automatic Git commit, push, pull request, or merge operations.
- A declarative workflow DSL. TypeScript plugins are the safer first step;
  declarative workflows can be added after two or three real workflows exist.

## Company demo boundary

The company checkout supplies its own profile directory (for example the
existing `apikey`/LiteLLM configuration) and company brain assets. The public
engine only requires the profile to satisfy the existing `config.yaml`
contract. No company credentials, PRDs, repository content, or memory database
belongs in this repository.
