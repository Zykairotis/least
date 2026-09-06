import { useMemo, useState, useEffect, useRef } from "react";
import type { DashboardEvent } from "../api.ts";
import { pairToolCalls, type PairedToolCall } from "../usePairedToolCalls.ts";
import { JsonDetailsDropdown } from "./JsonDetailsDropdown.tsx";

interface TimelinePanelProps {
  events: DashboardEvent[];
  connected?: boolean;
  historyDays?: number;
}

type KindFilter = "all" | "tools" | "hooks" | "locks" | "git" | "other";

export function TimelinePanel({ events, connected, historyDays = 3 }: TimelinePanelProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);

  const items = useMemo(() => {
    let list = pairToolCalls(events);
    if (filter === "tools") list = list.filter((i) => "status" in i || i.kind.startsWith("tool:"));
    if (filter === "hooks") list = list.filter((i) => !("status" in i) && i.kind.startsWith("hook:"));
    if (filter === "locks") list = list.filter((i) => !("status" in i) && i.kind.startsWith("lock:"));
    if (filter === "git") list = list.filter((i) => !("status" in i) && i.kind.startsWith("git:"));
    if (filter === "other") {
      list = list.filter(
        (i) =>
          !("status" in i) &&
          !i.kind.startsWith("tool:") &&
          !i.kind.startsWith("hook:") &&
          !i.kind.startsWith("lock:") &&
          !i.kind.startsWith("git:")
      );
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((item) => {
        if ("status" in item) {
          return (
            item.toolName.toLowerCase().includes(q) ||
            item.status.includes(q) ||
            (item.error?.toLowerCase().includes(q) ?? false)
          );
        }
        return (
          item.kind.toLowerCase().includes(q) ||
          (item.toolName?.toLowerCase().includes(q) ?? false) ||
          JSON.stringify(item.payload ?? {}).toLowerCase().includes(q)
        );
      });
    }
    return list.slice(0, 300);
  }, [events, filter, query]);

  useEffect(() => {
    if (!autoScroll) return;
    if (events.length > prevLen.current && bodyRef.current) {
      bodyRef.current.scrollTop = 0;
    }
    prevLen.current = events.length;
  }, [events.length, autoScroll]);

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Timeline</div>
          <div className="page-subtitle">
            SQLite timeline (max {historyDays}d){connected ? " · live" : " · offline"} ·{" "}
            {events.length} events · survives refresh
          </div>
        </div>
      </div>

      <div className="filter-bar">
        {(
          [
            ["all", "All"],
            ["tools", "Tools"],
            ["hooks", "Hooks"],
            ["locks", "Locks"],
            ["git", "Git"],
            ["other", "Other"],
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
        <button
          className={`btn-filter ${autoScroll ? "active" : ""}`}
          onClick={() => setAutoScroll((v) => !v)}
          style={{ marginLeft: "auto" }}
        >
          Auto-scroll {autoScroll ? "on" : "off"}
        </button>
      </div>

      <input
        className="search-input"
        type="search"
        placeholder="Filter timeline…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {items.length === 0 && (
        <div className="empty-state">
          <strong>No events match</strong>
          Tool calls, hooks, locks, and git snapshots show up here as they happen.
        </div>
      )}

      <div className="live-feed" style={{ maxHeight: "calc(100vh - 220px)" }}>
        <div className="live-feed-header">
          <div className="chart-title" style={{ margin: 0 }}>Events</div>
          <span className="pill pill-muted">{items.length}</span>
        </div>
        <div className="live-feed-body event-log" ref={bodyRef}>
          {items.map((item) => (
            <div key={item.id}>
              <div
                className="event-entry"
                style={{ cursor: "pointer" }}
                onClick={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
              >
                <span className="event-time">{fmtTime(item.ts)}</span>
                {"status" in item ? (
                  <>
                    <span className={`pill ${toolPillClass(item.status)}`}>{item.status}</span>
                    <span className="event-tool">{item.toolName}</span>
                    <span className="event-detail">
                      {item.durationMs != null && `${item.durationMs}ms`}
                      {item.error && ` ✗ ${item.error}`}
                      {item.output?.rawBytes != null && ` · ${item.output.rawBytes}B`}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`pill ${eventPillClass(item.kind)}`}>{item.kind.replace(":", "·")}</span>
                    {item.toolName && <span className="event-tool">{item.toolName}</span>}
                    <span className="event-detail">
                      {item.durationMs != null && `${item.durationMs}ms `}
                      {item.level && item.level !== "info" && `[${item.level}] `}
                      {item.payload?.message != null && String(item.payload.message)}
                      {item.payload?.decision != null && `→ ${String(item.payload.decision)}`}
                      {item.payload?.event != null && ` ${String(item.payload.event)}`}
                      {item.payload?.branch != null && ` ${String(item.payload.branch)}`}
                      {item.payload?.changedFiles != null && ` Δ${String(item.payload.changedFiles)}`}
                    </span>
                  </>
                )}
                <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>
                  {expandedId === item.id ? "▲" : "▼"}
                </span>
              </div>

              {expandedId === item.id && "status" in item && (
                <div style={{ padding: "8px 12px 12px 98px", borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.12)" }}>
                  <JsonDetailsDropdown label="Input" data={(item as PairedToolCall).input} />
                  <JsonDetailsDropdown label="Output" data={(item as PairedToolCall).output} />
                  {item.error && <JsonDetailsDropdown label="Error" data={{ message: item.error }} />}
                  <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)" }}>
                    {item.workspaceId && <span>ws: {item.workspaceId} </span>}
                    {item.sessionId && <span>session: {item.sessionId} </span>}
                    {item.durationMs != null && <span>duration: {item.durationMs}ms</span>}
                  </div>
                </div>
              )}

              {expandedId === item.id && !("status" in item) && (
                <div style={{ padding: "8px 12px 12px 98px", borderBottom: "1px solid var(--border)", background: "rgba(0,0,0,0.12)" }}>
                  <JsonDetailsDropdown label="Payload" data={(item as DashboardEvent).payload} />
                  <JsonDetailsDropdown
                    label="Event"
                    data={{
                      kind: item.kind,
                      toolName: item.toolName,
                      durationMs: item.durationMs,
                      level: item.level,
                      sessionId: item.sessionId,
                      workspaceId: item.workspaceId,
                    }}
                  />
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
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3 as any,
    });
  } catch {
    return ts;
  }
}

function eventPillClass(kind: string): string {
  if (kind.includes("error")) return "pill-error";
  if (kind.includes("end") || kind.includes("released") || kind.includes("close")) return "pill-ok";
  if (kind.includes("start") || kind.includes("acquired") || kind.includes("open")) return "pill-running";
  if (kind.includes("deny") || kind.includes("blocked")) return "pill-warn";
  if (kind.includes("hook")) return "pill-warn";
  if (kind.includes("git")) return "pill-muted";
  return "pill-info";
}

function toolPillClass(status: string): string {
  if (status === "error") return "pill-error";
  if (status === "ok") return "pill-ok";
  return "pill-running";
}
