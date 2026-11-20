#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const commands = ["install", "update", "status", "trust", "uninstall", "workers", "prune"];
const usage = `Usage: awb <command> [options]

Commands:
  setup      Install Agent Workbench skills and apply global setup
  install    Apply or refresh global setup
  update     Update installed skills and setup
  status     Show setup status
  trust      Review and trust Codex hooks
  uninstall  Remove managed setup
  workers    Show effective Worker configuration
  prune      Remove local worktrees and branches with merged PRs
  help       Show this help`;

const argv = process.argv.slice(2);
let home = os.homedir();
let skillsCmd;
const args = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--home") {
    if (!argv[i + 1]) {
      console.error("awb: --home requires a path");
      process.exit(2);
    }
    home = path.resolve(argv[++i]);
  } else if (argv[i] === "--skills-cmd") {
    if (!argv[i + 1]) {
      console.error("awb: --skills-cmd requires a command");
      process.exit(2);
    }
    skillsCmd = argv[++i];
  } else {
    args.push(argv[i]);
  }
}

const command = args[0] ?? "help";
if (command === "help" || command === "--help" || command === "-h") {
  console.log(usage);
  process.exit(0);
}

const script = path.join(home, ".agents", "skills", "workbench-setup", "scripts", "workbench.mjs");
const run = (executable, parameters) => {
  const result = spawnSync(executable, parameters, { stdio: "inherit" });
  if (result.error) {
    console.error(`awb: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
};
const runWorkbench = (parameters) => run(process.execPath, [script, "--home", home, ...parameters]);

if (command === "prune") {
  process.exit(run(process.execPath, [fileURLToPath(new URL("./prune.mjs", import.meta.url)), ...args.slice(1)]));
}

if (command === "setup") {
  const skillArgs = skillsCmd
    ? skillsCmd.split(/\s+/).filter(Boolean)
    : ["npx", "--yes", "skills@1.7.4"];
  if (!skillArgs.length) {
    console.error("awb: --skills-cmd must name a command");
    process.exit(2);
  }
  const result = run(skillArgs[0], [
    ...skillArgs.slice(1), "add", "onsager-ai/agent-workbench", "-g", "-a", "codex",
    "-a", "claude-code", "--skill", "*", "-y",
  ]);
  if (result !== 0) process.exit(result);
  const installResult = runWorkbench(["install"]);
  if (installResult !== 0) process.exit(installResult);
  process.exit(runWorkbench(["status"]));
}

if (!commands.includes(command)) {
  console.error(`awb: unknown command '${command}'\n\n${usage}`);
  process.exit(2);
}
if (!args.includes("--help") && !args.includes("-h") && !pathExists(script)) {
  console.error("Agent Workbench isn't installed; run: npx @onsager/awb setup");
  process.exit(1);
}
process.exit(runWorkbench(args));

function pathExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}
