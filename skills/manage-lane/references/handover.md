# Gateway handover

This is an agent-authored resume note for the user-facing Codex Gateway, not new authorization or a Worker/reviewer brief. Role sessions resume through orchestrate-harnesses with their own contracts. Fill only relevant fields; mark unknown facts rather than inventing them.

## Intent and authority

- Current user objective and delivery endpoint: **[desired result and requested endpoint; include commit, push or other delivery only when its authorization is present in the original user sources]**
- Original user sources: **[actual message/file references and relevant words; use transcript lines/timestamps when available]**
- Unresolved amendments: **[original sources, affected task IDs, cancellations/replacements]**
- Authorized actions and limits: **[implementation and delivery permissions with their user sources]**
- Explicit holds or pending user decision: **[source, release condition or still-actionable question; omit if none]**

## Observed execution state

- Existing task IDs and state paths: **[orchestrated tasks, or direct task with no controller]**
- Repository, worktree, branch and revision: **[actual paths and heads]**
- Current run: **[role/request ID, controller status, active process state and observation time]**
- Amendments delivered: **[queued/submitted/acknowledged by affected role; include message IDs]**
- Manager decision and independent review: **[result paths and reviewed revision; identify stale or missing results]**
- Verification and delivery: **[actual CI/check evidence, local SHA, remote/branch and verified remote SHA, remaining uncommitted/unpushed task changes, any push blocker, and observation time]**
- Next action and prerequisite: **[specific bounded action, dependency or blocker, and evidence to refresh]**

Reuse existing records rather than copying entire transcripts or creating another queue. Refresh the relevant task, repository and CI state before dispatch or replay. Push unfinished work as WIP only when the user authorized the push and the immutable contract permits it; identify pending verification. If delivery is prohibited, blocked or stopped, preserve the exact local state and reason. An active lease or an uncertain result requires reconciliation through the orchestration workflow. A queued message is not proof it reached the role. Scope outside the immutable contract needs a successor task, not an edited contract file.

## Instructions for resuming

Read applicable repository instructions and manage-lane. Load orchestrate-harnesses for an orchestrated task and only the role references needed for the next action. Consult a historical ruling only when a specific task hold cites it. Keep the existing interactive model and permission policy; role routing comes from the orchestration skill's current configuration.

Carry applicable resource and verification rules from the current host and repository instructions into any further delegation or resume, with their source. Do not assume a shared thermal threshold, local-check restriction or telemetry path from a prior task. Keep local parsing and searches bounded to the limits in force for the current task.
