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
