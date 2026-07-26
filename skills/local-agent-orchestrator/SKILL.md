---
name: local-agent-orchestrator
description: coordinate long-running local coding agents through Least/Xacho agent tools. Use when the user asks to delegate repository work, refactors, debugging, builds, implementation, review, or investigation to local agents such as Claude Code, Codex, Codex WSL, Oh My Pi/Pi, Grok build mode, OpenCode, or Groundcrew-backed agents. Trigger for requests involving agent_start, agent_status, agent_tail, agent_result, agent_watchdog, worktree-based local automation, or safe orchestration of local CLI coding agents.
---

# Local Agent Orchestrator

Use this skill to decide, launch, monitor, and review local agent work through Least/Xacho `agent_*` tools.

## Core rule

Do not run arbitrary local agent shell commands directly. Use the registered Least agent tools and named, allowlisted agent profiles.

## First checks

1. For setup/config questions, call `agent_doctor` first.
2. For available agents, call `agent_list`.
3. For any launchable task, call `agent_plan` before `agent_start` unless the user explicitly asks only for status/result/cancel.
4. For write-capable tasks, require a worktree-backed profile and mutation lock where the tool requires it.
5. For unknown/custom agents such as Oh My Pi or Grok build mode, do not launch unless `agent_doctor` and local config show the profile is enabled and verified.

## Tool sequence

Use this default flow:

```text
agent_doctor -> agent_list -> agent_plan -> agent_start -> agent_status/agent_tail/agent_watchdog -> agent_result -> review summary
```

For status-only requests:

```text
agent_status -> agent_tail if needed -> agent_result if job has worktree output
```

For cancellation:

```text
agent_cancel
```

For timeout enforcement:

```text
agent_watchdog
```

## Agent choice

Load `references/agent-selection.md` when selecting among Claude Code, Codex, Codex WSL, Pi, Grok build mode, or custom profiles.

## Prompting

Load `references/prompt-contracts.md` and one template from `templates/` before launching a non-trivial agent task.

Use:

- `templates/implementation-prompt.md` for code changes.
- `templates/debug-prompt.md` for bug investigation/fix loops.
- `templates/review-prompt.md` for independent review or second opinion.

## Safety

Load `references/safety-policy.md` before launch if the task is write-capable, destructive, security-sensitive, credential-adjacent, or uses unknown/custom agent commands.

Never ask an agent to deploy, publish, release, delete data, rotate secrets, migrate production state, or modify files outside the assigned worktree unless the user explicitly asks and the local tool policy allows it.

## Result review

Load `references/result-review.md` before presenting final results from `agent_result`.

Always report:

- job id and task id
- agent/profile used
- state and timeout state
- changed files
- diff/stat summary
- verification evidence
- risks and remaining manual checks

Do not claim changes are correct solely because an agent completed. Inspect the result and summarize concrete evidence.
