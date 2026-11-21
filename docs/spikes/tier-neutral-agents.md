# Tier-neutral Claude Code agents

## Findings

CC Switch Direct mode updates provider fields in `~/.claude/settings.json`. In the `env` object, `ANTHROPIC_BASE_URL` sets the endpoint, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` supplies authentication, and `ANTHROPIC_MODEL` selects the main session model. The provider form also sets `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `ANTHROPIC_DEFAULT_FABLE_MODEL` for the corresponding aliases. The associated `_NAME` fields are display labels. [Direct switching](https://github.com/farion1231/cc-switch/blob/5a5111b0a0255702d749511ddf00e44c78ba04fc/docs/user-manual/en/2-providers/2.2-switch.md) · [Provider form](https://github.com/farion1231/cc-switch/blob/5a5111b0a0255702d749511ddf00e44c78ba04fc/src/components/providers/forms/ClaudeFormFields.tsx#L649-L706) · [Example settings](https://github.com/farion1231/cc-switch/blob/5a5111b0a0255702d749511ddf00e44c78ba04fc/src/config/claudeProviderPresets.ts#L3044-L3054)

CC Switch Routing mode points `ANTHROPIC_BASE_URL` at its local proxy, writes placeholder auth, and can map requested Claude roles to upstream models or use a configured fallback. A provider can therefore rewrite even a literal ID after Claude Code sends it. This probe used Magpie directly and exercised client-side resolution. [CC Switch routing guide](https://github.com/farion1231/cc-switch/blob/5a5111b0a0255702d749511ddf00e44c78ba04fc/docs/guides/claude-codex-routing-guide-en.md#step-2-enable-local-routing-and-take-over-claude-code)

Claude Code documents four aliases for the Agent tool's `model` parameter (`sonnet`, `opus`, `haiku`, `fable`). The frontmatter accepts aliases, full model IDs, and `inherit`. The invocation parameter takes precedence over frontmatter in the standard model order. [Subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model)

### Magpie probe

`claude --version` returned `2.1.330 (Claude Code)`. The catalog query returned the three `onsager/...` routes below and no exact `claude-sonnet-5-5` entry.

```sh
curl -fsS --max-time 8 http://127.0.0.1:3425/v1/models |
  jq -r '.data[].id | select(.=="claude-sonnet-5-5" or .=="onsager/codex/gpt-6-luna" or .=="onsager/auto/claude-haiku-5-5" or .=="onsager/auto/claude-sonnet-5-5")'
```

The test created three agents and a recorder in a temporary profile. The script below uses `claude` resolved from the caller's path. The actual run used its absolute path. Each agent could take one turn, and only Agent was enabled in the parent.

```bash
spike_dir=$(mktemp -d /tmp/tier-neutral-agents.XXXXXX)
mkdir -p "$spike_dir/home/.claude/agents" "$spike_dir/work"
for spec in 'l2-a sonnet' 'l2-b claude-sonnet-5-5' 'l2-c onsager/auto/claude-sonnet-5-5'; do
  read -r agent model <<< "$spec"
  cat > "$spike_dir/home/.claude/agents/$agent.md" <<EOF
---
name: $agent
description: Model routing test fixture $agent
model: "$model"
effort: low
maxTurns: 1
---
Reply with only OK. Do not use tools.
EOF
done
jq -n --arg dir "$spike_dir" '{hooks:{PostToolUse:[{matcher:"Agent",hooks:[{type:"command",command:("cat >> " + $dir + "/post.jsonl")}]}]}}' > "$spike_dir/hooks.json"
claude_bin=$(command -v claude)
(
  cd "$spike_dir/work" &&
  env -i PATH=/usr/bin:/bin HOME="$spike_dir/home" CLAUDE_CONFIG_DIR="$spike_dir/home/.claude" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:3425 ANTHROPIC_AUTH_TOKEN=spike-local \
    ANTHROPIC_MODEL=onsager/auto/claude-haiku-5-5 \
    ANTHROPIC_DEFAULT_SONNET_MODEL=onsager/codex/gpt-6-luna \
    DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CLAUDE_CODE_MAX_OUTPUT_TOKENS=512 timeout 85s "$claude_bin" -p \
    --setting-sources user --settings "$spike_dir/hooks.json" --tools Agent --allowedTools Agent \
    --effort low --max-turns 2 --output-format stream-json --verbose --forward-subagent-text \
    'In this turn call Agent once for each exact subagent_type l2-a, l2-b, and l2-c, in parallel, with prompt "Reply only OK" and description "Routing probe". Omit the model field. After the tools finish, reply only DONE.'
) > "$spike_dir/run.jsonl" 2> "$spike_dir/run.stderr"
printf 'claude exit=%s\n' "$?"
jq -c '{type:.tool_input.subagent_type,status:.tool_response.status,agentType:.tool_response.agentType,model:.tool_response.resolvedModel}' "$spike_dir/post.jsonl"
jq -c 'select(.type=="assistant" and .parent_tool_use_id!=null) | {model:.message.model,text:[.message.content[]|select(.type=="text")|.text]}' "$spike_dir/run.jsonl"
```

`claude exit=0`. The parent init model was `onsager/auto/claude-haiku-5-5` and the final output was `DONE`. Joining the three Agent calls to their forwarded subagent replies gives:

| Agent | Frontmatter | Hook `resolvedModel` and reply `message.model` | Reply |
| --- | --- | --- | --- |
| `l2-a` | `sonnet` | `onsager/codex/gpt-6-luna` | `OK` |
| `l2-b` | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `OK` |
| `l2-c` | `onsager/auto/claude-sonnet-5-5` | `onsager/auto/claude-sonnet-5-5` | `OK` |

The alias followed the remap despite the CLI emitting `[claude-code:unrecognized_model]` for the Codex route. The full ID bypassed the client-side alias map and Magpie accepted it even though it was absent from the catalog. A stricter provider could reject it. The reported ID cannot establish which upstream Magpie chose for the bare ID. The explicit gateway ID and neutral names worked through native Agent calls.

The recorder got one `PostToolUse` per call, each with `status: "async_launched"`, `agentId`, and `resolvedModel`. The `agentType` field was absent. Completions arrived as separate stream events with `status: "completed"` and `summary: "OK"`.

A follow-up used the same invocation with `timeout 55s`, `--settings "$spike_dir/hooks-stop.json"`, and the prompt below. It exited 0. `SubagentStop` reported `agent_type: "l2-a"`, `last_assistant_message: "OK"`, and an `agent_transcript_path`. The payload had no model field. Reading the transcript after exit returned `onsager/codex/gpt-6-luna` for `.message.model`.

```bash
jq --arg dir "$spike_dir" '.hooks.SubagentStop = [{matcher:"l2-a",hooks:[{type:"command",command:("cat >> " + $dir + "/stop.jsonl")}]}] | .hooks.PostToolUse[0].hooks[0].command = ("cat >> " + $dir + "/post-stop.jsonl")' "$spike_dir/hooks.json" > "$spike_dir/hooks-stop.json"
# Prompt used with the same CLI flags and the changes above:
# Call Agent exactly once with subagent_type l2-a, description "Routing probe", and prompt "Reply only OK". Omit the model field. Afterward reply only DONE.
jq -c '{agent_type,last_assistant_message,agent_transcript_path,model}' "$spike_dir/stop.jsonl"
jq -r '.agent_transcript_path' "$spike_dir/stop.jsonl" |
  xargs -r -d '\n' jq -cr 'select(.type=="assistant") | .message.model'
```

## Recommendation

Keep existing tier keys as the default during rollout. Offer neutral keys such as `l2-a` and `l2-b` in a provider-switching profile, with a slot for each fallback and an explicit key for opt-in tiers. The Codex profile already orders `[luna, haiku]` at L1 and `[sol, sonnet]` at L2, so a single `l2` would lose a choice. Tier names make today's lineup easier to read. Neutral keys keep dispatch stable when models change. Keep the slot assignments explicit so reordering the ladder cannot silently change the model behind a name. [Worker profiles and ladder](../../skills/orchestrate-harnesses/workers.yml)

Use the same keys in `tiers`, `ladder`, and the generated agent filenames. The generator already uses the configured model or `claude_route` as frontmatter, and the approval hook already looks up the chosen key in the active profile. Its ban on per-call overrides already covers neutral custom names. Renaming only the Claude files would require a name-to-tier lookup in both hooks and dispatch instructions. Otherwise the approval hook treats the new name as unknown and the mismatch hook skips it. A global agent file can hold only one model and effort for a given name. The installer already rejects differing definitions for a name across profiles, so use distinct keys when profiles need different pinned routes or effort. [Generator](../../skills/workbench-setup/scripts/workbench.mjs#L781) · [Policy hook](../../skills/orchestrate-harnesses/scripts/policy-hook.mjs#L528)

Let users pick frontmatter aliases to follow their provider settings, or full IDs to pin a route. Compare a pinned ID against the launch payload's `resolvedModel`. For aliases, compare against the effective alias target where known, taking the hook's inherited `ANTHROPIC_DEFAULT_*_MODEL` into account. Where the effective target is unknown, report the observed ID without claiming a mismatch against the literal alias. Approval still follows the configured slot, so anyone remapping a slot should choose a target that fits its cost and capability. The optional Magpie catalog warning would also need to resolve aliases before checking for a catalog entry. A gateway's upstream choice needs provider-side evidence. [Alias settings](https://code.claude.com/docs/en/model-config#environment-variables)

The current mismatch hook requires `status === "completed"` and `tool_response.agentType`. It skipped the observed async payload shape. Use `tool_input.subagent_type` and `resolvedModel` at launch to check the requested route and keep the completed path where available. Async completion checking needs its own event if Workbench intends to verify the reply model. `SubagentStop` gives the agent key and transcript path, but its feedback goes to the subagent and the transcript may lag. Verify delivery to the Manager and transcript timing before adopting that completion path. [Mismatch hook](../../skills/orchestrate-harnesses/scripts/policy-hook.mjs#L463) · [SubagentStop contract](https://code.claude.com/docs/en/hooks#subagentstop)

For existing installations, make the neutral profile opt-in. On migration, update the `tiers` keys, ladder and dispatch references together, rerun `agent-workbench install`, then start a new Claude Code session. The installer already adds new names and removes retired files whose recorded hashes still match, and reports a conflict on edited or foreign files. Retain legacy profiles while callers still use their keys. If old names and new names ever coexist for one slot, both must resolve to the same approval and mismatch policy. [Agent ownership checks](../../skills/workbench-setup/scripts/workbench.mjs#L1171) · [Installer transaction](../../skills/workbench-setup/scripts/workbench.mjs#L1527)

The probe used stock Claude Code with temporary fixtures. CC Switch's full takeover behavior, Magpie's upstream choice for the bare ID, and a Workbench install and upgrade with neutral keys remain unverified.
