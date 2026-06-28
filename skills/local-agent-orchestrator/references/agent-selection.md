# Agent Selection

Choose the least risky capable agent. Prefer configured Groundcrew/Least profiles over raw commands.

## Default routing

| Task | Prefer | Notes |
|---|---|---|
| Broad repo investigation, architecture reasoning, multi-file planning | `claude-code` | Good for codebase comprehension and structured explanation. |
| Patch-oriented implementation, refactor, test-driven local changes | `codex` or `codex-wsl` | Use WSL only when Linux tooling or WSL-native environment is required. |
| Independent review or second opinion | different agent from implementer | Do not review an agent's own patch with the same assumptions. |
| Build-mode or UI/build workflows | `grok-build` | Use when `agent_doctor` confirms the `grok` CLI and local profile are available. |
| Pi/Oh My Pi workflows | `oh-my-pi` | Use when `agent_doctor` confirms the `omp` CLI and local profile are available. |

## Selection procedure

1. Call `agent_doctor` if setup or profile validity is unknown.
2. Call `agent_list` to see available Groundcrew profiles.
3. Match the user request to the safest capable profile.
4. If the requested profile is disabled, missing, or unknown, do not launch. Explain the missing setup and suggest `agent_doctor`/config steps.
5. Use `agent_plan` before launching.

## Red flags requiring extra caution

- prompt asks for deployment, production data, credentials, releases, migrations, or secret handling
- user asks for large refactor without constraints
- local config has `enabled: false`
- profile command contains shell-control syntax
- worktree or sandbox policy is unclear
- user wants Pi/Oh My Pi but `agent_doctor` cannot find `omp` or the local profile is disabled
- user wants Grok Build but `agent_doctor` cannot find `grok` or the local profile is disabled
