import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { workerBundle } from "../skills/workbench-setup/scripts/workbench.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "skills/orchestrate-harnesses/scripts/policy-hook");
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
    bundle = workerBundle(path.join(ROOT, "skills/orchestrate-harnesses/workers.yml"));
    fs.writeFileSync(workers, JSON.stringify(bundle));
  });

  function run(payload, { env, args = ["--workers", workers] } = {}) {
    const result = spawnSync(process.execPath, [HOOK, ...args], { input: payload, encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result;
  }

  const invoke = (payload, env) => {
    const result = run(payload, { env });
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
  };

  const invokeStop = (event) => {
    const result = run(JSON.stringify(event), { args: [] });
    return result.stdout ? JSON.parse(result.stdout) : null;
  };

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
    assert.deepEqual(first.updatedInput, {
      threadId: "peer", mode: "auto",
      message: `Done.\n\n-- WB_MSG from=env-1/${thread} kind=result id=74859825:1 re=89effeb3:2`,
    });
    const second = send("Decided.\n\n-- WB_MSG kind=decision", env);
    assert.equal(second.updatedInput.message,
      `Decided.\n\n-- WB_MSG from=env-1/${thread} kind=decision id=74859825:2 re=none`);
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
    const invokePost = (agentType, resolvedModel, models = [resolvedModel]) => {
      fs.writeFileSync(workerTranscript, models.map((model) => JSON.stringify({
        type: "assistant", message: { model },
      })).join("\n") + "\n");
      return invoke(JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Agent", transcript_path: transcript, cwd: directory,
        tool_response: { status: "completed", agentId: "worker-1", agentType, resolvedModel },
      }));
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

  test("opus requires approval", () => {
    for (const tool of ["Agent", "Task"]) {
      const decision = invoke(JSON.stringify({
        tool_name: tool, tool_input: { subagent_type: "opus" }, agent_id: "worker", agent_type: "sol",
      }));
      assert.equal(decision.hookEventName, "PreToolUse");
      assert.equal(decision.permissionDecision, "ask");
      assert.equal(decision.permissionDecisionReason,
        "Worker opus at level L3 needs the user's approval for this task (configured Worker ladder).");
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
      assert.equal(result.permissionDecision, "ask");
      assert.match(result.permissionDecisionReason, /expert/);
      payload.cwd = path.dirname(work);
      assert.equal(invoke(JSON.stringify(payload)), null);
      payload.cwd = work;
      payload.tool_input.subagent_type = "opus";
      result = invoke(JSON.stringify(payload));
      assert.equal(result.permissionDecision, "ask");
      assert.match(result.permissionDecisionReason, /not in the ladder/);
      payload.tool_input.subagent_type = "terra";
      assert.equal(invoke(JSON.stringify(payload)), null);
    }
    bundle.profile = "corporate";
    fs.writeFileSync(workers, JSON.stringify(bundle));
    assert.equal(invoke(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "sol" } })).permissionDecision, "ask");
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
      assert.equal(decision.permissionDecision, "ask");
      assert.equal(decision.permissionDecisionReason,
        "L3 Opus Worker needs the user's approval for this task (orchestrate-harnesses Worker ladder).");
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
    for (const command of ["git worktree add /tmp/test-tree main", "git worktree add /tmp/test-tree master",
      "git push origin main", "git push origin HEAD:main",
      "git push origin x:refs/heads/main", "git push -f origin main"]) {
      assertProtected(command);
    }
    for (const command of ["git worktree add -b x /tmp/test-tree main", "git push origin feature",
      "git push -u origin HEAD"]) {
      assertAllowed(command);
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
      "while true\ndo\ngh run list\nsleep 10\ndone",
    ]) {
      const decision = invoke(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
      assert.equal(decision?.permissionDecision, "deny", command);
      assert.match(decision.permissionDecisionReason, /watch_pull_request/);
      assert.match(decision.permissionDecisionReason, /GitHub API budget/);
    }
  });

  test("single reads and unrelated commands are allowed", () => {
    for (const command of [
      "gh pr view 1 --json headRefOid,statusCheckRollup",
      "gh run list --commit abc --json workflowName,event,status",
      "gh api rate_limit", "gh pr checks 1", "sleep 10",
      "while true; do date; sleep 10; done",
      "for attempt in 1 2; do gh run list; done",
      "echo 'gh run watch 123'", "echo gh run watch 123",
      "gh run list; while true; do date; sleep 10; done",
      "sleep 10; for attempt in 1 2; do gh run list; done",
      "echo while do sleep gh", "echo 'for x; do sleep 1; gh run list; done'",
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
        assert.match(result.updatedInput.message, /^Hi\.\n\n-- WB_MSG from=env-1\/.* kind=request id=74859825:\d+ re=none$/);
      }
    });

    test("delegate_task requires a model under the sanitized name", () => {
      const decision = codex({ tool_name: "mcp__t3_code__delegate_task", tool_input: { target: {} } });
      assert.equal(decision.permissionDecision, "deny");
      assert.equal(codex({
        tool_name: "mcp__t3_code__delegate_task", tool_input: { target: { model: "gpt-6-luna" } },
      }), null);
    });

    test("spawn_agent approval rules become deny", () => {
      const byType = codex({ tool_name: "spawn_agent", tool_input: { agent_type: "opus", message: "x" } });
      assert.equal(byType.permissionDecision, "deny");
      assert.match(byType.permissionDecisionReason, /^Worker opus at level L3 needs the user's approval/);
      assert.match(byType.permissionDecisionReason, /Get the user's approval, then retry\.$/);
      const byModel = codex({ tool_name: "spawn_agent", tool_input: { model: "opus" } });
      assert.equal(byModel.permissionDecision, "deny");
      assert.match(byModel.permissionDecisionReason, /Opus Worker needs the user's approval/);
    });

    test("spawn_agent of an unknown type or an L1 tier passes through", () => {
      assert.equal(codex({ tool_name: "spawn_agent", tool_input: { message: "x" } }), null);
      assert.equal(codex({ tool_name: "spawn_agent", tool_input: { agent_type: "haiku", model: "claude-haiku-5-5" } }), null);
    });

    test("Claude host keeps ask and stamps without allow", () => {
      const ask = invoke(JSON.stringify({ tool_name: "spawn_agent", tool_input: { agent_type: "opus" } }));
      assert.equal(ask.permissionDecision, "ask");
    });

    test("Bash rules and Stop still apply", () => {
      const deny = codex({ tool_name: "Bash", tool_input: { command: "gh run watch 1" } });
      assert.equal(deny.permissionDecision, "deny");
      const result = run(JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Proceed?" }), { args: codexArgs() });
      assert.equal(JSON.parse(result.stdout).decision, "block");
    });
  });
});
