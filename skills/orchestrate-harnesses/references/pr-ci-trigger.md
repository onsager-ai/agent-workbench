# Missing pull request CI trigger

Use this procedure after opening a PR or pushing its head, and when a no-checks notification arrives. A no-checks notification is actionable: diagnose the trigger or recover it; do not idle while treating it as a harmless status update.

## Establish the PR check gate

After opening a PR or pushing a head revision, verify within a short bound (about three minutes) that the expected workflows ran with event `pull_request` for the exact PR head SHA. For example:

```sh
gh run list --commit "$HEAD_SHA" --event pull_request
```

Read the PR's current head with `gh pr view "$PR" --json headRefOid,baseRefName,state,isDraft` and use that SHA as `HEAD_SHA`. Inspect run metadata as needed to confirm the matching PR and expected workflows; the default run list does not show every field. A PR rollup is also usable only when the event provenance is verified. Commit check-runs alone do not establish that PR-triggered workflows ran. A `workflow_dispatch` run is diagnostic only and never satisfies this gate. Distinguish run existence from completion: required checks must still finish successfully before they are green.

If the trigger is absent, inspect the PR base against workflow `branches` filters (these match the base branch), then inspect other event and path filters. For stacked PRs, retargeting to `main` is appropriate only when the change's scope and stack semantics permit it. Otherwise record explicitly that CI waits for the parent PR to merge; do not report green.

## Recover a missing trigger

When authorized and appropriate, close then promptly reopen the PR to cause a `reopened` event. Keep the same head SHA and draft state, then verify that the PR is open with that head and that the expected `pull_request` runs start. Describe this as a CI-only reopen; it does not decide whether the PR should be closed. Preserve the user's actual authority for any close/reopen action.

Only if close/reopen fails to start the expected runs, use an empty commit as the fallback, within existing commit/push authority. It counts as the one allowed push for a review round. The original push may already have consumed that allowance. Do not add another same-round push in that case: report the conflict and schedule it for an authorized next round or obtain an explicit exception. A manual dispatch is not a substitute.

Do not use polling loops, sleeps or `gh --watch`. Use T3 `watch_pull_request` notifications for check waits. If the available watcher exposes a bounded no-check timer, use that supported capability; do not invent an API or claim a guaranteed deadline when it is unavailable. Report the capability gap and keep the missing-trigger diagnosis open. Merge requires separate approval.
