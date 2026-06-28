import type { LeastConfig } from "./config.js";
import type { DashboardState, ServerInfo, RuntimeInfo, ConnectionInfo, ToolLiveStats, ToolCallEvent, HookStats, LogEvent, GitDashboardState, DashboardEvent, HookEventRecord } from "./dashboardTypes.js";
import { getRecentDashboardEvents, getDashboardEventsSince } from "./dashboardEvents.js";
import { listStoredAgentJobs, listStoredAgentTerminalSessions } from "./dashboardStore.js";
import { getLeastPerfSnapshot, getGainSnapshot, type PerfWindowName } from "./perf.js";
import { gitStatus } from "./gitOps.js";

const DEFAULT_ROOT = "X:\\least";
let _config: LeastConfig | undefined;

let _startedAt = new Date().toISOString();
let _connectionInfos: ConnectionInfo[] = [];
let _hookEvents: HookEventRecord[] = [];
let _logEvents: LogEvent[] = [];
let _gitState: GitDashboardState = { changedFiles: 0, staged: 0, unstaged: 0, untracked: 0, available: false };
let _activeDashboardClients = 0;
let _dashboardStreaming = false;

export function setDashboardConfig(config: LeastConfig): void {
  _config = config;
}

export function setDashboardStarted(): void {
  _startedAt = new Date().toISOString();
}

export function updateConnectionInfo(info: Partial<ConnectionInfo> & { id: string }): void {
  const existing = _connectionInfos.find((c) => c.id === info.id);
  if (existing) {
    Object.assign(existing, info);
  } else {
    _connectionInfos.push(info as ConnectionInfo);
  }
}

export function removeConnection(id: string): void {
  const idx = _connectionInfos.findIndex((c) => c.id === id);
  if (idx >= 0) {
    _connectionInfos[idx] = { ..._connectionInfos[idx], closed: true };
  }
}

export function recordHookEvent(hook: HookEventRecord): void {
  _hookEvents.push(hook);
  if (_hookEvents.length > 1000) _hookEvents = _hookEvents.slice(-1000);
}

export function getHookStats(): HookStats {
  const total = _hookEvents.length;
  let allows = 0;
  let denials = 0;
  let errors = 0;
  let untrusted = 0;
  const byEvent: Record<string, number> = {};
  let totalDuration = 0;
  let durationCount = 0;

  for (const h of _hookEvents) {
    if (h.decision === "allow") allows++;
    else if (h.decision === "deny") denials++;
    else if (h.decision === "error") errors++;
    if (!h.trusted) untrusted++;
    byEvent[h.event] = (byEvent[h.event] ?? 0) + 1;
    if (h.durationMs != null) {
      totalDuration += h.durationMs;
      durationCount++;
    }
  }

  // Compute real p95
  const durations = _hookEvents
    .filter((h): h is HookEventRecord & { durationMs: number } => h.durationMs != null)
    .map((h) => h.durationMs)
    .sort((a, b) => a - b);
  const p95Index = Math.floor(durations.length * 0.95);
  const p95DurationMs = durations.length > 0 ? durations[Math.min(p95Index, durations.length - 1)] : 0;

  return {
    total,
    allows,
    denials,
    errors,
    untrustedSkips: untrusted,
    p95DurationMs,
    byEvent,
  };
}

export function recordLog(log: LogEvent): void {
  _logEvents.push(log);
  if (_logEvents.length > 1000) _logEvents = _logEvents.slice(-1000);
}

export function setDashboardClientCount(n: number): void {
  _activeDashboardClients = n;
}

export function setDashboardStreaming(v: boolean): void {
  _dashboardStreaming = v;
}

export async function updateGitSnapshot(config: LeastConfig): Promise<void> {
  try {
    const { PathGuard, WorkspaceManager } = await import("./guard.js");
    const guard = new PathGuard(config);
    const wm = new (WorkspaceManager as any)(config);
    const ws = wm.defaultWorkspace?.() ?? { id: "default", root: config.defaultRoot };

    const status = await gitStatus(config, ws, guard, undefined, { untrackedMode: "all" });
    const lines = status.split("\n").filter(Boolean);
    const branchLine = lines.find((l) => l.startsWith("##"));
    const branch = branchLine?.replace(/^##\s*/, "").split("...")[0];
    const entries = lines.filter((l) => /^[MADRCU?!\s]{2}/.test(l));
    const staged = entries.filter((l) => /^[MADRUC]/.test(l)).length;
    const unstaged = entries.filter((l) => /^\s[MADRUC?]/.test(l)).length;
    const untracked = entries.filter((l) => /^\?\?/.test(l)).length;

    _gitState = {
      branch,
      status: status.slice(0, 2000),
      changedFiles: entries.length,
      staged,
      unstaged,
      untracked,
      lastSnapshotAt: new Date().toISOString(),
      available: true,
    };
  } catch (error) {
    _gitState = {
      changedFiles: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRuntimeInfo(): RuntimeInfo {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.floor(process.uptime()),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    activeDashboardClients: _activeDashboardClients,
    dashboardStreaming: _dashboardStreaming,
  };
}

export function buildDashboardSnapshot(
  eventLimit = 200,
  window: PerfWindowName = "session"
): DashboardState {
  const perf = getLeastPerfSnapshot(window);
  const gain = getGainSnapshot(window);
  const rawPerfTools = (perf.tools as Array<Record<string, unknown>>) ?? [];

  const tools: ToolLiveStats[] = rawPerfTools.map((t) => ({
    tool: String(t.tool ?? ""),
    calls: Number(t.calls ?? 0),
    errors: Number(t.errors ?? 0),
    timeouts: Number(t.timeouts ?? 0),
    partials: Number(t.partials ?? 0),
    avgMs: Number(t.avg_ms ?? 0),
    p95Ms: Number(t.p95_ms ?? 0),
    maxMs: Number(t.max_ms ?? 0),
    avgOutputBytes: Number(t.avg_output_bytes ?? 0),
    avgRawBytes: Number(t.avg_raw_bytes ?? 0),
    avgVisibleBytes: Number(t.avg_model_visible_bytes ?? 0),
    savedBytes: Number(t.total_saved_bytes ?? 0),
    compactions: Number(t.compactions ?? 0),
    retrievals: Number(t.retrievals ?? 0),
    backends: Array.isArray(t.backends) ? t.backends.map(String) : [],
  }));

  const recentEvents = getRecentDashboardEvents(eventLimit);
  const recentToolCalls: ToolCallEvent[] = recentEvents
    .filter((e): e is DashboardEvent & { kind: "tool:start" | "tool:end" | "tool:error" } =>
      e.kind === "tool:start" || e.kind === "tool:end" || e.kind === "tool:error"
    )
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      toolName: e.toolName ?? "unknown",
      workspaceId: e.workspaceId,
      sessionId: e.sessionId,
      status: e.kind === "tool:error" ? "error" : e.kind === "tool:end" ? "ok" : "running" as const,
      durationMs: e.durationMs,
      error: e.payload?.message as string | undefined,
      inputSummary: e.kind === "tool:start" ? (e.payload as Record<string, unknown> | undefined) : undefined,
    }));

  const logs: LogEvent[] = _logEvents.slice(-100);
  const connections = _connectionInfos.filter((c) => !c.closed);
  const hooks = getHookStats();
  const agentJobs = listStoredAgentJobs(100);
  const agentTerminalSessions = listStoredAgentTerminalSessions(500);

  return {
    server: {
      name: "Least",
      version: "0.31.0",
      startedAt: _startedAt,
      defaultRoot: _config?.defaultRoot ?? DEFAULT_ROOT,
      dashboardPort: _config?.dashboardPort ?? 8922,
      yoloMode: _config?.yoloMode ?? false,
    },
    runtime: buildRuntimeInfo(),
    connections,
    tools,
    recentToolCalls,
    hooks,
    git: _gitState,
    agents: {
      jobs: agentJobs,
      terminalSessions: agentTerminalSessions,
      jobCount: agentJobs.length,
      terminalSessionCount: agentTerminalSessions.length,
    },
    logs,
    perf,
    gain,
  };
}
