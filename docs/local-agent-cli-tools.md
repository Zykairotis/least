# Local agent CLI tool notes

Date: 2026-06-27
Status: planning/reference documentation
Related plan: `plan/2026-06-27-groundcrew-local-agent-orchestrator-integration-plan.md`
Groundcrew reference clone: `plan/groundcrew-reference`

## Purpose

This document records the external/local CLI tools that Least may orchestrate through the planned `agent_*` MCP tools.

Groundcrew already documents its own CLI, task sources, runners, and workspace/session model in `plan/groundcrew-reference/docs/`. This file focuses on the agent CLIs and local adapter commands that are not fully documented inside the cloned Groundcrew repo from Least's perspective.

The implementation rule is simple: Least must not accept arbitrary shell commands from ChatGPT. Every agent must be registered as a named, allowlisted profile with known command shape, prompt transport, timeout policy, sandbox/worktree policy, and result-collection strategy.

## Scope table

| Tool/profile | Source confidence | Groundcrew has built-in profile? | Least doc status | Recommended adapter mode |
|---|---:|---:|---|---|
| Claude Code CLI (`claude`) | High, official docs checked | Yes, basic `claude` profile | Documented here for Least-specific usage | Groundcrew profile + optional Claude background support |
| OpenAI Codex CLI (`codex`) | High, official docs checked | Yes, basic `codex` profile | Documented here for Least-specific usage and WSL use | Groundcrew profile + WSL wrapper for Linux-native work |
| Codex WSL profile (`codex-wsl`) | Derived from official Codex + local wrapper need | No | Documented as wrapper profile | Custom Groundcrew profile invoking a wrapper script |
| Oh My Pi / Pi local agent | Low, no reliable public CLI docs found under this name | No | Documented as local/custom adapter template | Custom profile after local command discovery |
| Grok build mode | Low, no reliable public CLI docs found under this name | No | Documented as local/custom adapter template | Custom profile after local command discovery |
| ACP adapters | Medium/high, protocol docs exist, but not first-phase dependency | No | Mentioned only as future compatibility layer | Do not block phase 1 on ACP |

## Common adapter contract

Every external CLI profile should define these fields before it is exposed through `agent_list` or `agent_start`:

```jsonc
{
  "name": "codex-wsl",
  "provider": "codex",
  "command": ["least-codex-wsl"],
  "prompt_transport": "stdin | positional | prompt-file | native-background",
  "cwd_policy": "groundcrew-worktree | explicit-worktree | read-only-main-tree",
  "write_policy": "read-only | worktree-write | full-access-forbidden-by-default",
  "resume": {
    "supported": true,
    "command": ["codex", "exec", "resume", "--last"]
  },
  "output": {
    "mode": "jsonl | text | terminal-capture",
    "tail_supported": true,
    "result_file_supported": true
  },
  "timeouts": {
    "tool_call_ms": 15000,
    "provision_ms": 120000,
    "wall_clock_ms": 3600000,
    "idle_ms": 900000,
    "force_kill_grace_ms": 60000
  },
  "safety": {
    "requires_worktree": true,
    "requires_approval_for_write": true,
    "allow_arbitrary_command_args": false,
    "allow_network": "inherit-from-runner"
  }
}
```

## Prompt transport rules

Prefer prompt files or stdin over inline shell text.

| Transport | Use when | Notes |
|---|---|---|
| `prompt-file` | Agent wrapper can read a prompt file path | Best for long prompts, quoting safety, and debugging. |
| `stdin` | CLI supports reading prompt from stdin | Good for Codex `codex exec -` and custom wrappers. |
| `positional` | CLI expects prompt as final argument | Works for Groundcrew's default command builder, but requires careful quoting. |
| `native-background` | CLI has its own background supervisor | Useful for Claude `--bg`, but still needs Least-side job state. |
| `terminal-interactive` | Agent is interactive-only | Least must rely on tmux/cmux/zellij capture and explicit cancellation. |

## Claude Code CLI

### Verified facts

Claude Code's CLI supports these important modes:

- `claude` starts an interactive session.
- `claude "query"` starts an interactive session with an initial prompt.
- `claude -p "query"` queries via SDK/print mode and exits.
- `cat file | claude -p "query"` processes piped content.
- `claude -c` continues the most recent conversation in the current directory.
- `claude -r "<session>" "query"` resumes a session by ID or name.
- `claude agents --json` can list active background sessions.
- `claude attach <id>`, `claude logs <id>`, and `claude stop <id>` manage background sessions.

Useful flags:

- `--bg` / `--background`: start as a background agent and return immediately.
- `--continue` / `-c`: load the most recent conversation in the current directory.
- `--resume` / `-r`: resume a specific session by ID or name.
- `--output-format text|json|stream-json`: control print-mode output format.
- `--permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions`: choose permission mode.
- `--max-turns`: cap agentic turns in print mode.
- `--max-budget-usd`: cap spend in print mode.
- `--mcp-config`: load MCP server configs.
- `--allowedTools` and `--disallowedTools`: tune tool permission behavior.
- `--debug-file`: write debug logs to a path.

Source checked:

```text
https://code.claude.com/docs/en/cli-reference
```

### Recommended Least profile

Use Groundcrew's normal `claude` profile for the first implementation, but define a Least-specific profile name so settings are explicit:

```ts
"claude-code": {
  cmd: "claude --permission-mode auto",
  color: "#C15F3C",
  resumeArgs: "--continue"
}
```

For non-interactive, structured runs outside Groundcrew, prefer:

```bash
claude -p --output-format stream-json --verbose "<task>"
```

For native Claude background sessions, possible future profile:

```bash
claude --bg "<task>"
claude agents --json
claude logs <id>
claude stop <id>
claude attach <id>
```

### Least adapter notes

| Concern | Decision |
|---|---|
| Primary mode | Groundcrew terminal/worktree profile first. |
| Prompt transport | Groundcrew positional prompt initially; prompt-file wrapper later if needed. |
| Resume | `--continue` in the task worktree. |
| Tail | tmux capture first; Claude native `logs <id>` only if using `--bg`. |
| Cancel | Groundcrew `interruptWorkspace`; Claude native `stop <id>` only for `--bg`. |
| Permissions | Start with `--permission-mode auto`; require approval for broader modes. |
| Unsafe mode | Do not default to `--dangerously-skip-permissions`. |

### Doctor checks

`agent_doctor` should check:

```bash
claude --version
claude auth status --text
```

Optional background-session checks:

```bash
claude daemon status
claude agents --json
```

### Open implementation questions

- Should Least use Claude's native `--bg` or always let Groundcrew own the terminal session?
- Can `claude -p --output-format stream-json` provide enough event detail to replace tmux capture for short jobs?
- Should high-risk tasks start in `--permission-mode plan` instead of `auto`?

## OpenAI Codex CLI

### Verified facts

Codex CLI is OpenAI's local terminal coding agent. It can inspect repositories, edit files, and run commands in the selected directory. The official docs describe `codex` as the interactive terminal UI and `codex exec` as the non-interactive/scriptable mode.

Key commands and modes:

- `codex`: launch the terminal UI.
- `codex exec "<task>"`: run non-interactively.
- `codex exec -`: read the full prompt from stdin.
- `codex exec --json "<task>"`: emit JSONL events on stdout.
- `codex exec -o <path>` / `--output-last-message <path>`: write final response to a file.
- `codex exec resume --last "<task>"`: continue the most recent exec session from the current working directory.
- `codex doctor`: generate a diagnostic report.

Important flags and behavior:

- `--cd` / `-C`: set workspace root before executing a task.
- `--sandbox workspace-write`: allow workspace edits.
- `--sandbox danger-full-access`: broader access; only for isolated runners.
- `--dangerously-bypass-approvals-and-sandbox` / `--yolo`: bypass approvals and sandboxing; should be forbidden by default in Least.
- `--skip-git-repo-check`: allow running outside Git; should be forbidden by default.
- By default, `codex exec` runs in a read-only sandbox.
- In non-interactive mode, progress streams to stderr and the final agent message prints to stdout.
- With `--json`, stdout becomes JSON Lines and includes events such as thread starts, turn starts/completions/failures, commands, file changes, MCP calls, web searches, and plan updates.
- On Windows, Codex can run natively with the Windows sandbox. Use WSL2 when Linux-native tooling or a WSL workflow is needed; WSL1 is no longer supported starting with Codex `0.115`.

Source checked:

```text
https://developers.openai.com/codex/cli
https://developers.openai.com/codex/cli/reference
https://developers.openai.com/codex/noninteractive
https://developers.openai.com/codex/windows
```

### Recommended Least profile: host Codex

For host-native Codex where the repo path is directly accessible:

```ts
"codex-host": {
  cmd: "codex exec --json --sandbox workspace-write -",
  color: "#3267e3",
  resumeArgs: "exec resume --last"
}
```

However, Groundcrew's default command builder appends the prompt as a positional argument. If using `codex exec -`, create a wrapper script so prompt-file/stdin transport is explicit.

### Recommended Least profile: Codex WSL

Use a wrapper script instead of embedding complicated WSL quoting in Groundcrew config.

Example logical Groundcrew profile:

```ts
"codex-wsl": {
  cmd: "least-codex-wsl {{worktree}}",
  color: "#3267e3",
  resumeArgs: "resume --last"
}
```

Better wrapper contract:

```bash
least-codex-wsl --worktree <host_or_wsl_path> --prompt-file <prompt.md> --mode implementation
```

Groundcrew may not pass `--prompt-file` natively in phase 1, so phase 1 can either:

1. Use a positional prompt and let the wrapper pass it to `codex exec`.
2. Extend Least/Groundcrew adapter to stage prompt files and call wrapper directly.
3. Use Groundcrew for worktree/session creation, then run a Least-owned command inside the terminal session.

Preferred long-term wrapper behavior is now represented by:

```text
scripts/least-codex-wsl.sh
```

Expected contract:

```bash
scripts/least-codex-wsl.sh --worktree <path> --prompt-file <path> [--output-dir <path>] [--distro <name>]
```

Responsibilities:

- Convert Windows paths to WSL paths when needed.
- cd into the assigned worktree.
- run `codex exec --json --sandbox workspace-write - < prompt.md`.
- write JSONL events to a known file when an output directory is supplied.
- preserve the Codex exit code.

### Least adapter notes

| Concern | Decision |
|---|---|
| Primary mode | `codex exec --json` for machine-readable output where possible. |
| Prompt transport | `stdin` via `codex exec -` preferred. |
| Resume | `codex exec resume --last` from same worktree. |
| Tail | JSONL log if wrapper captures stdout; tmux capture fallback. |
| Cancel | Groundcrew terminal interrupt first; process kill only through backend session. |
| Permissions | Default read-only for analysis, `workspace-write` for implementation. |
| Unsafe mode | Forbid `--yolo` / `--dangerously-bypass-approvals-and-sandbox` unless explicitly configured for an isolated runner. |
| WSL | Use WSL2, not WSL1. Prefer repos living inside WSL if possible. |

### Doctor checks

```bash
codex --version
codex doctor
```

For WSL:

```bash
wsl -l -v
wsl -d Ubuntu -- codex --version
wsl -d Ubuntu -- codex doctor
```

### Open implementation questions

- Should `codex-wsl` run inside a WSL-owned clone/worktree instead of Windows-mounted `X:` path?
- Should Codex JSONL become the primary event stream for `agent_tail`?
- Should Least use `--output-schema` for machine-readable final reports?

## Oh My Pi / Pi local agent profile

### Verification status

Verified from `can1357/oh-my-pi`. The user-facing product is Oh My Pi, but the installed CLI binary is `omp`.

The package is `@oh-my-pi/pi-coding-agent`, and its package metadata exposes this binary:

```jsonc
"bin": {
  "omp": "src/cli.ts"
}
```

Documented install commands include:

```text
curl -fsSL https://omp.sh/install | sh
brew install can1357/tap/omp
bun install -g @oh-my-pi/pi-coding-agent
irm https://omp.sh/install.ps1 | iex
mise use -g github:can1357/oh-my-pi
```

The README states platform/runtime support: macOS, Linux, Windows, and Bun >= 1.3.14.

### CLI command contract

The root CLI routes unknown positional arguments to the `launch` command, so these are valid launch forms:

```text
omp
omp "List all .ts files in src/"
omp @prompt.md @image.png "What color is the sky?"
omp -p "List all .ts files in src/"
```

Important launch flags:

| Flag | Meaning |
|---|---|
| `-p`, `--print` | Non-interactive mode: process prompt and exit. |
| `--cwd <DIR>` | Start in a specific directory. |
| `-c`, `--continue` | Continue previous session. |
| `-r`, `--resume <ID>` | Resume a session. |
| `--model <MODEL>` | Select model. |
| `--mode <MODE>` | Output mode: `text`, `json`, `rpc`, `acp`, or `rpc-ui`. |
| `--tools <LIST>` | Enable only selected tools. |
| `--max-time <SECONDS>` | Stop after a time limit. |
| `--approval-mode <MODE>` | `always-ask`, `write`, or `yolo`. Prefer `write`; do not default to `yolo`. |
| `--auto-approve`, `--yolo` | Auto-approve all tool calls; unsafe as a default. |

### Least profile

```jsonc
{
  "agents": {
    "oh-my-pi": {
      "provider": "pi",
      "groundcrewProfile": "oh-my-pi",
      "cmd": "omp -p --approval-mode write",
      "promptVia": "positional",
      "defaultTimeoutMs": 3600000,
      "idleTimeoutMs": 900000,
      "writePolicy": "worktree",
      "enabled": true,
      "notes": "Verified against can1357/oh-my-pi: the installed CLI binary is omp; -p/--print is non-interactive mode."
    }
  }
}
```

### Adapter recommendation

Use the same Groundcrew worktree/session path as Claude/Codex:

```text
Groundcrew worktree + tmux session -> omp -p --approval-mode write <prompt> -> tmux capture for tail -> git diff for result
```

Keep `--approval-mode write` as the default. Do not use `--yolo` / `--auto-approve` unless the user explicitly asks and the worktree/sandbox is isolated.

## Grok Build CLI profile

### Verification status

Verified public xAI documentation now identifies Grok Build as a coding agent exposed through the `grok` CLI.

The documented interactive command is:

```text
grok
```

The documented headless command forms are:

```text
grok -p "Explain this codebase"
grok -p "Explain the architecture" --output-format streaming-json
```

The documented headless flags include:

| Flag | Meaning |
|---|---|
| `-p`, `--single <PROMPT>` | Send one prompt. |
| `-m`, `--model <MODEL>` | Choose a model. |
| `-s`, `--session-id <ID>` | Create or resume a named headless session. |
| `-r`, `--resume <ID>` | Resume an existing session. |
| `-c`, `--continue` | Continue the most recent session in the current directory. |
| `--cwd <PATH>` | Set working directory. |
| `--output-format <FMT>` | `plain`, `json`, or `streaming-json`. |
| `--always-approve` | Auto-approve tool executions; do not use as the default Least profile. |
| `--no-alt-screen` | Run inline without fullscreen TUI takeover. |

xAI also documents `grok inspect` for checking discovered config/instructions/skills/plugins/hooks/MCP servers, and `grok agent stdio` for ACP over JSON-RPC.

Source URLs:

```text
https://docs.x.ai/build/overview
https://docs.x.ai/build/cli/headless-scripting
https://docs.x.ai/build/modes-and-commands
```

### Least profile

```jsonc
{
  "agents": {
    "grok-build": {
      "provider": "grok",
      "groundcrewProfile": "grok-build",
      "command": ["scripts/least-grok-headless.cmd"],
      "promptVia": "positional",
      "defaultTimeoutMs": 7200000,
      "idleTimeoutMs": 1200000,
      "writePolicy": "worktree",
      "enabled": true,
      "notes": "Verified against xAI Grok Build CLI docs: grok -p supports headless prompts and streaming-json output."
    }
  }
}
```

### Least wrapper

```text
scripts/least-grok-headless.cmd
```

The wrapper accepts the prompt appended by Groundcrew and calls the documented headless Grok CLI with streaming JSON output.

### Adapter recommendation

Treat Grok Build as usable but still higher-risk than read-only analysis agents:

- Require `agent_plan` before `agent_start`.
- Require isolated worktree.
- Keep `--always-approve` disabled by default.
- Default wall-clock timeout should be longer than code-analysis agents, e.g. 2 hours.
- Capture output via `streaming-json` when possible.
- Never auto-run deploy/publish/release commands.

## ACP adapters

ACP is useful later if Least wants editor/agent protocol compatibility, but it should not block the initial Groundcrew-backed implementation.

Potential ACP use cases:

- Pi has an ACP adapter and no clean CLI.
- Codex/Claude adapter offers better structured events than terminal capture.
- User wants Zed/VS Code/JetBrains interoperability.

Do not make ACP the phase-1 execution path. Use it as an adapter backend after the `agent_*` MCP surface is stable.

## Local wrapper conventions

Any wrapper script managed by Least should follow these rules:

1. Accept explicit `--worktree` and `--prompt-file` flags when possible.
2. Do not read arbitrary shell from the prompt.
3. `cd` only into the assigned worktree.
4. Emit logs to a known file path.
5. Emit a final result file where possible.
6. Preserve the underlying CLI exit code.
7. Avoid printing secrets or environment variables.
8. Prefer JSONL event output when the agent supports it.
9. Record tool version at startup.
10. Fail closed if the target worktree does not exist.

Recommended run folder layout:

```text
.ai-bridge/agent-runs/<job_id>/
  request.json
  prompt.md
  command.preview.txt
  stdout.log
  stderr.log
  events.jsonl
  result.md
  result.json
  status.json
```

## Documentation tasks to keep current

- Add exact local `oh-my-pi` command after discovery.
- Add exact Grok build command after discovery.
- Record whether Claude should use Groundcrew tmux or native `--bg` mode.
- Record whether Codex should use host-native Windows sandbox or WSL2.
- Add tested wrapper scripts once implemented.
- Add exact `agent_doctor` output expectations for each tool.
