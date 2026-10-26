"""CI regression checks for the distributed Worker/Manager protocol."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / 'skills/orchestrate-harnesses'
sys.path.insert(0, str(SKILL / 'scripts'))
import harness as h


class WorkerProtocolTests(unittest.TestCase):
    def test_distributed_config_and_output_schema_share_all_tiers(self):
        models = json.loads((SKILL / 'models.json').read_text())
        spec = json.loads((SKILL / 'references/response.schema.json').read_text())
        h._validate_models(models, SKILL / 'models.json', models)
        self.assertEqual(set(models['roles']), {'manager', *h.TIERS})
        self.assertEqual(spec['properties']['worker_tier']['enum'], list(h.TIERS))
        result = dict(task_id='protocol', ack_message_ids=['original'], outcome='complete',
                      summary='done', findings=[], next_role='manager', worker_tier='luna',
                      decision='bounded', evidence=[])
        for tier in h.TIERS:
            h.schema(dict(result, worker_tier=tier), spec)
        for role in ('preflight', 'acceptance'):
            with self.assertRaises(h.Error):
                h.schema(dict(result, next_role=role), spec)
        self.assertEqual(models['max_context_tokens'], 300000)
        self.assertEqual(models['roles']['manager'], dict(cli='claude', model='claude-opus-5-5',
                                                         effort='medium', budget_usd=.75, timeout_s=180))

    def test_lower_context_and_claude_budgets_are_valid(self):
        models = json.loads((SKILL / 'models.json').read_text())
        lowered = json.loads(json.dumps(models))
        lowered['max_context_tokens'] = 100000
        for tier in ('haiku', 'sonnet', 'opus'):
            lowered['roles'][tier]['budget_usd'] = .10
        h._validate_models(lowered, 'fixture', models)
        for tier in ('haiku', 'sonnet', 'opus'):
            invalid = json.loads(json.dumps(models))
            invalid['roles'][tier]['budget_usd'] = h.HARD_MAX_BUDGET_USD + 1
            with self.assertRaisesRegex(h.Error, 'roles.' + tier + '.budget_usd'):
                h._validate_models(invalid, 'fixture', models)


if __name__ == '__main__':
    unittest.main()
