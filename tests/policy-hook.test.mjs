import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  const BOT = "bot-github";
  const BOT_URL = "https://example.test/org/project/settings";
  const APPROVED = "Manager work approval: https://example.test/approval";
  const BROWSER_TASK = `Browser task: ${BOT} https://example.test/task`;

  function configureBrowser(extra = "") {
    const overlay = path.join(directory, "browser-workers.yml");
    fs.writeFileSync(overlay, `policy: { browser: { profiles: { ${BOT}: { urls: [${BOT_URL}] }${extra} } } }\n`);
    bundle = workerBundle(WORKERS, [overlay]);
    fs.writeFileSync(workers, JSON.stringify(bundle));
  }

  const browserPrompt = (session_id, prompt) => invoke(JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id, prompt,
  }));
  const browserCall = (session_id, tool_name, tool_input = {}, extras = {}) => invoke(JSON.stringify({
    hook_event_name: "PreToolUse", session_id, tool_name, tool_input, ...extras,
  }));
  const preview = (session, tool, input, extras) => browserCall(session, `mcp__t3-code__preview_${tool}`, input, extras);

  const githubReads = [
    "gh pr view 1 --json headRefOid,statusCheckRollup",
    "gh pr checks 1",
    "gh run view 123",
    "gh run view 123 --log-failed",
    "gh run list --commit abc",
    "gh api repos/o/r/actions/runs/123/logs",
    "gh api --method GET repos/o/r",
  ];

  function denialEntries() {
    const out = path.join(directory, "state", "agent-workbench", "denials");
    const files = fs.readdirSync(out).sort();
    assert.ok(files.every((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)));
    return files.flatMap((name) => fs.readFileSync(path.join(out, name), "utf8").trimEnd().split("\n").map((line) => {
      const { time, ...entry } = JSON.parse(line);
      assert.equal(new Date(time).toISOString(), time);
      assert.equal(time.slice(0, 10), name.slice(0, 10));
      return entry;
    }));
  }

  const readOnlyDenial = /Read-only Workers cannot edit files/;
  const shellReads = ["git status --short", "git show HEAD", "git log -1", "cat notes.md", "grep text notes.md", "gh pr view 1"];
  const shellWrites = ["touch notes.md", "git commit -m change", "echo change > notes.md"];

  test("Claude uses the active profile's native agent type for Worker edit and shell policy", () => {
    bundle = workerBundle(WORKERS, [NEUTRAL_OVERRIDE]);
    bundle.profiles.neutral.tiers.fast.access = "read-only";
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const call = (tool, input, agent_type) => browserCall("child-session", tool, input, { agent_id: "child", agent_type });
    for (const tool of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
      assert.match(call(tool, { file_path: "notes.md" }, "fast").permissionDecisionReason, readOnlyDenial);
      for (const type of ["standard", "unknown", undefined]) assert.equal(call(tool, { file_path: "notes.md" }, type), null);
    }
    for (const command of shellWrites) {
      assert.match(call("Bash", { command }, "fast").permissionDecisionReason, readOnlyDenial);
      assert.equal(call("Bash", { command }, "standard"), null, command);
    }
    for (const command of shellReads) assert.equal(call("Bash", { command }, "fast"), null, command);
  });

  test("denial records contain only metadata and use the thread ID or cwd basename", () => {
    const call = (tool_name, tool_input, thread) => invoke(JSON.stringify({
      session_id: "denial-manager", tool_name, tool_input, cwd: "/sensitive/parent/worktree",
    }), { ...process.env, T3CODE_THREAD_ID: thread });
    assert.equal(call("Read", { file_path: "/sensitive/input" }, "t3-lane"), null);
    assert.equal(call("Edit", { file_path: "/sensitive/output", new_string: "private text" }, "t3-lane").permissionDecision, "deny");
    assert.equal(call("Bash", { command: "echo private-command > /sensitive/file" }, "").permissionDecision, "deny");
    assert.deepEqual(denialEntries(), [
      { host: "claude", tool: "Edit", rule: "manager-edit", role: "manager", lane: "t3-lane" },
      { host: "claude", tool: "Bash", rule: "manager-shell-write", role: "manager", lane: "worktree" },
    ]);
  });

  test("an unwritable denial destination does not change the denial", () => {
    const state = path.join(directory, "state", "agent-workbench");
    fs.mkdirSync(state, { recursive: true });
    const log = path.join(state, "denials");
    fs.writeFileSync(log, "not a directory");
    const result = browserCall("denial-manager", "Bash", { command: "touch notes.md" });
    assert.equal(result.permissionDecision, "deny");
    assert.match(result.permissionDecisionReason, /changes files or state/);
    assert.equal(fs.readFileSync(log, "utf8"), "not a directory");
  });

  test("browser profile configuration is optional and validates profile IDs and URLs", () => {
    assert.equal(bundle.base.policy.browser, undefined);
    configureBrowser();
    assert.deepEqual(bundle.base.policy.browser.profiles, { [BOT]: { urls: [BOT_URL] } });
    const overlay = path.join(directory, "bad-browser.yml");
    for (const spec of ["default: { urls: [] }", "incognito: { urls: [] }", "bot: {}", "bot: { urls: nope }",
      "bot: { urls: [/relative] }", "bot: { urls: [https:example.test/] }", "bot: { urls: [http://example.test/] }",
      "bot: { urls: [https://@example.test/] }", "bot: { urls: [https://user@example.test/] }",
      "bot: { urls: [42] }", "bot: { urls: [], extra: true }"]) {
      fs.writeFileSync(overlay, `policy: { browser: { profiles: { ${spec} } } }\n`);
      assert.throws(() => workerBundle(WORKERS, [overlay]), /policy\.browser/, spec);
    }
  });

  test("browser open requires a configured profile and a current approved Manager grant", () => {
    browserPrompt("no-config", `${APPROVED}\n${BROWSER_TASK}`);
    assert.match(preview("no-config", "open", { profileId: BOT, reuseExistingTab: false }).permissionDecisionReason, /not configured/);
    configureBrowser();
    for (const [session, prompt] of [
      ["unapproved", BROWSER_TASK], ["no-grant", APPROVED], ["missing-link", `${APPROVED}\nBrowser task: ${BOT}`],
      ["bad-scheme", `${APPROVED}\nBrowser task: ${BOT} http://example.test/task`],
      ["bad-link", `${APPROVED}\nBrowser task: ${BOT} https:///`],
      ["extra-text", `${APPROVED}\n${BROWSER_TASK} extra`],
    ]) {
      browserPrompt(session, prompt);
      assert.match(preview(session, "open", { profileId: BOT, reuseExistingTab: false }).permissionDecisionReason, /current approved Manager turn/);
    }
    browserPrompt("approved", `${APPROVED}\n${BROWSER_TASK}`);
    for (const input of [{}, { reuseExistingTab: false, tabId: "tab-1" }, { reuseExistingTab: false, target: {} }]) {
      assert.match(preview("approved", "open", { profileId: BOT, ...input }).permissionDecisionReason, /reuseExistingTab/);
    }
    assert.equal(preview("approved", "open", { profileId: BOT, reuseExistingTab: false }), null);
    assert.equal(preview("approved", "snapshot", { tabId: "tab-1" }), null);
    assert.equal(browserCall("approved", "mcp__t3-code__t3_preview_list"), null);
    assert.match(preview("approved", "evaluate", { expression: "1 + 1" }).permissionDecisionReason, /evaluation/);
    browserPrompt("approved", APPROVED);
    assert.equal(preview("approved", "open", { profileId: BOT, reuseExistingTab: false }).permissionDecision, "deny");
    assert.match(preview("approved", "open", { tabId: "tab-1" }).permissionDecisionReason, /current approved Manager turn/);
    assert.equal(preview("approved", "open", { profileId: "default", tabId: "tab-1" }).permissionDecision, "deny");
    assert.equal(preview("approved", "navigate", { tabId: "tab-1", url: BOT_URL }).permissionDecision, "deny");
    assert.equal(browserCall("approved", "mcp__t3-code__t3_preview_close", { tabId: "tab-1" }).permissionDecision, "deny");
    assert.equal(preview("approved", "status"), null);
    browserPrompt("approved", `${APPROVED}\n${BROWSER_TASK}`);
    assert.match(preview("approved", "open", { tabId: "tab-1" }).permissionDecisionReason, /reuseExistingTab/);
    assert.match(preview("approved", "open", { profileId: "default", reuseExistingTab: false, url: "https://other.test/" }).permissionDecisionReason, /outside/);
    assert.equal(browserCall("approved", "mcp__t3_code__t3_preview_close", { tabId: "tab-1" }), null);
    assert.equal(preview("approved", "snapshot", { tabId: "tab-1" }), null);
  });

  test("a session stays pinned to one bot profile", () => {
    configureBrowser(", bot-other: { urls: [https://other.test/] }");
    const session = "browser-pinned";
    browserPrompt(session, `${APPROVED}\n${BROWSER_TASK}\nBrowser task: bot-other https://example.test/task`);
    assert.equal(preview(session, "open", { profileId: BOT, reuseExistingTab: false }), null);
    assert.match(preview(session, "open", { profileId: "bot-other", reuseExistingTab: false }).permissionDecisionReason, /fresh session/);
    assert.equal(preview(session, "navigate", { url: "https://other.test/" }).permissionDecision, "deny");
  });

  test("bot URLs match parsed origin and path segments, on open and on navigate", () => {
    configureBrowser();
    const denied = [`${BOT_URL}-x`, `${BOT_URL}%2Fx`, `${BOT_URL}/../other`, `${BOT_URL}/%2e%2e/other`,
      `${BOT_URL.replace("example.test", "example.test.invalid")}`, BOT_URL.replace("example.test", "example.test:444"),
      BOT_URL.replace("example.test", "user@example.test"), BOT_URL.replace("example.test", "@example.test"),
      BOT_URL.replace("https:", "http:"), BOT_URL.replace("https://", "https:"), "/org/project/settings", null];
    for (const [index, url] of denied.entries()) {
      const session = `browser-lookalike-${index}`;
      browserPrompt(session, `${APPROVED}\n${BROWSER_TASK}`);
      assert.match(browserCall(session, "mcp__t3_code__preview_open", { profileId: BOT, reuseExistingTab: false, url }).permissionDecisionReason, /outside/);
      assert.equal(preview(session, "open", { profileId: BOT, reuseExistingTab: false }), null);
      assert.match(preview(session, "navigate", { tabId: "tab-1", url }).permissionDecisionReason, /outside/);
    }
    browserPrompt("browser-valid", `${APPROVED}\n${BROWSER_TASK}`);
    assert.equal(preview("browser-valid", "open", { profileId: BOT, reuseExistingTab: false, url: BOT_URL }), null);
    assert.equal(preview("browser-valid", "navigate", { url: `${BOT_URL}/access?tab=members#users` }), null);
    assert.equal(preview("browser-valid", "navigate").permissionDecision, "deny");
  });

  test("Workers and subagents cannot use either browser tool family", () => {
    configureBrowser();
    const calls = [
      ["mcp__t3_code__preview_open", {}],
      ["mcp__t3-code__preview_open", { profileId: "default" }],
      ["mcp__t3_code__preview_open", { profileId: "incognito" }],
      ["mcp__t3_code__preview_open", { profileId: BOT, reuseExistingTab: false }],
      ["MCP__T3-CODE-DIRECT__PREVIEW_ACT", { tabId: "owner-tab" }],
      ["mcp__t3_code__t3_preview_list", {}],
      ["mcp__t3-code-direct__t3_preview_close", { tabId: "owner-tab" }],
    ];
    for (const [session, role, extras] of [["worker-browser", "Role: Worker\n", {}],
      ["subagent-browser", "", { agent_id: "worker" }]]) {
      browserPrompt(session, `${role}${APPROVED}\n${BROWSER_TASK}`);
      for (const [tool, input] of calls) {
        assert.match(browserCall(session, tool, input, extras).permissionDecisionReason, /Claude Manager/, tool);
      }
      assert.equal(browserCall(session, "MCP__T3-CODE-DIRECT__PREVIEW_STATUS", {}, extras), null);
    }
  });

  test("missing, damaged and pre-turn browser state denies access but not status", () => {
    const stateDir = path.join(directory, "state", "agent-workbench", "manager-turns");
    fs.mkdirSync(stateDir, { recursive: true });
    for (const [id, raw] of [
      ["no-state", null], ["broken-state", "bad JSON"],
      ["legacy-state", JSON.stringify({ worker: false, approved: true, count: 0 })],
      ["invalid-state", JSON.stringify({ worker: false, approved: true, count: 0, turn: "test-turn", browser: BOT })],
    ]) {
      if (raw !== null) fs.writeFileSync(path.join(stateDir, `${id}.json`), raw);
      assert.match(preview(id, "open").permissionDecisionReason, /valid turn state/);
      assert.match(preview(id, "navigate", { tabId: "owner-tab" }).permissionDecisionReason, /valid turn state/);
      assert.equal(preview(id, "status"), null);
    }
  });

  test("Claude Manager keeps personal and incognito access before a bot open", () => {
    const session = "browser-manager";
    browserPrompt(session, "Owner browser chore.");
    assert.equal(preview(session, "open"), null);
    assert.equal(preview(session, "open", { profileId: "default" }), null);
    assert.equal(preview(session, "open", { profileId: "incognito" }), null);
    assert.match(preview(session, "open", { profileId: "unlisted" }).permissionDecisionReason, /not configured/);
    assert.equal(preview(session, "act", { tabId: "owner-tab" }), null);
    assert.equal(browserCall(session, "Read").permissionDecision, "deny");
    assert.equal(preview(session, "status"), null);
  });

  test("Codex denies browser calls other than status", () => {
    const session_id = "browser-other-hosts";
    browserPrompt(session_id, `${APPROVED}\n${BROWSER_TASK}`);
    const env = { ...process.env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") };
    for (const [tool_name, allow] of [["mcp__t3_code__preview_navigate", false],
      ["mcp__t3_code_direct__t3_preview_close", false], ["mcp__t3-code__preview_status", true]]) {
      const input = { tabId: "owner-tab", url: BOT_URL };
      const codex = run(JSON.stringify({ session_id, tool_name, tool_input: input }), { args: ["--host", "codex"], env });
      assert.equal(codex.stdout ? JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision : null, allow ? null : "deny");
    }
  });

  test("bot browser audit logs only allowed metadata, including denied calls", () => {
    configureBrowser();
    const session = "browser-audit";
    const audit = path.join(directory, "state", "agent-workbench", "browser-audit.jsonl");
    const cwd = directory;
    assert.equal(preview("not-a-bot-session", "status"), null);
    assert.equal(preview("not-a-bot-session", "open", { profileId: BOT, reuseExistingTab: false }).permissionDecision, "deny");
    assert.equal(fs.existsSync(audit), false);
    browserPrompt(session, `${APPROVED}\n${BROWSER_TASK}`);
    const worker = { cwd, agent_id: "bot-worker" };
    assert.equal(preview(session, "open", { profileId: BOT, reuseExistingTab: false, url: BOT_URL }, { cwd }), null);
    assert.equal(preview(session, "act", {
      action: "type", locator: "aria-ref=e1", tabId: "tab-1", text: "typed-secret",
      values: ["selected-secret"], paths: ["path-secret"],
    }, { cwd }), null);
    assert.equal(preview(session, "evaluate", { tabId: "tab-1", expression: "script-secret" }, { cwd }).permissionDecision, "deny");
    assert.equal(browserCall(session, "mcp__t3-code__t3_preview_close", { tabId: "tab-1" }, worker).permissionDecision, "deny");
    assert.equal(preview(session, "status", {}, { cwd }), null);
    browserPrompt(session, "Next turn.");
    assert.equal(preview(session, "navigate", { tabId: "tab-1", url: "https://user:secret@example.test/" }, { cwd }).permissionDecision, "deny");

    const raw = fs.readFileSync(audit, "utf8");
    assert.doesNotMatch(raw, /secret|"(?:text|values|paths|expression)"/);
    assert.equal(fs.statSync(path.dirname(audit)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(audit).mode & 0o777, 0o600);
    const rows = raw.trimEnd().split("\n").map(JSON.parse);
    const common = { session_id: session, cwd, profile: BOT };
    const agent = { ...common, agent_id: "bot-worker", role: "worker" };
    const manager = { ...common, agent_id: null, role: "manager" };
    assert.deepEqual(rows.map(({ ts, ...entry }) => {
      assert.equal(new Date(ts).toISOString(), ts);
      return entry;
    }), [
      { ...manager, tool: "open", decision: "allow", url: BOT_URL },
      { ...manager, tool: "act", decision: "allow", tabId: "tab-1", locator: "aria-ref=e1", action: "type" },
      { ...manager, tool: "evaluate", decision: "deny", tabId: "tab-1" },
      { ...agent, tool: "t3_preview_close", decision: "deny", tabId: "tab-1" },
      { ...manager, tool: "status", decision: "allow" },
      { ...manager, tool: "navigate", decision: "deny", tabId: "tab-1", url: "https://[redacted]@example.test/" },
    ]);
  });

  test("audit write errors neither block allowed calls nor allow denied calls", () => {
    configureBrowser();
    const session = "browser-audit-write-error";
    browserPrompt(session, `${APPROVED}\n${BROWSER_TASK}`);
    const audit = path.join(directory, "state", "agent-workbench", "browser-audit.jsonl");
    fs.mkdirSync(audit);
    assert.equal(preview(session, "open", { profileId: BOT, reuseExistingTab: false }), null);
    assert.equal(preview(session, "evaluate").permissionDecision, "deny");
    assert.equal(preview(session, "status"), null);
  });

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
      "unwatch_pull_request", "pull_request_create"]) {
      assert.equal(call(tool), null, tool);
    }
    assert.equal(call("watch_pull_request", { repository: "org/project", number: 1 }), null);
    for (let i = 0; i < 5; i++) assert.equal(call("Read"), null);
    assert.equal(call("mcp__t3-code__t3_thread_configure"), null);
    const afterConfigure = call("Read");
    assert.equal(afterConfigure.permissionDecision, "deny");
    assert.match(afterConfigure.permissionDecisionReason, /sixth counted work call \(Read\)/);
    prompt("Manager work approval: https://example.test/chief-pm-message");
    for (let i = 0; i < 7; i++) assert.equal(call("Read"), null);
  });

  test("Manager delegation lifecycle calls do not use the five-call work allowance", () => {
    const env = { AGENT_WORKBENCH_STATE_HOME: path.join(directory, "lifecycle-state") };
    const prompt = () => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id: "manager-lifecycle", prompt: "Continue.",
    }), env);
    const call = (tool_name) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id: "manager-lifecycle", tool_name, tool_input: {},
    }), env);

    prompt();
    for (let index = 0; index < 5; index++) assert.equal(call("Read"), null);
    for (const tool of [
      "mcp__t3-code__orchestrator_capabilities", "mcp__t3-code__task_status",
      "mcp__t3-code__task_cancel", "mcp__t3-code__t3_thread_wait", "SendMessage", "TaskStop",
    ]) assert.equal(call(tool), null, tool);
    const sixth = call("Read");
    assert.equal(sixth.permissionDecision, "deny");
    assert.match(sixth.permissionDecisionReason, /sixth counted work call \(Read\)/);
  });

  test("manager observation reads do not use the five-call work allowance", () => {
    const env = { AGENT_WORKBENCH_STATE_HOME: path.join(directory, "observation-state") };
    const prompt = (session_id) => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id, prompt: "Continue.",
    }), env);
    const call = (session_id, tool_name, tool_input = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input,
    }), env);

    prompt("manager-observation");
    for (const tool of [
      "mcp__t3-code__t3_thread_list", "mcp__t3_code__t3_thread_list",
      "mcp__t3-code__t3_thread_read", "mcp__t3_code__t3_thread_search",
      "mcp__t3_code__t3_environment_links",
      "mcp__t3-code__t3_thread_read",
    ]) assert.equal(call("manager-observation", tool, { view: "activity" }), null, tool);
    for (let index = 0; index < 5; index++) assert.equal(call("manager-observation", "Read"), null);
    for (const tool of [
      "mcp__t3-code__t3_thread_list", "mcp__t3_code__t3_thread_read",
      "mcp__t3_code__t3_thread_search", "mcp__t3-code__t3_environment_links",
    ]) assert.equal(call("manager-observation", tool), null, tool);
    const sixth = call("manager-observation", "Read");
    assert.equal(sixth.permissionDecision, "deny");
    assert.match(sixth.permissionDecisionReason, /sixth counted work call \(Read\)/);

    prompt("manager-observation-lookalike");
    for (let index = 0; index < 5; index++) assert.equal(call("manager-observation-lookalike", "Read"), null);
    for (const tool of [
      "mcp__other__t3_thread_list", "mcp__t3-code__t3_thread_list_extra", "mcp__t3_code__t3_thread_unknown",
      "t3_thread_list",
    ]) assert.equal(call("manager-observation-lookalike", tool).permissionDecision, "deny", tool);

    prompt("manager-observation-actions");
    for (const [tool, input] of [
      ["mcp__t3-code__t3_queue", { action: "list" }],
      ["mcp__t3_code__t3_queue", { action: "cancel", queuedRunId: "queued" }],
      ["mcp__t3-code__t3_pending_request", { action: "list" }],
      ["mcp__t3_code__t3_pending_request", { action: "respond", requestId: "request", answers: {} }],
    ]) assert.equal(call("manager-observation-actions", tool, input), null, tool);
    assert.equal(call("manager-observation-actions", "Edit", { file_path: "/tmp/file" }).permissionDecision, "deny");
    assert.equal(call("manager-observation-actions", "Bash", { command: "touch file" }).permissionDecision, "deny");
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

    prompt("Manager work approval: https://example.test/approval\nRole: Worker\nDo the task.");
    for (const name of ["mcp__t3-code__schedule_task", "mcp__t3_code__schedule_task"]) {
      assert.equal(call(name, { environmentId: "env", projectId: "project", bindToCurrentThread: true }).permissionDecision, "deny");
      assert.equal(call(name, { scheduledTaskId: "existing", enabled: false }), null);
      assert.equal(call(name, { scheduledTaskId: "existing", enabled: false, prompt: "replace task" }).permissionDecision, "deny");
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
    prompt("Decide next step.");
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
    session = "thread-policy-approved";
    prompt("Manager work approval: https://example.test/approval");
    assert.equal(call("mcp__t3_code__schedule_task", {
      environmentId: "env", projectId: "project", bindToCurrentThread: true, model: "gpt-6-luna",
    }).permissionDecision, "deny");
  });

  test("T3 schedule creation and re-enabling require a registered schedule in the Claude Manager main loop", () => {
    const thread = "registered-thread";
    const title = "Hourly health check";
    const interval = { type: "interval", everyMs: 3600000 };
    const fixed = { type: "fixed_time", timeOfDay: "09:15", weekdays: [1, 3] };
    const input = { title, prompt: "Check service health.", bindToCurrentThread: true, schedule: interval };
    const reenable = { scheduledTaskId: "task-1", enabled: true, freshSession: true };
    const env = t3Env(thread);
    const tool_name = "mcp__t3-code__schedule_task";
    const direct = { tool_name: "mcp__t3_code_direct__schedule_task" };
    const call = (session_id, tool_input, extras = {}, hookEnv = env) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input, ...extras,
    }), hookEnv);
    const prompt = (session_id, text = "Create the registered schedule.") => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id, prompt: text,
    }), env);
    const deny = (decision, label) => {
      assert.equal(decision?.permissionDecision, "deny", label);
      assert.match(decision.permissionDecisionReason, /policy\.schedules/);
    };

    prompt("schedule-unconfigured");
    deny(call("schedule-unconfigured", input), "no schedule config");
    prompt("schedule-direct-worker", "Role: Worker\nDo the assigned work.");
    deny(call("schedule-direct-worker", input, direct), "unregistered direct Worker call");
    prompt("schedule-direct-pause");
    assert.equal(call("schedule-direct-pause", { scheduledTaskId: "existing", enabled: false }, direct), null);
    const managerTurns = path.join(directory, "state/agent-workbench/manager-turns");
    assert.equal(JSON.parse(fs.readFileSync(path.join(managerTurns, "schedule-direct-pause.json"), "utf8")).count, 0);

    const overlay = path.join(directory, "schedule-workers.yml");
    fs.writeFileSync(overlay, JSON.stringify({ policy: { schedules: [
      { name: title, thread, schedule: interval, task_id: reenable.scheduledTaskId, fresh_session: true },
      { name: "Scheduled review", thread, schedule: fixed, task_id: "task-2" },
    ] } }));
    fs.writeFileSync(workers, JSON.stringify(workerBundle(WORKERS, [overlay])));

    prompt("schedule-interval");
    assert.equal(call("schedule-interval", input), null);
    assert.equal(call("schedule-interval", { ...input, freshSession: true }), null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(managerTurns, "schedule-interval.json"), "utf8")).count, 0);

    prompt("schedule-no-environment-id");
    assert.equal(call("schedule-no-environment-id", input, direct, {
      ...env, T3CODE_HOME: path.join(directory, "t3-without-environment-id"), T3CODE_THREAD_ID: ` ${thread} `,
    }), null);

    prompt("schedule-fixed");
    const fixedInput = { ...input, title: "Scheduled review", enabled: true, clientRequestId: "request-1",
      schedule: { weekdays: [1, 3], timeOfDay: "09:15", type: "fixed_time" } };
    assert.equal(call("schedule-fixed", fixedInput), null);
    assert.equal(call("schedule-fixed", { ...fixedInput, freshSession: false }), null);

    prompt("schedule-reenable");
    assert.equal(call("schedule-reenable", reenable), null);
    assert.equal(call("schedule-reenable", { scheduledTaskId: reenable.scheduledTaskId, enabled: true }), null);
    const reenableWithEnv = { ...reenable, scheduledTaskId: "task-2", freshSession: false, environmentId: "env-1" };
    assert.equal(call("schedule-reenable", reenableWithEnv, direct), null);

    for (const [label, payload, event, hookEnv] of [
      ["wrong-thread", input, {}, t3Env("wrong-thread")],
      ["wrong-title", { ...input, title: "Other check" }],
      ["different-interval", { ...input, schedule: { ...interval, everyMs: 60000 } }],
      ["different-weekdays", { ...fixedInput, schedule: { ...fixed, weekdays: [3, 1] } }],
      ["webhook", { ...input, schedule: { type: "webhook" } }],
      ["once", { ...input, schedule: { type: "once", runAt: "2026-12-01T09:00:00Z" } }],
      ["missing-bind", { ...input, bindToCurrentThread: undefined }],
      ["extra-key", { ...input, environmentId: "env-1" }],
      ["update", { ...input, scheduledTaskId: "existing" }],
      ["disabled", { ...input, enabled: false }],
      ["blank-prompt", { ...input, prompt: " " }],
      ["child", input, { agent_id: "worker-1" }],
      ["create-fresh-session-mismatch", { ...input, freshSession: false }],
      ["create-fresh-session-default-mismatch", { ...fixedInput, freshSession: true }],
      ["reenable-wrong-thread", reenable, {}, t3Env("wrong-thread")],
      ["reenable-unknown-task", { ...reenable, scheduledTaskId: "unknown-task" }],
      ["reenable-fresh-session-mismatch", { ...reenable, freshSession: false }],
      ["reenable-fresh-session-type", { ...reenable, freshSession: "true" }],
      ["reenable-extra-key", { ...reenable, prompt: "Replace task." }],
      ["reenable-no-enable", { ...reenable, enabled: undefined }],
      ["reenable-invalid-environment", { ...reenable, environmentId: " " }],
      ["reenable-child", reenable, { agent_id: "worker-1" }],
    ]) {
      const session = `schedule-${label}`;
      prompt(session);
      deny(call(session, payload, event, hookEnv), label);
    }
    prompt("schedule-worker", "Role: Worker\nDo the assigned work.");
    deny(call("schedule-worker", input), "Worker main loop");
    deny(call("schedule-worker", reenable), "re-enable from Worker main loop");
    deny(call("schedule-no-state", input), "missing state");
    deny(call("schedule-no-state", reenable), "re-enable with missing state");
    fs.writeFileSync(path.join(managerTurns, "schedule-invalid-state.json"), "not JSON");
    deny(call("schedule-invalid-state", input), "invalid state");
    deny(call("schedule-invalid-state", reenable), "re-enable with invalid state");

    const session_id = "schedule-codex";
    prompt(session_id);
    const result = run(JSON.stringify({ session_id, tool_name, tool_input: input }), {
      args: ["--host", "codex", "--workers", workers], env: { ...env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") },
    });
    deny(JSON.parse(result.stdout).hookSpecificOutput, "Codex host");

    const enrolledSession = "schedule-enrolled-codex";
    fs.writeFileSync(path.join(directory, "state/agent-workbench/codex-managers.json"),
      JSON.stringify({ sessions: [enrolledSession] }));
    const codexOptions = {
      args: ["--host", "codex", "--workers", workers],
      env: { ...env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") },
    };
    const codexTurn = { session_id: enrolledSession, turn_id: "turn-1" };
    run(JSON.stringify({ ...codexTurn, hook_event_name: "UserPromptSubmit", prompt: "Create the registered schedule." }),
      codexOptions);
    assert.equal(JSON.parse(fs.readFileSync(path.join(managerTurns, `${enrolledSession}.json`), "utf8")).turn,
      codexTurn.turn_id);
    for (const name of [tool_name, direct.tool_name]) {
      const create = run(JSON.stringify({ ...codexTurn, hook_event_name: "PreToolUse", tool_name: name, tool_input: input }),
        codexOptions);
      deny(JSON.parse(create.stdout).hookSpecificOutput, `enrolled Codex host with matching schedule (${name})`);
    }
    assert.equal(call("schedule-pause", { scheduledTaskId: "existing", enabled: false }), null);
    deny(call("schedule-pause", { ...reenable, enabled: false }), "pause with freshSession");
  });

  test("Claude Managers can quote approval to launch configured Manager models", () => {
    const primary = "example/manager-model";
    const alias = "example/manager-alias";
    const alternate = "example/alternate-manager";
    const manager_models = [primary, alias, alternate];
    const overlay = path.join(directory, "manager-models.yml");
    fs.writeFileSync(overlay, JSON.stringify({ profile: "codex", policy: { manager_models } }));
    fs.writeFileSync(workers, JSON.stringify(workerBundle(WORKERS, [overlay])));
    const env = { AGENT_WORKBENCH_STATE_HOME: path.join(directory, "launch-approval-state") };
    const ids = { environmentId: "env", projectId: "project" };
    const approval = "Run the task.\nL3 approval: https://example.test/approval";
    const call = (tool_name, tool_input, session_id = "approved-launch", extras = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input, ...extras,
    }), env);
    const launch = (model, message, extras = {}) => ({ ...ids, modelSelection: { model }, message, ...extras });
    const launchTool = "mcp__t3-code__t3_thread_launch";
    for (const [index, model] of ["gpt-6-luna", "codex/gpt-6-luna", "gpt-6.2-sol", "codex/gpt-6.2-sol"].entries()) {
      assert.equal(call(launchTool, launch(model, "Run the task."), `eligible-launch-${index}`), null);
    }
    assert.equal(call(launchTool, launch("codex/gpt-6.1-terra", "Run the task."), "terra-launch").permissionDecision, "deny");
    for (const [index, model] of ["prefix-codex/gpt-6-luna", "codex/gpt-6-luna-extra", "other/codex/gpt-6-luna", "codex/codex/gpt-6-luna"].entries()) {
      assert.equal(call(launchTool, launch(model, approval), `lookalike-launch-${index}`).permissionDecision, "deny");
    }
    for (const [index, model] of manager_models.entries()) {
      const session = `approved-model-${index}`;
      const denied = call(launchTool, launch(model, "Run the task."), session);
      assert.equal(denied.permissionDecision, "deny");
      assert.match(denied.permissionDecisionReason, /L3 approval:/);
      assert.equal(call(launchTool, launch(model, approval), session), null);
    }
    assert.equal(call(launchTool, launch(alternate, "Run the task. L3 approval: https://example.test/approval")).permissionDecision, "deny");
    assert.equal(call(launchTool, launch("manager-model", approval)).permissionDecision, "deny");
    assert.equal(call(launchTool, launch("claude-opus-5-5", approval)).permissionDecision, "deny");
    assert.equal(call(launchTool, launch(primary, approval, { projectId: " " })).permissionDecision, "deny");
    assert.equal(call(launchTool, launch(primary, approval), "approved-launch", { agent_id: "subagent-1" }).permissionDecision, "deny");

    const create = (...threads) => call("mcp__t3-code__create_threads", { threads });
    const thread = (model, prompt) => ({ target: { ...ids, model }, prompt });
    assert.equal(create(thread(primary, approval), thread(alternate)).permissionDecision, "deny");
    assert.equal(create(thread(primary, approval), thread(alternate, approval), thread("gpt-6-luna")), null);

    assert.equal(call("mcp__t3-code__t3_thread_configure", {
      threadId: "thread-1", modelSelection: { model: alternate },
    }).permissionDecision, "deny");
  });

  test("an empty Manager model list grants no T3 thread creation exception", () => {
    assert.deepEqual(bundle.base.policy.manager_models, []);
    assert.deepEqual(bundle.profiles.codex.policy.manager_models, []);
    const session_id = "empty-manager-models";
    const ids = { environmentId: "env", projectId: "project" };
    const model = "example/manager-model";
    const approval = "L3 approval: https://example.test/approval";
    const call = (tool_name, tool_input) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input,
    }));
    assert.equal(call("mcp__t3-code__t3_thread_launch", {
      ...ids, modelSelection: { model }, message: approval,
    }).permissionDecision, "deny");
    assert.equal(call("mcp__t3-code__create_threads", {
      threads: [{ target: { ...ids, model }, prompt: approval }],
    }).permissionDecision, "deny");
    assert.equal(call("mcp__t3-code__t3_thread_launch", {
      ...ids, modelSelection: { model: "gpt-6-luna" },
    }), null);
  });

  test("thread configure model changes reuse launch eligibility while reads stay exempt", () => {
    const env = { AGENT_WORKBENCH_STATE_HOME: path.join(directory, "configure-state") };
    const prompt = (session_id, text) => invoke(JSON.stringify({
      hook_event_name: "UserPromptSubmit", session_id, prompt: text,
    }), env);
    const call = (session_id, tool_name, tool_input, host = "claude") => {
      const result = run(JSON.stringify({ hook_event_name: "PreToolUse", session_id, tool_name, tool_input }), {
        env, args: ["--workers", workers, "--host", host],
      });
      return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
    };

    prompt("configure-manager", "Continue.");
    for (let index = 0; index < 5; index++) assert.equal(call("configure-manager", "Read"), null);
    for (const name of ["mcp__t3-code__t3_thread_configure", "mcp__t3_code__t3_thread_configure"]) {
      assert.equal(call("configure-manager", name, { threadId: "thread-1" }), null);
      assert.equal(call("configure-manager", name, {
        threadId: "thread-1", modelSelection: { model: "gpt-6-luna" },
      }), null);
      for (const modelSelection of [null, {}, { model: " " }, { provider: "openai" }, { model: "claude-opus-5-5" }]) {
        assert.equal(call("configure-manager", name, { threadId: "thread-1", modelSelection }).permissionDecision, "deny");
      }
    }
    assert.equal(call("configure-manager", "Read").permissionDecision, "deny");

    prompt("configure-approved", "Manager work approval: https://example.test/approval");
    assert.equal(call("configure-approved", "mcp__t3_code__t3_thread_configure", {
      threadId: "thread-1", modelSelection: { model: "claude-opus-5-5" },
    }).permissionDecision, "deny");

    prompt("configure-worker", "Role: Worker\nConfigure the thread.");
    assert.equal(call("configure-worker", "mcp__t3_code__t3_thread_configure", {
      threadId: "thread-1", modelSelection: { model: "gpt-6-luna" },
    }).permissionDecision, "deny");

    assert.equal(call("configure-codex", "mcp__t3_code__t3_thread_configure", { threadId: "thread-1" }, "codex"), null);
    assert.equal(call("configure-codex", "mcp__t3_code__t3_thread_configure", {
      threadId: "thread-1", modelSelection: { model: "gpt-6-luna" },
    }, "codex").permissionDecision, "deny");
  });

  test("Managers can use current-thread wakeups and existing watches; Workers cannot create them", () => {
    const call = (session_id, tool_name, tool_input = {}) => invoke(JSON.stringify({
      hook_event_name: "PreToolUse", session_id, tool_name, tool_input,
    }));
    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "local-manager", prompt: "Continue." }));
    assert.equal(call("local-manager", "CronCreate", { cron: "7 * * * *", prompt: "Check status." }), null);
    assert.equal(call("local-manager", "Skill", { skill: "loop", args: "Check status." }), null);
    assert.equal(call("local-manager", "Bash", { command: "systemd-run --unit=job true" }), null);
    assert.equal(call("local-manager", "watch_pull_request").permissionDecision, "deny");
    assert.equal(call("local-manager", "watch_pull_request", { repository: "org/project", number: 1 }), null);
    assert.equal(call("local-manager", "mcp__t3-code__watch_pull_request", { repository: "org/project", number: 1 }), null);

    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "local-worker",
      prompt: "Manager work approval: https://example.test/approval\nRole: Worker\nCheck status." }));
    assert.equal(call("local-worker", "CronCreate", { cron: "7 * * * *", prompt: "Check status." }).permissionDecision, "deny");
    assert.equal(call("local-worker", "Skill", { skill: "loop", args: "Check status." }).permissionDecision, "deny");
    assert.equal(call("local-worker", "Bash", { command: "crontab -e" }).permissionDecision, "deny");
    assert.equal(call("local-worker", "mcp__t3_code__watch_pull_request", { repository: "org/project", number: 1 }).permissionDecision, "deny");

    invoke(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "wake-cap", prompt: "Continue." }));
    for (let index = 0; index < 5; index++) assert.equal(call("wake-cap", "Read"), null);
    assert.equal(call("wake-cap", "CronCreate", { cron: "7 * * * *", prompt: "Check status." }), null);
    assert.equal(call("wake-cap", "Skill", { skill: "loop", args: "Check status." }), null);
    assert.equal(call("wake-cap", "Read").permissionDecision, "deny");
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

  test("delegate_task matches provider tiers only by exact provider and model", () => {
    bundle.profile = null; // This fixture adds its tier to the base profile.
    bundle.base.tiers.remote = { provider: "example-provider", model: "catalog/example-model", access: "read-only" };
    bundle.base.ladder[0].tiers.push("remote");
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const target = { providerInstanceId: "example-provider", model: "catalog/example-model", options: { reasoning: "high" } };
    const delegate = (providerTarget, args = {}) => invoke(JSON.stringify({
      session_id: "provider-manager", tool_name: "mcp__t3-code__delegate_task",
      tool_input: { task: "Review this change.", target: providerTarget, ...args },
    }));
    const task = "Role: Worker\nThis Worker is read-only: no file edits, commits, pushes, PRs, or state changes.\nReview this change.";
    assert.deepEqual(delegate(target).updatedInput, { task, target });
    assert.equal(delegate(target, { task: "Role: Worker\nReview this change." }).updatedInput.task, task);
    assert.equal(delegate(target, { task }), null);
    for (const model of ["other-model", "example-model", "catalog/example-model[1m]", "remote", "haiku"]) {
      const denied = delegate({ ...target, model });
      assert.equal(denied.permissionDecision, "deny", model);
      assert.match(denied.permissionDecisionReason, /target\.model must exactly match/);
    }
    const denied = delegate(target, { isolation: "worktree" });
    assert.equal(denied.permissionDecision, "deny");
    assert.match(denied.permissionDecisionReason, /does not allow worktree isolation/);
    assert.equal(delegate({ ...target, providerInstanceId: "other-provider" }, { isolation: "worktree" }).updatedInput.task,
      "Role: Worker\nReview this change.");
    for (const bypass of [
      { driverKind: "example-provider", model: "other-model" },
      { driverKind: "example-provider", providerInstanceId: "other-provider", model: "other-model" },
      { model: target.model },
    ]) {
      const result = delegate(bypass);
      assert.equal(result.permissionDecision, "deny", JSON.stringify(bypass));
      assert.match(result.permissionDecisionReason, /Set target\.providerInstanceId/);
    }
    assert.equal(delegate({ model: "remote" }, { isolation: "worktree" }).updatedInput.task,
      "Role: Worker\nReview this change.");
  });

  test("delegate_task leaves isolation to T3 for a legacy tier", () => {
    const result = invoke(JSON.stringify({
      session_id: "legacy-manager", tool_name: "mcp__t3-code__delegate_task", tool_input: {
        target: { model: "haiku" }, isolation: "future-mode", task: "Review this change.",
      },
    }));
    assert.equal(result.updatedInput.task, "Role: Worker\nReview this change.");
    assert.equal(result.updatedInput.isolation, "future-mode");
  });

  test("delegate_task applies explicit isolation and custom stamps without bypassing approval", () => {
    bundle.profile = null; // This fixture adds its tier to the base profile.
    bundle.base.tiers.remote = {
      provider: "example-provider", model: "example-model", access: "write", isolation: ["worktree"],
      stamp: "Only edit the assigned files.",
    };
    bundle.base.ladder[2].tiers.push("remote");
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const delegate = (args) => invoke(JSON.stringify({
      session_id: "provider-manager", tool_name: "mcp__t3_code__delegate_task", tool_input: {
        task: "Fix the issue.", target: { providerInstanceId: "example-provider", model: "example-model" }, ...args,
      },
    }));
    assert.match(delegate({}).permissionDecisionReason, /does not allow shared isolation/);
    assert.match(delegate({ isolation: "worktree" }).permissionDecisionReason, /needs the user's approval/);
    const task = "Fix the issue.\nL3 approval: https://example.test/approval";
    assert.equal(delegate({ isolation: "worktree", task }).updatedInput.task,
      `Role: Worker\nOnly edit the assigned files.\n${task}`);
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

  const reportedDecisions = "Sent the PR review to the coordinator. It asks you to decide four things:\n" +
    "1. Whether to merge.\n2. Which tests to rerun.\n3. When to release.\n4. Who should review.\n" +
    "No action is needed from you.";
  const quotedQuestion = 'The reviewer asked: "Should we merge?"';

  test("stop classifier overrides question mark heuristic and falls back when uncertain or unreachable", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        assert.equal(request.headers.authorization, undefined);
        assert.equal(payload.model, "typesafe/jev-latest");
        const message = payload.state.message;
        const report = ["Just a report?", reportedDecisions, quotedQuestion].includes(message);
        if (message === reportedDecisions || message === quotedQuestion) {
          assert.match(payload.questions.asks.criteria.no, /Third-party requests .* quotes, code, and lists describing decisions/);
        }
        const probabilities = message === "Actual ask." ? { yes: 0.8, no: 0.2 } :
          report ? { yes: 0.1, no: 0.9 } : { yes: 0.5, no: 0.5 };
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
      assert.equal(await invoke(reportedDecisions), null);
      assert.equal(await invoke(quotedQuestion), null);
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
    assert.match(result.reason, /stop now without writing anything more/);
    assert.match(result.reason, /Do not explain or acknowledge this check/);
  });

  test("stop passes reported decisions and quoted or code questions", () => {
    for (const message of [
      reportedDecisions,
      quotedQuestion,
      "The PR asks you to decide whether to merge?",
      "They ask you to decide whether to merge?",
      "Alex Morgan asks you to decide whether to merge?",
      "The example is `Should I merge?`",
      "```text\nDo you want to merge?\n```",
      "> Should I merge?",
    ]) {
      assert.equal(invokeStop({ hook_event_name: "Stop", last_assistant_message: message }), null, message);
    }
  });

  test("stop still blocks direct requests after reports and without a question mark", () => {
    for (const message of [
      `${reportedDecisions} Should I merge?`,
      'Should I merge "option A"?',
      "Do you want me to merge.",
      "Let me know whether to merge.",
    ]) {
      assert.equal(invokeStop({ hook_event_name: "Stop", last_assistant_message: message }).decision, "block", message);
    }
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

  const antigravity = (toolCall, env, event = {}) => {
    const hookEnv = { ...process.env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state"), ...env };
    const result = run(JSON.stringify({ toolCall, ...event }), { env: hookEnv, args: ["--workers", workers, "--host", "antigravity", "--extra", "forwarded"] });
    return result.stdout ? JSON.parse(result.stdout) : null;
  };

  describe("Antigravity T3 roles", () => {
    const manager = "thread-top-level";
    const child = "thread:delegated-task:child";
    const writer = "thread:delegated-task:writer";
    const provider = "example-provider";
    const readerModel = "catalog/reader";
    const writerModel = "catalog/writer";
    const approval = "Manager work approval: https://example.com/approval";
    const edit = (name = "write_to_file", TargetFile = "/workspace/src/file.mjs") => ({ name, args: { TargetFile } });
    const call = (name, args = {}) => ({ name: `mcp_t3-code_${name}`, args });
    const launch = call("t3_thread_launch", { environmentId: "env", projectId: "project", modelSelection: { model: "gpt-6-luna" } });
    let enrolment;
    let database;
    let env;

    beforeEach(() => {
      env = { T3CODE_THREAD_ID: ` ${manager} `, T3CODE_HOME: path.join(directory, "t3"), NODE_OPTIONS: "--disable-warning=ExperimentalWarning" };
      database = path.join(env.T3CODE_HOME, "userdata/statev2.sqlite");
      enrolment = path.join(directory, "state/agent-workbench/antigravity-managers.json");
      fs.mkdirSync(path.dirname(database), { recursive: true });
      fs.mkdirSync(path.dirname(enrolment), { recursive: true });
      fs.writeFileSync(enrolment, JSON.stringify({
        threads: [manager, child, "thread-other-relation", "thread-no-row", "thread-no-lineage", "thread-no-relationship", "thread-null-lineage"],
      }));
      const db = new DatabaseSync(database);
      db.exec("CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL)");
      const insert = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)");
      const overlay = path.join(directory, "worker-access.yml");
      fs.writeFileSync(overlay, JSON.stringify({ tiers: {
        reader: { provider, model: readerModel, access: "read-only" },
        writer: { provider, model: writerModel },
      } }));
      bundle = workerBundle(WORKERS, [overlay]);
      fs.writeFileSync(workers, JSON.stringify(bundle));
      const topLevel = JSON.stringify({ lineage: { relationshipToParent: null, parentThreadId: null },
        providerInstanceId: provider, modelSelection: { model: writerModel } });
      insert.run(manager, topLevel);
      insert.run("thread-unenrolled", topLevel);
      insert.run("thread-no-lineage", "{}");
      insert.run("thread-no-relationship", '{"lineage":{}}');
      insert.run("thread-null-lineage", '{"lineage":null}');
      for (const [id, relationshipToParent, model, providerInstanceId] of [
        [child, "subagent", readerModel, provider], [writer, "subagent", writerModel, provider],
        ["thread-wrong-provider", "subagent", writerModel, "another-provider"],
        ["thread-other-relation", "other", writerModel, provider],
      ]) {
        insert.run(id, JSON.stringify({ lineage: { relationshipToParent, parentThreadId: manager },
          providerInstanceId, modelSelection: { model } }));
      }
      db.close();
    });

    test("only enrolled top-level T3 threads have the Manager role", () => {
      // A conversation ID is the native ID, not a substitute for the T3 thread ID.
      assert.deepEqual(antigravity(launch, env, { conversationId: child }), { decision: "allow" });
      for (const id of [child, "thread-other-relation", "thread-unenrolled", "thread-no-row",
        "thread-no-lineage", "thread-no-relationship", "thread-null-lineage", ""]) {
        const result = antigravity(launch, { ...env, T3CODE_THREAD_ID: id }, { conversationId: manager, lastUserInput: approval });
        assert.equal(result.decision, "deny", id);
        assert.match(result.reason, /Workers must not launch/);
      }
      for (const invalid of ["{bad JSON", JSON.stringify({ threads: [manager, null] })]) {
        fs.writeFileSync(enrolment, invalid);
        assert.equal(antigravity(launch, env).decision, "deny");
      }
      fs.unlinkSync(enrolment);
      assert.equal(antigravity(launch, env).decision, "deny");
    });

    test("unenrolled top-level threads report the enrolment hint and an unknown role", () => {
      const id = "thread-unenrolled";
      const unenrolled = { ...env, T3CODE_THREAD_ID: id };
      const hint = "This top-level Antigravity thread is not enrolled as a Manager, so Worker rules apply. " +
        `To use Manager rules, ask the harness owner to enrol thread ${id}.`;
      assert.ok(antigravity(edit(), unenrolled).reason.endsWith(hint));
      assert.ok(antigravity(launch, unenrolled).reason.endsWith(hint));
      assert.ok(antigravity({ name: "swarm" }, unenrolled).reason.endsWith(hint));
      assert.doesNotMatch(antigravity(edit(), { ...env, T3CODE_THREAD_ID: child }).reason, /enrol thread/);
      assert.deepEqual(denialEntries(), [
        { host: "antigravity", tool: "write_to_file", rule: "read-only-worker", role: "unknown", lane: id },
        { host: "antigravity", tool: "mcp_t3-code_t3_thread_launch", rule: "thread-launch", role: "unknown", lane: id },
        { host: "antigravity", tool: "swarm", rule: "native-subagent", role: "unknown", lane: id },
        { host: "antigravity", tool: "write_to_file", rule: "read-only-worker", role: "worker", lane: child },
      ]);
    });

    test("lineage database errors and missing database fall back to Worker", () => {
      fs.writeFileSync(database, "not a database");
      assert.match(antigravity(launch, env).reason, /Workers must not launch/);
      assert.match(antigravity(edit(), env).reason, readOnlyDenial);
      fs.unlinkSync(database);
      assert.match(antigravity(launch, env).reason, /Workers must not launch/);
      assert.match(antigravity(edit(), env).reason, readOnlyDenial);
      assert.equal(fs.existsSync(database), false);
    });

    test("Manager edits and mutating shell calls need current approval except for memory edits", () => {
      const run = { name: "run_command", args: { CommandLine: "touch file.mjs" } };
      for (const name of ["write_to_file", "replace_file_content", "multi_replace_file_content"]) {
        assert.match(antigravity(edit(name), env).reason, /Manager work approval/);
      }
      const memory = path.join(os.homedir(), ".claude/projects/example/memory/notes.md");
      assert.deepEqual(antigravity(edit("write_to_file", memory), env), { decision: "allow" });
      assert.match(antigravity(run, env).reason, /changes files or state/);
      assert.deepEqual(antigravity(edit(), env, { lastUserInput: approval }), { decision: "allow" });
      assert.deepEqual(antigravity(run, env, { lastUserInput: approval }), { decision: "allow" });
      assert.match(antigravity(edit(), env, { lastUserInput: "Review only." }).reason, /Manager work approval/);
    });

    test("ACP file tools and native state changes require Manager approval and are denied to read-only Workers", () => {
      const readOnly = { ...env, T3CODE_THREAD_ID: child };
      const memory = path.join(os.homedir(), ".claude/projects/example/memory/notes.md");
      const fileEdits = ["write_file", "edit_file", "create_file", "delete_file", "file_delete", "client_edit_file"].map((name) => ({
        name, args: { Path: "/workspace/src/file.mjs", TargetFile: memory },
      }));
      const stateChanges = [
        { name: "schedule", args: { DurationSeconds: 60, Prompt: "Continue the task" } },
        { name: "manage_task", args: { Action: "send_input", TaskId: "task", Input: "continue" } },
        { name: "manage_task", args: { Action: "kill", TaskId: "task" } },
        { name: "manage_subagents", args: { Action: "kill", ConversationIds: ["agent"] } },
        { name: "manage_subagents", args: { Action: "kill_all" } },
      ];
      for (const tool of [...fileEdits, ...stateChanges]) {
        const unapproved = antigravity(tool, env, { lastUserInput: "Inspect the workspace." });
        assert.equal(unapproved.decision, "deny", tool.name);
        assert.match(unapproved.reason, /Manager work approval/, tool.name);
        assert.deepEqual(antigravity(tool, env, { lastUserInput: approval }), { decision: "allow" }, tool.name);
        const worker = antigravity(tool, readOnly, { lastUserInput: approval });
        assert.equal(worker.decision, "deny", tool.name);
        assert.match(worker.reason, readOnlyDenial, tool.name);
      }
    });

    test("ACP and CLI read tools remain available", () => {
      const readOnly = { ...env, T3CODE_THREAD_ID: child };
      for (const name of ["read_file", "list_directory", "search_directory", "find_file", "view_file", "list_dir",
        "find_by_name", "grep_search", "read_url_content"]) {
        const tool = { name, args: {} };
        assert.deepEqual(antigravity(tool, env, { lastUserInput: `Inspect with ${name}.` }), { decision: "allow" }, name);
        assert.deepEqual(antigravity(tool, readOnly), { decision: "allow" }, name);
      }
      const prompt = { lastUserInput: "Check task progress." };
      const read = { name: "view_file", args: {} };
      for (let i = 0; i < 5; i++) assert.deepEqual(antigravity(read, env, prompt), { decision: "allow" });
      for (const tool of [{ name: "manage_task", args: { Action: "list" } },
        { name: "manage_task", args: { Action: "status", TaskId: "task" } }, { name: "manage_subagents", args: { Action: "list" } }]) {
        assert.deepEqual(antigravity(tool, env, prompt), { decision: "allow" }, tool.name);
        assert.deepEqual(antigravity(tool, readOnly), { decision: "allow" }, tool.name);
      }
      assert.match(antigravity(read, env, prompt).reason, /sixth counted work call/);
    });

    test("image output requires approval and has no memory-path exception", () => {
      const image = { name: "generate_image", args: { ImageName: "example" } };
      assert.match(antigravity(image, env).reason, /Manager work approval/);
      assert.deepEqual(antigravity(image, env, { lastUserInput: approval }), { decision: "allow" });
      assert.match(antigravity(image, { ...env, T3CODE_THREAD_ID: child }).reason, readOnlyDenial);
    });

    test("Antigravity resolves Worker access and blocks edits when identity cannot be resolved", () => {
      const workerCall = (thread, tool) => antigravity(tool, { ...env, T3CODE_THREAD_ID: thread }, { lastUserInput: approval });
      for (const name of ["write_to_file", "replace_file_content", "multi_replace_file_content", "generate_image"]) {
        assert.match(workerCall(child, edit(name)).reason, readOnlyDenial);
        assert.deepEqual(workerCall(writer, edit(name)), { decision: "allow" });
        for (const unknown of ["", "thread-no-row", "thread-other-relation", "thread-wrong-provider", "thread-unenrolled"]) {
          assert.match(workerCall(unknown, edit(name)).reason, readOnlyDenial, unknown);
        }
      }
      const shell = (command) => ({ name: "run_command", args: { CommandLine: command } });
      for (const command of shellWrites) assert.match(workerCall(child, shell(command)).reason, readOnlyDenial);
      for (const command of shellReads) assert.deepEqual(workerCall(child, shell(command)), { decision: "allow" }, command);
      assert.deepEqual(workerCall(writer, shell(shellWrites[0])), { decision: "allow" });
    });

    test("read-only Antigravity Workers cannot run unparseable shell commands", () => {
      const readOnly = { ...env, T3CODE_THREAD_ID: child };
      const run = (CommandLine) => antigravity({ name: "run_command", args: { CommandLine } }, readOnly);
      const result = run("cat > f <<EOF\nit's\nEOF");
      assert.equal(result.decision, "deny");
      assert.match(result.reason, readOnlyDenial);
      assert.deepEqual(run("git status"), { decision: "allow" });
    });

    test("T3-delegated Claude and Codex sessions can resolve tier without native subagent fields", () => {
      const hookEnv = { ...process.env, ...env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") };
      const session_id = "t3-child";
      for (const [host, tool_name] of [["claude", "Edit"], ["codex", "apply_patch"]]) {
        const args = ["--host", host, "--workers", workers];
        const event = JSON.stringify({ hook_event_name: "PreToolUse", tool_name, session_id });
        const call = (thread, payload = event) => run(payload, { env: { ...hookEnv, T3CODE_THREAD_ID: thread }, args });
        call(writer, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id, prompt: "Role: Worker\nEdit the file." }));
        assert.equal(call(writer).stdout, "");
        const output = call(child).stdout;
        assert.ok(output, `expected a denial from the ${host} hook`);
        assert.match(JSON.parse(output).hookSpecificOutput.permissionDecisionReason, readOnlyDenial);
      }
    });

    test("a routine resolved Worker call allows without creating Manager state", () => {
      const state = path.join(directory, "state/agent-workbench/manager-turns");
      const worker = { ...env, T3CODE_THREAD_ID: child };
      assert.equal(fs.existsSync(state), false);
      assert.deepEqual(antigravity({ name: "run_command", args: { CommandLine: "git status --short" } }, worker), {
        decision: "allow",
      });
      assert.equal(fs.existsSync(state), false);
    });

    test("a policy error after resolving the role returns an Antigravity denial", () => {
      assert.deepEqual(antigravity(edit("write_to_file", { toString: null }), env), {
        decision: "deny", reason: "Could not evaluate the Antigravity tool policy.",
      });
    });

    test("the sixth work call is blocked until lastUserInput changes", () => {
      const read = { name: "view_file", args: { AbsolutePath: "/workspace/file.mjs" } };
      const prompt = { lastUserInput: "Review this." };
      for (let i = 0; i < 5; i++) assert.deepEqual(antigravity(read, env, prompt), { decision: "allow" });
      assert.deepEqual(antigravity(call("t3_thread_send"), env, prompt), { decision: "allow" });
      assert.match(antigravity(read, env, prompt).reason, /sixth counted work call/);
      assert.deepEqual(antigravity(read, env, { lastUserInput: "Review the next file." }), { decision: "allow" });
    });

    test("Workers cannot configure threads, start automation, or use a browser except status", () => {
      const worker = { ...env, T3CODE_THREAD_ID: child };
      for (const tool of [call("t3_thread_configure", { modelSelection: { model: "gpt-6-luna" } }),
        call("t3_thread_configure"), call("create_threads"), call("watch_pull_request", { threadId: child }),
        { name: "run_command", args: { CommandLine: "crontab -e" } }, call("preview_open"), call("t3_preview_close")]) {
        assert.equal(antigravity(tool, worker).decision, "deny", tool.name);
      }
      assert.deepEqual(antigravity(call("preview_status"), worker), { decision: "allow" });
      assert.deepEqual(antigravity(call("preview_open"), env), { decision: "allow" });
    });

    test("Antigravity bot browser grants reset without releasing the profile binding", () => {
      configureBrowser();
      const open = call("preview_open", { profileId: BOT, url: BOT_URL, reuseExistingTab: false });
      const granted = { lastUserInput: `${APPROVED}\n${BROWSER_TASK}` };
      assert.match(antigravity(open, env).reason, /needs a Browser task grant/);
      assert.deepEqual(antigravity(open, env, granted), { decision: "allow" });
      assert.match(antigravity(call("preview_evaluate"), env, granted).reason, /Script evaluation is blocked/);
      assert.match(antigravity(call("preview_open"), env, { lastUserInput: "Next task." }).reason, /needs a Browser task grant/);
    });

    test("registered schedule creation is restricted to the enrolled Manager on that thread", () => {
      const schedule = { type: "interval", everyMs: 60000 };
      const input = { title: "Daily review", prompt: "Review updates.", schedule, bindToCurrentThread: true };
      const overlay = path.join(directory, "schedule-workers.yml");
      fs.writeFileSync(overlay, JSON.stringify({ policy: { schedules: [{ name: input.title, thread: manager, schedule }] } }));
      fs.writeFileSync(workers, JSON.stringify(workerBundle(WORKERS, [overlay])));
      assert.deepEqual(antigravity(call("schedule_task", input), env), { decision: "allow" });
      assert.equal(antigravity(call("schedule_task", { ...input, title: "Other review" }), env).decision, "deny");
      const worker = { ...env, T3CODE_THREAD_ID: child };
      assert.equal(antigravity(call("schedule_task", input), worker).decision, "deny");
      assert.deepEqual(antigravity(call("schedule_task", { scheduledTaskId: "existing", enabled: false }), worker), { decision: "allow" });
    });
  });

  test("Antigravity resolves shipped non-provider tiers like other hosts but denies unknown models", () => {
    const task = "Review this change.";
    const sonnet = bundle.profiles.codex.tiers.sonnet.model;
    const delegate = (target) => antigravity({ name: "mcp_t3-code_delegate_task", args: { task, target } });
    for (const target of [
      { providerInstanceId: "codex", model: "gpt-6-luna" },
      { providerInstanceId: "codex", model: "luna" },
      { providerInstanceId: "codex", model: "example-provider/gpt-6-luna[1m]" },
      { providerInstanceId: "claudeAgent", model: sonnet },
    ]) {
      assert.deepEqual(delegate(target), { decision: "allow", overwrite: { task: `Role: Worker\n${task}` } });
    }
    const denied = delegate({ providerInstanceId: "codex", model: "unlisted" });
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /match a configured Worker tier/);
    assert.equal(denied.overwrite, undefined);
  });

  test("Antigravity stamps exact T3 delegation and ignores toolSummary", () => {
    bundle.profile = null;
    bundle.base.tiers.remote = { provider: "example-provider", model: "catalog/example-model", access: "read-only" };
    bundle.base.ladder[0].tiers.push("remote");
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const target = { providerInstanceId: "example-provider", model: "catalog/example-model" };
    const delegate = (args) => antigravity({ name: "mcp_t3-code_delegate_task", args: { task: "Review this change.", target, ...args } });
    const stamped = "Role: Worker\nThis Worker is read-only: no file edits, commits, pushes, PRs, or state changes.\nReview this change.";
    const allow = { decision: "allow", overwrite: { task: stamped } };
    assert.deepEqual(delegate({}), allow);
    assert.deepEqual(delegate({ toolSummary: "Reviewing the change" }), allow);
    assert.deepEqual(delegate({ task: stamped }), { decision: "allow" });
    for (const unmatched of [{ ...target, model: "unlisted" }, { model: "unlisted" }, { ...target, providerInstanceId: "other-provider" }]) {
      const denied = delegate({ target: unmatched });
      assert.equal(denied.decision, "deny");
      assert.match(denied.reason, unmatched.providerInstanceId === target.providerInstanceId
        ? /exactly match a configured Worker model/ : /match a configured Worker tier/);
      assert.equal(denied.overwrite, undefined);
    }
    assert.match(delegate({ target: { model: target.model } }).reason, /Set target\.providerInstanceId/);
    assert.match(delegate({ isolation: "worktree" }).reason, /does not allow worktree isolation/);
  });

  test("Antigravity delegation keeps ladder approval separate from toolSummary", () => {
    bundle.profile = null;
    bundle.base.tiers.remote = { provider: "example-provider", model: "catalog/example-model", stamp: "Only edit assigned files." };
    bundle.base.ladder[2].tiers.push("remote");
    fs.writeFileSync(workers, JSON.stringify(bundle));
    const approval = "L3 approval: https://example.test/approval";
    const delegate = (task) => antigravity({ name: "mcp_t3-code_delegate_task", args: {
      task, target: { providerInstanceId: "example-provider", model: "catalog/example-model" }, toolSummary: approval,
    } });
    const denied = delegate("Fix this issue.");
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /needs the user's approval/);
    const task = `Fix this issue.\n${approval}`;
    assert.deepEqual(delegate(task), { decision: "allow", overwrite: { task: `Role: Worker\nOnly edit assigned files.\n${task}` } });
    bundle.base.ladder[2].tiers.pop();
    assert.ok(!bundle.base.tiers.remote.opt_in);
    fs.writeFileSync(workers, JSON.stringify(bundle));
    assert.match(delegate("Fix this issue.").reason, /not in the ladder/);
    bundle.base.tiers.remote.opt_in = true;
    fs.writeFileSync(workers, JSON.stringify(bundle));
    assert.deepEqual(delegate("Fix this issue."), {
      decision: "allow", overwrite: { task: "Role: Worker\nOnly edit assigned files.\nFix this issue." },
    });
  });

  test("Antigravity overwrites only the message for a stampable T3 send", () => {
    const env = t3Env("thread-12345678");
    const send = (message, hookEnv) => antigravity({ name: "mcp_t3-code_t3_thread_send", args: {
      threadId: "peer", mode: "auto", message, toolSummary: "Sending an update",
    } }, hookEnv);
    const message = "Done.\n-- WB_MSG kind=result re=previous";
    const result = send(message, env);
    assert.match(result.overwrite.message,
      /^Done\.\n-- WB_MSG from=env-1\/thread-12345678 kind=result sent=\S+ id=12345678:1 re=previous$/);
    assert.deepEqual(result, { decision: "allow", overwrite: { message: result.overwrite.message } });
    assert.deepEqual(send("No footer.", env), { decision: "allow" });
    assert.deepEqual(send(message, { ...env, T3CODE_THREAD_ID: "" }), { decision: "allow" });
    fs.writeFileSync(path.join(directory, "wbmsg", "thread-12345678.seq"), "invalid counter");
    assert.deepEqual(send(message, env), {
      decision: "deny", reason: "Could not evaluate the Antigravity tool policy.",
    }, "a corrupt footer counter denies the send rather than letting it proceed unstamped");
  });

  test("Antigravity denies only the targeted native delegation tools", () => {
    for (const name of ["invoke_subagent", "define_subagent", "swarm", "run_workflow"]) {
      const result = antigravity({ name, args: {} });
      assert.equal(result.decision, "deny", name);
      assert.match(result.reason, /skip the Worker ladder; dispatch Workers with T3 delegate_task/);
    }
    for (const name of ["manage_subagents", "mcp_t3-code_pull_request_read"]) {
      assert.deepEqual(antigravity({ name, args: { toolSummary: "Checking status" } }), { decision: "allow" });
    }
  });

  test("Antigravity retains empty successful output on invalid hook JSON", () => {
    assert.equal(run("{invalid", { args: ["--host", "antigravity"] }).stdout, "");
  });

  test("Antigravity PreToolUse adapter shares Bash classification without role metadata", () => {
    assert.ok(fs.statSync(HOOK).mode & 0o111, "the configured hook entry point must be executable");
    assert.deepEqual(antigravity({ name: "run_command", args: { CommandLine: "gh run watch 123" } }), {
      decision: "deny", reason: "Blocking GitHub waits are disabled. Use watch_pull_request for waiting and single-call reads for status or logs (see orchestrate-harnesses' GitHub API budget section).",
    });
    assert.deepEqual(antigravity({ name: "run_command", args: { CommandLine: "git status --short" } }), { decision: "allow" });
    assert.deepEqual(antigravity({ name: "run_command", args: { CommandLine: "gh run watch --help" } }), {
      decision: "deny", reason: "Blocking GitHub waits are disabled. Use watch_pull_request for waiting and single-call reads for status or logs (see orchestrate-harnesses' GitHub API budget section).",
    });
    for (const toolCall of [undefined, {}, { name: "other_tool", args: { CommandLine: "gh run watch 123" } },
      { name: "run_command", args: {} }, { name: "run_command", args: { CommandLine: 42 } }]) {
      assert.deepEqual(antigravity(toolCall), { decision: "allow" });
    }
  });

  test("polling is denied", () => {
    for (const command of [
      "gh run watch 123", "gh run watch --help", "gh pr checks 1 --watch", "gh pr checks --watch=true", "gh pr checks 1 -w",
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

  test("Claude Managers can read GitHub status and logs in one-shot calls that count", () => {
    for (const [index, command] of [...githubReads, "gh run view 123 --log | tail -50"].entries()) {
      assert.equal(browserCall(`manager-gh-${index}`, "Bash", { command }), null, command);
    }
    const session = "manager-gh-counted";
    for (const command of githubReads.slice(0, 5)) assert.equal(browserCall(session, "Bash", { command }), null, command);
    assert.match(browserCall(session, "Bash", { command: githubReads[5] }).permissionDecisionReason, /sixth counted work call/);
    assert.equal(denialEntries().at(-1).rule, "manager-work-limit");
  });

  test("Claude Managers can redirect to /dev/null and use quoted angle brackets", () => {
    const commands = [
      "curl -s --max-time 5 http://127.0.0.1:3773/ | grep -o '<title>[^<]*' | head -1; tailscale serve status 2>/dev/null | head -5",
      "systemctl status example >/dev/null",
      "tailscale serve status &>/dev/null",
      'grep "a>b" input.txt',
      `printf '%s\\n' "$(grep 'a>b' input.txt)"`,
    ];
    for (const [index, command] of commands.entries()) {
      assert.equal(browserCall(`manager-shell-${index}`, "Bash", { command }), null, command);
    }
    for (const command of ["echo x >/dev/null-extra", "echo x &>out.txt", 'echo "$(date >out.txt)"',
      "gh run view 123 --log-failed > failed.log", "gh run download 123", "gh api -X POST repos/o/r"]) {
      browserPrompt("manager-shell-writes", "Review only.");
      assert.match(browserCall("manager-shell-writes", "Bash", { command }).permissionDecisionReason, /changes files or state/, command);
    }
  });

  test("Claude Managers delegate shell commands when redirect parsing fails", () => {
    const session = "manager-shell-parse";
    for (const command of ["cat > f <<EOF\nit's\nEOF", `echo "unfinished > f`]) {
      const result = browserCall(session, "Bash", { command });
      assert.equal(result.permissionDecision, "deny", command);
      assert.match(result.permissionDecisionReason, /changes files or state/, command);
    }
    assert.equal(browserCall(session, "Bash", { command: `grep "it's" f` }), null);
    assert.equal(browserCall(session, "Bash", { command: "gh run view 123 --log-failed" }), null);
  });

  test("Claude Manager shell writes may redirect only to project memory or /dev/null", () => {
    const memory = path.join(os.homedir(), ".claude/projects/p with spaces/memory/MEMORY.md");
    const homeRelative = "~/" + shellQuote(path.relative(os.homedir(), memory));
    const call = (command) => {
      browserPrompt("manager-memory", "Update memory.");
      return browserCall("manager-memory", "Bash", { command });
    };
    assert.equal(call(`printf note >> ${shellQuote(memory)} 2>/dev/null`), null);
    assert.equal(call(`printf note >> ${homeRelative}`), null);
    assert.match(call(`printf note >> ${shellQuote(memory)} > outside.md`).permissionDecisionReason, /changes files or state/);
    assert.match(call(`touch outside.md >> ${shellQuote(memory)}`).permissionDecisionReason, /changes files or state/);
    assert.match(call('printf note >> "$INDEX"').permissionDecisionReason, /changes files or state/);
    const sibling = path.join(os.homedir(), ".claude/projects/p/memory-bak/MEMORY.md");
    assert.match(call(`printf note >> ${shellQuote(sibling)}`).permissionDecisionReason, /changes files or state/);
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

    const policyDir = () => path.join(directory, "state", "agent-workbench");
    const enrolmentFile = () => path.join(policyDir(), "codex-managers.json");
    const stateFile = (session) => path.join(policyDir(), "manager-turns", `${session}.json`);
    function enrol(...sessions) {
      fs.mkdirSync(policyDir(), { recursive: true });
      fs.writeFileSync(enrolmentFile(), JSON.stringify({ sessions }));
    }

    const event = (hook_event_name, session_id, details) => codex({
      hook_event_name, session_id, turn_id: "turn-1", ...details,
    }, { ...process.env, AGENT_WORKBENCH_STATE_HOME: path.join(directory, "state") });
    const prompt = (session, text = "Plan and delegate.", details) => event("UserPromptSubmit", session, { prompt: text, ...details });
    const tool = (session, tool_name, tool_input = {}, details) => event("PreToolUse", session, { tool_name, tool_input, ...details });
    const bash = (session, command, details) => tool(session, "Bash", { command }, details);
    const patch = (session, details) => tool(session, "apply_patch", {
      command: "*** Begin Patch\n*** Add File: task.txt\n+work\n*** End Patch",
    }, details);

    test("Codex uses the configured native subagent profile for edit and shell policy", () => {
      const overlay = path.join(directory, "worker-access.yml");
      fs.writeFileSync(overlay, JSON.stringify({ tiers: {
        reader: { harness: "codex", model: "example-reader", access: "read-only" },
        writer: { harness: "codex", model: "example-writer", access: "write" },
      } }));
      bundle = workerBundle(WORKERS, [overlay]);
      fs.writeFileSync(workers, JSON.stringify(bundle));
      const reader = { agent_id: "child", agent_type: "reader" };
      assert.match(patch("native-child", reader).permissionDecisionReason, readOnlyDenial);
      for (const agent_type of ["writer", "unknown", undefined]) {
        assert.equal(patch("native-child", { agent_id: "child", agent_type }), null);
      }
      for (const [name, key] of [["Bash", "command"], ["exec_command", "command"], ["exec_command", "cmd"]]) {
        const shell = (command, agent = reader) => tool("native-child", name, { [key]: command }, agent);
        for (const command of shellWrites) {
          assert.match(shell(command).permissionDecisionReason, readOnlyDenial);
          assert.equal(shell(command, { ...reader, agent_type: "writer" }), null, command);
        }
        for (const command of shellReads) assert.equal(shell(command), null, command);
      }
    });

    test("only listed top-level Codex sessions write Manager turn state", () => {
      for (const invalid of [undefined, "{broken", "null", '{"sessions":"manager"}', '{"sessions":["manager",42]}']) {
        if (invalid !== undefined) {
          fs.mkdirSync(policyDir(), { recursive: true });
          fs.writeFileSync(enrolmentFile(), invalid);
        }
        prompt("manager", APPROVED);
        assert.ok(!fs.existsSync(stateFile("manager")), invalid);
        assert.equal(patch("manager"), null, invalid);
      }
      enrol("manager");
      for (const marker of [{ agent_id: "child" }, { agent_type: "worker" }]) {
        prompt("manager", APPROVED, marker);
        assert.ok(!fs.existsSync(stateFile("manager")));
        assert.equal(patch("manager", marker), null);
      }
      prompt("other-session", APPROVED);
      assert.ok(!fs.existsSync(stateFile("other-session")));
      prompt("manager", APPROVED);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile("manager"), "utf8")), {
        worker: false, approved: true, count: 0, turn: "turn-1",
      });
    });

    test("enrolled Codex Managers exempt delegation lifecycle calls from the work count", () => {
      enrol("lifecycle");
      prompt("lifecycle");
      const lifecycleTools = [
        "mcp__t3_code__orchestrator_capabilities",
        "mcp__t3_code__task_status",
        "mcp__t3_code__task_cancel",
        "mcp__t3_code__t3_thread_wait",
        "SendMessage",
        "TaskStop",
      ];
      for (let i = 1; i <= 5; i++) assert.equal(tool("lifecycle", "Read"), null);
      assert.equal(JSON.parse(fs.readFileSync(stateFile("lifecycle"), "utf8")).count, 5);
      for (const tool_name of lifecycleTools) {
        assert.equal(tool("lifecycle", tool_name), null, tool_name);
        assert.equal(JSON.parse(fs.readFileSync(stateFile("lifecycle"), "utf8")).count, 5, tool_name);
      }
      assert.match(tool("lifecycle", "Read").permissionDecisionReason, /sixth counted work call/);
    });

    test("enrolled Codex Managers count apply_patch even when the patch is denied", () => {
      enrol("counted");
      for (const session of ["counted", "not-counted"]) {
        prompt(session);
        const enrolled = session === "counted";
        for (let i = 1; i <= 5; i++) {
          const decision = patch(session);
          if (enrolled) {
            assert.match(decision.permissionDecisionReason, /apply_patch to a file/);
            assert.equal(JSON.parse(fs.readFileSync(stateFile(session), "utf8")).count, i);
          } else assert.equal(decision, null);
        }
        const sixth = patch(session);
        if (enrolled) assert.match(sixth.permissionDecisionReason, /sixth counted work call/);
        else assert.equal(sixth, null);
      }
      prompt("counted", "New turn.", { turn_id: "turn-2" });
      assert.match(patch("counted", { turn_id: "turn-2" }).permissionDecisionReason, /apply_patch to a file/);
      assert.equal(JSON.parse(fs.readFileSync(stateFile("counted"), "utf8")).count, 1);
    });

    test("enrolled Codex Managers need current approval for other shell calls", () => {
      enrol("manager");
      const nestedPatch = `bash -c ${shellQuote("apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: task.txt\n+work\n*** End Patch\nPATCH")}`;
      const reason = "Enrolled Codex Managers need `Manager work approval: <link>` at the start " +
        "of the turn for shell commands outside the one-shot GitHub reads; send other shell work to a Worker.";
      for (const [toolName, key] of [["Bash", "command"], ["exec_command", "command"], ["exec_command", "cmd"]]) {
        const call = (session, command, details) => tool(session, toolName, { [key]: command, workdir: directory }, details);
        prompt("manager");
        for (const command of ["git status", nestedPatch]) {
          const decision = call("manager", command);
          assert.equal(decision.permissionDecision, "deny");
          assert.equal(decision.permissionDecisionReason, reason);
          assert.equal(call("outside", command), null);
          assert.equal(call("manager", command, { agent_id: "child" }), null);
          assert.equal(call("manager", command, { agent_type: "worker" }), null);
        }
        prompt("manager", APPROVED);
        assert.equal(call("manager", "git status"), null);
        assert.match(call("manager", "gh run watch 123").permissionDecisionReason, /watch_pull_request for waiting/);
        assert.equal(call("manager", "git status", { turn_id: "turn-2" }).permissionDecisionReason, reason);
      }
    });

    test("unenrolled top-level Codex sessions report the native ID and an unknown role", () => {
      const name = "mcp__t3_code__watch_pull_request";
      const target = { repository: "org/project", number: 1 };
      const cwd = "/checkout/test-lane";
      const unenrolled = tool("unenrolled-native", name, target, { cwd });
      assert.match(unenrolled.permissionDecisionReason, /do not expose reliable standalone Manager\/Worker role metadata/);
      assert.match(unenrolled.permissionDecisionReason, /ask the harness owner to enrol session unenrolled-native\.$/);
      const child = tool("child-native", name, target, { cwd, agent_id: "child" });
      assert.doesNotMatch(child.permissionDecisionReason, /enrol session/);
      const entries = denialEntries();
      assert.deepEqual(entries.map(({ lane, ...entry }) => entry), [
        { host: "codex", tool: name, rule: "unknown-automation", role: "unknown" },
        { host: "codex", tool: name, rule: "worker-automation", role: "worker" },
      ]);
      assert.equal(entries[0].lane, process.env.T3CODE_THREAD_ID?.trim() || "test-lane");
    });

    test("enrolled Codex Managers can use counted one-shot GitHub reads without approval", () => {
      enrol("manager");
      for (const command of githubReads) {
        prompt("manager");
        assert.equal(tool("manager", "exec_command", { cmd: command }), null, command);
        assert.equal(JSON.parse(fs.readFileSync(stateFile("manager"), "utf8")).count, 1);
      }
      for (const command of ["gh pr checks 1 --watch", "gh run watch 123"]) {
        assert.match(bash("manager", command).permissionDecisionReason, /watch_pull_request/);
      }
      for (const command of ["gh api -X DELETE repos/o/r", "gh api repos/o/r -f key=value",
        "gh pr view 1 > out.txt", "gh pr view 1; touch out.txt", "gh run view $(touch out.txt)"]) {
        assert.match(bash("manager", command).permissionDecisionReason, /Manager work approval/, command);
      }
    });

    test("unapproved Codex Managers can patch project memory only", () => {
      enrol("manager");
      const memory = path.join(os.homedir(), ".claude/projects/p/memory");
      const note = path.join(memory, "note.md");
      const add = `*** Add File: ${note}\n+note`;
      const apply = (body) => {
        prompt("manager");
        return tool("manager", "apply_patch", { command: `*** Begin Patch\n${body}\n*** End Patch` }, { cwd: memory });
      };
      const move = (from, to) => `*** Update File: ${from}\n*** Move to: ${to}\n@@\n-old\n+new`;
      assert.equal(apply(add), null);
      assert.equal(apply(move("note.md", "renamed.md")), null);
      const outside = path.join(directory, "task.txt");
      for (const body of [`${add}\n*** Add File: ${outside}\n+work`, move(note, outside), move(outside, note),
        `${add}\n*** Unknown File: ${outside}`]) {
        assert.equal(apply(body).permissionDecision, "deny", body);
      }
    });

    test("Codex Manager approval gates edits and other shell work", () => {
      enrol("approved", "unapproved", "worker");
      prompt("unapproved");
      assert.match(bash("unapproved", "touch task.txt").permissionDecisionReason, /need `Manager work approval:/);
      assert.equal(bash("outside", "touch task.txt"), null);
      prompt("approved", APPROVED);
      assert.equal(bash("approved", "touch task.txt"), null);
      assert.equal(patch("approved"), null);
      assert.equal(bash("approved", "gh run view 123 --log"), null);
      assert.equal(bash("outside", "gh run view 123 --log"), null);
      assert.equal(bash("approved", "gh run view 123 --log", { agent_id: "child" }), null);
      assert.equal(patch("approved", { turn_id: "turn-2" }).permissionDecision, "deny");
      prompt("approved", "Plan the next turn.", { turn_id: "turn-2" });
      assert.equal(JSON.parse(fs.readFileSync(stateFile("approved"), "utf8")).approved, false);
      assert.equal(patch("approved", { turn_id: "turn-2" }).permissionDecision, "deny");
      prompt("worker", "Role: Worker\nMake the change.");
      assert.equal(patch("worker"), null);
      assert.equal(bash("worker", "touch task.txt"), null);
      enrol();
      assert.equal(patch("approved", { turn_id: "turn-2" }), null);
      assert.equal(bash("approved", "gh run view 123 --log"), null);
    });

    test("enrolled Codex Managers use the launch and configure rules under both T3 namespaces", () => {
      const ids = { environmentId: "env", projectId: "project" };
      const approved = "Run the task.\nL3 approval: https://example.test/approval";
      const model = "example/manager-model";
      const overlay = path.join(directory, "manager-models.yml");
      fs.writeFileSync(overlay, JSON.stringify({ profile: "codex", policy: { manager_models: [model] } }));
      fs.writeFileSync(workers, JSON.stringify(workerBundle(WORKERS, [overlay])));
      const launch = { ...ids, modelSelection: { model } };
      const configure = { threadId: "thread-1", modelSelection: { model: "gpt-6-luna" } };
      const create = { threads: [{ target: { ...ids, model: "gpt-6-luna" }, prompt: "Inspect the project." }] };
      for (const namespace of ["mcp__t3_code__", "mcp__t3_code_direct__"]) {
        const session = namespace.includes("direct") ? "manager-direct" : "manager-legacy";
        const worker = `${session}-worker`;
        const launchTool = namespace + "t3_thread_launch";
        const createTool = namespace + "create_threads";
        const configureTool = namespace + "t3_thread_configure";
        enrol(session, worker);
        prompt(session);
        assert.match(tool(session, launchTool, launch).permissionDecisionReason, /L3 approval:/);
        assert.equal(tool(session, launchTool, { ...launch, message: approved }), null);
        assert.equal(tool(session, launchTool, { ...launch, projectId: "", message: approved }).permissionDecision, "deny");
        assert.equal(tool(session, createTool, create), null);
        assert.equal(tool(session, createTool, { threads: [{ target: { ...ids, model } }] }).permissionDecision, "deny");
        assert.equal(tool(session, configureTool, configure), null);
        assert.equal(tool(session, configureTool, { ...configure, modelSelection: launch.modelSelection }).permissionDecision, "deny");
        prompt(worker, `Role: Worker\n${APPROVED}`);
        for (const notManager of ["outside", worker]) {
          assert.equal(tool(notManager, launchTool, { ...launch, message: approved }).permissionDecision, "deny");
          assert.equal(tool(notManager, createTool, create).permissionDecision, "deny");
          assert.equal(tool(notManager, configureTool, configure).permissionDecision, "deny");
        }
        assert.equal(tool(session, launchTool, { ...launch, message: approved }, { agent_type: "worker" }).permissionDecision, "deny");
      }
    });

    test("Codex direct delegation and schedules keep the shared tool rules", () => {
      enrol("direct-manager");
      prompt("direct-manager");
      const delegate = "mcp__t3_code_direct__delegate_task";
      const schedule = "mcp__t3_code_direct__schedule_task";
      const input = { target: { model: "gpt-6-luna" }, task: "Inspect this." };
      assert.equal(tool("direct-manager", delegate, input).updatedInput.task, "Role: Worker\nInspect this.");
      assert.equal(tool("outside", delegate, input), null);
      assert.match(tool("direct-manager", delegate, { target: {} }).permissionDecisionReason, /Set target.model/);
      assert.equal(tool("outside", delegate, { target: {} }), null);
      for (const session of ["direct-manager", "outside"]) {
        assert.match(tool(session, schedule, {}).permissionDecisionReason, /New schedule_task calls/);
        assert.equal(tool(session, schedule, { scheduledTaskId: "s-1", enabled: false }), null);
      }
      assert.equal(JSON.parse(fs.readFileSync(stateFile("direct-manager"), "utf8")).count, 0);
    });

    test("Codex PR watches require an enrolled Manager under both T3 namespaces", () => {
      enrol("manager");
      prompt("manager");
      const target = { repository: "org/project", number: 1 };
      for (const watch of ["mcp__t3_code__watch_pull_request", "mcp__t3_code_direct__watch_pull_request"]) {
        assert.equal(tool("manager", watch, target), null);
        assert.equal(tool("outside", watch, target).permissionDecision, "deny");
        assert.equal(tool("manager", watch, target, { agent_id: "child" }).permissionDecision, "deny");
        assert.equal(tool("manager", watch, target, { agent_type: "worker" }).permissionDecision, "deny");
      }
    });

    test("Codex browsers require a current enrolled non-Worker Manager turn", () => {
      configureBrowser();
      enrol("personal", "bot", "browser-worker");
      const open = "mcp__t3_code_direct__preview_open";
      const status = "mcp__t3_code_direct__preview_status";
      const bot = { profileId: BOT, reuseExistingTab: false, url: BOT_URL };
      assert.equal(tool("personal", open).permissionDecision, "deny");
      prompt("personal");
      assert.equal(tool("personal", open), null);
      assert.match(tool("personal", open, bot).permissionDecisionReason, /current approved Manager turn/);
      prompt("bot", `${APPROVED}\n${BROWSER_TASK}`);
      assert.equal(tool("bot", open, bot), null);
      assert.match(tool("bot", "mcp__t3_code__preview_evaluate", {}).permissionDecisionReason, /Script evaluation/);
      assert.match(tool("bot", "mcp__t3_code__preview_navigate", { url: "https://outside.test/" }).permissionDecisionReason, /outside/);
      assert.equal(tool("bot", open, bot, { turn_id: "turn-2" }).permissionDecision, "deny");
      prompt("bot", "Continue without approval.", { turn_id: "turn-2" });
      assert.match(tool("bot", open, bot, { turn_id: "turn-2" }).permissionDecisionReason, /current approved Manager turn/);
      prompt("browser-worker", `Role: Worker\n${APPROVED}\n${BROWSER_TASK}`);
      prompt("outside", `${APPROVED}\n${BROWSER_TASK}`);
      for (const session of ["outside", "browser-worker"]) {
        assert.equal(tool(session, open, bot).permissionDecision, "deny");
        assert.equal(tool(session, status), null);
      }
      assert.equal(tool("personal", open, {}, { agent_id: "spawned" }).permissionDecision, "deny");
    });

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
      for (const tool_name of ["mcp__t3_code__watch_pull_request", "mcp__t3-code__watch_pull_request"]) {
        assert.equal(codex({ tool_name, tool_input: { repository: "org/project", number: 1 } }).permissionDecision, "deny");
      }
      assert.equal(codex({ tool_name: "Bash", tool_input: { command: "crontab -e" } }).permissionDecision, "deny");
      assert.equal(codex({ tool_name: "Bash", tool_input: { command: "make test" } }), null);
      // The Claude Manager loop stamps the role; Codex leaves delegation input unchanged.
      assert.equal(codex({ tool_name: "mcp__t3_code__delegate_task", tool_input: {
        target: { model: "gpt-6-luna" }, task: "Inspect.",
      } }), null);
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
      const help = codex({ tool_name: "Bash", tool_input: { command: "gh run watch --help" } });
      assert.equal(help.permissionDecision, "deny");
      const loop = codex({ tool_name: "Bash", tool_input: { command: "until test -f ready; do sleep 30; done" } });
      assert.equal(loop.permissionDecision, "deny");
      assert.equal(codex({ tool_name: "Bash", tool_input: { command: "gh run view 123 --log" } }), null);
      const result = run(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Proceed?" }), { args: codexArgs() });
      assert.equal(JSON.parse(result.stdout).decision, "block");
    });

    test("Codex Stop retries with the native question tool or Chief PM", () => {
      const result = run(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Proceed?" }), { args: codexArgs() });
      const stop = JSON.parse(result.stdout);
      assert.equal(stop.decision, "block");
      assert.match(stop.reason, /request_user_input/);
      assert.match(stop.reason, /Chief PM/);
      assert.doesNotMatch(stop.reason, /AskUserQuestion/);
    });
  });
});
