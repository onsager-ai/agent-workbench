---
name: hapi-runner-setup
description: Register or repair a HAPI runner as a Linux systemd user service, including private Codex provider credentials and verification from the runner environment.
---

Use for an existing HAPI installation on Linux with a working systemd user manager. Installing HAPI, changing providers, or enabling startup are separate choices; perform only the requested setup. Preserve unrelated configuration and active sessions.

## Inspect the machine

- Find the installed HAPI executable and run `hapi runner --help`. Confirm that `runner start-sync` is the foreground entry point for this installation before using it in a service. `runner start` backgrounds itself and is unsuitable as the service's main process.
- Inspect existing user units, the running runner, hub URL, workspace-root arguments, working directory, and executable search paths. Preserve explicit restrictions and required configuration. Inspect only needed environment keys; never dump process environments, authentication files, or systemd environment values containing secrets.
- Check the user's Codex provider configuration and its authentication source. A key available in an interactive shell does not establish that systemd or an existing Codex process has it.

## Register the user service

Use `~/.config/systemd/user/hapi-fly-runner.service` unless the user selects another name. Adapt this template to the discovered executable and required environment; replace the executable marker before validation:

```ini
[Unit]
Description=HAPI Fly runner
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=ABSOLUTE_HAPI_EXECUTABLE runner start-sync
Restart=on-failure
RestartSec=3
# Stop only the runner; keep its agent sessions alive.
KillMode=process
TimeoutStopSec=30

[Install]
WantedBy=default.target
```

Include the existing `HAPI_API_URL` and needed workspace-root arguments. Set a stable `PATH` covering HAPI's agent CLIs and their runtimes, including Node when required. Do not copy temporary Codex paths, session IDs, or the entire current process environment. Do not introduce service sandbox restrictions that change the user's agent permissions.

`KillMode=process` deliberately leaves spawned agents alive across service restarts. This unit does not stop an entire agent process tree. Do not add a global `hapi runner stop` ExecStop: it could stop a different runner if someone has replaced the managed process.

Validate the unit with `systemd-analyze --user verify`. If migrating an unmanaged runner, use the supported `hapi runner stop` command after preparing the configuration, then reload systemd and start the service. Confirm this HAPI version preserves sessions on stop. Enable the unit when startup is requested. Check `loginctl show-user "$USER" -p Linger`; boot startup without login requires lingering, which should be enabled only within the user's requested scope and available permissions.

## Supply provider credentials privately

When authorized, reuse a key already available locally without printing it. If it is unavailable, have the user enter it through a private local mechanism, rather than chat or a command argument. Keep credentials outside the repository.

Store only the required variables in `~/.config/hapi-fly/runner.env`, with mode `0600` and a private parent directory. Preserve other existing variables. Write valid systemd EnvironmentFile syntax: quote and escape values correctly; the file is not a shell script, so do not use `export`, substitutions, or shell commands. Never put credentials in a unit's `Environment=` line, process arguments, logs, or commit.

Use a service drop-in, preserving existing overrides:

```ini
[Service]
EnvironmentFile=%h/.config/hapi-fly/runner.env
```

For a requested Magpie setup, configure the user-level Codex config with the following provider settings, preserving the chosen model and unrelated configuration. Replace the example URL with the user's endpoint from private local configuration; keep real deployment hostnames out of this public skill:

```toml
model_provider = "magpie"

[model_providers.magpie]
name = "Magpie Gateway"
base_url = "https://gateway.example.com/v1"
env_key = "MAGPIE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

`model_provider` belongs at the TOML root. Merge this into the existing file rather than appending a root key inside another table or duplicating an existing provider. The environment file supplies `MAGPIE_API_KEY`; it contains the private value, never this skill or the repository.

Apply changes with `systemctl --user daemon-reload` and `systemctl --user restart hapi-fly-runner.service`. Once managed, use systemctl for runner lifecycle operations; `hapi runner start` replaces the runner outside systemd.

## Verify and report

- Confirm active/running state, the service MainPID matching HAPI's runner state, the expected hub, startup enablement when requested, and continued existence of previously active agent sessions. Allow normal initialization before checking the state file; it may briefly be absent during restart.
- Verify the credential variable is present in the actual MainPID's environment without displaying its value. Use that process's credential for one small request to the configured provider and selected model. For Responses streaming, require a completed response with the expected text, not merely HTTP 200. Bound the timeout and response size; do not send repository contents as test input.
- Distinguish a successful gateway probe from a verified Codex session. Existing Codex processes retain their startup configuration and environment; start a fresh HAPI Codex session to verify the complete path. Never claim this conversation switched providers based solely on a config edit or successful direct API request.
- Report the service name, verification result, any pending fresh-session check, and the status/log commands. Keep all credential values out of the report.
