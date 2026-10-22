"""CI-only stdlib control tests. Fake CLIs do NOT validate installed CLI flags."""
import contextlib
import datetime
import importlib.util
import json
import itertools
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('harness.py')
spec = importlib.util.spec_from_file_location('harness', SOURCE)
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def _control_when_free(task, action, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        try:
            return h.control(task, action)
        except h.Error as error:
            if 'task busy' not in str(error) or time.monotonic() >= deadline:
                raise
            remaining = deadline - time.monotonic()
            time.sleep(min(.05, max(0, remaining)))


FAKE = r'''
import json, os, pathlib, signal, subprocess, sys, time
p = json.load(sys.stdin)
role = os.environ['HARNESS_ROLE']
mode = os.environ.get('FAKE_MODE', '')
with open(os.environ['FAKE_CALLS'], 'a') as f:
    f.write(json.dumps({'args': sys.argv[1:], 'role': role, 'prompt': p}) + '\n')
if mode == 'hang':
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if os.environ.get('FAKE_DESCENDANT'):
        subprocess.Popen([sys.executable, '-c', 'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
    while True:
        time.sleep(.1)
if mode == 'flood':
    while True:
        os.write(1, b'x' * 8192)
if mode == 'wait':
    while not pathlib.Path(os.environ['FAKE_RELEASE']).exists():
        time.sleep(.05)
r = dict(task_id=p['task_id'], ack_message_ids=p['message_ids'],
         outcome={'worker':'complete','manager':'plan','acceptance':'pass','preflight':'pass'}[role],
         summary='fake result', findings=[], next_role='worker' if role == 'manager' else 'manager',
         worker_tier='luna', decision='bounded fake plan', evidence=[])
if mode == 'badack':
    r['ack_message_ids'] = []
if mode == 'selfaccept':
    r['outcome'] = 'accepted'
if mode == 'accept' and role == 'manager':
    r['outcome'] = 'accepted'
if mode in ('sol', 'sol-denied'):
    r['worker_tier'] = 'sol'
    r['decision'] = ('SOL_USAGE_UNKNOWN_BOUNDED_EXCEPTION: missing usage; subtle invariants'
                     if mode == 'sol' else 'No exception: this is unbounded; do not dispatch')
if mode == 'escalate':
    r['decision'] = 'explicit Manager escalation after rework limit'
if mode == 'verdictfail':
    r['outcome'] = 'fail'
if role == 'worker':
    print(json.dumps({'type':'thread.started','thread_id':'owned-worker-thread'}))
    result = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
    result.write_text(json.dumps(r))
    if mode == 'traceerror':
        print(json.dumps({'type':'turn.failed','error':'fake failure'}))
    print(json.dumps({'type':'turn.completed','usage':{'input_tokens':10,'output_tokens':5}}))
else:
    out = dict(type='result', subtype='success', is_error=False, session_id='owned-' + role,
               structured_output=r, model='fake-actual-model', total_cost_usd=.01)
    if mode == 'budget':
        out['subtype'] = 'error_max_budget_usd'
    if mode == 'denied':
        out['permission_denials'] = [{'tool_name':'Read'}]
    print(json.dumps(out))
'''


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / 'skill'
        (self.base / 'scripts').mkdir(parents=True)
        # Exercise the shipped schemas and model config rather than alternate test schemas.
        shutil.copytree(SOURCE.parent.parent / 'references', self.base / 'references')
        shutil.copyfile(SOURCE.parent.parent / 'models.json', self.base / 'models.json')
        self.script = self.base / 'scripts/harness.py'
        shutil.copyfile(SOURCE, self.script)
        self.home = self.root / 'home'
        (self.home / '.codex').mkdir(parents=True)
        (self.home / '.codex/AGENTS.md').write_text('# Thermal protection\nCanonical thermal sentinel; no CPU checks.\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('codex', 'claude'):
            path = self.bin / name
            path.write_text('#!' + sys.executable + '\n' + FAKE)
            path.chmod(0o700)
        self.env = dict(os.environ, HOME=str(self.home), HARNESS_STATE_HOME=str(self.root / 'state'),
                        PATH=str(self.bin) + os.pathsep + os.environ.get('PATH', ''),
                        FAKE_CALLS=str(self.root / 'calls.jsonl'))
        for key in ('HARNESS_ROLE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'FAKE_MODE', 'FAKE_DESCENDANT'):
            self.env.pop(key, None)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, self.env, clear=True).start()
        patch.object(h, 'BASE', self.base).start()
        patch.object(h.Path, 'home', return_value=self.home).start()
        self.old_umask = os.umask(0o077)
        self.addCleanup(os.umask, self.old_umask)
        self.original = self.root / 'original.txt'
        self.original.write_bytes('原始请求\r\nexact bytes\n'.encode())
        self.contract_file = self.root / 'contract.json'
        self.contract = dict(version=1, cwd=str(self.root), objective='bounded fake task', complexity='simple',
                             allowed_paths=['target.py'], acceptance_criteria=['observable result'],
                             authorization=dict(implementation=True, commit=False, push=False, merge=False, deploy=False, publish=False),
                             read_only=True, verification=dict(ci_required=False, evidence_files=[], exemption_reason='CI-only fake control test'),
                             source=dict(kind='user_message', reference='test attachment'))
        self.contract_file.write_text(json.dumps(self.contract))
        self.task = h.Task('task')
        h.create(self.task, self.original, self.contract_file)
        self.scenario_number = 0

    def scenario(self, **changes):
        """A new intake for changed criteria; never alter/rehash a stored contract."""
        self.scenario_number += 1
        self.contract = dict(self.contract, **changes)
        self.contract_file.write_text(json.dumps(self.contract))
        self.task = h.Task('scenario' + str(self.scenario_number))
        h.create(self.task, self.original, self.contract_file)

    def calls(self):
        path = Path(os.environ['FAKE_CALLS'])
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_role(self, role='worker', request='r1', mode='', **kwargs):
        with patch.dict(os.environ, {'FAKE_MODE': mode}):
            return h.run(self.task, role, request, **kwargs)

    def cli(self, *args, env=None):
        return subprocess.run([sys.executable, str(self.script), *args], env=env or os.environ.copy(),
                              stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10)

    def until(self, predicate, seconds=5):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                if predicate():
                    return
            except (h.Error, FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(.05)
        self.fail('bounded condition did not settle')

    @contextlib.contextmanager
    def controller(self, request='active', mode='hang'):
        env = dict(os.environ, FAKE_MODE=mode)
        process = subprocess.Popen([sys.executable, str(self.script), 'run', self.task.id, 'worker', '--request-id', request],
                                   env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.until(lambda: self.task.get()['active'] and self.task.get()['active'].get('child_pid'))
            yield process
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=6)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=2)
            active = self.task.get()['active']
            if active and active.get('child_pid'):
                # Only test-owned identity, even in test cleanup.
                if h.identity(active['child_pid'], active['child_start'], active['child_boot_id']):
                    h.stop_group(active)

    def test_original_bytes_create_and_message_idempotency(self):
        self.assertEqual((self.task.path / 'original.bin').read_bytes(), self.original.read_bytes())
        h.create(self.task, self.original, self.contract_file)
        self.original.write_text('different')
        with self.assertRaises(h.Error):
            h.create(self.task, self.original, self.contract_file)
        msg = self.root / 'amendment'
        msg.write_bytes(b'keep\r\nbytes')
        first = h.add_message(self.task, 'm1', msg, 'correlation')
        self.assertEqual(first, h.add_message(self.task, 'm1', msg, 'correlation'))
        self.assertEqual(first['delivery_status'], 'queued')
        self.assertEqual(first['acknowledgements'], {})
        msg.write_text('divergent')
        with self.assertRaises(h.Error):
            h.add_message(self.task, 'm1', msg, 'correlation')
        self.assertEqual((self.task.path / 'message-m1.bin').read_bytes(), b'keep\r\nbytes')

    def test_run_idempotency_acks_and_no_fake_parent(self):
        record = self.run_role()
        self.assertEqual(record['execution_status'], 'completed')
        self.assertEqual(self.run_role(), record)
        self.assertEqual(len(self.calls()), 1)
        with self.assertRaises(h.Error):
            self.run_role(tier='luna')
        message = self.task.get()['messages'][0]
        self.assertIn('worker', message['acknowledgements'])
        prompt = self.calls()[0]['prompt']
        self.assertEqual(prompt['user_messages'][0]['payload'], self.original.read_bytes().decode())
        self.assertIn('Canonical thermal sentinel', prompt['thermal_verbatim'])
        self.assertNotIn('canonical_instructions', prompt)
        self.assertNotIn('parent_marker', prompt)
        self.assertEqual(record['actual']['session_id'], 'owned-worker-thread')
        self.assertEqual(record['actual']['usage']['input_tokens'], 10)
        self.assertEqual(record['requested_effort'], h.load(self.base / 'models.json')['roles']['luna']['effort'])

    def test_invalid_and_error_outputs_never_ack(self):
        for index, (role, mode) in enumerate([('worker', 'badack'), ('worker', 'selfaccept'),
                                             ('worker', 'traceerror'), ('preflight', 'budget'), ('acceptance', 'denied')]):
            record = self.run_role(role, 'bad' + str(index), mode)
            self.assertEqual(record['execution_status'], 'failed')
            self.assertFalse(self.task.get()['messages'][0]['acknowledgements'])
        self.assertEqual(len(self.calls()), 5)

    def test_manager_routing_scope_and_owned_resume_arguments(self):
        self.scenario(complexity='complex')
        with self.assertRaises(h.Error):
            self.run_role()
        self.run_role('manager', 'plan', 'sol')
        with self.assertRaises(h.Error):
            self.run_role(request='wrong-tier', tier='luna')
        self.run_role(request='implementation')
        self.run_role(request='continued', resume=True)
        args = self.calls()[-1]['args']
        self.assertLess(args.index('-m'), args.index('exec'))
        self.assertEqual(args[args.index('-s') + 1], 'read-only')
        self.assertEqual(args[args.index('resume') + 1], 'owned-worker-thread')
        self.assertEqual(args[args.index('-m') + 1], 'gpt-6.1-sol')
        with self.assertRaises(h.Error):
            self.run_role('acceptance', 'review-resume', resume=True)
        claude_args = self.calls()[0]['args']
        self.assertEqual(claude_args[claude_args.index('--tools') + 1], 'Read')
        self.assertNotIn('--bare', claude_args)
        self.assertIn('--no-daemon', args[:args.index('exec')])
        self.assertEqual(claude_args[claude_args.index('--mcp-config') + 1], '{"mcpServers":{}}')
        self.assertIn('--strict-mcp-config', claude_args)

    def test_rework_counter_requires_explicit_escalation(self):
        for i in range(3):
            self.run_role(request='work' + str(i))
        with self.assertRaises(h.Error):
            self.run_role(request='fourth')
        self.run_role('manager', 'escalation', 'escalate')
        self.run_role(request='fourth')
        self.assertEqual(self.task.get()['worker_runs'], 4)
        with self.assertRaises(h.Error):
            self.run_role(request='fifth')

    def test_acceptance_requires_review_and_new_message_stales_it(self):
        self.run_role()
        denied = self.run_role('manager', 'premature', 'accept')
        self.assertEqual(denied['execution_status'], 'failed')
        self.run_role('preflight', 'review')
        self.assertEqual(self.run_role('manager', 'deliver', 'accept')['execution_status'], 'completed')
        self.assertEqual(self.task.get()['status'], 'accepted')
        msg = self.root / 'new'
        msg.write_text('new requirement')
        h.add_message(self.task, 'new', msg, None)
        self.assertEqual(self.task.get()['status'], 'ready')
        self.assertEqual(self.run_role('manager', 'stale', 'accept')['execution_status'], 'failed')

    def test_failed_worker_invalidates_previous_review(self):
        self.run_role()
        self.run_role('preflight', 'review')
        self.run_role(request='badwork', mode='badack')
        self.assertEqual(self.run_role('manager', 'deliver', 'accept')['execution_status'], 'failed')

    def test_scope_and_safe_id_validation(self):
        for name in ('../escape', '/absolute', '.', '', 'a/b'):
            with self.assertRaises(h.Error):
                h.Task(name)
        for change in ({'allowed_paths': ['../escape']}, {'acceptance_criteria': [' ']},
                       {'read_only': False, 'authorization': dict(self.contract['authorization'], implementation=False)}):
            with self.assertRaises(h.Error):
                h.contract_check(dict(self.contract, **change))
        target = self.root / 'external'
        target.symlink_to('/tmp')
        with self.assertRaises(h.Error):
            h.contract_check(dict(self.contract, allowed_paths=['external/file']))

    def test_role_guard_allows_only_status(self):
        for role in h.ROLES:
            env = dict(os.environ, HARNESS_ROLE=role)
            self.assertEqual(self.cli('status', 'task', env=env).returncode, 0)
            self.assertEqual(self.cli('cancel', 'task', env=env).returncode, 1)
        self.assertEqual(self.task.get()['status'], 'ready')

    def test_pause_blocks_launch_and_resume_does_not_dispatch(self):
        h.control(self.task, 'pause')
        with self.assertRaises(h.Error):
            self.run_role()
        self.assertEqual(h.control(self.task, 'resume')['status'], 'ready')
        self.assertEqual(self.calls(), [])
        h.control(self.task, 'cancel')
        with self.assertRaises(h.Error):
            h.control(self.task, 'resume')
        with self.assertRaises(h.Error):
            self.run_role()

    def test_pause_and_cancel_stop_group_without_clearing_stop_state(self):
        for action in ('pause', 'cancel'):
            with self.controller(request=action) as process:
                active = self.task.get()['active']
                with self.assertRaises(h.Error) as error:
                    _control_when_free(self.task, 'recover')
                self.assertNotIn('task busy', str(error.exception))
                _control_when_free(self.task, action)
                if action == 'pause':
                    with self.assertRaises(h.Error) as error:
                        _control_when_free(self.task, 'resume')
                    self.assertNotIn('task busy', str(error.exception))
                process.communicate(timeout=6)
                state = self.task.get()
                self.assertIsNone(state['active'])
                self.assertEqual(state['status'], 'paused' if action == 'pause' else 'cancelled')
                self.assertFalse(h.group_alive(active['child_pid']))
                self.assertFalse(state['messages'][0]['acknowledgements'])
            if action == 'pause':
                _control_when_free(self.task, 'resume')

    def test_sigterm_controller_preserves_uncertainty(self):
        with self.controller() as process:
            process.terminate()
            process.communicate(timeout=6)
            state = self.task.get()
            self.assertIsNone(state['active'])
            self.assertEqual(state['requests']['active']['execution_status'], 'uncertain')
            self.assertEqual(state['status'], 'blocked')

    def test_recover_abandoned_controller_never_replays(self):
        with self.controller() as process:
            process.kill()
            process.communicate(timeout=2)
            state = h.control(self.task, 'recover')
            self.assertIsNone(state['active'])
            self.assertEqual(state['requests']['active']['execution_status'], 'uncertain')
            before = len(self.calls())
            self.assertEqual(self.run_role(request='active')['execution_status'], 'uncertain')
            self.assertEqual(len(self.calls()), before)

    def lease(self, counted=False):
        state = self.task.get()
        record = dict(role='worker', request_id='uncertain', message_ids=['original'], sequence=1,
                      input=dict(role='worker', tier=None, resume_session=False, message_ids=['original']),
                      execution_status='starting', worker_counted=counted)
        state['requests']['uncertain'] = record
        state['worker_runs'] = int(counted)
        state['active'] = dict(controller_pid=99999999, controller_start='1', controller_boot_id='boot',
                               child_pid=99999998, child_start='2', child_boot_id='boot', request_id='uncertain')
        state['status'] = 'running'
        self.task.save(state)
        return state['active']

    def test_reused_pid_is_gone_and_never_signalled(self):
        active = self.lease()
        unrelated = dict(start='different', group=active['child_pid'], session=active['child_pid'], state='S')
        with patch.object(h, 'boot_id', return_value='boot'), patch.object(h, 'proc', return_value=unrelated), \
             patch.object(h, 'group_alive', return_value=True), patch.object(h.os, 'killpg') as kill:
            self.assertIsNone(h.identity(active['child_pid'], '2', 'boot'))
            with self.assertRaises(h.Error):
                h.control(self.task, 'recover')
            kill.assert_not_called()
        self.assertIsNotNone(self.task.get()['active'])

    def test_new_boot_never_signals_current_pid_or_group(self):
        self.lease()
        with patch.object(h, 'boot_id', return_value='new-boot'), patch.object(h.os, 'killpg') as kill:
            state = h.control(self.task, 'recover')
            kill.assert_not_called()
        self.assertIsNone(state['active'])
        self.assertEqual(state['requests']['uncertain']['execution_status'], 'uncertain')

    def test_terminal_abandonment_counts_once_and_never_replays(self):
        for counted in (False, True):
            self.scenario()
            self.lease(counted)
            state = self.task.get()
            state['active']['child_start'] = None
            self.task.save(state)
            with patch.object(h, 'boot_id', return_value='boot'), patch.object(h, 'proc', return_value=None), patch.object(h.os, 'killpg') as kill:
                with self.assertRaises(h.Error):
                    h.control(self.task, 'recover')
                state = h.control(self.task, 'recover', abandon=True)
                kill.assert_not_called()
            self.assertEqual(state['status'], 'abandoned')
            self.assertEqual(state['worker_runs'], 1)
            self.assertFalse(state['termination_confirmed'])
            self.assertIn('possible_orphan', state['requests']['uncertain'])
            self.assertEqual(h.control(self.task, 'recover', abandon=True)['worker_runs'], 1)
            for action in ('pause', 'resume', 'cancel'):
                with self.assertRaises(h.Error):
                    h.control(self.task, action)
            with self.assertRaises(h.Error):
                self.run_role(request='new')
            self.assertEqual(self.run_role(request='uncertain')['execution_status'], 'uncertain')
            self.assertEqual(self.calls(), [])

    def test_start_failure_clears_lease_and_timeout_does_not_ack(self):
        with patch.object(h.subprocess, 'Popen', side_effect=FileNotFoundError('missing CLI')):
            record = self.run_role()
        self.assertEqual(record['execution_status'], 'failed')
        self.assertIsNone(self.task.get()['active'])
        models = h.load(self.base / 'models.json')
        models['roles']['luna']['timeout_s'] = .2
        h.atomic(self.base / 'models.json', h.encoded(models))
        record = self.run_role(request='timeout', mode='hang')
        self.assertEqual(record['error'], 'timeout')
        self.assertFalse(self.task.get()['messages'][0]['acknowledgements'])

    def test_runaway_trace_is_bounded_and_never_acknowledged(self):
        models = h.load(self.base / 'models.json')
        models['max_log_bytes'] = 16384
        h.atomic(self.base / 'models.json', h.encoded(models))
        record = self.run_role(mode='flood')
        self.assertEqual(record['error'], 'output cap exceeded')
        self.assertLessEqual(Path(record['artifacts']['stdout']).stat().st_size, 16384)
        self.assertIsNone(self.task.get()['active'])
        self.assertFalse(self.task.get()['messages'][0]['acknowledgements'])

    def test_message_during_inference_remains_queued_until_next_run(self):
        release = self.root / 'release'
        with patch.dict(os.environ, {'FAKE_RELEASE': str(release)}):
            with self.controller(mode='wait') as process:
                self.until(lambda: bool(self.calls()))
                message = self.root / 'followup'
                message.write_text('additional user requirement')
                h.add_message(self.task, 'during', message, None)
                release.touch()
                process.communicate(timeout=5)
        state = self.task.get()
        self.assertIn('worker', state['messages'][0]['acknowledgements'])
        self.assertEqual(state['messages'][1]['delivery_status'], 'queued')
        self.assertFalse(state['messages'][1]['acknowledgements'])
        self.run_role(request='next')
        self.assertIn('worker', self.task.get()['messages'][1]['acknowledgements'])

    def test_ci_gate_and_normal_tasks_require_acceptance(self):
        self.scenario(complexity='normal', verification=dict(ci_required=True, evidence_files=[], exemption_reason=''))
        self.run_role('manager', 'plan')
        self.run_role()
        self.run_role('preflight', 'cheap')
        self.assertEqual(self.run_role('manager', 'cheap-delivery', 'accept')['execution_status'], 'failed')
        self.run_role('acceptance', 'independent')
        self.assertEqual(self.run_role('manager', 'missing-ci', 'accept')['execution_status'], 'failed')
        self.assertNotEqual(self.task.get()['status'], 'accepted')

    def test_lock_is_nonblocking(self):
        with self.task.lock():
            with self.assertRaisesRegex(h.Error, 'task busy'):
                h.control(self.task, 'pause')

    def test_intake_hashes_reject_tampered_bytes_and_state_copies(self):
        for kind in ('original', 'contract', 'amendment', 'payload', 'contract_payload', 'missing_hash'):
            with self.subTest(kind=kind):
                self.scenario()
                if kind == 'amendment':
                    amendment = self.root / 'amendment'
                    amendment.write_bytes(b'original amendment\xff\r\n')
                    h.add_message(self.task, 'm1', amendment, None)
                if kind in ('original', 'contract', 'amendment'):
                    name = {'original': 'original.bin', 'contract': 'contract.json', 'amendment': 'message-m1.bin'}[kind]
                    path = self.task.path / name
                    h.atomic(path, path.read_bytes() + b'\n')  # Same parsed contract still must fail.
                else:
                    state = self.task.get()
                    if kind == 'payload':
                        state['messages'][0]['payload'] = 'forged user request'
                    elif kind == 'contract_payload':
                        state['contract_payload'] += '\n'
                    else:
                        del state['immutable_hashes']['original.bin']
                    self.task.save(state)
                with self.assertRaises(h.Error):
                    self.run_role()
                self.assertIsNone(self.task.get()['active'])
        self.assertEqual(self.calls(), [])

    def test_non_utf8_original_round_trips_without_rewriting(self):
        raw = b'\xff\x00original\r\n'
        self.original.write_bytes(raw)
        self.scenario()
        self.run_role()
        self.assertEqual(self.calls()[0]['prompt']['user_messages'][0]['payload'], h.payload(raw))
        self.assertEqual((self.task.path / 'original.bin').read_bytes(), raw)

    def test_per_recipient_failure_preserves_acknowledgement_history(self):
        self.run_role()
        self.run_role('acceptance', 'bad-review', 'badack')
        message = self.task.get()['messages'][0]
        self.assertEqual(message['delivery_status'], 'partially_acknowledged')
        self.assertEqual(message['execution_status'], 'partial')
        self.assertEqual(message['submissions']['worker']['execution_status'], 'completed')
        self.assertEqual(message['submissions']['acceptance']['execution_status'], 'failed')
        self.assertEqual(set(message['acknowledgements']), {'worker'})
        self.run_role(request='failed-retry', mode='badack')
        message = self.task.get()['messages'][0]
        self.assertEqual(message['submissions']['worker']['execution_status'], 'failed')
        self.assertEqual(message['acknowledgements']['worker']['request_id'], 'r1')
        self.assertEqual(len(message['acknowledgement_history']), 1)

    def test_valid_failed_verdict_is_not_acknowledged(self):
        record = self.run_role('acceptance', 'negative', 'verdictfail')
        self.assertEqual(record['result']['outcome'], 'fail')
        self.assertFalse(self.task.get()['messages'][0]['acknowledgements'])
        self.assertEqual(self.task.get()['messages'][0]['submissions']['acceptance']['execution_status'], 'fail')

    def test_aggregate_ack_requires_all_declared_recipients(self):
        for role in h.ROLES:
            self.run_role(role, 'ack-' + role)
        message = self.task.get()['messages'][0]
        self.assertEqual(message['delivery_status'], 'acknowledged')
        self.assertEqual(message['execution_status'], 'completed')
        self.run_role('preflight', 'later-failure', 'budget')
        message = self.task.get()['messages'][0]
        self.assertEqual(message['delivery_status'], 'acknowledged')
        self.assertEqual(message['execution_status'], 'partial')
        self.assertEqual(len(message['acknowledgement_history']), 4)

    def test_launch_and_registration_are_serialized_against_cancel(self):
        actual = subprocess.Popen
        def launch(*args, **kwargs):
            state = self.task.get()
            self.assertIsNotNone(state['active'])
            self.assertIsNone(state['active']['child_pid'])
            with self.assertRaisesRegex(h.Error, 'task busy'):
                h.control(self.task, 'cancel')
            return actual(*args, **kwargs)
        with patch.object(h.subprocess, 'Popen', side_effect=launch):
            self.assertEqual(self.run_role()['execution_status'], 'completed')

    def test_sighup_is_stopped_and_recorded_as_uncertain(self):
        with self.controller() as process:
            process.send_signal(signal.SIGHUP)
            process.communicate(timeout=6)
            state = self.task.get()
            self.assertIsNone(state['active'])
            self.assertEqual(state['requests']['active']['execution_status'], 'uncertain')
            self.assertTrue(state['requests']['active']['termination_confirmed'])

    def test_shutdown_final_branch_reaps_leader_without_proc_corpus(self):
        active = self.lease()
        info = dict(start='2', group=active['child_pid'], session=active['child_pid'], state='S')
        child = unittest.mock.Mock()
        with patch.object(h, 'boot_id', return_value='boot'), patch.object(h, 'proc', return_value=info), \
             patch.object(h.os, 'killpg') as kill, patch.object(h, 'group_alive', return_value=False), \
             patch.object(h.time, 'monotonic', side_effect=[0, 3, 4, 6]), \
             patch.object(h.Path, 'iterdir', side_effect=AssertionError('forbidden corpus scan')):
            self.assertTrue(h.stop_group(active, child))
        child.wait.assert_called_once_with(timeout=.1)
        self.assertEqual([call.args[1] for call in kill.call_args_list], [signal.SIGTERM, signal.SIGKILL])

    def test_orphan_or_zombie_group_remains_unverified(self):
        active = self.lease()
        info = dict(start='2', group=active['child_pid'], session=active['child_pid'], state='Z')
        with patch.object(h, 'boot_id', return_value='boot'), patch.object(h, 'proc', return_value=info), \
             patch.object(h.os, 'killpg'), patch.object(h, 'group_alive', return_value=True), \
             patch.object(h.time, 'sleep'), patch.object(h.time, 'monotonic', side_effect=itertools.count()):
            self.assertFalse(h.stop_group(active, unittest.mock.Mock()))

    def test_configured_rework_limit_and_one_escalation_per_extra_dispatch(self):
        models = h.load(self.base / 'models.json')
        models['max_auto_rework'] = 0
        h.atomic(self.base / 'models.json', h.encoded(models))
        self.run_role('manager', 'initial-plan')
        self.run_role()
        with self.assertRaises(h.Error):
            self.run_role(request='extra')  # The plan before this Worker is stale for escalation.
        self.run_role('manager', 'fresh-dispatch-decision')
        self.run_role(request='extra')  # Structured plan + next_role=worker is the explicit decision.
        with self.assertRaises(h.Error):
            self.run_role(request='another')
        self.assertEqual(self.task.get()['worker_runs'], 2)

    def test_fresh_sol_brake_cannot_be_excepted_but_stale_usage_can(self):
        models = h.load(self.base / 'models.json')
        models['sol_weekly_brake_percent'] = 40
        h.atomic(self.base / 'models.json', h.encoded(models))
        observed = datetime.datetime.now(datetime.timezone.utc)
        self.scenario(complexity='complex', sol_usage=dict(weekly_percent=40, observed_at=observed.isoformat()))
        self.run_role('manager', 'plan', 'sol')
        with self.assertRaisesRegex(h.Error, 'weekly brake'):
            self.run_role()
        self.scenario(sol_usage=dict(weekly_percent=90, observed_at=(observed - datetime.timedelta(days=1)).isoformat()))
        self.run_role('manager', 'plan', 'sol')
        self.assertEqual(self.run_role()['execution_status'], 'completed')

    def test_unknown_sol_requires_exact_positive_exception_marker(self):
        self.scenario(complexity='complex')
        self.run_role('manager', 'denied-plan', 'sol-denied')
        with self.assertRaisesRegex(h.Error, 'exception marker'):
            self.run_role()
        self.assertEqual(self.task.get()['worker_runs'], 0)
        self.run_role('manager', 'approved-plan', 'sol')
        self.assertEqual(self.run_role()['execution_status'], 'completed')


if __name__ == '__main__':
    unittest.main()
