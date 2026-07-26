import { useState, useMemo } from "react";
import type { DashboardEvent } from "../api.ts";
import { pairToolCalls, type PairedToolCall } from "../usePairedToolCalls.ts";
import { JsonDetailsDropdown } from "./JsonDetailsDropdown.tsx";

interface SessionsPanelProps {
  events: DashboardEvent[];
}

export function SessionsPanel({ events }: SessionsPanelProps) {
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sessions = useMemo(() => {
    const map = new Map<string, { id: number; ts: string; toolCount: number; errorCount: number; durationMs: number }>();
    for (const e of events) {
      const sid = e.sessionId || "default";
      const existing = map.get(sid) || { id: e.id, ts: e.ts, toolCount: 0, errorCount: 0, durationMs: 0 };
      existing.toolCount++;
      if (e.level === "error" || e.kind.includes("error")) existing.errorCount++;
      if (e.durationMs) existing.durationMs = Math.max(existing.durationMs, e.durationMs);
      if (e.id > existing.id) existing.id = e.id;
      map.set(sid, existing);
    }
    return [...map.entries()].sort((a, b) => b[1].id - a[1].id);
  }, [events]);

  const sessionEvents = useMemo(() => {
    if (!selectedSession) return [];
    const filtered = events.filter((e) => e.sessionId === selectedSession);
    return pairToolCalls(filtered);
  }, [events, selectedSession]);

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  if (selectedSession) {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <button className="btn-filter" onClick={() => setSelectedSession(null)}>← Back</button>
          <h2 className="section-title" style={{ margin: 0 }}>Session {selectedSession.slice(0, 16)}…</h2>
          <span className={`pill pill-info`}>{sessionEvents.length} events</span>
        </div>
        <div className="event-log" style={{ maxHeight: "calc(100vh - 180px)", overflowY: "auto" }}>
          {sessionEvents.map((item) => (
            <div key={item.id}>
              <div className="event-entry" style={{ cursor: "pointer" }} onClick={() => toggleExpand(item.id)}>
                <span className="event-time">{"ts" in item ? fmtTime(item.ts) : ""}</span>
                {"status" in item ? (
                  <>
                    <span className={`pill ${item.status === "ok" ? "pill-ok" : item.status === "error" ? "pill-error" : "pill-running"}`} style={{ width: 50 }}>{item.status}</span>
                    <span className="event-tool">{item.toolName}</span>
                    <span className="event-detail">{item.durationMs != null && `${item.durationMs}ms`}</span>
                  </>
                ) : (
                  <>
                    <span className={`pill ${eventPillClass((item as DashboardEvent).kind)}`} style={{ width: 90 }}>{(item as DashboardEvent).kind.replace(":", ".")}</span>
                    {(item as DashboardEvent).toolName && <span className="event-tool">{(item as DashboardEvent).toolName}</span>}
                  </>
                )}
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>▼</span>
              </div>
              {expandedId === item.id && "status" in item && (
                <div style={{ padding: "4px 0 8px 88px", borderBottom: "1px solid var(--border)" }}>
                  <JsonDetailsDropdown label="Input" data={(item as PairedToolCall).input} />
                  {item.error && <JsonDetailsDropdown label="Error" data={{ message: item.error }} />}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="section-title">Sessions ({sessions.length})</h2>
      {sessions.length === 0 && <div className="empty-state">No session data</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sessions.map(([sid, info]) => (
          <div
            key={sid}
            className="card"
            style={{ cursor: "pointer" }}
            onClick={() => setSelectedSession(sid)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="card-header" style={{ margin: 0, flex: 1 }}>
                {sid === "default" ? "Default" : sid.slice(0, 24) + "…"}
              </div>
              <span className={`pill pill-info`}>{info.toolCount} events</span>
              {info.errorCount > 0 && <span className={`pill pill-error`}>{info.errorCount} errors</span>}
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--mono)" }}>
                {info.durationMs > 0 ? `${info.durationMs}ms` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 as any }); }
  catch { return ts; }
}

function eventPillClass(kind: string): string {
  if (kind.includes("error")) return "pill-error";
  if (kind.includes("end") || kind.includes("released") || kind.includes("close")) return "pill-ok";
  if (kind.includes("start") || kind.includes("acquired") || kind.includes("open")) return "pill-running";
  if (kind.includes("deny") || kind.includes("blocked")) return "pill-warn";
  return "pill-info";
}
