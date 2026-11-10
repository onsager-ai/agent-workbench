---
name: thermal-guard
description: Safely gate CPU-heavy local work by the machine's supported package-temperature sensor.
---

On Linux machines with a supported CPU temperature sensor (Intel `x86_pkg_temp`/coretemp `Package id 0`, or AMD k10temp `Tctl`), check temperature before CPU-heavy local work and put heavy commands behind the guard:

```sh
thermal now
thermal gate -- <command>
```

`thermal now` exits 75 at 85C or above, and `thermal gate` starts below 75C, runs one command at a time with low priority, and kills its process group at 88C or after two readings at 85C or above. Use CI if it returns 75. Exit 69 means no supported sensor exists, so this thermal rule does not apply on that machine. Carry the rule into delegated work.

After the skill is installed, use `thermal install` to add its launcher and, when a working user systemd manager is available, its temperature logger. `thermal status` reports the sensor, service, log freshness, and linger state. `thermal uninstall` removes only the launcher and service it owns.
