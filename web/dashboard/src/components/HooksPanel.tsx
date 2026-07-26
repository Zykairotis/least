import { useMemo, useState } from "react";
import type { DashboardEvent } from "../api.ts";
import { MetricCard } from "./MetricCard.tsx";

type HookRecord = {
  id: number;
  ts: string;
  event: string;
  toolName?: string;
  command?: string;
  trusted?: boolean;
  decision: "allow" | "deny" | "error";
  durationMs?: number;
  timedOut?: boolean;
  reason?: string;
};

interface HooksPanelProps {
  hooks: {
    total: number;
    allows: number;
    denials: number;
    errors: number;
    untrustedSkips: number;
    p95DurationMs: number;
    byEvent: Record<string, number>;
  } | null;
  recentHooks?: HookRecord[];
  events: DashboardEvent[];
}

type Filter = "all" | "allow" | "deny" | "error" | "stream";

export function HooksPanel({ hooks, recentHooks = [], events }: HooksPanelProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const streamHookEvents = useMemo(
    () => events.filter((e) => e.kind.startsWith("hook:")).slice(-200).reverse(),
    [events]
  );

  const records = useMemo(() => {
    const base = [...recentHooks].sort((a, b) => b.id - a.id);
    if (filter === "stream") return [];
    if (filter === "all") return base;
    return base.filter((r) => r.decision === filter);
  }, [recentHooks, filter]);

  const emptyConfigured = (hooks?.total ?? 0) === 0 && streamHookEvents.length === 0 && recentHooks.length === 0;

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <div className="page-title">Hooks</div>
          <div className="page-subtitle">
            Pre/Post tool hooks, trust decisions, denials, and durations — live via SSE.
          </div>
        </div>
      </div>

      <div className="metric-grid">
        <MetricCard title="Total" value={hooks?.total ?? 0} label="Hook executions" />
        <MetricCard title="Allowed" value={hooks?.allows ?? 0} label="Pass-through" />
        <MetricCard title="Denied" value={hooks?.denials ?? 0} label="Blocked ops" />
        <MetricCard title="Errors" value={hooks?.errors ?? 0} label="Hook failures" />
        <MetricCard title="Untrusted" value={hooks?.untrustedSkips ?? 0} label="Trust skips" />
        <MetricCard
          title="p95 Duration"
          value={hooks?.p95DurationMs ? `${Math.round(hooks.p95DurationMs)}ms` : "—"}
          label="Hook latency"
        />
      </div>

      {emptyConfigured && (
        <div className="empty-state" style={{ marginBottom: 16 }}>
          <strong>No hook activity yet</strong>
          Hooks only appear when project/user settings define PreToolUse / PostToolUse commands.
          <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 12 }}>
            Configure in <code>.least/settings.json</code> or <code>~/.least/settings.json</code>
          </div>
        </div>
      )}

      {hooks && Object.keys(hooks.byEvent).length > 0 && (
        <div className="chart-container">
          <div className="chart-title">By event type</div>
          <div className="table-shell">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th className="num">Count</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(hooks.byEvent)
                  .sort((a, b) => b[1] - a[1])
                  .map(([event, count]) => (
                    <tr key={event}>
                      <td style={{ color: "var(--text)" }}>{event}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="filter-bar">
        {(
          [
            ["all", "Records"],
            ["allow", "Allow"],
            ["deny", "Deny"],
            ["error", "Error"],
            ["stream", "SSE stream"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={`btn-filter ${filter === id ? "active" : ""}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {filter !== "stream" ? (
        <div className="live-feed" style={{ maxHeight: 480 }}>
          <div className="live-feed-header">
            <div className="chart-title" style={{ margin: 0 }}>Hook records</div>
            <span className="pill pill-muted">{records.length}</span>
          </div>
          <div className="live-feed-body event-log">
            {records.length === 0 && (
              <div className="empty-state" style={{ border: "none", margin: 12 }}>
                No hook records for this filter.
              </div>
            )}
            {records.map((r) => (
              <div key={r.id} className="event-entry">
                <span className="event-time">{fmtTime(r.ts)}</span>
                <span className={`pill ${decisionPill(r.decision)}`}>{r.decision}</span>
                <span className="event-kind">{r.event}</span>
                {r.toolName && <span className="event-tool">{r.toolName}</span>}
                <span className="event-detail">
                  {r.durationMs != null ? `${r.durationMs}ms` : ""}
                  {r.trusted === false ? " · untrusted" : ""}
                  {r.timedOut ? " · timeout" : ""}
                  {r.reason ? ` · ${r.reason}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="live-feed" style={{ maxHeight: 480 }}>
          <div className="live-feed-header">
            <div className="chart-title" style={{ margin: 0 }}>SSE hook events</div>
            <span className="pill pill-muted">{streamHookEvents.length}</span>
          </div>
          <div className="live-feed-body event-log">
            {streamHookEvents.length === 0 && (
              <div className="empty-state" style={{ border: "none", margin: 12 }}>
                No hook SSE events in this session stream yet.
              </div>
            )}
            {streamHookEvents.map((e) => (
              <div key={e.id} className="event-entry">
                <span className="event-time">{fmtTime(e.ts)}</span>
                <span className={`pill ${e.kind === "hook:error" ? "pill-error" : e.kind === "hook:end" ? "pill-ok" : "pill-running"}`}>
                  {e.kind.replace("hook:", "")}
                </span>
                {e.payload?.event != null && <span className="event-kind">{String(e.payload.event)}</span>}
                {e.toolName && <span className="event-tool">{e.toolName}</span>}
                <span className="event-detail">
                  {e.durationMs != null ? `${e.durationMs}ms` : ""}
                  {Array.isArray(e.payload?.decisions) ? ` · ${e.payload!.decisions.join(",")}` : ""}
                  {e.payload?.reason != null ? ` · ${String(e.payload.reason)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function decisionPill(d: string): string {
  if (d === "deny") return "pill-error";
  if (d === "error") return "pill-warn";
  return "pill-ok";
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}
