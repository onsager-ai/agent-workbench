# Configure a neutral Worker profile

For gateway or CC Switch setups, copy this `neutral` profile into `~/.agents/skills/workbench-personal/workers.yml` or `~/.config/agent-workbench/workers.yml`. If the file already has a `profiles` mapping, add `neutral` under it.

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

To use `neutral` only for a directory, replace `profile: neutral` with `select: [{path: ~/work, profile: neutral}]`, or add that entry to your existing `select` list. Define `fast-backup` or `standard-backup` under `profiles.neutral.tiers` and put it after the primary tier if your provider offers a fallback. Ladder overrides replace the whole list.

The aliases follow `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` in Claude Code. Use a full model ID to pin the route Claude Code requests.
