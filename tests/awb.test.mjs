import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "awb.mjs");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awb-test-"));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  const skillsCmd = path.join(dir, "fake-skills.mjs");
  fs.writeFileSync(skillsCmd, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const target = path.join(process.env.AWB_TEST_HOME, '.agents', 'skills', 'workbench-setup');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(path.join(path.dirname(target), 'skills-home'), process.env.HOME);
fs.cpSync(process.env.AWB_TEST_SOURCE, target, { recursive: true });
`, { mode: 0o755 });
  return { dir, home, skillsCmd, env: { ...process.env, AWB_TEST_HOME: home, AWB_TEST_SOURCE: path.join(root, "skills", "workbench-setup") } };
}

function run(home, args, env = process.env) {
  return spawnSync(process.execPath, [cli, "--home", home, ...args], { encoding: "utf8", env });
}

test("prune reports merged PR cleanup and removes eligible local worktrees on apply", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const repo = path.join(f.dir, "repo");
  const tree = path.join(f.dir, "tree");
  const fakeBin = path.join(f.dir, "bin");
  fs.mkdirSync(repo);
  fs.mkdirSync(fakeBin);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "base"), "base\n");
  git("add", "base"); git("commit", "-m", "base");
  git("worktree", "add", "-b", "merged-task-tree", tree);
  fs.writeFileSync(path.join(tree, "work"), "work\n");
  spawnSync("git", ["add", "work"], { cwd: tree });
  spawnSync("git", ["commit", "-m", "work"], { cwd: tree });
  const mergedTip = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" }).stdout.trim();
  git("branch", "empty-leftover");
  git("update-ref", "refs/remotes/origin/main", "main");
  const gh = path.join(fakeBin, "gh");
  fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify([{ headRefName: "merged-task-tree", headRefOid: mergedTip, state: "MERGED" }])}'\n`);
  fs.chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  const dry = spawnSync(process.execPath, [cli, "prune", "--repo", repo, "--json"], { encoding: "utf8", env, cwd: repo });
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(fs.existsSync(tree));
  assert.ok(JSON.parse(dry.stdout).some((row) => row.branch === "merged-task-tree" && row.action === "worktree"));
  assert.ok(JSON.parse(dry.stdout).some((row) => row.branch === "empty-leftover" && row.action === "branch"));
  const apply = spawnSync(process.execPath, [cli, "prune", "--repo", repo, "--apply", "--json"], { encoding: "utf8", env, cwd: repo });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(fs.existsSync(tree), false);
  assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/empty-leftover"], { cwd: repo }).status, 0);
  assert.notEqual(spawnSync("git", ["show-ref", "--verify", "refs/heads/merged-task-tree"], { cwd: repo }).status, 0);
});

test("lanes reports authored PR checks and local worktree status", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const setup = run(f.home, ["--skills-cmd", f.skillsCmd, "setup"], f.env);
  assert.equal(setup.status, 0, setup.stderr);

  const repo = path.join(f.dir, "repo");
  const tree = path.join(f.dir, "task tree");
  const local = path.join(f.dir, "local-only");
  const detached = path.join(f.dir, "detached");
  const remote = path.join(f.dir, "origin.git");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "original"), "base\n");
  git(repo, "add", "original");
  git(repo, "commit", "-m", "base");
  git(repo, "init", "--bare", "-b", "main", remote);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "main");
  git(repo, "remote", "set-head", "origin", "main");
  git(repo, "worktree", "add", "-b", "task", tree);
  git(tree, "commit", "--allow-empty", "-m", "published change");
  git(tree, "push", "origin", "task");
  const head = git(tree, "rev-parse", "HEAD");
  git(tree, "branch", "--set-upstream-to=main");
  git(tree, "commit", "--allow-empty", "-m", "local change");
  git(repo, "worktree", "add", "-b", "local-only", local, "main");
  git(local, "branch", "--set-upstream-to=task");
  git(local, "commit", "--allow-empty", "-m", "other local change");
  git(repo, "worktree", "add", "--detach", detached, "main");
  fs.appendFileSync(path.join(detached, "original"), "dirty\n");
  git(tree, "mv", "original", "renamed");
  fs.mkdirSync(path.join(tree, "untracked"));
  fs.writeFileSync(path.join(tree, "untracked", "one"), "one\n");
  fs.writeFileSync(path.join(tree, "untracked", "two"), "two\n");

  const fakeBin = path.join(f.dir, "bin");
  fs.mkdirSync(fakeBin);
  const updatedAt = "2026-01-01T00:00:00Z";
  const unknownHead = "b".repeat(40);
  const prs = [
    {
      number: 17, isDraft: true, headRefName: "task", headRefOid: head, updatedAt, isCrossRepository: false,
      statusCheckRollup: [
        { name: "lint", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE" },
        { name: "build", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" },
        { context: "external", state: "PENDING" },
      ],
    },
    {
      number: 18, isDraft: false, headRefName: "local-only", headRefOid: unknownHead, updatedAt,
      isCrossRepository: true, statusCheckRollup: [],
    },
  ];
  const ghLog = path.join(f.dir, "gh-calls");
  const ghArgs = "pr list --author @me --state open --limit 100 --json number,isDraft,headRefName,headRefOid,updatedAt,statusCheckRollup,isCrossRepository";
  fs.writeFileSync(path.join(fakeBin, "gh"), `#!/bin/sh
printf '%s\n' "$PWD $*" >> "$AWB_TEST_GH_LOG"
[ "$*" = '${ghArgs}' ] || exit 2
[ -z "$AWB_TEST_GH_FAIL" ] || exit 1
printf '%s\n' '${JSON.stringify(prs)}'
`, { mode: 0o755 });
  const env = { ...f.env, PATH: `${fakeBin}:${process.env.PATH}`, AWB_TEST_GH_LOG: ghLog };
  const ghCall = `${fs.realpathSync(repo)} ${ghArgs}\n`;

  const result = run(f.home, ["lanes", "--cwd", repo, "--json"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(ghLog, "utf8"), ghCall);
  const lanes = JSON.parse(result.stdout);
  assert.equal(lanes.note, null);
  const [draft, ready] = lanes.pullRequests;
  assert.ok(Number.isInteger(draft.headAgeSeconds));
  assert.deepEqual(draft, {
    number: 17, draft: true, branch: "task", crossRepository: false, head, headAgeSeconds: draft.headAgeSeconds, updatedAt,
    checks: [
      { name: "CI / lint", state: "pass" },
      { name: "CI / test", state: "fail" },
      { name: "CI / build", state: "running" },
      { name: "external", state: "running" },
    ],
  });
  assert.deepEqual(ready, {
    number: 18, draft: false, branch: "local-only", crossRepository: true,
    head: unknownHead, headAgeSeconds: null, updatedAt, checks: [],
  });
  assert.equal(lanes.worktrees.length, 4);
  assert.deepEqual(Object.fromEntries(lanes.worktrees.map((row) => [row.path, row])), {
    [fs.realpathSync(repo)]: { path: fs.realpathSync(repo), branch: "main", hasRemoteBranch: true, openPr: null, ahead: 0, dirtyFiles: 0 },
    [fs.realpathSync(tree)]: { path: fs.realpathSync(tree), branch: "task", hasRemoteBranch: true, openPr: 17, ahead: 1, dirtyFiles: 3 },
    [fs.realpathSync(local)]: { path: fs.realpathSync(local), branch: "local-only", hasRemoteBranch: false, openPr: null, ahead: 1, dirtyFiles: 0 },
    [fs.realpathSync(detached)]: { path: fs.realpathSync(detached), branch: null, hasRemoteBranch: false, openPr: null, ahead: 0, dirtyFiles: 1 },
  });

  const launcher = path.join(f.home, ".local", "bin", "agent-workbench");
  const text = spawnSync(launcher, ["lanes"], { cwd: repo, encoding: "utf8", env });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^PR #17  draft  [\da-f]{8}  head \d+[smhd] old  .*CI \/ lint pass/m);
  assert.match(text.stdout, /^PR #18  ready  bbbbbbbb  head age unknown, PR updated /m);
  assert.match(text.stdout, /^worktree  task  PR #17  1 ahead  3 dirty /m);
  assert.match(text.stdout, /^worktree  local-only  no matching PR  1 ahead \(no remote branch\)  0 dirty /m);
  assert.match(text.stdout, /^worktree  \(no branch\)  no matching PR  0 ahead \(no remote branch\)  1 dirty /m);

  const unavailable = run(f.home, ["lanes", "--cwd", repo, "--json"], { ...env, AWB_TEST_GH_FAIL: "1" });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  const offline = JSON.parse(unavailable.stdout);
  assert.match(offline.note, /Check GitHub authentication/);
  assert.deepEqual(offline.pullRequests, []);
  assert.deepEqual(offline.worktrees, lanes.worktrees.map((row) => ({ ...row, openPr: null })));
  const gitOnly = path.join(f.dir, "git-only");
  fs.mkdirSync(gitOnly);
  const gitExecutable = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(gitExecutable.status, 0, gitExecutable.stderr);
  fs.symlinkSync(gitExecutable.stdout.trim(), path.join(gitOnly, "git"));
  const missing = run(f.home, ["lanes", "--cwd", repo, "--json"], { ...env, PATH: gitOnly });
  assert.equal(missing.status, 0, missing.stderr);
  assert.deepEqual(JSON.parse(missing.stdout), { ...offline, note: "PRs unavailable: gh is not installed." });
  assert.equal(fs.readFileSync(ghLog, "utf8"), ghCall.repeat(3));
});

test("setup installs skills, then applies and reports setup", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = run(f.home, ["--skills-cmd", f.skillsCmd, "setup"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok  setup: applied$/m);
  assert.equal(fs.readFileSync(path.join(f.home, ".agents", "skills", "skills-home"), "utf8"), f.home);
  assert.ok(fs.existsSync(path.join(f.home, ".local", "bin", "agent-workbench")));
});

test("skills failure stops setup and preserves its exit code", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const failing = path.join(f.dir, "fail.mjs");
  fs.writeFileSync(failing, "#!/usr/bin/env node\nprocess.exit(37);\n", { mode: 0o755 });
  const result = run(f.home, ["--skills-cmd", failing, "setup"], f.env);
  assert.equal(result.status, 37);
  assert.equal(fs.existsSync(path.join(f.home, ".agents")), false);
});

test("status forwards to the installed workbench command", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = run(f.home, ["--skills-cmd", f.skillsCmd, "setup"], f.env);
  assert.equal(result.status, 0, result.stderr);
  const status = run(f.home, ["status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^ok  setup: applied$/m);
});

test("uninstalled commands explain how to bootstrap", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = run(f.home, ["status"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Agent Workbench isn't installed; run: npx @onsager\/awb setup/);
});

test("--version prints the package version", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  for (const flag of ["--version", "version"]) {
    const result = run(os.tmpdir(), [flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), version);
  }
});
