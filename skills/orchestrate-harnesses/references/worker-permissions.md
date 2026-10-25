# Worker permission handoff

Version 2 requires `worker_permissions`, rejecting unknown fields. The authoritative `source` is `native_trusted_context` or `user_message`, with a nonempty `evidence_ref`. Optional `supporting_evidence` entries contain only `{kind: user_config_fields|other, ref}`. Config fields can support the captured native/task policy; they do not prove runtime inheritance themselves.

The required adapter is `codex-cli-config-overrides`. Select `sandbox_mode` explicitly from `read-only`, `workspace-write`, `danger-full-access` and `approval_policy` from `never`, `on-request`. The installed CLI surface supports these two approvals; other values fail as `unsupported_policy`. Profiles, profile flags, named profiles and `default_permissions` are unsupported. The controller does not alter native/managed policy or ignore rules, hooks, trust or authentication.

OS sandboxing is optional. Use the mode actually selected by the user or evidenced native context. `danger-full-access` uses the current OS account's permissions without an additional Codex OS sandbox; task `allowed_paths` remain instructions rather than an enforced filesystem boundary. `workspace-write` and `read-only` select restricted execution. Creating a Worker or a worktree does not require adding a sandbox or container.

The editable task example illustrates an explicit full-access/never choice, not a universal default. Replace its evidence and policy with the current task's actual authority. Full-access execution does not require a working `bwrap` sandbox; a requested restricted mode still must pass its own startup check. The controller never repairs OS security settings or switches to full access after a restricted-mode failure.

`read_only: true` is a hard cap requiring read-only. Optional `network_access` is boolean or null (omission means null), and `writable_roots` defaults to an empty list. Non-null network and nonempty roots are allowed only for workspace-write. Each root must be canonical and absolute and lie within cwd or equal the directory returned by `git rev-parse --git-common-dir`. No roots are added automatically. In particular, committing from a linked worktree under workspace-write needs its git common directory explicitly listed and backed by evidence. This task-specific authority does not grant unrelated write access.

One builder supplies global options for both `codex ... exec` and `codex ... app-server`:

```
-c sandbox_mode="<selected mode>"
-c approval_policy="<selected approval>"
-c sandbox_workspace_write.network_access=false
-c sandbox_workspace_write.writable_roots=["/workspace/owned-worktree"]
```

The last two are emitted only for explicitly supplied workspace-write settings. Values are serialized as JSON/TOML literals and passed as individual argv entries, never through a shell. The CLI sandbox and approval shorthand flags are not used: app-server policy must resolve from the same config overrides as exec. Codex model, effort, resume, output schema and tracing stay on the existing Worker route; context overrides are added separately without changing the shared policy builder.

Before **every Codex** Worker model spawn, including owned session resume, the controller starts an owned stdio app-server process group with the same cwd/environment and policy overrides. This startup check does not add an OS sandbox to a full-access task. The ordered protocol is `initialize`, `initialized` notification, `config/read {cwd, includeLayers:false}`, `configRequirements/read`, then `command/exec {command:["/bin/true"], cwd, timeoutMs:2000}`. No sandbox override is supplied to command execution. No thread/turn or alternate process API is used. The same path applies to full access; a direct host command cannot certify Codex execution.

Only typed sandbox/approval/workspace fields and profile/default-permission presence are retained from config. All unrelated config, origins, auth, MCP and environment fields are discarded. Missing/unknown/different effective mode or approval blocks as `config_mismatch`. Explicit network and roots must match resolved workspace settings. Active profile/default-permission indicators and nonempty or invalid profile definitions block as `unsupported_policy`. The server’s default empty `profiles: {}` map is inactive metadata and is allowed. A missing requirements field is a protocol error; all non-null managed requirements currently block as `managed_constraint`, with only their presence retained. This conservative adapter has no compatibility proof for managed requirement structures and never bypasses them.

The server is owned using the existing lock, PID, process start time, boot ID and process group checks. The overall probe timeout is 30 seconds, with stdout/stderr each capped at `max_log_bytes` (and the existing absolute cap); stderr audit text is further limited to 8192 bytes. The owned group is stopped after success or failure. An unverified stop retains the active lease for explicit recovery. Probe failure/cancellation/recovery does not consume Worker inference or rework counters and never triggers a permission change or fallback.

Private append-only `probe-audit.jsonl` records contain timestamp, request ID, selected policy, argv, whitelisted effective metadata, classification, command exit code, bounded stderr and termination status. Classes are `ok`, `namespace`, `sandbox`, `config_mismatch`, `unsupported_policy`, `managed_constraint`, `protocol`, `timeout`, `cancelled`. Namespace classification recognizes bwrap/RTM_NEWADDR/userns/EPERM diagnostics. Invalid contracts fail before spawning and are not probe records. Audit results mean **startup execution under validated policy only; does not prove all filesystem/network/approval boundaries**.

Historical v1 contracts and originals are never edited, rehashed or auto-upgraded. Status, acknowledgements, Manager and control remain available. Historical preflight/acceptance results remain readable; those roles cannot dispatch. Every v1 Worker dispatch blocks before any spawn, including v1 read-only: it cannot recover the original approval policy. Create a new v2 task with current authorization and link historical evidence as needed.

For Codex, the controller implements the CLI config-override adapter only. Any Manager-approved external native bootstrap must be recorded separately as `route=external_native_bootstrap` with its actual native policy and scope. It is not controller-native support, an automatic fallback or authority to change global settings, OS policy, credentials, hooks or rules.


## Claude Workers

All six tiers share the v2 evidence validation. The contract adapter tag records the native Codex policy handoff, while the chosen tier fixes the actual CLI. Claude does not run the Codex probe. Before its model launch the controller validates the policy and constructs these explicit flags:

| Policy | Built-in tools | Permission handling |
| --- | --- | --- |
| read-only | Read, Glob, Grep | dontAsk; no write/shell tool |
| workspace-write | none; dispatch rejected before inference | requires a separately evidenced Claude confinement adapter; keep policy and use Codex |
| danger-full-access/on-request | Read, Glob, Grep, Edit, Write, Bash | dontAsk; Bash is not pre-allowed; operations needing approval are denied |
| danger-full-access/never | Read, Glob, Grep, Edit, Write, Bash | dontAsk; pre-allow only those named tools; no bypass |

`read_only` can never select an editable mapping. Every Claude call uses strict empty MCP config, denies `mcp__*,Agent,Task`, disables automatic memory, and keeps hooks, trust checks, authentication and managed denies. Manager remains Read only. No `bypassPermissions`, `--dangerously-skip-permissions`, safe/bare mode, hook-disabling flags or automatic fallback. Print mode has the native CLI's documented trusted-directory prerequisite; the controller does not change its trust configuration.

Workspace-write Claude dispatch is blocked because no verified Claude confinement adapter is implemented. Tool filtering is not an OS sandbox or proof of every file/network boundary. The adapter cannot silently drop the evidenced Codex OS confinement requirement; Manager may explicitly choose an appropriate Codex tier without changing policy. Read-only Claude calls expose no write or execution tools. Full-access calls need no OS confinement mapping. Native settings/managed restrictions can further deny operations; CLI errors and permission denials block completion. The only startup checks for Claude are contract/argv validation and the native CLI's own startup and structured result checks. **The Codex app-server startup execution claim does not cover Claude.** Unsupported policy must be reported rather than repaired by widening permissions.
