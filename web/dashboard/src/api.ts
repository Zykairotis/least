export interface DashboardSnapshot {
  ok: boolean;
  server: {
    name: string;
    version: string;
    startedAt: string;
    defaultRoot: string;
    dashboardPort: number;
    yoloMode: boolean;
  };
  runtime: {
    pid: number;
    node: string;
    platform: string;
    arch: string;
    uptimeSec: number;
    memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
    activeDashboardClients: number;
    dashboardStreaming: boolean;
  };
  connections: Array<{
    id: string;
    surface: string;
    authMode: string;
    createdAt: string;
    lastSeenAt: string;
    requestCount: number;
    closed?: boolean;
  }>;
  tools: Array<{
    tool: string;
    calls: number;
    errors: number;
    timeouts: number;
    partials: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
    avgOutputBytes: number;
    avgRawBytes: number;
    avgVisibleBytes: number;
    savedBytes: number;
    compactions: number;
    retrievals: number;
    backends: string[];
  }>;
  recentToolCalls: Array<{
    id: number;
    ts: string;
    toolName: string;
    status: "running" | "ok" | "error";
    durationMs?: number;
    error?: string;
  }>;
  hooks: {
    total: number;
    allows: number;
    denials: number;
    errors: number;
    untrustedSkips: number;
    p95DurationMs: number;
    byEvent: Record<string, number>;
  };
  git: {
    branch?: string;
    status?: string;
    changedFiles: number;
    staged: number;
    unstaged: number;
    untracked: number;
    lastSnapshotAt?: string;
    error?: string;
    available: boolean;
  };
  agents: {
    jobs: AgentJobRow[];
    terminalSessions: AgentTerminalSessionRow[];
    jobCount: number;
    terminalSessionCount: number;
  };
  logs: Array<{
    id: number;
    ts: string;
    kind: string;
    level: string;
    message: string;
    toolName?: string;
  }>;
  perf: Record<string, unknown>;
  gain: Record<string, unknown>;
}

export interface DashboardEvent {
  id: number;
  ts: string;
  kind: string;
  workspaceId?: string;
  sessionId?: string;
  surface?: string;
  toolName?: string;
  level?: "debug" | "info" | "warn" | "error";
  durationMs?: number;
  payload?: Record<string, unknown>;
}

export interface AgentJobRow {
  job_id: string;
  task_id?: string | null;
  workspace_id?: string | null;
  workspace_root?: string | null;
  agent?: string | null;
  repository?: string | null;
  title?: string | null;
  state?: string | null;
  idempotency_key?: string | null;
  launch_phase?: string | null;
  launch_error?: string | null;
  terminal_backend?: string | null;
  terminal_session?: string | null;
  terminal_pane_id?: string | null;
  worktree_dir?: string | null;
  branch_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  deadline_at?: string | null;
  idle_deadline_at?: string | null;
  metadata_json?: string | null;
}

export interface AgentTerminalSessionRow {
  id: string;
  job_id?: string | null;
  backend: string;
  session_name?: string | null;
  pane_id?: string | null;
  tab_id?: number | null;
  tab_name?: string | null;
  title?: string | null;
  command?: string | null;
  cwd?: string | null;
  attach_command?: string | null;
  watch_command?: string | null;
  tail_command?: string | null;
  source?: string | null;
  updated_at?: string | null;
  metadata_json?: string | null;
}

export async function fetchSnapshot(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/snapshot");
  return res.json();
}

export function connectSSE(
  onEvent: (event: DashboardEvent) => void,
  onSnapshot: (snapshot: DashboardSnapshot) => void,
  onError?: (err: Event) => void
): EventSource {
  const es = new EventSource("/api/events");

  es.addEventListener("snapshot", (msg: MessageEvent) => {
    try {
      const data = JSON.parse(msg.data);
      onSnapshot(data);
    } catch {
      // ignore parse errors
    }
  });

  es.addEventListener("dashboard", (msg: MessageEvent) => {
    try {
      const data = JSON.parse(msg.data);
      onEvent(data);
    } catch {
      // ignore parse errors
    }
  });

  es.onerror = (err: Event) => {
    onError?.(err);
  };

  return es;
}
