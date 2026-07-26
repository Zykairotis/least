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
- Treats bash mode as `full` regardless of configured mode
- Registers full toolset regardless of `toolMode` restrictions
- Hook PreToolUse denials become non-blocking warnings
- Adds `yolo_mode: true` to every tool response

## What it does NOT bypass

- ChatGPT / client platform tool-call safety that may reject raw shell payloads **before** they reach Least (for example some `curl` JSON POSTs). Prefer structured tools such as `local_http_json`, `docker_compose_ps`, and `run_vitest` for routine local-dev work.
- ChatGPT platform approval prompts for local connector actions
- Operating-system permissions
- MCP host security rules outside Least
- Workspace root containment
- `allowedRoots` restrictions
- Symlink escape prevention
- Secret-looking content write blocks
- Mutation lock enforcement (unless `--no-lock` is added separately)

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
