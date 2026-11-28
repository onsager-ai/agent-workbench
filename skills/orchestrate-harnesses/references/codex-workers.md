# Codex Workers from a Claude Manager

Run a Codex-harness role with:

~~~sh
timeout <s> codex exec -m <model> -c model_reasoning_effort=<effort> -s workspace-write
~~~

For Sol, pass `-c model_reasoning_effort=medium` using the resolved tier's default, or select a higher effort explicitly.

For `codex exec`, put `-m <model>` or `--model=<model>` before the positional brief or stdin redirection. Use a literal model ID. The hook also recognizes the model flag before `exec` and common `timeout` options. For an off-ladder model, put the approval line in the positional brief. A heredoc can supply task text for an eligible model. The hook reads the command header and skips the heredoc body. Scripts, shell functions, and indirect launchers are outside this check's scope.

Use `-s read-only` for read-only work. Pass the brief on stdin and capture the final message with `-o <file>`. Add `-c sandbox_workspace_write.network_access=true` only when the brief authorizes network work such as `git push` or `gh`. Use Codex's own sandbox, never `danger-full-access`. If the sandbox cannot start, for example because bubblewrap is blocked by an AppArmor user-namespace restriction, report the gap rather than widening access.

Launch as a tracked background command so exit signals completion. Verify the process and final message before reporting a Worker as running or finished. Honor the configured tier weekly brake. Fresh usage at or above it blocks that tier; 100 means block once the weekly allowance is used. Use [Magpie quota guidance](magpie.md) when installed; unknown or stale readings need an explicit bounded Manager exception. Never read credentials to obtain usage.

Apply `policy.max_auto_rework` across tiers after the initial attempt. At the limit, follow [design and stuck checkpoints](manager.md#design-and-stuck-checkpoints). Never silently reset the count or run endless cheap retries. These are Manager decisions, not checks enforced by a controller.
