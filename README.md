# Agent Workbench Skills

Five portable skills for Codex and Claude Code:

- disk-cleanup — inspect and reclaim safe, regenerable disk usage.
- manage-lane — maintain task intent, authorization and handovers.
- orchestrate-harnesses — coordinate engineering work across agent roles with explicit contracts and lifecycle controls.
- prompt-for-decisions — present a real unresolved user choice with evidence and trade-offs.
- review-storybook — review interactive Storybook previews against a specific revision.

## Requirements

The skills CLI requires Node.js 22.20 or newer.

The bundled orchestration controller is Linux-only and requires Python 3.11+ and the native agent CLIs already installed and authenticated in the user's environment. Installing skills with npx does not install those tools or provide credentials.

OS sandboxing is optional. Workers use the user's explicitly evidenced permission policy: `danger-full-access` runs without an additional Codex OS sandbox, while `workspace-write` and `read-only` request isolation. Worktrees keep task changes separate; they do not enforce a security boundary. The editable task example shows an explicit full-access choice; replace its policy and evidence with the current user's actual choice.

Worker dispatch requires an explicit v2 contract recording policy source/evidence, sandbox mode and approval policy. Read-only tasks are capped at read-only. A bounded no-inference startup probe validates resolved CLI policy and execution before each Worker run; failures block without widening permissions or consuming inference attempts. Historical v1 status and reviews remain available, but v1 Worker dispatch requires a new v2 task. See [Worker permission policy](skills/orchestrate-harnesses/references/worker-permissions.md).

## Install globally

~~~sh
npx skills add onsager-ai/agent-workbench -g -a codex -a claude-code --skill '*' -y
~~~

## Update globally

~~~sh
npx skills update -g -y
~~~

These commands manage skills only. User-scope AGENTS.md and CLAUDE.md, credentials and personal configuration remain separate and private; the skills installer does not create or modify them.

## Project-local install

From the project where you want the skills available, omit -g:

~~~sh
npx skills add onsager-ai/agent-workbench -a codex -a claude-code --skill '*' --copy -y
~~~

The --copy option installs independent copies in the project. This is useful when the project should carry its own skill versions.

## Set up a new machine

Install Node.js 22.20 or newer, then run the global install command above. To keep skills current later, run the global update command. For orchestration, also install Python 3.11+ and the native CLIs you intend to use, then authenticate those CLIs through their own supported setup. This repository does not manage user instructions, credentials or agent authentication.

## License

MIT. See [LICENSE](LICENSE).
