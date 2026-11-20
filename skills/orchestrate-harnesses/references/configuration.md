# Worker configuration and native controls

## Effective configuration

The distributed `workers.yml` supplies schema version 2 defaults. It is overlaid by optional `~/.agents/skills/workbench-personal/workers.yml`, then by the machine-specific override at `$XDG_CONFIG_HOME/agent-workbench/workers.yml` when XDG is nonempty and absolute, otherwise `~/.config/agent-workbench/workers.yml`. Mappings merge by key, lists replace wholesale, and null deletes a tier. The selected profile overlays the merged base; profiles may be defined in any layer. The first `select` rule whose expanded real path contains the working directory wins. Otherwise `profile` selects the default, or null uses the base. Run `agent-workbench workers --cwd PATH` to read effective JSON and the chosen profile. Do not merge files by hand or create/rewrite user configuration merely to dispatch. Skill updates leave user configuration alone.

Tier names are configurable. Each tier identifies its client with `harness` (`codex` or `claude`) and `model`, with optional `effort`, `timeout_s`, `budget_usd`, route, quota brake and opt-in settings. Harness identifies the client, not the model vendor. A positive finite `budget_usd` is a Claude-only target; null adds no monetary cap. Never invent a cost amount. Native billing and quota limits still apply. The interactive Manager keeps its selected model and permissions.

## Profiles and installation

`claude_route` is a Codex tier's model ID for dispatch from Claude Code. Null leaves it as a [Codex Worker](codex-workers.md). Claude tiers use their `model` directly. The optional `codex` profile leaves Luna, Terra and Sol routes null. Users may supply gateway IDs; gateway routing relies on workbench-setup's absolute compaction window and `policy.context.gateway_window`. Without them, Claude Code assumes 200k for those IDs, and routed Codex subagents can compact early, thrash autocompact, and stop using tools.

Run `agent-workbench install` after editing the override. Setup generates the union of routable tiers across the base and all profiles in `~/.claude/agents`. A name must keep the same model, route and effort across profiles; rename tiers that differ. Removing a route removes its generated file when no other profile needs it.

Unknown keys and invalid configuration fail installation without changing managed files. Setup preserves private instructions outside its managed block.

## Native controls

`policy.max_auto_rework` is nonnegative. A tier's optional `weekly_brake_percent` must be greater than 0 and at most 100. Context targets live in `policy.context`: `max_tokens`, `gateway_window`, and `codex_window`. Optional `policy.stop_classifier` is null by default; set it to `{url, model}` to classify the Stop hook's prose-question check. When enabled, every turn's final assistant message is sent to that URL, so point it at the local Magpie gateway. The hook blocks on a confident yes, passes on a confident no, and falls back to the question-mark check when uncertain or when the request fails. Installation applies base context values because native harness settings are shared across directories. Read target values from effective configuration and apply supported native controls. A configured target does not prove a subagent supports it. Report unsupported or unverified model, effort, timeout, budget, and context settings honestly. Native timeout/budget enforcement is used only where exposed; Manager tracking is not a hard runtime limit.

`timeout_s` is a ceiling: size each dispatch to the task, up to the configured value, and state it in the brief. Generated Claude Code subagents carry only model and effort; track elapsed time and stop overruns using native controls. Claude Code receives `max_tokens` as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, capped at each model's own window; `gateway_window` sets the assumed window for unknown gateway IDs without `[1m]`. Codex receives it with optional `codex_window`. Restart existing sessions to apply configuration. Compaction is advisory and cannot enforce request-token limits.

When applied by workbench-setup, Claude Code PreToolUse hooks ask approval according to the profile selected by the dispatch event's working directory and always for `model: opus`. Missing or unreadable resolved policy asks for approval on every Agent/Task dispatch and requests reinstall. Hooks deny built-in Agent/Task types without an explicit model, named agent types with a `model` override, and T3 `delegate_task` calls without `target.model`. A Stop hook blocks turns ending in a prose question so the Manager can ask through AskUserQuestion. Supply Worker effort in `target.options` for T3 delegation.

A workbench-setup PostToolUse check compares completed Agent/Task runs with the effective tier model. It warns about requested-model overrides or transcript model mismatches so the Manager can report the model that actually ran; it never blocks completed work.
