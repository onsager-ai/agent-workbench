<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/agent-workbench-lockup-dark.svg">
    <img src="docs/brand/agent-workbench-lockup-light.svg" alt="Agent Workbench" width="360">
  </picture>
</p>

# Agent Workbench Skills

Agent Workbench is a set of portable skills for Codex and Claude Code that helps a Manager plan and delegate engineering work to Workers, then track handoffs across sessions and machines.

## Quick start

1. Set up Agent Workbench:

   ```sh
   npx @onsager/awb setup
   ```

   This installs the skills and applies the shared global instructions and setup tools.

2. Start a new Manager session. Use the native subagent tools in your harness to delegate work; setup details and configuration are in the [reference](docs/reference.md).

For manual skill installation, updates, project-local installs, `awb prune` cleanup, and detailed configuration, see the [reference](docs/reference.md). Setup does not install agent tools or authenticate harnesses.

## Skills

- **manage-lane** — maintain task intent, authorization, and handovers.
- **orchestrate-harnesses** — coordinate native Workers and T3 Code Managers.
- **prompt-for-decisions** — surface unresolved choices with evidence and trade-offs.
- **thermal-guard** — gate CPU-heavy work using a supported package temperature sensor.
- **workbench-setup** — apply shared global instructions while preserving personal text.
- **disk-cleanup** and **review-storybook** are optional skills.

## License

MIT. See [LICENSE](LICENSE).
