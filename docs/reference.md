# Reference

## Requirements and workflow

| Requirement | Needed for |
| --- | --- |
| Node.js 22.20 or newer | Skills CLI, optional setup installer, and Claude policy hook |
| Linux or macOS | Optional setup installer |
| User systemd and a supported package-temperature sensor (optional) | `awb ops thermal` logger |

Engineering work uses the installed and authenticated native harness. T3 Code tools are optional; distributing skills does not install those tools or provide credentials.

The current interactive session is the **Manager**, using the model the user picks. Prefer the harness's strongest model for lanes with hard tradeoffs and a cheaper one for routine lanes. It plans and delegates substantial work, manages amendments, and verifies delivery. Prefer the harness's built-in subagents as Workers for same-harness implementation, investigation, and review. Workers do not create nested agents. Managers in the same harness and machine message each other natively; when available, T3 Code coordinates across harnesses and machines through sourced checkpoints and explicit ownership handover. Otherwise use native session messaging where supported and the user for handover. See [native Worker workflow](../skills/orchestrate-harnesses/SKILL.md#dispatch-and-verify) and [Manager sync](../skills/orchestrate-harnesses/references/manager-sync.md).

Agent Workbench covers user and machine instructions and Manager/Worker scope, distributed globally. Repository-committed conventions (pinned skills, the generated shared section of `AGENTS.md`, `.claude` projections and generated `.githooks`) stay owned by each repository's tooling and sync process. Agent Workbench never writes into managed repos.

## Profiles and Worker ladder

Workers use a configurable ladder. L1 is for bounded work with a small, fast, low-cost model. Research, spikes, and architecture start at L2, which uses a capable general model. L3 is for the strongest model and needs the user's approval for each task. The default Claude mapping is Haiku medium at L1, Sonnet medium at L2, and Opus medium at L3. The optional `codex` profile maps Luna medium and Haiku medium to L1, Sol medium and Sonnet medium to L2, and Opus medium to L3; Terra is opt-in outside the ladder. Haiku, Sonnet, and Opus are Anthropic's small, mid-size, and largest Claude models. Map any models from a gateway or another harness to levels in `workers.yml`. A Claude Manager runs Codex tiers through sandboxed `codex exec` unless a user override supplies a gateway route. Each tier's `timeout_s` (7200 s by default) is a ceiling; the Manager sizes each dispatch timeout to the task. Escalation needs evidence; moving to the next listed tier needs a recorded reason.

Model IDs, efforts, timeouts, optional monetary caps, rework policy, and context targets live in [workers.yml](../skills/orchestrate-harnesses/workers.yml). There is no fixed amount ceiling; `budget_usd: null` adds no monetary cap. See [local model configuration](../skills/orchestrate-harnesses/references/configuration.md) for partial per-user overrides. When the `magpie` CLI is installed, see [Magpie guidance](../skills/orchestrate-harnesses/references/magpie.md) for quota-aware tier choices, catalog warnings, and usage reporting.

Worker configuration is YAML loaded with the vendored `yaml` package without `npm install` or network access. Put partial overrides in `~/.config/agent-workbench/workers.yml` (or the absolute `$XDG_CONFIG_HOME` equivalent). Mappings merge, lists replace, and null tiers are deleted. Run `agent-workbench workers --cwd PATH` to inspect the selected profile and resolved configuration, then `agent-workbench install` to apply agent and hook changes.

A tier with `provider` uses T3 `delegate_task` only. Set `target.providerInstanceId` to the tier's `provider`, `target.model` to its exact `model`, and `target.options` to its `options` map. `harness` is optional for these tiers and does not select their route. No native agent or CLI route is generated. Provider tiers are not valid for top-level thread launch or model configuration. The hook checks the provider and exact model, not whether `target.options` matches the tier. Supply the provider instance ID explicitly; `driverKind` alone does not select a tier. Other providers keep the existing lookup.

`access` defaults to `write`. The `isolation` list defaults to `[shared, worktree]` for write tiers and `[shared]` for read-only tiers. A read-only tier cannot list `worktree`. Shared is the default when a dispatch omits `isolation`. `stamp`, if set, must be nonblank and adds text to the Worker brief; read-only tiers get a default no-changes line if `stamp` is unset. Some child hooks only see shell calls; use those providers on read-only tiers, and do not treat the stamp as a sandbox.

Optional `routing` maps job kinds to lists of tier names in fallback order. Managers follow the effective order printed by `agent-workbench workers`. The hook does not enforce this order, and existing ladder approval and opt-in rules still apply.

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

Check the route's model metadata and effective context window: an unknown ID can use a default window or compact early. `policy.context.worker_window` (null by default; otherwise at least `100000`) sets `autoCompactWindow` only in generated Claude subagent frontmatter. Claude Code caps it at the window granted by that model's settings, so it can only lower the window; it does not affect `codex exec` Workers. Apply only effort levels the route exposes and retain effective `policy.context.max_tokens`, host rules, and smaller native limits. Record accepted results, defects, corrective attempts, elapsed time, and actual usage/cost, including reasoning tokens and retries, in the task or PR record. Custom-tier attempts count toward the same `max_auto_rework`. Compare actual charges, including cache and long-context tiers; a model name is not a price guarantee. Provider request fallback does not correct reasoning, so the Manager still verifies results. Workbench does not automatically launch an agent when CI fails; log triage is assigned by a Manager.

Workbench has no custom orchestration runtime, task database, or process supervisor. Native runs use their tool IDs, briefs, and existing task/PR evidence; they do not create another task record.

Codex CLI 0.141 or newer (hooks are on by default) gets the same policy hook through `~/.codex/hooks.json` when `~/.codex` exists. Codex hooks cannot ask, so the interactive L3 and approval-required tier approvals become denials that tell the model to get your approval and retry, and the built-in-agent model inheritance rule is not applied. Codex runs hooks only after you trust them. Install leaves them untrusted and says so; run `agent-workbench trust` (it asks before recording trust hashes in `~/.codex/config.toml`) or run `/hooks` in Codex once. `agent-workbench status` shows `codex_hooks` and `codex_trust`.

Antigravity CLI can use a workspace `PreToolUse` hook with the installed `policy-hook --host antigravity` adapter. Its [documented hook payload](https://antigravity.google/docs/hooks) uses `toolCall.name` and `toolCall.args`. For every role, the hook checks shell calls for protected branches and GitHub polling, checks T3 delegation against the Worker ladder (including exact provider and model matching for provider tiers), and stamps Worker briefs and WB_MSG footers. It returns changed arguments in `overwrite`. Antigravity's native `invoke_subagent`, `define_subagent`, `swarm`, and `run_workflow` tools are denied because they bypass the Worker ladder.

To register it in one workspace, run `agent-workbench install --antigravity --workspace PATH` and select the hook in Antigravity before activation. The same command upgrades unchanged, previously owned shell-only and role-independent registrations. If the registration is missing `--workers` or its `workers.json` cannot be read, T3 delegation is denied; rerun the workspace install command. Plain install and update do not register or upgrade workspace hooks. Remove the workspace registration with `agent-workbench uninstall --antigravity --workspace PATH`.


### Manager models for T3 thread creation

Set `policy.manager_models` in your `workers.yml` override to a list of exact, nonblank model IDs, for example `[example/manager-model]`, then rerun `agent-workbench install`. Managers can launch or create threads with those models by including `L3 approval: <link to the approval>` on its own line in the launch text or each applicable thread prompt. The default `[]` grants no exception. Profiles can replace the list. Changing an existing thread's model remains limited to eligible L1/L2 models.

### Registered T3 schedules

For an automation already listed in the private registry, put its `name`, T3 `thread` ID, and exact `schedule` in `policy.schedules` in your `workers.yml` override, then rerun `agent-workbench install`. No schedules are allowlisted by default, and the hook does not read the registry. Only a Claude Manager main loop or an enrolled Antigravity Manager in that thread can create the schedule: use the name as `title`, supply a nonblank `prompt`, and set `bindToCurrentThread: true` to run on the thread's current model. The schedule must match the configured object exactly: `interval` uses integer `everyMs` of at least 60000, or `fixed_time` uses a quoted 24-hour `timeOfDay` (`"09:00"`) and optional `weekdays` (0 for Sunday through 6 for Saturday).

An optional `fresh_session` boolean defaults to `false`. If a create supplies `freshSession`, it must match that value. To let the same Manager re-enable a paused schedule, set the entry’s optional `task_id` to its T3 schedule ID and call with `scheduledTaskId` and `enabled: true`. The update may also include `environmentId` and a matching `freshSession`. Codex denies creates and re-enables. Pause-only updates to identified schedules are unchanged.

### Enrol a native Codex Manager

After upgrading, run `agent-workbench install` and trust the new hook entries with `/hooks` or, for the default Codex home, `agent-workbench trust`. If the previous install still had the managed `Read|Grep|Glob` entry, removing it shifts later entries. Use `/hooks` to re-trust all entries, including hooks installed by other tools.

This opt-in was designed for T3's native Codex provider on Codex 0.172. A listed top-level Codex session gets the same per-turn Manager workflow as Claude: each new prompt resets the count and approval, and a `Role: Worker` brief marks the session as a Worker. In an unapproved turn, an enrolled Codex Manager must delegate all shell work to a Worker, including read-only commands. Put `Manager work approval: <link>` at the start of the turn to enable shell calls under the shared Manager shell rules. The edit gate still applies to native `apply_patch`, CI logs go to a Worker, and the sixth counted work call in an unapproved turn is blocked. Only tools matched by the installed hooks count. T3 thread launch, creation and model changes follow the shared allowlist and quoted `L3 approval:` rules. [Browser rules](#t3-bot-browser-profiles) also apply. Other Codex sessions keep the ordinary Codex policy.

1. Install the current Workbench hooks on the host running T3's Codex provider. Review and trust them with `/hooks` in Codex using that provider's Codex home (including the new `UserPromptSubmit` and `PreToolUse` entries). For the default home, `agent-workbench trust` is the alternative; `agent-workbench status` reports what is trusted.
2. Once the T3 thread has opened a native Codex session, look up its **native Codex thread ID** (the rollout ID and hook `session_id`), not the T3 thread ID. In T3 0.1.13 the provider thread record in `userdata/statev2.sqlite` stores this as `nativeThreadRef.nativeId`. On the provider host, use the T3 thread ID from its link with this read-only lookup (Node 22.13+):

   ```sh
   t3_thread_id='<T3 thread ID>'
   node --input-type=module - "${T3CODE_HOME:-$HOME/.t3}/userdata/statev2.sqlite" "$t3_thread_id" <<'JS'
   import { DatabaseSync } from 'node:sqlite';
   const db = new DatabaseSync(process.argv[2], { readOnly: true });
   const row = db.prepare(`
     SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS session_id
     FROM orchestration_v2_projection_provider_threads
     WHERE thread_id = ? AND driver = 'codex' AND owner_node_id IS NULL
     ORDER BY updated_at DESC LIMIT 1
   `).get(process.argv[3]);
   console.log(row?.session_id ?? 'No native Codex session yet');
   JS
   ```

3. Add that result to `agent-workbench/codex-managers.json` under the hook's state root (`AGENT_WORKBENCH_STATE_HOME`, then `XDG_STATE_HOME`, then `~/.local/state`). The operator maintains this file; install does not create it. Start a new turn to record that turn's state.

   ```json
   {"sessions": ["<native Codex session ID>"]}
   ```

Remove the ID from the file to roll back. The next hook call uses the ordinary Codex policy, without needing a restart or reinstall. A missing or invalid file enrols no sessions. Spawned Codex agents are excluded by their hook markers or separate session IDs.

This is a cooperative guardrail, not a permission boundary. It trusts an operator-maintained file and approval text in prompts, and only sees the tools its hooks match. Indirect calls that Codex does not surface as those tools are outside the gate. The Codex adapter does not register a `PostToolUse` Worker-model check. For a question that blocks progress, the Stop hook points Codex at `request_user_input` or the Chief PM rather than Claude's question tool.

### Enrol an Antigravity Manager

**Upgrade note:** Enrol your existing Antigravity Managers before upgrading the workspace hook. An unenrolled top-level session now gets Worker rules: it cannot launch, configure, or create threads; create or re-enable schedules with `schedule_task`; use T3 browser tools other than status; start `watch_pull_request`; or run recognized local automation shell commands. Pausing an identified schedule remains allowed.

1. Copy the **T3 thread ID** from the top-level session's T3 link. Use that ID, not Antigravity's hook `conversationId`. This role lookup was verified with T3 0.1.13 and its Antigravity provider.
2. Add it to `agent-workbench/antigravity-managers.json` under the hook's state root (`AGENT_WORKBENCH_STATE_HOME`, then `XDG_STATE_HOME`, then `~/.local/state`). The operator maintains the file; install does not create it.

   ```json
   {"threads": ["<T3 thread ID>"]}
   ```

3. Install or upgrade and select the workspace hook as described above.

The hook reads the trimmed `T3CODE_THREAD_ID` and checks its lineage in `${T3CODE_HOME:-~/.t3}/userdata/statev2.sqlite` using read-only Node SQLite. Only a listed thread whose row has a `lineage` object with `relationshipToParent` explicitly set to JSON `null` is a Manager. Missing lineage, a missing relationship field, and non-null relationships (including subagents) all mean Worker.

**Troubleshooting:** A missing or invalid enrolment file, absent thread ID or row, database error, or unavailable SQLite support gives the session Worker rules. The same applies when the database cannot be opened or queried read-only, for example if a database in WAL mode needs its `-shm` file and the hook process cannot access it. Node's built-in SQLite is available without a feature flag in Node 22.13+; Workbench's hook launcher requires Node 22.20+. Remove the ID to return the thread to Worker policy on the next hook call.

The first matched tool call with changed `lastUserInput` resets the Manager's count and approval. Antigravity has no `UserPromptSubmit` event, and `PreInvocation` runs before a model invocation, not necessarily once per user prompt. The hook stores a digest rather than the prompt text. Identical consecutive prompts are treated as one turn; change the wording to start a distinct turn. Put `Manager work approval: <link>` on its own line in the user prompt for direct work. Without it, native edits (`write_to_file`, `replace_file_content`, `multi_replace_file_content`) are blocked except in the Claude memory path, `generate_image` and mutating `run_command` calls are blocked, and the sixth counted work call is denied. Only matched tools count, including the native read tools covered by the installer. Manager CI-log downloads are blocked even with work approval.

The workspace hook enforces shared T3 thread, watch, scheduling, and [browser rules](#t3-bot-browser-profiles) on the tools it matches under `mcp_t3-code_`. Workers cannot launch, configure, or create T3 threads. The hook does not map Claude's native wakeup tools, `PostToolUse` Worker-model observation, or `Stop` question check. Native Antigravity browser calls, other MCP server names, and any tools outside the workspace matcher are not covered.

This is a cooperative guardrail, not a sandbox. It trusts the provider's thread ID and approval text, not the sender's identity. A process running as the same OS user can change the enrolment, database, turn state or hook, or use an unguarded path. Keep account rights narrow; do not rely on this hook for isolation.

### T3 bot browser profiles

A bot profile keeps a dedicated account's browser sign-in separate from your personal profile. In T3, the owner opens **Settings → Browser profiles → Add profile → Blank profile**, then signs in once in a T3 preview tab using that profile. As a one-time host step, the owner runs `chmod 700 ~/.t3/userdata/server-browser/profiles`.

No bot profiles are enabled by default. List the profile ID and its allowed HTTPS URL prefixes in your `workers.yml` override, then rerun `agent-workbench install` to apply it:

```yaml
policy:
  browser:
    profiles:
      bot-github:
        urls: [https://github.com/onsager-ai/peirce/settings]
```

Run bot chores in the Claude Manager main loop or an enrolled Codex or Antigravity Manager. Put `Manager work approval: <link>` and `Browser task: bot-github <https-link>` on separate lines in the first user prompt of the turn. The next user prompt clears the grant but keeps the session tied to the bot profile. Use a separate session for a different bot profile.

A Manager may use the owner's default profile only for browser work the owner asks for directly in that thread. The hook can't tell an owner message from a peer message, so this is a rule Managers follow, not something the gate enforces. Workers, subagents, and unenrolled Codex or Antigravity sessions have no browser access, including incognito; only `preview_status` is allowed where the hook sees browser calls.

Bot opens require `reuseExistingTab: false`, no `tabId`, and no `target`. Open and navigate URLs must match the configured HTTPS origin and path on a segment boundary. Once a session opens a bot profile, every browser call except status needs a current grant, even opens naming `default` or omitting the profile. Script evaluation is blocked. The hook checks tool calls, not redirects or page clicks; keep the bot account's service permissions narrow. The `chmod 700` step restricts filesystem access by other OS users, and denying Worker browser calls protects the browser path. The hook does not block file reads, and mode `0700` does not isolate processes running as the same OS user.

The hook records allowed bot opens and subsequent preview decisions in `agent-workbench/browser-audit.jsonl` under `AGENT_WORKBENCH_STATE_HOME`, `XDG_STATE_HOME`, or `~/.local/state` (in that order). It logs decision metadata, not typed text, selected values, uploaded paths, or scripts. To revoke access, revoke the bot's access or sign-in at the service first, then remove the config entry, apply the config again, and delete that profile's directory.

Limits: This gate is a cooperative guardrail for agents that follow these rules, not a sandbox. `Browser task:` grants trust to prompt text in the same way as `Manager work approval:`, so a peer message containing those lines can grant access. A process running as the same user can rewrite the hook's state file. The Antigravity hook matches T3 browser tools only under `mcp_t3-code_`; other browser paths are not covered. The real limit is the bot account's own rights; keep them minimal and revoke access at the service.

### Neutral profile for provider switching

For a gateway or CC Switch setup, copy this profile into `~/.agents/skills/workbench-personal/workers.yml` or `~/.config/agent-workbench/workers.yml`. If the file already has a `profiles` mapping, add `neutral` under it.

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

To use `neutral` only for a directory, replace `profile: neutral` with `select: [{path: ~/work, profile: neutral}]`, or add that entry to your existing `select` list.

If your provider has a fallback, define a tier such as `fast-backup` or `standard-backup` under `profiles.neutral.tiers` and list it after `fast` or `standard` in that level. When overriding a ladder, include all three levels and keep L3 approval.

In Claude Code frontmatter, aliases follow the provider's `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` settings. A full model ID pins the route Claude Code requests. The provider may still choose its own upstream for that ID.

When migrating an existing configuration, update the tier keys, ladder entries, and any dispatch references such as `subagent_type` together. Run `agent-workbench install`, then start a new Claude Code session. Use `agent-workbench workers --cwd PATH` to confirm which ladder applies to a directory.

## Context windows

Setup reads the base `policy.context` from `workers.yml`. Claude Code uses `max_tokens` for its shared compaction window for Managers too. `manager_window` is null by default; set it to give models in `manager_models`, which defaults to `[claude-opus-5-5]`, their own window. Per-model settings require Claude Code v2.1.288 or later. A Worker using a Manager model shares that window, and install and status warn about the overlap.

When `manager_window` is set, for a Codex Manager pass `-c model_auto_compact_token_limit=<manager_window>` in the harness launch arguments, for example in T3 Code's Codex provider launch arguments. Workers launched with `codex exec` keep the shared limit. At the configured native threshold, the harness compacts in place in the same thread and the Manager takes no action. Managers and Workers must leave automatic compaction to that native context signal: peer or scheduled `/compact` must not be triggered by idleness, elapsed time, cost alerts, or unknown or stale size estimates, including when context looks large. This is Workbench policy and cannot control external senders; an explicit manual owner command remains available. Existing configured thresholds and restart behavior are unchanged.

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

If you installed the old `thermal` launcher or logger, let running gated commands finish, then run `thermal uninstall` before updating or removing the old skill. If the launcher is off your PATH, use `~/.local/bin/thermal uninstall`. If you have the old skill script but lack the launcher, run `uninstall` through that script (under `host-ops/scripts/thermal` or `thermal-guard/scripts/thermal` in the installed skills directory).

`host-ops` replaces the earlier `thermal-guard` and `disk-cleanup` skill names. If you still have either earlier skill, remove the names you installed and add `host-ops` explicitly. Use the same agent selections as your original install. For project-local copies, run from the project without `-g` and add with `--copy`.

```sh
npx skills remove -g thermal-guard disk-cleanup
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill host-ops -y
```

Run `agent-workbench update` to refresh the installed skills and setup. If update reports `unknown keys in policy: stop_classifier`, the distributed skills and setup command may be on mixed versions; run `agent-workbench install` to refresh setup. This does not require deleting user settings. A command already running from an older installed script cannot display this newer recovery guidance; run the updated command again after refreshing the skills. If you manage skills directly, update `workbench-setup` and `host-ops` through the skills CLI. Update `@onsager/awb` too if you use the npm CLI.

## Thermal operations

Use `awb ops thermal now`, `awb ops thermal gate -- <command>` and `awb ops thermal status` on supported Linux machines. For frequent calls, use `agent-workbench ops thermal` through `~/.local/bin` without `npx`. See the [thermal rules](../skills/host-ops/references/thermal.md) for thresholds and exit codes.

After setup, run `awb ops thermal install` only on machines where you want the background logger. It uses the installed Workbench skill and enables `host-ops-thermal.service` when a supported sensor and user systemd are available. Run `awb ops thermal uninstall` to remove the service. Existing logs and the admission lock stay in `${XDG_STATE_HOME:-$HOME/.local/state}/thermal-guard` across the upgrade.

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

The optional setup installer supports Linux and macOS and needs only Node.js 22.20 or newer. Set up the [optional thermal logger](#thermal-operations) separately on supported Linux machines.

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
| `~/.local/state/agent-workbench/workers.json` | Generated base and profile policy used by the dispatch hook |
| `~/.claude/agents/<tier>.md` | Generated Claude Code subagents, one per routable Worker tier when `orchestrate-harnesses` is installed; each blocks `AskUserQuestion`, and optional `worker_window` sets a minimum-only compaction target for these subagents |
| `~/.claude/settings.json` → `autoCompactWindow`, `modelSettings.<model>.autoCompactWindow`, and optional `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Shared and per-model compaction windows and optional gateway context size |
| `~/.codex/config.toml` → `model_auto_compact_token_limit` and optional `model_context_window` | Shared Codex compaction limit and optional context size |
| `~/.claude/settings.json` → `hooks.PreToolUse` | Owned hooks for L3 approval (Opus by default), GitHub polling and sleep-loop policy, Manager CI log delegation, and protection of local `main`/`master` branches when `orchestrate-harnesses` is installed |
| `~/.codex/hooks.json` and `[hooks.state]` in `~/.codex/config.toml` | Owned Codex policy hooks and, after you confirm, their trust entries when `orchestrate-harnesses` is installed and `~/.codex` exists |
| `~/.local/state/agent-workbench/` | Ownership, hashes, exclusive lock, private backups |

## Managed files and ownership

Install and update regenerate missing or edited `workers.json` from the YAML sources. Setup saves edits in a private `workers.json.edited-<UTC timestamp>` file and prints the path. Use `agent-workbench status` to see whether the file needs regeneration.

The package's `AGENTS.md` is applied immediately after the public block, inside `<!-- BEGIN agent-workbench personal -->` and `<!-- END agent-workbench personal -->`. Keep machine-local private text outside both blocks. Edit personal instructions in the package; edits inside either installed managed instruction block cause a conflict. Install removes the owned personal block if the package or its `AGENTS.md` disappears. Status reports package presence and applied personal files.

The exact public markers are `<!-- BEGIN agent-workbench -->` and `<!-- END agent-workbench -->`. Put machine-local personal rules outside both managed blocks in `~/.agents/AGENTS.md`. On first installation, existing Codex regular-file bytes are kept outside the block unchanged. Existing Claude text stays in place. Neither npx distribution nor this setup changes project instructions, agent settings outside the managed entries, credentials, or native permissions.

Generated agents let a Claude Manager dispatch each tier as `subagent_type: haiku`, `sonnet`, and so on. A tier with no `provider` is generated if it has `harness: claude` or a non-null `claude_route`. Setup generates the union across profiles. The shipped configuration generates `haiku`, `sonnet`, and `opus`. A Claude Manager uses `codex exec` for Codex tiers whose routes are null. Gateway prefixes are installation-specific; set `profiles.codex.tiers.luna.claude_route: <your-gateway>/gpt-6-luna` and `policy.context.gateway_window` in your partial override to generate that route. Rerun `agent-workbench install` after editing the override. Generated files are owned by hash: setup refuses to overwrite a foreign or edited file, leaves other files in `~/.claude/agents` alone, and `uninstall` removes only unmodified owned files.

Setup applies the configured compaction target to owned Claude and Codex config keys when their config directories exist, preserving existing provider routing. Compaction is advisory, not a hard request-token cap; restart running sessions to pick up changes. Setup preserves personal text outside its managed block.

The optional `policy.stop_classifier` workers setting enables model classification for the Stop hook's prose-question check. Set `{url, model}` to use it; while enabled, every turn's final assistant message is sent to that URL, so use the local Magpie gateway. A confident yes blocks for AskUserQuestion; a confident no passes, and uncertain or failed requests use the existing question-mark check. It is off by default.

Workers use a [report checklist](../skills/orchestrate-harnesses/references/worker.md#report-checklist) and end their final response with `Outcome: completed|blocked|cancelled · PR <url> · head <sha> · checks <state>`. Without a PR, only the outcome appears.

## Setup commands and behavior

```sh
# Reapply already distributed public assets (idempotent).
agent-workbench install
# Update this repository's installed skills and workbench-personal, then apply setup.
agent-workbench update
# Inspect hashes, versions, native paths, managed edits and masking overrides.
agent-workbench status [--json]
# Show open PRs and local worktrees for the current repository or PATH.
awb lanes [--cwd PATH] [--json]  # also agent-workbench lanes
# Trust Codex policy hooks after reviewing the prompt.
agent-workbench trust
# Roll back setup while preserving current personal edits.
agent-workbench uninstall
# Print the installed release.
agent-workbench --version
# Report local worktrees/branches whose merged PRs qualify for cleanup, plus
# PR-less branches with no commits beyond the default branch.
awb prune [--repo PATH] [--json]
# Remove eligible local worktrees and branches after reviewing the report.
awb prune --apply
```

`lanes` makes one `gh pr list` call for up to 100 of your open PRs. It shows the check rollup for each head without required-check metadata. The displayed age is the time since the PR was last updated. Worktrees match same-repository PRs by branch name and count commits ahead of the matching `origin` branch, or `origin/HEAD` when there is no remote branch. Worktrees still appear if GitHub is unavailable. Semon ASI will supply Worker state and session stats.

`update` reads native version-3 skills lock ownership (`~/.agents/.skill-lock.json`, or `$XDG_STATE_HOME/skills/.skill-lock.json` when configured) and delegates to `skills@1.7.4 update` with this repository's installed skill names plus `workbench-personal` when present in the lock, regardless of its source. Owned lock entries whose skill directory under `~/.agents/skills` is gone (skills removed upstream and deleted locally) are dropped from the lock first, so the native update stops warning about them. A failed native update leaves global instruction files unchanged. Updates honor the installed native skill source/ref metadata. `npx skills update -g -y` remains available for ordinary updates across all skills; use `agent-workbench install` afterward to apply any newly distributed instruction template.

`agent-workbench update` and `awb setup` refresh the installed personal skill before validating Worker configuration. This lets you recover from a bad installed `workers.yml` by pushing a corrected personal package and rerunning either command. Like its `skills add` step, `awb setup` refreshes the personal skill without the symlink and ownership checks that `agent-workbench update` runs before fetching, so rerun `awb setup` if the refresh fails.

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
2. Create a GitHub release for the merge commit: `gh release create v0.1.1 --target <merge sha> --generate-notes`. This creates the version tag and triggers the Release workflow.

The Release workflow checks that the release tag matches `package.json`, runs the tests and publishes with npm trusted publishing, so no npm token is stored. Running the workflow by hand does a dry run only. Trusted publishing is configured on npmjs.com under the package's settings: publisher GitHub Actions, repository `onsager-ai/agent-workbench`, workflow `release.yml`.
