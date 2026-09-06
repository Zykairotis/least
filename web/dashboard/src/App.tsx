import { useMemo, useState } from "react";
import { RefreshCw, Radio, AlertTriangle } from "lucide-react";
import { useLiveDashboard } from "./useLiveDashboard.ts";
import { Shell, type Section } from "./components/Shell.tsx";
import { MetricCard, EmptyState } from "./components/MetricCard.tsx";
import { ToolTable } from "./components/ToolTable.tsx";
import { Charts } from "./components/Charts.tsx";
import { EventLog } from "./components/EventLog.tsx";
import { HooksPanel } from "./components/HooksPanel.tsx";
import { ConnectionsPanel } from "./components/ConnectionsPanel.tsx";
import { GitPanel } from "./components/GitPanel.tsx";
import { RuntimePanel } from "./components/RuntimePanel.tsx";
import { TimelinePanel } from "./components/TimelinePanel.tsx";
import { SessionsPanel } from "./components/SessionsPanel.tsx";
import { AgentsPanel } from "./components/AgentsPanel.tsx";
import { SettingsPanel } from "./components/SettingsPanel.tsx";
import { pairToolCalls } from "./usePairedToolCalls.ts";

export default function App() {
  const [section, setSection] = useState<Section>("overview");
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(5000);
  const {
    snapshot,
    events,
    connected,
    streaming,
    lastEventTime,
    lastHeartbeatAt,
    error,
    eventRate,
    refreshSnapshot,
    historyDays,
  } = useLiveDashboard(refreshIntervalMs);

  const totals = useMemo(() => {
    const t = snapshot?.perf?.totals as { calls?: number; errors?: number } | undefined;
    return {
      calls: t?.calls ?? snapshot?.tools?.reduce((s, x) => s + x.calls, 0) ?? 0,
      errors: t?.errors ?? snapshot?.tools?.reduce((s, x) => s + x.errors, 0) ?? 0,
    };
  }, [snapshot]);

  const errorRate = totals.calls > 0 ? ((totals.errors / totals.calls) * 100).toFixed(1) : "0.0";

  const runningTools = useMemo(() => {
    return pairToolCalls(events)
      .filter((item): item is Extract<typeof item, { status: string }> => "status" in item && item.status === "running")
      .slice(0, 8);
  }, [events]);

  const liveItems = useMemo(() => {
    return pairToolCalls(events).slice(0, 25);
  }, [events]);

  const badges = useMemo(() => {
    const hookDenials = snapshot?.hooks?.denials ?? 0;
    const running = runningTools.length;
    const connections = snapshot?.connections?.length ?? 0;
    const changed = snapshot?.git?.changedFiles ?? 0;
    const agents = snapshot?.agents?.jobCount ?? 0;
    return {
      timeline: { value: eventRate > 0 ? eventRate : events.length, tone: eventRate > 0 ? "hot" as const : "default" as const },
      tools: { value: snapshot?.tools?.length ?? 0, tone: "default" as const },
      hooks: { value: hookDenials || (snapshot?.hooks?.total ?? 0), tone: hookDenials > 0 ? "danger" as const : "default" as const },
      connections: { value: connections, tone: connections > 0 ? "hot" as const : "default" as const },
      git: { value: changed, tone: changed > 0 ? "hot" as const : "default" as const },
      agents: { value: agents, tone: agents > 0 ? "hot" as const : "default" as const },
      overview: { value: running, tone: running > 0 ? "hot" as const : "default" as const },
    };
  }, [snapshot, eventRate, events.length, runningTools.length]);

  const serverLabel = snapshot
    ? `${snapshot.server.name} v${snapshot.server.version} · ${shortPath(snapshot.server.defaultRoot)}`
    : undefined;

  const renderContent = () => {
    if (!snapshot && !connected) {
      return (
        <div className="page">
          <div className="connecting-splash">
            <div>
              <div className="spinner" />
              <strong style={{ display: "block", marginBottom: 6 }}>Connecting to Least…</strong>
              <div style={{ color: "var(--text-dim)", fontSize: 13 }}>
                {error ?? "Waiting for dashboard API / SSE stream"}
              </div>
            </div>
          </div>
        </div>
      );
    }

    switch (section) {
      case "overview":
        return renderOverview();
      case "tools":
        return (
          <div className="page">
            <ToolTable tools={snapshot?.tools ?? []} />
          </div>
        );
      case "timeline":
        return (
          <div className="page">
            <TimelinePanel events={events} connected={connected} historyDays={historyDays} />
          </div>
        );
      case "hooks":
        return (
          <div className="page">
            <HooksPanel
              hooks={snapshot?.hooks ?? null}
              recentHooks={snapshot?.recentHooks ?? []}
              events={events}
            />
          </div>
        );
      case "connections":
        return (
          <div className="page">
            <ConnectionsPanel connections={snapshot?.connections ?? []} />
          </div>
        );
      case "git":
        return (
          <div className="page">
            <GitPanel git={snapshot?.git ?? null} />
          </div>
        );
      case "runtime":
        return (
          <div className="page">
            <RuntimePanel runtime={snapshot?.runtime ?? null} snapshot={snapshot} />
          </div>
        );
      case "logs":
        return (
          <div className="page">
            <EventLog events={events} logs={snapshot?.logs ?? []} />
          </div>
        );
      case "settings":
        return (
          <div className="page">
            <SettingsPanel
              snapshot={snapshot}
              refreshIntervalMs={refreshIntervalMs}
              onRefreshIntervalChange={setRefreshIntervalMs}
            />
          </div>
        );
      case "sessions":
        return (
          <div className="page">
            <SessionsPanel events={events} />
          </div>
        );
      case "agents":
        return (
          <div className="page">
            <AgentsPanel agents={snapshot?.agents} />
          </div>
        );
      default:
        return (
          <div className="page">
            <EmptyState message="Select a section" />
          </div>
        );
    }
  };

  function renderOverview() {
    const s = snapshot;
    const totalTools = s?.tools?.length ?? 0;
    const connections = s?.connections?.length ?? 0;
    const branch = s?.git?.branch ?? "—";
    const hookDenials = s?.hooks?.denials ?? 0;
    const hookTotal = s?.hooks?.total ?? 0;
    const uptime = s?.runtime?.uptimeSec ?? 0;
    const uptimeStr = formatUptime(uptime);
    const p95 = maxP95(s?.tools);
    const lastEvent = lastEventTime ? new Date(lastEventTime).toLocaleTimeString() : "—";
    const lastBeat = lastHeartbeatAt ? new Date(lastHeartbeatAt).toLocaleTimeString() : "—";

    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Overview</div>
            <div className="page-subtitle">
              Live activity, tool health, hooks, and git — updates over SSE without a full page reload.
            </div>
          </div>
          <div className="page-actions">
            <span className={`pill ${connected ? "pill-ok" : "pill-warn"}`}>
              <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
              {connected ? (streaming ? "Streaming" : "Connected") : error ?? "Disconnected"}
            </span>
            {s?.server?.yoloMode && (
              <span className="pill pill-error">
                <AlertTriangle size={12} /> YOLO
              </span>
            )}
            <span className="pill pill-muted">
              <Radio size={12} /> {eventRate}/min
            </span>
            <button className="btn btn-primary" onClick={() => refreshSnapshot()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <RefreshCw size={13} /> Refresh
              </span>
            </button>
          </div>
        </div>

        <div className="metric-grid">
          <MetricCard title="Tool Calls" value={totals.calls} label="Session total" />
          <MetricCard title="Tools Seen" value={totalTools} label="With telemetry" />
          <MetricCard title="Error Rate" value={`${errorRate}%`} label={`${totals.errors} errors`} />
          <MetricCard title="p95 Latency" value={p95 != null ? `${Math.round(p95)}ms` : "—"} label="Highest tool p95" />
          <MetricCard title="Connections" value={connections} label="Active MCP sessions" />
          <MetricCard
            title="Git Branch"
            value={shortBranch(branch)}
            label={s?.git?.changedFiles ? `${s.git.changedFiles} changed` : s?.git?.available ? "Clean" : "Unavailable"}
          />
          <MetricCard
            title="Hooks"
            value={hookTotal}
            label={hookDenials > 0 ? `${hookDenials} denials` : hookTotal ? "No denials" : "None configured / fired"}
          />
          <MetricCard title="Uptime" value={uptimeStr} label={`PID ${s?.runtime?.pid ?? "?"}`} />
        </div>

        <div className="panel-grid">
          <div className="live-feed">
            <div className="live-feed-header">
              <div className="chart-title" style={{ margin: 0 }}>Live activity</div>
              <div className="stat-inline">
                <span>last <b>{lastEvent}</b></span>
                <span>hb <b>{lastBeat}</b></span>
              </div>
            </div>
            <div className="live-feed-body event-log">
              {liveItems.length === 0 && (
                <div className="empty-state" style={{ border: "none", margin: 12 }}>
                  <strong>No events yet</strong>
                  Use Least tools (read, search, edit…) — they stream here in realtime.
                </div>
              )}
              {liveItems.map((item) => (
                <div key={item.id} className="event-entry">
                  <span className="event-time">{fmtTime(item.ts)}</span>
                  {"status" in item ? (
                    <>
                      <span className={`pill ${toolPill(item.status)}`}>{item.status}</span>
                      <span className="event-tool">{item.toolName}</span>
                      <span className="event-detail">
                        {item.durationMs != null ? `${item.durationMs}ms` : "in flight"}
                        {item.error ? ` · ${item.error}` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={`pill ${eventPill(item.kind)}`}>{shortKind(item.kind)}</span>
                      {item.toolName && <span className="event-tool">{item.toolName}</span>}
                      <span className="event-detail">
                        {item.payload?.event != null && String(item.payload.event)}
                        {item.payload?.decision != null && ` → ${String(item.payload.decision)}`}
                        {item.payload?.message != null && ` ${String(item.payload.message)}`}
                        {item.durationMs != null && ` ${item.durationMs}ms`}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="chart-container" style={{ marginBottom: 0 }}>
              <div className="chart-title">Running now</div>
              {runningTools.length === 0 ? (
                <div style={{ color: "var(--text-dim)", fontSize: 13, padding: "8px 0" }}>
                  No in-flight tool calls.
                </div>
              ) : (
                <div className="event-log">
                  {runningTools.map((t) => (
                    <div key={t.id} className="event-entry" style={{ borderBottom: "none", padding: "6px 0" }}>
                      <span className="pill pill-running">running</span>
                      <span className="event-tool">{t.toolName}</span>
                      <span className="event-detail">{fmtTime(t.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="chart-container" style={{ marginBottom: 0 }}>
              <div className="chart-title">Workspace</div>
              <div className="stat-inline" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
                <div>root <b className="truncate" style={{ display: "inline-block", maxWidth: 280 }}>{s?.server?.defaultRoot ?? "—"}</b></div>
                <div>branch <b>{branch}</b></div>
                <div>
                  git{" "}
                  <b>
                    {s?.git?.available
                      ? `${s.git.staged} staged · ${s.git.unstaged} unstaged · ${s.git.untracked} untracked`
                      : s?.git?.error ?? "unavailable"}
                  </b>
                </div>
                <div>
                  hooks <b>{hookTotal} total</b>
                  {hookDenials > 0 ? ` · ${hookDenials} denied` : ""}
                </div>
                <div>
                  clients <b>{s?.runtime?.activeDashboardClients ?? 0}</b> · heap{" "}
                  <b>{fmtBytes(s?.runtime?.memory?.heapUsed ?? 0)}</b>
                </div>
              </div>
            </div>
          </div>
        </div>

        {s?.tools && s.tools.length > 0 && <Charts snapshot={s} />}
      </div>
    );
  }

  return (
    <Shell
      section={section}
      onSectionChange={setSection}
      connected={connected}
      streaming={streaming}
      error={error}
      eventRate={eventRate}
      serverLabel={serverLabel}
      badges={badges}
    >
      {renderContent()}
    </Shell>
  );
}

function formatUptime(uptime: number): string {
  if (uptime > 3600) return `${(uptime / 3600).toFixed(1)}h`;
  if (uptime > 60) return `${Math.floor(uptime / 60)}m ${uptime % 60}s`;
  return `${uptime}s`;
}

function maxP95(tools: Array<{ p95Ms: number; calls: number }> | undefined): number | null {
  const active = (tools ?? []).filter((t) => t.calls > 0);
  if (!active.length) return null;
  return Math.max(...active.map((t) => t.p95Ms));
}

function shortPath(p: string): string {
  if (!p) return "—";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/") || p;
}

function shortBranch(b: string): string {
  if (!b || b === "—") return "—";
  return b.length > 18 ? `${b.slice(0, 16)}…` : b;
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)}MB`;
  if (b >= 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}

function shortKind(kind: string): string {
  return kind.replace(":", "·");
}

function toolPill(status: string): string {
  if (status === "error") return "pill-error";
  if (status === "ok") return "pill-ok";
  return "pill-running";
}

function eventPill(kind: string): string {
  if (kind.includes("error") || kind.includes("blocked")) return "pill-error";
  if (kind.includes("hook")) return "pill-warn";
  if (kind.includes("lock")) return "pill-info";
  if (kind.includes("git")) return "pill-muted";
  return "pill-info";
}
