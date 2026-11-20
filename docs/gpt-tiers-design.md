# GPT tiers in Claude Code: design

Status: section 1 (post-run model check) shipped in #66 on 2026-11-20. Sections 2 and 3 and the Magpie questions are open.

## Problem

A Claude Manager runs the luna, terra and sol tiers as native Claude Code subagents. Claude Code only talks to Claude models, so this works because Magpie, a local gateway at `ANTHROPIC_BASE_URL`, accepts Claude-style requests and forwards them to GPT models. Claude Code has no idea a GPT model is on the other end. Any part of it that assumes a Claude model can fail without an error.

We have hit two of these so far:

- **Context window.** Claude Code assumes a 200k window for model IDs it doesn't recognise. Gateway subagents compacted too early, kept re-compacting and stopped using tools. Fixed by `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `policy.context.gateway_window`.
- **The `model` argument.** The Agent tool's `model` argument only accepts `sonnet`, `opus` and `haiku`, and it overrides the model in the agent file. On 2026-11-19 a Manager passed `model: "sonnet"` to luna and sol dispatches, and all of them ran on Sonnet. Nothing reported the substitution. PR #64 now denies `model` on named agent types.

Both failures were silent. We found them only by reading transcripts afterwards.

## How a tier reaches its model today

`agent-workbench install` writes one agent file per tier in `~/.claude/agents/`. For a GPT tier, the file's `model:` is the tier's `claude_route`, for example `onsager/codex/gpt-6-luna`. Claude Code sends that ID to Magpie, and Magpie picks the backend.

When a tier has no `claude_route`, the Manager runs it with `codex exec` instead. That is the real Codex CLI, with no gateway involved.

## What the transcripts show

Each subagent transcript (`<session>/subagents/agent-<id>.jsonl`) records the model that answered each turn in `message.model`. Today's luna and sol runs on this machine:

| Agent file route | Recorded model |
|---|---|
| `onsager/codex/gpt-6-luna` | `codex/gpt-6-luna` |
| `onsager/codex/gpt-6.1-sol` (before the 6.2 switch) | `codex/gpt-6.1-sol` |
| `onsager/codex/gpt-6.2-sol` | `codex/gpt-6.2-sol` |
| luna or sol with `model: "sonnet"` | `group/auto-claude-sonnet-5-5` |

So the recorded model is a reliable signal of what ran, but its name differs from the requested ID. The `onsager/` prefix is dropped, and routing groups come back as `group/auto-…`.

Also: `agent-workbench status` warns that `onsager/codex/gpt-6.2-sol` is absent from `magpie models claude`, but requests to it do reach `codex/gpt-6.2-sol`. Either the catalog lags behind what Magpie routes, or the route works only by a fallback. We should find out which.

## Proposal

### 1. Report the model that actually ran (do first)

Add a check after each Agent/Task dispatch. It reads the Worker's transcript, collects the recorded models, and compares them with the tier's expected model from the effective `workers.yml`. On a mismatch it tells the Manager, for example: "This sol Worker ran on group/auto-claude-sonnet-5-5, not gpt-6.2-sol." The Manager then puts the real model in its report.

This catches every kind of wrong model: an override, a Magpie fallback, a stale route, or a typo in a personal override. That includes failures we haven't thought of yet. It doesn't depend on Claude Code's internals beyond the transcript format.

The check should warn, not block. The work has already run by the time it fires.

#### Spike result (2026-11-19)

A temporary project-local `PostToolUse` hook on `Agent|Task` was run against one foreground haiku dispatch. Findings:

- **The note reaches the Manager.** The hook's `hookSpecificOutput.additionalContext` showed up in the Manager's context right after the Agent result.
- **The hook gets two model signals.** `tool_response` includes `agentId`, `agentType` and `resolvedModel`. `resolvedModel` is the model Claude Code asked for after applying any override: `claude-haiku-5-5` for this probe. In the AW PM transcript it was `onsager/auto/claude-sonnet-5-5` for the overridden luna and sol runs, and `onsager/codex/gpt-6-luna` for normal luna runs.
- **The Worker transcript can be found.** It is at `<transcript_path without .jsonl>/subagents/agent-<agentId>.jsonl`, and its `message.model` values show what Magpie answered with: `group/auto-claude-haiku-5-5` for this probe.

So the check can run in two steps:

1. **Requested model.** Compare `resolvedModel` with the agent file's `model:` for `agentType`. They must match exactly. This step needs no naming rules or file reads, and it would have caught the AW PM override.
2. **Answering model.** Compare the transcript's models with the tier. This step catches Magpie fallbacks, but it needs a naming rule. Dropping `onsager/` works for Codex routes. Routing groups (`onsager/auto/…` requested, `group/auto-…` recorded) need a rule from Magpie (see open questions). Until Magpie gives one, this step should only report names it can't match, not treat them as errors.

Not yet tested: background dispatches (`run_in_background: true`). Their Agent result returns before the Worker finishes, so the transcript check would need `SubagentStop` or a check when the result notification arrives. Workbench Workers run in the foreground today, so this can wait.

### 2. List the remaining Claude-only assumptions

Go through the Claude Code features Workers use and record, for each one, whether it works through Magpie with a GPT model: effort levels, extended thinking, prompt caching, cost and token reporting, image input, and tool-call formats. `CLAUDE_CODE_MODEL_CAPABILITIES` in `~/.claude/settings.json` already declares effort support per model ID. agent-workbench doesn't write it, and it still lists retired IDs like `onsager/codex/gpt-6.1-sol`. Each item gets one of three outcomes: works, fixed in setup, or documented limitation.

### 3. Keep `codex exec` as the fallback path

If a feature turns out to be unreliable through the gateway, that tier goes back to `claude_route: null` and runs with `codex exec`. This path already exists, so no new mechanism is needed.

## Alternatives considered

- **Use only `codex exec` for GPT tiers.** It needs no gateway workaround, but Workers lose T3 nesting, worktree isolation and the Claude Code hooks, and each run starts a separate process the Manager has to track. Today's gateway subagents did their work correctly whenever the right model was used, so dropping the gateway path seems too costly.
- **Block before dispatch only (what PR #64 does).** It's cheap, but it can only catch mistakes that are visible in the request. It can't see what Magpie actually did.

## Open questions for Magpie

1. Can a `codex/…` route ever fall back to a different model or provider, or does it fail?
2. What does a `group/auto-…` routing group resolve to, and does the transcript ever show the backend actually used?
3. Is `magpie models claude` the full list of routable IDs? If so, why does `onsager/codex/gpt-6.2-sol` route when it isn't listed?
4. Should agent-workbench own the GPT entries in `CLAUDE_CODE_MODEL_CAPABILITIES`, or should whatever writes them now (probably Magpie) keep them up to date?
