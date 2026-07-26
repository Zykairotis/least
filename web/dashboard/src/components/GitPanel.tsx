import type { DashboardSnapshot } from "../api.ts";
import { MetricCard } from "./MetricCard.tsx";

interface GitPanelProps {
  git: DashboardSnapshot["git"] | null;
}

export function GitPanel({ git }: GitPanelProps) {
  if (!git) {
    return (
      <div>
        <div className="page-title">Git</div>
        <div className="empty-state" style={{ marginTop: 14 }}>
          <strong>No git data</strong>
          Open the dashboard while Least is running against a git workspace.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Git</div>
          <div className="page-subtitle">
            Status refreshes when files change and on a short background poll while the dashboard is open.
          </div>
        </div>
        {git.lastSnapshotAt && (
          <span className="pill pill-muted">Updated {new Date(git.lastSnapshotAt).toLocaleTimeString()}</span>
        )}
      </div>

      {!git.available ? (
        <div className="card">
          <div className="card-header">Git unavailable</div>
          <p style={{ color: "var(--red)", fontSize: 13 }}>{git.error ?? "Git is not available in this workspace."}</p>
        </div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard title="Branch" value={git.branch ?? "—"} label="Current branch" />
            <MetricCard title="Changed" value={git.changedFiles} label="Modified paths" />
            <MetricCard title="Staged" value={git.staged} label="Index changes" />
            <MetricCard title="Unstaged" value={git.unstaged} label="Worktree changes" />
            <MetricCard title="Untracked" value={git.untracked} label="New files" />
          </div>

          {git.status && (
            <div className="chart-container">
              <div className="chart-title">Status porcelain</div>
              <pre
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: "var(--text-muted)",
                  overflow: "auto",
                  maxHeight: 320,
                  whiteSpace: "pre-wrap",
                  margin: 0,
                }}
              >
                {git.status}
              </pre>
            </div>
          )}
        </>
      )}
    </div>
  );
}
