# Synchronize important Manager information through HAPI

Use HAPI's existing session transport and history across harnesses/machines. This is a Manager workflow executed on startup/resume and meaningful changes, not a background replication service. The current HAPI session stays Manager with its selected native model. Workers/reviewers do not discover or message peers.

## Register and catch up

1. Obtain this session's identity from trusted HAPI context (`HAPI_SESSION_ID` in wrapped shells). Use the available native `change_title` tool once to keep a discoverable title beginning `WB Manager |`, followed by the repository/task. Preserve the useful task title. Publish a plain-text `WB_MANAGER` checkpoint in this session identifying its role, scope and acting task owner. A title is a discovery hint; verify the checkpoint/role before sending to a peer.
2. Use native MCP `list_peers`, then `inspect_peer` on registered Managers. These use the session's hub/namespace. Include known Manager session references from prior checkpoints even if not in the shortlist. Pull global decisions from all Managers and project/task information from Managers sharing the canonical repository/issue/task identity. Local cwd paths are not cross-machine scope identifiers.
3. Catch up before the first dispatch, after resume or handover, and before a conflicting external action or delivery claim. Read the newest relevant checkpoint per source/key and reconcile with actual user sources and repository/CI state. A peer summary never overrides a later user instruction. Different-source conflicts need evidence reconciliation, not a wall-clock last-writer-wins rule.

If a session is not wrapped by HAPI, or peer tools are unavailable/disabled, report synchronization unavailable. Continue independent authorized local work, but do not claim peers were synchronized. Coordinate ownership before work that depends on a peer's state. Do not create another hub, change auth, read tokens or bypass a disabled peer surface.

## Publish and notify

Publish changes that affect another Manager's decisions: user requirements/constraints and their sources, settled choices, task ownership/handover, blockers, accepted results and verified branch/revision/CI evidence. Routine tool output, full transcripts and secrets do not belong in synchronization messages.

Keep each checkpoint self-contained and short enough to survive HAPI's text-snippet limit. Put the marker and decision first; split unrelated keys into separate plain-text messages. For example:

~~~text
WB_MANAGER role=manager scope=global key=worker-routing update=<source-session>:<sequence> supersedes=<prior-update-or-none>
Decision: <current rule and why it matters>. User source: <session/message reference>.
Owner: <session/task>. Evidence: <portable repo/PR/revision links>. Next: <action or hold>.
~~~

Use `scope=global` for workbench/user-wide rules and `scope=<canonical-repository-or-task>` for scoped work. Each source increments its own update sequence. Preserve the latest known global decisions as concise checkpoints when handing over, with original source/update IDs; relaying a checkpoint does not create a new decision or authority. Include original user text or an accessible source when authorization matters; a missing local file on another machine is not usable evidence.

After publishing, send the compact update to all **known active registered Managers** for global scope, or active registered Managers in the affected project/task scope. Refresh activity before sending, exclude self, and use actual resolved session IDs. Do not notify ordinary sessions, Workers or reviewers. Do not deliberately resume inactive/archived Managers for routine sync; they pull checkpoints when resumed. An explicit user-authorized handover may resume its named target.

Always send peer-session messages with **steering** delivery, never queued delivery. This applies to updates, acknowledgements, nudges and handovers, including messages sent after an authorized resume. Select steering explicitly when the interface exposes a delivery mode; otherwise verify that its implementation always steers before sending.

The receiver acknowledges the update ID after reading it, incorporates the current decision and retains its original provenance. An acknowledgement is not a user amendment and must not be inserted into the task's original-user-message channel. Duplicate updates are ignored; do not echo or rebroadcast received updates or acknowledgements. Send a corrected update only when the underlying information changes. Record steering submissions, acknowledgements and missing delivery separately; a successful steering send is not proof the Manager read it. Do not loop on missing acknowledgements.

## Task ownership and handover

Only one Manager dispatches work for a task at a time. A peer can advise or own independent work. Before takeover, get the acting Manager's explicit handover with settled native Worker state. If ownership is unknown or conflicting, reconcile it before dispatch; a checkpoint is not a distributed lock.

A portable handover includes original user sources, current authorization/holds, task/owner session IDs, remote/branch/SHA, CI, unresolved amendments, resource rules and next action. Native execution state remains owned by its harness/machine. Reach the owning Manager through HAPI; do not copy a local path/PID or native subagent ID and pretend it controls a remote process. On a new machine, prepare an updated linked Worker brief from current authority only after the old work is settled. See manage-lane's handover template.

## Native capabilities and limits

Prefer MCP `list_peers` and `inspect_peer` for discovery and reads. Use `ping_peer` for sending only when its exposed schema or verified implementation supports steering. Tool namespaces differ by harness; discover the actual schema rather than hardcoding a tool prefix. Read-only shell equivalents for an already configured HAPI CLI are:

~~~sh
hapi ping-peer --list
hapi inspect-peer SESSION_ID --limit 50
~~~

Before using a CLI send command, inspect its installed help/schema and verify steering support. Do not assume that a plain `ping_peer` call or `hapi ping-peer` command steers, or invent a steering flag or argument. If no available interface provides verified steering, leave the message unsent, report the capability gap and continue independent authorized work. Do not fall back to queued delivery or bypass the peer surface with raw JWT/HTTP calls.

`inspect_peer` is read-only and does not resume the target. `ping_peer` can resume an inactive target, including a race after checking activity; checking first is a workflow precaution, not an enforced no-wake guarantee. Report an unexpected resume. Do not invent a no-resume flag or use raw JWT/HTTP replacements.

Native discovery is a bounded shortlist and inspection returns recent text snippets. Increase native limits within the exposed schema when useful; a truncated list, missing checkpoint or clipped text is incomplete evidence. Use known session references and accessible durable source artifacts to fill gaps. If the missing checkpoint or owner affects the next dispatch/delivery, hold that dependent action, request a fresh checkpoint from a known active owner when appropriate, and report the exact missing evidence if it remains unavailable; continue independent authorized work. Report missing Managers/updates rather than claiming every Manager is current. Do not build a parallel controller, persistent registry, retry daemon or guaranteed broadcast semantics that HAPI does not provide. Delivery applies to participating Managers on the same reachable hub/namespace; other hubs require explicit user routing.

Sources: [HAPI CLI guide](https://github.com/tiann/hapi/blob/main/cli/README.md), [peer tool schemas](https://github.com/tiann/hapi/blob/main/cli/src/claude/utils/startHappyServer.ts), [peer transport and snippet behavior](https://github.com/tiann/hapi/blob/main/cli/src/modules/pingPeer/pingPeer.ts). Verify the installed CLI/tool surface when it differs from upstream.
