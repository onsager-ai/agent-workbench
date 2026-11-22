import { spawnSync } from "node:child_process";

const git = (cwd, ...args) => spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8" });
const prFields = "number,isDraft,headRefName,headRefOid,updatedAt,statusCheckRollup,isCrossRepository";

function checkState(check) {
  if (check.status && check.status !== "COMPLETED") return "running";
  const result = check.conclusion || check.state;
  if (!result || ["PENDING", "EXPECTED"].includes(result)) return "running";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result) ? "pass" : "fail";
}

function readPullRequests(cwd) {
  const result = spawnSync("gh", ["pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", prFields], { cwd, encoding: "utf8" });
  if (result.error?.code === "ENOENT") return { pullRequests: [], note: "PRs unavailable: gh is not installed." };
  if (result.status !== 0) {
    return { pullRequests: [], note: "PRs unavailable: gh pr list failed. Check GitHub authentication and repository access." };
  }
  const now = Date.now();
  const pullRequests = JSON.parse(result.stdout).map((pr) => ({
    number: pr.number,
    draft: pr.isDraft,
    branch: pr.headRefName,
    crossRepository: pr.isCrossRepository,
    head: pr.headRefOid,
    updatedAt: pr.updatedAt,
    updateAgeSeconds: Math.max(0, Math.floor((now - Date.parse(pr.updatedAt)) / 1000)),
    checks: (pr.statusCheckRollup ?? []).map((check) => ({
      name: check.workflowName ? `${check.workflowName} / ${check.name}` : check.name ?? check.context,
      state: checkState(check),
    })),
  }));
  return { pullRequests, note: null };
}

function readWorktrees(cwd) {
  const result = git(cwd, "worktree", "list", "--porcelain", "-z");
  if (result.status !== 0) throw new Error(result.error?.message ?? (result.stderr.trim() || "git worktree list failed"));
  return result.stdout.split("\0\0").filter(Boolean).map((entry) => {
    const fields = entry.split("\0");
    const directory = fields[0].slice("worktree ".length);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    const remoteRef = `refs/remotes/origin/${branch}`;
    const hasRemoteBranch = branch !== null && git(cwd, "show-ref", "--verify", "--quiet", remoteRef).status === 0;
    const base = hasRemoteBranch ? remoteRef : "refs/remotes/origin/HEAD";
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length);
    const count = head ? git(cwd, "rev-list", "--count", `${base}..${head}`, "--") : null;
    const ahead = count?.status === 0 ? Number(count.stdout.trim()) : null;
    const status = git(directory, "status", "--porcelain=v2", "-z", "--untracked-files=all");
    let dirtyFiles = null;
    if (status.status === 0) {
      dirtyFiles = 0;
      const records = status.stdout.split("\0");
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (/^[12u?] /.test(record)) dirtyFiles += 1;
        if (record.startsWith("2 ")) index += 1; // A rename has a second NUL-terminated path.
      }
    }
    return { path: directory, branch, hasRemoteBranch, ahead, dirtyFiles };
  });
}

function formatAge(seconds) {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}

export function showLanes({ cwd, json }) {
  const worktrees = readWorktrees(cwd);
  const { pullRequests, note } = readPullRequests(cwd);
  const prByBranch = new Map(pullRequests.filter((pr) => !pr.crossRepository).map((pr) => [pr.branch, pr.number]));
  for (const tree of worktrees) tree.openPr = prByBranch.get(tree.branch) ?? null;

  if (json) {
    console.log(JSON.stringify({ pullRequests, worktrees, note }, null, 2));
    return;
  }
  for (const pr of pullRequests) {
    const checks = pr.checks.map((check) => `${check.name} ${check.state}`).join(", ") || "no checks reported";
    console.log(`PR #${pr.number}  ${pr.draft ? "draft" : "ready"}  ${pr.head.slice(0, 8)}  updated ${formatAge(pr.updateAgeSeconds)} ago  ${checks}`);
  }
  for (const tree of worktrees) {
    const pr = tree.openPr ? `PR #${tree.openPr}` : note && tree.branch ? "PR unknown" : "no matching PR";
    const remote = tree.hasRemoteBranch ? "" : " (no remote branch)";
    console.log(`worktree  ${tree.branch ?? "(no branch)"}  ${pr}  ${tree.ahead ?? "?"} ahead${remote}  ${tree.dirtyFiles ?? "?"} dirty  ${JSON.stringify(tree.path)}`);
  }
  if (note) console.log(note);
}
