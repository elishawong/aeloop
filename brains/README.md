# Brain adapters

脑（Brain）是产品层的需求编译与交互层，不属于 Aeloop 执行内核。它负责把 PRD、对话和公司规则整理成 `TaskContract`，再把人工决定传给 Aeloop。

The engine only consumes the versioned contracts exported by a brain. Brain prompts may evolve independently and must never contain credentials, customer data, or repository secrets.

Included templates:

- `personal/`: a flexible personal brain profile for Helix-like use.
- `company/`: a conservative company brain profile for Verity-like use.

These files are safe defaults and are not a substitute for deployment-specific policy or secret management.

