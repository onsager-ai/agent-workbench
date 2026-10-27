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

Orchestration keeps its distributed model settings as defaults and supports partial per-user overrides at `$XDG_CONFIG_HOME/agent-workbench/models.json` (or `~/.config/agent-workbench/models.json` when XDG is unset, empty or relative). Skill updates leave that user file alone. See [local model configuration](skills/orchestrate-harnesses/SKILL.md#local-model-configuration) for supported fields, precedence, and the read-only effective-config command.

The current interactive HAPI session is the **Manager**, using its selected native model. It communicates with the user, plans and dispatches Workers, and verifies delivery against actual revision/diff, CI and authorized remote evidence. There is no Gateway or separate headless Manager call. Plans and verdicts are recorded with `submit TASK manager`; only Workers dispatch.

Managers synchronize important global decisions and scoped task information through HAPI peer discovery, inspection and messages. They pull checkpoints on startup/resume, notify relevant active Managers and hand over task ownership explicitly across machines. This uses the existing hub/namespace and session history, with bounded discovery and acknowledgement reporting; it is a workflow, not a background guaranteed broadcast service. See [HAPI synchronization](skills/orchestrate-harnesses/references/hapi-sync.md).

Workers use a Codex-first ladder: **Luna max / Haiku medium → Terra medium / Sonnet medium → Sol high / Opus medium**. Escalation is adjacent unless explicitly justified. Claude alternatives require a cost justification and a bounded timeout. Monetary caps are optional configuration (`budget_usd: null` by default); workbench adds no fixed amount ceiling or implicit CLI budget. Terra defaults to the installed catalog ID `gpt-6.1-terra`. Per-user overrides naming `manager` or removed reviewer roles must be migrated; historical task originals/results remain readable. See the [ladder and migration rules](skills/orchestrate-harnesses/SKILL.md#worker-ladder-and-migration).

All dispatched Worker calls, including resumes, receive the context/compaction limit from `max_context_tokens` in the effective model configuration, overridable upward or downward without a fixed controller ceiling, preserving smaller native windows. Native CLI compaction is advisory rather than hard request-token enforcement; unknown Codex native windows are left untouched and Claude uses its supported auto-compact window. See [context policy and limitations](skills/orchestrate-harnesses/SKILL.md#per-dispatch-context-policy). Manager context targets must also use native session configuration from the effective policy. Workbench does not automatically retrofit an already running HAPI Manager; unknown or unapplied settings are reported as a coverage gap, without prompt-based limits or changing its selected model.

OS sandboxing is optional. Codex Workers use the user's explicitly evidenced permission policy: `danger-full-access` runs without an additional Codex OS sandbox, while `workspace-write` and `read-only` request isolation. Worktrees keep task changes separate; they do not enforce a security boundary. The editable task example shows an explicit full-access choice; replace its policy and evidence with the current user's actual choice.

Worker dispatch requires an explicit v2 contract recording policy source/evidence, sandbox mode and approval policy. Read-only tasks are capped at read-only. A bounded no-inference startup probe validates resolved CLI policy and execution before each Codex Worker run; failures block without widening permissions or consuming inference attempts. Claude Workers use explicit policy-derived tool allowlists, no MCP/nested agents and no automatic memory. Workspace-write Claude dispatch is blocked because an allowlist cannot establish OS confinement; Manager can choose Codex under the existing policy. Full-access Claude calls pre-allow named tools without bypass mode. The Codex startup probe does not cover Claude. Historical v1 status and interactive Manager submissions remain available, but v1 Worker dispatch requires a new v2 task. See [Worker permission policy](skills/orchestrate-harnesses/references/worker-permissions.md).

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

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put personal rules outside that block in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes migrate outside the block unchanged. When migrating old orchestration rules, inspect personal text for Gateway/fixed-Manager requirements and reconcile those explicitly; setup preserves private text and does not resolve semantic conflicts for you. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, other agent settings, credentials, model choices, or native permissions.

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
