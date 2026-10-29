# Agent Workbench Skills

Seven portable skills for Codex and Claude Code:

- disk-cleanup — inspect and reclaim safe, regenerable disk usage.
- hapi-runner-setup — manage a HAPI systemd user service and private provider credentials when explicitly requested.
- manage-lane — maintain task intent, authorization and handovers.
- orchestrate-harnesses — coordinate native Workers and HAPI Managers with scoped briefs and native lifecycle controls.
- prompt-for-decisions — present a real unresolved user choice with evidence and trade-offs.
- review-storybook — review interactive Storybook previews against a specific revision.
- workbench-setup — explicitly apply shared global instructions while preserving personal text.

## Requirements and workflow

The skills CLI requires Node.js 22.20 or newer. The optional global-instruction installer requires Python 3.11+ on Linux or macOS. Engineering work uses the installed/authenticated native harness and HAPI tools; distributing skills does not install those tools or provide credentials.

The current interactive session is the **Manager**, using its selected native model. It talks with the user, delegates substantial work, manages amendments and verifies delivery. Prefer the harness's **built-in subagents as Workers** for same-harness implementation, investigation and review. The Manager owns delegation; Workers do not create nested agents. HAPI coordinates Managers across harnesses, sessions and machines through sourced checkpoints and explicit ownership handover. See [native Worker workflow](skills/orchestrate-harnesses/SKILL.md#native-worker-workflow) and [HAPI synchronization](skills/orchestrate-harnesses/references/hapi-sync.md).

Workers use a Codex-first ladder (Codex tiers are available to a Claude Manager once routed through `claude_model`): **Luna max / Haiku medium → Terra medium / Sonnet medium → Sol high / Opus medium**. Terra defaults to `gpt-6.1-terra`. Escalation needs evidence; Claude alternatives need a cost justification. Model IDs, efforts, timeouts, optional monetary caps, rework policy and context targets live in [models.json](skills/orchestrate-harnesses/models.json), with partial per-user overrides described in [local model configuration](skills/orchestrate-harnesses/SKILL.md#local-model-configuration). No fixed amount ceiling is imposed; `budget_usd: null` adds no monetary cap. See [Magpie guidance](skills/orchestrate-harnesses/references/magpie.md) for quota-aware tier choices, catalog warnings and usage reporting.

Managers apply these settings through actual native tool capabilities. A configured target does not establish native model/effort, timeout, monetary budget, context or permission enforcement. Report unsupported/unverified settings, preserve the user's native permissions, and hold dependent work when a missing control is required. Do not substitute prompt limits for native configuration or claim compaction is a hard request-token cap. The same applies to already-running Manager sessions.

An optional **DeepSeek Flash** Worker pilot covers CI log triage, repository exploration, small edits and independent diff review. Its `flash` role uses Claude Code as a gateway-compatible client; actual native model selection must be supported. Configure the client-visible model ID for your provider and compare accepted results, correction time and actual cost before changing defaults. See [Flash routing and pilot guidance](skills/orchestrate-harnesses/references/deepseek-flash.md). Workbench does not automatically launch an agent when CI fails; log triage is a task assigned by a Manager.

Workbench has no custom orchestration runtime, task database or process supervisor. The standalone Python controller, permission probe, old-role/session compatibility code and JSON dispatch/response contracts have been removed. Existing private historical records are left alone. Native runs use their tool IDs, briefs and existing task/PR evidence; they do not create another Python-managed task record.

The remaining Python files have narrow purposes:

| Files | Purpose |
| --- | --- |
| `skills/workbench-setup/scripts/workbench.py` | Optional install/update/status/uninstall of shared global instructions, launcher and private backups |
| `tests/test_*.py` | CI checks for package layout, model defaults and installer behavior; no orchestration service |

Setup applies the configured compaction target to owned Claude and Codex config keys when their config directories exist, preserving Magpie routing. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Setup preserves personal text outside its managed block. Reconcile old private Gateway/controller rules and obsolete model overrides explicitly; workbench does not silently rewrite them.

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
| `~/.claude/agents/<role>.md` | Generated Claude Code subagents, one per routable Worker tier (when `orchestrate-harnesses` is installed) |
| `~/.local/state/agent-workbench/` | Ownership, hashes, exclusive lock, private backups |

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put personal rules outside that block in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes migrate outside the block unchanged. When migrating old orchestration rules, inspect personal text for Gateway/fixed-Manager requirements and reconcile those explicitly; setup preserves private text and does not resolve semantic conflicts for you. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, other agent settings, credentials, model configuration, or native permissions.

The generated agents let a Claude Manager dispatch each tier as `subagent_type: luna`, `haiku`, and so on. A tier is generated when its role has `cli: claude`, or a non-null `claude_model` set in your partial model override (`{"roles": {"luna": {"claude_model": "<gateway model ID>"}}}`); Codex tiers stay unrouted by default because gateway prefixes are installation-specific, and nothing is generated without that route. Rerun `agent-workbench install` after editing the override. Generated files are owned by hash: setup refuses to overwrite a foreign or edited file, leaves other files in `~/.claude/agents` alone, and `uninstall` removes only unmodified owned files.

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

Install Node.js 22.20 or newer, then run the global install command above. To keep skills current later, run the global update command. For optional global instructions, install Python 3.11+ and run the explicit setup step. For engineering work, enable the native harness subagent tools and HAPI capabilities you intend to use and authenticate through their supported setup. This repository does not manage credentials or agent authentication.

## License

MIT. See [LICENSE](LICENSE).
