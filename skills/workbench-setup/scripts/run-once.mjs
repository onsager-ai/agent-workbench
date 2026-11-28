import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JOB_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHORT_HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const validArgument = (value) => typeof value === "string" && !value.includes("\0");
const absolutePath = (value) => validArgument(value) && path.isAbsolute(value);
const exactText = (value, pattern) => typeof value === "string" && value === value.trim() && pattern.test(value);
const modulePath = fileURLToPath(import.meta.url);
const thermal = fileURLToPath(new URL("./thermal", import.meta.url));
const thermalHosts = new Set(["hp-code-1", "hp-code-2"]);

export function validOneShotJob(job) {
  if (!job || !exactText(job.id, JOB_ID) || !exactText(job.host, SHORT_HOST) ||
      !exactText(job.parent_thread, /^\S+$/) || !absolutePath(job.cwd) ||
      !Array.isArray(job.argv) || !absolutePath(job.argv[0]) || !job.argv.every(validArgument) ||
      !positiveInteger(job.cpu_quota_percent) || job.cpu_quota_percent > 100 ||
      !positiveInteger(job.timeout_s) || !exactText(job.expires_at, UTC_SECONDS)) return false;
  const expiry = new Date(job.expires_at);
  return Number.isFinite(expiry.valueOf()) && expiry.toISOString() === job.expires_at.replace(/Z$/, ".000Z");
}

const shortHost = () => os.hostname().split(".")[0];
const unitName = (id) => `awb-once-${id}.service`;

// Both the hook and CLI use the deployed policy and T3's observed child lineage.
export async function authorizedOneShot(file, id, { cwd = process.cwd(), host = shortHost(), now = Date.now() } = {}) {
  if (process.platform !== "linux" || !exactText(id, JOB_ID) || !file) return undefined;
  try {
    const registry = JSON.parse(fs.readFileSync(file, "utf8")).base.policy.one_shot_jobs;
    const entries = registry?.filter((job) => job.id === id);
    if (entries?.length !== 1) return undefined;
    const [job] = entries;
    if (!validOneShotJob(job) || job.host !== host || Date.parse(job.expires_at) <= now) return undefined;
    const { t3Thread, t3WorkerTier } = await import("../../orchestrate-harnesses/scripts/worker-context.mjs");
    const row = await t3Thread(process.env.T3CODE_THREAD_ID?.trim());
    if (row?.relationship !== "subagent" || row.parentThreadId !== job.parent_thread) return undefined;
    const tier = t3WorkerTier(file, { cwd }, row);
    return tier && tier.access !== "read-only" ? job : undefined;
  } catch {
    return undefined;
  }
}

export function runOnceArguments(job, home) {
  const encoded = Buffer.from(JSON.stringify(job)).toString("base64url");
  return ["--user", "--wait", "--pipe", "--collect", "--expand-environment=no",
    `--unit=${unitName(job.id)}`, "--service-type=oneshot",
    `--property=CPUQuota=${job.cpu_quota_percent}%`, "--property=Nice=19",
    `--property=TimeoutStartSec=${job.timeout_s}s`, "--property=TimeoutStartFailureMode=kill",
    "--property=TimeoutStopSec=2s", "--property=KillMode=control-group", "--property=Restart=no",
    "--", process.execPath, modulePath, encoded, home];
}

export function runOnceCommand(args, home) {
  if (args.length === 1 && exactText(args[0], JOB_ID)) return runOnce(args[0], home);
  console.error("Usage: agent-workbench ops run-once <job-id>");
  return 64;
}

export async function runOnce(id, home, { launch = spawnSync, host = shortHost() } = {}) {
  const state = path.join(home, ".local/state/agent-workbench");
  const job = await authorizedOneShot(path.join(state, "workers.json"), id, { host });
  if (!job) {
    console.error("awb ops run-once: no active job for this host and T3 Worker");
    return 1;
  }
  const claims = path.join(state, "one-shot-claims");
  try {
    fs.mkdirSync(claims, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(claims, job.id), { mode: 0o700 });
  } catch (error) {
    console.error(error.code === "EEXIST" ? "awb ops run-once: job already claimed"
      : "awb ops run-once: could not claim job");
    return 1;
  }
  const result = launch("/usr/bin/systemd-run", runOnceArguments(job, home), { stdio: ["ignore", "inherit", "inherit"] });
  if (result.error || result.status === null) {
    console.error("awb ops run-once: systemd job failed to start or the foreground waiter was interrupted");
    return 1;
  }
  return result.status;
}

export function quotaEnforced(cpuMax, percent) {
  const fields = /^(\d+) (\d+)$/.exec(cpuMax.trim());
  if (!fields) return false;
  const [quota, period] = fields.slice(1).map(Number);
  return positiveInteger(quota) && positiveInteger(period) && (100 * quota) / period <= percent;
}

function runInCgroup(encoded, home) {
  const job = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!validOneShotJob(job) || job.host !== shortHost() || Date.parse(job.expires_at) <= Date.now()) {
    throw new Error("registered job is invalid, expired, or for a different host");
  }
  const cgroup = /^0::(\/[^\n]+)$/m.exec(fs.readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  if (!cgroup || path.basename(cgroup) !== unitName(job.id) || os.getPriority() !== 19 ||
      !quotaEnforced(fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "cpu.max"), "utf8"), job.cpu_quota_percent)) {
    throw new Error("registered job requires an enforced systemd cgroup v2 quota and Nice=19");
  }
  process.chdir(job.cwd);
  const env = { ...process.env, HOME: home };
  const argv = thermalHosts.has(job.host)
    ? ["/bin/sh", thermal, "gate", "--max-seconds", String(job.timeout_s), "--", ...job.argv] : job.argv;
  delete env.THERMAL_SYSFS;
  delete env.THERMAL_SETTLE_SECONDS;
  process.execve(argv[0], argv, env);
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    runInCgroup(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`awb ops run-once: ${error.message}`);
    process.exitCode = 1;
  }
}
