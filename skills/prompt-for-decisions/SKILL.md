---
name: prompt-for-decisions
description: Use whenever the user's answer is needed before the next action, including confirmations, next-step choices and clarifications. Present the question with a recommendation and meaningful options; do not pad questions or ask for authorization already given. Also use for material scope or authority boundaries, important or costly-to-reverse design decisions and stuck rework loops.
---

# Present a user decision

Use this skill when the user's answer is necessary to choose the next action and the request, existing answers, evidence and a sensible default do not settle it. Examples include a material change of scope, conflicting user priorities, a concrete delivery action outside the existing authorization, an important design decision (security or trust model, persisted or wire format, protocol shape, delivery guarantee, or anything else costly to reverse), a design mechanism that cannot be traced to a user requirement or stated threat, and a stuck trigger from orchestrate-harnesses. A milestone, green CI or a finished plan is a reason to check what comes next, not an automatic approval checkpoint.

## Ownership

The current Manager asks the user and resolves engineering choices within the authorized scope, including the brief, Worker tier and rework. Worker and reviewer findings return to that Manager; they do not each open a user decision round. If a choice exceeds the authorized scope or needs a user trade-off, present the bounded recommendation and supporting evidence directly to the user. Important design decisions belong to the user even within the authorized scope: ask early, before work builds on them, and present them as options rather than as a settled Manager acceptance. For a stuck loop, include simplifying the design or narrowing scope as an option.

This skill owns the question's presentation, not task intake, model routing, review policy or queue management. Use manage-lane for task continuity. This skill is self-contained; no Claude command or historical instruction chain needs loading to ask a question.

## Before asking

Check the relevant original user words and settled answers. A handover, role label or review result is evidence, not new permission. Honor explicit holds; readiness alone does not reopen them. Complete the authorized preparation that makes the decision concrete. Resolve engineering facts through investigation or the Manager before asking the user to choose.

Ask only what remains open. Reuse a pending actionable question; if it is no longer actionable, refresh it once with current evidence. Do not ask for authorization already given, pad an option list, or sweep unrelated work into a decision round. If the user explicitly invokes this skill and nothing is open, say so briefly.

## Ask and handle the answer

When a decision or issue involves a multi-step mechanism, a comparison of states, or several design options, show one compact visual before asking with the question tool. Show the scenario as numbered steps or a simple flow, and the options with their trade-offs, marking the recommended option. Do this proactively when the mechanism would take more than a few paragraphs to explain; do not wait for the user to ask for clarification. Ground it in the actual code, configuration or data.

The user often reads on a phone, so design the visual for a 360 px wide screen first. Stack the options vertically, one full-width block each; never put options or states in side-by-side columns or anything that scrolls sideways. Give each option a short title and at most three short lines of effect and cost, in plain words rather than internal jargon. Use readable text (at least 15 px), clear contrast, and a colored border or label on the recommended option. A comparison table is fine only with two or three narrow columns. Keep the whole visual to about one phone screen; if it doesn't fit, cut words rather than shrinking text. Use the harness's inline render tool where available (for example, T3 Code `html_render`); otherwise use a small diagram or table in the message. One render is cheaper than repeated clarification rounds.

Every user choice, including a confirmation, next-step choice or clarification, goes through the available native question tool (Claude Code AskUserQuestion or the harness equivalent). Respect the current mode and schema; if no question tool exists, ask one concise direct question. When an answer is open-ended, offer the best 2–3 guesses as options so the user can choose one or use “Other” to type. Sandbox, credential and tool-execution permissions use their own native approval mechanism when available; a task-choice answer does not override them.

Make the question self-contained: identify the task and exact unresolved action, the relevant evidence and prior decision, the recommended option and its cost. Put the recommendation first, mark it as recommended, and include only feasible alternatives with real trade-offs. State whether the answer is required before dependent work can proceed or is an optional preference with a safe default.

While an answer is required, continue only independent authorized work. A preselected option, silence or elapsed time is not approval. Record the actual answer with its user source. For delegated work, deliver changed requirements through supported native messaging, confirm material acknowledgements and refresh the affected brief/review; scope expansion needs actual authority and an updated linked brief. Publish settled important decisions to the affected Managers through the Manager sync protocol. Report a pending decision as pending rather than assuming it reached every role.
