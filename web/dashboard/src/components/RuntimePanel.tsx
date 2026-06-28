import type { DashboardSnapshot } from "../api.ts";
import { MetricCard } from "./MetricCard.tsx";

interface RuntimePanelProps {
  runtime: DashboardSnapshot["runtime"] | null;
  snapshot: DashboardSnapshot | null;
}

export function RuntimePanel({ runtime, snapshot }: RuntimePanelProps) {
  if (!runtime) {
    return <div><h2 className="section-title">Runtime</h2><div className="empty-state">No runtime data</div></div>;
  }

  const uptime = runtime.uptimeSec;
  const uptimeStr = uptime > 3600
    ? `${(uptime / 3600).toFixed(1)}h`
    : uptime > 60
      ? `${Math.floor(uptime / 60)}m ${uptime % 60}s`
      : `${uptime}s`;

  const cachedPerf = snapshot?.perf as Record<string, unknown> | undefined;
  const cacheStats = cachedPerf && typeof cachedPerf === "object"
    ? (cachedPerf as Record<string, unknown>)
    : null;

  return (
    <div>
      <h2 className="section-title">Runtime</h2>

      <div className="metric-grid">
        <MetricCard title="Node Version" value={runtime.node} />
        <MetricCard title="Platform" value={`${runtime.platform} ${runtime.arch}`} />
        <MetricCard title="PID" value={String(runtime.pid)} />
        <MetricCard title="Uptime" value={uptimeStr} />
        <MetricCard title="Dashboard Clients" value={String(runtime.activeDashboardClients)} />
        <MetricCard title="Streaming" value={runtime.dashboardStreaming ? "Active" : "Idle"} label={runtime.dashboardStreaming ? "SSE connected" : "No SSE clients"} />
      </div>

      <div className="chart-container">
        <div className="chart-title">Memory</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div className="card-header">RSS</div>
            <div className="card-value" style={{ fontSize: 18 }}>{fmtBytes(runtime.memory.rss)}</div>
          </div>
          <div>
            <div className="card-header">Heap Used</div>
            <div className="card-value" style={{ fontSize: 18 }}>{fmtBytes(runtime.memory.heapUsed)}</div>
          </div>
          <div>
            <div className="card-header">Heap Total</div>
            <div className="card-value" style={{ fontSize: 18 }}>{fmtBytes(runtime.memory.heapTotal)}</div>
          </div>
          <div>
            <div className="card-header">External</div>
            <div className="card-value" style={{ fontSize: 18 }}>{fmtBytes(runtime.memory.external)}</div>
          </div>
        </div>
      </div>

      <div className="chart-container">
        <div className="chart-title">Server Info</div>
        <table className="data-table">
          <tbody>
            <tr>
              <td style={{ color: "var(--accent-gray)", width: 200 }}>Server</td>
              <td>{snapshot?.server?.name ?? "Least"} v{snapshot?.server?.version ?? "?"}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>Started</td>
              <td>{snapshot?.server?.startedAt ? new Date(snapshot.server.startedAt).toLocaleString() : "—"}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>Default Root</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{snapshot?.server?.defaultRoot ?? "—"}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>YOLO Mode</td>
              <td><span className={`pill ${snapshot?.server?.yoloMode ? "pill-error" : "pill-ok"}`}>{snapshot?.server?.yoloMode ? "ON" : "OFF"}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}
