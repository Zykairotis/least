# Result Review

Use this checklist after `agent_result`.

## Inspect

- job id and task id
- final state and timeout fields
- worktree path and branch
- changed files
- diff stat
- full diff when needed
- tail/log warnings
- verification output claimed by the agent

## Interpret states

| State/conclusion | Meaning | Response action |
|---|---|---|
| `ready-for-review` | Worktree has changes | Summarize changes and ask/offer next action. |
| `still-running` | Agent may not be finished | Use `agent_tail` or `agent_watchdog`. |
| `timeout-soft` | Groundcrew interruption succeeded | Explain timeout reason and preserve worktree. |
| `timeout-hard` | Interruption failed | Warn user; manual process cleanup may be needed. |
| `no-changes` | No diff found | Report that no worktree changes were detected. |
| `failed` / `failed-to-launch` | Launch or run failed | Show error and setup/retry path. |

## Final response format

```text
Status:
Agent/job:
What changed:
Verification:
Risks:
Next step:
```

Do not overstate. If verification did not run, say so. If only diff stat is available, say that the summary is based on diff stat and file names.
