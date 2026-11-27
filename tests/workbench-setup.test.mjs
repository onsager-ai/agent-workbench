import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Setup, cliErrorMessage, codexHookHash, codexHookKey, effectiveWorkers, shellQuote, shellSplit } from "../skills/workbench-setup/scripts/workbench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = path.join(ROOT, "skills/workbench-setup");
const ORCHESTRATION = path.join(ROOT, "skills/orchestrate-harnesses");
const BEGIN = Buffer.from("<!-- BEGIN agent-workbench -->");
const END = Buffer.from("<!-- END agent-workbench -->");
const IMPORT = Buffer.from("@~/.agents/AGENTS.md");
const NL = Buffer.from("\n");
const temporaries = [];

after(() => temporaries.forEach((directory) => {
  fs.chmodSync(directory, 0o700);
  fs.rmSync(directory, { recursive: true, force: true });
}));

const cat = (...parts) => Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part) : part)));
// Byte-safe replace (all occurrences, or the first only).
const sub = (data, from, to, once = false) => {
  const text = data.toString("latin1");
  const search = Buffer.from(from).toString("latin1");
  const replacement = Buffer.from(to).toString("latin1");
  return Buffer.from(once ? text.replace(search, () => replacement) : text.replaceAll(search, replacement), "latin1");
};
const count = (data, needle) => data.toString("latin1").split(Buffer.from(needle).toString("latin1")).length - 1;

class Fixture {
  constructor() {
    this.temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workbench-setup-")));
    temporaries.push(this.temporary);
    this.configureHome(path.join(this.temporary, "selected"));
    this.nodeExecutable = process.execPath;
  }

  configureHome(home) {
    this.home = home;
    this.skill = path.join(home, ".agents/skills/workbench-setup");
    fs.cpSync(SKILL, this.skill, { recursive: true });
    this.script = path.join(this.skill, "scripts/workbench.mjs");
    this.shared = path.join(home, ".agents/AGENTS.md");
    this.codex = path.join(home, ".codex/AGENTS.md");
    this.claude = path.join(home, ".claude/CLAUDE.md");
    this.launcher = path.join(home, ".local/bin/agent-workbench");
    this.state = path.join(home, ".local/state/agent-workbench");
  }

  write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }

  run(command, args = [], ok = true, env = {}) {
    assert.notEqual(this.home, os.homedir());
    const result = spawnSync(this.nodeExecutable, [this.script, "--home", this.home, command, ...args,
      ...(command === "status" && !args.includes("--json") ? ["--json"] : [])],
      { encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: "", ...env } });
    assert.equal(result.status === 0, ok, result.stdout + result.stderr);
    return result;
  }

  // Only the selected disposable home is traversed; symlinks are never followed.
  snapshot() {
    const entries = {};
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        const relative = path.relative(this.home, file);
        if (entry.isSymbolicLink()) entries[relative] = ["link", fs.readlinkSync(file)];
        else if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          const info = fs.statSync(file, { bigint: true });
          entries[relative] = ["file", fs.readFileSync(file).toString("hex"), info.ino, info.mtimeNs];
        }
      }
    };
    walk(this.home);
    return entries;
  }

  private() {
    const data = fs.readFileSync(this.shared);
    return cat(data.subarray(0, data.indexOf(BEGIN)), data.subarray(data.indexOf(END) + END.length + 1));
  }

  nativeLock() {
    const lock = { version: 3, skills: {
      "workbench-setup": { source: "onsager-ai/agent-workbench", sourceType: "github" },
      "host-ops": { source: "onsager-ai/agent-workbench", sourceType: "github" },
      unrelated: { source: "another/project", sourceType: "github" },
    } };
    this.write(path.join(this.home, ".agents/.skill-lock.json"), JSON.stringify(lock));
    fs.mkdirSync(path.join(this.home, ".agents/skills/host-ops"), { recursive: true });
  }

  fakeCommand(body) {
    const file = path.join(this.home, "fake-skills.mjs");
    this.write(file, body);
    return [process.execPath, file].map(shellQuote).join(" ");
  }

  json(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  stateJson() {
    return this.json(path.join(this.state, "state.json"));
  }

  installOrchestration(override) {
    fs.cpSync(ORCHESTRATION, path.join(this.home, ".agents/skills/orchestrate-harnesses"), { recursive: true });
    fs.mkdirSync(path.join(this.home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(this.home, ".codex"), { recursive: true });
    if (override !== undefined) this.write(this.overridePath, JSON.stringify(override));
  }

  get overridePath() {
    return path.join(this.home, ".config/agent-workbench/workers.yml");
  }

  agent(name) {
    return path.join(this.home, ".claude/agents", name + ".md");
  }

  get hook() {
    return path.join(this.home, ".agents/skills/orchestrate-harnesses/scripts/policy-hook");
  }

  get hookCommand() {
    return [this.hook, "--workers", path.join(this.state, "workers.json")].map(shellQuote).join(" ");
  }

  get codexHookCommand() {
    return [this.hook, "--host", "codex", "--workers", path.join(this.state, "workers.json")].map(shellQuote).join(" ");
  }

  get codexHooksPath() {
    return path.join(this.home, ".codex/hooks.json");
  }

  personalFile(name = "AGENTS.md") {
    return path.join(this.home, ".agents/skills/workbench-personal", name);
  }
}

const exists = (file) => fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
const isLink = (file) => fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
const mode = (file) => fs.statSync(file).mode & 0o777;
const read = (file) => fs.readFileSync(file);
const hex = (data) => crypto.createHash("sha256").update(data).digest("hex");

describe("workbench setup", () => {
  test("update gives targeted guidance for the mixed-version stop_classifier error only", () => {
    const error = new Error("unknown keys in policy: stop_classifier; remove or correct those keys in workers.yml, then rerun the command");
    const message = cliErrorMessage(error, "update");
    assert.ok(message.startsWith(error.message));
    assert.match(message, /mixed versions; run agent-workbench install/);
    assert.match(message, /settings do not need to be deleted/);
    assert.equal(cliErrorMessage(error, "workers"), error.message);
    assert.equal(cliErrorMessage(new Error("invalid YAML in workers.yml"), "update"), "invalid YAML in workers.yml");
    assert.equal(cliErrorMessage(new Error("unknown keys in policy: stop_classifier, context"), "update"), "unknown keys in policy: stop_classifier, context");
  });

  test("instruction-only Antigravity opt-in and updates do not register workspace hooks", () => {
    const f = new Fixture();
    const workspace = path.join(f.temporary, "workspace with spaces");
    fs.mkdirSync(workspace);
    f.installOrchestration();
    f.run("install", ["--antigravity"]);
    f.run("install");
    assert.ok(!exists(path.join(workspace, ".agents/hooks.json")));
    f.nativeLock();
    f.run("update", ["--skills-cmd", f.fakeCommand("process.exit(0);")]);
    assert.ok(!exists(path.join(workspace, ".agents/hooks.json")));
  });

  test("explicit Antigravity workspace hook records ownership and removes only its unchanged group", () => {
    const f = new Fixture();
    f.configureHome(path.join(f.temporary, "selected home 'quotes'"));
    const workspace = path.join(f.temporary, "workspace with spaces and 'quotes'");
    const hooksFile = path.join(workspace, ".agents/hooks.json");
    fs.mkdirSync(workspace);
    f.installOrchestration();
    f.write(hooksFile, JSON.stringify({ foreign: { enabled: true, PreToolUse: [{ matcher: "other", hooks: [{ type: "command", command: "foreign" }] }] } }));
    f.run("install", ["--antigravity", "--workspace", workspace]);
    const expectedCommand = [path.resolve(process.execPath), path.resolve(f.hook), "--host", "antigravity"].map(shellQuote).join(" ");
    const expectedGroup = { enabled: true, PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: expectedCommand }] }] };
    assert.deepEqual(f.json(hooksFile), {
      foreign: { enabled: true, PreToolUse: [{ matcher: "other", hooks: [{ type: "command", command: "foreign" }] }] },
      "agent-workbench": expectedGroup,
    });
    const ownershipDir = path.join(f.state, "antigravity-workspaces");
    const records = fs.readdirSync(ownershipDir);
    assert.equal(records.length, 1);
    const ownershipFile = path.join(ownershipDir, records[0]);
    const ownership = f.json(ownershipFile);
    assert.deepEqual(ownership, { schema: 1, workspace, group: expectedGroup });
    assert.equal(mode(ownershipFile), 0o600);
    f.run("install", ["--antigravity", "--workspace", workspace]);
    assert.deepEqual(f.json(hooksFile)["agent-workbench"], expectedGroup);
    fs.unlinkSync(f.hook);
    f.run("uninstall", ["--antigravity", "--workspace", workspace]);
    assert.deepEqual(f.json(hooksFile), {
      foreign: { enabled: true, PreToolUse: [{ matcher: "other", hooks: [{ type: "command", command: "foreign" }] }] },
    });
    assert.ok(!exists(ownershipFile));
  });

  test("identical preexisting Antigravity hook is never adopted or removed", () => {
    const f = new Fixture();
    const workspace = path.join(f.temporary, "workspace");
    const hooksFile = path.join(workspace, ".agents/hooks.json");
    fs.mkdirSync(workspace);
    f.installOrchestration();
    const command = [path.resolve(process.execPath), path.resolve(f.hook), "--host", "antigravity"].map(shellQuote).join(" ");
    const foreign = { enabled: true, PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command }] }] };
    f.write(hooksFile, JSON.stringify({ "agent-workbench": foreign, other: { enabled: true } }));
    assert.match(f.run("install", ["--antigravity", "--workspace", workspace], false).stderr, /unowned agent-workbench group/);
    assert.deepEqual(f.json(hooksFile), { "agent-workbench": foreign, other: { enabled: true } });
    f.run("uninstall", ["--antigravity", "--workspace", workspace]);
    assert.deepEqual(f.json(hooksFile), { "agent-workbench": foreign, other: { enabled: true } });
    assert.ok(!exists(path.join(f.state, "antigravity-workspaces")));
  });

  test("changed Antigravity hook is retained until restored to its ownership record", () => {
    const f = new Fixture();
    const workspace = path.join(f.temporary, "workspace");
    const hooksFile = path.join(workspace, ".agents/hooks.json");
    fs.mkdirSync(workspace);
    f.installOrchestration();
    f.run("install", ["--antigravity", "--workspace", workspace]);
    const ownershipFile = path.join(f.state, "antigravity-workspaces", fs.readdirSync(path.join(f.state, "antigravity-workspaces"))[0]);
    const ownership = f.json(ownershipFile);
    const changed = { ...ownership.group, enabled: false };
    f.write(hooksFile, JSON.stringify({ "agent-workbench": changed, other: { enabled: true } }));
    const before = read(hooksFile);
    assert.match(f.run("uninstall", ["--antigravity", "--workspace", workspace], false).stderr, /hook was changed/);
    assert.deepEqual(read(hooksFile), before);
    assert.deepEqual(f.json(ownershipFile), ownership);
    assert.match(f.run("install", ["--antigravity", "--workspace", workspace], false).stderr, /conflicts with its ownership record/);
    assert.deepEqual(read(hooksFile), before);
    f.write(hooksFile, JSON.stringify({ "agent-workbench": ownership.group, other: { enabled: true } }));
    f.run("uninstall", ["--antigravity", "--workspace", workspace]);
    assert.deepEqual(f.json(hooksFile), { other: { enabled: true } });
    assert.ok(!exists(ownershipFile));
  });

  test("workspace hook registration conflicts on unsafe config or missing adapter", () => {
    const f = new Fixture();
    const workspace = path.join(f.temporary, "workspace");
    fs.mkdirSync(workspace);
    const hooksFile = path.join(workspace, ".agents/hooks.json");
    f.installOrchestration();
    f.write(hooksFile, "{broken");
    assert.match(f.run("install", ["--antigravity", "--workspace", workspace], false).stderr, /invalid Antigravity hooks/);
    fs.rmSync(hooksFile);
    fs.chmodSync(f.hook, 0o600);
    assert.match(f.run("install", ["--antigravity", "--workspace", workspace], false).stderr, /not installed or executable/);
    fs.chmodSync(f.hook, 0o700);
    f.write(hooksFile, JSON.stringify({ "agent-workbench": { enabled: true, PreToolUse: [] } }));
    assert.match(f.run("install", ["--antigravity", "--workspace", workspace], false).stderr, /unowned agent-workbench group/);
    assert.deepEqual(f.json(hooksFile), { "agent-workbench": { enabled: true, PreToolUse: [] } });
  });

  test("Antigravity target is opt-in, preserves content and removes only its owned include", () => {
    const f = new Fixture();
    const gemini = path.join(f.home, ".gemini/AGENTS.md");
    f.write(gemini, "# Existing guidance\n\nKeep this text.\n");
    f.run("install");
    assert.deepEqual(read(gemini), Buffer.from("# Existing guidance\n\nKeep this text.\n"));
    f.run("install", ["--antigravity"]);
    const include = Buffer.from("@[Work instructions](~/.agents/AGENTS.md)\n");
    assert.deepEqual(read(gemini), Buffer.concat([Buffer.from("# Existing guidance\n\nKeep this text.\n"), include]));
    f.run("install", ["--antigravity"]);
    assert.deepEqual(read(gemini), Buffer.concat([Buffer.from("# Existing guidance\n\nKeep this text.\n"), include]));
    f.run("uninstall");
    assert.deepEqual(read(gemini), Buffer.from("# Existing guidance\n\nKeep this text.\n"));
  });

  test("Antigravity removes its separator when original content has no newline", () => {
    const f = new Fixture();
    const gemini = path.join(f.home, ".gemini/AGENTS.md");
    const original = Buffer.from("Existing guidance without a newline");
    f.write(gemini, original);
    f.run("install", ["--antigravity"]);
    assert.equal(f.stateJson().antigravity_import.separator, true);
    f.run("uninstall");
    assert.deepEqual(read(gemini), original);
  });

  test("Antigravity uninstall removes an instruction file it created", () => {
    const f = new Fixture();
    const gemini = path.join(f.home, ".gemini/AGENTS.md");
    f.run("install", ["--antigravity"]);
    assert.ok(exists(gemini));
    f.run("uninstall");
    assert.ok(!exists(gemini));
  });

  test("default install does not inspect or change a Gemini instruction symlink", () => {
    const f = new Fixture();
    const gemini = path.join(f.home, ".gemini/AGENTS.md");
    const external = path.join(f.temporary, "outside-gemini.md");
    f.write(external, "leave alone");
    fs.mkdirSync(path.dirname(gemini), { recursive: true });
    fs.symlinkSync(external, gemini);
    f.run("install");
    assert.ok(isLink(gemini));
    assert.deepEqual(read(external), Buffer.from("leave alone"));
  });

  test("Antigravity leaves an identical pre-existing include unowned", () => {
    const f = new Fixture();
    const gemini = path.join(f.home, ".gemini/AGENTS.md");
    const original = Buffer.from("# Existing\r\n@[Work instructions](~/.agents/AGENTS.md)\r\nMore content\r\n");
    f.write(gemini, original);
    f.run("install", ["--antigravity"]);
    assert.equal(f.stateJson().antigravity_import.owned, false);
    f.run("uninstall");
    assert.deepEqual(read(gemini), original);
  });

  test("fresh install, status and launcher", () => {
    const f = new Fixture();
    const help = spawnSync(process.execPath, [f.script, "help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /trust\s+Trust installed Codex policy hooks/);
    assert.match(spawnSync(process.execPath, [f.script, "status", "--help"], { encoding: "utf8" }).stdout, /--json/);
    f.run("install");
    assert.equal(f.private().length, 0);
    assert.ok(isLink(f.codex));
    assert.deepEqual(read(f.codex), read(f.shared));
    assert.deepEqual(read(f.claude), cat(IMPORT, NL));
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` };
    const result = spawnSync(f.launcher, ["status", "--json"], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).private_bytes, 0);
    const readable = spawnSync(f.launcher, ["status"], { encoding: "utf8", env });
    assert.equal(readable.status, 0, readable.stderr);
    assert.match(readable.stdout, /^ok  setup: applied$/m);
    assert.deepEqual(JSON.parse(result.stdout).personal_package, { present: false, applied_files: [] });
    assert.equal(mode(f.state), 0o700);
    for (const name of fs.readdirSync(path.join(f.state, "backups"))) assert.equal(mode(path.join(f.state, "backups", name)), 0o600);
    assert.match(read(f.launcher).toString(), /^#!\/bin\/sh\n/);
    assert.equal(mode(f.launcher), 0o700);
  });

  test("thermal logger is opt-in through the installed launcher and preserves logs", () => {
    const f = new Fixture();
    const sysfs = path.join(f.temporary, "sys");
    const zone = path.join(sysfs, "class/thermal/thermal_zone0");
    f.write(path.join(zone, "type"), "x86_pkg_temp\n");
    f.write(path.join(zone, "temp"), "52000\n");
    const bin = path.join(f.temporary, "bin");
    const systemctl = path.join(bin, "systemctl");
    const calls = path.join(f.temporary, "systemctl.log");
    f.write(systemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_LOG"\n[ "$2" != is-active ] || echo active\n');
    fs.chmodSync(systemctl, 0o700);
    const env = {
      PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
      THERMAL_SYSFS: sysfs, XDG_STATE_HOME: "", SYSTEMCTL_LOG: calls,
    };
    const legacyLauncher = path.join(f.home, ".local/bin/thermal");
    const unit = "host-ops-thermal.service";
    const service = path.join(f.home, ".config/systemd/user", unit);
    const log = path.join(f.home, ".local/state/thermal-guard/temps.log");
    f.write(log, "previous reading\n");

    const legacyThermal = path.join(f.home, ".agents/skills/host-ops/scripts/thermal");
    f.write(legacyThermal, '#!/bin/sh\nprintf "legacy %s\\n" "$*" >> "$SYSTEMCTL_LOG"\n');
    fs.chmodSync(legacyThermal, 0o700);
    f.run("install", [], true, env);
    f.nativeLock();
    f.run("update", ["--skills-cmd", f.fakeCommand("process.exit(0);")], true, env);
    assert.ok(!exists(calls));
    assert.ok(!exists(service));

    const ops = (...args) => {
      const result = spawnSync(f.launcher, ["ops", "thermal", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.match(ops("now"), /52C sensor=/);
    assert.equal(ops("gate", "--", "printf", "%s", "--json"), "--json");
    assert.match(ops("install"), /thermal service installed/);
    assert.ok(!exists(legacyLauncher));
    assert.ok(read(service).includes('ExecStart=/bin/sh "%h/.agents/skills/workbench-setup/scripts/thermal" watch\n'));
    assert.match(ops("status"), /temperature=52C\nservice=active\nlast_log_age=\d+s/);
    assert.match(ops("uninstall"), /thermal guard uninstalled/);
    assert.ok(!exists(service));
    assert.equal(read(log).toString(), "previous reading\n");
    assert.deepEqual(read(calls).toString().trim().split("\n"), [
      "--user show-environment",
      "--user daemon-reload",
      `--user enable --now ${unit}`,
      "--user show-environment",
      `--user is-active ${unit}`,
      `--user disable --now ${unit}`,
      "--user daemon-reload",
    ]);
  });

  test("first install keeps existing bytes and is idempotent", () => {
    const f = new Fixture();
    const personal = cat("private π rules", Buffer.from([0x80]));
    f.write(f.shared, "existing shared\n");
    f.write(f.codex, personal);
    f.write(f.claude, "existing Claude text");
    f.run("install");
    assert.deepEqual(f.private(), cat("existing shared\n", personal));
    assert.deepEqual(read(f.claude), cat("existing Claude text\n", IMPORT, NL));
    const before = f.snapshot();
    assert.match(f.run("install").stdout, /no-op/);
    assert.deepEqual(f.snapshot(), before);
    const backup = f.json(path.join(f.state, "backups/codex.json"));
    assert.deepEqual(Buffer.from(backup.base64, "base64"), personal);
  });

  test("personal instructions install, idempotence and uninstall", () => {
    const f = new Fixture();
    const personal = f.personalFile();
    f.write(personal, "Personal π rules\n");
    f.write(f.shared, cat("private after", Buffer.from([0x80])));
    f.run("install");
    const expected = cat("<!-- BEGIN agent-workbench personal -->\n", read(personal), "<!-- END agent-workbench personal -->\n");
    assert.ok(read(f.shared).includes(cat(END, NL, expected)));
    fs.writeFileSync(f.shared, cat("private before\n", read(f.shared)));
    const before = f.snapshot();
    assert.match(f.run("install").stdout, /no-op/);
    assert.deepEqual(f.snapshot(), before);
    const status = JSON.parse(f.run("status").stdout);
    assert.deepEqual(status.personal_package, { present: true, applied_files: ["AGENTS.md"] });
    assert.equal(status.private_bytes, cat("private before\nprivate after", Buffer.from([0x80])).length);
    f.run("uninstall");
    assert.deepEqual(read(f.shared), cat("private before\nprivate after", Buffer.from([0x80])));
    assert.deepEqual(read(f.codex), read(f.shared));
  });

  test("personal block removed with file or package", () => {
    for (const removePackage of [false, true]) {
      const f = new Fixture();
      const personal = f.personalFile();
      f.write(personal, "personal rules");
      f.run("install");
      if (removePackage) fs.rmSync(path.dirname(personal), { recursive: true });
      else fs.unlinkSync(personal);
      f.run("install");
      assert.ok(!read(f.shared).includes("agent-workbench personal"));
      assert.equal(f.stateJson().personal_block, null);
    }
  });

  test("personal instruction update preserves private positions", () => {
    const f = new Fixture();
    f.run("install");
    fs.writeFileSync(f.shared, cat(Buffer.from([0x62, 0x80, 0x0a]), read(f.shared), Buffer.from([0x61, 0x81])));
    const personal = f.personalFile();
    f.write(personal, "first rules\n");
    f.run("install");
    fs.writeFileSync(personal, "new rules\n");
    f.run("install");
    const data = read(f.shared);
    assert.ok(data.subarray(0, 3 + BEGIN.length).equals(cat(Buffer.from([0x62, 0x80, 0x0a]), BEGIN)));
    assert.ok(data.subarray(data.length - 2).equals(Buffer.from([0x61, 0x81])));
    assert.ok(data.includes(cat(END, "\n<!-- BEGIN agent-workbench personal -->\nnew rules\n")));
    assert.ok(!data.includes("first rules"));
  });

  test("personal instruction symlink refused", () => {
    const f = new Fixture();
    const personal = f.personalFile();
    f.write(path.join(f.home, "foreign-instructions"), "rules");
    fs.mkdirSync(path.dirname(personal), { recursive: true });
    fs.symlinkSync(path.join(f.home, "foreign-instructions"), personal);
    const before = f.snapshot();
    assert.match(f.run("install", [], false).stderr, /symlink/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("personal managed markers and edits conflict", () => {
    const f = new Fixture();
    const personal = f.personalFile();
    f.write(personal, "personal rules\n");
    f.run("install");
    const original = read(f.shared);
    const variants = [
      sub(original, "personal rules", "edited rules"),
      cat(original, "<!-- BEGIN agent-workbench personal -->\n"),
      sub(original, "<!-- END agent-workbench personal -->", ""),
      sub(sub(original, cat(END, NL), ""), "personal rules", cat(END, "\npersonal rules")),
    ];
    for (const data of variants) {
      fs.writeFileSync(f.shared, data);
      for (const command of ["install", "status", "uninstall"]) {
        const before = f.snapshot();
        f.run(command, [], false);
        assert.deepEqual(f.snapshot(), before);
      }
    }
    fs.writeFileSync(f.shared, original);
    fs.writeFileSync(personal, BEGIN);
    assert.match(f.run("install", [], false).stderr, /managed markers/);
  });

  test("preexisting import is not owned or duplicated", () => {
    const f = new Fixture();
    const data = cat("private\n", IMPORT, NL);
    f.write(f.claude, data);
    f.run("install");
    f.run("install");
    f.run("uninstall");
    assert.deepEqual(read(f.claude), data);
  });

  test("preexisting equivalent import forms are reused", () => {
    const forms = ["@~/.agents/AGENTS.md", "@../.agents/AGENTS.md", "@./../.agents/AGENTS.md", null];
    forms.forEach((form, index) => {
      const f = new Fixture();
      f.configureHome(path.join(f.temporary, `equivalent-${index}`));
      const importLine = form ?? "@" + f.shared;
      const original = Buffer.from(`Claude café before\n${importLine}\nAfter 雪`);
      f.write(f.claude, original);
      f.run("install");
      assert.deepEqual(read(f.claude), original);
      assert.equal(f.stateJson().claude_import.owned, false);
      const beforeReinstall = read(f.claude);
      assert.match(f.run("install").stdout, /no-op/);
      assert.deepEqual(read(f.claude), beforeReinstall);
      f.run("status");
      f.run("uninstall");
      assert.deepEqual(read(f.claude), original);
    });
  });

  test("mixed equivalent import duplicates refuse without writes", () => {
    const cases = [["@~/.agents/AGENTS.md", "@../.agents/AGENTS.md"], ["@../.agents/AGENTS.md", null]];
    cases.forEach(([first, second], index) => {
      const f = new Fixture();
      f.configureHome(path.join(f.temporary, `duplicate-${index}`));
      const absolute = "@" + f.shared;
      f.write(f.claude, `Before é\n${first}\n${second ?? absolute}\nAfter`);
      const before = f.snapshot();
      assert.match(f.run("install", [], false).stderr, /duplicate Claude imports/);
      assert.deepEqual(f.snapshot(), before);
      assert.ok(!exists(path.join(f.state, "state.json")));
    });
  });

  test("foreign import is preserved and owned import is appended once", () => {
    const f = new Fixture();
    const original = Buffer.from("Personal café\n@../other/AGENTS.md\nAfter 雪");
    f.write(f.claude, original);
    f.run("install");
    const expected = cat(original, NL, IMPORT, NL);
    assert.deepEqual(read(f.claude), expected);
    f.run("install");
    assert.deepEqual(read(f.claude), expected);
    assert.equal(count(read(f.claude), IMPORT), 1);
    f.run("uninstall");
    assert.deepEqual(read(f.claude), original);
  });

  test("personal Claude edit survives owned import uninstall", () => {
    const f = new Fixture();
    f.run("install");
    fs.writeFileSync(f.claude, cat(read(f.claude), "personal edit π\n"));
    f.run("uninstall");
    assert.deepEqual(read(f.claude), Buffer.from("personal edit π\n"));
  });

  test("foreign link refuses without writes", () => {
    const f = new Fixture();
    const target = path.join(f.home, "foreign");
    f.write(target, "foreign");
    fs.mkdirSync(path.dirname(f.codex));
    fs.symlinkSync(target, f.codex);
    const before = f.snapshot();
    f.run("install", [], false);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(!exists(f.state));
  });

  test("foreign command refuses without writes", () => {
    const f = new Fixture();
    f.write(f.launcher, "foreign command");
    const before = f.snapshot();
    f.run("install", [], false);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(!exists(f.state));
  });

  test("symlink parent refuses", () => {
    const f = new Fixture();
    const directory = path.join(f.home, "elsewhere");
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, path.join(f.home, ".claude"), "dir");
    const before = f.snapshot();
    f.run("install", [], false);
    assert.deepEqual(f.snapshot(), before);
  });

  test("override masking is reported", () => {
    const f = new Fixture();
    f.run("install");
    f.write(path.join(f.home, ".codex/AGENTS.override.md"), "override");
    const before = f.snapshot();
    assert.match(f.run("status", [], false).stderr, /masks/);
    f.run("install", [], false);
    assert.deepEqual(f.snapshot(), before);
  });

  test("invalid markers refuse without writes", () => {
    for (const data of [BEGIN, END, cat(END, BEGIN), cat(BEGIN, BEGIN, END)]) {
      const f = new Fixture();
      f.write(f.shared, data);
      const before = f.snapshot();
      f.run("install", [], false);
      assert.deepEqual(f.snapshot(), before);
    }
  });

  test("manual managed drift refuses install and uninstall", () => {
    const f = new Fixture();
    f.run("install");
    const original = read(f.shared);
    const drifted = sub(original, cat(BEGIN, NL), cat(BEGIN, "\nmanual drift\n"), true);
    assert.notDeepEqual(original, drifted);
    fs.writeFileSync(f.shared, drifted);
    const before = f.snapshot();
    for (const command of ["status", "install", "uninstall"]) assert.match(f.run(command, [], false).stderr, /drift/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("lock contention", () => {
    const f = new Fixture();
    f.run("install");
    const lock = path.join(f.state, "lock.d");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    assert.match(f.run("install", [], false).stderr, /holds the lock/);
    assert.ok(exists(lock));
  });

  test("stale lock from a dead process is replaced", () => {
    const f = new Fixture();
    f.run("install");
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(dead.status, 0);
    const lock = path.join(f.state, "lock.d");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(dead.pid));
    assert.match(f.run("install").stdout, /no-op/);
    assert.ok(!exists(lock));
    assert.deepEqual(fs.readdirSync(f.state).filter((name) => name.startsWith("lock.d")), []);
  });

  test("a lock without a pid is held until it is old", () => {
    const f = new Fixture();
    f.run("install");
    const lock = path.join(f.state, "lock.d");
    fs.mkdirSync(lock);
    assert.match(f.run("install", [], false).stderr, /holds the lock/);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(lock, old, old);
    assert.match(f.run("install").stdout, /no-op/);
  });

  test("parent directories keep default modes and only the state directory is private", () => {
    const f = new Fixture();
    f.run("install");
    const expected = 0o777 & ~process.umask();
    assert.equal(mode(path.dirname(f.state)), expected);
    assert.equal(mode(f.state), 0o700);
    assert.equal(mode(path.join(f.state, "backups")), 0o700);
  });

  test("shell splitting uses ASCII whitespace only", () => {
    assert.deepEqual(shellSplit("a\u00a0b  c\t'd e'\n\"f g\""), ["a\u00a0b", "c", "d e", "f g"]);
  });

  test("update failure preserves instruction bytes", () => {
    const f = new Fixture();
    f.run("install");
    f.nativeLock();
    const command = f.fakeCommand("process.exit(7);\n");
    const before = f.snapshot();
    assert.match(f.run("update", ["--skills-cmd", command], false).stderr, /unchanged/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("alternate home never defaults to real npx", () => {
    const f = new Fixture();
    f.run("install");
    f.nativeLock();
    const before = f.snapshot();
    assert.match(f.run("update", [], false).stderr, /real-user npx was not invoked/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("update only repo skills then fresh updated code", () => {
    const f = new Fixture();
    f.run("install");
    f.nativeLock();
    const log = path.join(f.home, "calls.json");
    const marker = path.join(f.home, "fresh-process");
    const template = path.join(f.skill, "assets/AGENTS.md");
    // The updated script writes a marker only when entered as the new process.
    const command = f.fakeCommand(
      'import fs from "node:fs";\n' +
      `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.writeFileSync(${JSON.stringify(template)}, "new public template\\n");\n` +
      `let s = fs.readFileSync(${JSON.stringify(f.script)}, "utf8");\n` +
      `s = s.replace("process.exitCode = main();", ${JSON.stringify(`fs.writeFileSync(${JSON.stringify(marker)}, "fresh"); process.exitCode = main();`)});\n` +
      `fs.writeFileSync(${JSON.stringify(f.script)}, s);\n`);
    f.run("update", ["--skills-cmd", command]);
    assert.deepEqual(f.json(log), ["update", "host-ops", "workbench-setup", "-g", "-y"]);
    assert.equal(read(marker).toString(), "fresh");
    assert.ok(read(f.shared).includes("new public template"));
  });

  test("update includes personal package from any source", () => {
    const f = new Fixture();
    f.run("install");
    f.nativeLock();
    const lockPath = path.join(f.home, ".agents/.skill-lock.json");
    const lock = f.json(lockPath);
    lock.skills["workbench-personal"] = { source: "private/personal", sourceType: "git" };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const log = path.join(f.home, "calls.json");
    const personal = f.personalFile();
    fs.mkdirSync(path.dirname(personal), { recursive: true });
    const command = f.fakeCommand(
      'import fs from "node:fs";\nimport path from "node:path";\n' +
      `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.mkdirSync(path.dirname(${JSON.stringify(personal)}), { recursive: true });\n` +
      `fs.writeFileSync(${JSON.stringify(personal)}, "updated personal rules");\n`);
    f.run("update", ["--skills-cmd", command]);
    assert.deepEqual(f.json(log), ["update", "host-ops", "workbench-personal", "workbench-setup", "-g", "-y"]);
    assert.ok(read(f.shared).includes("updated personal rules"));
  });

  test("update drops owned lock entries whose skill was deleted locally", () => {
    const f = new Fixture();
    f.run("install");
    f.nativeLock();
    const lockPath = path.join(f.home, ".agents/.skill-lock.json");
    const lock = f.json(lockPath);
    lock.skills["thermal-guard"] = { source: "onsager-ai/agent-workbench", sourceType: "github" };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const log = path.join(f.home, "calls.json");
    const command = f.fakeCommand(`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    assert.match(f.run("update", ["--skills-cmd", command]).stdout, /dropped stale skills lock entries: thermal-guard/);
    assert.deepEqual(f.json(log), ["update", "host-ops", "workbench-setup", "-g", "-y"]);
    assert.deepEqual(Object.keys(f.json(lockPath).skills).sort(), ["host-ops", "unrelated", "workbench-setup"]);
  });

  test("version matches the package release", () => {
    const f = new Fixture();
    const release = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version;
    assert.equal(f.run("--version").stdout.trim(), release);
    assert.equal(f.run("version").stdout.trim(), release);
  });

  test("template update preserves private positions and bytes", () => {
    const f = new Fixture();
    f.run("install");
    fs.writeFileSync(f.shared, cat(Buffer.from([0x70, 0x80]), read(f.shared), "suffix"));
    f.write(path.join(f.skill, "assets/AGENTS.md"), "updated public\n");
    const status = f.run("status", [], false);
    assert.match(status.stdout, /instruction update is available; run agent-workbench install/);
    f.run("install");
    const data = read(f.shared);
    assert.ok(data.subarray(0, 2 + BEGIN.length).equals(cat(Buffer.from([0x70, 0x80]), BEGIN)));
    assert.ok(data.subarray(data.length - 6).equals(Buffer.from("suffix")));
    assert.deepEqual(f.private(), cat(Buffer.from([0x70, 0x80]), "suffix"));
  });

  test("uninstall preserves new private and Claude edits", () => {
    const f = new Fixture();
    f.write(f.codex, "original without newline");
    f.write(f.claude, "prior Claude");
    f.run("install");
    fs.writeFileSync(f.shared, cat(read(f.shared), "\nnew private edits", Buffer.from([0x80])));
    fs.writeFileSync(f.claude, cat(read(f.claude), "later Claude\n"));
    const expected = f.private();
    f.run("uninstall");
    assert.ok(!isLink(f.codex));
    assert.deepEqual(read(f.codex), expected);
    assert.deepEqual(read(f.shared), expected);
    assert.ok(read(f.claude).includes("later Claude\n"));
    assert.ok(!read(f.claude).includes(IMPORT));
    assert.ok(!exists(f.launcher));
    assert.ok(exists(path.join(f.state, "backups/codex.json")));
    f.run("uninstall");
  });

  test("uninstall foreign replaced link is preserved", () => {
    const f = new Fixture();
    f.run("install");
    fs.unlinkSync(f.codex);
    fs.symlinkSync("different", f.codex);
    const before = f.snapshot();
    f.run("uninstall", [], false);
    assert.deepEqual(f.snapshot(), before);
  });

  test("uninstall replaced command is preserved", () => {
    const f = new Fixture();
    f.run("install");
    fs.writeFileSync(f.launcher, "new foreign command");
    const before = f.snapshot();
    f.run("uninstall", [], false);
    assert.deepEqual(f.snapshot(), before);
  });

  test("reinstall after uninstall does not duplicate personal text", () => {
    const f = new Fixture();
    f.write(f.codex, "personal");
    f.write(f.claude, "Claude without newline");
    f.run("install");
    f.run("uninstall");
    assert.deepEqual(read(f.claude), Buffer.from("Claude without newline"));
    f.run("install");
    assert.deepEqual(f.private(), Buffer.from("personal"));
  });

  test("invalid state refuses without changes", () => {
    const f = new Fixture();
    f.run("install");
    f.write(path.join(f.state, "state.json"), '{"schema": 99}');
    const before = f.snapshot();
    assert.match(f.run("install", [], false).stderr, /invalid setup state/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("update missing ownership refuses before command", () => {
    const f = new Fixture();
    f.run("install");
    f.write(path.join(f.home, ".agents/.skill-lock.json"), '{"version": 3, "skills": {}}');
    const marker = path.join(f.home, "should-not-run");
    const command = f.fakeCommand(`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "");\n`);
    const before = f.snapshot();
    f.run("update", ["--skills-cmd", command], false);
    assert.ok(!exists(marker));
    assert.deepEqual(f.snapshot(), before);
  });

  test("write failure rolls back current entries", { skip: process.getuid() === 0 && "root ignores directory permissions" }, () => {
    const f = new Fixture();
    f.write(f.codex, "prior Codex");
    f.write(f.claude, "prior Claude");
    // CLAUDE.md is replaced after the shared file and Codex link; a read-only directory makes that write fail.
    fs.chmodSync(path.dirname(f.claude), 0o500);
    try {
      assert.throws(() => new Setup(f.home).install());
    } finally {
      fs.chmodSync(path.dirname(f.claude), 0o700);
    }
    assert.ok(!exists(f.shared));
    assert.ok(!isLink(f.codex));
    assert.deepEqual(read(f.codex), Buffer.from("prior Codex"));
    assert.deepEqual(read(f.claude), Buffer.from("prior Claude"));
    assert.ok(!exists(f.launcher));
    assert.ok(!exists(path.join(f.state, "state.json")));
  });

  test("pre-Node Python launcher is owned and migrated", () => {
    const f = new Fixture();
    f.run("install");
    const old = Buffer.from("#!/usr/bin/env python3\n# Managed by agent-workbench; ownership is recorded in state.json.\n" +
      `import os, sys\nscript = '${f.skill}/scripts/workbench.py'\nhome = '${f.home}'\n` +
      "os.execv(sys.executable, [sys.executable, script, '--home', home, *sys.argv[1:]])\n");
    fs.writeFileSync(f.launcher, old, { mode: 0o700 });
    const statePath = path.join(f.state, "state.json");
    const state = f.json(statePath);
    state.launcher_hash = hex(old);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    f.run("status");
    assert.match(f.run("install").stdout, /^installed/);
    assert.match(read(f.launcher).toString(), /^#!\/bin\/sh\n/);
    assert.notEqual(f.stateJson().launcher_hash, hex(old));
    assert.match(f.run("install").stdout, /no-op/);
    // A launcher that differs from the recorded bytes is still foreign.
    fs.writeFileSync(f.launcher, cat(old, "# edited\n"));
    f.run("install", [], false);
  });

  test("python shim hands off to the Node script", { skip: spawnSync("python3", ["--version"]).error !== undefined && "python3 unavailable" }, () => {
    const f = new Fixture();
    const result = spawnSync("python3", [path.join(f.skill, "scripts/workbench.py"), "--home", f.home, "install"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed/);
    assert.ok(exists(f.launcher));
  });

  test("personal worker layering and validation", () => {
    const f = new Fixture();
    f.installOrchestration({ defaults: { timeout_s: 900 } });
    const personal = f.personalFile("workers.yml");
    f.write(personal, "defaults: {timeout_s: 800, effort: high}\n");
    const workers = JSON.parse(f.run("workers").stdout);
    assert.equal(workers.defaults.timeout_s, 900);
    assert.equal(workers.defaults.effort, "high");
    f.run("install");
    assert.deepEqual(JSON.parse(f.run("status").stdout).personal_package, { present: true, applied_files: ["workers.yml"] });
    fs.unlinkSync(f.overridePath);
    assert.equal(JSON.parse(f.run("workers").stdout).defaults.timeout_s, 800);
    f.write(personal, "defaults: {unknown: true}\n");
    const before = f.snapshot();
    assert.match(f.run("install", [], false).stderr, /unknown keys/);
    assert.deepEqual(f.snapshot(), before);
    fs.unlinkSync(personal);
    fs.symlinkSync(path.join(f.home, "foreign-workers"), personal);
    assert.match(f.run("workers", [], false).stderr, /symlink/);
  });

  test("agents are generated for Claude roles by default", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const names = (directory) => fs.readdirSync(directory).map((name) => path.basename(name, ".md")).sort();
    assert.deepEqual(names(path.dirname(f.agent("x"))), ["haiku", "opus", "sonnet"]);
    const text = fs.readFileSync(f.agent("haiku"), "utf8");
    const worker = fs.readFileSync(path.join(ORCHESTRATION, "references/worker.md"), "utf8");
    assert.ok(text.startsWith("---\nname: haiku\n"));
    assert.ok(text.includes('model: "claude-haiku-5-5"\neffort: "medium"\ndisallowedTools: AskUserQuestion\n---\n'));
    assert.ok(text.includes("Managed by agent-workbench"));
    for (const name of names(path.dirname(f.agent("x")))) {
      const agent = fs.readFileSync(f.agent(name), "utf8");
      assert.ok(agent.includes("disallowedTools: AskUserQuestion\n"));
      assert.ok(!agent.includes("autoCompactWindow:"));
    }
    assert.ok(text.endsWith(worker));
    assert.deepEqual(Object.keys(f.stateJson().agents).sort(), ["haiku", "opus", "sonnet"]);
    assert.ok("haiku" in JSON.parse(f.run("status").stdout).agents);
    assert.match(f.run("install").stdout, /no-op/);
  });

  test("worker_window is added to every generated Claude subagent", () => {
    const f = new Fixture();
    f.installOrchestration({ policy: { context: { worker_window: 150000 } } });
    f.run("install");
    const names = fs.readdirSync(path.dirname(f.agent("x"))).filter((name) => name.endsWith(".md"));
    assert.equal(names.length, 3);
    for (const name of names) {
      const text = fs.readFileSync(path.join(path.dirname(f.agent("x")), name), "utf8");
      assert.ok(text.includes("disallowedTools: AskUserQuestion\n"));
      assert.ok(text.includes("autoCompactWindow: 150000\n"));
    }
  });

  // Run desiredAgents in-process against a fake `magpie` on PATH, capturing stderr warnings.
  function inspectCatalog(f, { stdout = "", runnable = true, installed = true } = {}) {
    const bin = path.join(f.temporary, "bin");
    fs.rmSync(bin, { recursive: true, force: true });
    fs.mkdirSync(bin);
    const calls = path.join(f.temporary, "magpie-calls");
    const output = path.join(f.temporary, "magpie-output");
    fs.writeFileSync(output, stdout);
    if (installed) {
      const body = runnable ? `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncat '${output}'\n` : "#!/nonexistent/interpreter\n";
      fs.writeFileSync(path.join(bin, "magpie"), body, { mode: 0o755 });
    }
    const originalPath = process.env.PATH;
    const originalError = console.error;
    const warnings = [];
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    console.error = (...args) => warnings.push(args.join(" "));
    try {
      new Setup(f.home).desiredAgents();
    } finally {
      process.env.PATH = originalPath;
      console.error = originalError;
    }
    const invocations = exists(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
    return { warnings: warnings.join("\n"), invocations };
  }

  test("catalog validation warns for unknown model and effort", () => {
    const f = new Fixture();
    f.installOrchestration({ profile: "codex", profiles: { codex: { tiers: {
      luna: { claude_route: "unknown/model", effort: "max" },
      terra: { claude_route: "known/model", effort: "xhigh" } } } } });
    const { warnings, invocations } = inspectCatalog(f, { stdout: "  known/model  Known Model  low/medium/high/max\n" });
    assert.match(warnings, /luna tier model 'unknown\/model' is absent/);
    assert.match(warnings, /terra tier effort 'xhigh' is not listed/);
    assert.deepEqual(invocations, ["models claude"]);
  });

  test("catalog validation matches routing-prefixed entries", () => {
    const f = new Fixture();
    f.installOrchestration({ profile: "codex", profiles: { codex: { tiers: {
      luna: { claude_route: "gateway/gpt-6-luna" },
      terra: { claude_route: "gateway/gpt-6.1-terra" },
      sol: { claude_route: "gateway/gpt-6.2-sol" } } } } });
    const { warnings } = inspectCatalog(f, { stdout:
      "  Routing groups\n" +
      "  auto/claude-haiku-5-5       Claude Haiku 5.5 · Wokey  low/medium\n" +
      "  hub/wokey/claude-sonnet-5-5 Claude Sonnet 5.5 · Wokey  medium/high\n" +
      "  claude/claude-opus-5-5      Claude Opus 5.5  low/medium/high\n" +
      "  gateway/gpt-6-luna    GPT-6 Luna  medium/high/max\n" +
      "  gateway/gpt-6.1-terra GPT-6.1 Terra  medium/high\n" +
      "  gateway/gpt-6.2-sol   GPT-6.2 Sol  medium/high\n" });
    assert.ok(!warnings.includes("is absent"));
    assert.ok(!warnings.includes("is not listed"));
  });

  test("the documented neutral override generates aliases and supports a pinned fallback", () => {
    const f = new Fixture();
    const snippet = read(path.join(ROOT, "tests/fixtures/neutral-workers.yml")).toString("utf8");
    f.installOrchestration();
    f.write(f.overridePath, snippet);
    f.run("install");
    const workers = JSON.parse(f.run("workers").stdout);
    assert.equal(workers.profile, "neutral");
    const aliases = { fast: "haiku", standard: "sonnet", expert: "opus" };
    for (const [name, alias] of Object.entries(aliases)) {
      assert.ok(fs.readFileSync(f.agent(name), "utf8").includes(`model: "${alias}"\neffort: "medium"\n`));
    }
    assert.deepEqual(Object.keys(f.stateJson().agents).sort(), ["expert", "fast", "haiku", "opus", "sonnet", "standard"]);
    const { warnings } = inspectCatalog(f, { stdout: ["haiku", "sonnet", "opus"]
      .map((alias) => `auto/claude-${alias}-5-5  Claude ${alias}  low/medium`).join("\n") });
    assert.equal(warnings, "");
    f.write(f.overridePath, snippet
      .replace("    ladder:", "      standard-backup: {harness: claude, model: gateway/fallback}\n    ladder:")
      .replace("tiers: [standard]", "tiers: [standard, standard-backup]"));
    f.run("install");
    assert.deepEqual(JSON.parse(f.run("workers").stdout).ladder[1].tiers, ["standard", "standard-backup"]);
    assert.ok(fs.readFileSync(f.agent("standard-backup"), "utf8").includes('model: "gateway/fallback"\n'));
  });

  test("catalog validation skips when magpie is absent", () => {
    const f = new Fixture();
    f.installOrchestration();
    const { warnings, invocations } = inspectCatalog(f, { installed: false });
    assert.equal(warnings, "");
    assert.deepEqual(invocations, []);
  });

  test("catalog validation failure is non-fatal", () => {
    const f = new Fixture();
    f.installOrchestration();
    const { warnings } = inspectCatalog(f, { runnable: false });
    assert.match(warnings, /magpie catalog unavailable; tier validation skipped/);
  });

  test("no agents without orchestration skill", () => {
    const f = new Fixture();
    const result = f.run("install");
    assert.match(result.stdout, /not installed/);
    assert.ok(!exists(path.dirname(f.agent("x"))));
  });

  test("codex profile routes only with override", () => {
    const f = new Fixture();
    f.installOrchestration({ profile: "codex" });
    f.run("install");
    const names = () => fs.readdirSync(path.dirname(f.agent("x"))).map((name) => path.basename(name, ".md")).sort();
    assert.deepEqual(names(), ["haiku", "opus", "sonnet"]);
    const route = "gateway/gpt-6-luna";
    f.write(f.overridePath, JSON.stringify({ profile: "codex", profiles: { codex: { tiers: { luna: { claude_route: route } } } } }));
    f.run("install");
    const text = fs.readFileSync(f.agent("luna"), "utf8");
    assert.ok(text.includes(`model: "${route}"\neffort: "medium"\n`));
    assert.ok(text.includes("gpt-6-luna via configured gateway"));
    f.write(f.overridePath, JSON.stringify({ profile: "codex" }));
    f.run("install");
    assert.ok(!exists(f.agent("luna")));
    assert.ok(exists(f.agent("opus")));
    assert.ok(!("luna" in f.stateJson().agents));
  });

  test("foreign agent file conflicts and is preserved", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.write(f.agent("haiku"), "mine\n");
    f.write(f.agent("custom"), "custom\n");
    assert.match(f.run("install", [], false).stderr, /foreign Claude agent/);
    assert.deepEqual(read(f.agent("haiku")), Buffer.from("mine\n"));
    assert.ok(!exists(f.launcher));
    fs.unlinkSync(f.agent("haiku"));
    f.run("install");
    assert.deepEqual(read(f.agent("custom")), Buffer.from("custom\n"));
    f.run("uninstall");
    assert.deepEqual(read(f.agent("custom")), Buffer.from("custom\n"));
  });

  test("edited owned agent conflicts", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const edited = cat(read(f.agent("opus")), "personal\n");
    fs.writeFileSync(f.agent("opus"), edited);
    for (const command of ["install", "status", "uninstall"]) assert.match(f.run(command, [], false).stderr, /edited/);
    const jsonStatus = f.run("status", ["--json"], false);
    assert.match(jsonStatus.stdout, /\"agents_error\"/);
    assert.deepEqual(read(f.agent("opus")), edited);
    assert.ok(exists(f.launcher));
  });

  test("uninstall removes owned agents", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    f.write(f.agent("custom"), "custom\n");
    f.run("uninstall");
    assert.deepEqual(fs.readdirSync(path.dirname(f.agent("x"))), ["custom.md"]);
  });

  test("policy hooks install, status and uninstall preserve foreign entries", () => {
    const f = new Fixture();
    f.installOrchestration();
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "personal-hook" }] };
    f.write(settingsPath, JSON.stringify({ model: "personal", hooks: { PreToolUse: [foreign], Stop: [{ hooks: [] }] }, env: { OTHER: "yes" } }));
    f.run("install");
    let settings = f.json(settingsPath);
    assert.deepEqual(Object.keys(settings), ["model", "hooks", "env", "autoCompactWindow"]);
    const entries = settings.hooks.PreToolUse;
    assert.deepEqual(entries[0], foreign);
    assert.deepEqual(entries.slice(1).map((entry) => entry.matcher),
      [".*"]);
    assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: f.hookCommand }] }]);
    assert.deepEqual(settings.hooks.PostToolUse, [{
      matcher: "Agent|Task", hooks: [{ type: "command", command: f.hookCommand }],
    }]);
    const stopEntry = settings.hooks.Stop.at(-1);
    assert.deepEqual(stopEntry, { hooks: [{ type: "command", command: f.hookCommand }] });
    for (const entry of entries.slice(1)) {
      assert.deepEqual(entry.hooks, [{ type: "command", command: f.hookCommand }]);
      fs.accessSync(f.hook, fs.constants.X_OK);
    }
    assert.deepEqual(f.stateJson().hooks, [
      ...entries.slice(1).map((entry) => ({ ...entry, key: `PreToolUse:${entry.matcher}` })),
      { ...settings.hooks.UserPromptSubmit[0], key: "UserPromptSubmit" },
      { ...settings.hooks.PostToolUse[0], key: "PostToolUse:Agent|Task" },
      { ...stopEntry, key: "Stop" },
    ]);
    assert.deepEqual(JSON.parse(f.run("status").stdout).hooks, {
      ".*": "applied", UserPromptSubmit: "applied",
      "PostToolUse:Agent|Task": "applied", Stop: "applied",
    });
    const postEntry = settings.hooks.PostToolUse[0];
    settings.hooks.PostToolUse = [];
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    assert.equal(JSON.parse(f.run("status").stdout).hooks["PostToolUse:Agent|Task"], "missing");
    f.run("install");
    assert.deepEqual(f.json(settingsPath).hooks.PostToolUse, [postEntry]);
    const before = f.snapshot();
    assert.match(f.run("install").stdout, /no-op/);
    assert.deepEqual(f.snapshot(), before);
    f.run("uninstall");
    settings = f.json(settingsPath);
    assert.deepEqual(settings.hooks, { PreToolUse: [foreign], UserPromptSubmit: [], PostToolUse: [], Stop: [{ hooks: [] }] });
    assert.equal(settings.model, "personal");
    assert.deepEqual(settings.env, { OTHER: "yes" });
  });

  test("older Claude hook ownership upgrades on reinstall", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const statePath = path.join(f.state, "state.json");
    const fresh = f.stateJson();
    const settings = f.json(settingsPath);
    const post = fresh.hooks.find((entry) => entry.key === "PostToolUse:Agent|Task");
    const older = fresh.hooks.filter((entry) => entry !== post && entry.key !== "UserPromptSubmit");
    const olderSettings = { ...settings.hooks };
    delete olderSettings.PostToolUse;
    delete olderSettings.UserPromptSubmit;
    const splitSettings = { ...settings.hooks };
    delete splitSettings.UserPromptSubmit;
    for (const split of [false, true]) {
      f.write(statePath, JSON.stringify({ ...fresh, hooks: older, ...(split ? { post_hooks: [post] } : {}) }));
      f.write(settingsPath, JSON.stringify({ ...settings, hooks: split ? splitSettings : olderSettings }));
      const status = JSON.parse(f.run("status").stdout).hooks;
      assert.equal(status[".*"], "applied");
      assert.equal(status.Stop, "applied");
      assert.equal(status["PostToolUse:Agent|Task"], split ? "applied" : undefined);
      f.run("install");
      const upgraded = f.stateJson();
      assert.deepEqual(upgraded.hooks, fresh.hooks);
      assert.ok(!Object.hasOwn(upgraded, "post_hooks"));
      assert.deepEqual(f.json(settingsPath).hooks, settings.hooks);
    }
  });

  test("policy hook runs through its shebang without the setup skill", () => {
    const f = new Fixture();
    f.installOrchestration();
    fs.rmSync(f.skill, { recursive: true });
    const result = spawnSync(f.hook, ["--workers", path.join(f.state, "workers.json")], {
      input: JSON.stringify({ tool_name: "Read", tool_input: {} }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  });

  test("policy hooks edited owned entry is kept and canonical reapplied", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const settings = f.json(settingsPath);
    const canonical = settings.hooks.PreToolUse[0];
    const edited = JSON.parse(JSON.stringify(canonical));
    edited.hooks[0].command = "edited-hook";
    settings.hooks.PreToolUse[0] = edited;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    assert.deepEqual(JSON.parse(f.run("status").stdout).hooks, {
      ".*": "missing", UserPromptSubmit: "applied",
      "PostToolUse:Agent|Task": "applied", Stop: "applied",
    });
    f.run("install");
    const reapplied = f.json(settingsPath).hooks.PreToolUse;
    assert.ok(reapplied.some((entry) => isDeepStrictEqual(entry, edited)));
    assert.ok(reapplied.some((entry) => isDeepStrictEqual(entry, canonical)));
    f.run("uninstall");
    assert.deepEqual(f.json(settingsPath).hooks.PreToolUse, [edited]);
  });

  test("policy hooks duplicated owned entry conflicts", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const settings = f.json(settingsPath);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      settings.hooks[event].push(settings.hooks[event][0]);
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      const data = read(settingsPath);
      assert.match(f.run("install", [], false).stderr, /duplicated/);
      assert.deepEqual(read(settingsPath), data);
      settings.hooks[event].pop();
    }
  });

  test("preexisting identical policy hook is not owned", () => {
    const f = new Fixture();
    f.installOrchestration();
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: f.hookCommand }] };
    f.write(settingsPath, JSON.stringify({ hooks: { PreToolUse: [foreign] } }));
    f.run("install");
    const saved = f.stateJson().hooks;
    assert.deepEqual(saved.map((entry) => entry.key), [
      "PreToolUse:.*", "UserPromptSubmit", "PostToolUse:Agent|Task", "Stop",
    ]);
    f.run("uninstall");
    const hooks = f.json(settingsPath).hooks;
    assert.deepEqual(hooks.PreToolUse, [foreign]);
    assert.deepEqual(hooks.Stop, []);
  });

  test("policy hooks removed when orchestration is removed", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    fs.rmSync(path.join(f.home, ".agents/skills/orchestrate-harnesses"), { recursive: true });
    f.run("install");
    assert.deepEqual(f.stateJson().hooks, []);
    assert.deepEqual(f.json(path.join(f.home, ".claude/settings.json")).hooks,
      { PreToolUse: [], UserPromptSubmit: [], PostToolUse: [], Stop: [] });
  });

  test("policy hooks invalid configuration conflicts without writes", () => {
    const f = new Fixture();
    f.installOrchestration();
    const settingsPath = path.join(f.home, ".claude/settings.json");
    const data = Buffer.from('{"hooks":{"PreToolUse":{}}}');
    f.write(settingsPath, data);
    assert.match(f.run("install", [], false).stderr, /invalid Claude hooks/);
    assert.deepEqual(read(settingsPath), data);
    assert.ok(!exists(path.join(f.state, "state.json")));
  });

  const codexHandler = (f) => ({ type: "command", command: f.codexHookCommand, timeout: 30 });
  const CODEX_MATCHERS = ["Agent|spawn_agent", "Bash", "mcp__t3_code__delegate_task", "mcp__t3_code__t3_thread_send", "mcp__t3_code__t3_thread_launch", "mcp__t3_code__t3_thread_configure", "mcp__t3_code__schedule_task", "mcp__t3_code__create_threads", "mcp__t3_code__watch_pull_request", "mcp__t3_code__preview_.*", "mcp__t3_code__t3_preview_.*", "mcp__t3_code_direct__(preview_|t3_preview_).*"];

  test("codex hooks install, status and uninstall preserve foreign entries", () => {
    const f = new Fixture();
    f.installOrchestration();
    const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "personal-hook" }] };
    f.write(f.codexHooksPath, JSON.stringify({ note: "keep", hooks: { PreToolUse: [foreign], SessionStart: [] } }));
    f.run("install");
    let file = f.json(f.codexHooksPath);
    assert.deepEqual(Object.keys(file), ["note", "hooks"]);
    assert.deepEqual(Object.keys(file.hooks), ["PreToolUse", "SessionStart", "Stop"]);
    assert.deepEqual(file.hooks.PreToolUse[0], foreign);
    assert.deepEqual(file.hooks.PreToolUse.slice(1).map((entry) => entry.matcher), CODEX_MATCHERS);
    for (const entry of file.hooks.PreToolUse.slice(1)) assert.deepEqual(entry.hooks, [codexHandler(f)]);
    assert.deepEqual(file.hooks.Stop, [{ hooks: [codexHandler(f)] }]);
    assert.deepEqual(f.stateJson().codex_hooks, [...file.hooks.PreToolUse.slice(1), file.hooks.Stop[0]]);
    assert.deepEqual(f.stateJson().hooks.length, 4);
    assert.deepEqual(JSON.parse(f.run("status").stdout).codex_hooks, {
      "Agent|spawn_agent": "applied", Bash: "applied",
      mcp__t3_code__delegate_task: "applied", mcp__t3_code__t3_thread_send: "applied",
      mcp__t3_code__t3_thread_launch: "applied", mcp__t3_code__t3_thread_configure: "applied",
      mcp__t3_code__schedule_task: "applied", mcp__t3_code__create_threads: "applied",
      mcp__t3_code__watch_pull_request: "applied",
      "mcp__t3_code__preview_.*": "applied", "mcp__t3_code__t3_preview_.*": "applied",
      "mcp__t3_code_direct__(preview_|t3_preview_).*": "applied", Stop: "applied",
    });
    const before = f.snapshot();
    assert.match(f.run("install").stdout, /no-op/);
    assert.deepEqual(f.snapshot(), before);
    f.run("uninstall");
    file = f.json(f.codexHooksPath);
    assert.deepEqual(file.hooks, { PreToolUse: [foreign], SessionStart: [], Stop: [] });
    assert.equal(file.note, "keep");
  });

  test("codex hooks are skipped without a codex directory or orchestration", () => {
    const f = new Fixture();
    f.installOrchestration();
    fs.rmdirSync(path.join(f.home, ".codex"));
    f.run("install");
    assert.ok(!exists(f.codexHooksPath));
    assert.deepEqual(f.stateJson().codex_hooks, []);
    const g = new Fixture();
    g.configureHome(path.join(g.temporary, "plain"));
    fs.mkdirSync(path.join(g.home, ".codex"), { recursive: true });
    g.run("install");
    assert.ok(!exists(g.codexHooksPath));
  });

  test("codex hooks edited owned entry is kept, duplicates conflict, identical foreign is unowned", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const file = f.json(f.codexHooksPath);
    const canonical = file.hooks.PreToolUse[0];
    const edited = JSON.parse(JSON.stringify(canonical));
    edited.hooks[0].command = "edited-hook";
    file.hooks.PreToolUse[0] = edited;
    fs.writeFileSync(f.codexHooksPath, JSON.stringify(file));
    assert.equal(JSON.parse(f.run("status").stdout).codex_hooks["Agent|spawn_agent"], "missing");
    f.run("install");
    const reapplied = f.json(f.codexHooksPath).hooks.PreToolUse;
    assert.ok(reapplied.some((entry) => isDeepStrictEqual(entry, edited)));
    assert.ok(reapplied.some((entry) => isDeepStrictEqual(entry, canonical)));
    f.run("uninstall");
    assert.deepEqual(f.json(f.codexHooksPath).hooks.PreToolUse, [edited]);

    const g = new Fixture();
    g.configureHome(path.join(g.temporary, "duplicate"));
    g.installOrchestration();
    g.run("install");
    const dup = g.json(g.codexHooksPath);
    dup.hooks.PreToolUse.push(dup.hooks.PreToolUse[0]);
    fs.writeFileSync(g.codexHooksPath, JSON.stringify(dup));
    const data = read(g.codexHooksPath);
    assert.match(g.run("install", [], false).stderr, /duplicated/);
    assert.deepEqual(read(g.codexHooksPath), data);

    const h = new Fixture();
    h.configureHome(path.join(h.temporary, "identical"));
    h.installOrchestration();
    const same = { matcher: "Bash", hooks: [codexHandler(h)] };
    h.write(h.codexHooksPath, JSON.stringify({ hooks: { PreToolUse: [same] } }));
    h.run("install");
    assert.deepEqual(h.stateJson().codex_hooks.filter((entry) => "matcher" in entry).map((entry) => entry.matcher),
      CODEX_MATCHERS.filter((matcher) => matcher !== "Bash"));
    h.run("uninstall");
    assert.deepEqual(h.json(h.codexHooksPath).hooks.PreToolUse, [same]);
  });

  test("codex hooks removed when orchestration is removed; invalid file conflicts", () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    fs.rmSync(path.join(f.home, ".agents/skills/orchestrate-harnesses"), { recursive: true });
    f.run("install");
    assert.deepEqual(f.stateJson().codex_hooks, []);
    assert.deepEqual(f.json(f.codexHooksPath).hooks.PreToolUse, []);
    for (const [index, data] of ['{"hooks":{"PreToolUse":{}}}', "{broken", '{"hooks":null}'].entries()) {
      const g = new Fixture();
      g.configureHome(path.join(g.temporary, `invalid-${index}`));
      g.installOrchestration();
      g.write(g.codexHooksPath, data);
      assert.match(g.run("install", [], false).stderr, /invalid Codex hooks/);
      assert.deepEqual(read(g.codexHooksPath), Buffer.from(data));
      assert.ok(!exists(path.join(g.state, "state.json")));
    }
  });

  test("codex hook hash matches Codex 0.170.0 fingerprints", () => {
    // Declaration hashes from codex-rs core/tests/suite/hooks.rs (plugin hooks, timeout defaulting to 600).
    const command = "python3 -I -S ${PLUGIN_ROOT}/hooks/pre_tool_use_hook.py";
    assert.equal(codexHookHash("PreToolUse", "^Bash$", { type: "command", command }),
      "sha256:c9ee1aca1b5d8c72b99df6571c87d61350b09f7f4594ae30e7250a2027e9d76b");
    assert.equal(codexHookHash("PostToolUse", "^Bash$", { type: "command", command }),
      "sha256:9eef43ad6f26b1f9b94f318a50445f8bb62c363da08152a2966b73d308bf42ba");
    assert.equal(codexHookKey("/h/.codex/hooks.json", "PreToolUse", 2), "/h/.codex/hooks.json:pre_tool_use:2:0");
    assert.equal(codexHookKey("/h/.codex/hooks.json", "Stop", 0), "/h/.codex/hooks.json:stop:0:0");
    // Stop ignores the matcher, so the hash does not depend on it.
    assert.equal(codexHookHash("Stop", "x", { command: "c", timeout: 30 }), codexHookHash("Stop", null, { command: "c", timeout: 30 }));
  });

  const quiet = (action) => {
    const log = console.log;
    const lines = [];
    console.log = (...items) => lines.push(items.join(" "));
    try {
      action();
    } finally {
      console.log = log;
    }
    return lines;
  };

  test("codex trust is written with consent, tracked and removed on uninstall", () => {
    const f = new Fixture();
    f.installOrchestration();
    const config = path.join(f.home, ".codex/config.toml");
    const original = Buffer.from('model = "x"\n[projects."/tmp"]\ntrust_level = "trusted"');
    f.write(config, original);
    const setup = new Setup(f.home);
    setup.confirmCodexTrust = () => true;
    quiet(() => setup.install());
    const hooks = f.json(f.codexHooksPath).hooks;
    const handler = hooks.PreToolUse[1].hooks[0];
    const key = `${f.codexHooksPath}:pre_tool_use:1:0`;
    assert.ok(!read(config).toString("utf8").includes("hooks.state"));
    assert.equal(f.stateJson().codex_trust.length, 0);
    const trustSetup = new Setup(f.home);
    trustSetup.confirmCodexTrust = () => true;
    quiet(() => trustSetup.trust());
    const toml = read(config).toString("utf8");
    assert.ok(toml.includes(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = "${codexHookHash("PreToolUse", "Bash", handler)}"\n`));
    assert.ok(toml.includes(`${f.codexHooksPath}:stop:0:0`));
    assert.equal(f.stateJson().codex_trust.length, CODEX_MATCHERS.length + 1);
    assert.deepEqual(JSON.parse(f.run("status").stdout).codex_trust, {
      "Agent|spawn_agent": "trusted", Bash: "trusted",
      mcp__t3_code__delegate_task: "trusted", mcp__t3_code__t3_thread_send: "trusted",
      mcp__t3_code__t3_thread_launch: "trusted", mcp__t3_code__t3_thread_configure: "trusted",
      mcp__t3_code__schedule_task: "trusted", mcp__t3_code__create_threads: "trusted",
      mcp__t3_code__watch_pull_request: "trusted",
      "mcp__t3_code__preview_.*": "trusted", "mcp__t3_code__t3_preview_.*": "trusted",
      "mcp__t3_code_direct__(preview_|t3_preview_).*": "trusted", Stop: "trusted",
    });
    // A second install neither prompts nor changes anything.
    const before = f.snapshot();
    const second = new Setup(f.home);
    second.confirmCodexTrust = () => assert.fail("must not prompt");
    quiet(() => second.trust());
    assert.deepEqual(f.snapshot(), before);
    f.run("uninstall");
    assert.deepEqual(read(config), original);
  });

  const hasScript = spawnSync("script", ["--version"]).status === 0;
  test("codex trust prompt reads the answer from a real terminal", { skip: !hasScript && "util-linux script not available" }, () => {
    const f = new Fixture();
    f.installOrchestration();
    f.run("install");
    const command = [process.execPath, f.script, "--home", f.home, "trust"].map(shellQuote).join(" ");
    const result = spawnSync("script", ["-qec", command, "/dev/null"],
      { input: "y\n", encoding: "utf8", env: { ...process.env, XDG_CONFIG_HOME: "" } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Trust agent-workbench's Codex hooks now\? \[y\/N\]/);
    assert.equal(f.stateJson().codex_trust.length, CODEX_MATCHERS.length + 1);
    assert.equal(JSON.parse(f.run("status").stdout).codex_trust.Bash, "trusted");
  });

  test("install leaves Codex hooks untrusted until trust is run", () => {
    const f = new Fixture();
    f.installOrchestration();
    const installed = f.run("install");
    assert.match(installed.stdout, /Run \/hooks in Codex once to trust agent-workbench's hooks: /);
    assert.deepEqual(f.stateJson().codex_trust, []);
    const result = f.run("trust");
    assert.match(result.stdout, /Run \/hooks in Codex once to trust agent-workbench's hooks\./);
    assert.deepEqual(f.stateJson().codex_trust, []);
  });

  test("codex trust is skipped without a terminal and reported untrusted", () => {
    const f = new Fixture();
    f.installOrchestration();
    const result = f.run("install");
    assert.match(result.stdout, /Run \/hooks in Codex once to trust agent-workbench's hooks: /);
    assert.ok(!exists(path.join(f.home, ".codex/config.toml")) || !read(path.join(f.home, ".codex/config.toml")).includes("hooks.state"));
    assert.deepEqual(f.stateJson().codex_trust, []);
    assert.equal(JSON.parse(f.run("status").stdout).codex_trust.Bash, "untrusted");
  });

  test("codex trust leaves foreign and edited tables alone", () => {
    const f = new Fixture();
    f.installOrchestration();
    const config = path.join(f.home, ".codex/config.toml");
    const foreignKey = `${f.codexHooksPath}:pre_tool_use:0:0`;
    f.write(config, `[hooks.state.${JSON.stringify(foreignKey)}]\ntrusted_hash = "sha256:foreign"\n`);
    const setup = new Setup(f.home);
    quiet(() => setup.install());
    const trustSetup = new Setup(f.home);
    trustSetup.confirmCodexTrust = () => true;
    const lines = quiet(() => trustSetup.trust());
    assert.ok(lines.some((line) => line.includes("foreign") && line.includes(foreignKey)));
    assert.equal(JSON.parse(f.run("status").stdout).codex_trust["Agent|spawn_agent"], "modified");
    assert.equal(f.stateJson().codex_trust.length, CODEX_MATCHERS.length);
    // Edit one owned table: uninstall keeps it and removes the rest.
    const edited = read(config).toString("utf8").replace(/(pre_tool_use:1:0"\]\ntrusted_hash = ")sha256:[0-9a-f]+/, "$1sha256:edited");
    fs.writeFileSync(config, edited);
    f.run("uninstall");
    const left = read(config).toString("utf8");
    assert.ok(left.includes("sha256:foreign"));
    assert.ok(left.includes("sha256:edited"));
    assert.ok(!left.includes("stop:0:0"));
  });

  test("null settings sections are reported as invalid configuration", () => {
    const cases = [
      ['{"hooks": null}', /invalid Claude hooks/],
      ['{"hooks": {"PreToolUse": null}}', /invalid Claude hooks/],
      ['{"hooks": {"Stop": null}}', /invalid Claude hooks/],
      ['{"env": null}', /invalid claude configuration/],
    ];
    cases.forEach(([data, message], index) => {
      const f = new Fixture();
      f.configureHome(path.join(f.temporary, `null-${index}`));
      f.installOrchestration();
      const file = path.join(f.home, ".claude/settings.json");
      f.write(file, data);
      assert.match(f.run("install", [], false).stderr, message);
      assert.deepEqual(read(file), Buffer.from(data));
      assert.ok(!exists(path.join(f.state, "state.json")));
    });
  });

  test("native apply, rewrite, conflict and uninstall", () => {
    const f = new Fixture();
    f.installOrchestration({ policy: { context: { codex_window: 900000, gateway_window: 400000, manager_window: 200000 } } });
    const claude = path.join(f.home, ".claude/settings.json");
    const codex = path.join(f.home, ".codex/config.toml");
    const original = Buffer.from('model = "magpie" # routing\nmodel_reasoning_effort = "high"\n\n[model_providers.magpie]\nname = "route"\n[projects."/tmp"]\ntrust_level = "trusted"\n');
    f.write(claude, '{"model":"magpie", "modelPicker":true, "env":{"OTHER":"x"}, "modelSettings":{"claude-opus-5-5":{"effortLevel":"high"}, "sonnet":{"effortLevel":"low"}}}');
    f.write(codex, original);
    f.run("install");
    let settings = f.json(claude);
    assert.deepEqual(settings.env, { OTHER: "x", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" });
    assert.equal(settings.autoCompactWindow, 300000);
    assert.deepEqual(settings.modelSettings, {
      "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 200000 }, sonnet: { effortLevel: "low" },
    });
    assert.equal(settings.model, "magpie");
    const expected = sub(original, "[model_providers.magpie]",
      "model_auto_compact_token_limit = 300000\nmodel_context_window = 900000\n[model_providers.magpie]");
    assert.deepEqual(read(codex), expected);
    const before = f.snapshot();
    assert.match(f.run("install").stdout, /no-op/);
    assert.deepEqual(f.snapshot(), before);
    delete settings.modelSettings["claude-opus-5-5"].autoCompactWindow;
    fs.writeFileSync(claude, JSON.stringify(settings));
    fs.writeFileSync(codex, original);
    let status = JSON.parse(f.run("status").stdout).native_settings;
    assert.equal(status.claude["modelSettings.claude-opus-5-5.autoCompactWindow"], "missing");
    f.run("install");
    assert.deepEqual(read(codex), expected);
    settings = f.json(claude);
    settings.modelSettings["claude-opus-5-5"].autoCompactWindow = 420000;
    fs.writeFileSync(claude, JSON.stringify(settings));
    status = JSON.parse(f.run("status").stdout).native_settings;
    assert.equal(status.claude["modelSettings.claude-opus-5-5.autoCompactWindow"], "conflict");
    assert.match(f.run("install", [], false).stderr, /edited/);
    f.run("uninstall");
    settings = f.json(claude);
    assert.ok(!("autoCompactWindow" in settings));
    assert.deepEqual(settings.env, { OTHER: "x" });
    assert.deepEqual(settings.modelSettings, {
      "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 420000 }, sonnet: { effortLevel: "low" },
    });
    assert.deepEqual(read(codex), original);
  });

  test("native preexisting values and invalid files", () => {
    const cases = [
      ["claude", '{"autoCompactWindow":300000}', true],
      ["claude", '{"autoCompactWindow":310000}', false],
      ["claude", '{"modelSettings":{"claude-opus-5-5":{"autoCompactWindow":200000}}}', true],
      ["claude", '{"modelSettings":{"claude-opus-5-5":{"autoCompactWindow":310000}}}', false],
      ["claude", '{"modelSettings":{"claude-opus-5-5":null}}', false],
      ["claude", '{"modelSettings":[]}', false],
      ["claude", "{invalid", false],
      ["codex", "model_auto_compact_token_limit = 300000\n", true],
      ["codex", "model_auto_compact_token_limit = 1\n", false],
      ["codex", "[broken", false],
    ];
    cases.forEach(([kind, data, succeeds], index) => {
      const f = new Fixture();
      f.configureHome(path.join(f.temporary, `native-${index}`));
      f.installOrchestration({ policy: { context: { manager_window: 200000 } } });
      const file = path.join(f.home, kind === "claude" ? ".claude/settings.json" : ".codex/config.toml");
      f.write(file, data);
      f.run("install", [], succeeds);
      if (succeeds) {
        f.run("uninstall");
        if (kind === "claude") {
          const original = JSON.parse(data);
          const current = f.json(file);
          assert.equal(current.autoCompactWindow, original.autoCompactWindow);
          assert.equal(current.modelSettings["claude-opus-5-5"].autoCompactWindow,
            original.modelSettings?.["claude-opus-5-5"].autoCompactWindow);
        } else assert.ok(!read(file).includes("model_auto_compact_token_limit"));
      } else {
        assert.deepEqual(read(file), Buffer.from(data));
      }
    });
  });

  test("install migrates only the owned legacy compaction environment variable", () => {
    const f = new Fixture();
    f.installOrchestration();
    const claude = path.join(f.home, ".claude/settings.json");
    const statePath = path.join(f.state, "state.json");
    const key = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
    f.run("install");
    const settings = f.json(claude);
    const state = f.stateJson();
    delete settings.autoCompactWindow;
    delete settings.modelSettings;
    settings.env = { OTHER: "x", [key]: "310000" };
    state.native.claude = { [key]: "300000" };
    f.write(claude, JSON.stringify(settings));
    f.write(statePath, JSON.stringify(state));
    assert.match(f.run("install", [], false).stderr, /edited .*CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
    assert.deepEqual(f.json(claude), settings);
    settings.env[key] = "300000";
    f.write(claude, JSON.stringify(settings));
    f.run("install");
    assert.deepEqual(f.json(claude).env, { OTHER: "x" });
    assert.equal(f.json(claude).autoCompactWindow, 300000);
    assert.ok(!(key in f.stateJson().native.claude));
    f.run("uninstall");
    f.write(claude, JSON.stringify({ env: { [key]: "310000" } }));
    f.run("install");
    f.run("uninstall");
    assert.deepEqual(f.json(claude).env, { [key]: "310000" });
  });

  test("install and status warn about Worker tiers sharing a Manager model", () => {
    const f = new Fixture();
    const manager_models = ["claude-opus-5-5", "gateway/gpt-6.2-sol"];
    f.installOrchestration({
      policy: { context: { manager_window: 110000, manager_models } },
      profiles: { codex: { tiers: { sol: { claude_route: "gateway/gpt-6.2-sol" } } } },
    });
    const claude = path.join(f.home, ".claude/settings.json");
    for (const command of ["install", "status"]) {
      const warnings = f.run(command).stderr;
      assert.equal(warnings.match(/opus tier.*shares the Manager's 110000-token/g)?.length, 1);
      assert.equal(warnings.match(/sol tier.*shares the Manager's 110000-token/g)?.length, 1);
    }
    for (const model of manager_models) assert.equal(f.json(claude).modelSettings[model].autoCompactWindow, 110000);
    f.installOrchestration({ policy: { context: { manager_window: null } } });
    for (const command of ["install", "status"]) assert.doesNotMatch(f.run(command).stderr, /shares the Manager/);
    for (const model of manager_models) assert.ok(!("autoCompactWindow" in f.json(claude).modelSettings[model]));
    assert.equal(f.json(claude).autoCompactWindow, 300000);
  });

  test("native missing directory and override validation", () => {
    const f = new Fixture();
    f.installOrchestration({ policy: { context: { max_tokens: 500000, gateway_window: null } } });
    fs.rmdirSync(path.join(f.home, ".codex"));
    f.run("install");
    assert.equal(f.json(path.join(f.home, ".claude/settings.json")).autoCompactWindow, 500000);
    assert.ok(!("codex" in f.stateJson().native));
  });

  test("profiles merge, delete, select and workers command", () => {
    const f = new Fixture();
    f.installOrchestration();
    const work = path.join(f.home, "work");
    fs.mkdirSync(work);
    const alias = path.join(f.home, "alias");
    fs.symlinkSync(work, alias, "dir");
    f.write(f.overridePath, `defaults: {timeout_s: 900}
profiles:
  corporate:
    tiers:
      glm: {harness: claude, model: glm, effort: high}
      sonnet: null
    policy: {context: {max_tokens: 12345}}
    ladder:
      - {level: junior, tiers: [haiku]}
      - {level: senior, tiers: [opus]}
      - {level: expert, tiers: [glm], approval: required}
profile: codex
select:
  - {path: ~/work, profile: corporate}
  - {path: "~", profile: codex}
`);
    const resolved = JSON.parse(f.run("workers", ["--cwd", path.join(alias, "nested")]).stdout);
    assert.equal(resolved.profile, "corporate");
    assert.ok(!("sonnet" in resolved.tiers));
    assert.equal(resolved.tiers.glm.effort, "high");
    assert.equal(resolved.tiers.glm.timeout_s, 900);
    assert.equal(resolved.policy.context.gateway_window, null);
    assert.deepEqual(resolved.ladder.map((entry) => entry.level), ["junior", "senior", "expert"]);
    const fallback = JSON.parse(f.run("workers", ["--cwd", path.dirname(f.home)]).stdout);
    assert.equal(fallback.profile, "codex");
    assert.deepEqual(Object.keys(fallback.tiers).sort(), ["haiku", "luna", "opus", "sol", "sonnet", "terra"]);
    f.run("install");
    assert.ok(exists(f.agent("glm")));
    assert.ok(!exists(f.agent("terra")));
    assert.ok(!exists(f.agent("luna")));
    const bundle = f.json(path.join(f.state, "workers.json"));
    assert.equal(bundle.profile, "codex");
    assert.equal(bundle.select[0].path, fs.realpathSync(work));
    assert.equal(bundle.profiles.corporate.policy.context.max_tokens, 12345);
    assert.equal(f.json(path.join(f.home, ".claude/settings.json")).autoCompactWindow, 300000);
    f.run("uninstall");
    assert.ok(!exists(path.join(f.state, "workers.json")));
    assert.ok(!exists(f.agent("glm")));
  });

  test("absolute XDG override and relative fallback", () => {
    const f = new Fixture();
    f.installOrchestration();
    const xdg = path.join(f.home, "xdg");
    const environment = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const restore = () => Object.entries(environment).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      assert.equal(new Setup(f.home).override, f.overridePath);
      process.env.HOME = f.home;
      const setup = new Setup(f.home);
      assert.equal(setup.override, path.join(xdg, "agent-workbench/workers.yml"));
      f.write(setup.override, "profile: codex");
      assert.equal(effectiveWorkers(setup.workersBundle(), f.home).profile, "codex");
      process.env.HOME = environment.HOME;
      for (const value of ["", "relative"]) {
        process.env.XDG_CONFIG_HOME = value;
        assert.equal(new Setup(f.home).override, f.overridePath);
      }
    } finally {
      restore();
    }
  });

  test("cross-profile tier identity conflict without writes", () => {
    const f = new Fixture();
    f.installOrchestration({ profiles: { other: { tiers: { haiku: { effort: "high" } } } } });
    const before = f.snapshot();
    const result = f.run("install", [], false);
    assert.match(result.stderr, /haiku/);
    assert.match(result.stderr, /rename/);
    assert.deepEqual(f.snapshot(), before);
  });

  test("invalid workers refuse without writes", () => {
    const invalid = [
      "version: 1", "roles: {}", "sol_weekly_brake_percent: 100", "tiers: []",
      "defaults: {timeout_s: false}", "policy: {context: {oops: 1}}",
      "policy: {context: {manager_window: 100000.0}}", "policy: {context: {manager_window: -1}}",
      "policy: {context: {worker_window: 99999}}", "policy: {context: {worker_window: -1}}",
      "policy: {context: {worker_window: 1.5}}", 'policy: {context: {worker_window: "100000"}}',
      "policy: {context: {manager_models: opus}}", "policy: {context: {manager_models: [opus, 5]}}",
      "select: [{path: ~/work, profile: missing}]", "select: {}", "profile: missing",
      "profiles: {unused: {tiers: {luna: {effort: false}}}}",
      "profiles: {unused: {roles: {}}}", "tiers: {luna: {cli: codex}}",
      "ladder: [{level: L1, tiers: [terra]}]", "ladder: []", "[broken",
      "defaults: {timeout_s: 7200.0}", "version: 2.0", "policy: {max_auto_rework: 1.0}",
      'policy: {stop_classifier: {url: "ftp://localhost", model: x}}',
      'policy: {stop_classifier: {url: "http://localhost", model: ""}}',
      'policy: {stop_classifier: {url: "http://localhost", model: x, token: secret}}',
      "tiers: {no: null}", "tiers: {on: {harness: claude, model: x}}", "tiers: {null: null}",
      "profiles: {1: {tiers: {}}}", "profiles: null", "select: null",
    ];
    for (const text of invalid) {
      const f = new Fixture();
      f.installOrchestration();
      f.write(f.overridePath, text);
      const before = f.snapshot();
      f.run("install", [], false);
      assert.deepEqual(f.snapshot(), before, text);
    }
  });

  test("resolved workers hash ownership", () => {
    const f = new Fixture();
    f.installOrchestration();
    const file = path.join(f.state, "workers.json");
    f.write(file, "personal");
    assert.match(f.run("install", [], false).stderr, /foreign or edited/);
    fs.unlinkSync(file);
    f.run("install");
    const original = read(file);
    fs.writeFileSync(file, "edited");
    for (const command of ["install", "status", "uninstall"]) assert.match(f.run(command, [], false).stderr, /foreign or edited/);
    fs.writeFileSync(file, original);
    f.run("uninstall");
    assert.ok(!exists(file));
  });

  test("missing resource and duplicate import status", () => {
    const f = new Fixture();
    f.run("install");
    const template = path.join(f.skill, "assets/AGENTS.md");
    fs.unlinkSync(template);
    assert.match(f.run("status", [], false).stderr, /missing canonical/);
    f.write(template, "public\n");
    fs.writeFileSync(f.claude, cat(read(f.claude), IMPORT, NL));
    assert.match(f.run("status", [], false).stderr, /duplicate/);
  });
});
