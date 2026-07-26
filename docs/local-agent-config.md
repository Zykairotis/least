# Local agent config

Least reads optional local agent metadata from:

```text
.least/agents.local.jsonc
agents.local.jsonc
```

A sample file is provided at:

```text
docs/examples/agents.local.example.jsonc
```

Copy the sample to `.least/agents.local.jsonc` on a machine where local agents are installed. The workspace safety rules may block automated writes to `.least/`, so this copy can be done manually.

Least now ships built-in known profiles for `claude-code`, `codex-host`, `codex-wsl`, `grok-build`, and `oh-my-pi`. This config is used to override or disable those built-ins, add custom profiles, drive validation, run doctor checks, and enforce disabled-profile safety. Groundcrew still needs its own `crew.config.ts` for actual worktree/session launches.

## Schema

```jsonc
{
  "groundcrew": {
    "configPath": "~/.config/groundcrew/crew.config.ts",
    "workspaceKind": "tmux | cmux | zellij | auto",
    "runner": "srt"
  },
  "terminal": {
    "preferredBackend": "zellij | tmux | logs | auto",
    "zellijSessionPrefix": "least-agent",
    "logFallback": true,
    "wslDistro": "Arch",
    "runZellijInWsl": false
  },
  "agents": {
    "agent-name": {
      "provider": "claude | codex | pi | grok | custom",
      "groundcrewProfile": "matching-groundcrew-profile-name",
      "cmd": "command string",
      "command": ["argv0", "arg1"],
      "promptVia": "stdin | positional | prompt-file | native-background | interactive | unknown",
      "defaultTimeoutMs": 3600000,
      "idleTimeoutMs": 900000,
      "writePolicy": "read-only | worktree | full-access-forbidden",
      "enabled": true,
      "requiredExecutables": ["omp"],
      "smokeArgs": ["--version"],
      "dangerousFlags": ["--yolo"],
      "notes": "operator notes"
    }
  }
}
```

Use either `cmd` or `command`. Prefer `command` arrays or wrapper scripts for anything with quoting, WSL, prompt files, or output paths. Local profiles with the same name as a built-in profile override the built-in entry.

## Safety rules

- Disabled profiles cannot be launched when their name matches the requested agent.
- Commands containing shell control syntax are flagged; use a wrapper script instead.
- Oh My Pi is supported as a verified `omp` CLI profile when `omp` is installed and authenticated/configured.
- Grok Build is supported as a verified `grok` CLI profile when `grok` is installed and authenticated or `XAI_API_KEY` is set.
- The config does not replace Groundcrew config. The `groundcrewProfile` should map to a profile in `crew.config.ts`.

## Doctor checks

Run `agent_doctor` to check:

- Node version/platform
- local config parse state
- built-in, local, and effective agent profiles
- Groundcrew import state
- Groundcrew config loading
- whether enabled local profiles map to Groundcrew profiles
- terminal backend availability for Zellij, tmux, and Least log fallback
- required local commands such as `git`, `tmux`, `zellij`, `wsl`, `claude`, `codex`, `grok`, and `omp`
- version/smoke checks for enabled profile executables when available

## Codex WSL wrapper

Template:

```text
scripts/least-codex-wsl.sh
```

Expected wrapper contract:

```bash
scripts/least-codex-wsl.sh --worktree <path> --prompt-file <path> [--output-dir <path>] [--distro <name>]
```

The script:

- converts paths with `wslpath` when available
- changes into the assigned worktree only
- runs `codex exec --json --sandbox workspace-write -`
- can write `events.jsonl` and `stderr.log` to an output directory

The wrapper is a template and should be tested on the target machine before enabling `codex-wsl`.

## Grok Build wrapper

Template:

```text
scripts/least-grok-headless.cmd
```

Expected Groundcrew usage:

```text
scripts/least-grok-headless.cmd <prompt...>
```

The wrapper calls:

```text
grok --no-auto-update -p <prompt> --output-format streaming-json
```

`agent_doctor` verifies the `grok` executable when the `grok-build` profile is enabled.
