# Local agent orchestration

Least can expose local coding agents through MCP tools backed by Groundcrew.

This implementation provides planning, setup checks, listing, starting, status, watchdog timeout enforcement, terminal output tailing through Zellij/tmux/log fallback, attach hints, session listing, worktree result summaries, cancellation, resume, and conservative cleanup. It does not yet provide hard process-kill escalation beyond Groundcrew interruption or direct Least-owned agent process spawning.

## Prerequisites

Install and configure Groundcrew before using launch/status/cancel tools:

```bash
npm install -g @clipboard-health/groundcrew
crew init
```

Groundcrew must have a valid `crew.config.ts` with:

- `workspace.projectDir`
- `workspace.knownRepositories`
- `agents.default`
- `agents.definitions`
- a terminal backend such as `tmux`, `cmux`, or `zellij`

See the local reference clone for Groundcrew docs:

```text
plan/groundcrew-reference/docs/
```

External CLI details for Claude Code, Codex, Codex WSL wrappers, Oh My Pi, and Grok build mode are tracked here:

```text
docs/local-agent-cli-tools.md
```

Local agent config details and sample paths are tracked here:

```text
docs/local-agent-config.md
docs/examples/agents.local.example.jsonc
```

Skill source is tracked here:

```text
docs/local-agent-skill.md
skills/local-agent-orchestrator/
```

## Tools

### `agent_doctor`

Checks local agent orchestration setup.

It reports:

- local config parse state from `.least/agents.local.jsonc` or `agents.local.jsonc`
- built-in, local, and effective agent profiles
- Groundcrew import/config status
- configured Groundcrew agents
- missing Groundcrew profiles for enabled local profiles
- terminal backend availability for Zellij, tmux, and Least job logs
- local command availability for `git`, `tmux`, `zellij`, `wsl` on Windows, and enabled profile executables
- version/smoke checks where configured
- warnings for disabled, unsafe, or high-risk profile definitions

### `agent_list`

Lists the agents configured in Groundcrew.

Required setup:

- `@clipboard-health/groundcrew` must be importable from the Least runtime.
- `crew.config.ts` must be discoverable by Groundcrew.

### `agent_plan`

Dry-runs a local agent launch. It generates a task id, risk level, timeout metadata, and warnings. It does not call Groundcrew and does not create worktrees or job files.

Required fields:

- `repository` or `repo`
- `prompt`

Useful optional fields:

- `agent`
- `title`
- `mode`
- `timeout_ms`
- `idle_timeout_ms`

### `agent_start`

Starts a Groundcrew-backed local agent job.

Required fields:

- `repository` or `repo`
- `prompt`

Optional fields:

- `agent`; omitted uses `agents.default` from Groundcrew config
- `title`
- `task_id`
- `timeout_ms`
- `idle_timeout_ms`
- `lease_token` when Least concurrency mode is `lease`

Behavior:

1. Creates `.ai-bridge/agent-runs/<job_id>/prompt.md`.
2. Creates `.ai-bridge/agent-runs/<job_id>/status.json`.
3. Calls Groundcrew `setupWorkspace`.
4. Refreshes the Least job record from Groundcrew `readRunState`.
5. Returns `job_id`, `task_id`, state, branch/worktree data when available.

### `agent_status`

Reads a local agent job by `job_id` or `task_id`, refreshes it from Groundcrew run state, and reports watchdog deadline/idle status. By default it detects expired timeouts but does not enforce interruption.

### `agent_watchdog`

Evaluates and optionally enforces wall-clock and idle timeouts for a local agent job.

Required fields:

- `job_id` or `task_id`

Optional fields:

- `enforce_timeouts`; default `true` for `agent_watchdog`
- `lease_token` when Least concurrency mode is `lease` and enforcement is enabled

Behavior:

- Refreshes Groundcrew run state.
- Tracks wall-clock deadline from `timeout_ms`.
- Tracks idle deadline from Groundcrew run-state changes and new tmux output seen by `agent_tail`.
- Calls Groundcrew `interruptWorkspace` when an expired timeout is enforced.
- Writes `timeout-soft` on successful interruption.
- Writes `timeout-hard` if Groundcrew interruption fails.
- Preserves the agent worktree.

### `agent_terminal_doctor`

Checks terminal backends used for agent viewing and capture.

It reports:

- Zellij availability and version
- tmux availability and version
- Least job log fallback availability
- capture/list capabilities where known

### `agent_sessions`

Lists known local agent terminal sessions and fallback log views across Zellij, tmux, and Least job records.

### `agent_attach_hint`

Returns exact commands a human can run to view an agent job.

Possible commands include:

```text
zellij attach <session>
zellij watch <session>
zellij --session <session> action dump-screen --pane-id <pane> --full
tmux attach -t <target>
Get-Content -Wait .ai-bridge\\agent-runs\\<job_id>\\stdout.log
tail -f .ai-bridge/agent-runs/<job_id>/stdout.log
```

### `agent_tail`

Captures recent output from a local agent terminal backend.

Required fields:

- `job_id` or `task_id`

Optional fields:

- `lines`; default `200`, min `20`, max `2000`

Behavior:

- Attempts Zellij pane capture through `zellij --session <session> action dump-screen --pane-id <pane> --full`.
- Falls back to `tmux capture-pane` against likely Groundcrew targets.
- Falls back again to `.ai-bridge/agent-runs/<job_id>/stdout.log`, `stderr.log`, `events.jsonl`, and `result.md`.
- Updates watchdog `lastActivityAt` and `idleDeadlineAt` when newly captured output is observed.
- Returns an empty output with warnings only if no terminal backend or log file yields output.

### `agent_result`

Summarizes the local agent worktree.

Required fields:

- `job_id` or `task_id`

Optional fields:

- `include_diff`; default `false`
- `include_tail`; default `false`
- `diff_max_chars`; default `60000`
- `tail_lines`; default `200`

Behavior:

- Reads the persisted Least job state.
- Uses the Groundcrew `worktreeDir` from run state.
- Runs git status and diff stat in the agent worktree.
- Optionally includes full diff, truncated by `diff_max_chars`.
- Optionally includes recent tmux tail.
- Returns a conclusion such as `ready-for-review`, `still-running`, `no-changes`, `failed`, or `unknown`.

### `agent_cancel`

Interrupts the Groundcrew workspace for a job while preserving the worktree.

Requires `job_id` or `task_id`. In Least lease mode, also requires `lease_token`.

### `agent_resume`

Resumes an interrupted or dead Groundcrew session in its existing worktree.

Required fields:

- `job_id` or `task_id`

Optional fields:

- `fresh`; when `true`, cold-starts the agent without Groundcrew `resumeArgs`
- `lease_token` when Least concurrency mode is `lease`

Behavior:

1. Reads the Least job record from `.ai-bridge/agent-runs/<job_id>/status.json`.
2. Refuses active jobs (`provisioning`, `running`, `resumed`).
3. Calls Groundcrew `resumeWorkspace` when available.
4. Refreshes the job record from Groundcrew `readRunState`.
5. Refreshes terminal metadata and returns attach/watch/tail hints.

### `agent_cleanup`

Conservatively cleans stale Least agent job records under `.ai-bridge/agent-runs`.

Optional fields:

- `job_id` or `task_id`; target one job
- `older_than`; ISO timestamp or relative duration like `7d`, `24h`, `30m`
- `dry_run`; default `true`
- `clean_worktrees`; default `false`
- `force`; default `false`; only applies when `clean_worktrees=true`
- `lease_token` when Least concurrency mode is `lease` and `dry_run=false`

Behavior:

- Never deletes active jobs (`provisioning`, `running`, `resumed`).
- With default `dry_run=true`, reports candidates without deleting anything.
- Removes stale `.ai-bridge/agent-runs/<job_id>/` directories when `dry_run=false`.
- Preserves Groundcrew worktrees by default.
- Optionally calls Groundcrew `cleanupWorkspace` when `clean_worktrees=true`.
- Refuses dirty worktree teardown unless `force=true`.
- Requires `job_id`, `task_id`, or `older_than` when `dry_run=false`.

## Current limitations

- `agent_tail` is tmux-first; cmux/zellij capture is not implemented yet.
- `agent_result` depends on Groundcrew run state containing `worktreeDir`.
- Watchdog hard-kill escalation is not implemented yet; `timeout-hard` currently means Groundcrew interruption failed.
- `agent_resume` and `agent_cleanup` depend on Groundcrew exports `resumeWorkspace` and `cleanupWorkspace`; older Groundcrew versions return a clear upgrade error.
- Oh My Pi and Grok build profiles must remain disabled until local command discovery confirms exact executable, flags, prompt transport, output behavior, and cancellation semantics.

## Safety rules

- Do not pass arbitrary shell from a prompt into agent profile commands.
- Use Groundcrew worktrees for write-capable work.
- Keep prompt files free of secrets.
- Preserve worktrees on cancellation.
- Do not auto-merge or auto-apply agent changes back to the main workspace.
