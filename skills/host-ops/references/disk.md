# Clean up local disk space

Recover space left behind by completed work while preserving source, user data and running work. Use existing filesystem, Git and cache-management tools. Use the [target guidance](#choosing-cleanup-targets) for the paths you inspect.

## Establish scope and measure

- Distinguish an inspection request from permission to delete. Asking what uses space or explicitly asking to hold deletion authorizes inspection only. A request to clean up authorizes the clearly disposable items within its scope; reuse that authority without repeatedly asking. Ask only when a useful next action crosses that scope, destroys valuable data or requires stopping another task.
- Start with `df -h` on the requested location to identify the full filesystem and record available space. An artifact on another mount will not help that filesystem. Ask for a space target only if the next decision depends on it; otherwise prioritize a useful batch of cold, regenerable leftovers.
- Follow the applicable host and repository resource rules, including any required current temperature readings and limits on local checks. Do not substitute a historical policy or invent a threshold. Carry applicable restrictions into any delegation.
- Begin with known artifact/cache locations, worktree registrations and task metadata. Query one selected location at a time; bound metadata walks by time and scope, avoid crossing mounts or following symlinks, and stop when sufficient evidence is available. Do not recursively scan the whole home, filesystem, repository contents or personal logs. Respect the one-file parsing/search limit; do not upload private local trees to CI to measure them. If a recursive size scan would exceed the permitted local work, use an existing size report or report the measurement limit.

## Choose what to reclaim

For each candidate, identify its exact path, type, owning tool/task, known size, regeneration cost and evidence that it is no longer needed. Age, an old branch name and a directory called `cache` are hints, not proof. Mark unknown sizes as unknown; prefer allocated/reclaimable bytes over apparent size, and avoid counting shared layers or hard links twice.

Prefer completed-task build outputs, expired scratch outputs with known ownership and tool-managed unused cache entries. Preserve source, credentials, databases, user exports, session history, backups and unknown content. Separate them from disposable outputs even when they share a directory.

Use `npx -y @onsager/awb prune --apply` as the supported way to remove local worktrees and branches whose merged PR and tip state qualify them; its default dry run reports eligibility and skip reasons. Keep the additional ignored-content checks below when reclaiming disk space.

Before removing a Git worktree:

- Check its registration/lock, tracked changes, untracked files and meaningful ignored content. Git's clean status can omit ignored databases or other valuable files.
- Confirm its commits are delivered remotely using fresh remote/PR evidence. A clean tree can still hold local-only commits. A stale remote-tracking ref is insufficient. Account for a verified squash-merged PR rather than assuming only an identical branch tip proves delivery. Do not commit/push unrelated work merely to make it eligible for deletion.
- Check task ownership and current use: running harnesses/builds, process working directories, and installed skill/instruction/config symlinks that reference it. Preserve the primary checkout, locked worktrees and anything still referenced or whose use cannot be established. A merged PR alone does not make a worktree unused.
- Use Git's worktree removal for an eligible tree, then prune stale registration metadata only when appropriate. Avoid force removal, manual deletion of `.git` metadata and branch deletion unless separately in scope.

## Clean in bounded batches

State the selected items, available size estimates and why they are disposable. Proceed within the user's existing cleanup authority; an unresolved candidate does not block other clearly authorized items.

Recheck identity, path boundaries and current use immediately before deletion. A symlink or changed task state can invalidate an earlier plan. Prefer the owning tool's supported selective clean/prune operation; inspect the installed tool's help for its actual scope and version. Broad options such as “all,” volumes, force or deletion of an entire cache root need their own justification and authority.

Clean one class or small batch at a time. Do not run builds, reinstall dependencies, regenerate artifacts or restart services to validate cleanup. Preserve a private record of paths/actions and skipped reasons outside repositories; do not copy personal log contents into the report. Removing regenerable data is generally irreversible; moving it to trash on the same filesystem does not free space until it is emptied.

## Verify and stop

Recheck `df` on the same filesystem and report actual space recovered, remaining available space, actions taken and significant skipped items. Deduplication, snapshots and open deleted files can make estimates differ from recovery. Investigate that discrepancy before expanding the deletion scope; do not kill processes or delete snapshots without authority.

Stop when the user's space goal is met, the selected safe batch is complete, or temperature/ownership/permission limits prevent more work. Never invent recovered byte counts or call unknown content safe. Include any concrete next choice only when it is needed.

## Choosing cleanup targets

Load the relevant sections for the selected paths. These are classification aids, not an instruction to clear every cache on a machine. Inspect installed tool help before choosing commands; path names and cleanup semantics vary by tool/version.

### Build outputs and dependency caches

Known completed-task outputs such as Rust `target` directories, disposable frontend build directories and downloaded dependency caches are good first candidates. Establish which task owns them, whether a build/server is running and how expensive they are to regenerate. Do not run `cargo clean`, delete a shared target directory or clear a shared cache while another task uses it.

Package caches, dependency installations and source are different things. Prefer selective pruning of unused entries through the owning package manager. Treat virtual environments and `node_modules` as rebuildable only when the project's dependency definitions are available, there are no local package edits/unique data and removal will not break a running tool. Do not rebuild them during cleanup. Preserve source/vendor edits, lockfiles and the active environments running agents or tools.

### Git worktrees and temporary clones

Use `git worktree list --porcelain` to identify registered trees; inspect only the selected tree's status, ownership and delivery evidence. Bound metadata checks rather than recursively reading repository contents. Check ignored content explicitly enough to distinguish generated artifacts from databases, exports or other unknown files.

Fresh remote evidence may be a fetched remote commit that contains the tree's HEAD, or a verified remote PR whose published head exactly matches it and whose merge is recorded. Missing upstream configuration is not proof of either unpublished or published work. If delivery cannot be established, keep the tree and report that reason.

Check references from installed instruction/skill directories and tool configuration as well as active process/task use. A source worktree backing an installed skill must remain available even if it is clean, pushed and merged. Detach or relocate such references only as an explicitly authorized migration. Removing a worktree does not require deleting its branch.

For a scratch clone, make the same source/data/delivery/current-use checks. Do not assume a directory under `/tmp` is disposable or use a broad recursive delete on a parent containing several tasks.

### Agent, preview and temporary artifacts

Completed-task preview builds, known temporary render outputs and scratch downloads can be candidates. User-facing exports, screenshots requested as deliverables, audit/acceptance evidence, task originals and recovery state are not automatically disposable.

For harness state, inspect only named task metadata needed to establish completion and ownership. Do not parse personal transcripts or purge `~/.codex`, `~/.claude`, `~/.agents`, `~/.local/state` or their history trees wholesale. Retiring old logs requires a bounded retention scope; preserve the metadata and evidence still needed for delivery, recovery or an active lane.

Provider/plugin caches can contain the code behind installed hooks and skills. An older version can still be referenced; “a newer version exists” does not prove the older one is unused. Prefer a native supported cache-prune operation with known scope. Do not uninstall plugins, alter connections or delete configured MCP server data under a generic cache-cleaning request.

### Containers

Use the container engine's own accounting to distinguish unused images/build cache from running containers, writable layers and volumes. Shared layers make logical sizes larger than the bytes a removal will reclaim.

Select unused build cache/images within the authorized target. Container volumes and stopped containers can hold databases or unique work; they need data/ownership evidence and explicit scope. Never add a volume or broad system-prune option just to increase the reported savings.

### Space that deletion does not immediately recover

Use `df` on the affected filesystem before and after each batch. A file kept open by a process, snapshots, hard links and copy-on-write sharing can retain space after removal. A focused open-deleted-file or snapshot inspection may explain a discrepancy; avoid recursive open-file scans and never stop other processes or remove recovery snapshots without authorization.
