import { useState, useMemo } from "react";
import type { DashboardEvent } from "../api.ts";
import { JsonDetailsDropdown } from "./JsonDetailsDropdown.tsx";
import { pairToolCalls } from "../usePairedToolCalls.ts";

interface EventLogProps {
  events: DashboardEvent[];
  logs: Array<{ id: number; ts: string; kind: string; level: string; message: string; toolName?: string }>;
}

export function EventLog({ events, logs }: EventLogProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error" | "debug">("all");
  const [query, setQuery] = useState("");

  const displayLogs = useMemo(() => {
    const base =
      logs.length > 0
        ? logs
        : pairToolCalls(events.slice(-400)).map((item) => {
            if ("status" in item) {
              const dur = item.durationMs != null ? ` ${item.durationMs}ms` : "";
              const err = item.error ? ` ✗${item.error}` : "";
              return {
                id: item.id,
                ts: item.ts,
                kind: "tool_call",
                level: item.status === "error" ? ("error" as const) : ("info" as const),
                message: `${item.toolName}${dur}${err}`,
                toolName: item.toolName,
              };
            }
            const e = item as DashboardEvent;
            return {
              id: e.id,
              ts: e.ts,
              kind: e.kind,
              level: (e.level ?? "info") as string,
              message: e.toolName
                ? `${e.kind} ${e.toolName}${e.durationMs != null ? ` ${e.durationMs}ms` : ""}`
                : e.kind,
              toolName: e.toolName,
            };
          });

    return base
      .filter((log) => (level === "all" ? true : log.level === level))
      .filter((log) => {
        const q = query.trim().toLowerCase();
        if (!q) return true;
        return (
          log.message.toLowerCase().includes(q) ||
          log.kind.toLowerCase().includes(q) ||
          (log.toolName?.toLowerCase().includes(q) ?? false)
        );
      })
      .slice()
      .reverse();
  }, [events, logs, level, query]);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Logs</div>
          <div className="page-subtitle">Unified stream from dashboard events and server log records.</div>
        </div>
      </div>

      <div className="filter-bar">
        {(["all", "info", "warn", "error", "debug"] as const).map((l) => (
          <button key={l} className={`btn-filter ${level === l ? "active" : ""}`} onClick={() => setLevel(l)}>
            {l}
          </button>
        ))}
      </div>

      <input
        className="search-input"
        type="search"
        placeholder="Search logs…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="live-feed" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <div className="live-feed-header">
          <div className="chart-title" style={{ margin: 0 }}>Entries</div>
          <span className="pill pill-muted">{displayLogs.length}</span>
        </div>
        <div className="live-feed-body event-log">
          {displayLogs.length === 0 && (
            <div className="empty-state" style={{ border: "none", margin: 12 }}>
              <strong>No log entries</strong>
              Activity will show here as tools and hooks run.
            </div>
          )}
          {displayLogs.map((log) => (
            <div key={`${log.id}-${log.ts}`}>
              <div className="event-entry" style={{ cursor: "pointer" }} onClick={() => setExpandedId((p) => (p === log.id ? null : log.id))}>
                <span className="event-time">{fmtTime(log.ts)}</span>
                <span className={`pill ${levelClass(log.level)}`}>{log.level}</span>
                <span className="event-kind">{log.kind}</span>
                {log.toolName && <span className="event-tool">{log.toolName}</span>}
                <span className="event-detail">{log.message}</span>
              </div>
              {expandedId === log.id && (
                <div style={{ padding: "4px 12px 10px 98px", borderBottom: "1px solid var(--border)" }}>
                  <JsonDetailsDropdown label="Raw" data={log} maxPreviewChars={500} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

function levelClass(level: string): string {
  switch (level) {
    case "error":
      return "pill-error";
    case "warn":
      return "pill-warn";
    case "debug":
      return "pill-info";
    default:
      return "pill-ok";
  }
}
