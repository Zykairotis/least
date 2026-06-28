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

  const displayLogs = useMemo(() => {
    if (logs.length > 0) return logs;
    // Pair tool calls for condensed log display
    const paired = pairToolCalls(events.slice(-300));
    return paired.map((item) => {
      if ("status" in item) {
        const dur = item.durationMs != null ? ` ${item.durationMs}ms` : "";
        const err = item.error ? ` ✗${item.error}` : "";
        return { id: item.id, ts: item.ts, kind: "tool_call", level: item.status === "error" ? "error" as const : "info" as const, message: `${item.toolName}${dur}${err}`, toolName: item.toolName };
      }
      const e = item as DashboardEvent;
      return { id: e.id, ts: e.ts, kind: e.kind, level: e.level ?? "info", message: e.toolName ? `${e.kind} ${e.toolName}${e.durationMs != null ? ` ${e.durationMs}ms` : ""}` : e.kind, toolName: e.toolName };
    });
  }, [events, logs]);

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div>
      <h2 className="section-title">Logs</h2>
      <div className="event-log" style={{ maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}>
        {displayLogs.length === 0 && (
          <div className="empty-state">No log entries yet</div>
        )}
        {displayLogs.map((log) => (
          <div key={log.id}>
            <div
              className="event-entry"
              style={{ cursor: "pointer" }}
              onClick={() => toggleExpand(log.id)}
            >
              <span className="event-time">{fmtTime(log.ts)}</span>
              <span className={`pill ${levelClass(log.level)}`} style={{ width: 48 }}>{log.level}</span>
              <span className="event-kind">{log.kind}</span>
              {log.toolName && <span className="event-tool">{log.toolName}</span>}
              <span className="event-detail">{log.message}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>▼</span>
            </div>
            {expandedId === log.id && (
              <div style={{ padding: "4px 0 8px 88px", borderBottom: "1px solid var(--border)" }}>
                <JsonDetailsDropdown label="Raw Event" data={log} maxPreviewChars={500} />
              </div>
            )}
          </div>
        ))}
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
    case "error": return "pill-error";
    case "warn": return "pill-warn";
    case "debug": return "pill-info";
    default: return "pill-ok";
  }
}
