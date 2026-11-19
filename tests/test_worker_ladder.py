"""Distributed Worker configuration and schema validation contract."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("worker_config", ROOT / "skills/workbench-setup/scripts/workbench.py")
WORKBENCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKBENCH)
WORKERS = ROOT / "skills/orchestrate-harnesses/workers.yml"


class WorkerConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.bundle = WORKBENCH.worker_bundle(WORKERS)
        self.config = self.bundle["base"]

    def test_distributed_ladder_and_tiers(self):
        self.assertEqual([(entry["level"], entry["tiers"]) for entry in self.config["ladder"]],
                         [("L1", ["haiku"]), ("L2", ["sonnet"]), ("L3", ["opus"])])
        self.assertEqual(self.config["ladder"][1]["start_for"], ["spike", "research", "architecture"])
        self.assertEqual(self.config["ladder"][2]["approval"], "required")
        expected = {
            "haiku": ("claude", "claude-haiku-5-5", "medium"),
            "sonnet": ("claude", "claude-sonnet-5-5", "medium"),
            "opus": ("claude", "claude-opus-5-5", "medium"),
        }
        self.assertEqual(set(self.config["tiers"]), set(expected))
        for name, values in expected.items():
            tier = self.config["tiers"][name]
            self.assertEqual(tuple(tier[key] for key in ("harness", "model", "effort")), values)
            self.assertEqual(tier["timeout_s"], 7200)
            self.assertIsNone(tier["budget_usd"])
            self.assertFalse(tier["opt_in"])
        self.assertIsNone(self.config["policy"]["context"]["gateway_window"])
        codex = self.bundle["profiles"]["codex"]
        self.assertEqual(set(codex["tiers"]), {"haiku", "sonnet", "opus", "luna", "sol", "terra"})
        self.assertEqual([e["tiers"] for e in codex["ladder"]], [["luna", "haiku"], ["sol", "sonnet"], ["opus"]])
        for name, model in (("luna", "gpt-6-luna"), ("sol", "gpt-6.1-sol"), ("terra", "gpt-6.1-terra")):
            self.assertEqual(codex["tiers"][name]["harness"], "codex")
            self.assertEqual(codex["tiers"][name]["model"], model)
            self.assertIsNone(codex["tiers"][name]["claude_route"])
            self.assertEqual(codex["tiers"][name]["opt_in"], name == "terra")

    def test_schema_rejects_bad_resolved_values(self):
        mutations = [
            lambda c: c["tiers"]["luna"].update(timeout_s=True),
            lambda c: c["tiers"]["luna"].update(budget_usd=1),
            lambda c: c["tiers"]["sonnet"].update(budget_usd=float("inf")),
            lambda c: c["tiers"]["sonnet"].update(claude_route=None),
            lambda c: c["tiers"]["sol"].update(weekly_brake_percent=101),
            lambda c: c["tiers"]["sol"].update(opt_in=True),
            lambda c: c["ladder"][0]["tiers"].append("unknown"),
            lambda c: c["ladder"][1]["tiers"].append("luna"),
            lambda c: c["ladder"][1].update(level="L1"),
            lambda c: c["ladder"][0].update(approval="optional"),
            lambda c: c["policy"]["context"].update(max_tokens=0),
            lambda c: c["policy"].update(max_auto_rework=-1),
            lambda c: c["tiers"]["luna"].update(cli="codex"),
        ]
        for mutate in mutations:
            config = copy.deepcopy(self.bundle["profiles"]["codex"])
            mutate(config)
            with self.subTest(mutate=mutate), self.assertRaises(WORKBENCH.Conflict):
                WORKBENCH.resolve_worker_config(config)


if __name__ == "__main__":
    unittest.main()
