# Optional Magpie integration

If you use Magpie and the `magpie` CLI is installed, use its local CLI for routing context, quota checks and usage reports. Never read credentials to obtain usage.

## Quota-aware tier picks

Before dispatching a Worker, run `magpie quota <provider> --json` for the provider backing the chosen tier. Confirm `readAt` is fresh for this dispatch; stale or unavailable data is unknown. When the tier sets `weekly_brake_percent`, compare the fresh seven-day `used` percentage with that threshold; at or above the brake blocks that tier. No default tier sets a brake; an override may set one. If a tier's allowance is exhausted or near its applicable brake, the Manager records a decision to wait with `magpie quota wait <provider> --timeout <duration>`, or move to the next listed tier at the same level with the quota reason. Do not substitute tiers automatically.

## Usage reports

In delivery reports, include task-window token and cost totals from `magpie sessions --json` filtered by folder and time, or `magpie usage --last <duration>`. Attribute only the traffic Magpie records. Report unpriced requests and unknown or incomplete subagent attribution explicitly; do not estimate missing values.

## Catalog validation

`agent-workbench install` and `agent-workbench status` warn when a generated Claude Code tier's model ID or configured effort is absent from `magpie models claude`. Warnings are advisory; missing or unavailable Magpie does not block setup.
