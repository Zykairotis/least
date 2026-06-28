import type { DashboardSnapshot } from "../api.ts";

interface SettingsPanelProps {
  snapshot: DashboardSnapshot | null;
  refreshIntervalMs: number;
  onRefreshIntervalChange: (ms: number) => void;
}

const PRESETS = [
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "Pause", value: 0 },
];

export function SettingsPanel({ snapshot, refreshIntervalMs, onRefreshIntervalChange }: SettingsPanelProps) {
  return (
    <div>
      <h2 className="section-title">Settings</h2>

      <div className="chart-container">
        <div className="chart-title">Auto-Refresh</div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
            Poll interval: {refreshIntervalMs === 0 ? "Paused" : `${refreshIntervalMs / 1000}s`}
          </div>
          <div className="filter-bar">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn-filter ${refreshIntervalMs === p.value ? "active" : ""}`}
                onClick={() => onRefreshIntervalChange(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={500}
            max={30_000}
            step={500}
            value={refreshIntervalMs || 500}
            onChange={(e) => onRefreshIntervalChange(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />
        </div>
      </div>

      <div className="chart-container">
        <div className="chart-title">Dashboard Config</div>
        <table className="data-table">
          <tbody>
            <tr>
              <td style={{ color: "var(--accent-gray)", width: 200 }}>Dashboard Port</td>
              <td>{snapshot?.server?.dashboardPort ?? 8922}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>Connected</td>
              <td>
                <span className={`pill ${snapshot?.runtime?.dashboardStreaming ? "pill-ok" : "pill-warn"}`}>
                  {snapshot?.runtime?.dashboardStreaming ? "Streaming" : "Not streaming"}
                </span>
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>Active Clients</td>
              <td>{snapshot?.runtime?.activeDashboardClients ?? 0}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--accent-gray)" }}>YOLO Mode</td>
              <td><span className={`pill ${snapshot?.server?.yoloMode ? "pill-error" : "pill-ok"}`}>{snapshot?.server?.yoloMode ? "Enabled" : "Disabled"}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="chart-container">
        <div className="chart-title">About</div>
        <p style={{ color: "var(--text-dim)", fontSize: 12, lineHeight: 1.6 }}>
          The dashboard is an observability plane for Least. It reads from Least's in-process telemetry and event bus.
          Tool execution from the browser is not supported in v1.
        </p>
        <ul style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.8, marginTop: 8, paddingLeft: 16 }}>
          <li>Dashboard is local-only by default (<code style={{ color: "var(--yellow)" }}>127.0.0.1</code>)</li>
          <li>Remote access requires <code style={{ color: "var(--yellow)" }}>--dashboard-token</code></li>
          <li>Sensitive fields are redacted in events and snapshots</li>
          <li>No raw tool arguments shown by default</li>
          <li>No shell output shown by default</li>
        </ul>
      </div>
    </div>
  );
}
