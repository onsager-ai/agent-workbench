# Synchronize important Manager information through T3 Code

Use T3 Code threads for Manager coordination across harnesses and machines. This workflow runs on startup/resume and meaningful changes, not as a background replication service. The current session stays Manager with its selected native model. Workers and reviewers do not discover or message peers.

## Register and catch up

1. Use `t3_thread_update` to keep the thread title in the [session naming](../SKILL.md#t3-manager-continuity) format. Post a plain-text `WB_MANAGER` checkpoint in your own thread identifying its role, scope and acting task owner. Include its native address when available, such as `native=claude-code:<name>` using the session name `ListAgents` reports for itself. A title is a discovery hint; verify the checkpoint and role before sending to a peer.
2. Discover threads with `t3_thread_list` and `t3_thread_search`; use `t3_thread_read` before answering about a thread. Read relevant registered Managers and known thread references from prior checkpoints. Pull global decisions from Managers and project/task information from Managers sharing the canonical repository/issue/task identity. Local paths are not cross-machine scope identifiers.
3. For another machine, use `t3_environment_links` to list linked machines and pass the machine's `environmentId` to T3 tools. If a machine the user names is not linked, call `t3_environment_link` with a `hint` from the user's words; never ask for a pairing code in chat. If T3 cannot reach it, report the gap. SSH is an acceptable user-chosen fallback for setup, not Manager synchronization.
4. Catch up before the first dispatch, after resume or handover, and before a conflicting external action or delivery claim. Read the newest relevant checkpoint per source/key and reconcile it with actual user sources and repository/CI state. A peer summary never overrides a later user instruction. Reconcile conflicting evidence rather than assuming the latest timestamp wins.

If the session is not running in T3 Code or T3 tools are unavailable, report synchronization unavailable. Continue independent authorized local work, but do not claim peers were synchronized. Coordinate ownership before work that depends on a peer's state. Do not change authentication or bypass an unavailable peer surface.

## Publish and notify

Publish changes that affect another Manager's decisions: user requirements and sources, settled choices, task ownership/handover, blockers, accepted results and verified branch/revision/CI evidence. Routine tool output, full transcripts and secrets do not belong in synchronization messages. Keep each checkpoint self-contained; put the marker and decision first and split unrelated keys into separate plain-text messages. Preserve the existing format:

~~~text
WB_MANAGER role=manager scope=global key=worker-routing update=<env8>/<thread8>:<n> supersedes=<prior-update-or-none> reply=none|ack|required
Decision: <current rule and why it matters>. User source: <session/message reference>.
Owner: <session/task>. Evidence: <portable repo/PR/revision links>. Next: <action or hold>.
~~~

Use `scope=global` for workbench/user-wide rules and `scope=<canonical-repository-or-task>` for scoped work. The update ID is the first eight characters of the sender's T3 `environmentId` and `threadId`, then that thread's own sequence starting at 1, for example `update=40683a5c/adb8038a:3`; `supersedes` uses the same form. A Manager outside T3 uses its native session ID in place of `<env8>/<thread8>`. `reply=none` needs no answer, `ack` asks for an acknowledgement in the receiver's next substantive message, and `required` holds dependent work until the sender gets an answer. Use the same block for native and T3 delivery. Preserve the latest known global decisions as concise checkpoints when handing over, with original source/update IDs; relaying a checkpoint does not create a new decision or authority. Include original user text or an accessible source when authorization matters; a missing local file on another machine is not usable evidence.

Post the checkpoint in your own thread and send the compact update to known active registered Managers for global scope, or active registered Managers in the affected project/task scope. Refresh activity before sending, exclude self, and use resolved thread identities. Do not notify unrelated sessions, Workers or reviewers, or deliberately wake inactive/archived Managers for routine sync; they catch up on resume. An explicit user-authorized handover may resume its named target.

For a peer listed natively in the same harness and machine, use native messaging; in Claude Code use `ListAgents` and `SendMessage`. For other peers, including cross-harness, cross-machine and Codex peers, send the checkpoint using `t3_thread_send`. Discover tool schemas by name without hardcoding an MCP prefix. Send one consolidated, self-contained message per milestone or review round and no acknowledgement-only pings. A successful send does not prove the recipient read it; record submitted and confirmed updates separately and do not automatically resend an unconfirmed message.

### Choose the T3 delivery mode

Relay is near-realtime by default. Choose `mode` on `t3_thread_send` per message:

- **`auto` (default)** for decisions, corrections, blockers, holds, handovers and anything that may change the peer's next action. It steers a running turn, starts a turn on an idle thread and queues otherwise. An idle, unsettled, unarchived registered Manager counts as active, so starting its turn is expected.
- **`steer`** when the message must land in the current turn and should fail rather than wait or start a new turn, such as a correction that invalidates work in progress. State what the peer should adjust now.
- **`queue`** only for non-time-sensitive information that can wait until the peer's current turn ends, which may take a long time.
- **`restart`** never for relay; it interrupts the peer's work. Use it only on the user's explicit instruction.

Do not send to settled or archived Managers for routine sync; they catch up on resume. Steering does not abort the peer's turn or guarantee an immediate reply.

### Acknowledge

When `reply=ack` or `reply=required`, the receiver puts `WB_ACK update=<id>` as the first line of its next substantive message to the sender, using the same channel, and incorporates the decision with its provenance. Do not acknowledge `reply=none`, echo or rebroadcast received updates, or loop on missing acknowledgements.

## PR check notifications

Treat `watch_pull_request` "no checks reported" notifications as actionable: follow the [PR CI trigger procedure](pr-ci-trigger.md), verify `pull_request` event provenance for the current head, and diagnose/re-trigger missing runs. Passing manually dispatched jobs on the commit are not evidence that the PR gate is satisfied. Use the native watch for waits, not `gh` polling loops or sleeps; report a missing bounded no-check timer rather than claiming one exists.

## Task ownership and handover

Only one Manager dispatches work for a task at a time. A peer can advise or own independent work. Before takeover, get the acting Manager's explicit handover with settled Worker state. If ownership is unknown or conflicting, reconcile it before dispatch; a checkpoint is not a distributed lock.

Use `t3_thread_transfer` or `t3_worktree_handoff` where applicable, together with a portable handover containing original user sources, current authorization/holds, task and owner thread IDs, remote/branch/SHA, CI, unresolved amendments, resource rules and next action. Native execution state remains owned by its harness/machine. Do not copy a local path, PID or native subagent ID and pretend it controls a remote process. On a new machine, prepare an updated linked Worker brief from current authority only after the old work is settled. See manage-lane's handover template.

Incomplete discovery, missing checkpoints or inaccessible sources are incomplete evidence. If an unknown checkpoint or owner affects the next dispatch or delivery, hold that dependent action, request a fresh checkpoint from a known active owner when appropriate, and report what remains missing; continue independent authorized work. Report missing Managers or updates rather than claiming everyone is current. Do not build a parallel controller, persistent registry, daemon, broker or guaranteed broadcast service. Only create new top-level threads with `t3_thread_launch` or `create_threads` when the user asks for a new thread.
