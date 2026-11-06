# DeepSeek Flash Worker

`flash` is an opt-in Worker outside the ladder, used only when the user asks for it. Its per-token provider billing and large per-call context made it costlier than luna in practice. Suitable work: CI failure diagnosis from supplied logs, repository exploration with file/line evidence, a small implementation task, or a second pass over a diff. The Manager retains planning, acceptance and delivery responsibility. Give it work that fits in one context; send long or compaction-prone work to luna or haiku.

## Route through the Codex harness

`cli: codex` runs Flash in Codex, with DeepSeek served through the Codex model provider (for example, a Magpie gateway). A Codex Manager selects it as a native Codex model; a Claude Manager runs it as a [Codex Worker](../SKILL.md#codex-workers-from-a-claude-manager) with `codex exec -m <model>`. It is not a generated Claude Code subagent: gateway-routed non-Claude models in Claude Code have lost tool use after compaction. If the provider does not expose the model, report that gap and choose an explicitly justified supported Worker; do not change the Manager's model to bypass it.

Read the provider's current model catalog and set the exact client-visible ID in the user's partial model override when it differs from the default. For example:

~~~json
{"roles": {"flash": {"model": "openrouter/deepseek/deepseek-v4.1-flash-1017"}}}
~~~

The provider ID is installation-specific. Keep credentials and gateway settings outside this package, and preserve other model overrides. Magpie's `magpie sync` refreshes its model catalog immediately; remote Magpie providers also advertise automatic refresh. Discovery alone is not evidence of a working agent tool loop. Verify a tool call and response through the intended harness before relying on it for implementation.

Codex may have no model metadata for this ID and fall back to a default context window. Gateway usage reports for it have overstated input tokens roughly tenfold, which can trigger early compaction; check provider billing rather than reported tokens.

## Evaluate useful work

Record accepted results, defects, corrective attempts, total elapsed time and actual usage/cost in the existing task or PR record. Include reasoning tokens and retries in comparisons. Count Flash attempts toward the same `max_auto_rework`; a failed attempt does not reset it.

Use the configured effort as the starting point. High is the default: published comparisons show no quality gain at max, with longer runs and higher cost. Low reasoning can suit extraction or summaries. Apply only levels the route actually exposes. A large advertised context window does not override effective `max_context_tokens`, host resource rules or smaller native limits.

Compare actual provider charges, including cache and long-context tiers. A Flash route can cost less than Sonnet or Opus while exceeding a discounted Haiku rate; the model name is not a price guarantee. A gateway/API fallback handles request failures, not incorrect reasoning, so the Manager still verifies the result.

Sources: [OpenRouter model and endpoints](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017), [DeepSeek agent integration and API formats](https://api-docs.deepseek.com/quick_start/pricing), [VulcanBench effort comparison](https://vulcanbench.com/models/deepseek-v4-1-flash.html). Capabilities and prices depend on the selected endpoint.
