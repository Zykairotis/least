# Local Agent Orchestrator Skill

Skill source:

```text
skills/local-agent-orchestrator/
```

This skill teaches ChatGPT how to route, launch, monitor, and review local coding agents through Least/Xacho `agent_*` tools.

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

## Packaging note

The source is now in the repository. To upload it as a ChatGPT Skill, package `skills/local-agent-orchestrator/` as a skill zip using the normal skill packaging/validation flow for the target ChatGPT environment.
