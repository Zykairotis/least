# Safety Policy

Use this policy before launching write-capable or unknown local agents.

## Allowed by default

- repo analysis
- static code review
- test/debug investigation
- worktree-contained edits
- diff generation
- build/test commands inside the assigned workspace

## Require explicit user approval

- broad refactors across many packages
- deleting many files
- dependency upgrades with lockfile changes
- migrations or generated-code rewrites
- network-heavy operations
- unsandboxed profiles
- running custom or newly discovered agents

## Refuse or redirect unless explicitly authorized and tool policy permits

- deployment, publish, release, package upload
- production database changes
- secret/key/token rotation
- exfiltration or printing secrets
- edits outside assigned worktree
- disabling security checks
- bypassing approvals/sandboxes for normal work

## Runtime guardrails

- Use `agent_plan` before `agent_start`.
- Use `agent_watchdog` for overdue jobs.
- Preserve worktrees on cancel/timeout.
- Do not auto-merge or auto-apply agent output.
- Use `agent_result` and review diffs before presenting conclusions.
