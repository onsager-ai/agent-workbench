# Manager context handover reminder

Research spike for the 2026-11-21 decision. The installed Manager guide's “Reduce Manager calls” section calls for handover at a phase boundary or around 100,000 tokens. That section was present in the installed skill and absent from the `origin/main` copy of `references/manager.md` used for this spike. The repository defaults `policy.context.max_tokens` to 300,000. Setup currently writes it as the native Claude and Codex auto-compaction setting in their respective user configurations. [Workbench defaults](../../skills/orchestrate-harnesses/workers.yml#L26) · [Setup](../../skills/workbench-setup/scripts/workbench.mjs#L803)

## Claude Code 2.1.330

| Event | Observed scope and identifying fields | Non-blocking output |
| --- | --- | --- |
| `UserPromptSubmit` | Root, first for the submitted prompt and again for the background Agent completion notification. No `agent_id`. No child prompt event observed. | `additionalContext` goes to the model about to run. |
| `PreToolUse` | Root Agent and Bash, plus child Bash. Child has `agent_id` and `agent_type`; all used the root `session_id` and `transcript_path`. | `additionalContext` goes alongside the eventual tool result. |
| `PostToolUse` | Same identity and scope as `PreToolUse`. Fires per tool. The Agent tool's event fired on async launch. | `additionalContext` goes alongside that result. |
| `PostToolBatch` | Root fired once for its two parallel tools. Child fired once for its one Bash with `agent_id` and `agent_type`. Both used the root path. | `additionalContext` goes to the model before the next request. |
| `Stop` | Root turn completion with no `agent_id`, including the second turn for the task notification. | `systemMessage` is a notice. `additionalContext` explicitly continues the turn and incurs another model request. |
| `SubagentStop` | Child completion with `agent_id`, `agent_type`, root `transcript_path`, and separate `agent_transcript_path`. An internal compaction helper emitted it too. | `additionalContext` continues the child, with the same semantics as `Stop`. |

`systemMessage` is for display in these cases. Stream JSON carried root informational notices. The root model reported the four `MODEL_` markers from prompt, pre-tool, post-tool and batch hooks, and reported zero `UI_` markers. Use `agent_id` to exclude native children. A root selected by `--agent` can have `agent_type`, and an independently launched Worker can appear as a root. A missing `agent_id` only identifies the native session level. [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields) · [Context injection](https://code.claude.com/docs/en/hooks#add-context-for-claude) · [Stop](https://code.claude.com/docs/en/hooks#stop-decision-control) · [SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop)

### Recorder and usage

Create an empty working directory and a temporary profile. The fixture agent made a single harmless Bash call. The recorder appended each stdin JSON object and sampled the corresponding transcript when the hook fired.

```bash
spike_dir=$(mktemp -d /tmp/manager-context-cap.XXXXXX)
mkdir -p "$spike_dir/home/.claude/agents" "$spike_dir/work"
cat > "$spike_dir/home/.claude/agents/context-probe.md" <<'EOF'
---
name: context-probe
description: Hook recorder fixture
model: inherit
tools: Bash
effort: low
maxTurns: 2
---
Call Bash exactly once with command `printf CHILD`, then reply only CHILD-OK.
EOF
cat > "$spike_dir/record.py" <<'PY'
import json, pathlib, sys

directory = pathlib.Path(__file__).parent
raw = sys.stdin.read()
event = json.loads(raw)
name = event['hook_event_name']
with (directory / 'events.jsonl').open('a') as log:
    log.write(raw.strip() + '\n')
path = pathlib.Path(event.get('agent_transcript_path') or event['transcript_path'])
rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
last = next((r for r in reversed(rows) if r.get('type') == 'assistant'), {})
u = last.get('message', {}).get('usage') or {}
with (directory / 'snapshots.jsonl').open('a') as log:
    log.write(json.dumps([
        name, event.get('tool_name'), event.get('agent_id'), len(rows),
        [u.get(k) for k in ('input_tokens', 'cache_read_input_tokens',
                            'cache_creation_input_tokens', 'output_tokens')],
        [r.get('subtype') for r in rows if r.get('subtype') == 'compact_boundary'],
    ]) + '\n')
output = {'systemMessage': 'UI_' + name}
if name in {'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolBatch'}:
    output['hookSpecificOutput'] = {'hookEventName': name, 'additionalContext': 'MODEL_' + name}
print(json.dumps(output))
PY
jq -n --arg command "python3 -I $spike_dir/record.py" \
  '{hooks: (["UserPromptSubmit","PreToolUse","PostToolUse","PostToolBatch","Stop","SubagentStop","PreCompact","PostCompact"] | map({key:.,value:[{hooks:[{type:"command",command:$command}]}]}) | from_entries)}' \
  > "$spike_dir/hooks.json"
claude_bin=$(command -v claude)
run_claude() (
  cd "$spike_dir/work" || exit
  exec env -i PATH=/usr/bin:/bin HOME="$spike_dir/home" CLAUDE_CONFIG_DIR="$spike_dir/home/.claude" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:3425 ANTHROPIC_AUTH_TOKEN=spike-local \
    ANTHROPIC_MODEL=onsager/auto/claude-haiku-5-5 DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_MAX_OUTPUT_TOKENS=512 \
    timeout 55s "$claude_bin" -p --setting-sources user --settings "$spike_dir/hooks.json" \
    --tools Agent,Bash --allowedTools Agent Bash --effort low \
    --output-format stream-json --verbose --forward-subagent-text "$@"
)
run_claude --max-turns 4 -- 'Call Agent once with subagent_type context-probe and description Hook probe. Tell it to call Bash once with printf CHILD, then reply CHILD-OK. After launching it, call Bash once with printf PARENT. In your final reply list any literal MODEL_ and UI_ markers visible to you.' > "$spike_dir/run.jsonl" 2> "$spike_dir/run.err"
printf 'claude exit=%s\n' "$?"
jq -cr '[.hook_event_name,.tool_name,.agent_type,has("agent_id"),(.transcript_path|split("/")|last|startswith("agent-")),has("agent_transcript_path"),(.tool_calls|length)]' "$spike_dir/events.jsonl"
cat "$spike_dir/snapshots.jsonl"
session=$(jq -r 'select(.hook_event_name=="Stop")|.session_id' "$spike_dir/events.jsonl" | head -1)
run_claude --resume "$session" -- '/compact' > "$spike_dir/compact.jsonl" 2> "$spike_dir/compact.err"
printf 'compact exit=%s\n' "$?"
run_claude --resume "$session" --max-turns 1 -- 'Reply only AFTER.' > "$spike_dir/after.jsonl" 2> "$spike_dir/after.err"
printf 'after exit=%s\n' "$?"
jq -c 'select(.subtype=="compact_boundary")|.compact_metadata|{trigger,pre_tokens,post_tokens}' "$spike_dir/compact.jsonl"
transcript=$(jq -r 'select(.hook_event_name=="Stop")|.transcript_path' "$spike_dir/events.jsonl" | head -1)
jq -c 'select(.type=="assistant")|.message.usage|[.input_tokens,.cache_read_input_tokens,.cache_creation_input_tokens,.output_tokens]' "$transcript"
```

All three Claude runs exited `0`. The root's first request produced three JSONL assistant rows for the same `.message.id` (thinking and two tool uses), each with `[10228,0,0,169]`. Subsequent distinct replies were `[11097,0,0,137]` and `[11698,0,0,47]`. `PreToolUse` and `PostToolUse` saw no assistant usage on the first root request. `PostToolBatch` saw `10228` input. The first `Stop` still saw `10228` while the following prompt hook saw `11097`. Child tool hooks sampled the root's `10228`, and `SubagentStop` sampled `5037` in the child file.

Manual compaction reported `{"trigger":"manual","pre_tokens":11745,"post_tokens":1469}`. At hook time `PostCompact` still saw `11698` input with no boundary on disk. The resumed prompt and its `Stop` both saw the boundary but still found `11698` when looking backward for any assistant message. After exit the first new assistant row returned `11163` input, below the pre-compaction API input. The compaction event's `1469` is a different measurement and would undercount the next full prompt here. The gateway counts looked plausible for the small test and included input overhead beyond visible conversation. The three Anthropic input buckets sum to the input for one request. Cache buckets were zero in this run. The real Claude transcript used for the benchmark below had positive cache usage in 250 of 253 assistant rows with usage. That confirms the fields occur in real transcripts. It does not validate the accuracy of every gateway route. [Anthropic input usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-is-the-cache-read-input-tokens-field)

## Codex CLI 0.171.0

The isolated Codex session returned `OK` and exited `0`. Its fresh `$CODEX_HOME/hooks.json` recorder produced no file. The hook contract requires a separate review of each non-managed hook definition. I kept native trust settings intact, so the hook behavior below comes from the release source and docs. The runtime probe verifies the rollout record independently of hook execution. [Codex hook trust](https://developers.openai.com/codex/hooks#review-and-trust-hooks)

```bash
mkdir -p "$spike_dir/codex-home"
jq --arg command "cat >> $spike_dir/codex-events.jsonl" \
  '.hooks |= with_entries(select(.key != "PostToolBatch") | .value[0].hooks[0].command = $command)' \
  "$spike_dir/hooks.json" > "$spike_dir/codex-home/hooks.json"
codex_bin=$(command -v codex)
env -i PATH=/usr/bin:/bin HOME="$spike_dir/home" CODEX_HOME="$spike_dir/codex-home" \
  timeout 40s "$codex_bin" exec --skip-git-repo-check -C "$spike_dir/work" -s read-only --json \
  -c 'model_provider="probe"' -c 'model_providers.probe.name="Probe"' \
  -c 'model_providers.probe.base_url="http://127.0.0.1:3425/v1"' \
  -c 'model_providers.probe.wire_api="responses"' -c 'model_providers.probe.request_max_retries=0' \
  -c 'model_providers.probe.stream_max_retries=0' -c 'model_reasoning_effort="low"' \
  -m 'onsager/codex/gpt-6-luna' 'Reply only OK.' > "$spike_dir/codex-run.jsonl" 2> "$spike_dir/codex-run.err"
printf 'codex exit=%s\n' "$?"
rollout=$(find "$spike_dir/codex-home/sessions" -name 'rollout-*.jsonl' -print -quit)
jq -c 'select(.type=="event_msg" and .payload.type=="token_count") | .payload.info' "$rollout"
test -e "$spike_dir/codex-events.jsonl"
printf 'codex recorder exists exit=%s\n' "$?"
```

`codex recorder exists exit=1`. The rollout's `last_token_usage` reported `input_tokens: 16058`, `cached_input_tokens: 3712`, `cache_write_input_tokens: 0`, `output_tokens: 5`, `reasoning_output_tokens: 0`, and `total_tokens: 16063`. The thread total happened to equal it in this one-response run. Codex emitted a fallback model metadata warning, so the reported `model_context_window: 258400` is not a verified capacity for the route.

| Event | Scope in the release source | Non-blocking output |
| --- | --- | --- |
| `UserPromptSubmit` | Runs for `TurnInput::UserInput`. The request populates `agent_id` and `agent_type` on a thread-spawn child when handling that input. Internal agent messages and tool results take other branches. | `additionalContext` adds developer context. |
| `PreToolUse` / `PostToolUse` | Both root and thread-spawn child on covered tool paths. Both attach child IDs/type, and the runtime sets `transcript_path` from the executing session. | `additionalContext` adds developer context. Hosted tools can bypass local tool hooks. |
| `Stop` / `SubagentStop` | Root turns use `Stop`. Spawned children use `SubagentStop`, with child `agent_id` and `agent_type`, parent `transcript_path`, and separate `agent_transcript_path`. Other synthetic subagent sources skip this dispatch. | `systemMessage` is a warning. `decision: "block"` or exit 2 starts a continuation with the reason. |

The docs describe a parent `session_id` for subagent hooks. The tagged runtime supplies `sess.session_id()` to the serializers, and `agent_id` is the child thread ID. Use the explicit child field to distinguish scope. The event matrix comes from source, and exact child-versus-parent session ID values remain unverified at runtime. [Codex hooks](https://developers.openai.com/codex/hooks) · [0.171.0 hook runtime](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/hook_runtime.rs) · [0.171.0 stop serialization](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/hooks/src/events/stop.rs)

Read the newest `event_msg` with `payload.type == "token_count"` and non-null `payload.info`. Use `last_token_usage.total_tokens` for Codex's context-window estimate, or `last_token_usage.input_tokens` for a comparison of request input on both harnesses. Codex includes cached input in `input_tokens`. The thread-wide `total_token_usage` accumulates spending across requests. The local compaction path recomputes usage after replacing history, so fresh post-compaction usage can be an estimate. A compacted record newer than the most recent usage is a reason to wait for an updated count. Live Codex compaction and token-record write timing at tool hooks remain unverified. Codex explicitly treats rollout schema as an unstable hook interface. [0.171.0 usage types and context-window method](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/protocol/src/protocol.rs#L2576-L2679) · [0.171.0 compaction](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/compact.rs#L451-L475) · [Codex transcript contract](https://developers.openai.com/codex/hooks#common-input-fields)

## Transcript read cost

Copied one completed real Claude transcript to a private temporary file and timed reads on Node `v24.22.0`. Each method warmed up for five iterations and timed 50, with each result checked against the full scan. No transcript content or session identifiers are included in the result. The anonymous path below stands for the source transcript. The benchmark excludes Node process startup and measures in-process reads with a warm OS file cache.

```bash
cp "$source_transcript" "$spike_dir/benchmark.jsonl"
cat > "$spike_dir/bench.cjs" <<'JS'
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const path = process.argv[2];
function newest(text) {
  for (const line of text.trimEnd().split('\n').reverse()) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'system' && row.subtype === 'compact_boundary') return row.uuid;
    if (row.type === 'assistant' && row.message?.usage) return row.message.id;
  }
}
function wholeScan() {
  let key;
  for (const line of fs.readFileSync(path, 'utf8').trimEnd().split('\n')) {
    const row = JSON.parse(line);
    if (row.type === 'system' && row.subtype === 'compact_boundary') key = row.uuid;
    if (row.type === 'assistant' && row.message?.usage) key = row.message.id;
  }
  return key;
}
function tail() {
  const fd = fs.openSync(path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const bytes = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(bytes);
    const offset = size - bytes;
    const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, offset));
    return newest(offset ? text.slice(text.indexOf('\n') + 1) : text);
  } finally { fs.closeSync(fd); }
}
const expected = wholeScan();
console.log(`bytes=${fs.statSync(path).size} samples=50`);
for (const [name, scan] of Object.entries({ wholeScan, wholeReverse: () => newest(fs.readFileSync(path, 'utf8')), tail })) {
  const samples = [];
  for (let index = 0; index < 55; index++) {
    const start = performance.now();
    if (!expected || scan() !== expected) throw new Error(`${name}: result mismatch`);
    if (index >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${name} p50=${samples[24].toFixed(3)}ms p95=${samples[47].toFixed(3)}ms`);
}
JS
node "$spike_dir/bench.cjs" "$spike_dir/benchmark.jsonl"
printf 'benchmark exit=%s\n' "$?"
```

```text
bytes=1999656 samples=50
wholeScan p50=7.060ms p95=8.868ms
wholeReverse p50=2.589ms p95=2.659ms
tail p50=0.043ms p95=0.086ms
benchmark exit=0
```

`wholeScan` uses `readFileSync(path, 'utf8')`, splits on newlines, parses all JSON records, and retains the latest assistant usage or compact boundary key. `wholeReverse` reads and splits the whole file, then walks backward and stops at the first relevant record. `tail` opens the file, uses `fstatSync` for its size, reads its last 64 KiB with positional `readSync`, drops the first fragment when the read starts at a nonzero offset, and uses the same backward lookup. All three found the same record for this copy. The existing policy hook already uses a bounded 256 KiB transcript read for separate checks. A bounded reader can miss usage after a large tool result or if the relevant JSONL record straddles the start of the window. [Current policy hook](../../skills/orchestrate-harnesses/scripts/policy-hook.mjs#L421)

## Recommendation

1. **Claude primary event.** Register `PostToolBatch` and return `hookSpecificOutput.additionalContext` before the next Manager request, using the 2.1.330 contract verified here. Its once-per-batch cadence meets the mid-turn reminder requirement and avoids running N scans for N parallel tools. Keep the existing Agent-specific `PostToolUse` check for Worker model verification. Add `UserPromptSubmit` for tool-free turns and resumed sessions with already persisted usage. A tool-free turn that crosses the threshold can be detected on the next prompt. `Stop` could optionally show a user notice, but model-visible feedback there forces another invocation, contrary to the goal of reducing Manager calls. A background task notification can also invoke the prompt hook, so it shares the same reminder deduplication.
2. **Manager identity and measurement.** Run only for a known Workbench Manager and skip `agent_id` events before touching the transcript. Supply the role from a launch path Workbench controls, or limit the feature to explicitly enabled Manager launches until those paths can signal their role. An independently launched CLI Worker has no native subagent identity. In Claude use one latest complete root assistant request's `message.usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Treat absent optional cache counters as zero and missing, all-zero, or invalid usage as unknown. Skip synthetic assistant messages and sidechain records, and identify duplicate blocks by `message.id`. A compact boundary newer than the newest valid usage makes the sample unknown. Prefer an observed fresh request after the boundary over old counts or `compactMetadata.postTokens`. The result measures the last request's input, including fixed prompts and tools. It lags output and pending tool results. A large result, skipped hook, off-disk transcript, or compaction before the next sampled event can leave the reminder late or absent.
3. **Threshold and re-fire.** Add a positive integer or explicit `null` at `policy.context.manager_handover_tokens` in effective `workers.yml`, defaulting to `100000` and preserving `null` as off. Extend the setup parser and validation alongside the existing `policy.context` settings and have the installed hook read the effective profile. Keep `context.max_tokens` in the native setup and leave both harnesses' auto-compaction paths in place. Emit at the threshold and repeat after another 10,000 measured tokens above the last emitted count, only on a fresh request sample. This suggested step lets the Manager finish a phase without seeing the reminder for every tool or prompt hook. Key the last emission to the session and compaction generation or clear it after a verified below-threshold sample. Use one small session-local checkpoint for deduplication across hook processes and coordinate concurrent updates where a harness can run matching tool hooks together. The text should suggest writing lane handover state and continuing in a fresh session. The hook leaves the decision and execution to the Manager.
4. **Codex follow-on.** Use `UserPromptSubmit` and `PostToolUse` for model-visible reminders on the supported tool paths. Compare Codex's latest input count if the same threshold should cover request input on both harnesses. Gate rollout support on a trusted hook probe that verifies sample freshness on root and child events and through live compaction. Adding those events requires extending Codex hook ownership in setup, which currently manages `PreToolUse` and `Stop`. Claude's `PostToolBatch` has no Codex counterpart in this release's hook event contract. [Codex events](https://developers.openai.com/codex/hooks#hook-events) · [Workbench Codex hook installation](../../skills/workbench-setup/scripts/workbench.mjs#L1004)

Start with bounded reads and return silently when the current sample is unavailable. Tune or add bounded backward chunk reads only if real workloads regularly miss samples. This spike covers small headless runs, one manual Claude compaction and one local read benchmark. Automatic compaction around 100,000 tokens, interactive/SDK parity, same-event write ordering under load, gateway usage accuracy across providers, and the Manager role signal across entry points still need verification.
