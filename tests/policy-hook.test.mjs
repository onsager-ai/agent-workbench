import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { workerBundle } from "../skills/workbench-setup/scripts/workbench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "skills/orchestrate-harnesses/scripts/policy-hook");
const WORKERS = path.join(ROOT, "skills/orchestrate-harnesses/workers.yml");
const NEUTRAL_OVERRIDE = path.join(ROOT, "tests/fixtures/neutral-workers.yml");
const temporaries = [];

const tmp = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-hook-")));
  temporaries.push(directory);
  return directory;
};
after(() => temporaries.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

describe("policy hook", () => {
  let workers;
  let bundle;
  let directory;

  beforeEach(() => {
    directory = tmp();
    workers = path.join(directory, "workers.json");
    bundle = workerBundle(WORKERS);
    fs.writeFileSync(workers, JSON.stringify(bundle));
  });

  function run(payload, { env, args = ["--workers", workers] } = {}) {
    const result = spawnSync(process.execPath, [HOOK, ...args], { input: payload, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result;
  }

  const invoke = (payload, env) => {
    let event;
    try { event = JSON.parse(payload); } catch {}
    if (event && typeof event === "object" && !Array.isArray(event)) {
      if ([undefined, "PreToolUse"].includes(event.hook_event_name) && !event.session_id) {
        event.session_id = "legacy-test-session";
        event.agent_id = "legacy-test-worker";
      }
      payload = JSON.stringify(event);
    }
    const stateHome = env?.AGENT_WORKBENCH_STATE_HOME ?? path.join(directory, "state");
    const hookEnv = { ...(env ?? process.env), AGENT_WORKBENCH_STATE_HOME: stateHome };
    const result = run(payload, { env: hookEnv });
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
  };

  const invokeStop = (event) => {
    const result = run(JSON.stringify(event), { args: [] });
    return result.stdout ? JSON.parse(result.stdout) : null;
  };

  const invokeStopAsync = (event) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, "--workers", workers]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) reject(new Error(stderr || `hook exited ${status}`));
      else resolve(stdout ? JSON.parse(stdout) : null);
    });
    child.stdin.end(JSON.stringify(event));
  });

  function t3Env(thread = "mcp:launch:5f9a6b10-be25-429c-abb6-1ebd74859825") {
    const home = path.join(directory, "t3");
    fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
    fs.writeFileSync(path.join(home, "userdata/environment-id"), "env-1\n");
    return { PATH: process.env.PATH ?? "", T3CODE_HOME: home, T3CODE_THREAD_ID: thread };
  }

  const send = (message, env) => invoke(JSON.stringify({
    hook_event_name: "PreToolUse", tool_name: "mcp__t3-code__t3_thread_send",
    tool_input: { threadId: "peer", mode: "auto", message },
  }), env);

  test("thread send footer is stamped from T3 identity", () => {
    const env = t3Env();
    const thread = env.T3CODE_THREAD_ID;
    const first = send("Done.\n\n-- WB_MSG from=x/duhem-pm kind=result id=duhempm:1 re=89effeb3:2", env);
    assert.equal("permissionDecision" in first, false);
    const sent = (message) => message.match(/ sent=(\d{4}-\d\d-\d\dT\d\d:\d\dZ) /)?.[1];
    const firstSent = sent(first.updatedInput.message);
    assert.ok(Math.abs(Date.parse(firstSent) - Date.now()) < 120000);
    assert.deepEqual(first.updatedInput, {
      threadId: "peer", mode: "auto",
      message: `Done.\n\n-- WB_MSG from=env-1/${thread} kind=result sent=${firstSent} id=74859825:1 re=89effeb3:2`,
    });
    const second = send("Decided.\n\n-- WB_MSG kind=decision sent=2000-01-01T00:00Z", env);
    assert.equal(second.updatedInput.message,
      `Decided.\n\n-- WB_MSG from=env-1/${thread} kind=decision sent=${sent(second.updatedInput.message)} id=74859825:2 re=none`);
    assert.notEqual(sent(second.updatedInput.message), "2000-01-01T00:00Z");
  });

  test("thread send without footer or identity is unchanged", () => {
    const env = t3Env();
    assert.equal(send("Plain task text.", env), null);
    delete env.T3CODE_THREAD_ID;
    assert.equal(send("Hi.\n\n-- WB_MSG from=a/b kind=request id=x:1 re=none", env), null);
  });

  test("thread send fails open without stamping while another process holds the counter lock", () => {
    const env = t3Env();
    const counter = path.join(directory, "wbmsg", env.T3CODE_THREAD_ID.replaceAll("/", "_") + ".seq");
    fs.mkdirSync(path.dirname(counter), { recursive: true });
    fs.mkdirSync(counter + ".lock");
    fs.writeFileSync(path.join(counter + ".lock", "pid"), String(process.pid));
    assert.equal(send("Hi.\n\n-- WB_MSG from=a/b kind=request id=x:1 re=none", env), null);
    // The other holder's lock is left alone and no sequence number was consumed.
    assert.equal(fs.readFileSync(path.join(counter + ".lock", "pid"), "utf8"), String(process.pid));
    assert.equal(fs.existsSync(counter), false);
  });

  test("thread send reclaims a counter lock left by a dead process", () => {
    const env = t3Env();
    const counter = path.join(directory, "wbmsg", env.T3CODE_THREAD_ID.replaceAll("/", "_") + ".seq");
    const dead = spawnSync(process.execPath, ["-e", ""]);
    fs.mkdirSync(path.dirname(counter), { recursive: true });
    fs.mkdirSync(counter + ".lock");
    fs.writeFileSync(path.join(counter + ".lock", "pid"), String(dead.pid));
    const result = send("Hi.\n\n-- WB_MSG kind=request", env);
    assert.match(result.updatedInput.message, /id=74859825:1 /);
    assert.deepEqual(fs.readdirSync(path.dirname(counter)).sort(), [path.basename(counter)]);
  });

  test("PostToolUse reports requested-model overrides and transcript mismatches", () => {
    const transcript = path.join(directory, "manager.jsonl");
    const subagents = path.join(directory, "manager", "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    const workerTranscript = path.join(subagents, "agent-worker-1.jsonl");
    const invokePost = (agentType, resolvedModel, models = [resolvedModel], env) => {
      fs.writeFileSync(workerTranscript, models.map((model) => JSON.stringify({
        type: "assistant", message: { model },
      })).join("\n") + "\n");
      return invoke(JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Agent", transcript_path: transcript, cwd: directory,
        tool_response: { status: "completed", agentId: "worker-1", agentType, resolvedModel },
      }), env);
    };
    assert.equal(invokePost("haiku", "claude-haiku-5-5", ["group/auto-claude-haiku-5-5"]), null);
    assert.match(invokePost("haiku", "claude-sonnet-5-5").additionalContext, /expected claude-haiku-5-5/);
    bundle.profiles.codex.tiers.luna.claude_route = "onsager/codex/gpt-6-luna";
    bundle.select = [{ path: directory, profile: "codex" }];
    fs.writeFileSync(workers, JSON.stringify(bundle));
    assert.equal(invokePost("luna", "onsager/codex/gpt-6-luna", ["codex/gpt-6-luna"]), null);
    assert.match(invokePost("luna", "codex/gpt-6-luna", ["onsager/codex/gpt-6-luna"]).additionalContext,
      /expected onsager\/codex\/gpt-6-luna/);
    assert.match(invokePost("luna", "onsager/codex/gpt-6-luna", ["group/auto-claude-sonnet-5-5"]).additionalContext,
      /claude-sonnet-5-5/);
    assert.equal(invokePost("unknown", "model"), null);
    bundle = workerBundle(WORKERS, [NEUTRAL_OVERRIDE]);
    bundle.profile = null;
    bundle.select = [{ path: directory, profile: "neutral" }];
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const route = "gateway/general";
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: route };
    assert.equal(invokePost("standard", route, ["general"], env), null);
    assert.match(invokePost("standard", route, ["other"], env).additionalContext,
      /expected gateway\/general but ran on gateway\/general, other/);
    assert.equal(invokePost("standard", route, [route], {}).additionalContext,
      "The standard Worker reported model(s) gateway/general.");
    fs.rmSync(workerTranscript);
    assert.equal(invoke(JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Agent", transcript_path: transcript,
      tool_response: { status: "completed", agentId: "worker-1", agentType: "haiku", resolvedModel: "claude-haiku-5-5" },
    })), null);
    assert.equal(invoke(JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Task", transcript_path: transcript,
      tool_response: { status: "running", agentId: "worker-1", agentType: "haiku" },
    })), null);
  });

  test("PostToolUse checks the requested route at async launch without a transcript", () => {
    const route = "gateway/general";
    bundle = workerBundle(WORKERS, [NEUTRAL_OVERRIDE]);
    bundle.profile = null;
    bundle.select = [{ path: directory, profile: "neutral" }];
    bundle.profiles.neutral.tiers.fast.model = "gateway/small";
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const launch = (subagentType, resolvedModel, env = {}) => invoke(JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Agent", cwd: directory,
      tool_input: { subagent_type: subagentType },
      tool_response: { status: "async_launched", agentId: "worker-1", resolvedModel },
    }), env);
    const env = { ANTHROPIC_DEFAULT_SONNET_MODEL: route };
    assert.equal(launch("standard", route, env), null);
    assert.equal(launch("standard", route).additionalContext, "The standard Worker launched with resolved model gateway/general.");
    assert.match(launch("standard", "other/general", env).additionalContext, /expected gateway\/general but launched with resolved model other\/general/);
    assert.equal(launch("fast", "gateway/small"), null);
    assert.match(launch("fast", "other/small").additionalContext, /expected gateway\/small but launched with resolved model other\/small/);
    assert.equal(launch("standard", undefined, env), null);
    assert.equal(launch("unknown", route), null);
  });

  test("Manager turn state gates main-loop work, counts calls, and honors approval", () => {
    const session = "manager-session";
    const stateHome = path.join(directory, "state");
    const env = { AGENT_WORKBENCH_STATE_HOME: stateHome };
    const prompt = (text) => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: session, prompt: text,
    }), env);
    const call = (tool_name, tool_input = {}, extras = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: session, tool_name, tool_input, ...extras,
    }), env);
    const statePath = path.join(stateHome, "agent-workbench", "manager-turns", `${session}.json`);

    prompt("Decide and delegate.");
    assert.equal(call("Read", { file_path: "/tmp/file" }), null);
    const blocked = call("Edit", { file_path: "/tmp/file" });
    assert.equal(blocked.permissionDecision, "deny");
    assert.match(blocked.permissionDecisionReason, /L1\/L2 Worker \(luna first, then sol\)/);
    assert.match(blocked.permissionDecisionReason, /Manager work approval/);
    assert.ok(blocked.permissionDecisionReason.includes(statePath));
    assert.equal(call("Edit", { file_path: path.join(os.homedir(), ".claude/projects/p/memory/MEMORY.md") }), null);
    assert.equal(call("Bash", { command: "git status" }), null);
    for (const command of ["git add file", "echo hi > output", "echo hi >> output", "tee output",
      "sed -i s/a/b/ file", "rm file", "mv a b", "cp a b", "mkdir dir", "touch file",
      "chmod 600 file", "git stash", "npm install", "pnpm publish", "yarn install", "pip install x",
      "ssh host 'touch file'"]) {
      prompt("Fresh command check.");
      assert.equal(call("Bash", { command }).permissionDecision, "deny", command);
    }
    for (const command of ["echo hi 2>/dev/null", "echo hi >/dev/null", "echo hi >&2", "npm view x", "git status"]) {
      prompt("Fresh read-only check.");
      assert.equal(call("Bash", { command }), null, command);
    }

    prompt("A fresh turn.");
    for (let i = 0; i < 5; i++) assert.equal(call("Read"), null);
    const sixth = call("Read");
    assert.equal(sixth.permissionDecision, "deny");
    prompt("Another turn.");
    for (const tool of ["Agent", "Task"]) {
      assert.equal(call(tool, { subagent_type: "luna", prompt: "Inspect the issue." }), null, tool);
    }
    assert.equal(call("spawn_agent", { agent_type: "luna", message: "Inspect the issue." }), null);
    for (const tool of ["t3_thread_send", "t3_queue", "send_to_user", "t3_pending_request",
      "t3_background_wait", "AskUserQuestion", "ToolSearch", "pull_request_merge",
      "pull_request_review", "pull_request_respond", "link_pull_request", "link_pull_requests",
      "watch_pull_request", "unwatch_pull_request", "pull_request_create"]) {
      assert.equal(call(tool), null, tool);
    }
    for (let i = 0; i < 5; i++) assert.equal(call("Read"), null);
    assert.equal(call("mcp__t3-code__t3_thread_configure"), null);
    const afterConfigure = call("Read");
    assert.equal(afterConfigure.permissionDecision, "deny");
    assert.match(afterConfigure.permissionDecisionReason, /sixth counted work call \(Read\)/);
    prompt("Manager work approval: https://example.test/chief-pm-message");
    for (let i = 0; i < 7; i++) assert.equal(call("Read"), null);
  });

  test("Manager Bash denials keep the full gate reason", () => {
    const session_id = "manager-bash";
    const statePath = path.join(directory, "state", "agent-workbench", "manager-turns", `${session_id}.json`);
    const call = (tool_name, tool_input = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input,
    }));
    const guidance = "Send this step to an L1/L2 Worker (luna first, then sol). " +
      "A turn whose first message has `Manager work approval: <link to a Chief PM or owner message>` " +
      `passes the gate. State file: ${statePath}.`;

    for (const command of ["touch file", "gh run view 123 --log-failed > failed.log"]) {
      const blocked = call("Bash", { command });
      assert.equal(blocked.permissionDecision, "deny", command);
      assert.equal(blocked.permissionDecisionReason, `A Bash command that changes files or state is blocked. ${guidance}`);
    }
    for (let i = 0; i < 3; i++) assert.equal(call("Read"), null);
    const sixth = call("Bash", { command: "git status" });
    assert.equal(sixth.permissionDecision, "deny");
    assert.equal(sixth.permissionDecisionReason, `The sixth counted work call (Bash) is blocked. ${guidance}`);
  });

  test("Worker sessions and subagents bypass the Manager gate; corrupt state is fresh", () => {
    const stateHome = path.join(directory, "state");
    const env = { AGENT_WORKBENCH_STATE_HOME: stateHome };
    const event = (session_id, tool_name, extras = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name,
      tool_input: { file_path: "/tmp/file", command: "rm file" }, ...extras,
    }), env);
    const submit = (session_id, prompt) => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id, prompt,
    }), env);
    submit("worker-session", "Role: Worker\nDo the task.");
    assert.equal(event("worker-session", "Edit"), null);
    assert.equal(event("worker-session", "Bash"), null);
    assert.equal(event("subagent-session", "Edit", { agent_id: "agent-1" }), null);
    const corrupt = path.join(stateHome, "agent-workbench", "manager-turns", "corrupt-session.json");
    fs.mkdirSync(path.dirname(corrupt), { recursive: true });
    fs.writeFileSync(corrupt, "not json");
    const result = event("corrupt-session", "Edit");
    assert.equal(result.permissionDecision, "deny");
    assert.doesNotMatch(result.permissionDecisionReason, /approved/i);
    const invalid = event("../invalid", "Edit");
    assert.equal(invalid.permissionDecision, "deny");
    assert.match(invalid.permissionDecisionReason, /invalid session_id/);
  });

  test("Manager file restrictions apply without a session ID", () => {
    for (const [tool_name, tool_input] of [
      ["Edit", { file_path: "/tmp/file" }],
      ["Bash", { command: "touch file" }],
    ]) {
      const { stdout } = run(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }));
      assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny", tool_name);
    }
  });

  test("T3 task creation is gated before exemptions and approval", () => {
    let session = "thread-policy";
    const env = { AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") };
    const prompt = (text) => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: session, prompt: text,
    }), env);
    const call = (tool_name, tool_input, extras = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: session, tool_name, tool_input, ...extras,
    }), env);
    const workerLaunch = {
      environmentId: "env", projectId: "project", modelSelection: { model: "gpt-6-luna" },
    };

    prompt("Role: Worker\nDo the task.");
    for (const name of ["mcp__t3-code__schedule_task", "mcp__t3_code__schedule_task"]) {
      assert.equal(call(name, { environmentId: "env", projectId: "project", bindToCurrentThread: true }).permissionDecision, "deny");
      assert.equal(call(name, { scheduledTaskId: "existing", enabled: false }), null);
    }
    assert.equal(call("mcp__t3_code__list_scheduled_tasks"), null);
    assert.equal(call("mcp__t3_code__delete_scheduled_task", { scheduledTaskId: "existing" }), null);
    for (const name of ["mcp__t3-code__t3_thread_launch", "mcp__t3_code__t3_thread_launch"]) {
      assert.equal(call(name, workerLaunch).permissionDecision, "deny");
    }
    assert.equal(call("mcp__t3_code__create_threads", { threads: [{
      target: { environmentId: "env", projectId: "project", model: "gpt-6-luna" },
    }] }).permissionDecision, "deny");
    assert.equal(call("mcp__t3_code__t3_thread_launch", workerLaunch, { agent_id: "subagent-1" }).permissionDecision, "deny");

    session = "thread-policy-manager";
    prompt("Manager work approval: https://example.test/approval");
    const launch = (tool_input) => call("mcp__t3_code__t3_thread_launch", tool_input);
    assert.equal(launch(workerLaunch), null);
    assert.equal(call("mcp__t3_code__create_threads", { threads: [{
      target: { environmentId: "env", projectId: "project", model: "gpt-6-luna" },
    }] }), null);
    assert.equal(call("mcp__t3_code__create_threads", { threads: [{
      target: { environmentId: "env", projectId: "project", model: "claude-opus-5-5" },
    }] }).permissionDecision, "deny");
    for (const invalid of [
      { projectId: "project", modelSelection: { model: "gpt-6-luna" } },
      { environmentId: "env", projectId: " ", modelSelection: { model: "gpt-6-luna" } },
      { environmentId: "env", projectId: "project", modelSelection: {} },
      { environmentId: "env", projectId: "project", modelSelection: { model: "prefix-gpt-6-luna" } },
      { environmentId: "env", projectId: "project", modelSelection: { model: "gpt-6-luna-extra" } },
      { environmentId: "env", projectId: "project", modelSelection: { model: "claude-opus-5-5" } },
      { environmentId: "env", projectId: "project", model: "gpt-6-luna" },
    ]) assert.equal(launch(invalid).permissionDecision, "deny");
    assert.equal(call("mcp__t3_code__schedule_task", {
      environmentId: "env", projectId: "project", bindToCurrentThread: true, model: "gpt-6-luna",
    }).permissionDecision, "deny");
  });

  test("automation activation requires a matching personal registry entry", () => {
    const home = directory;
    const project = path.join(directory, "project");
    fs.mkdirSync(project);
    const registry = path.join(home, ".agents/skills/workbench-personal/automations.yml");
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    const schedule = "7 * * * *";
    const entry = (model = "gpt-6-luna", entryProject = project) => `automations:\n  - name: routine-check\n    owner_lane: general\n    host: ${os.hostname()}\n    project: ${entryProject}\n    model: ${model}\n    schedule: '${schedule}'\n    cost_cap: bounded\n    end: completion\n`;
    const event = (tool_name, tool_input, extras = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "automation-manager", cwd: project,
      tool_name, tool_input, ...extras,
    }), { HOME: home });

    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }).permissionDecision, "deny");
    assert.equal(event("Skill", { skill: "loop", args: "Review changes." }).permissionDecision, "deny");
    assert.equal(event("Bash", { command: "systemd-run --unit=task true" }).permissionDecision, "deny");
    fs.writeFileSync(registry, entry());
    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }).permissionDecision, "deny");
    invoke(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "automation-manager",
      tool_name: "Write", tool_input: { file_path: registry } }), { HOME: home });
    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }), null);
    assert.equal(event("Skill", { skill: "loop", args: "Review changes." }), null);
    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "automation-manager", prompt: "Continue." }), { HOME: home });
    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }).permissionDecision, "deny");
    invoke(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "automation-manager",
      tool_name: "Edit", tool_input: { file_path: registry } }), { HOME: home });
    assert.equal(event("CronCreate", { cron: "0 0 * * *", prompt: "Review changes." }).permissionDecision, "deny");
    assert.equal(event("watch_pull_request", { repository: "other/repo", number: 1 }).permissionDecision, "deny");
    fs.writeFileSync(registry, entry("gpt-6-luna", "other/repo"));
    assert.equal(event("watch_pull_request", { repository: "other/repo", number: 1 }), null);
    assert.equal(event("watch_pull_request", { url: "https://github.com/other/repo/pull/1" }), null);
    fs.writeFileSync(registry, entry("claude-opus-5-5"));
    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }).permissionDecision, "deny");
    assert.equal(event("CronCreate", { cron: schedule, prompt: "L3 approval: https://example.test/owner\nReview changes." }), null);
    assert.equal(event("CronCreate", { cron: schedule, prompt: "Review changes." }, { agent_id: "worker-1" }).permissionDecision, "deny");
    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "automation-worker",
      prompt: "Role: Worker\nComplete the task." }), { HOME: home });
    invoke(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "automation-worker",
      tool_name: "Write", tool_input: { file_path: registry } }), { HOME: home });
    assert.equal(event("CronCreate", { cron: schedule, prompt: "L3 approval: https://example.test/owner" },
      { session_id: "automation-worker" }).permissionDecision, "deny");
    assert.equal(event("Bash", { command: "crontab -e" }).permissionDecision, "deny");
  });

  test("delegate_task stamps Worker role after its existing checks pass", () => {
    for (const tool_name of ["mcp__t3-code__delegate_task", "mcp__t3_code__delegate_task"]) {
      const result = invoke(JSON.stringify({ tool_name, session_id: "stamp-session", tool_input: {
        task: "Fix this issue.", target: { model: "gpt-6-luna" },
      } }));
      assert.equal(result.updatedInput.task, "Role: Worker\nFix this issue.");
      const already = invoke(JSON.stringify({ tool_name, session_id: "stamp-session", tool_input: {
        task: "Role: Worker\nFix this issue.", target: { model: "gpt-6-luna" },
      } }));
      assert.equal(already, null);
      const denied = invoke(JSON.stringify({ tool_name, session_id: "stamp-session", tool_input: { task: "x", target: {} } }));
      assert.equal(denied.permissionDecision, "deny");
      assert.equal(denied.updatedInput, undefined);
    }
  });

  test("neutral profile keeps L3 approval and disallows named model overrides", () => {
    bundle = workerBundle(WORKERS, [NEUTRAL_OVERRIDE]);
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const dispatch = (subagentType, model) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: "Agent",
      tool_input: { subagent_type: subagentType, model },
    }));
    assert.equal(dispatch("standard"), null);
    assert.equal(dispatch("standard", "sonnet").permissionDecision, "deny");
    assert.equal(dispatch("expert").permissionDecision, "deny");
  });

  test("opus is denied until the prompt records the approval", () => {
    for (const tool of ["Agent", "Task"]) {
      const dispatch = (prompt) => invoke(JSON.stringify({
        tool_name: tool, tool_input: { subagent_type: "opus", prompt }, agent_id: "worker", agent_type: "sol",
      }));
      const decision = dispatch("Fix the bug.");
      assert.equal(decision.hookEventName, "PreToolUse");
      assert.equal(decision.permissionDecision, "deny");
      assert.match(decision.permissionDecisionReason,
        /^Worker opus at level L3 needs the user's approval for this task \(configured Worker ladder\)\. /);
      assert.match(decision.permissionDecisionReason, /`L3 approval: <link to the approval>`/);
      assert.equal(dispatch("Fix the bug.\nL3 approval: https://example.test/approval"), null);
      assert.equal(dispatch("Fix the bug. L3 approval: inline only.").permissionDecision, "deny");
    }
  });

  test("T3 delegate to an approval tier is denied until the task records the approval", () => {
    const delegate = (model, task = "Review the PR.") => invoke(JSON.stringify({
      tool_name: "mcp__t3-code__delegate_task", tool_input: { task, target: { model } },
    }));
    for (const model of ["claude-opus-5-5", "opus", "onsager/auto/claude-opus-5-5[1m]"]) {
      const decision = delegate(model);
      assert.equal(decision.permissionDecision, "deny");
      assert.match(decision.permissionDecisionReason, /^Worker opus at level L3 needs the user's approval/);
      assert.match(decision.permissionDecisionReason, /`L3 approval: <link to the approval>`/);
      assert.equal(delegate(model, "Review the PR.\nL3 approval: https://example.test/approval"), null);
    }
    assert.equal(delegate("claude-opus-5-5", "Mention L3 approval: inline only.").permissionDecision, "deny");
    for (const model of ["claude-sonnet-5-5", "onsager/kiro/claude-sonnet-5-5[1m]", "unlisted/model"]) {
      assert.equal(delegate(model), null);
    }
  });

  test("approval uses profile and event cwd", () => {
    const work = path.join(directory, "work");
    fs.mkdirSync(work);
    const alias = path.join(directory, "alias");
    fs.symlinkSync(work, alias, "dir");
    const corporate = JSON.parse(JSON.stringify(bundle.profiles.codex));
    corporate.ladder = [{ level: "expert", tiers: ["sol"], approval: "required" }];
    bundle.profile = "codex";
    bundle.profiles.corporate = corporate;
    bundle.select = [{ path: work, profile: "corporate" }];
    fs.writeFileSync(workers, JSON.stringify(bundle));
    for (const tool of ["Agent", "Task"]) {
      const payload = { tool_name: tool, cwd: path.join(alias, "nested"), tool_input: { subagent_type: "sol" } };
      let result = invoke(JSON.stringify(payload));
      assert.equal(result.permissionDecision, "deny");
      assert.match(result.permissionDecisionReason, /expert/);
      payload.cwd = path.dirname(work);
      assert.equal(invoke(JSON.stringify(payload)), null);
      payload.cwd = work;
      payload.tool_input.subagent_type = "opus";
      result = invoke(JSON.stringify(payload));
      assert.equal(result.permissionDecision, "deny");
      assert.match(result.permissionDecisionReason, /not in the ladder/);
      payload.tool_input.subagent_type = "terra";
      assert.equal(invoke(JSON.stringify(payload)), null);
    }
    bundle.profile = "corporate";
    fs.writeFileSync(workers, JSON.stringify(bundle));
    assert.equal(invoke(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "sol" } })).permissionDecision, "deny");
  });

  test("missing or unreadable workers asks on every dispatch", () => {
    for (const content of [null, "invalid json", "{}"]) {
      if (content === null) fs.rmSync(workers);
      else fs.writeFileSync(workers, content);
      for (const tier of ["luna", "Plan", "custom"]) {
        const result = invoke(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: tier } }));
        assert.equal(result.permissionDecision, "ask");
        assert.match(result.permissionDecisionReason, /agent-workbench install/);
      }
    }
    fs.rmSync(workers);
    fs.mkdirSync(workers);
    assert.equal(invoke(JSON.stringify({ tool_name: "Task", tool_input: {} })).permissionDecision, "ask");
  });

  test("T3 delegate requires worker model", () => {
    for (const target of [{}, { model: "" }, { options: { effort: "low" } }]) {
      const decision = invoke(JSON.stringify({ tool_name: "mcp__t3-code__delegate_task", tool_input: { target } }));
      assert.equal(decision.permissionDecision, "deny");
      assert.match(decision.permissionDecisionReason, /target\.model/);
      assert.match(decision.permissionDecisionReason, /effort in target\.options/);
    }
    assert.equal(invoke(JSON.stringify({
      tool_name: "mcp__t3-code__delegate_task",
      tool_input: { target: { model: "gpt-6-luna", options: { effort: "low" } } },
    })), null);
  });

  test("builtin agents cannot inherit the Manager model", () => {
    for (const tool of ["Agent", "Task"]) {
      for (const subagentType of [null, "general-purpose", "Plan", "Explore", "claude"]) {
        const toolInput = subagentType === null ? {} : { subagent_type: subagentType };
        const decision = invoke(JSON.stringify({ tool_name: tool, tool_input: toolInput }));
        assert.equal(decision.permissionDecision, "deny");
        assert.match(decision.permissionDecisionReason, /inherit the Manager's model/);
        assert.match(decision.permissionDecisionReason, /subagent_type: <role>/);
      }
    }
    for (const tool of ["Agent", "Task"]) {
      assert.equal(invoke(JSON.stringify({
        tool_name: tool, tool_input: { subagent_type: "Plan", model: "claude-sonnet-5-5" },
      })), null);
    }
  });

  test("named fork and custom agents pass through", () => {
    for (const subagentType of ["fork", "sonnet", "custom-agent"]) {
      assert.equal(invoke(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: subagentType } })), null);
    }
  });

  test("named agents cannot override their model", () => {
    for (const tool of ["Agent", "Task"]) {
      for (const [subagentType, model] of [["luna", "sonnet"], ["sol", "sonnet"], ["haiku", "opus"], ["custom-agent", "haiku"]]) {
        const decision = invoke(JSON.stringify({ tool_name: tool, tool_input: { subagent_type: subagentType, model } }));
        assert.equal(decision.permissionDecision, "deny", subagentType);
        assert.match(decision.permissionDecisionReason, /Drop model and let subagent_type select the tier/);
      }
    }
    assert.equal(invoke(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "fork", model: "sonnet" } })), null);
  });

  test("opus model requires approval", () => {
    for (const tool of ["Agent", "Task"]) {
      const decision = invoke(JSON.stringify({ tool_name: tool, tool_input: { subagent_type: "Plan", model: "opus" } }));
      assert.equal(decision.permissionDecision, "deny");
      assert.match(decision.permissionDecisionReason,
        /^L3 Opus Worker needs the user's approval for this task \(orchestrate-harnesses Worker ladder\)\. /);
      assert.equal(invoke(JSON.stringify({
        tool_name: tool, tool_input: { subagent_type: "Plan", model: "opus", prompt: "L3 approval: https://example.test/a" },
      })), null);
    }
  });

  test("passthrough and malformed input", () => {
    for (const payload of [
      '{"tool_name":"Agent","tool_input":{"subagent_type":"sonnet"}}',
      '{"tool_name":"Read","tool_input":{"file_path":"anything"}}',
      "{invalid", "[]", "null", '{"tool_name":"Bash","tool_input":null}',
      '{"tool_name":"Bash","tool_input":{"command":42}}',
      JSON.stringify({ tool_name: "Bash", tool_input: { command: 'gh "' } }),
    ]) {
      assert.equal(invoke(payload), null, payload);
    }
  });

  test("stop classifier overrides question mark heuristic and falls back when uncertain or unreachable", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(payload.model, "typesafe/jev-latest");
        const message = payload.state.message;
        const probabilities = message === "Actual ask." ? { yes: 0.8, no: 0.2 } :
          message === "Just a report?" ? { yes: 0.1, no: 0.9 } : { yes: 0.5, no: 0.5 };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ answers: { asks: { choice: probabilities.yes >= 0.7 ? "yes" : "no", confidence: 0.9, probabilities } } }));
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/v1/systemone`;
      bundle.profile = null;
      bundle.base.policy.stop_classifier = { url, model: "typesafe/jev-latest" };
      fs.writeFileSync(workers, JSON.stringify(bundle));
      const invoke = async (message) => invokeStopAsync({ hook_event_name: "Stop", last_assistant_message: message });
      assert.equal((await invoke("Actual ask.")).decision, "block");
      assert.equal(await invoke("Just a report?"), null);
      assert.equal((await invoke("Unclear? ")).decision, "block");

      bundle.base.policy.stop_classifier.url = "http://127.0.0.1:1/unreachable";
      fs.writeFileSync(workers, JSON.stringify(bundle));
      assert.equal((await invoke("Fallback? ")).decision, "block");
      assert.equal(await invoke("Fallback report."), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("stop blocks a question from the last assistant message", () => {
    const result = invokeStop({ hook_event_name: "Stop", last_assistant_message: "Proceed with option A? **" });
    assert.equal(result.decision, "block");
    assert.match(result.reason, /AskUserQuestion/);
    assert.match(result.reason, /recommended option first/);
  });

  test("stop blocks a question from the transcript tail", () => {
    const transcript = path.join(tmp(), "transcript.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: "Question?" }] },
    }) + "\n");
    const result = invokeStop({ hook_event_name: "Stop", transcript_path: transcript });
    assert.equal(result.decision, "block");
  });

  test("stop passes active, no-question and malformed input", () => {
    for (const event of [
      { hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Question?" },
      { hook_event_name: "Stop", last_assistant_message: "Finished." },
      { hook_event_name: "Stop", transcript_path: "/missing/transcript" },
      { hook_event_name: "Stop" },
    ]) {
      assert.equal(invokeStop(event), null, JSON.stringify(event));
    }
    const result = spawnSync(process.execPath, [HOOK], { input: "{bad", encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  function makeGitRepo(repository, branch) {
    fs.mkdirSync(repository);
    const gitIn = (...args) => execFileSync("git", ["-C", repository, "-c", "user.name=Test",
      "-c", "user.email=test@example.com", ...args], { stdio: "pipe" });
    execFileSync("git", ["init", "-b", branch, repository], { stdio: "pipe" });
    fs.writeFileSync(path.join(repository, "tracked"), "initial\\n");
    gitIn("add", "tracked");
    gitIn("commit", "-m", "initial");
    return repository;
  }

  function bashDecision(command, cwd) {
    const event = { tool_name: "Bash", tool_input: { command } };
    if (cwd !== undefined) event.cwd = cwd;
    return invoke(JSON.stringify(event));
  }

  function assertProtected(command, cwd) {
    const decision = bashDecision(command, cwd);
    assert.equal(decision?.permissionDecision, "deny", command);
    const reason = decision.permissionDecisionReason;
    assert.match(reason, /local main branch is protected/);
    assert.match(reason, /task branch/);
    assert.match(reason, /origin\/main/);
  }

  const assertAllowed = (command, cwd) => assert.equal(bashDecision(command, cwd), null, command);

  test("checkout and switch protection", () => {
    assertProtected('git push "" main');
    for (const command of ["git checkout main", "git checkout master", "git switch main",
      "git checkout -B main origin/main", "git switch -C main origin/main", "git checkout -f main"]) {
      assertProtected(command);
    }
    for (const command of ["git checkout -b x origin/main", "git switch -c x main",
      "git checkout main -- path", "git checkout main path",
      "git checkout origin/main", "git checkout feature", "git switch --detach main"]) {
      assertAllowed(command);
    }
  });

  test("worktree and remote push protection", () => {
    const feature = makeGitRepo(path.join(tmp(), "feature"), "feature");
    for (const command of ["git worktree add /tmp/test-tree main", "git worktree add /tmp/test-tree master",
      "git push origin main", "git push origin HEAD:main",
      "git push origin x:refs/heads/main", "git push -f origin main"]) {
      assertProtected(command);
    }
    for (const command of ["git worktree add -b x /tmp/test-tree main", "git push origin feature",
      "git push -u origin HEAD"]) {
      assertAllowed(command, feature);
    }
  });

  test("protected current branch blocks mutations", () => {
    const root = tmp();
    const main = makeGitRepo(path.join(root, "main"), "main");
    const feature = makeGitRepo(path.join(root, "feature"), "feature");
    for (const command of ["git commit -m x", "git merge feature", "git rebase feature",
      "git cherry-pick HEAD", "git revert HEAD", "git reset --hard HEAD",
      "git am patch.mbox", "git push origin", "git push",
      "git push origin HEAD", "git push -u origin HEAD", "git push origin @"]) {
      assertProtected(command, main);
      assertProtected(`git -C ${shellQuote(main)} ${command.slice(4)}`, root);
    }
    assertProtected(`cd ${shellQuote(main)} && git commit -m x`, root);
    for (const command of ["git commit -m x", "git merge main", "git rebase main", "git push origin"]) {
      assertAllowed(command, feature);
    }
    for (const command of ["git pull", "git fetch", "git status", "git log -1", "git diff", "git switch -c topic"]) {
      assertAllowed(command, main);
    }
  });

  test("push to a protected ref is denied even on a feature branch", () => {
    const feature = makeGitRepo(path.join(tmp(), "feature"), "feature");
    for (const command of ["git push origin main", "git push origin HEAD:main",
      "git push origin x:refs/heads/master", "git push -f origin main"]) {
      assertProtected(command, feature);
    }
    assertAllowed("git push origin feature", feature);
    assertAllowed("git push -u origin HEAD", feature);
  });

  test("polling is denied", () => {
    for (const command of [
      "gh run watch 123", "gh pr checks 1 --watch", "gh pr checks --watch=true",
      "cd /tmp && gh run watch 123", "gh pr checks 1 --watch --interval 30",
      "while true; do gh run list; sleep 30; done",
      "until gh pr view 1; do sleep 10; done",
      "for attempt in 1 2 3; do sleep 10; gh api repos/o/r; done",
      "for i in 1 2; do X=$(sleep 1); gh run list; done",
      "while true\ndo\ngh run list\nsleep 10\ndone",
    ]) {
      const decision = invoke(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
      assert.equal(decision?.permissionDecision, "deny", command);
      assert.match(decision.permissionDecisionReason, /watch_pull_request/);
      assert.match(decision.permissionDecisionReason, /GitHub API budget/);
    }
  });

  test("Claude Managers delegate CI logs and subagents can read them", () => {
    for (const command of [
      "gh run view 123 --log",
      "gh run 'view' 123 --log",
      'gh run "view" 123 --log',
      "gh run view 123 --log | tail -50",
      "logs=$(gh run view 123 --log)",
      "echo 'gh run view 123 --log'", "echo gh run download 123",
      "GH_PAGER=cat gh run view 123 --log | tail -50",
      "GH_PAGER=$PAGER gh run view 123 --log",
      "X=${Y} gh run download 1",
      "X=$(echo $(date)) gh run download 1",
      "env GH_PAGER=cat timeout 5 gh run view 123 --log",
      "command gh run view 123 --log",
      "gh run view 123 --job 456 --log-failed > failed.log",
      "cd /tmp && gh run download 123",
      "gh api repos/o/r/actions/jobs/456/logs",
      "gh api '/repos/o/r/actions/runs/123/logs'",
      "gh api repos/o/r/actions/runs/123/attempts/2/logs",
      "gh api repos/{owner}/{repo}/actions/jobs/456/logs",
      'gh api "repos/$repo/actions/jobs/$job_id/logs"',
    ]) {
      const event = { hook_event_name: "PreToolUse", session_id: "manager-ci-logs", tool_name: "Bash", tool_input: { command } };
      invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: event.session_id,
        prompt: "Manager work approval: https://example.test/approval" }));
      const decision = invoke(JSON.stringify(event));
      assert.equal(decision?.permissionDecision, "deny", command);
      assert.match(decision.permissionDecisionReason, /Resume the Worker.*L1 Worker with the run URL/);
      assert.equal(invoke(JSON.stringify({ ...event, agent_id: "worker-1", agent_type: "standard" })), null, command);
    }
    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "named-manager",
      prompt: "Manager work approval: https://example.test/approval" }));
    const namedManager = invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "named-manager", tool_name: "Bash",
      tool_input: { command: "gh run view 123 --log" }, agent_type: "standard",
    }));
    assert.equal(namedManager?.permissionDecision, "deny");
  });

  test("sleep loops are denied even without gh", () => {
    for (const command of [
      "until test -f ready; do sleep 30; done",
      "while true; do date; sleep 10; done",
      "gh run list; while true; do date; sleep 10; done",
      "while true; do date # tick\nsleep 10; done",
      "while true; do X=$(sleep 10); done",
      "while read -r line; do echo do sleep; done < input.txt",
      "echo while do sleep gh",
    ]) {
      const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } };
      for (const agent of [{}, { agent_id: "worker-1" }]) {
        const decision = invoke(JSON.stringify({ ...event, ...agent }));
        assert.equal(decision?.permissionDecision, "deny", command);
        assert.match(decision.permissionDecisionReason, /t3_background_wait or Monitor/);
      }
    }
  });

  test("single reads and unrelated commands are allowed", () => {
    for (const command of [
      "gh pr view 1 --json headRefOid,statusCheckRollup",
      "gh run list --commit abc --json workflowName,event,status",
      "gh run view 123", "gh run view 123 --json status,conclusion", "gh run view 123 --json jobs",
      "gh api repos/o/r/actions/runs/123/jobs",
      "gh api rate_limit", "gh pr checks 1", "sleep 10",
      "FOO=$(date) git status",
      "while read f; do echo $f; done < x",
      'while read f; do echo "$f"; done < sleep-results.txt',
      "sleep_ms=5 gh run list",
      "for attempt in 1 2; do gh run list; done",
      "for attempt in 1 2; do sleep 10; done",
      "echo 'gh run watch 123'", "echo gh run watch 123",
      "sleep 10; for attempt in 1 2; do gh run list; done",
      "echo 'for x; do sleep 1; gh run list; done'",
    ]) {
      assert.equal(invoke(JSON.stringify({ tool_name: "Bash", tool_input: { command } })), null, command);
    }
  });

  describe("codex host", () => {
    const codexArgs = () => ["--host", "codex", "--workers", workers];
    const codex = (event, env) => {
      const result = run(JSON.stringify(event), { env, args: codexArgs() });
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
    };

    test("thread send is stamped with allow under either T3 tool name", () => {
      const env = t3Env();
      for (const tool of ["mcp__t3_code__t3_thread_send", "mcp__t3-code__t3_thread_send"]) {
        const result = codex({
          hook_event_name: "PreToolUse", tool_name: tool,
          tool_input: { threadId: "peer", message: "Hi.\n\n-- WB_MSG kind=request" },
        }, env);
        assert.equal(result.permissionDecision, "allow");
        assert.match(result.updatedInput.message, /^Hi\.\n\n-- WB_MSG from=env-1\/.* kind=request sent=\d{4}-\d\d-\d\dT\d\d:\d\dZ id=74859825:\d+ re=none$/);
      }
    });

    test("delegate_task requires a model under the sanitized name", () => {
      const decision = codex({ tool_name: "mcp__t3_code__delegate_task", tool_input: { target: {} } });
      assert.equal(decision.permissionDecision, "deny");
      assert.equal(codex({
        tool_name: "mcp__t3_code__delegate_task", tool_input: { target: { model: "gpt-6-luna" } },
      }), null);
    });

    test("task creation checks use the sanitized tool names", () => {
      for (const tool_name of ["mcp__t3_code__schedule_task", "mcp__t3-code__schedule_task"]) {
        assert.equal(codex({ tool_name, tool_input: { environmentId: "e", projectId: "p" } }).permissionDecision, "deny");
      }
      const launch = { environmentId: "e", projectId: "p", modelSelection: { model: "gpt-6-luna" } };
      for (const tool_name of ["mcp__t3_code__t3_thread_launch", "mcp__t3-code__t3_thread_launch"]) {
        assert.equal(codex({ tool_name, tool_input: launch }).permissionDecision, "deny");
      }
      assert.equal(codex({ tool_name: "mcp__t3_code__create_threads", tool_input: { threads: [{
        target: { environmentId: "e", projectId: "p", model: "gpt-6-luna" },
      }] } }).permissionDecision, "deny");
      assert.match(codex({ tool_name: "mcp__t3_code__delegate_task", tool_input: {
        target: { model: "gpt-6-luna" }, task: "Inspect.",
      } }).updatedInput.task, /^Role: Worker/);
    });

    test("spawn_agent approval rules become deny", () => {
      const byType = codex({ tool_name: "spawn_agent", tool_input: { agent_type: "opus", message: "x" } });
      assert.equal(byType.permissionDecision, "deny");
      assert.match(byType.permissionDecisionReason, /^Worker opus at level L3 needs the user's approval/);
      assert.match(byType.permissionDecisionReason, /`L3 approval: <link to the approval>` to the brief and retry\.$/);
      assert.equal(codex({
        tool_name: "spawn_agent", tool_input: { agent_type: "opus", message: "x\nL3 approval: https://example.test/a" },
      }), null);
      const byModel = codex({ tool_name: "spawn_agent", tool_input: { model: "opus" } });
      assert.equal(byModel.permissionDecision, "deny");
      assert.match(byModel.permissionDecisionReason, /Opus Worker needs the user's approval/);
    });

    test("spawn_agent of an unknown type or an L1 tier passes through", () => {
      assert.equal(codex({ tool_name: "spawn_agent", tool_input: { message: "x" } }), null);
      assert.equal(codex({ tool_name: "spawn_agent", tool_input: { agent_type: "haiku", model: "claude-haiku-5-5" } }), null);
    });

    test("Claude host denies an unapproved spawn_agent too", () => {
      const deny = invoke(JSON.stringify({ tool_name: "spawn_agent", tool_input: { agent_type: "opus" } }));
      assert.equal(deny.permissionDecision, "deny");
    });

    test("Bash rules and Stop still apply", () => {
      const deny = codex({ tool_name: "Bash", tool_input: { command: "gh run watch 1" } });
      assert.equal(deny.permissionDecision, "deny");
      const loop = codex({ tool_name: "Bash", tool_input: { command: "until test -f ready; do sleep 30; done" } });
      assert.equal(loop.permissionDecision, "deny");
      assert.equal(codex({ tool_name: "Bash", tool_input: { command: "gh run view 123 --log" } }), null);
      const result = run(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Proceed?" }), { args: codexArgs() });
      assert.equal(JSON.parse(result.stdout).decision, "block");
    });
  });
});
