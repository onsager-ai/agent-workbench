# Worker ladder

## Choose a tier

Choose a level by the work it handles:

| Level | Use for | Default Claude mapping |
| --- | --- | --- |
| L1 | Bounded work; use a small, fast, low-cost model. | haiku / claude-haiku-5-5 / medium |
| L2 | Research, spikes, and architecture; use a capable general model. | sonnet / claude-sonnet-5-5 / medium |
| L3 | Work that needs the strongest model; user approval is required. | opus / claude-opus-5-5 / medium |

Haiku, Sonnet, and Opus are Anthropic's small, mid-size, and largest Claude models. These are defaults: map any models from a gateway or another harness to levels in `workers.yml`.

Always use the resolved ladder from effective configuration. Start at its first level for bounded work. A task kind listed in `start_for` may start at that level; record why. By default, research, spikes, and architecture recommendations start at L2, or can split into narrow L1 probes with L2 synthesis. Give each spike a timebox, typically 20–30 minutes, and accept a partial report with unresolved checks. When a named output such as `FINDINGS.md` is in the brief, it is authorized output. Escalate one level at a time based on actual complexity, defects, or failed attempts. Choose the next level rather than raising effort when more reasoning is needed.

The optional `codex` profile maps Luna then Haiku to L1, Sol then Sonnet to L2, and Opus to L3 with approval. Terra is opt-in outside that ladder for explicit bounded assignments. The maintainer's evaluation history is in [evaluation notes](../../../docs/notes.md).

Within each level, try tiers in listed order. Move to the next tier only with a recorded reason, such as unavailable route, exhausted quota, or failed attempt. Escalation starts at the next level's first tier. Ask the user before dispatching a tier in a level with `approval: required`, give evidence for escalation, and continue below that level or hand back until approved. Approval covers that task only. A tier outside the active ladder and not marked `opt_in` needs user approval. In the codex profile, Terra needs an explicit bounded assignment.

A configured route is not proof of a working tool loop: verify a tool call first. Use effective model and effort values; an unavailable native model needs an explicit routing decision. Choosing a route never changes the tier. In Claude Code, Codex subagents are generated only when an override supplies their gateway routes. If a Manager delegates a Codex tier, it must retain that tier's provider, model, and effort. Do not choose a Claude tier because the dispatch mechanism is uncertain, a worktree is prepared, or Claude tiers are familiar.

When `magpie` is installed, check quota using [Magpie guidance](magpie.md). A fresh reading at or above the tier's weekly brake blocks that tier. Unknown or stale readings need an explicit bounded Manager exception. Never read credentials to obtain usage. Quota informs a recorded Manager choice; it never substitutes tiers automatically.

Apply `policy.max_auto_rework` across tiers after the initial attempt. Reaching the limit is a stuck trigger. Do not reset the count or run endless cheap retries. These are Manager decisions applied through native tools, not controller checks.

## Shape and run assignments

Shape implementation briefs so partial progress counts. Name a concrete first step, such as schema and loader before runtime. Ask for as much of the item list as fits the timebox and require a report on the rest. Require an early WIP commit or push when delivery is authorized. Batch CI fixes per round instead of pushing one fix per run.

A same-harness native Worker needs no justification beyond its brief. A cross-harness Worker is an explicit Manager choice for a concrete capability or cost reason. Record why, what the attempt resolves, and its configured timeout; mention a monetary cap only when configured. Compare effective provider prices instead of assuming cost from the harness. No automatic provider fallback, tier change, or retry.

When T3 Code tools are available, use `delegate_task` for cross-harness or other-machine Workers. Call `orchestrator_capabilities` once per thread before first delegation; put settings in `target.options`, `target.environmentId` for another machine, and `isolation: "worktree"` for a separate checkout. Follow the delegate's `next` rather than polling `task_status` or sleeping. Cancel unneeded delegates with `task_cancel`. Same-provider Workers use native subagents. Only create top-level threads when the user asks. For a Claude Manager, use the [Codex Worker procedure](codex-workers.md) for Codex tiers without a `claude_route`.

For a Codex Manager, choose its native subagent tool when available. If it cannot select the required model, use the user's authorized cross-harness path or report the capability gap. Do not silently use a new CLI process.
