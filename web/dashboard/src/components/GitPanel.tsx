import type { DashboardSnapshot } from "../api.ts";

interface GitPanelProps {
  git: DashboardSnapshot["git"] | null;
}

export function GitPanel({ git }: GitPanelProps) {
  if (!git) {
    return <div><h2 className="section-title">Git</h2><div className="empty-state">No git data</div></div>;
  }

  return (
    <div>
      <h2 className="section-title">Git Status</h2>

      {!git.available ? (
        <div className="card">
          <div className="card-header">Git Unavailable</div>
          <p style={{ color: "var(--red)", fontSize: 13 }}>{git.error ?? "Git is not available in this workspace."}</p>
        </div>
      ) : (
        <>
          <div className="metric-grid">
            <div className="card">
              <div className="card-header">Branch</div>
              <div className="card-value" style={{ fontSize: 18 }}>{git.branch ?? "—"}</div>
            </div>
            <div className="card">
              <div className="card-header">Changed Files</div>
              <div className="card-value" style={{ color: git.changedFiles > 0 ? "var(--yellow)" : undefined }}>
                {git.changedFiles}
              </div>
              <div className="card-label">Modified files</div>
            </div>
            <div className="card">
              <div className="card-header">Staged</div>
              <div className="card-value" style={{ color: "var(--green)" }}>{git.staged}</div>
            </div>
            <div className="card">
              <div className="card-header">Unstaged</div>
              <div className="card-value" style={{ color: git.unstaged > 0 ? "var(--orange)" : undefined }}>{git.unstaged}</div>
            </div>
            <div className="card">
              <div className="card-header">Untracked</div>
              <div className="card-value" style={{ color: git.untracked > 0 ? "var(--text-dim)" : undefined }}>{git.untracked}</div>
            </div>
            <div className="card">
              <div className="card-header">Last Snapshot</div>
              <div className="card-value" style={{ fontSize: 12 }}>
                {git.lastSnapshotAt ? new Date(git.lastSnapshotAt).toLocaleTimeString() : "—"}
              </div>
            </div>
          </div>

          {git.status && (
            <div className="chart-container">
              <div className="chart-title">Status Output</div>
              <pre style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                lineHeight: 1.5,
                color: "var(--text-muted)",
                overflow: "auto",
                maxHeight: 200,
                whiteSpace: "pre-wrap",
              }}>
                {git.status}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
