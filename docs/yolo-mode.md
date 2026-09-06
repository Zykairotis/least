# YOLO Mode

`--yolo` disables Least's internal permission prompts, allow/deny rules, and bash gating for trusted local development sessions.

## Usage

```bash
least --yolo
# or
least --dangerously-allow-all
# or
LEAST_YOLO=1 least start
```

## What it does

- Skips all `Tool(...)`, `Bash(...)`, `Read(...)`, `Write(...)`, `Edit(...)` permission evaluation
- Treats permission `ask` decisions as `allow`
- Treats bash mode as `full` regardless of configured mode (so tools like `agent-browser` can run)
- Registers full toolset regardless of `toolMode` restrictions
- Most hook denials become non-blocking warnings
- Adds `yolo_mode: true` to every tool response

## What it does NOT bypass

- **Hard safety bash blocks** (always on): `rm -rf /`, `mkfs`, `dd` to devices, `sudo`, `curl|sh`, fork bombs, force-push, etc. Inspired by Claude Code deny lists.
- **Safety hooks when `hooks.enforceInYolo` is true (default)**: `PreBash` and bash-matching `PreToolUse` denials still fail closed under yolo (see `scripts/hooks/block-destructive.mjs`).
- ChatGPT / client platform tool-call safety that may reject raw shell payloads **before** they reach Least (for example some `curl` JSON POSTs). Prefer structured tools such as `local_http_json`, `docker_compose_ps`, and `run_vitest` for routine local-dev work.
- ChatGPT platform approval prompts for local connector actions
- Operating-system permissions
- MCP host security rules outside Least
- Workspace root containment
- `allowedRoots` restrictions
- Symlink escape prevention
- Secret-looking content write blocks
- Mutation lock enforcement (unless `--no-lock` is added separately)

### Recommended yolo + safety setup

```bash
least start --yolo --dashboard --tunnel tailscale-funnel
```

With `.least/settings.local.json`:

```jsonc
{
  "hooks": {
    "enabled": true,
    "allowProjectHooks": true,
    "enforceInYolo": true,
    "trustedHookCommands": ["scripts/hooks/block-destructive.mjs"],
    "PreBash": [{ "type": "command", "command": "scripts/hooks/block-destructive.mjs" }],
    "PreToolUse": [{ "matcher": "bash", "type": "command", "command": "scripts/hooks/block-destructive.mjs" }]
  },
  "permissions": {
    "deny": ["Bash(sudo *)", "Bash(rm -rf /)", "Bash(mkfs*)", "Bash(git reset --hard*)"]
  }
}
```

This keeps agent-browser and normal coding CLIs available while blocking catastrophic deletes.

## Security

YOLO mode is intentionally dangerous. Risks include:

- Destructive shell commands
- Data exfiltration by tools
- Accidental writes to sensitive files
- Malicious hook behavior from workspace config
- Bypass of deny rules meant to protect secrets or production paths

Required mitigations:

- Opt-in only via CLI flag or `LEAST_YOLO=1` env variable
- Visible startup warning
- Visible `yoloMode: true` in `server_config`
- Project settings **cannot** enable YOLO mode
- Path containment and secret redaction remain active
