# Agent Workbench Skills

Six portable skills for Codex and Claude Code:

- disk-cleanup — inspect and reclaim safe, regenerable disk usage.
- manage-lane — maintain task intent, authorization and handovers.
- orchestrate-harnesses — coordinate engineering work across agent roles with explicit contracts and lifecycle controls.
- prompt-for-decisions — present a real unresolved user choice with evidence and trade-offs.
- review-storybook — review interactive Storybook previews against a specific revision.
- workbench-setup — explicitly apply shared global instructions while preserving personal text.

## Requirements

The skills CLI requires Node.js 22.20 or newer.

The bundled orchestration controller is Linux-only and requires Python 3.11+ and the native agent CLIs already installed and authenticated in the user's environment. Installing skills with npx does not install those tools or provide credentials.

## Install globally

~~~sh
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y
~~~

## Update globally

~~~sh
npx skills update -g -y
~~~

These commands manage skills only. User-scope AGENTS.md and CLAUDE.md, credentials and personal configuration remain separate and private; the npx skills installer does not create or modify them. Applying global instructions requires the explicit setup step below.

## Apply shared global instructions

The optional setup installer supports Linux and macOS with Python 3.11+. Distribution and native updates also require Node.js 22.20+ and npx. No separate npm package, compiled binary, background service, or shell configuration is installed.

After distributing the skills globally, apply their public instruction template:

~~~sh
python3 ~/.agents/skills/workbench-setup/scripts/workbench.py install
~/.local/bin/agent-workbench status
~~~

Use `agent-workbench` directly when `~/.local/bin` is already on your PATH. The installer creates these entries:

| Path | Purpose |
| --- | --- |
| `~/.agents/AGENTS.md` | Shared public block and your private text outside it |
| `~/.codex/AGENTS.md` | Native Codex symlink to the shared file |
| `~/.claude/CLAUDE.md` | Existing Claude text plus native `@~/.agents/AGENTS.md` import |
| `~/.local/bin/agent-workbench` | Thin launcher for the installed setup skill |
| `~/.local/state/agent-workbench/` | Ownership, hashes, exclusive lock, private backups |

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put personal rules outside that block in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes migrate outside the block unchanged. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, other agent settings, credentials, model choices, or native permissions.

~~~sh
# Reapply already distributed public assets (idempotent).
agent-workbench install
# Update only this repository's installed skills, then apply freshly loaded setup code.
agent-workbench update
# Inspect hashes, versions, native paths, managed edits and masking overrides.
agent-workbench status
# Roll back setup while preserving current personal edits.
agent-workbench uninstall
~~~

Update reads native version-3 skills lock ownership (`~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when configured) and delegates to `skills@1.7.4 update` with only this repository's installed skill names. A failed native update leaves global instruction files unchanged. Updates honor the installed native skill source/ref metadata. `npx skills update -g -y` remains available for ordinary updates across all your skills; use `agent-workbench install` afterward to apply any newly distributed instruction template.

Setup refuses foreign links or same-name commands, masking Codex overrides, duplicate/broken markers, and edits inside its public block. Resolve the reported conflict before retrying. State and backups are private to your user. Backups are historical snapshots; uninstall keeps current private text and restores Codex to a regular file containing it, removes the owned Claude import and launcher, and retains backups. It never replaces later personal edits with stale backup content. For historical recovery, inspect those backups yourself and restore only the intended text. Interrupted or partially failed operations should be inspected with `status` before retrying.

For disposable fixtures, copy the skill beneath a selected home's `.agents/skills/workbench-setup`, then use `python3 .../scripts/workbench.py --home PATH install`. An alternate-home `update` requires an explicit `--skills-cmd` command and never defaults to the real user's global npx update.

### Review-time branch installation

While this change is unmerged, explicitly select its branch ref to try the candidate:

~~~sh
npx skills add 'onsager-ai/agent-workbench#codex/global-instructions' -g -a codex -a claude-code --skill '*' -y
python3 ~/.agents/skills/workbench-setup/scripts/workbench.py install
~~~

The quoted fragment selects the branch, including its slash. This is an unmerged review candidate; distributing it still does not apply global prompts until the Python installer runs. Merge is a separate action.

## Project-local install

From the project where you want the skills available, omit -g:

~~~sh
npx skills add onsager-ai/agent-workbench -a codex -a claude-code --skill '*' --copy -y
~~~

The --copy option installs independent copies in the project. This is useful when the project should carry its own skill versions.

## Set up a new machine

Install Node.js 22.20 or newer, then run the global install command above. To keep skills current later, run the global update command. For optional global instructions, install Python 3.11+ and run the explicit setup step. For orchestration, also install the native CLIs you intend to use, then authenticate those CLIs through their own supported setup. This repository does not manage credentials or agent authentication.

## License

MIT. See [LICENSE](LICENSE).
