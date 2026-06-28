export interface DashboardSnapshot {
  ok: boolean;
  server: ServerInfo;
  runtime: RuntimeInfo;
  connections: ConnectionInfo[];
  tools: ToolLiveStats[];
  recentToolCalls: ToolCallEvent[];
  hooks: HookStats;
  git: GitDashboardState;
  logs: LogEvent[];
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

export interface ServerInfo {
  name: string;
  version: string;
  startedAt: string;
  defaultRoot: string;
  dashboardPort: number;
  yoloMode: boolean;
}

export interface RuntimeInfo {
  pid: number;
  node: string;
  platform: string;
  arch: string;
  uptimeSec: number;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  activeDashboardClients: number;
  dashboardStreaming: boolean;
}

export interface ConnectionInfo {
  id: string;
  surface: string;
  authMode: string;
  createdAt: string;
  lastSeenAt: string;
  requestCount: number;
  closed?: boolean;
}

export interface ToolLiveStats {
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
  lastSeen?: string;
}

export interface ToolCallEvent {
  id: number;
  ts: string;
  toolName: string;
  workspaceId?: string;
  sessionId?: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  error?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: { rawBytes?: number; visibleBytes?: number; structuredBytes?: number; compacted?: boolean; retrievalKeyPresent?: boolean };
}

export interface HookStats {
  total: number;
  allows: number;
  denials: number;
  errors: number;
  untrustedSkips: number;
  p95DurationMs: number;
  byEvent: Record<string, number>;
}

export interface GitDashboardState {
  branch?: string;
  status?: string;
  changedFiles: number;
  staged: number;
  unstaged: number;
  untracked: number;
  lastSnapshotAt?: string;
  error?: string;
  available: boolean;
}

export interface LogEvent {
  id: number;
  ts: string;
  kind: string;
  level: string;
  message: string;
  toolName?: string;
  workspaceId?: string;
}
