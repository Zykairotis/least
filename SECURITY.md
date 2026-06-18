# Security Policy

Least exposes a local workspace to an MCP client. Treat it like a developer tool with access to your source tree, not like a hosted SaaS app.

## Supported Version

Security fixes target the latest published version only until the project reaches `1.0.0`.

## Reporting

Please report security issues privately before opening a public issue. If the repository has GitHub private vulnerability reporting enabled, use that. Otherwise contact the maintainer listed by the project owner.

Do not include secrets, private repository contents, tunnel tokens, or `.env` values in reports.

## Terms Boundary

Least is not designed to bypass, avoid, pool, resell, or modify ChatGPT, Codex, OpenAI, or third-party model limits. Do not market, deploy, or configure it that way.

Each user should connect their own ChatGPT account, use only product surfaces available to that account, and follow the limits, safety rules, and terms for ChatGPT, Codex, OpenAI, and any third-party model provider they connect.

## Threat Model

Least can expose:

- file metadata and selected file contents from allowed workspaces
- git status and diffs
- `.ai-bridge` planning files
- optional shell command execution through the `bash` tool
- optional write/edit capability depending on `LEAST_WRITE_MODE`
- optional local handoff execution through `least execute-handoff`, run from the user's terminal only

The main risks are:

- connecting an untrusted MCP client
- exposing the server through a public tunnel without auth
- running with `LEAST_BASH_MODE=full`
- running with `LEAST_WRITE_MODE=workspace` on an important repo
- executing an untrusted `.ai-bridge/current-plan.md` or custom `execute-handoff --command`
- adding overly broad allowed roots
- leaking a `least_token` or Cloudflare tunnel token
- trusting a downloaded `cloudflared` binary without understanding where it came from

## Safer Defaults

Default daily mode:

```bash
least start \
  --root /path/to/repo \
  --bash safe \
  --tunnel cloudflare
```

Safer planning-only mode:

```bash
least start \
  --root /path/to/repo \
  --mode handoff \
  --bash safe \
  --tunnel cloudflare
```

For stable public hostnames, keep the Least auth token stable but private:

```bash
least start \
  --root /path/to/repo \
  --tunnel cloudflare-named \
  --hostname least.example.com \
  --tunnel-name least \
  --token <long-random-token> \
  --bash safe
```

## Hard Rules

- Do not run public tunnels with `--no-auth`.
- Public tunnel mode and non-loopback binds fail closed if `LEAST_HTTP_TOKEN` is missing.
- Do not commit printed connector URLs that include `least_token`.
- Do not commit Cloudflare tunnel tokens.
- Use `--mode handoff` for planning workflows where ChatGPT should not edit source files.
- Preview local handoff execution with `least execute-handoff --dry-run` before running an unfamiliar adapter or custom command.
- Keep `execute-handoff` local. Do not wrap it in a remote MCP tool unless you add a stronger approval and sandbox story.
- Use default agent mode only with trusted ChatGPT sessions and repo-specific roots.
- Use `--bash full` only for trusted local repos.
- Prefer a repo-specific `--root` instead of `--allow-home`.
- Use `--no-install-cloudflared --cloudflared <path>` if your organization requires a managed Cloudflare Tunnel binary.

## Cloudflare Binary Install

For the one-command public tunnel flow, Least can download the official Cloudflare `cloudflared` release into `~/.least/bin` on supported macOS, Windows, and Linux systems. It does not install a system service, does not use sudo/admin rights, and does not modify shell startup files.

Resolution order:

```text
1. explicit --cloudflared path or CLOUDFLARED_BIN
2. cloudflared already available in PATH
3. ~/.least/bin/cloudflared or cloudflared.exe
4. download official Cloudflare latest release unless --no-install-cloudflared is set
```

Use `--install-cloudflared` to refresh the local binary. Use `--no-install-cloudflared` to disable downloads.

## Built-In Guards

Least blocks common sensitive paths by default:

- `.env` and `.env.*`
- `.git` internals
- `node_modules`
- common private key names
- build/cache folders such as `dist`, `build`, `.next`, `coverage`, `.cache`
- symlinks that resolve outside the workspace or into blocked paths

These guards reduce risk. They are not an OS sandbox.
