---
name: workbench-setup
description: Install, inspect, update, or remove Agent Workbench shared global instructions and its local launcher while preserving personal instruction text.
---

# Workbench setup

Install or inspect the Agent Workbench shared global instructions and launcher. The interactive Manager, native Worker ladder and configured context policy live in the `orchestrate-harnesses` skill. Window values come from base `policy.context` in the Worker configuration, not skill or role instructions. Updating that skill changes its distributed defaults, not the current Manager's interactive model/settings or the user's partial model overrides.

## Commands

- `agent-workbench install` applies the current global instructions, generates routed Claude agents when orchestration is installed, and updates the launcher.
- `agent-workbench status` reports ownership and whether distributed assets need installation.
- `agent-workbench uninstall` removes only unmodified owned resources and restores the current personal instruction bytes.
- `agent-workbench workers --cwd PATH` prints effective JSON and the selected profile.

## Ownership and personal text

The installer creates `~/.agents/AGENTS.md`, links Codex's `~/.codex/AGENTS.md`, and ensures `~/.claude/CLAUDE.md` has one native import resolving to the shared instructions. An existing equivalent Claude import is reused. Personal text belongs outside `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->` in the shared file. Existing Codex regular-file bytes are kept outside the managed block on first installation; existing Claude text stays in its file.

Use `agent-workbench workers --cwd PATH` to print effective JSON and the selected profile. Overrides live at `$XDG_CONFIG_HOME/agent-workbench/workers.yml` when XDG is nonempty and absolute, otherwise `~/.config/agent-workbench/workers.yml`. PyYAML is vendored; installation never invokes pip. Setup owns a resolved `workers.json` beside `state.json` and passes its path to the policy hook. The hook selects approval rules by dispatch cwd; missing or unreadable policy asks for approval and requests reinstall. Uninstall removes the unmodified owned JSON along with the agents and hook entries.

## Conflicts and native settings

If a command reports an override, foreign entry, missing resource, or edited managed block, preserve the files and resolve that specific conflict before retrying. There is no force-overwrite mode. State and lock live under `~/.local/state/agent-workbench/`. Installation owns `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` and optionally `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` in `~/.claude/settings.json` and `model_auto_compact_token_limit` and optionally `model_context_window` in `~/.codex/config.toml`, when the respective config directory exists. It preserves other settings, including Magpie routing. Foreign or edited owned values conflict; missing values are reapplied. Status reports each key and uninstall removes only unmodified owned values. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Installation does not edit other skills, project files, shell configuration, credentials, or permissions.
