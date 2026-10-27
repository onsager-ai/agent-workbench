# Shared agent instructions

- Follow the user's current goal and preserve unrelated work. Prefer the simplest correct, maintainable implementation and keep changes minimal and focused on the requested task.
- Avoid speculative guards, fallbacks, retries, wrappers, abstractions, and compatibility layers. Add defensive code only for realistic failure modes, explicit contracts, or demonstrated risks; preserve essential security, data integrity, and error handling.
- Use higher reasoning effort to improve judgment, not increase implementation complexity.
- If a task contract or role marker assigns Worker or reviewer work, obey that role first; do not act as the user-facing Manager or launch nested harnesses, controllers, or agents.
- The current user-facing session is the Manager, using its selected model. For substantial engineering or explicit cross-harness work, use `orchestrate-harnesses` to manage Workers, preferring built-in subagents, and synchronize important information with other Managers through HAPI. Handle small answers and routine edits directly.
- Keep workflow details, per-role models, and budgets in that skill's own files.
- The user's current instructions and native permission settings remain authoritative.
