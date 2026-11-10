from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


THERMAL = Path(__file__).resolve().parents[1] / "skills/thermal-guard/scripts/thermal"


class ThermalGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sysfs = self.root / "sys"
        self.home = self.root / "home"
        self.home.mkdir()

    def sensor(self, value: str) -> Path:
        zone = self.sysfs / "class/thermal/thermal_zone0"
        zone.mkdir(parents=True)
        (zone / "type").write_text("x86_pkg_temp\n")
        path = zone / "temp"
        path.write_text(value)
        return path

    def thermal(self, *args: str, timeout: float = 8, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "HOME": str(self.home), "THERMAL_SYSFS": str(self.sysfs)}
        if extra_env:
            env.update(extra_env)
        return subprocess.run([str(THERMAL), *args], text=True, capture_output=True, env=env, timeout=timeout)

    def test_now_handles_cool_hot_unreadable_and_unsupported_sensors(self) -> None:
        self.sensor("52000\n")
        cool = self.thermal("now")
        self.assertEqual(cool.returncode, 0, cool.stderr)
        self.assertIn("52C sensor=", cool.stdout)

        self.sensor("85000\n")
        hot = self.thermal("now")
        self.assertEqual(hot.returncode, 75)
        self.assertIn("85C", hot.stdout)

        temp = self.sensor("52000\n")
        temp.unlink()
        temp.mkdir()
        unreadable = self.thermal("now")
        self.assertEqual(unreadable.returncode, 75)
        self.assertIn("cannot be read", unreadable.stderr)

        shutil.rmtree(self.sysfs)
        unsupported = self.thermal("now")
        self.assertEqual(unsupported.returncode, 69)
        self.assertIn("unsupported", unsupported.stderr)

    def test_gate_runs_when_cool_refuses_unsupported_and_stops_hot_group(self) -> None:
        sensor = self.sensor("52000\n")
        cool = self.thermal("gate", "--", "sh", "-c", "exit 7")
        self.assertEqual(cool.returncode, 7, cool.stderr)

        shutil.rmtree(self.sysfs)
        unsupported = self.thermal("gate", "--", "true")
        self.assertEqual(unsupported.returncode, 69)

        sensor = self.sensor("52000\n")
        env = {**os.environ, "HOME": str(self.home), "THERMAL_SYSFS": str(self.sysfs)}
        process = subprocess.Popen([str(THERMAL), "gate", "--", "sh", "-c", "sleep 30"], text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        time.sleep(1)
        sensor.write_text("90000\n")
        _, stderr = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 75, stderr)
        self.assertIn("stopped at 90C", stderr)

    def test_install_is_a_noop_without_sensor(self) -> None:
        result = self.thermal("install")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unsupported", result.stdout)
        self.assertFalse((self.home / ".local/bin/thermal").exists())

    def test_install_keeps_launcher_when_systemctl_fails(self) -> None:
        self.sensor("52000\n")
        fake_bin = self.root / "bin"
        fake_bin.mkdir()
        fake_systemctl = fake_bin / "systemctl"
        fake_systemctl.write_text("#!/bin/sh\nexit 1\n")
        fake_systemctl.chmod(0o700)
        result = self.thermal("install", extra_env={"PATH": f"{fake_bin}:{os.environ['PATH']}"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("service not installed", result.stdout)
        launcher = self.home / ".local/bin/thermal"
        self.assertTrue(launcher.is_symlink())
        self.assertEqual(launcher.resolve(), THERMAL.resolve())


if __name__ == "__main__":
    unittest.main()
