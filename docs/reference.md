# Reference

## Requirements and workflow

| Requirement | Needed for |
| --- | --- |
| Node.js 22.20 or newer | Skills CLI, optional setup installer, and Claude policy hook |
| Linux or macOS | Optional setup installer |
| User systemd and a supported package-temperature sensor (optional) | `host-ops` temperature logger |

Engineering work uses the installed and authenticated native harness. T3 Code tools are optional; distributing skills does not install those tools or provide credentials.

The current interactive session is the **Manager**, using the model the user picks. Prefer the harness's strongest model for lanes with hard tradeoffs and a cheaper one for routine lanes. It plans and delegates substantial work, manages amendments, and verifies delivery. Prefer the harness's built-in subagents as Workers for same-harness implementation, investigation, and review. Workers do not create nested agents. Managers in the same harness and machine message each other natively; when available, T3 Code coordinates across harnesses and machines through sourced checkpoints and explicit ownership handover. Otherwise use native session messaging where supported and the user for handover. See [native Worker workflow](../skills/orchestrate-harnesses/SKILL.md#dispatch-and-verify) and [Manager sync](../skills/orchestrate-harnesses/references/manager-sync.md).

Agent Workbench covers user and machine instructions and Manager/Worker scope, distributed globally. Repository-committed conventions (pinned skills, the generated shared section of `AGENTS.md`, `.claude` projections and generated `.githooks`) stay owned by each repository's tooling and sync process. Agent Workbench never writes into managed repos.

## Profiles and Worker ladder

Workers use a configurable ladder. The default is **Haiku medium → Sonnet medium → Opus medium**. The optional `codex` profile uses **Luna medium / Haiku medium → Sol medium / Sonnet medium → Opus medium**, with Terra opt-in outside the ladder. A Claude Manager runs Codex tiers through sandboxed `codex exec` unless a user override supplies a gateway route. Each tier's `timeout_s` (7200 s by default) is a ceiling; the Manager sizes each dispatch timeout to the task. Escalation needs evidence; moving to the next listed tier needs a recorded reason; L3 (Opus) needs the user's approval for each task.

Model IDs, efforts, timeouts, optional monetary caps, rework policy, and context targets live in [workers.yml](../skills/orchestrate-harnesses/workers.yml). There is no fixed amount ceiling; `budget_usd: null` adds no monetary cap. See [local model configuration](../skills/orchestrate-harnesses/references/configuration.md) for partial per-user overrides. When the `magpie` CLI is installed, see [Magpie guidance](../skills/orchestrate-harnesses/references/magpie.md) for quota-aware tier choices, catalog warnings, and usage reporting.

Worker configuration is YAML loaded with the vendored `yaml` package without `npm install` or network access. Put partial overrides in `~/.config/agent-workbench/workers.yml` (or the absolute `$XDG_CONFIG_HOME` equivalent). Mappings merge, lists replace, and null tiers are deleted. Run `agent-workbench workers --cwd PATH` to inspect the selected profile and resolved configuration, then `agent-workbench install` to apply agent and hook changes.

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

To add Codex Workers, select the shipped profile:

```yaml
profile: codex
```

Managers apply settings through actual native tool capabilities. A configured target does not establish native model/effort, timeout, monetary budget, context, or permission enforcement. Report unsupported or unverified settings, preserve the user's native permissions, and hold dependent work when a missing control is required. Do not substitute prompt limits for native configuration or claim compaction is a hard request-token cap. This also applies to already-running Manager sessions.

To add an opt-in tier on another provider, put a custom tier in your override. It stays outside the automatic ladder:

```yaml
tiers:
  custom:
    harness: codex
    model: <provider-model-id>
    effort: medium
    claude_route: null
    opt_in: true
```

Use it only when explicitly chosen for a bounded task, such as CI log triage, repository exploration, a small edit, or an independent diff review. The Manager retains planning, acceptance, and delivery responsibility. A Codex Manager selects the configured native model; a Claude Manager runs it as a [Codex Worker](../skills/orchestrate-harnesses/references/codex-workers.md) with `codex exec -m <model>`. Keep credentials and provider settings outside this package. Read the provider's current catalog for the exact client-visible model ID, and verify a tool call and response through the intended harness before relying on it. Discovery alone does not prove a working tool loop; report unavailable routes and choose a supported Worker explicitly.

Check the route's model metadata and effective context window: an unknown ID can use a default window or compact early. Apply only effort levels the route exposes and retain effective `policy.context.max_tokens`, host rules, and smaller native limits. Record accepted results, defects, corrective attempts, elapsed time, and actual usage/cost, including reasoning tokens and retries, in the task or PR record. Custom-tier attempts count toward the same `max_auto_rework`. Compare actual charges, including cache and long-context tiers; a model name is not a price guarantee. Provider request fallback does not correct reasoning, so the Manager still verifies results. Workbench does not automatically launch an agent when CI fails; log triage is assigned by a Manager.

Workbench has no custom orchestration runtime, task database, or process supervisor. Native runs use their tool IDs, briefs, and existing task/PR evidence; they do not create another task record.

Codex CLI 0.141 or newer (hooks are on by default) gets the same policy hook through `~/.codex/hooks.json` when `~/.codex` exists. Codex hooks cannot ask, so the interactive Opus and ladder approvals become denials that tell the model to get your approval and retry, and the built-in-agent model inheritance rule is not applied. Codex runs hooks only after you trust them. Install leaves them untrusted and says so; run `agent-workbench trust` (it asks before recording trust hashes in `~/.codex/config.toml`) or run `/hooks` in Codex once. `agent-workbench status` shows `codex_hooks` and `codex_trust`.

## Install and update

Install all skills globally with the bootstrap command:

```sh
npx @onsager/awb setup
```

For manual skill installation, use the native skills CLI:

```sh
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y
```

Or install only the core skills:

```sh
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill host-ops manage-lane orchestrate-harnesses prompt-for-decisions workbench-setup -y
```

Update globally with:

```sh
npx skills update -g -y
```

These commands manage skills only. User-scope AGENTS.md and CLAUDE.md, credentials, and personal configuration remain separate and private; the npx skills installer does not create or modify them. Applying global instructions requires the explicit setup step described below.

For a project-local install, omit `-g` and use `--copy` to install independent copies in the project:

```sh
npx skills add onsager-ai/agent-workbench -a codex -a claude-code --skill '*' --copy -y
```

## Upgrade to `host-ops`

`host-ops` replaces `thermal-guard` and `disk-cleanup`. The skills CLI updates installed names, so install the new name explicitly. If you installed the old `thermal` launcher or logger, run the first command while the old skill is still present and no gated commands are starting. Remove only the old skills you installed.

```sh
~/.agents/skills/thermal-guard/scripts/thermal uninstall
npx skills remove -g thermal-guard disk-cleanup
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill host-ops -y
agent-workbench update
```

If you manage the skills without the setup installer, update them with the skills CLI and use the bundled `host-ops/scripts/thermal install` to apply the thermal setup. Use the same agent selections you used for the original install. For project-local copies, remove and add the skills from the project without `-g`.

On supported hosts, the new install links the same `thermal` command to `host-ops` and enables `host-ops-thermal.service` when user systemd is available. Existing logs and the admission lock stay in `${XDG_STATE_HOME:-$HOME/.local/state}/thermal-guard`.

## Personal configuration across machines

Create your own repo with `skills/workbench-personal/SKILL.md` and optional `workers.yml` and `AGENTS.md` in that directory. The skill needs name and description frontmatter:

```yaml
---
name: workbench-personal
description: Personal Worker overrides and instructions.
---
```

Install it once per machine, then apply it:

```sh
npx skills add <you>/<repo> -g -a codex -a claude-code -y
agent-workbench install
```

Private repos work through `gh` authentication or SSH. To change shared personal settings, edit the package, push, and run `agent-workbench update` on each machine. Worker configuration layers distributed defaults, `~/.agents/skills/workbench-personal/workers.yml`, then `~/.config/agent-workbench/workers.yml` (or the absolute `$XDG_CONFIG_HOME` equivalent); the last file remains for machine-specific settings and overrides the package.

## Apply shared global instructions

The optional setup installer supports Linux and macOS and needs only Node.js 22.20 or newer. When a supported Linux package-temperature sensor is available and `host-ops` is installed, setup installs the `thermal` launcher. With user systemd it also installs the background logger. No separate npm package, compiled binary, or shell configuration is installed.

After distributing the skills globally, apply their public instruction template:

```sh
node ~/.agents/skills/workbench-setup/scripts/workbench.mjs install
~/.local/bin/agent-workbench status
```

Use `agent-workbench` directly when `~/.local/bin` is already on your PATH. The installer creates these entries:

| Path | Purpose |
| --- | --- |
| `~/.agents/AGENTS.md` | Shared public block, optional personal package block, and private text outside both |
| `~/.codex/AGENTS.md` | Native Codex symlink to the shared file |
| `~/.claude/CLAUDE.md` | Existing Claude text plus native `@~/.agents/AGENTS.md` import |
| `~/.local/bin/agent-workbench` | Thin launcher for the installed setup skill |
| `~/.local/state/agent-workbench/workers.json` | Owned resolved base and profile policy used by the dispatch hook |
| `~/.claude/agents/<tier>.md` | Generated Claude Code subagents, one per routable Worker tier when `orchestrate-harnesses` is installed |
| `~/.claude/settings.json` → `hooks.PreToolUse` | Owned hooks for Opus approval, GitHub polling policy, and protection of local `main`/`master` branches when `orchestrate-harnesses` is installed |
| `~/.codex/hooks.json` and `[hooks.state]` in `~/.codex/config.toml` | Owned Codex policy hooks and, after you confirm, their trust entries when `orchestrate-harnesses` is installed and `~/.codex` exists |
| `~/.local/state/agent-workbench/` | Ownership, hashes, exclusive lock, private backups |

## Managed files and ownership

The package's `AGENTS.md` is applied immediately after the public block, inside `<!-- BEGIN agent-workbench personal -->` and `<!-- END agent-workbench personal -->`. Keep machine-local private text outside both blocks. Edit personal instructions in the package; edits inside either installed managed instruction block cause a conflict. Install removes the owned personal block if the package or its `AGENTS.md` disappears. Status reports package presence and applied personal files.

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put machine-local personal rules outside both managed blocks in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes are kept outside the block unchanged. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, other agent settings, credentials, model configuration, or native permissions.

Generated agents let a Claude Manager dispatch each tier as `subagent_type: haiku`, `sonnet`, and so on. A tier is generated when its role has `harness: claude` or a non-null `claude_route`. Defaults generate haiku, sonnet, and opus only; the `codex` profile has null routes and runs its Codex tiers through `codex exec`. Gateway prefixes are installation-specific; set `profiles.codex.tiers.luna.claude_route: <your-gateway>/gpt-6-luna` and `policy.context.gateway_window` in your partial override to generate that route. Rerun `agent-workbench install` after editing the override. Generated files are owned by hash: setup refuses to overwrite a foreign or edited file, leaves other files in `~/.claude/agents` alone, and `uninstall` removes only unmodified owned files.

Setup applies the configured compaction target to owned Claude and Codex config keys when their config directories exist, preserving existing provider routing. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Setup preserves personal text outside its managed block.

The optional `policy.stop_classifier` workers setting enables model classification for the Stop hook's prose-question check. Set `{url, model}` to use it; while enabled, every turn's final assistant message is sent to that URL, so use the local Magpie gateway. A confident yes blocks for AskUserQuestion; a confident no passes, and uncertain or failed requests use the existing question-mark check. It is off by default.

## Setup commands and behavior

```sh
# Reapply already distributed public assets (idempotent).
agent-workbench install
# Update this repository's installed skills and workbench-personal, then apply setup.
agent-workbench update
# Inspect hashes, versions, native paths, managed edits and masking overrides.
agent-workbench status [--json]
# Trust Codex policy hooks after reviewing the prompt.
agent-workbench trust
# Roll back setup while preserving current personal edits.
agent-workbench uninstall
# Report local worktrees/branches whose merged PRs qualify for cleanup, plus
# PR-less branches with no commits beyond the default branch.
awb prune [--repo PATH] [--json]
# Remove eligible local worktrees and branches after reviewing the report.
awb prune --apply
```

`update` reads native version-3 skills lock ownership (`~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when configured) and delegates to `skills@1.7.4 update` with this repository's installed skill names plus `workbench-personal` when present in the lock, regardless of its source. A failed native update leaves global instruction files unchanged. Updates honor the installed native skill source/ref metadata. `npx skills update -g -y` remains available for ordinary updates across all skills; use `agent-workbench install` afterward to apply any newly distributed instruction template.

Setup refuses foreign links or same-name commands, masking Codex overrides, duplicate or broken markers, and edits inside either managed instruction block. Resolve the reported conflict before retrying. State and backups are private to your user. Backups are historical snapshots; uninstall keeps current private text and restores Codex to a regular file containing it, removes the owned Claude import and launcher, and retains backups. It never replaces later personal edits with stale backup content. For historical recovery, inspect those backups yourself and restore only the intended text. Inspect status after interrupted or partially failed operations before retrying.

For disposable fixtures, copy the skill beneath a selected home's `.agents/skills/workbench-setup`, then use `node .../scripts/workbench.mjs --home PATH install`. An alternate-home `update` requires an explicit `--skills-cmd` command and never defaults to the real user's global npx update.

## New machine

Install Node.js 22.20 or newer, then run the global install command above. To keep skills current, run the global update command. For optional global instructions, run the explicit setup step. For engineering work, enable the native harness subagent tools and T3 Code capabilities you intend to use and authenticate through their supported setup. This repository does not manage credentials or agent authentication.

## Remaining Node files

| Files | Purpose |
| --- | --- |
| `skills/workbench-setup/scripts/workbench.mjs` | Optional install/update/status/uninstall of shared global instructions, launcher, and private backups |
| `skills/workbench-setup/scripts/workbench.py` | Four-line shim handing off to `workbench.mjs`, so launchers installed before the Node port can still update; may be removed in a later release |
| `skills/orchestrate-harnesses/scripts/policy-hook` | Claude hook entry point (`policy-hook.mjs` holds the logic) |
| `tests/*.test.mjs` | `node --test` checks for package layout, model defaults, the hook, and installer behavior; no orchestration service |

## Releasing @onsager/awb

The npm package holds only the `awb` wrapper, so release it only when `bin/awb.mjs` or `package.json` changes. Skill changes reach users through `npx skills update` and need no release.

1. Bump `version` in `package.json` in a PR and merge it.
2. Tag the merge commit and push the tag: `git tag v0.1.1 <sha> && git push origin v0.1.1`.

The Release workflow checks that the tag matches `package.json`, runs the tests and publishes with npm trusted publishing, so no npm token is stored. Running the workflow by hand does a dry run only. Trusted publishing is configured on npmjs.com under the package's settings: publisher GitHub Actions, repository `onsager-ai/agent-workbench`, workflow `release.yml`.
