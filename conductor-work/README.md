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

The current MVP exposes planning. Actual model execution continues through the
Aeloop CLI/runtime after the plan is approved.
