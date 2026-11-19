import json
from pathlib import Path
import subprocess
import sys
import unittest


HOOK = Path(__file__).resolve().parents[1] / "skills/orchestrate-harnesses/scripts/policy-hook"


class PolicyHookTests(unittest.TestCase):
    def invoke(self, payload):
        result = subprocess.run([sys.executable, "-I", str(HOOK)], input=payload,
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
