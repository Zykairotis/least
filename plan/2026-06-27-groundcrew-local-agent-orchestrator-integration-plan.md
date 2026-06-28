# Groundcrew-backed local agent orchestration plan

Date: 2026-06-27
Status: draft plan
Reference clone: `plan/groundcrew-reference`
Reference commit: `e7f2fa873633d4893321327532801fdbffb1456f`
External CLI tool docs: `docs/local-agent-cli-tools.md`

## Goal

Add a local-agent orchestration layer to Least so ChatGPT can safely delegate long-running local coding/build tasks to local agents such as Claude Code, Codex in WSL/bash, Oh My Pi, and Grok build mode.

The intended user flow is:

1. ChatGPT decides a task should be delegated to a local agent.
2. ChatGPT calls a Least MCP tool such as `agent_plan` or `agent_start`.
3. Least starts the requested local agent in an isolated worktree or sandboxed workspace.
4. The MCP call returns quickly with a job id.
5. ChatGPT polls `agent_status`, `agent_tail`, and eventually `agent_result`.
6. Least preserves logs, diffs, branch information, and cancellation/timeout state.

The first implementation should reuse Groundcrew for what it already does well: worktree creation, launch profiles, terminal workspaces, sandbox runners, resume behavior, and run state. Least should add the MCP-native surface, structured job/result APIs, output tailing, watchdog timeouts, and ChatGPT-specific prompt contracts.

## What was cloned

Groundcrew was cloned locally for reference:

```text
plan/groundcrew-reference
```

Current clone commit:

```text
e7f2fa873633d4893321327532801fdbffb1456f
```

This directory is a reference checkout, not yet vendored code. Treat it as a read-only source of design/code examples unless we explicitly choose to fork or copy files later.

## Decision summary

Recommended path:

```text
ChatGPT Skill
  -> Least MCP agent tools
  -> Least Groundcrew adapter
  -> @clipboard-health/groundcrew library APIs
  -> tmux/cmux/zellij + worktree + local agent CLI
```

Do not make the ChatGPT Skill execute commands directly. The Skill should only define routing policy, agent selection rules, and prompt contracts. Least should own tool execution. Groundcrew should be the initial worktree/session backend.

Do not just extend `bash` timeouts. Least's current shell timeout model is synchronous and short-lived. Local coding agents need async job lifecycle tools, not one long blocking MCP call.

## Why Groundcrew is useful

Groundcrew already covers several of the hardest pieces:

- One git worktree per task.
- Local interactive coding agents.
- Claude and Codex presets.
- Custom agent command profiles.
- Terminal backends: cmux, tmux, zellij.
- Sandboxing: Safehouse, Anthropic sandbox-runtime (`srt`), Docker Sandboxes (`sdx`), or unsandboxed `none`.
- Resume behavior for Claude and Codex.
- Local run-state JSON.
- Task-source abstraction for Linear, shell, and todo-txt.
- Programmatic exports, not only a CLI.

The key limitation: Groundcrew is built for human terminal workflows and task trackers. It does not expose a ChatGPT/MCP-native job API with structured status/tail/result, wall-clock deadlines, idle timeout, or final diff summaries.

External CLI details that are not fully documented in the Groundcrew reference clone are now tracked separately in `docs/local-agent-cli-tools.md`. That document is part of this plan and should be kept current as the local commands are discovered and tested.

## Groundcrew source map: files worth studying or reusing

### Top-level package and public exports

| File | Relevance |
|---|---|
| `plan/groundcrew-reference/package.json` | Package metadata, Node requirement, dependencies, CLI bin, package exports. Useful for dependency strategy. |
| `plan/groundcrew-reference/src/index.ts` | Confirms Groundcrew exports library APIs: `setupWorkspace`, `interruptWorkspace`, `resumeWorkspace`, `cleanupWorkspace`, `status`, `loadConfig`, `readRunState`, `recordRunState`, etc. This makes a library-backed adapter viable. |
| `plan/groundcrew-reference/bin/run.js` | Thin CLI wrapper. Useful only if we call the CLI. Prefer library APIs. |
| `plan/groundcrew-reference/src/cli.ts` | CLI command routing for `start`, `status`, `stop`, `resume`, `open`, `cleanup`, `run`, `doctor`. Useful for mapping CLI behavior to Least tools. |

### Worktree lifecycle

| File | Useful elements |
|---|---|
| `src/lib/worktrees.ts` | Core worktree creation/list/removal logic. Handles branch names, duplicate worktrees, scripted provisioning, dirty-worktree protection, orphan cleanup, workdir resolution. Strongest code-reuse candidate if we implement a native Least backend later. |
| `src/commands/setupWorkspace.ts` | Main dispatch flow: resolve agent, preflight, create worktree, stage prompt, build launch command, open workspace, record run state. Best reference for `agent_start`. |
| `src/commands/cleanupWorkspace.ts` | Cleanup semantics. Use as reference for `agent_cleanup`. |
| `src/commands/openWorkspace.ts` | Opens existing PR/branch in a worktree. Useful future tool: `agent_open_pr` / `agent_continue_branch`. |

### Workspace/session backends

| File | Useful elements |
|---|---|
| `src/lib/workspaces.ts` | Facade over cmux/tmux/zellij. Resolves backend and exposes `open`, `probe`, `close`, `interrupt`, `accessHint`. Good adapter pattern. |
| `src/lib/workspaceAdapter.ts` | Internal adapter interface for terminal backends. Good minimal abstraction, but it lacks `tail`/`capture`. |
| `src/lib/tmuxAdapter.ts` | Most relevant for Windows/WSL/Linux. Starts sessions/windows, lists live/exited sessions, kills sessions, and gives attach hints. Add or mirror `capture-pane` here for `agent_tail`. |
| `src/lib/cmuxAdapter.ts` | Useful if user runs cmux on macOS. Check for richer status/attach integration. |
| `src/lib/zellijAdapter.ts` | Useful if zellij is preferred. Needs tail/capture evaluation. |

### Agent launch and sandboxing

| File | Useful elements |
|---|---|
| `src/lib/agentLaunch.ts` | Composes launch command, prepares sandbox runner, resolves local runner, safehouse/cmux integration, opens workspace. Strong reference for Least adapter. |
| `src/lib/launchCommand.ts` | Builds actual shell command. Important: prompt is staged in a temp file, read into `$_p`, and passed as a positional arg. Contains resume-args support, preLaunch handling, safehouse/srt/sdx wrapping. |
| `src/lib/srtLaunch.ts` | Detailed sandbox-runtime policy generation. Useful if we adopt `srt` as default on Linux/WSL. |
| `src/lib/localRunner.ts` | Resolves `safehouse`, `srt`, `sdx`, `none`. Useful for host capability checks. |
| `src/lib/host.ts` | Detects host capabilities. Useful for `agent_doctor`. |
| `src/lib/sandboxName.ts` | Docker sandbox naming. Useful if wrapping sdx. |

### Run state, status, and lifecycle

| File | Useful elements |
|---|---|
| `src/lib/runState.ts` | Local JSON run state. Fields include task, repo, agent, worktreeDir, branchName, workspaceName, lifecycle state, timestamps, resume count. This can be consumed directly by Least. |
| `src/commands/status.ts` | Human status output. Useful for logic: run-state vs live-session reconciliation, duration formatting, PR lookup, git dirtiness, recent logs. But it is not structured JSON. |
| `src/commands/interruptWorkspace.ts` | Stop/interrupt behavior. Useful for `agent_cancel`. It closes workspace while preserving worktree and records interrupted state. |
| `src/commands/resumeWorkspace.ts` | Resume behavior. It can append agent-specific resume args (`--continue`, `resume --last`) and opens a continuation prompt in existing worktree. Useful for `agent_resume`. |
| `src/lib/workspaceLiveness.ts` | Prevents duplicate resumes/launches. Useful for `agent_start` guardrails. |
| `src/lib/worktreeRunState.ts` | Effective branch name and adopted branch handling. Useful for result/diff. |

### Task sources and prompt handling

| File | Useful elements |
|---|---|
| `src/lib/taskSource.ts` | Canonical task model. Useful if Least creates synthetic local tasks. |
| `src/lib/board.ts` | Aggregates sources. Useful only if we use Groundcrew source system. |
| `src/lib/buildSources.ts` | Builds sources from config. Useful if we use todo-txt/shell tasks. |
| `src/lib/adapters/shell/*` | Shell source adapter emits JSON tasks. Useful if we integrate Least-created plan tasks as a Groundcrew shell source. |
| `src/lib/adapters/todo-txt/*` | Local todo task source. Potentially useful, but direct `setupWorkspace` is cleaner. |
| `src/lib/stagedLaunch.ts` | Prompt staging utilities. Good model for avoiding shell quoting bugs. |
| `src/lib/repositoryHooks.ts` | Resolves repo-local `.groundcrew/config.json` hooks vs config defaults. Useful for `prepareWorktree` support. |

### Supporting docs

| File | Useful elements |
|---|---|
| `docs/commands.md` | Human behavior contract for `start`, `stop`, `resume`, `status`, `open`, cleanup. |
| `docs/configuration.md` | Full configuration schema and defaults. Essential for mapping Least config to Groundcrew config. |
| `docs/runners.md` | Safehouse/srt/sdx runner behavior, Linux/WSL prerequisites, network/filesystem policy. |
| `docs/task-sources.md` | JSON task source format and semantics. Useful if Least feeds Groundcrew through local task sources. |
| `docs/setup-hooks.md` | Worktree preparation hook contract. |
| `docs/credentials.md` | Credential handling and `preLaunch`. |

## Integration options considered

### Option A: wrap `crew` CLI

Least runs commands such as:

```bash
crew start <task>
crew status <task>
crew stop <task>
crew resume <task>
crew cleanup <task>
```

Advantages:

- Fastest possible prototype.
- Minimal TypeScript integration.
- Uses documented public CLI.

Disadvantages:

- Hard to pass synthetic prompts without first creating a Groundcrew task source entry.
- `crew status` is human text, not structured JSON.
- Requires parsing terminal output.
- Harder to return clean MCP errors.
- Harder to implement `agent_result` reliably.

Verdict: acceptable only for throwaway prototype. Not recommended for main Least implementation.

### Option B: depend on Groundcrew as a library

Least imports:

```ts
import {
  loadConfig,
  setupWorkspace,
  interruptWorkspace,
  resumeWorkspace,
  cleanupWorkspace,
  readRunState,
} from "@clipboard-health/groundcrew";
```

Advantages:

- Uses Groundcrew's exported API surface.
- Avoids CLI parsing.
- Allows synthetic tasks through `setupWorkspace(config, options)`.
- Cleaner mapping to MCP tools.
- Easier to preserve exact Groundcrew run-state fields.

Disadvantages:

- Requires Node compatibility with Groundcrew. Groundcrew currently requires Node `24.14.1` and npm `~11.11.0` in package metadata.
- Least must manage dependency and possible API churn.
- Groundcrew exports are public but may not be as stable as CLI.

Verdict: recommended first implementation.

### Option C: copy/adapt selected Groundcrew internals into Least

Useful if Groundcrew's dependency footprint or API churn becomes a problem.

Likely copy/adapt candidates:

- `worktrees.ts`
- `runState.ts`
- `workspaceAdapter.ts`
- `workspaces.ts`
- `tmuxAdapter.ts`
- pieces of `launchCommand.ts`
- pieces of `agentLaunch.ts`

Advantages:

- Full control.
- Can add `tail`, `result`, watchdog, and JSON status natively.
- Can align with Least's existing tool registry, output store, permissions, and dashboard.

Disadvantages:

- More work.
- We would own maintenance.
- Need license attribution if copying code. Groundcrew is MIT, but preserve license notices if substantial code is copied.

Verdict: good second phase if library wrapping is too restrictive.

### Option D: fork Groundcrew

Advantages:

- Easier to add missing APIs directly upstream/downstream.
- Can add `status --json`, `tail`, `result`, and MCP bridge.

Disadvantages:

- Fork maintenance burden.
- Less clean inside Least.
- Groundcrew has its own roadmap and task-source assumptions.

Verdict: avoid initially. Prefer wrapper/library integration. Fork only if upstream cannot support required hooks.

## Recommended architecture

```text
ChatGPT Skill: local-agent-orchestrator
  - Routing policy
  - Prompt contracts
  - Safety rules
  - Agent-selection rules

Least MCP server
  - agent_list
  - agent_plan
  - agent_start
  - agent_status
  - agent_tail
  - agent_result
  - agent_cancel
  - agent_resume
  - agent_cleanup
  - agent_doctor

Least Groundcrew adapter
  - Loads Least agent config
  - Materializes Groundcrew config or imports existing one
  - Calls Groundcrew APIs
  - Adds Least job state and result collection
  - Adds timeout/idle watchdog

Groundcrew library
  - Worktrees
  - Agent launch profiles
  - Terminal sessions
  - Sandboxing
  - Resume
  - Run state

Local tools
  - Claude Code
  - Codex in WSL/bash
  - Oh My Pi
  - Grok build mode
  - custom CLI profiles
```

## Proposed Least files to add

### Core files

| New file | Purpose |
|---|---|
| `src/agentTypes.ts` | Shared TypeScript types for agent registry, jobs, status, result, lifecycle state. |
| `src/agentConfig.ts` | Load/validate `agents.local.jsonc` or `.least/agents.jsonc`; merge defaults. |
| `src/agentGroundcrewAdapter.ts` | Thin adapter around Groundcrew exported APIs. |
| `src/agentJobStore.ts` | Persist Least-side job records under `.ai-bridge/agent-runs` or a configured state dir. |
| `src/agentOps.ts` | Tool implementation functions: list/plan/start/status/tail/result/cancel/resume/cleanup/doctor. |
| `src/agentTail.ts` | Backend-specific tail/capture helpers for tmux/cmux/zellij and log files. |
| `src/agentResult.ts` | Summarize diff, branch, changed files, PR links, exit/session state. |
| `src/agentWatchdog.ts` | Deadline/idle timeout evaluator; invoked on status or by explicit command. |
| `src/agentPrompt.ts` | Prompt-file staging and prompt templates. |
| `src/agentSafety.ts` | Command allowlist, risk classification, approval gating. |

### Integration changes

| Existing file | Change |
|---|---|
| `src/server.ts` | Register new MCP tools and schemas. Add per-tool timeouts that remain short. |
| `src/toolRegistry.ts` | Add tool metadata if registry requires it. |
| `src/config.ts` | Add optional agent orchestration config paths/defaults. |
| `src/permissions.ts` / `src/permissionRules.ts` | Add permission category for local agent launches and destructive operations. |
| `src/dashboardEvents.ts` | Emit agent job events: planned, started, status, cancelled, completed. |
| `src/dashboardSnapshot.ts` | Include active agent jobs. |
| `src/outputShaper.ts` | Compact large agent logs/results. |
| `src/toolOutputStore.ts` | Store large `agent_tail` and `agent_result` payloads. |

### Tests/scripts

| New file | Purpose |
|---|---|
| `scripts/agent-config-unit.mjs` | Validate agent config parsing and unsafe command rejection. |
| `scripts/agent-job-store-unit.mjs` | Validate state writes/reads/recovery. |
| `scripts/agent-tail-unit.mjs` | Validate tmux capture parsing with fixtures. |
| `scripts/agent-result-unit.mjs` | Validate git diff/result summary. |
| `scripts/agent-groundcrew-smoke.mjs` | Optional smoke requiring Groundcrew installed and tmux available. |
| `scripts/agent-watchdog-unit.mjs` | Deadline/idle timeout behavior. |

### Docs/plans

| New file | Purpose |
|---|---|
| `docs/local-agents.md` | User-facing docs for agent orchestration. |
| `docs/local-agent-config.md` | Config examples for Claude, Codex WSL, Oh My Pi, Grok build. |
| `docs/local-agent-cli-tools.md` | External CLI notes for Claude Code, Codex, Codex WSL wrapper, Oh My Pi/Pi, Grok build mode, and future ACP adapters. Created in this planning pass. |
| `docs/local-agent-security.md` | Security model, permissions, sandboxing, and worktree isolation. |

## Proposed MCP tool surface

### `agent_list`

Purpose: list configured local agents and capabilities.

Input:

```ts
{
  include_unavailable?: boolean;
}
```

Output:

```ts
{
  agents: Array<{
    name: string;
    provider?: "claude" | "codex" | "pi" | "grok" | "custom";
    command_preview: string;
    runtime: "host" | "wsl" | "groundcrew" | "custom";
    runner: "safehouse" | "srt" | "sdx" | "none" | "auto";
    supports_resume: boolean;
    supports_cancel: boolean;
    default_timeout_ms: number;
    idle_timeout_ms: number;
    enabled: boolean;
    warnings: string[];
  }>;
}
```

Implementation:

- Read Least agent config.
- Read Groundcrew config if used directly.
- Check command existence shallowly, similar to Groundcrew doctor.

### `agent_plan`

Purpose: dry-run a launch before starting a job.

Input:

```ts
{
  agent?: string;
  repo: string;
  title: string;
  prompt: string;
  mode?: "analysis" | "implementation" | "review" | "debug" | "build";
  worktree?: "required" | "optional" | "none";
  timeout_ms?: number;
  idle_timeout_ms?: number;
}
```

Output:

```ts
{
  plan_id: string;
  selected_agent: string;
  repo: string;
  task_id: string;
  command_preview: string;
  worktree_preview: {
    branch: string;
    directory: string;
  };
  risk: "low" | "medium" | "high";
  requires_approval: boolean;
  warnings: string[];
}
```

Implementation:

- No process launch.
- Use Groundcrew-like branch/task naming.
- Generate prompt preview.
- Validate allowlisted agent command.

### `agent_start`

Purpose: start a local agent job and return immediately.

Input:

```ts
{
  agent?: string;
  repo: string;
  title: string;
  prompt: string;
  task_id?: string;
  timeout_ms?: number;
  idle_timeout_ms?: number;
  require_worktree?: boolean;
  approval_token?: string;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  state: "provisioning" | "running" | "failed-to-launch";
  agent: string;
  repo: string;
  branch?: string;
  worktree_dir?: string;
  attach_hint?: string;
  status_path: string;
  result_hint: string;
}
```

Implementation with Groundcrew:

1. Create Least job record under `.ai-bridge/agent-runs/<job_id>/request.json`.
2. Create `prompt.md`.
3. Load Groundcrew config.
4. Call `setupWorkspace(config, options)`.
5. Read Groundcrew run state.
6. Update Least job state.
7. Return without waiting for agent completion.

Potential issue: `setupWorkspace` may do worktree creation synchronously. That is acceptable if it normally completes within MCP timeout. If it can block too long due to fetch or runner readiness, wrap it with a short timeout and return `provisioning` if a background Least helper is created. For phase 1, assume `setupWorkspace` returns quickly after opening tmux.

### `agent_status`

Purpose: structured status for one job/task.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  include_tail?: boolean;
  tail_lines?: number;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  state: "planned" | "provisioning" | "running" | "resumed" | "interrupted" | "session-dead" | "session-exited" | "failed-to-launch" | "timeout-soft" | "timeout-hard" | "completed" | "unknown";
  groundcrew_state?: object;
  live_workspace: boolean | null;
  elapsed_ms?: number;
  deadline_ms?: number;
  idle_ms?: number;
  agent: string;
  repo: string;
  branch?: string;
  worktree_dir?: string;
  attach_hint?: string;
  tail?: string;
  warnings: string[];
}
```

Implementation:

- Read Least job record.
- Read Groundcrew `readRunState(config, task)`.
- Probe live workspace via Groundcrew if API accessible, otherwise run backend-specific commands.
- Reconcile run-state vs live workspace like Groundcrew `status.ts` does.
- Optionally call `agent_tail` internally.
- Evaluate deadline/idle timeout but do not necessarily kill unless `enforce_timeouts` is true or watchdog is invoked.

### `agent_tail`

Purpose: get recent output from the local agent.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  lines?: number;
  since_offset?: number;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  source: "tmux" | "cmux" | "zellij" | "log" | "unknown";
  text: string;
  truncated: boolean;
  next_offset?: number;
}
```

Implementation options:

1. tmux first:
   - `tmux capture-pane -p -t <target> -S -<lines>`
   - Need map task id to target: either `groundcrew:<task>` window model or `<task>` session model depending on `GROUNDCREW_TMUX_SESSION_PER_TASK`.
2. cmux:
   - Investigate `cmuxAdapter.ts` and cmux CLI support.
3. zellij:
   - Investigate zellij action/dump behavior.
4. fallback:
   - Use Groundcrew log file for recent event lines.

Need output compaction and storage for large tails.

### `agent_result`

Purpose: final or interim result summary.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  include_diff?: boolean;
  include_tail?: boolean;
  diff_max_chars?: number;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  state: string;
  agent: string;
  repo: string;
  branch?: string;
  worktree_dir?: string;
  git: {
    dirty: boolean;
    modified_count: number;
    untracked_count: number;
    changed_files: string[];
    diff_summary: string;
    diff?: string;
  };
  pr_links: string[];
  tail?: string;
  conclusion: "ready-for-review" | "still-running" | "failed" | "no-changes" | "unknown";
  warnings: string[];
}
```

Implementation:

- Read run state.
- Use `git -C <worktree> status --porcelain`.
- Use `git -C <worktree> diff --stat` and optionally `git diff`.
- Use Groundcrew `findPullRequestsForBranch` if exported or reimplement simple `gh pr list` query.
- Use `agent_tail` for last logs.
- Do not apply changes to the main workspace automatically.

### `agent_cancel`

Purpose: stop a running local agent while preserving the worktree.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  reason?: string;
  force?: boolean;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  state: "interrupted" | "timeout-soft" | "timeout-hard" | "missing";
  worktree_preserved: boolean;
  worktree_dir?: string;
  next: string;
}
```

Implementation:

- For graceful cancel: `interruptWorkspace(config, { task, reason })`.
- For force cancel: backend-specific kill if workspace remains live after grace period.
- Record cancellation in Least job state.
- Preserve worktree.

### `agent_resume`

Purpose: resume an interrupted/dead session in existing worktree.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  fresh?: boolean;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  state: "resumed";
  attach_hint?: string;
}
```

Implementation:

- Call `resumeWorkspace(config, { task, fresh })`.
- Groundcrew uses `resumeArgs` when available, e.g. Claude `--continue`, Codex `resume --last`.

### `agent_cleanup`

Purpose: remove preserved worktree/session after review.

Input:

```ts
{
  job_id?: string;
  task_id?: string;
  force?: boolean;
}
```

Output:

```ts
{
  job_id: string;
  task_id: string;
  removed_worktrees: string[];
  closed_sessions: string[];
  failures: string[];
}
```

Implementation:

- Call `cleanupWorkspace` or Groundcrew `worktrees.teardown` equivalent.
- Refuse cleanup when dirty unless `force` is true.
- Never delete remote branches.

### `agent_doctor`

Purpose: validate local agent setup.

Checks:

- Node version compatible with Groundcrew.
- `@clipboard-health/groundcrew` installed or local path configured.
- `tmux`/`cmux`/`zellij` available.
- `claude`, `codex`, Oh My Pi, Grok build commands available if configured.
- WSL distro available for `codex-wsl`.
- Runner dependencies: `srt` requires bubblewrap/socat/ripgrep on Linux/WSL.
- Known repositories exist.
- Config validates.
- Worktree root exists and is writable.

## Least job state

Groundcrew already has run state. Least should maintain its own job state because Groundcrew task ids may not be globally unique enough for ChatGPT sessions and because Least needs timeout/result metadata.

Proposed state directory:

```text
.ai-bridge/agent-runs/<job_id>/
  request.json
  prompt.md
  status.json
  groundcrew-task-id.txt
  result.json
  result.md
  tail.log
  final.diff
  changed-files.txt
```

Alternative state directory:

```text
.least/agent-runs/<job_id>/
```

Use `.ai-bridge/agent-runs` if this is meant to be visible to other agents. Use `.least/agent-runs` if it is internal operational state. Recommendation: `.ai-bridge/agent-runs` for visibility, but keep sensitive env/config out of it.

`request.json` shape:

```json
{
  "job_id": "agent_20260627_001",
  "task_id": "least-agent-20260627-001",
  "created_at": "2026-06-27T00:00:00.000Z",
  "agent": "codex-wsl",
  "repo": "OWNER/REPO",
  "title": "Implement async agent runner",
  "mode": "implementation",
  "timeout_ms": 3600000,
  "idle_timeout_ms": 900000,
  "groundcrew": {
    "worktree_dir": null,
    "branch": null,
    "workspace_name": null
  }
}
```

`status.json` shape:

```json
{
  "job_id": "agent_20260627_001",
  "state": "running",
  "updated_at": "2026-06-27T00:05:00.000Z",
  "elapsed_ms": 300000,
  "last_output_at": null,
  "deadline_at": "2026-06-27T01:00:00.000Z",
  "idle_deadline_at": null,
  "cancel_requested": false,
  "warnings": []
}
```

## Timeout model

Use three layers:

| Layer | Example | Owner | Behavior |
|---|---:|---|---|
| MCP tool timeout | 5-15 sec | Least tool wrapper | Must return quickly. No local agent should block here. |
| Provisioning timeout | 30-120 sec | `agent_start` | Covers config load, worktree create, launch workspace. Failure records `failed-to-launch`. |
| Agent wall-clock timeout | 30-180 min | Least job watchdog | Interrupt session if exceeded. Preserve worktree. |
| Agent idle timeout | 10-20 min | Least job watchdog | Interrupt if no new output/status progress. |
| Force-kill grace | 30-60 sec | Least job watchdog | If graceful interrupt fails, close/kill backend session. |

Groundcrew's `commandRunner.ts` has a 120s default timeout and SIGTERM/SIGKILL escalation for helper commands, but agent sessions run in tmux/cmux/zellij and therefore need a separate Least watchdog.

## Agent registry design

Do not expose arbitrary shell execution. Use a local allowlisted registry.

Proposed config file:

```text
agents.local.jsonc
```

or:

```text
.least/agents.jsonc
```

Example:

```jsonc
{
  "groundcrew": {
    "configPath": "~/.config/groundcrew/crew.config.ts",
    "workspaceKind": "tmux",
    "runner": "srt"
  },
  "agents": {
    "claude-code": {
      "provider": "claude",
      "groundcrewProfile": "claude-code",
      "cmd": "claude --permission-mode auto",
      "resumeArgs": "--continue",
      "defaultTimeoutMs": 3600000,
      "idleTimeoutMs": 900000,
      "writePolicy": "worktree"
    },
    "codex-wsl": {
      "provider": "codex",
      "groundcrewProfile": "codex-wsl",
      "cmd": "wsl -d Ubuntu -- bash -lc 'codex exec -'",
      "promptVia": "stdin-or-positional-wrapper",
      "resumeArgs": "resume --last",
      "defaultTimeoutMs": 3600000,
      "idleTimeoutMs": 900000,
      "writePolicy": "worktree"
    },
    "oh-my-pi": {
      "provider": "pi",
      "groundcrewProfile": "oh-my-pi",
      "cmd": "oh-my-pi",
      "defaultTimeoutMs": 3600000,
      "idleTimeoutMs": 900000,
      "writePolicy": "worktree"
    },
    "grok-build": {
      "provider": "grok",
      "groundcrewProfile": "grok-build",
      "cmd": "grok-build",
      "defaultTimeoutMs": 7200000,
      "idleTimeoutMs": 1200000,
      "writePolicy": "worktree"
    }
  }
}
```

Need validate:

- Agent name slug only.
- Command must map to allowlisted profile.
- No arbitrary shell fragments from ChatGPT.
- No `rm -rf`, `curl | sh`, secret-printing commands in profiles unless explicitly trusted by user config.
- WSL commands require path conversion support.

## Groundcrew config strategy

Two possible approaches:

### Strategy 1: require user-managed Groundcrew config

User creates `~/.config/groundcrew/crew.config.ts`. Least loads it through Groundcrew `loadConfig()`.

Pros:

- Follows Groundcrew's normal config discovery.
- Less code.
- Groundcrew doctor remains useful.

Cons:

- User must keep Groundcrew config in sync with Least agent config.

### Strategy 2: Least generates a temporary Groundcrew config

Least generates a Groundcrew config from its local agent registry before calling Groundcrew APIs.

Pros:

- Single source of truth in Least.
- Better UX.
- Can create synthetic profiles for WSL agents.

Cons:

- Need to study `loadConfig()` and whether direct config objects are enough.
- Need maybe avoid cosmiconfig discovery.

Recommendation:

Phase 1: require/consume Groundcrew config.
Phase 2: add Least-generated config.

## Prompt contract

The prompt must be written to a file first. Avoid inline shell text.

Prompt should contain:

```text
# Task
<title>

# User request
<prompt>

# Repository
<repo>

# Operating mode
- Work in the assigned worktree only.
- Inspect repo instructions first.
- Make the smallest correct change.
- Run relevant verification.
- Do not ask questions unless blocked by missing credentials or destructive approval.
- Produce a final summary with changed files, tests run, and follow-ups.

# Output contract
At the end, write a concise final report to stdout with:
- Summary
- Changed files
- Verification
- Risks
- PR/branch status
```

Groundcrew already has a default unattended prompt. We should either:

1. Use Groundcrew's default prompt and pass task description as the prompt.
2. Override `prompts.initial` / `promptFile` for a Least-specific execution contract.

Recommendation: create a Least-specific prompt file later, but phase 1 can use Groundcrew's default plus enriched task description.

## Result collection

`agent_result` should not rely on the agent's self-report alone.

Collect:

- Run state from Groundcrew.
- Workspace liveness.
- Worktree path.
- Branch name.
- Git status.
- Changed file list.
- Diff stat.
- Optional full diff with compaction.
- PR link if present.
- Last output tail.
- Timeout/cancellation state.

Result states:

| State | Meaning |
|---|---|
| `still-running` | Workspace live and no terminal state reached. |
| `session-exited` | tmux/cmutex/zellij session exited; inspect tail/diff. |
| `interrupted` | User/timeout stopped it; worktree preserved. |
| `failed-to-launch` | Groundcrew could not create/launch workspace. |
| `ready-for-review` | Session done/exited and worktree has changes. |
| `no-changes` | Session done/exited and worktree clean. |
| `unknown` | Could not read enough state. |

## Tail implementation details

### tmux window model

Groundcrew default tmux mode uses one `groundcrew` session and windows named by task id. Target:

```text
groundcrew:<task>
```

Capture command:

```bash
tmux capture-pane -p -t groundcrew:<task> -S -200
```

### tmux session-per-task model

If `GROUNDCREW_TMUX_SESSION_PER_TASK=1`, each task is a session. Target:

```text
<task>
```

Capture command:

```bash
tmux capture-pane -p -t <task> -S -200
```

### zellij

Need investigate zellij adapter and available dump/capture commands. If not reliable, use attach hints and Groundcrew logs for phase 1.

### cmux

Need inspect `cmuxAdapter.ts`. If cmux offers structured logs or CLI inspect, use that. Otherwise capture may need a Groundcrew patch.

## Safety and permissions

Agent launching is powerful. Add a dedicated permission category.

Launch approval should be required when:

- Agent can write files.
- Prompt asks for broad refactors.
- Agent uses unsandboxed runner `none`.
- Agent has network egress open.
- Agent command is custom/unknown.
- Agent has access to credential directories.
- Task asks to run deployment, publish, delete, or migrate commands.

Safe defaults:

- Use worktrees for any write-capable job.
- Do not run in main working tree by default.
- Do not allow arbitrary commands from prompt.
- Do not pass secrets into prompt files.
- Do not include environment dumps in output.
- Preserve worktree on cancel.
- Do not auto-merge or auto-apply patches back to main workspace.

## Windows/WSL concerns

This repo is on Windows path `X:\least`. Groundcrew is Node-based and supports Linux/WSL paths via runner settings, but WSL command profiles need careful path handling.

Potential problem:

- Groundcrew worktree path may be Windows-style when running on Windows host.
- Codex inside WSL expects Linux paths, e.g. `/mnt/x/least/...`.

Possible solutions:

1. Run Least/Groundcrew inside WSL for WSL agents.
2. Use a WSL wrapper script that converts `{{worktree}}` using `wslpath`.
3. Keep Codex profile host-native if possible.
4. Use `local.runner: srt` inside WSL for Linux-native path handling.

For `codex-wsl`, use a wrapper script rather than a complex inline command:

```bash
~/.config/least/agents/codex-wsl.sh
```

The script can:

- Convert Windows cwd to WSL path.
- `cd` into it.
- Read prompt from argv/stdin.
- Run Codex with the correct mode.

## Dependency strategy

Groundcrew package requirements observed in `package.json`:

- Node `24.14.1`
- npm `~11.11.0`
- dependencies include `@anthropic-ai/sandbox-runtime`, `@clipboard-health/clearance`, `@linear/sdk`, `cosmiconfig`, `zod`.

Least currently may not require Node 24. Before adding Groundcrew as a dependency, check Least's package engine and CI.

Options:

1. Optional peer dependency:
   - Least does not require Groundcrew normally.
   - Agent tools show `not_configured` unless Groundcrew is installed.
2. Direct dependency:
   - Easier imports.
   - May force Node 24.
3. Dynamic import with local path:
   - `import("@clipboard-health/groundcrew")` only when agent tools are used.
   - Fail gracefully if absent.

Recommendation: dynamic optional dependency first.

## Implementation phases

### Phase 0: reference clone and planning

Done:

- Clone Groundcrew into `plan/groundcrew-reference`.
- Draft this plan.

Exit criteria:

- Plan exists.
- Reference commit recorded.

### Phase 1: Groundcrew adapter proof of concept

Scope:

- Add dynamic import adapter.
- Add `agent_list`, `agent_start`, `agent_status`, `agent_cancel` only.
- Use existing Groundcrew config.
- No tail/result yet except basic run-state.

Implementation steps:

1. Add `src/agentTypes.ts`.
2. Add `src/agentGroundcrewAdapter.ts` with dynamic import.
3. Add `src/agentJobStore.ts` minimal state.
4. Add `src/agentOps.ts` for four tools.
5. Register tools in `src/server.ts`.
6. Add command caps/permissions.
7. Add tests for config absence and job state.

Exit criteria:

- `agent_list` returns configured agents or setup error.
- `agent_start` can launch a synthetic task.
- `agent_status` returns run state.
- `agent_cancel` interrupts and preserves worktree.

### Phase 2: structured result and tail

Scope:

- Add `agent_tail` and `agent_result`.
- Implement tmux capture first.
- Add diff/changed-file summary.

Implementation steps:

1. Add `src/agentTail.ts` with tmux target resolution.
2. Add `src/agentResult.ts`.
3. Add output store compaction for large tails/diffs.
4. Add tests with fixture outputs.
5. Add docs.

Exit criteria:

- ChatGPT can see last N lines from active agent.
- ChatGPT can retrieve changed files and diff after agent exits.

### Phase 3: timeout and watchdog

Scope:

- Add wall-clock and idle timeout tracking.
- Add explicit `agent_watchdog_tick` internal operation or invoke timeout checks during `agent_status`.

Implementation steps:

1. Store `deadline_at` and `idle_deadline_at` in Least job status.
2. Update `last_output_at` from `agent_tail` if new output is observed.
3. On timeout, call `interruptWorkspace`.
4. After grace, force close backend session if still live.
5. Record timeout state.

Exit criteria:

- Long-running agents can be stopped without blocking MCP calls.
- Worktree is preserved.
- Result shows timeout reason.

### Phase 4: better agent config, external CLI docs, and WSL wrappers

Scope:

- Add first-class agent config file.
- Maintain `docs/local-agent-cli-tools.md` as the source of truth for external CLI command shapes that are not already covered by Groundcrew docs.
- Add recommended wrapper scripts for Codex WSL, Oh My Pi, Grok build.

Implementation steps:

1. Define `agents.local.jsonc` schema.
2. Add `agent_doctor`.
3. Add sample config.
4. Keep `docs/local-agent-cli-tools.md` updated with verified local command names, flags, prompt transport, output format, resume/cancel behavior, and safety notes.
5. Add WSL path conversion helper/wrapper.
6. Add command allowlist validation.
7. For Oh My Pi and Grok build mode, keep profiles disabled until local discovery verifies the real commands and non-interactive behavior.

Exit criteria:

- User can define `codex-wsl`, `oh-my-pi`, and `grok-build` safely.
- External CLI docs identify which details are verified, which are local/custom, and which remain unknown.

### Phase 5: Skill integration

Scope:

- Add a ChatGPT Skill that teaches routing/prompt rules.

Skill contents:

```text
local-agent-orchestrator/
  SKILL.md
  references/
    agent-selection.md
    prompt-contracts.md
    safety-rules.md
    result-review.md
  templates/
    implementation-prompt.md
    debug-prompt.md
    review-prompt.md
```

The Skill should say:

- Use `agent_plan` before risky launches.
- Use `agent_start` for long coding/build tasks.
- Prefer Codex for WSL/Linux implementation tasks.
- Prefer Claude Code for broad repo understanding and planning.
- Use Oh My Pi/Grok only when explicitly appropriate.
- Always inspect `agent_result` before presenting conclusions.
- Never launch arbitrary commands outside configured profiles.

### Phase 6: optional native backend

If Groundcrew library wrapping is too limiting, port selected pieces into Least:

- Worktree lifecycle from `worktrees.ts`.
- Run state from `runState.ts`.
- Workspace adapter model from `workspaceAdapter.ts` and `workspaces.ts`.
- tmux backend from `tmuxAdapter.ts` plus added capture/tail.
- Launch command staging from `launchCommand.ts`.

This would remove the Groundcrew runtime dependency but increase maintenance.

## Minimal first patch plan

A minimal PR should include:

1. `src/agentTypes.ts`
2. `src/agentGroundcrewAdapter.ts`
3. `src/agentJobStore.ts`
4. `src/agentOps.ts`
5. `src/server.ts` tool registrations:
   - `agent_list`
   - `agent_start`
   - `agent_status`
   - `agent_cancel`
6. `docs/local-agents.md`
7. `docs/local-agent-cli-tools.md` reference link and follow-up checklist.
8. `config.example.env` additions.
9. Unit tests for no-Groundcrew-installed path.

Avoid in first PR:

- Forking Groundcrew.
- Copying Groundcrew internals.
- ACP integration.
- Full dashboard UI.
- Complex multi-backend tail.
- Auto-apply/merge behavior.

## Potential code skeleton

### Dynamic import adapter

```ts
export async function loadGroundcrew() {
  try {
    return await import("@clipboard-health/groundcrew");
  } catch (error) {
    throw new Error(
      "Groundcrew is not installed. Install @clipboard-health/groundcrew or disable local agent tools.",
      { cause: error },
    );
  }
}
```

### Start flow

```ts
export async function startGroundcrewAgent(input: StartAgentInput): Promise<StartAgentResult> {
  const gc = await loadGroundcrew();
  const config = await gc.loadConfig();
  const task = input.taskId ?? makeTaskId(input.title);

  const job = createJobRecord({ ...input, task });

  await gc.setupWorkspace(config, {
    task,
    completionTaskId: `least:${task}`,
    completionMarkDoneSupported: false,
    repository: input.repo,
    agent: input.agent,
    details: {
      title: input.title,
      description: input.prompt,
    },
  });

  const runState = gc.readRunState(config, task);
  updateJobFromRunState(job.jobId, runState);
  return formatStartResult(job, runState);
}
```

### Status flow

```ts
export async function statusGroundcrewAgent(input: AgentStatusInput): Promise<AgentStatusResult> {
  const gc = await loadGroundcrew();
  const config = await gc.loadConfig();
  const job = readJob(input);
  const runState = gc.readRunState(config, job.taskId);
  const live = await probeWorkspaceBestEffort(config, runState?.workspaceName ?? job.taskId);
  return reconcileStatus(job, runState, live);
}
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Groundcrew API changes | Use dynamic import wrapper; isolate all calls in one adapter file. |
| Node version mismatch | Make Groundcrew optional at first; `agent_doctor` reports exact fix. |
| WSL path issues | Use wrapper scripts and path conversion, not inline commands. |
| Agent runs forever | Add Least wall-clock and idle watchdog. |
| Output not visible | Implement tmux capture first; fallback to logs. |
| Agent edits wrong tree | Require worktree mode for write jobs. |
| User loses work on cleanup | Refuse dirty cleanup unless `force`. Mirror Groundcrew behavior. |
| Prompt leaks secrets | Never include env dumps; keep prompt files minimal; do not stage secrets in `.ai-bridge`. |
| Dangerous custom command | Agent registry allowlist; approval gating; no arbitrary shell from prompt. |
| Nested Groundcrew clone accidentally committed as submodule | Keep reference clone under `plan/` for local study only, or add explicit ignore if needed later. |

## Verification plan

### Static checks

- TypeScript build.
- Existing smoke tests.
- New agent config tests.
- New job store tests.

### Manual smoke: no Groundcrew installed

Expected:

- `agent_list` returns setup error.
- `agent_doctor` says install Groundcrew.
- No crash.

### Manual smoke: Groundcrew installed, tmux available

1. Configure one local repo in Groundcrew.
2. Configure `claude-code` or harmless custom agent like `echo-agent`.
3. Run `agent_start` with a no-op prompt.
4. Check `agent_status`.
5. Check `agent_tail`.
6. Run `agent_cancel`.
7. Confirm worktree preserved.
8. Run `agent_cleanup`.

### Manual smoke: Codex WSL

1. Use wrapper script.
2. Confirm WSL path conversion.
3. Launch simple read-only task.
4. Confirm output capture.
5. Confirm no edits outside worktree.

### Timeout smoke

1. Configure agent command that sleeps or loops.
2. Start with short timeout.
3. Confirm status changes to timeout state.
4. Confirm session interrupted/killed.
5. Confirm worktree still exists.

## External CLI documentation follow-up

Created: `docs/local-agent-cli-tools.md`.

That document currently records:

- Claude Code CLI verified command/flag notes.
- OpenAI Codex CLI verified command/flag notes.
- Codex WSL wrapper contract.
- Oh My Pi / Pi local agent discovery checklist and disabled profile template.
- Grok build mode discovery checklist and disabled profile template.
- Common wrapper conventions for prompt files, logs, JSONL output, result files, and safety.

Keep it updated whenever a local CLI is inspected or a wrapper script is added. Do not enable Oh My Pi or Grok build profiles until local discovery confirms the executable, prompt transport, output behavior, permission model, and cancellation semantics.

## Open questions

1. Should Least require Groundcrew config or generate it?
2. Should agent jobs live under `.ai-bridge/agent-runs` or `.least/agent-runs`?
3. Should `agent_start` require explicit approval for every write-capable run, or only high-risk runs?
4. Should Groundcrew be a direct dependency, optional dependency, or local path dependency?
5. Should `agent_tail` support cmux/zellij in first PR, or only tmux?
6. Should we add `status --json` upstream to Groundcrew instead of duplicating status logic?
7. How should Codex WSL receive prompts: positional argument, stdin, or wrapper-managed prompt file?
8. Should Grok build mode use Groundcrew worktrees or a separate build workspace?
9. What are the exact local executable names and `--help` outputs for Oh My Pi and Grok build mode?

## Final recommendation

Proceed with a Groundcrew-backed adapter in Least.

Use the cloned Groundcrew repository as reference only. The first implementation should be small and reversible: dynamic import Groundcrew, call exported APIs, and expose four Least MCP tools. Then add tail/result/timeouts in subsequent phases.

This gives us the practical value of Groundcrew immediately while preserving Least as the ChatGPT-native orchestration layer.
