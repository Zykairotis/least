#!/usr/bin/env bash
tailscale funnel reset
set -euo pipefail

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
workspace=${LEAST_ROOT:-$project_root}
allowed_root=${1:-${LEAST_ALLOW_ROOT:-}}
token_file=${LEAST_TOKEN_FILE:-$HOME/.least/tailscale-token}

command -v node >/dev/null || { printf 'Node.js is required (version 20+).\n' >&2; exit 1; }
command -v tailscale >/dev/null || { printf 'Tailscale is not installed.\n' >&2; exit 1; }
[[ -d "$workspace" ]] || { printf 'Workspace does not exist: %s\n' "$workspace" >&2; exit 1; }
[[ -z "$allowed_root" || -d "$allowed_root" ]] || { printf 'Allowed root does not exist: %s\n' "$allowed_root" >&2; exit 1; }

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
(( node_major >= 20 )) || { printf 'Node.js 20+ is required; found %s.\n' "$(node --version)" >&2; exit 1; }

if ! systemctl is-active --quiet tailscaled; then
  printf 'Starting tailscaled...\n'
  sudo systemctl start tailscaled
fi

backend_state=$(tailscale status --json 2>/dev/null | node -e '
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  try { process.stdout.write(JSON.parse(input).BackendState || ""); }
  catch { process.exit(1); }
});
' || true)
if [[ "$backend_state" != Running ]]; then
  printf 'Tailscale login required. Complete login when prompted.\n'
  sudo tailscale up
fi

if ! tailscale funnel status --json >/dev/null 2>&1; then
  printf 'Granting %s permission to manage Tailscale Funnel...\n' "$USER"
  sudo tailscale set --operator="$USER"
fi

mkdir -p -- "$(dirname -- "$token_file")"
if [[ ! -s "$token_file" ]]; then
  umask 077
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")' > "$token_file"
fi
chmod 600 "$token_file"
export LEAST_HTTP_TOKEN
LEAST_HTTP_TOKEN=$(<"$token_file")

launcher=(node "$project_root/scripts/least.mjs" tailscale
  --root "$workspace"
  --tool-mode full
  --bash full
  --shell-backend bash
  --write workspace
  --print-tools
  --dual-client
  --concurrency off
  --copy-url
  --yolo
  --dashboard)
[[ -z "$allowed_root" ]] || launcher+=(--allow-root "$allowed_root")

printf 'Workspace: %s\n' "$workspace"
[[ -z "$allowed_root" ]] || printf 'Additional allowed root: %s\n' "$allowed_root"
printf 'Dashboard: http://127.0.0.1:8922\n'
printf 'Token file: %s (mode 600)\n' "$token_file"
printf 'Connector URL will print and copy after Funnel health check passes.\n'
printf 'Funnel remains active after exit; disable with: tailscale funnel reset\n'
exec "${launcher[@]}"
