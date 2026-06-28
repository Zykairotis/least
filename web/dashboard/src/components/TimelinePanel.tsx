import { useState, useMemo } from "react";
import type { DashboardEvent } from "../api.ts";
import { pairToolCalls, type PairedToolCall } from "../usePairedToolCalls.ts";
import { JsonDetailsDropdown } from "./JsonDetailsDropdown.tsx";

interface TimelinePanelProps {
  events: DashboardEvent[];
}

export function TimelinePanel({ events }: TimelinePanelProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const items = useMemo(() => pairToolCalls(events).slice(0, 200), [events]);

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div>
      <h2 className="section-title">Event Timeline</h2>

      {items.length === 0 && <div className="empty-state">No events yet. Tool calls will appear here live.</div>}

      <div className="event-log" style={{ maxHeight: "calc(100vh - 140px)", overflowY: "auto" }}>
        {items.map((item) => (
          <div key={item.id}>
            <div
              className="event-entry"
              style={{ cursor: "pointer" }}
              onClick={() => toggleExpand(item.id)}
            >
              <span className="event-time">{fmtTime(item.ts)}</span>
              {"status" in item ? (
                <>
                  <span className={`pill ${toolPillClass(item.status)}`} style={{ width: 50 }}>{item.status}</span>
                  <span className="event-tool">{item.toolName}</span>
                  <span className="event-detail">
                    {item.durationMs != null && `${item.durationMs}ms`}
                    {item.error && ` ✗ ${item.error}`}
                    {item.output?.rawBytes != null && ` | ${item.output.rawBytes}B`}
                  </span>
                </>
              ) : (
                <>
                  <span className={`pill ${eventPillClass(item.kind)}`} style={{ width: 90 }}>
                    {item.kind.replace(":", ".")}
                  </span>
                  {item.toolName && <span className="event-tool">{item.toolName}</span>}
                  <span className="event-detail">
                    {item.durationMs != null && `${item.durationMs}ms`}
                    {item.level && item.level !== "info" && ` [${item.level}]`}
                    {item.payload?.message != null && ` ${String(item.payload.message)}`}
                    {item.payload?.decision != null && ` → ${String(item.payload.decision)}`}
                  </span>
                </>
              )}
              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>▼</span>
            </div>

            {expandedId === item.id && "status" in item && (
              <div style={{ padding: "4px 0 8px 88px", borderBottom: "1px solid var(--border)" }}>
                <JsonDetailsDropdown label="Input" data={item.input} />
                <JsonDetailsDropdown label="Output" data={item.output} />
                {item.error && <JsonDetailsDropdown label="Error" data={{ message: item.error }} />}
                <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
                  {item.workspaceId && <span>ws: {item.workspaceId} </span>}
                  {item.sessionId && <span>session: {item.sessionId} </span>}
                  {item.durationMs != null && <span>duration: {item.durationMs}ms</span>}
                </div>
              </div>
            )}

            {expandedId === item.id && !("toolName" in item) && (
              <div style={{ padding: "4px 0 8px 88px", borderBottom: "1px solid var(--border)" }}>
                <JsonDetailsDropdown label="Payload" data={(item as DashboardEvent).payload} />
                <JsonDetailsDropdown label="Full Event" data={{
                  kind: (item as DashboardEvent).kind,
                  toolName: (item as DashboardEvent).toolName,
                  durationMs: (item as DashboardEvent).durationMs,
                  level: (item as DashboardEvent).level,
                  sessionId: (item as DashboardEvent).sessionId,
                  workspaceId: (item as DashboardEvent).workspaceId,
                }} />
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
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 as any });
  } catch {
    return ts;
  }
}

function eventPillClass(kind: string): string {
  if (kind.includes("error")) return "pill-error";
  if (kind.includes("end") || kind.includes("released") || kind.includes("close")) return "pill-ok";
  if (kind.includes("start") || kind.includes("acquired") || kind.includes("open")) return "pill-running";
  if (kind.includes("deny") || kind.includes("blocked")) return "pill-warn";
  return "pill-info";
}

function toolPillClass(status: string): string {
  if (status === "error") return "pill-error";
  if (status === "ok") return "pill-ok";
  return "pill-running";
}
