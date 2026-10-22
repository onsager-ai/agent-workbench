#!/usr/bin/env python3
"""Explicit, local global-instruction setup. Python 3.11+, POSIX only."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile

VERSION = "1"
SOURCE = "onsager-ai/agent-workbench"
BEGIN = b"<!-- BEGIN agent-workbench -->"
END = b"<!-- END agent-workbench -->"
IMPORT = b"@~/.agents/AGENTS.md"
LIMIT = 10 * 1024 * 1024


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


def import_lines(data):
    return [line for line in data.splitlines(keepends=True)
            if line.strip() == IMPORT]


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

    def launcher_bytes(self):
        return ("#!/usr/bin/env python3\n"
                "# Managed by agent-workbench; ownership is recorded in state.json.\n"
                "import os, sys\n"
                f"script = {str(self.script)!r}\n"
                f"home = {str(self.home)!r}\n"
                "os.execv(sys.executable, [sys.executable, script, '--home', home, *sys.argv[1:]])\n").encode()

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
            return state
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise Conflict("invalid setup state; retain backups and repair state before retrying") from exc

    def preflight(self, *, uninstall=False, status=False):
        state = self.load()
        for path in (self.shared, self.claude, self.launcher):
            inspect(path, self.home)
        inspect(self.codex, self.home, link=True)
        inspect(self.root / "lock", self.home)
        inspect(self.root / "backups", self.home, directory=True)
        for name in ("shared", "codex", "claude", "launcher"):
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
        lines = import_lines(claude)
        if len(lines) > 1:
            raise Conflict("duplicate Claude imports; keep one import before retrying")
        equivalent = b"@" + str(self.shared).encode()
        if any(line.strip() == equivalent for line in claude.splitlines()):
            raise Conflict("absolute Claude import already exists; use the documented home-relative import")
        if state and len(lines) != 1:
            raise Conflict("managed Claude import is missing or modified; left unchanged")
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
            added = state["import_added"] if state else not import_lines(claude)
            suffix = state["import_suffix"] if state else ""
            if not import_lines(claude):
                suffix = ("\n" if claude and not claude.endswith(b"\n") else "") + IMPORT.decode() + "\n"
                claude += suffix.encode()
            for name in ("shared", "codex", "claude", "launcher"):
                self.backup(name, getattr(self, name))
            record = {"schema": 1, "version": VERSION, "template_hash": digest(template),
                      "block_hash": digest(block), "block_text": block.decode("utf-8"), "target": self.target,
                      "launcher_hash": digest(self.launcher_bytes()), "import_added": bool(added),
                      "import_suffix": suffix,
                      "owned": {"shared": "managed-block", "codex": "symlink",
                                "claude": "import-line", "launcher": "file"}}
            shared = read(self.shared).replace(old_block, block, 1) if old_block else block + private
            state_bytes = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode()
            plans = {self.shared: ("file", shared, 0o600), self.codex: ("link", self.target, None),
                     self.claude: ("file", claude, 0o600),
                     self.launcher: ("file", self.launcher_bytes(), 0o700),
                     self.state_path: ("file", state_bytes, 0o600)}
            with transaction(plans):
                changed = atomic(self.shared, shared)
                changed |= atomic_link(self.codex, self.target)
                changed |= atomic(self.claude, claude)
                changed |= atomic(self.launcher, self.launcher_bytes(), 0o700)
                changed |= atomic(self.state_path, state_bytes)
        print("installed" if changed else "no-op: already installed")

    def status(self):
        state, block, private = self.preflight(status=True)
        if not state:
            raise Conflict("not installed")
        template = read(self.template)
        print(json.dumps({"installed_version": state["version"], "available_version": VERSION,
                          "installed_template_hash": state["template_hash"],
                          "available_template_hash": digest(template),
                          "private_bytes": len(private), "shared": str(self.shared),
                          "codex": str(self.codex), "claude": str(self.claude),
                          "launcher": str(self.launcher)}, sort_keys=True))
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
            if state["import_added"]:
                suffix = state["import_suffix"].encode()
                if suffix and claude.endswith(suffix):
                    claude = claude[:-len(suffix)]
                else:
                    claude = b"".join(line for line in claude.splitlines(keepends=True)
                                      if line.strip() != IMPORT)
            # Keep current personal bytes, never restore an old snapshot over them.
            plans = {self.shared: ("file", private, 0o600), self.codex: ("file", private, 0o600),
                     self.claude: ("file", claude, 0o600), self.launcher: ("absent", None, None),
                     self.state_path: ("absent", None, None)}
            with transaction(plans):
                atomic(self.shared, private)
                atomic(self.codex, private)
                atomic(self.claude, claude)
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
