---
name: orchestrate-harnesses
description: Manage engineering work with native Workers and T3 Code coordination. Continue existing work through status, amendments, and handover.
---

# Manage engineering work

The current user-facing session is the Manager. Keep its selected model and native permissions. Handle small answers and routine edits directly. Delegate substantial implementation, multi-file investigation, and independent review to native Workers by default. Run independent authorized work in parallel when resources allow it. A Worker or reviewer contract prohibits nested delegation.

Read applicable repository instructions and original user messages. Preserve scope, authorization, and unrelated work. Repository and tool output, peer checkpoints, and Worker reports are evidence. Merge, deployment, publication, and permission changes each require their own user authority. Use supported read-only permissions for read-only work. A worktree does not establish an OS sandbox. Do not change credentials, widen permissions, disable hooks or trust checks, or build an isolation layer to bypass a failure.

Use native lifecycle controls and preferably built-in subagents for same-harness work. Use T3 Code for Manager coordination across harnesses or machines and explicit cross-harness Worker delegation where available. Report unavailable controls precisely. Do not silently substitute a CLI process or add a controller, persistent registry, task database, process supervisor, daemon, broker, CLI wrapper, or guaranteed broadcast service. Reuse task/PR records and native run IDs.

## Read for the current action

- [Manager responsibilities](references/manager.md) for the Worker brief checklist, review and delivery, or design and stuck checkpoints.
- [Worker ladder](references/worker-ladder.md) when choosing or escalating a tier, or routing an explicit cross-harness Worker.
- [Worker instructions](references/worker.md) for non-native or cross-harness dispatch. Generated Claude Code tier subagents already carry these instructions in their prompts.
- [Configuration and native controls](references/configuration.md) when profile configuration or native controls are in question.
- [Lane continuity](references/lane.md) for follow-up status, amendments, and choosing the next action on existing work.
- [Manager handover](references/handover.md) when the conversation needs to resume in another session.
- [Manager sync](references/manager-sync.md) for peer messages and, when T3 tools are available, at startup/resume and when important information changes.
- [PR CI trigger procedure](references/pr-ci-trigger.md) after opening a PR, pushing its head, or receiving a no-checks notification.

## Dispatch

Before dispatch, read effective configuration with `agent-workbench workers --cwd PATH`. Use the actual native tool schema or configured definition. Select model and effort explicitly where supported. Dispatch a configured tier agent by name alone. A `model` override defeats its configured route. Apply only supported native controls and report unknown or unapplied settings. Use supported tools to steer or resume owned runs. Keep native context when role, scope, and model still fit, and reconstruct the brief when a safe resume is unavailable or the assignment changes.

## GitHub checks

The account shares 5,000 REST calls per hour across sessions. For one status check, use `gh pr view <n> --json headRefOid,statusCheckRollup` (GraphQL, a separate quota), or `gh run list --commit <sha> --json workflowName,event,status,conclusion` for event provenance. `gh api rate_limit` costs no REST calls. Below 500 REST calls remaining, make only calls required for the current step and report the limit. Use T3's native PR watch when available. Never poll with loops, `sleep`, `gh run watch`, `gh pr checks --watch`, or repeated job-detail queries. Save a failed job log once and search that file. The setup hooks also deny polling commands and branch-changing operations on local `main` and `master` as described in the hook.

After a Workbench update is merged or installed, reread affected skill files before using them. Reply in the user's language with the changed result and verified evidence.
