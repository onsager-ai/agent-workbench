#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: "utf8" });
const git = (repo, ...args) => {
  const result = run("git", args, repo);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trimEnd();
};
const absolute = (value) => path.resolve(value);

export function parse(argv) {
  const options = { repo: process.cwd(), apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") {
      if (!argv[i + 1]) throw new Error("--repo requires a path");
      options.repo = absolute(argv[++i]);
    } else if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--json") options.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") options.help = true;
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return options;
}

function outputError(message) {
  console.error(`awb prune: ${message}`);
}

export function prune({ repo: requestedRepo, apply = false, json = false } = {}) {
  const repo = git(requestedRepo ?? process.cwd(), "rev-parse", "--show-toplevel");
  const common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const primaryRoot = path.dirname(common);
  const currentResult = run("git", ["rev-parse", "--show-toplevel"], process.cwd());
  const current = currentResult.status === 0 ? currentResult.stdout.trim() : (requestedRepo ? repo : "");
  const defaultRef = run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repo);
  const defaultBranch = defaultRef.status === 0 ? defaultRef.stdout.trim().split("/").at(-1) : "main";
  const gh = run("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "headRefName,headRefOid,state"], repo);
  if (gh.status !== 0) throw new Error(gh.stderr.trim() || "gh pr list failed");
  const prs = JSON.parse(gh.stdout);
  const worktrees = git(repo, "worktree", "list", "--porcelain").split(/\n\n/).filter(Boolean).map((block) => {
    const entry = {};
    for (const line of block.split("\n")) {
      const at = line.indexOf(" ");
      entry[at < 0 ? line : line.slice(0, at)] = at < 0 ? true : line.slice(at + 1);
    }
    return entry;
  });
  const symlinkRoots = [".claude/skills", ".agents/skills", ".codex/skills"].map((item) => path.join(os.homedir(), item));
  const references = new Set();
  let refsKnown = true;
  try {
    for (const root of symlinkRoots) {
      if (!fs.existsSync(root)) continue;
      if (fs.lstatSync(root).isSymbolicLink()) references.add(realpath(root));
      const visit = (directory) => {
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const target = path.join(directory, item.name);
          if (item.isSymbolicLink()) references.add(realpath(target));
          else if (item.isDirectory()) visit(target);
        }
      };
      visit(root);
    }
  } catch { refsKnown = false; }
  const processCwds = new Set();
  let processesKnown = true;
  try {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try { processCwds.add(fs.realpathSync(`/proc/${name}/cwd`)); }
      // Other users' processes deny cwd reads (EACCES/EPERM); only this user's processes can hold its worktrees.
      catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) processesKnown = false; }
    }
  } catch { processesKnown = false; }
  const branches = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean);
  const mergedHeads = new Map();
  const rows = [];
  for (const branch of branches) {
    if ([defaultBranch, "main", "master"].includes(branch)) continue;
    const matches = prs.filter((pr) => pr.headRefName === branch);
    const merged = matches.filter((pr) => pr.state === "MERGED");
    const branchTip = git(repo, "rev-parse", `refs/heads/${branch}`);
    if (!matches.length) {
      // Leftover isolation branches (e.g. Claude's worktree-agent-*) carry no commits beyond the default branch.
      const base = run("git", ["rev-parse", "--verify", `refs/remotes/origin/${defaultBranch}`], repo);
      const hasTree = worktrees.some((tree) => tree.branch === `refs/heads/${branch}`);
      if (base.status === 0 && !hasTree &&
          run("git", ["merge-base", "--is-ancestor", branchTip, base.stdout.trim()], repo).status === 0) {
        mergedHeads.set(branch, base.stdout.trim());
        rows.push({ branch, worktree: "", action: "branch", reason: "no commits beyond origin/" + defaultBranch });
        continue;
      }
    }
    if (!merged.length) {
      const state = matches.some((pr) => pr.state === "OPEN") ? "OPEN PR" : matches.length ? "CLOSED-unmerged PR" : "no PR";
      rows.push({ branch, worktree: "", action: "skip", reason: state });
      continue;
    }
    const qualifying = merged.find((pr) => {
      const ancestor = run("git", ["merge-base", "--is-ancestor", branchTip, pr.headRefOid], repo);
      return branchTip === pr.headRefOid || ancestor.status === 0;
    });
    if (!qualifying) {
      rows.push({ branch, worktree: "", action: "skip", reason: "local commits after merged PR" });
      continue;
    }
    mergedHeads.set(branch, qualifying.headRefOid);
    const associated = worktrees.filter((tree) => tree.branch === `refs/heads/${branch}`);
    if (!associated.length) {
      rows.push({ branch, worktree: "", action: "branch", reason: "merged PR and unchanged tip" });
      continue;
    }
    for (const tree of associated) {
      const directory = tree.worktree;
      let reason = "";
      if (directory === primaryRoot) reason = "primary checkout";
      else if (directory === current) reason = "invoking worktree";
      else if (tree.locked) reason = "locked";
      else if (!processesKnown) reason = "in use unknown";
      else if ([...processCwds].some((cwd) => within(cwd, directory))) reason = "in use";
      else if (!refsKnown) reason = "in use unknown (skill links unchecked)";
      else if ([...references].some((target) => within(target, directory))) reason = "referenced by skill symlink";
      else if (git(directory, "status", "--porcelain").length) reason = "dirty";
      rows.push({ branch, worktree: directory, action: reason ? "skip" : "worktree", reason: reason || "merged PR and unchanged tip" });
    }
  }
  if (apply) {
    for (const row of rows.filter((item) => item.action === "worktree")) {
      if (git(row.worktree, "status", "--porcelain").length) {
        row.action = "skip"; row.reason = "dirty (changed before removal)"; continue;
      }
      const result = run("git", ["worktree", "remove", row.worktree], repo);
      if (result.status !== 0) { row.action = "skip"; row.reason = result.stderr.trim() || "worktree removal failed"; continue; }
      row.action = "removed";
    }
    for (const branch of new Set(rows.filter((row) => row.action === "branch" ||
      (row.action === "removed" && rows.filter((item) => item.branch === row.branch && item.worktree).every((item) => item.action === "removed")))
      .map((row) => row.branch))) {
      const ref = `refs/heads/${branch}`;
      const check = run("git", ["rev-parse", "--verify", ref], repo);
      if (check.status === 0) {
        const tip = check.stdout.trim();
        const mergedHead = mergedHeads.get(branch);
        const ancestor = run("git", ["merge-base", "--is-ancestor", tip, mergedHead], repo);
        if (tip !== mergedHead && ancestor.status !== 0) {
          for (const row of rows.filter((item) => item.branch === branch && ["branch", "removed"].includes(item.action))) {
            row.action = "skip"; row.reason = "local commits added before branch removal";
          }
          continue;
        }
        git(repo, "branch", "-D", branch);
      }
      for (const row of rows.filter((item) => item.branch === branch && ["branch", "removed"].includes(item.action))) row.action = "removed";
    }
    git(repo, "worktree", "prune");
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${apply ? "Applied" : "Dry run"} (use --apply to remove eligible items)`);
    for (const row of rows) console.log(`${row.action.padEnd(8)} ${row.branch}${row.worktree ? `  ${row.worktree}` : ""}  ${row.reason}`);
  }
  return rows;
}

function within(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}
function realpath(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const args = parse(process.argv.slice(2));
    if (args.help) console.log("Usage: awb prune [--repo PATH] [--apply] [--json]");
    else prune(args);
  } catch (error) { outputError(error.message); process.exitCode = 1; }
}
