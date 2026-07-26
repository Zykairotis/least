import { useState, useMemo } from "react";
import type { DashboardSnapshot } from "../api.ts";

interface ToolTableProps {
  tools: DashboardSnapshot["tools"];
}

type SortKey = "calls" | "errors" | "p95Ms" | "avgMs" | "tool" | "savedBytes";
type SortDir = "asc" | "desc";

export function ToolTable({ tools }: ToolTableProps) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("calls");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const items = tools.filter((t) => t.tool.toLowerCase().includes(q));
    items.sort((a, b) => {
      const aVal = a[sortKey as keyof typeof a];
      const bVal = b[sortKey as keyof typeof b];
      const cmp =
        typeof aVal === "number" && typeof bVal === "number"
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));
      return sortDir === "desc" ? -cmp : cmp;
    });
    return items;
  }, [tools, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function sortArrow(key: SortKey): string {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const totals = useMemo(
    () => ({
      calls: tools.reduce((s, t) => s + t.calls, 0),
      errors: tools.reduce((s, t) => s + t.errors, 0),
    }),
    [tools]
  );

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Tools</div>
          <div className="page-subtitle">
            {tools.length} tools · {totals.calls} calls · {totals.errors} errors — live totals refresh on each tool event
          </div>
        </div>
      </div>

      <input
        className="search-input"
        type="search"
        placeholder="Search tools…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="table-shell" style={{ overflowX: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("tool")}>Tool{sortArrow("tool")}</th>
              <th className="num" onClick={() => toggleSort("calls")}>Calls{sortArrow("calls")}</th>
              <th className="num" onClick={() => toggleSort("errors")}>Errors{sortArrow("errors")}</th>
              <th className="num">Timeouts</th>
              <th className="num" onClick={() => toggleSort("avgMs")}>Avg{sortArrow("avgMs")}</th>
              <th className="num" onClick={() => toggleSort("p95Ms")}>P95{sortArrow("p95Ms")}</th>
              <th className="num">Max</th>
              <th className="num">Out</th>
              <th className="num" onClick={() => toggleSort("savedBytes")}>Saved{sortArrow("savedBytes")}</th>
              <th className="num">Compacts</th>
              <th>Backends</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} style={{ textAlign: "center", padding: 28, color: "var(--text-dim)" }}>
                  No tool telemetry yet. Calls appear after the first tool runs.
                </td>
              </tr>
            )}
            {filtered.map((tool) => (
              <tr key={tool.tool}>
                <td style={{ fontWeight: 600, color: "var(--text)" }}>{tool.tool}</td>
                <td className="num">{tool.calls}</td>
                <td className="num">
                  {tool.errors > 0 ? <span style={{ color: "var(--red)" }}>{tool.errors}</span> : tool.errors}
                </td>
                <td className="num">
                  {tool.timeouts > 0 ? <span style={{ color: "var(--yellow)" }}>{tool.timeouts}</span> : tool.timeouts}
                </td>
                <td className="num">{tool.avgMs.toFixed(1)}</td>
                <td className="num">{tool.p95Ms.toFixed(1)}</td>
                <td className="num">{tool.maxMs.toFixed(1)}</td>
                <td className="num">{fmtBytes(tool.avgOutputBytes)}</td>
                <td className="num" style={{ color: tool.savedBytes > 0 ? "var(--green)" : undefined }}>
                  {fmtBytes(tool.savedBytes)}
                </td>
                <td className="num">{tool.compactions}</td>
                <td style={{ fontSize: 11 }}>{tool.backends.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)}MB`;
  if (b >= 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}
