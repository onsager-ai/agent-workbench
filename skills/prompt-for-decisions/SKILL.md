---
name: prompt-for-decisions
description: Ask when a user choice blocks the next action, including confirmations, clarifications, important design choices, and stuck rework.
---

# Present a user decision

The Manager asks and resolves engineering choices within scope. Check original user sources, settled answers, holds, and sensible defaults. Resolve facts and finish authorized preparation. Ask about material scope or authority changes, conflicting priorities, and costly-to-reverse choices such as security models, formats, protocols, or delivery guarantees. Ask before work depends on a design. Include simplification or narrower scope when rework stalls. Readiness grants no approval. Reuse existing authorization. Reuse a pending question, refreshing it once if stale. If explicitly invoked with nothing open, say so.

Use the native question tool for every user choice, following its current mode and schema. If unavailable, ask one concise direct question. Offer 2–3 likely options for an open-ended answer and let the user choose Other. Use native approval for sandbox, credential, and tool permissions.

Make the question self-contained. Name the task, action, evidence, and relevant prior choices. Mark the recommendation first, give its cost, and offer only feasible alternatives with real trade-offs. Say whether the answer blocks work or is an optional preference with a safe default. Read [visual guidance](references/visuals.md) only for complicated problems.

While blocked, continue only independent authorized work. Silence, elapsed time, and preselection grant no approval. Record the answer and its source. Use `orchestrate-harnesses` for amendments and Manager sync. Report pending choices as pending.
