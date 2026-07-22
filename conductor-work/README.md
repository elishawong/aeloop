# Conductor Work

`conductor-work` is the company-facing product entry layer. It loads the
company brain, reads a versioned `TaskContract`, and asks the deterministic
Conductor layer to select a registered Aeloop workflow.

This layer contains no credentials, repository data, or company PRDs. Those
remain in the deployment's private profile root and source systems.

## Credential-free plan demo

```bash
pnpm run build
node scripts/conductor-work.mjs plan ./contract.json
```

## Candidate-only execution

The company runner can now start a governed candidate run. It never approves a
human gate and never performs Git writes, commits, pushes, pull requests, or
merges.

```bash
export AI_AGENT_PROFILE=apikey
export AELOOP_PROFILES_ROOT="$PWD/profiles"
pnpm run build
node scripts/conductor-work.mjs run ./contract.json --profile apikey --json --events ./company-run.events.jsonl
```

The JSON result contains the versioned `RunPlan`, the current run handle, and a
company-safe `EvidenceBundle`. The optional JSONL file contains the observed
`LoopEvent` trail. A result with `run.interrupt` is waiting for an external
human decision; it is not auto-approved.
