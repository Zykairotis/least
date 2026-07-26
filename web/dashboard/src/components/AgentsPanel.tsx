import { useState, useMemo } from "react";
import type { AgentJobRow, AgentTerminalSessionRow, DashboardSnapshot } from "../api.ts";
import { MetricCard } from "./MetricCard.tsx";

interface AgentsPanelProps {
  agents: DashboardSnapshot["agents"] | null | undefined;
}

type View = "jobs" | "sessions";

export function AgentsPanel({ agents }: AgentsPanelProps) {
  const [view, setView] = useState<View>("jobs");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const jobs = useMemo(() => (agents?.jobs ?? []) as AgentJobRow[], [agents?.jobs]);
  const sessions = useMemo(() => (agents?.terminalSessions ?? []) as AgentTerminalSessionRow[], [agents?.terminalSessions]);

  const selectedJob = useMemo(
    () => (selectedJobId ? jobs.find((j) => j.job_id === selectedJobId) : undefined),
    [jobs, selectedJobId]
  );

  const jobSessions = useMemo(
    () => (selectedJobId ? sessions.filter((s) => s.job_id === selectedJobId) : []),
    [sessions, selectedJobId]
  );

  if (selectedJob) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <button className="btn-filter" onClick={() => setSelectedJobId(null)}>← Back</button>
          <h2 className="section-title" style={{ margin: 0 }}>Job {shortId(selectedJob.job_id)}</h2>
          <span className={`pill ${statePillClass(selectedJob.state)}`}>{selectedJob.state ?? "unknown"}</span>
          {selectedJob.launch_phase && <span className={`pill ${statePillClass(selectedJob.launch_phase)}`}>{selectedJob.launch_phase}</span>}
        </div>

        <div className="metric-grid" style={{ marginBottom: 16 }}>
          <MetricCard title="Agent" value={selectedJob.agent ?? "—"} />
          <MetricCard title="Repository" value={selectedJob.repository ?? "—"} />
          <MetricCard title="Terminal" value={selectedJob.terminal_backend ?? "—"} label={selectedJob.terminal_session ?? "no session"} />
          <MetricCard title="Launch" value={selectedJob.launch_phase ?? "—"} label={selectedJob.launch_error ?? "no recovery issue"} />
          <MetricCard title="Updated" value={fmtTime(selectedJob.updated_at)} />
        </div>

        <JobDetailTable job={selectedJob} />
        {jobSessions.length > 0 && (
          <div className="chart-container" style={{ marginTop: 16 }}>
            <div className="chart-title">Terminal Sessions ({jobSessions.length})</div>
            <SessionsTable sessions={jobSessions} compact />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 className="section-title" style={{ margin: 0 }}>Local Agents</h2>
        <span className="pill pill-info">{agents?.jobCount ?? jobs.length} jobs</span>
        <span className="pill pill-info">{agents?.terminalSessionCount ?? sessions.length} sessions</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className={`btn-filter ${view === "jobs" ? "active" : ""}`} onClick={() => setView("jobs")}>Jobs</button>
          <button className={`btn-filter ${view === "sessions" ? "active" : ""}`} onClick={() => setView("sessions")}>Terminal Sessions</button>
        </div>
      </div>

      <div className="metric-grid" style={{ marginBottom: 20 }}>
        <MetricCard title="Agent Jobs" value={agents?.jobCount ?? jobs.length} label="Persisted runs" />
        <MetricCard title="Terminal Sessions" value={agents?.terminalSessionCount ?? sessions.length} label="Zellij / tmux / logs" />
        <MetricCard title="Running" value={jobs.filter((j) => isRunningState(j.state)).length} label="Active jobs" />
        <MetricCard title="Backends" value={uniqueBackends(jobs, sessions).join(", ") || "—"} label="Terminal backends seen" />
      </div>

      {view === "jobs" ? (
        jobs.length === 0 ? (
          <div className="empty-state">No agent jobs yet. Run agent_start to create one.</div>
        ) : (
          <JobsTable jobs={jobs} onSelect={setSelectedJobId} />
        )
      ) : sessions.length === 0 ? (
        <div className="empty-state">No terminal sessions recorded yet.</div>
      ) : (
        <SessionsTable sessions={sessions} />
      )}
    </div>
  );
}

function JobsTable({ jobs, onSelect }: { jobs: AgentJobRow[]; onSelect: (id: string) => void }) {
  return (
    <div className="chart-container">
      <table className="data-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Task</th>
            <th>Agent</th>
            <th>State</th>
            <th>Launch</th>
            <th>Backend</th>
            <th>Session</th>
            <th>Worktree</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.job_id} style={{ cursor: "pointer" }} onClick={() => onSelect(job.job_id)}>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{shortId(job.job_id)}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{job.task_id ? shortId(job.task_id) : "—"}</td>
              <td>{job.agent ?? "—"}</td>
              <td><span className={`pill ${statePillClass(job.state)}`}>{job.state ?? "—"}</span></td>
              <td><span className={`pill ${statePillClass(job.launch_phase)}`}>{job.launch_phase ?? "—"}</span></td>
              <td>{job.terminal_backend ?? "—"}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{job.terminal_session ?? "—"}</td>
              <td style={{ fontFamily: "var(--mono)", fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={job.worktree_dir ?? undefined}>
                {job.worktree_dir ? shortPath(job.worktree_dir) : "—"}
              </td>
              <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{fmtTime(job.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ sessions, compact = false }: { sessions: AgentTerminalSessionRow[]; compact?: boolean }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Backend</th>
          <th>Job</th>
          {!compact && <th>Session</th>}
          <th>Pane</th>
          {!compact && <th>Title</th>}
          <th>Attach</th>
          <th>Tail</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.id}>
            <td><span className="pill pill-info">{s.backend}</span></td>
            <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.job_id ? shortId(s.job_id) : "—"}</td>
            {!compact && <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.session_name ?? "—"}</td>}
            <td style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{s.pane_id ?? "—"}</td>
            {!compact && <td style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title ?? "—"}</td>}
            <td><CommandCell command={s.attach_command} /></td>
            <td><CommandCell command={s.tail_command} /></td>
            <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{fmtTime(s.updated_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function JobDetailTable({ job }: { job: AgentJobRow }) {
  const rows: Array<[string, string | null | undefined]> = [
    ["Job ID", job.job_id],
    ["Task ID", job.task_id],
    ["Agent", job.agent],
    ["Repository", job.repository],
    ["Title", job.title],
    ["State", job.state],
    ["Launch Phase", job.launch_phase],
    ["Launch Error", job.launch_error],
    ["Idempotency Key", job.idempotency_key],
    ["Workspace", job.workspace_root],
    ["Terminal Backend", job.terminal_backend],
    ["Session", job.terminal_session],
    ["Pane ID", job.terminal_pane_id],
    ["Worktree", job.worktree_dir],
    ["Branch", job.branch_name],
    ["Created", job.created_at],
    ["Updated", job.updated_at],
    ["Deadline", job.deadline_at],
    ["Idle Deadline", job.idle_deadline_at],
  ];

  return (
    <div className="chart-container">
      <table className="data-table">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td style={{ color: "var(--accent-gray)", width: 160 }}>{label}</td>
              <td style={{ fontFamily: label.includes("ID") || label.includes("Worktree") || label.includes("Session") ? "var(--mono)" : undefined, fontSize: label.includes("ID") ? 11 : undefined }}>
                {value ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommandCell({ command }: { command?: string | null }) {
  if (!command) return <span style={{ color: "var(--text-dim)" }}>—</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, maxWidth: 220 }}>
      <code style={{ fontFamily: "var(--mono)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={command}>
        {command}
      </code>
      <button className="btn-filter" style={{ padding: "2px 6px", fontSize: 10 }} onClick={(e) => { e.stopPropagation(); copyText(command); }}>
        Copy
      </button>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}

function fmtTime(ts?: string | null): string {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); }
  catch { return ts; }
}

function isRunningState(state?: string | null): boolean {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === "running" || s === "started" || s === "active" || s === "in_progress" || s === "provisioning" || s === "accepted";
}

function statePillClass(state?: string | null): string {
  if (!state) return "pill-info";
  const s = state.toLowerCase();
  if (s.includes("fail") || s.includes("error") || s === "timeout-hard" || s === "cancelled" || s === "orphaned") return "pill-error";
  if (s === "recovery-required") return "pill-warn";
  if (s.includes("timeout") || s.includes("warn")) return "pill-warn";
  if (isRunningState(s)) return "pill-running";
  if (s.includes("done") || s.includes("complete") || s.includes("success") || s === "finished") return "pill-ok";
  return "pill-info";
}

function uniqueBackends(jobs: AgentJobRow[], sessions: AgentTerminalSessionRow[]): string[] {
  const set = new Set<string>();
  for (const j of jobs) if (j.terminal_backend) set.add(j.terminal_backend);
  for (const s of sessions) if (s.backend) set.add(s.backend);
  return [...set].sort();
}

function copyText(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => {});
}
