import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentJobRecord } from "./agentTypes.js";
import type { AgentTerminalSession } from "./agentTerminalTypes.js";
import type { DashboardEvent } from "./dashboardTypes.js";

let db: DatabaseSync | undefined;
let dbFile: string | undefined;
let pendingEvents: DashboardEvent[] = [];
let flushScheduled = false;

export function initDashboardStore(filePath: string): void {
  if (db) return;
  dbFile = filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
CREATE TABLE IF NOT EXISTS log_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NULL,
  source TEXT NOT NULL,
  user_id TEXT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NULL
);
CREATE TABLE IF NOT EXISTS log_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_event_id TEXT NULL,
  event_type TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  duration_ms INTEGER NULL,
  status TEXT NOT NULL,
  input_json TEXT NULL,
  output_json TEXT NULL,
  error_json TEXT NULL,
  metadata_json TEXT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_namespace TEXT NULL,
  input_json TEXT NULL,
  output_json TEXT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NULL,
  duration_ms INTEGER NULL,
  status TEXT NOT NULL,
  error_json TEXT NULL
);
CREATE TABLE IF NOT EXISTS agent_jobs (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NULL,
  workspace_id TEXT NULL,
  workspace_root TEXT NULL,
  agent TEXT NULL,
  repository TEXT NULL,
  title TEXT NULL,
  state TEXT NULL,
  idempotency_key TEXT NULL,
  launch_phase TEXT NULL,
  launch_error TEXT NULL,
  terminal_backend TEXT NULL,
  terminal_session TEXT NULL,
  terminal_pane_id TEXT NULL,
  worktree_dir TEXT NULL,
  branch_name TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT NULL,
  idle_deadline_at TEXT NULL,
  metadata_json TEXT NULL
);
CREATE TABLE IF NOT EXISTS agent_terminal_sessions (
  id TEXT PRIMARY KEY,
  job_id TEXT NULL,
  backend TEXT NOT NULL,
  session_name TEXT NULL,
  pane_id TEXT NULL,
  tab_id INTEGER NULL,
  tab_name TEXT NULL,
  title TEXT NULL,
  command TEXT NULL,
  cwd TEXT NULL,
  attach_command TEXT NULL,
  watch_command TEXT NULL,
  tail_command TEXT NULL,
  source TEXT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_events_session_started ON log_events(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_started ON tool_calls(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_task_id ON agent_jobs(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_state ON agent_jobs(state);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_updated_at ON agent_jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_terminal_sessions_job ON agent_terminal_sessions(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_terminal_sessions_backend ON agent_terminal_sessions(backend);
`);
  ensureAgentJobColumn("idempotency_key", "TEXT NULL");
  ensureAgentJobColumn("launch_phase", "TEXT NULL");
  ensureAgentJobColumn("launch_error", "TEXT NULL");
}

export function getDashboardStorePath(): string | undefined {
  return dbFile;
}

export function persistDashboardEvent(event: DashboardEvent): void {
  if (!db) return;
  pendingEvents.push(event);
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(flushDashboardEvents);
  }
}

function flushDashboardEvents(): void {
  flushScheduled = false;
  const currentDb = db;
  if (!currentDb || pendingEvents.length === 0) return;
  const events = pendingEvents;
  pendingEvents = [];
  try {
    currentDb.exec("BEGIN");
    for (const event of events) persistDashboardEventNow(currentDb, event);
    currentDb.exec("COMMIT");
  } catch {
    try { currentDb.exec("ROLLBACK"); } catch {}
  }
}

function persistDashboardEventNow(store: DatabaseSync, event: DashboardEvent): void {
  try {
    const sessionId = event.sessionId || event.workspaceId || "default";
    const level = event.level || (event.kind.includes("error") ? "error" : "info");
    const status = event.kind.endsWith(":start") ? "running" : event.kind.includes("error") ? "failed" : "success";
    const message = typeof event.payload?.message === "string" ? event.payload.message : event.toolName ? event.kind + " " + event.toolName : event.kind;
    const inputJson = jsonOrNull(event.payload?.input);
    const outputJson = jsonOrNull(event.payload?.output ?? event.payload?.outputSummary);
    const errorJson = jsonOrNull(event.payload?.error ?? (event.kind.includes("error") ? event.payload : undefined));
    const metadataJson = jsonOrNull({ workspaceId: event.workspaceId, surface: event.surface, toolName: event.toolName, payload: event.payload });

    store.prepare("INSERT INTO log_sessions (id, title, source, user_id, started_at, ended_at, status, metadata_json) VALUES (?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, metadata_json=excluded.metadata_json").run(
      sessionId,
      sessionId === "default" ? "Default session" : sessionId,
      event.surface || "dashboard",
      null,
      event.ts,
      status === "failed" ? "failed" : "running",
      jsonOrNull({ workspaceId: event.workspaceId, surface: event.surface })
    );

    store.prepare("INSERT OR REPLACE INTO log_events (id, session_id, parent_event_id, event_type, level, message, started_at, ended_at, duration_ms, status, input_json, output_json, error_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      String(event.id),
      sessionId,
      typeof event.payload?.parentEventId === "string" ? event.payload.parentEventId : null,
      event.kind,
      level,
      message,
      event.ts,
      event.durationMs != null ? event.ts : null,
      event.durationMs ?? null,
      status,
      inputJson,
      outputJson,
      errorJson,
      metadataJson
    );

    if (event.kind.startsWith("tool:") && event.toolName) {
      persistToolCall(event, sessionId, status, inputJson, outputJson, errorJson);
      persistAgentToolOutput(event);
    }
  } catch {
    // Dashboard persistence is best-effort.
  }
}

export function persistAgentJobSnapshot(job: AgentJobRecord): void {
  if (!db) return;
  const payload: Record<string, unknown> = {
    job_id: job.jobId,
    task_id: job.taskId,
    workspace_id: job.workspaceId,
    workspace_root: job.workspaceRoot,
    agent: job.agent,
    repository: job.repository,
    title: job.title,
    state: job.state,
    idempotency_key: job.idempotencyKey,
    request_hash: job.requestHash,
    launch: job.launch,
    terminal: job.terminal,
    worktree_dir: job.groundcrew?.worktreeDir,
    branch_name: job.groundcrew?.branchName,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    deadline_at: job.watchdog?.deadlineAt,
    idle_deadline_at: job.watchdog?.idleDeadlineAt
  };
  upsertAgentJob(payload, new Date().toISOString());
  if (job.terminal) upsertAgentTerminalSession(terminalPayloadToSession(payload, job.terminal as unknown as Record<string, unknown>), new Date().toISOString());
}

export function persistAgentTerminalSessions(sessions: AgentTerminalSession[], jobId?: string): void {
  if (!db) return;
  const ts = new Date().toISOString();
  for (const session of sessions) upsertAgentTerminalSession({ ...session, job_id: jobId }, ts);
}

export function listStoredSessions(limit = 100): unknown[] {
  flushDashboardEvents();
  if (!db) return [];
  return db.prepare("SELECT s.*, (SELECT COUNT(*) FROM log_events e WHERE e.session_id = s.id) AS event_count, (SELECT COUNT(*) FROM tool_calls t WHERE t.session_id = s.id) AS tool_call_count, (SELECT COUNT(*) FROM log_events e WHERE e.session_id = s.id AND e.level = 'error') AS error_count FROM log_sessions s ORDER BY started_at DESC LIMIT ?").all(limit);
}

export function listStoredSessionEvents(sessionId: string, limit = 500): unknown[] {
  flushDashboardEvents();
  if (!db) return [];
  return db.prepare("SELECT * FROM log_events WHERE session_id = ? ORDER BY started_at ASC LIMIT ?").all(sessionId, limit);
}

export function listStoredToolCalls(sessionId: string, limit = 500): unknown[] {
  flushDashboardEvents();
  if (!db) return [];
  return db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY started_at ASC LIMIT ?").all(sessionId, limit);
}

export function listStoredAgentJobs(limit = 100): unknown[] {
  if (!db) return [];
  return db.prepare("SELECT * FROM agent_jobs ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function listStoredAgentTerminalSessions(limit = 500): unknown[] {
  if (!db) return [];
  return db.prepare("SELECT * FROM agent_terminal_sessions ORDER BY updated_at DESC LIMIT ?").all(limit);
}

export function getStoredLogEvent(eventId: string): unknown {
  if (!db) return undefined;
  return db.prepare("SELECT * FROM log_events WHERE id = ?").get(eventId);
}

function persistToolCall(event: DashboardEvent, sessionId: string, status: string, inputJson: string | null, outputJson: string | null, errorJson: string | null): void {
  const safeToolName = event.toolName ?? "unknown";
  const callId = typeof event.payload?.toolCallId === "string" ? event.payload.toolCallId : sessionId + ":" + safeToolName + ":" + String(event.id);
  const namespace = namespaceForTool(safeToolName);
  if (event.kind === "tool:start") {
    db?.prepare("INSERT OR REPLACE INTO tool_calls (id, session_id, event_id, tool_name, tool_namespace, input_json, output_json, started_at, ended_at, duration_ms, status, error_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, 'running', NULL)").run(callId, sessionId, String(event.id), safeToolName, namespace, inputJson, event.ts);
    return;
  }
  const existing = db?.prepare("SELECT id FROM tool_calls WHERE id = ?").get(callId) as { id?: string } | undefined;
  if (existing?.id) {
    db?.prepare("UPDATE tool_calls SET event_id = ?, output_json = COALESCE(?, output_json), ended_at = ?, duration_ms = ?, status = ?, error_json = ? WHERE id = ?").run(String(event.id), outputJson, event.ts, event.durationMs ?? null, status, errorJson, callId);
    return;
  }
  db?.prepare("INSERT INTO tool_calls (id, session_id, event_id, tool_name, tool_namespace, input_json, output_json, started_at, ended_at, duration_ms, status, error_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(callId, sessionId, String(event.id), safeToolName, namespace, inputJson, outputJson, event.ts, event.ts, event.durationMs ?? null, status, errorJson);
}

function persistAgentToolOutput(event: DashboardEvent): void {
  if (event.kind !== "tool:end") return;
  if (!event.toolName?.startsWith("agent_")) return;
  const output = asRecord(event.payload?.output);
  if (!output) return;

  if (stringField(output, "job_id") || stringField(output, "task_id")) {
    upsertAgentJob(output, event.ts);
    const terminal = asRecord(output.terminal);
    if (terminal) upsertAgentTerminalSession(terminalPayloadToSession(output, terminal), event.ts);
    else if (stringField(output, "source") || stringField(output, "backend")) upsertAgentTerminalSession(terminalPayloadToSession(output, output), event.ts);
  }

  const sessions = Array.isArray(output.sessions) ? output.sessions : [];
  for (const item of sessions) {
    const session = asRecord(item);
    if (session) upsertAgentTerminalSession(session, event.ts);
  }
}

function upsertAgentJob(payload: Record<string, unknown>, eventTs: string): void {
  const jobId = stringField(payload, "job_id") ?? stringField(payload, "jobId");
  if (!jobId) return;
  const terminal = asRecord(payload.terminal);
  db?.prepare(`INSERT INTO agent_jobs (
    job_id, task_id, workspace_id, workspace_root, agent, repository, title, state,
    idempotency_key, launch_phase, launch_error,
    terminal_backend, terminal_session, terminal_pane_id, worktree_dir, branch_name,
    created_at, updated_at, deadline_at, idle_deadline_at, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(job_id) DO UPDATE SET
    task_id=COALESCE(excluded.task_id, agent_jobs.task_id),
    workspace_id=COALESCE(excluded.workspace_id, agent_jobs.workspace_id),
    workspace_root=COALESCE(excluded.workspace_root, agent_jobs.workspace_root),
    agent=COALESCE(excluded.agent, agent_jobs.agent),
    repository=COALESCE(excluded.repository, agent_jobs.repository),
    title=COALESCE(excluded.title, agent_jobs.title),
    state=COALESCE(excluded.state, agent_jobs.state),
    idempotency_key=COALESCE(excluded.idempotency_key, agent_jobs.idempotency_key),
    launch_phase=COALESCE(excluded.launch_phase, agent_jobs.launch_phase),
    launch_error=COALESCE(excluded.launch_error, agent_jobs.launch_error),
    terminal_backend=COALESCE(excluded.terminal_backend, agent_jobs.terminal_backend),
    terminal_session=COALESCE(excluded.terminal_session, agent_jobs.terminal_session),
    terminal_pane_id=COALESCE(excluded.terminal_pane_id, agent_jobs.terminal_pane_id),
    worktree_dir=COALESCE(excluded.worktree_dir, agent_jobs.worktree_dir),
    branch_name=COALESCE(excluded.branch_name, agent_jobs.branch_name),
    updated_at=excluded.updated_at,
    deadline_at=COALESCE(excluded.deadline_at, agent_jobs.deadline_at),
    idle_deadline_at=COALESCE(excluded.idle_deadline_at, agent_jobs.idle_deadline_at),
    metadata_json=excluded.metadata_json`).run(
    jobId,
    stringField(payload, "task_id") ?? stringField(payload, "taskId"),
    stringField(payload, "workspace_id") ?? stringField(payload, "workspaceId"),
    stringField(payload, "workspace_root") ?? stringField(payload, "workspaceRoot"),
    stringField(payload, "agent"),
    stringField(payload, "repository"),
    stringField(payload, "title"),
    stringField(payload, "state"),
    stringField(payload, "idempotency_key") ?? stringField(payload, "idempotencyKey"),
    stringField(payload, "launch_phase") ?? stringField(asRecord(payload.launch), "phase"),
    stringField(payload, "launch_error") ?? stringField(asRecord(payload.launch), "error"),
    stringField(terminal, "backend"),
    stringField(terminal, "sessionName") ?? stringField(terminal, "session_name"),
    stringField(terminal, "paneId") ?? stringField(terminal, "pane_id"),
    stringField(payload, "worktree_dir") ?? stringField(payload, "worktreeDir"),
    stringField(payload, "branch_name") ?? stringField(payload, "branchName"),
    stringField(payload, "created_at") ?? stringField(payload, "createdAt") ?? eventTs,
    stringField(payload, "updated_at") ?? stringField(payload, "updatedAt") ?? eventTs,
    stringField(payload, "deadline_at") ?? stringField(payload, "deadlineAt"),
    stringField(payload, "idle_deadline_at") ?? stringField(payload, "idleDeadlineAt"),
    jsonOrNull(payload)
  );
}

function terminalPayloadToSession(parent: Record<string, unknown>, terminal: Record<string, unknown>): Record<string, unknown> {
  return {
    job_id: stringField(parent, "job_id") ?? stringField(parent, "jobId"),
    backend: stringField(terminal, "backend") ?? stringField(parent, "source") ?? stringField(parent, "backend"),
    sessionName: stringField(terminal, "sessionName") ?? stringField(terminal, "session_name") ?? stringField(parent, "session_name"),
    paneId: stringField(terminal, "paneId") ?? stringField(terminal, "pane_id") ?? stringField(parent, "pane_id"),
    tabId: numberField(terminal, "tabId") ?? numberField(terminal, "tab_id"),
    tabName: stringField(terminal, "tabName") ?? stringField(terminal, "tab_name"),
    title: stringField(parent, "title") ?? stringField(terminal, "paneTitle") ?? stringField(terminal, "title"),
    command: stringField(terminal, "paneCommand") ?? stringField(terminal, "command"),
    cwd: stringField(terminal, "paneCwd") ?? stringField(terminal, "cwd") ?? stringField(parent, "worktree_dir"),
    attachCommand: stringField(terminal, "attachCommand") ?? stringField(parent, "attach_hint"),
    watchCommand: stringField(terminal, "watchCommand") ?? stringField(parent, "watch_hint"),
    tailCommand: stringField(terminal, "tailCommand") ?? stringField(parent, "tail_hint"),
    source: stringField(terminal, "source") ?? stringField(parent, "source") ?? "tool"
  };
}

function upsertAgentTerminalSession(payload: Record<string, unknown>, eventTs: string): void {
  const backend = stringField(payload, "backend");
  if (!backend || backend === "none") return;
  const jobId = stringField(payload, "job_id") ?? stringField(payload, "jobId");
  const sessionName = stringField(payload, "sessionName") ?? stringField(payload, "session_name");
  const paneId = stringField(payload, "paneId") ?? stringField(payload, "pane_id");
  const cwd = stringField(payload, "cwd");
  const id = [jobId ?? "external", backend, sessionName ?? "", paneId ?? "", cwd ?? ""].join(":");
  db?.prepare(`INSERT INTO agent_terminal_sessions (
    id, job_id, backend, session_name, pane_id, tab_id, tab_name, title, command, cwd,
    attach_command, watch_command, tail_command, source, updated_at, metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    job_id=COALESCE(excluded.job_id, agent_terminal_sessions.job_id),
    session_name=COALESCE(excluded.session_name, agent_terminal_sessions.session_name),
    pane_id=COALESCE(excluded.pane_id, agent_terminal_sessions.pane_id),
    tab_id=COALESCE(excluded.tab_id, agent_terminal_sessions.tab_id),
    tab_name=COALESCE(excluded.tab_name, agent_terminal_sessions.tab_name),
    title=COALESCE(excluded.title, agent_terminal_sessions.title),
    command=COALESCE(excluded.command, agent_terminal_sessions.command),
    cwd=COALESCE(excluded.cwd, agent_terminal_sessions.cwd),
    attach_command=COALESCE(excluded.attach_command, agent_terminal_sessions.attach_command),
    watch_command=COALESCE(excluded.watch_command, agent_terminal_sessions.watch_command),
    tail_command=COALESCE(excluded.tail_command, agent_terminal_sessions.tail_command),
    source=COALESCE(excluded.source, agent_terminal_sessions.source),
    updated_at=excluded.updated_at,
    metadata_json=excluded.metadata_json`).run(
    id,
    jobId,
    backend,
    sessionName,
    paneId,
    numberField(payload, "tabId") ?? numberField(payload, "tab_id"),
    stringField(payload, "tabName") ?? stringField(payload, "tab_name"),
    stringField(payload, "title"),
    stringField(payload, "command"),
    cwd,
    stringField(payload, "attachCommand") ?? stringField(payload, "attach_command"),
    stringField(payload, "watchCommand") ?? stringField(payload, "watch_command"),
    stringField(payload, "tailCommand") ?? stringField(payload, "tail_command"),
    stringField(payload, "source"),
    eventTs,
    jsonOrNull(payload)
  );
}

function namespaceForTool(toolName: string | undefined): string | null {
  if (!toolName) return null;
  const dot = toolName.indexOf(".");
  return dot > 0 ? toolName.slice(0, dot) : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonOrNull(value: unknown): string | null {
  if (value == null) return null;
  try { return JSON.stringify(value); } catch { return JSON.stringify({ unserializable: true }); }
}

function ensureAgentJobColumn(name: string, ddl: string): void {
  try {
    db?.exec(`ALTER TABLE agent_jobs ADD COLUMN ${name} ${ddl}`);
  } catch {
    // Existing DBs may already have the column.
  }
}
