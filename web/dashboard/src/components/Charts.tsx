import { useMemo } from "react";
import type { DashboardSnapshot, DashboardEvent } from "../api.ts";

interface ChartsProps {
  snapshot: DashboardSnapshot;
}

export function Charts({ snapshot }: ChartsProps) {
  // Simple in-memory chart rendering with inline SVGs
  // In production, Recharts would be used. For v1, show key stats.
  const tools = snapshot.tools ?? [];
  const gain = (snapshot.gain ?? {}) as Record<string, unknown>;
  const rawProcessed = Number(gain.raw_bytes_processed ?? 0);
  const visibleEmitted = Number(gain.visible_bytes_emitted ?? 0);
  const savedBytes = rawProcessed - visibleEmitted;

  const topByCalls = useMemo(() => {
    return [...tools].sort((a, b) => b.calls - a.calls).slice(0, 10);
  }, [tools]);

  const topByP95 = useMemo(() => {
    return [...tools].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 10);
  }, [tools]);

  return (
    <div>
      <h2 className="section-title">Charts</h2>
      <div className="chart-row">
        <div className="chart-container">
          <div className="chart-title">Top Tools by Calls</div>
          <BarChart
            data={topByCalls.map((t) => ({ label: t.tool, value: t.calls }))}
            color="var(--accent-blue)"
            maxVal={Math.max(...topByCalls.map((t) => t.calls), 1)}
          />
        </div>
        <div className="chart-container">
          <div className="chart-title">p95 Latency by Tool</div>
          <BarChart
            data={topByP95.map((t) => ({ label: t.tool, value: Math.round(t.p95Ms) }))}
            color="var(--orange)"
            maxVal={Math.max(...topByP95.map((t) => t.p95Ms), 1)}
          />
        </div>
      </div>
      <div className="chart-row">
        <div className="chart-container">
          <div className="chart-title">Compaction Savings</div>
          {rawProcessed > 0 ? (
            <div style={{ padding: "12px 0" }}>
              <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Raw</div>
                  <div className="card-value" style={{ fontSize: 18 }}>{fmtBytes(rawProcessed)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Visible</div>
                  <div className="card-value" style={{ fontSize: 18, color: "var(--green)" }}>{fmtBytes(visibleEmitted)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Saved</div>
                  <div className="card-value" style={{ fontSize: 18, color: "var(--yellow)" }}>{fmtBytes(Math.max(0, savedBytes))}</div>
                </div>
              </div>
              <div style={{ height: 24, background: "var(--bg-4)", borderRadius: 4, overflow: "hidden", display: "flex" }}>
                <div style={{
                  width: `${(visibleEmitted / Math.max(rawProcessed, 1)) * 100}%`,
                  background: "var(--green)",
                  height: "100%",
                  transition: "width 0.3s",
                }} title="Visible bytes" />
                <div style={{
                  width: `${(Math.max(0, savedBytes) / Math.max(rawProcessed, 1)) * 100}%`,
                  background: "var(--yellow)",
                  height: "100%",
                  transition: "width 0.3s",
                }} title="Saved bytes" />
              </div>
            </div>
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              No compaction data yet
            </div>
          )}
        </div>
        <div className="chart-container">
          <div className="chart-title">Top Savers (Compaction)</div>
          {topSavers(snapshot).length > 0 ? (
            <BarChart
              data={topSavers(snapshot).slice(0, 8).map((s: any) => ({
                label: s.key ?? s.tool ?? "?",
                value: Math.round((s.saved_bytes ?? s.savedBytes ?? 0) / 1024),
              }))}
              color="var(--yellow)"
              maxVal={Math.max(...topSavers(snapshot).slice(0, 8).map((s: any) => Math.round((s.saved_bytes ?? s.savedBytes ?? 0) / 1024)), 1)}
            />
          ) : (
            <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
              No savers yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function topSavers(snapshot: DashboardSnapshot): any[] {
  const gain = snapshot.gain as Record<string, unknown> | undefined;
  if (gain?.top_savers && Array.isArray(gain.top_savers)) return gain.top_savers;
  return [];
}

function BarChart({ data, color, maxVal }: { data: Array<{ label: string; value: number }>; color: string; maxVal: number }) {
  const barHeight = 20;
  const gap = 4;
  const h = data.length * (barHeight + gap) + 10;
  return (
    <svg width="100%" height={h} style={{ display: "block" }}>
      {data.map((d, i) => {
        const w = maxVal > 0 ? (d.value / maxVal) * 100 : 0;
        const y = i * (barHeight + gap);
        return (
          <g key={d.label}>
            <text x={0} y={y + barHeight - 4} fill="var(--text-muted)" fontSize={10} fontFamily="var(--mono)">
              {shortLabel(d.label)}
            </text>
            <rect
              x={80}
              y={y}
              width={`${Math.max(w, 2)}%`}
              height={barHeight}
              fill={color}
              rx={3}
              opacity={0.85}
            />
            <text x={84} y={y + barHeight - 4} fill="var(--bg-0)" fontSize={10} fontWeight={600} fontFamily="var(--mono)">
              {d.value}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function shortLabel(label: string): string {
  return label.length > 12 ? label.slice(0, 11) + "…" : label;
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}
