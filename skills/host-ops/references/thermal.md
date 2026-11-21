# Gate CPU-heavy local work

On Linux machines with a supported CPU temperature sensor (Intel `x86_pkg_temp` or coretemp `Package id 0`, or AMD k10temp `Tctl`), check temperature before CPU-heavy local work and run heavy commands through the guard.

```sh
awb ops thermal now
awb ops thermal gate -- <command>
```

`awb ops thermal now` exits 75 at 85 °C or above or if the sensor is unreadable. `awb ops thermal gate` admits a command below 75 °C, staggers starts with a lock held for up to the first 30 seconds of a run, and runs the command at low priority. It kills the process group at 88 °C or after two readings at 85 °C or above.

On exit 75, stop CPU-heavy local work and use CI, continue with work that does not load the CPU, or wait for a safe reading. If the command is unavailable or reports exit 69 (no supported sensor), the thermal rule does not apply on that machine. Carry the rule into delegated work.

For frequent calls, use `agent-workbench ops thermal now` and `agent-workbench ops thermal gate -- <command>` through the installed `~/.local/bin/agent-workbench` launcher. These commands run locally without `npx`.

After Workbench setup, run `awb ops thermal install` only if you want the background logger and have user systemd. `awb ops thermal status` reports the sensor, service, log freshness, and linger state. `awb ops thermal uninstall` removes the logger and keeps its logs. All three commands also work through `agent-workbench ops thermal`.
