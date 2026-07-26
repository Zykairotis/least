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

export type DashboardEventLevel = "debug" | "info" | "warn" | "error";

export interface DashboardEvent {
  id: number;
  ts: string;
  kind: DashboardEventKind;
  workspaceId?: string;
  sessionId?: string;
  surface?: "chatgpt" | "grok" | "openai" | "dashboard";
  toolName?: string;
  level?: DashboardEventLevel;
  durationMs?: number;
  payload?: Record<string, unknown>;
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
  outputSummary?: {
    rawBytes?: number;
    visibleBytes?: number;
    structuredBytes?: number;
    compacted?: boolean;
    retrievalKeyPresent?: boolean;
  };
}

export interface ConnectionInfo {
  id: string;
  surface: "chatgpt" | "grok" | "openai" | "dashboard";
  authMode: string;
  createdAt: string;
  lastSeenAt: string;
  requestCount: number;
  closed?: boolean;
}

export interface HookEventRecord {
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

export interface LogEvent {
  id: number;
  ts: string;
  kind: DashboardEventKind;
  level: DashboardEventLevel;
  message: string;
  toolName?: string;
  workspaceId?: string;
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
  memory: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  activeDashboardClients: number;
  dashboardStreaming: boolean;
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

export interface AgentDashboardState {
  jobs: unknown[];
  terminalSessions: unknown[];
  jobCount: number;
  terminalSessionCount: number;
}

export interface DashboardState {
  server: ServerInfo;
  runtime: RuntimeInfo;
  connections: ConnectionInfo[];
  tools: ToolLiveStats[];
  recentToolCalls: ToolCallEvent[];
  hooks: HookStats;
  /** Recent individual hook executions for the Hooks panel. */
  recentHooks: HookEventRecord[];
  git: GitDashboardState;
  agents: AgentDashboardState;
  logs: LogEvent[];
  perf: Record<string, unknown>;
  gain: Record<string, unknown>;
  /** Event stream meta for clients. */
  stream?: {
    latestEventId: number;
    eventCount: number;
  };
}
