import { spawnSync } from "node:child_process";

const git = (cwd, ...args) => spawnSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8" });
const prFields = "number,isDraft,headRefName,headRefOid,updatedAt,statusCheckRollup";

function checkState(check) {
  if (check.status && check.status !== "COMPLETED") return "running";
  const result = check.conclusion || check.state;
  if (!result || ["PENDING", "EXPECTED"].includes(result)) return "running";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(result) ? "pass" : "fail";
}

function readPullRequests(cwd) {
  const result = spawnSync("gh", ["pr", "list", "--author", "@me", "--state", "open", "--json", prFields], { cwd, encoding: "utf8" });
  if (result.error?.code === "ENOENT") return { pullRequests: [], note: "PRs unavailable: gh is not installed." };
  if (result.status !== 0) {
    return { pullRequests: [], note: "PRs unavailable: gh pr list failed. Check GitHub authentication and repository access." };
  }
  const now = Date.now();
  const pullRequests = JSON.parse(result.stdout).map((pr) => {
    const commit = git(cwd, "log", "-1", "--no-show-signature", "--format=%ct", pr.headRefOid, "--");
    const headTime = commit.status === 0 && commit.stdout.trim() ? Number(commit.stdout.trim()) * 1000 : NaN;
    return {
      number: pr.number,
      draft: pr.isDraft,
      branch: pr.headRefName,
      head: pr.headRefOid,
      headAgeSeconds: Number.isFinite(headTime) ? Math.max(0, Math.floor((now - headTime) / 1000)) : null,
      updatedAt: pr.updatedAt,
      checks: (pr.statusCheckRollup ?? []).map((check) => ({
        name: check.workflowName ? `${check.workflowName} / ${check.name}` : check.name ?? check.context,
        state: checkState(check),
      })),
    };
  });
  return { pullRequests, note: null };
}

function readWorktrees(cwd) {
  const result = git(cwd, "worktree", "list", "--porcelain", "-z");
  if (result.status !== 0) throw new Error(result.error?.message ?? (result.stderr.trim() || "git worktree list failed"));
  return result.stdout.split("\0\0").filter(Boolean).map((entry) => {
    const fields = entry.split("\0");
    const directory = fields[0].slice("worktree ".length);
    const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null;
    const status = git(directory, "status", "--porcelain=v2", "--branch", "--ahead-behind", "-z", "--untracked-files=all");
    let ahead = null;
    let dirtyFiles = null;
    if (status.status === 0) {
      dirtyFiles = 0;
      const records = status.stdout.split("\0");
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith("# branch.ab ")) ahead = Number(record.split(" ")[2]);
        if (/^[12u?] /.test(record)) dirtyFiles += 1;
        if (record.startsWith("2 ")) index += 1; // A rename has a second NUL-terminated path.
      }
    }
    return { path: directory, branch, ahead, dirtyFiles };
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
  const prByBranch = new Map(pullRequests.map((pr) => [pr.branch, pr.number]));
  for (const tree of worktrees) tree.openPr = prByBranch.get(tree.branch) ?? null;

  if (json) {
    console.log(JSON.stringify({ pullRequests, worktrees, note }, null, 2));
    return;
  }
  for (const pr of pullRequests) {
    const age = pr.headAgeSeconds === null ? `head age unknown, PR updated ${pr.updatedAt}` : `head ${formatAge(pr.headAgeSeconds)} old`;
    const checks = pr.checks.map((check) => `${check.name} ${check.state}`).join(", ") || "no checks reported";
    console.log(`PR #${pr.number}  ${pr.draft ? "draft" : "ready"}  ${pr.head.slice(0, 8)}  ${age}  ${checks}`);
  }
  for (const tree of worktrees) {
    const pr = tree.openPr ? `PR #${tree.openPr}` : note && tree.branch ? "PR unknown" : "no matching PR";
    console.log(`worktree  ${tree.branch ?? "(no branch)"}  ${pr}  ${tree.ahead ?? "?"} ahead  ${tree.dirtyFiles ?? "?"} dirty  ${JSON.stringify(tree.path)}`);
  }
  if (note) console.log(note);
}
