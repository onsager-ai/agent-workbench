import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HOOK = Path(__file__).resolve().parents[1] / "skills/orchestrate-harnesses/scripts/policy-hook"


class PolicyHookTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workers = Path(temporary.name) / "workers.json"
        root = HOOK.parents[3]
        spec = importlib.util.spec_from_file_location("hook_config", root / "skills/workbench-setup/scripts/workbench.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.bundle = module.worker_bundle(root / "skills/orchestrate-harnesses/workers.yml")
        self.workers.write_text(json.dumps(self.bundle))

    def invoke(self, payload):
        result = subprocess.run([sys.executable, "-I", str(HOOK), "--workers", str(self.workers)], input=payload,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)["hookSpecificOutput"] if result.stdout else None

    def test_opus_requires_approval(self):
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool):
                decision = self.invoke(json.dumps({"tool_name": tool,
                    "tool_input": {"subagent_type": "opus"}, "agent_id": "worker", "agent_type": "sol"}))
                self.assertEqual(decision["hookEventName"], "PreToolUse")
                self.assertEqual(decision["permissionDecision"], "ask")
                self.assertEqual(decision["permissionDecisionReason"],
                    "Worker opus at level L3 needs the user's approval for this task (configured Worker ladder).")

    def test_approval_uses_profile_and_event_cwd(self):
        work = self.workers.parent / "work"
        work.mkdir()
        alias = self.workers.parent / "alias"
        alias.symlink_to(work, target_is_directory=True)
        corporate = json.loads(json.dumps(self.bundle["profiles"]["codex"]))
        corporate["ladder"] = [{"level": "expert", "tiers": ["sol"], "approval": "required"}]
        self.bundle["profile"] = "codex"
        self.bundle["profiles"]["corporate"] = corporate
        self.bundle["select"] = [{"path": str(work), "profile": "corporate"}]
        self.workers.write_text(json.dumps(self.bundle))
        for tool in ("Agent", "Task"):
            payload = {"tool_name": tool, "cwd": str(alias / "nested"), "tool_input": {"subagent_type": "sol"}}
            result = self.invoke(json.dumps(payload))
            self.assertEqual(result["permissionDecision"], "ask")
            self.assertIn("expert", result["permissionDecisionReason"])
            payload["cwd"] = str(work.parent)
            self.assertIsNone(self.invoke(json.dumps(payload)))
            payload["cwd"] = str(work)
            payload["tool_input"]["subagent_type"] = "opus"
            result = self.invoke(json.dumps(payload))
            self.assertEqual(result["permissionDecision"], "ask")
            self.assertIn("not in the ladder", result["permissionDecisionReason"])
            payload["tool_input"]["subagent_type"] = "terra"
            self.assertIsNone(self.invoke(json.dumps(payload)))
        self.bundle["profile"] = "corporate"
        self.workers.write_text(json.dumps(self.bundle))
        self.assertEqual(self.invoke(json.dumps({"tool_name": "Agent", "tool_input": {"subagent_type": "sol"}}))["permissionDecision"], "ask")

    def test_missing_or_unreadable_workers_asks_on_every_dispatch(self):
        for content in (None, "invalid json", "{}"):
            if content is None:
                self.workers.unlink()
            else:
                self.workers.write_text(content)
            for tier in ("luna", "Plan", "custom"):
                result = self.invoke(json.dumps({"tool_name": "Agent", "tool_input": {"subagent_type": tier}}))
                self.assertEqual(result["permissionDecision"], "ask")
                self.assertIn("agent-workbench install", result["permissionDecisionReason"])
        self.workers.unlink()
        self.workers.mkdir()
        self.assertEqual(self.invoke(json.dumps({"tool_name": "Task", "tool_input": {}}))["permissionDecision"], "ask")

    def test_t3_delegate_requires_worker_model(self):
        for target in ({}, {"model": ""}, {"options": {"effort": "low"}}):
            with self.subTest(target=target):
                decision = self.invoke(json.dumps({"tool_name": "mcp__t3-code__delegate_task",
                                                   "tool_input": {"target": target}}))
                self.assertEqual(decision["permissionDecision"], "deny")
                self.assertIn("target.model", decision["permissionDecisionReason"])
                self.assertIn("effort in target.options", decision["permissionDecisionReason"])
        self.assertIsNone(self.invoke(json.dumps({"tool_name": "mcp__t3-code__delegate_task",
            "tool_input": {"target": {"model": "gpt-6-luna", "options": {"effort": "low"}}}})))

    def test_builtin_agents_cannot_inherit_manager_model(self):
        for tool in ("Agent", "Task"):
            for subagent_type in (None, "general-purpose", "Plan", "Explore", "claude"):
                with self.subTest(tool=tool, subagent_type=subagent_type):
                    tool_input = {} if subagent_type is None else {"subagent_type": subagent_type}
                    decision = self.invoke(json.dumps({"tool_name": tool, "tool_input": tool_input}))
                    self.assertEqual(decision["permissionDecision"], "deny")
                    self.assertIn("inherit the Manager's model", decision["permissionDecisionReason"])
                    self.assertIn("subagent_type: <role>", decision["permissionDecisionReason"])
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool, with_model=True):
                self.assertIsNone(self.invoke(json.dumps({"tool_name": tool,
                    "tool_input": {"subagent_type": "Plan", "model": "claude-sonnet-5-5"}})))

    def test_named_fork_and_custom_agents_pass_through(self):
        for subagent_type in ("fork", "sonnet", "custom-agent"):
            with self.subTest(subagent_type=subagent_type):
                self.assertIsNone(self.invoke(json.dumps({"tool_name": "Agent",
                    "tool_input": {"subagent_type": subagent_type}})))

    def test_opus_model_requires_approval(self):
        for tool in ("Agent", "Task"):
            with self.subTest(tool=tool):
                decision = self.invoke(json.dumps({"tool_name": tool,
                    "tool_input": {"subagent_type": "haiku", "model": "opus"}}))
                self.assertEqual(decision["permissionDecision"], "ask")
                self.assertEqual(decision["permissionDecisionReason"],
                    "L3 Opus Worker needs the user's approval for this task (orchestrate-harnesses Worker ladder).")

    def test_passthrough_and_malformed_input(self):
        for payload in (
            '{"tool_name":"Agent","tool_input":{"subagent_type":"sonnet"}}',
            '{"tool_name":"Read","tool_input":{"file_path":"anything"}}',
            "{invalid", "[]", "null", '{"tool_name":"Bash","tool_input":null}',
            '{"tool_name":"Bash","tool_input":{"command":42}}',
            json.dumps({"tool_name": "Bash", "tool_input": {"command": 'gh "'}}),
        ):
            with self.subTest(payload=payload):
                self.assertIsNone(self.invoke(payload))

    def invoke_stop(self, event):
        result = subprocess.run([sys.executable, "-I", str(HOOK)],
                                input=json.dumps(event), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout) if result.stdout else None

    def test_stop_blocks_question_from_last_assistant_message(self):
        result = self.invoke_stop({"hook_event_name": "Stop",
                                   "last_assistant_message": "Proceed with option A? **"})
        self.assertEqual(result["decision"], "block")
        self.assertIn("AskUserQuestion", result["reason"])
        self.assertIn("recommended option first", result["reason"])

    def test_stop_blocks_question_from_transcript_tail(self):
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "transcript.jsonl"
            transcript.write_text(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "text", "text": "Question?"}]}}) + "\n")
            result = self.invoke_stop({"hook_event_name": "Stop", "transcript_path": str(transcript)})
        self.assertEqual(result["decision"], "block")

    def test_stop_passes_active_no_question_and_malformed_input(self):
        for event in (
            {"hook_event_name": "Stop", "stop_hook_active": True, "last_assistant_message": "Question?"},
            {"hook_event_name": "Stop", "last_assistant_message": "Finished."},
            {"hook_event_name": "Stop", "transcript_path": "/missing/transcript"},
            {"hook_event_name": "Stop"},
        ):
            with self.subTest(event=event):
                self.assertIsNone(self.invoke_stop(event))
        result = subprocess.run([sys.executable, "-I", str(HOOK)], input="{bad",
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_polling_is_denied(self):
        for command in (
            "gh run watch 123", "gh pr checks 1 --watch", "gh pr checks --watch=true",
            "cd /tmp && gh run watch 123", "gh pr checks 1 --watch --interval 30",
            "while true; do gh run list; sleep 30; done",
            "until gh pr view 1; do sleep 10; done",
            "for attempt in 1 2 3; do sleep 10; gh api repos/o/r; done",
            "while true\ndo\ngh run list\nsleep 10\ndone",
        ):
            with self.subTest(command=command):
                decision = self.invoke(json.dumps({"tool_name": "Bash", "tool_input": {"command": command}}))
                self.assertEqual(decision["permissionDecision"], "deny")
                self.assertIn("watch_pull_request", decision["permissionDecisionReason"])
                self.assertIn("GitHub API budget", decision["permissionDecisionReason"])

    def test_single_reads_and_unrelated_commands_are_allowed(self):
        for command in (
            "gh pr view 1 --json headRefOid,statusCheckRollup",
            "gh run list --commit abc --json workflowName,event,status",
            "gh api rate_limit", "gh pr checks 1", "sleep 10",
            "while true; do date; sleep 10; done",
            "for attempt in 1 2; do gh run list; done",
            "echo 'gh run watch 123'", "echo gh run watch 123",
            "gh run list; while true; do date; sleep 10; done",
            "sleep 10; for attempt in 1 2; do gh run list; done",
            "echo while do sleep gh", "echo 'for x; do sleep 1; gh run list; done'",

        ):
            with self.subTest(command=command):
                self.assertIsNone(self.invoke(json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})))
