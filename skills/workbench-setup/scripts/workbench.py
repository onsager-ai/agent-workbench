#!/usr/bin/env python3
"""Explicit, local global-instruction setup. Python 3.11+, POSIX only."""
from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import tomllib

VERSION = "1"
SOURCE = "onsager-ai/agent-workbench"
BEGIN = b"<!-- BEGIN agent-workbench -->"
END = b"<!-- END agent-workbench -->"
IMPORT = b"@~/.agents/AGENTS.md"
LIMIT = 10 * 1024 * 1024
ROLE = re.compile(r"[a-z][a-z0-9-]*")
LEVELS = {"luna": "L1", "haiku": "L1", "terra": "L2", "sonnet": "L2", "sol": "L3", "opus": "L3", "flash": "pilot"}


class Conflict(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def present(path):
    return os.path.lexists(path)


def inspect(path, home, *, link=False, directory=False):
    """Never traverse symlink parents or read a foreign-owned entry."""
    if not path.is_relative_to(home):
        raise Conflict(f"path escapes selected home: {path}")
    if home.is_symlink() or not home.is_dir() or home.stat().st_uid != os.getuid():
        raise Conflict(f"home must be an owned directory: {home}")
    if any(parent.is_symlink() for parent in home.parents):
        raise Conflict(f"selected home has a symlink ancestor: {home}")
    current = home
    for part in path.relative_to(home).parts[:-1]:
        current /= part
        if present(current):
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
                raise Conflict(f"unsafe parent directory: {current}")
    if not present(path):
        return
    info = path.lstat()
    if info.st_uid != os.getuid():
        raise Conflict(f"entry owned by another user: {path}")
    allowed = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if link and stat.S_ISLNK(info.st_mode):
        allowed = True
    if not allowed:
        raise Conflict(f"unexpected file type or symlink: {path}")
    if not directory and stat.S_ISREG(info.st_mode) and info.st_size > LIMIT:
        raise Conflict(f"file too large for bounded inspection: {path}")


def read(path):
    return path.read_bytes() if present(path) else b""


def split_block(data):
    if not data.count(BEGIN) and not data.count(END):
        return None, data
    if data.count(BEGIN) != 1 or data.count(END) != 1:
        raise Conflict("duplicate or unbalanced managed markers; repair markers manually")
    start, end = data.index(BEGIN), data.index(END)
    if end < start:
        raise Conflict("managed markers are reversed")
    end += len(END)
    if data[end:end + 1] == b"\n":
        end += 1
    return data[start:end], data[:start] + data[end:]


def import_lines(data, home, claude_parent, shared):
    """Return import lines resolving lexically to the shared instructions."""
    matches = []
    shared_path = os.path.normpath(shared)
    for line in data.splitlines(keepends=True):
        stripped = line.strip()
        if not stripped.startswith(b"@"):
            continue
        token = stripped[1:]
        if not token or len(token.split()) != 1:
            continue
        path = os.fsdecode(token)
        if path.startswith("~/"):
            path = os.path.join(os.fspath(home), path[2:])
        elif not os.path.isabs(path):
            path = os.path.join(os.fspath(claude_parent), path)
        if os.path.normpath(path) == shared_path:
            matches.append(line)
    return matches


def remove_exact_line(data, line):
    lines = data.splitlines(keepends=True)
    for index, current in enumerate(lines):
        if current == line:
            del lines[index]
            return b"".join(lines)
    raise Conflict("managed Claude import missing or modified; left unchanged")


def atomic(path, data, mode=0o600):
    if present(path) and not path.is_symlink() and read(path) == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".agent-workbench-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync_dir(path.parent)
    finally:
        if os.path.lexists(name):
            os.unlink(name)
    return True


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_link(path, target):
    if path.is_symlink() and os.readlink(path) == target:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".agent-workbench-", dir=path.parent)
    os.close(fd)
    os.unlink(name)
    try:
        os.symlink(target, name)
        os.replace(name, path)
        sync_dir(path.parent)
    finally:
        if os.path.lexists(name):
            os.unlink(name)
    return True


def snapshot(path):
    if path.is_symlink():
        return ("link", os.readlink(path), None)
    if present(path):
        return ("file", read(path), stat.S_IMODE(path.stat().st_mode))
    return ("absent", None, None)


@contextlib.contextmanager
def transaction(plans):
    """Roll back this operation's writes, retaining independently changed entries."""
    before = {path: snapshot(path) for path in plans}
    try:
        yield
    except BaseException as original:
        problems = []
        for path in reversed(plans):
            try:
                current = snapshot(path)
                old = before[path]
                if current == old:
                    continue
                if current[:2] != plans[path][:2]:
                    problems.append(f"changed foreign entry retained: {path}")
                    continue
                kind, value, mode = old
                if kind == "absent":
                    path.unlink()
                elif kind == "link":
                    atomic_link(path, value)
                else:
                    atomic(path, value, mode)
            except OSError as exc:
                problems.append(f"rollback could not restore {path}: {exc}")
        if problems:
            raise Conflict("operation failed; inspect retained backups and state: " + "; ".join(problems)) from original
        raise


class Setup:
    def __init__(self, home):
        self.home = Path(os.path.abspath(home))
        self.shared = self.home / ".agents/AGENTS.md"
        self.codex = self.home / ".codex/AGENTS.md"
        self.claude = self.home / ".claude/CLAUDE.md"
        self.launcher = self.home / ".local/bin/agent-workbench"
        self.root = self.home / ".local/state/agent-workbench"
        self.state_path = self.root / "state.json"
        self.script = self.home / ".agents/skills/workbench-setup/scripts/workbench.py"
        self.template = self.script.parent.parent / "assets/AGENTS.md"
        self.target = "../.agents/AGENTS.md"
        self.agents = self.home / ".claude/agents"
        orchestration = self.home / ".agents/skills/orchestrate-harnesses"
        self.claude_settings = self.home / ".claude/settings.json"
        self.codex_settings = self.home / ".codex/config.toml"
        self.models = orchestration / "models.json"
        self.worker = orchestration / "references/worker.md"
        xdg = os.environ.get("XDG_CONFIG_HOME", "")
        config = Path(xdg) if self.home == Path.home() and xdg and os.path.isabs(xdg) else self.home / ".config"
        self.override = config / "agent-workbench/models.json"

    def launcher_bytes(self):
        return ("#!/usr/bin/env python3\n"
                "# Managed by agent-workbench; ownership is recorded in state.json.\n"
                "import os, sys\n"
                f"script = {str(self.script)!r}\n"
                f"home = {str(self.home)!r}\n"
                "os.execv(sys.executable, [sys.executable, script, '--home', home, *sys.argv[1:]])\n").encode()

    def agent_path(self, name):
        return self.agents / (name + ".md")

    def read_json(self, path):
        base = self.home if path.is_relative_to(self.home) else path.parent
        inspect(path, base)
        try:
            data = json.loads(read(path))
            if not isinstance(data.get("roles", {}), dict):
                raise ValueError("roles must be an object")
            return data
        except (ValueError, AttributeError) as exc:
            raise Conflict(f"invalid model configuration: {path}") from exc

    def warn_catalog(self, targets):
        magpie = shutil.which("magpie")
        if not magpie or not targets:
            return
        try:
            result = subprocess.run([magpie, "models", "claude"], capture_output=True,
                                    text=True, timeout=20, check=False)
        except (OSError, subprocess.TimeoutExpired):
            print("magpie catalog unavailable; tier validation skipped", file=sys.stderr)
            return
        if result.returncode:
            print("magpie catalog unavailable; tier validation skipped", file=sys.stderr)
            return
        catalog = {}
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 2 and "/" in fields[-1] and re.fullmatch(r"[a-z/]+", fields[-1]):
                catalog[fields[0]] = set(fields[-1].split("/"))
        for name, (model, effort) in targets.items():
            efforts = catalog.get(model)
            if efforts is None:
                print(f"warning: {name} tier model {model!r} is absent from magpie models claude",
                      file=sys.stderr)
            elif effort not in efforts:
                print(f"warning: {name} tier effort {effort!r} is not listed for {model!r} "
                      "by magpie models claude", file=sys.stderr)

    def desired_agents(self):
        """Render one Claude Code subagent per role routable from Claude Code."""
        inspect(self.models, self.home)
        inspect(self.worker, self.home)
        if not present(self.models) or not present(self.worker):
            return {}
        roles = self.read_json(self.models).get("roles", {})
        if present(self.override):
            for name, fields in self.read_json(self.override).get("roles", {}).items():
                if not isinstance(fields, dict):
                    raise Conflict(f"invalid model override for role {name}: {self.override}")
                roles[name] = {**roles.get(name, {}), **fields}
        body = read(self.worker).decode("utf-8")
        agents = {}
        targets = {}
        for name, role in roles.items():
            model = role.get("model") if role.get("cli") == "claude" else role.get("claude_model")
            if model is None:
                continue
            effort = role.get("effort")
            if not ROLE.fullmatch(name) or not isinstance(model, str) or not isinstance(effort, str):
                raise Conflict(f"invalid model configuration for role {name}")
            label = f"{LEVELS[name] + ' ' if name in LEVELS else ''}Worker"
            via = "" if role.get("cli") == "claude" else " via configured gateway"
            description = f"Agent Workbench {label} ({role['model']}{via})"
            agents[name] = ("---\n" f"name: {name}\n" f"description: {json.dumps(description)}\n"
                            f"model: {json.dumps(model)}\n" f"effort: {json.dumps(effort)}\n---\n"
                            "<!-- Managed by agent-workbench; ownership is recorded in state.json. -->\n\n"
                            + body).encode()
            targets[name] = (model, effort)
        self.warn_catalog(targets)
        return agents

    def context_values(self):
        if not present(self.models):
            return None
        config = self.read_json(self.models)
        if present(self.override):
            config.update({k: v for k, v in self.read_json(self.override).items() if k != "roles"})
        for key in ("max_context_tokens", "claude_context_window", "codex_context_window"):
            value = config.get(key)
            if not (key == "codex_context_window" and value is None) and (type(value) is not int or value <= 0):
                raise Conflict(f"invalid model configuration: {key} must be a positive integer" +
                               (" or null" if key == "codex_context_window" else ""))
        target = config["max_context_tokens"]
        values = {"claude": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str(max(1, min(100, 100 * target // config["claude_context_window"])))},
                  "codex": {"model_auto_compact_token_limit": target}}
        if config["codex_context_window"] is not None:
            values["codex"]["model_context_window"] = config["codex_context_window"]
        return values

    def native_config(self, kind):
        path = getattr(self, kind + "_settings")
        inspect(path.parent, self.home, directory=True)
        if not present(path.parent):
            return None, None
        inspect(path, self.home)
        data = read(path)
        try:
            if kind == "claude":
                parsed = json.loads(data) if present(path) else {}
                if not isinstance(parsed, dict) or not isinstance(parsed.get("env", {}), dict):
                    raise ValueError("settings and env must be objects")
                return data, parsed.get("env", {})
            parsed = tomllib.loads(data.decode("utf-8"))
            return data, parsed
        except (ValueError, UnicodeDecodeError) as exc:
            raise Conflict(f"invalid {kind} configuration: {path}") from exc

    def native_edit(self, kind, data, changes):
        if not changes:
            return data
        if kind == "claude":
            parsed = json.loads(data) if data else {}
            env = parsed.setdefault("env", {})
            for key, value in changes.items():
                if value is None:
                    env.pop(key, None)
                else:
                    env[key] = value
            return (json.dumps(parsed, indent=2, ensure_ascii=False) + "\n").encode()
        text = data.decode("utf-8")
        lines = text.splitlines(keepends=True)
        first_table = next((i for i, line in enumerate(lines) if re.match(r"^\s*\[", line)), len(lines))
        for key, value in changes.items():
            pattern = re.compile(r'^([ \t]*(?:' + re.escape(key) + r'|"' + re.escape(key) + r'"|\'' + re.escape(key) + r'\')[ \t]*=[ \t]*)([^#\r\n]*?)([ \t]*(?:#[^\r\n]*)?)(\r?\n)?$')
            matches = [(i, pattern.match(line)) for i, line in enumerate(lines[:first_table])]
            matches = [(i, match) for i, match in matches if match]
            if matches:
                i, match = matches[0]
                if value is None:
                    comment = match.group(3).lstrip()
                    lines[i] = comment + (match.group(4) or "") if comment else ""
                else:
                    lines[i] = match.group(1) + str(value) + match.group(3) + (match.group(4) or "")
            elif value is not None:
                prefix = "" if first_table == 0 or lines[first_table - 1].endswith("\n") else "\n"
                lines.insert(first_table, prefix + key + " = " + str(value) + "\n")
                first_table += 1
            else:
                raise Conflict(f"cannot safely edit {kind} key: {key}")
        result = "".join(lines).encode("utf-8")
        try:
            tomllib.loads(result.decode("utf-8"))
        except ValueError as exc:
            raise Conflict("invalid Codex configuration after edit") from exc
        return result

    def native_plans(self, state, desired, *, uninstall=False, status=False):
        owned = state.get("native", {}) if state else {}
        plans, record, report = {}, {}, {}
        for kind in ("claude", "codex"):
            data, current = self.native_config(kind)
            if data is None:
                report[kind] = "skipped: config directory missing"
                if kind in owned:
                    record[kind] = owned[kind]
                continue
            old = owned.get(kind, {})
            if status and kind not in owned:
                report[kind] = "skipped: not applied; run install if config directory is available"
                continue
            wanted = {} if uninstall or desired is None else desired[kind]
            changes, entries = {}, {}
            report[kind] = {}
            for key in sorted(set(old) | set(wanted)):
                exists = key in current
                value = current.get(key)
                conflict = exists and (type(value) is not type(old.get(key, wanted.get(key))) or value != old.get(key, wanted.get(key)))
                report[kind][key] = "conflict" if conflict else ("applied" if exists else "missing")
                if status:
                    continue
                if conflict:
                    if uninstall:
                        continue
                    raise Conflict(f"foreign or edited {kind} setting: {key}")
                if key in wanted:
                    entries[key] = wanted[key]
                    if not exists or value != wanted[key] or type(value) is not type(wanted[key]):
                        changes[key] = wanted[key]
                elif exists and key in old:
                    changes[key] = None
            if entries:
                record[kind] = entries
            if changes:
                path = getattr(self, kind + "_settings")
                plans[path] = ("file", self.native_edit(kind, data, changes), 0o600)
        return plans, record, report

    def check_agents(self, state, desired=()):
        owned = state.get("agents", {}) if state else {}
        for name in sorted({*owned, *desired}):
            path = self.agent_path(name)
            inspect(path, self.home)
            if not present(path):
                continue
            if name not in owned:
                raise Conflict(f"foreign Claude agent file; left unchanged: {path}")
            if digest(read(path)) != owned[name]["hash"]:
                raise Conflict(f"owned Claude agent file was edited; left unchanged: {path}")

    def load(self):
        inspect(self.root, self.home, directory=True)
        inspect(self.state_path, self.home)
        if not present(self.state_path):
            return None
        try:
            state = json.loads(read(self.state_path))
            if (state["schema"] != 1 or not isinstance(state["block_hash"], str)
                    or state["target"] != self.target
                    or not isinstance(state["launcher_hash"], str)
                    or not isinstance(state["version"], str)
                    or not isinstance(state["template_hash"], str)
                    or digest(state["block_text"].encode("utf-8")) != state["block_hash"]
                    or not isinstance(state["import_added"], bool)
                    or state["import_suffix"] not in ("", IMPORT.decode() + "\n", "\n" + IMPORT.decode() + "\n")):
                raise ValueError("invalid ownership metadata")
            if "claude_import" in state:
                imported = state["claude_import"]
                if (not isinstance(imported, dict) or not isinstance(imported.get("owned"), bool)
                        or not isinstance(imported.get("line"), str)):
                    raise ValueError("invalid Claude import ownership metadata")
                base64.b64decode(imported["line"], validate=True)
            native = state.get("native", {})
            if not isinstance(native, dict) or any(kind not in ("claude", "codex") or not isinstance(entries, dict) for kind, entries in native.items()):
                raise ValueError("invalid native ownership metadata")
            allowed = {"claude": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": str}, "codex": {"model_auto_compact_token_limit": int, "model_context_window": int}}
            for kind, entries in native.items():
                if any(key not in allowed[kind] or type(value) is not allowed[kind][key] for key, value in entries.items()):
                    raise ValueError("invalid native ownership metadata")
            for name, entry in state.get("agents", {}).items():
                if not ROLE.fullmatch(name) or not isinstance(entry["hash"], str):
                    raise ValueError("invalid agent ownership metadata")
            return state
        except (ValueError, KeyError, TypeError, AttributeError, binascii.Error) as exc:
            raise Conflict("invalid setup state; retain backups and repair state before retrying") from exc

    @staticmethod
    def claude_import_record(state, current_line=None):
        if "claude_import" in state:
            saved = state["claude_import"]
            return {"owned": saved["owned"], "line": base64.b64decode(saved["line"], validate=True)}
        if state["import_added"]:
            return {"owned": True, "line": IMPORT + b"\n"}
        return {"owned": False, "line": current_line}

    @staticmethod
    def encode_claude_import(owned, line):
        return {"owned": bool(owned), "line": base64.b64encode(line).decode("ascii")}

    def preflight(self, *, uninstall=False, status=False):
        state = self.load()
        for path in (self.shared, self.claude, self.launcher):
            inspect(path, self.home)
        inspect(self.codex, self.home, link=True)
        inspect(self.root / "lock", self.home)
        inspect(self.root / "backups", self.home, directory=True)
        for name in ("shared", "codex", "claude", "launcher", "claude_settings", "codex_settings"):
            inspect(self.root / "backups" / (name + ".json"), self.home)
        override = self.home / ".codex/AGENTS.override.md"
        inspect(override, self.home, link=True)
        if present(override):
            raise Conflict("Codex AGENTS.override.md masks AGENTS.md; resolve the override first")
        if self.home == Path.home():
            command = shutil.which("agent-workbench")
            if command and Path(os.path.abspath(command)) != self.launcher:
                raise Conflict("another agent-workbench command is on PATH; resolve the command collision first")
            for variable, expected in (("CODEX_HOME", self.home / ".codex"),
                                       ("CLAUDE_CONFIG_DIR", self.home / ".claude")):
                configured = os.environ.get(variable)
                if configured and Path(configured).expanduser().absolute() != expected:
                    raise Conflict(f"{variable} selects another instruction location; resolve it first")
        if self.codex.is_symlink() and os.readlink(self.codex) != self.target:
            raise Conflict("foreign Codex link; left unchanged (restore the managed link manually)")
        if not state and self.codex.is_symlink():
            raise Conflict("unowned Codex link; no setup ownership record")
        if state and (not self.codex.is_symlink()):
            raise Conflict("owned Codex link is missing or replaced; left unchanged")
        if present(self.launcher):
            if not state or digest(read(self.launcher)) != state["launcher_hash"]:
                raise Conflict("foreign or edited agent-workbench command; left unchanged")
            if not self.launcher.stat().st_mode & stat.S_IXUSR:
                raise Conflict("owned launcher is not executable; restore its executable mode")
        elif state:
            raise Conflict("owned launcher is missing; restore it before retrying")
        block, private = split_block(read(self.shared))
        if state:
            if block is None or digest(block) != state["block_hash"]:
                raise Conflict("managed block drift; restore the public block recorded in state.json before retrying")
        elif block is not None:
            raise Conflict("managed markers have no ownership record; left unchanged")
        claude = read(self.claude)
        lines = import_lines(claude, self.home, self.claude.parent, self.shared)
        if len(lines) > 1:
            raise Conflict("duplicate Claude imports; keep one import before retrying")
        if state and len(lines) != 1:
            raise Conflict("managed Claude import is missing or modified; left unchanged")
        if state:
            imported = self.claude_import_record(state, lines[0])
            if imported["owned"]:
                if lines[0] != imported["line"]:
                    raise Conflict("managed Claude import missing or modified; left unchanged")
            elif "claude_import" not in state and lines[0].strip() != IMPORT:
                raise Conflict("managed Claude import missing or modified; left unchanged")
        self.check_agents(state)
        if not uninstall:
            inspect(self.script, self.home)
            inspect(self.template, self.home)
            if not self.script.is_file() or not self.template.is_file():
                raise Conflict("missing canonical setup resources; distribute workbench-setup globally first")
            template = read(self.template)
            template.decode("utf-8")
            if BEGIN in template or END in template:
                raise Conflict("template must not contain managed markers")
        return state, block, private

    @contextlib.contextmanager
    def lock(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        fd = os.open(self.root / "lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise Conflict("another agent-workbench operation holds the lock") from exc
            yield
        finally:
            os.close(fd)

    def backup(self, name, path):
        backups = self.root / "backups"
        backups.mkdir(mode=0o700, exist_ok=True)
        os.chmod(backups, 0o700)
        destination = backups / (name + ".json")
        if not present(destination):
            import base64
            entry = {"type": "absent"}
            if path.is_symlink():
                entry = {"type": "symlink", "target": os.readlink(path)}
            elif present(path):
                entry = {"type": "file", "base64": base64.b64encode(read(path)).decode(),
                         "mode": stat.S_IMODE(path.stat().st_mode)}
            atomic(destination, (json.dumps(entry, sort_keys=True) + "\n").encode())

    def install(self):
        self.preflight()
        with self.lock():
            state, old_block, private = self.preflight()
            template = read(self.template)
            block = BEGIN + b"\n" + template.rstrip(b"\n") + b"\n" + END + b"\n"
            if not state and present(self.codex):
                codex_private = read(self.codex)
                if codex_private != private:
                    private += codex_private
            claude = read(self.claude)
            lines = import_lines(claude, self.home, self.claude.parent, self.shared)
            if state:
                imported = self.claude_import_record(state, lines[0])
                added = state["import_added"]
                suffix = state["import_suffix"]
            else:
                added = not lines
                suffix = ""
                if lines:
                    imported = {"owned": False, "line": lines[0]}
                else:
                    imported = {"owned": True, "line": IMPORT + b"\n"}
            if not lines:
                suffix = ("\n" if claude and not claude.endswith(b"\n") else "") + IMPORT.decode() + "\n"
                claude += suffix.encode()
                imported = {"owned": True, "line": IMPORT + b"\n"}
            native_plans, native_record, _ = self.native_plans(state, self.context_values())
            desired = self.desired_agents()
            self.check_agents(state, desired)
            for name in ("shared", "codex", "claude", "launcher"):
                self.backup(name, getattr(self, name))
            for path in native_plans:
                self.backup("claude_settings" if path == self.claude_settings else "codex_settings", path)
            record = {"native": native_record, "schema": 1, "version": VERSION, "template_hash": digest(template),
                      "block_hash": digest(block), "block_text": block.decode("utf-8"), "target": self.target,
                      "launcher_hash": digest(self.launcher_bytes()), "import_added": bool(added),
                      "import_suffix": suffix,
                      "claude_import": self.encode_claude_import(imported["owned"], imported["line"]),
                      "owned": {"shared": "managed-block", "codex": "symlink",
                                "claude": "import-line", "launcher": "file"},
                      "agents": {name: {"path": str(self.agent_path(name).relative_to(self.home)),
                                        "hash": digest(data)} for name, data in desired.items()}}
            shared = read(self.shared).replace(old_block, block, 1) if old_block else block + private
            state_bytes = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode()
            plans = {self.shared: ("file", shared, 0o600), self.codex: ("link", self.target, None),
                     self.claude: ("file", claude, 0o600),
                     self.launcher: ("file", self.launcher_bytes(), 0o700),
                     self.state_path: ("file", state_bytes, 0o600)}
            agents = {self.agent_path(name): ("file", desired[name], 0o600) if name in desired
                      else ("absent", None, None)
                      for name in {*(state.get("agents", {}) if state else ()), *desired}}
            plans.update(agents)
            plans.update(native_plans)
            with transaction(plans):
                changed = atomic(self.shared, shared)
                changed |= atomic_link(self.codex, self.target)
                changed |= atomic(self.claude, claude)
                changed |= atomic(self.launcher, self.launcher_bytes(), 0o700)
                for path, plan in agents.items():
                    if plan[0] == "absent":
                        if present(path):
                            path.unlink()
                            changed = True
                    else:
                        changed |= atomic(path, plan[1])
                for path, plan in native_plans.items():
                    changed |= atomic(path, plan[1])
                changed |= atomic(self.state_path, state_bytes)
        print("installed" if changed else "no-op: already installed")
        print(f"claude agents: {', '.join(sorted(desired)) or 'none'}")
        if not desired:
            print("no Claude agents generated: orchestrate-harnesses is not installed")

    def status(self):
        state, block, private = self.preflight(status=True)
        if not state:
            raise Conflict("not installed")
        template = read(self.template)
        _, _, native_status = self.native_plans(state, self.context_values(), status=True)
        print(json.dumps({"installed_version": state["version"], "available_version": VERSION,
                          "installed_template_hash": state["template_hash"],
                          "available_template_hash": digest(template),
                          "native_settings": native_status, "private_bytes": len(private), "shared": str(self.shared),
                          "codex": str(self.codex), "claude": str(self.claude),
                          "launcher": str(self.launcher),
                          "agents": {name: str(self.agent_path(name)) for name in sorted(state.get("agents", {}))}},
                         sort_keys=True))
        self.check_agents(state, self.desired_agents())
        if state["template_hash"] != digest(template) or state["version"] != VERSION:
            raise Conflict("an instruction update is available; run install to apply distributed assets")

    def uninstall(self):
        state, _, _ = self.preflight(uninstall=True)
        if not state:
            print("no-op: not installed")
            return
        with self.lock():
            state, _, private = self.preflight(uninstall=True)
            claude = read(self.claude)
            lines = import_lines(claude, self.home, self.claude.parent, self.shared)
            imported = self.claude_import_record(state, lines[0])
            if imported["owned"]:
                suffix = state["import_suffix"].encode() if state["import_added"] else b""
                if suffix and claude.endswith(suffix) and imported["line"] == IMPORT + b"\n":
                    claude = claude[:-len(suffix)]
                else:
                    claude = remove_exact_line(claude, imported["line"])
            native_plans, _, _ = self.native_plans(state, None, uninstall=True)
            for path in native_plans:
                self.backup("claude_settings" if path == self.claude_settings else "codex_settings", path)
            # Keep current personal bytes, never restore an old snapshot over them.
            agents = {self.agent_path(name): ("absent", None, None) for name in state.get("agents", {})}
            plans = {**agents, self.shared: ("file", private, 0o600), self.codex: ("file", private, 0o600),
                     self.claude: ("file", claude, 0o600), self.launcher: ("absent", None, None),
                     self.state_path: ("absent", None, None)}
            plans.update(native_plans)
            with transaction(plans):
                for path, plan in native_plans.items():
                    atomic(path, plan[1])
                atomic(self.shared, private)
                atomic(self.codex, private)
                atomic(self.claude, claude)
                for path in agents:
                    if present(path):
                        path.unlink()
                self.launcher.unlink()
                self.state_path.unlink()
                sync_dir(self.root)
        print("uninstalled; current private instructions and private backups retained")

    def update(self, command):
        self.preflight()
        if self.home != Path.home() and not command:
            raise Conflict("alternate --home requires --skills-cmd; real-user npx was not invoked")
        lock_path = self.home / ".agents/.skill-lock.json"
        if self.home == Path.home() and os.environ.get("XDG_STATE_HOME"):
            lock_path = Path(os.environ["XDG_STATE_HOME"]) / "skills/.skill-lock.json"
            # XDG_STATE_HOME may be outside home, but reject symlink traversal there too.
            base = Path(os.path.abspath(os.environ["XDG_STATE_HOME"]))
            inspect(lock_path, base)
        else:
            inspect(lock_path, self.home)
        if not present(lock_path):
            raise Conflict("native skills lock is missing; install global skills first")
        try:
            native = json.loads(read(lock_path))
            skills = native["skills"]
            if native["version"] != 3 or not isinstance(skills, dict):
                raise ValueError("unsupported lock")
            names = sorted(name for name, item in skills.items()
                           if item.get("source") == SOURCE and item.get("sourceType") == "github")
            if "workbench-setup" not in names or any(not name or name.startswith("-")
                                                       or "/" in name for name in names):
                raise ValueError("setup ownership is missing or names are invalid")
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise Conflict("unsupported native skills lock or missing repository ownership") from exc
        args = shlex.split(command) if command else ["npx", "--yes", "skills@1.7.4"]
        if not args:
            raise Conflict("empty skills command")
        with self.lock():
            self.preflight()
            result = subprocess.run([*args, "update", *names, "-g", "-y"], check=False)
            if result.returncode:
                raise Conflict(f"native skills update failed ({result.returncode}); global instructions unchanged")
            # Revalidate updated canonical resource paths without executing replaced symlinks.
            self.preflight()
        # Fresh interpreter loads the newly distributed code, after releasing our lock.
        os.execv(sys.executable, [sys.executable, str(self.script), "--home", str(self.home), "install"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home(), help="selected home (default: current user's home)")
    parser.add_argument("command", choices=("install", "update", "status", "uninstall"))
    parser.add_argument("--skills-cmd", help="explicit native skills CLI command, required for alternate-home updates")
    args = parser.parse_args()
    try:
        setup = Setup(args.home)
        if args.command == "update":
            setup.update(args.skills_cmd)
        else:
            getattr(setup, args.command)()
        return 0
    except (Conflict, OSError, ValueError) as exc:
        print(f"agent-workbench: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
