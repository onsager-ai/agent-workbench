import { fileURLToPath } from "node:url";

export const opsHelp = "Usage: awb ops thermal <command> [arguments]";
const thermalHelp = `Usage: awb ops thermal <command>

Commands:
  now                           Read CPU package temperature
  gate [--max-seconds N] -- CMD  Run a command with thermal limits
  status                        Show sensor and logger status
  install                       Enable the optional user logger
  uninstall                     Remove the user logger and retain logs`;
const helpFlags = ["help", "--help", "-h"];
const thermal = fileURLToPath(new URL("./thermal", import.meta.url));

export function runOps([group, command, ...args], home) {
  if (group === undefined || helpFlags.includes(group)) {
    console.log(opsHelp);
    return 0;
  }
  if (group !== "thermal") {
    console.error(`awb ops: unknown operation '${group}'\n${opsHelp}`);
    return 64;
  }
  if (command === undefined || helpFlags.includes(command)) {
    console.log(thermalHelp);
    return 0;
  }
  if (!["now", "gate", "status", "install", "uninstall"].includes(command)) {
    console.error(`awb ops thermal: unknown command '${command}'\n${thermalHelp}`);
    return 64;
  }
  // Replace Node so signals and the command's exit status go directly to the guard.
  process.execve("/bin/sh", ["/bin/sh", thermal, command, ...args], { ...process.env, HOME: home });
}
