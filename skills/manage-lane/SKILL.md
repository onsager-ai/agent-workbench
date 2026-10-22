---
name: manage-lane
description: Maintain user intent and task continuity in the Codex Gateway for an existing engineering lane, including status, amendments and handover. Use orchestrate-harnesses for engineering planning and execution.
---

# Maintain Gateway task continuity

Use this skill in the user-facing Codex Gateway when continuing an existing engineering task across questions, amendments or handover. Handle small tasks directly. Manager, Worker and reviewer sessions follow their own role contracts; this skill does not turn them into another Gateway. An unrelated factual question can be answered on its own.

## Ownership

The Gateway keeps the user's intended outcome, existing authorization, unresolved requests and links to the relevant tasks. For orchestrated work, orchestrate-harnesses owns task contracts, dispatch and lifecycle operations. The Manager owns the engineering brief, Worker tier, rework and delivery decision; independent reviewers supply their verdicts. Use that skill's role references and models.json for execution policy rather than defining another model, review or retry policy here.

A lane is a conversational grouping, not another controller or persistent queue. Reuse the existing issue/PR or task records; when multiple tasks matter, keep only their IDs, dependencies and next actions. A simple edit needs no orchestration record just because this skill was selected. Read applicable repository instructions and only the historical rule actually relevant to a cited hold.

## Follow-ups

- Identify which existing object the user means. Preserve the original objective and unresolved amendments; explicit cancellations or replacements update that scope. Ask only if ambiguity changes the next action.
- Answer status questions from the relevant task's status and current repository/CI evidence. Distinguish a controller record, a model report and verified external state. A status question alone needs no new task, dispatch, review or queued amendment; queuing it would invalidate results tied to the previous message set.
- Save actual requirement changes as original user messages and deliver them through the orchestration skill's amendment protocol. A running role has not read a newly queued file. If its work is affected, settle the owned run before redispatch and verify the affected roles' acknowledgements. Recheck planning and review against the amended requirements instead of reusing an earlier verdict.
- Respect the immutable task contract. A follow-up exceeding its paths or permissions needs a successor task with the newly authorized contract and a link to the prior work. Reconcile or stop affected old work before starting it; do not rewrite the stored contract or infer extra permission from the amendment summary.

## Choose the next step

Continue useful work already covered by the user's request. In an orchestrated task, execute the Manager's applicable decision through the controller; return defects, missing evidence or changed requirements to the appropriate role. Check actual revisions and required evidence before reporting delivery. Preserve explicit user holds and use prompt-for-decisions only for a genuinely unresolved user choice after preparing the concrete evidence; reuse existing authorization and settled answers.

Choose parallel work only when another independent authorized task is actually ready and resources allow it. There is no standing two-task target or requirement to fill every wait. Use supported waits or notifications for owned runs and CI. When genuinely blocked with no useful authorized step, name the blocker and what can release it; do not invent work, repeatedly ask the same question, or promise unattended continuation without a live mechanism.

Derive commit and push authorization from the current user's actual instructions and the immutable task contract. Record the source for each authorization; a prior task, example contract or local convention grants no permission. Track technical acceptance separately from any authorized remote delivery. Verify the requested remote branch and SHA before reporting a push complete. A planned handover may include a WIP push only when the task contract explicitly permits it. Preserve no-push restrictions and pause/cancel requests; merge, deployment and publication require their own authorization.

## Handover

Use the [Gateway handover template](references/handover.md) when the conversation needs to resume elsewhere. Keep original user sources separate from agent summaries, include the existing task IDs and observed execution state, and refresh that state before replaying an action. Resume role sessions only through the orchestration workflow. Carry applicable host and repository resource limits into every delegated brief and resume; do not invent policy or import historical restrictions as current policy.
