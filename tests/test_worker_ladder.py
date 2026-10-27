"""Configuration contract for native Worker model selection."""
import json
import math
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODELS_PATH = ROOT / "skills/orchestrate-harnesses/models.json"
EXPECTED_WORKERS = {
    "luna": ("codex", "gpt-6-luna", "max"),
    "haiku": ("claude", "claude-haiku-5-5", "medium"),
    "terra": ("codex", "gpt-6.1-terra", "medium"),
    "sonnet": ("claude", "claude-sonnet-5-5", "medium"),
    "sol": ("codex", "gpt-6.1-sol", "high"),
    "opus": ("claude", "claude-opus-5-5", "medium"),
}


class WorkerConfigurationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.models = json.loads(MODELS_PATH.read_text(encoding="utf-8"))

    def test_worker_tiers_keep_the_distributed_models_and_efforts(self) -> None:
        roles = self.models["roles"]
        self.assertEqual(set(roles), set(EXPECTED_WORKERS))
        self.assertNotIn("manager", roles)
        self.assertNotIn("reviewer", roles)

        for tier, expected in EXPECTED_WORKERS.items():
            with self.subTest(tier=tier):
                role = roles[tier]
                cli = expected[0]
                self.assertEqual((role["cli"], role["model"], role["effort"]), expected)
                fields = {"cli", "model", "effort", "timeout_s"}
                if cli == "claude":
                    fields.add("budget_usd")
                    self.assertIsNone(role["budget_usd"])
                self.assertEqual(set(role), fields)
                self.assertIs(type(role["timeout_s"]), int)
                self.assertGreater(role["timeout_s"], 0)

    def test_shared_policy_fields_are_valid_configuration(self) -> None:
        self.assertEqual(
            set(self.models),
            {"version", "roles", "max_auto_rework", "sol_weekly_brake_percent", "max_context_tokens"},
        )
        self.assertEqual(self.models["version"], 1)
        self.assertIs(type(self.models["max_auto_rework"]), int)
        self.assertGreaterEqual(self.models["max_auto_rework"], 0)
        brake = self.models["sol_weekly_brake_percent"]
        self.assertTrue(type(brake) in (int, float) and math.isfinite(brake))
        self.assertGreater(brake, 0)
        self.assertLessEqual(brake, 100)
        self.assertIs(type(self.models["max_context_tokens"]), int)
        self.assertGreater(self.models["max_context_tokens"], 0)


if __name__ == "__main__":
    unittest.main()
