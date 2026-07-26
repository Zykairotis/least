# Plan: Least Live Analytics Dashboard

Date: 2026-06-27
Status: Proposed
Scope: Web-hosted React dashboard for live Least tool, connection, hook, git, runtime, and analytics telemetry
Default dashboard port: 8922

## Summary

Build a separate web-hosted dashboard for Least that shows live activity and analytics for local Least sessions. The dashboard should be a dark Nord-themed React application served from Least, defaulting to port `8922`, with the port configurable by CLI and environment variable.

The dashboard should show:

- live tool calls and output metadata
- active MCP/HTTP connection state
- session and lifetime tool performance
- runtime latency, cache, timeout, compaction, and output-size metrics
- hook events and hook outcomes
- workspace lock events
- git status snapshots and recent changes
- logs and error stream
- graphs for tool usage, latency, output sizes, compaction savings, and event throughput

This should not replace the existing MCP server. It should be an observability plane that reads from Least's in-process telemetry/event bus and renders it in a browser.

## Important Constraints

1. The dashboard must not expose secrets.
2. The dashboard must not display raw tool arguments by default when arguments may contain secrets.
3. The dashboard must not expose raw shell output by default.
4. The dashboard must not run arbitrary tools from the browser in v1.
5. The dashboard must bind to `127.0.0.1` by default.
6. Remote/LAN access must require an explicit flag and token.
7. The dashboard should work even when the main MCP HTTP server is running on a different port.
8. The dashboard must be disabled by default unless explicitly started, or served behind the same local-only assumptions as Least.

## External Research Notes

Context7 was requested for library research. In this session, Context7 library lookup calls were blocked by the platform safety layer. The implementation agent should retry Context7 locally for the exact libraries below before coding:

- `Vite`
- `React`
- `Recharts`
- `TanStack Table` or a smaller table alternative
- `lucide-react`
- optional: `zustand` if local state complexity gets high

Official web docs checked for planning assumptions:

- Vite supports configurable dev `server.port`, `server.strictPort`, proxy rules, and middleware mode.
- Browser `EventSource` / Server-Sent Events are a native browser mechanism for one-way server-to-client streaming over HTTP.
- React `useEffect` is the correct primitive for connecting a mounted component to an external system and cleaning up the connection.

## Current Codebase Observations

### `src/perf.ts`

Least already has in-process tool performance telemetry:

- `measuredToolCall(toolName, workspaceId, fn)`
- `recordCompaction(...)`
- `recordRetrieval()`
- `recordGuardTiming(...)`
- `recordFsTiming(...)`
- `recordChildProcessTiming(...)`
- `recordChildProcessSpawn(...)`
- `recordCacheOutcome(...)`
- `recordBackend(...)`
- `recordTimedOut()`
- `recordPartial()`
- `getLeastPerfSnapshot(window)`

The snapshot already includes per-tool calls, errors, timeouts, partials, average and p95 latency, output bytes, raw bytes, visible bytes, saved bytes, compactions, compaction fallback count, retrieval count, backend labels, slowest calls, largest outputs, and gain metrics. This should be the base for the dashboard metrics model.

### `src/gainOps.ts`

Least already formats gain/discover snapshots:

- `leastGain(window, format)`
- `leastDiscover(window)`

The dashboard should consume structured JSON directly rather than text formatting.

### `src/server.ts`

Least has a central `registerCodexTool(...)` wrapper around every tool. This is the right place to emit live tool lifecycle events.

Natural stages:

1. generic permission check
2. `PreToolUse` hooks
3. actual handler execution
4. `PostToolUse` hooks
5. result return

Add dashboard event emission around these stages.

Known prerequisite bug:

- `runHooks(..., { yoloMode: true })` is hardcoded in the generic wrapper. It should pass `config.yoloMode` or `_yoloMode`, otherwise normal-mode hook denials are effectively bypassed.

### `src/hooks.ts`

Hook events already have typed names:

- `ConfigLoad`
- `ConfigChange`
- `WorkspaceOpen`
- `PreToolUse`
- `PostToolUse`
- `ToolError`
- `PreBash` / `PostBash`
- `PreRead` / `PostRead`
- `PreWrite` / `PostWrite`
- `PreEdit` / `PostEdit`
- `LockAcquired` / `LockReleased`

The dashboard should record hook start, hook allow/deny/error, timeout, trusted/untrusted status, and duration.

### `src/workspaceLocks.ts`

The lock manager has state and lifecycle methods:

- acquire
- renew
- release
- status
- prune

Add event emission here or in the server tool handlers that call these methods.

### `src/gitOps.ts`

Git functions are already capped, redacted, cached, and measured:

- `gitStatus(...)`
- `gitDiff(...)`
- `gitLog(...)`

Use these for dashboard snapshots. Do not shell out independently from the dashboard layer.

### `src/http.ts`

The current HTTP server serves:

- onboarding page at `/` and `/setup`
- health endpoint at `/healthz`
- MCP endpoints
- OAuth/OpenAI-compatible routes when configured

Add either a separate dashboard server module or mount dashboard assets into this Express app depending on the selected architecture.

### `src/toolCardWidget.ts`

There is already a Nord-like dark UI vocabulary:

- `--nord0` through `--nord16`
- dark surfaces
- compact cards
- status pills
- monospace metadata

Reuse these color tokens for visual consistency.

## Architecture Decision

Use a separate dashboard server by default:

```text
Least MCP/API server:   existing port, e.g. 8787
Least dashboard server: default port 8922
```

Reasons:

- It avoids coupling dashboard static assets to the MCP protocol route handling.
- It allows the dashboard to be enabled/disabled independently.
- It makes permission and CORS boundaries simpler.
- It keeps the main MCP surface small.

Later, optionally support embedding at `/dashboard` on the main HTTP server.

## CLI and Environment Design

Add CLI flags to `scripts/least.mjs`:

```bash
least start --dashboard
least start --dashboard-port 8922
least start --dashboard-host 127.0.0.1
least start --dashboard-open
least start --dashboard-token <token>
```

Environment variables:

```bash
LEAST_DASHBOARD=1
LEAST_DASHBOARD_PORT=8922
LEAST_DASHBOARD_HOST=127.0.0.1
LEAST_DASHBOARD_OPEN=1
LEAST_DASHBOARD_TOKEN=<token>
```

Config fields in `LeastConfig`:

```ts
dashboardEnabled: boolean;
dashboardHost: string;
dashboardPort: number;
dashboardOpen: boolean;
dashboardToken?: string;
dashboardMaxEvents: number;
dashboardSampleMs: number;
```

Defaults:

```ts
dashboardEnabled = false;
dashboardHost = "127.0.0.1";
dashboardPort = 8922;
dashboardOpen = false;
dashboardMaxEvents = 5_000;
dashboardSampleMs = 1_000;
```

## Recommended New Files

```text
src/dashboardServer.ts
src/dashboardEvents.ts
src/dashboardState.ts
src/dashboardTypes.ts
src/dashboardAuth.ts
src/dashboardSnapshot.ts
web/dashboard/package.json
web/dashboard/index.html
web/dashboard/vite.config.ts
web/dashboard/tsconfig.json
web/dashboard/src/main.tsx
web/dashboard/src/App.tsx
web/dashboard/src/api.ts
web/dashboard/src/useLiveDashboard.ts
web/dashboard/src/theme.css
web/dashboard/src/types.ts
web/dashboard/src/components/Shell.tsx
web/dashboard/src/components/MetricCard.tsx
web/dashboard/src/components/ToolTimeline.tsx
web/dashboard/src/components/ToolTable.tsx
web/dashboard/src/components/Charts.tsx
web/dashboard/src/components/EventLog.tsx
web/dashboard/src/components/HooksPanel.tsx
web/dashboard/src/components/GitPanel.tsx
web/dashboard/src/components/ConnectionsPanel.tsx
web/dashboard/src/components/RuntimePanel.tsx
scripts/dashboard-unit.mjs
scripts/dashboard-smoke.mjs
scripts/dashboard-build-smoke.mjs
```

## Existing Files to Modify

```text
package.json
package-lock.json
src/config.ts
src/http.ts
src/server.ts
src/hooks.ts
src/workspaceLocks.ts
src/perf.ts
src/gitOps.ts
scripts/least.mjs
scripts/smoke.mjs
docs/dashboard.md
```

## Backend Design

### `src/dashboardEvents.ts`

Create a small in-process pub/sub event bus.

Types:

```ts
export type DashboardEventKind =
  | "tool:start"
  | "tool:end"
  | "tool:error"
  | "hook:start"
  | "hook:end"
  | "hook:error"
  | "connection:open"
  | "connection:close"
  | "connection:request"
  | "lock:acquired"
  | "lock:renewed"
  | "lock:released"
  | "lock:blocked"
  | "git:snapshot"
  | "runtime:snapshot"
  | "log"
  | "server:started";
```

Core interface:

```ts
export interface DashboardEvent {
  id: number;
  ts: string;
  kind: DashboardEventKind;
  workspaceId?: string;
  sessionId?: string;
  surface?: "chatgpt" | "grok" | "openai" | "dashboard";
  toolName?: string;
  level?: "debug" | "info" | "warn" | "error";
  durationMs?: number;
  payload?: Record<string, unknown>;
}
```

Bus API:

```ts
export function emitDashboardEvent(input: Omit<DashboardEvent, "id" | "ts">): DashboardEvent;
export function subscribeDashboardEvents(listener: (event: DashboardEvent) => void): () => void;
export function getRecentDashboardEvents(limit?: number): DashboardEvent[];
export function clearDashboardEvents(): void;
```

Implementation notes:

- Keep an in-memory ring buffer, default 5,000 events.
- Redact payloads before storing.
- Do not store full command output.
- Store hashes/truncated summaries for large strings.
- Use monotonic numeric `id` for EventSource resume support via `Last-Event-ID` later.

### `src/dashboardState.ts`

Create aggregate state optimized for the UI.

State sections:

```ts
interface DashboardState {
  server: ServerInfo;
  runtime: RuntimeInfo;
  connections: ConnectionInfo[];
  tools: ToolLiveStats[];
  recentToolCalls: ToolCallEvent[];
  hooks: HookStats;
  git: GitDashboardState;
  logs: LogEvent[];
  perf: ReturnType<typeof getLeastPerfSnapshot>;
  gain: ReturnType<typeof getGainSnapshot>;
}
```

Aggregation model:

- Tool stats aggregate from `perf.ts` and live events.
- Connection stats come from `http.ts` MCP transport lifecycle.
- Hook stats come from `hooks.ts` execution lifecycle.
- Git snapshot polls `gitStatus` on a conservative interval, default 2 seconds while dashboard clients are connected.
- Runtime uses `process.memoryUsage()`, `process.uptime()`, Node version, platform, and pid.

### `src/dashboardServer.ts`

Serve:

```text
GET /                 dashboard SPA HTML/static assets
GET /healthz          dashboard health
GET /api/snapshot     current full dashboard snapshot JSON
GET /api/events       Server-Sent Events stream
GET /api/config       redacted dashboard config
```

Optional in v2:

```text
GET /api/git/status
GET /api/perf
POST /api/events/clear
```

Security:

- Bind `127.0.0.1` by default.
- If host is not loopback, require `LEAST_DASHBOARD_TOKEN`.
- Do not reuse MCP token unless explicitly configured.
- Add no-store cache headers for JSON/SSE.
- Use CORS only for local dashboard origin.

SSE response requirements:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
```

Stream event format:

```text
event: dashboard
id: 42
data: {"id":42,"ts":"...","kind":"tool:end"}

```

Heartbeat every 15 seconds:

```text
: heartbeat

```

### Why SSE Instead of WebSocket for v1

Use Server-Sent Events for v1 because the dashboard only needs one-way updates from Least to the browser. It is simpler than WebSocket, native in browsers through `EventSource`, and fits logs/metrics streaming. Add WebSocket later only if browser-to-server commands are added.

## Frontend Design

### Framework

Use:

```text
React + TypeScript + Vite
```

Suggested dependencies:

```json
{
  "react": "latest stable",
  "react-dom": "latest stable",
  "vite": "latest stable",
  "@vitejs/plugin-react": "latest stable",
  "recharts": "latest stable",
  "lucide-react": "latest stable",
  "clsx": "latest stable"
}
```

Consider avoiding a heavy UI kit. The existing Least UI is custom CSS and should stay visually consistent.

Optional:

```json
{
  "@tanstack/react-table": "latest stable"
}
```

Only add TanStack Table if sorting/filtering/pinning complexity justifies it. Otherwise use plain semantic tables.

### Vite Config

File: `web/dashboard/vite.config.ts`

Requirements:

- default dev port `8922`
- strict port true for predictable UX
- proxy `/api` to the dashboard backend in development if backend port differs
- output to `dist/dashboard` or `web/dashboard/dist`

Sketch:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.LEAST_DASHBOARD_PORT ?? 8922),
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.LEAST_DASHBOARD_API ?? "http://127.0.0.1:8922",
        changeOrigin: true,
        ws: false
      }
    }
  },
  build: {
    outDir: "../../dist/dashboard",
    emptyOutDir: true
  }
});
```

### React Data Flow

Create `useLiveDashboard()`:

```ts
export function useLiveDashboard() {
  // 1. fetch /api/snapshot on mount
  // 2. open EventSource('/api/events')
  // 3. merge incoming events into local reducer
  // 4. reconnect automatically when browser/network drops
  // 5. expose connection state and last event time
}
```

React implementation notes:

- Use `useEffect` to create and clean up `EventSource`.
- Keep event reducer pure.
- Cap in-browser event arrays, e.g. last 1,000 log rows.
- Store raw events separately from derived chart series.
- Use memoized selectors for expensive derived data.

### UI Layout

Use a single-page dashboard with left nav and dense cards.

Top-level sections:

1. Overview
2. Tools
3. Timeline
4. Hooks
5. Connections
6. Git
7. Runtime
8. Logs
9. Settings

### Nord Theme

Use tokens aligned with `src/toolCardWidget.ts`:

```css
:root {
  color-scheme: dark;
  --nord0: #030407;
  --nord1: #06080c;
  --nord2: #0a0d12;
  --nord3: #0f131a;
  --nord4: #151b24;
  --nord5: #7b8799;
  --nord6: #a3afc0;
  --nord7: #c8d0dc;
  --nord8: #7ab8b6;
  --nord9: #6fa8b8;
  --nord10: #6d8faa;
  --nord11: #4d6d8c;
  --nord12: #a85b64;
  --nord13: #b06f5a;
  --nord14: #c4a86a;
  --nord15: #7fa070;
  --nord16: #9a7a9e;
  --line: rgba(77, 109, 140, 0.2);
  --line-strong: rgba(77, 109, 140, 0.32);
  --shadow: rgba(0, 0, 0, 0.72);
  --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Monaco, Consolas, monospace;
  --sans: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
}
```

Components:

- matte dark panels
- thin blue-gray borders
- small caps labels
- monospace metadata
- colored status pills
- no high-saturation neon
- responsive grid

## Screens and Analytics

### Overview

Cards:

- Active sessions
- Tool calls per minute
- Error rate
- p95 latency
- Average output bytes
- Raw bytes saved by compaction
- Hook denials/errors
- Current git branch/status summary
- Workspace lock status
- Dashboard stream status

Charts:

- tool calls over time
- p95 latency by tool
- output bytes over time
- compaction savings over time
- error/timeout count over time

### Tools

Table columns:

```text
Tool
Calls
Errors
Timeouts
Partials
Avg ms
P95 ms
Max ms
Avg output bytes
Avg raw bytes
Avg visible bytes
Saved bytes
Compactions
Retrievals
Backends
Last seen
```

Interactions:

- search by tool name
- sort by p95, calls, errors, output size
- filter: errors only, slow only, write tools, shell tools
- click tool row to show recent calls for that tool

### Timeline

Show recent events in strict timestamp order:

```text
19:20:01.120 tool:start bash
19:20:02.401 hook:start PreToolUse bash
19:20:02.480 hook:end allow
19:20:06.910 tool:end bash 4520ms exit=0 output=12KB
```

Include event kinds:

- tool start/end/error
- hook start/end/error
- connection open/close
- lock acquire/renew/release
- git snapshot changed
- dashboard client connect/disconnect

### Hooks

Cards:

- hook events by type
- hook duration p95
- hook denials
- hook errors
- untrusted hook skips
- current settings summary: enabled, allowProjectHooks, trustedHookCommands count

Table:

```text
Timestamp
Event
Tool
Command
Decision
Duration
Timed out
Reason
```

Do not show raw hook stdin payload unless a debug toggle is explicitly enabled and redacted.

### Connections

Track:

- MCP session id, redacted
- client surface: ChatGPT/Grok/OpenAI/dashboard
- auth mode
- created at
- last seen
- request count
- pending request count
- closed/disconnected state
- transport count

Use `http.ts` transport lifecycle:

- new initialize request
- session initialized
- request received
- transport pruned
- transport closed

### Git

Show:

- branch/status text
- changed files count
- staged/unstaged/untracked counts
- last snapshot time
- git errors

Implementation:

- Use `gitStatus(config, workspace, guard, undefined, { untrackedMode: "all" })`.
- Parse counts for UI only; keep raw redacted status available in collapsible panel.
- Poll only while dashboard has connected clients.
- Cache/poll interval default 2 seconds, configurable.

### Runtime

Show:

- Node version
- platform and arch
- pid
- uptime
- rss heap external memory
- event loop delay if implemented later
- active dashboard clients
- active MCP transports
- cache stats from `getWorkspaceCacheStats`
- output store stats if available

### Logs

Unify logs from:

- dashboard event bus
- tool errors
- hook errors
- HTTP request logs if enabled
- server started/stopped events

Levels:

```text
debug, info, warn, error
```

Filters:

- tool
- level
- workspace id
- event kind
- text search

## Backend Event Emission Points

### Tool Lifecycle in `registerCodexTool`

On start:

```ts
emitDashboardEvent({
  kind: "tool:start",
  toolName: name,
  workspaceId: workspaceIdFromArgsIfKnown(safeArgs),
  payload: summarizeToolInput(name, safeArgs)
});
```

On success:

```ts
emitDashboardEvent({
  kind: "tool:end",
  toolName: name,
  durationMs,
  workspaceId,
  payload: summarizeToolResult(raw)
});
```

On error:

```ts
emitDashboardEvent({
  kind: "tool:error",
  toolName: name,
  durationMs,
  workspaceId,
  level: "error",
  payload: { message: redactSensitiveText(error.message) }
});
```

Do not duplicate `measuredToolCall`. Instead, emit events and let `perf.ts` remain the aggregate metrics source.

### Hook Lifecycle in `runHooks`

Emit:

- `hook:start` before trust check/execution
- `hook:end` after allow/deny
- `hook:error` on process error or timeout

Payload should include:

```ts
{
  event,
  toolName,
  command: sanitizeHookCommand(spec.command),
  trusted: boolean,
  decision,
  timedOut,
  reason
}
```

### HTTP Connection Lifecycle in `http.ts`

Emit:

- `connection:request` on MCP POST/GET/DELETE
- `connection:open` when session initializes
- `connection:close` in transport `onclose`
- `connection:close` when pruned

Payload should include redacted session id, surface, auth mode, path, status code, duration.

### Lock Lifecycle

Emit:

- `lock:acquired`
- `lock:renewed`
- `lock:released`
- `lock:blocked`

Prefer server handlers if adding an event dependency inside `workspaceLocks.ts` causes coupling. If using the manager, keep event emitter lightweight and dependency-free.

### Git Snapshots

Implement a dashboard poller inside `dashboardSnapshot.ts`:

- Only run while dashboard has at least one connected SSE client.
- Use default workspace initially.
- Later support workspace selection.
- Poll every `LEAST_DASHBOARD_GIT_INTERVAL_MS`, default 2,000ms.
- Emit `git:snapshot` only when status hash changes.

## API Contract

### `GET /api/snapshot`

Response:

```json
{
  "ok": true,
  "server": {
    "name": "Least",
    "version": "0.31.0",
    "startedAt": "...",
    "defaultRoot": "X:\\least",
    "dashboardPort": 8922,
    "yoloMode": false
  },
  "runtime": {
    "pid": 1234,
    "node": "v26.2.0",
    "platform": "win32",
    "uptimeSec": 120,
    "memory": {
      "rss": 0,
      "heapUsed": 0,
      "heapTotal": 0,
      "external": 0
    }
  },
  "perf": {},
  "gain": {},
  "connections": [],
  "hooks": {},
  "git": {},
  "events": []
}
```

### `GET /api/events`

SSE stream.

Initial events:

1. `snapshot`
2. then incremental `dashboard` events
3. heartbeat comments every 15 seconds

Events:

```text
event: snapshot
data: {...}

```

```text
event: dashboard
data: {...}

```

```text
: heartbeat

```

### `GET /api/config`

Return redacted runtime/dashboard config.

Never return:

- `authToken`
- `dashboardToken`
- full environment
- secret-like settings values

## Serving Model

### Development

Run two processes or one orchestrated process:

```bash
npm run dashboard:dev
```

Options:

- Vite dev server on 8922 proxies `/api` to the Least dashboard backend.
- Or Least dashboard backend serves Vite middleware.

Prefer separate dev server for speed.

### Production/Local Installed Use

Build React assets:

```bash
npm run dashboard:build
```

Output:

```text
dist/dashboard/
```

Least dashboard server serves this static directory.

If assets are missing:

- Return a clear HTML error page with `npm run dashboard:build` instruction.
- Do not crash the MCP server unless dashboard is explicitly required.

## Package Scripts

Add:

```json
{
  "dashboard:dev": "vite --config web/dashboard/vite.config.ts",
  "dashboard:build": "vite build --config web/dashboard/vite.config.ts",
  "dashboard:preview": "vite preview --config web/dashboard/vite.config.ts --host 127.0.0.1 --port 8922",
  "dashboard:unit": "node scripts/dashboard-unit.mjs",
  "dashboard:smoke": "node scripts/dashboard-smoke.mjs",
  "dashboard:build-smoke": "node scripts/dashboard-build-smoke.mjs"
}
```

Add to `npm run smoke` after settings/permissions/hooks/yolo tests but before slow integration tests:

```bash
node scripts/dashboard-unit.mjs && node scripts/dashboard-smoke.mjs && node scripts/dashboard-build-smoke.mjs
```

## Tests

### Unit Tests

Add `scripts/dashboard-unit.mjs` for pure event bus and snapshot tests:

- event ids increment
- ring buffer caps correctly
- subscribers receive events
- unsubscribe stops delivery
- redaction applies to payloads
- snapshot includes perf/gain/runtime sections
- Last-Event-ID filtering works if implemented

### Backend Smoke

Add `scripts/dashboard-smoke.mjs`:

- start dashboard server on an ephemeral port or fixed test port
- request `/healthz`
- request `/api/snapshot`
- open `/api/events`
- emit synthetic event
- verify SSE receives it
- verify heartbeat or snapshot event arrives
- close client cleanly

### Frontend Build Smoke

Add `scripts/dashboard-build-smoke.mjs`:

- run Vite build if safe in CI or verify build output exists after `npm run dashboard:build`
- verify `dist/dashboard/index.html`
- verify asset files exist
- verify no secrets are embedded

### Integration Smoke

Optional later:

- start Least with dashboard enabled
- call a few tools through registry
- assert dashboard snapshot shows tool calls
- assert `tool:start` and `tool:end` events were streamed

## Security and Privacy

### Redaction

Before any event is stored or streamed:

- call `redactSensitiveText` for strings
- call `redactStructured` or equivalent for objects
- truncate large values
- replace shell output with byte counts and small preview only when safe

Sensitive keys to suppress:

```text
token
access_token
refresh_token
authorization
password
secret
cookie
api_key
private_key
.env
```

### Auth

Default local mode:

- bind `127.0.0.1`
- no token required for loopback if existing Least behavior allows this

Non-loopback mode:

- require `LEAST_DASHBOARD_TOKEN`
- reject startup if host is not loopback and no token is provided
- use `Authorization: Bearer <token>` or `?dashboard_token=` only for local convenience

### CORS

- Do not use open CORS by default.
- Allow only same-origin dashboard requests.
- Dev mode can allow `http://127.0.0.1:8922` explicitly.

### No Browser Tool Execution in v1

The dashboard is read-only.

Do not add buttons that run tools, bash, hooks, or git commands in v1. Any control plane can be added later with explicit auth, confirmation, audit, and non-YOLO safety semantics.

## Performance Requirements

Backend:

- O(1) event append to ring buffer.
- Avoid serializing massive snapshots on every event.
- Send small event deltas over SSE.
- Send full snapshot at connect and on explicit refresh.
- Poll git only while clients are connected.
- Throttle runtime snapshots to once per second.

Frontend:

- Cap in-memory events to 1,000 visible rows by default.
- Virtualize logs only if performance requires it.
- Use memoized selectors for chart data.
- Avoid rendering every incoming event as a new React component tree if event rate spikes.

## Implementation Phases

### Phase 1: Backend event bus and snapshots

Files:

```text
src/dashboardEvents.ts
src/dashboardState.ts
src/dashboardSnapshot.ts
src/dashboardTypes.ts
```

Tasks:

1. Add event bus with ring buffer.
2. Add redacted event emit helper.
3. Add runtime snapshot helper.
4. Add dashboard snapshot combining perf/gain/runtime/events.
5. Add unit tests.

Acceptance:

- event bus tests pass
- snapshot returns expected sections
- no secrets in synthetic secret payload test

### Phase 2: Instrument core lifecycle events

Files:

```text
src/server.ts
src/hooks.ts
src/http.ts
src/workspaceLocks.ts or server lock handlers
```

Tasks:

1. Emit tool lifecycle events from `registerCodexTool`.
2. Emit hook lifecycle events from `runHooks`.
3. Emit connection events in HTTP transport lifecycle.
4. Emit lock lifecycle events.
5. Fix hardcoded `yoloMode: true` in `server.ts` while touching hook wrapper.

Acceptance:

- dashboard event bus receives tool start/end/error
- hook deny/allow events appear
- connection open/close appears
- normal-mode hook behavior remains correct

### Phase 3: Dashboard HTTP server

Files:

```text
src/dashboardServer.ts
src/dashboardAuth.ts
src/http.ts
src/config.ts
scripts/least.mjs
```

Tasks:

1. Add config fields and CLI/env parsing.
2. Add server startup path when dashboard is enabled.
3. Add `/api/snapshot`.
4. Add `/api/events` SSE.
5. Add `/api/config`.
6. Add `/healthz`.
7. Add static asset serving.

Acceptance:

- `least start --dashboard --dashboard-port 8922` serves dashboard.
- `GET /api/snapshot` returns valid JSON.
- `GET /api/events` streams events.
- non-loopback without token is rejected.

### Phase 4: React frontend

Files:

```text
web/dashboard/**
```

Tasks:

1. Create Vite React TypeScript app.
2. Add Nord theme CSS based on existing tool card variables.
3. Build layout shell and nav.
4. Implement snapshot fetch and SSE hook.
5. Implement overview cards.
6. Implement tools table.
7. Implement charts.
8. Implement logs/timeline/hooks/connections/git/runtime panels.

Acceptance:

- loads at `http://127.0.0.1:8922`
- shows live stream status
- updates without refresh when events arrive
- responsive layout works at desktop and narrow widths

### Phase 5: Graphs and analytics

Recommended charts:

- Area chart: tool calls per minute
- Line chart: p95 latency over time
- Bar chart: calls by tool
- Bar chart: errors/timeouts by tool
- Area chart: raw bytes vs visible bytes
- Bar chart: compaction savings by tool
- Timeline strip: hook decisions and tool errors

Use Recharts for v1 unless the build size or rendering performance becomes a problem.

### Phase 6: Docs and smoke tests

Files:

```text
docs/dashboard.md
scripts/dashboard-unit.mjs
scripts/dashboard-smoke.mjs
scripts/dashboard-build-smoke.mjs
scripts/smoke.mjs
package.json
```

Tasks:

1. Document startup flags.
2. Document security model.
3. Document dashboard endpoints.
4. Document troubleshooting.
5. Add smoke tests.
6. Add CI-safe build test.

Acceptance:

- `npm run build` passes
- `npm run dashboard:build` passes
- `npm run dashboard:smoke` passes
- `npm run smoke` passes

## Suggested Data Types

### Tool Call Event

```ts
interface ToolCallEvent {
  id: number;
  ts: string;
  toolName: string;
  workspaceId?: string;
  sessionId?: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  error?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: {
    rawBytes?: number;
    visibleBytes?: number;
    structuredBytes?: number;
    compacted?: boolean;
    retrievalKeyPresent?: boolean;
  };
}
```

### Connection Info

```ts
interface ConnectionInfo {
  id: string;
  surface: "chatgpt" | "grok" | "openai" | "dashboard";
  authMode: string;
  createdAt: string;
  lastSeenAt: string;
  requestCount: number;
  closed?: boolean;
}
```

### Hook Event

```ts
interface HookEventRecord {
  id: number;
  ts: string;
  event: string;
  toolName?: string;
  command?: string;
  trusted?: boolean;
  decision: "allow" | "deny" | "error";
  durationMs?: number;
  timedOut?: boolean;
  reason?: string;
}
```

## Edge Cases

1. Dashboard starts before any tool call.
   - Show empty state, not errors.

2. Main MCP server is not enabled.
   - Dashboard should still show runtime/config if started independently.

3. Client reconnects.
   - Fetch snapshot again; optionally use `Last-Event-ID` later.

4. High event volume.
   - Ring buffer drops oldest; UI shows dropped-event count.

5. Git repo unavailable.
   - Git panel shows unavailable state, not crash.

6. Hook command includes sensitive paths.
   - Show sanitized command and reason only.

7. Output compaction disabled.
   - Graphs still show raw vs visible bytes if available.

8. Multiple workspaces.
   - v1 shows all workspaces mixed with workspace filter; v2 can add per-workspace tabs.

## Documentation Outline

Create `docs/dashboard.md`:

```markdown
# Least Live Dashboard

## Start

least start --dashboard
least start --dashboard --dashboard-port 8922

## Security

Local-only by default. Non-loopback requires token.

## What is shown

Tools, hooks, connections, runtime, git, logs, performance, compaction gain.

## Endpoints

/api/snapshot
/api/events
/api/config
/healthz

## Troubleshooting

Port already in use
Dashboard assets missing
SSE disconnected
No git data
No tool events
```

## Acceptance Criteria

Implementation is complete when:

- Dashboard defaults to `127.0.0.1:8922`.
- Port can be changed via CLI and env.
- React app uses dark Nord theme aligned with existing tool card UI.
- Dashboard shows live tool events without page refresh.
- Dashboard shows session/lifetime perf analytics from `perf.ts`.
- Dashboard shows hook events and outcomes.
- Dashboard shows connection lifecycle events.
- Dashboard shows lock events.
- Dashboard shows git status snapshots.
- Dashboard shows runtime memory/uptime.
- Dashboard graphs update live.
- Sensitive fields are redacted in events and snapshots.
- Non-loopback dashboard access requires token.
- Static production dashboard assets are served by Least.
- `npm run dashboard:build` passes.
- `npm run dashboard:smoke` passes.
- `npm run smoke` includes dashboard smoke and passes.

## Recommended PR Order

1. Fix existing hook YOLO hardcode bug.
2. Add dashboard event bus and unit tests.
3. Instrument tool/hook/connection/lock lifecycle events.
4. Add dashboard snapshot/SSE HTTP endpoints.
5. Add Vite React app with Nord theme and read-only UI.
6. Add charts and tables.
7. Add git/runtime panels.
8. Add docs and smoke tests.
9. Add `npm run smoke` integration.

## Open Decisions

1. Should dashboard start automatically with `least start`, or only with `--dashboard`?
   - Recommendation: only with `--dashboard` initially.

2. Should dashboard share the MCP HTTP token?
   - Recommendation: no by default; use separate `LEAST_DASHBOARD_TOKEN` for non-loopback.

3. Should dashboard allow tool execution later?
   - Recommendation: not in v1.

4. Should dashboard run as separate Express app or mount on existing app?
   - Recommendation: separate server by default, optional mount later.

5. Should charting use Recharts or a smaller canvas library?
   - Recommendation: Recharts for v1 because it is simple for React dashboards; revisit if performance/build size is poor.
