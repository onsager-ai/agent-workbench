# Missing pull request CI trigger

After opening a PR or pushing its head, verify within about three minutes that expected workflows have event `pull_request` runs for the exact current PR head SHA. A `workflow_dispatch` run or commit check-run alone is not evidence that PR-triggered CI ran.

For full diagnosis and recovery, follow dev-skills' [PR CI trigger procedure](https://github.com/onsager-ai/dev-skills/blob/main/skills/pr-lifecycle/references/pr-ci-trigger.md), pinned in `.agents/skills/pr-lifecycle/references/pr-ci-trigger.md` when available. Repos without that pin can use the upstream link. If runs are missing, inspect base-branch and other workflow filters. When authorized and appropriate, close and promptly reopen the PR, preserving head SHA and draft state, then verify the reopened PR and expected runs. If that fails, use an empty commit only within existing push authority and allowance; manual dispatch is never a substitute.
