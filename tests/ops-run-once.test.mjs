import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { quotaEnforced, runOnce, runOnceArguments, runOnceCommand } from "../skills/workbench-setup/scripts/run-once.mjs";

const runner = fileURLToPath(new URL("../skills/workbench-setup/scripts/run-once.mjs", import.meta.url));

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "awb-once-"));
  const state = path.join(home, ".local/state/agent-workbench");
  fs.mkdirSync(state, { recursive: true });
  const t3 = path.join(home, "t3", "userdata");
  fs.mkdirSync(t3, { recursive: true });
  const db = new DatabaseSync(path.join(t3, "statev2.sqlite"));
  db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)");
  for (const [thread, relationshipToParent, parentThreadId, model] of [
    ["allowed-child", "subagent", "authorized-manager", "writer-model"],
    ["wrong-parent", "subagent", "other-manager", "writer-model"],
    ["read-only-child", "subagent", "authorized-manager", "reader-model"],
    ["authorized-manager", null, null, "writer-model"],
  ]) insert.run(thread, JSON.stringify({ lineage: { relationshipToParent, parentThreadId }, modelSelection: { model } }));
  db.close();
  for (const [key, value] of Object.entries({ T3CODE_HOME: path.dirname(t3), T3CODE_THREAD_ID: "allowed-child" })) {
    const saved = process.env[key];
    process.env[key] = value;
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const job = {
    id: "example-once", host: os.hostname().split(".")[0], parent_thread: "authorized-manager", cwd: home,
    argv: ["/usr/bin/true", "literal $HOME argument"], cpu_quota_percent: 25, timeout_s: 60,
    expires_at: "2999-12-01T00:00:00Z",
  };
  const install = (entry = job) => fs.writeFileSync(path.join(state, "workers.json"), JSON.stringify({
    profile: null, profiles: {}, select: [], base: {
      policy: { one_shot_jobs: [entry] }, tiers: {
        writer: { model: "writer-model" }, reader: { model: "reader-model", access: "read-only" },
      },
    },
  }));
  install();
  return { home, state, job, install };
}

test("a one-shot claim wins once, even with concurrent calls and a failed start", async (t) => {
  const { home, state, job } = fixture(t);
  let starts = 0;
  const launch = (program, args, options) => {
    starts++;
    assert.equal(program, "/usr/bin/systemd-run");
    assert.ok(fs.statSync(path.join(state, "one-shot-claims", job.id)).isDirectory());
    assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit"]);
    assert.deepEqual(args.slice(0, -5), ["--user", "--wait", "--pipe", "--collect", "--expand-environment=no",
      "--unit=awb-once-example-once.service", "--service-type=oneshot", "--property=CPUQuota=25%",
      "--property=Nice=19", "--property=TimeoutStartSec=60s", "--property=TimeoutStartFailureMode=kill",
      "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=Restart=no"]);
    assert.equal(args.at(-4), process.execPath);
    assert.equal(args.at(-3), runner);
    assert.deepEqual(JSON.parse(Buffer.from(args.at(-2), "base64url")), job);
    return { status: 7 };
  };
  const statuses = await Promise.all([runOnce(job.id, home, { launch }), runOnce(job.id, home, { launch })]);
  assert.deepEqual(statuses.sort(), [1, 7]);
  assert.equal(await runOnce(job.id, home, { launch }), 1);
  assert.equal(starts, 1);
});

test("wrong parent, read-only and missing Workers, host mismatch, and expiry never reach systemd", async (t) => {
  const { home, state, job, install } = fixture(t);
  const launch = () => assert.fail("an unauthorized job reached systemd-run");
  for (const thread of ["wrong-parent", "read-only-child", "authorized-manager", "unknown-child"]) {
    process.env.T3CODE_THREAD_ID = thread;
    assert.equal(await runOnce(job.id, home, { launch }), 1, thread);
  }
  process.env.T3CODE_THREAD_ID = "allowed-child";
  assert.equal(await runOnce(job.id, home, { launch, host: "wrong-host" }), 1);
  install({ ...job, expires_at: "2000-01-01T00:00:00Z" });
  assert.equal(await runOnce(job.id, home, { launch }), 1);
  assert.equal(runOnceCommand([job.id, "extra"], home), 64);
  assert.equal(fs.existsSync(path.join(state, "one-shot-claims")), false);
});

test("the executor refuses unbounded quotas and will not run the approved argv outside its unit", (t) => {
  const { home, job } = fixture(t);
  assert.equal(quotaEnforced("25000 100000\n", 25), true);
  for (const cpuMax of ["max 100000", "26000 100000", "0 100000", "25000 0", "invalid"]) {
    assert.equal(quotaEnforced(cpuMax, 25), false, cpuMax);
  }
  const marker = path.join(home, "must-not-run");
  const args = runOnceArguments({ ...job, argv: ["/usr/bin/touch", marker] }, home);
  const child = spawnSync(args.at(-4), args.slice(-3), { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /requires an enforced systemd cgroup v2 quota/);
  assert.equal(fs.existsSync(marker), false);
});
