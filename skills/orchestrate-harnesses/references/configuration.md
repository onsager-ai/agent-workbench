# Worker configuration and native controls

## Effective configuration

The distributed `workers.yml` supplies schema version 2 defaults. It is overlaid by optional `~/.agents/skills/workbench-personal/workers.yml`, then by the machine-specific override at `$XDG_CONFIG_HOME/agent-workbench/workers.yml` when XDG is nonempty and absolute, otherwise `~/.config/agent-workbench/workers.yml`. Mappings merge by key, lists replace wholesale, and null deletes a tier. The selected profile overlays the merged base; profiles may be defined in any layer. The first `select` rule whose expanded real path contains the working directory wins. Otherwise `profile` selects the default, or null uses the base. Run `agent-workbench workers --cwd PATH` to read effective JSON and the chosen profile. Do not merge files by hand or create/rewrite user configuration merely to dispatch. Skill updates leave user configuration alone.

Tier names are configurable. Each tier identifies its client with `harness` (`codex` or `claude`) and `model`, with optional `effort`, `timeout_s`, `budget_usd`, route, quota brake and opt-in settings. Harness identifies the client, not the model vendor. A positive finite `budget_usd` is a Claude-only target; null adds no monetary cap. Never invent a cost amount. Native billing and quota limits still apply. The interactive Manager keeps its selected model and permissions.

## Profiles and installation

`claude_route` is a Codex tier's model ID for dispatch from Claude Code. Null leaves it as a [Codex Worker](codex-workers.md). Claude tiers use their `model` directly. The optional `codex` profile leaves Luna, Terra and Sol routes null. Users may supply gateway IDs; gateway routing relies on workbench-setup's absolute compaction window and `policy.context.gateway_window`. Without them, Claude Code assumes 200k for those IDs, and routed Codex subagents can compact early, thrash autocompact, and stop using tools.

For gateway or CC Switch setups, copy this `neutral` profile into `~/.agents/skills/workbench-personal/workers.yml` or `~/.config/agent-workbench/workers.yml`. If the file already has a `profiles` mapping, add `neutral` under it.

```yaml
profiles:
  neutral:
    tiers:
      haiku: null
      sonnet: null
      opus: null
      fast: {harness: claude, model: haiku}
      standard: {harness: claude, model: sonnet}
      expert: {harness: claude, model: opus}
    ladder:
      - {level: L1, tiers: [fast]}
      - {level: L2, tiers: [standard], start_for: [spike, research, architecture]}
      - {level: L3, tiers: [expert], approval: required}
profile: neutral
```

To use `neutral` only for a directory, replace `profile: neutral` with `select: [{path: ~/work, profile: neutral}]`, or add that entry to your existing `select` list. Define `fast-backup` or `standard-backup` under `profiles.neutral.tiers` and put it after the primary tier if your provider offers a fallback. Ladder overrides replace the whole list.

The aliases follow `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` in Claude Code. Use a full model ID to pin the route Claude Code requests.

When migrating tier names, change the tier keys, ladder entries, and dispatch references together. Run `agent-workbench install` after editing the override and start a new session. Setup generates the union of routable tiers across the base and all profiles in `~/.claude/agents`. A name must keep the same model, route and effort across profiles; rename tiers that differ. Removing a route removes its generated file when no other profile needs it.

Unknown keys and invalid configuration fail installation without changing managed files. Setup preserves private instructions outside its managed block.

## Native controls

`policy.max_auto_rework` is nonnegative. A tier's optional `weekly_brake_percent` must be greater than 0 and at most 100. Optional `policy.stop_classifier` is null by default; set it to `{url, model}` to classify the Stop hook's prose-question check. When enabled, every turn's final assistant message is sent to that URL, so point it at the local Magpie gateway. The hook blocks on a confident yes, passes on a confident no, and falls back to the question-mark check when uncertain or when the request fails. Read target values from effective configuration and apply supported native controls. A configured target does not prove a subagent supports it. Report unsupported or unverified model, effort, timeout, budget, and context settings honestly. Native timeout/budget enforcement is used only where exposed; Manager tracking is not a hard runtime limit.

`timeout_s` is a ceiling: size each dispatch to the task, up to the configured value, and state it in the brief. Generated Claude Code subagents carry model, effort and `disallowedTools: AskUserQuestion`; track elapsed time and stop overruns using native controls.

### Context windows

Installation uses the base `policy.context` because native harness settings are shared across directories. `max_tokens` sets Claude Code's `autoCompactWindow` and Codex's `model_auto_compact_token_limit`. `gateway_window` still sets the assumed window for unknown Claude gateway IDs without `[1m]`. `codex_window` optionally sets Codex's `model_context_window`.

`manager_window` is a positive integer and defaults to `200000`. Set it to `null` to disable the Manager override. In Claude Code v2.1.288 or later, setup writes `modelSettings.<model>.autoCompactWindow` for each ID or alias in `manager_models`, which defaults to `[claude-opus-5-5]`. Use the canonical ID for a built-in model and the exact ID for a gateway alias. Claude Code supports configured windows of at least 100,000 tokens. Install and status warn when a Worker uses a configured Manager model because that Worker shares the smaller native window. A `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set outside Workbench takes precedence over these settings.

`worker_window` is null by default; when set, it must be at least `100000` and adds `autoCompactWindow` to every generated Claude subagent. Claude Code applies this frontmatter only to subagents and caps it at the window granted by that model's settings, so it can lower the Worker window but cannot raise it. It does not affect `codex exec` Workers.

To apply the Manager window in Codex, add `-c model_auto_compact_token_limit=<manager_window>` to the Manager's harness launch arguments, for example in T3 Code's Codex provider launch arguments. `codex exec` Workers use the shared limit from `~/.codex/config.toml`.

At the cap, the harness compacts in place in the same thread. The Manager takes no action. Restart existing sessions to apply configuration. Compaction does not enforce a hard request-token limit.

When applied by workbench-setup, Claude Code PreToolUse hooks ask approval according to the profile selected by the dispatch event's working directory and always for `model: opus`. Missing or unreadable resolved policy asks for approval on every Agent/Task dispatch and requests reinstall. Hooks deny built-in Agent/Task types without an explicit model, named agent types with a `model` override, and T3 `delegate_task` calls without `target.model`. A Stop hook blocks turns ending in a prose question so the Manager can ask through AskUserQuestion. Supply Worker effort in `target.options` for T3 delegation.

A workbench-setup PostToolUse check compares the resolved Agent/Task route with the configured tier at async launch. For completed runs it also checks transcript models. It compares an alias against its `ANTHROPIC_DEFAULT_*_MODEL` target when the hook environment supplies one. With an unknown alias target, it reports the observed model without a mismatch warning.
