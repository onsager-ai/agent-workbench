# Choosing cleanup targets

Load the relevant sections for the selected paths. These are classification aids, not an instruction to clear every cache on a machine. Inspect installed tool help before choosing commands; path names and cleanup semantics vary by tool/version.

## Build outputs and dependency caches

Known completed-task outputs such as Rust `target` directories, disposable frontend build directories and downloaded dependency caches are good first candidates. Establish which task owns them, whether a build/server is running and how expensive they are to regenerate. Do not run `cargo clean`, delete a shared target directory or clear a shared cache while another task uses it.

Package caches, dependency installations and source are different things. Prefer selective pruning of unused entries through the owning package manager. Treat virtual environments and `node_modules` as rebuildable only when the project's dependency definitions are available, there are no local package edits/unique data and removal will not break a running tool. Do not rebuild them during cleanup. Preserve source/vendor edits, lockfiles and the active environments running agents or tools.

## Git worktrees and temporary clones

Use `git worktree list --porcelain` to identify registered trees; inspect only the selected tree's status, ownership and delivery evidence. Bound metadata checks rather than recursively reading repository contents. Check ignored content explicitly enough to distinguish generated artifacts from databases, exports or other unknown files.

Fresh remote evidence may be a fetched remote commit that contains the tree's HEAD, or a verified remote PR whose published head exactly matches it and whose merge is recorded. Missing upstream configuration is not proof of either unpublished or published work. If delivery cannot be established, keep the tree and report that reason.

Check references from installed instruction/skill directories and tool configuration as well as active process/task use. A source worktree backing an installed skill must remain available even if it is clean, pushed and merged. Detach or relocate such references only as an explicitly authorized migration. Removing a worktree does not require deleting its branch.

For a scratch clone, make the same source/data/delivery/current-use checks. Do not assume a directory under `/tmp` is disposable or use a broad recursive delete on a parent containing several tasks.

## Agent, preview and temporary artifacts

Completed-task preview builds, known temporary render outputs and scratch downloads can be candidates. User-facing exports, screenshots requested as deliverables, audit/acceptance evidence, task originals and recovery state are not automatically disposable.

For harness state, inspect only named task metadata needed to establish completion and ownership. Do not parse personal transcripts or purge `~/.codex`, `~/.claude`, `~/.agents`, `~/.local/state` or their history trees wholesale. Retiring old logs requires a bounded retention scope; preserve the metadata and evidence still needed for delivery, recovery or an active lane.

Provider/plugin caches can contain the code behind installed hooks and skills. An older version can still be referenced; “a newer version exists” does not prove the older one is unused. Prefer a native supported cache-prune operation with known scope. Do not uninstall plugins, alter connections or delete configured MCP server data under a generic cache-cleaning request.

## Containers

Use the container engine's own accounting to distinguish unused images/build cache from running containers, writable layers and volumes. Shared layers make logical sizes larger than the bytes a removal will reclaim.

Select unused build cache/images within the authorized target. Container volumes and stopped containers can hold databases or unique work; they need data/ownership evidence and explicit scope. Never add a volume or broad system-prune option just to increase the reported savings.

## Space that deletion does not immediately recover

Use `df` on the affected filesystem before and after each batch. A file kept open by a process, snapshots, hard links and copy-on-write sharing can retain space after removal. A focused open-deleted-file or snapshot inspection may explain a discrepancy; avoid recursive open-file scans and never stop other processes or remove recovery snapshots without authorization.
