# Maintainer evaluation notes for the codex profile

These observations describe the maintainer’s evaluation of the optional `codex` profile, rather than requirements for other users’ model choices.

In the evaluated Codex-first ladder, L2 used GPT-6.2 Sol at medium effort. On 42 replayed merged PRs across five projects it beat GPT-6.1 Sol 29–7 with 6 ties under blind grading, and finished five tasks where 6.1 timed out (onsager-ai/worker-bench). It used about 24% less total input than 6.1, with a lower cache hit rate. L3 has no Codex tier until a GPT candidate (Sol at `xhigh`, or Astra) matches Opus on a hard-task replay. Effort above `high` added wall time without a correctness gain, so no ladder tier defaults above `medium`.

`terra` (GPT-6.1 Terra, medium) is an opt-in Worker outside the ladder, for bounded tasks the Manager assigns to it explicitly. GPT-6.1 Terra ends implementation turns early with unfinished work and no blocker, and neither persistence prompts nor tighter briefs correct it ([openai/codex#58694](https://github.com/openai/codex/issues/58694), [#58114](https://github.com/openai/codex/issues/58114)). Keep it out of the ladder until several real implementation runs of over 30 minutes show the fix.
