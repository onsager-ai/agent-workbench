import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const AWB = fileURLToPath(new URL("../bin/awb.mjs", import.meta.url));
const THERMAL_ARGS = [AWB, "ops", "thermal"];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("awb ops thermal", () => {
  let root;
  let sysfs;
  let home;
  const children = [];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-ops-thermal-")));
    sysfs = path.join(root, "sys");
    home = path.join(root, "home");
    fs.mkdirSync(home);
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  });

  function sensor(value) {
    const zone = path.join(sysfs, "class/thermal/thermal_zone0");
    fs.mkdirSync(zone, { recursive: true });
    fs.writeFileSync(path.join(zone, "type"), "x86_pkg_temp\n");
    const temp = path.join(zone, "temp");
    fs.writeFileSync(temp, value);
    return temp;
  }

  const environment = (extra = {}) => ({ ...process.env, HOME: home, XDG_STATE_HOME: "", THERMAL_SYSFS: sysfs, ...extra });

  function thermal(args, { timeout = 8000, extraEnv = {} } = {}) {
    return spawnSync(process.execPath, [...THERMAL_ARGS, ...args], { encoding: "utf8", env: environment(extraEnv), timeout });
  }

  function start(args, extraEnv = {}) {
    const child = spawn(process.execPath, [...THERMAL_ARGS, ...args], { env: environment(extraEnv), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
    children.push(child);
    return { child, done };
  }

  test("now handles cool, hot, unreadable and unsupported sensors", () => {
    sensor("52000\n");
    const cool = thermal(["now"]);
    assert.equal(cool.status, 0, cool.stderr);
    assert.match(cool.stdout, /52C sensor=/);

    sensor("85000\n");
    const hot = thermal(["now"]);
    assert.equal(hot.status, 75);
    assert.match(hot.stdout, /85C/);

    const temp = sensor("52000\n");
    fs.unlinkSync(temp);
    fs.mkdirSync(temp);
    const unreadable = thermal(["now"]);
    assert.equal(unreadable.status, 75);
    assert.match(unreadable.stderr, /cannot be read/);

    fs.rmSync(sysfs, { recursive: true });
    const unsupported = thermal(["now"]);
    assert.equal(unsupported.status, 69);
    assert.match(unsupported.stderr, /unsupported/);
  });

  test("now reads the AMD Tctl hwmon sensor", () => {
    const hwmon = path.join(sysfs, "class/hwmon/hwmon3");
    fs.mkdirSync(hwmon, { recursive: true });
    fs.writeFileSync(path.join(hwmon, "temp1_label"), "Tctl\n");
    fs.writeFileSync(path.join(hwmon, "temp1_input"), "61250\n");
    const result = thermal(["now"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /61C sensor=/);
    assert.match(result.stdout, /hwmon3\/temp1_input/);
  });

  test("gate runs when cool, refuses unsupported and stops a hot group", async () => {
    const temp = sensor("52000\n");
    const cool = thermal(["gate", "--max-seconds", "5", "--", "sh", "-c", 'test "$1" = --home && exit 7', "sh", "--home"]);
    assert.equal(cool.status, 7, cool.stderr);

    fs.rmSync(sysfs, { recursive: true });
    const unsupported = thermal(["gate", "--", "true"]);
    assert.equal(unsupported.status, 69);
    assert.match(unsupported.stderr, /unsupported/);

    sensor("52000\n");
    const { done } = start(["gate", "--", "sh", "-c", "sleep 30"]);
    await delay(1000);
    fs.writeFileSync(temp, "90000\n");
    const result = await done;
    assert.equal(result.code, 75, result.stderr);
    assert.match(result.stderr, /stopped at 90C/);
  });

  test("a long gated command releases the lock after settle", async () => {
    sensor("52000\n");
    const longJob = start(["gate", "--", "sh", "-c", "sleep 30"], { THERMAL_SETTLE_SECONDS: "1" });
    await delay(500);
    const started = Date.now();
    const quick = thermal(["gate", "--", "true"], { timeout: 10000, extraEnv: { THERMAL_SETTLE_SECONDS: "1" } });
    assert.equal(quick.status, 0, quick.stderr);
    // Waits out the first job's short settle, not its 30-second run.
    assert.ok(Date.now() - started < 5000);
    assert.equal(longJob.child.exitCode, null);
  });

  test("install is a no-op without a sensor", () => {
    const result = thermal(["install"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unsupported/);
    assert.ok(!fs.existsSync(path.join(home, ".local/bin/thermal")));
  });

  test("install skips the logger when systemctl is unavailable", () => {
    sensor("52000\n");
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = thermal(["install"], { extraEnv: { PATH: `${fakeBin}:${process.env.PATH}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /service not installed/);
    assert.ok(!fs.existsSync(path.join(home, ".local/bin/thermal")));
    assert.ok(!fs.existsSync(path.join(home, ".config/systemd/user/host-ops-thermal.service")));
  });
});
