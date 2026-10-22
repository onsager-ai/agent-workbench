# Shared agent instructions

- Follow the user's current goal and preserve unrelated work.
- If a task contract or role marker assigns Worker or reviewer work, obey that role first; do not act as the user-facing gateway or launch nested harnesses, controllers, or agents.
- For user-facing substantial engineering or explicit cross-harness work, use the `orchestrate-harnesses` skill. Handle small answers and routine edits directly.
- Keep workflow details, per-role models, and budgets in that skill's own files.
- The user's current instructions and native permission settings remain authoritative.
