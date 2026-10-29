from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SKILL = Path(__file__).resolve().parents[1] / "skills/workbench-setup"
ORCHESTRATION = Path(__file__).resolve().parents[1] / "skills/orchestrate-harnesses"
BEGIN = b"<!-- BEGIN agent-workbench -->"
END = b"<!-- END agent-workbench -->"
IMPORT = b"@~/.agents/AGENTS.md"


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.configure_home(Path(self.temporary.name) / "selected")

    def configure_home(self, home):
        self.home = Path(home)
        self.skill = self.home / ".agents/skills/workbench-setup"
        shutil.copytree(SKILL, self.skill)
        self.script = self.skill / "scripts/workbench.py"
        self.shared = self.home / ".agents/AGENTS.md"
        self.codex = self.home / ".codex/AGENTS.md"
        self.claude = self.home / ".claude/CLAUDE.md"
        self.launcher = self.home / ".local/bin/agent-workbench"
        self.state = self.home / ".local/state/agent-workbench"

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def run_setup(self, command, *args, ok=True):
        self.assertNotEqual(self.home, Path.home())
        result = subprocess.run([sys.executable, str(self.script), "--home", str(self.home),
                                 command, *args], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def snapshot(self):
        # Only the selected disposable home is traversed; symlinks are never followed.
        return {str(p.relative_to(self.home)): ("link", os.readlink(p)) if p.is_symlink()
                else ("file", p.read_bytes(), p.stat().st_ino, p.stat().st_mtime_ns)
                for p in self.home.rglob("*") if p.is_symlink() or p.is_file()}

    def private(self):
        data = self.shared.read_bytes()
        start = data.index(BEGIN)
        end = data.index(END) + len(END) + 1
        return data[:start] + data[end:]

    def native_lock(self):
        lock = {"version": 3, "skills": {
            "workbench-setup": {"source": "onsager-ai/agent-workbench", "sourceType": "github"},
            "disk-cleanup": {"source": "onsager-ai/agent-workbench", "sourceType": "github"},
            "unrelated": {"source": "another/project", "sourceType": "github"}}}
        self.write(self.home / ".agents/.skill-lock.json", json.dumps(lock).encode())

    def fake_command(self, body):
        path = self.home / "fake-skills.py"
        self.write(path, body.encode())
        return shlex.join([sys.executable, str(path)])

    def test_fresh_install_status_and_launcher(self):
        self.run_setup("install")
        self.assertEqual(self.private(), b"")
        self.assertTrue(self.codex.is_symlink())
        self.assertEqual(self.codex.read_bytes(), self.shared.read_bytes())
        self.assertEqual(self.claude.read_bytes(), IMPORT + b"\n")
        result = subprocess.run([str(self.launcher), "status"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["private_bytes"], 0)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        for path in (self.state / "backups").iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_migration_exact_bytes_and_idempotency(self):
        personal = "private π rules".encode() + b"\x80"
        self.write(self.shared, b"existing shared\n")
        self.write(self.codex, personal)
        self.write(self.claude, b"existing Claude text")
        self.run_setup("install")
        self.assertEqual(self.private(), b"existing shared\n" + personal)
        self.assertEqual(self.claude.read_bytes(), b"existing Claude text\n" + IMPORT + b"\n")
        before = self.snapshot()
        self.assertIn("no-op", self.run_setup("install").stdout)
        self.assertEqual(before, self.snapshot())
        import base64
        backup = json.loads((self.state / "backups/codex.json").read_bytes())
        self.assertEqual(base64.b64decode(backup["base64"]), personal)

    def test_preexisting_import_not_owned_or_duplicated(self):
        data = b"private\n" + IMPORT + b"\n"
        self.write(self.claude, data)
        self.run_setup("install")
        self.run_setup("install")
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), data)

    def test_preexisting_equivalent_import_forms_are_reused(self):
        forms = (
            b"@~/.agents/AGENTS.md",
            b"@../.agents/AGENTS.md",
            b"@./../.agents/AGENTS.md",
            None,
        )
        # Build the absolute form from each selected home at runtime.
        for index, form in enumerate(forms):
            with self.subTest(form=form or "absolute"):
                selected = Path(self.temporary.name) / f"equivalent-{index}"
                self.configure_home(selected)
                import_line = form or b"@" + os.fsencode(self.shared)
                original = "Claude café before\n".encode() + import_line + "\nAfter 雪".encode()
                self.write(self.claude, original)

                self.run_setup("install")
                self.assertEqual(self.claude.read_bytes(), original)
                state = json.loads((self.state / "state.json").read_bytes())
                self.assertFalse(state["claude_import"]["owned"])
                before_reinstall = self.claude.read_bytes()
                self.assertIn("no-op", self.run_setup("install").stdout)
                self.assertEqual(self.claude.read_bytes(), before_reinstall)
                self.run_setup("status")
                self.run_setup("uninstall")
                self.assertEqual(self.claude.read_bytes(), original)

    def test_mixed_equivalent_import_duplicates_refuse_without_writes(self):
        cases = (
            (b"@~/.agents/AGENTS.md", b"@../.agents/AGENTS.md"),
            (b"@../.agents/AGENTS.md", None),
        )
        for index, (first, second) in enumerate(cases):
            with self.subTest(index=index):
                selected = Path(self.temporary.name) / f"duplicate-{index}"
                self.configure_home(selected)
                absolute = b"@" + os.fsencode(self.shared)
                data = b"Before \xc3\xa9\n" + first + b"\n" + (second or absolute) + b"\nAfter"
                self.write(self.claude, data)
                before = self.snapshot()
                result = self.run_setup("install", ok=False)
                self.assertIn("duplicate Claude imports", result.stderr)
                self.assertEqual(before, self.snapshot())
                self.assertFalse((self.state / "state.json").exists())

    def test_foreign_import_is_preserved_and_owned_import_is_appended_once(self):
        original = b"Personal caf\xc3\xa9\n@../other/AGENTS.md\nAfter \xe9\x9b\xaa"
        self.write(self.claude, original)
        self.run_setup("install")
        expected = original + b"\n" + IMPORT + b"\n"
        self.assertEqual(self.claude.read_bytes(), expected)
        self.run_setup("install")
        self.assertEqual(self.claude.read_bytes(), expected)
        self.assertEqual(self.claude.read_bytes().count(IMPORT), 1)
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), original)

    def test_personal_claude_edit_survives_owned_import_uninstall(self):
        self.run_setup("install")
        self.claude.write_bytes(self.claude.read_bytes() + b"personal edit \xcf\x80\n")
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), b"personal edit \xcf\x80\n")

    def test_legacy_reused_import_remains_non_owned(self):
        original = b"Prior caf\xc3\xa9\n" + IMPORT + b"\nAfter"
        self.write(self.claude, original)
        self.run_setup("install")
        state_path = self.state / "state.json"
        state = json.loads(state_path.read_bytes())
        self.assertFalse(state["import_added"])
        state.pop("claude_import")
        state_path.write_text(json.dumps(state) + "\n")
        self.run_setup("status")
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), original)

    def test_legacy_added_import_remains_owned(self):
        self.run_setup("install")
        state_path = self.state / "state.json"
        state = json.loads(state_path.read_bytes())
        self.assertTrue(state["import_added"])
        state.pop("claude_import")
        state_path.write_text(json.dumps(state) + "\n")
        self.run_setup("status")
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), b"")

    def test_foreign_link_refuses_without_writes(self):
        target = self.home / "foreign"
        self.write(target, b"foreign")
        self.codex.parent.mkdir()
        self.codex.symlink_to(target)
        before = self.snapshot()
        self.run_setup("install", ok=False)
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.state.exists())

    def test_foreign_command_refuses_without_writes(self):
        self.write(self.launcher, b"foreign command")
        before = self.snapshot()
        self.run_setup("install", ok=False)
        self.assertEqual(before, self.snapshot())
        self.assertFalse(self.state.exists())

    def test_symlink_parent_refuses(self):
        directory = self.home / "elsewhere"
        directory.mkdir()
        (self.home / ".claude").symlink_to(directory, target_is_directory=True)
        before = self.snapshot()
        self.run_setup("install", ok=False)
        self.assertEqual(before, self.snapshot())

    def test_override_masking_is_reported(self):
        self.run_setup("install")
        self.write(self.home / ".codex/AGENTS.override.md", b"override")
        before = self.snapshot()
        self.assertIn("masks", self.run_setup("status", ok=False).stderr)
        self.run_setup("install", ok=False)
        self.assertEqual(before, self.snapshot())

    def test_invalid_markers_refuse_without_writes(self):
        for data in (BEGIN, END, END + BEGIN, BEGIN + BEGIN + END):
            with self.subTest(data=data):
                self.write(self.shared, data)
                before = self.snapshot()
                self.run_setup("install", ok=False)
                self.assertEqual(before, self.snapshot())

    def test_manual_managed_drift_refuses_install_and_uninstall(self):
        self.run_setup("install")
        original = self.shared.read_bytes()
        drifted = original.replace(BEGIN + b"\n", BEGIN + b"\nmanual drift\n", 1)
        self.assertNotEqual(original, drifted)
        self.shared.write_bytes(drifted)
        before = self.snapshot()
        for command in ("status", "install", "uninstall"):
            self.assertIn("drift", self.run_setup(command, ok=False).stderr)
        self.assertEqual(before, self.snapshot())

    def test_lock_contention(self):
        self.run_setup("install")
        with (self.state / "lock").open("r+") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertIn("holds the lock", self.run_setup("install", ok=False).stderr)

    def test_update_failure_preserves_instruction_bytes(self):
        self.run_setup("install")
        self.native_lock()
        command = self.fake_command("raise SystemExit(7)\n")
        before = self.snapshot()
        self.assertIn("unchanged", self.run_setup("update", "--skills-cmd", command, ok=False).stderr)
        self.assertEqual(before, self.snapshot())

    def test_alternate_home_never_defaults_to_real_npx(self):
        self.run_setup("install")
        self.native_lock()
        before = self.snapshot()
        self.assertIn("real-user npx was not invoked", self.run_setup("update", ok=False).stderr)
        self.assertEqual(before, self.snapshot())

    def test_update_only_repo_skills_then_fresh_updated_code(self):
        self.run_setup("install")
        self.native_lock()
        log = self.home / "calls.json"
        marker = self.home / "fresh-process"
        template = self.skill / "assets/AGENTS.md"
        # The updated script writes a marker only when entered as the new process.
        replacement = f'    Path({str(marker)!r}).write_text("fresh")\n    raise SystemExit(main())'
        command = self.fake_command(
            "import json, pathlib, sys\n"
            f"pathlib.Path({str(log)!r}).write_text(json.dumps(sys.argv[1:]))\n"
            f"pathlib.Path({str(template)!r}).write_bytes(b'new public template\\n')\n"
            f"p = pathlib.Path({str(self.script)!r})\n"
            "s = p.read_text()\n"
            f"s = s.replace('    raise SystemExit(main())', {replacement!r})\n"
            "p.write_text(s)\n")
        self.run_setup("update", "--skills-cmd", command)
        self.assertEqual(json.loads(log.read_text()), ["update", "disk-cleanup", "workbench-setup", "-g", "-y"])
        self.assertEqual(marker.read_text(), "fresh")
        self.assertIn(b"new public template", self.shared.read_bytes())

    def test_template_update_preserves_private_positions_and_bytes(self):
        self.run_setup("install")
        self.shared.write_bytes(b"prefix\x80" + self.shared.read_bytes() + b"suffix")
        self.write(self.skill / "assets/AGENTS.md", b"updated public\n")
        self.run_setup("status", ok=False)
        self.run_setup("install")
        data = self.shared.read_bytes()
        self.assertTrue(data.startswith(b"prefix\x80" + BEGIN))
        self.assertTrue(data.endswith(b"suffix"))
        self.assertEqual(self.private(), b"prefix\x80suffix")

    def test_uninstall_preserves_new_private_and_claude_edits(self):
        self.write(self.codex, b"original without newline")
        self.write(self.claude, b"prior Claude")
        self.run_setup("install")
        self.shared.write_bytes(self.shared.read_bytes() + b"\nnew private edits\x80")
        self.claude.write_bytes(self.claude.read_bytes() + b"later Claude\n")
        expected = self.private()
        self.run_setup("uninstall")
        self.assertFalse(self.codex.is_symlink())
        self.assertEqual(self.codex.read_bytes(), expected)
        self.assertEqual(self.shared.read_bytes(), expected)
        self.assertIn(b"later Claude\n", self.claude.read_bytes())
        self.assertNotIn(IMPORT, self.claude.read_bytes())
        self.assertFalse(self.launcher.exists())
        self.assertTrue((self.state / "backups/codex.json").exists())
        self.run_setup("uninstall")

    def test_uninstall_foreign_replaced_link_or_command_is_preserved(self):
        self.run_setup("install")
        self.codex.unlink()
        self.codex.symlink_to("different")
        before = self.snapshot()
        self.run_setup("uninstall", ok=False)
        self.assertEqual(before, self.snapshot())

    def test_uninstall_replaced_command_is_preserved(self):
        self.run_setup("install")
        self.launcher.write_bytes(b"new foreign command")
        before = self.snapshot()
        self.run_setup("uninstall", ok=False)
        self.assertEqual(before, self.snapshot())

    def test_reinstall_after_uninstall_does_not_duplicate_personal_text(self):
        self.write(self.codex, b"personal")
        self.write(self.claude, b"Claude without newline")
        self.run_setup("install")
        self.run_setup("uninstall")
        self.assertEqual(self.claude.read_bytes(), b"Claude without newline")
        self.run_setup("install")
        self.assertEqual(self.private(), b"personal")

    def test_invalid_state_refuses_without_changes(self):
        self.run_setup("install")
        self.write(self.state / "state.json", b'{"schema": 99}')
        before = self.snapshot()
        self.assertIn("invalid setup state", self.run_setup("install", ok=False).stderr)
        self.assertEqual(before, self.snapshot())

    def test_update_missing_ownership_refuses_before_command(self):
        self.run_setup("install")
        self.write(self.home / ".agents/.skill-lock.json", b'{"version": 3, "skills": {}}')
        marker = self.home / "should-not-run"
        command = self.fake_command(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
        before = self.snapshot()
        self.run_setup("update", "--skills-cmd", command, ok=False)
        self.assertFalse(marker.exists())
        self.assertEqual(before, self.snapshot())

    def test_write_failure_rolls_back_current_entries(self):
        self.write(self.codex, b"prior Codex")
        self.write(self.claude, b"prior Claude")
        spec = importlib.util.spec_from_file_location("fixture_workbench", self.script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        actual_atomic = module.atomic
        failed = False

        def fail_once(path, *args, **kwargs):
            nonlocal failed
            if path == self.claude and not failed:
                failed = True
                raise OSError("simulated write failure")
            return actual_atomic(path, *args, **kwargs)

        with mock.patch.object(module, "atomic", side_effect=fail_once):
            with self.assertRaises(OSError):
                module.Setup(self.home).install()
        self.assertFalse(self.shared.exists())
        self.assertFalse(self.codex.is_symlink())
        self.assertEqual(self.codex.read_bytes(), b"prior Codex")
        self.assertEqual(self.claude.read_bytes(), b"prior Claude")
        self.assertFalse(self.launcher.exists())
        self.assertFalse((self.state / "state.json").exists())

    def install_orchestration(self, override=None):
        shutil.copytree(ORCHESTRATION, self.home / ".agents/skills/orchestrate-harnesses")
        if override is not None:
            self.write(self.home / ".config/agent-workbench/models.json", json.dumps(override).encode())

    def agent(self, name):
        return self.home / ".claude/agents" / (name + ".md")

    def test_agents_generated_for_claude_roles_by_default(self):
        self.install_orchestration()
        self.run_setup("install")
        self.assertEqual({p.stem for p in self.agent("x").parent.iterdir()}, {"haiku", "flash", "sonnet", "opus"})
        text = self.agent("haiku").read_text()
        worker = (ORCHESTRATION / "references/worker.md").read_text()
        self.assertTrue(text.startswith("---\nname: haiku\n"))
        self.assertIn('model: "claude-haiku-5-5"\neffort: "medium"\n---\n', text)
        self.assertIn("Managed by agent-workbench", text)
        self.assertTrue(text.endswith(worker))
        state = json.loads((self.state / "state.json").read_bytes())
        self.assertEqual(set(state["agents"]), {"haiku", "flash", "sonnet", "opus"})
        self.assertIn("haiku", json.loads(self.run_setup("status").stdout)["agents"])
        self.assertIn("no-op", self.run_setup("install").stdout)

    def inspect_catalog(self, stdout, *, executable="/usr/bin/magpie", error=None):
        spec = importlib.util.spec_from_file_location("fixture_workbench_catalog", self.script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = io.StringIO()
        completed = subprocess.CompletedProcess([executable, "models", "claude"], 0, stdout, "")
        with mock.patch.object(module.shutil, "which", return_value=executable), \
                mock.patch.object(module.subprocess, "run", return_value=completed) as run, \
                contextlib.redirect_stderr(output):
            if error is not None:
                run.side_effect = error
            agents = module.Setup(self.home).desired_agents()
        return agents, output.getvalue(), run

    def test_catalog_validation_warns_for_unknown_model_and_effort(self):
        self.install_orchestration({"roles": {
            "luna": {"claude_model": "unknown/model", "effort": "max"},
            "terra": {"claude_model": "known/model", "effort": "xhigh"}}})
        _, warnings, run = self.inspect_catalog(
            "  known/model  Known Model  low/medium/high/max\n")
        self.assertIn("luna tier model 'unknown/model' is absent", warnings)
        self.assertIn("terra tier effort 'xhigh' is not listed", warnings)
        run.assert_called_once_with(["/usr/bin/magpie", "models", "claude"],
                                    capture_output=True, text=True, timeout=20, check=False)

    def test_catalog_validation_skips_when_magpie_is_absent(self):
        self.install_orchestration()
        spec = importlib.util.spec_from_file_location("fixture_workbench_no_magpie", self.script)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = io.StringIO()
        with mock.patch.object(module.shutil, "which", return_value=None), \
                mock.patch.object(module.subprocess, "run") as run, \
                contextlib.redirect_stderr(output):
            module.Setup(self.home).desired_agents()
        self.assertEqual(output.getvalue(), "")
        run.assert_not_called()

    def test_catalog_validation_failure_is_non_fatal(self):
        self.install_orchestration()
        _, warnings, run = self.inspect_catalog("", error=OSError("not runnable"))
        self.assertIn("magpie catalog unavailable; tier validation skipped", warnings)
        self.assertEqual(len(run.call_args_list), 1)

    def test_no_agents_without_orchestration_skill(self):
        result = self.run_setup("install")
        self.assertIn("not installed", result.stdout)
        self.assertFalse(self.agent("x").parent.exists())

    def test_codex_role_routed_by_override_and_removed_by_null(self):
        route = "onsager/codex/gpt-6-luna"
        self.install_orchestration({"roles": {"luna": {"claude_model": route}}})
        self.run_setup("install")
        text = self.agent("luna").read_text()
        self.assertIn(f'model: "{route}"\neffort: "max"\n', text)
        self.assertIn("gpt-6-luna via configured gateway", text)
        self.assertFalse(self.agent("terra").exists())
        self.write(self.home / ".config/agent-workbench/models.json",
                   json.dumps({"roles": {"luna": {"claude_model": None}}}).encode())
        self.run_setup("install")
        self.assertFalse(self.agent("luna").exists())
        self.assertTrue(self.agent("opus").exists())
        self.assertNotIn("luna", json.loads((self.state / "state.json").read_bytes())["agents"])

    def test_foreign_agent_file_conflicts_and_is_preserved(self):
        self.install_orchestration()
        self.write(self.agent("haiku"), b"mine\n")
        self.write(self.agent("custom"), b"custom\n")
        self.assertIn("foreign Claude agent", self.run_setup("install", ok=False).stderr)
        self.assertEqual(self.agent("haiku").read_bytes(), b"mine\n")
        self.assertFalse(self.launcher.exists())
        self.agent("haiku").unlink()
        self.run_setup("install")
        self.assertEqual(self.agent("custom").read_bytes(), b"custom\n")
        self.run_setup("uninstall")
        self.assertEqual(self.agent("custom").read_bytes(), b"custom\n")

    def test_edited_owned_agent_conflicts(self):
        self.install_orchestration()
        self.run_setup("install")
        edited = self.agent("opus").read_bytes() + b"personal\n"
        self.agent("opus").write_bytes(edited)
        for command in ("install", "status", "uninstall"):
            self.assertIn("edited", self.run_setup(command, ok=False).stderr)
        self.assertEqual(self.agent("opus").read_bytes(), edited)
        self.assertTrue(self.launcher.exists())

    def test_uninstall_removes_owned_agents(self):
        self.install_orchestration()
        self.run_setup("install")
        self.write(self.agent("custom"), b"custom\n")
        self.run_setup("uninstall")
        self.assertEqual([p.name for p in self.agent("x").parent.iterdir()], ["custom.md"])

    def test_state_without_agent_records_still_loads(self):
        self.run_setup("install")
        path = self.state / "state.json"
        state = json.loads(path.read_bytes())
        del state["agents"]
        path.write_text(json.dumps(state))
        self.run_setup("status")
        self.install_orchestration()
        self.run_setup("install")
        self.assertTrue(self.agent("sonnet").exists())
        self.run_setup("uninstall")
        self.assertFalse(self.agent("sonnet").exists())

    def test_missing_resource_and_duplicate_import_status(self):
        self.run_setup("install")
        template = self.skill / "assets/AGENTS.md"
        template.unlink()
        self.assertIn("missing canonical", self.run_setup("status", ok=False).stderr)
        self.write(template, b"public\n")
        self.claude.write_bytes(self.claude.read_bytes() + IMPORT + b"\n")
        self.assertIn("duplicate", self.run_setup("status", ok=False).stderr)


if __name__ == "__main__":
    unittest.main()
