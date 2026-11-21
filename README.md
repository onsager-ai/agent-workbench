<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/agent-workbench-lockup-dark.svg">
    <img src="docs/brand/agent-workbench-lockup-light.svg" alt="Agent Workbench" width="360">
  </picture>
</p>

# Agent Workbench Skills

Agent Workbench is a set of portable skills for Codex and Claude Code that helps a Manager plan and delegate engineering work to Workers, then track handoffs across sessions and machines.

## Why use it

Coding agents work best when one session keeps the plan and cheaper ones do the work. Without rules, an agent picks the most expensive model for small jobs, loses track of what you approved, and leaves half-finished branches behind. Agent Workbench gives your session a working routine:

- **Your session plans, Workers build.** The session you talk to is the Manager. It splits the task, sends each piece to a Worker subagent and checks the result before telling you it's done.
- **Start small, escalate when needed.** L1 uses a small, fast, low-cost model for bounded work. L2 uses a capable general model for research, spikes, and architecture. L3 uses the strongest model and needs your approval for each task. The default Claude mapping is Haiku, Sonnet, and Opus; an optional Codex profile maps Luna + Haiku to L1, Sol + Sonnet to L2, and Opus to L3. You can map any models from a gateway or another harness in `workers.yml`.
- **Questions you can answer quickly.** When the agent needs a decision, it asks with your harness's question tool and puts its recommended option first.
- **Handoffs survive.** The Manager records what you asked for and what you approved, so a later session or another machine can pick up the task.

## Quick start

1. Set up Agent Workbench:

   ```sh
   npx @onsager/awb setup
   ```

   This installs the skills and applies the shared global instructions and setup tools.

2. If you use Codex, review and trust its hooks once:

   ```sh
   awb trust
   ```

3. Start a new Manager session. Use the native subagent tools in your harness to delegate work; setup details and configuration are in the [reference](docs/reference.md).

For manual skill installation, updates, project-local installs, `awb prune` cleanup, and detailed configuration, see the [reference](docs/reference.md). Setup does not install agent tools or authenticate harnesses.

## What setup changes

Setup writes only to your home directory and never to your repositories.

| Path | Change |
| --- | --- |
| `~/.agents/skills`, `~/.claude/skills` | The skills listed below |
| `~/.agents/AGENTS.md` | [Shared instructions](skills/workbench-setup/assets/AGENTS.md), imported from `~/.claude/CLAUDE.md` and added as a marked block to `~/.codex/AGENTS.md`. Your own text in those files stays. |
| `~/.claude/settings.json`, `~/.codex/hooks.json` | A policy hook (see below) and a 300,000-token auto-compact window |
| `~/.claude/agents` | `haiku`, `sonnet` and `opus` Worker subagents |
| `~/.local/bin` | The `agent-workbench` and `thermal` commands |

Once installed, the policy hook will:

- block checking out, committing to or pushing a local `main` or `master` branch, so work happens on task branches;
- ask before dispatching an L3 Worker (Opus by default);
- block GitHub polling, such as `gh pr checks --watch` or `sleep` loops around `gh`;
- send the agent back when it ends a turn with a question written as prose, so it asks with the question tool.

The shared instructions also tell agents to check CPU temperature before heavy local work. That rule applies only on Linux machines with a supported sensor.

## Undo

```sh
awb uninstall                       # restore instructions, settings and hooks; keep your own edits
npx skills remove -g --all          # remove installed skills (this removes every global skill)
```

To remove only these skills, name them: `npx skills remove -g manage-lane orchestrate-harnesses prompt-for-decisions thermal-guard workbench-setup disk-cleanup review-storybook`.

## Skills

- **manage-lane** — maintain task intent, authorization, and handovers.
- **orchestrate-harnesses** — coordinate native Workers and T3 Code Managers.
- **prompt-for-decisions** — surface unresolved choices with evidence and trade-offs.
- **thermal-guard** — gate CPU-heavy work using a supported package temperature sensor.
- **workbench-setup** — apply shared global instructions while preserving personal text.
- **disk-cleanup** and **review-storybook** are optional skills.

## License

MIT. See [LICENSE](LICENSE).
