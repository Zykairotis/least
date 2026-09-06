#!/usr/bin/env bash
# Diagnose whether Tailscale Funnel is ChatGPT-ready for Least MCP.
#
# Checks:
#   1. tailscaled + device online
#   2. local Least on LEAST_PORT (default 8787)
#   3. Funnel public + proxy target matches local port
#   4. public DNS from multiple resolvers
#   5. public /healthz + MCP initialize via Funnel edge
#
# Exit codes:
#   0  ChatGPT-ready (public MCP path verified)
#   1  not ready (see FAIL/WARN lines)
#   2  missing deps (tailscale/curl/dig)
#
# Usage:
#   bash scripts/least-funnel-doctor.sh
#   bash scripts/least-funnel-doctor.sh --fix    # reassert funnel -> local port if wrong
#   LEAST_PORT=8787 LEAST_TOKEN_FILE=~/.least/tailscale-token bash scripts/least-funnel-doctor.sh

set -euo pipefail

port=${LEAST_PORT:-8787}
token_file=${LEAST_TOKEN_FILE:-$HOME/.least/tailscale-token}
host_override=${LEAST_FUNNEL_HOST:-}
fix=0
json_out=0

for arg in "$@"; do
  case "$arg" in
    --fix) fix=1 ;;
    --json) json_out=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if ! command -v tailscale >/dev/null; then
  printf 'FAIL  tailscale CLI not found on PATH\n' >&2
  exit 2
fi
if ! command -v curl >/dev/null; then
  printf 'FAIL  curl not found on PATH\n' >&2
  exit 2
fi
if ! command -v dig >/dev/null; then
  printf 'FAIL  dig not found on PATH (install bind-tools / dnsutils)\n' >&2
  exit 2
fi

ok_n=0
warn_n=0
fail_n=0
chatgpt_ready=0
dns_name=""
proxy_target=""
funnel_on=0
local_ok=0
public_health_ok=0
public_mcp_ok=0
dns_ok_resolvers=()
dns_bad_resolvers=()
edge_ip=""
token=""
connector_url=""
remediation=()

record() {
  local level=$1 label=$2 detail=${3:-}
  case "$level" in
    ok)   ok_n=$((ok_n + 1));   printf 'OK    %s' "$label" ;;
    warn) warn_n=$((warn_n + 1)); printf 'WARN  %s' "$label" ;;
    fail) fail_n=$((fail_n + 1)); printf 'FAIL  %s' "$label" ;;
  esac
  if [[ -n "$detail" ]]; then
    printf ' — %s\n' "$detail"
  else
    printf '\n'
  fi
}

add_fix() {
  remediation+=("$1")
}

read_token() {
  if [[ -s "$token_file" ]]; then
    token=$(tr -d '[:space:]' <"$token_file")
  elif [[ -n "${LEAST_HTTP_TOKEN:-}" ]]; then
    token=$LEAST_HTTP_TOKEN
  fi
}

json_get() {
  # Usage: json_get <json-string> <node-expression-on-j>
  local payload=$1
  local expr=$2
  node -e '
const j = JSON.parse(process.argv[1] || "{}");
const out = (() => { try { return ('"$expr"'); } catch { return ""; } })();
if (out === undefined || out === null) process.stdout.write("");
else if (typeof out === "string") process.stdout.write(out);
else process.stdout.write(String(out));
' "$payload" 2>/dev/null || true
}

# --- 1. Tailscale daemon / self ---
ts_json=$(tailscale status --json 2>/dev/null || true)
if [[ -z "$ts_json" ]]; then
  record fail "Tailscale status" "could not read status --json (is tailscaled running?)"
  add_fix "Start Tailscale: sudo systemctl start tailscaled && sudo tailscale up"
else
  backend=$(json_get "$ts_json" 'j.BackendState')
  online=$(json_get "$ts_json" 'j.Self && j.Self.Online')
  dns_name=$(json_get "$ts_json" 'j.Self && j.Self.DNSName || ""')
  # Tailscale reports FQDN with trailing dot; strip for URLs and dig.
  dns_name=${dns_name%.}
  dns_name=${dns_name%.}
  if [[ -n "$host_override" ]]; then
    dns_name=$host_override
    dns_name=${dns_name%.}
  fi
  if [[ "$backend" == "Running" ]]; then
    record ok "Tailscale daemon" "BackendState=Running"
  else
    record fail "Tailscale daemon" "BackendState=${backend:-unknown}"
    add_fix "Connect Tailscale: sudo tailscale up"
  fi
  if [[ "$online" == "true" ]]; then
    record ok "This device" "online as ${dns_name:-unknown}"
  else
    record fail "This device" "not online (Self.Online=${online:-empty})"
    add_fix "Ensure this machine is signed in and not paused: tailscale status"
  fi
  if [[ -z "$dns_name" ]]; then
    record fail "MagicDNS name" "no Self.DNSName (enable MagicDNS + HTTPS Certificates in admin console)"
    add_fix "Tailscale admin: enable MagicDNS and HTTPS Certificates for the tailnet"
  else
    record ok "MagicDNS name" "$dns_name"
  fi
fi

# --- 2. Token ---
read_token
if [[ -n "$token" ]]; then
  record ok "Auth token" "loaded from ${token_file/#$HOME/~} (${#token} chars)"
else
  record warn "Auth token" "missing ($token_file); public /healthz may still work if auth disabled"
  add_fix "Create token: mkdir -p ~/.least && umask 077 && openssl rand -hex 32 > ~/.least/tailscale-token && chmod 600 ~/.least/tailscale-token"
fi

# --- 3. Local Least ---
local_code=$(curl -sS -o /tmp/least-funnel-doctor-local.json -w '%{http_code}' \
  --connect-timeout 3 --max-time 8 \
  ${token:+-H "Authorization: Bearer $token"} \
  "http://127.0.0.1:${port}/healthz" 2>/dev/null || echo "000")
if [[ "$local_code" == "200" ]]; then
  local_ok=1
  local_name=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync("/tmp/least-funnel-doctor-local.json","utf8"));process.stdout.write(j.name||"")}catch{}' 2>/dev/null || true)
  record ok "Local Least" "http://127.0.0.1:${port}/healthz → 200${local_name:+ ($local_name)}"
else
  record fail "Local Least" "http://127.0.0.1:${port}/healthz → ${local_code}"
  add_fix "Start Least: bash scripts/least-tailscale-linux.sh"
  add_fix "Or: npm run connect:tailscale  (with LEAST_HTTP_TOKEN set)"
fi

# --- 4. Funnel config ---
funnel_text=$(tailscale funnel status 2>/dev/null || true)
funnel_json=$(tailscale funnel status --json 2>/dev/null || true)

if echo "$funnel_text" | grep -qi 'Funnel on'; then
  funnel_on=1
  record ok "Funnel mode" "public Funnel on"
elif echo "$funnel_text" | grep -qi 'tailnet only'; then
  record fail "Funnel mode" "tailnet only (Serve) — ChatGPT cannot reach private Serve"
  add_fix "Enable public Funnel: tailscale funnel reset && tailscale funnel --bg ${port}"
elif [[ -z "$funnel_text" ]]; then
  record fail "Funnel mode" "no funnel/serve config"
  add_fix "Enable Funnel: tailscale funnel --bg ${port}"
else
  # older CLI wording
  if echo "$funnel_text" | grep -qi 'Available on the internet'; then
    funnel_on=1
    record ok "Funnel mode" "available on the internet"
  else
    record warn "Funnel mode" "unrecognized status output"
    printf '%s\n' "$funnel_text" | sed 's/^/      /'
  fi
fi

expected_proxy="http://127.0.0.1:${port}"
proxy_target=$(node -e '
const j = JSON.parse(process.argv[1] || "{}");
const web = j.Web || {};
for (const host of Object.keys(web)) {
  const handlers = (web[host] && web[host].Handlers) || {};
  for (const path of Object.keys(handlers)) {
    const h = handlers[path] || {};
    if (h.Proxy) { process.stdout.write(h.Proxy); process.exit(0); }
  }
}
' "$funnel_json" 2>/dev/null || true)

if [[ -z "$proxy_target" ]]; then
  # fallback parse from text
  proxy_target=$(echo "$funnel_text" | sed -n 's/.*proxy //p' | head -1 | tr -d '[:space:]')
fi

if [[ -n "$proxy_target" ]]; then
  if [[ "$proxy_target" == "$expected_proxy" || "$proxy_target" == "http://localhost:${port}" || "$proxy_target" == "${port}" || "$proxy_target" == "127.0.0.1:${port}" ]]; then
    record ok "Funnel target" "$proxy_target (matches Least port ${port})"
  else
    record fail "Funnel target" "$proxy_target (expected ${expected_proxy})"
    add_fix "Rebind Funnel: tailscale funnel reset && tailscale funnel --bg ${port}"
    if [[ "$fix" -eq 1 ]]; then
      printf '      --fix: reasserting funnel → %s\n' "$port"
      if tailscale funnel reset >/dev/null 2>&1 && tailscale funnel --bg "$port" >/dev/null 2>&1; then
        sleep 1
        funnel_text=$(tailscale funnel status 2>/dev/null || true)
        funnel_json=$(tailscale funnel status --json 2>/dev/null || true)
        proxy_target=$(echo "$funnel_text" | sed -n 's/.*proxy //p' | head -1 | tr -d '[:space:]')
        if echo "$funnel_text" | grep -qi 'Funnel on\|Available on the internet'; then
          funnel_on=1
        fi
        if [[ "$proxy_target" == *":${port}"* || "$proxy_target" == "$expected_proxy" ]]; then
          record ok "Funnel target (after --fix)" "$proxy_target"
          fail_n=$((fail_n > 0 ? fail_n - 1 : 0))
        else
          record fail "Funnel target (after --fix)" "${proxy_target:-still wrong}"
        fi
      else
        record fail "Funnel --fix" "could not run funnel reset/--bg (operator permissions?)"
        add_fix "Grant operator: sudo tailscale set --operator=\$USER"
      fi
    fi
  fi
else
  record fail "Funnel target" "no proxy handler found"
  add_fix "Enable Funnel: tailscale funnel --bg ${port}"
fi

# If funnel was off but --fix requested and target missing, try enable
if [[ "$fix" -eq 1 && "$funnel_on" -eq 0 ]]; then
  printf '      --fix: enabling public funnel on port %s\n' "$port"
  if tailscale funnel reset >/dev/null 2>&1 && tailscale funnel --bg "$port" >/dev/null 2>&1; then
    sleep 1
    funnel_text=$(tailscale funnel status 2>/dev/null || true)
    if echo "$funnel_text" | grep -qi 'Funnel on\|Available on the internet'; then
      funnel_on=1
      record ok "Funnel mode (after --fix)" "public Funnel on"
    fi
  fi
fi

# --- 5. Public DNS (multi-resolver) ---
if [[ -n "$dns_name" ]]; then
  resolvers=(1.1.1.1 8.8.8.8 9.9.9.9)
  for r in "${resolvers[@]}"; do
    ans=$(dig @"$r" +time=2 +tries=1 +short "$dns_name" A 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')
    if [[ -n "$ans" ]]; then
      dns_ok_resolvers+=("$r")
      record ok "DNS @$r" "$dns_name → $ans"
      if [[ -z "$edge_ip" ]]; then
        edge_ip=${ans%% *}
      fi
    else
      dns_bad_resolvers+=("$r")
      record warn "DNS @$r" "$dns_name → empty/NXDOMAIN"
    fi
  done
  if [[ ${#dns_ok_resolvers[@]} -eq 0 ]]; then
    record fail "Public DNS" "no resolver returned A records for $dns_name"
    add_fix "Reassert Funnel: tailscale funnel reset && tailscale funnel --bg ${port}"
    add_fix "Wait ~30s for Funnel DNS, re-run this doctor"
    add_fix "If ChatGPT still fails, use Cloudflare tunnel as fallback"
  elif [[ ${#dns_bad_resolvers[@]} -gt 0 ]]; then
    record warn "Public DNS" "partial: ok=[${dns_ok_resolvers[*]}] bad=[${dns_bad_resolvers[*]}]"
    add_fix "ChatGPT may fail if its resolvers hit a bad view (seen often with Cloudflare 1.1.1.1 on Funnel names)"
  else
    record ok "Public DNS" "all sampled resolvers returned A records"
  fi
else
  record fail "Public DNS" "skipped (no hostname)"
fi

# --- 6. Public health + MCP via edge IP (bypass local DNS bugs) ---
if [[ -n "$dns_name" && -n "$edge_ip" ]]; then
  auth_args=()
  [[ -n "$token" ]] && auth_args=(-H "Authorization: Bearer $token")

  pub_code=$(curl -skS -o /tmp/least-funnel-doctor-pub.json -w '%{http_code}' \
    --connect-timeout 12 --max-time 25 \
    --resolve "${dns_name}:443:${edge_ip}" \
    "${auth_args[@]}" \
    "https://${dns_name}/healthz" 2>/dev/null || echo "000")
  if [[ "$pub_code" == "200" ]]; then
    public_health_ok=1
    record ok "Public /healthz" "via ${edge_ip} → 200"
  else
    record fail "Public /healthz" "via ${edge_ip} → ${pub_code}"
    add_fix "Confirm Funnel proxies to Least and Least is listening on ${port}"
  fi

  mcp_url="https://${dns_name}/mcp"
  [[ -n "$token" ]] && mcp_url="${mcp_url}?least_token=${token}"
  mcp_code=$(curl -skS -o /tmp/least-funnel-doctor-mcp.txt -w '%{http_code}' \
    --connect-timeout 12 --max-time 25 \
    --resolve "${dns_name}:443:${edge_ip}" \
    -X POST "$mcp_url" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"least-funnel-doctor","version":"1"}}}' \
    2>/dev/null || echo "000")
  if [[ "$mcp_code" == "200" ]] && grep -q '"name":"Least"' /tmp/least-funnel-doctor-mcp.txt 2>/dev/null; then
    public_mcp_ok=1
    record ok "Public MCP initialize" "via ${edge_ip} → 200 (Least)"
  elif [[ "$mcp_code" == "200" ]]; then
    record warn "Public MCP initialize" "HTTP 200 but body did not look like Least"
  else
    record fail "Public MCP initialize" "via ${edge_ip} → ${mcp_code}"
    add_fix "ChatGPT needs a working public /mcp; fix Funnel target and local Least first"
  fi
else
  record fail "Public probe" "skipped (need hostname + public A record)"
fi

# --- Verdict ---
if [[ "$local_ok" -eq 1 && "$funnel_on" -eq 1 && "$public_health_ok" -eq 1 && "$public_mcp_ok" -eq 1 && ${#dns_ok_resolvers[@]} -gt 0 ]]; then
  chatgpt_ready=1
fi

printf '\n'
printf '──────────────────────────────────────────────\n'
if [[ "$chatgpt_ready" -eq 1 ]]; then
  if [[ ${#dns_bad_resolvers[@]} -gt 0 ]]; then
    printf 'RESULT  MOSTLY READY (DNS partial)\n'
    printf '        Public MCP works from this machine via Funnel edge.\n'
    printf '        Some resolvers fail — ChatGPT may still see mcp_network_error.\n'
  else
    printf 'RESULT  CHATGPT-READY (Tailscale Funnel)\n'
  fi
  if [[ -n "$token" && -n "$dns_name" ]]; then
    connector_url="https://${dns_name}/mcp?least_token=${token}"
  elif [[ -n "$dns_name" ]]; then
    connector_url="https://${dns_name}/mcp"
  fi
  if [[ -n "$connector_url" ]]; then
    printf '\nChatGPT connector (No Auth):\n  %s\n' "$connector_url"
    printf '\nGrok MCP:\n  https://%s/mcp-grok\n' "$dns_name"
  fi
  printf '\nNext: paste the URL into ChatGPT, then open a new chat.\n'
else
  printf 'RESULT  NOT CHATGPT-READY\n'
  printf '        Fix FAIL items below, then re-run this doctor.\n'
fi
printf '──────────────────────────────────────────────\n'
printf 'summary  ok=%s  warn=%s  fail=%s  local=%s  funnel=%s  dns_ok=%s  pub_health=%s  pub_mcp=%s\n' \
  "$ok_n" "$warn_n" "$fail_n" "$local_ok" "$funnel_on" "${#dns_ok_resolvers[@]}" "$public_health_ok" "$public_mcp_ok"

if [[ ${#remediation[@]} -gt 0 ]]; then
  printf '\nSuggested fixes:\n'
  # unique preserve order
  seen=""
  for line in "${remediation[@]}"; do
    case "$seen" in
      *"|$line|"*) continue ;;
    esac
    seen="${seen}|$line|"
    printf '  • %s\n' "$line"
  done
fi

if [[ "$json_out" -eq 1 ]]; then
  DNS_OK_CSV=$(IFS=,; echo "${dns_ok_resolvers[*]-}")
  DNS_BAD_CSV=$(IFS=,; echo "${dns_bad_resolvers[*]-}")
  LEAST_DOCTOR_JSON=1 \
  CHATGPT_READY=$chatgpt_ready \
  LOCAL_OK=$local_ok \
  FUNNEL_ON=$funnel_on \
  PUB_HEALTH=$public_health_ok \
  PUB_MCP=$public_mcp_ok \
  DNS_NAME=$dns_name \
  PROXY_TARGET=$proxy_target \
  EDGE_IP=$edge_ip \
  CONNECTOR_URL=$connector_url \
  DNS_OK_CSV=$DNS_OK_CSV \
  DNS_BAD_CSV=$DNS_BAD_CSV \
  PORT=$port \
  OK_N=$ok_n \
  WARN_N=$warn_n \
  FAIL_N=$fail_n \
  node -e '
const b = (v) => v === "1" || v === "true";
const csv = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const data = {
  chatgptReady: b(process.env.CHATGPT_READY),
  localOk: b(process.env.LOCAL_OK),
  funnelOn: b(process.env.FUNNEL_ON),
  publicHealthOk: b(process.env.PUB_HEALTH),
  publicMcpOk: b(process.env.PUB_MCP),
  dnsName: process.env.DNS_NAME || "",
  proxyTarget: process.env.PROXY_TARGET || "",
  edgeIp: process.env.EDGE_IP || "",
  connectorUrl: process.env.CONNECTOR_URL || "",
  dnsOk: csv(process.env.DNS_OK_CSV),
  dnsBad: csv(process.env.DNS_BAD_CSV),
  port: Number(process.env.PORT || 8787),
  ok: Number(process.env.OK_N || 0),
  warn: Number(process.env.WARN_N || 0),
  fail: Number(process.env.FAIL_N || 0),
};
console.log(JSON.stringify(data, null, 2));
'
fi

if [[ "$chatgpt_ready" -eq 1 ]]; then
  # partial DNS still exits 0 but user was warned
  exit 0
fi
exit 1
