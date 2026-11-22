# Worker configuration and native controls

## Effective configuration

The distributed `workers.yml` supplies schema version 2 defaults. It is overlaid by optional `~/.agents/skills/workbench-personal/workers.yml`, then by the machine-specific override at `$XDG_CONFIG_HOME/agent-workbench/workers.yml` when XDG is nonempty and absolute, otherwise `~/.config/agent-workbench/workers.yml`. Mappings merge by key, lists replace wholesale, and null deletes a tier. The selected profile overlays the merged base; profiles may be defined in any layer. The first `select` rule whose expanded real path contains the working directory wins. Otherwise `profile` selects the default, or null uses the base. Run `agent-workbench workers --cwd PATH` to read effective JSON and the chosen profile. Do not merge files by hand or create/rewrite user configuration merely to dispatch. Skill updates leave user configuration alone.

Tier names are configurable. Each tier identifies its client with `harness` (`codex` or `claude`) and `model`, with optional `effort`, `timeout_s`, `budget_usd`, route, quota brake and opt-in settings. Harness identifies the client, not the model vendor. A positive finite `budget_usd` is a Claude-only target; null adds no monetary cap. Never invent a cost amount. Native billing and quota limits still apply.

## Native controls

- `claude_route` is a Codex tier's model ID for dispatch from Claude Code. Null leaves it as a [Codex Worker](codex-workers.md). Claude tiers use `model` directly. See [Workbench setup](../../workbench-setup/SKILL.md) for agent generation, hook behavior and native context settings.
- `timeout_s` is a ceiling. Size each dispatch to the task and state the timeout in the brief. Generated Claude Code tier agents configure model and effort. Track elapsed time and stop overruns using supported native controls.
- Apply runtime timeout and budget controls where exposed. Manager tracking and prompt instructions do not enforce a hard limit. Report unsupported or unverified model, effort, timeout, budget, or context settings, including those of already-running Manager sessions.
- `policy.max_auto_rework` is nonnegative. A configured `weekly_brake_percent` must be greater than 0 and at most 100. See the [ladder](worker-ladder.md) for applying both rules.
