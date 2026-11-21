---
name: host-ops
description: Follow host resource limits for CPU-heavy local work and inspect or reclaim local disk space.
---

# Host operations

- Before CPU-heavy local work, use `awb ops thermal` and follow the [thermal rules](references/thermal.md) for supported machines.
- When storage is filling up or the user asks about disk space, follow the [disk guidance](references/disk.md) to measure usage and reclaim disposable files within the authorized scope.
- Carry applicable host and repository resource limits into delegations and resumes.
