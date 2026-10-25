---
name: workbench-setup
description: Install, inspect, update, or remove Agent Workbench shared global instructions and its local launcher while preserving personal instruction text.
---

Use the bundled Python 3.11+ installer on Linux or macOS. Native `npx skills` distributes this skill; it does not execute the installer or apply global prompts.

Orchestration's Manager/Worker-only ladder and per-dispatch 300000-token context policy live in the `orchestrate-harnesses` skill. Updating that skill changes its distributed defaults, not Gateway's interactive model/settings or the user's partial model overrides. Remove obsolete `roles.preflight`/`roles.acceptance` overrides as described in that skill before the next dispatch. Setup does not migrate those private settings or rewrite historical tasks.

After global distribution, explicitly apply the setup:

```sh
python3 ~/.agents/skills/workbench-setup/scripts/workbench.py install
~/.local/bin/agent-workbench status
```

The installer creates `~/.agents/AGENTS.md`, links Codex's `~/.codex/AGENTS.md`, and ensures `~/.claude/CLAUDE.md` has one native import resolving to the shared instructions. An existing equivalent Claude import is reused. Personal text belongs outside `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->` in the shared file. Existing Codex regular-file bytes migrate there on first installation; existing Claude text stays in its file.

`agent-workbench install` reapplies distributed assets. `agent-workbench update` first updates only installed skills owned by `onsager-ai/agent-workbench` through the native skills lock, then runs freshly distributed setup code. Node.js 22.20+ and npx are needed for distribution and updates. Do not edit the native skills lock yourself.

`agent-workbench uninstall` removes the public block and owned import/launcher, and makes Codex's file regular again with the current private text. Backups remain private under `~/.local/state/agent-workbench/backups`; uninstall never restores stale snapshots over later edits. This is the normal rollback operation. Review retained backups manually for historical recovery.

If a command reports an override, foreign entry, missing resource, or edited managed block, preserve the files and resolve that specific conflict before retrying. There is no force-overwrite mode. State and lock live under `~/.local/state/agent-workbench/`. Installation does not edit other skills, project files, shell configuration, credentials, models, or permissions.

For isolated fixtures, put the skill at the canonical location under a disposable home, then pass `--home PATH` before the command. Alternate-home updates require an explicit `--skills-cmd` executable command; they never default to the real user's npx update. Native permission choices remain with the user.
