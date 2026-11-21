# Gate CPU-heavy local work

On Linux machines with a supported CPU temperature sensor (Intel `x86_pkg_temp` or coretemp `Package id 0`, or AMD k10temp `Tctl`), check temperature before CPU-heavy local work and run heavy commands through the guard.

```sh
thermal now
thermal gate -- <command>
```

`thermal now` exits 75 at 85 °C or above or if the sensor is unreadable. Stop CPU-heavy local work and use CI if it exits 75. `thermal gate` admits a command below 75 °C, staggers starts with a lock held for up to the first 30 seconds of a run, and runs the command at low priority. It kills the process group at 88 °C or after two readings at 85 °C or above. Use CI if the gate returns 75. If the command is unavailable or reports exit 69 (no supported sensor), the thermal rule does not apply on that machine. Carry the rule into delegated work.

After distributing `host-ops`, run `agent-workbench install` or invoke the bundled `scripts/thermal install` to add the launcher and, when user systemd is available, the temperature logger. `thermal status` reports the sensor, service, log freshness, and linger state. `thermal uninstall` removes only the launcher and service it owns.
