# Zellij terminal backend integration plan

Date: 2026-06-27
Status: plan only
Scope: add a cross-platform terminal backend layer for local agent viewing/tailing, with Zellij as the preferred non-WezTerm backend, tmux as Linux/WSL fallback, and log files as universal fallback.

## Executive summary

Least currently has Groundcrew-backed agent lifecycle tools, but terminal visibility is tmux-specific. This is not correct for a Windows-first setup. The next integration should introduce a terminal backend abstraction that can read and present agent terminal output from multiple sources:

```text
zellij -> tmux -> logs
```

Zellij should become the preferred interactive backend because it supports Windows binaries, Linux/Arch, WSL, named sessions, attach/list/kill operations, CLI actions, pane IDs, JSON pane listings, `dump-screen`, and `subscribe` output streaming. tmux remains valuable for WSL/Linux and for existing Groundcrew configurations. Logs remain mandatory because they are the only guaranteed capture path when a terminal UI or session manager is missing or when Zellij pane capture is unavailable.

## Verified Zellij primitives

Official docs checked:

```text
https://zellij.dev/documentation/installation.html
https://zellij.dev/documentation/commands.html
https://zellij.dev/documentation/command-line-options.html
https://zellij.dev/documentation/controlling-zellij-through-cli.html
https://zellij.dev/documentation/zellij-run-and-edit.html
https://zellij.dev/documentation/cli-actions.html
https://zellij.dev/documentation/zellij-subscribe.html
https://zellij.dev/documentation/cli-recipes.html
https://zellij.dev/documentation/programmatic-control.html
```

Relevant capabilities:

- Windows binary is available; docs say to run `zellij.exe` from PowerShell or Windows Terminal.
- `zellij attach [session-name]` attaches to a running session.
- `zellij list-sessions` lists running sessions.
- `zellij kill-sessions [target-session]` kills a specific session.
- `zellij options --session-name <name>` sets session name when starting.
- `zellij run -- <command>` opens a new pane running a command.
- `zellij run --cwd <path> -- <command>` starts the pane in a chosen directory.
- `zellij action list-panes --json` returns pane state including id, title, command, cwd, tab id/name, and exit state.
- `zellij action dump-screen --pane-id <pane> --full` dumps viewport/scrollback to stdout.
- `zellij subscribe --pane-id <pane> --format json` streams rendered pane output as NDJSON.
- `zellij watch <session-name>` gives a read-only view of a session.

## Current codebase findings

### Existing agent lifecycle

Implemented files:

```text
src/agentTypes.ts
src/agentJobStore.ts
src/agentGroundcrewAdapter.ts
src/agentOps.ts
src/agentTail.ts
src/agentResult.ts
src/agentWatchdog.ts
src/agentConfig.ts
src/agentDoctor.ts
src/server.ts
```

Current tools:

```text
agent_list
agent_doctor
agent_plan
agent_start
agent_status
agent_watchdog
agent_tail
agent_result
agent_cancel
```

### Current limitation

`src/agentTail.ts` is hard-coded to tmux:

```text
source: "tmux" | "none"
tmux capture-pane -p -t <target> -S -<lines>
```

It tries only these target names:

```text
workspaceName
groundcrew:<task_id>
<task_id>
```

If tmux is unavailable or the target naming does not match Groundcrew, `agent_tail` returns no output.

### Job record limitation

`AgentJobRecord` has no terminal metadata. It only stores Groundcrew metadata:

```ts
agentJob.groundcrew = {
  worktreeDir,
  branchName,
  workspaceName,
  runState
}
```

There is no place for:

```text
terminal backend
zellij session
zellij pane id
attach command
watch command
tail command
log paths
```

### Doctor limitation

`agent_doctor` currently checks `git`, `tmux`, `wsl`, and the agent executable set. It does not check:

```text
zellij
zellij --version
zellij list-sessions
zellij action list-panes --json
zellij action dump-screen --help
zellij subscribe --help
```

### Server/tool wording limitation

`src/server.ts` describes `agent_tail` as tmux-specific. That must become backend-neutral.

## Target architecture

Introduce a terminal backend abstraction independent of Groundcrew. Groundcrew can continue to own worktree/session launch initially, but Least should own the visibility abstraction.

```text
agent_start
  -> Groundcrew setupWorkspace
  -> refresh runState
  -> infer terminal metadata when possible
  -> persist AgentJobRecord.terminal

agent_tail
  -> terminalTail(job)
     -> zellij dump-screen if terminal.backend == zellij or zellij session can be inferred
     -> tmux capture-pane if tmux metadata/targets exist
     -> log file tail fallback

agent_attach_hint
  -> return exact command(s) for human viewing

agent_sessions
  -> list known Least jobs and known external sessions/panes
```

## New data model

Add to `src/agentTypes.ts`:

```ts
export type AgentTerminalBackendId = "zellij" | "tmux" | "logs" | "none";

export interface AgentTerminalMetadata {
  backend: AgentTerminalBackendId;
  sessionName?: string;
  paneId?: string;
  tabId?: number;
  tabName?: string;
  paneTitle?: string;
  paneCommand?: string;
  paneCwd?: string;
  attachCommand?: string;
  watchCommand?: string;
  tailCommand?: string;
  stdoutLog?: string;
  stderrLog?: string;
  eventsLog?: string;
  inferred?: boolean;
  warnings?: string[];
}
```

Extend `AgentJobRecord`:

```ts
terminal?: AgentTerminalMetadata;
```

Keep this optional for backward compatibility with existing job records.

## New modules

### `src/agentTerminalTypes.ts`

Shared interfaces:

```ts
export interface TerminalBackendDetection {
  backend: AgentTerminalBackendId;
  available: boolean;
  version?: string;
  detail?: string;
  warnings: string[];
}

export interface TerminalTailOptions {
  lines?: number;
  includeAnsi?: boolean;
}

export interface TerminalTailResult {
  job_id: string;
  task_id: string;
  source: "zellij" | "tmux" | "logs" | "none";
  text: string;
  lines: number;
  truncated: boolean;
  target?: string;
  session_name?: string;
  pane_id?: string;
  attempted_targets: string[];
  attach_hint?: string;
  watch_hint?: string;
  error?: string;
}

export interface AgentTerminalSession {
  backend: AgentTerminalBackendId;
  sessionName?: string;
  paneId?: string;
  tabId?: number;
  tabName?: string;
  title?: string;
  command?: string;
  cwd?: string;
  exited?: boolean;
  exitStatus?: number | null;
  attachCommand?: string;
  watchCommand?: string;
}
```

### `src/agentTerminalLogs.ts`

Universal log fallback.

Responsibilities:

- Determine run dir from `agentJobDir(workspace, job.jobId)`.
- Read these files if present:

```text
stdout.log
stderr.log
events.jsonl
result.md
```

- Return last N lines across files, preserving file labels.
- Support Windows paths.
- Never fail hard if logs are missing; return source `none` or `logs` with warnings.

### `src/agentTerminalTmux.ts`

Move current tmux logic out of `src/agentTail.ts`.

Responsibilities:

- Generate tmux targets from:

```text
job.groundcrew.workspaceName
job.terminal.sessionName
job.taskId
groundcrew:<task_id>
```

- Capture:

```text
tmux capture-pane -p -t <target> -S -<lines>
```

- Produce attach hints:

```text
tmux attach -t <target>
```

### `src/agentTerminalZellij.ts`

Primary new backend.

Responsibilities:

- Detect executable:

```text
zellij --version
```

- List sessions:

```text
zellij list-sessions
```

- List panes in a session:

```text
zellij --session <session> action list-panes --json
```

- Dump screen:

```text
zellij --session <session> action dump-screen --pane-id <paneId> --full
```

- Stream output command for human/diagnostic use:

```text
zellij --session <session> subscribe --pane-id <paneId> --scrollback <lines> --format raw
```

- Attach/view hints:

```text
zellij attach <session>
zellij watch <session>
```

- Kill session fallback:

```text
zellij kill-sessions <session>
```

Important implementation detail: Zellij pane IDs are process-local terminal IDs such as `terminal_1`. If Groundcrew does not record pane id, Least must infer it by scanning `list-panes --json` and matching:

```text
pane_cwd == worktreeDir
pane_command contains agent executable or wrapper
pane title contains task id/job id/agent name
session name contains task id/job id/workspaceName
```

Do not rely on exact pane id until captured and persisted.

### `src/agentTerminalBackend.ts`

Backend coordinator.

Functions:

```ts
export async function detectTerminalBackends(): Promise<TerminalBackendDetection[]>;

export async function inferTerminalMetadata(workspace: Workspace, job: AgentJobRecord): Promise<AgentTerminalMetadata>;

export async function tailAgentTerminal(workspace: Workspace, job: AgentJobRecord, options: TerminalTailOptions): Promise<TerminalTailResult>;

export async function listAgentTerminalSessions(workspace: Workspace): Promise<AgentTerminalSession[]>;

export function attachHintForJob(workspace: Workspace, job: AgentJobRecord): AttachHintResult;
```

Tail order:

```text
1. If job.terminal.backend == zellij and pane/session known:
   zellij dump-screen

2. Else infer zellij session/pane and try dump-screen.

3. Else if job.terminal.backend == tmux or Groundcrew workspaceName exists:
   tmux capture-pane.

4. Else read logs from .ai-bridge/agent-runs/<job_id>/.

5. Else return source none with all attempted targets and attach hints.
```

## Changes to existing files

### `src/agentTypes.ts`

Add terminal metadata types and optional `terminal` field.

### `src/agentTail.ts`

Refactor from tmux-only to backend coordinator:

Before:

```ts
source: "tmux" | "none"
```

After:

```ts
source: "zellij" | "tmux" | "logs" | "none"
```

`tailAgentJob` should call `tailAgentTerminal`.

### `src/agentOps.ts`

Update:

- `jobStructured()` includes terminal metadata.
- `agentStart()` calls `inferTerminalMetadata()` after `refreshJobFromGroundcrew()`.
- `agentStatus()` optionally refreshes/infer terminal metadata if missing.
- `agentTail()` uses backend-neutral tail result.
- `agentCancel()` should keep Groundcrew interruption as primary, then optionally close/kill terminal session only if explicit future flag is added. Do not kill Zellij session automatically in initial phase because it may contain user-visible panes.

Add new operations:

```ts
agentSessions(workspace)
agentAttachHint(workspace, input)
agentTerminalDoctor(workspace)
```

### `src/agentDoctor.ts`

Add checks:

```text
command:zellij
smoke:zellij --version
zellij:list-sessions
zellij:actions list-panes/dump-screen/subscribe help availability
```

Add structured section:

```jsonc
"terminal_backends": [
  { "backend": "zellij", "available": true, "version": "..." },
  { "backend": "tmux", "available": false },
  { "backend": "logs", "available": true }
]
```

### `src/server.ts`

Update tool registration:

- Change `agent_tail` description from tmux-specific to backend-neutral.
- Add timeout entries:

```ts
agent_sessions: 10_000,
agent_attach_hint: 5_000,
agent_terminal_doctor: 15_000
```

- Add tool names to toolset allowlists.
- Add MCP tools:

```text
agent_sessions
agent_attach_hint
agent_terminal_doctor
```

Suggested tool descriptions:

```text
agent_sessions: List known local agent terminal sessions/panes across Zellij, tmux, and Least job logs.
agent_attach_hint: Return exact human attach/watch/tail commands for an agent job.
agent_terminal_doctor: Check available terminal backends and their supported capture/list operations.
```

### `docs/local-agents.md`

Update docs to remove tmux-only wording.

Add terminal backend section:

```text
Preferred: zellij
Fallback: tmux
Universal fallback: logs
```

### `docs/local-agent-config.md`

Extend schema:

```jsonc
"terminal": {
  "preferredBackend": "zellij | tmux | logs | auto",
  "zellijSessionPrefix": "least-agent",
  "logFallback": true
}
```

Note: this is a Least-side config, not Groundcrew config.

### `docs/examples/agents.local.example.jsonc`

Add:

```jsonc
"terminal": {
  "preferredBackend": "zellij",
  "zellijSessionPrefix": "least-agent",
  "logFallback": true
}
```

This requires updating `LocalAgentConfig` in `src/agentConfig.ts`:

```ts
terminal?: {
  preferredBackend?: "zellij" | "tmux" | "logs" | "auto";
  zellijSessionPrefix?: string;
  logFallback?: boolean;
};
```

## Windows behavior

### Native Windows

Primary human attach command:

```powershell
zellij attach <session>
```

Read-only view:

```powershell
zellij watch <session>
```

Backend tail:

```powershell
zellij --session <session> action dump-screen --pane-id <pane> --full
```

Fallback live log tail:

```powershell
Get-Content -Wait .ai-bridge\agent-runs\<job_id>\stdout.log
```

### WSL / Arch

Primary options:

```bash
zellij attach <session>
zellij watch <session>
zellij --session <session> action dump-screen --pane-id <pane> --full
```

Fallback:

```bash
tmux attach -t <target>
tmux capture-pane -p -t <target> -S -200
tail -f .ai-bridge/agent-runs/<job_id>/stdout.log
```

### Cross-boundary caution

Do not assume native Windows Zellij can directly see WSL Zellij sessions. Treat Windows-native and WSL-native sessions as separate backends. For WSL agents, the backend may need to invoke:

```powershell
wsl.exe -d <distro> -- zellij ...
```

This should be phase 2, after native Zellij support is stable.

## Groundcrew integration strategy

Do not fork Groundcrew first. Keep Groundcrew as the worktree/session launcher and add Least-side visibility.

Initial implementation should infer session data from Groundcrew run state:

```text
workspaceName -> candidate Zellij session name
worktreeDir -> pane cwd match
agent -> pane command/title match
```

If Groundcrew config can choose `workspaceKind: "zellij"`, use that as a signal in `agent_doctor` and plan output, but do not assume it records pane IDs.

Future enhancement: if Groundcrew exposes session/pane metadata, map it directly into `AgentJobRecord.terminal`.

## Attach hint behavior

`agent_attach_hint` should return multiple commands, ordered by confidence:

For Zellij:

```text
zellij attach <session>
zellij watch <session>
zellij --session <session> action dump-screen --pane-id <pane> --full
zellij --session <session> subscribe --pane-id <pane> --scrollback 200
```

For tmux:

```text
tmux attach -t <target>
tmux capture-pane -p -t <target> -S -200
```

For logs on Windows:

```text
Get-Content -Wait .ai-bridge\agent-runs\<job_id>\stdout.log
Get-Content -Wait .ai-bridge\agent-runs\<job_id>\stderr.log
```

For logs on Linux/WSL:

```text
tail -f .ai-bridge/agent-runs/<job_id>/stdout.log
tail -f .ai-bridge/agent-runs/<job_id>/stderr.log
```

## Implementation phases

### Phase A: Backend-neutral tail and log fallback

Goal: stop `agent_tail` from being tmux-only.

Files:

```text
src/agentTerminalTypes.ts
src/agentTerminalLogs.ts
src/agentTerminalTmux.ts
src/agentTerminalBackend.ts
src/agentTail.ts
src/agentResult.ts
src/server.ts
docs/local-agents.md
```

Steps:

1. Move tmux logic from `agentTail.ts` into `agentTerminalTmux.ts`.
2. Add log fallback reader.
3. Update `AgentTailResult.source` union.
4. Update `agent_tail` tool text and schema descriptions.
5. Verify `npx tsc -p tsconfig.json`.

Acceptance:

- `agent_tail` still works for tmux.
- If tmux fails, `agent_tail` reads job logs if present.
- `agent_result include_tail=true` uses same fallback.

### Phase B: Zellij detection and one-shot capture

Goal: make Zellij visible to doctor and tail.

Files:

```text
src/agentTerminalZellij.ts
src/agentTerminalBackend.ts
src/agentDoctor.ts
src/agentTypes.ts
src/agentOps.ts
```

Steps:

1. Add `AgentTerminalMetadata` to job record.
2. Add `zellij --version` detection.
3. Add `zellij list-sessions` collection.
4. Add `zellij --session <name> action list-panes --json` parsing.
5. Add `zellij --session <name> action dump-screen --pane-id <id> --full` capture.
6. Add pane/session inference from `workspaceName`, `taskId`, `worktreeDir`, and agent executable.
7. Persist inferred terminal metadata when confidence is high.

Acceptance:

- `agent_doctor` shows Zellij availability.
- `agent_tail` returns source `zellij` if a matching pane is found.
- If Zellij is present but no matching pane is found, fallback proceeds to tmux/logs.

### Phase C: Human session tools

Goal: make it easy for the user to view everything manually.

Files:

```text
src/agentOps.ts
src/server.ts
src/agentTerminalBackend.ts
docs/local-agents.md
```

Add tools:

```text
agent_sessions
agent_attach_hint
agent_terminal_doctor
```

Acceptance:

- `agent_sessions` lists Zellij sessions/panes plus known Least jobs.
- `agent_attach_hint` returns exact `zellij attach`, `zellij watch`, and log-tail commands.
- Tools are read-only except any future kill/close operation.

### Phase D: Zellij launch assistance, not replacement

Goal: optionally create/prepare a Zellij session for a job, without bypassing Groundcrew.

This phase is optional because Groundcrew already launches agents. Only implement if Groundcrew cannot reliably create Zellij sessions.

Possible helper:

```ts
prepareZellijSession(job): Promise<AgentTerminalMetadata>
```

It would create an empty/named session or a holding pane, then Groundcrew still starts the agent.

Do not implement direct agent process spawning in Least yet. That would create two launch systems and bypass Groundcrew isolation semantics.

### Phase E: WSL/Arch Zellij support

Goal: support Zellij inside WSL/Arch from native Windows Least.

Add config:

```jsonc
"terminal": {
  "preferredBackend": "zellij",
  "wslDistro": "Arch",
  "runZellijInWsl": true
}
```

Commands:

```text
wsl.exe -d Arch -- zellij list-sessions
wsl.exe -d Arch -- zellij --session <session> action list-panes --json
wsl.exe -d Arch -- zellij --session <session> action dump-screen --pane-id <pane> --full
```

Acceptance:

- Native Windows Least can inspect WSL Zellij sessions when configured.
- Path matching handles Windows path vs WSL path conversion cautiously.

## Risk analysis

### Risk: Zellij session exists but pane id is unknown

Mitigation:

- Infer from `list-panes --json` by cwd/command/title.
- Persist `paneId` after first successful match.
- Provide attach hints even when programmatic tail fails.

### Risk: Groundcrew Zellij naming differs from assumptions

Mitigation:

- Try candidate session names:

```text
job.groundcrew.workspaceName
job.taskId
groundcrew:<task_id>
least-agent-<job_id>
least-agent-<task_id>
```

- Add config override for `zellijSessionPrefix`.

### Risk: Windows native and WSL sessions are isolated

Mitigation:

- Treat host and WSL as separate terminal environments.
- Support host Zellij first.
- Add WSL Zellij commands in later phase.

### Risk: Captured terminal content is too large

Mitigation:

- Respect existing `lines` limit.
- Prefer `dump-screen --full` followed by local truncation.
- Add max byte cap on command output.

### Risk: Killing Zellij session kills user panes

Mitigation:

- Initial `agent_cancel` should only interrupt via Groundcrew.
- Do not call `zellij kill-sessions` automatically.
- Add explicit future option only if needed:

```text
agent_cancel(force_terminal=true)
```

### Risk: Zellij docs/features differ by installed version

Mitigation:

- `agent_terminal_doctor` checks actual local subcommands.
- Capability flags drive behavior:

```jsonc
{
  "zellij": {
    "canListPanesJson": true,
    "canDumpScreen": true,
    "canSubscribe": true
  }
}
```

## Testing plan

### Unit/static tests

Add script:

```text
scripts/agent-terminal-unit.mjs
```

Test:

- source fallback order
- Zellij JSON pane parser
- session candidate generation
- attach hint generation on Windows/Linux
- log tail truncation
- old job records without `terminal` field

### TypeScript

Run:

```text
npx tsc -p tsconfig.json
```

### Manual smoke tests

Native Windows:

```powershell
zellij.exe --version
zellij.exe list-sessions
zellij.exe options --session-name least-agent-smoke
zellij.exe attach least-agent-smoke
zellij.exe --session least-agent-smoke action list-panes --json
zellij.exe --session least-agent-smoke action dump-screen --pane-id terminal_1 --full
```

WSL/Arch:

```bash
zellij --version
zellij list-sessions
zellij options --session-name least-agent-smoke
zellij attach least-agent-smoke
zellij --session least-agent-smoke action list-panes --json
zellij --session least-agent-smoke action dump-screen --pane-id terminal_1 --full
```

Least tool smoke:

```text
agent_doctor
agent_terminal_doctor
agent_sessions
agent_attach_hint(job_id=...)
agent_tail(job_id=...)
agent_result(job_id=..., include_tail=true)
```

## Recommended first implementation slice

Implement Phase A + Phase B first:

```text
1. Add AgentTerminalMetadata to job records.
2. Add terminal backend modules.
3. Add Zellij detection/list/dump-screen.
4. Add logs fallback.
5. Update agent_tail and agent_result.
6. Update agent_doctor.
7. Update docs.
8. Compile.
```

Do not implement direct process spawning or forced Zellij kill in the first slice.

## Final verdict

Zellij is viable as the non-WezTerm tmux-like backend. The right design is not to replace Groundcrew or tmux immediately, but to introduce a terminal visibility layer:

```text
Zellij for cross-platform human viewing and pane capture.
tmux for existing Linux/WSL Groundcrew sessions.
logs as the always-available fallback.
```

This gives Windows-native, WSL, and Arch/Linux a single conceptual model while avoiding the brittle assumption that every agent session is a tmux pane.
