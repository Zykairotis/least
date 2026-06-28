# Groundcrew local agent implementation notes

Date: 2026-06-27
Status: Phase 1 complete; Phase 2 initial implementation complete; Phase 3 initial watchdog implementation complete; Phase 4 initial config/doctor implementation complete; Phase 5 skill source complete; Phase 6 initial Zellij/log terminal backend implementation complete
Related plan: `plan/2026-06-27-groundcrew-local-agent-orchestrator-integration-plan.md`

## Implemented so far

Added the first practical Groundcrew-backed local agent orchestration slices:

- `src/agentTypes.ts`
- `src/agentJobStore.ts`
- `src/agentGroundcrewAdapter.ts`
- `src/agentOps.ts`
- `src/agentTail.ts`
- `src/agentResult.ts`
- `src/agentWatchdog.ts`
- `src/agentConfig.ts`
- `src/agentDoctor.ts`
- `src/agentTerminalTypes.ts`
- `src/agentTerminalBackend.ts`
- `src/agentTerminalZellij.ts`
- `src/agentTerminalTmux.ts`
- `src/agentTerminalLogs.ts`
- dashboard SQLite schema/parser updates in `src/dashboardStore.ts`
- dashboard snapshot/API updates in `src/dashboardSnapshot.ts`, `src/dashboardTypes.ts`, and `src/dashboardServer.ts`
- MCP tool registrations in `src/server.ts`
- `docs/local-agents.md`

## New MCP tools

- `agent_list`
- `agent_doctor`
- `agent_plan`
- `agent_start`
- `agent_status`
- `agent_watchdog`
- `agent_tail`
- `agent_result`
- `agent_cancel`
- `agent_terminal_doctor`
- `agent_sessions`
- `agent_attach_hint`

## Behavior

`agent_plan` performs a dry run only and does not call Groundcrew. It now reports planned wall-clock and idle deadlines.

`agent_start`:

1. Requires `repository` or `repo`.
2. Requires `prompt`.
3. Uses explicit `agent` or Groundcrew `agents.default`.
4. Creates `.ai-bridge/agent-runs/<job_id>/prompt.md`.
5. Creates `.ai-bridge/agent-runs/<job_id>/status.json`.
6. Stores watchdog state: `deadlineAt`, `idleDeadlineAt`, `lastActivityAt`.
7. Calls Groundcrew `setupWorkspace`.
8. Refreshes the job record from Groundcrew `readRunState`.
9. Returns job/task/worktree/branch/watchdog metadata when available.

`agent_status` refreshes the Least job record from Groundcrew run state by `job_id` or `task_id`. It evaluates watchdog timeout status in non-enforcing mode by default.

`agent_watchdog` evaluates watchdog deadlines and enforces by default. If the wall-clock or idle deadline has expired, it calls Groundcrew `interruptWorkspace`, preserves the worktree, and writes `timeout-soft`. If interruption fails, it writes `timeout-hard` and records the error.

`agent_tail` now captures recent terminal output through a backend chain: Zellij pane `dump-screen`, tmux `capture-pane`, then Least job log files. If newly captured output differs from the last captured output hash, it updates watchdog `lastActivityAt`, `lastOutputAt`, and `idleDeadlineAt`.

`agent_result` summarizes the Groundcrew worktree using git status, changed files, diff stat, optional full diff, and optional `agent_tail` output.

Dashboard persistence now creates `agent_jobs` and `agent_terminal_sessions` tables and parses compact structured output from `agent_*` tool completions. This makes job state, terminal backend, session/pane ids, and attach/tail commands queryable through `/api/agent-jobs`, `/api/agent-terminal-sessions`, and `/api/snapshot`.

`agent_cancel` calls Groundcrew `interruptWorkspace` and preserves the worktree.

## Dependency behavior

Groundcrew is loaded dynamically through `new Function("specifier", "return import(specifier)")` to avoid a hard TypeScript compile dependency on `@clipboard-health/groundcrew`.

If Groundcrew is not installed or not importable in the Least runtime, `agent_list`, `agent_start`, `agent_status`, `agent_watchdog`, and `agent_cancel` return a clear setup error.

## Phase 4 config and doctor

Added:

- `src/agentConfig.ts` for `.least/agents.local.jsonc` / `agents.local.jsonc` loading and validation.
- `src/agentDoctor.ts` for setup checks.
- `agent_doctor` MCP tool.
- `docs/local-agent-config.md`.
- `docs/examples/agents.local.example.jsonc` sample config.
- `scripts/least-codex-wsl.sh` Codex WSL wrapper template.

The local config currently validates and guards named profiles. It does not replace Groundcrew `crew.config.ts`; Groundcrew still owns worktree/session launch profiles.

Additional CLI integration pass:

- Added code-level built-in profile catalog in `src/agentConfig.ts` for `claude-code`, `codex-host`, `codex-wsl`, `grok-build`, and `oh-my-pi`.
- Added `codex-host` as a safer known Codex profile using workspace-write mode.
- Upgraded `grok-build` from unknown/disabled to known/usable based on xAI Grok Build CLI docs.
- Added `scripts/least-grok-headless.cmd` for Windows/Groundcrew prompt handoff.
- Upgraded `oh-my-pi` from disabled/unknown to known/usable based on can1357/oh-my-pi docs; the actual CLI binary is `omp`, with `-p` non-interactive mode.
- Changed `agent_doctor` to report built-in, local, and effective profiles and to run executable/smoke checks for enabled profiles.
- Changed `agent_start` to validate against the effective built-in-plus-local profile set and return selected local profile metadata.

## Phase 5 skill source

Added skill source under:

```text
skills/local-agent-orchestrator/
```

Files:

- `SKILL.md`
- `agents/openai.yaml`
- `references/agent-selection.md`
- `references/prompt-contracts.md`
- `references/safety-policy.md`
- `references/result-review.md`
- `templates/implementation-prompt.md`
- `templates/debug-prompt.md`
- `templates/review-prompt.md`

The skill encodes the standard workflow: `agent_doctor -> agent_list -> agent_plan -> agent_start -> agent_status/agent_tail/agent_watchdog -> agent_result -> review summary`.

## Watchdog model

The watchdog uses two deadlines:

- `deadlineAt`: wall-clock deadline derived from `createdAt + timeoutMs`.
- `idleDeadlineAt`: idle deadline derived from the most recent activity timestamp plus `idleTimeoutMs`.

Activity is updated when:

- Groundcrew `readRunState` changes, based on a stable hash of the run-state payload.
- `agent_tail` captures new terminal output, based on a hash of the captured output text.

Enforcement behavior:

- `agent_status` detects timeout state but does not enforce unless explicitly passed `enforce_timeouts=true`.
- `agent_watchdog` enforces by default.
- In lease mode, `agent_watchdog` requires a mutation lock when enforcing.
- Successful enforcement writes `timeout-soft`.
- Failed Groundcrew interruption writes `timeout-hard`.
- There is no direct OS process hard-kill escalation yet.

## Verification

Ran:

```bash
npm run build
```

Result:

```text
success
```

## Not implemented yet

The following roadmap pieces remain:

- hard process-kill escalation after failed Groundcrew interruption
- deeper cmux support for `agent_tail`
- output-store compaction for very large `agent_result` payloads
- `agent_resume`
- `agent_cleanup`
- full generated Groundcrew config from `agents.local.jsonc`
- tested Codex WSL wrapper on target machine
- tested Grok Build wrapper on target machine
- tested Oh My Pi/omp profile on target machine
- package/validate `skills/local-agent-orchestrator/` into uploadable `skill.zip` when needed
- dashboard agent job events/snapshot integration
- optional Groundcrew generated config

## Risk notes

- `agent_start` currently blocks until Groundcrew `setupWorkspace` returns. This should usually be short because Groundcrew opens a terminal workspace, but if setup stalls on config/runner readiness, it can consume the `agent_start` tool timeout.
- `agent_status` depends on Groundcrew being importable even for reading local Least job state because it refreshes run state every time.
- Idle timeout is only as accurate as Groundcrew run-state changes and `agent_tail` capture frequency. Full streaming output accounting remains future work.
- `timeout-hard` currently indicates Groundcrew interruption failure, not that Least successfully killed the OS process.
