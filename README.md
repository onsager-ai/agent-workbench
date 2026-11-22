English | [简体中文](README.zh-CN.md)

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

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/how-it-works-dark.svg">
    <img src="docs/media/how-it-works-light.svg" alt="You talk to a Manager session. It sends work to Haiku, Sonnet or Opus Workers, checks their results and hands tasks over to other Managers. A policy hook checks every step." width="720">
  </picture>
</p>

For what you get, how it works and how it compares with similar projects, see the [overview](docs/overview.md).

A real Claude Code session after setup: the Manager sends a bug fix to a Haiku Worker, then checks the diff, the commit and the tests itself before reporting.

<img src="docs/media/session.gif" alt="Claude Code session: asked to have a Worker fix an off-by-one bug, the Manager writes a brief, a Haiku Worker commits the fix on a task branch, and the Manager verifies the diff, commit and tests before reporting." width="720">

## Quick start

1. Set up Agent Workbench:

   ```sh
   npx @onsager/awb setup
   ```

   This installs the skills and applies the shared global instructions and setup tools.

   <img src="docs/media/demo.svg" alt="Terminal demo: setup installs the skills, Worker subagents and policy hook. In an agent session the hook then blocks a commit on main and CI polling, asks before an Opus Worker, and sends a prose question back." width="720">

2. If you use Codex, review and trust its hooks once:

   ```sh
   awb trust
   ```

3. Start a new Manager session. Use the native subagent tools in your harness to delegate work; setup details and configuration are in the [reference](docs/reference.md).

Run `awb lanes` to see your open PRs and local worktrees.

For manual skill installation, updates, project-local installs, `awb prune` cleanup, and detailed configuration, see the [reference](docs/reference.md). Setup does not install agent tools or authenticate harnesses.

Gateway and CC Switch users can copy the [neutral Worker profile](docs/reference.md#neutral-profile-for-provider-switching) to use plain Worker names and follow provider model aliases.

## What setup changes

Setup writes only to your home directory and never to your repositories.

| Path | Change |
| --- | --- |
| `~/.agents/skills`, `~/.claude/skills` | The skills listed below |
| `~/.agents/AGENTS.md` | [Shared instructions](skills/workbench-setup/assets/AGENTS.md), imported from `~/.claude/CLAUDE.md` and added as a marked block to `~/.codex/AGENTS.md`. Your own text in those files stays. |
| `~/.claude/settings.json`, `~/.codex/hooks.json` | A policy hook (see below) and a 300,000-token auto-compact window |
| `~/.claude/agents` | `haiku`, `sonnet` and `opus` Worker subagents |
| `~/.local/bin` | The `agent-workbench` launcher |

Once installed, the policy hook will:

- block checking out, committing to or pushing a local `main` or `master` branch, so work happens on task branches;
- ask before dispatching an L3 Worker (Opus by default);
- block GitHub polling, `while` or `until` loops with `sleep`, and `for` loops with both `sleep` and `gh`;
- make Claude Code Managers delegate CI log retrieval to Workers;
- send the agent back when it ends a turn with a question written as prose, so it asks with the question tool.

On Linux machines with a supported sensor, use `awb ops thermal now` before heavy local work and `awb ops thermal gate -- <command>` to run it. Use the installed `agent-workbench ops thermal` launcher for frequent calls without `npx`. To enable background logging on a machine with user systemd, run `awb ops thermal install` after setup.

## Undo

If you enabled the optional logger, run `awb ops thermal uninstall` before removing the skills. Your thermal logs are retained.

```sh
awb uninstall                       # restore instructions, settings and hooks; keep your own edits
npx skills remove -g --all          # remove installed skills (this removes every global skill)
```

To remove only these skills, name them: `npx skills remove -g manage-lane orchestrate-harnesses prompt-for-decisions host-ops workbench-setup review-storybook`.

## Skills

- **manage-lane** — maintain task intent, authorization, and handovers.
- **orchestrate-harnesses** — coordinate native Workers and T3 Code Managers.
- **prompt-for-decisions** — surface unresolved choices with evidence and trade-offs.
- **host-ops** — gate CPU-heavy work on supported machines and inspect or reclaim local disk space.
- **workbench-setup** — apply shared global instructions while preserving personal text.
- **review-storybook** is optional.

## License

MIT. See [LICENSE](LICENSE).
