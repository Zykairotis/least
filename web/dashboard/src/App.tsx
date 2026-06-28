import { useState, useMemo } from "react";
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

export default function App() {
  const [section, setSection] = useState<Section>("overview");
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(2000);
  const { snapshot, events, connected, lastEventTime, error, refreshSnapshot } = useLiveDashboard(refreshIntervalMs);
  const callsPerMin = useMemo(() => {
    if (!snapshot?.perf?.totals) return 0;
    const totals = snapshot.perf.totals as { calls: number };
    return totals.calls ?? 0;
  }, [snapshot]);

  const errorRate = useMemo(() => {
    if (!snapshot?.perf?.totals) return 0;
    const totals = snapshot.perf.totals as { calls: number; errors: number };
    return totals.calls > 0 ? ((totals.errors / totals.calls) * 100).toFixed(1) : "0.0";
  }, [snapshot]);

  const handleRefresh = () => {
    refreshSnapshot();
  };

  const renderContent = () => {
    if (!snapshot && !connected) {
      return <EmptyState message="Connecting to Least dashboard..." />;
    }

    switch (section) {
      case "overview":
        return renderOverview();
      case "tools":
        return <ToolTable tools={snapshot?.tools ?? []} />;
      case "timeline":
        return <TimelinePanel events={events} />;
      case "hooks":
        return <HooksPanel hooks={snapshot?.hooks ?? null} events={events} />;
      case "connections":
        return <ConnectionsPanel connections={snapshot?.connections ?? []} />;
      case "git":
        return <GitPanel git={snapshot?.git ?? null} />;
      case "runtime":
        return <RuntimePanel runtime={snapshot?.runtime ?? null} snapshot={snapshot} />;
      case "logs":
        return <EventLog events={events} logs={snapshot?.logs ?? []} />;
      case "settings":
        return <SettingsPanel snapshot={snapshot} refreshIntervalMs={refreshIntervalMs} onRefreshIntervalChange={setRefreshIntervalMs} />;
      case "sessions":
        return <SessionsPanel events={events} />;
      case "agents":
        return <AgentsPanel agents={snapshot?.agents} />;
      default:
        return <EmptyState message="Select a section" />;
    }
  };

  function renderOverview() {
    const s = snapshot;
    const totalTools = s?.tools?.length ?? 0;
    const connections = s?.connections?.length ?? 0;
    const branch = s?.git?.branch ?? "—";
    const hookDenials = s?.hooks?.denials ?? 0;
    const uptime = s?.runtime?.uptimeSec ?? 0;
    const uptimeStr = uptime > 3600
      ? `${(uptime / 3600).toFixed(1)}h`
      : uptime > 60
        ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
        : `${uptime}s`;
    const firstPerfTool = Array.isArray(s?.perf?.tools)
      ? (s?.perf?.tools[0] as { p95_ms?: number } | undefined)
      : undefined;

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>Overview</h2>
          <span className={`pill ${connected ? "pill-ok" : "pill-error"}`}>
            <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
            {connected ? "Live" : error ?? "Disconnected"}
          </span>
          {lastEventTime && (
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
              Last event: {new Date(lastEventTime).toLocaleTimeString()}
            </span>
          )}
          <button className="btn-filter" onClick={handleRefresh} style={{ marginLeft: "auto" }}>
            Refresh
          </button>
        </div>

        <div className="metric-grid">
          <MetricCard title="Tool Calls" value={callsPerMin} label="Total calls" />
          <MetricCard title="Tools Registered" value={totalTools} label="Active tools" />
          <MetricCard title="Error Rate" value={`${errorRate}%`} label="Of all calls" />
          <MetricCard title="p95 Latency" value={firstPerfTool?.p95_ms != null ? `${firstPerfTool.p95_ms}ms` : "—"} label="Fastest tool p95" />
          <MetricCard title="Connections" value={connections} label="Active MCP sessions" />
          <MetricCard title="Git Branch" value={branch} label={s?.git?.changedFiles ? `${s.git.changedFiles} changed` : "Clean"} />
          <MetricCard title="Hook Denials" value={hookDenials} label="Blocked operations" />
          <MetricCard title="Uptime" value={uptimeStr} label={`PID ${s?.runtime?.pid ?? "?"}`} />
        </div>

        {s?.tools && s.tools.length > 0 && <Charts snapshot={s} />}
      </div>
    );
  }

  return (
    <Shell section={section} onSectionChange={setSection} connected={connected}>
      {renderContent()}
    </Shell>
  );
}
