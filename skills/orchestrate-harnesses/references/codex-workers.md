# Codex Workers from a Claude Manager

Run a Codex-harness role with:

~~~sh
timeout <s> codex exec -m <model> -c model_reasoning_effort=<effort> -s workspace-write
~~~

Use `-s read-only` for read-only work. Pass the brief on stdin and capture the final message with `-o <file>`. Add `-c sandbox_workspace_write.network_access=true` only when the brief authorizes network work such as `git push` or `gh`. Use Codex's own sandbox, never `danger-full-access`. If the sandbox cannot start, for example because bubblewrap is blocked by an AppArmor user-namespace restriction, report the gap rather than widening access.

Launch as a tracked background command so exit signals completion. Verify the process and final message before reporting a Worker as running or finished. Follow the [Worker ladder](worker-ladder.md#choose-a-tier) for quota brakes and rework.
