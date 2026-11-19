---
name: workbench-setup
description: Install, inspect, update, or remove Agent Workbench shared global instructions and its local launcher while preserving personal instruction text.
---

Use the bundled Python 3.11+ installer on Linux or macOS. Native `npx skills` distributes this skill; it does not execute the installer or apply global prompts.

Orchestration's interactive Manager, native Worker ladder and configured context policy live in the `orchestrate-harnesses` skill. Window values come from base `policy.context` in the Worker configuration, not skill or role instructions. Updating that skill changes its distributed defaults, not the current Manager's interactive model/settings or the user's partial model overrides.

After global distribution, explicitly apply the setup:

```sh
python3 ~/.agents/skills/workbench-setup/scripts/workbench.py install
~/.local/bin/agent-workbench status
```

The installer creates `~/.agents/AGENTS.md`, links Codex's `~/.codex/AGENTS.md`, and ensures `~/.claude/CLAUDE.md` has one native import resolving to the shared instructions. An existing equivalent Claude import is reused. Personal text belongs outside `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->` in the shared file. Existing Codex regular-file bytes are kept outside the managed block on first installation; existing Claude text stays in its file.

`agent-workbench install` reapplies distributed assets and runs thermal-guard's installer when that skill is installed. On a supported Linux sensor with user systemd it installs the `thermal` launcher and logger; unsupported machines report that condition without failing setup. `agent-workbench update` first updates only installed skills owned by `onsager-ai/agent-workbench` through the native skills lock, then runs freshly distributed setup code. Node.js 22.20+ and npx are needed for distribution and updates. Do not edit the native skills lock yourself.

When `orchestrate-harnesses` is installed, `install` (and `update`) generates one Claude Code subagent per routable tier at `~/.claude/agents/<tier>.md`. Distributed `workers.yml`, the partial user override, and every profile contribute to this union. A tier is routable when it has `harness: claude` (using `model`) or a non-null `claude_route`. The default luna, terra and sol routes use `onsager/codex/<model>`; flash has no route and runs as a `codex exec` Worker. Change a route in the YAML override, or set it to null to remove it when no profile needs it. A tier name must use the same model, route and effort across profiles; rename conflicting tiers. Each agent carries model and effort in frontmatter and the Worker instructions as its prompt. Rerun `agent-workbench install` after edits. Without `orchestrate-harnesses` no agents are generated.

Use `agent-workbench workers --cwd PATH` to print effective JSON and the selected profile. Overrides live at `$XDG_CONFIG_HOME/agent-workbench/workers.yml` when XDG is nonempty and absolute, otherwise `~/.config/agent-workbench/workers.yml`. PyYAML is vendored; installation never invokes pip. Setup owns a resolved `workers.json` beside `state.json` and passes its path to the policy hook. The hook selects approval rules by dispatch cwd; missing or unreadable policy asks for approval and requests reinstall. Uninstall removes the unmodified owned JSON along with the agents and hook entries.

Generated agent files are recorded with content hashes in the state file. Setup never overwrites a file it does not own, or an owned file you edited, and reports a conflict instead; other files in `~/.claude/agents` are left alone. `status` lists owned agents and `uninstall` removes unmodified ones.

When `orchestrate-harnesses` is installed, setup adds three Claude Code `hooks.PreToolUse` entries and one `hooks.Stop` entry in `~/.claude/settings.json`, all running the installed `orchestrate-harnesses/scripts/policy-hook`. The PreToolUse entries match `Agent|Task`, `Bash`, and `mcp__t3-code__delegate_task` to require approval for Opus Workers, deny GitHub polling commands, and require explicit Worker models for built-in agents and T3 delegation. The Stop entry blocks turns that end in a prose question, directing the model to re-ask through AskUserQuestion. State records the exact entries setup added; foreign entries (including identical pre-existing ones) remain unowned. Status lists owned hooks as applied or missing; install re-adds a missing or edited owned entry and leaves the edited copy as yours, a duplicated owned entry causes a conflict, and uninstall removes only owned entries while preserving other settings and their key order.

`agent-workbench uninstall` removes the public block and owned import/launcher, and makes Codex's file regular again with the current private text. Backups remain private under `~/.local/state/agent-workbench/backups`; uninstall never restores stale snapshots over later edits. This is the normal rollback operation. Review retained backups manually for historical recovery.

If a command reports an override, foreign entry, missing resource, or edited managed block, preserve the files and resolve that specific conflict before retrying. There is no force-overwrite mode. State and lock live under `~/.local/state/agent-workbench/`. Installation also owns `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` and optionally `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` in `~/.claude/settings.json` (replacing the earlier, unmodified `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) and `model_auto_compact_token_limit` and optionally `model_context_window` in `~/.codex/config.toml`, when the respective config directory exists. It preserves other settings, including Magpie routing. Foreign or edited owned values conflict; missing values are reapplied. Status reports each key and uninstall removes only unmodified owned values. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Installation does not edit other skills, project files, shell configuration, credentials, or permissions.

For isolated fixtures, put the skill at the canonical location under a disposable home, then pass `--home PATH` before the command. Alternate-home updates require an explicit `--skills-cmd` executable command; they never default to the real user's npx update. Native permission choices remain with the user.
