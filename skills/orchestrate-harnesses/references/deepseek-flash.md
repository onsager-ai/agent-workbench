# DeepSeek Flash worker pilot

Use the effective `roles.flash` configuration for an optional bounded Worker attempt: CI failure diagnosis from supplied logs, repository exploration with file/line evidence, a small implementation task, or a second pass over a diff. The Manager retains planning, acceptance and delivery responsibility. Keep the default native ladder until real task results justify a change.

## Route through the available native harness

`cli: claude` selects Claude Code as the client, with DeepSeek served through an already configured compatible gateway. It does not select a Claude model or establish that arbitrary provider models are supported by the native subagent tool. In Claude Code, once the route is configured and `agent-workbench install` has generated the agent, dispatch it as `subagent_type: flash`. Inspect the actual native subagent definition before dispatch. If Flash is unavailable there, report that gap and choose an explicitly justified supported Worker; do not start a standalone CLI process or change the Manager's model to bypass it.

Read the gateway's current model catalog and set the exact client-visible ID in the user's partial model override when configuring this integration. For example, a remote Magpie provider named `onsager` exposes this route:

~~~json
{"roles": {"flash": {"model": "onsager/openrouter/deepseek/deepseek-v4.1-flash-1017"}}}
~~~

The provider prefix is installation-specific. Keep credentials and gateway settings outside this package, and preserve other model overrides. The `flash` role is a `cli: claude` role, so the `model` override above is also what the generated agent uses; rerun `agent-workbench install` after editing it. Magpie's `magpie sync` refreshes its model catalog immediately; remote Magpie providers also advertise automatic refresh. Discovery alone is not evidence of a working agent tool loop. Verify a tool call and response through the intended harness before relying on it for implementation.

## Evaluate useful work

Start with three small tasks with verifiable outcomes. Supply the same bounded evidence and acceptance criteria when comparing Flash with an existing Worker. Record accepted results, defects, corrective attempts, total elapsed time and actual usage/cost in the existing task or PR record. Include reasoning tokens and retries in the comparison. Count Flash attempts toward the same `max_auto_rework`; a failed pilot does not reset it.

Use the configured effort as the starting point. Low reasoning can suit extraction or summaries; high can suit implementation. Apply only levels the route actually exposes. A large advertised context window does not override effective `max_context_tokens`, host resource rules or smaller native limits.

Compare actual provider charges, including cache and long-context tiers. A Flash route can cost less than Sonnet or Opus while exceeding a discounted Haiku rate; the model name is not a price guarantee. A gateway/API fallback handles request failures, not incorrect reasoning, so the Manager still verifies the result.

Sources: [OpenRouter model and endpoints](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017), [DeepSeek agent integration and API formats](https://api-docs.deepseek.com/quick_start/pricing). Capabilities and prices depend on the selected endpoint.
