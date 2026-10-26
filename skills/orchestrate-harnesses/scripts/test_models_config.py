"""Isolated tests for per-user model configuration."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import harness as h


class ModelsConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'skill'
        self.base.mkdir()
        source = Path(h.__file__).resolve().parent.parent / 'models.json'
        (self.base / 'models.json').write_bytes(source.read_bytes())
        self.home = self.root / 'home'
        self.home.mkdir()
        self.xdg = self.root / 'xdg'
        self.xdg.mkdir()

    def config_path(self, root=None):
        return (self.xdg if root is None else Path(root)) / 'agent-workbench' / 'models.json'

    def write_config(self, value, root=None):
        path = self.config_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, allow_nan=True))
        return path

    def load(self, env=None):
        return h.load_effective_models(base=self.base, env=env or {}, home=self.home)

    def test_missing_config_preserves_distributed_defaults(self):
        defaults = json.loads((self.base / 'models.json').read_text())
        effective, source = self.load()
        self.assertEqual(effective, defaults)
        self.assertFalse(source['user_config_exists'])
        self.assertFalse(source['user_config_used'])
        self.assertEqual(source['user_config_path'], str(self.home / '.config/agent-workbench/models.json'))
        self.assertEqual(source['defaults_path'], str(self.base / 'models.json'))

    def test_partial_merge_changes_only_named_fields(self):
        self.write_config({'roles': {'sonnet': {'model': 'local-model', 'timeout_s': 45,
                                                'budget_usd': 1.25}}, 'max_prompt_bytes': 2048})
        effective, source = self.load({'XDG_CONFIG_HOME': str(self.xdg)})
        defaults = json.loads((self.base / 'models.json').read_text())
        expected = json.loads(json.dumps(defaults))
        expected['roles']['sonnet']['model'] = 'local-model'
        expected['roles']['sonnet']['timeout_s'] = 45
        expected['roles']['sonnet']['budget_usd'] = 1.25
        expected['max_prompt_bytes'] = 2048
        self.assertEqual(effective, expected)
        self.assertEqual(source['user_config_path'], str(self.config_path()))
        self.assertTrue(source['user_config_exists'])
        self.assertTrue(source['user_config_used'])

    def test_context_override_can_increase_or_decrease_the_default(self):
        for limit in (100000, 600000, 1000000):
            with self.subTest(limit=limit):
                self.write_config({'max_context_tokens': limit})
                effective, _ = self.load({'XDG_CONFIG_HOME': str(self.xdg)})
                self.assertEqual(effective['max_context_tokens'], limit)

    def test_fractional_values_and_zero_rework_preserve_controller_semantics(self):
        self.write_config({'roles': {'luna': {'timeout_s': 0.2}},
                           'sol_weekly_brake_percent': 55.5, 'max_auto_rework': 0})
        effective, _ = self.load({'XDG_CONFIG_HOME': str(self.xdg)})
        self.assertEqual(effective['roles']['luna']['timeout_s'], 0.2)
        self.assertEqual(effective['sol_weekly_brake_percent'], 55.5)
        self.assertEqual(effective['max_auto_rework'], 0)
        self.write_config({'max_auto_rework': 3})
        effective, _ = self.load({'XDG_CONFIG_HOME': str(self.xdg)})
        self.assertEqual(effective['max_auto_rework'], 3)

    def test_xdg_resolution_and_fallback(self):
        expected_fallback = self.home / '.config/agent-workbench/models.json'
        self.assertEqual(h.user_models_path({'XDG_CONFIG_HOME': str(self.xdg)}, self.home), self.config_path())
        for env in ({}, {'XDG_CONFIG_HOME': ''}, {'XDG_CONFIG_HOME': 'relative/config'}):
            with self.subTest(env=env):
                self.assertEqual(h.user_models_path(env, self.home), expected_fallback)

    def test_invalid_configs_report_path_and_field(self):
        cases = [
            ('malformed JSON', b'{', '<root>'),
            ('wrong root', b'[]', '<root>'),
            ('boolean is not a number', b'{"roles":{"sonnet":{"timeout_s":true}}}', 'roles.sonnet.timeout_s'),
            ('NaN constant', b'{"roles":{"sonnet":{"budget_usd":NaN}}}', 'roles.sonnet.budget_usd'),
            ('infinite number', b'{"roles":{"sonnet":{"timeout_s":1e999}}}', 'roles.sonnet.timeout_s'),
            ('zero timeout', b'{"roles":{"sonnet":{"timeout_s":0}}}', 'roles.sonnet.timeout_s'),
            ('negative timeout', b'{"roles":{"sonnet":{"timeout_s":-1}}}', 'roles.sonnet.timeout_s'),
            ('zero budget', b'{"roles":{"sonnet":{"budget_usd":0}}}', 'roles.sonnet.budget_usd'),
            ('negative budget', b'{"roles":{"sonnet":{"budget_usd":-1}}}', 'roles.sonnet.budget_usd'),
            ('unknown top-level key', b'{"extra":1}', 'extra'),
            ('unknown role', b'{"roles":{"reviewer":{}}}', 'roles.reviewer'),
            ('removed preflight role', b'{"roles":{"preflight":{}}}', 'roles.preflight'),
            ('removed acceptance role', b'{"roles":{"acceptance":{}}}', 'roles.acceptance'),
            ('removed manager role', b'{"roles":{"manager":{}}}', 'roles.manager'),
            ('unknown field', b'{"roles":{"sonnet":{"unknown":1}}}', 'roles.sonnet.unknown'),
            ('CLI routing is fixed', b'{"roles":{"sonnet":{"cli":"other"}}}', 'roles.sonnet.cli'),
            ('unsupported version', b'{"version":2}', 'version'),
            ('non-finite top-level value', b'{"sol_weekly_brake_percent":Infinity}', 'sol_weekly_brake_percent'),
            ('negative rework limit', b'{"max_auto_rework":-1}', 'max_auto_rework'),
            ('boolean rework limit', b'{"max_auto_rework":true}', 'max_auto_rework'),
            ('zero log limit', b'{"max_log_bytes":0}', 'max_log_bytes'),
            ('negative prompt limit', b'{"max_prompt_bytes":-1}', 'max_prompt_bytes'),
            ('above log ceiling', b'{"max_log_bytes":8388609}', 'max_log_bytes'),
            ('above prompt ceiling', b'{"max_prompt_bytes":262145}', 'max_prompt_bytes'),
            ('negative context', b'{"max_context_tokens":-1}', 'max_context_tokens'),
            ('zero context', b'{"max_context_tokens":0}', 'max_context_tokens'),
            ('fractional context', b'{"max_context_tokens":1.5}', 'max_context_tokens'),
            ('boolean context', b'{"max_context_tokens":true}', 'max_context_tokens'),
            ('above budget ceiling', b'{"roles":{"opus":{"budget_usd":10.01}}}', 'roles.opus.budget_usd'),
        ]
        for label, content, field in cases:
            with self.subTest(label=label):
                path = self.config_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                with self.assertRaises(h.Error) as caught:
                    self.load({'XDG_CONFIG_HOME': str(self.xdg)})
                self.assertIn(str(path), str(caught.exception))
                self.assertIn(field, str(caught.exception))

    def test_huge_integer_fields_fail_with_clear_path_and_field_errors(self):
        digits = b'9' * 400
        cases = [
            (b'{"roles":{"sonnet":{"budget_usd":' + digits + b'}}}', 'roles.sonnet.budget_usd'),
            (b'{"roles":{"sonnet":{"timeout_s":' + digits + b'}}}', 'roles.sonnet.timeout_s'),
        ]
        for content, field in cases:
            with self.subTest(field=field):
                path = self.config_path()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                with self.assertRaises(h.Error) as caught:
                    self.load({'XDG_CONFIG_HOME': str(self.xdg)})
                self.assertIn(str(path), str(caught.exception))
                self.assertIn(field, str(caught.exception))

    def test_cli_show_reports_sources_without_creating_task_state(self):
        self.write_config({'roles': {'sonnet': {'timeout_s': 55}}})
        state = self.root / 'state'
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(h, 'BASE', self.base), patch.dict(os.environ, {
                'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.xdg),
                'HARNESS_STATE_HOME': str(state)}, clear=True), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = h.main(['models', 'show'])
        self.assertEqual(status, 0, stderr.getvalue())
        output = json.loads(stdout.getvalue())
        self.assertEqual(output['defaults_path'], str(self.base / 'models.json'))
        self.assertEqual(output['user_config_path'], str(self.config_path()))
        self.assertTrue(output['user_config_exists'])
        self.assertTrue(output['user_config_used'])
        self.assertEqual(output['effective']['roles']['sonnet']['timeout_s'], 55)
        self.assertFalse(state.exists())

    def test_cli_show_fails_clearly_for_invalid_config(self):
        path = self.write_config({'roles': {'sonnet': {'timeout_s': True}}})
        state = self.root / 'state'
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(h, 'BASE', self.base), patch.dict(os.environ, {
                'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.xdg),
                'HARNESS_STATE_HOME': str(state)}, clear=True), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = h.main(['models', 'show'])
        self.assertEqual(status, 1)
        self.assertIn(str(path), stderr.getvalue())
        self.assertIn('roles.sonnet.timeout_s', stderr.getvalue())
        self.assertFalse(state.exists())

    def test_cli_show_rejects_huge_integer_without_traceback(self):
        digits = '9' * 400
        path = self.config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"roles":{"sonnet":{"budget_usd":' + digits + '}}}')
        state = self.root / 'state'
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(h, 'BASE', self.base), patch.dict(os.environ, {
                'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.xdg),
                'HARNESS_STATE_HOME': str(state)}, clear=True), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = h.main(['models', 'show'])
        self.assertEqual(status, 1)
        self.assertIn(str(path), stderr.getvalue())
        self.assertIn('roles.sonnet.budget_usd', stderr.getvalue())
        self.assertNotIn('Traceback', stderr.getvalue())
        self.assertFalse(state.exists())


if __name__ == '__main__':
    unittest.main()
