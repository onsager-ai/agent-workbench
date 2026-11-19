# Agent Workbench Skills

Seven portable skills for Codex and Claude Code. Core skills are manage-lane, orchestrate-harnesses, prompt-for-decisions, thermal-guard and workbench-setup; disk-cleanup and review-storybook are optional:

- disk-cleanup — inspect and reclaim safe, regenerable disk usage.
- manage-lane — maintain task intent, authorization and handovers.
- orchestrate-harnesses — coordinate native Workers and T3 Code Managers with scoped briefs and native lifecycle controls.
- prompt-for-decisions — present a real unresolved user choice with evidence and trade-offs.
- review-storybook — review interactive Storybook previews against a specific revision.
- thermal-guard — safely gate CPU-heavy work by a supported package-temperature sensor.
- workbench-setup — explicitly apply shared global instructions while preserving personal text.

## Requirements and workflow

The skills CLI requires Node.js 22.20 or newer. The optional global-instruction installer requires Python 3.11+ on Linux or macOS. Engineering work uses the installed/authenticated native harness; T3 Code tools are optional and used when available; distributing skills does not install those tools or provide credentials.

The current interactive session is the **Manager**, using the model the user picks. Prefer the harness's strongest model for lanes with hard tradeoffs and a cheaper one for routine lanes. It talks with the user, delegates substantial work, manages amendments and verifies delivery. Prefer the harness's **built-in subagents as Workers** for same-harness implementation, investigation and review. The Manager owns delegation; Workers do not create nested agents. Managers in the same harness on the same machine message each other natively; when its tools are available, T3 Code coordinates them across harnesses and machines through sourced checkpoints and explicit ownership handover. Otherwise use native session messaging where supported and the user for handover. See [native Worker workflow](skills/orchestrate-harnesses/SKILL.md#native-worker-workflow) and [T3 synchronization](skills/orchestrate-harnesses/references/t3-sync.md).

## Scope

Agent Workbench covers user/machine instructions and Manager/Worker scope, distributed globally. Repository-committed conventions—pinned skills, the generated shared section of `AGENTS.md`, `.claude` projections, and generated `.githooks`—remain owned by each repository's tooling and sync process. AW never writes into managed repos.

Workers use a configurable ladder. The default is **Haiku medium → Sonnet medium → Opus medium**. The optional `codex` profile uses **Luna medium / Haiku medium → Sol medium / Sonnet medium → Opus medium**, with Terra opt-in outside the ladder. A Claude Manager runs Codex tiers through sandboxed `codex exec` unless a user override supplies a gateway route. Each tier's `timeout_s` (7200 s by default) is a ceiling; the Manager sizes each dispatch's timeout to the task. Escalation needs evidence; moving to the next listed tier needs a recorded reason; L3 (Opus) needs the user's approval for each task. Model IDs, efforts, timeouts, optional monetary caps, rework policy and context targets live in [workers.yml](skills/orchestrate-harnesses/workers.yml), with partial per-user overrides described in [local model configuration](skills/orchestrate-harnesses/SKILL.md#local-model-configuration). No fixed amount ceiling is imposed; `budget_usd: null` adds no monetary cap. When the `magpie` CLI is installed, see [Magpie guidance](skills/orchestrate-harnesses/references/magpie.md) for quota-aware tier choices, catalog warnings and usage reporting.

Worker configuration is YAML, loaded with vendored PyYAML without pip or network access. Put partial overrides in `~/.config/agent-workbench/workers.yml` (or the absolute `$XDG_CONFIG_HOME` equivalent). Mappings merge, lists replace, and null tiers are deleted. Run `agent-workbench workers --cwd PATH` to inspect the chosen profile and resolved configuration, then `agent-workbench install` to apply agent and hook changes.

For a corporate setup, add a profile and select it for your work directory:

```yaml
profiles:
  corporate:
    tiers:
      glm: {harness: claude, model: glm, effort: medium}
    ladder:
      - {level: L1, tiers: [haiku, glm]}
      - {level: L2, tiers: [sonnet]}
      - {level: L3, tiers: [opus], approval: required}
select:
  - {path: ~/work, profile: corporate}
```

To add Codex Workers, select the shipped `codex` profile:

```yaml
profile: codex
```


Managers apply these settings through actual native tool capabilities. A configured target does not establish native model/effort, timeout, monetary budget, context or permission enforcement. Report unsupported/unverified settings, preserve the user's native permissions, and hold dependent work when a missing control is required. Do not substitute prompt limits for native configuration or claim compaction is a hard request-token cap. The same applies to already-running Manager sessions.

To add an opt-in tier on another provider, put a custom tier in your override; it stays outside the automatic ladder:

~~~yaml
tiers:
  custom:
    harness: codex
    model: <provider-model-id>
    effort: medium
    claude_route: null
    opt_in: true
~~~

Use it only when explicitly chosen for a bounded task, such as CI log triage, repository exploration, a small edit or an independent diff review. The Manager retains planning, acceptance and delivery responsibility. A Codex Manager selects the configured native model; a Claude Manager runs it as a [Codex Worker](skills/orchestrate-harnesses/SKILL.md#codex-workers-from-a-claude-manager) with `codex exec -m <model>`. Keep credentials and provider settings outside this package. Read the provider's current catalog for the exact client-visible model ID, and verify a tool call and response through the intended harness before relying on it. Discovery alone does not prove a working tool loop; report unavailable routes and choose a supported Worker explicitly.

Check the route's model metadata and effective context window: an unknown ID can use a default window or compact early. Apply only effort levels the route exposes and retain effective `policy.context.max_tokens`, host rules and smaller native limits. Record accepted results, defects, corrective attempts, elapsed time and actual usage/cost, including reasoning tokens and retries, in the task or PR record. Custom-tier attempts count toward the same `max_auto_rework`. Compare actual charges, including cache and long-context tiers; a model name is not a price guarantee. Provider request fallback does not correct reasoning, so the Manager still verifies results. Workbench does not automatically launch an agent when CI fails; log triage is assigned by a Manager.

Workbench has no custom orchestration runtime, task database or process supervisor. Native runs use their tool IDs, briefs and existing task/PR evidence; they do not create another Python-managed task record.

The remaining Python files have narrow purposes:

| Files | Purpose |
| --- | --- |
| `skills/workbench-setup/scripts/workbench.py` | Optional install/update/status/uninstall of shared global instructions, launcher and private backups |
| `tests/test_*.py` | CI checks for package layout, model defaults and installer behavior; no orchestration service |

Setup applies the configured compaction target to owned Claude and Codex config keys when their config directories exist, preserving existing provider routing. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Setup preserves personal text outside its managed block.

## Install globally

~~~sh
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y
# Or install only the core skills:
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill manage-lane orchestrate-harnesses prompt-for-decisions thermal-guard workbench-setup -y
~~~

## Update globally

~~~sh
npx skills update -g -y
~~~

These commands manage skills only. User-scope AGENTS.md and CLAUDE.md, credentials and personal configuration remain separate and private; the npx skills installer does not create or modify them. Applying global instructions requires the explicit setup step below.

## Personal configuration across machines

Create your own repo with `skills/workbench-personal/SKILL.md` and optional `workers.yml` and `AGENTS.md` in that directory. The skill needs name and description frontmatter:

~~~yaml
---
name: workbench-personal
description: Personal Worker overrides and instructions.
---
~~~

Install it once per machine, then apply it:

~~~sh
npx skills add <you>/<repo> -g -a codex -a claude-code -y
agent-workbench install
~~~

Private repos work through `gh` authentication or SSH. To change shared personal settings, edit the package, push, and run `agent-workbench update` on each machine. Worker configuration layers distributed defaults, `~/.agents/skills/workbench-personal/workers.yml`, then `~/.config/agent-workbench/workers.yml` (or the absolute `$XDG_CONFIG_HOME` equivalent); the last file remains for machine-specific settings and overrides the package.

The package's `AGENTS.md` is applied immediately after the public block, inside `<!-- BEGIN agent-workbench personal -->` and `<!-- END agent-workbench personal -->`. Keep machine-local private text outside both blocks. Edit personal instructions in the package; edits inside either installed managed block cause a conflict. Install removes the owned personal block if the package or its `AGENTS.md` disappears. Status reports package presence and applied personal files.

## Apply shared global instructions

The optional setup installer supports Linux and macOS with Python 3.11+. Distribution and native updates also require Node.js 22.20+ and npx. When a supported Linux package-temperature sensor and user systemd are available, setup installs thermal-guard's launcher and background logger; otherwise the thermal rule does not apply. No separate npm package, compiled binary, or shell configuration is installed.

After distributing the skills globally, apply their public instruction template:

~~~sh
python3 ~/.agents/skills/workbench-setup/scripts/workbench.py install
~/.local/bin/agent-workbench status
~~~

Use `agent-workbench` directly when `~/.local/bin` is already on your PATH. The installer creates these entries:

| Path | Purpose |
| --- | --- |
| `~/.agents/AGENTS.md` | Shared public block, optional personal package block, and your private text outside both |
| `~/.codex/AGENTS.md` | Native Codex symlink to the shared file |
| `~/.claude/CLAUDE.md` | Existing Claude text plus native `@~/.agents/AGENTS.md` import |
| `~/.local/bin/agent-workbench` | Thin launcher for the installed setup skill |
| `~/.local/state/agent-workbench/workers.json` | Owned resolved base and profile policy used by the dispatch hook |
| `~/.claude/agents/<tier>.md` | Generated Claude Code subagents, one per routable Worker tier (when `orchestrate-harnesses` is installed) |
| `~/.claude/settings.json` → `hooks.PreToolUse` | Owned hooks for Opus approval, GitHub polling policy, and protection of local `main`/`master` branches (when `orchestrate-harnesses` is installed) |
| `~/.local/state/agent-workbench/` | Ownership, hashes, exclusive lock, private backups |

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put machine-local personal rules outside both managed blocks in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes are kept outside the block unchanged. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, other agent settings, credentials, model configuration, or native permissions.

The generated agents let a Claude Manager dispatch each tier as `subagent_type: haiku`, `sonnet`, and so on. A tier is generated when its role has `harness: claude` or a non-null `claude_route`. Defaults generate haiku, sonnet and opus only; the `codex` profile has null routes and runs its Codex tiers through `codex exec`. Gateway prefixes are installation-specific; set `profiles.codex.tiers.luna.claude_route: <your-gateway>/gpt-6-luna` and `policy.context.gateway_window` in your partial override to generate that route. Rerun `agent-workbench install` after editing the override. Generated files are owned by hash: setup refuses to overwrite a foreign or edited file, leaves other files in `~/.claude/agents` alone, and `uninstall` removes only unmodified owned files.

~~~sh
# Reapply already distributed public assets (idempotent).
agent-workbench install
# Update this repository's installed skills and workbench-personal, then apply setup.
agent-workbench update
# Inspect hashes, versions, native paths, managed edits and masking overrides.
agent-workbench status
# Roll back setup while preserving current personal edits.
agent-workbench uninstall
~~~

Update reads native version-3 skills lock ownership (`~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when configured) and delegates to `skills@1.7.4 update` with this repository's installed skill names plus `workbench-personal` when present in the lock, regardless of its source. A failed native update leaves global instruction files unchanged. Updates honor the installed native skill source/ref metadata. `npx skills update -g -y` remains available for ordinary updates across all your skills; use `agent-workbench install` afterward to apply any newly distributed instruction template.

Setup refuses foreign links or same-name commands, masking Codex overrides, duplicate/broken markers, and edits inside either managed instruction block. Resolve the reported conflict before retrying. State and backups are private to your user. Backups are historical snapshots; uninstall keeps current private text and restores Codex to a regular file containing it, removes the owned Claude import and launcher, and retains backups. It never replaces later personal edits with stale backup content. For historical recovery, inspect those backups yourself and restore only the intended text. Interrupted or partially failed operations should be inspected with `status` before retrying.

For disposable fixtures, copy the skill beneath a selected home's `.agents/skills/workbench-setup`, then use `python3 .../scripts/workbench.py --home PATH install`. An alternate-home `update` requires an explicit `--skills-cmd` command and never defaults to the real user's global npx update.

## Project-local install

From the project where you want the skills available, omit -g:

~~~sh
npx skills add onsager-ai/agent-workbench -a codex -a claude-code --skill '*' --copy -y
~~~

The --copy option installs independent copies in the project. This is useful when the project should carry its own skill versions.

## Set up a new machine

Install Node.js 22.20 or newer, then run the global install command above. To keep skills current later, run the global update command. For optional global instructions, install Python 3.11+ and run the explicit setup step. For engineering work, enable the native harness subagent tools and T3 Code capabilities you intend to use and authenticate through their supported setup. This repository does not manage credentials or agent authentication.

## License

MIT. See [LICENSE](LICENSE).
