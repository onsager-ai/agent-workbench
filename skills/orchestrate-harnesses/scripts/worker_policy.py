"""Explicit Worker policy and bounded, owned no-inference app-server probe."""
import contextlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import time

ADAPTER = 'codex-cli-config-overrides'
MODES = ('read-only', 'workspace-write', 'danger-full-access')
APPROVALS = ('never', 'on-request')
CLAIM = ('startup execution under validated policy only; '
         'does not prove all filesystem/network/approval boundaries')
PROBE_TIMEOUT_S = 30


def policy_check(contract):
    """No inference, fallback, user-config authority or implicit writable roots."""
    def check(ok, detail):
        if not ok:
            raise ValueError('unsupported_policy: ' + detail)
    check(contract.get('version') == 2,
          'worker permissions evidence missing or unsupported; create a v2 task')
    forbidden = {'profile', 'profiles', '-p', '-P', 'default_permissions', 'defaultPermissions',
                 'named_profile', 'named-profile', 'namedProfile', 'config_profile', 'configProfile'}
    check(not forbidden.intersection(contract), 'profile/default_permissions unsupported')
    policy = contract.get('worker_permissions')
    check(isinstance(policy, dict), 'worker_permissions required')
    allowed = {'source', 'evidence_ref', 'supporting_evidence', 'sandbox_mode',
               'approval_policy', 'network_access', 'writable_roots', 'adapter'}
    check(policy.keys() <= allowed, 'unknown or profile/default_permissions field')
    check(policy.get('source') in ('native_trusted_context', 'user_message'), 'authoritative source required')
    check(isinstance(policy.get('evidence_ref'), str) and policy['evidence_ref'].strip(), 'evidence_ref required')
    check(policy.get('adapter') == ADAPTER, 'unsupported adapter')
    check(policy.get('sandbox_mode') in MODES, 'unknown sandbox_mode')
    check(policy.get('approval_policy') in APPROVALS, 'unknown approval_policy')
    check(not contract.get('read_only') or policy['sandbox_mode'] == 'read-only', 'read_only requires read-only sandbox')
    network, roots = policy.get('network_access'), policy.get('writable_roots', [])
    check(network is None or type(network) is bool, 'network_access must be boolean or null')
    check(isinstance(roots, list) and all(isinstance(x, str) for x in roots), 'writable_roots must be paths')
    check(policy['sandbox_mode'] == 'workspace-write' or (network is None and not roots),
          'network_access and writable_roots require workspace-write')
    evidence = policy.get('supporting_evidence', [])
    check(isinstance(evidence, list), 'supporting_evidence must be an array')
    for item in evidence:
        check(isinstance(item, dict) and item.keys() == {'kind', 'ref'}
              and item['kind'] in ('user_config_fields', 'other')
              and isinstance(item['ref'], str) and item['ref'].strip(), 'invalid supporting evidence')
    cwd = Path(contract['cwd']).resolve()
    common = None
    for root in roots:
        path = Path(root)
        check(path.is_absolute() and path.resolve() == path, 'writable root must be canonical and absolute')
        if path.is_relative_to(cwd):
            continue
        if common is None:
            result = subprocess.run(['git', '-C', str(cwd), 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                    capture_output=True, timeout=2, check=False)
            check(result.returncode == 0 and len(result.stdout) < 8192, 'cannot verify git common dir')
            common = Path(os.fsdecode(result.stdout).strip()).resolve()
        check(path == common, 'writable root outside cwd/git common dir')
    return policy


def overrides(policy):
    pairs = [('sandbox_mode', policy['sandbox_mode']), ('approval_policy', policy['approval_policy'])]
    if policy['sandbox_mode'] == 'workspace-write':
        if policy.get('network_access') is not None:
            pairs.append(('sandbox_workspace_write.network_access', policy['network_access']))
        if policy.get('writable_roots'):
            pairs.append(('sandbox_workspace_write.writable_roots', policy['writable_roots']))
    return [part for key, value in pairs for part in ('-c', key + '=' + json.dumps(value, ensure_ascii=True))]


def probe_command(contract):
    return ['codex', '--no-daemon', '-C', contract['cwd'], *overrides(contract['worker_permissions']), 'app-server']


class ProbeFailure(Exception):
    def __init__(self, classification):
        self.classification = classification


def effective_policy(config):
    """Whitelist types as well as keys; never retain full config or packet values."""
    if not isinstance(config, dict):
        raise ProbeFailure('protocol')
    effective = {key: config.get(key) if config.get(key) in values else None
                 for key, values in (('sandbox_mode', MODES), ('approval_policy', APPROVALS))}
    # Record presence only: arbitrary profile names/default objects can contain private data.
    for key in ('default_permissions', 'profile', 'profiles', 'config_profile', 'configProfile',
                'named_profile', 'named-profile', 'namedProfile', 'defaultPermissions', '-p', '-P'):
        value = config.get(key)
        # config/read includes an empty definitions map even when no profile is selected.
        effective[key] = value is not None and not (key == 'profiles' and type(value) is dict and not value)
    workspace = config.get('sandbox_workspace_write')
    if workspace is not None and not isinstance(workspace, dict):
        raise ProbeFailure('config_mismatch')
    workspace = workspace or {}
    network, roots = workspace.get('network_access'), workspace.get('writable_roots', [])
    if (network is not None and type(network) is not bool) or not isinstance(roots, list) or not all(isinstance(x, str) for x in roots):
        raise ProbeFailure('config_mismatch')
    effective['sandbox_workspace_write'] = dict(network_access=network, writable_roots=roots)
    return effective


def verify_effective(selected, effective):
    if any(effective[key] for key in effective if key not in ('sandbox_mode', 'approval_policy', 'sandbox_workspace_write')):
        raise ProbeFailure('unsupported_policy')
    if any(selected[key] != effective[key] for key in ('sandbox_mode', 'approval_policy')):
        raise ProbeFailure('config_mismatch')
    if selected['sandbox_mode'] == 'workspace-write':
        workspace = effective['sandbox_workspace_write']
        if selected.get('network_access') is not None and selected['network_access'] != workspace['network_access']:
            raise ProbeFailure('config_mismatch')
        # Explicit roots must match. Additional effective roots cannot silently widen the task.
        if set(selected.get('writable_roots', [])) != set(workspace['writable_roots']):
            raise ProbeFailure('config_mismatch')


def startup_probe(task, request_id, contract, models, env, interrupted, api):
    """Own the server with the controller's existing lock/identity/stop primitives.

    Stdout is parsed in memory and discarded. Only whitelisted metadata is audited.
    All non-null managed requirements block until a supported compatibility proof exists.
    """
    cap = min(int(models['max_log_bytes']), 8 * 1024 * 1024)
    if cap <= 0:
        raise ValueError('invalid probe log cap')
    audit = dict(timestamp=api['now'](), selected=contract['worker_permissions'], argv=probe_command(contract),
                 effective={}, classification='protocol', exit_code=None, stderr='', claim=CLAIM,
                 stdout_bytes=0, stderr_bytes=0, truncated=False, termination_confirmed=True)
    deadline = time.monotonic() + PROBE_TIMEOUT_S
    child, active, settled = None, None, False
    selector = selectors.DefaultSelector()
    pending, errors = bytearray(), bytearray()
    stdout_closed = False
    totals = {'stdout': 0, 'stderr': 0}

    def check_stop():
        if interrupted:
            raise ProbeFailure('cancelled')
        try:
            with task.lock():
                status = task.get()['status']
        except api['Error'] as exc:
            if str(exc) != 'task busy; retry explicit command':
                raise
        else:
            if status in ('paused', 'cancelled', 'abandoned'):
                raise ProbeFailure('cancelled')
        if time.monotonic() >= deadline:
            raise ProbeFailure('timeout')

    def send(identity, method, params):
        child.stdin.write(json.dumps(dict(id=identity, method=method, params=params)).encode() + b'\n')
        child.stdin.flush()

    def response(identity):
        nonlocal stdout_closed
        while True:
            check_stop()
            while b'\n' in pending:
                line, _, remainder = pending.partition(b'\n')
                pending[:] = remainder
                packet = json.loads(line)
                if not isinstance(packet, dict):
                    raise ProbeFailure('protocol')
                if packet.get('id') == identity:
                    if 'error' in packet or not isinstance(packet.get('result'), dict):
                        raise ProbeFailure('protocol')
                    return packet['result']
                # Notifications are discarded; server requests cannot be approved here.
                if 'id' in packet:
                    raise ProbeFailure('protocol')
            if stdout_closed:
                raise ProbeFailure('protocol')
            for key, _ in selector.select(timeout=.1):
                chunk = os.read(key.fileobj.fileno(), min(65536, cap + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    if key.data == 'stdout':
                        stdout_closed = True
                    continue
                kind = key.data
                remaining = max(0, cap - totals[kind])
                totals[kind] += len(chunk)
                (pending if kind == 'stdout' else errors).extend(chunk[:remaining])
                if totals[kind] > cap:
                    audit['truncated'] = True
                    raise ProbeFailure('protocol')

    try:
        with task.lock():
            state = task.get()
            active = state['active']
            api['require'](active and active['request_id'] == request_id, 'active lease changed before probe')
            if interrupted or state['status'] in ('paused', 'cancelled', 'abandoned'):
                raise ProbeFailure('cancelled')
            active.update(phase='probe', child_pid=None, child_start=None, child_boot_id=None)
            task.save(state)  # Register phase before spawn; unknown crash windows fail closed.
            child = subprocess.Popen(audit['argv'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=contract['cwd'], env=env, start_new_session=True)
            active.update(child_pid=child.pid, child_boot_id=active['controller_boot_id'])
            task.save(state)
            info = api['proc'](child.pid)
            api['require'](info is not None, 'probe child identity unavailable')
            active['child_start'] = info['start']
            task.save(state)
        for pipe, name in ((child.stdout, 'stdout'), (child.stderr, 'stderr')):
            os.set_blocking(pipe.fileno(), False)
            selector.register(pipe, selectors.EVENT_READ, name)
        send(1, 'initialize', dict(clientInfo=dict(name='workbench-policy-probe', version='2'),
                                   capabilities=dict(experimentalApi=True)))
        response(1)
        child.stdin.write(b'{"method":"initialized","params":{}}\n')
        child.stdin.flush()
        send(2, 'config/read', dict(cwd=contract['cwd'], includeLayers=False))
        packet = response(2)
        audit['effective'] = effective_policy(packet.get('config'))
        del packet
        send(3, 'configRequirements/read', {})
        packet = response(3)
        if 'requirements' not in packet:
            raise ProbeFailure('protocol')
        # Unknown managed structures are never persisted, including nested auth/MCP/env.
        audit['effective']['requirements'] = None if packet['requirements'] is None else {'present': True}
        has_requirements = packet['requirements'] is not None
        del packet
        effective = {k: v for k, v in audit['effective'].items() if k != 'requirements'}
        verify_effective(contract['worker_permissions'], effective)
        if has_requirements:
            raise ProbeFailure('managed_constraint')
        check_stop()
        send(4, 'command/exec', dict(command=['/bin/true'], cwd=contract['cwd'], timeoutMs=2000))
        packet = response(4)
        code = packet.get('exitCode')
        text = packet.get('stderr', '')
        if type(code) is not int or not isinstance(text, str):
            raise ProbeFailure('protocol')
        audit['exit_code'] = code
        data = text.encode()
        remaining = max(0, cap - len(errors))
        errors.extend(data[:remaining])
        audit['truncated'] |= len(data) > remaining
        del packet
        audit['classification'] = 'ok' if code == 0 else 'sandbox'
    except ProbeFailure as exc:
        audit['classification'] = exc.classification
    except (OSError, ValueError, KeyError, TypeError, api['Error']):
        audit['classification'] = 'protocol'
    finally:
        selector.close()
        if child:
            try:
                settled = api['stop_group'](active, child)
            except (api['Error'], OSError, subprocess.TimeoutExpired):
                settled = False
            # Drain remaining diagnostics only within the same byte caps. Never save raw stdout.
            for pipe, kind in ((child.stdout, 'stdout'), (child.stderr, 'stderr')):
                with contextlib.suppress(OSError):
                    os.set_blocking(pipe.fileno(), False)
                    while totals[kind] <= cap:
                        try:
                            chunk = os.read(pipe.fileno(), min(65536, cap + 1 - totals[kind]))
                        except BlockingIOError:
                            break
                        if not chunk:
                            break
                        remaining = max(0, cap - totals[kind])
                        totals[kind] += len(chunk)
                        if kind == 'stderr':
                            errors.extend(chunk[:remaining])
                        if totals[kind] > cap:
                            audit['truncated'] = True
                            if audit['classification'] == 'ok':
                                audit['classification'] = 'protocol'
            for pipe in (child.stdin, child.stdout, child.stderr):
                with contextlib.suppress(OSError):
                    pipe.close()
        else:
            settled = True
        audit['termination_confirmed'] = settled
        normalized = errors.decode('utf-8', errors='replace').encode('utf-8')
        audit['stderr'] = normalized[:min(cap, 8192)].decode('utf-8', errors='ignore')
        audit['truncated'] |= len(normalized) > min(cap, 8192)
        audit['stdout_bytes'], audit['stderr_bytes'] = totals['stdout'], totals['stderr']
        if audit['classification'] in ('sandbox', 'protocol') and any(
                word in audit['stderr'].lower() for word in ('bwrap', 'rtm_newaddr', 'userns', 'eperm')):
            audit['classification'] = 'namespace'
        if not settled and audit['classification'] == 'ok':
            audit['classification'] = 'protocol'
        # Retry lock acquisition only, never the probe or model.
        while True:
            try:
                with task.lock():
                    state = task.get()
                    api['require'](state['active'] and state['active']['request_id'] == request_id,
                                   'active lease changed during probe')
                    record = state['requests'][request_id]
                    record['probe'] = audit
                    path = task.path / 'probe-audit.jsonl'
                    with open(path, 'ab') as stream:
                        stream.write(json.dumps(dict(request_id=request_id, **audit), ensure_ascii=True).encode() + b'\n')
                        stream.flush()
                        os.fsync(stream.fileno())
                    if settled:
                        state['active']['phase'] = 'probe-complete'
                    task.save(state)
                    break
            except api['Error'] as exc:
                if str(exc) != 'task busy; retry explicit command':
                    raise
                time.sleep(.1)
    return audit
