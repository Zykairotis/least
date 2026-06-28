import type { DashboardSnapshot } from "../api.ts";

interface ConnectionsPanelProps {
  connections: DashboardSnapshot["connections"];
}

export function ConnectionsPanel({ connections }: ConnectionsPanelProps) {
  return (
    <div>
      <h2 className="section-title">Connections ({connections.length})</h2>
      {connections.length === 0 && <div className="empty-state">No active connections</div>}
      {connections.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Surface</th>
                <th>Auth</th>
                <th>Created</th>
                <th>Last Seen</th>
                <th className="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{c.id.slice(0, 16)}…</td>
                  <td><span className={`pill ${c.surface === "dashboard" ? "pill-info" : c.surface === "grok" ? "pill-warn" : "pill-ok"}`}>{c.surface}</span></td>
                  <td style={{ fontSize: 11 }}>{c.authMode}</td>
                  <td style={{ fontSize: 11 }}>{fmtDate(c.createdAt)}</td>
                  <td style={{ fontSize: 11 }}>{fmtDate(c.lastSeenAt)}</td>
                  <td className="num">{c.requestCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtDate(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}
