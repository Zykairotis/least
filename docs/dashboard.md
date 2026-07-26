# Least Live Dashboard

The dashboard is a separate web-hosted React application that shows live activity and analytics for Least sessions.

## Start

```bash
least start --dashboard
# Custom port
least start --dashboard --dashboard-port 8922
# Custom host (non-loopback requires token)
least start --dashboard --dashboard-host 192.168.1.100 --dashboard-token mytoken
# Open browser on start
least start --dashboard --dashboard-open
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LEAST_DASHBOARD` | — | Enable dashboard (`1`) |
| `LEAST_DASHBOARD_PORT` | `8922` | Dashboard server port |
| `LEAST_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind address |
| `LEAST_DASHBOARD_OPEN` | — | Open browser on start (`1`) |
| `LEAST_DASHBOARD_TOKEN` | — | Auth token for non-loopback access |
| `LEAST_DASHBOARD_MAX_EVENTS` | `5000` | In-memory ring buffer size |
| `LEAST_DASHBOARD_SAMPLE_MS` | `1000` | Runtime snapshot interval |
| `LEAST_DASHBOARD_DB_PATH` | `<workspace>/.least/dashboard.db` | SQLite persistence path |
| `LEAST_DASHBOARD_GIT_INTERVAL_MS` | `2000` | Git status poll interval |

## Security

- **Local-only by default.** The dashboard binds to `127.0.0.1`.
- **Non-loopback requires token.** If `--dashboard-host` is not a loopback address, `--dashboard-token` is required at startup.
- **No raw tool arguments shown** by default (arguments may contain secrets).
- **No raw shell output shown** by default.
- **Sensitive fields are redacted** in events and snapshots.
- **No tool execution.** The dashboard is read-only in v1.

## What is shown

- **Overview** — KPI cards, live stream status, performance charts
- **Tools** — per-tool call/error/latency/size metrics with search and sort
- **Timeline** — live event stream (tool/hook/connection/lock events)
- **Hooks** — hook lifecycle, decisions, denials, duration
- **Connections** — active MCP sessions and surface info
- **Git** — branch, changed files, staged/unstaged counts
- **Runtime** — Node version, memory, uptime, PID
- **Agents** — persisted local agent jobs, terminal backends, sessions, panes, and attach/tail commands
- **Logs** — unified log stream with level/tool/kind filtering
- **Settings** — dashboard configuration summary

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/snapshot` | Full dashboard snapshot JSON |
| `GET /api/events` | Server-Sent Events stream |
| `GET /api/config` | Redacted dashboard config |
| `GET /api/log-sessions` | Persisted session rows |
| `GET /api/stored-events` | Persisted event rows for a session |
| `GET /api/stored-tool-calls` | Persisted tool-call rows for a session |
| `GET /api/agent-jobs` | Persisted local agent jobs parsed from `agent_*` tool outputs |
| `GET /api/agent-terminal-sessions` | Persisted Zellij/tmux/log terminal session rows |
| `GET /healthz` | Dashboard health check |

### SSE Event Stream

The `/api/events` endpoint streams Server-Sent Events:

1. **`snapshot`** — initial full state on connect
2. **`dashboard`** — incremental events as they occur
3. **`heartbeat`** — keep-alive every 15 seconds

Events use standard SSE format with `Last-Event-ID` support for reconnection.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Least MCP/API Server (port 8787 by default)          │
│  - MCP tool handlers                                 │
│  - Hook execution                                    │
│  - Connection lifecycle                              │
│  - Lock management                                   │
│  - Git operations                                    │
│                                                      │
│  Events: emitDashboardEvent() → ring buffer          │
└──────────────┬───────────────────────────────────────┘
               │ SSE stream
               ▼
┌──────────────────────────────────────────────────────┐
│ Least Dashboard Server (port 8922 by default)         │
│  - GET /api/snapshot                                  │
│  - GET /api/events (SSE)                              │
│  - GET /api/config                                    │
│  - Static SPA assets                                  │
│  - Auth (loopback bypass / token required)            │
└──────────────┬───────────────────────────────────────┘
               │ HTTP / SSE
               ▼
┌──────────────────────────────────────────────────────┐
│ React Dashboard SPA                                  │
│  - Nord dark theme                                   │
│  - Live updates via EventSource                      │
│  - Charts, tables, metrics                           │
│  - Read-only (no tool execution)                     │
└──────────────────────────────────────────────────────┘
```

## Development

```bash
# Start Vite dev server (proxies /api to backend)
npm run dashboard:dev

# Build production assets
npm run dashboard:build

# Preview built assets
npm run dashboard:preview
```

## Tests

```bash
# Unit tests (event bus, snapshot)
npm run dashboard:unit

# Backend smoke test
npm run dashboard:smoke

# Build smoke test (verify assets exist)
npm run dashboard:build-smoke
```

## Troubleshooting

| Problem | Solution |
|---|---|
| Port already in use | Set `--dashboard-port` or `LEAST_DASHBOARD_PORT` |
| Dashboard assets missing | Run `npm run dashboard:build` |
| SSE disconnected | Check network/firewall. Dashboard auto-reconnects. |
| No git data | Workspace must be a git repository. |
| No tool events | Tools must be called through Least's MCP server. |
