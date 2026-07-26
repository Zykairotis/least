# Local Agent Orchestrator Skill

Skill source:

```text
skills/local-agent-orchestrator/
```

This skill teaches ChatGPT how to route, launch, monitor, and review local coding agents through Least/Xacho `agent_*` tools.

Direct `agent_*` tools are the primary path. If a chat does not expose them yet, the supported fallback is to call `open_workspace` or `least_inventory`, then use the Windows-native PowerShell CLI bridge guidance those tools return.

The CLI bridge must run from the Least install directory and pass the actual project with `--root`. Target folders do not need their own `package.json`; unregistered folders run as direct-folder jobs with logs/results under the target folder's `.ai-bridge/agent-runs`.

## Files

```text
skills/local-agent-orchestrator/
  SKILL.md
  agents/openai.yaml
  references/agent-selection.md
  references/prompt-contracts.md
  references/safety-policy.md
  references/result-review.md
  templates/implementation-prompt.md
  templates/debug-prompt.md
  templates/review-prompt.md
```

## Intended use

Use this skill when a user asks ChatGPT to delegate repository work to local agents such as:

- Claude Code
- Codex
- Codex WSL
- Oh My Pi / Pi
- Grok build mode
- custom Groundcrew-backed profiles

## Workflow encoded by the skill

```text
agent_doctor -> agent_list -> agent_plan -> agent_start -> agent_status/agent_tail/agent_watchdog -> agent_result -> review summary
```

The skill explicitly tells ChatGPT not to run arbitrary local agent shell commands directly. It must use registered `agent_*` tools and named allowlisted profiles.

When the live MCP server is healthy but a chat still does not show direct `Xacho.agent_*` tools, the expected operator recovery is: reconnect the connector/server, then open a brand-new chat.

## Packaging note

The source is now in the repository. To upload it as a ChatGPT Skill, package `skills/local-agent-orchestrator/` as a skill zip using the normal skill packaging/validation flow for the target ChatGPT environment.
