# Log Session Observability Plan

> **Status**: Draft — awaiting operator review  
> **Triggered by**: Session request on 2026-06-26 — add JSON-like log detail dropdowns and persist sessions in SQL DB  
> **Scope**: Frontend log viewer UX, backend session/event persistence, tool-call audit trail  
> **Non-goal**: Replace existing application logging or market-data storage

---

## Goal

Build a session-oriented observability layer where every assistant/agent run can be inspected from the UI as structured events. The UI should show a compact timeline by default, with expandable JSON detail panels for tool calls, inputs, outputs, timing, errors, and session metadata.

Target outcome:

```text
Session list -> session detail timeline -> event row -> JSON/details dropdown
```

---

## Current Problem

The current log experience is too flat for debugging agent/tool behavior. We need to answer questions like:

- Which tool was used?
- What input was sent?
- What output came back?
- How long did it take?
- Did it fail, timeout, retry, or get blocked?
- Which user/session/request produced it?
- Can we reload the full session later from DB?

---

## Data Model

Use a small SQL-backed persistence layer for sessions and events. If the project standardizes on Postgres/SQLite for app metadata, use that. If not, ClickHouse can temporarily store append-only event logs, but relational SQL is better for session metadata and UI lookups.

### `log_sessions`

```sql
CREATE TABLE log_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NULL,
  source TEXT NOT NULL,
  user_id TEXT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NULL
);
```

### `log_events`

```sql
CREATE TABLE log_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_event_id TEXT NULL,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NULL,
  duration_ms INTEGER NULL,
  status TEXT NOT NULL,
  input_json TEXT NULL,
  output_json TEXT NULL,
  error_json TEXT NULL,
  metadata_json TEXT NULL,
  FOREIGN KEY (session_id) REFERENCES log_sessions(id)
);
```

### `tool_calls`

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_namespace TEXT NULL,
  input_json TEXT NULL,
  output_json TEXT NULL,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP NULL,
  duration_ms INTEGER NULL,
  status TEXT NOT NULL,
  error_json TEXT NULL,
  FOREIGN KEY (session_id) REFERENCES log_sessions(id),
  FOREIGN KEY (event_id) REFERENCES log_events(id)
);
```

---

## Frontend UX Plan

### 1. Session list

Add a page/panel for stored sessions:

```text
Session title | source | status | start time | duration | event count | error count
```

Filters:

- status: running, completed, failed, cancelled
- source: chat, agent, backend job, market-data job
- date range
- contains tool name
- error-only

### 2. Session detail timeline

Each event row should show:

```text
[time] [level] [event_type] message       duration/status
```

Examples:

```text
12:41:02 INFO  tool_call Xacho.bash        353ms success
12:41:03 WARN  validation lint             failed
12:41:04 INFO  assistant_response          1.2s success
```

### 3. JSON dropdown/details panel

Each event/tool row should expand into tabs:

```text
Summary | Input | Output | Error | Metadata | Raw JSON
```

Requirements:

- pretty-printed JSON
- collapsible objects/arrays
- copy button
- redact known secrets/tokens
- truncate very large payloads, with "show more" or backend pagination
- show duration, timestamps, status, retry count, and tool namespace

Recommended component names:

```text
SessionLogPage
SessionTimeline
SessionEventRow
JsonDetailsDropdown
ToolCallDetails
LogLevelBadge
DurationBadge
```

---

## Backend API Plan

Add read APIs for the frontend:

```text
GET /api/log-sessions
GET /api/log-sessions/:sessionId
GET /api/log-sessions/:sessionId/events
GET /api/log-sessions/:sessionId/tool-calls
GET /api/log-events/:eventId
```

Add write APIs/internal services for producers:

```text
POST /internal/log-sessions
PATCH /internal/log-sessions/:sessionId
POST /internal/log-events
PATCH /internal/log-events/:eventId
POST /internal/tool-calls
PATCH /internal/tool-calls/:toolCallId
```

Internal write routes should require `INTERNAL_SERVICE_API_KEY` or equivalent service auth.

---

## Capture Contract

Every persisted event should follow this normalized shape:

```ts
type LogEvent = {
  id: string;
  sessionId: string;
  parentEventId?: string;
  eventType: 'message' | 'tool_call' | 'tool_result' | 'error' | 'system' | 'validation';
  level: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
};
```

Tool calls should include:

```ts
type ToolCallLog = {
  toolNamespace?: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  durationMs?: number;
  status: 'running' | 'success' | 'failed' | 'timeout' | 'blocked';
  error?: unknown;
};
```

---

## Security and Retention

Do not persist raw secrets. Add a redaction layer before writing JSON:

```text
api_key
access_token
refresh_token
authorization
cookie
password
secret
broker token
```

Retention policy:

- keep session metadata for long term
- keep full input/output JSON for 30-90 days by default
- allow manual pinning of important sessions
- optionally export old sessions to compressed archive storage

---

## Implementation Phases

### Phase 1 — Schema and service

- Add SQL migrations for `log_sessions`, `log_events`, `tool_calls`.
- Add backend repository/service for session/event writes and reads.
- Add redaction utility for JSON payloads.
- Add duration/status helpers.

### Phase 2 — Backend APIs

- Add session list/detail endpoints.
- Add internal append/update endpoints.
- Add pagination for events and large JSON payloads.
- Add tests for create session, append tool call, failure event, redaction.

### Phase 3 — Frontend viewer

- Add session list page.
- Add session timeline.
- Add expandable JSON dropdown with tabs.
- Add filters and error-only mode.
- Add copy-to-clipboard for JSON blocks.

### Phase 4 — Instrumentation

- Wire backend jobs and agent/tool wrappers to emit session events.
- Capture tool input/output/time/status.
- Capture validation/build/test results as events.
- Add trace/session ID propagation through API calls.

### Phase 5 — Hardening

- Add retention cleanup job.
- Add payload size limits.
- Add secret redaction tests.
- Add UI performance guardrails for large sessions.

---

## Acceptance Criteria

- A completed session can be reopened from SQL storage.
- Tool calls show tool name, input JSON, output JSON, duration, status, and error details.
- Large JSON output does not freeze the frontend.
- Secrets are redacted before persistence.
- Session list supports filtering by status, source, date, and tool name.
- Backend tests cover write/read/redaction paths.
- Frontend typecheck and build pass.

---

## Open Questions

- Should canonical session storage be Postgres/SQLite, or should ClickHouse be used initially because it already exists in Docker?
- Should raw tool output be stored fully, truncated, or stored separately with blob/archive references?
- Should this log viewer live under admin/dev routes only?
- Which producers should be instrumented first: local agent tools, backend jobs, market-data ingestors, or frontend actions?
