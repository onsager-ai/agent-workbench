---
name: prompt-for-decisions
description: Present a genuinely unresolved user choice in the Codex Gateway with evidence, a recommendation and meaningful trade-offs. Use for material scope or authority boundaries, not routine engineering decisions owned by the Manager.
---

# Present a user decision

Use this skill when the user's answer is necessary to choose the next action and the request, existing answers, evidence and a sensible default do not settle it. Examples include a material change of scope, conflicting user priorities or a concrete delivery action outside the existing authorization. A milestone, green CI or a finished plan is a reason to check what comes next, not an automatic approval checkpoint.

## Ownership

In orchestrated work the Codex Gateway asks the user. The Manager resolves engineering choices within the contract, including the brief, Worker tier and rework. Worker and reviewer findings go back through orchestrate-harnesses; they do not each open a user decision round. If a choice exceeds the contract or needs a user trade-off, bring the Manager's bounded recommendation and supporting evidence to the Gateway.

This skill owns the question's presentation, not task intake, model routing, review policy or queue management. Use manage-lane for task continuity. This Codex skill is self-contained; no Claude command or historical instruction chain needs loading to ask a question.

## Before asking

Check the relevant original user words and settled answers. A handover, role label or review result is evidence, not new permission. Honor explicit holds; readiness alone does not reopen them. Complete the authorized preparation that makes the decision concrete. Resolve engineering facts through investigation or the Manager before asking the user to choose.

Ask only what remains open. Reuse a pending actionable question; if it is no longer actionable, refresh it once with current evidence. Do not ask for authorization already given, pad an option list, or sweep unrelated work into a decision round. If the user explicitly invokes this skill and nothing is open, say so briefly.

## Ask and handle the answer

Use the available native question UI for task choices when its current tool contract permits it. Respect the current mode and schema; if no suitable question tool is available, ask one concise direct question. Sandbox, credential and tool-execution permissions use their own native approval mechanism when available; a task-choice answer does not override them.

Make the question self-contained: identify the task and exact unresolved action, the relevant evidence and prior decision, the recommended option and its cost. Put the recommendation first, mark it as recommended, and include only feasible alternatives with real trade-offs. State whether the answer is required before dependent work can proceed or is an optional preference with a safe default.

While an answer is required, continue only independent authorized work. A preselected option, silence or elapsed time is not approval. Record the actual answer with its user source. For orchestrated work, deliver a changed requirement through the amendment protocol and refresh affected planning/review; scope outside an immutable contract needs a successor task. Report a pending decision as pending rather than assuming it reached every role.
