import type { DashboardEvent } from "../api.ts";

interface HooksPanelProps {
  hooks: {
    total: number; allows: number; denials: number; errors: number;
    untrustedSkips: number; p95DurationMs: number; byEvent: Record<string, number>;
  } | null;
  events: DashboardEvent[];
}

export function HooksPanel({ hooks, events }: HooksPanelProps) {
  const hookEvents = events.filter((e) => e.kind.startsWith("hook:"));

  return (
    <div>
      <h2 className="section-title">Hooks</h2>

      {hooks && (
        <div className="metric-grid">
          <div className="card">
            <div className="card-header">Total Hook Events</div>
            <div className="card-value">{hooks.total}</div>
          </div>
          <div className="card">
            <div className="card-header">Allowed</div>
            <div className="card-value" style={{ color: "var(--green)" }}>{hooks.allows}</div>
          </div>
          <div className="card">
            <div className="card-header">Denied</div>
            <div className="card-value" style={{ color: "var(--red)" }}>{hooks.denials}</div>
          </div>
          <div className="card">
            <div className="card-header">Errors</div>
            <div className="card-value" style={{ color: "var(--orange)" }}>{hooks.errors}</div>
          </div>
          <div className="card">
            <div className="card-header">Untrusted Skips</div>
            <div className="card-value">{hooks.untrustedSkips}</div>
          </div>
        </div>
      )}

      {hooks && Object.keys(hooks.byEvent).length > 0 && (
        <div className="chart-container" style={{ marginTop: 16 }}>
          <div className="chart-title">Hook Events by Type</div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Event</th>
                <th className="num">Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(hooks.byEvent).sort((a, b) => b[1] - a[1]).map(([event, count]) => (
                <tr key={event}>
                  <td>{event}</td>
                  <td className="num">{count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="chart-container" style={{ marginTop: 16 }}>
        <div className="chart-title">Recent Hook Events</div>
        <div className="event-log" style={{ maxHeight: 300, overflowY: "auto" }}>
          {hookEvents.length === 0 && <div className="empty-state">No hook events yet</div>}
          {hookEvents.slice(-100).reverse().map((e) => (
            <div key={e.id} className="event-entry">
              <span className="event-time">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`pill ${e.kind === "hook:end" ? "pill-ok" : e.kind === "hook:error" ? "pill-error" : "pill-info"}`}>
                {e.kind.replace("hook:", "")}
              </span>
              {e.payload?.event != null && <span className="event-kind">{String(e.payload.event)}</span>}
              {e.toolName && <span className="event-tool">{e.toolName}</span>}
              {e.durationMs != null && <span className="event-detail">{e.durationMs}ms</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
