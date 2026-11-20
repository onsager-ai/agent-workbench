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
fs.cpSync(process.env.AWB_TEST_SOURCE, target, { recursive: true });
`, { mode: 0o755 });
  return { dir, home, skillsCmd, env: { ...process.env, AWB_TEST_HOME: home, AWB_TEST_SOURCE: path.join(root, "skills", "workbench-setup") } };
}

function run(home, args, env = process.env) {
  return spawnSync(process.execPath, [cli, "--home", home, ...args], { encoding: "utf8", env });
}

test("setup installs skills, then applies and reports setup", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const result = run(f.home, ["--skills-cmd", f.skillsCmd, "setup"], f.env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok  setup: applied$/m);
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
